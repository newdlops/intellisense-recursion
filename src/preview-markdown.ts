// Preview-markdown helpers extracted from extension.ts (Phase 5).
//
// Scope:
//   * resolvePreviewMarkdownUri      — relPath → vscode.Uri (open docs first,
//                                       then workspace folders)
//   * parsePreviewMarkdownSource     — extract typeName/relPath/line/lang/code
//                                       from our own preview markdown shape
//   * declarationIndexInLine         — find an identifier's start column when
//                                       it is being declared on the given line
//   * registerPreviewMarkdownLocations — re-populate the per-identifier
//                                       location LRU from a parsed preview
//
// Pure modulo the LRU side-effects inside rememberPreviewLocations.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { isCodeDoc } from './util';
import { declarationIdentifiersInLine } from './idents';
import type { DefinitionPreview } from './preview-engine';
import { rememberPreviewLocations } from './preview-builder';

export async function resolvePreviewMarkdownUri(relPath: string): Promise<vscode.Uri | null> {
  const normalized = relPath.trim();
  if (!normalized) { return null; }

  for (const doc of vscode.workspace.textDocuments) {
    if (!isCodeDoc(doc)) { continue; }
    if (vscode.workspace.asRelativePath(doc.uri) === normalized || doc.uri.fsPath === normalized) {
      return doc.uri;
    }
  }

  const candidates: string[] = [];
  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') { continue; }
    candidates.push(path.join(folder.uri.fsPath, normalized));
  }

  for (const fsPath of candidates) {
    try {
      const stat = await fs.stat(fsPath);
      if (stat.isFile()) { return vscode.Uri.file(fsPath); }
    } catch {}
  }
  return null;
}

export function parsePreviewMarkdownSource(markdown: string): {
  typeName: string;
  relPath: string;
  definitionLine: number;
  languageId: string;
  code: string;
} | null {
  const match = /^`([^`\n]+)`\s+(?:—|-)\s+\*([^*\n]+):(\d+)\*\s*\n```([^\n`]*)\n([\s\S]*?)\n?```/m.exec(markdown);
  if (!match) { return null; }
  const line = Number(match[3]);
  if (!Number.isFinite(line) || line <= 0) { return null; }
  return {
    typeName: match[1],
    relPath: match[2],
    definitionLine: line - 1,
    languageId: match[4].trim() || 'plaintext',
    code: match[5],
  };
}

export function declarationIndexInLine(line: string, identifier: string): number | null {
  for (const decl of declarationIdentifiersInLine(line)) {
    if (decl.id === identifier) { return decl.index; }
  }
  return null;
}

export function registerPreviewMarkdownLocations(
  typeName: string,
  uri: vscode.Uri,
  definitionLine: number,
  code: string,
): { location: vscode.Location; previewStartLine: number } {
  const lines = code.split('\n');
  const declarationOffset = Math.max(0, lines.findIndex(line => declarationIndexInLine(line, typeName) !== null));
  const previewStartLine = Math.max(0, definitionLine - declarationOffset);
  const preview: DefinitionPreview = {
    previewStartLine,
    definitionLine,
    endLine: previewStartLine + lines.length,
    code,
  };
  return {
    location: rememberPreviewLocations(typeName, uri, preview),
    previewStartLine,
  };
}
