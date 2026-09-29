// Definition preview builders extracted from extension.ts (Phase 4).
//
// Scope:
//   * Higher-level preview functions that take a TextDocument (or raw file)
//     and produce a Markdown-rendered DefCacheEntry payload:
//       - collectDefinitionPreview
//       - rememberPreviewLocations
//       - buildDefinitionPreviewResult
//       - languageIdForFsPath
//       - readRawFileSnapshot
//       - buildDefinitionPreviewResultFromRawFile
//   * The per-identifier preview-location LRU maps used by Cmd+Click and
//     the drill preview pipeline:
//       - lastPreviewLocations
//       - lastPreviewDeclarationLocations
//       - cappedPreviewLocationSet / cappedPreviewLocationGet
//
// buildResultFromFastHit STAYS in extension.ts because it needs `log`,
// `findOpenDoc`, and `withTimeout` — utilities not yet split out. It can
// call into this module via buildDefinitionPreviewResult /
// buildDefinitionPreviewResultFromRawFile after import.

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { DEFINITION_PREVIEW_FALLBACK_LINES } from './util';
import {
  SKIP_WORDS,
  declarationIdentifiersInLine,
  decoratorIdentifiersInLine,
} from './idents';
import {
  DefinitionPreview,
  TextLikeDocument,
  RawFileSnapshot,
  rawDefFileCache,
  cacheRawFileSnapshot,
  isPythonLikeDoc,
  includeLeadingDefinitionDecorators,
  normalizePythonDecoratedDefinitionLine,
  refineDefinitionLineForIdentifier,
  findValueDefinitionEndLine,
  findPythonBlockEndLine,
  findBraceBlockEndLine,
} from './preview-engine';
import type { DefCacheEntry } from './cache';
import { previewFileLink } from './preview-file-link';

export const PREVIEW_LOCATION_MAX_SIZE = 1_000;
export const lastPreviewLocations = new Map<string, vscode.Location>();
export const lastPreviewDeclarationLocations = new Map<string, vscode.Location>();

export function cappedPreviewLocationSet(map: Map<string, vscode.Location>, key: string, value: vscode.Location) {
  if (map.has(key)) { map.delete(key); }
  while (map.size >= PREVIEW_LOCATION_MAX_SIZE) {
    const first = map.keys().next().value;
    if (first === undefined) { break; }
    map.delete(first);
  }
  map.set(key, value);
}

export function cappedPreviewLocationGet(map: Map<string, vscode.Location>, key: string): vscode.Location | undefined {
  const value = map.get(key);
  if (!value) { return undefined; }
  map.delete(key);
  map.set(key, value);
  return value;
}

/** Drop every cached preview location (both maps). Used on hard rebuild. */
export function clearPreviewLocations(): void {
  lastPreviewLocations.clear();
  lastPreviewDeclarationLocations.clear();
}

export function collectDefinitionPreview(
  doc: TextLikeDocument,
  requestedStartLine: number,
  hintedEndLine?: number,
): DefinitionPreview {
  const requestedLine = Math.max(0, Math.min(requestedStartLine, Math.max(0, doc.lineCount - 1)));
  const definitionLine = normalizePythonDecoratedDefinitionLine(doc, requestedLine);
  const valueEndLine = findValueDefinitionEndLine(doc, definitionLine);
  const previewStartLine = valueEndLine === null ? includeLeadingDefinitionDecorators(doc, definitionLine) : definitionLine;

  const structuralEndLine = valueEndLine !== null
    ? valueEndLine
    : isPythonLikeDoc(doc)
      ? findPythonBlockEndLine(doc, definitionLine)
      : findBraceBlockEndLine(doc, definitionLine)
        ?? Math.min(definitionLine + DEFINITION_PREVIEW_FALLBACK_LINES, doc.lineCount);

  // Some language servers report only the declaration/header range for a
  // class (e.g. a multiline Python class signature). Treat the LS range as a
  // hint, not an upper bound, so it cannot truncate the structural block.
  let endLine = structuralEndLine;
  if (valueEndLine === null && hintedEndLine !== undefined && hintedEndLine > definitionLine) {
    endLine = Math.max(endLine, Math.min(hintedEndLine + 1, doc.lineCount));
  }

  if (endLine <= previewStartLine) {
    endLine = Math.min(previewStartLine + DEFINITION_PREVIEW_FALLBACK_LINES, doc.lineCount);
  }

  // Keep the complete definition. Resource limits belong to cache retention,
  // never to the source shown in the scrollable hover.
  const lines: string[] = [];
  for (let i = previewStartLine; i < endLine; i++) { lines.push(doc.lineAt(i).text); }

  return {
    previewStartLine,
    definitionLine,
    endLine,
    code: lines.join('\n'),
  };
}

export function rememberPreviewLocations(
  typeName: string,
  uri: vscode.Uri,
  preview: DefinitionPreview,
): vscode.Location {
  const previewLoc = new vscode.Location(
    uri,
    new vscode.Range(preview.definitionLine, 0, preview.endLine, 0),
  );
  cappedPreviewLocationSet(lastPreviewLocations, typeName, previewLoc);

  const seen = new Set<string>([typeName]);
  // Cap how many preview lines we eagerly index by identifier. Previously
  // this loop ran over the entire preview block (up to ~600 lines), doing
  // a matchAll on every line and ~hundreds of cappedPreviewLocationSet
  // calls per hover. Headers + first 24 lines is enough to support
  // Cmd+Click into nearby declarations; deeper identifiers can still be
  // resolved by the regular LSP path when the user actually hovers them.
  const REMEMBER_PREVIEW_INDEX_LINES = 24;
  // Split only the eagerly indexed prefix, without copying the rest of a large
  // definition into a temporary line array. The displayed preview stays whole.
  const lineTexts = preview.code.split('\n', REMEMBER_PREVIEW_INDEX_LINES);
  for (let offset = 0; offset < lineTexts.length; offset++) {
    const lineText = lineTexts[offset];
    const absLine = preview.previewStartLine + offset;
    for (const decl of decoratorIdentifiersInLine(lineText)) {
      if (!decl.id || decl.id.length <= 2) { continue; }
      cappedPreviewLocationSet(
        lastPreviewLocations,
        decl.id,
        new vscode.Location(uri, new vscode.Range(absLine, decl.index, absLine, decl.index + decl.id.length)),
      );
    }
    for (const decl of declarationIdentifiersInLine(lineText)) {
      if (SKIP_WORDS.has(decl.id) || decl.id.length <= 2) { continue; }
      const loc = new vscode.Location(
        uri,
        new vscode.Range(absLine, decl.index, absLine, decl.index + decl.id.length),
      );
      cappedPreviewLocationSet(lastPreviewDeclarationLocations, decl.id, loc);
      if (!seen.has(decl.id)) {
        seen.add(decl.id);
        cappedPreviewLocationSet(lastPreviewLocations, decl.id, loc);
      }
    }
    const ids = lineText.matchAll(/\b[A-Za-z_]\w*\b/g);
    for (const match of ids) {
      const id = match[0];
      if (seen.has(id) || SKIP_WORDS.has(id) || id.length <= 2 || match.index === undefined) { continue; }
      seen.add(id);
      cappedPreviewLocationSet(
        lastPreviewLocations,
        id,
        new vscode.Location(uri, new vscode.Range(absLine, match.index, absLine, match.index + id.length)),
      );
    }
  }

  return previewLoc;
}

// Preserve the whole source and language in one Markdown code fence. Delivery
// can reopen the fence across native items to avoid VS Code's character cap.
function renderPreviewCodeFences(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

export function buildDefinitionPreviewResult(
  typeName: string,
  defUri: vscode.Uri,
  defDoc: vscode.TextDocument,
  startLine: number,
  hintedEndLine?: number,
  rememberLocations = true,
): NonNullable<DefCacheEntry['result']> {
  const resolvedStartLine = refineDefinitionLineForIdentifier(defDoc, typeName, startLine);
  const previewBlock = collectDefinitionPreview(defDoc, resolvedStartLine, hintedEndLine);
  const lang = defDoc.languageId || 'python';
  const preview = `\`${typeName}\` — ${previewFileLink(defUri, previewBlock.definitionLine)}\n${renderPreviewCodeFences(lang, previewBlock.code)}`;
  // Detached hover windows keep their own navigation lane.  Building one of
  // those pages must not repoint the singleton location LRUs used by the
  // native hover.  Callers can therefore request the same preview payload
  // without the global indexing side effect.
  const location = rememberLocations
    ? rememberPreviewLocations(typeName, defUri, previewBlock)
    : new vscode.Location(
      defUri,
      new vscode.Range(previewBlock.definitionLine, 0, previewBlock.endLine, 0),
    );
  return {
    preview,
    location,
    defUri,
    defDoc,
    previewLineCount: Math.max(0, previewBlock.endLine - previewBlock.previewStartLine),
  };
}

export function languageIdForFsPath(fsPath: string): string {
  if (fsPath.endsWith('.py') || fsPath.endsWith('.pyi')) { return 'python'; }
  if (fsPath.endsWith('.tsx')) { return 'typescriptreact'; }
  if (fsPath.endsWith('.ts') || fsPath.endsWith('.d.ts')) { return 'typescript'; }
  return 'plaintext';
}

export async function readRawFileSnapshot(fsPath: string): Promise<RawFileSnapshot> {
  const stat = await fs.stat(fsPath);
  const cached = rawDefFileCache.get(fsPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    rawDefFileCache.delete(fsPath);
    rawDefFileCache.set(fsPath, cached);
    return cached.snapshot;
  }

  const raw = await fs.readFile(fsPath, 'utf8');
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const snapshot: RawFileSnapshot = {
    languageId: languageIdForFsPath(fsPath),
    uri: { fsPath },
    lines,
    lineCount: lines.length,
    lineAt(line: number) {
      return { text: lines[line] ?? '' };
    },
  };

  cacheRawFileSnapshot(fsPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    // Allow for UTF-16 backing text, line strings and array slots. This is
    // a conservative retention estimate, not a cap on the process's RSS.
    retainedBytes: raw.length * 2 + lines.length * 64,
    snapshot,
  });
  return snapshot;
}

export async function buildDefinitionPreviewResultFromRawFile(
  typeName: string,
  defUri: vscode.Uri,
  fsPath: string,
  startLine: number,
  hintedEndLine?: number,
): Promise<NonNullable<DefCacheEntry['result']>> {
  const rawDoc = await readRawFileSnapshot(fsPath);
  const resolvedStartLine = refineDefinitionLineForIdentifier(rawDoc, typeName, startLine);
  const previewBlock = collectDefinitionPreview(rawDoc, resolvedStartLine, hintedEndLine);
  const lang = rawDoc.languageId || 'python';
  const preview = `\`${typeName}\` — ${previewFileLink(defUri, previewBlock.definitionLine)}\n${renderPreviewCodeFences(lang, previewBlock.code)}`;
  const location = rememberPreviewLocations(typeName, defUri, previewBlock);
  return {
    preview,
    location,
    defUri,
    previewLineCount: Math.max(0, previewBlock.endLine - previewBlock.previewStartLine),
  };
}
