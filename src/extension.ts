import * as vscode from 'vscode';
import * as inspector from 'node:inspector';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import WebSocket from 'ws';
import { IndexManager, IndexStatus } from './indexManager';
import type { SidecarHit, SidecarKind, SidecarLanguage } from './sidecar';

const log = vscode.window.createOutputChannel('IntelliSense Recursion', { log: true });

// ── Rust sidecar fast-path manager (Phase 3) ──
// Null when no workspace or binary missing; all callers guard on this.
let indexManager: IndexManager | null = null;

function workspaceRootFsPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || folders[0].uri.scheme !== 'file') { return null; }
  return folders[0].uri.fsPath;
}

function isPythonFsPath(fsPath: string): boolean {
  return fsPath.endsWith('.py') || fsPath.endsWith('.pyi');
}

function isSupportedFsPath(fsPath: string): boolean {
  return (
    isPythonFsPath(fsPath)
    || fsPath.endsWith('.ts')
    || fsPath.endsWith('.tsx')
    || fsPath.endsWith('.d.ts')
  );
}

/**
 * Derive the sidecar language tag from the file that triggered a lookup.
 * Returns undefined for files we don't index (means: don't apply a language
 * filter on the sidecar query — but we also wouldn't reach here since the
 * fast-path is gated by isSupportedFsPath).
 */
function languageOf(fsPath: string): SidecarLanguage | undefined {
  if (isPythonFsPath(fsPath)) { return 'python'; }
  if (fsPath.endsWith('.ts') || fsPath.endsWith('.tsx') || fsPath.endsWith('.d.ts')) {
    return 'typescript';
  }
  return undefined;
}

/**
 * Ask the sidecar for the best definition of `typeName` and return it only
 * when the answer is unambiguous.
 *
 * Heuristic: exactly one non-alias hit across all kinds. If two or more
 * non-aliases exist (e.g. `Meta` defined in many Django models, `created_at`
 * on many models) we return null and let the LSP path disambiguate via type
 * inference.
 */
// PascalCase / SCREAMING_SNAKE only — names shaped like parameter/method
// (snake_case, starts lowercase) stay on the LSP path because the sidecar
// doesn't index parameters or local variables.
const TYPE_SHAPED_NAME = /^[A-Z_][A-Za-z0-9_]*$/;
const CONSTANT_SHAPED_NAME = /^_*[A-Z][A-Z0-9_]*$/;

/**
 * True when the sidecar has full-library coverage AND returns zero hits for
 * `typeName`. In that case LSP won't find it either (we already index
 * .venv/stdlib/typeshed) so we save the 1.5 s timeout.
 */
/**
 * Short-circuit the LSP path only when we're confident the symbol doesn't
 * exist anywhere the sidecar would find it. Python has full library coverage
 * (venv + stdlib + typeshed), so a miss is authoritative. TypeScript coverage
 * is partial (node_modules has .d.ts but also parameters/generics we skip) —
 * we don't short-circuit there.
 */
async function sidecarDefinitivelyMissing(
  typeName: string,
  originFsPath: string,
): Promise<boolean> {
  if (!indexManager?.hasFullCoverage()) { return false; }
  if (!TYPE_SHAPED_NAME.test(typeName)) { return false; }
  if (CONSTANT_SHAPED_NAME.test(typeName)) { return false; }
  const language = languageOf(originFsPath);
  if (!language) { return false; }
  // Applies to Python (.venv + stdlib + typeshed covered) and TypeScript
  // (node_modules covered). If the sidecar finds nothing in the appropriate
  // language pool, LSP will almost always time out too — skip it.
  const hits = await indexManager.lookup(typeName, 1, language);
  return hits.length === 0;
}

/** Shared directory-component depth between two absolute paths. */
function sharedDirDepth(a: string, b: string): number {
  const aParts = path.dirname(a).split(path.sep);
  const bParts = path.dirname(b).split(path.sep);
  const max = Math.min(aParts.length, bParts.length);
  let i = 0;
  while (i < max && aParts[i] === bParts[i]) { i++; }
  return i;
}

/**
 * Pick the hit whose path shares the deepest directory prefix with `origin`.
 * Returns null when two or more hits tie for the deepest prefix (ambiguous).
 */
function pickByProximity<T extends { path: string }>(
  candidates: T[],
  origin: string,
): T | null {
  let best: T | null = null;
  let bestDepth = -1;
  let tie = false;
  for (const c of candidates) {
    const d = sharedDirDepth(c.path, origin);
    if (d > bestDepth) { best = c; bestDepth = d; tie = false; }
    else if (d === bestDepth) { tie = true; }
  }
  return tie || bestDepth < 0 ? null : best;
}

type ImportTarget = {
  relPath: string;
  importedName: string;
};

const MODULE_IMPORT_TARGET = '*module*';
const IMPORT_SCAN_MAX_LINES = 500;

function workspaceRelPathForFsPath(fsPath: string): string | null {
  const root = workspaceRootFsPath();
  if (!root) { return null; }
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return rel.replace(/\\/g, '/');
}

function sidecarHitRelPath(hit: SidecarHit): string | null {
  return workspaceRelPathForFsPath(hit.path);
}

function dedupeImportTargets(targets: ImportTarget[]): ImportTarget[] {
  const seen = new Set<string>();
  const out: ImportTarget[] = [];
  for (const target of targets) {
    const key = `${target.relPath}:${target.importedName}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(target);
  }
  return out;
}

function importScanText(doc: vscode.TextDocument): string {
  const max = Math.min(doc.lineCount, IMPORT_SCAN_MAX_LINES);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    lines.push(doc.lineAt(i).text);
  }
  return lines.join('\n');
}

function isTsLikeRelPath(relPath: string): boolean {
  return /\.(?:tsx?|jsx?|mjs|cjs)$/.test(relPath);
}

function resolveRelativeModuleCandidates(sourceRelPath: string, moduleSpecifier: string): string[] {
  if (!moduleSpecifier.startsWith('.')) { return []; }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelPath), moduleSpecifier));
  if (path.posix.extname(base)) { return [base]; }
  const out: string[] = [];
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    out.push(`${base}.${ext}`);
  }
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    out.push(`${base}/index.${ext}`);
  }
  return out;
}

function importedNamesForLocalName(importClause: string, localName: string): string[] {
  const out: string[] = [];
  const brace = /\{([\s\S]*?)\}/.exec(importClause);
  if (brace) {
    for (const rawItem of brace[1].split(',')) {
      let item = rawItem.trim();
      if (item.startsWith('type ')) { item = item.slice('type '.length).trimStart(); }
      if (!item) { continue; }
      const alias = /\s+as\s+/.test(item) ? item.split(/\s+as\s+/) : [item, item];
      const imported = alias[0]?.trim();
      const local = alias[1]?.trim();
      if (local === localName && imported) { out.push(imported); }
    }
  }
  const defaultPart = importClause.split('{')[0]?.split(',')[0]?.trim();
  if (defaultPart === localName) { out.push(localName); }
  const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(importClause);
  if (namespaceMatch?.[1] === localName) { out.push(MODULE_IMPORT_TARGET); }
  return out;
}

function tsImportTargetsForIdentifier(documentText: string, sourceRelPath: string, localName: string): ImportTarget[] {
  const out: ImportTarget[] = [];
  const importRegex = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of documentText.matchAll(importRegex)) {
    const clause = match[1] ?? '';
    const moduleSpecifier = match[2] ?? '';
    const targetRelPaths = resolveRelativeModuleCandidates(sourceRelPath, moduleSpecifier);
    if (targetRelPaths.length === 0) { continue; }
    for (const importedName of importedNamesForLocalName(clause, localName)) {
      for (const relPath of targetRelPaths) {
        out.push({ relPath, importedName });
      }
    }
  }
  return dedupeImportTargets(out);
}

function pythonModuleCandidates(sourceRelPath: string, moduleName: string): string[] {
  let dots = 0;
  while (dots < moduleName.length && moduleName[dots] === '.') { dots++; }
  const rawModule = moduleName.slice(dots);
  let baseParts = rawModule ? rawModule.split('.').filter(Boolean) : [];
  if (dots > 0) {
    const sourceParts = sourceRelPath.split('/').slice(0, -1);
    const keep = Math.max(0, sourceParts.length - Math.max(0, dots - 1));
    baseParts = [...sourceParts.slice(0, keep), ...baseParts];
  }
  const base = baseParts.join('/');
  if (!base) { return []; }
  return [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`];
}

function pythonImportTargetsForIdentifier(documentText: string, sourceRelPath: string, localName: string): ImportTarget[] {
  const out: ImportTarget[] = [];
  const fromImportRegex = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm;
  for (const match of documentText.matchAll(fromImportRegex)) {
    const moduleName = match[1] ?? '';
    const clause = (match[2] ?? '').split('#')[0] ?? '';
    const targetRelPaths = pythonModuleCandidates(sourceRelPath, moduleName);
    if (targetRelPaths.length === 0) { continue; }
    for (const rawItem of clause.split(',')) {
      const item = rawItem.trim();
      if (!item || item === '*') { continue; }
      const parts = item.split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (local !== localName || !imported) { continue; }
      for (const relPath of targetRelPaths) {
        out.push({ relPath, importedName: imported });
      }
    }
  }
  return dedupeImportTargets(out);
}

function importTargetsForIdentifier(
  doc: vscode.TextDocument | undefined,
  localName: string,
): ImportTarget[] {
  if (!doc || doc.uri.scheme !== 'file') { return []; }
  const sourceRelPath = workspaceRelPathForFsPath(doc.uri.fsPath);
  if (!sourceRelPath) { return []; }
  const text = importScanText(doc);
  if (isTsLikeRelPath(sourceRelPath)) {
    return tsImportTargetsForIdentifier(text, sourceRelPath, localName);
  }
  if (sourceRelPath.endsWith('.py') || sourceRelPath.endsWith('.pyi')) {
    return pythonImportTargetsForIdentifier(text, sourceRelPath, localName);
  }
  return [];
}

function hitMatchesImportTarget(hit: SidecarHit, queryName: string, target: ImportTarget): boolean {
  const rel = sidecarHitRelPath(hit);
  if (!rel) { return false; }
  const importedMatches = target.importedName === MODULE_IMPORT_TARGET
    || queryName === target.importedName;
  if (!importedMatches) { return false; }
  if (rel === target.relPath) { return true; }
  if (target.relPath.endsWith('/__init__.py') || target.relPath.endsWith('/__init__.pyi')) {
    const dir = path.posix.dirname(target.relPath);
    return rel.startsWith(`${dir}/`);
  }
  return false;
}

function chooseSidecarHit(
  hits: SidecarHit[],
  originFsPath: string,
  typeName: string,
): SidecarHit | null {
  const nonAlias = hits.filter((h) => h.kind !== 'alias');
  if (nonAlias.length === 0) { return null; }

  const projectNonAlias = nonAlias.filter((h) => h.source === 'project');
  if (projectNonAlias.length === 1) { return projectNonAlias[0]; }
  if (projectNonAlias.length > 1) {
    if (!TYPE_SHAPED_NAME.test(typeName)) { return null; }
    return pickByProximity(projectNonAlias, originFsPath);
  }

  if (!TYPE_SHAPED_NAME.test(typeName)) { return null; }
  return nonAlias[0];
}

async function fastResolveTypeName(
  typeName: string,
  originFsPath: string,
  originDoc?: vscode.TextDocument,
): Promise<SidecarHit | null> {
  if (!indexManager) { return null; }
  // Ask the sidecar for same-language hits only. Cross-language jumps
  // (e.g. `.tsx` → Python stub file) are always wrong for our users.
  const language = languageOf(originFsPath);
  const importTargets = importTargetsForIdentifier(originDoc, typeName);
  const queryNames = [...new Set([
    typeName,
    ...importTargets
      .map((target) => target.importedName)
      .filter((name) => name !== MODULE_IMPORT_TARGET),
  ])];

  if (importTargets.length > 0 && queryNames.length > 1) {
    const results = await indexManager.lookupMany(queryNames, 50, language);
    const importedHits: Array<{ hit: SidecarHit; queryName: string }> = [];
    for (const result of results) {
      for (const hit of result.hits) {
        if (importTargets.some((target) => hitMatchesImportTarget(hit, result.name, target))) {
          importedHits.push({ hit, queryName: result.name });
        }
      }
    }
    const chosenImported = chooseSidecarHit(
      importedHits.map((entry) => entry.hit),
      originFsPath,
      typeName,
    );
    if (chosenImported) { return chosenImported; }
  }

  const hits = await indexManager.lookup(typeName, 50, language);
  if (hits.length === 0) { return null; }

  if (importTargets.length > 0) {
    const scopedHits = hits.filter((hit) =>
      importTargets.some((target) => hitMatchesImportTarget(hit, typeName, target)));
    const chosenScoped = chooseSidecarHit(scopedHits, originFsPath, typeName);
    if (chosenScoped) { return chosenScoped; }
  }

  // If the workspace itself defines the symbol, prefer project-side hits.
  // Multiple project definitions (e.g. `class Meta` across Django models,
  // `DIRECTOR` across several enum classes) are resolved by directory
  // proximity when possible. Otherwise we fall back to LSP.
  return chooseSidecarHit(hits, originFsPath, typeName);
}

/**
 * Definition preview extraction is intentionally more verbose than native
 * language-server hovers: show the whole syntactic block, then let the hover
 * widget scroll when the block is long.
 */
const DEFINITION_PREVIEW_FALLBACK_LINES = 120;
const DEFINITION_PREVIEW_SAFETY_MAX_LINES = 10_000;
const DEFINITION_PREVIEW_VALUE_MAX_LINES = 600;

interface DefinitionPreview {
  previewStartLine: number;
  definitionLine: number;
  endLine: number;
  code: string;
}

interface TextLikeDocument {
  languageId?: string;
  uri: { fsPath: string };
  lineCount: number;
  lineAt(line: number): { text: string };
}

interface RawFileSnapshot extends TextLikeDocument {
  languageId: string;
  lines: string[];
}

const RAW_DEF_FILE_CACHE_MAX = 24;
const rawDefFileCache = new Map<string, {
  mtimeMs: number;
  size: number;
  snapshot: RawFileSnapshot;
}>();

function isPythonLikeDoc(doc: TextLikeDocument): boolean {
  return doc.languageId === 'python' || doc.uri.fsPath.endsWith('.py') || doc.uri.fsPath.endsWith('.pyi');
}

function indentationWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') { width++; }
    else if (ch === '\t') { width += 4; }
    else { break; }
  }
  return width;
}

function includeLeadingDefinitionDecorators(doc: TextLikeDocument, line: number): number {
  let start = line;
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = doc.lineAt(i).text.trim();
    if (!trimmed) { break; }
    if (trimmed.startsWith('@') || trimmed.startsWith('#[')) { start = i; continue; }
    break;
  }
  return start;
}

function isPythonValueDefinitionLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) { return false; }
  if (/^(class|def|async\s+def|import|from|for|while|if|elif|else|try|except|finally|with|return|raise|yield|assert|del|global|nonlocal)\b/.test(trimmed)) {
    return false;
  }
  return /^\s*[A-Za-z_]\w*(?:\s*:\s*[^=]+)?\s*=/.test(text);
}

function isBraceValueDefinitionLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) { return false; }
  if (/^(export\s+)?(default\s+)?(class|interface|enum|type|function)\b/.test(trimmed)) { return false; }
  return /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\b/.test(text)
    || /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|abstract\s+)*[A-Za-z_$][\w$]*\s*(?:[:=])/.test(text);
}

function valueLineContinues(text: string, pythonLike: boolean): boolean {
  const trimmed = text.trim().replace(/\/\/.*$/, '');
  if (!trimmed) { return false; }
  if (pythonLike && trimmed.endsWith('\\')) { return true; }
  if (!pythonLike && /;\s*$/.test(trimmed)) { return false; }
  return /(?:[,=:+\-*/%&|^?.]|\b(?:and|or|is|in|as|extends|satisfies))$/.test(trimmed);
}

function findValueDefinitionEndLine(doc: TextLikeDocument, definitionLine: number): number | null {
  const pythonLike = isPythonLikeDoc(doc);
  const firstLine = doc.lineAt(definitionLine).text;
  if (pythonLike ? !isPythonValueDefinitionLine(firstLine) : !isBraceValueDefinitionLine(firstLine)) {
    return null;
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let blockComment = false;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  const scanEnd = Math.min(doc.lineCount, definitionLine + DEFINITION_PREVIEW_VALUE_MAX_LINES);

  for (let i = definitionLine; i < scanEnd; i++) {
    const line = doc.lineAt(i).text;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      if (blockComment) {
        if (ch === '*' && next === '/') { blockComment = false; j++; }
        continue;
      }

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (pythonLike && ch === '#') { break; }
      if (!pythonLike && ch === '/' && next === '/') { break; }
      if (!pythonLike && ch === '/' && next === '*') { blockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || (!pythonLike && ch === '`')) { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
      if (!pythonLike && ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return i + 1;
      }
    }

    if (quote || blockComment || parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) { continue; }
    if (!valueLineContinues(line, pythonLike)) { return i + 1; }
  }

  return scanEnd;
}

function findPythonHeaderEndLine(doc: TextLikeDocument, definitionLine: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = definitionLine; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (ch === '#') { break; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
      if (ch === ':' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return i;
      }
    }
  }

  return definitionLine;
}

function findPythonBlockEndLine(doc: TextLikeDocument, definitionLine: number): number {
  const baseIndent = indentationWidth(doc.lineAt(definitionLine).text);
  const headerEndLine = findPythonHeaderEndLine(doc, definitionLine);
  for (let i = headerEndLine + 1; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.trim()) { continue; }
    if (indentationWidth(text) <= baseIndent) { return i; }
  }
  return doc.lineCount;
}

function findBraceBlockEndLine(doc: TextLikeDocument, definitionLine: number): number | null {
  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let started = false;
  let blockComment = false;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = definitionLine; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      if (blockComment) {
        if (ch === '*' && next === '/') { blockComment = false; j++; }
        continue;
      }

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (ch === '/' && next === '/') { break; }
      if (ch === '/' && next === '*') { blockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }

      if (ch === '{') {
        started = true;
        depth++;
        continue;
      }
      if (ch === '}' && started) {
        depth--;
        if (depth <= 0) { return i + 1; }
        continue;
      }
      if (!started && ch === ';' && parenDepth === 0 && bracketDepth === 0) {
        return i + 1;
      }
    }
  }

  return started ? doc.lineCount : null;
}

function collectDefinitionPreview(
  doc: TextLikeDocument,
  requestedStartLine: number,
  hintedEndLine?: number,
): DefinitionPreview {
  const definitionLine = Math.max(0, Math.min(requestedStartLine, Math.max(0, doc.lineCount - 1)));
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

  const uncappedEndLine = endLine;
  endLine = Math.min(endLine, previewStartLine + DEFINITION_PREVIEW_SAFETY_MAX_LINES);

  const lines: string[] = [];
  for (let i = previewStartLine; i < endLine; i++) { lines.push(doc.lineAt(i).text); }
  if (endLine < uncappedEndLine) {
    lines.push(`... (${uncappedEndLine - endLine} more lines)`);
  }

  return {
    previewStartLine,
    definitionLine,
    endLine,
    code: lines.join('\n'),
  };
}

function rememberPreviewLocations(
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
  const lineTexts = preview.code.split('\n');
  for (let offset = 0; offset < lineTexts.length; offset++) {
    const lineText = lineTexts[offset];
    const absLine = preview.previewStartLine + offset;
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

function buildDefinitionPreviewResult(
  typeName: string,
  defUri: vscode.Uri,
  defDoc: vscode.TextDocument,
  startLine: number,
  hintedEndLine?: number,
): NonNullable<DefCacheEntry['result']> {
  const previewBlock = collectDefinitionPreview(defDoc, startLine, hintedEndLine);
  const relPath = vscode.workspace.asRelativePath(defUri);
  const lang = defDoc.languageId || 'python';
  const preview = `\`${typeName}\` — *${relPath}:${previewBlock.definitionLine + 1}*\n\`\`\`${lang}\n${previewBlock.code}\n\`\`\``;
  const location = rememberPreviewLocations(typeName, defUri, previewBlock);
  return {
    preview,
    location,
    defUri,
    defDoc,
    previewLineCount: Math.max(0, previewBlock.endLine - previewBlock.previewStartLine),
  };
}

function languageIdForFsPath(fsPath: string): string {
  if (fsPath.endsWith('.py') || fsPath.endsWith('.pyi')) { return 'python'; }
  if (fsPath.endsWith('.tsx')) { return 'typescriptreact'; }
  if (fsPath.endsWith('.ts') || fsPath.endsWith('.d.ts')) { return 'typescript'; }
  return 'plaintext';
}

async function readRawFileSnapshot(fsPath: string): Promise<RawFileSnapshot> {
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

  if (rawDefFileCache.size >= RAW_DEF_FILE_CACHE_MAX) {
    const first = rawDefFileCache.keys().next().value;
    if (first !== undefined) { rawDefFileCache.delete(first); }
  }
  rawDefFileCache.set(fsPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    snapshot,
  });
  return snapshot;
}

async function buildDefinitionPreviewResultFromRawFile(
  typeName: string,
  defUri: vscode.Uri,
  fsPath: string,
  startLine: number,
  hintedEndLine?: number,
): Promise<NonNullable<DefCacheEntry['result']>> {
  const rawDoc = await readRawFileSnapshot(fsPath);
  const previewBlock = collectDefinitionPreview(rawDoc, startLine, hintedEndLine);
  const relPath = vscode.workspace.asRelativePath(defUri);
  const lang = rawDoc.languageId || 'python';
  const preview = `\`${typeName}\` — *${relPath}:${previewBlock.definitionLine + 1}*\n\`\`\`${lang}\n${previewBlock.code}\n\`\`\``;
  const location = rememberPreviewLocations(typeName, defUri, previewBlock);
  return {
    preview,
    location,
    defUri,
    previewLineCount: Math.max(0, previewBlock.endLine - previewBlock.previewStartLine),
  };
}

/**
 * Build the same DefCacheEntry payload as resolveInBackground's LSP success
 * path, but from a sidecar hit. Reads the target file directly instead of
 * asking VS Code to open a TextDocument; this mirrors the MCP snippet path
 * and keeps definition capture off the language-service/UI hot path.
 */
async function buildResultFromFastHit(
  typeName: string,
  hit: SidecarHit,
): Promise<DefCacheEntry['result']> {
  // hit.path is always absolute (v2 format reconstructs root + relative).
  const defUri = vscode.Uri.file(hit.path);
  const startLine = Math.max(0, hit.line - 1);
  try {
    return await buildDefinitionPreviewResultFromRawFile(typeName, defUri, hit.path, startLine);
  } catch (rawErr) {
    log.warn(`[bg]   "${typeName}" raw fast preview failed: ${rawErr}`);
    const defDoc = findOpenDoc(defUri)
      ?? await withTimeout(vscode.workspace.openTextDocument(defUri), 1_000, 'openDef (fast)');
    return buildDefinitionPreviewResult(typeName, defUri, defDoc, startLine);
  }
}

const PREVIEW_LOCATION_MAX_SIZE = 1_000;
const lastPreviewLocations = new Map<string, vscode.Location>();
const lastPreviewDeclarationLocations = new Map<string, vscode.Location>();
let lastHoverDocUri = '';
let hoverRecursionDepth = 0;
let reinjectTimer: ReturnType<typeof setInterval> | undefined;
let rendererReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let rendererInjectInFlight: Promise<void> | null = null;
let extensionDeactivated = false;
let lastClickId = '';
let lastClickTime = 0;
// A new click aborts an in-flight click via this controller.
let currentClickController: AbortController | null = null;
let hoverPatchActive = false;
// Current main-process CDP WebSocket, tracked so reconnect cleanup only
// clears the listener that originally owned the socket.
let mainWsRef: WebSocket | null = null;

function cappedPreviewLocationSet(map: Map<string, vscode.Location>, key: string, value: vscode.Location) {
  if (map.has(key)) { map.delete(key); }
  while (map.size >= PREVIEW_LOCATION_MAX_SIZE) {
    const first = map.keys().next().value;
    if (first === undefined) { break; }
    map.delete(first);
  }
  map.set(key, value);
}

function cappedPreviewLocationGet(map: Map<string, vscode.Location>, key: string): vscode.Location | undefined {
  const value = map.get(key);
  if (!value) { return undefined; }
  map.delete(key);
  map.set(key, value);
  return value;
}

function clearRendererReconnectTimer() {
  if (rendererReconnectTimer) {
    clearTimeout(rendererReconnectTimer);
    rendererReconnectTimer = undefined;
  }
}

function closeMainWebSocket() {
  const ws = mainWsRef;
  mainWsRef = null;
  if (!ws) { return; }
  try { ws.removeAllListeners(); } catch {}
  try { ws.close(); } catch {}
}

function scheduleRendererReconnect() {
  if (extensionDeactivated || rendererReconnectTimer) { return; }
  rendererReconnectTimer = setTimeout(() => {
    rendererReconnectTimer = undefined;
    if (extensionDeactivated) { return; }
    log.info('[listen] Attempting CDP reconnect...');
    runRendererInjection(injectRenderer).catch(err => log.error(`[listen] Reconnect failed: ${err}`));
  }, 2000);
}

async function runRendererInjection(fn: () => Promise<void>): Promise<void> {
  if (rendererInjectInFlight) { return rendererInjectInFlight; }
  rendererInjectInFlight = fn().finally(() => {
    rendererInjectInFlight = null;
  });
  return rendererInjectInFlight;
}

// "Page-transition" state: when set, the next $provideHover call (within
// the time window) returns this markdown as its only content instead of
// the original symbol's hover. Set by previewTypeHandler before
// triggering editor.action.showHover, consumed and cleared by the
// patched $provideHover. VS Code re-renders via its native pipeline so
// theme + tokenization are applied for free.
interface PendingPreviewHover {
  identifier: string;
  contents: any[];   // vscode.Hover['contents']-shaped array
  range?: any;
  expiresAt: number;
}
let pendingPreviewHover: PendingPreviewHover | null = null;
// After the override is delivered to the first handle, suppress all
// further handle responses for a short window so VS Code's hover
// aggregator doesn't repeat the drill-down panel once per registered
// provider. Parallel handles in the same showHover fanout fire within
// a few ms; 500ms is a generous bound. Unrelated hovers after the
// window go through the normal LSP path.
let previewHoverSuppressUntil = 0;

// Last position where VS Code's native hover was successfully fetched.
// Captured by the patched $provideHover so previewTypeHandler can move
// the text cursor there before triggering editor.action.showHover —
// otherwise showHover is a no-op when a hover is already visible, or
// triggers hover for the wrong position.
let lastHoverFetchPosition: { uri: vscode.Uri; line: number; character: number } | null = null;

// Drill-down history: each forward drill-down pushes the previously
// rendered drill-down state onto previewHistory; "Back" pops it back
// into currentPreviewState and refires the hover. The stack is reset
// whenever $provideHover reaches the genuine LSP path (i.e. past the
// pending-preview consume + suppression window) — that's the moment a
// brand-new hover session starts, so no prior chain should carry over.
interface PreviewState {
  identifier: string;
  markdown: string;          // raw drill-down body, no back link prepended
  anchor: { uri: vscode.Uri; line: number; character: number };
  anchorRange?: vscode.Range;
}
const previewHistory: PreviewState[] = [];
let currentPreviewState: PreviewState | null = null;

// ── Definition cache (LRU-style with TTL) ──
// Key: "uri:line:character:typeName", Value: cached result or negative marker
interface DefCacheEntry {
  timestamp: number;
  /** null = negative cache (defProvider returned 0 and hover fallback failed) */
  result: {
    preview: string;
    location: vscode.Location;
    defUri: vscode.Uri;
    defDoc?: vscode.TextDocument;
    previewLineCount?: number;
  } | null;
}
const defCache = new Map<string, DefCacheEntry>();
const DEF_CACHE_TTL = 60_000;       // positive cache: 60s
const DEF_CACHE_NEG_TTL = 30_000;   // negative cache: 30s
const DEF_CACHE_MAX_SIZE = 200;

function defCacheKey(uri: vscode.Uri, pos: vscode.Position, typeName: string): string {
  return `${uri.fsPath}:${pos.line}:${pos.character}:${typeName}`;
}

function defCacheGet(key: string): DefCacheEntry | undefined {
  const entry = defCache.get(key);
  if (!entry) { return undefined; }
  const ttl = entry.result ? DEF_CACHE_TTL : DEF_CACHE_NEG_TTL;
  if (Date.now() - entry.timestamp > ttl) {
    defCache.delete(key);
    return undefined;
  }
  return entry;
}

function defCacheSet(key: string, result: DefCacheEntry['result']) {
  // Simple eviction: drop oldest entries when over limit
  if (defCache.size >= DEF_CACHE_MAX_SIZE) {
    const firstKey = defCache.keys().next().value;
    if (firstKey !== undefined) { defCache.delete(firstKey); }
  }
  defCache.set(key, { timestamp: Date.now(), result });
}

// ── Click negative cache ──
// Identifier-level: short-circuits goToTypeHandler when a prior click already
// walked every fallback (steps 1-6) and came up empty. Avoids re-running the
// ~3-4s import-source scan for genuinely unresolvable tokens. Cleared on save.
const clickNegCache = new Map<string, number>();
const CLICK_NEG_TTL = 60_000;
const CLICK_NEG_MAX = 200;
function clickNegGet(identifier: string): boolean {
  const ts = clickNegCache.get(identifier);
  if (ts === undefined) { return false; }
  if (Date.now() - ts > CLICK_NEG_TTL) { clickNegCache.delete(identifier); return false; }
  return true;
}
function clickNegSet(identifier: string) {
  if (clickNegCache.size >= CLICK_NEG_MAX) {
    const k = clickNegCache.keys().next().value;
    if (k !== undefined) { clickNegCache.delete(k); }
  }
  clickNegCache.set(identifier, Date.now());
}

// ── Hover definition resolve ──
// First hover must include the definition preview when a definition can be
// resolved. Slow language-server calls are still bounded inside
// resolveInBackground(), but we no longer return a symbol-only hover just
// because the fast path missed a tiny UI budget.
const HOVER_DOC_SCAN_MAX_LINES = 5_000;
// defProvider is the hot path — Pylance/Jedi commonly stalls up to several
// seconds on cold symbols. 1500ms keeps the ceiling low without dropping most
// successful resolves (observed p95 ~1300ms).
const BG_RESOLVE_DEF_TIMEOUT_MS = 1_500;
// Hover fallback can pull docstrings over the wire; allow a bit more headroom.
const BG_RESOLVE_HOVER_TIMEOUT_MS = 2_000;
const IR_DIRECT_HOVER_MARKER = '<!--ir-direct-hover-->';

const inflightResolves = new Map<string, Promise<DefCacheEntry['result']>>();
let internalHoverProviderRequestDepth = 0;

function withTimeout<T>(p: Thenable<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

function findOpenDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  const fs = uri.fsPath;
  return vscode.workspace.textDocuments.find(d => d.uri.fsPath === fs);
}

/**
 * Actual defProvider + hoverProvider resolve. Runs to completion (bounded by
 * BG_RESOLVE_DEF_TIMEOUT_MS / BG_RESOLVE_HOVER_TIMEOUT_MS) and writes the
 * result to cache. Deduplicated by cacheKey via `inflightResolves` so
 * concurrent hovers don't spawn duplicate work.
 */
function resolveInBackground(
  typeName: string,
  matchUri: vscode.Uri,
  pos: vscode.Position,
  cacheKey: string,
  mode: 'hover' | 'prefetch' = 'hover',
): Promise<DefCacheEntry['result']> {
  // Only hover participates in in-flight dedup. Prefetch runs independently
  // so a concurrent hover can still take the full LSP path instead of
  // inheriting prefetch's null (sidecar-skip) result.
  if (mode === 'hover') {
    const existing = inflightResolves.get(cacheKey);
    if (existing) { return existing; }
  }

  const p = (async (): Promise<DefCacheEntry['result']> => {
    const t0 = Date.now();
    try {
      // Fast path via the Rust sidecar. Applies to any language the indexer
      // understands (.py, .pyi, .ts, .tsx, .d.ts).
      if (indexManager && isSupportedFsPath(matchUri.fsPath)) {
        try {
          const fastHit = await fastResolveTypeName(typeName, matchUri.fsPath, findOpenDoc(matchUri));
          if (fastHit) {
            const entry = await buildResultFromFastHit(typeName, fastHit);
            if (entry) {
              defCacheSet(cacheKey, entry);
              log.info(`[bg]   "${typeName}" → fast def ${fastHit.path}:${fastHit.line} lines=${entry.previewLineCount ?? '?'} md=${entry.preview.length} (${Date.now() - t0}ms)`);
              return entry;
            }
          } else if (await sidecarDefinitivelyMissing(typeName, matchUri.fsPath)) {
            // Full Python library coverage + zero hits + type-shaped name →
            // LSP won't find anything either. Cache negative and skip the
            // 1.5 s timeout.
            defCacheSet(cacheKey, null);
            log.info(`[bg]   "${typeName}" → sidecar miss (full coverage), skipping LSP (${Date.now() - t0}ms)`);
            return null;
          }
        } catch (err) {
          log.warn(`[bg]   "${typeName}" fast-path error: ${err}`);
          // fall through to LSP
        }
      }

      // Prefetch is speculative warmup — skip LSP entirely. Don't cache so
      // a real hover can retry via LSP if the user actually lands on this
      // token. Prevents 30-token prefetch batches from stacking 1.5 s LSP
      // timeouts during Pylance backpressure.
      if (mode === 'prefetch') {
        log.info(`[bg]   "${typeName}" → prefetch skip LSP (${Date.now() - t0}ms)`);
        return null;
      }

      const defs = await withTimeout(
        vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', matchUri, pos),
        BG_RESOLVE_DEF_TIMEOUT_MS,
        'defProvider',
      );

      const def = defs?.length ? normalizeDef(defs[0]) : null;
      if (def) {
        const defDoc = findOpenDoc(def.uri) ?? await withTimeout(
          vscode.workspace.openTextDocument(def.uri),
          BG_RESOLVE_DEF_TIMEOUT_MS,
          'openDef',
        );
        const startLine = def.range.start.line;
        const relPath = vscode.workspace.asRelativePath(def.uri);
        const hintedEndLine = def.range.end.line > startLine ? def.range.end.line : undefined;
        const result = buildDefinitionPreviewResult(typeName, def.uri, defDoc, startLine, hintedEndLine);
        defCacheSet(cacheKey, result);
        // Promote the LSP-resolved location into the sidecar's discovery
        // cache so future lookups for `typeName` from anywhere in the
        // session can short-circuit the LSP path (which costs ~1.5s on
        // pylance backpressure). Best-effort; sidecar invalidates on any
        // edit to this file. Kind is a heuristic — type-shaped names skew
        // class, anything else falls back to function.
        if (indexManager && isSupportedFsPath(def.uri.fsPath)) {
          const kind: SidecarKind = CONSTANT_SHAPED_NAME.test(typeName)
            ? 'variable'
            : TYPE_SHAPED_NAME.test(typeName) ? 'class' : 'function';
          void indexManager.addDiscovery(
            typeName,
            def.uri.fsPath,
            def.range.start.line + 1,
            def.range.start.character + 1,
            kind,
          );
        }
        log.info(`[bg]   "${typeName}" → def ${relPath}:${startLine + 1} lines=${result.previewLineCount ?? '?'} md=${result.preview.length} (${Date.now() - t0}ms)`);
        return result;
      }

      // Hover fallback
      try {
        let hovers: vscode.Hover[] | undefined;
        internalHoverProviderRequestDepth++;
        try {
          hovers = await withTimeout(
            vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', matchUri, pos),
            BG_RESOLVE_HOVER_TIMEOUT_MS,
            'hoverProvider',
          );
        } finally {
          internalHoverProviderRequestDepth--;
        }
        if (hovers?.length) {
          const hoverParts: string[] = [];
          for (const h of hovers) {
            for (const c of (h.contents as any[])) {
              const val = typeof c === 'string' ? c
                : c instanceof vscode.MarkdownString ? c.value
                : (c && typeof c.value === 'string') ? c.value
                : null;
              if (val) { hoverParts.push(val); }
            }
          }
          if (hoverParts.length > 0) {
            const preview = `\`${typeName}\` — *doc*\n${hoverParts.join('\n')}`;
            const hoverLoc = new vscode.Location(matchUri, new vscode.Range(pos, pos));
            cappedPreviewLocationSet(lastPreviewLocations, typeName, hoverLoc);
            for (const ht of findTypeNames(hoverParts.join('\n'))) {
              cappedPreviewLocationSet(lastPreviewLocations, ht, hoverLoc);
            }
            const result = { preview, location: hoverLoc, defUri: matchUri };
            defCacheSet(cacheKey, result);
            log.info(`[bg]   "${typeName}" → hover fallback ok (${Date.now() - t0}ms)`);
            return result;
          }
        }
      } catch (hoverErr) {
        log.warn(`[bg]   "${typeName}" hover error: ${hoverErr} (${Date.now() - t0}ms)`);
      }

      defCacheSet(cacheKey, null);
      log.info(`[bg]   "${typeName}" → negative (${Date.now() - t0}ms)`);
      return null;
    } catch (err) {
      // Timeout or LS error: don't cache — may succeed later
      log.warn(`[bg]   "${typeName}" resolve failed: ${err} (${Date.now() - t0}ms)`);
      return null;
    } finally {
      if (mode === 'hover') { inflightResolves.delete(cacheKey); }
    }
  })();

  if (mode === 'hover') { inflightResolves.set(cacheKey, p); }
  return p;
}

// ── (D) Regex compile cache ──
// Boundary-anchored regex per typeName. Reused across hovers and prefetch.
const regexCache = new Map<string, RegExp>();
function typeRegex(name: string): RegExp {
  let r = regexCache.get(name);
  if (!r) {
    r = new RegExp(`\\b${esc(name)}\\b`);
    if (regexCache.size > 500) {
      const k = regexCache.keys().next().value;
      if (k !== undefined) { regexCache.delete(k); }
    }
    regexCache.set(name, r);
  }
  return r;
}

// ── (A) Position-level preview cache ──
// Key: "uri:line:col". Short TTL — guards against re-computing for the same
// hover event across handles and for rapid re-hovers at the same point.
interface PosPreviewEntry {
  timestamp: number;
  typesKey: string;  // sorted, comma-joined type names
  previews: string;  // joined preview blocks, ready to append
}
const posPreviewCache = new Map<string, PosPreviewEntry>();
const POS_PREVIEW_TTL = 30_000;
const POS_PREVIEW_MAX = 100;

function posPreviewGet(posKey: string, typesKey: string): string | undefined {
  const e = posPreviewCache.get(posKey);
  if (!e) { return undefined; }
  if (Date.now() - e.timestamp > POS_PREVIEW_TTL) { posPreviewCache.delete(posKey); return undefined; }
  if (e.typesKey !== typesKey) { return undefined; }
  return e.previews;
}
function posPreviewSet(posKey: string, typesKey: string, previews: string) {
  if (posPreviewCache.size >= POS_PREVIEW_MAX) {
    const k = posPreviewCache.keys().next().value;
    if (k !== undefined) { posPreviewCache.delete(k); }
  }
  posPreviewCache.set(posKey, { timestamp: Date.now(), typesKey, previews });
}

// ── (E) In-flight hover preview dedup (per-position) ──
// When VS Code calls $provideHover for multiple handles at the same position,
// the first handle computes and later handles await the same promise.
const inflightHoverPreviews = new Map<string, Promise<{ typesKey: string; previews: string } | null>>();

// ── (B) Document-open prefetch infrastructure ──
const prefetchedDocs = new Set<string>();  // uri.fsPath → already scheduled
const prefetchQueue: Array<() => Promise<void>> = [];
let prefetchWorkers = 0;
// Single worker. Prefetch is sidecar-only (µs per lookup), so serial issue is
// not a throughput concern, and this eliminates the concurrent timer pile-up
// we saw when 3 workers each stalled on LSP backpressure.
const PREFETCH_MAX_WORKERS = 1;
const PREFETCH_WORKER_DELAY_MS = 100;
const PREFETCH_MAX_TOKENS = 30;
const PREFETCH_MAX_DOC_BYTES = 1_000_000;  // 1 MB
const PREFETCH_MAX_DOC_LINES = 5_000;
const PREFETCH_DEBOUNCE_MS = 500;
let prefetchDebounce: ReturnType<typeof setTimeout> | undefined;

function enqueuePrefetch(task: () => Promise<void>) {
  prefetchQueue.push(task);
  while (prefetchWorkers < PREFETCH_MAX_WORKERS && prefetchQueue.length > 0) {
    prefetchWorkers++;
    (async () => {
      while (prefetchQueue.length > 0) {
        const t = prefetchQueue.shift();
        if (!t) { break; }
        try { await t(); } catch { /* swallow */ }
        await new Promise(r => setTimeout(r, PREFETCH_WORKER_DELAY_MS));
      }
      prefetchWorkers--;
    })();
  }
}

// Extract PascalCase tokens (>= 3 chars) ranked by frequency, return top N with their first position.
function extractPrefetchTokens(doc: vscode.TextDocument): Array<{ name: string; pos: vscode.Position }> {
  const text = doc.getText();
  const re = /\b[A-Z][A-Za-z0-9_]{2,}\b/g;
  const seen = new Map<string, { pos: vscode.Position; count: number }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[0];
    if (SKIP_WORDS.has(name)) { continue; }
    const prev = seen.get(name);
    if (prev) { prev.count++; } else { seen.set(name, { pos: doc.positionAt(m.index), count: 1 }); }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, PREFETCH_MAX_TOKENS)
    .map(([name, v]) => ({ name, pos: v.pos }));
}

interface HoverWordCandidate {
  name: string;
  anchor: vscode.Position;
  range: vscode.Range;
}

function isCallableHoverContext(doc: vscode.TextDocument, range: vscode.Range): boolean {
  const line = doc.lineAt(range.start.line).text;
  const before = line.slice(Math.max(0, range.start.character - 48), range.start.character);
  const after = line.slice(range.end.character, Math.min(line.length, range.end.character + 32));
  if (/(?:^|\s)(?:async\s+)?def\s+$/.test(before)) { return true; }
  if (/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+$/.test(before)) { return true; }
  if (/^\s*\(/.test(after)) { return true; }
  return false;
}

function hoverWordCandidateAt(
  doc: vscode.TextDocument | undefined,
  position: vscode.Position,
): HoverWordCandidate | null {
  if (!doc) { return null; }
  const range = doc.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
  if (!range) { return null; }
  const name = doc.getText(range);
  if (!name || name.length <= 2 || SKIP_WORDS.has(name)) { return null; }
  if (TYPE_SHAPED_NAME.test(name) || CONSTANT_SHAPED_NAME.test(name)) {
    return { name, anchor: range.start, range };
  }
  if (/^[a-z_$][\w$]*$/.test(name) && (name.includes('_') || isCallableHoverContext(doc, range))) {
    return { name, anchor: range.start, range };
  }
  return null;
}

function fullWordRangeAt(
  doc: vscode.TextDocument | undefined,
  position: vscode.Position,
): vscode.Range | undefined {
  if (!doc) { return undefined; }
  return doc.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/) ?? undefined;
}

function internalRangeFromVsCode(range: vscode.Range | undefined): any | undefined {
  if (!range) { return undefined; }
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function internalFullWordRangeAt(
  doc: vscode.TextDocument | undefined,
  position: vscode.Position,
): any | undefined {
  return internalRangeFromVsCode(fullWordRangeAt(doc, position));
}

function declarationLineContainsIdentifier(doc: vscode.TextDocument, line: number, identifier: string): boolean {
  if (line < 0 || line >= doc.lineCount) { return false; }
  return declarationIdentifiersInLine(doc.lineAt(line).text).some(decl => decl.id === identifier);
}

function shouldDirectHoverCandidate(name: string): boolean {
  return CONSTANT_SHAPED_NAME.test(name) || !TYPE_SHAPED_NAME.test(name);
}

function markdownStringForDirectHover(preview: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`${IR_DIRECT_HOVER_MARKER}\n${preview}`, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  return md;
}

async function provideBroadSymbolHover(
  doc: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
): Promise<vscode.Hover | null> {
  if (internalHoverProviderRequestDepth > 0) { return null; }
  if (!isCodeDoc(doc)) { return null; }
  const candidate = hoverWordCandidateAt(doc, position);
  if (!candidate || !shouldDirectHoverCandidate(candidate.name)) { return null; }

  const cacheKey = defCacheKey(doc.uri, candidate.anchor, candidate.name);
  let result: DefCacheEntry['result'] | null = null;

  if (declarationLineContainsIdentifier(doc, candidate.anchor.line, candidate.name)) {
    result = buildDefinitionPreviewResult(candidate.name, doc.uri, doc, candidate.anchor.line);
    defCacheSet(cacheKey, result);
    cappedPreviewLocationSet(lastPreviewLocations, candidate.name, result.location);
  } else {
    const cached = defCacheGet(cacheKey);
    if (cached) {
      result = cached.result;
    } else {
      result = await resolveInBackground(candidate.name, doc.uri, candidate.anchor, cacheKey, 'hover');
    }
  }

  if (token.isCancellationRequested || !result?.preview) { return null; }
  log.info(`[directHover] "${candidate.name}" → md=${result.preview.length}`);
  return new vscode.Hover(
    markdownStringForDirectHover(result.preview),
    candidate.range,
  );
}

function schedulePrefetch(doc: vscode.TextDocument | undefined) {
  if (!doc) { return; }
  if (!isCodeDoc(doc)) { return; }
  if (prefetchedDocs.has(doc.uri.fsPath)) { return; }
  // Cheap size check without copying full text (approx): lineCount * avg chars.
  // If actual getText() is too big we still bail inside the debounced task.

  if (prefetchDebounce) { clearTimeout(prefetchDebounce); }
  prefetchDebounce = setTimeout(() => {
    try {
      if (prefetchedDocs.has(doc.uri.fsPath)) { return; }
      if (!vscode.window.visibleTextEditors.some(e => e.document === doc)) { return; }
      if (doc.lineCount > PREFETCH_MAX_DOC_LINES) {
        log.info(`[prefetch] skip ${vscode.workspace.asRelativePath(doc.uri)} — too many lines (${doc.lineCount})`);
        prefetchedDocs.add(doc.uri.fsPath);
        return;
      }
      const textLen = doc.getText().length;
      if (textLen > PREFETCH_MAX_DOC_BYTES) {
        log.info(`[prefetch] skip ${vscode.workspace.asRelativePath(doc.uri)} — too large (${textLen}B)`);
        prefetchedDocs.add(doc.uri.fsPath);
        return;
      }
      prefetchedDocs.add(doc.uri.fsPath);
      const tokens = extractPrefetchTokens(doc);
      let queued = 0;
      for (const t of tokens) {
        const key = defCacheKey(doc.uri, t.pos, t.name);
        if (defCacheGet(key)) { continue; }
        enqueuePrefetch(async () => {
          await resolveInBackground(t.name, doc.uri, t.pos, key, 'prefetch');
        });
        queued++;
      }
      log.info(`[prefetch] ${vscode.workspace.asRelativePath(doc.uri)}: queued ${queued}/${tokens.length} tokens`);
    } catch (err) {
      log.warn(`[prefetch] scheduling error: ${err}`);
    }
  }, PREFETCH_DEBOUNCE_MS);
}

/**
 * Drop every in-memory hover-side cache. Called by the hard-rebuild path so a
 * user reaching for "Rebuild (Clear Cache)" actually gets a clean slate —
 * stale defCache / posPreviewCache entries can otherwise mask a freshly
 * rebuilt index.
 */
function clearAllExtensionCaches() {
  defCache.clear();
  posPreviewCache.clear();
  rawDefFileCache.clear();
  clickNegCache.clear();
  prefetchedDocs.clear();
  lastPreviewLocations.clear();
  lastPreviewDeclarationLocations.clear();
}

/**
 * Run a rebuild with a progress notification. Soft rebuild keeps the existing
 * index file (atomic swap on success); hard rebuild deletes it first and
 * also wipes every per-file cache the extension owns.
 */
async function runRebuild(opts: { hard: boolean }) {
  if (!indexManager) {
    vscode.window.showWarningMessage('IR: sidecar not available');
    return;
  }
  const title = opts.hard
    ? 'IR: rebuilding symbol index (clearing cache)…'
    : 'IR: rebuilding symbol index…';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => {
      if (opts.hard) { clearAllExtensionCaches(); }
      try {
        await indexManager!.rebuildNow({ hard: opts.hard });
      } catch (err) {
        vscode.window.showErrorMessage(`IR: rebuild failed — ${err}`);
        return;
      }
      const s = indexManager!.currentStatus();
      if (s.kind === 'ready') {
        vscode.window.setStatusBarMessage(
          `IR: rebuilt (${s.symbols.toLocaleString()} symbols)`,
          4_000,
        );
      } else if (s.kind === 'failed') {
        vscode.window.showWarningMessage(`IR: rebuild ended in failed state — ${s.reason}`);
      }
    },
  );
}

async function collectDefinitionFallbackDocs(originDoc: vscode.TextDocument): Promise<vscode.TextDocument[]> {
  const seen = new Set<string>();
  const docs: vscode.TextDocument[] = [];
  const inWorkspace = (uri: vscode.Uri): boolean => {
    if (uri.scheme !== 'file') { return false; }
    return !!vscode.workspace.workspaceFolders?.some(folder => {
      const root = folder.uri.fsPath;
      return uri.fsPath === root || uri.fsPath.startsWith(root + path.sep);
    });
  };

  const addDoc = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    if (seen.has(key) || !isCodeDoc(doc)) { return; }
    if (key !== originDoc.uri.toString() && !inWorkspace(doc.uri)) { return; }
    seen.add(key);
    docs.push(doc);
  };

  addDoc(originDoc);
  for (const doc of vscode.workspace.textDocuments) { addDoc(doc); }

  if (originDoc.languageId === 'python' || originDoc.uri.fsPath.endsWith('.py')) {
    try {
      const files = await vscode.workspace.findFiles(
        '**/*.{py,pyi}',
        '**/{.venv,venv,env,node_modules,site-packages,__pycache__,.vscode-test,.git}/**',
        200,
      );
      for (const uri of files) {
        if (seen.has(uri.toString())) { continue; }
        try { addDoc(await vscode.workspace.openTextDocument(uri)); } catch {}
      }
    } catch (err) {
      log.warn(`[defFallback] workspace scan error: ${err}`);
    }
  }

  docs.sort((a, b) => {
    if (a.uri.toString() === originDoc.uri.toString()) { return -1; }
    if (b.uri.toString() === originDoc.uri.toString()) { return 1; }
    return vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri));
  });
  return docs;
}

async function providePythonDefinitionFallback(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Location[] | null> {
  if (!(doc.languageId === 'python' || doc.uri.fsPath.endsWith('.py') || doc.uri.fsPath.endsWith('.pyi'))) {
    return null;
  }
  const range = doc.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) { return null; }
  const identifier = doc.getText(range);
  if (identifier.length <= 2 || SKIP_WORDS.has(identifier)) { return null; }
  // Keep the fallback narrow: Python class/type names and snake_case methods.
  if (!/^[A-Z_]/.test(identifier) && !identifier.includes('_')) { return null; }

  const docs = await collectDefinitionFallbackDocs(doc);
  for (const candidate of docs) {
    const pos = findDefInText(candidate.getText(), identifier, candidate);
    if (!pos) { continue; }
    const sameSpot = candidate.uri.toString() === doc.uri.toString()
      && pos.line === position.line
      && Math.abs(pos.character - position.character) < identifier.length;
    if (sameSpot) { continue; }
    log.info(`[defFallback] "${identifier}" → ${vscode.workspace.asRelativePath(candidate.uri)}:${pos.line + 1}`);
    return [new vscode.Location(candidate.uri, new vscode.Range(pos, pos))];
  }
  return null;
}

/**
 * Status bar: reflects the index manager's lifecycle. Click invokes a soft
 * rebuild; the (Clear Cache) variant lives only in the Command Palette to
 * avoid foot-guns.
 */
function setupStatusBar(context: vscode.ExtensionContext, im: IndexManager) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'intellisenseRecursion.rebuildIndex';

  const render = (s: IndexStatus) => {
    switch (s.kind) {
      case 'idle':
        item.text = '$(database) IR: idle';
        item.tooltip = 'IntelliSense Recursion — idle. Click to rebuild.';
        break;
      case 'building':
        item.text = '$(sync~spin) IR: building';
        item.tooltip = 'IntelliSense Recursion — building symbol index…';
        break;
      case 'ready': {
        const rootSummary = s.roots.map((r) => r.tag).join(', ') || 'project';
        item.text = `$(database) IR: ${s.symbols.toLocaleString()}`;
        item.tooltip = `IntelliSense Recursion — ${s.files.toLocaleString()} files, ${s.symbols.toLocaleString()} symbols (${rootSummary}). Click to rebuild.`;
        break;
      }
      case 'failed':
        item.text = '$(warning) IR: failed';
        item.tooltip = `IntelliSense Recursion — ${s.reason}. Click to rebuild.`;
        break;
    }
  };

  render(im.currentStatus());
  item.show();
  context.subscriptions.push(item, im.onStatusChange(render));
}

const BROAD_SYMBOL_HOVER_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'python' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'java' },
  { scheme: 'file', language: 'c' },
  { scheme: 'file', language: 'cpp' },
  { scheme: 'file', language: 'csharp' },
  { scheme: 'file', language: 'go' },
  { scheme: 'file', language: 'rust' },
  { scheme: 'file', language: 'ruby' },
  { scheme: 'file', language: 'php' },
  { scheme: 'file', language: 'swift' },
  { scheme: 'file', language: 'kotlin' },
  { scheme: 'file', language: 'dart' },
];

export async function activate(context: vscode.ExtensionContext) {
  extensionDeactivated = false;
  const version = (context.extension?.packageJSON?.version as string | undefined) ?? 'unknown';
  log.info(`IntelliSense Recursion v${version} activating...`);

  // Rust sidecar: non-blocking; if it fails we continue with LSP-only path.
  indexManager = new IndexManager(context.extensionPath, context.globalStorageUri.fsPath, {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
  });
  if (indexManager.isAvailable()) {
    indexManager.registerWatchers(context);
    setupStatusBar(context, indexManager);
    indexManager.start().catch((err) => log.warn(`[ir] start error: ${err}`));
  } else {
    log.info('[ir] sidecar unavailable; running in LSP-only mode');
  }
  context.subscriptions.push({ dispose: () => indexManager?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('intellisenseRecursion.goToType', goToTypeHandler),
    vscode.commands.registerCommand('intellisenseRecursion.previewBack', previewBackHandler),
    vscode.commands.registerCommand('intellisenseRecursion.getPatchStatus', () => ({
      hoverPatchActive,
      hoverRecursionDepth,
      currentPreviewIdentifier: currentPreviewState?.identifier ?? null,
      currentPreviewMarkdown: currentPreviewState?.markdown ?? '',
      pendingPreviewIdentifier: pendingPreviewHover?.identifier ?? null,
      previewHistoryLength: previewHistory.length,
      previewHistoryIdentifiers: previewHistory.map(state => state.identifier),
      lastHoverFetchPosition: lastHoverFetchPosition
        ? {
            uri: lastHoverFetchPosition.uri.toString(),
            line: lastHoverFetchPosition.line,
            character: lastHoverFetchPosition.character,
          }
        : null,
    })),
    vscode.languages.registerDefinitionProvider(
      [{ language: 'python', scheme: 'file' }, { language: 'python', scheme: 'untitled' }],
      { provideDefinition: providePythonDefinitionFallback },
    ),
    vscode.languages.registerHoverProvider(
      BROAD_SYMBOL_HOVER_SELECTOR,
      { provideHover: provideBroadSymbolHover },
    ),
    vscode.commands.registerCommand('intellisenseRecursion.rebuildIndex', () =>
      runRebuild({ hard: true }),
    ),
    // Invalidate caches when documents are saved (content may have changed)
    vscode.workspace.onDidSaveTextDocument(savedDoc => {
      const prefix = savedDoc.uri.fsPath + ':';
      for (const key of defCache.keys()) {
        if (key.startsWith(prefix)) { defCache.delete(key); }
      }
      for (const key of posPreviewCache.keys()) {
        if (key.startsWith(prefix)) { posPreviewCache.delete(key); }
      }
      rawDefFileCache.delete(savedDoc.uri.fsPath);
      // Any new save may have added a definition the prior scan missed.
      clickNegCache.clear();
      // Allow prefetch to run again on next activation of this doc
      prefetchedDocs.delete(savedDoc.uri.fsPath);
    }),
    // (B) Prefetch on active editor change — warms def cache for visible docs
    vscode.window.onDidChangeActiveTextEditor(editor => {
      schedulePrefetch(editor?.document);
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverRendererHarnessForTests',
        runHoverRendererHarnessForTests,
      ),
    );
  }

  // Prefetch current active editor on startup
  schedulePrefetch(vscode.window.activeTextEditor?.document);

  // Patch $provideHover on shared ExtHostLanguageFeatures
  const sharedService = findSharedHoverService();
  if (sharedService) {
    patchSharedService(sharedService);
  } else {
    log.warn('Could not find shared ExtHostLanguageFeatures');
  }

  // Inject renderer script and keep a low-frequency safety pass for new windows.
  // E2E tests exercise extension-host behavior through executeHoverProvider;
  // renderer CDP injection would target the user's live VS Code windows when
  // multiple Electron instances are open, so tests opt out explicitly.
  if (process.env.IR_SKIP_RENDERER_INJECTION === '1') {
    log.info('[inject] Renderer injection disabled by IR_SKIP_RENDERER_INJECTION');
  } else {
    await runRendererInjection(injectRenderer);
    reinjectTimer = setInterval(() => {
      runRendererInjection(reinjectRenderer).catch(() => {});
    }, 60000);
  }

  // Do not arm renderer prototype capture on activation. Capture is useful
  // only for hover drill-down rendering, and even brief global prototype
  // hooks can be felt as VS Code UI lag if they run during normal editing.

  log.info(`IntelliSense Recursion v${version} activated`);
}

// ── V8 Inspector: extract shared ExtHostLanguageFeatures ──

function findSharedHoverService(): any | null {
  try {
    const session = new inspector.Session();
    session.connect();
    (globalThis as any).__irFn = vscode.languages.registerHoverProvider;

    session.post('Runtime.evaluate', { expression: '__irFn', returnByValue: false }, (err, evalResult: any) => {
      if (err || !evalResult?.result?.objectId) { return; }
      session.post('Runtime.getProperties', { objectId: evalResult.result.objectId, ownProperties: false, accessorPropertiesOnly: false }, (err2, propsResult: any) => {
        if (err2) { return; }
        const scopesProp = propsResult?.internalProperties?.find((p: any) => p.name === '[[Scopes]]');
        if (!scopesProp?.value?.objectId) { return; }
        session.post('Runtime.getProperties', { objectId: scopesProp.value.objectId }, (err3, scopesResult: any) => {
          if (err3) { return; }
          for (const entry of (scopesResult?.result || [])) {
            if (!entry.value?.objectId) { continue; }
            session.post('Runtime.getProperties', { objectId: entry.value.objectId }, (err4, varsResult: any) => {
              if (err4) { return; }
              for (const v of (varsResult?.result || [])) {
                if (v.value?.objectId) {
                  session.post('Runtime.callFunctionOn', {
                    objectId: v.value.objectId,
                    functionDeclaration: 'function() { if (typeof this.$provideHover === "function") { globalThis.__irEt = this; } }',
                  }, () => {});
                }
              }
            });
          }
        });
      });
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { session.post('Runtime.evaluate', { expression: '1' }, () => {}); } catch {}
      if ((globalThis as any).__irEt) { break; }
    }

    session.disconnect();
    delete (globalThis as any).__irFn;

    const et = (globalThis as any).__irEt;
    if (et && '$provideHover' in et) {
      log.info('Found shared ExtHostLanguageFeatures');
      return et;
    }
  } catch (err) {
    log.error(`V8 Inspector error: ${err}`);
  }
  return null;
}

// ── Patch $provideHover ──

function patchSharedService(service: any) {
  const original = service.$provideHover;

  // Helper: attach previews string to the first stringy content block.
  function attachPreviews(res: any, previews: string, position: any, hoverRange?: any): any {
    const ln = position?.lineNumber !== undefined ? position.lineNumber : (position?.line !== undefined ? position.line + 1 : 1);
    const col = position?.column !== undefined ? position.column : (position?.character !== undefined ? position.character + 1 : 1);
    const range = hoverRange ?? { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col };
    if (!res?.contents?.length) {
      return {
        contents: [{ value: previews, isTrusted: true, supportThemeIcons: true }],
        range,
      };
    }
    const newContents = [...res.contents];
    let attached = false;
    for (let ci = 0; ci < newContents.length; ci++) {
      if (newContents[ci]?.value && typeof newContents[ci].value === 'string') {
        newContents[ci] = { ...newContents[ci], value: newContents[ci].value + '\n\n---\n' + previews };
        attached = true;
        break;
      }
    }
    if (!attached) {
      newContents.push({ value: previews, isTrusted: true, supportThemeIcons: true });
    }
    return { ...res, contents: newContents, range: hoverRange ?? res.range };
  }

  function hoverResultText(res: any): string {
    const parts: string[] = [];
    for (const content of (res?.contents || [])) {
      if (typeof content === 'string') { parts.push(content); }
      else if (content?.value && typeof content.value === 'string') { parts.push(content.value); }
    }
    return parts.join('\n');
  }

  function nativeHoverHasClassLikeSource(res: any, typeName: string): boolean {
    if (!TYPE_SHAPED_NAME.test(typeName)) { return false; }
    const text = hoverResultText(res);
    return new RegExp(`\\b(?:class|interface|enum|struct|type)\\s+${esc(typeName)}\\b`).test(text);
  }

  service.$provideHover = async function (handle: number, uri: any, position: any, context: any, token: any) {
    const hoverT0 = Date.now();
    const fileName = (uri?.path || '').split('/').pop() || '?';
    // Internal position format: {lineNumber, column} (1-based) vs VS Code API {line, character} (0-based)
    const posLine = position?.lineNumber ?? position?.line;
    const posChar = position?.column ?? position?.character;

    // Track last hover fetch position so previewTypeHandler can move
    // the text cursor here before triggering editor.action.showHover.
    try {
      const apiL = position?.lineNumber !== undefined ? position.lineNumber - 1 : (position?.line ?? 0);
      const apiC = position?.column !== undefined ? position.column - 1 : (position?.character ?? 0);
      const docUriStr2 = uri?.scheme ? `${uri.scheme}://${uri.authority || ''}${uri.path}` : String(uri);
      lastHoverFetchPosition = { uri: vscode.Uri.parse(docUriStr2), line: apiL, character: apiC };
    } catch {}

    // Page transition: if a drill-down click is pending, redirect this
    // hover request to return the clicked symbol's content. VS Code
    // renders via its native MarkdownRenderer (theme + TextMate tokens
    // for free) — no DOM manipulation on the renderer side.
    if (pendingPreviewHover && Date.now() < pendingPreviewHover.expiresAt) {
      const preview = pendingPreviewHover;
      // Consume on first hit: clear pendingPreviewHover and open a short
      // suppression window. The other handles in this showHover fanout
      // (typically a few ms apart) hit the suppression branch below and
      // return empty contents, so the hover aggregator shows the panel
      // exactly once.
      pendingPreviewHover = null;
      previewHoverSuppressUntil = Date.now() + 500;
      log.info(`[hover] page-transition handle=${handle} → "${preview.identifier}"`);
      const ln = position?.lineNumber !== undefined ? position.lineNumber : (position?.line !== undefined ? position.line + 1 : 1);
      const col = position?.column !== undefined ? position.column : (position?.character !== undefined ? position.character + 1 : 1);
      const pointRange = { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col };
      return {
        contents: preview.contents,
        range: preview.range ?? pointRange,
      };
    }
    // Suppression branch: parallel handles in the same showHover fanout
    // return empty so the override isn't duplicated across providers.
    if (Date.now() < previewHoverSuppressUntil) {
      log.info(`[hover] page-transition handle=${handle} suppressed (in window)`);
      return { contents: [] };
    }

    // Drill-down history reset: reaching this point means we've passed
    // both the pending-preview consume and the post-consume suppression
    // window, so this is a genuine LSP hover (a new hover session). Any
    // prior drill-down chain should not carry across into the next click.
    if (currentPreviewState) {
      log.info(`[hover] drill-down history reset on fresh LSP hover (was at "${currentPreviewState.identifier}", stack=${previewHistory.length})`);
      previewHistory.length = 0;
      currentPreviewState = null;
    }

    // Canonical position key (0-based, stable across internal vs API shapes)
    const apiLine = position?.lineNumber !== undefined ? position.lineNumber - 1 : (position?.line ?? 0);
    const apiChar = position?.column !== undefined ? position.column - 1 : (position?.character ?? 0);
    const posKey = `${uri?.path || uri}:${apiLine}:${apiChar}`;
    const docUriStr = uri?.scheme ? `${uri.scheme}://${uri.authority || ''}${uri.path}` : String(uri);
    const docUri = vscode.Uri.parse(docUriStr);
    const hoverApiPos = new vscode.Position(apiLine, apiChar);
    const hoverDocForCandidate = findOpenDoc(docUri);
    const hoveredCandidate = hoverWordCandidateAt(hoverDocForCandidate, hoverApiPos);
    const hoveredInternalRange = hoveredCandidate
      ? internalRangeFromVsCode(hoveredCandidate.range)
      : internalFullWordRangeAt(hoverDocForCandidate, hoverApiPos);

    const result = await original.call(this, handle, uri, position, context, token);
    const postNativeT0 = Date.now();
    if (hoverResultText(result).includes(IR_DIRECT_HOVER_MARKER)) { return result; }
    if (!result?.contents?.length && !hoveredCandidate) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    // Prefer the exact word under the cursor, then supplement with type names
    // discovered in native hover code fences. This covers symbols where the
    // language server has definition data but no hover text.
    const skipDirectClassPreview = hoveredCandidate
      ? nativeHoverHasClassLikeSource(result, hoveredCandidate.name)
      : false;
    const directCandidateNeedsFallback = hoveredCandidate
      ? shouldDirectHoverCandidate(hoveredCandidate.name)
      : false;
    const types: string[] = [];
    if (hoveredCandidate && directCandidateNeedsFallback && !skipDirectClassPreview) {
      types.push(hoveredCandidate.name);
    }
    for (const content of (result?.contents || [])) {
      if (!content || typeof content.value !== 'string') { continue; }
      const fences = content.value.matchAll(/```\w*\n?([\s\S]*?)```/g);
      for (const fence of fences) {
        if (!fence[1]) { continue; }
        for (const name of findTypeNames(fence[1].trim())) {
          if (skipDirectClassPreview && hoveredCandidate?.name === name) { continue; }
          types.push(name);
        }
      }
    }
    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length === 0) {
      return hoveredInternalRange && result?.contents?.length
        ? { ...result, range: hoveredInternalRange }
        : result;
    }

    const hoverMs = () => `${Date.now() - hoverT0}ms`;
    const postNativeMs = () => `${Date.now() - postNativeT0}ms`;
    const typesKey = uniqueTypes.slice(0, 3).sort().join(',');
    const inflightKey = `${posKey}:${typesKey}`;

    // (A) Position-level preview cache — short-circuits everything below for
    // repeated hovers at the same point with the same extracted types.
    const cachedPreviews = posPreviewGet(posKey, typesKey);
    if (cachedPreviews) {
      log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} POS-CACHE hit (${hoverMs()})`);
      return attachPreviews(result, cachedPreviews, position, hoveredInternalRange);
    }

    // (E) In-flight preview dedup — share work with other handles called
    // for the same hover event at the same position with the same types.
    const existingInflight = inflightHoverPreviews.get(inflightKey);
    if (existingInflight) {
      const computed = await existingInflight.catch(err => {
        log.error(`[hover] inflight compute error: ${err} (${hoverMs()})`);
        return null;
      });
      if (computed) {
        log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} INFLIGHT attached (${hoverMs()}, post=${postNativeMs()})`);
        return attachPreviews(result, computed.previews, position, hoveredInternalRange);
      }
      log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} INFLIGHT empty (${hoverMs()}, post=${postNativeMs()})`);
      return result;
    }

    log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} types=[${uniqueTypes.join(',')}] (${hoverMs()})`);

    lastHoverDocUri = docUriStr;

    // Compute previews and cache. Install promise in inflightHoverPreviews
    // BEFORE awaiting so concurrent handles can share.
    const runCompute = async (): Promise<{ typesKey: string; previews: string } | null> => {
      const doc = findOpenDoc(docUri);
      if (!doc) {
        // Opening a document can touch disk and parse a large file; never do
        // that on the hover response path.
        void Promise.resolve(vscode.workspace.openTextDocument(docUri)).catch(() => {});
        log.info(`[hover] doc not open; scheduled background open only (${hoverMs()})`);
        return null;
      }
      const hoverDoc: vscode.TextDocument = doc;
      const allowDocScan = hoverDoc.lineCount <= HOVER_DOC_SCAN_MAX_LINES;

      // (C) Smart anchor — if the word under the cursor is itself a PascalCase
      // identifier, we can skip the full docText regex scan for it.
      let hoveredWord = '';
      let hoveredAnchor: vscode.Position | undefined;
      try {
        if (hoveredCandidate) {
          hoveredWord = hoveredCandidate.name;
          hoveredAnchor = hoveredCandidate.anchor;
        } else {
          const wr = hoverDoc.getWordRangeAtPosition(hoverApiPos);
          if (wr) {
            hoveredWord = hoverDoc.getText(wr);
            hoveredAnchor = wr.start;
          }
        }
      } catch { /* invalid position — fall back to scan */ }

      // Lazy-load docText only when we actually need to scan (i.e. no smart anchor)
      let docTextCache: string | undefined;
      const getDocText = () => (docTextCache ??= hoverDoc.getText());

      const previewsOut: string[] = [];
      const resolvedDefDocs: { uri: vscode.Uri; doc: vscode.TextDocument }[] = [];

      async function resolveType(typeName: string): Promise<string | null> {
        const typeT0 = Date.now();
        let pos: vscode.Position | undefined;
        let matchUri = docUri;

        // (C) Smart anchor shortcut
        if (typeName === hoveredWord && hoveredAnchor) {
          pos = hoveredAnchor;
        } else {
          if (!allowDocScan) {
            // For very large files, do not copy/regex-scan the whole document
            // on hover. Sidecar-only background warmup may still populate the
            // cache, but the current hover returns native content immediately.
            const fallbackPos = hoveredAnchor ?? hoverApiPos;
            const largeCacheKey = defCacheKey(docUri, fallbackPos, typeName);
            const cached = defCacheGet(largeCacheKey);
            if (cached?.result) {
              cappedPreviewLocationSet(lastPreviewLocations, typeName, cached.result.location);
              if (cached.result.defDoc) {
                resolvedDefDocs.push({ uri: cached.result.defUri, doc: cached.result.defDoc });
              }
              log.info(`[hover]   "${typeName}" → large-doc cached def lines=${cached.result.previewLineCount ?? '?'} md=${cached.result.preview.length} (${Date.now() - typeT0}ms)`);
              return cached.result.preview;
            }
            if (!cached) {
              const resolved = await resolveInBackground(typeName, docUri, fallbackPos, largeCacheKey, 'hover');
              if (resolved) {
                if (resolved.defDoc) {
                  resolvedDefDocs.push({ uri: resolved.defUri, doc: resolved.defDoc });
                }
                log.info(`[hover]   "${typeName}" → large-doc resolved for first hover lines=${resolved.previewLineCount ?? '?'} md=${resolved.preview.length} (${Date.now() - typeT0}ms)`);
                return resolved.preview;
              }
            }
            log.info(`[hover]   "${typeName}" → large-doc unresolved (${Date.now() - typeT0}ms)`);
            return null;
          }
          // (D) Cached compiled regex, scan hovered doc first
          const regex = typeRegex(typeName);
          regex.lastIndex = 0;
          let match = regex.exec(getDocText());
          let matchDoc: vscode.TextDocument = hoverDoc;
          if (!match) {
            for (const rd of resolvedDefDocs) {
              regex.lastIndex = 0;
              match = regex.exec(rd.doc.getText());
              if (match) { matchUri = rd.uri; matchDoc = rd.doc; break; }
            }
            if (!match) {
              log.info(`[hover]   "${typeName}" not found in docs (${hoverMs()})`);
              return null;
            }
          }
          pos = matchDoc.positionAt(match.index);
        }

        const cacheKey = defCacheKey(matchUri, pos, typeName);

        if (matchUri.toString() === hoverDoc.uri.toString()
          && declarationLineContainsIdentifier(hoverDoc, pos.line, typeName)) {
          const direct = buildDefinitionPreviewResult(typeName, hoverDoc.uri, hoverDoc, pos.line);
          defCacheSet(cacheKey, direct);
          cappedPreviewLocationSet(lastPreviewLocations, typeName, direct.location);
          if (direct.defDoc) {
            resolvedDefDocs.push({ uri: direct.defUri, doc: direct.defDoc });
          }
          log.info(`[hover]   "${typeName}" → direct source declaration lines=${direct.previewLineCount ?? '?'} md=${direct.preview.length} (${Date.now() - typeT0}ms)`);
          return direct.preview;
        }

        const cached = defCacheGet(cacheKey);
        if (cached) {
          if (cached.result) {
            log.info(`[hover]   "${typeName}" → cached def lines=${cached.result.previewLineCount ?? '?'} md=${cached.result.preview.length} (${Date.now() - typeT0}ms)`);
            cappedPreviewLocationSet(lastPreviewLocations, typeName, cached.result.location);
            if (cached.result.defDoc) {
              resolvedDefDocs.push({ uri: cached.result.defUri, doc: cached.result.defDoc });
            }
            return cached.result.preview;
          }
          log.info(`[hover]   "${typeName}" → cached negative (${Date.now() - typeT0}ms)`);
          return null;
        }

        const raced = await resolveInBackground(typeName, matchUri, pos, cacheKey, 'hover');
        if (raced) {
          if (raced.defDoc) {
            resolvedDefDocs.push({ uri: raced.defUri, doc: raced.defDoc });
          }
          log.info(`[hover]   "${typeName}" → resolved for first hover (${Date.now() - typeT0}ms)`);
          return raced.preview;
        }
        return null;
      }

      if (token?.isCancellationRequested) {
        log.info(`[hover] cancelled before resolve (${hoverMs()})`);
        return null;
      }

      const typeResults = await Promise.all(uniqueTypes.slice(0, 3).map(resolveType));
      for (const r of typeResults) { if (r) { previewsOut.push(r); } }
      if (previewsOut.length === 0) { return null; }
      const previews = previewsOut.join('\n\n---\n');
      log.info(`[hover] previews built count=${previewsOut.length} md=${previews.length} (${hoverMs()})`);
      return { typesKey, previews };
    };

    const computePromise = runCompute();
    inflightHoverPreviews.set(inflightKey, computePromise);
    hoverRecursionDepth++;
    try {
      const computed = await computePromise;
      if (computed) {
        posPreviewSet(posKey, computed.typesKey, computed.previews);
        log.info(`[hover] done: first-hover preview attached md=${computed.previews.length} (${hoverMs()}, post=${postNativeMs()})`);
        return attachPreviews(result, computed.previews, position, hoveredInternalRange);
      }
    } catch (err) {
      log.error(`[hover] compute error: ${err} (${hoverMs()})`);
    } finally {
      hoverRecursionDepth--;
      inflightHoverPreviews.delete(inflightKey);
    }

    log.info(`[hover] done: no definition preview resolved; returning native hover (${hoverMs()}, post=${postNativeMs()})`);
    return result;
  };

  hoverPatchActive = true;
  log.info('$provideHover patched');
}

// ── Renderer injection via main process CDP ──

const RENDERER_PATCH_VERSION = 101;

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function listProcessRows(): ProcessRow[] {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
    return out.split(/\r?\n/)
      .map((line: string) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) { return null; }
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3],
        } satisfies ProcessRow;
      })
      .filter((row: ProcessRow | null): row is ProcessRow => !!row);
  } catch (err) {
    log.warn(`[inject] process scan failed: ${err}`);
    return [];
  }
}

function isVSCodeMainProcessCommand(command: string): boolean {
  // Match the Electron/Code executable itself, not Code Helper processes.
  return /\/Contents\/MacOS\/(?:Code|Code - Insiders|Code - OSS|Electron)(?:\s+--|$)/.test(command);
}

function findCurrentVSCodeMainPid(): number | null {
  const rows = listProcessRows();
  if (!rows.length) { return null; }
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) { byPid.set(row.pid, row); }

  const seen = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) { break; }
    if (isVSCodeMainProcessCommand(row.command)) { return row.pid; }
    pid = row.ppid;
  }

  const envPid = Number(process.env.VSCODE_PID || '');
  if (envPid && byPid.has(envPid) && isVSCodeMainProcessCommand(byPid.get(envPid)!.command)) {
    return envPid;
  }

  const mainRows = rows.filter(row => isVSCodeMainProcessCommand(row.command));
  if (mainRows.length === 1) { return mainRows[0].pid; }
  if (mainRows.length > 1) {
    log.warn(`[inject] multiple VS Code main processes found; skipping ambiguous renderer injection (${mainRows.map(row => row.pid).join(',')})`);
  }
  return null;
}

function makeRendererEvalExpression(script: string): string {
  const patchB64 = Buffer.from(script, 'utf8').toString('base64');
  return `(function(){var bin=atob(${JSON.stringify(patchB64)});var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){bytes[i]=bin.charCodeAt(i);}return eval(new TextDecoder('utf-8').decode(bytes));})()`;
}

async function injectRenderer() {
  try {
    if (extensionDeactivated) { return; }
    log.info('[inject] Starting renderer injection...');
    const mainPid = findCurrentVSCodeMainPid();
    if (!mainPid) {
      log.warn('[inject] Could not identify current VS Code main process');
      return;
    }
    log.info(`[inject] Main process PID: ${mainPid}`);

    process.kill(mainPid, 'SIGUSR1');
    log.info('[inject] SIGUSR1 sent, waiting for inspector...');
    await new Promise(r => setTimeout(r, 500));

    const targetsJson = await httpGet('http://127.0.0.1:9229/json/list');
    const targets = JSON.parse(targetsJson);
    log.info(`[inject] CDP targets: ${targets.length}`);
    if (!targets.length || !targets[0].webSocketDebuggerUrl) {
      log.warn('[inject] No CDP WebSocket URL found');
      return;
    }
    log.info(`[inject] Connecting WebSocket...`);
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);

    await new Promise<void>((resolve) => {
      let msgId = 1;
      let evalMsgId = -1;
      let done = false;
      const finish = (keepOpen: boolean) => {
        if (done) { return; }
        done = true;
        clearTimeout(timeout);
        if (!keepOpen) {
          try { ws.close(); } catch {}
        }
        resolve();
      };
      const timeout = setTimeout(() => {
        log.warn('[inject] timed out waiting for renderer injection result');
        finish(false);
      }, 10000);
      ws.on('open', () => {
        // Enable Runtime events & add main-process binding for instant click notification
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.addBinding', params: { name: 'irClickNotify' } }));

        const evalExpr = makeRendererEvalExpression(getHoverPatchScript());

        const injectScript = `
          (async function() {
            if (process.pid !== ${mainPid}) {
              return 'wrong-main-pid:' + process.pid + ' expected:${mainPid}';
            }
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var results = [];
            function evalSummary(id, r) {
              if (!r) { return 'skip:' + id + '(no response)'; }
              if (r.exceptionDetails) {
                var ex = r.exceptionDetails.exception;
                var desc = ex && (ex.description || ex.value) || '';
                return 'eval-exc:' + id + ':' + (r.exceptionDetails.text || '') + ':' + desc;
              }
              var rr = r.result || {};
              return 'skip:' + id + '(value=' + String(rr.value) + ',type=' + String(rr.type) + ',desc=' + String(rr.description || '') + ')';
            }
            async function installedVersion(w) {
              try {
                var chk = await w.webContents.debugger.sendCommand('Runtime.evaluate', {
                  expression: 'Number(window.__irPatchVersion)||0',
                  returnByValue: true
                });
                return Number(chk && chk.result && chk.result.value) || 0;
              } catch(eChk) { return 0; }
            }
            async function ensureBinding(w) {
              try {
                try { await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: 'irGoToType' }); }
                catch(eAdd) {
                  if (!/already|exists|duplicate/i.test(String(eAdd && eAdd.message || eAdd))) { throw eAdd; }
                }
                if (!global.__irGoToTypeBridgeListeners) { global.__irGoToTypeBridgeListeners = new Map(); }
                var prev = global.__irGoToTypeBridgeListeners.get(w.id);
                if (prev) {
                  try { w.webContents.debugger.removeListener('message', prev); } catch(eRm) {}
                }
                var bridge = function(event, method, params) {
                  if (method === 'Runtime.bindingCalled' && params.name === 'irGoToType') {
                    if(typeof global.irClickNotify==='function'){global.irClickNotify(params.payload)}
                  }
                };
                w.webContents.debugger.on('message', bridge);
                global.__irGoToTypeBridgeListeners.set(w.id, bridge);
                return 'binding:' + w.id + ':ok';
              } catch(eb) {
                return 'binding:' + w.id + ':' + ((eb && eb.message) || eb);
              }
            }
            for (var i = 0; i < wins.length; i++) {
              var w = wins[i];
              try {
                var alreadyAttached = false;
                try { alreadyAttached = w.webContents.debugger.isAttached(); } catch(eIs) {}
                if (!alreadyAttached) {
                  try { w.webContents.debugger.attach('1.3'); }
                  catch(eAttach) { results.push('attach-fail:' + w.id + ':' + eAttach.message); continue; }
                }
                await w.webContents.debugger.sendCommand('Runtime.enable');
                var bindingResult = await ensureBinding(w);
                var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)}, includeCommandLineAPI: true, returnByValue: true });
                var value = r && r.result && r.result.value;
                var ok = value === 'hover patch installed' || value === 'already patched';
                if (!ok) {
                  var version = await installedVersion(w);
                  if (version >= ${RENDERER_PATCH_VERSION}) {
                    ok = true;
                    value = 'postcheck:' + version;
                  }
                }
                if (ok) {
                  results.push('injected:' + w.id + '(' + value + ')');
                  results.push(bindingResult);
                } else {
                  results.push(evalSummary(w.id, r));
                  results.push(bindingResult);
                }
              } catch(e) { results.push('err:' + w.id + ':' + e.message); }
            }
            return results.join(' | ');
          })()
        `.trim();

        evalMsgId = msgId++;
        ws.send(JSON.stringify({ id: evalMsgId, method: 'Runtime.evaluate', params: { expression: injectScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }));
      });

      ws.on('message', (data: string) => {
        try {
          const resp = JSON.parse(data);
          if (resp.id === evalMsgId && !done) {
            const val = resp.result?.result?.value;
            if (val) { log.info(`Renderer injection: ${val}`); }
            if (extensionDeactivated) {
              finish(false);
              return;
            }
            startClickListener(ws);
            finish(true);
          }
        } catch {}
      });
      ws.on('error', () => { finish(false); });
      ws.on('close', () => { finish(false); });
    });
  } catch (err) {
    log.error(`Renderer injection error: ${err}`);
  }
}

async function reinjectRenderer() {
  try {
    if (extensionDeactivated) { return; }
    const mainPid = findCurrentVSCodeMainPid();
    if (!mainPid) { return; }
    const targetsJson = await httpGet('http://127.0.0.1:9229/json/list');
    const targets = JSON.parse(targetsJson);
    if (!targets.length || !targets[0].webSocketDebuggerUrl) { return; }

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) { return; }
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve();
      };
      const timeout = setTimeout(() => {
        log.warn('[inject] re-injection timed out');
        finish();
      }, 3000);
      ws.on('open', () => {
        const evalExpr = makeRendererEvalExpression(getHoverPatchScript());
        const injectScript = `
          (async function() {
            if (process.pid !== ${mainPid}) { return 0; }
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var n = 0;
            async function installedVersion(w) {
              try {
                var chk = await w.webContents.debugger.sendCommand('Runtime.evaluate', {
                  expression: 'Number(window.__irPatchVersion)||0',
                  returnByValue: true
                });
                return Number(chk && chk.result && chk.result.value) || 0;
              } catch(eChk) { return 0; }
            }
            async function ensureBinding(w) {
              try {
                try { await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: 'irGoToType' }); }
                catch(eAdd) {
                  if (!/already|exists|duplicate/i.test(String(eAdd && eAdd.message || eAdd))) { throw eAdd; }
                }
                if (!global.__irGoToTypeBridgeListeners) { global.__irGoToTypeBridgeListeners = new Map(); }
                var prev = global.__irGoToTypeBridgeListeners.get(w.id);
                if (prev) {
                  try { w.webContents.debugger.removeListener('message', prev); } catch(eRm) {}
                }
                var bridge = function(event, method, params) {
                  if (method === 'Runtime.bindingCalled' && params.name === 'irGoToType') {
                    if(typeof global.irClickNotify==='function'){global.irClickNotify(params.payload)}
                  }
                };
                w.webContents.debugger.on('message', bridge);
                global.__irGoToTypeBridgeListeners.set(w.id, bridge);
              } catch(eb) {}
            }
            for (var i = 0; i < wins.length; i++) {
              try {
                var w = wins[i];
                var attached = false;
                try { attached = w.webContents.debugger.isAttached(); } catch(eIs) {}
                if (!attached) {
                  try { w.webContents.debugger.attach('1.3'); } catch(eAttach) { continue; }
                }
                await w.webContents.debugger.sendCommand('Runtime.enable');
                await ensureBinding(w);
                var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)}, includeCommandLineAPI: true, returnByValue: true });
                var value = r && r.result && r.result.value;
                if (value === 'hover patch installed' || value === 'already patched') {
                  n++;
                } else if ((await installedVersion(w)) >= ${RENDERER_PATCH_VERSION}) {
                  n++;
                }
              } catch(e) {}
            }
            return n;
          })()
        `.trim();
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: injectScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }));
      });
      ws.on('message', (data: string) => {
        try {
          const resp = JSON.parse(data);
          if (resp.id === 1) {
            const n = resp.result?.result?.value;
            if (n && n > 0) { log.info(`Re-injected into ${n} window(s)`); }
            finish();
          }
        } catch {}
      });
      ws.on('error', () => { finish(); });
      ws.on('close', () => { finish(); });
    });
  } catch {}
}

function startClickListener(mainWs: any) {
  if (mainWsRef && mainWsRef !== mainWs) {
    closeMainWebSocket();
  }
  clearRendererReconnectTimer();
  mainWsRef = mainWs;
  if (mainWs.__irClickListenerStarted) { return; }
  mainWs.__irClickListenerStarted = true;
  log.info('[listen] Click event listener started (binding-driven)');

  mainWs.on('message', (data: string) => {
    try {
      const resp = JSON.parse(data);
      if (resp.method === 'Runtime.bindingCalled' && resp.params?.name === 'irClickNotify') {
        const val = String(resp.params.payload);
        if (val.startsWith('LOG:')) {
          log.info(`[renderer] ${val.substring(4)}`);
          return;
        }
        if (val.startsWith('SEND:')) {
          log.info(`[send] ${val.substring(5)}`);
          return;
        }

        // Debounce: ignore duplicate clicks for same identifier within 300ms
        const now = Date.now();
        if (val === lastClickId && now - lastClickTime < 300) { return; }
        lastClickId = val;
        lastClickTime = now;

        log.info(`Click: "${val}"`);
        const editor = vscode.window.activeTextEditor;
        const docUri = editor?.document.uri.toString() || '';

        if (val.startsWith('PREVIEW:')) {
          const typeName = val.substring('PREVIEW:'.length);
          previewTypeHandler(docUri, typeName).catch(err => log.warn(`preview: error: ${err}`));
        } else if (editor) {
          goToTypeHandler(editor.document.uri.toString(), val);
        }
      }
    } catch {}
  });

  mainWs.on('close', () => {
    log.warn('[listen] CDP WebSocket closed — click listener lost. Will attempt reconnect...');
    if (mainWsRef === mainWs) { mainWsRef = null; }
    scheduleRendererReconnect();
  });

  mainWs.on('error', (err: any) => {
    log.warn(`[listen] CDP WebSocket error: ${err}`);
  });
}

async function cleanupRendererInjection(reason: string): Promise<void> {
  const ws = mainWsRef;
  if (!ws || ws.readyState !== WebSocket.OPEN) { return; }

  await new Promise<void>((resolve) => {
    const requestId = Date.now() % 1_000_000_000;
    let done = false;
    const finish = () => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.off('message', onMessage); } catch {}
      resolve();
    };
    const timeout = setTimeout(finish, 1500);
    const rendererExpr = `try{if(window.__irCleanup){window.__irCleanup(${JSON.stringify(reason)});'ok'}else{'missing'}}catch(e){'err:'+((e&&e.message)||e)}`;
    const cleanupScript = `
      (async function() {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var n = 0;
        for (var i = 0; i < wins.length; i++) {
          try {
            var w = wins[i];
            var attached = false;
            try { attached = w.webContents.debugger.isAttached(); } catch(eIs) {}
            if (!attached) {
              try { w.webContents.debugger.attach('1.3'); } catch(eAttach) { continue; }
            }
            await w.webContents.debugger.sendCommand('Runtime.evaluate', {
              expression: ${JSON.stringify(rendererExpr)},
              returnByValue: true
            });
            n++;
          } catch(e) {}
        }
        return n;
      })()
    `.trim();
    const onMessage = (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id === requestId) {
          const n = resp.result?.result?.value;
          if (typeof n === 'number') { log.info(`[inject] renderer cleanup sent to ${n} window(s)`); }
          finish();
        }
      } catch {}
    };
    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: { expression: cleanupScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true },
      }));
    } catch {
      finish();
    }
  });
}

function evaluateInMainProcessForTests(expression: string, timeoutMs = 7000): Promise<any> {
  const ws = mainWsRef;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('renderer test CDP socket is not open'));
  }
  return new Promise((resolve, reject) => {
    const requestId = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000);
    let done = false;
    const finish = (err: Error | null, value?: any) => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.off('message', onMessage); } catch {}
      if (err) { reject(err); } else { resolve(value); }
    };
    const timeout = setTimeout(() => finish(new Error('renderer test eval timed out')), timeoutMs);
    const onMessage = (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id !== requestId) { return; }
        if (resp.error) {
          finish(new Error(resp.error.message || String(resp.error)));
          return;
        }
        const result = resp.result?.result;
        if (resp.result?.exceptionDetails) {
          finish(new Error(resp.result.exceptionDetails.text || 'renderer test eval exception'));
          return;
        }
        finish(null, result?.value);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: {
          expression,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function runHoverRendererHarnessForTests(): Promise<any[]> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    await runRendererInjection(injectRenderer);
  }
  const rendererExpr = `
    (async function() {
      var hooks = window.__irTestHooks;
      function rectObj(r) {
        return {
          left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          width: r.width, height: r.height
        };
      }
      function handleMetrics(root) {
        var handles = root.querySelectorAll('.scrollbar,.slider,.shadow,.sash,.monaco-sash');
        var visible = 0;
        var maxHeight = 0;
        var maxWidth = 0;
        for (var i = 0; i < handles.length; i++) {
          var h = handles[i];
          var cs = window.getComputedStyle(h);
          var r = h.getBoundingClientRect();
          maxHeight = Math.max(maxHeight, r.height || 0);
          maxWidth = Math.max(maxWidth, r.width || 0);
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0) {
            visible++;
          }
        }
        return { total: handles.length, visible: visible, maxHeight: maxHeight, maxWidth: maxWidth };
      }
      function snap(hoverEl) {
        var sc = hooks.primaryHoverScroller(hoverEl) || hoverEl;
        var rect = hoverEl.getBoundingClientRect();
        return {
          className: String(hoverEl.className || ''),
          textLength: (hoverEl.textContent || '').length,
          rect: rectObj(rect),
          sizeTier: hoverEl.classList.contains('ir-size-large') ? 'large'
            : hoverEl.classList.contains('ir-size-medium') ? 'medium'
            : hoverEl.classList.contains('ir-size-small') ? 'small'
            : null,
          isScrollable: hoverEl.classList.contains('ir-scrollable'),
          connected: document.body.contains(hoverEl),
          scroller: {
            scrollTop: sc.scrollTop || 0,
            scrollHeight: sc.scrollHeight || 0,
            clientHeight: sc.clientHeight || 0,
            maxTop: Math.max(0, (sc.scrollHeight || 0) - (sc.clientHeight || 0))
          },
          handles: handleMetrics(hoverEl)
        };
      }
      function makeHover(label, lineCount) {
        var hover = document.createElement('div');
        hover.className = 'monaco-hover ir-e2e-hover';
        hover.style.cssText = 'position:fixed;left:32px;top:32px;z-index:2147483647;background:Canvas;color:CanvasText;';
        var sc = document.createElement('div');
        sc.className = 'monaco-scrollable-element';
        var content = document.createElement('div');
        content.className = 'monaco-hover-content';
        var row = document.createElement('div');
        row.className = 'hover-row';
        var rowContents = document.createElement('div');
        rowContents.className = 'hover-row-contents';
        var md = document.createElement('div');
        md.className = 'rendered-markdown ir-applied';
        md.style.cssText = 'font-family:Menlo,Monaco,monospace;font-size:12px;line-height:18px;';
        for (var i = 0; i < lineCount; i++) {
          var line = document.createElement('div');
          var n = String(i + 1).padStart(3, '0');
          line.textContent = label + ' field_' + n + ': str';
          md.appendChild(line);
        }
        rowContents.appendChild(md);
        row.appendChild(rowContents);
        content.appendChild(row);
        sc.appendChild(content);
        var scrollbar = document.createElement('div');
        scrollbar.className = 'scrollbar vertical';
        scrollbar.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:680px;display:block;visibility:visible;';
        var slider = document.createElement('div');
        slider.className = 'slider';
        slider.style.cssText = 'width:12px;height:640px;display:block;visibility:visible;';
        scrollbar.appendChild(slider);
        var shadow = document.createElement('div');
        shadow.className = 'shadow';
        shadow.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:680px;display:block;visibility:visible;';
        var sash = document.createElement('div');
        sash.className = 'monaco-sash';
        sash.style.cssText = 'position:absolute;right:0;bottom:0;width:12px;height:680px;display:block;visibility:visible;';
        sc.appendChild(scrollbar);
        sc.appendChild(shadow);
        hover.appendChild(sash);
        hover.appendChild(sc);
        document.body.appendChild(hover);
        return hover;
      }
      if (!hooks || typeof hooks.makeHoverScrollable !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      Array.prototype.slice.call(document.querySelectorAll('.ir-e2e-hover')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });

      var large = makeHover('LargeHoverModel', 90);
      hooks.makeHoverScrollable(large, true, (large.textContent || '').length);
      var largeBefore = snap(large);
      var target = hooks.primaryHoverScroller(large) || large;
      try {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 360,
          deltaMode: 0
        }));
      } catch (_) {}
      await new Promise(function(resolve) {
        requestAnimationFrame(function() { requestAnimationFrame(resolve); });
      });
      var largeAfterWheel = snap(large);

      var small = makeHover('STATUS_ACTIVE = "active"', 1);
      hooks.makeHoverScrollable(small, true, (small.textContent || '').length);
      var largeConnectedAfterSmall = document.body.contains(large);
      var smallSnap = snap(small);

      try { small.parentNode && small.parentNode.removeChild(small); } catch (_) {}
      try { large.parentNode && large.parentNode.removeChild(large); } catch (_) {}
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
        largeBefore: largeBefore,
        largeAfterWheel: largeAfterWheel,
        small: smallSnap,
        largeConnectedAfterSmall: largeConnectedAfterSmall
      };
    })()
  `.trim();
  const mainExpr = `
    (async function() {
      var BW = require('electron').BrowserWindow;
      var wins = BW.getAllWindows();
      var out = [];
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        try {
          var attached = false;
          try { attached = w.webContents.debugger.isAttached(); } catch (_) {}
          if (!attached) {
            try { w.webContents.debugger.attach('1.3'); } catch (eAttach) {
              out.push({ id: w.id, attachError: String(eAttach && eAttach.message || eAttach) });
              continue;
            }
          }
          await w.webContents.debugger.sendCommand('Runtime.enable');
          var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: ${JSON.stringify(rendererExpr)},
            includeCommandLineAPI: true,
            returnByValue: true,
            awaitPromise: true
          });
          out.push({
            id: w.id,
            value: r && r.result ? r.result.value : undefined,
            exception: r && r.exceptionDetails ? (r.exceptionDetails.text || 'exception') : undefined
          });
        } catch (e) {
          out.push({ id: w && w.id, error: String(e && e.message || e) });
        }
      }
      return out;
    })()
  `.trim();
  return evaluateInMainProcessForTests(mainExpr);
}

// ASCII-escape every non-ASCII char to \\uXXXX. The payload is base64-
// encoded for transport and the renderer uses atob() which returns a
// binary (latin-1) string; without the escape, UTF-8 multibyte chars
// (e.g. Korean) come out as mojibake when the string is eval'd.
function jsonStringifyAscii(value: unknown): string {
  return JSON.stringify(value).replace(/[-￿]/g, c =>
    '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function previewTypeHandler(docUriStr: string, identifier: string): Promise<void> {
  if (identifier.length <= 2) { return; }
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  // Snapshot the on-screen anchor position the new hover should fire
  // at. Resolution can open or inspect the target definition off-screen
  // (e.g. drilling into a definition far down the file), so without this
  // snapshot showHover can end up firing outside the viewport and the
  // user perceives it as "hover disappeared".
  const anchorPos = lastHoverFetchPosition;
  if (!anchorPos) {
    log.warn(`preview: "${identifier}" no anchorPos — skipping (no prior hover position)`);
    return;
  }
  log.info(`preview: "${identifier}" start`);

  // Resolve location: declaration in the current preview first (nested
  // classes/methods), then sidecar, then hover-side cache+find fallback.
  let loc: vscode.Location | null = null;
  const declaredInPreview = cappedPreviewLocationGet(lastPreviewDeclarationLocations, identifier);
  if (declaredInPreview) {
    loc = declaredInPreview;
    log.info(`preview:   loc from preview declaration: ${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`);
  }
  let originFs = '';
  try { if (docUriStr) { originFs = vscode.Uri.parse(docUriStr).fsPath; } } catch {}
  if (!originFs) { originFs = vscode.window.activeTextEditor?.document.uri.fsPath ?? ''; }
  if (!loc && originFs && indexManager) {
    try {
      const fastHit = await fastResolveTypeName(identifier, originFs, findOpenDoc(vscode.Uri.file(originFs)));
      if (fastHit) {
        loc = new vscode.Location(
          vscode.Uri.file(fastHit.path),
          new vscode.Position(Math.max(0, fastHit.line - 1), Math.max(0, fastHit.col - 1)),
        );
        log.info(`preview:   loc from sidecar: ${vscode.workspace.asRelativePath(loc.uri)}:${fastHit.line}`);
      }
    } catch (err) { log.warn(`preview: sidecar error: ${err}`); }
  }
  if (!loc) {
    const cached = cappedPreviewLocationGet(lastPreviewLocations, identifier);
    if (cached) {
      try {
        const cacheDoc = findOpenDoc(cached.uri) ?? await vscode.workspace.openTextDocument(cached.uri);
        const cl = cached.range.start.line;
        const startLine = Math.max(0, cl - 5);
        const endLine = Math.min(cacheDoc.lineCount, cl + 30);
        const re = new RegExp(`\\b${esc(identifier)}\\b`);
        let foundPos: vscode.Position | null = null;
        for (let li = startLine; li < endLine; li++) {
          const m = re.exec(cacheDoc.lineAt(li).text);
          if (m) { foundPos = new vscode.Position(li, m.index); break; }
        }
        if (foundPos) {
          loc = new vscode.Location(cached.uri, foundPos);
          log.info(`preview:   loc from cache+find: ${vscode.workspace.asRelativePath(cached.uri)}:${foundPos.line + 1}:${foundPos.character + 1}`);
        } else {
          loc = cached;
        }
      } catch (err) {
        log.warn(`preview: cache lookup error: ${err}`);
        loc = cached;
      }
    }
  }
  if (!loc) {
    log.info(`preview: "${identifier}" no location (${ms()})`);
    return;
  }

  let doc: vscode.TextDocument;
  try { doc = await vscode.workspace.openTextDocument(loc.uri); }
  catch (err) { log.warn(`preview: openDoc error: ${err} (${ms()})`); return; }

  let markdown = '';
  try {
    const startLine = loc.range.start.line;
    const hintedEndLine = loc.range.end.line > startLine ? loc.range.end.line : undefined;
    const sourcePreview = buildDefinitionPreviewResult(identifier, loc.uri, doc, startLine, hintedEndLine);
    markdown = sourcePreview.preview;
    log.info(`preview: source block ${vscode.workspace.asRelativePath(loc.uri)}:${sourcePreview.location.range.start.line + 1}-${sourcePreview.location.range.end.line} lines=${sourcePreview.previewLineCount ?? '?'} md=${markdown.length} (${ms()})`);
  } catch (err) {
    log.warn(`preview: source preview error: ${err} (${ms()})`);
  }

  try {
      if (!markdown) {
      let hovers: vscode.Hover[] | undefined;
      internalHoverProviderRequestDepth++;
      try {
        hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider', loc.uri, loc.range.start,
        );
      } finally {
        internalHoverProviderRequestDepth--;
      }
      if (hovers?.length) {
        const parts: string[] = [];
        for (const h of hovers) {
          for (const c of (h.contents as any[])) {
            const val = typeof c === 'string' ? c
              : c instanceof vscode.MarkdownString ? c.value
              : (c && typeof c.value === 'string') ? c.value
              : null;
            if (val) { parts.push(val); }
          }
        }
        markdown = parts.join('\n\n---\n\n');
        if (markdown) {
          log.info(`preview: hoverProvider fallback md=${markdown.length} (${ms()})`);
        }
      }
    }
  } catch (err) {
    log.warn(`preview: hoverProvider error: ${err} (${ms()})`);
  }

  if (!markdown) {
    const startLine = loc.range.start.line;
    const hintedEndLine = loc.range.end.line > startLine ? loc.range.end.line : undefined;
    const sourcePreview = buildDefinitionPreviewResult(identifier, loc.uri, doc, startLine, hintedEndLine);
    markdown = sourcePreview.preview;
    log.info(`preview: source fallback block ${vscode.workspace.asRelativePath(loc.uri)}:${sourcePreview.location.range.start.line + 1}-${sourcePreview.location.range.end.line} lines=${sourcePreview.previewLineCount ?? '?'} md=${markdown.length} (${ms()})`);
  }

  // Drill-down history: push the page we're navigating away from (if
  // any) onto the stack before installing the new one. The back link
  // is appended via applyPreviewStateAsHover below — when history is
  // non-empty, the rendered hover will include a "← Back" command link.
  if (currentPreviewState) {
    previewHistory.push(currentPreviewState);
  }
  const anchorDoc = findOpenDoc(anchorPos.uri);
  const anchorRange = anchorDoc
    ? fullWordRangeAt(anchorDoc, new vscode.Position(anchorPos.line, anchorPos.character))
    : undefined;
  currentPreviewState = {
    identifier,
    markdown,
    anchor: anchorPos,
    anchorRange,
  };

  await applyPreviewStateAsHover(currentPreviewState, ms);
}

/**
 * Handle the [← Back] click in a drill-down hover. If previewHistory has
 * entries, pop one and re-render. If empty (we're at the first drill-down),
 * clear the override and refire — VS Code returns the original LSP hover.
 */
async function previewBackHandler(): Promise<void> {
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  if (!currentPreviewState) {
    log.info(`previewBack: no current drill-down state — ignoring`);
    return;
  }
  if (previewHistory.length > 0) {
    const prev = previewHistory.pop()!;
    currentPreviewState = prev;
    log.info(`previewBack: → "${prev.identifier}" stack=${previewHistory.length}`);
    await applyPreviewStateAsHover(prev, ms);
    return;
  }
  // History empty → back to original LSP hover. Clear our override and
  // refire showHover at the saved anchor; $provideHover will take the
  // genuine LSP path (which also clears state via the fresh-hover branch,
  // but we clear here for clarity).
  const anchor = currentPreviewState.anchor;
  pendingPreviewHover = null;
  previewHoverSuppressUntil = 0;
  currentPreviewState = null;
  log.info(`previewBack: → original LSP hover at ${anchor.line}:${anchor.character} (${ms()})`);
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === anchor.uri.toString()) {
      const newPos = new vscode.Position(anchor.line, anchor.character);
      editor.selection = new vscode.Selection(newPos, newPos);
    }
    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('editor.action.showHover');
  } catch (err) {
    log.warn(`previewBack: hide+showHover error: ${err} (${ms()})`);
  }
}

/**
 * Build pendingPreviewHover from a PreviewState (always prepends a
 * "← Back" command link — first drill-down's back returns to the LSP
 * hover; deeper drill-downs pop the prior page off history), move the
 * editor cursor to the state's anchor, then hide+show the hover so VS
 * Code's native pipeline picks up the override. Shared by drill-down
 * and back.
 */
async function applyPreviewStateAsHover(state: PreviewState, ms: () => string): Promise<void> {
  const renderedMarkdown = `[$(arrow-left) Back](command:intellisenseRecursion.previewBack "Back")\n\n${state.markdown}`;
  const anchorDoc = findOpenDoc(state.anchor.uri);
  const pendingRange = internalRangeFromVsCode(state.anchorRange)
    ?? internalFullWordRangeAt(anchorDoc, new vscode.Position(state.anchor.line, state.anchor.character));
  pendingPreviewHover = {
    identifier: state.identifier,
    contents: [{ value: renderedMarkdown, isTrusted: true, supportThemeIcons: true }],
    range: pendingRange,
    expiresAt: Date.now() + 3000,
  };
  previewHoverSuppressUntil = 0;

  try {
    const editor = vscode.window.activeTextEditor;
    const targetUriStr = state.anchor.uri.toString();
    if (editor && editor.document.uri.toString() === targetUriStr) {
      const newPos = new vscode.Position(state.anchor.line, state.anchor.character);
      editor.selection = new vscode.Selection(newPos, newPos);
    }
    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('editor.action.showHover');
    log.info(`preview: "${state.identifier}" hide+showHover hist=${previewHistory.length} (${state.markdown.length}md, ${ms()})`);
  } catch (err) {
    log.warn(`preview: hide+showHover error: ${err} (${ms()})`);
  }
}

function httpGet(url: string): Promise<string> {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Renderer patch script ──

function getHoverPatchScript(): string {
  return `(function(){
var IR_PATCH_VERSION = ${RENDERER_PATCH_VERSION};
var IR_EXISTING_PATCH_VERSION = Number(window.__irPatchVersion)||0;
if(IR_EXISTING_PATCH_VERSION >= IR_PATCH_VERSION && window.__irTestHooks) return 'already patched';

// Tear down any prior version's listeners and style so the new patch
// has a clean slate. Each version stores its registered listeners on
// window.__irListeners so the next install can remove them precisely.
try {
  if (typeof window.__irCleanup === 'function') {
    try { window.__irCleanup('patch-upgrade'); } catch(_) {}
  }
  if (window.__irListeners) {
    for (var n = 0; n < window.__irListeners.length; n++) {
      var L = window.__irListeners[n];
      try { L.target.removeEventListener(L.type, L.fn, L.capture); } catch(_) {}
    }
  }
  if (window.__irStyleEl && window.__irStyleEl.parentNode) {
    window.__irStyleEl.parentNode.removeChild(window.__irStyleEl);
  }
  if (window.__irScanInterval) { clearInterval(window.__irScanInterval); }
  if (window.__irScanTimer) { clearTimeout(window.__irScanTimer); }
  if (window.__irCaptureFallbackTimer) { clearTimeout(window.__irCaptureFallbackTimer); }
  if (window.__irCaptureGraceTimer) { clearTimeout(window.__irCaptureGraceTimer); }
  if (window.__irTimers) {
    for (var t = 0; t < window.__irTimers.length; t++) {
      try { clearTimeout(window.__irTimers[t]); } catch(_) {}
    }
  }
  if (window.__irMarkdownObserver) { try { window.__irMarkdownObserver.disconnect(); } catch(_) {} }
  if (window.__irObservers) {
    for (var oi = 0; oi < window.__irObservers.length; oi++) {
      try { window.__irObservers[oi].disconnect(); } catch(_) {}
    }
  }
  if (window.__irDisposeMonaco) { try { window.__irDisposeMonaco('patch-upgrade'); } catch(_) {} }
  if (window.__irMonaco) {
    try {
      var oldM = window.__irMonaco;
      if (oldM.editorRegistration && typeof oldM.editorRegistration.dispose === 'function') {
        try { oldM.editorRegistration.dispose(); } catch(_) {}
      }
      if (oldM.codeEditorSvc && oldM.editor && typeof oldM.codeEditorSvc.removeCodeEditor === 'function') {
        try { oldM.codeEditorSvc.removeCodeEditor(oldM.editor); } catch(_) {}
      }
      try {
        if (oldM.editor && typeof oldM.editor.setModel === 'function') { oldM.editor.setModel(null); }
      } catch(_) {}
      try {
        if (oldM.editor && typeof oldM.editor.dispose === 'function') { oldM.editor.dispose(); }
      } catch(_) {}
      try {
        if (oldM.host && oldM.host.parentNode) { oldM.host.parentNode.removeChild(oldM.host); }
      } catch(_) {}
      window.__irMonaco = null;
    } catch(_) {}
  }
  if (window.__irStopCapture) { try { window.__irStopCapture(); } catch(_) {} }
} catch(_) {}
window.__irListeners = [];
window.__irObservers = [];
window.__irTimers = [];
window.__irPatchVersion = IR_PATCH_VERSION;
window.__irScanLogCount = 0;
window.__irWrapLogCount = 0;
window.__irPointWrapLogCount = 0;
window.__irStaleHoverLogCount = 0;
window.__irHoverPatched = true;  // legacy compat

function irLog(msg){if(typeof window.irGoToType==='function')window.irGoToType('LOG:'+msg)}
irLog('renderer: patch v'+IR_PATCH_VERSION+' installing');

function track(target, type, fn, capture){
  target.addEventListener(type, fn, capture);
  window.__irListeners.push({target:target,type:type,fn:fn,capture:capture});
}
function irTrackObserver(obs){
  window.__irObservers.push(obs);
  return obs;
}
function irForgetTimer(timer){
  var timers=window.__irTimers||[];
  for(var i=timers.length-1;i>=0;i--){
    if(timers[i]===timer)timers.splice(i,1);
  }
}
function irSetTimer(fn,ms){
  var timer=setTimeout(function(){
    irForgetTimer(timer);
    fn();
  },ms);
  window.__irTimers.push(timer);
  return timer;
}
function irClearTimer(timer){
  if(!timer)return;
  try{clearTimeout(timer)}catch(_){}
  irForgetTimer(timer);
}
function irPruneDetachedHoverState(){
  try{
    var body=document.body;
    if(window.__irHistoryFor&&!body.contains(window.__irHistoryFor)){
      window.__irHistoryFor=null;
      window.__irHistory=[];
      window.__irHistoryCurrent=null;
    }
    if(window.__irLastPreviewTarget&&!body.contains(window.__irLastPreviewTarget)){
      window.__irLastPreviewTarget=null;
    }
    if(window.__irActiveHoverEl&&!body.contains(window.__irActiveHoverEl)){
      window.__irActiveHoverEl=null;
    }
  }catch(_){}
}
window.__irCleanup=function(reason){
  try{
    if(window.__irListeners){
      for(var i=0;i<window.__irListeners.length;i++){
        var L=window.__irListeners[i];
        try{L.target.removeEventListener(L.type,L.fn,L.capture)}catch(_){}
      }
    }
    if(window.__irStyleEl&&window.__irStyleEl.parentNode){
      try{window.__irStyleEl.parentNode.removeChild(window.__irStyleEl)}catch(_){}
    }
    if(window.__irScanInterval){try{clearInterval(window.__irScanInterval)}catch(_){}}
    if(window.__irScanTimer){try{clearTimeout(window.__irScanTimer)}catch(_){}}
    if(window.__irCaptureFallbackTimer){try{clearTimeout(window.__irCaptureFallbackTimer)}catch(_){}}
    if(window.__irCaptureGraceTimer){try{clearTimeout(window.__irCaptureGraceTimer)}catch(_){}}
    if(window.__irTimers){
      for(var ti=0;ti<window.__irTimers.length;ti++){
        try{clearTimeout(window.__irTimers[ti])}catch(_){}
      }
    }
    if(window.__irMarkdownObserver){try{window.__irMarkdownObserver.disconnect()}catch(_){}}
    if(window.__irObservers){
      for(var oi=0;oi<window.__irObservers.length;oi++){
        try{window.__irObservers[oi].disconnect()}catch(_){}
      }
    }
    window.__irCleanupInProgress=true;
    if(window.__irStopCapture){try{window.__irStopCapture()}catch(_){}}
    window.__irCleanupInProgress=false;
    if(window.__irDisposeMonaco){try{window.__irDisposeMonaco(reason||'cleanup')}catch(_){}}
    window.__irListeners=[];
    window.__irObservers=[];
    window.__irTimers=[];
    window.__irScanTimer=null;
    window.__irCaptureFallbackTimer=null;
    window.__irCaptureGraceTimer=null;
    window.__irMarkdownObserver=null;
    window.__irHistoryFor=null;
    window.__irHistory=[];
    window.__irHistoryCurrent=null;
    window.__irLastPreviewTarget=null;
    window.__irActiveHoverEl=null;
    window.__irMonacoCaps=null;
    window.__irMdRenderer=null;
    window.__irTokSupports={};
    window.__irTokenizeToString=null;
    window.__irTestHooks=null;
    window.__irPatchVersion=0;
    window.__irRecaptureScheduled=false;
    window.__irCaptureActive=false;
  }catch(_){}
};

var style=document.createElement('style');
style.textContent=[
  // Always-on underline + pointer on hover. cmd/ctrl is no longer
  // required to see the hint that a symbol is clickable.
  // Hover-only underline + link color. Doubled selectors push
  // specificity (0,2,0) above .mtkN single-class rules so our hover
  // styling always wins, even though our link is wrapped inside the
  // tokenizer's .mtkN span. pointer-events:auto guards against the
  // parent mtk span swallowing clicks.
  '.monaco-hover.ir-keepalive,.monaco-hover.ir-scrollable,.monaco-editor-hover.ir-keepalive,.monaco-editor-hover.ir-scrollable{pointer-events:auto !important}',
  '.monaco-hover.ir-keepalive *,.monaco-hover.ir-scrollable *,.monaco-editor-hover.ir-keepalive *,.monaco-editor-hover.ir-scrollable *{pointer-events:auto !important}',
  '.ir-type-link,.ir-type-link *{cursor:pointer !important;pointer-events:auto !important}',
  '.ir-type-link.ir-type-link:hover,.ir-type-link:hover,.ir-type-link:hover *{text-decoration:underline !important;color:var(--vscode-textLink-foreground) !important}',
  '.ir-type-link.ir-point-active,.ir-type-link.ir-point-active *{text-decoration:underline !important;color:var(--vscode-textLink-foreground) !important}',
  // ── Drill-down content styling ──
  // We DON'T set color/font/etc on .ir-applied. The parent
  // .code-hover-contents / .markdown-hover already inherits the right
  // theme from VS Code. Forcing var(--vscode-font-family) on .ir-applied
  // (as earlier versions did) was overriding the editor monospace font
  // that .monaco-tokenized-source's inline style sets, plus pushing
  // line-height to 1.5 which broke 18px line spacing inside code blocks.
  // Letting native CSS handle everything = drill-down looks identical
  // to native hover. The only thing we keep is some prose tweaks for
  // markdown rendering (h*, hr, a, strong, em) since our irBuildMdDom
  // emits raw tags without inline styles.
  '.monaco-hover .ir-applied p,.monaco-editor-hover .ir-applied p{margin:6px 0 !important}',
  '.monaco-hover .ir-applied h1,.monaco-hover .ir-applied h2,.monaco-hover .ir-applied h3,.monaco-hover .ir-applied h4,.monaco-hover .ir-applied h5,.monaco-hover .ir-applied h6,.monaco-editor-hover .ir-applied h1,.monaco-editor-hover .ir-applied h2,.monaco-editor-hover .ir-applied h3{margin:8px 0 4px !important;font-weight:600 !important}',
  '.monaco-hover .ir-applied hr,.monaco-editor-hover .ir-applied hr{border:none !important;border-top:1px solid var(--vscode-textSeparator-foreground,rgba(128,128,128,0.35)) !important;margin:8px 0 !important}',
  '.monaco-hover .ir-applied a,.monaco-editor-hover .ir-applied a{color:var(--vscode-textLink-foreground) !important;text-decoration:none !important}',
  '.monaco-hover .ir-applied a:hover,.monaco-editor-hover .ir-applied a:hover{text-decoration:underline !important}',
  '.monaco-hover .ir-applied strong,.monaco-editor-hover .ir-applied strong{font-weight:600 !important}',
  '.monaco-hover .ir-applied em,.monaco-editor-hover .ir-applied em{font-style:italic !important}',
  // Inline code (within prose, NOT inside .monaco-tokenized-source).
  '.monaco-hover .ir-applied :not(.monaco-tokenized-source) > code,.monaco-editor-hover .ir-applied :not(.monaco-tokenized-source) > code{color:var(--vscode-textPreformat-foreground) !important;background:var(--vscode-textPreformat-background,var(--vscode-textCodeBlock-background,rgba(128,128,128,0.1))) !important;padding:1px 4px !important;border-radius:3px !important;font-family:var(--vscode-editor-font-family,monospace) !important;font-size:0.95em !important}',
  // Force monospace + 12px / 18px on our .monaco-tokenized-source AND
  // its descendants. Native VS Code CSS rules on .rendered-markdown
  // ancestors apply system font with enough specificity to override
  // our inline style on the box, so the spans end up rendered in
  // proportional system font instead of monospace. !important on a
  // CSS rule defeats inline styles, so this forces monospace through.
  // Also: spans inside our drill-down are wrapped one level deeper
  // than native (.rendered-markdown.ir-applied between code-hover-contents
  // and .monaco-tokenized-source), which breaks native\\'s scoped
  // .code-hover-contents > .monaco-tokenized-source selectors. Re-add
  // the chrome ourselves so the drill-down code block has the same
  // background / padding as native.
  '.monaco-hover .ir-applied .monaco-tokenized-source,.monaco-editor-hover .ir-applied .monaco-tokenized-source{display:block !important;font-family:Menlo,Monaco,"Courier New",monospace !important;font-size:12px !important;line-height:18px !important;letter-spacing:0 !important}',
  '.monaco-hover .ir-applied .monaco-tokenized-source *,.monaco-editor-hover .ir-applied .monaco-tokenized-source *{font-family:inherit !important;font-size:inherit !important;line-height:inherit !important}',
  // Long normal hovers need the same native scrolling treatment as
  // drill-down hovers. VS Code's custom SmoothScrollableElement can keep
  // stale dimensions after our preview is appended, clipping the tail of
  // very large definitions.
  '.monaco-hover.ir-scrollable,.monaco-editor-hover.ir-scrollable{box-sizing:border-box !important;width:var(--ir-hover-width,760px) !important;height:var(--ir-hover-height,460px) !important;max-height:var(--ir-hover-height,460px) !important;max-width:var(--ir-hover-width,760px) !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element{overflow:auto !important;overscroll-behavior:contain !important;width:100% !important;height:var(--ir-hover-height,460px) !important;max-height:var(--ir-hover-height,460px) !important;max-width:var(--ir-hover-width,760px) !important;position:relative !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element .monaco-scrollable-element,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element .monaco-scrollable-element{overflow:visible !important;height:auto !important;max-height:none !important;width:auto !important;max-width:none !important}',
  '.monaco-hover.ir-scrollable .monaco-hover-content,.monaco-editor-hover.ir-scrollable .monaco-hover-content{transform:none !important;top:0 !important;left:0 !important;position:static !important;overflow:visible !important}',
  '.monaco-hover.ir-scrollable .hover-row,.monaco-hover.ir-scrollable .hover-row-contents,.monaco-hover.ir-scrollable .hover-contents,.monaco-hover.ir-scrollable .markdown-hover,.monaco-hover.ir-scrollable .rendered-markdown,.monaco-editor-hover.ir-scrollable .hover-row,.monaco-editor-hover.ir-scrollable .hover-row-contents,.monaco-editor-hover.ir-scrollable .hover-contents,.monaco-editor-hover.ir-scrollable .markdown-hover,.monaco-editor-hover.ir-scrollable .rendered-markdown{max-height:none !important;overflow:visible !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-hover.ir-scrollable > .monaco-scrollable-element > .shadow,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .shadow{display:none !important}',
  '.monaco-hover.ir-scrollable .scrollbar,.monaco-hover.ir-scrollable .slider,.monaco-hover.ir-scrollable .shadow,.monaco-hover.ir-scrollable .sash,.monaco-hover.ir-scrollable .monaco-sash,.monaco-editor-hover.ir-scrollable .scrollbar,.monaco-editor-hover.ir-scrollable .slider,.monaco-editor-hover.ir-scrollable .shadow,.monaco-editor-hover.ir-scrollable .sash,.monaco-editor-hover.ir-scrollable .monaco-sash{display:none !important;visibility:hidden !important;pointer-events:none !important}',
  '.ir-native-hover-handle-hidden{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;width:0 !important;height:0 !important;min-width:0 !important;min-height:0 !important;max-width:0 !important;max-height:0 !important}',
  '.ir-stale-hover{display:none !important;visibility:hidden !important;pointer-events:none !important}',
].join('');
document.head.appendChild(style);
window.__irStyleEl = style;
irLog('renderer: CSS injected');

function irEventElement(target){
  return target&&(target.nodeType===1?target:target.parentElement);
}
function irClosestTypeLink(target){
  var el=irEventElement(target);
  return el&&el.closest?el.closest('.ir-type-link'):null;
}
function irClosestHover(target){
  var el=irEventElement(target);
  return el&&el.closest?el.closest('.monaco-hover, .monaco-editor-hover'):null;
}
function irEnsureHoverPointer(hoverEl){
  if(!hoverEl)return;
  try{hoverEl.style.pointerEvents='auto'}catch(_){}
  try{
    var sc=irPrimaryHoverScroller(hoverEl);
    if(sc)sc.style.pointerEvents='auto';
  }catch(_){}
}

// Eat mousedown on type-links so VS Code's selection / focus-change
// logic can't fire before our click handler — some hover widgets
// dismiss on mousedown outside the editor.
function irTypeLinkPointerDown(e){
  var link=irClosestTypeLink(e.target)||irWrapWordAtPoint(e);
  if(!link)return;
  irMarkHoverManaged(irClosestHover(link),true);
  e.preventDefault();
  e.stopImmediatePropagation();
}
track(window,'pointerdown',irTypeLinkPointerDown,true);
track(window,'mousedown',irTypeLinkPointerDown,true);
track(document,'pointerdown',irTypeLinkPointerDown,true);
track(document,'mousedown',irTypeLinkPointerDown,true);

// Drill-down dismissal control with two layers:
//  1) Mouse INSIDE the drill-down hover → block VS Code\\'s capture-phase
//     dismiss handler (it uses a cached 0-depth bbox so it would fire
//     when the cursor moves into our expanded area).
//  2) Mouse OUTSIDE the drill-down hover but the hover is "sticky"
//     (drill-down was just applied / depth just changed; user has not
//     yet moved their cursor INTO the hover) → block dismiss until
//     they enter. Once inside, we keep a short grace window instead of
//     clearing immediately; VS Code otherwise dismisses too eagerly when
//     the cursor clips an edge while scrolling or moving between rows.
var IR_HOVER_INITIAL_STICKY_MS=5000;
var IR_HOVER_EXIT_GRACE_MS=1800;
var IR_HOVER_NEAR_PX=56;
function irHoverHasManagedContent(hoverEl){
  if(!hoverEl)return false;
  if(hoverEl.classList&&hoverEl.classList.contains('ir-keepalive'))return true;
  return !!hoverEl.querySelector('.ir-applied,.ir-type-link');
}
function irArmHoverSticky(hoverEl, ms){
  if(!hoverEl||!hoverEl.classList)return;
  hoverEl.classList.add('ir-sticky');
  hoverEl.__irStickyUntil=Date.now()+ms;
  if(hoverEl.__irStickyTimer)try{irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  hoverEl.__irStickyTimer=irSetTimer(function(){
    try{
      if((hoverEl.__irStickyUntil||0)<=Date.now()){
        hoverEl.classList.remove('ir-sticky');
      }
    }catch(_){}
  },ms+50);
}
function irMarkHoverManaged(hoverEl, sticky){
  if(!hoverEl||!hoverEl.classList)return;
  hoverEl.classList.add('ir-keepalive');
  irEnsureHoverPointer(hoverEl);
  if(sticky){
    irArmHoverSticky(hoverEl,IR_HOVER_INITIAL_STICKY_MS);
  }
}
function irIsPointerNearHover(hoverEl,e){
  if(!hoverEl||typeof e.clientX!=='number'||typeof e.clientY!=='number')return false;
  try{
    var r=hoverEl.getBoundingClientRect();
    return e.clientX>=r.left-IR_HOVER_NEAR_PX&&e.clientX<=r.right+IR_HOVER_NEAR_PX&&
      e.clientY>=r.top-IR_HOVER_NEAR_PX&&e.clientY<=r.bottom+IR_HOVER_NEAR_PX;
  }catch(_){return false}
}
function irHoverGuard(e){
  var insideHv=irClosestHover(e.target);
  if(insideHv){
    var pointLink=null;
    try{pointLink=irWrapWordAtPoint(e)}catch(_){}
    if(!pointLink&&!irHoverHasManagedContent(insideHv))return;
    irEnsureHoverPointer(insideHv);
    insideHv.__irLastInsideAt=Date.now();
    irArmHoverSticky(insideHv,IR_HOVER_EXIT_GRACE_MS);
    e.stopImmediatePropagation();
    return;
  }
  var managed=document.querySelector('.monaco-hover.ir-keepalive, .monaco-editor-hover.ir-keepalive');
  if(!managed||!irHoverHasManagedContent(managed))return;
  var now=Date.now();
  var isSticky=managed.classList&&managed.classList.contains('ir-sticky');
  var recentlyInside=managed.__irLastInsideAt&&now-managed.__irLastInsideAt<IR_HOVER_EXIT_GRACE_MS;
  var near=irIsPointerNearHover(managed,e);
  if(isSticky||recentlyInside||near){
    if(near)irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
    e.stopImmediatePropagation();
  }
}
track(window,'pointermove',irHoverGuard,true);
track(window,'pointerover',irHoverGuard,true);
track(window,'pointerout',irHoverGuard,true);
track(window,'pointerleave',irHoverGuard,true);
track(window,'mousemove',irHoverGuard,true);
track(window,'mouseover',irHoverGuard,true);
track(window,'mouseout',irHoverGuard,true);
track(window,'mouseleave',irHoverGuard,true);
track(document,'pointermove',irHoverGuard,true);
track(document,'pointerover',irHoverGuard,true);
track(document,'pointerout',irHoverGuard,true);
track(document,'pointerleave',irHoverGuard,true);
track(document,'mousemove',irHoverGuard,true);
track(document,'mouseover',irHoverGuard,true);
track(document,'mouseout',irHoverGuard,true);
track(document,'mouseleave',irHoverGuard,true);
function irPrimaryHoverScroller(hoverEl){
  if(!hoverEl)return null;
  try{
    var children=hoverEl.children||[];
    for(var i=0;i<children.length;i++){
      if(children[i].classList&&children[i].classList.contains('monaco-scrollable-element'))return children[i];
    }
  }catch(_){}
  try{
    var direct=hoverEl.querySelector(':scope > .monaco-scrollable-element');
    if(direct)return direct;
  }catch(_){}
  return hoverEl.querySelector('.monaco-scrollable-element')||hoverEl;
}
function irFlattenNestedScrollLayers(hoverEl){
  if(!hoverEl||!hoverEl.querySelectorAll)return;
  var primary=irPrimaryHoverScroller(hoverEl);
  var all=hoverEl.querySelectorAll('.monaco-scrollable-element');
  for(var i=0;i<all.length;i++){
    var sc=all[i];
    if(sc===primary)continue;
    sc.style.overflow='visible';
    sc.style.height='auto';
    sc.style.maxHeight='none';
    sc.style.width='auto';
    sc.style.maxWidth='none';
    sc.style.transform='none';
    var content=sc.querySelector('.monaco-hover-content, .scrollable-element, .hover-contents, .rendered-markdown');
    if(content){
      content.style.transform='none';
      content.style.top='0';
      content.style.left='0';
      content.style.position='static';
      content.style.overflow='visible';
    }
  }
}
var IR_HOVER_NATIVE_HANDLE_SELECTOR='.scrollbar,.slider,.shadow,.sash,.monaco-sash';
function irQuarantineHoverNativeHandle(handle,remove){
  if(!handle)return;
  try{
    if(remove&&handle.parentNode){
      handle.parentNode.removeChild(handle);
      return;
    }
  }catch(_){}
  try{
    if(handle.classList)handle.classList.add('ir-native-hover-handle-hidden');
    handle.setAttribute('aria-hidden','true');
    var props={
      display:'none',
      visibility:'hidden',
      pointerEvents:'none',
      opacity:'0',
      width:'0px',
      height:'0px',
      minWidth:'0px',
      minHeight:'0px',
      maxWidth:'0px',
      maxHeight:'0px',
      transform:'none'
    };
    for(var k in props){
      if(Object.prototype.hasOwnProperty.call(props,k)){
        handle.style.setProperty(k.replace(/[A-Z]/g,function(ch){return '-'+ch.toLowerCase()}),props[k],'important');
      }
    }
  }catch(_){}
}
function irHideHoverNativeHandles(hoverEl,remove){
  if(!hoverEl||!hoverEl.querySelectorAll)return;
  try{
    var handles=hoverEl.querySelectorAll(IR_HOVER_NATIVE_HANDLE_SELECTOR);
    for(var hi=0;hi<handles.length;hi++)irQuarantineHoverNativeHandle(handles[hi],!!remove);
  }catch(_){}
}
function irDisposeStaleHover(hoverEl,reason){
  if(!hoverEl||!hoverEl.classList)return;
  try{if(hoverEl.__irStickyTimer)irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  try{if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame)}catch(_){}
  try{irResetHoverViewportShift(hoverEl)}catch(_){}
  try{irHideHoverNativeHandles(hoverEl,true)}catch(_){}
  try{
    hoverEl.classList.remove('ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive');
    hoverEl.classList.add('ir-stale-hover');
    hoverEl.style.pointerEvents='none';
    hoverEl.style.display='none';
  }catch(_){}
  try{
    if(window.__irActiveHoverEl===hoverEl)window.__irActiveHoverEl=null;
    if(window.__irHistoryFor===hoverEl){
      window.__irHistoryFor=null;
      window.__irHistory=[];
      window.__irHistoryCurrent=null;
    }
  }catch(_){}
  try{
    if(hoverEl.parentNode)hoverEl.parentNode.removeChild(hoverEl);
  }catch(_){}
  if(window.__irStaleHoverLogCount<20){
    window.__irStaleHoverLogCount++;
    irLog('renderer: stale hover removed '+(reason||''));
  }
}
function irSetActiveHoverLayer(hoverEl){
  if(!hoverEl)return;
  window.__irActiveHoverEl=hoverEl;
  irEnsureHoverPointer(hoverEl);
  var hovers=document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
  for(var i=0;i<hovers.length;i++){
    var h=hovers[i];
    if(h===hoverEl)continue;
    var managed=irHoverHasManagedContent(h)||(h.classList&&h.classList.contains('ir-scrollable'));
    if(managed){
      irDisposeStaleHover(h,'active-switch');
    }else{
      h.classList.remove('ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large');
      if(h.__irStickyTimer)try{irClearTimer(h.__irStickyTimer)}catch(_){}
      try{irResetHoverViewportShift(h)}catch(_){}
    }
  }
}
function irHoverScrollElement(hoverEl,t){
  return irBestHoverScroller(hoverEl,t);
}
function irScrollRange(el){
  if(!el)return {x:0,y:0};
  return {
    x:Math.max(0,(el.scrollWidth||0)-(el.clientWidth||0)),
    y:Math.max(0,(el.scrollHeight||0)-(el.clientHeight||0))
  };
}
function irAddScrollCandidate(out,seen,el){
  if(!el||seen.indexOf(el)>=0)return;
  seen.push(el);
  out.push(el);
}
function irBestHoverScroller(hoverEl,t){
  if(!hoverEl)return null;
  var out=[],seen=[];
  try{
    var targetEl=irWheelTargetElement(t);
    if(targetEl&&targetEl.closest){
      irAddScrollCandidate(out,seen,targetEl.closest('.monaco-scrollable-element'));
      irAddScrollCandidate(out,seen,targetEl.closest('.hover-row, .hover-row-contents, .hover-contents, .markdown-hover, .rendered-markdown'));
    }
  }catch(_){}
  irAddScrollCandidate(out,seen,irPrimaryHoverScroller(hoverEl));
  irAddScrollCandidate(out,seen,hoverEl);
  try{
    var all=hoverEl.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown');
    for(var i=0;i<all.length;i++)irAddScrollCandidate(out,seen,all[i]);
  }catch(_){}
  var best=null,bestScore=-1;
  for(var ci=0;ci<out.length;ci++){
    var el=out[ci];
    try{
      var r=irScrollRange(el);
      var score=r.y*2+r.x;
      if(score>bestScore){best=el;bestScore=score}
    }catch(_){}
  }
  return best||irPrimaryHoverScroller(hoverEl);
}
function irWheelDelta(e,axisClientSize){
  var factor=e.deltaMode===1?18:(e.deltaMode===2?Math.max(120,axisClientSize||600):1);
  return {x:(e.deltaX||0)*factor,y:(e.deltaY||0)*factor};
}
function irWheelTargetElement(t){
  if(!t)return null;
  if(t.closest)return t;
  return t.parentElement||t.parentNode||null;
}
track(document,'wheel',function(e){
  if(e.__irWheelHandled)return;
  var t=irWheelTargetElement(e.target);
  if(!t||!t.closest)return;
  var active=window.__irActiveHoverEl;
  var insideHv=(active&&active.contains&&active.contains(t))?active:t.closest('.monaco-hover, .monaco-editor-hover');
  if(insideHv){
    if(!insideHv.classList.contains('ir-scrollable')){
      var pre=irPrimaryHoverScroller(insideHv);
      var textLen=(insideHv.textContent||'').length;
      if(textLen>800||(pre&&pre.scrollHeight>pre.clientHeight+1)){
        irMakeHoverScrollable(insideHv,false,textLen);
      }else{
        irSetActiveHoverLayer(insideHv);
        return;
      }
    }
    e.__irWheelHandled=true;
    var sc=irHoverScrollElement(insideHv,t);
    var d=irWheelDelta(e,sc?sc.clientHeight:0);
    var dx=d.x,dy=d.y;
    if(e.shiftKey&&Math.abs(dx)<1&&Math.abs(dy)>0){dx=dy;dy=0}
    var didScroll=false;
    if(sc){
      var maxTop=Math.max(0,(sc.scrollHeight||0)-(sc.clientHeight||0));
      var maxLeft=Math.max(0,(sc.scrollWidth||0)-(sc.clientWidth||0));
      if(maxTop>0&&dy){
        var oldTop=sc.scrollTop||0;
        var newTop=irClamp(oldTop+dy,0,maxTop);
        if(newTop!==oldTop){sc.scrollTop=newTop;didScroll=(sc.scrollTop||0)!==oldTop}
      }
      if(maxLeft>0&&dx){
        var oldLeft=sc.scrollLeft||0;
        var newLeft=irClamp(oldLeft+dx,0,maxLeft);
        if(newLeft!==oldLeft){sc.scrollLeft=newLeft;didScroll=didScroll||((sc.scrollLeft||0)!==oldLeft)}
      }
      if(didScroll){
        insideHv.__irLastInsideAt=Date.now();
        irArmHoverSticky(insideHv,IR_HOVER_EXIT_GRACE_MS);
      }
    }
    if(!didScroll){
      // Do not consume wheel when our selected element has no scroll range
      // or is already at the boundary. Otherwise the hover becomes a wheel
      // event sink and neither native hover scrolling nor editor scrolling
      // can proceed.
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }
},true);

var IR_HOVER_LINK_SKIP={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'throws':1,'since':1,'see':1,'deprecated':1,'alias':1,'overload':1,'module':1,'variable':1,'Any':1,'None':1,'Optional':1,'Union':1,'Callable':1,'Type':1,'Self':1,'List':1,'Dict':1,'Set':1,'Tuple':1,'Iterable':1,'Iterator':1,'Sequence':1,'Mapping':1,'True':1,'False':1,'Cannot':1,'Could':1,'Would':1,'Should':1,'This':1,'That':1,'These':1,'Those':1,'Here':1,'There':1,'Warning':1,'Warnings':1,'See':1,'Also':1,'More':1,'Given':1,'Available':1,'Required':1,'Reference':1,'Examples':1};
var IR_HOVER_LINK_MAX_TYPES=240;
var IR_HOVER_LINK_MAX_LOWER_DECLS=100;
var IR_HOVER_LINK_MAX_CONSTANTS=80;
function irTypeShapedName(w){return /^[A-Z][A-Za-z0-9_]*$/.test(w)||/^_[A-Z][A-Z0-9_]*$/.test(w)}
function irConstantHoverLinkName(w){return /^_*[A-Z][A-Z0-9_]*$/.test(w)}
function irPrimaryHoverLinkName(w){return /[a-z]/.test(w)}
function irLowerCallableName(w){return /^[a-z_$][A-Za-z0-9_$]*$/.test(w)}
function irAddHoverLinkName(types,seen,skip,w,allowLower){
  if(!w||w.length<=2||skip[w]||seen[w])return;
  if(!allowLower&&!irTypeShapedName(w))return;
  seen[w]=1;
  types.push(w);
}
function irTextNodeInAnchor(node,block){
  var anc=node&&node.parentNode;
  while(anc&&anc!==block){
    if(anc.nodeName==='A'||(anc.classList&&anc.classList.contains('ir-type-link')))return true;
    anc=anc.parentNode;
  }
  return false;
}
function irWordAtOffset(text,offset){
  var s=String(text||'');
  if(!s)return null;
  var wc=/[A-Za-z0-9_]/;
  var idx=Math.max(0,Math.min(offset,s.length-1));
  if(!wc.test(s.charAt(idx))&&idx>0&&wc.test(s.charAt(idx-1)))idx--;
  if(!wc.test(s.charAt(idx)))return null;
  var start=idx,end=idx+1;
  while(start>0&&wc.test(s.charAt(start-1)))start--;
  while(end<s.length&&wc.test(s.charAt(end)))end++;
  return {word:s.slice(start,end),start:start,end:end};
}
function irPointRange(e){
  if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return null;
  try{
    if(document.caretRangeFromPoint)return document.caretRangeFromPoint(e.clientX,e.clientY);
    if(document.caretPositionFromPoint){
      var pos=document.caretPositionFromPoint(e.clientX,e.clientY);
      if(pos){
        var r=document.createRange();
        r.setStart(pos.offsetNode,pos.offset);
        r.collapse(true);
        return r;
      }
    }
  }catch(_){}
  return null;
}
function irPointAllowsLowerCallable(node,info){
  if(!node||!info||!irLowerCallableName(info.word))return false;
  var text=String(node.nodeValue||'');
  var before=text.slice(Math.max(0,info.start-48),info.start);
  var after=text.slice(info.end,Math.min(text.length,info.end+16));
  if(/(?:^|\\s)(?:async\\s+)?def\\s+$/.test(before))return true;
  if(/(?:^|\\s)(?:async\\s+)?function\\s+$/.test(before))return true;
  if(/^\\s*\\(/.test(after))return true;
  return false;
}
function irSetPointActiveLink(link){
  try{
    var prev=window.__irPointActiveLink;
    if(prev&&prev!==link&&prev.classList)prev.classList.remove('ir-point-active');
    window.__irPointActiveLink=link||null;
    if(link&&link.classList)link.classList.add('ir-point-active');
  }catch(_){}
}
function irWrapTextNodeWord(node,info){
  if(!node||!node.parentNode||!info||info.start<0||info.end<=info.start||info.end>(node.nodeValue||'').length)return null;
  var after=node.splitText(info.start);
  var rest=after.splitText(info.end-info.start);
  var parent=after.parentNode;
  if(!parent)return null;
  var span=document.createElement('span');
  span.className='ir-type-link';
  span.setAttribute('data-type',info.word);
  parent.insertBefore(span,after);
  span.appendChild(after);
  return span;
}
function irWrapWordAtPoint(e){
  var hover=irClosestHover(e&&e.target);
  if(!hover){irSetPointActiveLink(null);return null}
  var range=irPointRange(e);
  var node=range&&range.startContainer;
  if(!node||node.nodeType!==3||!node.parentNode){irSetPointActiveLink(null);return null}
  var parentEl=node.parentNode.nodeType===1?node.parentNode:node.parentNode.parentElement;
  var block=parentEl&&parentEl.closest?parentEl.closest('.rendered-markdown'):null;
  if(!block||!hover.contains(block)||irTextNodeInAnchor(node,block)){irSetPointActiveLink(null);return null}
  var info=irWordAtOffset(node.nodeValue||'',range.startOffset||0);
  var allowLower=irPointAllowsLowerCallable(node,info);
  if(!info||IR_HOVER_LINK_SKIP[info.word]||info.word.length<=2||(!irTypeShapedName(info.word)&&!allowLower)){irSetPointActiveLink(null);return null}
  var span=irWrapTextNodeWord(node,info);
  if(span){
    irSetPointActiveLink(span);
    irMarkHoverManaged(hover,true);
    if(window.__irPointWrapLogCount<20){
      window.__irPointWrapLogCount++;
      irLog('renderer: point-wrap "'+info.word+'"');
    }
  }
  return span;
}
function irDeclarationNamesInLine(line){
  var out=[];
  var trimmed=(line||'').trim();
  if(!trimmed||trimmed.indexOf('#')===0||trimmed.indexOf('//')===0)return out;
  var patterns=[
    /^(?:export\\s+)?(?:abstract\\s+)?(?:class|interface|enum|struct)\\s+([A-Za-z_$][\\w$]*)\\b/,
    /^(?:export\\s+)?type\\s+([A-Za-z_$][\\w$]*)\\b/,
    /^(?:async\\s+)?def\\s+([A-Za-z_]\\w*)\\b/,
    /^(?:export\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\b/,
    /^(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\b/,
    /^([A-Z_][A-Z0-9_]*)\\s*(?::[^=]+)?=/
  ];
  for(var pi=0;pi<patterns.length;pi++){
    var pm=patterns[pi].exec(trimmed);
    if(pm&&pm[1]){out.push(pm[1]);return out}
  }
  if(/^(?:if|elif|else|for|while|switch|case|return|throw|raise|yield|await|with|try|except|finally|from|import|new)\\b/.test(trimmed))return out;
  var mm=/^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\\s+)*([A-Za-z_$][\\w$]*)\\s*(?:<[^>\\n]*>)?\\s*\\([^=;{}]*\\)\\s*(?::|=>|\\{|$)/.exec(trimmed);
  if(mm&&mm[1])out.push(mm[1]);
  return out;
}
function irCollectTypeShapedCandidates(text,skip,types,seen,maxChars,maxLines){
  var src=String(text||'');
  var lines=src.split(/\\n/);
  var used=0;
  var re=/\\b[A-Z_][A-Za-z0-9_]{2,}\\b/g;
  var constants=[],constantSeen={},deferred=[],deferredSeen={};
  var reserve=Math.min(IR_HOVER_LINK_MAX_CONSTANTS,Math.max(0,IR_HOVER_LINK_MAX_TYPES-types.length));
  var primaryLimit=Math.max(0,IR_HOVER_LINK_MAX_TYPES-reserve);
  for(var li=0;li<lines.length&&li<maxLines&&used<maxChars;li++){
    var line=lines[li]||'';
    used+=line.length+1;
    re.lastIndex=0;
    var m;
    while((m=re.exec(line))!==null){
      var w=m[0];
      if(irPrimaryHoverLinkName(w)){
        if(types.length<primaryLimit){
          irAddHoverLinkName(types,seen,skip,w,false);
        }else if(!deferredSeen[w]){
          deferredSeen[w]=1;
          deferred.push(w);
        }
      }else if(irConstantHoverLinkName(w)){
        if(!constantSeen[w]){
          constantSeen[w]=1;
          constants.push(w);
        }
      }else if(!deferredSeen[w]){
        deferredSeen[w]=1;
        deferred.push(w);
      }
    }
  }
  for(var ci=0;ci<constants.length&&ci<IR_HOVER_LINK_MAX_CONSTANTS;ci++){
    irAddHoverLinkName(types,seen,skip,constants[ci],false);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)return;
  }
  for(var di=0;di<deferred.length;di++){
    irAddHoverLinkName(types,seen,skip,deferred[di],false);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)return;
  }
}
function irCollectHoverLinkNames(text,skip){
  var src=String(text||'');
  var types=[],seen={};
  var lowerDecls=[];
  var lines=src.split(/\\n/);
  for(var li=0;li<lines.length;li++){
    var decls=irDeclarationNamesInLine(lines[li]);
    for(var di=0;di<decls.length;di++){
      if(irTypeShapedName(decls[di])){
        irAddHoverLinkName(types,seen,skip,decls[di],false);
      }else{
        lowerDecls.push(decls[di]);
      }
      if(types.length>=IR_HOVER_LINK_MAX_TYPES)return types;
    }
  }
  for(var ld=0;ld<lowerDecls.length&&ld<IR_HOVER_LINK_MAX_LOWER_DECLS;ld++){
    irAddHoverLinkName(types,seen,skip,lowerDecls[ld],true);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)return types;
  }
  // Large definition previews can be tens of KB. Earlier patches returned
  // after declaration scanning, so type annotations like "owner: User" were
  // never wrapped in hover links. Keep the scan bounded but always inspect
  // the visible/front-loaded code for type-shaped names.
  irCollectTypeShapedCandidates(src,skip,types,seen,src.length>24000?100000:src.length+1,src.length>24000?2200:lines.length);
  for(var d=IR_HOVER_LINK_MAX_LOWER_DECLS;d<lowerDecls.length;d++){
    irAddHoverLinkName(types,seen,skip,lowerDecls[d],true);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)break;
  }
  return types;
}

var IR_HOVER_SIZE_TIERS=[
  {name:'small',width:560,height:260,maxText:2500,maxLines:45},
  {name:'medium',width:780,height:460,maxText:12000,maxLines:180},
  {name:'large',width:1040,height:680,maxText:Infinity,maxLines:Infinity}
];
function irClamp(n,min,max){return Math.max(min,Math.min(max,n))}
function irNumericStyle(el,prop){
  var n=parseFloat(el&&el.style?el.style[prop]:'');
  return Number.isFinite(n)?n:0;
}
function irMeasureHoverContent(hoverEl,fallbackTextLength){
  var content=hoverEl&&hoverEl.querySelector?hoverEl.querySelector('.monaco-hover-content'):null;
  var text=(content&&content.textContent)||(hoverEl&&hoverEl.textContent)||'';
  var textLength=Math.max(fallbackTextLength||0,text.length);
  var lines=text.split(/\\n/);
  var lineCount=Math.max(1,lines.length);
  var longest=0;
  for(var li=0;li<lines.length;li++){if(lines[li].length>longest)longest=lines[li].length}
  return {textLength:textLength,lineCount:lineCount,longest:longest};
}
function irPickHoverSizeTier(hoverEl,fallbackTextLength){
  var m=irMeasureHoverContent(hoverEl,fallbackTextLength);
  for(var i=0;i<IR_HOVER_SIZE_TIERS.length;i++){
    var t=IR_HOVER_SIZE_TIERS[i];
    if(m.textLength<=t.maxText&&m.lineCount<=t.maxLines){
      t.measure=m;
      return t;
    }
  }
  IR_HOVER_SIZE_TIERS[2].measure=m;
  return IR_HOVER_SIZE_TIERS[2];
}
function irResetHoverViewportShift(hoverEl){
  if(!hoverEl)return;
  var dx=hoverEl.__irViewportShiftX||0;
  var dy=hoverEl.__irViewportShiftY||0;
  if(dx){
    hoverEl.style.marginLeft=(irNumericStyle(hoverEl,'marginLeft')-dx)+'px';
    hoverEl.__irViewportShiftX=0;
  }
  if(dy){
    hoverEl.style.marginTop=(irNumericStyle(hoverEl,'marginTop')-dy)+'px';
    hoverEl.__irViewportShiftY=0;
  }
}
function irKeepHoverInViewport(hoverEl){
  if(!hoverEl||!hoverEl.getBoundingClientRect)return;
  try{
    irResetHoverViewportShift(hoverEl);
    var margin=8;
    var vw=window.innerWidth||1200;
    var vh=window.innerHeight||800;
    var rect=hoverEl.getBoundingClientRect();
    var dx=0,dy=0;
    if(rect.right>vw-margin) dx=vw-margin-rect.right;
    if(rect.left+dx<margin) dx+=margin-(rect.left+dx);
    if(rect.bottom>vh-margin) dy=vh-margin-rect.bottom;
    if(rect.top+dy<margin) dy+=margin-(rect.top+dy);
    if(dx){
      hoverEl.style.marginLeft=(irNumericStyle(hoverEl,'marginLeft')+dx)+'px';
      hoverEl.__irViewportShiftX=dx;
    }
    if(dy){
      hoverEl.style.marginTop=(irNumericStyle(hoverEl,'marginTop')+dy)+'px';
      hoverEl.__irViewportShiftY=dy;
    }
  }catch(_){}
}
function irScheduleHoverViewportFit(hoverEl){
  if(!hoverEl)return;
  irHideHoverNativeHandles(hoverEl);
  irKeepHoverInViewport(hoverEl);
  try{
    if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame);
    hoverEl.__irFitFrame=requestAnimationFrame(function(){
      hoverEl.__irFitFrame=0;
      irHideHoverNativeHandles(hoverEl);
      irKeepHoverInViewport(hoverEl);
    });
  }catch(_){}
}
function irApplyHoverSizeTier(hoverEl,fallbackTextLength,resetScroll){
  if(!hoverEl)return null;
  var tier=irPickHoverSizeTier(hoverEl,fallbackTextLength);
  var vw=window.innerWidth||1200;
  var vh=window.innerHeight||800;
  var width=irClamp(tier.width,320,Math.max(320,Math.floor(vw*0.9)));
  var height=irClamp(tier.height,160,Math.max(160,Math.floor(vh*0.82)));
  hoverEl.classList.remove('ir-size-small','ir-size-medium','ir-size-large');
  hoverEl.classList.add('ir-size-'+tier.name);
  hoverEl.style.setProperty('--ir-hover-width',width+'px');
  hoverEl.style.setProperty('--ir-hover-height',height+'px');
  hoverEl.style.width=width+'px';
  hoverEl.style.height=height+'px';
  hoverEl.style.maxWidth=width+'px';
  hoverEl.style.maxHeight=height+'px';
  var sc=irPrimaryHoverScroller(hoverEl);
  if(sc){
    sc.style.width='100%';
    sc.style.height=height+'px';
    sc.style.maxWidth=width+'px';
    sc.style.maxHeight=height+'px';
    sc.style.overflowY='auto';
    sc.style.overflowX='auto';
    sc.style.overscrollBehavior='contain';
    sc.style.position='relative';
    if(resetScroll)sc.scrollTop=0;
  }
  var hContent=hoverEl.querySelector('.monaco-hover-content');
  if(hContent){
    hContent.style.transform='none';
    hContent.style.top='0';
    hContent.style.left='0';
    hContent.style.position='static';
    hContent.style.overflow='visible';
  }
  irHideHoverNativeHandles(hoverEl);
  irFlattenNestedScrollLayers(hoverEl);
  if(resetScroll)hoverEl.scrollTop=0;
  if(hoverEl.__irSizeTierName!==tier.name){
    hoverEl.__irSizeTierName=tier.name;
  }
  irScheduleHoverViewportFit(hoverEl);
  return tier;
}

function irTypeLinkClick(e){
  var link=irClosestTypeLink(e.target)||irWrapWordAtPoint(e);
  if(!link)return;
  var typeName=link.getAttribute('data-type');
  if(!typeName)return;
  irMarkHoverManaged(irClosestHover(link),true);
  e.preventDefault();e.stopImmediatePropagation();
  if(e.metaKey||e.ctrlKey){
    irLog('renderer: cmd-click on "'+typeName+'"');
    if(typeof window.irGoToType==='function'){window.irGoToType(typeName)}
  }else{
    var anc=link.closest('.rendered-markdown');
    window.__irLastPreviewTarget=anc;
    irLog('renderer: plain-click on "'+typeName+'"');
    if(typeof window.irGoToType==='function'){window.irGoToType('PREVIEW:'+typeName)}
  }
}
track(window,'click',irTypeLinkClick,true);
track(document,'click',irTypeLinkClick,true);

function irMakeHoverScrollable(hoverEl, resetScroll, fallbackTextLength){
  if(!hoverEl)return;
  try{
    irMarkHoverManaged(hoverEl,true);
    hoverEl.classList.add('ir-scrollable');
    irSetActiveHoverLayer(hoverEl);
    var clearProps=['height','maxHeight','minHeight','width','maxWidth','minWidth'];
    for(var cp=0;cp<clearProps.length;cp++) hoverEl.style[clearProps[cp]]='';
    var sc=irPrimaryHoverScroller(hoverEl);
    var hContent=hoverEl.querySelector('.monaco-hover-content');
    if(sc) for(var cpS=0;cpS<clearProps.length;cpS++) sc.style[clearProps[cpS]]='';
    if(hContent) for(var cpC=0;cpC<clearProps.length;cpC++) hContent.style[clearProps[cpC]]='';
    var wrappers=hoverEl.querySelectorAll('.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown');
    for(var wi=0;wi<wrappers.length;wi++){
      for(var cpW=0;cpW<clearProps.length;cpW++) wrappers[wi].style[clearProps[cpW]]='';
      wrappers[wi].style.overflow='visible';
    }

    irApplyHoverSizeTier(hoverEl,fallbackTextLength||0,resetScroll);
    if(resetScroll){
      if(hoverEl.scrollTop) hoverEl.scrollTop=0;
      if(sc&&sc.scrollTop) sc.scrollTop=0;
    }
    try { var _=hoverEl.scrollHeight; var __=hoverEl.offsetHeight; } catch(_) {}
    try { window.dispatchEvent(new Event('resize')); } catch(_) {}
  }catch(_){}
}
window.__irTestHooks={
  primaryHoverScroller:irPrimaryHoverScroller,
  makeHoverScrollable:irMakeHoverScrollable,
  setActiveHoverLayer:irSetActiveHoverLayer,
  applyHoverSizeTier:irApplyHoverSizeTier,
  disposeStaleHover:irDisposeStaleHover
};

// ── Markdown → DOM (TrustedHTML-safe) ─────────────────────────────────
// We never set innerHTML or use DOMParser.parseFromString — both are
// blocked by VS Code's CSP. Build everything via createElement and
// createTextNode. Handles fenced code, inline \`code\`, paragraphs,
// headings, hr, line breaks. Other markdown is rendered as plain text.
function irBuildInline(text, parent){
  var re=/\\\`([^\\\`]+)\\\`/g; var last=0; var m;
  while((m=re.exec(text))!==null){
    if(m.index>last) parent.appendChild(document.createTextNode(text.substring(last,m.index)));
    var c=document.createElement('code'); c.textContent=m[1]; parent.appendChild(c);
    last=m.index+m[0].length;
  }
  if(last<text.length){
    var rest=text.substring(last);
    if(rest.indexOf('\\n')<0){ parent.appendChild(document.createTextNode(rest)); return; }
    var parts=rest.split('\\n');
    for(var i=0;i<parts.length;i++){
      if(parts[i]) parent.appendChild(document.createTextNode(parts[i]));
      if(i<parts.length-1) parent.appendChild(document.createElement('br'));
    }
  }
}
function irBuildParagraphs(text,parent){
  var paras=text.split(/\\n\\s*\\n/);
  for(var p=0;p<paras.length;p++){
    var t=paras[p].trim(); if(!t) continue;
    if(/^---+$/.test(t)){ parent.appendChild(document.createElement('hr')); continue; }
    var h=/^(#{1,6})\\s+(.+)$/.exec(t);
    if(h){
      var hEl=document.createElement('h'+h[1].length);
      irBuildInline(h[2],hEl); parent.appendChild(hEl); continue;
    }
    var pEl=document.createElement('p');
    irBuildInline(t,pEl); parent.appendChild(pEl);
  }
}
// Lightweight per-line regex tokenizer for TS/JS/Python. Produces
// span elements with .ir-tk-{kw,str,num,cls,fn,cm} classes; each
// class uses a VS Code theme variable (--vscode-symbolIcon-*) so
// colors track the active theme. Not as faithful as Monaco's
// TextMate tokenizer, but distinguishes the major token categories.
var IR_KW = {
  // Shared keywords across TS/JS + Python keywords
  'const':1,'let':1,'var':1,'function':1,'class':1,'interface':1,'type':1,'enum':1,'namespace':1,
  'if':1,'else':1,'elif':1,'for':1,'while':1,'do':1,'switch':1,'case':1,'break':1,'continue':1,
  'return':1,'yield':1,'await':1,'async':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'in':1,'of':1,'is':1,
  'try':1,'catch':1,'finally':1,'throw':1,'raise':1,
  'import':1,'export':1,'from':1,'as':1,'default':1,'extends':1,'implements':1,'with':1,
  'public':1,'private':1,'protected':1,'static':1,'abstract':1,'readonly':1,'override':1,
  'void':1,'null':1,'undefined':1,'true':1,'false':1,'this':1,'super':1,'self':1,'cls':1,
  'def':1,'lambda':1,'pass':1,'global':1,'nonlocal':1,'and':1,'or':1,'not':1,'None':1,'True':1,'False':1,
  'declare':1,'keyof':1,'infer':1,'never':1,'unknown':1,'any':1,
};
var IR_PRIM = {
  'string':1,'number':1,'boolean':1,'object':1,'symbol':1,'bigint':1,
  'int':1,'str':1,'float':1,'bool':1,'list':1,'dict':1,'tuple':1,'set':1,'bytes':1,
};
// Sample which .mtkN class corresponds to which token type by walking
// already-rendered view-lines in any open editor / hover. The user's
// active theme has already mapped .mtkN → color; we just need to know
// which N is keyword, string, etc. Cached after first call.
var IR_MTK_MAP = null;
function irSampleMtk(){
  if (IR_MTK_MAP) return IR_MTK_MAP;
  var map = {
    kw:'',     // keywords (function, class, if, return, etc.)
    str:'',    // strings ('foo', "bar", \`baz\`)
    num:'',    // numbers (123, 3.14, 0xff)
    cls:'',    // class/type names (PascalCase)
    fn:'',     // function calls (followed by '(')
    cm:'',     // comments (//, /* */, #)
    prim:'',   // primitive types (string, number, boolean, ...)
    op:'',     // operators (=, +, -, *, /, <, >, etc.)
    pn:'',     // punctuation (commas, colons, semicolons)
    bk:'',     // brackets (parens, braces — used as bracket-highlighting base)
    prop:'',   // property names (after .)
    var:'',    // variable names / parameter names (lowercase identifiers)
    deco:'',   // decorators / annotations (@foo)
    def:'mtk1' // default
  };
  var KW = /^(function|const|let|var|class|interface|type|enum|if|else|elif|for|while|do|return|import|export|from|as|new|delete|typeof|instanceof|in|of|async|await|yield|throw|try|catch|finally|switch|case|break|continue|default|extends|implements|public|private|protected|static|abstract|readonly|override|namespace|declare|keyof|infer|this|super|self|def|lambda|pass|global|nonlocal|raise|and|or|not|with|module)$/;
  var KW_LITERAL = /^(true|false|null|undefined|None|True|False|never|any|unknown)$/;
  var PRIM = /^(string|number|boolean|object|symbol|bigint|void|int|str|float|bool|list|dict|tuple|set|bytes)$/;
  try {
    var spans = document.querySelectorAll('.monaco-editor .view-line span > span');
    var collected = 0;
    for (var i = 0; i < spans.length && collected < 12 && i < 4000; i++) {
      var sp = spans[i];
      var text = (sp.textContent || '').replace(/\\u00a0/g, ' ');
      var trimmed = text.trim();
      if (!trimmed) continue;
      var cls = sp.className || '';
      var m = /(?:^|\\s)(mtk\\d+)/.exec(cls);
      if (!m) continue;
      var mtk = m[1];
      // Detect kind from a single-token-looking text
      if (!map.kw && KW.test(trimmed)) { map.kw = mtk; collected++; continue; }
      if (!map.kw && KW_LITERAL.test(trimmed)) { map.kw = mtk; collected++; continue; }
      if (!map.prim && PRIM.test(trimmed)) { map.prim = mtk; collected++; continue; }
      if (!map.str && (trimmed.charAt(0) === '"' || trimmed.charAt(0) === "'" || trimmed.charAt(0) === '\`')) { map.str = mtk; collected++; continue; }
      if (!map.num && /^[0-9]/.test(trimmed)) { map.num = mtk; collected++; continue; }
      if (!map.cls && /^[A-Z][A-Za-z0-9_]+$/.test(trimmed) && trimmed.length > 1 && !KW_LITERAL.test(trimmed)) { map.cls = mtk; collected++; continue; }
      if (!map.cm && (trimmed.indexOf('//') === 0 || trimmed.indexOf('/*') === 0 || trimmed.indexOf('#') === 0)) { map.cm = mtk; collected++; continue; }
      if (!map.deco && trimmed.charAt(0) === '@' && trimmed.length > 1) { map.deco = mtk; collected++; continue; }
      // Operator-ish (single-char symbol token)
      if (!map.op && trimmed.length === 1 && '=+-*/<>!&|^%~?:'.indexOf(trimmed) >= 0) { map.op = mtk; collected++; continue; }
      // Bracket / punctuation (single-char open/close bracket)
      if (!map.bk && trimmed.length === 1 && '()[]{}'.indexOf(trimmed) >= 0) { map.bk = mtk; collected++; continue; }
      if (!map.pn && trimmed.length === 1 && ',;.'.indexOf(trimmed) >= 0) { map.pn = mtk; collected++; continue; }
      // Lowercase identifier — variable / parameter
      if (!map.var && /^[a-z_][a-zA-Z0-9_]*$/.test(trimmed) && !KW.test(trimmed) && !PRIM.test(trimmed)) { map.var = mtk; collected++; continue; }
    }
  } catch(_) {}
  // Fall back to default for any unfound type.
  for (var k in map) if (!map[k]) map[k] = 'mtk1';
  IR_MTK_MAP = map;
  irLog('mtk-map: kw='+map.kw+' prim='+map.prim+' str='+map.str+' num='+map.num+' cls='+map.cls+' fn='+map.fn+' cm='+map.cm+' op='+map.op+' bk='+map.bk+' pn='+map.pn+' prop='+map.prop+' var='+map.var+' deco='+map.deco);
  return map;
}

function irTokenizeCode(code, lang, target){
  var L = (lang||'').toLowerCase();
  var isPy = (L==='py'||L==='python');
  var lineComment = isPy ? '#' : '//';
  var i = 0; var len = code.length;
  var mtk = irSampleMtk();
  var bracketDepth = 0; // for bracket-highlighting-N classes
  function clsFor(kind){
    var k = mtk[kind];
    return k && k !== mtk.def ? k : mtk.def;
  }
  function emit(kind, text, extraCls){
    if (!text) return;
    var sp = document.createElement('span');
    var cls = clsFor(kind) + ' ir-tk-' + kind;
    if (extraCls) cls += ' ' + extraCls;
    sp.className = cls;
    sp.textContent = text;
    target.appendChild(sp);
  }
  function emitText(text){
    if (text) target.appendChild(document.createTextNode(text));
  }
  while (i < len) {
    var ch = code.charAt(i);
    // Whitespace
    if (ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r') {
      var j = i; while (j < len && (code[j]===' '||code[j]==='\\t'||code[j]==='\\n'||code[j]==='\\r')) j++;
      target.appendChild(document.createTextNode(code.substring(i, j)));
      i = j; continue;
    }
    // Line comment
    if (code.substr(i, lineComment.length) === lineComment) {
      var j = code.indexOf('\\n', i); if (j < 0) j = len;
      emit('cm', code.substring(i, j));
      i = j; continue;
    }
    // Block comment (TS/JS)
    if (!isPy && ch === '/' && code.charAt(i+1) === '*') {
      var j = code.indexOf('*/', i+2); if (j < 0) j = len; else j += 2;
      emit('cm', code.substring(i, j));
      i = j; continue;
    }
    // Strings (single/double quote, plus backtick for TS/JS)
    if (ch === '"' || ch === "'" || (!isPy && ch === '\`')) {
      var quote = ch; var j = i + 1;
      while (j < len) {
        var c2 = code.charAt(j);
        if (c2 === '\\\\') { j += 2; continue; }
        if (c2 === quote) { j++; break; }
        if (c2 === '\\n' && quote !== '\`') { break; }
        j++;
      }
      emit('str', code.substring(i, j));
      i = j; continue;
    }
    // Numbers
    if (ch >= '0' && ch <= '9') {
      var j = i;
      while (j < len && /[0-9.eExX_a-fA-F]/.test(code.charAt(j))) j++;
      emit('num', code.substring(i, j));
      i = j; continue;
    }
    // Decorators / annotations (@foo)
    if (ch === '@' && i+1 < len && /[A-Za-z_]/.test(code.charAt(i+1))) {
      var j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(code.charAt(j))) j++;
      emit('deco', code.substring(i, j));
      i = j; continue;
    }
    // Identifiers / keywords / property access
    if (/[A-Za-z_$]/.test(ch)) {
      var j = i;
      while (j < len && /[A-Za-z0-9_$]/.test(code.charAt(j))) j++;
      var word = code.substring(i, j);
      // Property access: previous non-space char is '.'
      var prevIdx = i - 1;
      while (prevIdx >= 0 && (code.charAt(prevIdx) === ' ' || code.charAt(prevIdx) === '\\t')) prevIdx--;
      var afterDot = prevIdx >= 0 && code.charAt(prevIdx) === '.';
      if (IR_KW[word]) emit('kw', word);
      else if (IR_PRIM[word]) emit('prim', word);
      else if (afterDot && j < len && code.charAt(j) === '(') emit('fn', word);
      else if (afterDot) emit('prop', word);
      else if (word.charAt(0) >= 'A' && word.charAt(0) <= 'Z') emit('cls', word);
      else if (j < len && code.charAt(j) === '(') emit('fn', word);
      else emit('var', word);
      i = j; continue;
    }
    // Brackets — apply bracket-highlighting-N like Monaco does.
    if (ch === '(' || ch === '[' || ch === '{') {
      emit('bk', ch, 'bracket-highlighting-' + (bracketDepth % 3));
      bracketDepth++;
      i++; continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      emit('bk', ch, 'bracket-highlighting-' + (bracketDepth % 3));
      i++; continue;
    }
    // Operators
    if ('=+-*/<>!&|^%~?'.indexOf(ch) >= 0) {
      var j = i + 1;
      while (j < len && '=+-*/<>!&|^%~?'.indexOf(code.charAt(j)) >= 0) j++;
      emit('op', code.substring(i, j));
      i = j; continue;
    }
    // Punctuation
    if (ch === ',' || ch === ';' || ch === ':' || ch === '.') {
      emit('pn', ch);
      i++; continue;
    }
    // Anything else — plain text
    target.appendChild(document.createTextNode(ch));
    i++;
  }
}

// Inline styles used by VS Code's native .monaco-tokenized-source. From
// snapshot of native hover. Re-applying here keeps font / line-height /
// letter-spacing identical even before we get real tokenization wired.
var IR_MTS_STYLE = 'font-family: Menlo, Monaco, "Courier New", monospace; font-weight: normal; font-size: 12px; font-feature-settings: "liga" 0, "calt" 0; font-variation-settings: normal; line-height: 18px; letter-spacing: 0px; white-space: pre;';
function irBuildMdDom(md,parent){
  var i=0; var len=md.length;
  while(i<len){
    var fenceAt=-1;
    if(md.substr(i,3)==='\\\`\\\`\\\`') fenceAt=i;
    else { var nl=md.indexOf('\\n\\\`\\\`\\\`',i); if(nl>=0) fenceAt=nl+1; }
    if(fenceAt<0){ irBuildParagraphs(md.substring(i),parent); break; }
    if(fenceAt>i) irBuildParagraphs(md.substring(i,fenceAt),parent);
    var langStart=fenceAt+3;
    var nlAfter=md.indexOf('\\n',langStart);
    if(nlAfter<0) break;
    var lang=md.substring(langStart,nlAfter).trim();
    var endFence=md.indexOf('\\\`\\\`\\\`',nlAfter+1);
    if(endFence<0) break;
    var code=md.substring(nlAfter+1,endFence);
    if(code.charAt(code.length-1)==='\\n') code=code.substring(0,code.length-1);
    // Tokenize via VS Code's actual tokenizationSupport (extracted from
    // a captured open-editor model). Returns mtkN-classed spans —
    // matches native hover output exactly. Falls back to the hidden-
    // widget approach (which collapses to mtk1) if no grammar-loaded
    // support is found for the language.
    var frag=null;
    try {
      if(typeof window.__irTokenizeToFragment==='function' && lang){
        frag=window.__irTokenizeToFragment(code,lang);
      }
    } catch(eT){ irLog('renderer: tokFrag err: '+(eT&&eT.message)); }
    if(!frag){
      try {
        if(typeof window.__irTokenizeCode==='function' && lang){
          frag=window.__irTokenizeCode(code,lang);
        }
      } catch(eT2){ irLog('renderer: tokenize err: '+(eT2&&eT2.message)); }
    }
    var box=document.createElement('div');
    box.className='monaco-tokenized-source';
    box.setAttribute('style', IR_MTS_STYLE);
    if(lang) box.setAttribute('data-lang',lang);
    if(frag){
      box.appendChild(frag);
    } else {
      // No tokenizer — at least match the native structure so font /
      // line-height / letter-spacing are right. mtk1 = default fg.
      var sp=document.createElement('span');
      sp.className='mtk1';
      sp.textContent=code;
      box.appendChild(sp);
    }
    parent.appendChild(box);
    i=endFence+3; if(md.charAt(i)==='\\n') i++;
  }
}

// Decode HTML entities + unescape markdown backslash escapes that some
// LSPs leave in their hover content (e.g. \`<class 'int'>\` arrives as
// \`&lt;class &#39;int&#39;&gt;\` and \`\\<\` stays raw).
function irDecodeContent(s){
  var out=s;
  out=out.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
  var lines=out.split('\\n');
  var inFence=false;
  for(var li=0;li<lines.length;li++){
    if(lines[li].indexOf('\\\`\\\`\\\`')===0) { inFence=!inFence; continue; }
    if(inFence) continue;
    lines[li]=lines[li].replace(/\\\\([\\\\\\\`*_{}\\[\\]()#+\\-.!<>|~])/g, '$1');
  }
  return lines.join('\\n');
}

window.irApplyPreview=function(typeName,md,fromBack){
  irLog('renderer: irApplyPreview "'+typeName+'" md='+md.length+'B'+(fromBack?' [back]':''));
  irPruneDetachedHoverState();
  var target=window.__irLastPreviewTarget;
  var src='stored';
  if(!target||!document.body.contains(target)){
    src='fallback';
    var nodes=document.querySelectorAll('.monaco-hover .rendered-markdown, .monaco-editor-hover .rendered-markdown');
    target=null;
    for(var i=nodes.length-1;i>=0;i--){
      if(nodes[i].offsetParent!==null){target=nodes[i];break}
    }
  }
  if(!target){ irLog('renderer: irApplyPreview no target for "'+typeName+'"'); return; }
  // Drill-down history: each forward navigation pushes the CURRENT
  // state to history (so we can pop back). Back navigation skips push.
  // Fresh hover (different hoverEl from last time) resets history.
  var hoverElForHistory=target.closest('.monaco-hover, .monaco-editor-hover');
  if(window.__irHistoryFor!==hoverElForHistory){
    window.__irHistoryFor=hoverElForHistory;
    window.__irHistory=[];
    window.__irHistoryCurrent=null;
  }
  if(!fromBack){
    if(window.__irHistoryCurrent){
      window.__irHistory=window.__irHistory||[];
      window.__irHistory.push(window.__irHistoryCurrent);
      while(window.__irHistory.length>20) window.__irHistory.shift();
    }
  }
  window.__irHistoryCurrent={ typeName:typeName, md:md };
  try {
    var decoded=irDecodeContent(md);
    while(target.firstChild) target.removeChild(target.firstChild);
    target.classList.add('ir-applied');
    // Find the OUTER hover (non-scrolling) and remove any existing back
    // button there — so the new one sticks to the panel\\'s top-right
    // and doesn\\'t scroll with content.
    var outerHover=target.closest('.monaco-hover, .monaco-editor-hover');
    if(outerHover){
      var prevBtn=outerHover.querySelector(':scope > .ir-back-btn');
      if(prevBtn) prevBtn.parentElement.removeChild(prevBtn);
    }
    // Back button — appears when history is non-empty. Anchored on the
    // OUTER .monaco-hover (which doesn\\'t scroll) so it stays pinned
    // top-right even as the user scrolls through long drill-down content.
    if(window.__irHistory && window.__irHistory.length && outerHover){
      var backBtn=document.createElement('button');
      backBtn.className='ir-back-btn';
      backBtn.setAttribute('aria-label','Back');
      backBtn.textContent='\\u2190';
      backBtn.style.cssText='position:absolute;top:4px;right:4px;z-index:10;cursor:pointer;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,0.2));border:1px solid var(--vscode-textSeparator-foreground,rgba(128,128,128,0.3));color:var(--vscode-foreground,inherit);padding:0 6px;border-radius:3px;font-size:13px;line-height:18px;height:20px;';
      backBtn.onclick=function(e){
        e.preventDefault(); e.stopPropagation();
        var hist=window.__irHistory;
        if(!hist||!hist.length)return;
        var prev=hist.pop();
        window.__irHistoryCurrent=prev;
        irLog('renderer: back to "'+prev.typeName+'" stack='+hist.length);
        window.irApplyPreview(prev.typeName, prev.md, true);
      };
      var ocs=window.getComputedStyle(outerHover);
      if(ocs.position==='static') outerHover.style.position='relative';
      outerHover.appendChild(backBtn);
    }
    // Prefer VS Code's captured MarkdownRenderer if we found one — it
    // produces native-quality output (TextMate + semantic tokens, plus
    // exact chrome). Falls through to our own DOM builder if not found
    // or rendering fails.
    var nativeOk = false;
    if (window.__irMdRenderer && typeof window.__irMdRenderer.render === 'function') {
      try {
        var nr = window.__irMdRenderer.render({ value: decoded, isTrusted: true, supportThemeIcons: true });
        if (nr && nr.element instanceof HTMLElement) {
          target.appendChild(nr.element);
          nativeOk = true;
          irLog('renderer: native MdRenderer used (children='+nr.element.children.length+')');
        }
      } catch(eMR){ irLog('renderer: native MdRenderer threw: '+(eMR&&eMR.message)); }
    }
    if (!nativeOk) irBuildMdDom(decoded,target);
  } catch(eAP){
    irLog('renderer: irApplyPreview build err: '+(eAP&&eAP.message?eAP.message:String(eAP)));
    return;
  }
  // Let the popup grow to fit drill-down content. The 0-depth hover
  // sizes itself once on first render; without clearing those inline
  // dims the new (potentially larger) content is clipped to that
  // original box. Clear size dimensions, but keep VS Code's native
  // top/left anchor; after resizing we shift the hover back into the
  // viewport instead of throwing the original position away.
  // Clear height/width/maxHeight/maxWidth/minWidth on hoverEl AND
  // every inner sizing wrapper. Then nudge the scrollable-element\\'s
  // internal dimensions by reading scrollHeight (forces a reflow that
  // VS Code\\'s SmoothScrollableElement picks up).
  try {
    var hoverEl=target.closest('.monaco-hover, .monaco-editor-hover');
    if(hoverEl){
      // No size pinning across depth changes: each new content sizes the
      // hover naturally. Pinning min-height/min-width to the previous
      // depth\\'s rendered box meant a small drill-down kept the big
      // outer box of an earlier large one.
      // RE-ARM sticky on EVERY depth change. Even if the user already
      // entered the hover at a previous depth, the new (potentially
      // smaller) content might shrink under the cursor, triggering a
      // phantom mouseleave. Sticky requires them to enter again before
      // dismiss is allowed.
      irMarkHoverManaged(hoverEl,true);
      var clearProps=['height','maxHeight','minHeight','width','maxWidth','minWidth'];
      // Panel-level wrappers (one per hover, shared across all rows).
      // Clearing these lets the panel reflow when our preview content
      // grows or shrinks. Other rows are siblings of ours inside these,
      // so their own sizing stays untouched.
      for(var cp=0;cp<clearProps.length;cp++) hoverEl.style[clearProps[cp]]='';
      var scTop=hoverEl.querySelector('.monaco-scrollable-element');
      if(scTop) for(var cpS=0;cpS<clearProps.length;cpS++) scTop.style[clearProps[cpS]]='';
      var hContentTop=hoverEl.querySelector('.monaco-hover-content');
      if(hContentTop) for(var cpC=0;cpC<clearProps.length;cpC++) hContentTop.style[clearProps[cpC]]='';
      // Per-row wrappers — scope to OUR row only. Other extensions\\' hover
      // rows (e.g. Pylance docstrings) live as sibling .hover-row nodes in
      // the same panel; we must not touch their dimensions or scroll.
      var ourRow=target.closest('.hover-row')||target.closest('.markdown-hover')||target;
      for(var cpR=0;cpR<clearProps.length;cpR++) ourRow.style[clearProps[cpR]]='';
      var rowInners=ourRow.querySelectorAll('.hover-row-contents, .hover-contents, .markdown-hover, .rendered-markdown');
      for(var i2=0;i2<rowInners.length;i2++){
        for(var cp2=0;cp2<clearProps.length;cp2++) rowInners[i2].style[clearProps[cp2]]='';
      }
      // Reset scrolltops: panel-level + our row only.
      if(hoverEl.scrollTop) hoverEl.scrollTop=0;
      if(scTop&&scTop.scrollTop) scTop.scrollTop=0;
      if(ourRow.scrollTop) ourRow.scrollTop=0;
      var rowScrolls=ourRow.querySelectorAll('*');
      for(var s=0;s<rowScrolls.length;s++){ if(rowScrolls[s].scrollTop) rowScrolls[s].scrollTop=0; }
      // VS Code\\'s SmoothScrollableElement caches scroll dimensions
      // internally and the cache doesn\\'t refresh on DOM mutation.
      // scanDomNode() calls didn\\'t take effect reliably, so instead
      // we BYPASS the custom scrollable entirely: switch the .monaco-
      // scrollable-element to browser-native overflow and reset the
      // hover-content\\'s transform (VS Code translates content up to
      // simulate scroll). The browser then handles scrolling natively
      // against actual current content height. Hide the overlay
      // scrollbar widgets since native scrollbar will appear instead.
      try {
        hoverEl.classList.add('ir-scrollable');
        irSetActiveHoverLayer(hoverEl);
        var sc=irPrimaryHoverScroller(hoverEl);
        if(sc){
          sc.style.overflowY='auto';
          sc.style.overflowX='auto';
          sc.style.overscrollBehavior='contain';
          sc.style.position='relative';
        }
        var hContent=hoverEl.querySelector('.monaco-hover-content');
        if(hContent){
          hContent.style.transform='none';
          hContent.style.top='0';
          hContent.style.left='0';
          hContent.style.position='static';
          hContent.style.overflow='visible';
        }
        irFlattenNestedScrollLayers(hoverEl);
        irApplyHoverSizeTier(hoverEl,(target.textContent||'').length,true);
        // Hide VS Code\\'s overlay handles; their slider geometry was
        // computed from the pre-expanded hover.
        irHideHoverNativeHandles(hoverEl);
        // Force layout flush.
        try { var _=hoverEl.scrollHeight; var __=hoverEl.offsetHeight; } catch(_) {}
      } catch(_) {}
      try { window.dispatchEvent(new Event('resize')); } catch(_) {}
    } else if(target.scrollTop){ target.scrollTop=0; }
  } catch(_) {}
  window.__irLastPreviewTarget=null;
  irLog('renderer: applied "'+typeName+'" via '+src);
};

var irLastContainerCount=0;

function irScanRenderedMarkdown(){
  irPruneDetachedHoverState();
  var containers=document.querySelectorAll('.monaco-hover .rendered-markdown, .monaco-editor-hover .rendered-markdown, .ij-find-hover-tooltip .rendered-markdown');
  if(containers.length!==irLastContainerCount) irLastContainerCount=containers.length;
  for(var j=0;j<containers.length;j++){var block=containers[j];
    var text=block.textContent||'';
    var hoverHost=block.closest('.monaco-hover, .monaco-editor-hover');
    irEnsureHoverPointer(hoverHost);
    // VS Code can replace a hover row with the same text while removing our
    // spans. Same text is only a skip when the clickable links still exist.
    var hasTypeLinks=!!block.querySelector('.ir-type-link');
    if(block.__irLastScanText===text&&hasTypeLinks){
      if(text.length>4000||hasTypeLinks) irMakeHoverScrollable(hoverHost, false, text.length);
      continue;
    }
    if(text.length>4000) irMakeHoverScrollable(hoverHost, false, text.length);
    if(text.length>24000){
      irMarkHoverManaged(hoverHost,true);
    }
    if(block.querySelector('.ir-type-link')){
      irMarkHoverManaged(hoverHost,true);
      irMakeHoverScrollable(hoverHost, false, text.length);
    }
    if(text.length<3)continue;
    var skip=IR_HOVER_LINK_SKIP;
    var types=irCollectHoverLinkNames(text,skip);
    block.__irLastScanText=text;
    var existingLinks=block.querySelectorAll?block.querySelectorAll('.ir-type-link').length:0;
    if(window.__irScanLogCount<20&&(text.length>800||types.length||existingLinks)){
      window.__irScanLogCount++;
      irLog('renderer: scan text='+text.length+' types='+types.length+' existing='+existingLinks+' sample='+types.slice(0,10).join(','));
    }
    if(!types.length)continue;
    var walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    var node,textNodes=[];
    while(node=walker.nextNode()){textNodes.push(node)}
    var wrappedCount=0;
    var wc=/[a-zA-Z0-9_]/;
    for(var tn=0;tn<textNodes.length;tn++){
      node=textNodes[tn];
      if(!node||!node.parentNode)continue;
      // Skip text inside <a> elements (e.g. our [← Back](command:...) link
      // or any markdown link). Wrapping them as ir-type-link would let the
      // capture-phase click handler intercept and treat the label as a
      // type-name click instead of following the command: URI.
      var nAnc=node.parentNode,inAnchor=false;
      while(nAnc&&nAnc!==block){
        if(nAnc.nodeName==='A'||(nAnc.classList&&nAnc.classList.contains('ir-type-link'))){inAnchor=true;break}
        nAnc=nAnc.parentNode;
      }
      if(inAnchor)continue;
      var nv=node.nodeValue||'';
      var matches=[];
      for(var k=0;k<types.length;k++){
        var typeName=types[k];
        if(!typeName)continue;
        var searchFrom=0;
        while(searchFrom<nv.length){
          var idx=nv.indexOf(typeName,searchFrom);
          if(idx<0)break;
          var before=idx>0?nv[idx-1]:'';
          var afterC=nv[idx+typeName.length]||'';
          if(!afterC&&node.nextSibling){var ns=node.nextSibling.textContent||'';afterC=ns[0]||''}
          if(!before&&node.previousSibling){var ps=node.previousSibling.textContent||'';before=ps[ps.length-1]||''}
          if(!wc.test(before)&&!wc.test(afterC)){matches.push({type:typeName,idx:idx})}
          searchFrom=idx+Math.max(1,typeName.length);
        }
      }
      if(!matches.length)continue;
      matches.sort(function(a,b){return a.idx-b.idx||b.type.length-a.type.length});
      var filtered=[],claimedUntil=-1;
      for(var mi=0;mi<matches.length;mi++){
        var mt=matches[mi];
        var mtEnd=mt.idx+mt.type.length;
        if(mt.idx<claimedUntil)continue;
        filtered.push(mt);
        claimedUntil=mtEnd;
      }
      for(var r2=filtered.length-1;r2>=0;r2--){
        var rep=filtered[r2];
        try{
          if(!node.parentNode||rep.idx>node.nodeValue.length)continue;
          var after=node.splitText(rep.idx);
          var rest=after.splitText(rep.type.length);
          var parent=after.parentNode;
          if(!parent)continue;
          var span=document.createElement('span');
          span.className='ir-type-link';
          span.setAttribute('data-type',rep.type);
          parent.insertBefore(span,after);
          span.appendChild(after);
          wrappedCount++;
        }catch(e2){irLog('renderer: wrap error "'+rep.type+'": '+e2.message)}
      }
    }
    if(wrappedCount>0){
      irMarkHoverManaged(hoverHost,true);
      irMakeHoverScrollable(hoverHost, false, text.length);
    }
    if(window.__irWrapLogCount<20&&(wrappedCount>0||types.length>0)){
      window.__irWrapLogCount++;
      irLog('renderer: wrap text='+text.length+' types='+types.length+' wrapped='+wrappedCount+' sample='+types.slice(0,10).join(','));
    }
    if(text.length>4000) irMakeHoverScrollable(hoverHost, false, text.length);
  }
}

function irScheduleScan(){
  if(window.__irScanTimer)return;
  window.__irScanTimer=irSetTimer(function(){
    window.__irScanTimer=null;
    try{irScanRenderedMarkdown()}catch(eScan){irLog('renderer: scan err '+(eScan&&eScan.message))}
  },50);
}

window.__irMarkdownObserver=irTrackObserver(new MutationObserver(function(muts){
  irPruneDetachedHoverState();
  for(var mi=0;mi<muts.length;mi++){
    var mut=muts[mi];
    var target=mut.target;
    var targetEl=target&&(target.nodeType===1?target:target.parentElement);
    if(targetEl&&targetEl.closest&&targetEl.closest('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip')){
      irScheduleScan();
      return;
    }
    var nodes=mut.addedNodes||[];
    for(var ni=0;ni<nodes.length;ni++){
      var n=nodes[ni];
      if(!n||n.nodeType!==1)continue;
      if((n.matches&&n.matches('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip'))||
         (n.querySelector&&n.querySelector('.rendered-markdown'))){
        irScheduleScan();
        return;
      }
    }
  }
}));
window.__irMarkdownObserver.observe(document.body,{childList:true,subtree:true});
irScheduleScan();

irLog('renderer: MutationObserver scan installed');

// ── Native hover anatomy probe ─────────────────────────────────────
// Auto-snapshot any newly-appeared .monaco-hover so we can see the
// exact DOM/class structure VS Code uses. Helps us understand what
// to replicate. Fires once per hover (deduped via Set).
function irDumpNode(el, depth, max){
  if (!el || depth > max) return [];
  var lines = [];
  var indent = '  '.repeat(depth);
  var cls = (el.className || '').toString();
  var attrs = [];
  if (el.id) attrs.push('id='+el.id);
  for (var ai = 0; ai < (el.attributes||{}).length; ai++) {
    var a = el.attributes[ai];
    if (a.name === 'class' || a.name === 'id') continue;
    if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'style') {
      attrs.push(a.name+'='+(a.value||'').slice(0,40));
    }
  }
  var txt = '';
  if (el.children.length === 0) {
    txt = (el.textContent || '').slice(0,40).replace(/\\n/g,'\\\\n');
    if (txt) txt = ' "'+txt+'"';
  }
  lines.push(indent + el.tagName + (cls?'.'+cls.split(/\\s+/).join('.'):'') + (attrs.length?' ['+attrs.join(' ')+']':'') + txt);
  for (var i = 0; i < el.children.length && i < 30; i++) {
    var sub = irDumpNode(el.children[i], depth + 1, max);
    for (var s = 0; s < sub.length; s++) lines.push(sub[s]);
  }
  if (el.children.length > 30) lines.push(indent + '  ... +' + (el.children.length - 30) + ' more children');
  return lines;
}

window.__irSnapshotHover = function(hoverEl){
  if (!hoverEl) {
    // Find first visible .monaco-hover
    var all = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null) { hoverEl = all[i]; break; }
    }
  }
  if (!hoverEl) return 'no-hover';

  var lines = ['── hover anatomy ──'];

  // Full DOM tree (4 levels deep)
  lines.push('DOM:');
  var tree = irDumpNode(hoverEl, 0, 6);
  for (var t = 0; t < tree.length && t < 60; t++) lines.push(tree[t]);

  // Find code blocks specifically and dump their inner HTML
  var codeBlocks = hoverEl.querySelectorAll('pre, .monaco-tokenized-source');
  lines.push('CODE BLOCKS: '+codeBlocks.length);
  for (var c = 0; c < Math.min(codeBlocks.length, 3); c++) {
    var cb = codeBlocks[c];
    var html = (cb.outerHTML || '').slice(0, 600);
    lines.push('  ['+c+'] '+html);
  }

  // Collect all distinct mtk classes inside hover
  var mtkSet = {};
  var mtkSpans = hoverEl.querySelectorAll('[class*="mtk"]');
  for (var m = 0; m < mtkSpans.length; m++) {
    var c2 = mtkSpans[m].className.toString();
    var matches = c2.match(/mtk\\d+/g);
    if (matches) for (var mm = 0; mm < matches.length; mm++) mtkSet[matches[mm]] = true;
  }
  lines.push('mtk classes used: '+Object.keys(mtkSet).join(','));

  // For each unique mtk, look up its CSS color
  var colorInfo = [];
  for (var mc in mtkSet) {
    var probe = document.createElement('span');
    probe.className = mc;
    probe.style.position = 'fixed';
    probe.style.top = '-9999px';
    document.body.appendChild(probe);
    try {
      var cs = window.getComputedStyle(probe);
      colorInfo.push(mc+':'+cs.color);
    } catch(_) {}
    try { document.body.removeChild(probe); } catch(_) {}
  }
  lines.push('mtk colors: '+colorInfo.join(' | '));

  // Sample tokens with their text + class
  var sample = [];
  for (var s2 = 0; s2 < Math.min(mtkSpans.length, 12); s2++) {
    var sp = mtkSpans[s2];
    sample.push('"'+(sp.textContent||'').slice(0,15).replace(/\\n/g,'·')+'":'+(sp.className||''));
  }
  lines.push('token samples: '+sample.join(' / '));

  return lines.join('\\n');
};

// Auto-snapshot first visible hover via MutationObserver. VS Code
// creates the hover container first then populates content async — so
// we observe the container itself for content additions, and snapshot
// only once meaningful content (.rendered-markdown with children) is
// present. Limited to first 3 successful snapshots. Disabled by default:
// the observer is diagnostic-only and can be noisy on mutation-heavy windows.
if(window.__irEnableHoverDiagnostics){
(function(){
  var snapshotted = new WeakSet();
  var snapshotCount = 0;
  var watching = new WeakSet();
  function isPopulated(el){
    if (!el) return false;
    if (el.classList.contains('hidden')) return false;
    // Require a code block (PRE, or .codeBlock, or .markdown-tokenized-source)
    // so we capture only structurally interesting hovers — those with
    // tokenized content. Ignore plain-text-only hovers.
    var hasCode = !!el.querySelector('pre, .codeBlock, .markdown-tokenized-source');
    return hasCode;
  }
  function trySnapshot(el){
    if (snapshotted.has(el) || snapshotCount >= 3) return false;
    if (!isPopulated(el)) return false;
    snapshotted.add(el);
    snapshotCount++;
    try {
      var snap = window.__irSnapshotHover(el);
      irLog('AUTO-SNAPSHOT['+snapshotCount+']:\\n'+snap);
    } catch(eS) { irLog('snapshot err: '+(eS&&eS.message)); }
    return true;
  }
  function watchHover(el){
    if (!el || watching.has(el) || snapshotted.has(el)) return;
    if (!el.classList || !(el.classList.contains('monaco-hover') || el.classList.contains('monaco-editor-hover'))) return;
    watching.add(el);
    // Try immediately in case content already arrived.
    if (trySnapshot(el)) return;
    // Otherwise watch for content additions inside it.
    var inner = irTrackObserver(new MutationObserver(function(){
      if (trySnapshot(el)) {
        try { inner.disconnect(); } catch(_) {}
      }
    }));
    try { inner.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); } catch(_) {}
    // Safety fallback — give up after 3s
    irSetTimer(function(){
      try { inner.disconnect(); } catch(_) {}
      // One more try in case mutation observer missed it.
      if (!snapshotted.has(el)) {
        if (!trySnapshot(el)) {
          // Force a snapshot anyway if we never got populated content,
          // so we at least have the empty skeleton for diagnosis.
          if (!snapshotted.has(el) && snapshotCount < 3) {
            snapshotted.add(el);
            snapshotCount++;
            try {
              var snap = window.__irSnapshotHover(el);
              irLog('AUTO-SNAPSHOT['+snapshotCount+'] (timeout, may be empty):\\n'+snap);
            } catch(_) {}
          }
        }
      }
    }, 3000);
  }
  var outer = irTrackObserver(new MutationObserver(function(muts){
    if(snapshotCount>=3){try{outer.disconnect()}catch(_){};return;}
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        watchHover(n);
        var hovers = n.querySelectorAll && n.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        if (hovers) for (var h = 0; h < hovers.length; h++) watchHover(hovers[h]);
      }
    }
  }));
  outer.observe(document.body, { childList: true, subtree: true });
  irLog('hover-observer installed (waits for content)');
})();
}else{
  irLog('hover diagnostics disabled');
}

// Watches for tokenized hover DOM and can trigger Monaco capture. This is
// disabled by default because capture briefly hooks Map/WeakMap/Set prototypes,
// which is too expensive for normal editing sessions. Set the flag manually
// from devtools only when diagnosing renderer/tokenization internals.
if(window.__irEnableTokenCapture){
(function(){
  var reported = 0;
  var seenEl = new WeakSet();
  function dumpAncestorPrivKeys(el){
    var lines = [];
    var anc = el;
    for (var d = 0; d < 8 && anc; d++) {
      var clsName = (anc.className || '').toString().replace(/\\s+/g,'.').slice(0,40);
      var keys = [];
      try { for (var k in anc) keys.push(k); } catch(_) {}
      // Filter to private-looking enumerable keys (own + inherited)
      var priv = keys.filter(function(k){
        return (k && k.length > 0 && (k[0] === '_' || k[0] === '$')) || k === 'render' || k === 'renderer';
      });
      // Also Symbol-keyed properties
      var syms = [];
      try {
        var sk = Object.getOwnPropertySymbols(anc) || [];
        for (var si = 0; si < sk.length && si < 5; si++) syms.push(String(sk[si]));
      } catch(_) {}
      lines.push(anc.tagName + (clsName?'.'+clsName:'') + (priv.length?' priv=['+priv.slice(0,5).join(',')+']':'') + (syms.length?' sym=['+syms.join(',')+']':''));
      anc = anc.parentElement;
    }
    return lines.join(' < ');
  }
  function visit(node){
    if (reported >= 3) return;
    if (!node || node.nodeType !== 1) return;
    var direct = node.classList && node.classList.contains('monaco-tokenized-source') ? node : null;
    var found = direct || (node.querySelector && node.querySelector('.monaco-tokenized-source'));
    if (!found || seenEl.has(found)) return;
    seenEl.add(found);
    reported++;
    try {
      irLog('TOKEN-DOM['+reported+'] outer="'+(found.outerHTML||'').slice(0,200)+'"');
      irLog('TOKEN-DOM['+reported+'] anc: '+dumpAncestorPrivKeys(found));
    } catch(eD) { irLog('TOKEN-DOM dump err: '+(eD&&eD.message)); }
    // Strategy 1: try to locate renderer via DOM walk (rarely works
    // because DOM elements don\\'t carry widget refs).
    if (!window.__irMdRenderer && typeof window.__irFindMdRendererFromDom === 'function') {
      try {
        var r = window.__irFindMdRendererFromDom(found);
        if (r) irLog('TOKEN-DOM['+reported+'] mdRenderer FOUND: '+r);
      } catch(eF) { irLog('mdRenderer DOM-walk err: '+(eF&&eF.message)); }
    }
    // Strategy 2: re-enable prototype hooks only when our cached Monaco
    // singleton is missing or no longer satisfies the CodeEditorWidget
    // contract. Missing MarkdownRenderer alone is not a reason to recapture:
    // the Monaco singleton is the expensive object we want to preserve.
    var monacoErr = window.__irMonacoValidationError ? window.__irMonacoValidationError(window.__irMonaco) : 'no-validator';
    if (monacoErr && reported === 1 && !window.__irRecaptureScheduled) {
      window.__irRecaptureScheduled = true;
      irLog('monaco recatch: re-enabling hooks for next hover ('+monacoErr+')');
      try {
        if (window.__irStartCapture) window.__irStartCapture('monaco-invalid:'+monacoErr);
      } catch(eRC) { irLog('monaco recatch start err: '+(eRC&&eRC.message)); }
    }
  }
  var obs = irTrackObserver(new MutationObserver(function(muts){
    for (var i = 0; i < muts.length && reported < 3; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) visit(added[j]);
    }
    if(reported>=3){try{obs.disconnect()}catch(_){}}
  }));
  obs.observe(document.body, { childList: true, subtree: true });
  irSetTimer(function(){try{obs.disconnect()}catch(_){}},15000);
  irLog('token-observer installed');
})();
}else{
  irLog('token capture disabled');
}

// ── Monaco capture (host-driven, brief activation) ────────────────────
// Modern VS Code hides the monaco namespace and AMD loader. To get
// theme-matched syntax highlighting we capture VS Code's internal
// IInstantiationService + CodeEditorWidget constructor + IModelService
// by hooking native Map/WeakMap/Set prototypes during widget
// creation. Hooks are EXPENSIVE (every push/set in the renderer flows
// through us), so they only activate during the brief window between
// __irStartCapture() and __irStopCapture() — both driven by the host.
// Default: no hooks, no impact on normal editor operation.
window.__irStartCapture = function(reason){
  if (window.__irCaptureActive) return 'already-active';
  var existingErr = irMonacoValidationError(window.__irMonaco);
  if (!existingErr) {
    irLog('capture skipped: valid monaco singleton');
    return 'skipped-valid-monaco';
  }
  if (window.__irMonaco) {
    irDisposeMonaco('invalid-before-capture:' + existingErr);
  }
  // rendererCtors: classes whose prototype has .render — candidates for
  // VS Code's MarkdownRenderer (used by hover to tokenize/render markdown
  // via Monaco's tokenizer with full theme awareness). We exclude widget
  // signatures so we only collect non-widget renderers.
  var caps = { widgets: [], services: [], widgetCtors: [], rendererCtors: [], rendererInstances: [] };
  window.__irMonacoCaps = caps;
  window.__irCaptureActive = true;
  var capturing = true;
  var graceScheduled = false;
  if (window.__irCaptureFallbackTimer) {
    try { irClearTimer(window.__irCaptureFallbackTimer); } catch(_) {}
    window.__irCaptureFallbackTimer = null;
  }
  if (window.__irCaptureGraceTimer) {
    try { irClearTimer(window.__irCaptureGraceTimer); } catch(_) {}
    window.__irCaptureGraceTimer = null;
  }
  // After the first real CodeEditorWidget (one with a model whose URI
  // is set) flows through our hooks, schedule auto-stop after a short
  // grace period. The grace lets related services (IInstantiationService,
  // IModelService) get registered around widget construction. DI-stub
  // widgets (no model, getModel() returns null) do NOT trigger this —
  // they appear during workbench boot and aren't useful for materializing
  // real Monaco editors.
  function scheduleGraceStop(){
    if (graceScheduled) return;
    graceScheduled = true;
    window.__irCaptureGraceTimer=irSetTimer(function(){
      try {
        if (window.__irCaptureActive && window.__irCaptureSessionId === mySessionId) {
          window.__irStopCapture();
        }
      } catch(_) {}
    }, 2000);
  }
  function sniff(v){
    if(!capturing || !v || typeof v !== 'object') return;
    try {
      if (typeof v.layout==='function' && typeof v.getModel==='function' && typeof v.getDomNode==='function') {
        if (caps.widgets.length < 50) caps.widgets.push(v);
        var ctor = v.constructor;
        if (ctor && caps.widgetCtors.indexOf(ctor) < 0 && caps.widgetCtors.length < 10) caps.widgetCtors.push(ctor);
        if (!graceScheduled) {
          try {
            var m = v.getModel();
            if (m && m.uri) scheduleGraceStop();
          } catch(_) {}
        }
        return;
      }
    } catch(_) {}
    try {
      if (typeof v.createInstance==='function' && typeof v.invokeFunction==='function') {
        if (caps.services.length < 40) caps.services.push({v:v, kind:'IInstantiationService'});
        return;
      }
    } catch(_) {}
    try {
      if (typeof v.createModel==='function' && typeof v.getModel==='function' && typeof v.getModels==='function') {
        if (caps.services.length < 40) caps.services.push({v:v, kind:'IModelService'});
        return;
      }
    } catch(_) {}
    // Possible MarkdownRenderer instance — has .render method, is a
    // proper class instance (not vanilla Object), and not a widget.
    // Dedupe by constructor so we keep one per class.
    try {
      if (typeof v.render==='function' &&
          typeof v.layout!=='function' &&
          typeof v.getModel!=='function' &&
          v.constructor && v.constructor !== Object &&
          v.constructor.prototype !== Object.prototype &&
          // .render must be on the PROTOTYPE (real class), not own property
          typeof Object.getPrototypeOf(v).render === 'function' &&
          caps.rendererInstances.length < 50) {
        // Dedupe by constructor — keep one instance per class.
        var alreadyHave = false;
        for (var ri = 0; ri < caps.rendererInstances.length; ri++) {
          if (caps.rendererInstances[ri].constructor === v.constructor) { alreadyHave = true; break; }
        }
        if (!alreadyHave) caps.rendererInstances.push(v);
      }
    } catch(_) {}
  }
  var oM=Map.prototype.set, oW=WeakMap.prototype.set, oS=Set.prototype.add;
  Map.prototype.set = function(k,v){ try { sniff(v); } catch(_) {} return oM.call(this,k,v); };
  WeakMap.prototype.set = function(k,v){ try { sniff(v); } catch(_) {} return oW.call(this,k,v); };
  Set.prototype.add = function(v){ try { sniff(v); } catch(_) {} return oS.call(this,v); };
  window.__irStopCapture = function(){
    if (!capturing) return 'already-stopped';
    capturing = false;
    if (window.__irCaptureFallbackTimer) {
      try { irClearTimer(window.__irCaptureFallbackTimer); } catch(_) {}
      window.__irCaptureFallbackTimer = null;
    }
    if (window.__irCaptureGraceTimer) {
      try { irClearTimer(window.__irCaptureGraceTimer); } catch(_) {}
      window.__irCaptureGraceTimer = null;
    }
    try { Map.prototype.set = oM; } catch(_) {}
    try { WeakMap.prototype.set = oW; } catch(_) {}
    try { Set.prototype.add = oS; } catch(_) {}
    window.__irCaptureActive = false;
    if(window.__irCleanupInProgress){
      irReleaseCaptureCaps('cleanup');
      return 'stopped-cleanup';
    }
    var kinds = {};
    for (var i = 0; i < caps.services.length; i++) { kinds[caps.services[i].kind] = (kinds[caps.services[i].kind]||0)+1; }
    irLog('capture stopped: widgets='+caps.widgets.length+' ctors='+caps.widgetCtors.length+' svcs='+JSON.stringify(kinds)+' rendererCtors='+caps.rendererCtors.length+' rendererInst='+caps.rendererInstances.length);
    // DIAG: list captured renderer instances with constructor name +
    // prototype methods + own field names. Helps identify MarkdownRenderer.
    try {
      for (var ri = 0; ri < Math.min(caps.rendererInstances.length, 15); ri++) {
        var rinst = caps.rendererInstances[ri];
        var ctorName = (rinst.constructor && rinst.constructor.name) || '?';
        var protoKeys = [];
        try {
          var pn = Object.getOwnPropertyNames(Object.getPrototypeOf(rinst) || {});
          for (var pmi = 0; pmi < pn.length && protoKeys.length < 8; pmi++) {
            protoKeys.push(pn[pmi]);
          }
        } catch(_) {}
        var ownKeys = [];
        try {
          var on = Object.getOwnPropertyNames(rinst);
          for (var omi = 0; omi < on.length && ownKeys.length < 6; omi++) {
            ownKeys.push(on[omi]);
          }
        } catch(_) {}
        irLog('cand['+ri+'] ctor='+ctorName+' proto=['+protoKeys.join(',')+'] own=['+ownKeys.join(',')+']');
      }
    } catch(_) {}
    // Try each candidate: call .render() with a small markdown and see
    // which one returns an HTMLElement with .mtkN spans.
    try {
      var testMd = { value: '\\\`\\\`\\\`typescript\\nconst x: number = 1;\\n\\\`\\\`\\\`', isTrusted: true };
      for (var ri2 = 0; ri2 < caps.rendererInstances.length; ri2++) {
        var inst2 = caps.rendererInstances[ri2];
        try {
          var r = inst2.render(testMd);
          if (r && r.element instanceof HTMLElement) {
            var hasMtk = !!r.element.querySelector('[class*="mtk"]');
            irLog('cand['+ri2+'] '+(inst2.constructor && inst2.constructor.name)+' render→element ('+(r.element.tagName)+') hasMtk='+hasMtk+' html="'+(r.element.outerHTML||'').slice(0,120)+'"');
            if (hasMtk && !window.__irMdRenderer) {
              window.__irMdRenderer = inst2;
              irLog('cand['+ri2+'] ★ stored as __irMdRenderer');
            }
            try { r.dispose && r.dispose(); } catch(_) {}
          }
        } catch(eR) { /* not a renderer */ }
      }
      irLog('mdRenderer found: '+!!window.__irMdRenderer);
    } catch(_) {}
    // Aggressive deep duck-typing — walk through ALL captured graphs
    // (widgets, services, their nested fields), looking for any object
    // whose render() returns an HTMLElement with .mtkN spans. Markdown-
    // Renderer is often a private field on a higher-level widget rather
    // than itself surfaced through prototype hooks.
    if (!window.__irMdRenderer) try {
      var seenAgg = new WeakSet();
      var foundAgg = null;
      var testMd2 = { value: '\\\`\\\`\\\`typescript\\nconst x: number = 1;\\n\\\`\\\`\\\`', isTrusted: true };
      function looksLikeMd(o){
        // Field-name check is useless in minified VS Code (names are
        // munged to '_a', 'Tu' etc). So we just gate on STRUCTURE: a
        // render method with sane arity, on a real class. The actual
        // identification happens by calling render() and checking the
        // result has .element with .mtkN spans.
        if (typeof o.render !== 'function') return false;
        if (o.render.length > 3) return false;
        try {
          if (!o.constructor || o.constructor === Object) return false;
          if (o.constructor.prototype === Object.prototype) return false;
        } catch(_) { return false; }
        // Skip widgets (have layout/getModel) — we tested those already.
        if (typeof o.layout === 'function' && typeof o.getModel === 'function') return false;
        return true;
      }
      var candDiag = [];
      function tryRender(o){
        var ctorName = (o.constructor && o.constructor.name) || '?';
        var arity = o.render.length;
        var ownKeys = [];
        try { ownKeys = Object.getOwnPropertyNames(o).slice(0,5); } catch(_) {}
        var info = 'ctor='+ctorName+' arity='+arity+' own=['+ownKeys.join(',')+']';
        // MarkdownRenderer signature check via own keys (more reliable
        // than calling render — render\\'s code-block fill is async, so
        // mtkN spans appear later than our sync check).
        var hasMdSignature = false;
        try {
          for (var ki = 0; ki < ownKeys.length; ki++) {
            if (/_(defaultCodeBlockRenderer|openerService|languageService|codeBlockRenderer)/.test(ownKeys[ki]) ||
                /setDefaultCodeBlockRenderer|getMarkdown/.test(ownKeys[ki])) {
              hasMdSignature = true; break;
            }
          }
          if (!hasMdSignature) {
            var protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {});
            for (var pi = 0; pi < protoKeys.length; pi++) {
              if (/setDefaultCodeBlockRenderer|render(Markdown|CodeBlock)/.test(protoKeys[pi])) {
                hasMdSignature = true; break;
              }
            }
          }
        } catch(_) {}
        try {
          var r = o.render(testMd2);
          if (r === null || r === undefined) {
            info += ' → '+typeof r;
          } else if (r instanceof HTMLElement) {
            info += ' → HTMLElement('+r.tagName+') hasMtk='+(!!r.querySelector('[class*="mtk"]'));
            if (candDiag.length < 8) candDiag.push(info+(hasMdSignature?' [MD-SIG]':''));
            try { r.dispose && r.dispose(); } catch(_) {}
            return !!r.querySelector('[class*="mtk"]');
          } else if (typeof r === 'object') {
            var rkeys = [];
            try { rkeys = Object.getOwnPropertyNames(r).slice(0,5); } catch(_) {}
            info += ' → obj keys=['+rkeys.join(',')+']';
            if (r.element instanceof HTMLElement) {
              var hasMtk = !!r.element.querySelector('[class*="mtk"]');
              info += ' .element('+r.element.tagName+') hasMtk='+hasMtk;
              if (candDiag.length < 8) candDiag.push(info+(hasMdSignature?' [MD-SIG]':''));
              try { r.dispose && r.dispose(); } catch(_) {}
              // Accept based on SHAPE + signature, not just immediate
              // mtkN. MarkdownRenderer.render returns sync but populates
              // code blocks via async codeBlockRenderer callback. mtkN
              // spans appear AFTER our sync check.
              if (hasMdSignature && typeof r.dispose === 'function' && r.element instanceof HTMLElement) {
                return true;
              }
              return hasMtk;
            }
          } else {
            info += ' → '+typeof r;
          }
          if (candDiag.length < 8) candDiag.push(info+(hasMdSignature?' [MD-SIG]':''));
        } catch(eR) {
          info += ' → THREW: '+(eR&&eR.message?eR.message.slice(0,60):String(eR).slice(0,60));
          if (candDiag.length < 8) candDiag.push(info+(hasMdSignature?' [MD-SIG]':''));
        }
        return false;
      }
      var visited = 0, candidates = 0, tested = 0, mapsWalked = 0;
      var triedCtors = new WeakSet(); // dedup tryRender by class
      function walkAgg(o, path, depth){
        if (foundAgg || depth > 7 || visited > 200000) return;
        if (!o) return;
        var t = typeof o;
        if (t !== 'object' && t !== 'function') return;
        try { if (seenAgg.has(o)) return; seenAgg.add(o); } catch(_) { return; }
        visited++;
        if (t === 'object') {
          try {
            if (looksLikeMd(o)) {
              candidates++;
              var ctor = o.constructor;
              if (ctor && !triedCtors.has(ctor)) {
                try { triedCtors.add(ctor); } catch(_) {}
                if (tryRender(o)) {
                  foundAgg = { obj: o, path: path, ctor: (ctor.name || '?') };
                  return;
                }
                tested++;
              }
            }
          } catch(_) {}
        }
        // VS Code stores DI services in Maps. Walk Map.values()/Set
        // entries so we don\\'t miss MarkdownRenderer instances stashed
        // in service collections.
        if (o instanceof Map) {
          mapsWalked++;
          try {
            var ent = o.values();
            var n = 0;
            while (n < 500) {
              var nx = ent.next();
              if (nx.done) break;
              walkAgg(nx.value, path+'.<map>', depth+1);
              if (foundAgg) return;
              n++;
            }
          } catch(_) {}
        } else if (o instanceof Set) {
          try {
            var sIter = o.values();
            var sn = 0;
            while (sn < 500) {
              var snx = sIter.next();
              if (snx.done) break;
              walkAgg(snx.value, path+'.<set>', depth+1);
              if (foundAgg) return;
              sn++;
            }
          } catch(_) {}
        }
        var keys;
        try { keys = Object.getOwnPropertyNames(o); } catch(_) { return; }
        for (var ki = 0; ki < keys.length; ki++) {
          var kk = keys[ki];
          if (t === 'function' && (kk === 'caller' || kk === 'arguments' || kk === 'callee' || kk === 'prototype')) continue;
          if (kk === '_textModel' || kk === '_buffer' || kk === '_lines') continue;
          var vv;
          try { vv = o[kk]; } catch(_) { continue; }
          walkAgg(vv, path+'.'+kk, depth+1);
          if (foundAgg) return;
        }
      }
      // Seed from all our capture buckets
      walkAgg(caps.widgets, 'caps.widgets', 0);
      if (!foundAgg) walkAgg(caps.services, 'caps.services', 0);
      if (!foundAgg) walkAgg(caps.rendererInstances, 'caps.rendererInstances', 0);
      if (!foundAgg) walkAgg(caps.widgetCtors, 'caps.widgetCtors', 0);
      if (!foundAgg) walkAgg(caps.rendererCtors, 'caps.rendererCtors', 0);
      irLog('mdRenderer agg: visited='+visited+' maps='+mapsWalked+' candidates='+candidates+' tested='+tested+' found='+(!!foundAgg));
      for (var di = 0; di < candDiag.length; di++) irLog('mdRenderer cand['+di+']: '+candDiag[di]);
      if (foundAgg) {
        window.__irMdRenderer = foundAgg.obj;
        irLog('mdRenderer agg ★ '+foundAgg.path+' ctor='+foundAgg.ctor);
      }
    } catch(eA) { irLog('mdRenderer agg err: '+(eA&&eA.message)); }
    // Deep scan ALL captures (services + widgets + their object graphs)
    // for any function whose .toString() contains 'monaco-tokenized-source'.
    // This is the actual VS Code tokenizer entry point — finding it lets
    // us call it directly with our own (text, lang) instead of trying to
    // re-render via a DI-wrapped MarkdownRenderer.
    try {
      var seen = new WeakSet();
      var hits = [];
      function scanFn(obj, path, depth){
        if (depth > 6 || hits.length >= 5) return;
        if (!obj) return;
        var t = typeof obj;
        if (t !== 'object' && t !== 'function') return;
        try { if (seen.has(obj)) return; seen.add(obj); } catch(_) { return; }
        if (t === 'function') {
          var src;
          try { src = Function.prototype.toString.call(obj); } catch(_) { src = ''; }
          if (src.indexOf('monaco-tokenized-source') >= 0) {
            hits.push({ path: path, len: src.length, head: src.slice(0,180) });
            return;
          }
          // Also walk function's own props (e.g. static methods)
        }
        var keys;
        try { keys = Object.getOwnPropertyNames(obj); } catch(_) { return; }
        for (var ki = 0; ki < keys.length; ki++) {
          var k = keys[ki];
          // Skip noisy native props on functions
          if (t === 'function' && (k === 'caller' || k === 'arguments' || k === 'callee')) continue;
          var v;
          try { v = obj[k]; } catch(_) { continue; }
          scanFn(v, path + '.' + k, depth + 1);
          if (hits.length >= 5) return;
        }
      }
      try { scanFn(caps, 'caps', 0); } catch(_) {}
      try { if (window.__irMonaco) scanFn(window.__irMonaco, '__irMonaco', 0); } catch(_) {}
      if (hits.length) {
        for (var hi = 0; hi < hits.length; hi++) {
          irLog('TOKEN-FN['+hi+'] '+hits[hi].path+' len='+hits[hi].len+' head="'+hits[hi].head.replace(/\\n/g,' ').slice(0,160)+'"');
        }
        // Stash the first match for direct use by drill-down.
        try {
          var firstPath = hits[0].path.split('.');
          var node = firstPath[0]==='caps'?caps:window.__irMonaco;
          for (var pi = 1; pi < firstPath.length; pi++) node = node[firstPath[pi]];
          if (typeof node === 'function') window.__irTokenizeToString = node;
        } catch(eS) {}
      } else {
        irLog('TOKEN-FN: none found in capture graph');
      }
    } catch(eF) { irLog('TOKEN-FN scan err: '+(eF&&eF.message)); }
    try {
      var mz = window.__irMaterializeMonaco ? window.__irMaterializeMonaco() : 'no-fn';
      irLog('materialize: '+mz);
      irReleaseCaptureCaps('after-materialize:'+mz);
    } catch(eMz) { irLog('materialize threw: '+(eMz&&eMz.message)); }
    window.__irRecaptureScheduled = false;
    return 'stopped';
  };
  // Per-session ID so a stale timer from a previous capture session
  // can\\'t fire and kill our brand-new session. Each start increments
  // the global counter, and the auto-stop timer only fires if the
  // current session ID still matches.
  if (typeof window.__irCaptureSessionId !== 'number') window.__irCaptureSessionId = 0;
  window.__irCaptureSessionId++;
  var mySessionId = window.__irCaptureSessionId;
  window.__irCaptureFallbackTimer=irSetTimer(function(){
    try {
      if (window.__irCaptureActive && window.__irCaptureSessionId === mySessionId) {
        window.__irStopCapture();
      }
    } catch(_) {}
  }, 8000);
  irLog('capture started ('+reason+', fallback 8s, auto-stops 2s after first real widget)');
  return 'started';
};

// Aggressive recursive search for a value matching predicate inside
// obj's own properties + Map entries. Bounded by depth and a visited
// set to avoid cycles. Returns first match. Used to mine private
// fields like _modelService that aren't on captured widgets directly
// but live deeper in IInstantiationService's ServiceCollection.
function irDeepFind(obj, depth, visited, predicate){
  if (depth < 0 || !obj || typeof obj !== 'object') return null;
  if (visited.has(obj)) return null;
  visited.add(obj);
  try {
    if (predicate(obj)) return obj;
  } catch(_) {}
  if (obj instanceof Map) {
    try {
      var iter = obj.values();
      var v;
      while (!(v = iter.next()).done) {
        var hit = irDeepFind(v.value, depth - 1, visited, predicate);
        if (hit) return hit;
      }
    } catch(_) {}
  }
  var keys;
  try { keys = Object.getOwnPropertyNames(obj); } catch(_) { return null; }
  for (var i = 0; i < keys.length; i++) {
    var v2;
    try { v2 = obj[keys[i]]; } catch(_) { continue; }
    var hit2 = irDeepFind(v2, depth - 1, visited, predicate);
    if (hit2) return hit2;
  }
  return null;
}

function irIsModelSvc(v){
  return v && typeof v === 'object' &&
    typeof v.createModel === 'function' &&
    typeof v.getModel === 'function' &&
    typeof v.getModels === 'function';
}
function irIsCodeEditorSvc(v){
  return v && typeof v === 'object' &&
    typeof v.addCodeEditor === 'function' &&
    typeof v.listCodeEditors === 'function';
}

function irEditorRegistryValidationError(ed){
  if (!ed || typeof ed !== 'object') return 'not-object';
  var required = [
    'getModel',
    'setModel',
    'hasModel',
    'hasWidgetFocus',
    'onDidChangeModel',
    'onDidChangeModelLanguage',
    'onDidChangeModelContent',
    'removeDecorationsByType',
    'layout',
    'getDomNode',
    'dispose',
  ];
  var missing = [];
  for (var i = 0; i < required.length; i++) {
    if (typeof ed[required[i]] !== 'function') missing.push(required[i]);
  }
  if (missing.length) return 'missing:' + missing.join(',');
  try {
    var dom = ed.getDomNode();
    if (!dom || !(dom instanceof HTMLElement)) return 'bad-dom';
  } catch(eDom) {
    return 'bad-dom:' + (eDom && eDom.message ? eDom.message : eDom);
  }
  try {
    ed.hasModel();
  } catch(eHasModel) {
    return 'hasModel-throws:' + (eHasModel && eHasModel.message ? eHasModel.message : eHasModel);
  }
  try {
    ed.hasWidgetFocus();
  } catch(eFocus) {
    return 'hasWidgetFocus-throws:' + (eFocus && eFocus.message ? eFocus.message : eFocus);
  }
  return '';
}

function irMonacoValidationError(m){
  if (!m || typeof m !== 'object') return 'missing';
  if (!m.editor || typeof m.editor !== 'object') return 'missing-editor';
  var edErr = irEditorRegistryValidationError(m.editor);
  if (edErr) return 'editor:' + edErr;
  if (!m.host || !(m.host instanceof HTMLElement)) return 'missing-host';
  try {
    if (!document.documentElement.contains(m.host)) return 'host-detached';
  } catch(eHost) {
    return 'host-check-throws:' + (eHost && eHost.message ? eHost.message : eHost);
  }
  if (!irIsModelSvc(m.modelSvc)) return 'missing-modelSvc';
  if (m.registeredInCodeEditorSvc) {
    if (!m.editorRegistration || typeof m.editorRegistration.dispose !== 'function') {
      return 'missing-editor-registration';
    }
    if (!irIsCodeEditorSvc(m.codeEditorSvc)) return 'missing-codeEditorSvc';
  }
  if (m.uriCtor && typeof m.uriCtor.parse !== 'function') return 'bad-uriCtor';
  return '';
}
window.__irMonacoValidationError = irMonacoValidationError;

function irReleaseCaptureCaps(reason){
  try{
    var caps=window.__irMonacoCaps;
    if(!caps)return;
    if(caps.widgets)caps.widgets.length=0;
    if(caps.services)caps.services.length=0;
    if(caps.widgetCtors)caps.widgetCtors.length=0;
    if(caps.rendererCtors)caps.rendererCtors.length=0;
    if(caps.rendererInstances)caps.rendererInstances.length=0;
    window.__irMonacoCaps=null;
    irLog('capture caps released: '+(reason||'unknown'));
  }catch(_){}
}

function irDisposeMonaco(reason){
  var m = window.__irMonaco;
  if (!m) return 'none';
  var out = [];
  try {
    if (m.editorRegistration && typeof m.editorRegistration.dispose === 'function') {
      m.editorRegistration.dispose();
      out.push('registration=disposed');
    }
  } catch(eReg) {
    out.push('registration=err:' + (eReg && eReg.message ? eReg.message : eReg));
  }
  try {
    var ed = m.editor;
    var model = ed && typeof ed.getModel === 'function' ? ed.getModel() : null;
    if (ed && typeof ed.setModel === 'function') {
      try { ed.setModel(null); } catch(_) {}
    }
    if (model && typeof model.dispose === 'function') {
      try { model.dispose(); out.push('model=disposed'); } catch(eModel) { out.push('model=err'); }
    }
  } catch(eDetach) {
    out.push('model-detach=err:' + (eDetach && eDetach.message ? eDetach.message : eDetach));
  }
  try {
    if (m.editor && typeof m.editor.dispose === 'function') {
      m.editor.dispose();
      out.push('editor=disposed');
    }
  } catch(eEd) {
    out.push('editor=err:' + (eEd && eEd.message ? eEd.message : eEd));
  }
  try {
    if (m.host && m.host.parentNode) {
      m.host.parentNode.removeChild(m.host);
      out.push('host=removed');
    }
  } catch(eHost) {
    out.push('host=err:' + (eHost && eHost.message ? eHost.message : eHost));
  }
  window.__irMonaco = null;
  irLog('monaco disposed reason=' + (reason || 'unknown') + ' ' + out.join(' '));
  return out.join(',') || 'disposed';
}
window.__irDisposeMonaco = irDisposeMonaco;

window.__irRendererSafetyReport = function(){
  var m = window.__irMonaco;
  var validation = irMonacoValidationError(m);
  return JSON.stringify({
    patchVersion: IR_PATCH_VERSION,
    captureActive: !!window.__irCaptureActive,
    hasMonaco: !!m,
    registeredInCodeEditorSvc: !!(m && m.registeredInCodeEditorSvc),
    monacoValidation: validation || 'ok',
  });
};

function irRegisterCodeEditorSafely(codeEditorSvc, ed){
  if (!codeEditorSvc) return { ok: false, reason: 'no-codeEditorSvc', disposable: null };
  var validation = irEditorRegistryValidationError(ed);
  if (validation) return { ok: false, reason: validation, disposable: null };
  try {
    var before = [];
    try { before = codeEditorSvc.listCodeEditors() || []; } catch(_) {}
    var disposable = codeEditorSvc.addCodeEditor(ed);
    if (disposable && typeof disposable.dispose === 'function') {
      return { ok: true, reason: 'registered:disposable', disposable: disposable };
    }
    try {
      if (typeof codeEditorSvc.removeCodeEditor === 'function') {
        codeEditorSvc.removeCodeEditor(ed);
        return { ok: false, reason: 'registered-without-disposable:removed', disposable: null };
      }
    } catch(eRemove) {
      return { ok: false, reason: 'registered-without-disposable:remove-throws:' + (eRemove && eRemove.message ? eRemove.message : eRemove), disposable: null };
    }
    var after = [];
    try { after = codeEditorSvc.listCodeEditors() || []; } catch(_) {}
    return { ok: false, reason: 'registered-without-disposable:unrecoverable before=' + before.length + ' after=' + after.length, disposable: null };
  } catch(eAdd) {
    return { ok: false, reason: 'add-throws:' + (eAdd && eAdd.message ? eAdd.message : eAdd), disposable: null };
  }
}

// Materialize a hidden, off-screen Monaco CodeEditorWidget using the
// captured services. Try every (inst × ctor) pair — DI stubs throw,
// real combos succeed. IModelService fallback: walk captured widgets
// and the new widget itself for a private field matching the duck-type.
window.__irMaterializeMonaco = function(){
  if (window.__irMonaco) {
    var existingErr = irMonacoValidationError(window.__irMonaco);
    if (existingErr) {
      irDisposeMonaco('invalid-existing:' + existingErr);
    } else {
      return 'already';
    }
  }
  var caps = window.__irMonacoCaps;
  if (!caps) return 'no-caps';
  var insts = [], modelSvc = null, codeEditorSvc = null;
  for (var i = 0; i < caps.services.length; i++) {
    var s = caps.services[i];
    if (s.kind === 'IInstantiationService' && insts.indexOf(s.v) < 0) insts.push(s.v);
    if (s.kind === 'IModelService' && !modelSvc) modelSvc = s.v;
    if (s.kind === 'ICodeEditorService' && !codeEditorSvc) codeEditorSvc = s.v;
  }
  if (!insts.length || !caps.widgetCtors.length) {
    return 'missing: inst='+insts.length+' ctors='+caps.widgetCtors.length;
  }
  // Fallback 1: deep-search captured IInstantiationService instances.
  // Their internal ServiceCollection (_services) holds every DI'd
  // service including IModelService, even when our hooks missed the
  // initial Map.set call (boot-time pre-existing entries).
  if (!modelSvc) {
    for (var ix = 0; ix < insts.length && !modelSvc; ix++) {
      modelSvc = irDeepFind(insts[ix], 6, new Set(), irIsModelSvc);
    }
    if (modelSvc) irLog('modelSvc found via inst deep-find');
  }
  // Fallback 2: deep-search captured widgets (each has a private
  // _modelService injected by DI).
  if (!modelSvc) {
    for (var w = 0; w < caps.widgets.length && !modelSvc; w++) {
      modelSvc = irDeepFind(caps.widgets[w], 5, new Set(), irIsModelSvc);
    }
    if (modelSvc) irLog('modelSvc found via widget deep-find');
  }
  // Fallback 3: deep-search captured renderer instances (also DI-injected).
  if (!modelSvc) {
    for (var ri3 = 0; ri3 < caps.rendererInstances.length && !modelSvc; ri3++) {
      modelSvc = irDeepFind(caps.rendererInstances[ri3], 5, new Set(), irIsModelSvc);
    }
    if (modelSvc) irLog('modelSvc found via rendererInst deep-find');
  }
  if (!modelSvc) irLog('modelSvc deep-find: STILL not found across '+insts.length+' insts, '+caps.widgets.length+' widgets, '+caps.rendererInstances.length+' renderer insts');
  if (!codeEditorSvc) {
    for (var w2 = 0; w2 < caps.widgets.length && !codeEditorSvc; w2++) {
      codeEditorSvc = irDeepFind(caps.widgets[w2], 5, new Set(), irIsCodeEditorSvc);
    }
  }
  // Capture monaco.Uri class so tokenize can construct URIs. First try
  // captured widgets directly. If none have a model with .uri, derive
  // it later from a dummy model created via modelSvc.
  var uriCtor = null;
  for (var wu = 0; wu < caps.widgets.length && !uriCtor; wu++) {
    try {
      var mm = caps.widgets[wu].getModel && caps.widgets[wu].getModel();
      if (mm && mm.uri && mm.uri.constructor && mm.uri.constructor !== Object) {
        uriCtor = mm.uri.constructor;
      }
    } catch(_) {}
  }
  // If still no uriCtor but we have modelSvc, create a throwaway model
  // — its .uri.constructor is the Uri class.
  if (!uriCtor && modelSvc) {
    try {
      var dummy = modelSvc.createModel('', 'plaintext');
      if (dummy && dummy.uri && dummy.uri.constructor) {
        uriCtor = dummy.uri.constructor;
        irLog('uriCtor via dummy model');
      }
      try { dummy && dummy.dispose && dummy.dispose(); } catch(_) {}
    } catch(eD) { irLog('dummy model err: '+(eD&&eD.message)); }
  }
  irLog('mat services: modelSvc='+(!!modelSvc)+' uriCtor='+(!!uriCtor)+' codeEdSvc='+(!!codeEditorSvc));
  var host = document.createElement('div');
  host.className = 'ir-monaco-tokenizer-host';
  host.style.cssText = 'position:fixed;top:-99999px;left:-99999px;width:800px;height:200px;visibility:hidden;pointer-events:none;';
  document.body.appendChild(host);
  var options = {
    automaticLayout: false, readOnly: true, lineNumbers: 'off',
    glyphMargin: false, folding: false, contextmenu: false,
    minimap: { enabled: false }, scrollBeyondLastLine: false,
    wordWrap: 'off', renderLineHighlight: 'none',
    overviewRulerLanes: 0, overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
    fontSize: 12,
  };
  // isSimpleWidget=false: register the widget as a "full" editor so all
  // default contributions (including TextMate tokenization driver and
  // theme application) are wired up. With true, our tokens collapse to
  // .mtk1 because the language service never tokenizes the model.
  var widgetOpts = { isSimpleWidget: false, contributions: [] };
  for (var ii = 0; ii < insts.length; ii++) {
    for (var ci = 0; ci < caps.widgetCtors.length; ci++) {
      var ctor = caps.widgetCtors[ci];
      try {
        var ed = insts[ii].createInstance(ctor, host, options, widgetOpts);
        if (ed && typeof ed === 'object' && typeof ed.setModel === 'function' && typeof ed.layout === 'function') {
          if (!modelSvc) modelSvc = irDeepFind(ed, 3, new Set(), irIsModelSvc);
          if (!modelSvc) { try { ed.dispose && ed.dispose(); } catch(_) {} continue; }
          var editorErr = irEditorRegistryValidationError(ed);
          if (editorErr) {
            irLog('candidate editor rejected: ' + editorErr);
            try { ed.dispose && ed.dispose(); } catch(_) {}
            continue;
          }
          // Register the widget with ICodeEditorService so the workbench
          // theme service applies token colors and the language service
          // attaches grammar-driven tokenizers to its models.
          var registration = irRegisterCodeEditorSafely(codeEditorSvc, ed);
          if (registration.ok) {
            irLog('addCodeEditor safe ok: ' + registration.reason);
          } else {
            irLog('addCodeEditor skipped: ' + registration.reason);
            if (/unrecoverable/.test(registration.reason)) {
              try { ed.dispose && ed.dispose(); } catch(_) {}
              continue;
            }
          }
          window.__irMonaco = {
            editor: ed,
            host: host,
            modelSvc: modelSvc,
            inst: insts[ii],
            ctor: ctor,
            uriCtor: uriCtor,
            codeEditorSvc: codeEditorSvc,
            editorRegistration: registration.disposable || null,
            registeredInCodeEditorSvc: !!registration.ok,
          };
          return 'ok inst#'+ii+' ctor#'+ci;
        }
      } catch(_) { /* try next */ }
    }
  }
  try { document.body.removeChild(host); } catch(_) {}
  return 'all-combos-failed (modelSvc='+(!!modelSvc)+')';
};

// DIAG: walk a real (depth-1) rendered hover's DOM and report what
// kind of markdown rendering objects are accessible. We're trying to
// locate the IInstantiationService-created MarkdownRenderer instance
// that VS Code uses for hover code-block tokenization. Once found,
// drill-down can call its .render() directly instead of building DOM
// ourselves (which loses TextMate tokens).
window.__irProbeMdRenderer = function(){
  var lines = [];
  // Walk active hovers in the DOM
  var hovers = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
  lines.push('hovers='+hovers.length);
  for (var i = 0; i < Math.min(hovers.length, 3); i++) {
    var hv = hovers[i];
    var rms = hv.querySelectorAll('.rendered-markdown');
    lines.push(' hover['+i+'] rms='+rms.length);
    // Check if hover has any direct widget ref (some VS Code attaches via __widget__-like keys)
    var keys;
    try { keys = []; for (var k in hv) keys.push(k); } catch(_) { keys = ['err']; }
    lines.push('   ownEnumKeys='+keys.slice(0,10).join(','));
  }
  // Walk our materialized widget for any sub-object exposing .render
  var m = window.__irMonaco;
  if (m && m.editor) {
    var seen = new Set();
    var stack = [{ obj: m.editor, path: 'editor' }];
    var found = [];
    var depth = 0;
    while (stack.length > 0 && depth < 500) {
      var top = stack.shift(); depth++;
      if (!top.obj || typeof top.obj !== 'object' || seen.has(top.obj)) continue;
      seen.add(top.obj);
      try {
        if (typeof top.obj.render === 'function') {
          // Heuristic: must NOT be a layout-able widget (those have render too).
          var isWidget = typeof top.obj.layout === 'function' && typeof top.obj.getModel === 'function';
          if (!isWidget) {
            var ctorName = (top.obj.constructor && top.obj.constructor.name) || '?';
            found.push(top.path + ' ctor=' + ctorName);
          }
        }
      } catch(_) {}
      if (found.length >= 5) break;
      try {
        var subKeys = Object.getOwnPropertyNames(top.obj);
        for (var sk = 0; sk < Math.min(subKeys.length, 30); sk++) {
          var v;
          try { v = top.obj[subKeys[sk]]; } catch(_) { continue; }
          if (v && typeof v === 'object' && !seen.has(v)) {
            stack.push({ obj: v, path: top.path + '.' + subKeys[sk] });
          }
        }
      } catch(_) {}
    }
    lines.push('render-method holders: '+(found.length?found.join(' || '):'none'));
  } else {
    lines.push('no monaco materialized');
  }
  return lines.join('\\n');
};

// Find a tokenizationSupport with grammar actually loaded. Walks all
// open models via captured IModelService — the user's real editors
// have full TextMate / TreeSitter grammar attached, so tokenizeEncoded
// returns proper mtk classes. Verifies via a probe (tokenize a known
// mixed string and check we get >=2 distinct fg colors).
// DOM-walk fallback for MarkdownRenderer. Triggered when a native
// .monaco-tokenized-source first appears (TOKEN-DOM observer). At that
// moment the renderer JUST executed and is still reachable from the
// hover element\\'s ancestor chain — VS Code attaches widget refs via
// Symbol-keyed properties on DOM elements. Walks the DOM tree (incl.
// Symbol props), then descends through each candidate widget\\'s own
// fields + Map/Set entries until it finds an object whose render()
// returns a result containing .mtkN spans.
window.__irFindMdRendererFromDom = function(seedEl){
  if (window.__irMdRenderer) return 'already-found';
  var seen = new WeakSet();
  var triedCtors = new WeakSet();
  var found = null;
  var visited = 0;
  var testMd = { value: '\\\`\\\`\\\`typescript\\nconst x: number = 1;\\n\\\`\\\`\\\`', isTrusted: true };
  function tryRender(o){
    try {
      var r = o.render(testMd);
      if (r && r.element instanceof HTMLElement) {
        var hasMtk = !!r.element.querySelector('[class*="mtk"]');
        try { r.dispose && r.dispose(); } catch(_) {}
        return hasMtk;
      }
    } catch(_) {}
    return false;
  }
  function looksLikeMd(o){
    if (typeof o.render !== 'function') return false;
    if (o.render.length > 3) return false;
    try {
      if (!o.constructor || o.constructor === Object) return false;
      if (o.constructor.prototype === Object.prototype) return false;
    } catch(_) { return false; }
    if (typeof o.layout === 'function' && typeof o.getModel === 'function') return false;
    return true;
  }
  function walk(o, path, depth){
    if (found || depth > 8 || visited > 30000) return;
    if (!o) return;
    var t = typeof o;
    if (t !== 'object' && t !== 'function') return;
    try { if (seen.has(o)) return; seen.add(o); } catch(_) { return; }
    visited++;
    if (t === 'object') {
      try {
        if (looksLikeMd(o)) {
          var c = o.constructor;
          if (c && !triedCtors.has(c)) {
            try { triedCtors.add(c); } catch(_) {}
            if (tryRender(o)) {
              found = { obj: o, path: path, ctor: (c.name||'?') };
              return;
            }
          }
        }
      } catch(_) {}
    }
    // Map / Set entries
    if (o instanceof Map) {
      try {
        var iter = o.values(), n = 0;
        while (n < 500) {
          var nx = iter.next(); if (nx.done) break;
          walk(nx.value, path+'.<map>', depth+1); if (found) return;
          n++;
        }
      } catch(_) {}
    } else if (o instanceof Set) {
      try {
        var sIter = o.values(), sn = 0;
        while (sn < 500) {
          var snx = sIter.next(); if (snx.done) break;
          walk(snx.value, path+'.<set>', depth+1); if (found) return;
          sn++;
        }
      } catch(_) {}
    }
    // Own props (string keys)
    var keys;
    try { keys = Object.getOwnPropertyNames(o); } catch(_) { return; }
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      if (t === 'function' && (k === 'caller' || k === 'arguments' || k === 'callee' || k === 'prototype')) continue;
      if (k === '_textModel' || k === '_buffer' || k === '_lines' || k === 'children' || k === 'childNodes') continue;
      var v;
      try { v = o[k]; } catch(_) { continue; }
      walk(v, path+'.'+k, depth+1);
      if (found) return;
    }
    // Symbol-keyed props (DOM elements: VS Code attaches widget refs here)
    if (t === 'object') {
      var syms = [];
      try { syms = Object.getOwnPropertySymbols(o); } catch(_) {}
      for (var si = 0; si < syms.length; si++) {
        var v2;
        try { v2 = o[syms[si]]; } catch(_) { continue; }
        walk(v2, path+'.['+String(syms[si]).slice(0,20)+']', depth+1);
        if (found) return;
      }
    }
  }
  // Walk seed element + 12 ancestors
  var node = seedEl;
  for (var d = 0; d < 12 && node && !found; d++) {
    walk(node, 'dom['+d+']', 0);
    node = node.parentElement;
  }
  irLog('mdRenderer DOM-walk: visited='+visited+' found='+(!!found));
  if (found) {
    window.__irMdRenderer = found.obj;
    return found.path+' ctor='+found.ctor;
  }
  return null;
};

window.__irFindTokenSupport = function(langId){
  if (!window.__irTokSupports) window.__irTokSupports = {};
  if (window.__irTokSupports[langId]) return window.__irTokSupports[langId];
  var family = [langId];
  if (langId === 'typescript') family = ['typescript','typescriptreact','javascript','javascriptreact'];
  else if (langId === 'typescriptreact') family = ['typescriptreact','typescript','javascriptreact','javascript'];
  else if (langId === 'javascript') family = ['javascript','javascriptreact','typescript','typescriptreact'];
  else if (langId === 'javascriptreact') family = ['javascriptreact','javascript','typescriptreact','typescript'];
  var caps = window.__irMonacoCaps || window.__irCaptures || {};
  // Probe: tokenize a known mixed-content string. If it produces only
  // one foreground color, the grammar isn't loaded for that model.
  function probe(sup){
    try {
      var st = sup.getInitialState();
      var r = sup.tokenizeEncoded('const x: number = 1', false, st);
      if (!r || !r.tokens || r.tokens.length < 4) return false;
      var fgs = {};
      for (var ti = 0; ti < r.tokens.length; ti += 2) {
        fgs[(r.tokens[ti+1] >>> 15) & 0x1FF] = true;
      }
      return Object.keys(fgs).length >= 2;
    } catch(_) { return false; }
  }
  // Collect all open models via IModelService.getModels(). Sometimes
  // capture misses IModelService directly but materialize finds it via
  // deep-find through IInstantiationService — try both sources.
  var modelSvcs = [];
  if (caps.services) {
    for (var si = 0; si < caps.services.length; si++) {
      var svc = caps.services[si];
      if (svc.kind === 'IModelService' && svc.v && typeof svc.v.getModels === 'function') {
        modelSvcs.push(svc.v);
      }
    }
  }
  // Fallback: modelSvc captured during materialization (may have been
  // deep-found through IInstantiationService when not surfaced in caps).
  if (window.__irMonaco && window.__irMonaco.modelSvc && typeof window.__irMonaco.modelSvc.getModels === 'function') {
    if (modelSvcs.indexOf(window.__irMonaco.modelSvc) < 0) modelSvcs.push(window.__irMonaco.modelSvc);
  }
  var allModels = [];
  var seenModel = new Set();
  for (var msi = 0; msi < modelSvcs.length; msi++) {
    try {
      var ml = modelSvcs[msi].getModels();
      if (ml && ml.length) {
        for (var mi = 0; mi < ml.length; mi++) {
          if (!seenModel.has(ml[mi])) { seenModel.add(ml[mi]); allModels.push(ml[mi]); }
        }
      }
    } catch(_) {}
  }
  // Diagnostic: how many models per language
  var langCounts = {};
  for (var ci = 0; ci < allModels.length; ci++) {
    try {
      var l = typeof allModels[ci].getLanguageId === 'function' ? allModels[ci].getLanguageId() : '?';
      langCounts[l] = (langCounts[l] || 0) + 1;
    } catch(_) {}
  }
  irLog('tokSupport: scan models='+allModels.length+' langs='+JSON.stringify(langCounts));
  // Scan in family priority order
  for (var fi = 0; fi < family.length; fi++) {
    var target = family[fi];
    for (var mi2 = 0; mi2 < allModels.length; mi2++) {
      try {
        var mdl = allModels[mi2];
        if (typeof mdl.getLanguageId !== 'function') continue;
        if (mdl.getLanguageId() !== target) continue;
        var tk = mdl.tokenization;
        if (!tk || !tk.tokens || !tk.tokens._value || !tk.tokens._value._tokenizer) continue;
        var sup = tk.tokens._value._tokenizer.tokenizationSupport;
        if (!sup || typeof sup.tokenizeEncoded !== 'function') continue;
        if (!probe(sup)) continue;
        var uriStr = mdl.uri ? ((mdl.uri.scheme||'?')+':'+(mdl.uri.path||'?').slice(-30)) : '?';
        irLog('tokSupport: '+langId+' → ok via lang='+target+' uri='+uriStr);
        window.__irTokSupports[langId] = sup;
        return sup;
      } catch(_) {}
    }
  }
  irLog('tokSupport: no working support for '+langId+' (tried family '+family.join(',')+')');
  return null;
};

// Tokenize text using a captured grammar-loaded tokenizationSupport.
// Returns a DocumentFragment of <span class="mtkN">…</span> nodes
// (matching VS Code's native rendering exactly), or null on failure.
window.__irTokenizeToFragment = function(text, lang){
  var langId = (lang || 'plaintext').toLowerCase();
  var aliases = { ts:'typescript', js:'javascript', py:'python', tsx:'typescriptreact', jsx:'javascriptreact', sh:'shellscript', md:'markdown', yml:'yaml' };
  if (aliases[langId]) langId = aliases[langId];
  var support = window.__irFindTokenSupport(langId);
  if (!support) { irLog('tokFrag: no support for '+langId); return null; }
  var lines = (text || '').split('\\n');
  var state;
  try { state = support.getInitialState(); }
  catch(e) { irLog('tokFrag: getInitialState err: '+(e&&e.message)); return null; }
  var frag = document.createDocumentFragment();
  var fgCounts = {};
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var hasEOL = li < lines.length - 1;
    var result;
    try { result = support.tokenizeEncoded(line, hasEOL, state); }
    catch(e2) { irLog('tokFrag: tokenizeEncoded err: '+(e2&&e2.message)); return null; }
    state = result.endState;
    var tokens = result.tokens;
    if (!tokens || !tokens.length) {
      if (li < lines.length - 1) frag.appendChild(document.createTextNode('\\n'));
      continue;
    }
    var pos = 0;
    for (var t = 0; t < tokens.length; t += 2) {
      var endIdx = tokens[t];
      var meta = tokens[t + 1];
      // Bit layout (encodedTokenAttributes.ts):
      //   FOREGROUND_OFFSET = 15, mask 9 bits → 0x1FF
      //   ITALIC_MASK    = 0x00000800
      //   BOLD_MASK      = 0x00001000
      //   UNDERLINE_MASK = 0x00002000
      var fg = (meta >>> 15) & 0x1FF;
      var italic    = (meta & 0x0800) !== 0;
      var bold      = (meta & 0x1000) !== 0;
      var underline = (meta & 0x2000) !== 0;
      fgCounts[fg] = (fgCounts[fg] || 0) + 1;
      var part = line.substring(pos, endIdx);
      pos = endIdx;
      var cls = 'mtk' + fg;
      if (italic) cls += ' mtki';
      if (bold) cls += ' mtkb';
      if (underline) cls += ' mtku';
      var span = document.createElement('span');
      span.className = cls;
      span.textContent = part;
      frag.appendChild(span);
    }
    if (li < lines.length - 1) frag.appendChild(document.createTextNode('\\n'));
  }
  irLog('tokFrag: '+langId+' lines='+lines.length+' fgs='+JSON.stringify(fgCounts));
  return frag;
};

window.__irProbeMtk = function(){
  var hits = [];
  try {
    for (var s = 0; s < document.styleSheets.length; s++) {
      var rules;
      try { rules = document.styleSheets[s].cssRules; } catch(_) { continue; }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule.selectorText) continue;
        if (/\\.mtk[0-9]/.test(rule.selectorText)) {
          hits.push(rule.selectorText.slice(0,80) + ' { ' + (rule.style.cssText || '').slice(0,60) + ' }');
          if (hits.length >= 8) break;
        }
      }
      if (hits.length >= 8) break;
    }
  } catch(eP) { return 'probe err: '+(eP&&eP.message); }
  return hits.length ? hits.join(' || ') : 'no .mtkN rules found';
};

// Tokenize a single code block via our BUNDLED monaco's colorize API.
// Returns an HTMLElement (a span containing .mtkN children) ready to
// append into a code element, or null on failure. Asynchronous —
// monaco.editor.colorize returns a Promise; caller stuffs a placeholder
// and replaces it on resolve.
window.__irTokenizeCodeAsync = function(text, lang){
  if (!globalThis.__irMonacoApi || !globalThis.__irMonacoApi.editor || typeof globalThis.__irMonacoApi.editor.colorize !== 'function') {
    return null;
  }
  if (!text || typeof text !== 'string') return null;
  var langId = (lang || 'plaintext').toLowerCase();
  var aliases = { ts:'typescript', js:'javascript', py:'python', tsx:'typescriptreact', jsx:'javascriptreact', sh:'shellscript', md:'markdown', yml:'yaml' };
  if (aliases[langId]) langId = aliases[langId];
  try {
    return globalThis.__irMonacoApi.editor.colorize(text, langId, { tabSize: 2 });
  } catch(e) {
    irLog('colorize threw: '+(e&&e.message?e.message:String(e)));
    return null;
  }
};

// Legacy sync API (kept for compat — falls through when monaco bundle
// is loaded since colorize is async, this returns null).
window.__irTokenizeCode = function(text, lang){
  var m = window.__irMonaco;
  if (!m) { irLog('tokenize: no monaco'); return null; }
  if (!text || typeof text !== 'string') { irLog('tokenize: bad text'); return null; }
  try {
    var langId = (lang || 'plaintext').toLowerCase();
    var aliases = { ts:'typescript', js:'javascript', py:'python', tsx:'typescriptreact', jsx:'javascriptreact', sh:'shellscript', md:'markdown', yml:'yaml' };
    if (aliases[langId]) langId = aliases[langId];
    var lineCount = (text.match(/\\n/g) || []).length + 1;
    var height = Math.max(40, Math.min(20000, lineCount * 18 + 20));
    m.host.style.height = height + 'px';
    var prev = m.editor.getModel && m.editor.getModel();
    // Build a synthetic URI so the workbench picks the right grammar
    // (TextMate tokenizers are dispatched by file extension). Without
    // a URI, createModel produces a model with only the basic Monaco
    // language tokenizer — which collapses all tokens into .mtk1.
    var extByLang = {
      typescript: 'ts', typescriptreact: 'tsx', javascript: 'js', javascriptreact: 'jsx',
      python: 'py', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift',
      cpp: 'cpp', c: 'c', csharp: 'cs', ruby: 'rb', php: 'php', dart: 'dart',
      shellscript: 'sh', json: 'json', yaml: 'yaml', markdown: 'md', html: 'html', css: 'css',
    };
    var ext = extByLang[langId] || 'txt';
    var uri = null;
    if (m.uriCtor) {
      try {
        // Use file:// scheme — the workbench's TextMate/TreeSitter
        // tokenizers only attach to file-scheme models. inmemory://
        // models render text but never get a grammar tokenizer, so
        // every token collapses to .mtk1.
        // untitled: scheme = virtual buffer, won't be scanned by workspace
        // tools (stylelint etc). Was using file:///tmp/ir-tokenize/ which
        // stylelint picked up as a real folder and crashed its worker.
        uri = m.uriCtor.parse('untitled:ir-tokenize-'+Date.now()+'-'+Math.random().toString(36).slice(2,6)+'.'+ext);
      } catch(_) {}
    }
    var model;
    try { model = uri ? m.modelSvc.createModel(text, langId, uri) : m.modelSvc.createModel(text, langId); }
    catch(eL) {
      irLog('tokenize: createModel("'+langId+'") err: '+(eL&&eL.message));
      try { model = m.modelSvc.createModel(text, 'plaintext'); }
      catch(eM) { irLog('tokenize: createModel(plaintext) err: '+(eM&&eM.message)); return null; }
    }
    m.editor.setModel(model);
    m.editor.layout({ width: 800, height: height });
    if (prev && prev !== model) { try { prev.dispose && prev.dispose(); } catch(_) {} }
    try {
      var tk = model.tokenization;
      // Newer VS Code (TreeSitter-based): forceTokenization is gone,
      // tokenization lives on tk.tokens. Try tokens-based API first.
      var inner = tk && tk.tokens;
      if (inner) {
        var lc = model.getLineCount();
        for (var li = 1; li <= lc; li++) {
          try { if (typeof inner.forceTokenization === 'function') inner.forceTokenization(li); } catch(_) {}
          try { if (typeof inner.tokenizeIfCheap === 'function') inner.tokenizeIfCheap(li); } catch(_) {}
        }
        if (typeof inner.tokenizeViewport === 'function') {
          try { inner.tokenizeViewport(1, lc); } catch(_) {}
        }
        // tk.tokens is an Observable. Try Observable.get() to read its
        // current value — might be the actual TokenInfo[] / TextMate
        // result that VS Code uses for native hover tokenization.
        try {
          if (typeof inner.get === 'function') {
            var obsVal = inner.get();
            var t = typeof obsVal;
            var info = 't='+t;
            if (obsVal && t === 'object') {
              var pn = Object.getOwnPropertyNames(obsVal).slice(0,8);
              info += ' keys=['+pn.join(',')+']';
              if (Array.isArray(obsVal)) info += ' arrLen='+obsVal.length+' first='+JSON.stringify(obsVal[0]).slice(0,80);
              else if (typeof obsVal.getCount === 'function') info += ' tokenCount='+obsVal.getCount();
              else if (typeof obsVal.getLineTokens === 'function') {
                try { var lts = obsVal.getLineTokens(1); info += ' line1Tokens='+(lts&&lts.getCount?lts.getCount():'?'); } catch(_) {}
              }
            }
            irLog('tokenize obs.get(): '+info);
          }
        } catch(eO) { irLog('tokenize obs.get err: '+(eO&&eO.message)); }
      }
      // DIAG: walk tk recursively (depth 4) looking for a property
      // called tokenizationSupport / _tokenizationSupport / a function
      // called tokenize / tokenizeEncoded. This is the actual tokenizer
      // entry point — once found, we can call it directly on text.
      try {
        var seenTk = new WeakSet();
        var found = [];
        function walkTk(o, path, depth){
          if (depth > 4 || found.length >= 12) return;
          if (!o) return;
          var t = typeof o;
          if (t !== 'object' && t !== 'function') return;
          try { if (seenTk.has(o)) return; seenTk.add(o); } catch(_) { return; }
          // Note any object with tokenize-y method
          if (t === 'object') {
            try {
              var hasTokenize = typeof o.tokenize === 'function' || typeof o.tokenizeEncoded === 'function' || typeof o.tokenize2 === 'function';
              if (hasTokenize) {
                var ms = [];
                try { ms = Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {}).filter(function(k){ return typeof o[k]==='function' && k!=='constructor'; }).slice(0,6); } catch(_) {}
                found.push({ kind: 'TOKENIZE-METHOD', path: path, methods: ms.join(',') });
              }
            } catch(_) {}
          }
          var keys;
          try { keys = Object.getOwnPropertyNames(o); } catch(_) { return; }
          for (var ki = 0; ki < keys.length; ki++) {
            var k = keys[ki];
            // Skip noisy/large fields
            if (k === '_textModel' || k === '_buffer' || k === 'parent') continue;
            // Hit on suspicious key names
            if (/tokenization(Registry|Support)?$|tokenizer|^_tokens$|^tokens$/i.test(k)) {
              try {
                var v = o[k];
                var vt = typeof v;
                var info = 't='+vt;
                if (v && (vt === 'object' || vt === 'function')) {
                  var pn = [];
                  try { pn = Object.getOwnPropertyNames(v).slice(0,6); } catch(_) {}
                  info += ' own=['+pn.join(',')+']';
                  if (vt === 'object') {
                    try {
                      var protoMs = Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).filter(function(kk){ return typeof v[kk]==='function' && kk!=='constructor'; }).slice(0,8);
                      info += ' methods=['+protoMs.join(',')+']';
                    } catch(_) {}
                  }
                }
                found.push({ kind: 'KEY', path: path+'.'+k, info: info });
              } catch(_) {}
            }
            try {
              var v2 = o[k];
              walkTk(v2, path+'.'+k, depth+1);
            } catch(_) {}
            if (found.length >= 12) return;
          }
        }
        walkTk(tk, 'tk', 0);
        walkTk(model, 'model', 0);
        for (var fi = 0; fi < found.length; fi++) {
          var ff = found[fi];
          irLog('TOK-PROBE['+fi+'] '+ff.kind+' '+ff.path+' '+(ff.info||'methods=['+ff.methods+']'));
        }
        if (!found.length) irLog('TOK-PROBE: nothing');
      } catch(eW) { irLog('TOK-PROBE err: '+(eW&&eW.message)); }
      // DIAG: dump methods on _languageService so we can find the
      // grammar-load trigger API (e.g. requestRichLanguageFeatures).
      // Without an explicit load call, file:/// URI alone doesn't
      // auto-attach TextMate grammar to a hidden materialized widget.
      try {
        var lang = model._languageService || (tk && tk._languageService);
        if (lang) {
          var lProto = Object.getPrototypeOf(lang);
          var lKeys = lProto ? Object.getOwnPropertyNames(lProto).filter(function(k){ return typeof lang[k]==='function' && k!=='constructor'; }) : [];
          irLog('tokenize: langSvc methods=['+lKeys.slice(0,30).join(',')+']');
          // Also dump non-method own properties (tokenizationRegistry
          // is typically a non-method singleton attached as a field)
          try {
            var lOwn = Object.getOwnPropertyNames(lang);
            var nonFn = [];
            for (var loi = 0; loi < lOwn.length; loi++) {
              try {
                var lv = lang[lOwn[loi]];
                var lvt = typeof lv;
                if (lvt !== 'function' && lv !== null) nonFn.push(lOwn[loi]+':'+lvt);
              } catch(_) {}
            }
            irLog('tokenize: langSvc own non-fn=['+nonFn.slice(0,15).join(',')+']');
          } catch(_) {}
        } else {
          irLog('tokenize: no langSvc');
        }
        var trees = tk && tk._treeSitterLibraryService;
        if (trees) {
          var tProto = Object.getPrototypeOf(trees);
          var tKeys = tProto ? Object.getOwnPropertyNames(tProto).filter(function(k){ return typeof trees[k]==='function' && k!=='constructor'; }) : [];
          irLog('tokenize: tsSvc methods=['+tKeys.slice(0,15).join(',')+']');
        }
      } catch(eL) { irLog('tokenize: svc dump err: '+(eL&&eL.message)); }
      // DIAG: dump methods on tk.tokens so we can see what API is
      // actually available in this VS Code build.
      if (tk) {
        var innerKeys = inner ? Object.getOwnPropertyNames(Object.getPrototypeOf(inner) || inner).slice(0,15).join(',') : 'no-tokens-field';
        irLog('tokenize tokens API: '+innerKeys);
      }
      if (tk && typeof tk.forceTokenization === 'function') {
        var lc2 = model.getLineCount();
        for (var li2 = 1; li2 <= lc2; li2++) tk.forceTokenization(li2);
        // DIAG: extract raw token data from line 1 so we can see if
        // the tokenizer is producing distinct types or one bucket.
        // Missing getLineTokens or count of 1 means TextMate isn't
        // running on this model.
        try {
          if (typeof model.getLineTokens === 'function') {
            var lt = model.getLineTokens(1);
            var info = 'count='+(lt&&typeof lt.getCount==='function'?lt.getCount():'?');
            if (lt && typeof lt.getCount === 'function') {
              var types = [];
              var n = Math.min(lt.getCount(), 6);
              for (var ti = 0; ti < n; ti++) {
                var typeStr = '?';
                try {
                  if (typeof lt.getClassName === 'function') typeStr = lt.getClassName(ti);
                  else if (typeof lt.getStandardTokenType === 'function') typeStr = 'std='+lt.getStandardTokenType(ti);
                  else if (typeof lt.getMetadata === 'function') typeStr = 'meta='+lt.getMetadata(ti);
                } catch(_) {}
                types.push(typeStr);
              }
              info += ' types=['+types.join(',')+']';
            }
            irLog('tokenize raw line1: '+info);
          } else {
            var mKeys = [];
            try { mKeys = Object.getOwnPropertyNames(model); } catch(_) {}
            var tkKeys = tk ? Object.getOwnPropertyNames(tk) : [];
            irLog('tokenize: no getLineTokens. modelKeys='+mKeys.slice(0,15).join(',')+' tkKeys='+tkKeys.join(','));
          }
        } catch(eRt) { irLog('tokenize: raw token dump err: '+(eRt&&eRt.message)); }
      } else {
        var tkProto = tk ? Object.getPrototypeOf(tk) : null;
        var protoKeys = tkProto ? Object.getOwnPropertyNames(tkProto) : [];
        irLog('tokenize: no forceTokenization. tkKeys='+(tk?Object.getOwnPropertyNames(tk).join(','):'no-tk')+' protoKeys='+protoKeys.slice(0,10).join(','));
      }
    } catch(eT) { irLog('tokenize: forceTokenization err: '+(eT&&eT.message)); }
    var dom = m.editor.getDomNode && m.editor.getDomNode();
    if (!dom) { irLog('tokenize: no dom node'); return null; }
    var viewLines = dom.querySelector('.view-lines');
    if (!viewLines) {
      // Inspect what's inside the editor's DOM so we can see what to look for.
      var hits = [];
      var allCls = dom.querySelectorAll('[class]');
      for (var ai = 0; ai < Math.min(allCls.length, 6); ai++) {
        hits.push(allCls[ai].className.toString().slice(0,40));
      }
      irLog('tokenize: no .view-lines (descendants='+allCls.length+' sample='+hits.join('|')+')');
      return null;
    }
    var lnCount = viewLines.children.length;
    if (!lnCount) { irLog('tokenize: .view-lines empty (text='+text.length+'B lang='+langId+')'); return null; }
    var entries = [];
    for (var i = 0; i < lnCount; i++) {
      var ln = viewLines.children[i];
      entries.push({ top: parseInt(ln.style.top, 10) || 0, el: ln });
    }
    entries.sort(function(a,b){ return a.top - b.top; });
    var frag = document.createDocumentFragment();
    var spanCount = 0;
    for (var j = 0; j < entries.length; j++) {
      var lnEl = entries[j].el;
      for (var k = 0; k < lnEl.children.length; k++) {
        var sp = lnEl.children[k];
        if (sp.nodeName === 'SPAN') { frag.appendChild(sp.cloneNode(true)); spanCount++; }
      }
      if (j < entries.length - 1) frag.appendChild(document.createTextNode('\\n'));
    }
    // DIAG: capture first cloned line's outerHTML so we can see what
    // classes (.mtkN) and structure were actually produced. Also grab
    // the editor's root class list so we know which Monaco theme class
    // is on the widget — if it's 'vs' instead of the user's theme, the
    // generated .mtkN colors won't match what's in the user's editor.
    try {
      var rootCls = (m.editor.getDomNode && m.editor.getDomNode().className) || '?';
      var sample = entries[0] && entries[0].el ? entries[0].el.outerHTML : '?';
      irLog('tokenize: ok lines='+lnCount+' spans='+spanCount+' lang='+langId+' root="'+String(rootCls).slice(0,60)+'" first="'+String(sample).slice(0,200)+'"');
    } catch(_) {
      irLog('tokenize: ok lines='+lnCount+' spans='+spanCount+' lang='+langId);
    }
    return frag;
  } catch(e) {
    var msg = e&&e.message?e.message:String(e);
    irLog('tokenize threw: '+msg);
    if (/hasModel|hasWidgetFocus|removeDecorationsByType|onDidChangeModelLanguage/.test(msg)) {
      try { irDisposeMonaco('tokenize-contract-error:' + msg.slice(0, 120)); } catch(_) {}
    }
    return null;
  }
};

return 'hover patch installed';
})()`;
}

// ── Type detection (for $provideHover preview) ──

// Only language keywords and documentation words — NOT type/variable names
const SKIP_WORDS = new Set([
  // Language keywords (not navigable)
  'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'super', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'of', 'in',
  'async', 'await', 'yield', 'throw', 'try', 'catch', 'finally',
  'def', 'self', 'pass', 'with', 'isinstance', 'property',
  'public', 'private', 'protected', 'static', 'abstract',
  'struct', 'union', 'typedef', 'extern', 'register',
  'virtual', 'inline', 'constexpr', 'namespace', 'using', 'template',
  // Documentation/markup words
  'the', 'The', 'that', 'will', 'are', 'was', 'has', 'have', 'can',
  'should', 'may', 'must', 'been', 'being', 'does', 'did', 'its',
  'also', 'than', 'then', 'when', 'where', 'which', 'what', 'how', 'who',
  'all', 'each', 'every', 'some', 'any', 'Returns', 'Raises', 'Args',
  'Parameters', 'Note', 'Example', 'param', 'throws', 'since', 'see',
  'deprecated', 'alias', 'overload', 'module', 'variable',
  // Common Python typing helpers are useful in signatures but noisy as
  // recursive previews; resolving them often points into stdlib/typeshed.
  'Any', 'None', 'Optional', 'Union', 'Callable', 'Type', 'Self',
  'List', 'Dict', 'Set', 'Tuple', 'Iterable', 'Iterator', 'Sequence', 'Mapping',
  // Modal verbs / common doc prose capitalized at sentence start
  'Cannot', 'Could', 'Would', 'Should',
  // Pronouns / demonstratives
  'This', 'That', 'These', 'Those', 'Here', 'There',
  // Temporal / hedging adverbs
  'Now', 'Then', 'Usually', 'Sometimes', 'Always', 'Never',
  'Often', 'Rarely', 'Initially', 'Finally',
  // Docstring headers we missed the first time
  'Warning', 'Warnings', 'See', 'Also', 'More', 'Given',
  'Available', 'Required', 'Reference', 'Examples',
  // Review / logging words
  'Copy', 'Wrap', 'Multiple', 'Make', 'Please', 'Raise',
  'Private', 'Subclasses', 'Implementation', 'Root',
  'Filesystem', 'Human', 'Last',
  // Linter codes that show up in comments
  'F401',
]);

function addNavigableName(out: string[], seen: Set<string>, id: string, allowLowercaseDeclaration = false) {
  if (!id || seen.has(id) || SKIP_WORDS.has(id) || id.length <= 2) { return; }
  if (!allowLowercaseDeclaration && !TYPE_SHAPED_NAME.test(id)) { return; }
  seen.add(id);
  out.push(id);
}

function declarationIdentifiersInLine(line: string): Array<{ id: string; index: number }> {
  const out: Array<{ id: string; index: number }> = [];
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) { return out; }

  const declarationPatterns = [
    /^(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:async\s+)?def\s+([A-Za-z_]\w*)\b/,
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
    /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/,
  ];

  for (const pattern of declarationPatterns) {
    const match = pattern.exec(trimmed);
    if (!match?.[1]) { continue; }
    const index = line.indexOf(match[1]);
    if (index >= 0) { out.push({ id: match[1], index }); }
    return out;
  }

  if (/^(?:if|elif|else|for|while|switch|case|return|throw|raise|yield|await|with|try|except|finally|from|import|new)\b/.test(trimmed)) {
    return out;
  }

  const methodMatch = /^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\([^=;{}]*\)\s*(?::|=>|\{|$)/.exec(trimmed);
  if (methodMatch?.[1]) {
    const index = line.indexOf(methodMatch[1]);
    if (index >= 0) { out.push({ id: methodMatch[1], index }); }
  }
  return out;
}

function findTypeNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const decl of declarationIdentifiersInLine(line)) {
      addNavigableName(out, seen, decl.id, true);
    }
  }
  const ids = text.match(/\b[A-Za-z_]\w*\b/g) || [];
  for (const id of ids) {
    addNavigableName(out, seen, id, false);
  }
  return out;
}

// ── Go to definition handler ──

class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new AbortError(); }
}

async function goToTypeHandler(docUriStr: string, identifier: string) {
  if (identifier.startsWith('PREVIEW:')) {
    const previewIdentifier = identifier.substring('PREVIEW:'.length);
    await previewTypeHandler(docUriStr, previewIdentifier);
    return;
  }
  if (identifier.length <= 2) {
    log.info(`goToType: "${identifier}" skipped (too short)`);
    return;
  }
  if (clickNegGet(identifier)) {
    log.info(`goToType: "${identifier}" skipped (cached negative)`);
    return;
  }

  // Cancel any in-flight click so a new one isn't dropped by a busy flag.
  if (currentClickController && !currentClickController.signal.aborted) {
    currentClickController.abort();
    log.info(`goToType: cancelling previous click for new "${identifier}"`);
  }
  const controller = new AbortController();
  currentClickController = controller;
  const signal = controller.signal;

  // Safety net: abort if the inner handler hangs beyond 15s.
  const safetyTimer = setTimeout(() => {
    if (!signal.aborted) {
      log.warn(`goToType: "${identifier}" safety timeout (15s) — aborting`);
      controller.abort();
    }
  }, 15000);

  try {
    await goToTypeHandlerInner(docUriStr, identifier, signal);
  } catch (err) {
    if (err instanceof AbortError || signal.aborted) {
      log.info(`goToType: "${identifier}" aborted`);
    } else {
      log.warn(`goToType: "${identifier}" error: ${err}`);
    }
  } finally {
    clearTimeout(safetyTimer);
    if (currentClickController === controller) { currentClickController = null; }
  }
}

// Normalize defProvider result (Location or LocationLink) to {uri, range}
function normalizeDef(d: any): { uri: vscode.Uri; range: vscode.Range } | null {
  if (d.targetUri) {
    return { uri: d.targetUri, range: d.targetRange || d.targetSelectionRange };
  }
  if (d.uri && d.range) {
    return { uri: d.uri, range: d.range };
  }
  return null;
}

// Filter out non-code documents (logs, git buffers, output channels, etc.)
const CODE_SCHEMES = new Set(['file', 'untitled', 'vscode-userdata']);
function isCodeDoc(doc: vscode.TextDocument): boolean {
  if (!CODE_SCHEMES.has(doc.uri.scheme)) { return false; }
  const p = doc.uri.fsPath;
  if (p.endsWith('.log') || p.endsWith('.md') || p.endsWith('.git') || p.includes('/scm')) { return false; }
  return true;
}

// ── Import-follow engine: resolve identifier by tracing import statements ──

// Scan a file for a definition of identifier.
// Priority: class/interface > function/method > const/let/var > field/property > assignment
function findDefInText(text: string, identifier: string, doc: vscode.TextDocument): vscode.Position | null {
  const escaped = esc(identifier);
  const modifiers = `(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)[ \\t]+)*`;
  const patterns: RegExp[] = [
    // 1. Class-level: class X, interface X, type X, enum X, struct X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:class|interface|type|enum|struct)[ \\t]+${escaped}\\b`, 'm'),
    // 2. Function/method: def X, fn X, func X, function X, async def X, async function X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?(?:def|fn|func|function)[ \\t]+${escaped}\\b`, 'm'),
    // 3. Rust pub items: pub struct/enum/fn/type X
    new RegExp(`^[ \\t]*pub[ \\t]+(?:struct|enum|fn|type|const|static)[ \\t]+${escaped}\\b`, 'm'),
    // 4. const/let/var declaration: const X, let X, var X, export const X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escaped}\\b`, 'm'),
    // 5. Method signature (TS interface/class): X(..., public X(..., X<T>(...
    new RegExp(`^[ \\t]+${modifiers}${escaped}[ \\t]*(?:<[^>\\n]*>)?[<(]`, 'm'),
    // 6. Field/property declaration: X: Type, readonly X?: Type, public X = ...
    new RegExp(`^[ \\t]+${modifiers}${escaped}[ \\t]*[:?=][ \\t]*\\w`, 'm'),
    // 7. Django/Python field: X = models.SomeField(...) or X = SomeType(...)
    new RegExp(`^[ \\t]+${escaped}[ \\t]*=[ \\t]*(?:models\\.)?\\w+\\(`, 'm'),
    // 8. Python @property: @property followed by def X
    new RegExp(`^[ \\t]*@property\\s+def[ \\t]+${escaped}\\b`, 'ms'),
    // 9. Top-level assignment: X = ... (PascalCase only, no indent)
    new RegExp(`^${escaped}[ \\t]*(?::[ \\t]*\\w+)?[ \\t]*=[ \\t]*`, 'm'),
  ];

  for (const regex of patterns) {
    const match = regex.exec(text);
    if (match) {
      // Find exact identifier position within the match
      const idIdx = text.indexOf(identifier, match.index);
      return doc.positionAt(idIdx >= 0 ? idIdx : match.index);
    }
  }
  return null;
}

async function followImports(identifier: string, docs: vscode.TextDocument[], ms: () => string, signal?: AbortSignal): Promise<vscode.Location | null> {
  const checkAbort = () => { if (signal?.aborted) { throw new AbortError(); } };
  // Python: from module.path import Identifier (single-line)
  const pyImportSingle = new RegExp(`^[ \\t]*from[ \\t]+([\\w.]+)[ \\t]+import[ \\t]+.*\\b${esc(identifier)}\\b`, 'm');
  // Python: from module.path import (\n  ...\n  Identifier,\n) (multi-line)
  const pyImportMulti = new RegExp(`^[ \\t]*from[ \\t]+([\\w.]+)[ \\t]+import[ \\t]*\\([^)]*\\b${esc(identifier)}\\b[^)]*\\)`, 'ms');
  // TS/JS: import { Identifier } from 'path' (single or multi-line)
  const tsImportRegex = new RegExp(`import[ \\t]+(?:\\{[^}]*\\b${esc(identifier)}\\b[^}]*\\}|${esc(identifier)})[ \\t]+from[ \\t]+['"]([^'"]+)['"]`, 's');

  for (const doc of docs) {
    checkAbort();
    const text = doc.getText();
    const isPython = doc.languageId === 'python' || doc.uri.fsPath.endsWith('.py') || doc.uri.fsPath.endsWith('.pyi');
    const isTS = doc.languageId === 'typescript' || doc.languageId === 'javascript'
      || doc.languageId === 'typescriptreact' || doc.languageId === 'javascriptreact';

    // ── Python imports ──
    if (isPython) {
      const pyMatch = pyImportSingle.exec(text) || pyImportMulti.exec(text);
      if (pyMatch) {
        const modulePath = pyMatch[1];
        const filePath = modulePath.replace(/\./g, '/');
        log.info(`  [import] Python: from ${modulePath} import ${identifier} (${ms()})`);

        const patterns = [`**/${filePath}.py`, `**/${filePath}/__init__.py`, `**/${filePath}.pyi`];
        for (const pattern of patterns) {
          try {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
            // Prefer project files over .venv/site-packages
            files.sort((a, b) => {
              const aVenv = a.fsPath.includes('.venv') || a.fsPath.includes('site-packages') ? 1 : 0;
              const bVenv = b.fsPath.includes('.venv') || b.fsPath.includes('site-packages') ? 1 : 0;
              if (aVenv !== bVenv) { return aVenv - bVenv; }
              return a.fsPath.length - b.fsPath.length; // shorter path = likely more direct
            });
            for (const fileUri of files) {
              try {
                const targetDoc = await vscode.workspace.openTextDocument(fileUri);
                const targetText = targetDoc.getText();
                const pos = findDefInText(targetText, identifier, targetDoc);
                if (pos) {
                  const line = targetDoc.lineAt(pos.line).text.trim();
                  log.info(`  [import] → ${vscode.workspace.asRelativePath(fileUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                  return new vscode.Location(fileUri, new vscode.Range(pos, pos));
                }
                // __init__.py barrel: follow "from .submodule import *" or "from .submodule import Identifier"
                if (fileUri.fsPath.endsWith('__init__.py')) {
                  const reExportNamed = new RegExp(`^[ \\t]*from[ \\t]+(\\.\\w+)[ \\t]+import[ \\t]+.*\\b${esc(identifier)}\\b`, 'm');
                  const reExportStar = /^[ \t]*from[ \t]+(\.\w+)[ \t]+import[ \t]+\*/gm;
                  const subModules: string[] = [];
                  const namedMatch = reExportNamed.exec(targetText);
                  if (namedMatch) { subModules.push(namedMatch[1]); }
                  let starMatch: RegExpExecArray | null;
                  while ((starMatch = reExportStar.exec(targetText)) !== null) {
                    subModules.push(starMatch[1]);
                  }
                  for (const relModule of subModules) {
                    try {
                      const subUri = vscode.Uri.joinPath(fileUri, '..', relModule.replace('.', '') + '.py');
                      const subDoc = await vscode.workspace.openTextDocument(subUri);
                      const subPos = findDefInText(subDoc.getText(), identifier, subDoc);
                      if (subPos) {
                        const subLine = subDoc.lineAt(subPos.line).text.trim();
                        log.info(`  [import] → ${vscode.workspace.asRelativePath(subUri)}:${subPos.line + 1} "${subLine.substring(0, 60)}" (barrel, ${ms()})`);
                        return new vscode.Location(subUri, new vscode.Range(subPos, subPos));
                      }
                    } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
        }
        log.info(`  [import] module "${modulePath}" not resolved (${ms()})`);
      }
    }

    // ── TS/JS imports ──
    if (isTS) {
      const tsMatch = tsImportRegex.exec(text);
      if (tsMatch) {
        const importPath = tsMatch[1];
        log.info(`  [import] TS/JS: import ${identifier} from '${importPath}' (${ms()})`);

        if (importPath.startsWith('.')) {
          // Relative import
          const docDir = vscode.Uri.joinPath(doc.uri, '..');
          const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
          for (const ext of extensions) {
            try {
              const targetUri = vscode.Uri.joinPath(docDir, importPath + ext);
              const targetDoc = await vscode.workspace.openTextDocument(targetUri);
              const pos = findDefInText(targetDoc.getText(), identifier, targetDoc);
              if (pos) {
                const line = targetDoc.lineAt(pos.line).text.trim();
                log.info(`  [import] → ${vscode.workspace.asRelativePath(targetUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                return new vscode.Location(targetUri, new vscode.Range(pos, pos));
              }
            } catch {}
          }
        } else {
          // Package import (e.g. '@emotion/react', 'react', 'formik')
          // Strategy: find package.json → read "types"/"typings" field → scan that file
          const pkgPatterns = [
            `**/node_modules/${importPath}/package.json`,
            `**/node_modules/@types/${importPath.replace(/^@[^/]+\//, '')}/package.json`,
          ];
          for (const pkgPattern of pkgPatterns) {
            try {
              const pkgFiles = await vscode.workspace.findFiles(pkgPattern, undefined, 2);
              for (const pkgUri of pkgFiles) {
                try {
                  const pkgDoc = await vscode.workspace.openTextDocument(pkgUri);
                  const pkgJson = JSON.parse(pkgDoc.getText());
                  const typesPath = pkgJson.types || pkgJson.typings;
                  if (typesPath) {
                    const typesUri = vscode.Uri.joinPath(pkgUri, '..', typesPath);
                    const typesDoc = await vscode.workspace.openTextDocument(typesUri);
                    const typesText = typesDoc.getText();
                    // Direct def in types entry file
                    const pos = findDefInText(typesText, identifier, typesDoc);
                    if (pos) {
                      const line = typesDoc.lineAt(pos.line).text.trim();
                      log.info(`  [import] → ${vscode.workspace.asRelativePath(typesUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                      return new vscode.Location(typesUri, new vscode.Range(pos, pos));
                    }
                    // Check re-exports: export { X } from './sub' or export * from './sub'
                    const reExportPaths: string[] = [];
                    // Named: export { Identifier } from './path'
                    const namedReExport = new RegExp(`export\\s*\\{[^}]*\\b${esc(identifier)}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`, 's');
                    const namedMatch = namedReExport.exec(typesText);
                    if (namedMatch) { reExportPaths.push(namedMatch[1]); }
                    // Star: export * from './path' — check all star re-exports
                    const starRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
                    let starMatch: RegExpExecArray | null;
                    while ((starMatch = starRegex.exec(typesText)) !== null) {
                      reExportPaths.push(starMatch[1]);
                    }
                    for (const subPath of reExportPaths) {
                      const subExts = ['.d.ts', '.ts', '/index.d.ts'];
                      for (const ext of subExts) {
                        try {
                          const subUri = vscode.Uri.joinPath(typesUri, '..', subPath + ext);
                          const subDoc = await vscode.workspace.openTextDocument(subUri);
                          const subPos = findDefInText(subDoc.getText(), identifier, subDoc);
                          if (subPos) {
                            const subLine = subDoc.lineAt(subPos.line).text.trim();
                            log.info(`  [import] → ${vscode.workspace.asRelativePath(subUri)}:${subPos.line + 1} "${subLine.substring(0, 60)}" (${ms()})`);
                            return new vscode.Location(subUri, new vscode.Range(subPos, subPos));
                          }
                        } catch {}
                      }
                    }
                  }
                } catch {}
              }
            } catch {}
          }
          // Fallback: direct file patterns
          const directPatterns = [
            `**/node_modules/${importPath}/index.d.ts`,
            `**/node_modules/@types/${importPath}/index.d.ts`,
          ];
          for (const pattern of directPatterns) {
            try {
              const files = await vscode.workspace.findFiles(pattern, undefined, 2);
              for (const fileUri of files) {
                try {
                  const targetDoc = await vscode.workspace.openTextDocument(fileUri);
                  const pos = findDefInText(targetDoc.getText(), identifier, targetDoc);
                  if (pos) {
                    const line = targetDoc.lineAt(pos.line).text.trim();
                    log.info(`  [import] → ${vscode.workspace.asRelativePath(fileUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                    return new vscode.Location(fileUri, new vscode.Range(pos, pos));
                  }
                } catch {}
              }
            } catch {}
          }
        }
        log.info(`  [import] path "${importPath}" not resolved (${ms()})`);
      }
    }
  }
  return null;
}

/** showTextDocument with a 5s timeout to prevent permanent hangs */
async function safeShowTextDocument(docOrUri: vscode.TextDocument | vscode.Uri, options: { selection: vscode.Range; preserveFocus: boolean }): Promise<void> {
  const doc = docOrUri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(docOrUri) : docOrUri;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('showTextDocument timeout (5s)')), 5000));
  try {
    await Promise.race([vscode.window.showTextDocument(doc, options), timeout]);
  } catch (err) {
    log.warn(`safeShowTextDocument: ${err}`);
  }
}

async function goToTypeHandlerInner(docUriStr: string, identifier: string, signal?: AbortSignal) {
  const regexSource = `\\b${esc(identifier)}\\b`;
  log.info(`goToType: "${identifier}" regex=/${regexSource}/g`);
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  const regex = new RegExp(regexSource, 'g');

  // ── Collect all searchable docs ──
  const previewLoc = cappedPreviewLocationGet(lastPreviewLocations, identifier);
  const priorityUris: string[] = [];
  if (previewLoc?.uri) { priorityUris.push(previewLoc.uri.toString()); }
  if (lastHoverDocUri) { priorityUris.push(lastHoverDocUri); }
  if (docUriStr) { priorityUris.push(docUriStr); }
  const editor = vscode.window.activeTextEditor;
  if (editor) { priorityUris.push(editor.document.uri.toString()); }

  const seen = new Set<string>();
  const allDocs: vscode.TextDocument[] = [];
  for (const uriStr of priorityUris) {
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    try {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
      if (isCodeDoc(d)) { allDocs.push(d); }
    } catch {}
  }
  for (const openDoc of vscode.workspace.textDocuments) {
    const uriStr = openDoc.uri.toString();
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    if (isCodeDoc(openDoc)) { allDocs.push(openDoc); }
  }
  // Sort: project files first, then node_modules/@types, then stdlib/.venv last
  allDocs.sort((a, b) => {
    const score = (d: vscode.TextDocument) => {
      const p = d.uri.fsPath;
      if (p.includes('.venv') || p.includes('site-packages') || p.includes('.asdf')
        || p.includes('typeshed') || p.includes('/lib/python')) { return 3; } // stdlib/.venv last
      if (p.includes('node_modules') || p.includes('lib.dom.d.ts') || p.includes('lib.es')) { return 2; } // TS lib
      if (p.includes('package.json')) { return 4; } // config files last
      return 0; // project files first
    };
    return score(a) - score(b);
  });
  log.info(`  docs: [${allDocs.map(d => vscode.workspace.asRelativePath(d.uri)).join(', ')}] (${ms()})`);

  const previewDeclarationLoc = cappedPreviewLocationGet(lastPreviewDeclarationLocations, identifier);
  if (previewDeclarationLoc) {
    throwIfAborted(signal);
    const defDoc = findOpenDoc(previewDeclarationLoc.uri) ?? await vscode.workspace.openTextDocument(previewDeclarationLoc.uri);
    log.info(`→ ${vscode.workspace.asRelativePath(previewDeclarationLoc.uri)}:${previewDeclarationLoc.range.start.line + 1} (preview declaration, ${ms()})`);
    await safeShowTextDocument(defDoc, {
      selection: previewDeclarationLoc.range,
      preserveFocus: false,
    });
    return;
  }

  // ── Step 0: Sidecar fast path ──
  // Gate on the *origin* doc type so unsupported-language clicks aren't
  // funnelled through the index. Fast-path applies to any supported language;
  // the short-circuit (definitively-missing) is restricted to Python because
  // we only have full library coverage there.
  const originFsPath = (() => {
    try {
      if (docUriStr) { return vscode.Uri.parse(docUriStr).fsPath; }
    } catch {}
    const active = vscode.window.activeTextEditor;
    return active?.document.uri.fsPath ?? '';
  })();
  const clickSupported = isSupportedFsPath(originFsPath);

  if (indexManager && clickSupported) {
    try {
      const fastHit = await fastResolveTypeName(identifier, originFsPath, findOpenDoc(vscode.Uri.file(originFsPath)));
      throwIfAborted(signal);
      if (fastHit) {
        try {
          const defUri = vscode.Uri.file(fastHit.path);
          const defDoc = findOpenDoc(defUri) ?? await vscode.workspace.openTextDocument(defUri);
          const pos = new vscode.Position(
            Math.max(0, fastHit.line - 1),
            Math.max(0, fastHit.col - 1),
          );
          log.info(`→ ${vscode.workspace.asRelativePath(defUri)}:${fastHit.line} (fast/${fastHit.kind}/${fastHit.source}, ${ms()})`);
          await safeShowTextDocument(defDoc, {
            selection: new vscode.Range(pos, pos), preserveFocus: false,
          });
          return;
        } catch (err) {
          log.warn(`  [0] fast path open error: ${err} (${ms()})`);
        }
      } else if (await sidecarDefinitivelyMissing(identifier, originFsPath)) {
        log.info(`  [0] sidecar miss (full coverage) → skip LSP, "${identifier}" not navigable (${ms()})`);
        clickNegSet(identifier);
        return;
      }
    } catch (err) {
      if (err instanceof AbortError) { throw err; }
      log.warn(`  [0] fast path error: ${err} (${ms()})`);
    }
  }

  // ── Step 1: Fast definition-line scan (no language server, pure regex) ──
  // Two-pass: project files first, then stdlib/.venv/node_modules
  log.info(`  [1] defLine scan... (${ms()})`);
  const isExternalDoc = (d: vscode.TextDocument) => {
    const p = d.uri.fsPath;
    return p.includes('.venv') || p.includes('site-packages') || p.includes('.asdf')
      || p.includes('typeshed') || p.includes('/lib/python') || p.includes('node_modules')
      || p.includes('lib.dom.d.ts') || p.includes('lib.es');
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let di = 0; di < allDocs.length; di++) {
      throwIfAborted(signal);
      const doc = allDocs[di];
      const external = isExternalDoc(doc);
      if (pass === 0 && external) { continue; }  // pass 0: project only
      if (pass === 1 && !external) { continue; }  // pass 1: external only

      const relPath = vscode.workspace.asRelativePath(doc.uri);
      const text = doc.getText();

      const pos = findDefInText(text, identifier, doc);
      if (pos) {
        throwIfAborted(signal);
        const line = doc.lineAt(pos.line).text.trim();
        log.info(`→ ${relPath}:${pos.line + 1} "${line.substring(0, 60)}" (defLine${pass === 1 ? '/ext' : ''}, ${ms()})`);
        await safeShowTextDocument(doc, {
          selection: new vscode.Range(pos, pos), preserveFocus: false
        });
        return;
      }
    }
    if (pass === 0) { log.info(`  [1] not in project docs, checking external... (${ms()})`); }
  }

  // ── Step 2: Import-follow (trace import statements to source file) ──
  throwIfAborted(signal);
  log.info(`  [2] import-follow... (${ms()})`);
  try {
    const importLoc = await followImports(identifier, allDocs, ms, signal);
    throwIfAborted(signal);
    if (importLoc) {
      log.info(`→ ${vscode.workspace.asRelativePath(importLoc.uri)}:${importLoc.range.start.line + 1} (import-follow, ${ms()})`);
      await safeShowTextDocument(importLoc.uri, {
        selection: importLoc.range, preserveFocus: false
      });
      return;
    }
  } catch (err) {
    if (err instanceof AbortError) { throw err; }
    log.warn(`  [2] import-follow error: ${err} (${ms()})`);
  }

  // ── Step 3: Definition provider (with per-call timeout, skip if first call is slow) ──
  log.info(`  [3] defProvider scan... (${ms()})`);
  for (let di = 0; di < allDocs.length; di++) {
    throwIfAborted(signal);
    const doc = allDocs[di];
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const text = doc.getText();
    regex.lastIndex = 0;

    const matchPositions: number[] = [];
    let mc: RegExpExecArray | null;
    while ((mc = regex.exec(text)) !== null) {
      matchPositions.push(mc.index);
      if (matchPositions.length > 20) { break; }
    }
    if (matchPositions.length === 0) { continue; }
    log.info(`  [3.${di}] ${relPath}: ${matchPositions.length} match(es) (${ms()})`);

    try {
      let slowFile = false;
      for (let mi = 0; mi < matchPositions.length; mi++) {
        throwIfAborted(signal);
        if (slowFile) {
          log.info(`  [3.${di}] skip remaining (slow file) (${ms()})`);
          break;
        }
        const pos = doc.positionAt(matchPositions[mi]);
        log.info(`  [3.${di}.${mi}] defProvider :${pos.line + 1}:${pos.character} (${ms()})`);
        const callT0 = Date.now();
        const defPromise = vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, pos);
        const defTimeout = new Promise<null>(r => setTimeout(() => r(null), 5000));
        const defs = await Promise.race([defPromise, defTimeout]);
        throwIfAborted(signal);

        if (defs === null) {
          log.warn(`  [3.${di}.${mi}] TIMEOUT 5s → skip file (${ms()})`);
          slowFile = true;
          continue;
        }
        const callMs = Date.now() - callT0;
        log.info(`  [3.${di}.${mi}] returned ${defs?.length || 0} def(s) [${callMs}ms] (${ms()})`);
        if (callMs > 3000) { slowFile = true; } // mark file as slow for remaining matches

        const def = defs?.length ? normalizeDef(defs[0]) : null;
        if (def) {
          const defRelPath = vscode.workspace.asRelativePath(def.uri);
          const isSameFile = def.uri.toString() === doc.uri.toString();
          const isSameLine = isSameFile && def.range.start.line === pos.line;
          const isSelfRef = isSameLine && Math.abs(def.range.start.character - pos.character) < 3;

          log.info(`  [3.${di}.${mi}] → ${defRelPath}:${def.range.start.line + 1}${isSelfRef ? ' (self-ref)' : ''}`);

          if (isSelfRef) {
            const defLineText = doc.lineAt(def.range.start.line).text;
            const isDefLine = /^\s*(?:export\s+)?(?:class|interface|type|enum|const|let|var|function|def|struct)\s+/.test(defLineText);
            if (isDefLine) {
              log.info(`  [3.${di}.${mi}] self-ref on defLine → accept`);
            } else {
              log.info(`  [3.${di}.${mi}] self-ref → skip`);
              continue;
            }
          }

          log.info(`→ ${defRelPath}:${def.range.start.line + 1} (${ms()})`);
          await safeShowTextDocument(def.uri, {
            selection: def.range, preserveFocus: false
          });
          return;
        }
      }
    } catch (err) {
      if (err instanceof AbortError) { throw err; }
      log.warn(`  [3.${di}] error: ${err} (${ms()})`);
    }
  }

  // ── Step 4: Scan import sources of the hover-origin file (max 3s) ──
  throwIfAborted(signal);
  const step4Deadline = Date.now() + 3000;
  log.info(`  [4] import-source scan... (${ms()})`);
  try {
    // Find the file where hover was triggered, scan its imports for packages that might define this type
    let hoverDoc: vscode.TextDocument | null = null;
    if (lastHoverDocUri) {
      try { hoverDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(lastHoverDocUri)); } catch {}
    }
    if (hoverDoc) {
      const hoverText = hoverDoc.getText();
      // Collect all import sources from the hover file
      const importSources: vscode.Uri[] = [];

      if (hoverDoc.languageId === 'typescript' || hoverDoc.languageId === 'typescriptreact'
        || hoverDoc.languageId === 'javascript' || hoverDoc.languageId === 'javascriptreact') {
        // TS: extract all "from 'package'" paths, resolve to type files
        const fromRegex = /from\s+['"]([^'"]+)['"]/g;
        let fm: RegExpExecArray | null;
        const seenPkgs = new Set<string>();
        const MAX_PKG_SCAN = 5;
        while ((fm = fromRegex.exec(hoverText)) !== null) {
          if (Date.now() > step4Deadline || seenPkgs.size >= MAX_PKG_SCAN) { break; }
          const pkg = fm[1];
          if (pkg.startsWith('.') || seenPkgs.has(pkg)) { continue; }
          seenPkgs.add(pkg);
          // Try @types/<pkg>/index.d.ts and <pkg> package.json → types
          const candidates = [
            `**/node_modules/@types/${pkg.replace(/^@[^/]+\//, '')}/index.d.ts`,
            `**/node_modules/${pkg}/index.d.ts`,
          ];
          for (const pat of candidates) {
            try {
              const files = await vscode.workspace.findFiles(pat, undefined, 1);
              for (const f of files) { if (!seen.has(f.toString())) { importSources.push(f); seen.add(f.toString()); } }
            } catch {}
          }
          // Also try package.json → types field
          try {
            const pkgFiles = await vscode.workspace.findFiles(`**/node_modules/${pkg}/package.json`, undefined, 1);
            for (const pkgUri of pkgFiles) {
              const pkgDoc = await vscode.workspace.openTextDocument(pkgUri);
              const pkgJson = JSON.parse(pkgDoc.getText());
              const typesPath = pkgJson.types || pkgJson.typings;
              if (typesPath) {
                const typesUri = vscode.Uri.joinPath(pkgUri, '..', typesPath);
                if (!seen.has(typesUri.toString())) { importSources.push(typesUri); seen.add(typesUri.toString()); }
              }
            }
          } catch {}
        }
      }

      if (hoverDoc.languageId === 'python') {
        const pyFromRegex = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import/gm;
        let pfm: RegExpExecArray | null;
        let pyPkgCount = 0;
        while ((pfm = pyFromRegex.exec(hoverText)) !== null) {
          if (Date.now() > step4Deadline || pyPkgCount >= 5) { break; }
          pyPkgCount++;
          const modPath = pfm[1].replace(/\./g, '/');
          const pats = [`**/${modPath}.py`, `**/${modPath}/__init__.py`, `**/${modPath}.pyi`];
          for (const pat of pats) {
            if (Date.now() > step4Deadline) { break; }
            try {
              const files = await vscode.workspace.findFiles(pat, '**/node_modules/**', 2);
              for (const f of files) { if (!seen.has(f.toString())) { importSources.push(f); seen.add(f.toString()); } }
            } catch {}
          }
        }
      }

      log.info(`  [4] scanning ${importSources.length} import source(s) (${ms()})`);
      for (const srcUri of importSources) {
        throwIfAborted(signal);
        if (Date.now() > step4Deadline) {
          log.info(`  [4] timeout after 3s (${ms()})`);
          break;
        }
        try {
          const srcDoc = await vscode.workspace.openTextDocument(srcUri);
          const pos = findDefInText(srcDoc.getText(), identifier, srcDoc);
          if (pos) {
            throwIfAborted(signal);
            const line = srcDoc.lineAt(pos.line).text.trim();
            log.info(`→ ${vscode.workspace.asRelativePath(srcUri)}:${pos.line + 1} "${line.substring(0, 60)}" (importSource, ${ms()})`);
            await safeShowTextDocument(srcDoc, {
              selection: new vscode.Range(pos, pos), preserveFocus: false
            });
            return;
          }
        } catch (err) { if (err instanceof AbortError) { throw err; } }
      }
    }

    // Fallback: file-name based search (only if still within deadline)
    if (Date.now() > step4Deadline) {
      log.info(`  [4] timeout before findFiles (${ms()})`);
    } else {
    const wsPatterns = [`**/${identifier}.py`, `**/${identifier}.ts`, `**/${identifier}.d.ts`,
      `**/${identifier}.tsx`, `**/${identifier.toLowerCase()}.py`, `**/${identifier.toLowerCase()}.ts`];
    for (const wsPat of wsPatterns) {
      throwIfAborted(signal);
      if (Date.now() > step4Deadline) { break; }
      const wsFiles = await vscode.workspace.findFiles(wsPat, '**/node_modules/**', 3);
      for (const wsFileUri of wsFiles) {
        throwIfAborted(signal);
        if (seen.has(wsFileUri.toString())) { continue; }
        try {
          const wsDoc = await vscode.workspace.openTextDocument(wsFileUri);
          const wsPos = findDefInText(wsDoc.getText(), identifier, wsDoc);
          if (wsPos) {
            throwIfAborted(signal);
            const wsLine = wsDoc.lineAt(wsPos.line).text.trim();
            log.info(`→ ${vscode.workspace.asRelativePath(wsFileUri)}:${wsPos.line + 1} "${wsLine.substring(0, 60)}" (findFiles, ${ms()})`);
            await safeShowTextDocument(wsDoc, {
              selection: new vscode.Range(wsPos, wsPos), preserveFocus: false
            });
            return;
          }
        } catch (err) { if (err instanceof AbortError) { throw err; } }
      }
    }
    } // end if deadline check
  } catch (err) {
    if (err instanceof AbortError) { throw err; }
    log.warn(`  [4] error: ${err} (${ms()})`);
  }

  // ── Step 5: Direct defProvider on previewLoc (for types the LS knows about) ──
  throwIfAborted(signal);
  if (previewLoc?.uri) {
    log.info(`  [5] previewLoc defProvider... (${ms()})`);
    try {
      const pvDoc = await vscode.workspace.openTextDocument(previewLoc.uri);
      const pvText = pvDoc.getText();
      regex.lastIndex = 0;
      let pvMatch: RegExpExecArray | null;
      while ((pvMatch = regex.exec(pvText)) !== null) {
        throwIfAborted(signal);
        const pvPos = pvDoc.positionAt(pvMatch.index);
        const callT0 = Date.now();
        const pvDefs = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', pvDoc.uri, pvPos);
        throwIfAborted(signal);
        const callMs = Date.now() - callT0;
        const pvDef = pvDefs?.length ? normalizeDef(pvDefs[0]) : null;
        if (pvDef) {
          const isSelf = pvDef.uri.toString() === pvDoc.uri.toString()
            && pvDef.range.start.line === pvPos.line
            && Math.abs(pvDef.range.start.character - pvPos.character) < 3;
          if (!isSelf) {
            log.info(`→ ${vscode.workspace.asRelativePath(pvDef.uri)}:${pvDef.range.start.line + 1} (previewLoc+def, ${ms()})`);
            await safeShowTextDocument(pvDef.uri, {
              selection: pvDef.range, preserveFocus: false
            });
            return;
          }
        }
        if (callMs > 3000) {
          log.info(`  [5] slow (${callMs}ms) → skip (${ms()})`);
          break;
        }
      }
    } catch (err) {
      if (err instanceof AbortError) { throw err; }
      log.warn(`  [5] previewLoc defProvider error: ${err} (${ms()})`);
    }
  }

  // ── Step 6: Hover fallback ──
  throwIfAborted(signal);
  log.info(`  [6] hover fallback... (${ms()})`);
  for (let di = 0; di < allDocs.length; di++) {
    throwIfAborted(signal);
    const doc = allDocs[di];
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    try {
      const text = doc.getText();
      regex.lastIndex = 0;
      const m = regex.exec(text);
      if (!m) { continue; }
      const pos = doc.positionAt(m.index);
      log.info(`  [6.${di}] ${relPath}:${pos.line + 1} hoverProvider (${ms()})`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      throwIfAborted(signal);
      log.info(`  [6.${di}] returned ${hovers?.length || 0} hover(s) (${ms()})`);
      if (hovers?.length) {
        log.info(`→ hover at ${relPath}:${pos.line + 1} (${ms()})`);
        await safeShowTextDocument(doc, { selection: new vscode.Range(pos, pos), preserveFocus: false });
        await vscode.commands.executeCommand('editor.action.showHover');
        return;
      }
    } catch (err) {
      if (err instanceof AbortError) { throw err; }
    }
  }

  clickNegSet(identifier);
  log.warn(`"${identifier}" not found (${ms()})`);
}

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export async function deactivate() {
  extensionDeactivated = true;
  if (reinjectTimer) {
    clearInterval(reinjectTimer);
    reinjectTimer = undefined;
  }
  clearRendererReconnectTimer();
  if (prefetchDebounce) {
    clearTimeout(prefetchDebounce);
    prefetchDebounce = undefined;
  }
  prefetchQueue.length = 0;
  if (currentClickController && !currentClickController.signal.aborted) {
    currentClickController.abort();
  }
  currentClickController = null;
  await cleanupRendererInjection('deactivate');
  closeMainWebSocket();
  clearAllExtensionCaches();
  indexManager?.dispose();
  indexManager = null;
  log.info('Extension deactivated');
  log.dispose();
}
