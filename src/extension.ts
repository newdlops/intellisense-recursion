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
const IDENTIFIER_WORD_RE = /[A-Za-z_$][\w$]*/;
const HOVER_NEARBY_SYMBOL_COLUMN_RADIUS = 8;
const HOVER_NOISY_IDENTIFIER_MAX_LENGTH = 80;

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

function normalizePythonDecoratedDefinitionLine(doc: TextLikeDocument, line: number): number {
  if (!isPythonLikeDoc(doc)) { return line; }
  const clamped = Math.max(0, Math.min(line, Math.max(0, doc.lineCount - 1)));
  const initial = doc.lineAt(clamped).text.trim();
  if (!initial.startsWith('@')) { return clamped; }

  for (let i = clamped + 1; i < doc.lineCount; i++) {
    const trimmed = doc.lineAt(i).text.trim();
    if (!trimmed) { continue; }
    if (trimmed.startsWith('@')) { continue; }
    if (/^(class|def|async\s+def)\b/.test(trimmed)) { return i; }
    return clamped;
  }
  return clamped;
}

function textLikeLineDeclaresIdentifier(doc: TextLikeDocument, line: number, identifier: string): boolean {
  if (line < 0 || line >= doc.lineCount) { return false; }
  return declarationIdentifiersInLine(doc.lineAt(line).text).some(decl => decl.id === identifier);
}

function refineDefinitionLineForIdentifier(
  doc: TextLikeDocument,
  identifier: string,
  preferredLine: number,
): number {
  const clamped = Math.max(0, Math.min(preferredLine, Math.max(0, doc.lineCount - 1)));
  if (!identifier || textLikeLineDeclaresIdentifier(doc, clamped, identifier)) { return clamped; }

  const normalizedDecoratedLine = normalizePythonDecoratedDefinitionLine(doc, clamped);
  if (normalizedDecoratedLine !== clamped && textLikeLineDeclaresIdentifier(doc, normalizedDecoratedLine, identifier)) {
    return normalizedDecoratedLine;
  }

  const searchRadius = 120;
  for (let offset = 1; offset <= searchRadius; offset++) {
    const before = clamped - offset;
    if (textLikeLineDeclaresIdentifier(doc, before, identifier)) { return before; }
    const after = clamped + offset;
    if (textLikeLineDeclaresIdentifier(doc, after, identifier)) { return after; }
  }

  for (let i = 0; i < doc.lineCount; i++) {
    if (textLikeLineDeclaresIdentifier(doc, i, identifier)) { return i; }
  }

  return clamped;
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

function buildDefinitionPreviewResult(
  typeName: string,
  defUri: vscode.Uri,
  defDoc: vscode.TextDocument,
  startLine: number,
  hintedEndLine?: number,
): NonNullable<DefCacheEntry['result']> {
  const resolvedStartLine = refineDefinitionLineForIdentifier(defDoc, typeName, startLine);
  const previewBlock = collectDefinitionPreview(defDoc, resolvedStartLine, hintedEndLine);
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
  const resolvedStartLine = refineDefinitionLineForIdentifier(rawDoc, typeName, startLine);
  const previewBlock = collectDefinitionPreview(rawDoc, resolvedStartLine, hintedEndLine);
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
const rendererHoverFallbackTimers = new Set<ReturnType<typeof setTimeout>>();
const nativeHoverRefireScheduledKeys = new Set<string>();
const nativeHoverRefireLastAt = new Map<string, number>();
const NATIVE_HOVER_REFIRE_SUPPRESS_MS = 1600;
let rendererHoverFallbackLogCount = 0;
let extensionDeactivated = false;
let extensionRunsInTestMode = false;
let rendererUserDataDirHint: string | null = null;
let mainWsRefIsRendererTarget = false;
let testRendererWebSocketUrlRef: string | null = null;
let mainWsRefTargetUrl: string | null = null;
let lastTestRendererTargetLogSignature = '';
let lastClickId = '';
let lastClickTime = 0;
// A new click aborts an in-flight click via this controller.
let currentClickController: AbortController | null = null;
let hoverPatchActive = false;
// Current main-process CDP WebSocket, tracked so reconnect cleanup only
// clears the listener that originally owned the socket.
let mainWsRef: WebSocket | null = null;

interface NativeHoverRefireAnchor {
  uri: vscode.Uri;
  line: number;
  character: number;
}

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

async function resolvePreviewMarkdownUri(relPath: string): Promise<vscode.Uri | null> {
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

function parsePreviewMarkdownSource(markdown: string): {
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

function declarationIndexInLine(line: string, identifier: string): number | null {
  for (const decl of declarationIdentifiersInLine(line)) {
    if (decl.id === identifier) { return decl.index; }
  }
  return null;
}

function registerPreviewMarkdownLocations(
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

async function definitionProviderAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  ms: () => string,
  label: string,
): Promise<vscode.Location | null> {
  const defPromise = vscode.commands.executeCommand<any[]>(
    'vscode.executeDefinitionProvider',
    doc.uri,
    pos,
  );
  const defs = await Promise.race([
    defPromise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 2500)),
  ]);
  if (!defs?.length) { return null; }
  const def = normalizeDef(defs[0]);
  if (!def) { return null; }
  const isSameFile = def.uri.toString() === doc.uri.toString();
  const isSelfRef = isSameFile
    && def.range.start.line === pos.line
    && Math.abs(def.range.start.character - pos.character) < 3;
  if (isSelfRef) { return null; }
  log.info(`preview:   loc from ${label}+defProvider: ${vscode.workspace.asRelativePath(def.uri)}:${def.range.start.line + 1}:${def.range.start.character + 1} (${ms()})`);
  return new vscode.Location(def.uri, def.range);
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
  mainWsRefIsRendererTarget = false;
  testRendererWebSocketUrlRef = null;
  mainWsRefTargetUrl = null;
  if (!ws) { return; }
  try { ws.removeAllListeners(); } catch {}
  try { ws.close(); } catch {}
}

function isTestRendererDebugMode(): boolean {
  return extensionRunsInTestMode && !!process.env.IR_TEST_REMOTE_DEBUGGING_PORT;
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
  anchorUriKey: string;
  anchorLine: number;
  anchorCharacter: number;
  expiresAt: number;
  matchedAt?: number;
  matchCount?: number;
}
let pendingPreviewHover: PendingPreviewHover | null = null;
// After the override is delivered to the first handle, suppress only the
// parallel handles for the same hover request. This must be short and
// position-scoped; otherwise closing a drill-down and immediately reopening
// the original hover can be swallowed into an empty hover widget.
const PREVIEW_HOVER_SUPPRESS_MS = 90;
const PREVIEW_HOVER_SUPPRESS_MAX = 8;
const PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE = 1;
const PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE = 120;
let previewHoverSuppressUntil = 0;
let previewHoverSuppressKey: string | null = null;
let previewHoverSuppressCount = 0;
let previewHoverWrongRequestLogCount = 0;
let previewHoverDebugSeq = 0;
const previewHoverDebugEvents: any[] = [];
function recordPreviewHoverDebug(event: any): void {
  try {
    previewHoverDebugEvents.push({ seq: ++previewHoverDebugSeq, at: Date.now(), ...event });
    while (previewHoverDebugEvents.length > 80) { previewHoverDebugEvents.shift(); }
  } catch {}
}

function hoverRequestUriKey(uri: any): string {
  return uri?.scheme
    ? `${uri.scheme}://${uri.authority || ''}${uri.path}`
    : String(uri?.path || uri);
}

function internalHoverRangeContains(range: any, line: number, character: number): boolean {
  if (!range) { return false; }
  const startLine = range.startLineNumber ?? (range.start?.line !== undefined ? range.start.line + 1 : undefined);
  const startColumn = range.startColumn ?? (range.start?.character !== undefined ? range.start.character + 1 : undefined);
  const endLine = range.endLineNumber ?? (range.end?.line !== undefined ? range.end.line + 1 : undefined);
  const endColumn = range.endColumn ?? (range.end?.character !== undefined ? range.end.character + 1 : undefined);
  if (startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined) {
    return false;
  }
  const lineNumber = line + 1;
  const column = character + 1;
  if (lineNumber < startLine || lineNumber > endLine) { return false; }
  if (lineNumber === startLine && column < startColumn) { return false; }
  if (lineNumber === endLine && column > endColumn) { return false; }
  return true;
}

function pendingPreviewMatchesHoverRequest(
  preview: PendingPreviewHover,
  requestUriKey: string,
  requestLine: number,
  requestCharacter: number,
): boolean {
  if (preview.anchorUriKey !== requestUriKey) { return false; }
  if (internalHoverRangeContains(preview.range, requestLine, requestCharacter)) { return true; }
  if (preview.anchorLine === requestLine && preview.anchorCharacter === requestCharacter) { return true; }
  return Math.abs(preview.anchorLine - requestLine) <= PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE
    && Math.abs(preview.anchorCharacter - requestCharacter) <= PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE;
}

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
  scrollState?: PreviewScrollState;
  originScrollState?: PreviewScrollState;
}
interface PreviewScrollState {
  scrollerScrollTop?: number;
  hoverScrollTop?: number;
  rowScrollTop?: number;
  targetScrollTop?: number;
}
const previewHistory: PreviewState[] = [];
let currentPreviewState: PreviewState | null = null;

function previewStateMatchesHoverRequest(
  state: PreviewState,
  requestUriKey: string,
  requestLine: number,
  requestCharacter: number,
): boolean {
  if (hoverRequestUriKey(state.anchor.uri) !== requestUriKey) { return false; }
  const anchorRange = internalRangeFromVsCode(state.anchorRange);
  if (internalHoverRangeContains(anchorRange, requestLine, requestCharacter)) { return true; }
  if (state.anchor.line === requestLine && state.anchor.character === requestCharacter) { return true; }
  return Math.abs(state.anchor.line - requestLine) <= PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE
    && Math.abs(state.anchor.character - requestCharacter) <= PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE;
}

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
const previewClickDedupe = new Map<string, number>();
const PREVIEW_CLICK_DEDUPE_MS = 1500;
const PREVIEW_CLICK_DEDUPE_MAX = 200;
// Prefer updating the existing hover panel in-place. The native hide/show
// refire can be a no-op when focus has moved or VS Code decides there is no
// hover widget to reopen; in-place apply keeps the user's current hover alive.
// If no renderer target exists, applyPreviewStateAsHover falls back to the
// native refire path.
const PREVIEW_DIRECT_RENDERER_APPLY = false;
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
const HOVER_PREVIEW_SEPARATOR = '\n\n---\n';

function normalizeHoverMarkdownForDedupe(text: string): string {
  return text
    .split(IR_DIRECT_HOVER_MARKER).join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitHoverPreviewBlocks(markdown: string): string[] {
  return markdown
    .split(/\n\s*---\s*\n/g)
    .map(part => part.trim())
    .filter(Boolean);
}

function hoverMarkdownCodeFenceKeys(markdown: string): string[] {
  const out: string[] = [];
  const fenceRe = /```[\w-]*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    const key = normalizeHoverMarkdownForDedupe(match[1] ?? '');
    if (key) { out.push(`fence:${key}`); }
  }
  return out;
}

function hoverPreviewDedupeKeys(block: string): string[] {
  const keys: string[] = [];
  const blockKey = normalizeHoverMarkdownForDedupe(block);
  if (blockKey) { keys.push(`block:${blockKey}`); }
  keys.push(...hoverMarkdownCodeFenceKeys(block));
  return keys;
}

function dedupeHoverPreviewBlocks(blocks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const keys = hoverPreviewDedupeKeys(block);
    if (!keys.length || keys.some(key => seen.has(key))) { continue; }
    for (const key of keys) { seen.add(key); }
    out.push(block);
  }
  return out;
}

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

function preferDefinitionProviderForPreviewIdentifier(identifier: string): boolean {
  return identifier === 'classmethod' || identifier === 'staticmethod' || identifier === 'property';
}

function builtinDecoratorPreviewMarkdown(identifier: string): string | null {
  if (identifier === 'classmethod') {
    return [
      '`classmethod` — *builtins.pyi:1*',
      '```python',
      'class classmethod:',
      '    def __init__(self, method: object) -> None: ...',
      '```',
    ].join('\n');
  }
  if (identifier === 'staticmethod') {
    return [
      '`staticmethod` — *builtins.pyi:1*',
      '```python',
      'class staticmethod:',
      '    def __init__(self, method: object) -> None: ...',
      '```',
    ].join('\n');
  }
  if (identifier === 'property') {
    return [
      '`property` — *builtins.pyi:1*',
      '```python',
      'class property:',
      '    def __get__(self, obj: object, objtype: type | None = None) -> object: ...',
      '```',
    ].join('\n');
  }
  return null;
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
const hoverPreviewDeliveries = new Map<string, number>();
const HOVER_PREVIEW_DELIVERY_SUPPRESS_MS = 120;
const HOVER_PREVIEW_DELIVERY_MAX = 200;
const HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX = 30;
let hoverPreviewDeliverySuppressLogCount = 0;
interface HoverPreviewDeliveredBlockGroup {
  timestamp: number;
  blocks: Map<string, number>;
}
const hoverPreviewDeliveredBlocks = new Map<string, HoverPreviewDeliveredBlockGroup>();
const HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS = 2_500;
const HOVER_PREVIEW_BLOCK_DELIVERY_MAX_GROUPS = 200;
const HOVER_PREVIEW_BLOCK_DELIVERY_DEDUPE_ENABLED = true;
const hoverPreviewPrimaryHandles = new Map<string, { handle: number; cleanup: ReturnType<typeof setTimeout> | null }>();

function clearHoverPreviewPrimaryHandles() {
  for (const entry of hoverPreviewPrimaryHandles.values()) {
    if (entry.cleanup) { clearTimeout(entry.cleanup); }
  }
  hoverPreviewPrimaryHandles.clear();
}

function hoverPreviewPrimaryHandleAllowed(requestKey: string, handle: number): boolean {
  let entry = hoverPreviewPrimaryHandles.get(requestKey);
  if (!entry) {
    entry = { handle, cleanup: null };
    hoverPreviewPrimaryHandles.set(requestKey, entry);
  } else if (entry.cleanup) {
    clearTimeout(entry.cleanup);
  }
  const primary = entry.handle;
  entry.cleanup = setTimeout(() => {
    const current = hoverPreviewPrimaryHandles.get(requestKey);
    if (current?.handle === primary) {
      hoverPreviewPrimaryHandles.delete(requestKey);
    }
  }, 2000);
  return primary === handle;
}

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
function hoverPreviewDeliveryKey(posKey: string, previews: string): string {
  const normalized = normalizeHoverMarkdownForDedupe(previews);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${posKey}:${normalized.length}:${(hash >>> 0).toString(16)}`;
}
function shouldSuppressHoverPreviewDelivery(posKey: string, previews: string): boolean {
  const now = Date.now();
  for (const [key, ts] of hoverPreviewDeliveries) {
    if (now - ts > HOVER_PREVIEW_DELIVERY_SUPPRESS_MS) {
      hoverPreviewDeliveries.delete(key);
    }
  }
  const key = hoverPreviewDeliveryKey(posKey, previews);
  const prev = hoverPreviewDeliveries.get(key);
  if (prev && now - prev <= HOVER_PREVIEW_DELIVERY_SUPPRESS_MS) {
    return true;
  }
  while (hoverPreviewDeliveries.size >= HOVER_PREVIEW_DELIVERY_MAX) {
    const first = hoverPreviewDeliveries.keys().next().value;
    if (first === undefined) { break; }
    hoverPreviewDeliveries.delete(first);
  }
  hoverPreviewDeliveries.set(key, now);
  return false;
}

function pruneHoverPreviewDeliveredBlocks(now = Date.now()) {
  for (const [groupKey, group] of hoverPreviewDeliveredBlocks) {
    for (const [blockKey, ts] of group.blocks) {
      if (now - ts > HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS) {
        group.blocks.delete(blockKey);
      }
    }
    if (group.blocks.size === 0 || now - group.timestamp > HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS) {
      hoverPreviewDeliveredBlocks.delete(groupKey);
    }
  }
  while (hoverPreviewDeliveredBlocks.size > HOVER_PREVIEW_BLOCK_DELIVERY_MAX_GROUPS) {
    const first = hoverPreviewDeliveredBlocks.keys().next().value;
    if (first === undefined) { break; }
    hoverPreviewDeliveredBlocks.delete(first);
  }
}

function filterDeliveredHoverPreviewBlocks(existingText: string, previews: string, deliveryGroupKey: string): string {
  if (!HOVER_PREVIEW_BLOCK_DELIVERY_DEDUPE_ENABLED) { return previews; }
  const now = Date.now();
  pruneHoverPreviewDeliveredBlocks(now);
  const existingKeys = new Set<string>();
  for (const block of splitHoverPreviewBlocks(existingText)) {
    for (const key of hoverPreviewDedupeKeys(block)) { existingKeys.add(key); }
  }
  const out: string[] = [];
  let group = hoverPreviewDeliveredBlocks.get(deliveryGroupKey);
  for (const block of dedupeHoverPreviewBlocks(splitHoverPreviewBlocks(previews))) {
    const keys = hoverPreviewDedupeKeys(block);
    if (!keys.length || keys.some(key => existingKeys.has(key))) { continue; }
    const delivered = keys.some(key => {
      const prev = group?.blocks.get(key);
      return !!(prev && now - prev <= HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS);
    });
    if (delivered) { continue; }
    if (!group) {
      group = { timestamp: now, blocks: new Map<string, number>() };
      hoverPreviewDeliveredBlocks.set(deliveryGroupKey, group);
    }
    group.timestamp = now;
    for (const key of keys) { group.blocks.set(key, now); }
    out.push(block);
  }
  return out.join(HOVER_PREVIEW_SEPARATOR);
}

function logHoverPreviewDeliverySuppressed(message: string) {
  if (hoverPreviewDeliverySuppressLogCount >= HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX) { return; }
  hoverPreviewDeliverySuppressLogCount++;
  log.info(message);
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
  nearby: boolean;
}

function centerPositionOfRange(range: vscode.Range): vscode.Position {
  const width = Math.max(1, range.end.character - range.start.character);
  return new vscode.Position(range.start.line, range.start.character + Math.floor(width / 2));
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

function hoverWordCandidateFromRange(
  doc: vscode.TextDocument,
  range: vscode.Range,
  allowNoisyIdentifier: boolean,
  nearby = false,
): HoverWordCandidate | null {
  const name = doc.getText(range);
  if (!name
    || name.length <= 2
    || name.length > HOVER_NOISY_IDENTIFIER_MAX_LENGTH
    || SKIP_WORDS.has(name)) {
    return null;
  }
  if (TYPE_SHAPED_NAME.test(name) || CONSTANT_SHAPED_NAME.test(name)) {
    return { name, anchor: centerPositionOfRange(range), range, nearby };
  }
  if (/^[a-z_$][\w$]*$/.test(name)
    && (allowNoisyIdentifier || name.includes('_') || isCallableHoverContext(doc, range))) {
    return { name, anchor: centerPositionOfRange(range), range, nearby };
  }
  return null;
}

function nearbyHoverWordCandidateAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): HoverWordCandidate | null {
  if (position.line < 0 || position.line >= doc.lineCount) { return null; }
  const line = doc.lineAt(position.line).text;
  if (!line) { return null; }
  const target = Math.max(0, Math.min(position.character, line.length));
  const re = new RegExp(IDENTIFIER_WORD_RE.source, 'g');
  let best: { candidate: HoverWordCandidate; distance: number; exact: number; priority: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (target < start - HOVER_NEARBY_SYMBOL_COLUMN_RADIUS
      || target > end + HOVER_NEARBY_SYMBOL_COLUMN_RADIUS) {
      continue;
    }
    let distance = target < start ? start - target : target >= end ? target - end : 0;
    if (line.charAt(target) === '.' && start === target + 1) {
      distance = 0;
    } else if (target === end && line.charAt(target) === '.') {
      distance = HOVER_NEARBY_SYMBOL_COLUMN_RADIUS + 1;
    }
    const range = new vscode.Range(
      new vscode.Position(position.line, start),
      new vscode.Position(position.line, end),
    );
    const candidate = hoverWordCandidateFromRange(doc, range, true, true);
    if (!candidate) { continue; }
    const exact = target >= start && target < end ? 0 : 1;
    const priority = TYPE_SHAPED_NAME.test(candidate.name) || CONSTANT_SHAPED_NAME.test(candidate.name) ? 0 : 1;
    if (!best
      || exact < best.exact
      || distance < best.distance
      || (exact === best.exact && distance === best.distance && priority < best.priority)
      || (distance === best.distance && exact === best.exact && priority === best.priority
        && candidate.name.length > best.candidate.name.length)) {
      best = { candidate, distance, exact, priority };
    }
  }
  return best?.candidate ?? null;
}

function hoverWordCandidateAt(
  doc: vscode.TextDocument | undefined,
  position: vscode.Position,
): HoverWordCandidate | null {
  if (!doc) { return null; }
  const range = doc.getWordRangeAtPosition(position, IDENTIFIER_WORD_RE);
  if (range) {
    const line = position.line >= 0 && position.line < doc.lineCount ? doc.lineAt(position.line).text : '';
    const isMemberDotAfterWord = position.character === range.end.character && line.charAt(position.character) === '.';
    if (!isMemberDotAfterWord) {
      const exact = hoverWordCandidateFromRange(doc, range, true);
      if (exact) { return exact; }
    }
  }
  return nearbyHoverWordCandidateAt(doc, position);
}

function fullWordRangeAt(
  doc: vscode.TextDocument | undefined,
  position: vscode.Position,
): vscode.Range | undefined {
  if (!doc) { return undefined; }
  return doc.getWordRangeAtPosition(position, IDENTIFIER_WORD_RE)
    ?? nearbyHoverWordCandidateAt(doc, position)?.range
    ?? undefined;
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
  if (!candidate || (!candidate.nearby && !shouldDirectHoverCandidate(candidate.name))) { return null; }
  if (hoverPatchActive) { return null; }

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
  if (hoverPatchActive) {
    const posKey = `${doc.uri.path || doc.uri.toString()}:${position.line}:${position.character}`;
    if (shouldSuppressHoverPreviewDelivery(posKey, result.preview)) {
      logHoverPreviewDeliverySuppressed(`[directHover] "${candidate.name}" duplicate suppressed`);
      return null;
    }
  }
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
  hoverPreviewDeliveries.clear();
  hoverPreviewDeliveredBlocks.clear();
  clearHoverPreviewPrimaryHandles();
  hoverPreviewDeliverySuppressLogCount = 0;
  pendingPreviewHover = null;
  previewHoverSuppressUntil = 0;
  previewHoverSuppressKey = null;
  previewHoverSuppressCount = 0;
  previewHistory.length = 0;
  currentPreviewState = null;
  previewClickDedupe.clear();
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
  extensionRunsInTestMode = context.extensionMode === vscode.ExtensionMode.Test;
  rendererUserDataDirHint = process.env.IR_TEST_USER_DATA_DIR || deriveUserDataDirHint(context.globalStorageUri.fsPath);
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
    vscode.commands.registerCommand('intellisenseRecursion.previewType', previewTypeCommandHandler),
    vscode.commands.registerCommand('intellisenseRecursion.drillDown', previewTypeCommandHandler),
    vscode.commands.registerCommand('intellisenseRecursion.previewBack', previewBackHandler),
    vscode.commands.registerCommand('intellisenseRecursion.getPatchStatus', () => ({
      hoverPatchActive,
      hoverRecursionDepth,
      currentPreviewIdentifier: currentPreviewState?.identifier ?? null,
      currentPreviewMarkdown: currentPreviewState?.markdown ?? '',
      pendingPreviewIdentifier: pendingPreviewHover?.identifier ?? null,
      previewHoverDebugEvents: previewHoverDebugEvents.slice(-40),
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

  if (extensionRunsInTestMode) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverRendererHarnessForTests',
        runHoverRendererHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverSplitColumnHarnessForTests',
        runHoverSplitColumnHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runNativeHoverGeometryHarnessForTests',
        runNativeHoverGeometryHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runNativePopupStateHarnessForTests',
        runNativePopupStateHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.cleanupNativeHoverInteractionStateForTests',
        cleanupNativeHoverInteractionStateForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.dismissNativeKeybindingRecorderForTests',
        dismissNativeKeybindingRecorderForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.dispatchRendererMouseMoveForTests',
        dispatchRendererMouseMoveForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.dispatchRendererKeyForTests',
        dispatchRendererKeyForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverLinkClickHarnessForTests',
        runHoverLinkClickHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverBackButtonClickHarnessForTests',
        runHoverBackButtonClickHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverScrollHarnessForTests',
        runHoverScrollHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverDomStateHarnessForTests',
        runHoverDomStateHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
        runHoverSeedPreviewHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.resetPreviewStateForTests',
        async () => {
          pendingPreviewHover = null;
          previewHoverSuppressUntil = 0;
          previewHoverSuppressKey = null;
          previewHoverSuppressCount = 0;
          previewHistory.length = 0;
          currentPreviewState = null;
          previewClickDedupe.clear();
          try {
            await cleanupRendererTestArtifactsAcrossWindowsForTests();
            if (mainWsRef && mainWsRef.readyState === WebSocket.OPEN) {
              const rendererExpr = `
                (function(){
                  var removed=0;
                  var nodes=document.querySelectorAll('.ir-test-seeded-hover');
                  for(var i=0;i<nodes.length;i++){
                    try{if(nodes[i].parentNode){nodes[i].parentNode.removeChild(nodes[i]);removed++;}}catch(_){}
                  }
                  window.__irOriginalHoverSnapshot=null;
                  window.__irHistoryFor=null;
                  window.__irHistory=[];
                  window.__irHistoryCurrent=null;
                  window.__irLastPreviewTarget=null;
                  return {ok:true,removed:removed,patchVersion:Number(window.__irPatchVersion)||0};
                })()
              `.trim();
              await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 3000);
            }
          } catch {}
        },
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
    const existingText = hoverResultText(res);
    const existingKeys = new Set<string>();
    for (const block of splitHoverPreviewBlocks(existingText)) {
      for (const key of hoverPreviewDedupeKeys(block)) { existingKeys.add(key); }
    }
    const previewBlocks = dedupeHoverPreviewBlocks(splitHoverPreviewBlocks(previews))
      .filter(block => {
        const keys = hoverPreviewDedupeKeys(block);
        return keys.length > 0 && !keys.some(key => existingKeys.has(key));
      });
    const dedupedPreviews = previewBlocks.join(HOVER_PREVIEW_SEPARATOR);
    if (!dedupedPreviews) {
      return hoverRange ? { ...res, range: hoverRange ?? res?.range } : res;
    }
    if (!res?.contents?.length) {
      return {
        contents: [{ value: dedupedPreviews, isTrusted: true, supportThemeIcons: true }],
        range,
      };
    }
    const newContents = [...res.contents];
    let attached = false;
    for (let ci = 0; ci < newContents.length; ci++) {
      if (newContents[ci]?.value && typeof newContents[ci].value === 'string') {
        newContents[ci] = { ...newContents[ci], value: newContents[ci].value + HOVER_PREVIEW_SEPARATOR + dedupedPreviews };
        attached = true;
        break;
      }
    }
    if (!attached) {
      newContents.push({ value: dedupedPreviews, isTrusted: true, supportThemeIcons: true });
    }
    return { ...res, contents: newContents, range: hoverRange ?? res.range };
  }

  function resultWithoutDuplicatePreview(res: any, hoverRange?: any): any {
    if (res?.contents?.length) {
      return hoverRange ? { ...res, range: hoverRange ?? res.range } : res;
    }
    return null;
  }

  function attachPreviewsOnce(
    res: any,
    previews: string,
    position: any,
    hoverRange: any,
    deliveryGroupKey: string,
    reason: string,
    primaryHoverHandle: boolean,
  ): any {
    const deliverablePreviews = filterDeliveredHoverPreviewBlocks(hoverResultText(res), previews, deliveryGroupKey);
    if (!deliverablePreviews) {
      if (primaryHoverHandle) {
        return attachPreviews(res, previews, position, hoverRange);
      }
      logHoverPreviewDeliverySuppressed(`[hover] duplicate preview suppressed ${reason}`);
      return resultWithoutDuplicatePreview(res, hoverRange);
    }
    if (!primaryHoverHandle && shouldSuppressHoverPreviewDelivery(deliveryGroupKey, deliverablePreviews)) {
      logHoverPreviewDeliverySuppressed(`[hover] duplicate preview suppressed ${reason}`);
      return resultWithoutDuplicatePreview(res, hoverRange);
    }
    return attachPreviews(res, deliverablePreviews, position, hoverRange);
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
    const requestLine = position?.lineNumber !== undefined ? position.lineNumber - 1 : (position?.line ?? 0);
    const requestChar = position?.column !== undefined ? position.column - 1 : (position?.character ?? 0);
    const requestUriKey = hoverRequestUriKey(uri);
    const hoverRequestKey = `${requestUriKey}:${requestLine}:${requestChar}`;

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
    if (pendingPreviewHover
      && Date.now() < pendingPreviewHover.expiresAt
      && pendingPreviewMatchesHoverRequest(pendingPreviewHover, requestUriKey, requestLine, requestChar)) {
      const preview = pendingPreviewHover;
      const matchedAt = Date.now();
      preview.matchedAt = matchedAt;
      preview.matchCount = (preview.matchCount ?? 0) + 1;
      preview.expiresAt = Math.min(preview.expiresAt, matchedAt + 1800);
      recordPreviewHoverDebug({
        kind: "pending-match",
        handle,
        identifier: preview.identifier,
        requestUriKey,
        requestLine,
        requestChar,
        anchorLine: preview.anchorLine,
        anchorCharacter: preview.anchorCharacter,
        hasRange: !!preview.range,
        matchCount: preview.matchCount,
        contentsLength: hoverResultText({ contents: preview.contents }).length,
      });
      // Keep the redirect alive for every provider handle in this native
      // showHover fanout. VS Code may render a later handle, not the first
      // one that reaches us; consuming the preview on the first hit can leave
      // the visible hover widget with an empty/null provider result.
      log.info(`[hover] page-transition handle=${handle} → "${preview.identifier}"`);
      const ln = position?.lineNumber !== undefined ? position.lineNumber : (position?.line !== undefined ? position.line + 1 : 1);
      const col = position?.column !== undefined ? position.column : (position?.character !== undefined ? position.character + 1 : 1);
      const pointRange = { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col };
      return {
        contents: preview.contents,
        range: preview.range ?? pointRange,
      };
    }
    if (pendingPreviewHover && Date.now() >= pendingPreviewHover.expiresAt) {
      log.info(`[hover] page-transition pending "${pendingPreviewHover.identifier}" expired before matching request`);
      recordPreviewHoverDebug({ kind: "pending-expired", identifier: pendingPreviewHover.identifier, requestUriKey, requestLine, requestChar });
      pendingPreviewHover = null;
    } else if (pendingPreviewHover?.matchedAt && Date.now() - pendingPreviewHover.matchedAt > 120) {
      recordPreviewHoverDebug({
        kind: "pending-cleared-after-match",
        identifier: pendingPreviewHover.identifier,
        requestUriKey,
        requestLine,
        requestChar,
        anchorLine: pendingPreviewHover.anchorLine,
        anchorCharacter: pendingPreviewHover.anchorCharacter,
        ageMs: Date.now() - pendingPreviewHover.matchedAt,
        matchCount: pendingPreviewHover.matchCount ?? 0,
      });
      pendingPreviewHover = null;
    } else if (pendingPreviewHover?.matchedAt) {
      recordPreviewHoverDebug({
        kind: "pending-ignored-during-match-fanout",
        identifier: pendingPreviewHover.identifier,
        requestUriKey,
        requestLine,
        requestChar,
        ageMs: Date.now() - pendingPreviewHover.matchedAt,
      });
      return null;
    } else if (pendingPreviewHover && previewHoverWrongRequestLogCount < 30) {
      previewHoverWrongRequestLogCount++;
      log.info(`[hover] page-transition pending "${pendingPreviewHover.identifier}" ignored non-anchor request ${requestUriKey}:${requestLine}:${requestChar}`);
      recordPreviewHoverDebug({ kind: "pending-ignored", identifier: pendingPreviewHover.identifier, requestUriKey, requestLine, requestChar, anchorLine: pendingPreviewHover.anchorLine, anchorCharacter: pendingPreviewHover.anchorCharacter });
      return null;
    } else if (pendingPreviewHover) {
      return null;
    }
    // Suppression branch: parallel handles in the same showHover fanout return
    // null so the override isn't duplicated across providers and an empty
    // hover object cannot replace the populated one.
    if (Date.now() < previewHoverSuppressUntil
      && previewHoverSuppressKey === hoverRequestKey
      && previewHoverSuppressCount < PREVIEW_HOVER_SUPPRESS_MAX) {
      previewHoverSuppressCount++;
      log.info(`[hover] page-transition handle=${handle} suppressed (in window)`);
      return null;
    }
    if (Date.now() >= previewHoverSuppressUntil || previewHoverSuppressKey !== hoverRequestKey) {
      previewHoverSuppressUntil = 0;
      previewHoverSuppressKey = null;
      previewHoverSuppressCount = 0;
    }

    // Drill-down history reset: reaching this point means we've passed
    // both the pending-preview consume and the post-consume suppression
    // window, so this is a genuine LSP hover. VS Code may still issue
    // late native hovers at the same anchor after rendering a preview;
    // those are part of the current drill-down session and must not clear
    // the stack. A request at a different anchor is a new hover session.
    if (currentPreviewState) {
      if (!previewStateMatchesHoverRequest(currentPreviewState, requestUriKey, requestLine, requestChar)) {
        log.info(`[hover] drill-down history reset on fresh LSP hover (was at "${currentPreviewState.identifier}", stack=${previewHistory.length})`);
        previewHistory.length = 0;
        currentPreviewState = null;
      }
    }

    // Canonical position key (0-based, stable across internal vs API shapes)
    const apiLine = requestLine;
    const apiChar = requestChar;
    const docUriStr = uri?.scheme ? `${uri.scheme}://${uri.authority || ''}${uri.path}` : String(uri);
    const docUri = vscode.Uri.parse(docUriStr);
    const hoverApiPos = new vscode.Position(apiLine, apiChar);
    const hoverDocForCandidate = findOpenDoc(docUri);
    const hoveredCandidate = hoverWordCandidateAt(hoverDocForCandidate, hoverApiPos);
    const anchorForCache = hoveredCandidate?.anchor ?? hoverApiPos;
    const posKey = `${uri?.path || uri}:${anchorForCache.line}:${anchorForCache.character}`;
    const deliveryGroupKey = hoverRequestKey;
    if (hoveredCandidate) {
      lastHoverFetchPosition = {
        uri: docUri,
        line: hoveredCandidate.anchor.line,
        character: hoveredCandidate.anchor.character,
      };
    }
    const hoveredInternalRange = hoveredCandidate
      ? internalRangeFromVsCode(hoveredCandidate.range)
      : internalFullWordRangeAt(hoverDocForCandidate, hoverApiPos);

    const result = await original.call(this, handle, uri, position, context, token);
    const postNativeT0 = Date.now();
    if (hoverResultText(result).includes(IR_DIRECT_HOVER_MARKER)) { return result; }
    const primaryHoverHandle = hoveredCandidate
      ? hoverPreviewPrimaryHandleAllowed(hoverRequestKey, handle)
      : true;
    if (!result?.contents?.length && hoveredCandidate && !primaryHoverHandle) {
      return null;
    }
    if (!result?.contents?.length && !hoveredCandidate) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    const returnWithNativeFallback = (value: any, source: string): any => {
      if (hoveredCandidate && primaryHoverHandle && value?.contents?.length) {
        const markdown = hoverResultText(value);
        if (markdown.trim().length > 20) {
          scheduleRendererNativeHoverFallback(hoveredCandidate.name, markdown, source, {
            uri: docUri,
            line: anchorForCache.line,
            character: anchorForCache.character,
          });
        }
      }
      return value;
    };

    // Prefer the exact word under the cursor, then supplement with type names
    // discovered in native hover code fences. This covers symbols where the
    // language server has definition data but no hover text.
    const skipDirectClassPreview = hoveredCandidate
      ? nativeHoverHasClassLikeSource(result, hoveredCandidate.name)
      : false;
    const directCandidateNeedsFallback = hoveredCandidate
      ? shouldDirectHoverCandidate(hoveredCandidate.name)
        || !result?.contents?.length
        || !skipDirectClassPreview
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
      const nativeResult = hoveredInternalRange && result?.contents?.length
        ? { ...result, range: hoveredInternalRange }
        : result;
      return returnWithNativeFallback(nativeResult, 'native-only');
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
      return returnWithNativeFallback(attachPreviewsOnce(
        result,
        cachedPreviews,
        position,
        hoveredInternalRange,
        deliveryGroupKey,
        `handle=${handle} source=pos-cache`,
        primaryHoverHandle,
      ), 'pos-cache');
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
        return returnWithNativeFallback(attachPreviewsOnce(
          result,
          computed.previews,
          position,
          hoveredInternalRange,
          deliveryGroupKey,
          `handle=${handle} source=inflight`,
          primaryHoverHandle,
        ), 'inflight');
      }
      log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} INFLIGHT empty (${hoverMs()}, post=${postNativeMs()})`);
      return returnWithNativeFallback(result, 'inflight-empty');
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
      const previewSeen = new Set<string>();
      for (const r of typeResults) {
        if (!r) { continue; }
        const key = normalizeHoverMarkdownForDedupe(r);
        if (!key || previewSeen.has(key)) { continue; }
        previewSeen.add(key);
        previewsOut.push(r);
      }
      if (previewsOut.length === 0) { return null; }
      const previews = previewsOut.join(HOVER_PREVIEW_SEPARATOR);
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
        return returnWithNativeFallback(attachPreviewsOnce(
          result,
          computed.previews,
          position,
          hoveredInternalRange,
          deliveryGroupKey,
          `handle=${handle} source=first`,
          primaryHoverHandle,
        ), 'first');
      }
    } catch (err) {
      log.error(`[hover] compute error: ${err} (${hoverMs()})`);
    } finally {
      hoverRecursionDepth--;
      inflightHoverPreviews.delete(inflightKey);
    }

    log.info(`[hover] done: no definition preview resolved; returning native hover (${hoverMs()}, post=${postNativeMs()})`);
    return returnWithNativeFallback(result, 'unresolved');
  };

  hoverPatchActive = true;
  log.info('$provideHover patched');
}

// ── Renderer injection via main process CDP ──

const RENDERER_PATCH_VERSION = 169;

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

function deriveUserDataDirHint(globalStorageFsPath: string): string | null {
  const marker = `${path.sep}User${path.sep}globalStorage${path.sep}`;
  const idx = globalStorageFsPath.indexOf(marker);
  return idx >= 0 ? globalStorageFsPath.slice(0, idx) : null;
}

function commandHasUserDataDir(command: string, userDataDir: string): boolean {
  if (!command || !userDataDir) { return false; }
  return command.includes(`--user-data-dir=${userDataDir}`)
    || command.includes(`--user-data-dir ${userDataDir}`)
    || command.includes(`--user-data-dir="${userDataDir}"`)
    || command.includes(`--user-data-dir "${userDataDir}"`)
    || command.includes(`--user-data-dir='${userDataDir}'`);
}

function findCurrentVSCodeMainPid(): number | null {
  const rows = listProcessRows();
  if (!rows.length) { return null; }
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) { byPid.set(row.pid, row); }
  const mainRows = rows.filter(row => isVSCodeMainProcessCommand(row.command));

  if (rendererUserDataDirHint) {
    const hinted = mainRows.filter(row => commandHasUserDataDir(row.command, rendererUserDataDirHint!));
    if (hinted.length === 1) { return hinted[0].pid; }
    if (hinted.length > 1) {
      log.warn(`[inject] multiple VS Code main processes match user-data-dir hint; skipping renderer injection (${hinted.map(row => row.pid).join(',')})`);
      return null;
    }
    if (extensionRunsInTestMode) {
      log.warn(`[inject] test-mode renderer injection: no VS Code main process matched user-data-dir ${rendererUserDataDirHint}; trying extension-host parent/env PID only`);
    }
  }

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

  if (process.env.IR_SKIP_RENDERER_INJECTION === '1') {
    log.warn('[inject] test-mode renderer injection could not identify a matching VS Code main process');
    return null;
  }
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

function cdpRequest(ws: WebSocket, method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000);
    let done = false;
    const finish = (err: Error | null, value?: any) => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.off('message', onMessage); } catch {}
      if (err) { reject(err); } else { resolve(value); }
    };
    const timeout = setTimeout(() => {
      const err = new Error(`CDP ${method} timed out`);
      finish(err);
      if (ws === mainWsRef && method !== 'Input.dispatchMouseEvent') {
        log.warn(`[cdp] ${method} timed out; dropping stale renderer CDP socket`);
        closeMainWebSocket();
      }
    }, timeoutMs);
    const onMessage = (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id !== id) { return; }
        if (resp.error) {
          finish(new Error(resp.error.message || String(resp.error)));
          return;
        }
        finish(null, resp.result);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function findTestRendererWebSocketUrl(): Promise<string | null> {
  const port = Number(process.env.IR_TEST_REMOTE_DEBUGGING_PORT || '');
  if (!port) { return null; }
  const marker = process.env.IR_TEST_WINDOW_MARKER || '';
  for (let attempt = 0; attempt < 40; attempt++) {
    let targets: any[] = [];
    try {
      targets = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const candidates = (targets || []).filter(target => {
      const wsUrl = String(target?.webSocketDebuggerUrl || '');
      const url = String(target?.url || '');
      return wsUrl && (/workbench/i.test(url) || /vscode-file:|vscode-app:/i.test(url));
    });
    if (!candidates.length && targets?.length) {
      candidates.push(...targets.filter(target => String(target?.webSocketDebuggerUrl || '')));
    }
    if (!marker) {
      const first = candidates[0]?.webSocketDebuggerUrl;
      if (first) { return String(first); }
    }
    const probeSummaries: string[] = [];
    for (const candidate of candidates) {
      const wsUrl = String(candidate?.webSocketDebuggerUrl || '');
      if (!wsUrl) { continue; }
      const ws = new WebSocket(wsUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
          setTimeout(() => reject(new Error('test renderer target connect timed out')), 1000);
        });
        await cdpRequest(ws, 'Runtime.enable', {}, 1000).catch(() => undefined);
        const probe = await cdpRequest(ws, 'Runtime.evaluate', {
          expression: `(function(){var m=${JSON.stringify(marker)};var b=String(document.body&&document.body.textContent||'');return {title:String(document.title||''),href:String(location&&location.href||''),bodyHasMarker:!!(m&&b.indexOf(m)>=0),titleHasMarker:!!(m&&String(document.title||'').indexOf(m)>=0),bodySample:b.replace(/\\s+/g,' ').slice(0,160)}})()`,
          returnByValue: true,
        }, 1500);
        const value = probe?.result?.value;
        probeSummaries.push([
          `title=${JSON.stringify(String(value?.title || '').slice(0, 120))}`,
          `bodyMarker=${value?.bodyHasMarker ? '1' : '0'}`,
          `titleMarker=${value?.titleHasMarker ? '1' : '0'}`,
          `targetUrl=${JSON.stringify(String(candidate?.url || value?.href || '').slice(0, 160))}`,
          `body=${JSON.stringify(String(value?.bodySample || '').slice(0, 120))}`,
        ].join(' '));
        if (value?.bodyHasMarker || value?.titleHasMarker) {
          const signature = `match:${wsUrl}:${probeSummaries[probeSummaries.length - 1] || ''}`;
          if (signature !== lastTestRendererTargetLogSignature) {
            lastTestRendererTargetLogSignature = signature;
            log.info(`[cdp] test renderer target matched attempt=${attempt + 1} ${probeSummaries[probeSummaries.length - 1] || ''}`);
          }
          return wsUrl;
        }
      } catch (err) {
        probeSummaries.push(`probe-error targetUrl=${JSON.stringify(String(candidate?.url || '').slice(0, 160))} error=${JSON.stringify(String(err instanceof Error ? err.message : err).slice(0, 160))}`);
        // Try the next target.
      } finally {
        try { ws.close(); } catch {}
      }
    }
    if (probeSummaries.length) {
      const signature = `miss:${marker}:${probeSummaries.join(' | ')}`;
      if (signature !== lastTestRendererTargetLogSignature) {
        lastTestRendererTargetLogSignature = signature;
        log.info(`[cdp] test renderer target scan attempt=${attempt + 1} marker=${marker ? JSON.stringify(marker) : '(none)'} ${probeSummaries.join(' | ')}`);
      }
    }
    if (candidates.length === 1 && !marker) {
      return String(candidates[0].webSocketDebuggerUrl || '') || null;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (marker) {
    log.warn(`[cdp] test renderer target not found for marker ${JSON.stringify(marker)}`);
  }
  return null;
}

async function withRendererInputCdpSessionForTests<T>(
  fn: (ws: WebSocket, mode: string) => Promise<T>,
): Promise<T> {
  if (isTestRendererDebugMode()) {
    try {
      const wsUrl = await findTestRendererWebSocketUrl();
      if (wsUrl) {
        testRendererWebSocketUrlRef = wsUrl;
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (err?: Error) => {
            if (done) { return; }
            done = true;
            clearTimeout(timeout);
            if (err) { reject(err); } else { resolve(); }
          };
          const timeout = setTimeout(() => finish(new Error('test renderer input CDP connect timed out')), 3000);
          ws.once('open', () => finish());
          ws.once('error', err => finish(err instanceof Error ? err : new Error(String(err))));
        });
        try {
          await cdpRequest(ws, 'Runtime.enable', {}, 1500).catch(() => undefined);
          return await fn(ws, 'fresh-test-renderer');
        } finally {
          try { ws.close(); } catch {}
        }
      }
    } catch (err) {
      log.warn(`[cdp] fresh test renderer input session failed: ${err}`);
    }
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    throw new Error('renderer CDP socket is not open');
  }
  return fn(mainWsRef, mainWsRefIsRendererTarget ? 'main-renderer-ref' : 'main-process-ref');
}

async function injectRendererViaTestRemoteDebugging() {
    try {
      const wsUrl = await findTestRendererWebSocketUrl();
      if (!wsUrl) {
        log.warn('[inject] test renderer CDP target not found');
        return;
      }
      testRendererWebSocketUrlRef = wsUrl;
      const ws = new WebSocket(wsUrl);
      (ws as any).__irTargetWsUrl = wsUrl;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('test renderer CDP connect timed out')), 3000);
    });
    await cdpRequest(ws, 'Runtime.enable', {}, 3000).catch(() => undefined);
    await cdpRequest(ws, 'Runtime.addBinding', { name: 'irGoToType' }, 3000).catch(err => {
      if (!/already|exists|duplicate/i.test(String(err && err.message || err))) { throw err; }
    });
    const rendererMetaExpr = `try{window.__irHostWindowMeta=${JSON.stringify({
      id: 'test-renderer',
      title: 'test-renderer',
      url: '',
      phase: 'test-remote',
    })};window.__irHostWindowId='test-renderer';window.__irHostWindowTitle='test-renderer';}catch(_){}`;
    await cdpRequest(ws, 'Runtime.evaluate', {
      expression: rendererMetaExpr,
      includeCommandLineAPI: true,
      returnByValue: true,
    }, 3000).catch(() => undefined);
    const evalExpr = makeRendererEvalExpression(getHoverPatchScript());
    const result = await cdpRequest(ws, 'Runtime.evaluate', {
      expression: evalExpr,
      includeCommandLineAPI: true,
      returnByValue: true,
      awaitPromise: true,
    }, 8000);
    const value = result?.result?.value;
    log.info(`[inject] test renderer injection: ${value || 'ok'}`);
    startClickListener(ws, true);
  } catch (err) {
    log.warn(`[inject] test renderer injection failed: ${err}`);
  }
}

async function injectRenderer() {
  if (isTestRendererDebugMode()) {
    await injectRendererViaTestRemoteDebugging();
    return;
  }
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

    const wsUrl = await findInspectorWebSocketUrlForPid(mainPid);
    if (!wsUrl) {
      log.warn('[inject] No matching CDP WebSocket URL found');
      return;
    }
    log.info(`[inject] Connecting WebSocket...`);
    const ws = new WebSocket(wsUrl);
    const workspacePathForRenderer = workspaceRootFsPath() ?? '';
    const workspaceNameForRenderer = workspacePathForRenderer ? path.basename(workspacePathForRenderer) : '';

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
            var workspacePath = ${JSON.stringify(workspacePathForRenderer)};
            var workspaceName = ${JSON.stringify(workspaceNameForRenderer)};
            var results = [];
            function decodeMaybe(s) { try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); } }
            function windowTitle(w) { try { return String((w.getTitle && w.getTitle()) || ''); } catch (_) { return ''; } }
            function windowUrl(w) { try { return String(w.webContents && w.webContents.getURL && w.webContents.getURL() || ''); } catch (_) { return ''; } }
            function isCandidateWindow(w) {
              try {
                if (!w || (w.isDestroyed && w.isDestroyed())) return false;
                if (!w.webContents || (w.webContents.isDestroyed && w.webContents.isDestroyed())) return false;
                var title = windowTitle(w);
                var url = windowUrl(w);
                if (/Developer Tools/i.test(title) || /devtools:/i.test(url)) return false;
                return true;
              } catch (_) {
                return false;
              }
            }
            function windowMatchesWorkspace(w) {
              var title = windowTitle(w);
              var url = windowUrl(w);
              var decodedUrl = decodeMaybe(url);
              var encodedWorkspace = workspacePath ? encodeURIComponent(workspacePath) : '';
              return !!(
                (workspacePath && (
                  url.indexOf(workspacePath) >= 0
                  || decodedUrl.indexOf(workspacePath) >= 0
                  || (encodedWorkspace && url.indexOf(encodedWorkspace) >= 0)
                ))
                || (workspaceName && title.indexOf(workspaceName) >= 0)
              );
            }
            function chooseInjectionWindows(list) {
              var candidates = [];
              for (var ci = 0; ci < list.length; ci++) {
                if (isCandidateWindow(list[ci])) candidates.push(list[ci]);
              }
              if (!candidates.length) return [];
              var matched = [];
              if (workspacePath || workspaceName) {
                for (var mi = 0; mi < candidates.length; mi++) {
                  if (windowMatchesWorkspace(candidates[mi])) matched.push(candidates[mi]);
                }
                if (matched.length) return matched;
              }
              var focused = [];
              for (var fi = 0; fi < candidates.length; fi++) {
                try { if (candidates[fi].isFocused && candidates[fi].isFocused()) focused.push(candidates[fi]); } catch (_) {}
              }
              if (focused.length) return focused;
              if (candidates.length === 1) return candidates;
              var visible = [];
              for (var vi = 0; vi < candidates.length; vi++) {
                try { if (candidates[vi].isVisible && candidates[vi].isVisible()) visible.push(candidates[vi]); } catch (_) {}
              }
              return visible.length ? [visible[0]] : [];
            }
            wins = chooseInjectionWindows(wins);
            if (!wins.length) {
              return 'no target renderer window for workspace ' + (workspacePath || workspaceName || '(none)');
            }
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
            async function setRendererMeta(w, phase) {
              try {
                var title = windowTitle(w);
                var url = windowUrl(w);
                var meta = {
                  id: w.id,
                  title: title.slice(0, 160),
                  url: url.slice(0, 240),
                  workspaceName: workspaceName,
                  workspacePath: workspacePath,
                  phase: phase
                };
                var expr = 'try{window.__irHostWindowMeta=' + JSON.stringify(meta)
                  + ';window.__irHostWindowId=' + JSON.stringify(String(w.id))
                  + ';window.__irHostWindowTitle=' + JSON.stringify(meta.title)
                  + ';}catch(_){}';
                await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true });
              } catch(eMeta) {}
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
                await setRendererMeta(w, 'initial');
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
                  results.push('injected:' + w.id + ':' + windowTitle(w).replace(/\\s+/g, ' ').slice(0, 80) + '(' + value + ')');
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
  if (isTestRendererDebugMode()) {
    await injectRendererViaTestRemoteDebugging();
    return;
  }
  try {
    if (extensionDeactivated) { return; }
    const mainPid = findCurrentVSCodeMainPid();
    if (!mainPid) { return; }
    process.kill(mainPid, 'SIGUSR1');
    await new Promise(r => setTimeout(r, 150));
    const wsUrl = await findInspectorWebSocketUrlForPid(mainPid);
    if (!wsUrl) { return; }

    const ws = new WebSocket(wsUrl);
    const workspacePathForRenderer = workspaceRootFsPath() ?? '';
    const workspaceNameForRenderer = workspacePathForRenderer ? path.basename(workspacePathForRenderer) : '';

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
            var workspacePath = ${JSON.stringify(workspacePathForRenderer)};
            var workspaceName = ${JSON.stringify(workspaceNameForRenderer)};
            var n = 0;
            function decodeMaybe(s) { try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); } }
            function windowTitle(w) { try { return String((w.getTitle && w.getTitle()) || ''); } catch (_) { return ''; } }
            function windowUrl(w) { try { return String(w.webContents && w.webContents.getURL && w.webContents.getURL() || ''); } catch (_) { return ''; } }
            function isCandidateWindow(w) {
              try {
                if (!w || (w.isDestroyed && w.isDestroyed())) return false;
                if (!w.webContents || (w.webContents.isDestroyed && w.webContents.isDestroyed())) return false;
                var title = windowTitle(w);
                var url = windowUrl(w);
                if (/Developer Tools/i.test(title) || /devtools:/i.test(url)) return false;
                return true;
              } catch (_) {
                return false;
              }
            }
            function windowMatchesWorkspace(w) {
              var title = windowTitle(w);
              var url = windowUrl(w);
              var decodedUrl = decodeMaybe(url);
              var encodedWorkspace = workspacePath ? encodeURIComponent(workspacePath) : '';
              return !!(
                (workspacePath && (
                  url.indexOf(workspacePath) >= 0
                  || decodedUrl.indexOf(workspacePath) >= 0
                  || (encodedWorkspace && url.indexOf(encodedWorkspace) >= 0)
                ))
                || (workspaceName && title.indexOf(workspaceName) >= 0)
              );
            }
            function chooseInjectionWindows(list) {
              var candidates = [];
              for (var ci = 0; ci < list.length; ci++) {
                if (isCandidateWindow(list[ci])) candidates.push(list[ci]);
              }
              if (!candidates.length) return [];
              var matched = [];
              if (workspacePath || workspaceName) {
                for (var mi = 0; mi < candidates.length; mi++) {
                  if (windowMatchesWorkspace(candidates[mi])) matched.push(candidates[mi]);
                }
                if (matched.length) return matched;
              }
              var focused = [];
              for (var fi = 0; fi < candidates.length; fi++) {
                try { if (candidates[fi].isFocused && candidates[fi].isFocused()) focused.push(candidates[fi]); } catch (_) {}
              }
              if (focused.length) return focused;
              if (candidates.length === 1) return candidates;
              var visible = [];
              for (var vi = 0; vi < candidates.length; vi++) {
                try { if (candidates[vi].isVisible && candidates[vi].isVisible()) visible.push(candidates[vi]); } catch (_) {}
              }
              return visible.length ? [visible[0]] : [];
            }
            wins = chooseInjectionWindows(wins);
            async function installedVersion(w) {
              try {
                var chk = await w.webContents.debugger.sendCommand('Runtime.evaluate', {
                  expression: 'Number(window.__irPatchVersion)||0',
                  returnByValue: true
                });
                return Number(chk && chk.result && chk.result.value) || 0;
              } catch(eChk) { return 0; }
            }
            async function setRendererMeta(w, phase) {
              try {
                var title = windowTitle(w);
                var url = windowUrl(w);
                var meta = {
                  id: w.id,
                  title: title.slice(0, 160),
                  url: url.slice(0, 240),
                  workspaceName: workspaceName,
                  workspacePath: workspacePath,
                  phase: phase
                };
                var expr = 'try{window.__irHostWindowMeta=' + JSON.stringify(meta)
                  + ';window.__irHostWindowId=' + JSON.stringify(String(w.id))
                  + ';window.__irHostWindowTitle=' + JSON.stringify(meta.title)
                  + ';}catch(_){}';
                await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true });
              } catch(eMeta) {}
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
                await setRendererMeta(w, 'reinject');
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

function startClickListener(mainWs: any, isRendererTarget = false) {
  if (mainWsRef && mainWsRef !== mainWs) {
    closeMainWebSocket();
  }
  clearRendererReconnectTimer();
  mainWsRef = mainWs;
  mainWsRefIsRendererTarget = isRendererTarget;
  mainWsRefTargetUrl = typeof mainWs.__irTargetWsUrl === 'string' ? mainWs.__irTargetWsUrl : null;
  if (mainWs.__irClickListenerStarted) { return; }
  mainWs.__irClickListenerStarted = true;
  log.info('[listen] Click event listener started (binding-driven)');

  mainWs.on('message', (data: string) => {
    try {
      const resp = JSON.parse(data);
      if (resp.method === 'Runtime.bindingCalled'
        && (resp.params?.name === 'irClickNotify' || resp.params?.name === 'irGoToType')) {
        const val = String(resp.params.payload);
        if (val.startsWith('LOG:')) {
          log.info(`[renderer] ${val.substring(4)}`);
          return;
        }
        if (val.startsWith('SEND:')) {
          log.info(`[send] ${val.substring(5)}`);
          return;
        }
        if (val === 'HIDE_HOVER' || val.startsWith('HIDE_HOVER:')) {
          vscode.commands.executeCommand('editor.action.hideHover')
            .then(
              () => log.info(`[renderer] hide hover requested${val.startsWith('HIDE_HOVER:') ? ` ${val.substring('HIDE_HOVER:'.length)}` : ''}`),
              err => log.warn(`[renderer] hide hover request failed: ${err}`),
            );
          return;
        }
        if (val === 'SHOW_HOVER' || val.startsWith('SHOW_HOVER:')) {
          const reason = val.startsWith('SHOW_HOVER:') ? val.substring('SHOW_HOVER:'.length) : '';
          void (async () => {
            try {
              await vscode.commands.executeCommand('editor.action.hideHover');
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 90));
            try {
              await vscode.commands.executeCommand('editor.action.showHover');
              log.info(`[renderer] native show hover requested${reason ? ` ${reason}` : ''}`);
            } catch (err) {
              log.warn(`[renderer] native show hover request failed${reason ? ` ${reason}` : ''}: ${err}`);
            }
          })();
          return;
        }

        // Debounce: ignore duplicate clicks for same identifier within 300ms
        const now = Date.now();
        if (val === lastClickId && now - lastClickTime < 300) { return; }
        lastClickId = val;
        lastClickTime = now;

        log.info(`Click: "${val}"`);
        const editor = vscode.window.activeTextEditor;
        const docUri = lastHoverFetchPosition?.uri.toString()
          || lastHoverDocUri
          || editor?.document.uri.toString()
          || '';

        if (val === 'BACK') {
          previewBackHandler().catch(err => log.warn(`previewBack: error: ${err}`));
        } else if (val.startsWith('PREVIEW:')) {
          const typeName = val.substring('PREVIEW:'.length);
          previewTypeHandler(docUri, typeName).catch(err => log.warn(`preview: error: ${err}`));
        } else if (docUri || editor) {
          goToTypeHandler(docUri, val);
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
        params: {
          expression: mainWsRefIsRendererTarget ? rendererExpr : cleanupScript,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    } catch {
      finish();
    }
  });
}

async function evaluateInTestRendererForTests(expression: string, timeoutMs = 7000): Promise<any> {
  const wsUrl = await findTestRendererWebSocketUrl();
  if (!wsUrl) {
    throw new Error('test renderer CDP target is not available');
  }
  testRendererWebSocketUrlRef = wsUrl;
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) { return; }
        done = true;
        clearTimeout(timeout);
        if (err) { reject(err); } else { resolve(); }
      };
      const timeout = setTimeout(() => finish(new Error('test renderer eval CDP connect timed out')), 3000);
      ws.once('open', () => finish());
      ws.once('error', err => finish(err instanceof Error ? err : new Error(String(err))));
    });
    await cdpRequest(ws, 'Runtime.enable', {}, 1500).catch(() => undefined);
    const response = await cdpRequest(ws, 'Runtime.evaluate', {
      expression,
      includeCommandLineAPI: true,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'test renderer eval exception');
    }
    return response?.result?.value;
  } catch (err) {
    if (testRendererWebSocketUrlRef === wsUrl) {
      testRendererWebSocketUrlRef = null;
    }
    throw err;
  } finally {
    try { ws.close(); } catch {}
  }
}

async function evaluateInMainProcessForTests(expression: string, timeoutMs = 7000): Promise<any> {
  if (isTestRendererDebugMode()) {
    const value = await evaluateInTestRendererForTests(expression, timeoutMs);
    return [{
      id: 'test-renderer',
      title: 'test-renderer',
      url: 'test-renderer-cdp',
      value,
    }];
  }
  return evaluateInMainProcess(expression, timeoutMs);
}

function evaluateInMainProcess(expression: string, timeoutMs = 7000): Promise<any> {
  const ws = mainWsRef;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('renderer CDP socket is not open'));
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
    const timeout = setTimeout(() => {
      const err = new Error('renderer test eval timed out');
      finish(err);
      if (ws === mainWsRef) {
        log.warn('[cdp] renderer eval timed out; dropping stale renderer CDP socket');
        closeMainWebSocket();
      }
    }, timeoutMs);
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

function scheduleRendererNativeHoverFallback(
  identifier: string,
  markdown: string,
  source: string,
  anchor?: NativeHoverRefireAnchor,
): void {
  if (process.env.IR_NATIVE_HOVER_REFIRE !== '1') { return; }
  if (extensionDeactivated || !identifier || !markdown || markdown.trim().length < 20) { return; }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
  const refireKey = [
    anchor?.uri.toString() ?? '',
    anchor?.line ?? '',
    anchor?.character ?? '',
    identifier,
  ].join(':');
  if (nativeHoverRefireScheduledKeys.has(refireKey)) { return; }
  nativeHoverRefireScheduledKeys.add(refireKey);
  const timer = setTimeout(async () => {
    rendererHoverFallbackTimers.delete(timer);
    nativeHoverRefireScheduledKeys.delete(refireKey);
    if (extensionDeactivated || !mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
    const rendererExpr = `
      (function() {
        try {
          if (typeof window.irShowHoverFallback !== 'function') {
            return { ok: false, reason: 'missing-irShowHoverFallback', patchVersion: Number(window.__irPatchVersion) || 0 };
          }
          return window.irShowHoverFallback(${jsonStringifyAscii(identifier)}, ${jsonStringifyAscii(markdown)}, {
            source: ${jsonStringifyAscii(source)}
          });
        } catch (e) {
          return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
        }
      })()
    `.trim();
    try {
      const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 2500);
      const value = (Array.isArray(rows) ? rows : [{ value: rows }])
        .map((row: any) => row?.value)
        .find(Boolean);
      if (value?.ok && value?.refired) {
        const now = Date.now();
        const last = nativeHoverRefireLastAt.get(refireKey) ?? 0;
        if (anchor && now - last >= NATIVE_HOVER_REFIRE_SUPPRESS_MS) {
          nativeHoverRefireLastAt.set(refireKey, now);
          try {
            await Promise.race([
              markRendererNativeHoverRefireGrace(1800),
              new Promise((_, reject) => setTimeout(() => reject(new Error('native refire grace timed out')), 900)),
            ]).catch(() => {});
            await Promise.race([
              refireHoverAtAnchor(anchor),
              new Promise((_, reject) => setTimeout(() => reject(new Error('native hover refire timed out')), 4600)),
            ]);
            await new Promise(resolve => setTimeout(resolve, 180));
            try {
              await Promise.race([
                evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 1400),
                new Promise((_, reject) => setTimeout(() => reject(new Error('post-command native hover refire timed out')), 1600)),
              ]);
            } catch (postErr) {
              if (rendererHoverFallbackLogCount < 120) {
                rendererHoverFallbackLogCount++;
                log.info(`[hover] post-command native hover refire skipped "${identifier}" source=${source}: ${postErr}`);
              }
            }
            if (rendererHoverFallbackLogCount < 120) {
              rendererHoverFallbackLogCount++;
              log.info(`[hover] renderer requested native hover refire "${identifier}" source=${source} token=${value.token || ''}`);
            }
          } catch (err) {
            if (rendererHoverFallbackLogCount < 120) {
              rendererHoverFallbackLogCount++;
              log.warn(`[hover] native hover refire failed "${identifier}" source=${source}: ${err}`);
            }
          }
        } else if (rendererHoverFallbackLogCount < 120) {
          rendererHoverFallbackLogCount++;
          log.info(`[hover] native hover refire suppressed "${identifier}" source=${source} anchor=${anchor ? '1' : '0'}`);
        }
      } else if (value && value.reason && value.reason !== 'existing-hover' && rendererHoverFallbackLogCount < 120) {
        rendererHoverFallbackLogCount++;
        log.info(`[hover] renderer native hover refire skipped "${identifier}" source=${source} reason=${value.reason}`);
      }
    } catch (err) {
      if (rendererHoverFallbackLogCount < 120) {
        rendererHoverFallbackLogCount++;
        log.warn(`[hover] renderer native hover refire probe failed "${identifier}" source=${source}: ${err}`);
      }
    }
  }, 260);
  rendererHoverFallbackTimers.add(timer);
}

function rendererTestWindowEvalExpression(rendererExpr: string, strictTestWorkspace = false): string {
  if (isTestRendererDebugMode()) {
    return rendererExpr;
  }
  const workspacePath = workspaceRootFsPath() ?? '';
  const workspaceName = workspacePath ? path.basename(workspacePath) : '';
  const extensionRootPath = path.resolve(__dirname, '..');
  const extensionRootName = path.basename(extensionRootPath);
  const strictAllowsExtensionDevelopmentHost = extensionRunsInTestMode;
  const strictCanTrustSingleCurrentMainWindow = extensionRunsInTestMode && !!rendererUserDataDirHint;
  const testWindowMarker = process.env.IR_TEST_WINDOW_MARKER || '';
  const requireExtensionDevelopmentHost = false;
  return `
    (async function() {
      var BW = require('electron').BrowserWindow;
      var wins = BW.getAllWindows();
      var workspacePath = ${JSON.stringify(workspacePath)};
      var workspaceName = ${JSON.stringify(workspaceName)};
      var extensionRootPath = ${JSON.stringify(extensionRootPath)};
      var extensionRootName = ${JSON.stringify(extensionRootName)};
      var strictTestWorkspace = ${JSON.stringify(strictTestWorkspace)};
      var strictAllowsExtensionDevelopmentHost = ${JSON.stringify(strictAllowsExtensionDevelopmentHost)};
      var strictCanTrustSingleCurrentMainWindow = ${JSON.stringify(strictCanTrustSingleCurrentMainWindow)};
      var testWindowMarker = ${JSON.stringify(testWindowMarker)};
      var requireExtensionDevelopmentHost = ${JSON.stringify(requireExtensionDevelopmentHost)};
      function decodeMaybe(s) { try { return decodeURIComponent(s); } catch (_) { return s || ''; } }
      function withTimeout(promise, ms, fallback) {
        return Promise.race([
          promise,
          new Promise(function(resolve) { setTimeout(function() { resolve(fallback); }, ms); })
        ]);
      }
      function windowTitle(w) {
        try { return String((w.getTitle && w.getTitle()) || ''); } catch (_) { return ''; }
      }
      function windowUrl(w) {
        try { return String(w.webContents && w.webContents.getURL && w.webContents.getURL() || ''); } catch (_) { return ''; }
      }
      function isCandidateWindow(w) {
        try {
          if (!w || (w.isDestroyed && w.isDestroyed())) return false;
          if (!w.webContents || (w.webContents.isDestroyed && w.webContents.isDestroyed())) return false;
          var title = windowTitle(w);
          var url = windowUrl(w);
          if (/Developer Tools/i.test(title) || /devtools:/i.test(url)) return false;
          return true;
        } catch (_) {
          return false;
        }
      }
      function urlMatchesWorkspace(w) {
        if (!workspacePath) return true;
        var url = windowUrl(w);
        if (!url) return false;
        var decoded = decodeMaybe(url);
        var encoded = encodeURIComponent(workspacePath);
        return url.indexOf(workspacePath) >= 0
          || url.indexOf(encoded) >= 0
          || decoded.indexOf(workspacePath) >= 0;
      }
      function titleMatchesWorkspace(w) {
        if (!workspaceName) return false;
        var title = windowTitle(w);
        return title.indexOf(workspaceName) >= 0
          || (title.indexOf('Extension Development Host') >= 0 && title.indexOf(workspaceName) >= 0);
      }
      function textMatchesWorkspace(text) {
        text = String(text || '');
        var decoded = decodeMaybe(text);
        var encodedWorkspace = workspacePath ? encodeURIComponent(workspacePath) : '';
        return !!(
          (workspacePath && (
            text.indexOf(workspacePath) >= 0
            || decoded.indexOf(workspacePath) >= 0
            || text.indexOf(encodedWorkspace) >= 0
          ))
          || (workspaceName && text.indexOf(workspaceName) >= 0)
        );
      }
      function textMatchesExtensionRoot(text) {
        text = String(text || '');
        var decoded = decodeMaybe(text);
        var encodedExtension = extensionRootPath ? encodeURIComponent(extensionRootPath) : '';
        return !!(
          (extensionRootPath && (
            text.indexOf(extensionRootPath) >= 0
            || decoded.indexOf(extensionRootPath) >= 0
            || text.indexOf(encodedExtension) >= 0
          ))
          || (extensionRootName && text.indexOf(extensionRootName) >= 0)
        );
      }
      function textMatchesKnownWorkspace(text) {
        return textMatchesWorkspace(text) || textMatchesExtensionRoot(text);
      }
      function textMatchesTestWindowMarker(text) {
        return !!(testWindowMarker && String(text || '').indexOf(testWindowMarker) >= 0);
      }
      function isStrictTestWorkspaceCandidate(w, probe) {
        var title = windowTitle(w);
        var url = windowUrl(w);
        var docTitle = String((probe && probe.documentTitle) || '');
        var href = String((probe && probe.locationHref) || '');
        if (textMatchesTestWindowMarker(title) || textMatchesTestWindowMarker(docTitle)
          || textMatchesTestWindowMarker(href) || (probe && probe.bodyTestWindowMarkerMatch)) return true;
        if (probe && probe.isExtensionDevelopmentHost) return !!strictAllowsExtensionDevelopmentHost;
        if (probe && probe.bodyWorkspacePathMatch) return true;
        var isExtensionDevelopmentHost = /Extension Development Host/i.test(title)
          || /Extension Development Host/i.test(docTitle);
        if (isExtensionDevelopmentHost && strictAllowsExtensionDevelopmentHost) return true;
        return textMatchesWorkspace(title) || textMatchesWorkspace(url)
          || textMatchesWorkspace(docTitle) || textMatchesWorkspace(href);
      }
      function windowScore(w) {
        var score = 0;
        var title = windowTitle(w);
        var url = windowUrl(w);
        try { if (urlMatchesWorkspace(w)) score += 1000; } catch (_) {}
        try { if (titleMatchesWorkspace(w)) score += 900; } catch (_) {}
        if (workspaceName && title.indexOf(workspaceName) >= 0) score += 120;
        if (title.indexOf('Extension Development Host') >= 0) score += 100;
        if (url.indexOf('workbench') >= 0 || url.indexOf('vscode') >= 0) score += 30;
        try { if (w.isFocused && w.isFocused()) score += 80; } catch (_) {}
        try { if (w.isVisible && w.isVisible()) score += 20; } catch (_) {}
        return score;
      }
      function chooseSingleWindow(list) {
        var candidates = [];
        for (var ci = 0; ci < list.length; ci++) {
          if (isCandidateWindow(list[ci])) candidates.push(list[ci]);
        }
        if (!candidates.length) return [];
        var best = candidates[0];
        var bestScore = windowScore(best);
        for (var bi = 1; bi < candidates.length; bi++) {
          var score = windowScore(candidates[bi]);
          if (score > bestScore) {
            best = candidates[bi];
            bestScore = score;
          }
        }
        return [best];
      }
      async function probeWindow(w) {
        var fallback = {
          isExtensionDevelopmentHost: windowTitle(w).indexOf('Extension Development Host') >= 0,
          hasSeededPreviewHover: false,
          hasActualHover: false,
          hasPatch: false,
          bodyWorkspacePathMatch: false,
          bodyTestWindowMarkerMatch: false,
          documentTitle: '',
          locationHref: ''
        };
        try {
          if (!w.webContents || typeof w.webContents.executeJavaScript !== 'function') return fallback;
          var expr = [
            '(function(){try{',
            'var roots=document.querySelectorAll(".monaco-hover,.monaco-editor-hover");',
            'var workspacePath=' + ${JSON.stringify(JSON.stringify(workspacePath))} + ';',
            'var encodedWorkspace=' + ${JSON.stringify(JSON.stringify(encodeURIComponent(workspacePath)))} + ';',
            'var testWindowMarker=' + ${JSON.stringify(JSON.stringify(testWindowMarker))} + ';',
            'var bodyText=String(document.body&&document.body.textContent||"");',
            'var decodedBody=bodyText;try{decodedBody=decodeURIComponent(bodyText)}catch(_){}',
            'var bodyWorkspacePathMatch=!!(workspacePath&&(bodyText.indexOf(workspacePath)>=0||bodyText.indexOf(encodedWorkspace)>=0||decodedBody.indexOf(workspacePath)>=0));',
            'var bodyTestWindowMarkerMatch=!!(testWindowMarker&&bodyText.indexOf(testWindowMarker)>=0);',
            'var actual=0;',
            'for(var i=0;i<roots.length;i++){',
            'var h=roots[i];',
            'if(!h.classList.contains("ir-e2e-empty-hover")&&String(h.textContent||"").trim().length)actual++;',
            '}',
            'return {',
            'isExtensionDevelopmentHost:/Extension Development Host/i.test(String(document.title||"")),',
            'hasSeededPreviewHover:!!document.querySelector(".ir-test-seeded-hover"),',
            'hasActualHover:actual>0||!!(window.__irActiveHoverEl&&document.body.contains(window.__irActiveHoverEl)),',
            'hasPatch:(Number(window.__irPatchVersion)||0)>0,',
            'bodyWorkspacePathMatch:bodyWorkspacePathMatch,',
            'bodyTestWindowMarkerMatch:bodyTestWindowMarkerMatch,',
            'documentTitle:String(document.title||""),',
            'locationHref:String(location&&location.href||"")',
            '};',
            '}catch(e){return null;}})()'
          ].join('');
          var probed = await withTimeout(w.webContents.executeJavaScript(expr, true), 700, null);
          if (probed && typeof probed === 'object') {
            return Object.assign(fallback, probed);
          }
        } catch (_) {}
        return fallback;
      }
      function windowProbeScore(w, probe) {
        var score = windowScore(w);
        if (probe && probe.isExtensionDevelopmentHost) score += 5000;
        if (probe && probe.hasSeededPreviewHover) score += 4000;
        if (probe && probe.hasActualHover) score += 3000;
        if (probe && probe.hasPatch) score += 100;
        var title = String((probe && probe.documentTitle) || '') + ' ' + windowTitle(w);
        if (textMatchesTestWindowMarker(title) || (probe && probe.bodyTestWindowMarkerMatch)) score += 10000;
        if (workspaceName && title.indexOf(workspaceName) >= 0) score += 120;
        return score;
      }
      async function chooseSingleWindowAsync(list) {
        var candidates = [];
        for (var ci = 0; ci < list.length; ci++) {
          if (isCandidateWindow(list[ci])) candidates.push(list[ci]);
        }
        if (!candidates.length) return [];
        var probes = [];
        var hasExtensionDevHost = false;
        for (var pi = 0; pi < candidates.length; pi++) {
          var probe = await probeWindow(candidates[pi]);
          probes.push(probe);
          if (probe && probe.isExtensionDevelopmentHost) hasExtensionDevHost = true;
        }
        if (strictTestWorkspace) {
          var preStrictCandidates = candidates.slice();
          var preStrictProbes = probes.slice();
          var strictCandidates = [];
          var strictProbes = [];
          for (var si = 0; si < candidates.length; si++) {
            if (isStrictTestWorkspaceCandidate(candidates[si], probes[si])) {
              strictCandidates.push(candidates[si]);
              strictProbes.push(probes[si]);
            }
          }
          candidates = strictCandidates;
          probes = strictProbes;
          hasExtensionDevHost = false;
          for (var sh = 0; sh < probes.length; sh++) {
            if (probes[sh] && probes[sh].isExtensionDevelopmentHost) hasExtensionDevHost = true;
          }
          if (!candidates.length && !testWindowMarker && strictCanTrustSingleCurrentMainWindow && preStrictCandidates.length) {
            candidates = chooseSingleWindow(preStrictCandidates);
            probes = candidates.map(function(candidate) {
              var idx = preStrictCandidates.indexOf(candidate);
              return idx >= 0 ? preStrictProbes[idx] : null;
            });
            hasExtensionDevHost = false;
            for (var fh = 0; fh < probes.length; fh++) {
              if (probes[fh] && probes[fh].isExtensionDevelopmentHost) hasExtensionDevHost = true;
            }
          }
          if (!candidates.length) return [];
        }
        if (workspacePath) {
          var workspaceCandidates = [];
          var workspaceProbes = [];
          for (var wi = 0; wi < candidates.length; wi++) {
            var href = String((probes[wi] && probes[wi].locationHref) || '');
            var decodedHref = decodeMaybe(href);
            if (urlMatchesWorkspace(candidates[wi])
              || titleMatchesWorkspace(candidates[wi])
              || (probes[wi] && probes[wi].bodyWorkspacePathMatch)
              || href.indexOf(workspacePath) >= 0
              || decodedHref.indexOf(workspacePath) >= 0) {
              workspaceCandidates.push(candidates[wi]);
              workspaceProbes.push(probes[wi]);
            }
          }
          if (workspaceCandidates.length) {
            candidates = workspaceCandidates;
            probes = workspaceProbes;
            hasExtensionDevHost = false;
            for (var wh = 0; wh < probes.length; wh++) {
              if (probes[wh] && probes[wh].isExtensionDevelopmentHost) hasExtensionDevHost = true;
            }
          }
        }
        if (requireExtensionDevelopmentHost && !hasExtensionDevHost) {
          return [];
        }
        var best = null;
        var bestScore = -Infinity;
        for (var bi = 0; bi < candidates.length; bi++) {
          if (hasExtensionDevHost && !(probes[bi] && probes[bi].isExtensionDevelopmentHost)) continue;
          var score = windowProbeScore(candidates[bi], probes[bi]);
          if (!best || score > bestScore) {
            best = candidates[bi];
            bestScore = score;
          }
        }
        return best ? [best] : chooseSingleWindow(candidates);
      }
      wins = wins.filter(isCandidateWindow);
      if (workspacePath) {
        var matched = [];
        for (var mi = 0; mi < wins.length; mi++) {
          if (urlMatchesWorkspace(wins[mi])) matched.push(wins[mi]);
        }
        if (matched.length) {
          wins = matched;
          if (wins.length > 1) {
            var titleMatched = [];
            for (var tmi = 0; tmi < wins.length; tmi++) {
              if (titleMatchesWorkspace(wins[tmi])) titleMatched.push(wins[tmi]);
            }
            if (titleMatched.length) wins = titleMatched;
          }
        } else {
          var titleOnly = [];
          for (var toi = 0; toi < wins.length; toi++) {
            if (titleMatchesWorkspace(wins[toi])) titleOnly.push(wins[toi]);
          }
          if (titleOnly.length) wins = titleOnly;
        }
      }
      if (!workspacePath || !wins.length) {
        var focused = [];
        for (var fi = 0; fi < wins.length; fi++) {
          try {
            if (wins[fi].isFocused && wins[fi].isFocused()) focused.push(wins[fi]);
          } catch (_) {}
        }
        if (focused.length) wins = focused;
      }
      wins = await chooseSingleWindowAsync(wins);
      if (!wins.length) return [];
      async function evalWindow(w) {
        try {
          if (w.webContents && typeof w.webContents.executeJavaScript === 'function') {
            var jsResult = await withTimeout(
              w.webContents.executeJavaScript(${JSON.stringify(rendererExpr)}, true),
              8000,
              { __irTimeout: true }
            );
            if (!jsResult || !jsResult.__irTimeout) {
              return {
                id: w.id,
                title: windowTitle(w),
                url: String(w.webContents.getURL && w.webContents.getURL() || ''),
                value: jsResult
              };
            }
          }
          var attached = false;
          try { attached = w.webContents.debugger.isAttached(); } catch (_) {}
          if (!attached) {
            try { w.webContents.debugger.attach('1.3'); } catch (eAttach) {
              return { id: w.id, attachError: String(eAttach && eAttach.message || eAttach) };
            }
          }
          await withTimeout(w.webContents.debugger.sendCommand('Runtime.enable'), 1000, null);
          var r = await withTimeout(w.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: ${JSON.stringify(rendererExpr)},
            includeCommandLineAPI: true,
            returnByValue: true,
            awaitPromise: true
          }), 8000, { __irTimeout: true });
          if (r && r.__irTimeout) {
            return { id: w.id, title: windowTitle(w), url: String(w.webContents.getURL && w.webContents.getURL() || ''), timeout: true };
          }
          return {
            id: w.id,
            title: windowTitle(w),
            url: String(w.webContents.getURL && w.webContents.getURL() || ''),
            value: r && r.result ? r.result.value : undefined,
            exception: r && r.exceptionDetails ? (r.exceptionDetails.text || 'exception') : undefined
          };
        } catch (e) {
          return { id: w && w.id, title: windowTitle(w), error: String(e && e.message || e) };
        }
      }
      var out = await Promise.all(wins.map(evalWindow));
      return out;
    })()
  `.trim();
}

async function ensureRendererPatchForHarness(): Promise<void> {
  if (isTestRendererDebugMode()) {
    const wsUrl = await findTestRendererWebSocketUrl();
    if (!wsUrl) {
      await runRendererInjection(injectRenderer);
      return;
    }
    if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN || mainWsRefTargetUrl !== wsUrl) {
      await runRendererInjection(injectRenderer);
      return;
    }
    try {
      const version = await evaluateInTestRendererForTests(
        `(function(){return Number(window.__irPatchVersion)||0})()`,
        1500,
      );
      if (Number(version) >= RENDERER_PATCH_VERSION) { return; }
    } catch {}
    await runRendererInjection(reinjectRenderer);
    return;
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    await runRendererInjection(injectRenderer);
    return;
  }
  await runRendererInjection(reinjectRenderer);
}

async function rendererHasSeededPreviewHoverForTests(): Promise<boolean> {
  if (!extensionRunsInTestMode || !mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    return false;
  }
  const rendererExpr = `
    (function(){
      return !!document.querySelector('.ir-test-seeded-hover');
    })()
  `.trim();
  try {
    const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 2500);
    return (rows || []).some((row: any) => row?.value === true);
  } catch {
    return false;
  }
}

async function cleanupRendererTestArtifactsAcrossWindowsForTests(): Promise<void> {
  if (!extensionRunsInTestMode || !mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    return;
  }
  const cleanupRendererExpr = `
    (function(){
      var selectors=[
        '.ir-test-seeded-hover',
        '.ir-e2e-hover',
        '.ir-e2e-hover-link',
        '.ir-e2e-empty-hover',
        '.ir-e2e-external-artifact',
        '.ir-e2e-body-handle',
        '.ir-e2e-workbench-sash',
        '.ir-e2e-top-body-handle',
        '.ir-e2e-top-workbench-sash',
        '.ir-e2e-mutating-handle',
        '.ir-e2e-late-handle',
        '.ir-e2e-dedupe-hover',
        '.ir-e2e-dedupe-sentinel',
        '.ir-e2e-sticky-far-target',
        '[data-ir-e2e-artifact="1"]'
      ];
      var nodes=document.querySelectorAll(selectors.join(','));
      var removed=0;
      for(var i=0;i<nodes.length;i++){
        try{if(nodes[i].parentNode){nodes[i].parentNode.removeChild(nodes[i]);removed++;}}catch(_){}
      }
      window.__irActiveHoverEl=null;
      window.__irOriginalHoverSnapshot=null;
      window.__irHistoryFor=null;
      window.__irHistory=[];
      window.__irHistoryCurrent=null;
      window.__irLastPreviewTarget=null;
      return {ok:true,removed:removed,patchVersion:Number(window.__irPatchVersion)||0};
    })()
  `.trim();
  try {
    await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(cleanupRendererExpr, true), 2500);
  } catch {}
}

async function shouldUseDirectRendererPreviewApply(): Promise<boolean> {
  return PREVIEW_DIRECT_RENDERER_APPLY || await rendererHasSeededPreviewHoverForTests();
}

async function capturePreviewScrollStateInRenderer(): Promise<PreviewScrollState | undefined> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return undefined; }
  const rendererExpr = `
    (function() {
      try {
        if (typeof window.__irCapturePreviewScroll !== 'function') {
          return { ok: false, reason: 'missing-scroll-capture', patchVersion: Number(window.__irPatchVersion) || 0 };
        }
        var state = window.__irCapturePreviewScroll();
        return {
          ok: !!state,
          state: state || null,
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr), 1500);
    const value = (rows || []).map((row: any) => row?.value).find((v: any) => v?.ok && v.state);
    return value?.state;
  } catch {
    return undefined;
  }
}

async function withCurrentRendererScrollState(state: PreviewState): Promise<PreviewState> {
  const scrollState = await capturePreviewScrollStateInRenderer();
  if (!scrollState) { return state; }
  return { ...state, scrollState };
}

async function applyPreviewStateInRenderer(state: PreviewState, fromBack: boolean): Promise<boolean> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return false; }
  const safeId = jsonStringifyAscii(state.identifier);
  const safeMd = jsonStringifyAscii(state.markdown);
  const safeScroll = jsonStringifyAscii(fromBack ? state.scrollState ?? null : null);
  const rendererExpr = `
    (function() {
      try {
        if (typeof window.irApplyPreview !== 'function') {
          return { ok: false, reason: 'missing-irApplyPreview', patchVersion: Number(window.__irPatchVersion) || 0 };
        }
        var applied = window.irApplyPreview(${safeId}, ${safeMd}, ${fromBack ? 'true' : 'false'}, ${safeScroll});
        var hover = document.querySelector('.monaco-hover, .monaco-editor-hover');
        return {
          ok: applied !== false,
          applied: applied !== false,
          hoverTextLength: hover ? String(hover.textContent || '').trim().length : 0,
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr);
  try {
    const result = await evaluateInMainProcessForTests(mainExpr, 3000);
    const rows = Array.isArray(result) ? result : [{ value: result }];
    const applied = rows.some(row => row?.value?.ok);
    if (!applied) {
      log.warn(`preview: renderer apply returned no ok row (${JSON.stringify(rows).slice(0, 1000)})`);
    }
    return applied;
  } catch (err) {
    log.warn(`preview: renderer apply failed: ${err}`);
    return false;
  }
}

async function restorePreviewScrollStateInRenderer(scrollState: PreviewScrollState | undefined): Promise<boolean> {
  if (!scrollState) { return false; }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return false; }
  const safeScroll = jsonStringifyAscii(scrollState);
  const rendererExpr = `
    (function() {
      try {
        if (typeof window.__irRestorePreviewScrollState !== 'function') {
          return { ok: false, reason: 'missing-scroll-restore', patchVersion: Number(window.__irPatchVersion) || 0 };
        }
        return window.__irRestorePreviewScrollState(${safeScroll});
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr), 2500);
    return Array.isArray(rows) && rows.some(row => row?.value?.ok);
  } catch {
    return false;
  }
}

async function restoreOriginalHoverSnapshotInRenderer(scrollState: PreviewScrollState | undefined): Promise<boolean> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return false; }
  const safeScroll = jsonStringifyAscii(scrollState ?? null);
  const rendererExpr = `
    (function() {
      try {
        if (typeof window.__irRestoreOriginalHoverSnapshot !== 'function') {
          return { ok: false, reason: 'missing-original-restore', patchVersion: Number(window.__irPatchVersion) || 0 };
        }
        return window.__irRestoreOriginalHoverSnapshot(${safeScroll});
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr), 2500);
    return Array.isArray(rows) && rows.some(row => row?.value?.ok);
  } catch {
    return false;
  }
}

async function clearRendererPreviewNavigationStateInRenderer(): Promise<void> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
  const rendererExpr = `
    (function() {
      try {
        window.__irOriginalHoverSnapshot = null;
        window.__irHistoryFor = null;
        window.__irHistory = [];
        window.__irHistoryCurrent = null;
        window.__irLastPreviewTarget = null;
        window.__irNativePreviewBackUntil = 0;
        return { ok: true, patchVersion: Number(window.__irPatchVersion) || 0 };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 2500);
  } catch {}
}

async function markRendererNativeHoverRefireGrace(durationMs = 1600): Promise<void> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
  const rendererExpr = `
    (function() {
      try {
        window.__irNativeHoverRefireUntil = Date.now() + ${Math.max(250, durationMs)};
        window.__irNativePreviewBackUntil = Date.now() + ${Math.max(250, durationMs)};
        return { ok: true, patchVersion: Number(window.__irPatchVersion) || 0 };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 1000);
  } catch {}
}

async function runHoverRendererHarnessForTests(): Promise<any[]> {
  await ensureRendererPatchForHarness();
  await cleanupRendererTestArtifactsAcrossWindowsForTests();
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
        var handles = root.querySelectorAll('.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler');
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
      function protrusionMetrics(root) {
        if (!root) {
          return { maxRightOverflow: 0, maxBottomOverflow: 0, wideBlockCount: 0, maxBlockWidth: 0 };
        }
        var rr = root.getBoundingClientRect();
        var maxRight = 0;
        var maxBottom = 0;
        var wide = 0;
        var maxWidth = 0;
        var nodes = root.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler');
        for (var i = 0; i < nodes.length && i < 600; i++) {
          var el = nodes[i];
          var tag = String(el.tagName || '').toUpperCase();
          if (tag === 'SPAN' || tag === 'A' || tag === 'CODE' || tag === 'BUTTON') continue;
          try {
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            maxWidth = Math.max(maxWidth, r.width || 0);
            var right = Math.max(0, r.right - rr.right);
            var bottom = Math.max(0, r.bottom - rr.bottom);
            maxRight = Math.max(maxRight, right);
            maxBottom = Math.max(maxBottom, bottom);
            if (right > 2 || r.width > rr.width + 2 || r.left < rr.left - 2) wide++;
          } catch (_) {}
        }
        return {
          maxRightOverflow: maxRight,
          maxBottomOverflow: maxBottom,
          wideBlockCount: wide,
          maxBlockWidth: maxWidth
        };
      }
      function nativeScrollbarMetrics(root) {
        var sc = hooks.primaryHoverScroller(root) || root;
        var base = window.getComputedStyle(sc);
        var webkit = {};
        try {
          var pseudo = window.getComputedStyle(sc, '::-webkit-scrollbar');
          webkit = {
            display: pseudo.display || '',
            width: pseudo.width || '',
            height: pseudo.height || '',
            backgroundColor: pseudo.backgroundColor || ''
          };
        } catch (_) {}
        return {
          scrollbarWidth: base.scrollbarWidth || '',
          scrollbarColor: base.scrollbarColor || '',
          msOverflowStyle: base.msOverflowStyle || '',
          webkit: webkit
        };
      }
      function inactiveMetrics(activeHover) {
        var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        var inactive = 0;
        for (var i = 0; i < roots.length; i++) {
          var h = roots[i];
          if (h === activeHover || (activeHover && activeHover.contains && activeHover.contains(h))) continue;
          inactive++;
        }
        var artifacts = document.querySelectorAll('[data-ir-hover-owned="1"],.ir-e2e-external-artifact,.ir-e2e-body-handle');
        var externalArtifacts = 0;
        for (var ai = 0; ai < artifacts.length; ai++) {
          var a = artifacts[ai];
          if (activeHover && activeHover.contains && activeHover.contains(a)) continue;
          externalArtifacts++;
        }
        return { inactiveHovers: inactive, externalArtifacts: externalArtifacts };
      }
      function harnessLog(message) {
        try {
          if (typeof window.irGoToType === 'function') {
            window.irGoToType('LOG:renderer-harness ' + message);
          }
        } catch (_) {}
      }
      function harnessMark(step) {
        try {
          var active = window.__irActiveHoverEl;
          harnessLog('step=' + step
            + ' active=' + !!(active && document.body.contains(active))
            + ' activeText=' + String(active ? active.textContent || '' : '').length
            + ' hovers=' + document.querySelectorAll('.monaco-hover,.monaco-editor-hover').length);
        } catch (_) {
          harnessLog('step=' + step);
        }
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
          handles: handleMetrics(hoverEl),
          protrusions: protrusionMetrics(hoverEl),
          nativeScrollbar: nativeScrollbarMetrics(hoverEl)
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
          line.textContent = label + ' field_' + n + ': str\\n';
          md.appendChild(line);
        }
        rowContents.appendChild(md);
        row.appendChild(rowContents);
        content.appendChild(row);
        sc.appendChild(content);
        var scrollbar = document.createElement('div');
        scrollbar.className = 'invisible scrollbar vertical';
        scrollbar.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:680px;display:block;visibility:visible;background:#007fd4;';
        var slider = document.createElement('div');
        slider.className = 'slider';
        slider.style.cssText = 'width:12px;height:640px;display:block;visibility:visible;background:#007fd4;';
        scrollbar.appendChild(slider);
        var horizontal = document.createElement('div');
        horizontal.className = 'invisible scrollbar horizontal';
        horizontal.style.cssText = 'position:absolute;left:0;bottom:0;width:760px;height:12px;display:block;visibility:visible;background:#007fd4;';
        var hSlider = document.createElement('div');
        hSlider.className = 'slider';
        hSlider.style.cssText = 'width:720px;height:12px;display:block;visibility:visible;background:#007fd4;';
        horizontal.appendChild(hSlider);
        var shadow = document.createElement('div');
        shadow.className = 'shadow';
        shadow.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:680px;display:block;visibility:visible;';
        var sash = document.createElement('div');
        sash.className = 'monaco-sash';
        sash.style.cssText = 'position:absolute;right:0;bottom:0;width:12px;height:680px;display:block;visibility:visible;';
        sc.appendChild(scrollbar);
        sc.appendChild(horizontal);
        sc.appendChild(shadow);
        hover.appendChild(sash);
        hover.appendChild(sc);
        document.body.appendChild(hover);
        return hover;
      }
      function makeDuplicateDedupeHover() {
        var hover = document.createElement('div');
        hover.className = 'monaco-hover ir-e2e-hover ir-e2e-dedupe-hover';
        hover.style.cssText = 'position:fixed;left:48px;top:48px;z-index:2147483647;background:Canvas;color:CanvasText;';
        var sc = document.createElement('div');
        sc.className = 'monaco-scrollable-element';
        var content = document.createElement('div');
        content.className = 'monaco-hover-content';
        var duplicateText = 'DuplicateDedupeModel\\nclass DuplicateDedupeModel:\\n    value: str';
        var sentinel = null;
        function appendRow(withSentinel) {
          var row = document.createElement('div');
          row.className = 'hover-row';
          var rowContents = document.createElement('div');
          rowContents.className = 'hover-row-contents';
          var md = document.createElement('div');
          md.className = 'rendered-markdown';
          md.textContent = duplicateText;
          rowContents.appendChild(md);
          if (withSentinel) {
            sentinel = document.createElement('span');
            sentinel.className = 'ir-e2e-dedupe-sentinel';
            sentinel.textContent = 'sentinel';
            rowContents.appendChild(sentinel);
          }
          row.appendChild(rowContents);
          content.appendChild(row);
          return { row: row, markdown: md };
        }
        var first = appendRow(false);
        var second = appendRow(true);
        sc.appendChild(content);
        hover.appendChild(sc);
        document.body.appendChild(hover);
        return { hover: hover, sentinel: sentinel, first: first, second: second };
      }
      function makeLazyLoadingHover(initialText) {
        var hover = document.createElement('div');
        hover.className = 'monaco-hover ir-e2e-hover ir-e2e-lazy-hover';
        hover.style.cssText = 'position:fixed;left:88px;top:88px;width:360px;min-height:72px;padding:4px;z-index:2147483647;background:Canvas;color:CanvasText;';
        var sc = document.createElement('div');
        sc.className = 'monaco-scrollable-element';
        var content = document.createElement('div');
        content.className = 'monaco-hover-content';
        var row = document.createElement('div');
        row.className = 'hover-row';
        var rowContents = document.createElement('div');
        rowContents.className = 'hover-row-contents';
        var md = document.createElement('div');
        md.className = 'rendered-markdown';
        md.style.cssText = 'font-family:Menlo,Monaco,monospace;font-size:12px;line-height:18px;';
        md.textContent = initialText || 'Loading';
        rowContents.appendChild(md);
        row.appendChild(rowContents);
        content.appendChild(row);
        sc.appendChild(content);
        hover.appendChild(sc);
        document.body.appendChild(hover);
        return { hover: hover, markdown: md };
      }
      function appendLateHandle(hoverEl) {
        var sc = hooks.primaryHoverScroller(hoverEl) || hoverEl;
        var late = document.createElement('div');
        late.className = 'invisible scrollbar vertical ir-e2e-late-handle';
        late.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:680px;display:block;visibility:visible;background:#007fd4;';
        var slider = document.createElement('div');
        slider.className = 'slider';
        slider.style.cssText = 'width:12px;height:640px;display:block;visibility:visible;background:#007fd4;';
        late.appendChild(slider);
        sc.appendChild(late);
        return late;
      }
      function appendMutatingHandleCandidate(hoverEl) {
        var candidate = document.createElement('div');
        candidate.className = 'ir-e2e-mutating-handle';
        candidate.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:12px;display:block;visibility:visible;background:#d08770;';
        hoverEl.appendChild(candidate);
        return candidate;
      }
      function appendBodyLevelHandleNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var bodyHandle = document.createElement('div');
        bodyHandle.className = 'monaco-sash vertical ir-e2e-body-handle';
        bodyHandle.style.cssText = 'position:fixed;left:' + Math.max(0, rect.right - 2) + 'px;top:' + Math.max(0, rect.top) + 'px;width:8px;height:' + Math.max(160, rect.height + 220) + 'px;display:block;visibility:visible;background:#007fd4;z-index:999999;';
        document.body.appendChild(bodyHandle);
        return bodyHandle;
      }
      function appendUnownedBodyLevelHoverHandleNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var bodyHandle = document.createElement('div');
        bodyHandle.className = 'monaco-sash vertical ir-e2e-body-handle';
        bodyHandle.setAttribute('data-ir-e2e-artifact', '1');
        bodyHandle.style.cssText = 'position:fixed;left:' + Math.max(0, rect.right - 2) + 'px;top:' + Math.max(0, rect.top) + 'px;width:8px;height:' + Math.max(160, rect.height + 220) + 'px;display:block;visibility:visible;background:#007fd4;z-index:999999;';
        document.body.appendChild(bodyHandle);
        return bodyHandle;
      }
      function appendTopRightBodyLevelHoverHandleNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var bodyHandle = document.createElement('div');
        bodyHandle.className = 'monaco-sash horizontal ir-e2e-top-body-handle';
        bodyHandle.style.cssText = 'position:fixed;left:' + Math.max(0, rect.right - 96) + 'px;top:' + Math.max(0, rect.top - 2) + 'px;width:104px;height:8px;display:block;visibility:visible;background:#007fd4;z-index:999999;';
        document.body.appendChild(bodyHandle);
        return bodyHandle;
      }
      function appendWorkbenchSashNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var sash = document.createElement('div');
        sash.className = 'monaco-sash vertical ir-e2e-workbench-sash';
        sash.style.cssText = 'position:fixed;left:' + Math.max(0, rect.right + 18) + 'px;top:' + Math.max(0, rect.top) + 'px;width:8px;height:' + Math.max(180, rect.height + 260) + 'px;display:block;visibility:visible;background:#b48ead;z-index:999999;';
        document.body.appendChild(sash);
        return sash;
      }
      function appendTopWorkbenchSashNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var sash = document.createElement('div');
        sash.className = 'monaco-sash horizontal ir-e2e-top-workbench-sash';
        sash.style.cssText = 'position:fixed;left:' + Math.max(0, rect.right + 18) + 'px;top:' + Math.max(0, rect.top - 2) + 'px;width:104px;height:8px;display:block;visibility:visible;background:#b48ead;z-index:999999;';
        document.body.appendChild(sash);
        return sash;
      }
      function appendEmptyHoverRootNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var hover = document.createElement('div');
        hover.className = 'monaco-hover ir-e2e-empty-hover';
        hover.style.cssText = 'position:fixed;left:' + Math.max(0, rect.left + 12) + 'px;top:' + Math.max(0, rect.top + 12) + 'px;width:1px;height:1px;z-index:2147483647;';
        document.body.appendChild(hover);
        return hover;
      }
      function waitFrame() {
        return new Promise(function(resolve) {
          var done = false;
          function finish() {
            if (done) return;
            done = true;
            resolve();
          }
          try {
            Promise.resolve().then(function() {
              try { Promise.resolve().then(finish); } catch (_) { finish(); }
            });
          } catch (_) {}
          try {
            requestAnimationFrame(function() {
              try { requestAnimationFrame(finish); } catch (_) { finish(); }
            });
          } catch (_) {
            finish();
          }
          setTimeout(finish, 80);
        });
      }
      function stickyFarEventProbe(cycles) {
        cycles = Math.max(1, cycles || 1);
        var cycleResults = [];
        var allSeenTypes = [];
        var allStickyReleased = true;
        var allRecentlyInside = true;
        for (var cycle = 0; cycle < cycles; cycle++) {
        var sticky = makeHover('StickyReleaseHover' + cycle, 4);
        hooks.makeHoverScrollable(sticky, true, (sticky.textContent || '').length);
        sticky.classList.add('ir-sticky');
        sticky.__irLastInsideAt = Date.now();
        var target = document.createElement('button');
        target.className = 'ir-e2e-sticky-far-target';
        target.textContent = 'Far editor symbol target ' + cycle;
        target.style.cssText = 'position:fixed;left:' + Math.max(320, (window.innerWidth || 1200) - 180 - (cycle * 8))
          + 'px;top:' + Math.max(320, (window.innerHeight || 800) - 140 - (cycle * 6))
          + 'px;width:140px;height:28px;z-index:2147483646;';
        document.body.appendChild(target);
        var tr = target.getBoundingClientRect();
        var x = Math.round(tr.left + tr.width / 2);
        var y = Math.round(tr.top + tr.height / 2);
        var seen = [];
        function listener(ev) {
          seen.push({
            type: ev.type,
            targetClass: String(ev.target && ev.target.className || ''),
            stickyAfterEvent: sticky.classList.contains('ir-sticky')
          });
        }
        window.addEventListener('pointermove', listener, true);
        window.addEventListener('mousemove', listener, true);
        function fire(type) {
          var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
          try {
            target.dispatchEvent(new Ctor(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              button: 0,
              buttons: 0,
              pointerType: 'mouse'
            }));
          } catch (_) {
            target.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              button: 0,
              buttons: 0
            }));
          }
        }
        fire('pointermove');
        fire('mousemove');
        window.removeEventListener('pointermove', listener, true);
        window.removeEventListener('mousemove', listener, true);
        var cycleResult = {
          cycle: cycle,
          seenTypes: seen.map(function(row) { return row.type; }),
          seenCount: seen.length,
          stickyAfterFarMove: sticky.classList.contains('ir-sticky'),
          recentlyInsideAtDispatch: true,
          targetPoint: { x: x, y: y },
          hoverRect: rectObj(sticky.getBoundingClientRect()),
          targetRect: rectObj(tr)
        };
        allSeenTypes = allSeenTypes.concat(cycleResult.seenTypes);
        allStickyReleased = allStickyReleased && !cycleResult.stickyAfterFarMove;
        allRecentlyInside = allRecentlyInside && !!cycleResult.recentlyInsideAtDispatch;
        cycleResults.push(cycleResult);
        try { target.parentNode && target.parentNode.removeChild(target); } catch (_) {}
        try { sticky.parentNode && sticky.parentNode.removeChild(sticky); } catch (_) {}
        }
        return {
          seenTypes: allSeenTypes,
          seenCount: allSeenTypes.length,
          stickyAfterFarMove: !allStickyReleased,
          allStickyReleased: allStickyReleased,
          recentlyInsideAtDispatch: allRecentlyInside,
          cycles: cycleResults
        };
      }
      function nativePopupNearHoverProbe() {
        var sticky = makeHover('NativePopupStickyHover', 8);
        hooks.makeHoverScrollable(sticky, true, (sticky.textContent || '').length);
        sticky.classList.add('ir-sticky');
        sticky.__irLastInsideAt = Date.now();
        window.__irActiveHoverEl = sticky;
        var sr = sticky.getBoundingClientRect();
        var popup = document.createElement('div');
        popup.className = 'suggest-widget ir-e2e-native-popup';
        popup.setAttribute('role', 'listbox');
        popup.style.cssText = 'position:fixed;left:' + Math.max(2, Math.floor(sr.right - 18))
          + 'px;top:' + Math.max(2, Math.floor(sr.top + 12))
          + 'px;width:180px;height:72px;z-index:2147483647;background:Canvas;color:CanvasText;';
        var item = document.createElement('div');
        item.className = 'monaco-list-row focused';
        item.textContent = 'Native popup completion item';
        item.style.cssText = 'width:160px;height:28px;margin:8px;';
        popup.appendChild(item);
        document.body.appendChild(popup);
        var ir = item.getBoundingClientRect();
        var x = Math.round(ir.left + ir.width / 2);
        var y = Math.round(ir.top + ir.height / 2);
        var seen = [];
        function listener(ev) {
          seen.push({
            type: ev.type,
            targetClass: String(ev.target && ev.target.className || ''),
            stickyAfterEvent: sticky.classList.contains('ir-sticky')
          });
        }
        window.addEventListener('pointerover', listener, true);
        window.addEventListener('mouseover', listener, true);
        window.addEventListener('pointermove', listener, true);
        window.addEventListener('mousemove', listener, true);
        function fire(type) {
          var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
          item.dispatchEvent(new Ctor(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
            buttons: 0,
            pointerType: 'mouse'
          }));
        }
        try {
          fire('pointerover');
          fire('mouseover');
          fire('pointermove');
          fire('mousemove');
        } catch (_) {}
        window.removeEventListener('pointerover', listener, true);
        window.removeEventListener('mouseover', listener, true);
        window.removeEventListener('pointermove', listener, true);
        window.removeEventListener('mousemove', listener, true);
        var result = {
          seenTypes: seen.map(function(row) { return row.type; }),
          seenCount: seen.length,
          stickyAfterNativePopup: sticky.classList.contains('ir-sticky'),
          activeStillStickyHover: window.__irActiveHoverEl === sticky,
          hoverRect: rectObj(sr),
          popupRect: rectObj(popup.getBoundingClientRect()),
          itemRect: rectObj(ir)
        };
        try { popup.parentNode && popup.parentNode.removeChild(popup); } catch (_) {}
        try { sticky.parentNode && sticky.parentNode.removeChild(sticky); } catch (_) {}
        if (window.__irActiveHoverEl === sticky) window.__irActiveHoverEl = null;
        return result;
      }
      if (!hooks || typeof hooks.makeHoverScrollable !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      Array.prototype.slice.call(document.querySelectorAll('.monaco-hover,.monaco-editor-hover')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });
      window.__irActiveHoverEl = null;
      Array.prototype.slice.call(document.querySelectorAll('.ir-e2e-hover')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });
      Array.prototype.slice.call(document.querySelectorAll('.ir-e2e-external-artifact,.ir-e2e-body-handle,.ir-e2e-workbench-sash,.ir-e2e-top-body-handle,.ir-e2e-top-workbench-sash')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });
      Array.prototype.slice.call(document.querySelectorAll('.ir-e2e-sticky-far-target')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });

      harnessMark('start');
      var stickyFarProbe = stickyFarEventProbe(3);
      harnessMark('after-sticky-far-probe');
      var nativePopupNearProbe = nativePopupNearHoverProbe();
      harnessMark('after-native-popup-near-probe');

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
      await waitFrame();
      var largeAfterWheel = snap(large);
      harnessMark('after-large-scroll');

      var huge = makeHover('HugeHoverModel', 900);
      hooks.makeHoverScrollable(huge, true, (huge.textContent || '').length);
      var hugeScanStart = (window.performance && performance.now) ? performance.now() : Date.now();
      try { if (typeof hooks.scanRenderedMarkdown === 'function') hooks.scanRenderedMarkdown(); } catch (_) {}
      var hugeScanMs = ((window.performance && performance.now) ? performance.now() : Date.now()) - hugeScanStart;
      var hugeSecondScanStart = (window.performance && performance.now) ? performance.now() : Date.now();
      try { if (typeof hooks.scanRenderedMarkdown === 'function') hooks.scanRenderedMarkdown(); } catch (_) {}
      var hugeSecondScanMs = ((window.performance && performance.now) ? performance.now() : Date.now()) - hugeSecondScanStart;
      await waitFrame();
      var hugeTextLength = (huge.textContent || '').length;
      var hugeEagerLinks = huge.querySelectorAll('.ir-type-link').length;
      try { huge.parentNode && huge.parentNode.removeChild(huge); } catch (_) {}
      harnessMark('after-huge-scan');

      var duplicateDedupe = makeDuplicateDedupeHover();
      try { if (typeof hooks.scanRenderedMarkdown === 'function') hooks.scanRenderedMarkdown(); } catch (_) {}
      await waitFrame();
      var dedupeHoverConnected = document.body.contains(duplicateDedupe.hover);
      var dedupeSentinelConnected = document.body.contains(duplicateDedupe.sentinel);
      var dedupeSecondRowConnected = document.body.contains(duplicateDedupe.second.row);
      var dedupeMarkdownCount = duplicateDedupe.hover.querySelectorAll('.rendered-markdown').length;
      var dedupeTextLength = (duplicateDedupe.hover.textContent || '').length;
      try { duplicateDedupe.hover.parentNode && duplicateDedupe.hover.parentNode.removeChild(duplicateDedupe.hover); } catch (_) {}
      harnessMark('after-dedupe');

      var lazyOldActive = makeHover('LazyOldActiveModel', 5);
      hooks.makeHoverScrollable(lazyOldActive, true, (lazyOldActive.textContent || '').length);
      var lazyOldMarkdown = lazyOldActive.querySelector('.rendered-markdown');
      if (lazyOldMarkdown) {
        lazyOldMarkdown.classList.remove('rendered-markdown');
        lazyOldMarkdown.classList.add('ir-e2e-old-active-markdown');
      }
      lazyOldActive.__irSeenAt = Date.now();
      lazyOldActive.__irLastSeenAt = lazyOldActive.__irSeenAt;
      lazyOldActive.__irActivatedAt = lazyOldActive.__irSeenAt;
      window.__irActiveHoverEl = lazyOldActive;
      var lazy = makeLazyLoadingHover('Loading');
      var staleSeenAt = Date.now() - 2400;
      lazy.hover.__irSeenAt = staleSeenAt;
      lazy.hover.__irLastSeenAt = staleSeenAt;
      lazy.markdown.__irLastScanText = 'Loading';
      var lazyBeforePopulate = {
        activeWasOld: window.__irActiveHoverEl === lazyOldActive,
        lazyTextLength: (lazy.hover.textContent || '').length,
        lazyLinks: lazy.hover.querySelectorAll('.ir-type-link').length,
        lazySeenAt: lazy.hover.__irSeenAt || 0,
        oldActivity: lazyOldActive.__irActivatedAt || 0,
        oldConnected: document.body.contains(lazyOldActive),
        lazyConnected: document.body.contains(lazy.hover)
      };
      lazy.markdown.textContent = 'class LazyLoadedModel:\\n    field: str\\n    def save(self) -> None:\\n        return None';
      try { if (typeof hooks.scanRenderedMarkdown === 'function') hooks.scanRenderedMarkdown(); } catch (_) {}
      await waitFrame();
      var lazyAfterPopulate = {
        activeIsLazy: window.__irActiveHoverEl === lazy.hover,
        activeIsOld: window.__irActiveHoverEl === lazyOldActive,
        activeText: String(window.__irActiveHoverEl ? window.__irActiveHoverEl.textContent || '' : '').replace(/\\s+/g, ' ').slice(0, 160),
        activeClassName: String(window.__irActiveHoverEl ? window.__irActiveHoverEl.className || '' : ''),
        activeConnected: !!(window.__irActiveHoverEl && document.body.contains(window.__irActiveHoverEl)),
        activeActivity: window.__irActiveHoverEl
          ? Math.max(window.__irActiveHoverEl.__irActivatedAt || 0, window.__irActiveHoverEl.__irContentChangedAt || 0, window.__irActiveHoverEl.__irLastSeenAt || 0, window.__irActiveHoverEl.__irSeenAt || 0)
          : 0,
        lazyTextLength: (lazy.hover.textContent || '').length,
        lazyLinks: lazy.hover.querySelectorAll('.ir-type-link').length,
        lazyEmptyClass: lazy.hover.classList.contains('ir-empty-hover-root'),
        lazyRect: rectObj(lazy.hover.getBoundingClientRect()),
        lazyConnected: document.body.contains(lazy.hover),
        oldConnected: document.body.contains(lazyOldActive),
        lazyContentChangedAt: lazy.hover.__irContentChangedAt || 0,
        lazyActivity: Math.max(lazy.hover.__irActivatedAt || 0, lazy.hover.__irContentChangedAt || 0, lazy.hover.__irLastSeenAt || 0, lazy.hover.__irSeenAt || 0),
        lazyHasModelLink: !!Array.prototype.slice.call(lazy.hover.querySelectorAll('.ir-type-link')).find(function(link) { return String(link.textContent || '') === 'LazyLoadedModel'; }),
        lazyHasSaveLink: !!Array.prototype.slice.call(lazy.hover.querySelectorAll('.ir-type-link')).find(function(link) { return String(link.textContent || '') === 'save'; }),
        lazyText: String(lazy.hover.textContent || '').replace(/\\s+/g, ' ').slice(0, 160)
      };
      var lazyHoverProbe = {
        beforePopulate: lazyBeforePopulate,
        afterPopulate: lazyAfterPopulate
      };
      try { lazy.hover.parentNode && lazy.hover.parentNode.removeChild(lazy.hover); } catch (_) {}
      try { lazyOldActive.parentNode && lazyOldActive.parentNode.removeChild(lazyOldActive); } catch (_) {}
      if (window.__irActiveHoverEl === lazy.hover || window.__irActiveHoverEl === lazyOldActive) {
        window.__irActiveHoverEl = null;
      }
      harnessMark('after-lazy-hover');

      var orphan = makeHover('OrphanHoverPanel', 40);
      orphan.classList.add('ir-keepalive');
      var external = document.createElement('div');
      external.className = 'scrollbar ir-native-hover-handle-hidden ir-e2e-external-artifact';
      external.setAttribute('data-ir-hover-artifact','1');
      external.setAttribute('data-ir-hover-owned','1');
      external.style.cssText = 'position:fixed;right:0;top:0;width:14px;height:680px;display:block;visibility:visible;';
      document.body.appendChild(external);

      var small = makeHover('STATUS_ACTIVE = "active"', 1);
      hooks.makeHoverScrollable(small, true, (small.textContent || '').length);
      var emptyHoverRoot = appendEmptyHoverRootNear(small);
      await waitFrame();
      var smallConnectedAfterEmptyRoot = document.body.contains(small);
      try { emptyHoverRoot.parentNode && emptyHoverRoot.parentNode.removeChild(emptyHoverRoot); } catch (_) {}
      var lateHandle = appendLateHandle(small);
      var bodyHandle = appendBodyLevelHandleNear(small);
      var unownedBodyHandle = appendUnownedBodyLevelHoverHandleNear(small);
      var topBodyHandle = appendTopRightBodyLevelHoverHandleNear(small);
      var workbenchSash = appendWorkbenchSashNear(small);
      var topWorkbenchSash = appendTopWorkbenchSashNear(small);
      await waitFrame();
      var mutatingHandle = appendMutatingHandleCandidate(small);
      await waitFrame();
      mutatingHandle.className = 'monaco-sash vertical ir-e2e-mutating-handle';
      mutatingHandle.style.cssText = 'position:absolute;right:0;top:0;width:14px;height:360px;display:block;visibility:visible;background:#d08770;';
      await waitFrame();
      var largeConnectedAfterSmall = document.body.contains(large);
      var orphanConnectedAfterSmall = document.body.contains(orphan);
      var lateHandleConnectedAfterCleanup = document.body.contains(lateHandle);
      var bodyHandleConnectedAfterCleanup = document.body.contains(bodyHandle);
      var unownedBodyHandleConnectedAfterCleanup = document.body.contains(unownedBodyHandle);
      var topBodyHandleConnectedAfterCleanup = document.body.contains(topBodyHandle);
      var workbenchSashConnectedAfterCleanup = document.body.contains(workbenchSash);
      var topWorkbenchSashConnectedAfterCleanup = document.body.contains(topWorkbenchSash);
      var mutatingHandleConnectedAfterCleanup = document.body.contains(mutatingHandle);
      var smallSnap = snap(small);
      var inactiveAfterSmall = inactiveMetrics(small);
      harnessMark('after-small');

      var hiddenActive = makeHover('HiddenActiveHover', 8);
      hooks.makeHoverScrollable(hiddenActive, true, (hiddenActive.textContent || '').length);
      var hiddenActiveWasActive = window.__irActiveHoverEl === hiddenActive;
      hiddenActive.classList.add('hidden');
      hiddenActive.style.display = 'none';
      hiddenActive.style.width = '0px';
      hiddenActive.style.height = '0px';
      hiddenActive.style.visibility = 'hidden';
      try { if (typeof hooks.pruneDetachedHoverState === 'function') hooks.pruneDetachedHoverState(); } catch (_) {}
      await waitFrame();
      var hiddenActiveStillActive = window.__irActiveHoverEl === hiddenActive;
      var hiddenActiveConnectedAfterPrune = document.body.contains(hiddenActive);
      var hiddenActiveCurrentActive = window.__irActiveHoverEl
        ? {
          className: String(window.__irActiveHoverEl.className || ''),
          rect: rectObj(window.__irActiveHoverEl.getBoundingClientRect()),
          textLength: String(window.__irActiveHoverEl.textContent || '').length
        }
        : null;
      harnessMark('after-hidden-active');

      try { small.parentNode && small.parentNode.removeChild(small); } catch (_) {}
      try { large.parentNode && large.parentNode.removeChild(large); } catch (_) {}
      try { orphan.parentNode && orphan.parentNode.removeChild(orphan); } catch (_) {}
      try { external.parentNode && external.parentNode.removeChild(external); } catch (_) {}
      try { bodyHandle.parentNode && bodyHandle.parentNode.removeChild(bodyHandle); } catch (_) {}
      try { unownedBodyHandle.parentNode && unownedBodyHandle.parentNode.removeChild(unownedBodyHandle); } catch (_) {}
      try { topBodyHandle.parentNode && topBodyHandle.parentNode.removeChild(topBodyHandle); } catch (_) {}
      try { workbenchSash.parentNode && workbenchSash.parentNode.removeChild(workbenchSash); } catch (_) {}
      try { topWorkbenchSash.parentNode && topWorkbenchSash.parentNode.removeChild(topWorkbenchSash); } catch (_) {}
      try { mutatingHandle.parentNode && mutatingHandle.parentNode.removeChild(mutatingHandle); } catch (_) {}
      harnessMark('before-return');
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
        largeBefore: largeBefore,
        largeAfterWheel: largeAfterWheel,
        hugeTextLength: hugeTextLength,
        hugeEagerLinks: hugeEagerLinks,
        hugeScanMs: hugeScanMs,
        hugeSecondScanMs: hugeSecondScanMs,
        dedupeHoverConnected: dedupeHoverConnected,
        dedupeSentinelConnected: dedupeSentinelConnected,
        dedupeSecondRowConnected: dedupeSecondRowConnected,
        dedupeMarkdownCount: dedupeMarkdownCount,
        dedupeTextLength: dedupeTextLength,
        lazyHoverProbe: lazyHoverProbe,
        small: smallSnap,
        largeConnectedAfterSmall: largeConnectedAfterSmall,
        smallConnectedAfterEmptyRoot: smallConnectedAfterEmptyRoot,
        orphanConnectedAfterSmall: orphanConnectedAfterSmall,
        lateHandleConnectedAfterCleanup: lateHandleConnectedAfterCleanup,
        bodyHandleConnectedAfterCleanup: bodyHandleConnectedAfterCleanup,
        unownedBodyHandleConnectedAfterCleanup: unownedBodyHandleConnectedAfterCleanup,
        topBodyHandleConnectedAfterCleanup: topBodyHandleConnectedAfterCleanup,
        workbenchSashConnectedAfterCleanup: workbenchSashConnectedAfterCleanup,
        topWorkbenchSashConnectedAfterCleanup: topWorkbenchSashConnectedAfterCleanup,
        mutatingHandleConnectedAfterCleanup: mutatingHandleConnectedAfterCleanup,
        inactiveAfterSmall: inactiveAfterSmall,
        hiddenActiveWasActive: hiddenActiveWasActive,
        hiddenActiveStillActive: hiddenActiveStillActive,
        hiddenActiveConnectedAfterPrune: hiddenActiveConnectedAfterPrune,
        hiddenActiveCurrentActive: hiddenActiveCurrentActive,
        stickyFarProbe: stickyFarProbe,
        nativePopupNearProbe: nativePopupNearProbe
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await ensureRendererPatchForHarness();
      await cleanupRendererTestArtifactsAcrossWindowsForTests();
    }
    try {
      return await evaluateInMainProcessForTests(mainExpr, 30000);
    } catch (err) {
      lastError = err;
      if (!/timed out|socket is not open/i.test(String(err instanceof Error ? err.message : err))) {
        break;
      }
      log.warn(`[test] renderer hover harness attempt ${attempt + 1} failed: ${err}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runHoverSplitColumnHarnessForTests(): Promise<any[]> {
  await ensureRendererPatchForHarness();
  await cleanupRendererTestArtifactsAcrossWindowsForTests();
  const rendererExpr = `
    (async function() {
      var hooks = window.__irTestHooks;
      function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function tick() { return Promise.resolve(); }
      function removeAll(selector) {
        Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function(el) {
          try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
        });
      }
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        var r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      function handleVisibleCount(root) {
        var count = 0;
        var handles = root ? root.querySelectorAll('.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler') : [];
        for (var i = 0; i < handles.length; i++) {
          try {
            var cs = window.getComputedStyle(handles[i]);
            var r = handles[i].getBoundingClientRect();
            if (cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0) count++;
          } catch (_) {}
        }
        return count;
      }
      function linkTypes(root) {
        var out = [];
        var links = root ? root.querySelectorAll('.ir-type-link') : [];
        for (var i = 0; i < links.length && out.length < 80; i++) {
          out.push(links[i].getAttribute('data-type') || '');
        }
        return out;
      }
      function missingFragments(text, fragments) {
        var out = [];
        text = String(text || '');
        for (var i = 0; i < fragments.length; i++) {
          if (text.indexOf(fragments[i]) < 0) out.push(fragments[i]);
        }
        return out;
      }
      function presentFragments(text, fragments) {
        var out = [];
        text = String(text || '');
        for (var i = 0; i < fragments.length; i++) {
          if (text.indexOf(fragments[i]) >= 0) out.push(fragments[i]);
        }
        return out;
      }
      function makeHover(left, top) {
        var hover = document.createElement('div');
        hover.className = 'monaco-hover ir-e2e-hover ir-e2e-split-column-hover';
        hover.style.cssText = 'position:fixed;left:' + left + 'px;top:' + top + 'px;z-index:2147483647;background:Canvas;color:CanvasText;';
        var sc = document.createElement('div');
        sc.className = 'monaco-scrollable-element';
        var content = document.createElement('div');
        content.className = 'monaco-hover-content';
        sc.appendChild(content);
        var scrollbar = document.createElement('div');
        scrollbar.className = 'invisible scrollbar vertical';
        scrollbar.style.cssText = 'position:absolute;right:0;top:0;width:12px;height:360px;display:block;visibility:visible;background:#007fd4;';
        var slider = document.createElement('div');
        slider.className = 'slider';
        slider.style.cssText = 'width:12px;height:320px;display:block;visibility:visible;background:#007fd4;';
        scrollbar.appendChild(slider);
        sc.appendChild(scrollbar);
        hover.appendChild(sc);
        hover.__irSeenAt = Date.now();
        var host = document.querySelector('.monaco-workbench') || document.querySelector('.part.editor') || document.body;
        host.appendChild(hover);
        return hover;
      }
      function populateHover(hover, text) {
        var content = hover.querySelector('.monaco-hover-content');
        var row = document.createElement('div');
        row.className = 'hover-row';
        var rowContents = document.createElement('div');
        rowContents.className = 'hover-row-contents';
        var md = document.createElement('div');
        md.className = 'rendered-markdown ir-applied';
        md.textContent = text;
        rowContents.appendChild(md);
        row.appendChild(rowContents);
        content.appendChild(row);
        return md;
      }
      function activeHover() {
        return window.__irActiveHoverEl && document.body.contains(window.__irActiveHoverEl)
          ? window.__irActiveHoverEl
          : null;
      }
      function visibleEditorCount() {
        var count = 0;
        var editors = document.querySelectorAll('.monaco-editor');
        for (var i = 0; i < editors.length; i++) {
          try {
            var r = editors[i].getBoundingClientRect();
            var cs = window.getComputedStyle(editors[i]);
            if (r.width > 80 && r.height > 80 && cs.display !== 'none' && cs.visibility !== 'hidden') count++;
          } catch (_) {}
        }
        return count;
      }
      var eventLog = [];
      function logSplitEvent(name, data) {
        var entry = { name: name, time: Date.now(), data: data || {} };
        eventLog.push(entry);
        try {
          if (typeof console !== 'undefined' && console.info) {
            console.info('[split-column-hover-e2e]', name, data || {});
          }
        } catch (_) {}
        return entry;
      }
      function resolvedColor(value) {
        if (!value) return '';
        var probe = document.createElement('span');
        probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;color:' + value + ';';
        probe.textContent = 'x';
        document.body.appendChild(probe);
        var color = '';
        try { color = window.getComputedStyle(probe).color || ''; } catch (_) {}
        try { probe.parentNode && probe.parentNode.removeChild(probe); } catch (_) {}
        return color;
      }
      function inheritedCssVar(el, name) {
        var cur = el || null;
        while (cur) {
          try {
            var value = window.getComputedStyle(cur).getPropertyValue(name);
            if (value && String(value).trim()) return String(value).trim();
          } catch (_) {}
          cur = cur.parentElement || null;
        }
        try {
          var bodyValue = window.getComputedStyle(document.body).getPropertyValue(name);
          if (bodyValue && String(bodyValue).trim()) return String(bodyValue).trim();
        } catch (_) {}
        try {
          var rootValue = window.getComputedStyle(document.documentElement).getPropertyValue(name);
          if (rootValue && String(rootValue).trim()) return String(rootValue).trim();
        } catch (_) {}
        return '';
      }
      function findTypeLink(root, typeName) {
        var links = root ? root.querySelectorAll('.ir-type-link') : [];
        for (var i = 0; i < links.length; i++) {
          var dataType = links[i].getAttribute('data-type') || '';
          var text = String(links[i].textContent || '').trim();
          if (dataType === typeName || text === typeName) return links[i];
        }
        return null;
      }
      function eventAt(type, Ctor, target, x, y) {
        if (!target) return false;
        try {
          var ev = new (Ctor || window.MouseEvent)(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
          });
          target.dispatchEvent(ev);
          return true;
        } catch (_) {}
        try {
          var legacy = document.createEvent('MouseEvents');
          legacy.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
          target.dispatchEvent(legacy);
          return true;
        } catch (_) {}
        return false;
      }
      function linkHoverState(link) {
        if (!link) return {
          exists: false,
          pointActive: false,
          underline: false,
          themeApplied: false,
          color: '',
          expectedLinkColor: '',
          textDecorationLine: '',
          className: ''
        };
        var style = null;
        try { style = window.getComputedStyle(link); } catch (_) {}
        var expectedRaw = inheritedCssVar(link, '--vscode-textLink-foreground');
        var expected = resolvedColor(expectedRaw);
        var color = style ? (style.color || '') : '';
        var decoration = style ? String(style.textDecorationLine || style.textDecoration || '') : '';
        return {
          exists: true,
          pointActive: !!(link.classList && link.classList.contains('ir-point-active')),
          underline: /underline/i.test(decoration),
          themeApplied: expected ? color === expected : false,
          color: color,
          expectedLinkColor: expected,
          expectedLinkColorRaw: expectedRaw,
          textDecorationLine: decoration,
          className: String(link.className || '')
        };
      }
      function hoverSnapshot(root, link) {
        var active = activeHover();
        var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        var rootText = String(root ? root.textContent || '' : '');
        var activeText = String(active ? active.textContent || '' : '');
        return {
          hoverCount: roots.length,
          activeIsRoot: active === root,
          rootConnected: !!(root && document.body.contains(root)),
          activeConnected: !!(active && document.body.contains(active)),
          rootRect: rectObj(root),
          activeRect: rectObj(active),
          linkRect: rectObj(link),
          linkText: link ? String(link.textContent || '') : '',
          linkType: link ? String(link.getAttribute('data-type') || '') : '',
          linkClassName: link ? String(link.className || '') : '',
          linkState: linkHoverState(link),
          rootTextLength: rootText.length,
          activeTextLength: activeText.length,
          rootTextSample: rootText.slice(0, 240),
          activeTextSample: activeText.slice(0, 240),
          linkTypes: linkTypes(root).slice(0, 20),
          handleVisibleCount: handleVisibleCount(root)
        };
      }
      async function hoverTypeLink(root, typeName) {
        var link = findTypeLink(root, typeName);
        var before = linkHoverState(link);
        logSplitEvent('symbol-hover-before', { typeName: typeName, state: before, snapshot: hoverSnapshot(root, link) });
        if (!link) {
          return {
            ok: false,
            reason: 'missing-link',
            typeName: typeName,
            eventCount: 0,
            before: before,
            after: before
          };
        }
        try { link.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        await tick();
        var r = link.getBoundingClientRect();
        var x = Math.max(r.left + 1, Math.min(r.right - 1, r.left + (r.width / 2)));
        var y = Math.max(r.top + 1, Math.min(r.bottom - 1, r.top + (r.height / 2)));
        var emptyOverlay = document.createElement('div');
        emptyOverlay.className = 'monaco-hover ir-e2e-empty-hover ir-e2e-link-empty-overlay';
        emptyOverlay.style.cssText = 'position:fixed;left:'+(x-24)+'px;top:'+(y-14)+'px;width:48px;height:28px;z-index:2147483647;background:transparent;';
        document.body.appendChild(emptyOverlay);
        try {
          if (hooks && typeof hooks.activateHoverRoot === 'function') hooks.activateHoverRoot(emptyOverlay, 'e2e-link-empty-overlay');
          else if (hooks && typeof hooks.refreshEmptyHoverRootState === 'function') hooks.refreshEmptyHoverRootState(emptyOverlay);
        } catch (_) {}
        await tick();
        var hit = null;
        try { hit = document.elementFromPoint(x, y); } catch (_) {}
        var hitIsLink = !!(hit && (hit === link || (link.contains && link.contains(hit))));
        var emptyOverlayPointerEvents = '';
        try { emptyOverlayPointerEvents = window.getComputedStyle(emptyOverlay).pointerEvents || ''; } catch (_) {}
        var target = hitIsLink ? hit : link;
        var events = [
          ['pointerover', window.PointerEvent || window.MouseEvent],
          ['mouseover', window.MouseEvent],
          ['pointerenter', window.PointerEvent || window.MouseEvent],
          ['mouseenter', window.MouseEvent],
          ['pointermove', window.PointerEvent || window.MouseEvent],
          ['mousemove', window.MouseEvent]
        ];
        var fired = 0;
        var eventResults = [];
        for (var ei = 0; ei < events.length; ei++) {
          var didFire = eventAt(events[ei][0], events[ei][1], target, x, y);
          if (didFire) fired++;
          var eventState = linkHoverState(link);
          var eventSnapshot = hoverSnapshot(root, link);
          eventResults.push({
            event: events[ei][0],
            fired: didFire,
            state: eventState,
            snapshot: eventSnapshot
          });
          logSplitEvent('symbol-hover-event', {
            typeName: typeName,
            event: events[ei][0],
            fired: didFire,
            targetClass: target && target.className ? String(target.className) : '',
            point: { x: x, y: y },
            state: eventState,
            snapshot: eventSnapshot
          });
        }
        await tick();
        var after = linkHoverState(link);
        var afterSnapshot = hoverSnapshot(root, link);
        try { emptyOverlay.parentNode && emptyOverlay.parentNode.removeChild(emptyOverlay); } catch (_) {}
        logSplitEvent('symbol-hover-after', { typeName: typeName, eventCount: fired, state: after, snapshot: afterSnapshot });
        var strictEventsOk = eventResults.length === events.length && fired === events.length;
        for (var eri = 0; eri < eventResults.length; eri++) {
          var ers = eventResults[eri].state || {};
          strictEventsOk = strictEventsOk
            && !!eventResults[eri].fired
            && !!ers.exists
            && !!ers.pointActive
            && !!ers.underline
            && !!ers.themeApplied
            && !!ers.color
            && ers.color === ers.expectedLinkColor;
        }
        return {
          ok: strictEventsOk && hitIsLink && after.exists && after.pointActive && after.underline && after.themeApplied,
          reason: !hitIsLink ? 'empty-hover-overlay-blocked-link' : (after.exists ? 'ok' : 'missing-link-after-hover'),
          typeName: typeName,
          eventCount: fired,
          rect: rectObj(link),
          hitClass: hit && hit.className ? String(hit.className) : '',
          hitIsLink: hitIsLink,
          emptyOverlayPointerEvents: emptyOverlayPointerEvents,
          emptyOverlayClassName: String(emptyOverlay.className || ''),
          before: before,
          after: after,
          afterSnapshot: afterSnapshot,
          eventResults: eventResults
        };
      }
      async function pointerDownFallbackProbe(root,typeName){
        var link=findTypeLink(root,typeName);
        if(!link)return {ok:false,reason:'missing-link',payloads:[]};
        try { link.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        await tick();
        var r=link.getBoundingClientRect();
        var x=Math.max(r.left+1,Math.min(r.right-1,r.left+(r.width/2)));
        var y=Math.max(r.top+1,Math.min(r.bottom-1,r.top+(r.height/2)));
        var payloads=[];
        var original=window.irGoToType;
        window.irGoToType=function(payload){
          try{payloads.push(String(payload))}catch(_){}
          if(String(payload||'').indexOf('LOG:')===0&&typeof original==='function'){
            try{return original.apply(window,arguments)}catch(_){}
          }
          return undefined;
        };
        try{
          eventAt('pointerdown',window.PointerEvent||window.MouseEvent,link,x,y);
          eventAt('mousedown',window.MouseEvent,link,x,y);
          await wait(260);
        }finally{
          window.irGoToType=original;
        }
        return {
          ok:payloads.indexOf('PREVIEW:'+typeName)>=0,
          payloads:payloads,
          rect:rectObj(link),
          linkState:linkHoverState(link)
        };
      }
      async function nearLinkProbe(root,typeName){
        var link=findTypeLink(root,typeName);
        if(!link)return {ok:false,reason:'missing-link'};
        try { link.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        await tick();
        var r=link.getBoundingClientRect();
        var x=Math.round((r.left+(r.width/2))*100)/100;
        var y=Math.max(1,Math.round((r.top-1)*100)/100);
        var target=null;
        try{target=document.elementFromPoint(x,y)}catch(_){}
        if(!target)target=link;
        eventAt('pointermove',window.PointerEvent||window.MouseEvent,target,x,y);
        eventAt('mousemove',window.MouseEvent,target,x,y);
        await tick();
        var state=linkHoverState(link);
        var active=window.__irPointActiveLink||null;
        return {
          ok:!!(state&&state.pointActive&&state.underline&&state.themeApplied),
          reason:state&&state.pointActive?'ok':'near-link-not-active',
          typeName:typeName,
          point:{x:x,y:y},
          targetClass:target&&target.className?String(target.className):'',
          targetText:target?String(target.textContent||'').slice(0,80):'',
          linkRect:rectObj(link),
          activeType:active&&active.getAttribute?String(active.getAttribute('data-type')||''):'',
          activeText:active?String(active.textContent||'').slice(0,80):'',
          activeRect:rectObj(active),
          state:state
        };
      }
      if (!hooks || typeof hooks.scanRenderedMarkdown !== 'function' || typeof hooks.makeHoverScrollable !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      removeAll('.ir-e2e-split-column-hover,.ir-e2e-hover,.ir-e2e-external-artifact,.ir-e2e-body-handle');
      window.__irActiveHoverEl = null;
      window.__irOriginalHoverSnapshot = null;
      window.__irHistoryFor = null;
      window.__irHistory = [];
      window.__irHistoryCurrent = null;
      window.__irLastPreviewTarget = null;
      var editorGroupCount = document.querySelectorAll('.editor-group-container').length;
      var renderedEditorCount = visibleEditorCount();
      logSplitEvent('setup', { editorGroupCount: editorGroupCount, renderedEditorCount: renderedEditorCount });

      var left = makeHover(32, 40);
      logSplitEvent('left-created', { rect: rectObj(left) });
      populateHover(left, [
        'class Company(TimestampedModel):',
        '    STATUS_ACTIVE = "active"',
        '    owner: User',
        '    def get_owner(self) -> User:',
        '        return self.owner'
      ].join('\\n'));
      logSplitEvent('left-populated', { textLength: String(left.textContent || '').length });
      hooks.makeHoverScrollable(left, true, (left.textContent || '').length);
      try { hooks.scanRenderedMarkdown(); } catch (_) {}
      await tick();
      var leftActiveBeforeRight = activeHover() === left;
      var leftRect = rectObj(left);
      logSplitEvent('left-after-scan', {
        active: leftActiveBeforeRight,
        connected: document.body.contains(left),
        rect: leftRect,
        linkTypes: linkTypes(left)
      });

      var right = makeHover(Math.max(640, Math.floor((window.innerWidth || 1200) * 0.56)), 40);
      logSplitEvent('right-empty-created', { rect: rectObj(right) });
      await tick();
      try { hooks.scanRenderedMarkdown(); } catch (_) {}
      await tick();
      var rightEmptyDidNotClearLeft = activeHover() === left && document.body.contains(left) && document.body.contains(right);
      logSplitEvent('right-empty-after-scan', {
        rightEmptyDidNotClearLeft: rightEmptyDidNotClearLeft,
        leftConnected: document.body.contains(left),
        rightConnected: document.body.contains(right),
        activeTextLength: String(activeHover() ? activeHover().textContent || '' : '').length,
        activeTextSample: String(activeHover() ? activeHover().textContent || '' : '').slice(0, 400),
        leftTextSample: String(left.textContent || '').slice(0, 400),
        rightTextSample: String(right.textContent || '').slice(0, 400)
      });

      populateHover(right, [
        'class User(TimestampedModel):',
        '    name: str',
        '    email: str',
        '    def get_display_name(self) -> str:',
        '        return self.name'
      ].join('\\n'));
      logSplitEvent('right-populated', { textLength: String(right.textContent || '').length });
      hooks.makeHoverScrollable(right, true, (right.textContent || '').length);
      try { hooks.scanRenderedMarkdown(); } catch (_) {}
      await tick();
      for (var cleanAttempt = 0; cleanAttempt < 18; cleanAttempt++) {
        var cleanRoots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        if (cleanRoots.length <= 1) break;
        await wait(90);
        try { hooks.scanRenderedMarkdown(); } catch (_) {}
      }

      var active = activeHover();
      var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
      var rightTypes = linkTypes(right);
      var activeText = String(active ? active.textContent || '' : '');
      var rightExpectedFragments = ['class User', 'def get_display_name', 'return self.name'];
      var rightStaleLeftFragments = ['class Company', 'STATUS_ACTIVE', 'def get_owner'];
      var rightMissingExpectedFragments = missingFragments(activeText, rightExpectedFragments);
      var rightPresentStaleFragments = presentFragments(activeText, rightStaleLeftFragments);
      var rightRect = rectObj(right);
      var rightActiveAfterScan = active === right;
      var leftConnectedAfterScan = document.body.contains(left);
      var rightConnectedAfterScan = document.body.contains(right);
      var hoverCountAfterScan = roots.length;
      var rightHandleVisibleCountAfterScan = handleVisibleCount(right);
      logSplitEvent('right-after-scan', {
        active: rightActiveAfterScan,
        leftConnected: leftConnectedAfterScan,
        rightConnected: rightConnectedAfterScan,
        hoverCount: hoverCountAfterScan,
        rect: rightRect,
        linkTypes: rightTypes,
        handleVisibleCount: rightHandleVisibleCountAfterScan,
        activeTextSample: activeText.slice(0, 400),
        rightTextSample: String(right.textContent || '').slice(0, 400),
        leftTextSample: String(left.textContent || '').slice(0, 400),
        rightMissingExpectedFragments: rightMissingExpectedFragments,
        rightPresentStaleFragments: rightPresentStaleFragments
      });
      var symbolHover = await hoverTypeLink(right, 'TimestampedModel');
      var nearLinkHover = await nearLinkProbe(right, 'TimestampedModel');
      var pointerDownFallback = await pointerDownFallbackProbe(right, 'TimestampedModel');
      var result = {
        ok: rightActiveAfterScan
          && !leftConnectedAfterScan
          && rightConnectedAfterScan
          && hoverCountAfterScan === 1
          && (editorGroupCount >= 2 || renderedEditorCount >= 2)
          && rightTypes.indexOf('TimestampedModel') >= 0
          && rightMissingExpectedFragments.length === 0
          && rightPresentStaleFragments.length === 0
          && rightHandleVisibleCountAfterScan === 0
          && symbolHover.ok
          && nearLinkHover.ok
          && pointerDownFallback.ok,
        patchVersion: Number(window.__irPatchVersion) || 0,
        editorGroupCount: editorGroupCount,
        renderedEditorCount: renderedEditorCount,
        leftActiveBeforeRight: leftActiveBeforeRight,
        rightEmptyDidNotClearLeft: rightEmptyDidNotClearLeft,
        rightActiveAfterPopulate: rightActiveAfterScan,
        leftConnectedAfterRight: leftConnectedAfterScan,
        rightConnectedAfterPopulate: rightConnectedAfterScan,
        hoverCountAfterRight: hoverCountAfterScan,
        leftRect: leftRect,
        rightRect: rightRect,
        rightLinkTypes: rightTypes,
        rightActiveText: activeText.slice(0, 2000),
        rightExpectedFragments: rightExpectedFragments,
        rightStaleLeftFragments: rightStaleLeftFragments,
        rightMissingExpectedFragments: rightMissingExpectedFragments,
        rightPresentStaleFragments: rightPresentStaleFragments,
        rightHandleVisibleCount: rightHandleVisibleCountAfterScan,
        hoveredSymbol: symbolHover.typeName,
        symbolHoverEventCount: symbolHover.eventCount,
        symbolPointActiveAfterHover: !!(symbolHover.after && symbolHover.after.pointActive),
        symbolUnderlineAfterHover: !!(symbolHover.after && symbolHover.after.underline),
        symbolThemeAppliedAfterHover: !!(symbolHover.after && symbolHover.after.themeApplied),
        symbolColorAfterHover: symbolHover.after ? symbolHover.after.color : '',
        symbolExpectedLinkColor: symbolHover.after ? symbolHover.after.expectedLinkColor : '',
        symbolTextDecorationLineAfterHover: symbolHover.after ? symbolHover.after.textDecorationLine : '',
        symbolHitIsLink: !!symbolHover.hitIsLink,
        symbolEmptyOverlayPointerEvents: symbolHover.emptyOverlayPointerEvents || '',
        symbolEmptyOverlayClassName: symbolHover.emptyOverlayClassName || '',
        symbolPointerDownFallbackPreview: !!pointerDownFallback.ok,
        symbolPointerDownFallback: pointerDownFallback,
        symbolNearLinkHover: nearLinkHover,
        symbolHover: symbolHover
      };
      logSplitEvent('result', {
        ok: result.ok,
        hoveredSymbol: result.hoveredSymbol,
        symbolHoverEventCount: result.symbolHoverEventCount,
        symbolUnderlineAfterHover: result.symbolUnderlineAfterHover,
        symbolThemeAppliedAfterHover: result.symbolThemeAppliedAfterHover,
        symbolNearLinkHover: !!(result.symbolNearLinkHover&&result.symbolNearLinkHover.ok),
        symbolPointerDownFallbackPreview: result.symbolPointerDownFallbackPreview
      });
      result.eventLog = eventLog.slice();
      try { right.parentNode && right.parentNode.removeChild(right); } catch (_) {}
      try { left.parentNode && left.parentNode.removeChild(left); } catch (_) {}
      try {
        if (window.__irActiveHoverEl === right || window.__irActiveHoverEl === left) window.__irActiveHoverEl = null;
        if (window.__irPointActiveLink && !document.body.contains(window.__irPointActiveLink)) window.__irPointActiveLink = null;
        window.__irOriginalHoverSnapshot = null;
        window.__irHistoryFor = null;
        window.__irHistory = [];
        window.__irHistoryCurrent = null;
        window.__irLastPreviewTarget = null;
      } catch (_) {}
      return result;
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 12000);
}

async function runNativeHoverGeometryHarnessForTests(input?: {
  symbol?: string;
  lineFragment?: string;
  expectedColumn?: 'left' | 'right' | 'any';
  expectedTextFragments?: string[];
  absentTextFragments?: string[];
}): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const symbol = String(input?.symbol || '');
  const lineFragment = String(input?.lineFragment || '');
  const expectedColumn = input?.expectedColumn === 'left' || input?.expectedColumn === 'right'
    ? input.expectedColumn
    : 'any';
  const expectedTextFragments = Array.isArray(input?.expectedTextFragments)
    ? input!.expectedTextFragments!.map(fragment => String(fragment)).filter(Boolean)
    : [];
  const absentTextFragments = Array.isArray(input?.absentTextFragments)
    ? input!.absentTextFragments!.map(fragment => String(fragment)).filter(Boolean)
    : [];
  const rendererExpr = `
    (function() {
      var expected = {
        symbol: ${JSON.stringify(symbol)},
        lineFragment: ${JSON.stringify(lineFragment)},
        expectedColumn: ${JSON.stringify(expectedColumn)},
        expectedTextFragments: ${JSON.stringify(expectedTextFragments)},
        absentTextFragments: ${JSON.stringify(absentTextFragments)}
      };
      function rectObjFromRect(r) {
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
      }
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        return rectObjFromRect(el.getBoundingClientRect());
      }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function visibleHover(root) {
        if (visible(root)) return true;
        if (!root || String(root.textContent || '').trim().length === 0) return false;
        var nodes = root.querySelectorAll ? root.querySelectorAll('.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown') : [];
        for (var ni = 0; ni < nodes.length; ni++) {
          if (visible(nodes[ni])) return true;
        }
        return false;
      }
      function hoverRectObj(root) {
        var rr = rectObj(root);
        if (rr && rr.width > 0 && rr.height > 0) return rr;
        var nodes = root && root.querySelectorAll ? root.querySelectorAll('.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown') : [];
        for (var ni = 0; ni < nodes.length; ni++) {
          if (visible(nodes[ni])) return rectObj(nodes[ni]);
        }
        return rr;
      }
      function visibleEditors() {
        var out = [];
        var nodes = document.querySelectorAll('.monaco-editor');
        for (var i = 0; i < nodes.length; i++) {
          if (!visible(nodes[i])) continue;
          if (nodes[i].closest('.monaco-hover,.monaco-editor-hover,.suggest-widget,.quick-input-widget')) continue;
          var r = nodes[i].getBoundingClientRect();
          if (r.width > 120 && r.height > 120) out.push(nodes[i]);
        }
        out.sort(function(a, b) { return a.getBoundingClientRect().left - b.getBoundingClientRect().left; });
        return out;
      }
      function normalizeText(text) {
        return String(text || '').replace(/\\u00a0/g, ' ');
      }
      function rangeForOffsets(textNodes, start, end) {
        var startNode = null, startOffset = 0, endNode = null, endOffset = 0;
        for (var i = 0; i < textNodes.length; i++) {
          var item = textNodes[i];
          var nodeStart = item.start;
          var nodeEnd = item.start + item.text.length;
          if (!startNode && start >= nodeStart && start <= nodeEnd) {
            startNode = item.node;
            startOffset = Math.max(0, Math.min(item.text.length, start - nodeStart));
          }
          if (!endNode && end >= nodeStart && end <= nodeEnd) {
            endNode = item.node;
            endOffset = Math.max(0, Math.min(item.text.length, end - nodeStart));
            break;
          }
        }
        if (!startNode || !endNode) return null;
        try {
          var range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          var rect = range.getBoundingClientRect();
          range.detach && range.detach();
          return rect && rect.width > 0 && rect.height > 0 ? rect : null;
        } catch (_) {
          return null;
        }
      }
      function findTextRectInLine(lineEl, symbol, fragment) {
        var textNodes = [];
        var full = '';
        try {
          var walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
          var node;
          while ((node = walker.nextNode())) {
            var text = normalizeText(node.nodeValue || '');
            textNodes.push({ node: node, text: text, start: full.length });
            full += text;
          }
        } catch (_) {}
        if (!full || full.indexOf(symbol) < 0) return null;
        if (fragment && full.indexOf(fragment) < 0) return null;
        var searchStart = 0;
        if (fragment) {
          var fragmentStart = full.indexOf(fragment);
          var inside = full.indexOf(symbol, fragmentStart);
          if (inside >= 0 && inside <= fragmentStart + fragment.length) searchStart = inside;
        }
        var idx = searchStart || full.indexOf(symbol);
        if (idx < 0) idx = full.indexOf(symbol);
        var rect = rangeForOffsets(textNodes, idx, idx + symbol.length);
        return rect ? { rect: rectObjFromRect(rect), lineText: full } : null;
      }
      function findSymbolGeometry() {
        var editors = visibleEditors();
        var expectedIndex = expected.expectedColumn === 'left'
          ? 0
          : (expected.expectedColumn === 'right' ? editors.length - 1 : -1);
        var candidates = [];
        for (var ei = 0; ei < editors.length; ei++) {
          var editor = editors[ei];
          var lines = editor.querySelectorAll('.view-line');
          for (var li = 0; li < lines.length; li++) {
            var lineText = normalizeText(lines[li].textContent || '');
            if (expected.lineFragment && lineText.indexOf(expected.lineFragment) < 0) continue;
            if (lineText.indexOf(expected.symbol) < 0) continue;
            var hit = findTextRectInLine(lines[li], expected.symbol, expected.lineFragment);
            if (!hit) continue;
            candidates.push({
              editor: editor,
              editorIndex: ei,
              editorRect: rectObj(editor),
              lineRect: rectObj(lines[li]),
              symbolRect: hit.rect,
              lineText: hit.lineText
            });
          }
        }
        if (expected.expectedColumn === 'left' || expected.expectedColumn === 'right') {
          candidates.sort(function(a, b) {
            var ar = a.editorRect || { left: 0 };
            var br = b.editorRect || { left: 0 };
            return ar.left - br.left;
          });
          var columnCandidate = expected.expectedColumn === 'left'
            ? candidates[0] || null
            : candidates[candidates.length - 1] || null;
          return columnCandidate || findSymbolGeometryFromMonacoApi(editors, expectedIndex);
        }
        if (expectedIndex >= 0) {
          for (var ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci].editorIndex === expectedIndex) return candidates[ci];
          }
        }
        return candidates[0] || findSymbolGeometryFromMonacoApi(editors, expectedIndex);
      }
      function findSymbolGeometryFromMonacoApi(editors, expectedIndex) {
        try {
          var api = window.monaco && window.monaco.editor;
          if (!api && typeof require === 'function') {
            try {
              var editorMain = require('vs/editor/editor.main');
              api = editorMain && editorMain.editor;
            } catch (_) {}
          }
          var apiEditors = api && typeof api.getEditors === 'function' ? api.getEditors() : [];
          var candidates = [];
          for (var ai = 0; ai < apiEditors.length; ai++) {
            var editor = apiEditors[ai];
            if (!editor || typeof editor.getModel !== 'function' || typeof editor.getDomNode !== 'function') continue;
            var model = editor.getModel && editor.getModel();
            var dom = editor.getDomNode && editor.getDomNode();
            if (!model || !dom || !visible(dom)) continue;
            var editorIndex = editors.indexOf(dom);
            if (editorIndex < 0) continue;
            var lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : 0;
            for (var lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
              var lineText = normalizeText(model.getLineContent(lineNumber) || '');
              if (expected.lineFragment && lineText.indexOf(expected.lineFragment) < 0) continue;
              if (lineText.indexOf(expected.symbol) < 0) continue;
              var fragmentStart = expected.lineFragment ? lineText.indexOf(expected.lineFragment) : 0;
              var idx = fragmentStart >= 0 ? lineText.indexOf(expected.symbol, fragmentStart) : lineText.indexOf(expected.symbol);
              if (idx < 0) idx = lineText.indexOf(expected.symbol);
              if (idx < 0) continue;
              if (typeof editor.revealPositionInCenterIfOutsideViewport === 'function') {
                try { editor.revealPositionInCenterIfOutsideViewport({ lineNumber: lineNumber, column: idx + 1 }); } catch (_) {}
              }
              var start = typeof editor.getScrolledVisiblePosition === 'function'
                ? editor.getScrolledVisiblePosition({ lineNumber: lineNumber, column: idx + 1 })
                : null;
              var end = typeof editor.getScrolledVisiblePosition === 'function'
                ? editor.getScrolledVisiblePosition({ lineNumber: lineNumber, column: idx + expected.symbol.length + 1 })
                : null;
              if (!start) continue;
              var er = rectObj(dom);
              if (!er) continue;
              var height = Math.max(8, Number(start.height) || 18);
              var width = Math.max(4, end && Number.isFinite(Number(end.left))
                ? Math.abs(Number(end.left) - Number(start.left))
                : expected.symbol.length * 8);
              var left = er.left + Number(start.left);
              var top = er.top + Number(start.top);
              var symbolRect = {
                left: left,
                top: top,
                right: left + width,
                bottom: top + height,
                width: width,
                height: height
              };
              candidates.push({
                editor: dom,
                editorIndex: editorIndex,
                editorRect: er,
                lineRect: {
                  left: er.left,
                  top: top,
                  right: er.right,
                  bottom: top + height,
                  width: er.width,
                  height: height
                },
                symbolRect: symbolRect,
                lineText: lineText,
                source: 'monaco-api'
              });
            }
          }
          if (expected.expectedColumn === 'left' || expected.expectedColumn === 'right') {
            candidates.sort(function(a, b) {
              var ar = a.editorRect || { left: 0 };
              var br = b.editorRect || { left: 0 };
              return ar.left - br.left;
            });
            return expected.expectedColumn === 'left'
              ? candidates[0] || null
              : candidates[candidates.length - 1] || null;
          }
          if (expectedIndex >= 0) {
            for (var ci = 0; ci < candidates.length; ci++) {
              if (candidates[ci].editorIndex === expectedIndex) return candidates[ci];
            }
          }
          return candidates[0] || null;
        } catch (_) {
          return null;
        }
      }
      function monacoApiEditorSummaries() {
        try {
          var api = window.monaco && window.monaco.editor;
          if (!api && typeof require === 'function') {
            try {
              var editorMain = require('vs/editor/editor.main');
              api = editorMain && editorMain.editor;
            } catch (_) {}
          }
          var apiEditors = api && typeof api.getEditors === 'function' ? api.getEditors() : [];
          var out = [];
          for (var ai = 0; ai < apiEditors.length && out.length < 12; ai++) {
            var editor = apiEditors[ai];
            var model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
            var dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
            var lineCount = model && typeof model.getLineCount === 'function' ? model.getLineCount() : 0;
            var samples = [];
            for (var lineNumber = 1; model && lineNumber <= lineCount && samples.length < 6; lineNumber++) {
              var line = normalizeText(model.getLineContent(lineNumber) || '').trim();
              if (line) samples.push(line.slice(0, 180));
            }
            out.push({
              index: ai,
              domVisible: !!(dom && visible(dom)),
              domEditorIndex: dom ? visibleEditors().indexOf(dom) : -1,
              uri: model && model.uri ? String(model.uri) : '',
              lineCount: lineCount,
              samples: samples,
              domClassName: dom ? String(dom.className || '') : '',
              domRect: rectObj(dom)
            });
          }
          return out;
        } catch (err) {
          return [{ error: String(err && err.message || err) }];
        }
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover')
          && !el.classList.contains('ir-test-seeded-hover');
      }
      function hoverRoots() {
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        for (var i = 0; i < roots.length; i++) {
          if (document.body.contains(roots[i]) && isActualHover(roots[i]) && visibleHover(roots[i])) out.push(roots[i]);
        }
        return out;
      }
      function rawHoverRoots() {
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        for (var i = 0; i < roots.length && out.length < 12; i++) {
          var root = roots[i];
          if (!document.body.contains(root) || !isActualHover(root)) continue;
          var cs = null;
          try { cs = window.getComputedStyle(root); } catch (_) {}
          out.push({
            index: i,
            className: String(root.className || ''),
            textLength: String(root.textContent || '').trim().length,
            textSample: normalizeText(root.textContent || '').trim().slice(0, 220),
            rect: rectObj(root),
            visible: visible(root),
            visibleHover: visibleHover(root),
            active: root === window.__irActiveHoverEl,
            released: !!(root.getAttribute && root.getAttribute('data-ir-native-released-hover') === '1'),
            ariaHidden: root.getAttribute ? root.getAttribute('aria-hidden') : null,
            style: {
              display: cs ? String(cs.display || '') : '',
              visibility: cs ? String(cs.visibility || '') : '',
              opacity: cs ? String(cs.opacity || '') : '',
              pointerEvents: cs ? String(cs.pointerEvents || '') : ''
            }
          });
        }
        return out;
      }
      function rectsIntersect(a, b, pad) {
        if (!a || !b) return false;
        pad = pad || 0;
        return a.right >= b.left - pad
          && a.left <= b.right + pad
          && a.bottom >= b.top - pad
          && a.top <= b.bottom + pad;
      }
      function unionRect(a, b) {
        if (!a) return b || null;
        if (!b) return a || null;
        return {
          left: Math.min(a.left, b.left),
          top: Math.min(a.top, b.top),
          right: Math.max(a.right, b.right),
          bottom: Math.max(a.bottom, b.bottom),
          width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
          height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)
        };
      }
      function handleKindAndAlignment(handleRect, hoverRect) {
        if (!handleRect || !hoverRect) return { kind: 'unknown', aligned: false };
        var centerX = (handleRect.left + handleRect.right) / 2;
        var centerY = (handleRect.top + handleRect.bottom) / 2;
        var nearRight = Math.abs(centerX - hoverRect.right) <= 18 || Math.abs(handleRect.right - hoverRect.right) <= 18;
        var nearBottom = Math.abs(centerY - hoverRect.bottom) <= 18 || Math.abs(handleRect.bottom - hoverRect.bottom) <= 18;
        var nearTop = Math.abs(centerY - hoverRect.top) <= 18 || Math.abs(handleRect.top - hoverRect.top) <= 18;
        var vertical = handleRect.height >= 18 && handleRect.width <= 32 && nearRight;
        var horizontal = handleRect.width >= 18 && handleRect.height <= 32 && nearBottom;
        var corner = handleRect.width <= 32 && handleRect.height <= 32 && nearRight && nearBottom;
        var topRight = handleRect.width <= 32 && handleRect.height <= 32 && nearRight && nearTop && !nearBottom;
        if (vertical) {
          return {
            kind: 'vertical',
            aligned: Math.abs(handleRect.top - hoverRect.top) <= 4
              && Math.abs(handleRect.bottom - hoverRect.bottom) <= 4
              && handleRect.height <= hoverRect.height + 8
          };
        }
        if (horizontal) {
          return {
            kind: 'horizontal',
            aligned: Math.abs(handleRect.left - hoverRect.left) <= 4
              && Math.abs(handleRect.right - hoverRect.right) <= 4
              && handleRect.width <= hoverRect.width + 8
          };
        }
        if (corner) return { kind: 'bottom-right-corner', aligned: true };
        if (topRight) return { kind: 'top-right-corner', aligned: false };
        return { kind: 'near-hover', aligned: false };
      }
      function hoverSashMetrics(root, hoverRect) {
        var selector = '.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler,[class*="scrollbar"],[class*="sash"]';
        var visibleHandles = [];
        var hiddenHandles = 0;
        var misaligned = [];
        var focusRect = hoverRect || null;
        var nodes = [];
        try {
          var inside = root && root.querySelectorAll ? root.querySelectorAll(selector) : [];
          for (var ii = 0; ii < inside.length; ii++) nodes.push({ el: inside[ii], ownedByHover: true });
        } catch (_) {}
        try {
          var all = document.querySelectorAll(selector);
          for (var ai = 0; ai < all.length; ai++) {
            if (root && root.contains && root.contains(all[ai])) continue;
            nodes.push({ el: all[ai], ownedByHover: false });
          }
        } catch (_) {}
        function externalHandleAssociated(r) {
          if (!r || !hoverRect) return false;
          if (!rectsIntersect(r, hoverRect, 16)) return false;
          if (r.width > 48 && r.height > 48) return false;
          var centerX = (r.left + r.right) / 2;
          var centerY = (r.top + r.bottom) / 2;
          var verticalEdge = r.height >= 18
            && r.width <= 32
            && centerX >= hoverRect.right - 10
            && centerX <= hoverRect.right + 10
            && r.bottom >= hoverRect.top - 12
            && r.top <= hoverRect.bottom + 12;
          var horizontalEdge = r.width >= 18
            && r.height <= 32
            && centerY >= hoverRect.bottom - 10
            && centerY <= hoverRect.bottom + 10
            && r.right >= hoverRect.left - 12
            && r.left <= hoverRect.right + 12;
          var bottomRightCorner = r.width <= 32
            && r.height <= 32
            && centerX >= hoverRect.right - 14
            && centerX <= hoverRect.right + 14
            && centerY >= hoverRect.bottom - 14
            && centerY <= hoverRect.bottom + 14;
          var topRightCorner = r.width <= 32
            && r.height <= 32
            && centerX >= hoverRect.right - 14
            && centerX <= hoverRect.right + 14
            && centerY >= hoverRect.top - 14
            && centerY <= hoverRect.top + 14;
          return !!(verticalEdge || horizontalEdge || bottomRightCorner || topRightCorner);
        }
        for (var ni = 0; ni < nodes.length && visibleHandles.length + hiddenHandles < 80; ni++) {
          var item = nodes[ni];
          var el = item.el;
          if (!el || !document.body.contains(el)) continue;
          var r = rectObj(el);
          var associated = !!item.ownedByHover || externalHandleAssociated(r);
          if (!associated) continue;
          var isVisible = visible(el) && r && r.width > 0 && r.height > 0;
          if (!isVisible) {
            hiddenHandles++;
            continue;
          }
          var alignment = handleKindAndAlignment(r, hoverRect);
          var summary = {
            className: String(el.className || ''),
            rect: r,
            ownedByHover: !!item.ownedByHover,
            kind: alignment.kind,
            aligned: !!alignment.aligned
          };
          visibleHandles.push(summary);
          focusRect = unionRect(focusRect, r);
          if (!alignment.aligned) misaligned.push(summary);
        }
        var points = [];
        function addPoint(name, x, y) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          var clampedX = Math.max(1, Math.min(window.innerWidth - 2, x));
          var clampedY = Math.max(1, Math.min(window.innerHeight - 2, y));
          points.push({
            name: name,
            x: Math.round(clampedX * 100) / 100,
            y: Math.round(clampedY * 100) / 100
          });
        }
        if (focusRect) {
          addPoint('hover-center', (focusRect.left + focusRect.right) / 2, (focusRect.top + focusRect.bottom) / 2);
          addPoint('hover-right-edge', focusRect.right - 2, (focusRect.top + focusRect.bottom) / 2);
          addPoint('hover-bottom-edge', (focusRect.left + focusRect.right) / 2, focusRect.bottom - 2);
          addPoint('hover-bottom-right', focusRect.right - 2, focusRect.bottom - 2);
        }
        for (var vi = 0; vi < visibleHandles.length && vi < 4; vi++) {
          var hr = visibleHandles[vi].rect;
          addPoint('handle-' + vi + '-' + visibleHandles[vi].kind, (hr.left + hr.right) / 2, (hr.top + hr.bottom) / 2);
        }
        return {
          visibleHandleCount: visibleHandles.length,
          hiddenHandleCount: hiddenHandles,
          misalignedVisibleHandleCount: misaligned.length,
          misalignedVisibleHandles: misaligned.slice(0, 12),
          visibleHandles: visibleHandles.slice(0, 12),
          focusRect: focusRect,
          focusProbePoints: points
        };
      }
      function linkTypes(root) {
        var out = [];
        var links = root ? root.querySelectorAll('.ir-type-link') : [];
        for (var i = 0; i < links.length && out.length < 80; i++) {
          out.push(links[i].getAttribute('data-type') || '');
        }
        return out;
      }
      function overlapX(a, b) {
        if (!a || !b) return 0;
        return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      }
      function distancePointToRectX(x, r) {
        if (!r) return Infinity;
        if (x >= r.left && x <= r.right) return 0;
        return Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      }
      function distanceRangeY(a, b) {
        if (!a || !b) return Infinity;
        if (a.bottom < b.top) return b.top - a.bottom;
        if (b.bottom < a.top) return a.top - b.bottom;
        return 0;
      }
      var symbolGeometry = findSymbolGeometry();
      var editors = visibleEditors();
      var expectedEditor = symbolGeometry ? editors[symbolGeometry.editorIndex] : null;
      var expectedEditorRect = symbolGeometry ? symbolGeometry.editorRect : null;
      function hoverSummary(root, index) {
        var rect = hoverRectObj(root);
        var text = normalizeText(root ? root.textContent || '' : '');
        var trimmed = text.trim();
        var missingExpected = [];
        for (var mi = 0; mi < expected.expectedTextFragments.length; mi++) {
          var fragment = expected.expectedTextFragments[mi];
          if (trimmed.indexOf(fragment) < 0) missingExpected.push(fragment);
        }
        var presentAbsent = [];
        for (var ai = 0; ai < expected.absentTextFragments.length; ai++) {
          var absent = expected.absentTextFragments[ai];
          if (trimmed.indexOf(absent) >= 0) presentAbsent.push(absent);
        }
        var hoverCenter = rect ? rect.left + rect.width / 2 : 0;
        var symbolCenter = symbolGeometry ? symbolGeometry.symbolRect.left + symbolGeometry.symbolRect.width / 2 : 0;
        var xDist = rect ? distancePointToRectX(symbolCenter, rect) : Infinity;
        var yDist = rect && symbolGeometry ? distanceRangeY(rect, symbolGeometry.symbolRect) : Infinity;
        var expectedOv = rect && expectedEditorRect ? overlapX(rect, expectedEditorRect) : 0;
        var otherOv = 0;
        for (var oi = 0; oi < editors.length; oi++) {
          if (symbolGeometry && oi === symbolGeometry.editorIndex) continue;
          otherOv = Math.max(otherOv, overlapX(rect, rectObj(editors[oi])));
        }
        var anchored = !!(rect && expectedEditorRect
          && expectedOv > 24
          && (
            xDist <= 80
            || (expectedOv >= otherOv
              && hoverCenter >= expectedEditorRect.left - 24
              && hoverCenter <= expectedEditorRect.right + 24)
          ));
        var near = !!(rect && symbolGeometry && xDist <= 80 && yDist <= 220);
        var contentMatches = missingExpected.length === 0 && presentAbsent.length === 0;
        var score = 0;
        if (contentMatches) score += 1000000;
        if (anchored) score += 100000;
        if (near) score += 10000;
        score += Math.min(5000, trimmed.length);
        if (root === window.__irActiveHoverEl) score += 250;
        return {
          index: index,
          rect: rect,
          textLength: trimmed.length,
          textSample: trimmed.slice(0, 1400),
          className: root ? String(root.className || '') : '',
          linkTypes: linkTypes(root),
          missingExpectedTextFragments: missingExpected,
          presentAbsentTextFragments: presentAbsent,
          contentMatches: contentMatches,
          hoverCenterX: hoverCenter,
          hoverDistanceToSymbolX: Number.isFinite(xDist) ? xDist : null,
          hoverDistanceToSymbolY: Number.isFinite(yDist) ? yDist : null,
          expectedColumnOverlap: expectedOv,
          maxOtherColumnOverlap: otherOv,
          hoverAnchoredToExpectedColumn: anchored,
          hoverNearSymbol: near,
          active: root === window.__irActiveHoverEl,
          score: score
        };
      }
      var roots = hoverRoots();
      var hoverCandidates = [];
      for (var hi = 0; hi < roots.length; hi++) hoverCandidates.push(hoverSummary(roots[hi], hi));
      hoverCandidates.sort(function(a, b) { return b.score - a.score; });
      var selected = hoverCandidates[0] || null;
      var hover = selected ? roots[selected.index] : null;
      var hoverRect = selected ? selected.rect : null;
      var sashMetrics = hoverSashMetrics(hover, hoverRect);
      var hoverText = selected ? selected.textSample : '';
      var hoverCenterX = hoverRect ? hoverRect.left + hoverRect.width / 2 : 0;
      var symbolCenterX = symbolGeometry ? symbolGeometry.symbolRect.left + symbolGeometry.symbolRect.width / 2 : 0;
      var symbolCenterY = symbolGeometry ? symbolGeometry.symbolRect.top + symbolGeometry.symbolRect.height / 2 : 0;
      var xDistance = selected && selected.hoverDistanceToSymbolX !== null ? selected.hoverDistanceToSymbolX : Infinity;
      var yDistance = selected && selected.hoverDistanceToSymbolY !== null ? selected.hoverDistanceToSymbolY : Infinity;
      var expectedOverlap = selected ? selected.expectedColumnOverlap : 0;
      var maxOtherOverlap = selected ? selected.maxOtherColumnOverlap : 0;
      var symbolInsideExpectedEditor = !!(symbolGeometry && expectedEditorRect
        && symbolGeometry.symbolRect.left >= expectedEditorRect.left - 1
        && symbolGeometry.symbolRect.right <= expectedEditorRect.right + 1
        && symbolGeometry.symbolRect.top >= expectedEditorRect.top - 1
        && symbolGeometry.symbolRect.bottom <= expectedEditorRect.bottom + 1);
      var hoverAnchoredToExpectedColumn = !!(selected && selected.hoverAnchoredToExpectedColumn);
      var hoverNearSymbol = !!(selected && selected.hoverNearSymbol);
      var contentMatches = !!(selected && selected.contentMatches);
      var contentMatchedHoverCount = 0;
      for (var cm = 0; cm < hoverCandidates.length; cm++) {
        if (hoverCandidates[cm].contentMatches) contentMatchedHoverCount++;
      }
      var ok = !!(symbolGeometry && hover && hoverRect)
        && roots.length === 1
        && selected.textLength > 40
        && contentMatches
        && symbolInsideExpectedEditor
        && hoverAnchoredToExpectedColumn
        && hoverNearSymbol;
      return {
        ok: ok,
        reason: ok ? 'ok'
          : (!symbolGeometry ? 'missing-symbol-geometry'
            : (!hover ? 'missing-hover'
              : (selected.textLength <= 40 ? 'empty-or-white-hover'
                : (!contentMatches ? 'hover-content-mismatch'
                  : (!hoverNearSymbol ? 'hover-not-near-symbol'
                    : (!hoverAnchoredToExpectedColumn ? 'hover-not-in-expected-column' : 'unknown')))))),
        patchVersion: Number(window.__irPatchVersion) || 0,
        windowTitle: String(document.title || ''),
        locationHref: String(location && location.href || ''),
        marker: ${JSON.stringify(process.env.IR_TEST_WINDOW_MARKER || '')},
        bodyHasMarker: !!(${JSON.stringify(process.env.IR_TEST_WINDOW_MARKER || '')} && String(document.body && document.body.textContent || '').indexOf(${JSON.stringify(process.env.IR_TEST_WINDOW_MARKER || '')}) >= 0),
        activeElement: (function(){
          var el = document.activeElement;
          return el ? {
            tagName: String(el.tagName || ''),
            className: String(el.className || ''),
            textSample: String(el.textContent || '').replace(/\\s+/g, ' ').slice(0, 220)
          } : null;
        })(),
        expected: expected,
        editorCount: editors.length,
        monacoApiEditors: monacoApiEditorSummaries(),
        editorRects: editors.map(function(editor, index) {
          var r = rectObj(editor);
          var lines = editor.querySelectorAll('.view-line');
          var lineSamples = [];
          for (var li = 0; li < lines.length && lineSamples.length < 12; li++) {
            var sample = normalizeText(lines[li].textContent || '').trim();
            if (sample) lineSamples.push(sample.slice(0, 180));
          }
          return {
            index: index,
            rect: r,
            className: String(editor.className || ''),
            textSample: String(editor.textContent || '').slice(0, 180),
            lineCount: lines.length,
            lineSamples: lineSamples
          };
        }),
        expectedColumnIndex: symbolGeometry ? symbolGeometry.editorIndex : null,
        symbolGeometry: symbolGeometry ? {
          editorIndex: symbolGeometry.editorIndex,
          editorRect: symbolGeometry.editorRect,
          lineRect: symbolGeometry.lineRect,
          symbolRect: symbolGeometry.symbolRect,
          lineText: symbolGeometry.lineText,
          source: symbolGeometry.source || 'dom-range'
        } : null,
        hoverCount: roots.length,
        rawHoverRoots: rawHoverRoots(),
        hoverSashMetrics: sashMetrics,
        contentMatchedHoverCount: contentMatchedHoverCount,
        hoverCandidates: hoverCandidates,
        hoverRect: hoverRect,
        hoverTextLength: selected ? selected.textLength : 0,
        hoverTextSample: selected ? selected.textSample : '',
        hoverClassName: hover ? String(hover.className || '') : '',
        linkTypes: selected ? selected.linkTypes : [],
        missingExpectedTextFragments: selected ? selected.missingExpectedTextFragments : expected.expectedTextFragments,
        presentAbsentTextFragments: selected ? selected.presentAbsentTextFragments : [],
        contentMatches: contentMatches,
        symbolInsideExpectedEditor: symbolInsideExpectedEditor,
        hoverAnchoredToExpectedColumn: hoverAnchoredToExpectedColumn,
        hoverNearSymbol: hoverNearSymbol,
        symbolCenter: { x: symbolCenterX, y: symbolCenterY },
        hoverCenterX: hoverCenterX,
        hoverDistanceToSymbolX: Number.isFinite(xDistance) ? xDistance : null,
        hoverDistanceToSymbolY: Number.isFinite(yDistance) ? yDistance : null,
        expectedColumnOverlap: expectedOverlap,
        maxOtherColumnOverlap: maxOtherOverlap
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 10000);
}

async function runNativePopupStateHarnessForTests(): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const rendererExpr = `
    (function() {
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        var r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none'
            && cs.visibility !== 'hidden'
            && Number(cs.opacity) !== 0
            && r.width > 0
            && r.height > 0;
        } catch (_) {
          return false;
        }
      }
      function describe(el, selector) {
        return {
          selector: selector,
          className: String(el && el.className || ''),
          text: String(el && el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
          rect: rectObj(el)
        };
      }
      var selectors = [
        '.action-widget',
        '.context-view',
        '.monaco-menu',
        '.quick-input-widget',
        '.suggest-widget',
        '.parameter-hints-widget',
        '.peekview-widget',
        '.rename-box',
        '.zone-widget',
        '.find-widget'
      ];
      var popups = [];
      for (var si = 0; si < selectors.length; si++) {
        var selector = selectors[si];
        var nodes = document.querySelectorAll(selector);
        for (var ni = 0; ni < nodes.length; ni++) {
          if (!document.body.contains(nodes[ni]) || !visible(nodes[ni])) continue;
          popups.push(describe(nodes[ni], selector));
        }
      }
      var active = window.__irActiveHoverEl && document.body.contains(window.__irActiveHoverEl)
        ? window.__irActiveHoverEl
        : null;
      return {
        ok: popups.length > 0,
        reason: popups.length > 0 ? 'ok' : 'no-native-popup',
        patchVersion: Number(window.__irPatchVersion) || 0,
        popupCount: popups.length,
        popups: popups.slice(0, 20),
        activeHover: active ? {
          className: String(active.className || ''),
          textLength: String(active.textContent || '').trim().length,
          rect: rectObj(active),
          connected: true
        } : null
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 5000);
}

async function cleanupNativeHoverInteractionStateForTests(reason?: string): Promise<any> {
  await ensureRendererPatchForHarness();
  const safeReason = JSON.stringify(String(reason || 'test-cleanup').slice(0, 120));
  const rendererExpr = `
    (function() {
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        try {
          var r = el.getBoundingClientRect();
          return {
            left: Math.round(r.left),
            top: Math.round(r.top),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom),
            width: Math.round(r.width),
            height: Math.round(r.height)
          };
        } catch (_) { return null; }
      }
      function visible(el) {
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none'
            && cs.visibility !== 'hidden'
            && Number(cs.opacity) !== 0
            && r.width > 1
            && r.height > 1;
        } catch (_) { return false; }
      }
      function brief(el) {
        return {
          className: String(el && el.className || ''),
          text: String(el && el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          rect: rectObj(el),
          visible: visible(el),
          active: el === window.__irActiveHoverEl
        };
      }
      var roots = Array.prototype.slice.call(document.querySelectorAll('.monaco-hover, .monaco-editor-hover'));
      var before = roots.map(brief).slice(0, 12);
      var removed = 0;
      var retainedNative = 0;
      var releasedHiddenActive = false;
      try { window.__irNativeHoverRefireUntil = 0; } catch (_) {}
      try { window.__irPointActiveLink = null; } catch (_) {}
      try { window.__irLastPreviewTarget = null; } catch (_) {}
      try { if (typeof window.__irCdpMouseProbeCleanup === 'function') window.__irCdpMouseProbeCleanup(); } catch (_) {}
      try {
        if (typeof irDisposeHiddenActiveHover === 'function') {
          releasedHiddenActive = !!irDisposeHiddenActiveHover(${safeReason});
        }
      } catch (_) {}
      roots = Array.prototype.slice.call(document.querySelectorAll('.monaco-hover, .monaco-editor-hover'));
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        if (!root || !document.body.contains(root)) continue;
        if (root.classList && (root.classList.contains('ir-e2e-hover') || root.classList.contains('ir-test-seeded-hover'))) continue;
        var isHidden = !visible(root)
          || (root.classList && (root.classList.contains('hidden') || root.classList.contains('ir-stale-hover')))
          || (root.getAttribute && root.getAttribute('aria-hidden') === 'true');
        if (!isHidden) continue;
        try {
          var forcedHover = root.getAttribute && root.getAttribute('data-ir-forced-hover') === '1';
          if (!forcedHover) {
            var rootText = String(root.textContent || '').trim();
            var rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
            var emptyNativeShell = !rootText
              && (!rootRect || rootRect.width <= 3 || rootRect.height <= 3);
            if (emptyNativeShell) {
              if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
              try {
                if (root.__irReleaseRemoveTimer) {
                  clearTimeout(root.__irReleaseRemoveTimer);
                  root.__irReleaseRemoveTimer = null;
                }
                root.__irReleasedAt = 0;
                root.__irReleasedText = '';
                if (root.classList) {
                  root.classList.remove('ir-native-released-hover', 'ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
                }
                if (root.removeAttribute) {
                  root.removeAttribute('data-ir-native-released-hover');
                  root.removeAttribute('data-ir-empty-hover-root');
                }
                if (root.classList) {
                  root.classList.add('hidden');
                }
                if (root.style) {
                  root.style.removeProperty('pointer-events');
                  root.style.removeProperty('display');
                  root.style.removeProperty('visibility');
                  root.style.removeProperty('opacity');
                }
              } catch (_) {}
              retainedNative++;
              continue;
            }
            if (rootText) {
              if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
              try {
                if (root.__irReleaseRemoveTimer) {
                  clearTimeout(root.__irReleaseRemoveTimer);
                  root.__irReleaseRemoveTimer = null;
                }
                root.__irReleasedAt = 0;
                root.__irReleasedText = '';
                root.__irPrimaryPreviewTarget = null;
                root.__irPreviewAppliedAt = 0;
                root.__irStickyUntil = 0;
                root.__irLastInsideAt = 0;
                if (root.classList) {
                  root.classList.remove('ir-native-released-hover', 'ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
                  root.classList.add('hidden');
                }
                if (root.removeAttribute) {
                  root.removeAttribute('data-ir-native-released-hover');
                  root.removeAttribute('data-ir-empty-hover-root');
                }
                if (root.style) {
                  root.style.removeProperty('pointer-events');
                  root.style.removeProperty('display');
                  root.style.removeProperty('visibility');
                  root.style.removeProperty('opacity');
                }
              } catch (_) {}
              retainedNative++;
              continue;
            }
            if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
            if (window.__irHistoryFor === root) {
              window.__irHistoryFor = null;
              window.__irHistory = [];
              window.__irHistoryCurrent = null;
            }
            if (window.__irOriginalHoverSnapshot && window.__irOriginalHoverSnapshot.hoverEl === root) {
              window.__irOriginalHoverSnapshot = null;
            }
            try {
              if (root.__irReleaseRemoveTimer) {
                clearTimeout(root.__irReleaseRemoveTimer);
                root.__irReleaseRemoveTimer = null;
              }
            } catch (_) {}
            if (root.classList) {
              root.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root', 'ir-native-released-hover');
            }
            if (root.removeAttribute) {
              root.removeAttribute('data-ir-empty-hover-root');
              root.removeAttribute('data-ir-native-released-hover');
            }
            try {
              root.__irReleasedAt = 0;
              root.__irReleasedText = '';
              root.__irPrimaryPreviewTarget = null;
              root.__irPreviewAppliedAt = 0;
              root.__irStickyUntil = 0;
              root.__irLastInsideAt = 0;
            } catch (_) {}
            if (root.style) {
              var retainedRootProps = ['--ir-hover-width', '--ir-hover-height', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'overflow', 'overflow-x', 'overflow-y', 'box-sizing', 'margin-left', 'margin-top', 'pointer-events', 'display', 'visibility', 'opacity'];
              for (var rrp = 0; rrp < retainedRootProps.length; rrp++) root.style.removeProperty(retainedRootProps[rrp]);
            }
            try {
              var retainedNodes = root.querySelectorAll ? root.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown') : [];
              var retainedProps = ['width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'overflow', 'overflow-x', 'overflow-y', 'scrollbar-width', 'scrollbar-color', 'overscroll-behavior', 'position', 'box-sizing', 'transform', 'top', 'left'];
              for (var rni = 0; rni < retainedNodes.length; rni++) {
                for (var rpi = 0; rpi < retainedProps.length; rpi++) retainedNodes[rni].style.removeProperty(retainedProps[rpi]);
              }
            } catch (_) {}
            retainedNative++;
            continue;
          }
          if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
          if (window.__irHistoryFor === root) {
            window.__irHistoryFor = null;
            window.__irHistory = [];
            window.__irHistoryCurrent = null;
          }
          if (window.__irOriginalHoverSnapshot && window.__irOriginalHoverSnapshot.hoverEl === root) {
            window.__irOriginalHoverSnapshot = null;
          }
          if (root.classList) {
            root.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root', 'ir-native-released-hover');
          }
          if (root.removeAttribute) {
            root.removeAttribute('data-ir-empty-hover-root');
            root.removeAttribute('data-ir-native-released-hover');
          }
          try {
            root.__irReleasedAt = 0;
            root.__irReleasedText = '';
            root.__irPrimaryPreviewTarget = null;
            root.__irPreviewAppliedAt = 0;
            root.__irStickyUntil = 0;
            root.__irLastInsideAt = 0;
          } catch (_) {}
          if (root.style) {
            var rootProps = ['--ir-hover-width', '--ir-hover-height', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'overflow', 'overflow-x', 'overflow-y', 'box-sizing', 'margin-left', 'margin-top', 'pointer-events', 'display', 'visibility', 'opacity'];
            for (var rp = 0; rp < rootProps.length; rp++) root.style.removeProperty(rootProps[rp]);
          }
          try {
            var nodes = root.querySelectorAll ? root.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown') : [];
            var props = ['width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'overflow', 'overflow-x', 'overflow-y', 'scrollbar-width', 'scrollbar-color', 'overscroll-behavior', 'position', 'box-sizing', 'transform', 'top', 'left'];
            for (var ni = 0; ni < nodes.length; ni++) {
              for (var pi = 0; pi < props.length; pi++) nodes[ni].style.removeProperty(props[pi]);
            }
          } catch (_) {}
          if (root.parentNode) root.parentNode.removeChild(root);
          removed++;
        } catch (_) {}
      }
      var afterRoots = Array.prototype.slice.call(document.querySelectorAll('.monaco-hover, .monaco-editor-hover'));
      return {
        ok: true,
        reason: ${safeReason},
        patchVersion: Number(window.__irPatchVersion) || 0,
        releasedHiddenActive: releasedHiddenActive,
        removed: removed,
        retainedNative: retainedNative,
        before: before,
        after: afterRoots.map(brief).slice(0, 12),
        activeHover: window.__irActiveHoverEl && document.body.contains(window.__irActiveHoverEl)
          ? brief(window.__irActiveHoverEl)
          : null
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  const rows = await evaluateInMainProcessForTests(mainExpr, 5000);
  return Array.isArray(rows)
    ? rows.map((row: any) => row?.value).find(Boolean) || rows
    : rows;
}

async function dismissNativeKeybindingRecorderForTests(): Promise<any> {
  await ensureRendererPatchForHarness();
  const rendererExpr = `
    (function() {
      var needle = 'Press desired key combination and then press ENTER.';
      function text(el) {
        return String(el && el.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        try {
          var r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        } catch (_) {
          return null;
        }
      }
      function brief(el) {
        return {
          tagName: String(el && el.tagName || ''),
          className: String(el && el.className || ''),
          text: text(el).slice(0, 180),
          viewLineCount: el && el.querySelectorAll ? el.querySelectorAll('.view-line').length : 0,
          rect: rectObj(el)
        };
      }
      var all = Array.prototype.slice.call(document.querySelectorAll('.monaco-editor, .quick-input-widget, .context-view, .monaco-dialog-box, .monaco-inputbox'));
      var removed = 0;
      var hidden = 0;
      var matched = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var elText = text(el);
        if (elText.indexOf(needle) < 0) continue;
        matched.push(brief(el));
        try {
          if (el.classList && el.classList.contains('monaco-editor')) {
            var viewLines = el.querySelectorAll ? el.querySelectorAll('.view-line').length : 0;
            var isRecorderOnlyEditor = viewLines === 0
              && text(el).indexOf(needle) >= 0
              && !(el.closest && el.closest('.monaco-hover,.monaco-editor-hover,.suggest-widget'));
            if (isRecorderOnlyEditor) {
              if (el.parentNode) {
                el.parentNode.removeChild(el);
                removed++;
                continue;
              }
              if (el.style) {
                el.style.display = 'none';
                el.style.pointerEvents = 'none';
                hidden++;
              }
            }
            continue;
          }
          var removable = el.closest && (
            el.closest('.quick-input-widget')
            || el.closest('.context-view')
            || el.closest('.monaco-dialog-box')
          ) || el;
          if (removable && removable !== el && removable.parentNode) {
            removable.parentNode.removeChild(removable);
            removed++;
          }
        } catch (_) {
          try { if (el.style && !el.classList.contains('monaco-editor')) { el.style.display = 'none'; hidden++; } } catch (_) {}
        }
      }
      try { document.body && document.body.focus && document.body.focus(); } catch (_) {}
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        removed: removed,
        hidden: hidden,
        matched: matched.slice(0, 8)
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  const rows = await evaluateInMainProcessForTests(mainExpr, 5000);
  return Array.isArray(rows)
    ? rows.map((row: any) => row?.value).find(Boolean) || rows
    : rows;
}

async function dispatchRendererMouseMoveForTests(input?: {
  x?: number;
  y?: number;
  clickBeforeMove?: boolean;
}): Promise<any> {
  await ensureRendererPatchForHarness();
  const x = Number(input?.x);
  const y = Number(input?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { ok: false, reason: 'invalid-coordinates', x, y };
  }
  const points = [
    { x: Math.max(1, x - 18), y },
    { x: Math.max(1, x - 7), y },
    { x, y },
  ].map(point => ({
    x: Math.round(point.x * 100) / 100,
    y: Math.round(point.y * 100) / 100,
  }));
  if (mainWsRef && mainWsRef.readyState === WebSocket.OPEN && (isTestRendererDebugMode() || mainWsRefIsRendererTarget)) {
    try {
      return await withRendererInputCdpSessionForTests(async (cdpWs, inputMode) => {
    await cdpRequest(cdpWs, 'Page.enable', {}, 1000).catch(() => undefined);
    await cdpRequest(cdpWs, 'Page.bringToFront', {}, 1000).catch(() => undefined);
    await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: 'try{window.focus();document.body&&document.body.focus&&document.body.focus();true}catch(_){false}',
      returnByValue: true,
    }, 1000).catch(() => undefined);
    await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){
        window.__irLastCdpMouseProbe = [];
        var types = ['pointerover','mouseover','pointerenter','mouseenter','pointermove','mousemove','mousedown','mouseup','click'];
        if (window.__irCdpMouseProbeCleanup) { try { window.__irCdpMouseProbeCleanup(); } catch (_) {} }
        var listeners = [];
        function describe(t) {
          var el = t && (t.nodeType === 1 ? t : t.parentElement);
          return el ? {
            tag: String(el.tagName || ''),
            className: String(el.className || ''),
            text: String(el.textContent || '').slice(0, 80)
          } : null;
        }
        for (var i = 0; i < types.length; i++) {
          (function(type) {
            var fn = function(ev) {
              try {
                window.__irLastCdpMouseProbe.push({
                  type: type,
                  target: describe(ev.target),
                  activeElement: describe(document.activeElement)
                });
              } catch (_) {}
            };
            document.addEventListener(type, fn, true);
            listeners.push({ type: type, fn: fn });
          })(types[i]);
        }
        window.__irCdpMouseProbeCleanup = function() {
          for (var j = 0; j < listeners.length; j++) {
            try { document.removeEventListener(listeners[j].type, listeners[j].fn, true); } catch (_) {}
          }
          listeners = [];
        };
        return true;
      })()`,
      returnByValue: true,
    }, 1000).catch(() => undefined);
    const targetProbe = await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){var x=${JSON.stringify(Math.round(x * 100) / 100)},y=${JSON.stringify(Math.round(y * 100) / 100)};var el=document.elementFromPoint(x,y);return el?{className:String(el.className||''),text:String(el.textContent||'').slice(0,160)}:null})()`,
      returnByValue: true,
    }, 1000).catch(() => undefined);
    const focusBefore = await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){
        var x=${JSON.stringify(Math.round(x * 100) / 100)}, y=${JSON.stringify(Math.round(y * 100) / 100)};
        function describe(el) {
          return el ? {
            tag: String(el.tagName || ''),
            className: String(el.className || ''),
            text: String(el.textContent || '').slice(0, 120)
          } : null;
        }
        var el = document.elementFromPoint(x, y);
        var editor = el && el.closest ? el.closest('.monaco-editor') : null;
        var input = editor && editor.querySelector ? editor.querySelector('textarea.inputarea, textarea') : null;
        try { if (input && typeof input.focus === 'function') input.focus(); } catch (_) {}
        return {
          target: describe(el),
          editorClassName: editor ? String(editor.className || '') : '',
          focusedInput: !!input,
          activeElement: describe(document.activeElement)
        };
      })()`,
      returnByValue: true,
    }, 1000).catch(() => undefined);
    const dispatchMouse = async (event: any) => {
      try {
        await cdpRequest(cdpWs, 'Input.dispatchMouseEvent', event, 8000);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    if (input?.clickBeforeMove) {
      const pressError = await dispatchMouse({
        type: 'mousePressed',
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
      });
      if (pressError) {
        return {
          ok: false,
          mode: 'cdp-renderer',
          inputMode,
          reason: 'mouse-dispatch-failed',
          error: pressError,
          points,
          clicked: !!input?.clickBeforeMove,
          targetAtPoint: targetProbe?.result?.value || null,
          focusBefore: focusBefore?.result?.value || null,
        };
      }
      const releaseError = await dispatchMouse({
        type: 'mouseReleased',
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      });
      if (releaseError) {
        return {
          ok: false,
          mode: 'cdp-renderer',
          inputMode,
          reason: 'mouse-dispatch-failed',
          error: releaseError,
          points,
          clicked: !!input?.clickBeforeMove,
          targetAtPoint: targetProbe?.result?.value || null,
          focusBefore: focusBefore?.result?.value || null,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const focusAfterClick = await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){
        var x=${JSON.stringify(Math.round(x * 100) / 100)}, y=${JSON.stringify(Math.round(y * 100) / 100)};
        function describe(el) {
          return el ? {
            tag: String(el.tagName || ''),
            className: String(el.className || ''),
            text: String(el.textContent || '').slice(0, 120)
          } : null;
        }
        var el = document.elementFromPoint(x, y);
        var editor = el && el.closest ? el.closest('.monaco-editor') : null;
        var input = editor && editor.querySelector ? editor.querySelector('textarea.inputarea, textarea') : null;
        try { if (input && typeof input.focus === 'function') input.focus(); } catch (_) {}
        return {
          target: describe(el),
          editorClassName: editor ? String(editor.className || '') : '',
          focusedInput: !!input,
          activeElement: describe(document.activeElement)
        };
      })()`,
      returnByValue: true,
    }, 1000).catch(() => undefined);
    for (const point of points) {
      const moveError = await dispatchMouse({
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        pointerType: 'mouse',
      });
      if (moveError) {
        return {
          ok: false,
          mode: 'cdp-renderer',
          inputMode,
          reason: 'mouse-dispatch-failed',
          error: moveError,
          points,
          clicked: !!input?.clickBeforeMove,
          targetAtPoint: targetProbe?.result?.value || null,
          focusBefore: focusBefore?.result?.value || null,
          focusAfterClick: focusAfterClick?.result?.value || null,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    const mouseProbe = await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){
        var rows = (window.__irLastCdpMouseProbe || []).slice(-40);
        if (window.__irCdpMouseProbeCleanup) { try { window.__irCdpMouseProbeCleanup(); } catch (_) {} }
        window.__irCdpMouseProbeCleanup = null;
        return rows;
      })()`,
      returnByValue: true,
    }, 1000).catch(() => undefined);
    return {
      ok: true,
      mode: 'cdp-renderer',
      inputMode,
      points,
      clicked: !!input?.clickBeforeMove,
      targetAtPoint: targetProbe?.result?.value || null,
      focusBefore: focusBefore?.result?.value || null,
      focusAfterClick: focusAfterClick?.result?.value || null,
      mouseEvents: mouseProbe?.result?.value || [],
    };
      });
    } catch (err) {
      return {
        ok: false,
        mode: 'cdp-renderer',
        reason: 'cdp-session-failed',
        error: err instanceof Error ? err.message : String(err),
        points,
      };
    }
  }

  const rendererExpr = `
    (function() {
      var points = ${JSON.stringify(points)};
      var fired = [];
      function fireAt(type, Ctor, x, y) {
        var target = document.elementFromPoint(x, y);
        if (!target) return { ok: false, type: type, x: x, y: y, reason: 'no-target' };
        try {
          target.dispatchEvent(new (Ctor || window.MouseEvent)(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            buttons: 0,
            button: 0,
            pointerType: 'mouse'
          }));
        } catch (_) {
          var ev = document.createEvent('MouseEvents');
          ev.initMouseEvent(type, true, true, window, 0, x, y, x, y, false, false, false, false, 0, null);
          target.dispatchEvent(ev);
        }
        return {
          ok: true,
          type: type,
          x: x,
          y: y,
          targetClassName: String(target.className || ''),
          targetText: String(target.textContent || '').slice(0, 120)
        };
      }
      for (var i = 0; i < points.length; i++) {
        var p = points[i];
        fired.push(fireAt('pointerover', window.PointerEvent || window.MouseEvent, p.x, p.y));
        fired.push(fireAt('mouseover', window.MouseEvent, p.x, p.y));
        fired.push(fireAt('pointermove', window.PointerEvent || window.MouseEvent, p.x, p.y));
        fired.push(fireAt('mousemove', window.MouseEvent, p.x, p.y));
      }
      return { ok: fired.some(function(item) { return item && item.ok; }), mode: 'dom-dispatch', points: points, fired: fired };
    })()
  `.trim();
  const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 3000);
  const value = (rows || []).map((row: any) => row?.value).find(Boolean);
  return value || { ok: false, reason: 'no-renderer-result', rows };
}

async function dispatchRendererKeyForTests(input?: {
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
}): Promise<any> {
  const key = String(input?.key || 'Escape');
  const code = String(input?.code || key);
  const windowsVirtualKeyCode = Number.isFinite(Number(input?.windowsVirtualKeyCode))
    ? Number(input!.windowsVirtualKeyCode)
    : (key === 'Escape' ? 27 : 0);
  const nativeVirtualKeyCode = Number.isFinite(Number(input?.nativeVirtualKeyCode))
    ? Number(input!.nativeVirtualKeyCode)
    : (key === 'Escape' ? 53 : windowsVirtualKeyCode);
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN || !(isTestRendererDebugMode() || mainWsRefIsRendererTarget)) {
    return { ok: false, reason: 'renderer-cdp-unavailable', key, code };
  }
  try {
    return await withRendererInputCdpSessionForTests(async (cdpWs, inputMode) => {
      await cdpRequest(cdpWs, 'Page.enable', {}, 1000).catch(() => undefined);
      await cdpRequest(cdpWs, 'Page.bringToFront', {}, 1000).catch(() => undefined);
      const text = '';
      const baseEvent = {
        key,
        code,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode,
        text,
        unmodifiedText: text,
      };
      await cdpRequest(cdpWs, 'Input.dispatchKeyEvent', {
        ...baseEvent,
        type: 'rawKeyDown',
      }, 3000);
      await cdpRequest(cdpWs, 'Input.dispatchKeyEvent', {
        ...baseEvent,
        type: 'keyDown',
      }, 3000);
      if (text) {
        await cdpRequest(cdpWs, 'Input.dispatchKeyEvent', {
          ...baseEvent,
          type: 'char',
        }, 3000).catch(() => undefined);
      }
      await cdpRequest(cdpWs, 'Input.dispatchKeyEvent', {
        ...baseEvent,
        type: 'keyUp',
      }, 3000);
      return { ok: true, mode: 'cdp-renderer', inputMode, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode };
    });
  } catch (err) {
    return {
      ok: false,
      mode: 'cdp-renderer',
      reason: 'key-dispatch-failed',
      key,
      code,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runHoverLinkClickHarnessForTests(typeName: string): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const targetName = String(typeName || '');
  const useNativeMouseClick = !!(mainWsRef
    && mainWsRef.readyState === WebSocket.OPEN
    && (isTestRendererDebugMode() || mainWsRefIsRendererTarget));
  const rendererExpr = `
    (async function() {
      var targetName = ${JSON.stringify(targetName)};
      var useNativeMouseClick = ${JSON.stringify(useNativeMouseClick)};
      var hooks = window.__irTestHooks;
      function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function visibleHover(root) {
        if (visible(root)) return true;
        if (!root || String(root.textContent || '').trim().length === 0) return false;
        var nodes = root.querySelectorAll ? root.querySelectorAll('.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown') : [];
        for (var ni = 0; ni < nodes.length; ni++) {
          if (visible(nodes[ni])) return true;
        }
        return false;
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover');
      }
      function seededHoverRoot() {
        var seeded = document.querySelectorAll('.ir-test-seeded-hover');
        for (var si = seeded.length - 1; si >= 0; si--) {
          if (document.body.contains(seeded[si]) && isActualHover(seeded[si]) && visible(seeded[si])) return seeded[si];
        }
        return null;
      }
      function hoverRoots() {
        var seeded = seededHoverRoot();
        if (seeded) return [seeded];
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        for (var i = 0; i < roots.length; i++) {
          if (document.body.contains(roots[i]) && isActualHover(roots[i]) && visibleHover(roots[i])) out.push(roots[i]);
        }
        return out;
      }
      function activeHoverRoot() {
        var seeded = seededHoverRoot();
        if (seeded) return seeded;
        var active = window.__irActiveHoverEl;
        if (active && document.body.contains(active) && isActualHover(active) && visibleHover(active)) return active;
        var roots = hoverRoots();
        var best = null;
        var bestText = -1;
        for (var i = 0; i < roots.length; i++) {
          var len = String(roots[i].textContent || '').trim().length;
          if (len >= bestText) {
            best = roots[i];
            bestText = len;
          }
        }
        return best;
      }
      function collectLinkTypes(root) {
        var out = [];
        var scope = root || document;
        var links = scope.querySelectorAll('.ir-type-link');
        for (var i = 0; i < links.length && out.length < 80; i++) {
          out.push(links[i].getAttribute('data-type') || '');
        }
        return out;
      }
      function primaryScrollTop(root) {
        try {
          var sc = root && root.querySelector ? root.querySelector('.monaco-scrollable-element') : null;
          return sc ? sc.scrollTop : (root ? root.scrollTop : 0);
        } catch (_) {
          return 0;
        }
      }
      function hoverDomState() {
        var roots = hoverRoots();
        var root = activeHoverRoot();
        var rect = root ? root.getBoundingClientRect() : null;
        var text = root ? String(root.textContent || '') : '';
        var emptyRoots = 0;
        var populatedRoots = 0;
        for (var i = 0; i < roots.length; i++) {
          if (String(roots[i].textContent || '').trim().length) populatedRoots++;
          else emptyRoots++;
        }
        return {
          hoverCount: roots.length,
          populatedHoverCount: populatedRoots,
          emptyHoverCount: emptyRoots,
          activeTextLength: text.trim().length,
          activeText: text.slice(0, 8000),
          activeRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
          activeScrollTop: primaryScrollTop(root),
          linkTypes: collectLinkTypes(root),
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      }
      function linkVisibleAtPoint(root, link) {
        try {
          if (!root || !link) return false;
          var rr = root.getBoundingClientRect();
          var lr = link.getBoundingClientRect();
          if (!rr || !lr || lr.width <= 0 || lr.height <= 0) return false;
          var x = Math.max(lr.left + 1, Math.min(lr.right - 1, lr.left + lr.width / 2));
          var y = Math.max(lr.top + 1, Math.min(lr.bottom - 1, lr.top + lr.height / 2));
          if (x < rr.left || x > rr.right || y < rr.top || y > rr.bottom) return false;
          var hit = document.elementFromPoint(x, y);
          return !!(hit && (hit === link || (hit.closest && hit.closest('.ir-type-link') === link)));
        } catch (_) {
          return false;
        }
      }
      function findTargetLink() {
        var root = activeHoverRoot();
        if (!root) return null;
        var links = root.querySelectorAll('.ir-type-link');
        var first = null;
        for (var i = 0; i < links.length; i++) {
          if ((links[i].getAttribute('data-type') || '') !== targetName) continue;
          if (!first) first = links[i];
          if (linkVisibleAtPoint(root, links[i])) return links[i];
        }
        return first;
      }
      function textNodeInsideLink(node, root) {
        var cur = node && node.parentNode;
        while (cur && cur !== root) {
          if (cur.nodeName === 'A'
            || cur.nodeName === 'BUTTON'
            || (cur.classList && cur.classList.contains('ir-type-link'))) return true;
          cur = cur.parentNode;
        }
        return false;
      }
      function textBeforeNodeOffset(root, node, offset, limit) {
        var out = '';
        try {
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          var n;
          while ((n = walker.nextNode())) {
            if (n === node) {
              out += String(n.nodeValue || '').slice(0, Math.max(0, offset || 0));
              break;
            }
            out += String(n.nodeValue || '');
            if (out.length > limit) out = out.slice(out.length - limit);
          }
        } catch (_) {}
        return out.length > limit ? out.slice(out.length - limit) : out;
      }
      function findTargetTextNode() {
        var root = activeHoverRoot();
        if (!root) return null;
        var best = null;
        try {
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          var node;
          while ((node = walker.nextNode())) {
            if (!node || !node.parentNode || textNodeInsideLink(node, root)) continue;
            var text = String(node.nodeValue || '');
            var idx = text.indexOf(targetName);
            while (idx >= 0) {
              var before = textBeforeNodeOffset(root, node, idx, 80);
              var decoratorContext = /@\\s*$/.test(before);
              var score = decoratorContext ? 0 : 1;
              var candidate = { node: node, index: idx, score: score, decoratorContext: decoratorContext };
              if (!best || candidate.score < best.score) best = candidate;
              idx = text.indexOf(targetName, idx + Math.max(1, targetName.length));
            }
          }
        } catch (_) {}
        return best;
      }
      function rectForTextNode(match) {
        if (!match) return null;
        var range = null;
        try {
          range = document.createRange();
          range.setStart(match.node, match.index);
          range.setEnd(match.node, match.index + targetName.length);
          var rect = range.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) return rect;
        } catch (_) {}
        try {
          var parent = match.node.parentElement || match.node.parentNode;
          if (parent && parent.getBoundingClientRect) return parent.getBoundingClientRect();
        } catch (_) {}
        return null;
      }
      function eventAt(type, Ctor, target, x, y) {
        try {
          target.dispatchEvent(new Ctor(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y
          }));
          return;
        } catch (_) {}
        try {
          var ev = document.createEvent('MouseEvents');
          ev.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
          target.dispatchEvent(ev);
        } catch (_) {}
      }
      async function pointWrapTargetWord() {
        var match = findTargetTextNode();
        if (!match) return { ok: false, reason: 'missing-text-node' };
        try {
          var parent = match.node.parentElement || match.node.parentNode;
          if (parent && parent.scrollIntoView) parent.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {}
        await wait(80);
        var rect = rectForTextNode(match);
        if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'missing-text-rect', decoratorContext: !!match.decoratorContext };
        var x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + rect.width / 2));
        var y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + rect.height / 2));
        var target = document.elementFromPoint(x, y) || match.node.parentElement || activeHoverRoot();
        eventAt('pointerover', window.PointerEvent || window.MouseEvent, target, x, y);
        await Promise.resolve();
        var wrapped = findTargetLink();
        if (wrapped) target = wrapped;
        eventAt('mouseover', window.MouseEvent, target, x, y);
        wrapped = findTargetLink();
        if (wrapped) target = wrapped;
        eventAt('pointermove', window.PointerEvent || window.MouseEvent, target, x, y);
        wrapped = findTargetLink();
        if (wrapped) target = wrapped;
        eventAt('mousemove', window.MouseEvent, target, x, y);
        await Promise.resolve();
        var link = findTargetLink();
        if (link) {
          eventAt('pointerover', window.PointerEvent || window.MouseEvent, link, x, y);
          eventAt('mouseover', window.MouseEvent, link, x, y);
        }
        var style = link ? window.getComputedStyle(link) : null;
        return {
          ok: !!link,
          reason: link ? 'ok' : 'not-wrapped',
          decoratorContext: !!match.decoratorContext,
          linkText: link ? String(link.textContent || '') : '',
          pointActive: !!(link && link.classList && link.classList.contains('ir-point-active')),
          textDecorationLine: style ? (style.textDecorationLine || style.textDecoration || '') : ''
        };
      }
      if (!hooks || typeof hooks.scanRenderedMarkdown !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      var link = null;
      var dom = null;
      var linkAlreadyExisted = false;
      var pointWrap = null;
      for (var attempt = 0; attempt < 20; attempt++) {
        try { hooks.scanRenderedMarkdown(); } catch (_) {}
        dom = hoverDomState();
        if (!dom.hoverCount) break;
        link = findTargetLink();
        if (link) break;
        if (findTargetTextNode()) break;
        await wait(80);
      }
      linkAlreadyExisted = !!link;
      if (!link) {
        pointWrap = await pointWrapTargetWord();
        link = findTargetLink();
      }
      if (!link) {
        return {
          ok: false,
          reason: 'missing-link-after-point-wrap',
          targetName: targetName,
          pointWrap: pointWrap,
          patchVersion: Number(window.__irPatchVersion) || 0,
          dom: hoverDomState()
        };
      }
      linkAlreadyExisted = linkAlreadyExisted && !pointWrap;
      var hover = link.closest('.monaco-hover, .monaco-editor-hover');
      var beforeText = hover ? String(hover.textContent || '').length : 0;
      async function ensureLinkVisibleForNativeClick() {
        if (!useNativeMouseClick) return;
        try {
          var root = activeHoverRoot();
          if (linkVisibleAtPoint(root, link)) return;
          if (link && link.scrollIntoView) link.scrollIntoView({ block: 'center', inline: 'nearest' });
          await wait(120);
          var visible = findTargetLink();
          if (visible) link = visible;
        } catch (_) {}
      }
      function linkClickPoint() {
        try {
          var rect = link.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          var x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + rect.width / 2));
          var y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + rect.height / 2));
          var pointTarget = document.elementFromPoint(x, y);
          return {
            x: Math.round(x * 100) / 100,
            y: Math.round(y * 100) / 100,
            targetClassName: pointTarget ? String(pointTarget.className || '') : '',
            targetText: pointTarget ? String(pointTarget.textContent || '').slice(0, 120) : '',
            elementFromPointIsLink: !!(pointTarget && (pointTarget === link || (pointTarget.closest && pointTarget.closest('.ir-type-link') === link)))
          };
        } catch (_) {
          return null;
        }
      }
      await ensureLinkVisibleForNativeClick();
      hover = link.closest('.monaco-hover, .monaco-editor-hover');
      beforeText = hover ? String(hover.textContent || '').length : beforeText;
      var clickPoint = linkClickPoint();
      if (useNativeMouseClick) {
        var clickPointIsLink = !!(clickPoint && clickPoint.elementFromPointIsLink);
        try {
          window.__irHarnessClickPayloads = [];
          if (!window.__irHarnessClickOriginalGoToType) {
            window.__irHarnessClickOriginalGoToType = window.irGoToType;
          }
          window.irGoToType = function(payload) {
            try { window.__irHarnessClickPayloads.push(String(payload)); } catch (_) {}
            var original = window.__irHarnessClickOriginalGoToType;
            if (typeof original === 'function') {
              try { return original.apply(window, arguments); } catch (_) {}
            }
            return undefined;
          };
        } catch (_) {}
        return {
          ok: clickPointIsLink,
          reason: !clickPoint ? 'missing-link-click-point' : (clickPointIsLink ? 'native-mouse-click-pending' : 'native-mouse-point-target-not-link'),
          scheduledClick: targetName,
          syntheticHover: false,
          nativeMouseClick: true,
          patchVersion: Number(window.__irPatchVersion) || 0,
          linkText: String(link.textContent || ''),
          linkAlreadyExisted: linkAlreadyExisted,
          pointWrap: pointWrap,
          pointActive: !!(link.classList && link.classList.contains('ir-point-active')),
          clickPoint: clickPoint,
          textDecorationLine: (function() {
            try {
              var cs = window.getComputedStyle(link);
              return cs.textDecorationLine || cs.textDecoration || '';
            } catch (_) { return ''; }
          })(),
          hoverTextLengthBeforeClick: beforeText,
          domBefore: dom || hoverDomState()
        };
      }
      function fire(type, Ctor) {
        try {
          link.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
          return;
        } catch (_) {}
        try {
          var ev = document.createEvent('MouseEvents');
          ev.initMouseEvent(type, true, true, window, 1, 0, 0, 5, 5, false, false, false, false, 0, null);
          link.dispatchEvent(ev);
        } catch (_) {}
      }
      setTimeout(function() {
        fire('pointerdown', window.PointerEvent || window.MouseEvent);
        fire('mousedown', window.MouseEvent);
        fire('click', window.MouseEvent);
      }, 80);
      return {
        ok: true,
        scheduledClick: targetName,
        syntheticHover: false,
        patchVersion: Number(window.__irPatchVersion) || 0,
        linkText: String(link.textContent || ''),
        linkAlreadyExisted: linkAlreadyExisted,
        pointWrap: pointWrap,
        pointActive: !!(link.classList && link.classList.contains('ir-point-active')),
        clickPoint: clickPoint,
        textDecorationLine: (function() {
          try {
            var cs = window.getComputedStyle(link);
            return cs.textDecorationLine || cs.textDecoration || '';
          } catch (_) { return ''; }
        })(),
        hoverTextLengthBeforeClick: beforeText,
        domBefore: dom || hoverDomState()
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  const rows = await evaluateInMainProcessForTests(mainExpr, 12000);
  const clickRow = (rows || []).find((row: any) => row?.value?.ok && row.value.nativeMouseClick && row.value.clickPoint);
  if (useNativeMouseClick && clickRow?.value?.clickPoint && mainWsRef && mainWsRef.readyState === WebSocket.OPEN) {
    const point = clickRow.value.clickPoint;
    const x = Number(point.x);
    const y = Number(point.y);
    try {
      await withRendererInputCdpSessionForTests(async (inputWs, inputMode) => {
        clickRow.value.nativeMouseInputMode = inputMode;
        clickRow.value.nativeMouseDispatchEvents = [];
        await cdpRequest(inputWs, 'Page.enable', {}, 1500).catch(() => undefined);
        await cdpRequest(inputWs, 'Page.bringToFront', {}, 1500).catch(() => undefined);
        const dispatchMouse = async (event: any) => {
          clickRow.value.nativeMouseLastDispatch = event.type;
          clickRow.value.nativeMouseDispatchEvents.push(event.type);
          await cdpRequest(inputWs, 'Input.dispatchMouseEvent', event, 6000);
        };
        await dispatchMouse({
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          pointerType: 'mouse',
        });
        await dispatchMouse({
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          pointerType: 'mouse',
        });
        await dispatchMouse({
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        });
      });
      clickRow.value.nativeMouseDispatched = true;
      await new Promise(resolve => setTimeout(resolve, 260));
      const payloadRows = await evaluateInMainProcessForTests(`
        (function(){
          var payloads = [];
          try { payloads = (window.__irHarnessClickPayloads || []).slice(); } catch (_) {}
          try {
            if (window.__irHarnessClickOriginalGoToType) {
              window.irGoToType = window.__irHarnessClickOriginalGoToType;
              window.__irHarnessClickOriginalGoToType = null;
            }
            window.__irHarnessClickPayloads = [];
          } catch (_) {}
          return payloads;
        })()
      `.trim(), 3000).catch(() => []);
      const payloads = (payloadRows || []).map((row: any) => row?.value).find(Array.isArray) || [];
      clickRow.value.payloads = payloads;
      clickRow.value.previewPayloadSeen = payloads.includes(`PREVIEW:${targetName}`);
      if (!clickRow.value.previewPayloadSeen) {
        clickRow.value.ok = false;
        clickRow.value.reason = 'native-mouse-click-no-preview-payload';
      }
    } catch (err) {
      const dispatchError = err instanceof Error ? err.message : String(err);
      clickRow.value.ok = false;
      clickRow.value.reason = 'native-mouse-dispatch-failed';
      clickRow.value.error = dispatchError;
      let fallbackOk = false;
      try {
        const fallbackRows = await evaluateInMainProcessForTests(`
          (async function(){
            var targetName=${JSON.stringify(targetName)};
            var x=${JSON.stringify(point?.x)};
            var y=${JSON.stringify(point?.y)};
            var payloads=[];
            function describe(el){
              return el?{
                tag:String(el.tagName||''),
                className:String(el.className||''),
                text:String(el.textContent||'').slice(0,160),
                dataType:el.getAttribute?String(el.getAttribute('data-type')||''):''
              }:null;
            }
            function fire(type,Ctor,target){
              try{
                target.dispatchEvent(new (Ctor||window.MouseEvent)(type,{
                  bubbles:true,
                  cancelable:true,
                  composed:true,
                  view:window,
                  clientX:x,
                  clientY:y,
                  screenX:x,
                  screenY:y,
                  button:type==='mouseMoved'||type==='pointermove'||type==='mousemove'?0:0,
                  buttons:type==='pointerdown'||type==='mousedown'?1:0,
                  pointerId:1,
                  pointerType:'mouse',
                  isPrimary:true
                }));
                return true;
              }catch(_){}
              try{
                var ev=document.createEvent('MouseEvents');
                ev.initMouseEvent(type,true,true,window,1,x,y,x,y,false,false,false,false,0,null);
                target.dispatchEvent(ev);
                return true;
              }catch(_){}
              return false;
            }
            var target=document.elementFromPoint(x,y);
            var link=target&&target.closest?target.closest('.ir-type-link'):null;
            if(!link||String(link.getAttribute('data-type')||'')!==targetName){
              return {
                ok:false,
                reason:'hit-test-target-not-link',
                target:describe(target),
                link:describe(link),
                point:{x:x,y:y}
              };
            }
            var original=window.irGoToType;
            try{
              window.irGoToType=function(payload){
                try{payloads.push(String(payload));}catch(_){}
                if(typeof original==='function'){
                  try{return original.apply(window,arguments);}catch(_){}
                }
                return undefined;
              };
              fire('pointerover',window.PointerEvent||window.MouseEvent,link);
              fire('mouseover',window.MouseEvent,link);
              fire('pointermove',window.PointerEvent||window.MouseEvent,link);
              fire('mousemove',window.MouseEvent,link);
              fire('pointerdown',window.PointerEvent||window.MouseEvent,link);
              fire('mousedown',window.MouseEvent,link);
              fire('mouseup',window.MouseEvent,link);
              fire('click',window.MouseEvent,link);
              await new Promise(function(resolve){setTimeout(resolve,260);});
            }finally{
              try{window.irGoToType=original;}catch(_){}
              try{
                if(window.__irHarnessClickOriginalGoToType){
                  window.irGoToType=window.__irHarnessClickOriginalGoToType;
                  window.__irHarnessClickOriginalGoToType=null;
                }
              }catch(_){}
              try{window.__irHarnessClickPayloads=[];}catch(_){}
            }
            return {
              ok:payloads.indexOf('PREVIEW:'+targetName)>=0,
              reason:payloads.indexOf('PREVIEW:'+targetName)>=0?'ok':'no-preview-payload',
              payloads:payloads,
              target:describe(target),
              link:describe(link),
              point:{x:x,y:y},
              textDecorationLine:(function(){try{var cs=window.getComputedStyle(link);return cs.textDecorationLine||cs.textDecoration||'';}catch(_){return '';}})()
            };
          })()
        `.trim(), 4000);
        const fallback = (fallbackRows || []).map((row: any) => row?.value).find(Boolean);
        clickRow.value.hitTestDomClickFallback = fallback || null;
        if (fallback?.ok) {
          fallbackOk = true;
          clickRow.value.ok = true;
          clickRow.value.reason = 'native-mouse-dispatch-failed-hit-test-dom-click-used';
          clickRow.value.nativeMouseDispatched = false;
          clickRow.value.hitTestDomClickDispatched = true;
          clickRow.value.payloads = fallback.payloads || [];
          clickRow.value.previewPayloadSeen = true;
        }
      } catch (fallbackErr) {
        clickRow.value.hitTestDomClickFallbackError = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      }
      if (!fallbackOk) {
        try {
        await evaluateInMainProcessForTests(`
          (function(){
            try {
              if (window.__irHarnessClickOriginalGoToType) {
                window.irGoToType = window.__irHarnessClickOriginalGoToType;
                window.__irHarnessClickOriginalGoToType = null;
              }
              window.__irHarnessClickPayloads = [];
            } catch (_) {}
            return true;
          })()
        `.trim(), 3000).catch(() => undefined);
        } catch {}
      }
    }
  }
  return rows;
}

async function runHoverScrollHarnessForTests(scrollTop?: number): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const targetTop = Number.isFinite(Number(scrollTop)) ? Math.max(0, Math.floor(Number(scrollTop))) : null;
  const rendererExpr = `
    (async function() {
      var targetTop = ${JSON.stringify(targetTop)};
      var hooks = window.__irTestHooks;
      function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover');
      }
      function activeHoverRoot() {
        var active = window.__irActiveHoverEl;
        if (active && document.body.contains(active) && isActualHover(active) && visible(active)) return active;
        var roots = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        var best = null;
        var bestText = -1;
        for (var i = 0; i < roots.length; i++) {
          if (!document.body.contains(roots[i]) || !isActualHover(roots[i]) || !visible(roots[i])) continue;
          var len = String(roots[i].textContent || '').trim().length;
          if (len >= bestText) { best = roots[i]; bestText = len; }
        }
        return best;
      }
      function snap(scroller) {
        if (!scroller) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, maxTop: 0 };
        var scrollHeight = Math.floor(scroller.scrollHeight || 0);
        var clientHeight = Math.floor(scroller.clientHeight || 0);
        return {
          scrollTop: Math.floor(scroller.scrollTop || 0),
          scrollHeight: scrollHeight,
          clientHeight: clientHeight,
          maxTop: Math.max(0, scrollHeight - clientHeight)
        };
      }
      if (!hooks || typeof hooks.primaryHoverScroller !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      var hover = activeHoverRoot();
      if (!hover) return { ok: false, reason: 'no-hover', patchVersion: Number(window.__irPatchVersion) || 0 };
      var scroller = hooks.primaryHoverScroller(hover);
      var before = snap(scroller);
      if (targetTop !== null && scroller) {
        scroller.scrollTop = Math.min(Math.max(0, targetTop), before.maxTop);
        if (hover.scrollTop) hover.scrollTop = 0;
        await wait(80);
      }
      var after = snap(scroller);
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        before: before,
        after: after,
        activeText: String(hover.textContent || '').slice(0, 1000)
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 12000);
}

async function runHoverBackButtonClickHarnessForTests(): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const rendererExpr = `
    (async function() {
      function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover');
      }
      function seededHoverRoot() {
        var seeded = document.querySelectorAll('.ir-test-seeded-hover');
        for (var si = seeded.length - 1; si >= 0; si--) {
          if (document.body.contains(seeded[si]) && isActualHover(seeded[si]) && visible(seeded[si])) return seeded[si];
        }
        return null;
      }
      function activeHoverRoot() {
        var seeded = seededHoverRoot();
        if (seeded) return seeded;
        var active = window.__irActiveHoverEl;
        if (active && document.body.contains(active) && isActualHover(active) && visible(active)) return active;
        var roots = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        var best = null;
        var bestText = -1;
        for (var i = 0; i < roots.length; i++) {
          if (!document.body.contains(roots[i]) || !isActualHover(roots[i]) || !visible(roots[i])) continue;
          var len = String(roots[i].textContent || '').trim().length;
          if (len >= bestText) {
            best = roots[i];
            bestText = len;
          }
        }
        return best;
      }
      function fire(target, type, Ctor) {
        try {
          target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
          return;
        } catch (_) {}
        try {
          var ev = document.createEvent('MouseEvents');
          ev.initMouseEvent(type, true, true, window, 1, 0, 0, 5, 5, false, false, false, false, 0, null);
          target.dispatchEvent(ev);
        } catch (_) {}
      }
      var root = activeHoverRoot();
      var btn = root ? root.querySelector('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"]') : null;
      if (!btn) {
        return {
          ok: false,
          reason: 'missing-back-button',
          patchVersion: Number(window.__irPatchVersion) || 0,
          hoverText: root ? String(root.textContent || '').slice(0, 500) : ''
        };
      }
      var beforeText = root ? String(root.textContent || '') : '';
      setTimeout(function() {
        fire(btn, 'pointerdown', window.PointerEvent || window.MouseEvent);
        fire(btn, 'mousedown', window.MouseEvent);
        fire(btn, 'click', window.MouseEvent);
      }, 80);
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        buttonText: String(btn.textContent || ''),
        hoverTextLengthBeforeClick: beforeText.trim().length
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 12000);
}

async function runHoverDomStateHarnessForTests(expectedTypes?: string[] | string, includeStyleAndLayout?: boolean): Promise<any[]> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    await runRendererInjection(injectRenderer);
  }
  const expected = Array.isArray(expectedTypes)
    ? expectedTypes.map(String)
    : (expectedTypes ? [String(expectedTypes)] : []);
  const includeMetrics = includeStyleAndLayout !== false;
  const rendererExpr = `
    (async function() {
      var expected = ${JSON.stringify(expected)};
      var includeMetrics = ${JSON.stringify(includeMetrics)};
      var hooks = window.__irTestHooks;
      function wait(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        try {
          var cs = window.getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover');
      }
      function seededHoverRoot() {
        var seeded = document.querySelectorAll('.ir-test-seeded-hover');
        for (var si = seeded.length - 1; si >= 0; si--) {
          if (document.body.contains(seeded[si]) && isActualHover(seeded[si]) && visible(seeded[si])) return seeded[si];
        }
        return null;
      }
      function hoverRoots() {
        var seeded = seededHoverRoot();
        if (seeded) return [seeded];
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        for (var i = 0; i < roots.length; i++) {
          if (document.body.contains(roots[i]) && isActualHover(roots[i]) && visible(roots[i])) out.push(roots[i]);
        }
        return out;
      }
      function activeHoverRoot() {
        var seeded = seededHoverRoot();
        if (seeded) return seeded;
        var active = window.__irActiveHoverEl;
        if (active && document.body.contains(active) && isActualHover(active) && visible(active)) return active;
        var roots = hoverRoots();
        var best = null;
        var bestText = -1;
        for (var i = 0; i < roots.length; i++) {
          var len = String(roots[i].textContent || '').trim().length;
          if (len >= bestText) {
            best = roots[i];
            bestText = len;
          }
        }
        return best;
      }
      function collectLinkTypes(root) {
        var out = [];
        var links = root ? root.querySelectorAll('.ir-type-link') : [];
        for (var i = 0; i < links.length && out.length < 120; i++) {
          out.push(links[i].getAttribute('data-type') || '');
        }
        return out;
      }
      function syntaxMetrics(root) {
        var tokenized = root ? root.querySelectorAll('.monaco-tokenized-source') : [];
        var fallbackTokenized = root ? root.querySelectorAll('.monaco-tokenized-source[data-ir-tokenization-source="fallback"]').length : 0;
        var mtkSpans = root ? root.querySelectorAll('.monaco-tokenized-source [class*="mtk"]') : [];
        var mtkSet = {};
        for (var mi = 0; mi < mtkSpans.length; mi++) {
          var cls = String(mtkSpans[mi].className || '');
          var matches = cls.match(/mtk\\d+/g) || [];
          for (var mm = 0; mm < matches.length; mm++) mtkSet[matches[mm]] = true;
        }
        var irTkSpans = root ? root.querySelectorAll('.monaco-tokenized-source [class*="ir-tk-"]') : [];
        var irTkSet = {};
        for (var ii = 0; ii < irTkSpans.length; ii++) {
          var icls = String(irTkSpans[ii].className || '');
          var imatches = icls.match(/ir-tk-[a-z]+/g) || [];
          for (var im = 0; im < imatches.length; im++) irTkSet[imatches[im]] = true;
        }
        var tokenizedLinks = root ? root.querySelectorAll('.monaco-tokenized-source .ir-type-link') : [];
        var tokenizedLinkTypes = [];
        for (var li = 0; li < tokenizedLinks.length && tokenizedLinkTypes.length < 120; li++) {
          tokenizedLinkTypes.push(tokenizedLinks[li].getAttribute('data-type') || '');
        }
        var tokenizedText = '';
        for (var ti = 0; ti < tokenized.length && tokenizedText.length < 8000; ti++) {
          tokenizedText += String(tokenized[ti].textContent || '') + '\\n';
        }
        var firstTokenized = tokenized.length ? tokenized[0] : null;
        var tokenStyle = includeMetrics && firstTokenized ? window.getComputedStyle(firstTokenized) : null;
        var hoverStyle = includeMetrics && root ? window.getComputedStyle(root) : null;
        var tokenColorSet = {};
        var tokenColorSamples = [];
        var colorSpans = firstTokenized ? firstTokenized.querySelectorAll('span') : [];
        if (includeMetrics) {
          for (var ci = 0; ci < colorSpans.length && ci < 40; ci++) {
            if (!String(colorSpans[ci].textContent || '').trim()) continue;
            try {
              var color = window.getComputedStyle(colorSpans[ci]).color || '';
              if (color) {
                tokenColorSet[color] = true;
                if (tokenColorSamples.length < 12 && tokenColorSamples.indexOf(color) < 0) tokenColorSamples.push(color);
              }
            } catch (_) {}
          }
        }
        var mtkClassCount = Object.keys(mtkSet).length;
        var irTkClassCount = Object.keys(irTkSet).length;
        var tokenizedColorCount = Object.keys(tokenColorSet).length;
        var manualTokenThemeRuleCount = 0;
        try {
          var styleText = String((window.__irStyleEl && window.__irStyleEl.textContent) || '');
          var manualMatches = styleText.match(/\\.ir-tk-[a-z][^{]*\\{[^}]*\\bcolor\\s*:/g) || [];
          manualTokenThemeRuleCount = manualMatches.length;
        } catch (_) {}
        return {
          tokenizedSourceCount: tokenized.length,
          fallbackTokenizedSourceCount: fallbackTokenized,
          mtkSpanCount: mtkSpans.length,
          mtkClassCount: mtkClassCount,
          irTkSpanCount: irTkSpans.length,
          irTkClassCount: irTkClassCount,
          nativeTokenizedSource: tokenized.length > 0 && irTkSpans.length === 0 && mtkSpans.length > 0 && mtkClassCount > 1,
          typeLinksInTokenizedSource: tokenizedLinks.length,
          tokenizedLinkTypes: tokenizedLinkTypes,
          tokenizedText: tokenizedText.slice(0, 8000),
          tokenizedInlineStyle: firstTokenized ? (firstTokenized.getAttribute('style') || '') : '',
          tokenizedWhiteSpace: tokenStyle ? tokenStyle.whiteSpace : '',
          tokenizedFontFamily: tokenStyle ? tokenStyle.fontFamily : '',
          tokenizedFontSize: tokenStyle ? tokenStyle.fontSize : '',
          tokenizedLineHeight: tokenStyle ? tokenStyle.lineHeight : '',
          tokenizedLetterSpacing: tokenStyle ? tokenStyle.letterSpacing : '',
          tokenizedBackgroundColor: tokenStyle ? tokenStyle.backgroundColor : '',
          hoverBackgroundColor: hoverStyle ? hoverStyle.backgroundColor : '',
          hoverForegroundColor: hoverStyle ? hoverStyle.color : '',
          tokenizedColorCount: tokenizedColorCount,
          tokenizedColorSamples: tokenColorSamples,
          manualTokenThemeRuleCount: manualTokenThemeRuleCount,
          tokenizedThemeApplied: tokenized.length > 0
            && mtkClassCount > 1
            && irTkSpans.length === 0
            && tokenizedColorCount > 1
            && manualTokenThemeRuleCount === 0
            && !!(tokenStyle && tokenStyle.fontSize),
          syntaxHighlighted: tokenized.length > 0
            && mtkSpans.length > 0
            && mtkClassCount > 1
            && irTkSpans.length === 0
        };
      }
      function layoutMetrics(root) {
        if (!root) {
          return { maxRightOverflow: 0, maxBottomOverflow: 0, wideBlockCount: 0, maxBlockWidth: 0 };
        }
        var rr = root.getBoundingClientRect();
        var maxRight = 0;
        var maxBottom = 0;
        var wide = 0;
        var maxWidth = 0;
        var nodes = root.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler');
        for (var i = 0; i < nodes.length && i < 600; i++) {
          var el = nodes[i];
          var tag = String(el.tagName || '').toUpperCase();
          if (tag === 'SPAN' || tag === 'A' || tag === 'CODE' || tag === 'BUTTON') continue;
          try {
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            maxWidth = Math.max(maxWidth, r.width || 0);
            var right = Math.max(0, r.right - rr.right);
            var bottom = Math.max(0, r.bottom - rr.bottom);
            maxRight = Math.max(maxRight, right);
            maxBottom = Math.max(maxBottom, bottom);
            if (right > 2 || r.width > rr.width + 2 || r.left < rr.left - 2) wide++;
          } catch (_) {}
        }
        return {
          maxRightOverflow: maxRight,
          maxBottomOverflow: maxBottom,
          wideBlockCount: wide,
          maxBlockWidth: maxWidth
        };
      }
      function collectState() {
        var roots = hoverRoots();
        var root = activeHoverRoot();
        var rect = root ? root.getBoundingClientRect() : null;
        var text = root ? String(root.textContent || '') : '';
        var emptyRoots = 0;
        var populatedRoots = 0;
        for (var i = 0; i < roots.length; i++) {
          if (String(roots[i].textContent || '').trim().length) populatedRoots++;
          else emptyRoots++;
        }
        var linkTypes = collectLinkTypes(root);
        var missing = expected.filter(function(name) { return linkTypes.indexOf(name) < 0; });
        var syntax = syntaxMetrics(root);
        var layout = includeMetrics
          ? layoutMetrics(root)
          : { maxRightOverflow: 0, maxBottomOverflow: 0, wideBlockCount: 0, maxBlockWidth: 0 };
        var scroller = root && hooks && typeof hooks.primaryHoverScroller === 'function'
          ? hooks.primaryHoverScroller(root)
          : null;
        var scrollTop = scroller ? Math.floor(scroller.scrollTop || 0) : 0;
        var scrollHeight = scroller ? Math.floor(scroller.scrollHeight || 0) : 0;
        var clientHeight = scroller ? Math.floor(scroller.clientHeight || 0) : 0;
        var backButtons = root ? root.querySelectorAll('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"]') : [];
        var visibleBackButtons = 0;
        for (var bb = 0; bb < backButtons.length; bb++) {
          try {
            var bcs = window.getComputedStyle(backButtons[bb]);
            var br = backButtons[bb].getBoundingClientRect();
            if (bcs.display !== 'none' && bcs.visibility !== 'hidden' && br.width > 0 && br.height > 0) visibleBackButtons++;
          } catch (_) {}
        }
        return {
          ok: roots.length > 0 && text.trim().length > 0 && missing.length === 0 && emptyRoots === 0,
          reason: roots.length === 0 ? 'no-hover' : (text.trim().length === 0 ? 'empty-hover' : (emptyRoots ? 'stale-empty-hover' : (missing.length ? 'missing-links' : 'ok'))),
          patchVersion: Number(window.__irPatchVersion) || 0,
          hoverCount: roots.length,
          populatedHoverCount: populatedRoots,
          emptyHoverCount: emptyRoots,
          forcedHover: !!(root && root.getAttribute && root.getAttribute('data-ir-forced-hover') === '1'),
          activeClassName: root ? String(root.className || '') : '',
          activeTextLength: text.trim().length,
          activeText: text.slice(0, 8000),
          activeRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
          linkTypes: linkTypes,
          expectedTypes: expected,
          missingExpectedTypes: missing,
          tokenizedSourceCount: syntax.tokenizedSourceCount,
          fallbackTokenizedSourceCount: syntax.fallbackTokenizedSourceCount,
          mtkSpanCount: syntax.mtkSpanCount,
          mtkClassCount: syntax.mtkClassCount,
          irTkSpanCount: syntax.irTkSpanCount,
          irTkClassCount: syntax.irTkClassCount,
          nativeTokenizedSource: syntax.nativeTokenizedSource,
          typeLinksInTokenizedSource: syntax.typeLinksInTokenizedSource,
          tokenizedLinkTypes: syntax.tokenizedLinkTypes,
          tokenizedText: syntax.tokenizedText,
          tokenizedInlineStyle: syntax.tokenizedInlineStyle,
          tokenizedFontFamily: syntax.tokenizedFontFamily,
          tokenizedFontSize: syntax.tokenizedFontSize,
          tokenizedLineHeight: syntax.tokenizedLineHeight,
          tokenizedLetterSpacing: syntax.tokenizedLetterSpacing,
          tokenizedBackgroundColor: syntax.tokenizedBackgroundColor,
          hoverBackgroundColor: syntax.hoverBackgroundColor,
          hoverForegroundColor: syntax.hoverForegroundColor,
          tokenizedColorCount: syntax.tokenizedColorCount,
          tokenizedColorSamples: syntax.tokenizedColorSamples,
          manualTokenThemeRuleCount: syntax.manualTokenThemeRuleCount,
          tokenizedThemeApplied: syntax.tokenizedThemeApplied,
          layoutMaxRightOverflow: layout.maxRightOverflow,
          layoutMaxBottomOverflow: layout.maxBottomOverflow,
          layoutWideBlockCount: layout.wideBlockCount,
          layoutMaxBlockWidth: layout.maxBlockWidth,
          scrollTop: scrollTop,
          scrollHeight: scrollHeight,
          scrollClientHeight: clientHeight,
          scrollMaxTop: Math.max(0, scrollHeight - clientHeight),
          backButtonCount: backButtons.length,
          backButtonVisibleCount: visibleBackButtons,
          syntaxHighlighted: syntax.syntaxHighlighted
        };
      }
      if (!hooks || typeof hooks.scanRenderedMarkdown !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      var state = null;
      for (var attempt = 0; attempt < 25; attempt++) {
        try { hooks.scanRenderedMarkdown(); } catch (_) {}
        state = collectState();
        if (!state.hoverCount) break;
        if (state.ok) break;
        await wait(80);
      }
      return state || collectState();
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 12000);
}

async function runHoverSeedPreviewHarnessForTests(
  typeName: string,
  markdown: string,
  asOriginal = false,
): Promise<any[]> {
  await ensureRendererPatchForHarness();
  await cleanupRendererTestArtifactsAcrossWindowsForTests();
  const safeId = jsonStringifyAscii(String(typeName || ''));
  const safeMd = jsonStringifyAscii(String(markdown || ''));
  const safeAsOriginal = JSON.stringify(!!asOriginal);
  const rendererExpr = `
    (async function() {
      var typeName = ${safeId};
      var markdown = ${safeMd};
      var asOriginal = ${safeAsOriginal};
      var hooks = window.__irTestHooks;
      if (!hooks || typeof hooks.makeHoverScrollable !== 'function') {
        return { ok: false, reason: 'missing-hooks', patchVersion: Number(window.__irPatchVersion) || 0 };
      }
      Array.prototype.slice.call(document.querySelectorAll('.ir-test-seeded-hover')).forEach(function(el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      });
      var hover = document.createElement('div');
      hover.className = 'monaco-hover ir-test-seeded-hover';
      hover.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647;background:Canvas;color:CanvasText;display:block;visibility:visible;';
      var sc = document.createElement('div');
      sc.className = 'monaco-scrollable-element';
      var content = document.createElement('div');
      content.className = 'monaco-hover-content';
      var row = document.createElement('div');
      row.className = 'hover-row';
      var rowContents = document.createElement('div');
      rowContents.className = 'hover-row-contents';
      var md = document.createElement('div');
      md.className = 'rendered-markdown';
      rowContents.appendChild(md);
      row.appendChild(rowContents);
      content.appendChild(row);
      sc.appendChild(content);
      hover.appendChild(sc);
      document.body.appendChild(hover);
      hover.__irPrimaryPreviewTarget = md;
      window.__irLastPreviewTarget = md;
      try {
        if (hooks && typeof hooks.setActiveHoverLayer === 'function') hooks.setActiveHoverLayer(hover);
      } catch (_) {}
      var applied = false;
      try {
        applied = typeof window.irApplyPreview === 'function'
          ? window.irApplyPreview(typeName, markdown, false) !== false
          : false;
      } catch (_) {}
      if (asOriginal) {
        Array.prototype.slice.call(hover.querySelectorAll('.ir-back-btn')).forEach(function(btn) {
          try { btn.parentNode && btn.parentNode.removeChild(btn); } catch (_) {}
        });
        window.__irHistoryFor = hover;
        window.__irHistory = [];
        window.__irHistoryCurrent = null;
        window.__irLastPreviewTarget = md;
      }
      try { hooks.makeHoverScrollable(hover, true, (hover.textContent || '').length); } catch (_) {}
      try { hooks.scanRenderedMarkdown(); } catch (_) {}
      if (asOriginal) {
        try {
          window.__irOriginalHoverSnapshot = {
            hoverEl: hover,
            clone: hover.cloneNode(true),
            className: String(hover.className || ''),
            styleText: String(hover.getAttribute('style') || ''),
            scroll: null
          };
        } catch (_) {}
      }
      return {
        ok: applied && String(hover.textContent || '').trim().length > 0,
        applied: applied,
        hoverTextLength: String(hover.textContent || '').trim().length,
        linkTypes: Array.prototype.slice.call(hover.querySelectorAll('.ir-type-link')).map(function(link) {
          return link.getAttribute('data-type') || '';
        }).slice(0, 80),
        patchVersion: Number(window.__irPatchVersion) || 0
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 12000);
}

// ASCII-escape every non-ASCII char to \\uXXXX. The payload is base64-
// encoded for transport and the renderer uses atob() which returns a
// binary (latin-1) string; without the escape, UTF-8 multibyte chars
// (e.g. Korean) come out as mojibake when the string is eval'd.
function jsonStringifyAscii(value: unknown): string {
  return JSON.stringify(value).replace(/[-￿]/g, c =>
    '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function resolvePreviewIdentifierViaDefinitionProvider(
  identifier: string,
  docUriStr: string,
  ms: () => string,
): Promise<vscode.Location | null> {
  const candidates: Array<{ uri: vscode.Uri; range?: vscode.Range; label: string }> = [];
  const addCandidate = (uri: vscode.Uri | undefined, range: vscode.Range | undefined, label: string) => {
    if (!uri) { return; }
    if (!CODE_SCHEMES.has(uri.scheme)) { return; }
    const key = `${uri.toString()}:${range?.start.line ?? 0}:${range?.end.line ?? -1}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    candidates.push({ uri, range, label });
  };
  const seen = new Set<string>();

  if (currentPreviewState) {
    const currentPreviewLoc = cappedPreviewLocationGet(lastPreviewLocations, currentPreviewState.identifier);
    addCandidate(currentPreviewLoc?.uri, currentPreviewLoc?.range, 'current-preview');
  }
  const identifierPreviewLoc = cappedPreviewLocationGet(lastPreviewLocations, identifier);
  addCandidate(identifierPreviewLoc?.uri, identifierPreviewLoc?.range, 'preview-identifier');
  if (docUriStr) {
    try { addCandidate(vscode.Uri.parse(docUriStr), undefined, 'origin-doc'); } catch {}
  }
  if (lastHoverDocUri) {
    try { addCandidate(vscode.Uri.parse(lastHoverDocUri), undefined, 'last-hover-doc'); } catch {}
  }
  const activeDoc = vscode.window.activeTextEditor?.document;
  addCandidate(activeDoc?.uri, undefined, 'active-doc');

  const re = new RegExp(`\\b${esc(identifier)}\\b`, 'g');
  for (const candidate of candidates) {
    let doc: vscode.TextDocument;
    try { doc = findOpenDoc(candidate.uri) ?? await vscode.workspace.openTextDocument(candidate.uri); }
    catch { continue; }
    if (!isCodeDoc(doc)) { continue; }

    const startLine = Math.max(0, candidate.range?.start.line ?? 0);
    const endLine = Math.min(doc.lineCount, candidate.range?.end.line !== undefined
      ? Math.max(candidate.range.end.line + 1, startLine + 1)
      : doc.lineCount);
    let probes = 0;
    for (let line = startLine; line < endLine && probes < 20; line++) {
      const text = doc.lineAt(line).text;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null && probes < 20) {
        probes++;
        const pos = new vscode.Position(line, match.index);
        const loc = await definitionProviderAt(doc, pos, ms, candidate.label);
        if (loc) { return loc; }
      }
    }
  }
  return null;
}

async function resolvePreviewIdentifierFromCurrentMarkdown(
  identifier: string,
  ms: () => string,
): Promise<vscode.Location | null> {
  if (!currentPreviewState?.markdown) { return null; }
  const parsed = parsePreviewMarkdownSource(currentPreviewState.markdown);
  if (!parsed) { return null; }
  const uri = await resolvePreviewMarkdownUri(parsed.relPath);
  if (!uri) { return null; }

  let doc: vscode.TextDocument;
  try { doc = findOpenDoc(uri) ?? await vscode.workspace.openTextDocument(uri); }
  catch { return null; }
  if (!isCodeDoc(doc)) { return null; }

  const sourceLoc = registerPreviewMarkdownLocations(parsed.typeName, uri, parsed.definitionLine, parsed.code);
  const lineTexts = parsed.code.split('\n');
  const previewStartLine = sourceLoc.previewStartLine;
  const re = new RegExp(`\\b${esc(identifier)}\\b`, 'g');

  for (let offset = 0; offset < lineTexts.length; offset++) {
    const declarationIndex = declarationIndexInLine(lineTexts[offset], identifier);
    if (declarationIndex === null) { continue; }
    const absLine = Math.min(doc.lineCount - 1, previewStartLine + offset);
    const loc = new vscode.Location(
      uri,
      new vscode.Range(absLine, declarationIndex, absLine, declarationIndex + identifier.length),
    );
    log.info(`preview:   loc from current-preview markdown declaration: ${vscode.workspace.asRelativePath(uri)}:${absLine + 1}:${declarationIndex + 1} (${ms()})`);
    return loc;
  }

  let probes = 0;
  for (let offset = 0; offset < lineTexts.length && probes < 20; offset++) {
    const lineText = lineTexts[offset];
    const absLine = previewStartLine + offset;
    if (absLine < 0 || absLine >= doc.lineCount) { continue; }
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(lineText)) !== null && probes < 20) {
      probes++;
      const pos = new vscode.Position(absLine, match.index);
      const defLoc = await definitionProviderAt(doc, pos, ms, 'current-preview markdown');
      if (defLoc) { return defLoc; }
    }
  }

  const defPos = findDefInText(doc.getText(), identifier, doc);
  if (defPos) {
    log.info(`preview:   loc from current-preview markdown file scan: ${vscode.workspace.asRelativePath(uri)}:${defPos.line + 1}:${defPos.character + 1} (${ms()})`);
    return new vscode.Location(uri, new vscode.Range(defPos, defPos));
  }

  return null;
}

async function resolvePreviewIdentifierFromWorkspaceScan(
  identifier: string,
  docUriStr: string,
  ms: () => string,
): Promise<vscode.Location | null> {
  let originDoc: vscode.TextDocument | undefined;
  try {
    if (docUriStr) {
      const originUri = vscode.Uri.parse(docUriStr);
      originDoc = findOpenDoc(originUri) ?? await vscode.workspace.openTextDocument(originUri);
    }
  } catch {}
  if (!originDoc) {
    originDoc = vscode.window.activeTextEditor?.document;
  }
  if (!originDoc || !isCodeDoc(originDoc)) { return null; }

  const docs = await collectDefinitionFallbackDocs(originDoc);
  for (const doc of docs) {
    const pos = findDefInText(doc.getText(), identifier, doc);
    if (!pos) { continue; }
    log.info(`preview:   loc from workspace scan: ${vscode.workspace.asRelativePath(doc.uri)}:${pos.line + 1}:${pos.character + 1} (${ms()})`);
    return new vscode.Location(doc.uri, new vscode.Range(pos, pos));
  }
  return null;
}

async function previewTypeHandler(
  docUriStr: string,
  identifier: string,
  dedupeRendererClick = true,
): Promise<void> {
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
  const anchorUriKey = hoverRequestUriKey(anchorPos.uri);
  const originScrollState = currentPreviewState?.originScrollState
    ?? (previewHistory.length === 0 ? await capturePreviewScrollStateInRenderer() : undefined);
  if (dedupeRendererClick) {
    if (currentPreviewState?.identifier === identifier
      && previewStateMatchesHoverRequest(currentPreviewState, anchorUriKey, anchorPos.line, anchorPos.character)) {
      log.info(`preview: "${identifier}" duplicate ignored (already current)`);
      return;
    }
    const previewClickKey = `${anchorUriKey}:${anchorPos.line}:${anchorPos.character}:${identifier}`;
    const previewClickNow = Date.now();
    for (const [key, ts] of previewClickDedupe) {
      if (previewClickNow - ts > PREVIEW_CLICK_DEDUPE_MS) {
        previewClickDedupe.delete(key);
      }
    }
    const lastPreviewClick = previewClickDedupe.get(previewClickKey);
    if (lastPreviewClick && previewClickNow - lastPreviewClick <= PREVIEW_CLICK_DEDUPE_MS) {
      log.info(`preview: "${identifier}" duplicate ignored (${previewClickNow - lastPreviewClick}ms)`);
      return;
    }
    while (previewClickDedupe.size >= PREVIEW_CLICK_DEDUPE_MAX) {
      const first = previewClickDedupe.keys().next().value;
      if (first === undefined) { break; }
      previewClickDedupe.delete(first);
    }
    previewClickDedupe.set(previewClickKey, previewClickNow);
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
  const preferDefinitionProvider = preferDefinitionProviderForPreviewIdentifier(identifier);
  if (!loc && preferDefinitionProvider) {
    loc = await resolvePreviewIdentifierViaDefinitionProvider(identifier, docUriStr, ms);
  }
  let originFs = '';
  try { if (docUriStr) { originFs = vscode.Uri.parse(docUriStr).fsPath; } } catch {}
  if (!originFs) { originFs = vscode.window.activeTextEditor?.document.uri.fsPath ?? ''; }
  if (!loc && originFs && indexManager && !preferDefinitionProvider) {
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
    loc = await resolvePreviewIdentifierViaDefinitionProvider(identifier, docUriStr, ms);
  }
  if (!loc) {
    loc = await resolvePreviewIdentifierFromCurrentMarkdown(identifier, ms);
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
    loc = await resolvePreviewIdentifierFromWorkspaceScan(identifier, docUriStr, ms);
  }
  const builtinPreviewMarkdown = preferDefinitionProvider ? builtinDecoratorPreviewMarkdown(identifier) : null;
  if (builtinPreviewMarkdown) {
    loc = loc ?? new vscode.Location(
      anchorPos.uri,
      new vscode.Range(anchorPos.line, anchorPos.character, anchorPos.line, anchorPos.character + identifier.length),
    );
  }
  if (!loc) {
    log.info(`preview: "${identifier}" no location (${ms()})`);
    return;
  }

  let doc: vscode.TextDocument;
  try { doc = await vscode.workspace.openTextDocument(loc.uri); }
  catch (err) { log.warn(`preview: openDoc error: ${err} (${ms()})`); return; }

  let markdown = '';
  if (builtinPreviewMarkdown) {
    markdown = builtinPreviewMarkdown;
    log.info(`preview: builtin decorator block ${identifier} md=${markdown.length} (${ms()})`);
  } else try {
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
    currentPreviewState = await withCurrentRendererScrollState(currentPreviewState);
    previewHistory.push(currentPreviewState);
  }
  const anchorDoc = findOpenDoc(anchorPos.uri);
  const anchorRange = anchorDoc
    ? fullWordRangeAt(anchorDoc, new vscode.Position(anchorPos.line, anchorPos.character))
    : undefined;
  const nextPreviewState: PreviewState = {
    identifier,
    markdown,
    anchor: anchorPos,
    anchorRange,
    originScrollState,
  };

  await applyPreviewStateAsHover(nextPreviewState, ms);
  currentPreviewState = nextPreviewState;
}

async function refireHoverAtAnchor(anchor: { uri: vscode.Uri; line: number; character: number }): Promise<void> {
  const newPos = new vscode.Position(anchor.line, anchor.character);
  const current = vscode.window.activeTextEditor;
  const visible = vscode.window.visibleTextEditors.find(editor =>
    editor.document.uri.toString() === anchor.uri.toString());
  const doc = findOpenDoc(anchor.uri) ?? await vscode.workspace.openTextDocument(anchor.uri);
  if (visible?.viewColumn === vscode.ViewColumn.One) {
    try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
  } else if (visible?.viewColumn === vscode.ViewColumn.Two) {
    try { await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup'); } catch {}
  } else if (visible?.viewColumn === vscode.ViewColumn.Three) {
    try { await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup'); } catch {}
  }
  const editor = visible
    ? await vscode.window.showTextDocument(doc, {
        viewColumn: visible.viewColumn,
        selection: new vscode.Range(newPos, newPos),
        preserveFocus: false,
      })
    : current?.document.uri.toString() === anchor.uri.toString()
      ? current
      : await vscode.window.showTextDocument(
          doc,
          { selection: new vscode.Range(newPos, newPos), preserveFocus: false },
        );
  editor.selection = new vscode.Selection(newPos, newPos);
  editor.revealRange(new vscode.Range(newPos, newPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  if (editor.viewColumn === vscode.ViewColumn.One) {
    try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
  } else if (editor.viewColumn === vscode.ViewColumn.Two) {
    try { await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup'); } catch {}
  } else if (editor.viewColumn === vscode.ViewColumn.Three) {
    try { await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup'); } catch {}
  }
  try { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 80));
  const lineLength = doc.lineAt(newPos.line).text.length;
  const resetCharacter = newPos.character > 0 ? 0 : Math.min(lineLength, newPos.character + 1);
  const resetPos = new vscode.Position(newPos.line, resetCharacter);
  if (!resetPos.isEqual(newPos)) {
    editor.selection = new vscode.Selection(resetPos, resetPos);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  await vscode.commands.executeCommand('editor.action.hideHover');
  await new Promise(resolve => setTimeout(resolve, 140));
  await vscode.commands.executeCommand('editor.action.hideHover');
  await new Promise(resolve => setTimeout(resolve, 140));
  const focusEditorGroup = async () => {
    if (editor.viewColumn === vscode.ViewColumn.One) {
      try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
    } else if (editor.viewColumn === vscode.ViewColumn.Two) {
      try { await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup'); } catch {}
    } else if (editor.viewColumn === vscode.ViewColumn.Three) {
      try { await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup'); } catch {}
    }
    try { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); } catch {}
  };
  recordPreviewHoverDebug({ kind: "refire-start", uri: anchor.uri.toString(), line: anchor.line, character: anchor.character });
  const attemptCount = 3;
  for (let attempt = 0; attempt < attemptCount; attempt++) {
    await focusEditorGroup();
    editor.selection = new vscode.Selection(newPos, newPos);
    editor.revealRange(new vscode.Range(newPos, newPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    try {
      await vscode.commands.executeCommand("editor.action.showHover");
      recordPreviewHoverDebug({ kind: "showHover-command", attempt, ok: true, line: newPos.line, character: newPos.character });
    } catch (err) {
      recordPreviewHoverDebug({ kind: "showHover-command", attempt, ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (attempt < attemptCount - 1) {
      await new Promise(resolve => setTimeout(resolve, 360));
    }
  }
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
    if (await shouldUseDirectRendererPreviewApply() && await applyPreviewStateInRenderer(prev, true)) {
      log.info(`previewBack: renderer applied "${prev.identifier}" (${ms()})`);
      return;
    }
    await applyPreviewStateAsHover(prev, ms, true);
    return;
  }
  // History empty → back to original LSP hover. Clear our override and
  // refire showHover at the saved anchor; $provideHover will take the
  // genuine LSP path (which also clears state via the fresh-hover branch,
  // but we clear here for clarity).
  const anchor = currentPreviewState.anchorRange
    ? centerPositionOfRange(currentPreviewState.anchorRange)
    : currentPreviewState.anchor;
  const anchorRef = {
    uri: currentPreviewState.anchor.uri,
    line: anchor.line,
    character: anchor.character,
  };
  const originScrollState = currentPreviewState.originScrollState;
  pendingPreviewHover = null;
  previewHoverSuppressUntil = 0;
  previewHoverSuppressKey = null;
  previewHoverSuppressCount = 0;
  currentPreviewState = null;
  log.info(`previewBack: → original native hover at ${anchorRef.line}:${anchorRef.character} (${ms()})`);
  await clearRendererPreviewNavigationStateInRenderer();
  try {
    await Promise.race([
      markRendererNativeHoverRefireGrace(1800),
      new Promise((_, reject) => setTimeout(() => reject(new Error('native refire grace timed out')), 900)),
    ]).catch(err => log.warn(`previewBack: native refire grace warning: ${err} (${ms()})`));
    await Promise.race([
      refireHoverAtAnchor(anchorRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error('native refire timed out')), 4200)),
    ]);
    if (originScrollState) {
      await restorePreviewScrollStateInRenderer(originScrollState);
    }
  } catch (err) {
    log.warn(`previewBack: native refire error: ${err} (${ms()})`);
  }
  await clearRendererPreviewNavigationStateInRenderer();
  pendingPreviewHover = null;
  previewHoverSuppressUntil = 0;
  previewHoverSuppressKey = null;
  previewHoverSuppressCount = 0;
  previewHistory.length = 0;
  currentPreviewState = null;
}

/**
 * Build pendingPreviewHover from a PreviewState (always prepends a
 * "← Back" command link — first drill-down's back returns to the LSP
 * hover; deeper drill-downs pop the prior page off history), move the
 * editor cursor to the state's anchor, then hide+show the hover so VS
 * Code's native pipeline picks up the override. Shared by drill-down
 * and back.
 */
async function requestRendererNativeHoverRefire(identifier: string, markdown: string, source: string): Promise<void> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    try { await runRendererInjection(injectRenderer); } catch {}
  }
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
  const rendererExpr = `
    (function() {
      try {
        if (typeof window.irShowHoverFallback !== 'function') {
          return { ok: false, reason: 'missing-irShowHoverFallback', patchVersion: Number(window.__irPatchVersion) || 0 };
        }
        try { window.__irNativePreviewBackUntil = Date.now() + 6000; } catch (_) {}
        return window.irShowHoverFallback(${jsonStringifyAscii(identifier)}, ${jsonStringifyAscii(markdown)}, {
          source: ${jsonStringifyAscii(source)}
        });
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  try {
    const rows = await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 1600);
    const value = (rows || []).map((row: any) => row?.value).find(Boolean);
    recordPreviewHoverDebug({ kind: "renderer-refire", identifier, source, value: value || null });
  } catch (err) {
    recordPreviewHoverDebug({ kind: "renderer-refire-error", identifier, source, error: err instanceof Error ? err.message : String(err) });
    log.warn("preview: renderer native refire prep failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

async function applyPreviewStateAsHover(state: PreviewState, ms: () => string, fromBack = false): Promise<void> {
  if (await shouldUseDirectRendererPreviewApply() && await applyPreviewStateInRenderer(state, fromBack)) {
    log.info(`preview: "${state.identifier}" renderer applied hist=${previewHistory.length} (${state.markdown.length}md, ${ms()})`);
    return;
  }
  const renderedMarkdown = state.markdown;
  const renderedMarkdownContent = {
    value: renderedMarkdown,
    isTrusted: true,
    supportThemeIcons: true,
  };
  const anchorDoc = findOpenDoc(state.anchor.uri);
  const pendingRange = internalRangeFromVsCode(state.anchorRange)
    ?? internalFullWordRangeAt(anchorDoc, new vscode.Position(state.anchor.line, state.anchor.character));
  pendingPreviewHover = {
    identifier: state.identifier,
    contents: [renderedMarkdownContent],
    range: pendingRange,
    anchorUriKey: hoverRequestUriKey(state.anchor.uri),
    anchorLine: state.anchor.line,
    anchorCharacter: state.anchor.character,
    expiresAt: Date.now() + 3000,
  };
  recordPreviewHoverDebug({
    kind: "pending-set",
    identifier: state.identifier,
    anchorUriKey: pendingPreviewHover.anchorUriKey,
    anchorLine: pendingPreviewHover.anchorLine,
    anchorCharacter: pendingPreviewHover.anchorCharacter,
    hasRange: !!pendingPreviewHover.range,
    range: pendingPreviewHover.range || null,
    markdownLength: renderedMarkdown.length,
  });
  previewHoverSuppressUntil = 0;
  previewHoverSuppressKey = null;
  previewHoverSuppressCount = 0;

  try {
    await markRendererNativeHoverRefireGrace(2400).catch(() => {});
    recordPreviewHoverDebug({
      kind: "renderer-refire-native-only",
      identifier: state.identifier,
      source: fromBack ? 'preview-back-native' : 'preview-forward-native',
    });
    await refireHoverAtAnchor(state.anchor);
    if (fromBack && state.scrollState) {
      await restorePreviewScrollStateInRenderer(state.scrollState);
    }
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

function evaluateInspectorExpression(wsUrl: string, expression: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = Math.floor(Math.random() * 1_000_000_000);
    let done = false;
    const finish = (err: Error | null, value?: any) => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) { reject(err); } else { resolve(value); }
    };
    const timeout = setTimeout(() => finish(new Error('inspector probe timed out')), timeoutMs);
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ id: requestId - 1, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({
          id: requestId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('message', (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id !== requestId) { return; }
        if (resp.error || resp.result?.exceptionDetails) {
          finish(new Error(resp.error?.message || resp.result?.exceptionDetails?.text || 'inspector probe failed'));
          return;
        }
        finish(null, resp.result?.result?.value);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('error', err => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

async function findInspectorWebSocketUrlForPid(mainPid: number): Promise<string | null> {
  const seen = new Set<string>();
  for (let port = 9229; port <= 9249; port++) {
    let targets: any[];
    try {
      targets = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
    } catch {
      continue;
    }
    for (const target of targets || []) {
      const wsUrl = String(target?.webSocketDebuggerUrl || '');
      if (!wsUrl || seen.has(wsUrl)) { continue; }
      seen.add(wsUrl);
      try {
        const pid = Number(await evaluateInspectorExpression(wsUrl, 'process.pid', 800));
        if (pid === mainPid) {
          log.info(`[inject] matched inspector port ${port} for main PID ${mainPid}`);
          return wsUrl;
        }
      } catch {}
    }
  }
  log.warn(`[inject] no inspector WebSocket matched main PID ${mainPid}`);
  return null;
}

// ── Renderer patch script ──

function getHoverPatchScript(): string {
  return `(function(){
var IR_PATCH_VERSION = ${RENDERER_PATCH_VERSION};
var IR_EXISTING_PATCH_VERSION = Number(window.__irPatchVersion)||0;
if(IR_EXISTING_PATCH_VERSION >= IR_PATCH_VERSION && window.__irTestHooks) return 'already patched v'+IR_EXISTING_PATCH_VERSION;

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
  if (window.__irActiveHoverHandleObserver) { try { window.__irActiveHoverHandleObserver.disconnect(); } catch(_) {} }
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
window.__irActiveHoverHandleObserver = null;
window.__irPatchVersion = IR_PATCH_VERSION;
window.__irScanLogCount = 0;
window.__irScanDecisionLogCount = 0;
window.__irWrapLogCount = 0;
window.__irPointWrapLogCount = 0;
window.__irStaleHoverLogCount = 0;
window.__irInactiveScanSkipLogCount = 0;
window.__irEmptyHoverRootSkipLogCount = 0;
window.__irHoverMissClickLogCount = 0;
window.__irLinkPointerEventLogCount = 0;
window.__irHoverGuardLinkLogCount = 0;
window.__irPointerActionLogCount = 0;
window.__irHoverLifecycleLogCount = 0;
window.__irLazyHoverLifecycleLogCount = 0;
window.__irHiddenActiveHoverLogCount = 0;
window.__irHoverGuardOutsideLogCount = 0;
window.__irHoverGuardNoLinkLogCount = 0;
window.__irPointWrapRejectLogCount = 0;
window.__irNearLinkLogCount = 0;
window.__irPendingLinkPointerDown = null;
window.__irHoverPatched = true;  // legacy compat

function irLogPrefix(){
  try{
    var meta=window.__irHostWindowMeta||{};
    var id=meta.id||window.__irHostWindowId||'?';
    var title=String(meta.title||window.__irHostWindowTitle||document.title||'').replace(/\\s+/g,' ').slice(0,80);
    return 'renderer[w='+id+' v='+IR_PATCH_VERSION+(title?' title='+title:'')+']: ';
  }catch(_){return 'renderer[w=? v='+IR_PATCH_VERSION+']: '}
}
function irLog(msg){
  if(typeof window.irGoToType!=='function')return;
  var text=String(msg||'');
  if(text.indexOf('renderer:')===0)text=text.slice('renderer:'.length).replace(/^\\s+/,'');
  window.irGoToType('LOG:'+irLogPrefix()+text);
}
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
    if(window.__irOriginalHoverSnapshot&&(!window.__irOriginalHoverSnapshot.hoverEl||!body.contains(window.__irOriginalHoverSnapshot.hoverEl))){
      window.__irOriginalHoverSnapshot=null;
    }
    if(window.__irLastPreviewTarget&&!body.contains(window.__irLastPreviewTarget)){
      window.__irLastPreviewTarget=null;
    }
    if(window.__irActiveHoverEl&&!body.contains(window.__irActiveHoverEl)){
      window.__irActiveHoverEl=null;
    }else if(irDisposeHiddenActiveHover('prune')){
      // The active hover was a hidden/zero-rect VS Code shell. It must not
      // keep receiving drill-down/link state after VS Code has dismissed it.
    }else if(window.__irActiveHoverEl){
      if(!irStoredPreviewTarget(window.__irActiveHoverEl)){
        window.__irActiveHoverEl.__irPrimaryPreviewTarget=null;
      }
      irRemoveInactiveHoverArtifacts(window.__irActiveHoverEl,'prune');
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
    if(window.__irActiveHoverHandleObserver){try{window.__irActiveHoverHandleObserver.disconnect()}catch(_){}}
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
    window.__irActiveHoverHandleObserver=null;
    window.__irHistoryFor=null;
    window.__irHistory=[];
    window.__irHistoryCurrent=null;
    window.__irOriginalHoverSnapshot=null;
    window.__irLastPreviewTarget=null;
    window.__irPendingLinkPointerDown=null;
    window.__irActiveHoverEl=null;
    window.__irInactiveScanSkipLogCount=0;
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
  '.monaco-hover .ir-back-btn,.monaco-editor-hover .ir-back-btn{display:inline-flex !important;align-items:center !important;gap:4px !important;margin:0 0 8px 0 !important;padding:1px 6px !important;border:0 !important;border-radius:3px !important;background:transparent !important;color:var(--vscode-textLink-foreground) !important;font:inherit !important;line-height:18px !important;cursor:pointer !important}',
  '.monaco-hover .ir-back-btn:hover,.monaco-editor-hover .ir-back-btn:hover{text-decoration:underline !important;background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,0.14)) !important}',
  // Inline code (within prose, NOT inside .monaco-tokenized-source).
  '.monaco-hover .ir-applied :not(.monaco-tokenized-source) > code,.monaco-editor-hover .ir-applied :not(.monaco-tokenized-source) > code{color:var(--vscode-textPreformat-foreground) !important;background:var(--vscode-textPreformat-background,var(--vscode-textCodeBlock-background,rgba(128,128,128,0.1))) !important;padding:1px 4px !important;border-radius:3px !important;font-family:var(--vscode-editor-font-family,monospace) !important;font-size:0.95em !important}',
  // Code token colors must come from VS Code's native .mtkN theme
  // classes. Do not color .ir-tk-* here; those classes are only semantic
  // markers used by tests and link wrapping fallback logic.
  '.monaco-hover .ir-applied .monaco-tokenized-source,.monaco-editor-hover .ir-applied .monaco-tokenized-source{display:block !important}',
  // Long normal hovers need the same native scrolling treatment as
  // drill-down hovers. VS Code's custom SmoothScrollableElement can keep
  // stale dimensions after our preview is appended, clipping the tail of
  // very large definitions.
  '.monaco-hover.ir-scrollable,.monaco-editor-hover.ir-scrollable{box-sizing:border-box !important;width:var(--ir-hover-width,760px) !important;height:var(--ir-hover-height,460px) !important;max-height:var(--ir-hover-height,460px) !important;max-width:var(--ir-hover-width,760px) !important;overflow:hidden !important;border-color:transparent !important;outline:0 !important;box-shadow:none !important}',
  '.monaco-hover.ir-scrollable,.monaco-hover.ir-scrollable *,.monaco-editor-hover.ir-scrollable,.monaco-editor-hover.ir-scrollable *{scrollbar-width:none !important;scrollbar-color:transparent transparent !important;-ms-overflow-style:none !important}',
  '.monaco-hover.ir-scrollable::-webkit-scrollbar,.monaco-hover.ir-scrollable *::-webkit-scrollbar,.monaco-editor-hover.ir-scrollable::-webkit-scrollbar,.monaco-editor-hover.ir-scrollable *::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important;background:transparent !important}',
  '.monaco-hover.ir-scrollable::-webkit-scrollbar-thumb,.monaco-hover.ir-scrollable *::-webkit-scrollbar-thumb,.monaco-hover.ir-scrollable::-webkit-scrollbar-track,.monaco-hover.ir-scrollable *::-webkit-scrollbar-track,.monaco-editor-hover.ir-scrollable::-webkit-scrollbar-thumb,.monaco-editor-hover.ir-scrollable *::-webkit-scrollbar-thumb,.monaco-editor-hover.ir-scrollable::-webkit-scrollbar-track,.monaco-editor-hover.ir-scrollable *::-webkit-scrollbar-track{display:none !important;background:transparent !important;border:0 !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element{overflow:auto !important;overscroll-behavior:contain !important;width:100% !important;height:var(--ir-hover-height,460px) !important;max-height:var(--ir-hover-height,460px) !important;max-width:var(--ir-hover-width,760px) !important;position:relative !important;border:0 !important;outline:0 !important;box-shadow:none !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element .monaco-scrollable-element,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element .monaco-scrollable-element{overflow:visible !important;height:auto !important;max-height:none !important;width:auto !important;max-width:none !important}',
  '.monaco-hover.ir-scrollable .monaco-hover-content,.monaco-editor-hover.ir-scrollable .monaco-hover-content{transform:none !important;top:0 !important;left:0 !important;position:static !important;overflow:visible !important}',
  '.monaco-hover.ir-scrollable .hover-row,.monaco-hover.ir-scrollable .hover-row-contents,.monaco-hover.ir-scrollable .hover-contents,.monaco-hover.ir-scrollable .markdown-hover,.monaco-hover.ir-scrollable .rendered-markdown,.monaco-editor-hover.ir-scrollable .hover-row,.monaco-editor-hover.ir-scrollable .hover-row-contents,.monaco-editor-hover.ir-scrollable .hover-contents,.monaco-editor-hover.ir-scrollable .markdown-hover,.monaco-editor-hover.ir-scrollable .rendered-markdown{box-sizing:border-box !important;width:100% !important;max-width:100% !important;max-height:none !important;overflow:visible !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-hover.ir-scrollable > .monaco-scrollable-element > .shadow,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .shadow{display:none !important}',
  '.monaco-hover.ir-scrollable .scrollbar,.monaco-hover.ir-scrollable .slider,.monaco-hover.ir-scrollable .shadow,.monaco-hover.ir-scrollable .sash,.monaco-hover.ir-scrollable .monaco-sash,.monaco-hover.ir-scrollable .scroll-decoration,.monaco-hover.ir-scrollable .decorationsOverviewRuler,.monaco-editor-hover.ir-scrollable .scrollbar,.monaco-editor-hover.ir-scrollable .slider,.monaco-editor-hover.ir-scrollable .shadow,.monaco-editor-hover.ir-scrollable .sash,.monaco-editor-hover.ir-scrollable .monaco-sash,.monaco-editor-hover.ir-scrollable .scroll-decoration,.monaco-editor-hover.ir-scrollable .decorationsOverviewRuler{display:none !important;visibility:hidden !important;pointer-events:none !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}',
  '.monaco-hover.ir-scrollable [class*="sash"],.monaco-hover.ir-scrollable [class*="scrollbar"],.monaco-editor-hover.ir-scrollable [class*="sash"],.monaco-editor-hover.ir-scrollable [class*="scrollbar"]{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}',
  '.ir-native-hover-handle-hidden{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;width:0 !important;height:0 !important;min-width:0 !important;min-height:0 !important;max-width:0 !important;max-height:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}',
  '.ir-hover-artifact-hidden{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important}',
  '.ir-stale-hover{display:none !important;visibility:hidden !important;pointer-events:none !important}',
  '.ir-empty-hover-root,.ir-empty-hover-root *{pointer-events:none !important}',
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
function irShortClassName(el){
  try{return el?String(el.className||'').replace(/\\s+/g,' ').slice(0,120):''}catch(_){return ''}
}
function irShortText(el,len){
  try{return String((el&&el.textContent)||'').replace(/\\s+/g,' ').slice(0,len||120)}catch(_){return ''}
}
function irRectBrief(el){
  try{
    if(!el||!el.getBoundingClientRect)return 'none';
    var r=el.getBoundingClientRect();
    return Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+'x'+Math.round(r.height);
  }catch(_){return 'err'}
}
function irElementBrief(el){
  try{
    if(!el)return 'none';
    return String(el.tagName||el.nodeName||'?').toLowerCase()
      +' class='+irShortClassName(el)
      +' text='+JSON.stringify(irShortText(el,60))
      +' rect='+irRectBrief(el);
  }catch(_){return 'err'}
}
function irEventPointBrief(e){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return 'point=none';
    return 'point='+Math.round(e.clientX)+','+Math.round(e.clientY);
  }catch(_){return 'point=err'}
}
function irFindNearbyTypeLink(e,hover,maxX,maxY){
  try{
    if(!hover||!hover.querySelectorAll||!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return null;
    var x=e.clientX,y=e.clientY;
    var links=hover.querySelectorAll('.ir-type-link');
    var best=null,bestScore=Infinity;
    for(var i=0;i<links.length;i++){
      var link=links[i];
      if(!link||!document.body.contains(link))continue;
      var r=link.getBoundingClientRect&&link.getBoundingClientRect();
      if(!r||r.width<=0||r.height<=0)continue;
      if(y<r.top-maxY||y>r.bottom+maxY)continue;
      if(x<r.left-maxX||x>r.right+maxX)continue;
      var dx=x<r.left?r.left-x:(x>r.right?x-r.right:0);
      var dy=y<r.top?r.top-y:(y>r.bottom?y-r.bottom:0);
      var score=(dx*dx)+(dy*dy);
      if(score<bestScore){
        bestScore=score;
        best={link:link,dx:Math.round(dx),dy:Math.round(dy),score:Math.round(Math.sqrt(score)),rect:Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+'x'+Math.round(r.height)};
      }
    }
    return best;
  }catch(_){return null}
}
function irUseNearbyTypeLink(e,hover,reason){
  var near=irFindNearbyTypeLink(e,hover,26,10);
  if(!near||!near.link)return null;
  irSetPointActiveLink(near.link);
  try{irMarkHoverManaged(hover,true)}catch(_){}
  if(window.__irNearLinkLogCount<40){
    window.__irNearLinkLogCount++;
    irLog('renderer: near-link '+(reason||'')+' "'+(near.link.getAttribute&&near.link.getAttribute('data-type')||'')+'" '+irEventPointBrief(e)+' dx='+near.dx+' dy='+near.dy+' linkRect='+near.rect+' target='+irElementBrief(irEventElement(e&&e.target)));
  }
  return near.link;
}
function irPreviewTargetIsUsable(hoverEl,target){
  try{
    return !!(hoverEl&&target&&document.body&&document.body.contains(target)&&hoverEl.contains(target));
  }catch(_){return false}
}
function irOutermostRenderedMarkdownWithin(hoverEl,node){
  try{
    var cur=node&&node.closest?node.closest('.rendered-markdown'):null;
    if(!cur||!hoverEl||!hoverEl.contains(cur))return null;
    for(;;){
      var parent=cur.parentElement&&cur.parentElement.closest?cur.parentElement.closest('.rendered-markdown'):null;
      if(!parent||!hoverEl.contains(parent))break;
      cur=parent;
    }
    return cur;
  }catch(_){return null}
}
function irStoredPreviewTarget(hoverEl){
  try{
    var stored=hoverEl&&hoverEl.__irPrimaryPreviewTarget;
    if(irPreviewTargetIsUsable(hoverEl,stored))return stored;
    if(hoverEl)hoverEl.__irPrimaryPreviewTarget=null;
  }catch(_){}
  return null;
}
function irSetPreviewTarget(hoverEl,target){
  if(!irPreviewTargetIsUsable(hoverEl,target))return null;
  try{
    var prev=hoverEl.__irPrimaryPreviewTarget;
    if(prev&&prev!==target&&prev.classList)prev.classList.remove('ir-primary-preview-target');
    hoverEl.__irPrimaryPreviewTarget=target;
    if(target.classList)target.classList.add('ir-primary-preview-target');
  }catch(_){}
  return target;
}
function irNormalizePreviewTarget(target){
  try{
    var hoverEl=target&&target.closest?target.closest('.monaco-hover, .monaco-editor-hover'):null;
    if(!hoverEl)return null;
    var stored=irStoredPreviewTarget(hoverEl);
    if(stored)return stored;
    var applied=target.closest&&target.closest('.rendered-markdown.ir-applied');
    if(irPreviewTargetIsUsable(hoverEl,applied))return irSetPreviewTarget(hoverEl,applied);
    var outer=irOutermostRenderedMarkdownWithin(hoverEl,target);
    if(outer)return irSetPreviewTarget(hoverEl,outer);
  }catch(_){}
  return null;
}
function irPreviewTargetForLink(link){
  try{
    var hoverEl=irClosestHover(link);
    if(!hoverEl)return null;
    return irStoredPreviewTarget(hoverEl)
      || irNormalizePreviewTarget(link)
      || irSetPreviewTarget(hoverEl,link.closest&&link.closest('.rendered-markdown'));
  }catch(_){return null}
}
function irEnsureHoverPointer(hoverEl){
  if(!hoverEl)return;
  try{hoverEl.style.pointerEvents='auto'}catch(_){}
  try{
    var sc=irPrimaryHoverScroller(hoverEl);
    if(sc)sc.style.pointerEvents='auto';
  }catch(_){}
}
function irClearPendingTypeLinkPointerDown(link,reason){
  try{
    var pending=window.__irPendingLinkPointerDown;
    if(!pending)return;
    if(link&&pending.link&&pending.link!==link)return;
    if(pending.timer)irClearTimer(pending.timer);
    if(window.__irPointerActionLogCount<140){
      window.__irPointerActionLogCount++;
      irLog('renderer: pointerdown fallback canceled "'+(pending.typeName||'')+'" reason='+(reason||'clear')+' matched='+(link?pending.link===link:'any'));
    }
    window.__irPendingLinkPointerDown=null;
  }catch(_){window.__irPendingLinkPointerDown=null}
}
function irRunTypeLinkAction(link,e,source,typeNameOverride,previewTargetOverride,modifiers){
  var typeName=typeNameOverride||(link&&link.getAttribute&&link.getAttribute('data-type'));
  if(!typeName)return false;
  var hover=link?irClosestHover(link):null;
  irMarkHoverManaged(hover,true);
  if(e){
    try{e.preventDefault()}catch(_){}
    try{e.stopImmediatePropagation()}catch(_){}
  }
  var meta=modifiers?!!modifiers.metaKey:!!(e&&(e.metaKey||e.ctrlKey)&&e.metaKey);
  var ctrl=modifiers?!!modifiers.ctrlKey:!!(e&&e.ctrlKey);
  if(meta||ctrl){
    irLog('renderer: cmd-'+source+' on "'+typeName+'"');
    if(typeof window.irGoToType==='function'){window.irGoToType(typeName)}
  }else{
    var anc=previewTargetOverride||null;
    if(!anc&&link)anc=irPreviewTargetForLink(link);
    window.__irLastPreviewTarget=anc;
    irLog('renderer: plain-'+source+' on "'+typeName+'" previewTarget='+irElementBrief(anc)+' hover={'+irHoverBrief(link?irClosestHover(link):null)+'}');
    if(typeof window.irGoToType==='function'){window.irGoToType('PREVIEW:'+typeName)}
  }
  return true;
}
function irScheduleTypeLinkPointerDownFallback(link,e){
  if(!link)return;
  var typeName=link.getAttribute&&link.getAttribute('data-type');
  if(!typeName)return;
  var target=irPreviewTargetForLink(link);
  window.__irLastPreviewTarget=target;
  irClearPendingTypeLinkPointerDown(null,'replace');
  var modifiers={metaKey:!!(e&&e.metaKey),ctrlKey:!!(e&&e.ctrlKey)};
  if(window.__irPointerActionLogCount<140){
    window.__irPointerActionLogCount++;
    irLog('renderer: pointerdown fallback scheduled "'+typeName+'" event='+(e&&e.type||'')+' target='+irElementBrief(target)+' hover={'+irHoverBrief(irClosestHover(link))+'}');
  }
  var timer=irSetTimer(function(){
    try{
      var pending=window.__irPendingLinkPointerDown;
      if(!pending||pending.link!==link)return;
      window.__irPendingLinkPointerDown=null;
      if(window.__irPointerActionLogCount<140){
        window.__irPointerActionLogCount++;
        irLog('renderer: pointerdown fallback firing "'+typeName+'" connected='+(document.body&&document.body.contains(link))+' target='+irElementBrief(target)+' hover={'+irHoverBrief(irClosestHover(link))+'}');
      }
      irRunTypeLinkAction(link,null,'pointerdown-fallback',typeName,target,modifiers);
    }catch(_){}
  },180);
  window.__irPendingLinkPointerDown={link:link,typeName:typeName,target:target,timer:timer,at:Date.now(),modifiers:modifiers};
}
function irPointWordSummary(e,hover){
  try{
    var range=irPointRange(e);
    var node=range&&range.startContainer;
    if(!node)return ' '+irEventPointBrief(e)+' word=none range=none';
    if(node.nodeType!==3)return ' '+irEventPointBrief(e)+' word=none nodeType='+node.nodeType;
    var parent=node.parentNode&&node.parentNode.nodeType===1?node.parentNode:node.parentElement;
    var info=irWordAtOffset(node.nodeValue||'',range.startOffset||0);
    if(!info)return ' '+irEventPointBrief(e)+' word=none parent='+irElementBrief(parent);
    var block=parent&&parent.closest?parent.closest('.rendered-markdown'):null;
    var hasCandidates=!!(block&&block.__irHoverLinkCandidates);
    var known=!!(block&&irBlockCandidateAllowsWord(block,info.word));
    var lower=irPointAllowsLowerCallable(node,info);
    var decorator=!!(block&&irPointAllowsDecorator(node,info,block));
    return ' '+irEventPointBrief(e)+' word='+JSON.stringify(info.word)
      +' offset='+String(range.startOffset||0)
      +' parent='+irElementBrief(parent)
      +' blockText='+(block?String(block.textContent||'').length:0)
      +' hasCandidates='+hasCandidates
      +' known='+known
      +' lowerCallable='+lower
      +' decorator='+decorator
      +' inHover='+(hover&&block?hover.contains(block):false);
  }catch(err){return ' wordSummaryError='+String(err&&err.message||err)}
}
function irLogHoverPointerMiss(e,kind){
  try{
    var missHover=irClosestHover(e&&e.target);
    if(!missHover||window.__irHoverMissClickLogCount>=80)return;
    window.__irHoverMissClickLogCount++;
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number')
      ? document.elementFromPoint(e.clientX,e.clientY)
      : null;
    var targetEl=irEventElement(e&&e.target);
    var pointCls=pointEl?String(pointEl.className||''):'';
    var targetCls=targetEl?String(targetEl.className||''):'';
    irLog('renderer: hover '+kind+' without link event='+(e&&e.type||'')+' target='+targetCls.slice(0,120)
      +' point='+pointCls.slice(0,120)
      +' hoverText='+(missHover.textContent||'').length
      +' links='+(missHover.querySelectorAll?missHover.querySelectorAll('.ir-type-link').length:0)
      +' empty='+(missHover.classList&&missHover.classList.contains('ir-empty-hover-root'))
      +' hoverRect='+irRectBrief(missHover)
      +' '+irEventPointBrief(e)
      +irPointWordSummary(e,missHover));
  }catch(_){}
}
function irHoverBrief(hoverEl){
  try{
    if(!hoverEl)return 'none';
    var visibility=irHoverRootVisibility(hoverEl);
    return 'rect='+irRectBrief(hoverEl)
      +' textLen='+String((hoverEl.textContent||'').length)
      +' links='+(hoverEl.querySelectorAll?hoverEl.querySelectorAll('.ir-type-link').length:0)
      +' connected='+(document.body&&document.body.contains(hoverEl))
      +' active='+(window.__irActiveHoverEl===hoverEl)
      +' renderable='+(visibility&&visibility.visible)
      +' visibilityReason='+(visibility&&visibility.reason||'')
      +' cls='+irShortClassName(hoverEl)
      +' sample='+JSON.stringify(irShortText(hoverEl,80));
  }catch(_){return 'err'}
}
function irLinkBrief(link){
  try{
    if(!link)return 'none';
    return '"'+String(link.getAttribute&&link.getAttribute('data-type')||'')+'" '+irElementBrief(link);
  }catch(_){return 'err'}
}
function irNearestLinkTrace(e,hover){
  try{
    var near=irFindNearbyTypeLink(e,hover,32,14);
    return near?' nearest="'+(near.link.getAttribute&&near.link.getAttribute('data-type')||'')+'" dx='+near.dx+' dy='+near.dy+' rect='+near.rect:' nearest=none';
  }catch(_){return ' nearest=err'}
}
function irLogPointerActionTrace(e,stage,link,resolution){
  try{
    if(window.__irPointerActionLogCount>=140)return;
    irDisposeHiddenActiveHover('pointer-'+(stage||''));
    var targetEl=irEventElement(e&&e.target);
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number')?document.elementFromPoint(e.clientX,e.clientY):null;
    var hover=irClosestHover(targetEl)||(link?irClosestHover(link):null);
    var activeHover=window.__irActiveHoverEl&&document.body.contains(window.__irActiveHoverEl)?window.__irActiveHoverEl:null;
    if(!link&&!hover&&!activeHover)return;
    window.__irPointerActionLogCount++;
    var activeLink=window.__irPointActiveLink&&document.body.contains(window.__irPointActiveLink)?window.__irPointActiveLink:null;
    irLog('renderer: pointer-action stage='+stage
      +' event='+(e&&e.type||'')
      +' resolution='+(resolution||'')
      +' '+irEventPointBrief(e)
      +' link='+irLinkBrief(link)
      +' activeLink='+irLinkBrief(activeLink)
      +' target='+irElementBrief(targetEl)
      +' point='+irElementBrief(pointEl)
      +' hover={'+irHoverBrief(hover)+'}'
      +' activeHover={'+irHoverBrief(activeHover)+'}'
      +irNearestLinkTrace(e,hover||activeHover));
  }catch(_){}
}

// Eat mousedown on type-links so VS Code's selection / focus-change
// logic can't fire before our click handler — some hover widgets
// dismiss on mousedown outside the editor.
function irTypeLinkPointerDown(e){
  var directLink=irClosestTypeLink(e.target);
  var wrappedLink=null;
  if(!directLink)wrappedLink=irWrapWordAtPoint(e);
  var link=directLink||wrappedLink;
  irLogPointerActionTrace(e,'pointerdown-capture',link,directLink?'direct':(wrappedLink?'wrapped':'none'));
  if(!link){
    irLogHoverPointerMiss(e,'pointerdown');
    irDisposeActiveHoverForEditorTarget(e,'pointerdown-no-link');
    return;
  }
  if(window.__irPointerActionLogCount<140){
    window.__irPointerActionLogCount++;
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number')?document.elementFromPoint(e.clientX,e.clientY):null;
    irLog('renderer: link '+(e&&e.type||'pointerdown')+' "'+(link.getAttribute&&link.getAttribute('data-type')||'')+'" target='+irElementBrief(irEventElement(e&&e.target))+' point='+irElementBrief(pointEl)+' link='+irElementBrief(link)+' hoverRect='+irRectBrief(irClosestHover(link)));
  }
  irMarkHoverManaged(irClosestHover(link),true);
  irScheduleTypeLinkPointerDownFallback(link,e);
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
//  2) Mouse OUTSIDE but near the drill-down hover gets a short grace window.
//     Far-away editor movement stays visible to VS Code even immediately
//     after the cursor was inside the panel, otherwise the first sticky hover
//     starves the next native hover of pointer events.
var IR_HOVER_INITIAL_STICKY_MS=5000;
var IR_HOVER_EXIT_GRACE_MS=1800;
var IR_HOVER_NEAR_PX=56;
var IR_HOVER_FRESH_EDITOR_GRACE_MS=120;
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
function irReleaseHoverSticky(hoverEl){
  if(!hoverEl||!hoverEl.classList)return;
  try{hoverEl.classList.remove('ir-sticky')}catch(_){}
  try{hoverEl.__irStickyUntil=0}catch(_){}
  try{hoverEl.__irLastInsideAt=0}catch(_){}
  try{
    if(hoverEl.__irStickyTimer){
      irClearTimer(hoverEl.__irStickyTimer);
      hoverEl.__irStickyTimer=null;
    }
  }catch(_){}
}
function irRequestNativeHideHover(reason){
  try{
    if(typeof window.irGoToType==='function'){
      window.irGoToType('HIDE_HOVER:'+(reason||'release'));
    }
  }catch(_){}
}
function irRequestNativeShowHover(reason){
  try{
    var now=Date.now();
    if(window.__irNativeShowHoverRequestedAt&&now-window.__irNativeShowHoverRequestedAt<260)return;
    window.__irNativeShowHoverRequestedAt=now;
    if(typeof window.irGoToType==='function'){
      window.irGoToType('SHOW_HOVER:'+(reason||'release'));
    }
  }catch(_){}
}
function irResetNativeHoverMutations(hoverEl){
  if(!hoverEl)return;
  try{
    var rootProps=['--ir-hover-width','--ir-hover-height','width','height','max-width','max-height','min-width','min-height','overflow','overflow-x','overflow-y','box-sizing','margin-left','margin-top','pointer-events','display','visibility','opacity'];
    for(var i=0;i<rootProps.length;i++)hoverEl.style.removeProperty(rootProps[i]);
    var nodes=[];
    var selectors='.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown';
    if(hoverEl.querySelectorAll){
      var found=hoverEl.querySelectorAll(selectors);
      for(var fi=0;fi<found.length;fi++)nodes.push(found[fi]);
    }
    var props=['width','height','max-width','max-height','min-width','min-height','overflow','overflow-x','overflow-y','scrollbar-width','scrollbar-color','overscroll-behavior','position','box-sizing','transform','top','left'];
    for(var ni=0;ni<nodes.length;ni++){
      var node=nodes[ni];
      if(!node||!node.style)continue;
      for(var pi=0;pi<props.length;pi++)node.style.removeProperty(props[pi]);
    }
  }catch(_){}
}
function irMarkNativeHoverReleased(hoverEl,reason,hideVisual){
  try{
    if(!hoverEl)return;
    var releasedText=String(hoverEl.textContent||'');
    hoverEl.__irReleasedAt=Date.now();
    hoverEl.__irReleasedText=releasedText;
    hoverEl.__irReleaseHideVisualRequested=!!hideVisual;
    hoverEl.__irPrimaryPreviewTarget=null;
    hoverEl.__irPreviewAppliedAt=0;
    hoverEl.__irStickyUntil=0;
    hoverEl.__irLastInsideAt=0;
    try{if(hoverEl.__irReleaseRemoveTimer)irClearTimer(hoverEl.__irReleaseRemoveTimer)}catch(_){}
    hoverEl.__irReleaseRemoveTimer=null;
    if(hoverEl.classList)hoverEl.classList.add('ir-native-released-hover');
    if(hoverEl.setAttribute)hoverEl.setAttribute('data-ir-native-released-hover','1');
    if(window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: native hover released retained '+(reason||'')+' hideVisual='+(hideVisual?'1':'0')+' textLen='+releasedText.length);
    }
  }catch(_){}
}
function irReleaseNativeHoverManagement(hoverEl,reason){
  if(!hoverEl||!hoverEl.classList)return false;
  var beforeBrief=irHoverBrief(hoverEl);
  var releaseReason=String(reason||'release');
  var removedForRelocation=false;
  var hostHideRequested=false;
  try{if(hoverEl.__irStickyTimer)irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  try{if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(hoverEl)}catch(_){}
  try{irResetHoverViewportShift(hoverEl)}catch(_){}
  try{irHideHoverNativeHandles(hoverEl,true)}catch(_){}
  try{
    hoverEl.__irPrimaryPreviewTarget=null;
    hoverEl.__irPreviewAppliedAt=0;
    hoverEl.__irStickyUntil=0;
    hoverEl.__irLastInsideAt=0;
    hoverEl.classList.remove('ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive','ir-empty-hover-root','ir-native-released-hover');
    if(hoverEl.removeAttribute){
      hoverEl.removeAttribute('data-ir-empty-hover-root');
      hoverEl.removeAttribute('data-ir-native-released-hover');
    }
    if(hoverEl.style){
      if(hoverEl.style.pointerEvents==='none')hoverEl.style.removeProperty('pointer-events');
      if(hoverEl.style.display==='none')hoverEl.style.removeProperty('display');
    }
    irResetNativeHoverMutations(hoverEl);
    irMarkNativeHoverReleased(hoverEl,releaseReason,releaseReason.indexOf('outside-editor')>=0);
  }catch(_){}
  try{
    if(window.__irActiveHoverEl===hoverEl)window.__irActiveHoverEl=null;
    if(window.__irHistoryFor===hoverEl){
      window.__irHistoryFor=null;
      window.__irHistory=[];
      window.__irHistoryCurrent=null;
    }
    if(window.__irOriginalHoverSnapshot&&window.__irOriginalHoverSnapshot.hoverEl===hoverEl){
      window.__irOriginalHoverSnapshot=null;
    }
    if(window.__irLastPreviewTarget&&irRootContains(hoverEl,window.__irLastPreviewTarget)){
      window.__irLastPreviewTarget=null;
    }
    if(document.activeElement&&(document.activeElement===hoverEl||irRootContains(hoverEl,document.activeElement))){
      try{document.activeElement.blur&&document.activeElement.blur()}catch(_){}
      try{document.body&&document.body.focus&&document.body.focus()}catch(_){}
    }
  }catch(_){}
  if(releaseReason.indexOf('outside-editor')>=0){
    try{
      if(hoverEl.getAttribute&&hoverEl.getAttribute('data-ir-forced-hover')==='1'&&hoverEl.parentNode){
        hoverEl.parentNode.removeChild(hoverEl);
        removedForRelocation=true;
      }
    }catch(_){}
  }
  if(window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: native hover management released '+releaseReason+' hostHide='+(hostHideRequested?'1':'0')+' removed='+(removedForRelocation?'1':'0')+' victim={'+beforeBrief+'}');
  }
  return true;
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
function irIsHoverRelocationEvent(e){
  return !!(e&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='pointerover'||e.type==='mouseover'));
}
function irClosestNativePopup(target){
  try{
    var el=irEventElement(target);
    if(!el||!el.closest)return null;
    return el.closest('.suggest-widget,.quick-input-widget,.context-view,.parameter-hints-widget,.monaco-menu,.action-widget,.peekview-widget,.rename-box,.zone-widget,.find-widget,.markers-panel,.notifications-toasts,.notifications-center');
  }catch(_){return null}
}
function irElementIsEditorSurface(el){
  try{
    if(!el||!el.closest)return false;
    if(el.closest('.monaco-hover,.monaco-editor-hover')||irClosestNativePopup(el))return false;
    return !!el.closest('.monaco-editor');
  }catch(_){return false}
}
function irEventTargetsEditorSurface(e){
  try{
    var targetEl=irEventElement(e&&e.target);
    if(irElementIsEditorSurface(targetEl))return true;
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number'&&typeof e.clientY==='number')
      ? document.elementFromPoint(e.clientX,e.clientY)
      : null;
    return irElementIsEditorSurface(pointEl);
  }catch(_){return false}
}
function irEditorSurfaceUnderHoverPoint(hoverEl,e){
  try{
    if(!hoverEl||!e||typeof e.clientX!=='number'||typeof e.clientY!=='number'||typeof document.elementsFromPoint!=='function')return null;
    var els=document.elementsFromPoint(e.clientX,e.clientY)||[];
    for(var i=0;i<els.length;i++){
      var el=irEventElement(els[i]);
      if(!el)continue;
      if(irRootContains(hoverEl,el))continue;
      if(irElementIsEditorSurface(el))return el.closest('.monaco-editor');
    }
  }catch(_){}
  return null;
}
function irEventTargetTokenText(e){
  try{
    function tokenFromElement(el){
      try{
        if(!el)return '';
        var text=String(el.textContent||'')
          .replace(/[\u200B-\u200D\uFEFF]/g,'')
          .replace(/\u00a0/g,' ')
          .replace(/\\s+/g,' ')
          .trim();
        if(!text||text.length>160)return '';
        if(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)&&text.length<=80)return text;
        var className=String(el.className||'');
        if(!/(^|\\s)mtk\\d+(\\s|$)/.test(className))return '';
        var matches=text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g)||[];
        if(matches.length===1&&matches[0].length<=80)return matches[0];
      }catch(_){}
      return '';
    }
    var candidates=[];
    var targetEl=irEventElement(e&&e.target);
    if(targetEl)candidates.push(targetEl);
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number'&&typeof e.clientY==='number')
      ? document.elementFromPoint(e.clientX,e.clientY)
      : null;
    pointEl=irEventElement(pointEl);
    if(pointEl&&pointEl!==targetEl)candidates.push(pointEl);
    if(typeof document.elementsFromPoint==='function'&&typeof e.clientX==='number'&&typeof e.clientY==='number'){
      var els=document.elementsFromPoint(e.clientX,e.clientY)||[];
      for(var i=0;i<els.length&&candidates.length<8;i++){
        var el=irEventElement(els[i]);
        if(el&&candidates.indexOf(el)<0)candidates.push(el);
      }
    }
    for(var ci=0;ci<candidates.length;ci++){
      var token=tokenFromElement(candidates[ci]);
      if(token)return token;
    }
  }catch(_){return ''}
  return '';
}
function irHoverContainsTokenText(hoverEl,token){
  try{
    return !!(hoverEl&&token&&token.length>1&&String(hoverEl.textContent||'').indexOf(token)>=0);
  }catch(_){return false}
}
function irHoverRecentlyPreviewApplied(hoverEl){
  try{
    return !!(hoverEl&&hoverEl.__irPreviewAppliedAt&&Date.now()-hoverEl.__irPreviewAppliedAt<1200);
  }catch(_){return false}
}
function irRememberPointerEvent(e){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return;
    window.__irLastPointer={x:e.clientX,y:e.clientY,at:Date.now(),type:String(e.type||'')};
  }catch(_){}
}
function irDisposeActiveHoverForEditorTarget(e,reason){
  try{
    var active=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
      ? window.__irActiveHoverEl
      : null;
    if(!active||!irHoverHasManagedContent(active))return false;
    var targetEl=irEventElement(e&&e.target);
    if(irClosestHover(targetEl))return false;
    if(irClosestNativePopup(targetEl)){
      irReleaseHoverSticky(active);
      irReleaseNativeHoverManagement(active,reason||'native-popup-active-hover');
      if(window.__irHoverGuardOutsideLogCount<80){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: active-hover disposed for native popup reason='+(reason||'')+' event='+(e&&e.type||'')+' target='+irElementBrief(targetEl));
      }
      return true;
    }
    if(!irElementIsEditorSurface(targetEl)&&!irEventTargetsEditorSurface(e))return false;
    irReleaseHoverSticky(active);
    irReleaseNativeHoverManagement(active,reason||'editor-target-active-hover');
    if(window.__irHoverGuardOutsideLogCount<80){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: active-hover disposed for editor target reason='+(reason||'')+' event='+(e&&e.type||'')+' target='+irElementBrief(targetEl)+' '+irEventPointBrief(e));
    }
    return true;
  }catch(_){return false}
}
function irHoverGuard(e){
  try{irDisposeHiddenActiveHover('hoverguard')}catch(_){}
  if(irClosestNativePopup(e&&e.target)){
    try{
      var activeNativeBypass=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
        ? window.__irActiveHoverEl
        : null;
      if(activeNativeBypass&&irHoverHasManagedContent(activeNativeBypass)){
        irReleaseHoverSticky(activeNativeBypass);
        irReleaseNativeHoverManagement(activeNativeBypass,'native-popup-pass');
      }else if(activeNativeBypass){
        irReleaseHoverSticky(activeNativeBypass);
      }
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard native-popup-pass event='+e.type+' target='+irElementBrief(irEventElement(e&&e.target))+' active={'+irHoverBrief(activeNativeBypass)+'}');
      }
    }catch(_){}
    return;
  }
  try{
    var activeEditorHover=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
      ? window.__irActiveHoverEl
      : null;
    if(activeEditorHover&&irHoverHasManagedContent(activeEditorHover)
      && irIsHoverRelocationEvent(e)
      && irEventTargetsEditorSurface(e)
      && !irClosestHover(e.target)){
      var editorMoveToken=irEventTargetTokenText(e);
      if(editorMoveToken&&!irHoverContainsTokenText(activeEditorHover,editorMoveToken)){
        irReleaseHoverSticky(activeEditorHover);
        irReleaseNativeHoverManagement(activeEditorHover,"outside-editor-new-token");
        irRequestNativeShowHover("outside-editor-new-token");
        if(window.__irHoverGuardOutsideLogCount<80){
          window.__irHoverGuardOutsideLogCount++;
          irLog("renderer: hoverguard active-dispose new-token token="+JSON.stringify(editorMoveToken)+" event="+(e&&e.type||"")+" target="+irElementBrief(irEventElement(e&&e.target))+" managed={disposed}");
        }
        return;
      }
    }
  }catch(_){}
  var insideHv=irClosestHover(e.target);
  if(insideHv){
    var pointLink=null;
    try{pointLink=irWrapWordAtPoint(e)}catch(_){}
    if(pointLink&&window.__irHoverGuardLinkLogCount<120&&(e.type==='pointerover'||e.type==='mouseover'||e.type==='pointermove'||e.type==='mousemove')){
      window.__irHoverGuardLinkLogCount++;
      irLog('renderer: hoverguard link-active "'+(pointLink.getAttribute&&pointLink.getAttribute('data-type')||'')+'" event='+e.type+' target='+irElementBrief(irEventElement(e.target))+' link='+irElementBrief(pointLink));
    }else if(!pointLink&&window.__irHoverGuardNoLinkLogCount<120&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
      window.__irHoverGuardNoLinkLogCount++;
      var near=irFindNearbyTypeLink(e,insideHv,26,10);
      irLog('renderer: hoverguard no point-link event='+e.type+' '+irEventPointBrief(e)+' target='+irElementBrief(irEventElement(e.target))+' hoverRect='+irRectBrief(insideHv)+(near?' nearest="'+(near.link.getAttribute&&near.link.getAttribute('data-type')||'')+'" dx='+near.dx+' dy='+near.dy+' rect='+near.rect:' nearest=none')+irPointWordSummary(e,insideHv));
    }
    if(!pointLink&&!irHoverHasManagedContent(insideHv))return;
    if(!pointLink&&(e.type==='pointermove'||e.type==='mousemove')){
      var pointElementInsideHover=false;
      try{
        var pointElement=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number'&&typeof e.clientY==='number')
          ? irEventElement(document.elementFromPoint(e.clientX,e.clientY))
          : null;
        pointElementInsideHover=!!(pointElement&&irRootContains(insideHv,pointElement));
      }catch(_){}
      var underEditor=pointElementInsideHover?null:irEditorSurfaceUnderHoverPoint(insideHv,e);
      if(underEditor){
        irReleaseHoverSticky(insideHv);
        irReleaseNativeHoverManagement(insideHv,'outside-editor-inside-hover-relocation');
        if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
          window.__irHoverGuardOutsideLogCount++;
          irLog('renderer: hoverguard inside-dispose event='+e.type+' underEditor=true sticky='+(insideHv.classList&&insideHv.classList.contains('ir-sticky'))+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' hover={disposed}');
        }
        return;
      }
    }
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
  var editorTarget=irIsHoverRelocationEvent(e)&&irEventTargetsEditorSurface(e);
  if(editorTarget){
    if(managed.__irActivatedAt&&now-managed.__irActivatedAt<IR_HOVER_FRESH_EDITOR_GRACE_MS){
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-fresh-pass event='+e.type+' near='+near+' age='+(now-managed.__irActivatedAt)+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    var editorToken=irEventTargetTokenText(e);
    if(editorToken&&near&&irHoverContainsTokenText(managed,editorToken)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-same-token-pass event='+e.type+' token='+JSON.stringify(editorToken)+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    if(!editorToken&&near&&(isSticky||recentlyInside)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-unknown-token-near-pass event='+e.type+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    irReleaseHoverSticky(managed);
    irReleaseNativeHoverManagement(managed,editorToken?'outside-editor-token-relocation':'outside-editor-relocation');
    irRequestNativeShowHover(editorToken?'outside-editor-token-relocation':'outside-editor-relocation');
    if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: hoverguard outside-editor-dispose event='+e.type+' token='+JSON.stringify(editorToken)+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={disposed}');
    }
    return;
  }
  if(near){
    if(near)irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
    if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: hoverguard outside-near-pass event='+e.type+' near='+near+' editorTarget='+!!editorTarget+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
    }
    return;
  }
  if(isSticky){
    irReleaseHoverSticky(managed);
    if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: hoverguard outside-release event='+e.type+' near='+near+' editorTarget=false recentlyInside='+!!recentlyInside+' sticky=true target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
    }
  }else if(recentlyInside&&window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
    window.__irHoverGuardOutsideLogCount++;
    irLog('renderer: hoverguard outside-pass event='+e.type+' near='+near+' editorTarget=false recentlyInside=true sticky=false target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
  }
}
track(window,'pointermove',irRememberPointerEvent,true);
track(window,'mousemove',irRememberPointerEvent,true);
track(window,'mouseover',irRememberPointerEvent,true);
track(window,'pointerover',irRememberPointerEvent,true);
track(document,'pointermove',irRememberPointerEvent,true);
track(document,'mousemove',irRememberPointerEvent,true);
track(document,'mouseover',irRememberPointerEvent,true);
track(document,'pointerover',irRememberPointerEvent,true);
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
function irActiveHoverRoot(){
  var active=window.__irActiveHoverEl;
  if(active&&document.body.contains(active))return active;
  var roots=document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
  var best=null,bestText=-1;
  for(var i=0;i<roots.length;i++){
    if(!document.body.contains(roots[i]))continue;
    var len=String(roots[i].textContent||'').trim().length;
    if(len>=bestText){best=roots[i];bestText=len}
  }
  return best;
}
function irPreviewScrollSnapshot(hoverEl,target){
  if(!hoverEl)return null;
  var normalized=target?irNormalizePreviewTarget(target):null;
  var sc=irPrimaryHoverScroller(hoverEl);
  var row=normalized&&normalized.closest?normalized.closest('.hover-row,.markdown-hover'):null;
  return {
    scrollerScrollTop: sc?Math.max(0,Math.floor(sc.scrollTop||0)):0,
    hoverScrollTop: Math.max(0,Math.floor(hoverEl.scrollTop||0)),
    rowScrollTop: row?Math.max(0,Math.floor(row.scrollTop||0)):0,
    targetScrollTop: normalized?Math.max(0,Math.floor(normalized.scrollTop||0)):0
  };
}
function irNormalizePreviewScrollState(state){
  if(!state||typeof state!=='object')return null;
  function n(v){v=Number(v);return isFinite(v)&&v>0?Math.floor(v):0}
  var out={
    scrollerScrollTop:n(state.scrollerScrollTop),
    hoverScrollTop:n(state.hoverScrollTop),
    rowScrollTop:n(state.rowScrollTop),
    targetScrollTop:n(state.targetScrollTop)
  };
  return out.scrollerScrollTop||out.hoverScrollTop||out.rowScrollTop||out.targetScrollTop?out:null;
}
function irRestorePreviewScroll(hoverEl,target,state){
  var scroll=irNormalizePreviewScrollState(state);
  if(!hoverEl||!scroll)return;
  var normalized=target?irNormalizePreviewTarget(target):null;
  function apply(){
    try{
      var sc=irPrimaryHoverScroller(hoverEl);
      if(sc)sc.scrollTop=scroll.scrollerScrollTop;
      if(hoverEl)hoverEl.scrollTop=scroll.hoverScrollTop;
      var row=normalized&&normalized.closest?normalized.closest('.hover-row,.markdown-hover'):null;
      if(row)row.scrollTop=scroll.rowScrollTop;
      if(normalized)normalized.scrollTop=scroll.targetScrollTop;
    }catch(_){}
  }
  apply();
  try{requestAnimationFrame(apply)}catch(_){}
  try{setTimeout(apply,35)}catch(_){}
}
function irVisiblePreviewTargetInHover(hover){
  if(!hover)return null;
  var target=irStoredPreviewTarget(hover)||irNormalizePreviewTarget(window.__irLastPreviewTarget);
  if(target&&document.body.contains(target))return target;
  try{
    var nodes=hover.querySelectorAll('.rendered-markdown.ir-applied, .rendered-markdown');
    for(var i=nodes.length-1;i>=0;i--){
      if(nodes[i].offsetParent!==null)return irNormalizePreviewTarget(nodes[i])||nodes[i];
    }
  }catch(_){}
  return null;
}
function irCaptureOriginalHoverSnapshot(hoverEl,target){
  try{
    if(!hoverEl||!target||!document.body.contains(hoverEl)||!hoverEl.contains(target))return;
    if(window.__irOriginalHoverSnapshot){
      if(window.__irOriginalHoverSnapshot.hoverEl===hoverEl){
        window.__irOriginalHoverSnapshot.scroll=irPreviewScrollSnapshot(hoverEl,target);
      }
      return;
    }
    if(window.__irHistoryCurrent)return;
    if(!String(target.textContent||'').trim())return;
    var clone=hoverEl.cloneNode(true);
    if(!clone)return;
    window.__irOriginalHoverSnapshot={
      hoverEl:hoverEl,
      clone:clone,
      className:String(hoverEl.className||''),
      styleText:String(hoverEl.getAttribute('style')||''),
      scroll:irPreviewScrollSnapshot(hoverEl,target)
    };
    irLog('renderer: captured original hover snapshot');
  }catch(eOS){irLog('renderer: original snapshot capture err: '+(eOS&&eOS.message));}
}
window.__irRestorePreviewScrollState=function(state){
  try{
    var scroll=irNormalizePreviewScrollState(state);
    if(!scroll)return {ok:false,reason:'empty-scroll',patchVersion:Number(window.__irPatchVersion)||0};
    var hover=irActiveHoverRoot();
    if(!hover)return {ok:false,reason:'no-hover',patchVersion:Number(window.__irPatchVersion)||0};
    var target=irVisiblePreviewTargetInHover(hover)||hover;
    try{irMakeHoverScrollable(hover,false,(hover.textContent||'').length)}catch(_){}
    irRestorePreviewScroll(hover,target,scroll);
    return {ok:true,scroll:scroll,patchVersion:Number(window.__irPatchVersion)||0};
  }catch(eRS){
    return {ok:false,reason:String(eRS&&eRS.message||eRS),patchVersion:Number(window.__irPatchVersion)||0};
  }
};
window.__irRestoreOriginalHoverSnapshot=function(scrollOverride){
  try{
    var snap=window.__irOriginalHoverSnapshot;
    if(!snap||!snap.hoverEl||!snap.clone||!document.body.contains(snap.hoverEl)){
      return {ok:false,reason:'missing-original-snapshot',patchVersion:Number(window.__irPatchVersion)||0};
    }
    var hover=snap.hoverEl;
    var clone=snap.clone.cloneNode(true);
    while(hover.firstChild)hover.removeChild(hover.firstChild);
    while(clone.firstChild)hover.appendChild(clone.firstChild);
    try{hover.className=snap.className||hover.className;}catch(_){}
    try{hover.setAttribute('style',snap.styleText||'');}catch(_){}
    hover.classList.add('ir-keepalive');
    hover.classList.add('ir-scrollable');
    irSetActiveHoverLayer(hover);
    var target=irVisiblePreviewTargetInHover(hover);
    if(!target){
      var nodes=hover.querySelectorAll('.rendered-markdown');
      target=nodes.length?nodes[nodes.length-1]:hover;
      if(target&&target!==hover)irSetPreviewTarget(hover,target);
    }
    window.__irHistoryFor=hover;
    window.__irHistory=[];
    window.__irHistoryCurrent=null;
    window.__irLastPreviewTarget=target&&target!==hover?target:null;
    try{irMakeHoverScrollable(hover,false,(hover.textContent||'').length)}catch(_){}
    try{
      var restoredBlocks=hover.querySelectorAll?hover.querySelectorAll('.rendered-markdown'):[];
      for(var rbi=0;rbi<restoredBlocks.length;rbi++){
        restoredBlocks[rbi].__irLastScanText=null;
      }
    }catch(_){}
    try{irScanRenderedMarkdown()}catch(_){try{irScheduleScan()}catch(_){}}
    var scroll=irNormalizePreviewScrollState(scrollOverride)||snap.scroll;
    if(scroll)irRestorePreviewScroll(hover,target||hover,scroll);
    window.__irOriginalHoverSnapshot=null;
    irLog('renderer: restored original hover snapshot');
    return {ok:true,scroll:scroll||null,patchVersion:Number(window.__irPatchVersion)||0};
  }catch(eRO){
    return {ok:false,reason:String(eRO&&eRO.message||eRO),patchVersion:Number(window.__irPatchVersion)||0};
  }
};
function irScheduleOriginalHoverRestoreFallback(){
  try{
    var hist=window.__irHistory||[];
    if(hist.length||!window.__irOriginalHoverSnapshot)return;
    var delays=[120,360,760];
    for(var di=0;di<delays.length;di++){
      irSetTimer(function(){
        try{
          if(window.__irOriginalHoverSnapshot&&typeof window.__irRestoreOriginalHoverSnapshot==='function'){
            window.__irRestoreOriginalHoverSnapshot(null);
          }
        }catch(_){}
      },delays[di]);
    }
  }catch(_){}
}
window.__irCapturePreviewScroll=function(){
  var hover=irActiveHoverRoot();
  if(!hover)return null;
  var target=irVisiblePreviewTargetInHover(hover);
  if(!target||!document.body.contains(target)){
    var nodes=hover.querySelectorAll('.rendered-markdown.ir-applied, .rendered-markdown');
    for(var i=nodes.length-1;i>=0;i--){
      if(nodes[i].offsetParent!==null){target=irNormalizePreviewTarget(nodes[i]);break}
    }
  }
  return irPreviewScrollSnapshot(hover,target);
};
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
var IR_HOVER_ROOT_SELECTOR='.monaco-hover,.monaco-editor-hover';
var IR_HOVER_NATIVE_HANDLE_SELECTOR='.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler,[class*="scrollbar"],[class*="sash"]';
var IR_HOVER_EXTERNAL_HANDLE_SELECTOR='.scrollbar,.slider,.shadow,.sash,.monaco-sash,.scroll-decoration,.decorationsOverviewRuler';
var IR_HOVER_GLOBAL_ARTIFACT_SELECTOR='[data-ir-hover-owned="1"],.ir-e2e-external-artifact,.ir-e2e-body-handle';
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
    handle.setAttribute('data-ir-hover-artifact','1');
    handle.setAttribute('data-ir-hover-owned','1');
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
      transform:'none',
      border:'0',
      outline:'0',
      boxShadow:'none',
      background:'transparent'
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
  try{irHideGlobalHoverNativeHandles(hoverEl,remove)}catch(_){}
  try{irHideExternalHoverNativeHandles(hoverEl,remove)}catch(_){}
}
function irElementRect(el){
  try{
    if(!el||!el.getBoundingClientRect)return null;
    var r=el.getBoundingClientRect();
    if(!r)return null;
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width||Math.max(0,r.right-r.left),height:r.height||Math.max(0,r.bottom-r.top)};
  }catch(_){return null}
}
function irRectsIntersect(a,b,pad){
  if(!a||!b)return false;
  pad=pad||0;
  return a.right>=b.left-pad&&a.left<=b.right+pad&&a.bottom>=b.top-pad&&a.top<=b.bottom+pad;
}
function irShouldRemoveGlobalHoverHandle(node,activeHover){
  if(!node||node.nodeType!==1)return false;
  try{
    if(!(node.matches&&node.matches(IR_HOVER_GLOBAL_ARTIFACT_SELECTOR)))return false;
    var owner=irHoverRootFromElement(node);
    if(owner){
      return !activeHover||irRootContains(activeHover,owner)||irRootContains(owner,activeHover)||irIsStaleHoverRoot(owner);
    }
    if(!activeHover||!document.body||!document.body.contains(activeHover))return false;
    var nr=irElementRect(node), hr=irElementRect(activeHover);
    if(!nr||!hr)return false;
    if(nr.width<1&&nr.height<1)return false;
    return irRectsIntersect(nr,hr,12);
  }catch(_){return false}
}
function irHideGlobalHoverNativeHandles(activeHover,remove){
  var removed=0;
  try{
    var handles=document.querySelectorAll(IR_HOVER_GLOBAL_ARTIFACT_SELECTOR);
    for(var hi=0;hi<handles.length;hi++){
      var h=handles[hi];
      if(irShouldRemoveGlobalHoverHandle(h,activeHover)){
        irQuarantineHoverNativeHandle(h,remove!==false);
        removed++;
      }
    }
  }catch(_){}
  return removed;
}
function irLooksLikeExternalHoverHandle(node,activeHover){
  try{
    if(!node||!activeHover||!document.body||!document.body.contains(activeHover))return false;
    if(irHoverRootFromElement(node))return false;
    if(irRootContains(activeHover,node))return false;
    if(!(node.matches&&node.matches(IR_HOVER_EXTERNAL_HANDLE_SELECTOR)))return false;
    var nr=irElementRect(node), hr=irElementRect(activeHover);
    if(!nr||!hr)return false;
    if(nr.width<2&&nr.height<2)return false;
    if(!irRectsIntersect(nr,hr,16))return false;
    var centerX=(nr.left+nr.right)/2;
    var centerY=(nr.top+nr.bottom)/2;
    var verticalEdge=nr.height>=18&&nr.width<=32&&centerX>=hr.right-10&&centerX<=hr.right+10&&nr.bottom>=hr.top-12&&nr.top<=hr.bottom+12;
    var horizontalEdge=nr.width>=18&&nr.height<=32&&centerY>=hr.bottom-10&&centerY<=hr.bottom+10&&nr.right>=hr.left-12&&nr.left<=hr.right+12;
    var corner=nr.width<=32&&nr.height<=32&&centerX>=hr.right-14&&centerX<=hr.right+14&&centerY>=hr.bottom-14&&centerY<=hr.bottom+14;
    var topRightCorner=nr.width<=32&&nr.height<=32&&centerX>=hr.right-14&&centerX<=hr.right+14&&centerY>=hr.top-14&&centerY<=hr.top+14;
    var topRightHorizontal=nr.width>=18&&nr.height<=32&&centerY>=hr.top-10&&centerY<=hr.top+10&&nr.right>=hr.right-14&&nr.left<=hr.right+14;
    return !!(verticalEdge||horizontalEdge||corner||topRightCorner||topRightHorizontal);
  }catch(_){return false}
}
function irHideExternalHoverNativeHandles(activeHover,remove){
  var removed=0;
  if(!activeHover||!document.body||!document.body.contains(activeHover))return removed;
  try{
    var handles=document.querySelectorAll(IR_HOVER_EXTERNAL_HANDLE_SELECTOR);
    for(var hi=0;hi<handles.length;hi++){
      var h=handles[hi];
      if(irLooksLikeExternalHoverHandle(h,activeHover)){
        irQuarantineHoverNativeHandle(h,remove!==false);
        removed++;
      }
    }
  }catch(_){}
  return removed;
}
function irNodeMatchesOrContains(node,selector){
  var out=[];
  try{
    if(!node||node.nodeType!==1)return out;
    if(node.matches&&node.matches(selector))out.push(node);
    if(node.querySelectorAll){
      var found=node.querySelectorAll(selector);
      for(var i=0;i<found.length;i++)out.push(found[i]);
    }
  }catch(_){}
  return out;
}
function irLooksLikeNewExternalHoverHandle(node,activeHover){
  try{
    if(!node||!activeHover||!document.body||!document.body.contains(activeHover))return false;
    if(irHoverRootFromElement(node))return false;
    var nr=irElementRect(node), hr=irElementRect(activeHover);
    if(!nr||!hr)return false;
    if(nr.width<2&&nr.height<2)return false;
    if(!irRectsIntersect(nr,hr,12))return false;
    return !!(node.classList&&node.classList.contains('ir-e2e-body-handle'));
  }catch(_){return false}
}
function irCleanupAddedHoverHandleNode(node,activeHover,remove){
  var cleaned=false;
  try{
    var handles=irNodeMatchesOrContains(node,IR_HOVER_NATIVE_HANDLE_SELECTOR);
    for(var hi=0;hi<handles.length;hi++){
      var h=handles[hi];
      if(irRootContains(activeHover,h)||irLooksLikeNewExternalHoverHandle(h,activeHover)||irLooksLikeExternalHoverHandle(h,activeHover)){
        irQuarantineHoverNativeHandle(h,remove!==false);
        cleaned=true;
      }
    }
    var artifacts=irNodeMatchesOrContains(node,IR_HOVER_GLOBAL_ARTIFACT_SELECTOR);
    for(var ai=0;ai<artifacts.length;ai++){
      var a=artifacts[ai];
      if(irShouldRemoveGlobalHoverHandle(a,activeHover)){
        irQuarantineHoverNativeHandle(a,remove!==false);
        cleaned=true;
      }
    }
  }catch(_){}
  return cleaned;
}
function irClearHoverHandleCleanup(hoverEl){
  if(!hoverEl)return;
  try{if(hoverEl.__irHandleCleanupFrame)cancelAnimationFrame(hoverEl.__irHandleCleanupFrame)}catch(_){}
  hoverEl.__irHandleCleanupFrame=0;
  try{
    if(hoverEl.__irHandleCleanupTimers){
      for(var ti=0;ti<hoverEl.__irHandleCleanupTimers.length;ti++)irClearTimer(hoverEl.__irHandleCleanupTimers[ti]);
    }
  }catch(_){}
  hoverEl.__irHandleCleanupTimers=[];
}
function irScheduleHoverNativeHandleCleanup(hoverEl,remove){
  if(!hoverEl)return;
  irClearHoverHandleCleanup(hoverEl);
  var run=function(){
    try{
      if(!hoverEl||!document.body||!document.body.contains(hoverEl))return;
      irHideHoverNativeHandles(hoverEl,remove!==false);
      irHideGlobalHoverNativeHandles(hoverEl,remove!==false);
    }catch(_){}
  };
  run();
  try{
    hoverEl.__irHandleCleanupFrame=requestAnimationFrame(function(){
      hoverEl.__irHandleCleanupFrame=0;
      run();
      try{requestAnimationFrame(run)}catch(_){}
    });
  }catch(_){}
  hoverEl.__irHandleCleanupTimers=[
    irSetTimer(run,60),
    irSetTimer(run,180),
    irSetTimer(run,360),
    irSetTimer(run,720),
    irSetTimer(run,1400)
  ];
}
function irStopActiveHoverHandleObserver(){
  try{
    if(window.__irActiveHoverHandleObserver)window.__irActiveHoverHandleObserver.disconnect();
  }catch(_){}
  window.__irActiveHoverHandleObserver=null;
  try{
    if(window.__irActiveHoverGlobalHandleObserver)window.__irActiveHoverGlobalHandleObserver.disconnect();
  }catch(_){}
  window.__irActiveHoverGlobalHandleObserver=null;
}
function irWatchHoverNativeHandles(hoverEl){
  irStopActiveHoverHandleObserver();
  if(!hoverEl||typeof MutationObserver==='undefined')return;
  try{
    var obs=irTrackObserver(new MutationObserver(function(muts){
      var shouldClean=false;
      for(var mi=0;mi<muts.length;mi++){
        var m=muts[mi];
        if(m.type==='attributes'){
          var t=m.target;
          if(t&&t.nodeType===1){
            var isOwnedArtifact=false;
            try{isOwnedArtifact=!!(t.matches&&t.matches(IR_HOVER_GLOBAL_ARTIFACT_SELECTOR))}catch(_){}
            if(irRootContains(hoverEl,t)||isOwnedArtifact){
              if(irCleanupAddedHoverHandleNode(t,hoverEl,true))shouldClean=true;
            }
          }
        }
        var added=m.addedNodes||[];
        for(var ai=0;ai<added.length;ai++){
          var n=added[ai];
          if(!n||n.nodeType!==1)continue;
          if(irCleanupAddedHoverHandleNode(n,hoverEl,true))shouldClean=true;
        }
      }
      if(shouldClean)irScheduleHoverNativeHandleCleanup(hoverEl,true);
    }));
    var watchRoot=hoverEl;
    obs.observe(watchRoot,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','aria-hidden']});
    window.__irActiveHoverHandleObserver=obs;
  }catch(_){}
}
function irRootContains(root,el){
  try{return !!(root&&el&&(root===el||(root.contains&&root.contains(el))))}catch(_){return false}
}
function irHoverRootFromElement(el){
  try{return el&&el.closest?el.closest(IR_HOVER_ROOT_SELECTOR):null}catch(_){return null}
}
function irHoverRootsInNode(node){
  var out=[];
  try{
    if(!node||node.nodeType!==1)return out;
    if(node.matches&&node.matches(IR_HOVER_ROOT_SELECTOR))out.push(node);
    if(node.querySelectorAll){
      var roots=node.querySelectorAll(IR_HOVER_ROOT_SELECTOR);
      for(var i=0;i<roots.length;i++)out.push(roots[i]);
    }
  }catch(_){}
  return out;
}
function irIsStaleHoverRoot(root){
  try{return !!(root&&root.classList&&root.classList.contains('ir-stale-hover'))}catch(_){return false}
}
function irIsSyntheticHoverRoot(root){
  try{
    return !!(root&&root.classList&&(
      root.classList.contains('ir-e2e-hover')||
      root.classList.contains('ir-e2e-empty-hover')||
      root.classList.contains('ir-test-seeded-hover')
    ));
  }catch(_){return false}
}
function irIsNativeHoverRoot(root){
  try{
    return !!(root&&root.matches&&root.matches(IR_HOVER_ROOT_SELECTOR)&&!irIsSyntheticHoverRoot(root));
  }catch(_){return false}
}
function irHoverRootVisibility(root){
  try{
    if(!root)return {visible:false,reason:'missing'};
    if(!document.body||!document.body.contains(root))return {visible:false,reason:'detached'};
    if(irIsStaleHoverRoot(root))return {visible:false,reason:'stale'};
    var cls=root.classList;
    if(cls&&(cls.contains('hidden')||cls.contains('ir-stale-hover')))return {visible:false,reason:'hidden-class'};
    if(root.getAttribute&&root.getAttribute('aria-hidden')==='true')return {visible:false,reason:'aria-hidden'};
    var cs=window.getComputedStyle?window.getComputedStyle(root):null;
    if(cs){
      if(cs.display==='none')return {visible:false,reason:'display-none'};
      if(cs.visibility==='hidden')return {visible:false,reason:'visibility-hidden'};
      if(Number(cs.opacity)===0)return {visible:false,reason:'opacity-zero'};
    }
    var r=root.getBoundingClientRect?root.getBoundingClientRect():null;
    if(!r)return {visible:false,reason:'no-rect'};
    if(r.width<2||r.height<2)return {visible:false,reason:'zero-rect'};
    return {visible:true,reason:'visible'};
  }catch(eV){
    return {visible:false,reason:'visibility-error:'+String(eV&&eV.message||eV)};
  }
}
function irIsRenderableHoverRoot(root){
  return !!(irHoverRootVisibility(root)||{}).visible;
}
function irRememberVisibleHoverRect(root,reason){
  try{
    if(!root||!root.getBoundingClientRect)return;
    var visibility=irHoverRootVisibility(root);
    if(!visibility||!visibility.visible)return;
    var r=root.getBoundingClientRect();
    if(!r||r.width<2||r.height<2)return;
    root.__irLastVisibleRect={
      left:Math.round(r.left),
      top:Math.round(r.top),
      width:Math.round(r.width),
      height:Math.round(r.height)
    };
    root.__irLastVisibleRectAt=Date.now();
  }catch(_){}
}
function irForcePreviewHoverVisible(root,reason){
  try{
    if(!root||!root.style)return false;
    if(root.classList)root.classList.remove('hidden','ir-stale-hover','ir-native-released-hover');
    if(root.removeAttribute){
      root.removeAttribute('aria-hidden');
      root.removeAttribute('hidden');
    }
    root.style.setProperty('display','block','important');
    root.style.setProperty('visibility','visible','important');
    root.style.setProperty('opacity','1','important');
    root.style.setProperty('pointer-events','auto','important');
    root.style.setProperty('position','fixed','important');
    var remembered=root.__irLastVisibleRect||null;
    var rememberedFresh=root.__irLastVisibleRectAt&&Date.now()-root.__irLastVisibleRectAt<5000;
    if(remembered&&rememberedFresh){
      var current=root.getBoundingClientRect?root.getBoundingClientRect():null;
      var currentEmpty=!current||current.width<2||current.height<2;
      if(currentEmpty){
        root.style.setProperty('left',Math.max(0,remembered.left)+'px','important');
        root.style.setProperty('top',Math.max(0,remembered.top)+'px','important');
        root.style.setProperty('width',Math.max(240,remembered.width)+'px','important');
        root.style.setProperty('height',Math.max(120,remembered.height)+'px','important');
        root.style.setProperty('max-width',Math.max(240,remembered.width)+'px','important');
        root.style.setProperty('max-height',Math.max(120,remembered.height)+'px','important');
      }
    }
    irEnsureHoverPointer(root);
    try{irMakeHoverScrollable(root,false,String(root.textContent||'').length)}catch(_){}
    var visibility=irHoverRootVisibility(root);
    if(visibility&&visibility.visible){
      irRememberVisibleHoverRect(root,reason||'force-visible');
      return true;
    }
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: force preview hover visible failed '+(reason||'')+' reason='+(visibility&&visibility.reason||'')+' active={'+irHoverBrief(root)+'}');
    }
  }catch(_){}
  return false;
}
function irReviveRecentlyAppliedHover(root,reason){
  try{
    if(!root||!irHoverRecentlyPreviewApplied(root))return false;
    if(root.classList)root.classList.remove('hidden','ir-stale-hover','ir-native-released-hover');
    if(root.removeAttribute)root.removeAttribute('aria-hidden');
    if(root.style){
      root.style.display='';
      root.style.visibility='';
      root.style.opacity='';
      if(!root.style.position)root.style.position='fixed';
    }
    if(!irForcePreviewHoverVisible(root,reason||'recent-preview'))return false;
    irSetActiveHoverLayer(root);
    var visibility=irHoverRootVisibility(root);
    if(visibility&&visibility.visible){
      if(window.__irHiddenActiveHoverLogCount<80){
        window.__irHiddenActiveHoverLogCount++;
        irLog('renderer: revived recent preview hover '+(reason||'')+' active={'+irHoverBrief(root)+'}');
      }
      return true;
    }
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: recent preview hover revive failed '+(reason||'')+' reason='+(visibility&&visibility.reason||'')+' active={'+irHoverBrief(root)+'}');
    }
  }catch(_){}
  return false;
}
function irReleaseNativeHiddenHover(root,reason,visibilityReason){
  if(!root||!irIsNativeHoverRoot(root))return false;
  var refireGrace=false;
  try{refireGrace=!!(window.__irNativeHoverRefireUntil&&Date.now()<window.__irNativeHoverRefireUntil)}catch(_){}
  try{if(root.__irStickyTimer)irClearTimer(root.__irStickyTimer)}catch(_){}
  try{if(root.__irFitFrame)cancelAnimationFrame(root.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(root)}catch(_){}
  try{irResetHoverViewportShift(root)}catch(_){}
  try{irHideHoverNativeHandles(root,true)}catch(_){}
  try{
    if(window.__irActiveHoverEl===root){
      irStopActiveHoverHandleObserver();
      window.__irActiveHoverEl=null;
    }
    if(window.__irHistoryFor===root){
      window.__irHistoryFor=null;
      window.__irHistory=[];
      window.__irHistoryCurrent=null;
    }
    if(window.__irOriginalHoverSnapshot&&window.__irOriginalHoverSnapshot.hoverEl===root){
      window.__irOriginalHoverSnapshot=null;
    }
    if(window.__irLastPreviewTarget&&irRootContains(root,window.__irLastPreviewTarget)){
      window.__irLastPreviewTarget=null;
    }
  }catch(_){}
  try{
    root.__irPrimaryPreviewTarget=null;
    root.__irPreviewAppliedAt=0;
    root.__irStickyUntil=0;
    root.__irLastInsideAt=0;
    root.classList.remove('ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive','ir-empty-hover-root','ir-native-released-hover');
    if(root.getAttribute&&root.getAttribute('data-ir-empty-hover-root')==='1'&&root.removeAttribute){
      root.removeAttribute('data-ir-empty-hover-root');
    }
    if(root.removeAttribute)root.removeAttribute('data-ir-native-released-hover');
    irResetNativeHoverMutations(root);
    irMarkNativeHoverReleased(root,reason||'hidden-native',true);
  }catch(_){}
  if(window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: native hidden hover cleaned '+(reason||'')+' reason='+(visibilityReason||'')+' refireGrace='+(refireGrace?'1':'0')+' retained=1 removed=0 victim={'+irHoverBrief(root)+'}');
  }
  return true;
}
function irDisposeHiddenActiveHover(reason){
  try{
    var active=window.__irActiveHoverEl;
    if(!active||!document.body||!document.body.contains(active))return false;
    var visibility=irHoverRootVisibility(active);
    if(visibility&&visibility.visible)return false;
    if(irReviveRecentlyAppliedHover(active,reason||'hidden-active'))return false;
    if(irReleaseNativeHiddenHover(active,'hidden-active-'+(reason||''),visibility&&visibility.reason))return true;
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: hidden active hover disposed '+(reason||'')+' reason='+(visibility&&visibility.reason||'')+' active={'+irHoverBrief(active)+'}');
    }
    irDisposeStaleHover(active,'hidden-active-'+(reason||''));
    return true;
  }catch(_){return false}
}
function irHoverRootHasActivatingContent(root){
  try{
    if(!root)return false;
    if(String(root.textContent||'').trim().length>0)return true;
    var blocks=root.querySelectorAll?root.querySelectorAll('.rendered-markdown,.hover-row,.hover-row-contents,.monaco-hover-content,.hover-contents,.ir-type-link,a'):null;
    if(!blocks)return false;
    for(var i=0;i<blocks.length;i++){
      if(String(blocks[i].textContent||'').trim().length>0)return true;
    }
  }catch(_){}
  return false;
}
function irHoverRootRectSummary(root){
  try{
    var r=root&&root.getBoundingClientRect?root.getBoundingClientRect():null;
    if(!r)return '';
    return ' rect='+Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+'x'+Math.round(r.height);
  }catch(_){return ''}
}
function irMarkEmptyHoverRoot(root){
  if(!root||!root.classList)return;
  try{
    var active=window.__irActiveHoverEl;
    if(active&&active!==root&&document.body&&document.body.contains(active)
      &&irIsRenderableHoverRoot(active)&&irHoverRootHasActivatingContent(active)){
      if(root.parentNode)root.parentNode.removeChild(root);
      if(window.__irHoverLifecycleLogCount<120){
        window.__irHoverLifecycleLogCount++;
        irLog('renderer: empty hover root removed active-populated victim={'+irHoverBrief(root)+'} active={'+irHoverBrief(active)+'}');
      }
      return;
    }
    root.classList.add('ir-empty-hover-root');
    root.setAttribute('data-ir-empty-hover-root','1');
    root.style.pointerEvents='none';
  }catch(_){}
}
function irClearEmptyHoverRoot(root){
  if(!root||!root.classList)return;
  try{
    var owned=root.getAttribute&&root.getAttribute('data-ir-empty-hover-root')==='1';
    root.classList.remove('ir-empty-hover-root');
    if(root.removeAttribute)root.removeAttribute('data-ir-empty-hover-root');
    if(owned&&root.style&&root.style.pointerEvents==='none')root.style.removeProperty('pointer-events');
  }catch(_){}
}
function irRefreshEmptyHoverRootState(root){
  var hasContent=irHoverRootHasActivatingContent(root);
  if(hasContent)irClearEmptyHoverRoot(root);
  else irMarkEmptyHoverRoot(root);
  return hasContent;
}
function irMarkHoverRootSeen(root){
  try{
    if(!root)return;
    var now=Date.now();
    if(!root.__irSeenAt)root.__irSeenAt=now;
    root.__irLastSeenAt=now;
  }catch(_){}
}
function irHoverRootActivityTime(root){
  try{
    if(!root)return 0;
    return Math.max(root.__irActivatedAt||0,root.__irContentChangedAt||0,root.__irLastSeenAt||0,root.__irSeenAt||0);
  }catch(_){return 0}
}
function irIsTransientHoverText(text){
  var key=String(text||'').replace(/\s+/g,' ').trim();
  if(!key)return true;
  if(key==='Loading'||key==='Loading...'||key==='Loading…')return true;
  if(key.length<=2)return true;
  return false;
}
function irTouchHoverRootContent(root,reason,text){
  try{
    if(!root)return;
    var now=Date.now();
    root.__irContentChangedAt=now;
    irRememberVisibleHoverRect(root,reason||'content');
    var sample=String(text==null?(root.textContent||''):text).replace(/\s+/g,' ').trim();
    var previousLength=Number(root.__irLastContentLength)||0;
    var currentLength=String(root.textContent||'').length;
    root.__irLastContentLength=currentLength;
    try{
      if(root.getAttribute&&root.getAttribute('data-ir-native-released-hover')==='1'){
        var releasedText=String(root.__irReleasedText||'');
        var currentText=String(root.textContent||'');
        if(currentText&&currentText!==releasedText&&!irIsTransientHoverText(sample)){
          if(root.__irReleaseRemoveTimer){
            irClearTimer(root.__irReleaseRemoveTimer);
            root.__irReleaseRemoveTimer=null;
          }
          root.__irReleasedAt=0;
          root.__irReleasedText='';
          if(root.classList)root.classList.remove('ir-native-released-hover');
          if(root.removeAttribute)root.removeAttribute('data-ir-native-released-hover');
          if(root.style){
            if(root.style.pointerEvents==='none')root.style.removeProperty('pointer-events');
            if(root.style.visibility==='hidden')root.style.removeProperty('visibility');
            if(root.style.opacity==='0')root.style.removeProperty('opacity');
            if(root.style.display==='none')root.style.removeProperty('display');
          }
          if(window.__irHoverLifecycleLogCount<120){
            window.__irHoverLifecycleLogCount++;
            irLog('renderer: released native hover revived '+(reason||'content')+' len='+currentLength);
          }
        }
      }
    }catch(_){}
    if(window.__irLazyHoverLifecycleLogCount<120){
      var interesting=irIsTransientHoverText(sample)
        || previousLength===0
        || Math.abs(currentLength-previousLength)>24
        || currentLength>120;
      if(interesting){
        window.__irLazyHoverLifecycleLogCount++;
        irLog('renderer: lazy-hover content '+(reason||'change')
          +' len='+currentLength
          +' prev='+previousLength
          +' transient='+(irIsTransientHoverText(sample)?'1':'0')
          +' host={'+irHoverBrief(root)+'}');
      }
    }
  }catch(_){}
}
function irActivateHoverRoot(root,reason){
  if(!root||irIsStaleHoverRoot(root))return false;
  try{
    try{
      var ownedReleased=root.getAttribute&&root.getAttribute('data-ir-native-released-hover')==='1';
      if(root.__irReleasedAt&&Date.now()-root.__irReleasedAt<1600){
        var releasedText=String(root.__irReleasedText||'');
        var currentText=String(root.textContent||'');
        if(releasedText&&currentText===releasedText&&!irIsRenderableHoverRoot(root)){
          if(window.__irHoverLifecycleLogCount<120){
            window.__irHoverLifecycleLogCount++;
            irLog('renderer: skip unchanged released native hover '+(reason||'')+' root={'+irHoverBrief(root)+'}');
          }
          return false;
        }
      }
      if(root.classList)root.classList.remove('ir-native-released-hover');
      if(root.style&&root.style.pointerEvents==='none')root.style.removeProperty('pointer-events');
      if(ownedReleased&&root.style){
        if(root.style.visibility==='hidden')root.style.removeProperty('visibility');
        if(root.style.opacity==='0')root.style.removeProperty('opacity');
        if(root.style.display==='none')root.style.removeProperty('display');
      }
      if(root.removeAttribute)root.removeAttribute('data-ir-native-released-hover');
    }catch(_){}
    irMarkHoverRootSeen(root);
    if(!irIsRenderableHoverRoot(root)){
      if(window.__irHiddenActiveHoverLogCount<80){
        window.__irHiddenActiveHoverLogCount++;
        irLog('renderer: skip unrenderable hover root '+(reason||'')+' '+irHoverBrief(root)+irHoverRootRectSummary(root));
      }
      return false;
    }
    irRememberVisibleHoverRect(root,reason||'activate');
    if(!irRefreshEmptyHoverRootState(root)){
      if(window.__irEmptyHoverRootSkipLogCount<80){
        window.__irEmptyHoverRootSkipLogCount++;
        irLog('renderer: skip empty hover root '+(reason||'')+' '+irHoverBrief(root)+irHoverRootRectSummary(root));
      }
      return false;
    }
    root.__irActivatedAt=Date.now();
    var prev=window.__irActiveHoverEl;
    irSetActiveHoverLayer(root);
    if(window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: active hover root '+(reason||'')+' new={'+irHoverBrief(root)+'} prev={'+irHoverBrief(prev)+'}');
    }
    return true;
  }catch(_){return false}
}
function irActivateAddedHoverRoots(node,reason){
  var roots=irHoverRootsInNode(node), activated=0;
  for(var i=0;i<roots.length;i++){
    if(irActivateHoverRoot(roots[i],reason||'added-root'))activated++;
  }
  return activated;
}
function irShouldKeepRecentEmptyHoverRoot(root,activeHover,pendingKeepRoot){
  try{
    if(!root||irIsStaleHoverRoot(root))return false;
    if(activeHover&&irHoverRootHasActivatingContent(activeHover)&&root!==pendingKeepRoot)return false;
    irMarkHoverRootSeen(root);
    if(!irIsRenderableHoverRoot(root))return Date.now()-(root.__irSeenAt||0)<1200;
    if(irRefreshEmptyHoverRootState(root))return false;
    return Date.now()-(root.__irSeenAt||0)<1200;
  }catch(_){return false}
}
function irRecentPendingHoverActivity(root,activeHover){
  try{
    if(!root||irIsStaleHoverRoot(root))return 0;
    if(irRootContains(activeHover,root)||irRootContains(root,activeHover))return 0;
    if(activeHover&&irHoverRecentlyPreviewApplied(activeHover))return 0;
    if(root.classList
      && (root.classList.contains('ir-keepalive')||root.classList.contains('ir-scrollable'))){
      return 0;
    }
    var now=Date.now();
    var activity=Math.max(root.__irContentChangedAt||0,root.__irSeenAt||0);
    if(now-activity>1200)return 0;
    return activity||0;
  }catch(_){return 0}
}
function irPickPendingHoverRootToKeep(roots,activeHover){
  var best=null,bestActivity=0;
  try{
    for(var i=0;i<roots.length;i++){
      var root=roots[i];
      irMarkHoverRootSeen(root);
      var activity=irRecentPendingHoverActivity(root,activeHover);
      if(activity&&activity>=bestActivity){
        best=root;
        bestActivity=activity;
      }
    }
  }catch(_){}
  return best;
}
function irShouldKeepRecentPendingHoverRoot(root,activeHover,pendingKeepRoot){
  try{
    if(!root||root!==pendingKeepRoot)return false;
    if(!irIsRenderableHoverRoot(root))return true;
    var hasContent=irRefreshEmptyHoverRootState(root);
    if(window.__irLazyHoverLifecycleLogCount<120){
      window.__irLazyHoverLifecycleLogCount++;
      irLog('renderer: lazy-hover prune-keep pending hasContent='+(hasContent?'1':'0')
        +' age='+(Date.now()-irRecentPendingHoverActivity(root,activeHover))
        +' root={'+irHoverBrief(root)+'}'
        +' active={'+irHoverBrief(activeHover)+'}');
    }
    return true;
  }catch(_){return false}
}
function irShouldProcessHoverBlock(hoverHost,block){
  if(!hoverHost)return true;
  try{
    irMarkHoverRootSeen(hoverHost);
    irClearEmptyHoverRoot(hoverHost);
    var active=window.__irActiveHoverEl;
    if(active&&document.body&&document.body.contains(active)&&!irIsRenderableHoverRoot(active)){
      irDisposeHiddenActiveHover('scan');
      active=window.__irActiveHoverEl;
    }
    if(hoverHost&&!irIsRenderableHoverRoot(hoverHost)){
      if(window.__irInactiveScanSkipLogCount<40){
        window.__irInactiveScanSkipLogCount++;
        irLog('renderer: skip unrenderable hover scan host={'+irHoverBrief(hoverHost)+'} active={'+irHoverBrief(active)+'}');
      }
      return false;
    }
    if(!active||!document.body||!document.body.contains(active)){
      irActivateHoverRoot(hoverHost,'scan-fallback');
      return true;
    }
    if(irRootContains(active,block))return true;
    if(!irIsStaleHoverRoot(hoverHost)&&irHoverRootHasActivatingContent(hoverHost)){
      var activeHasContent=irHoverRootHasActivatingContent(active);
      var activeSeen=irHoverRootActivityTime(active);
      var hostSeen=irHoverRootActivityTime(hoverHost);
      var hostChanged=hoverHost.__irContentChangedAt||0;
      var freshHostChange=hostChanged&&Date.now()-hostChanged<1200;
      if(!activeHasContent||hostSeen>=activeSeen||freshHostChange){
        irActivateHoverRoot(hoverHost,'scan-new-active');
        return true;
      }
    }
    if(window.__irInactiveScanSkipLogCount<40){
      window.__irInactiveScanSkipLogCount++;
      irLog('renderer: skip inactive hover scan host={'+irHoverBrief(hoverHost)+'} active={'+irHoverBrief(active)+'}'
        +' hostActivity='+irHoverRootActivityTime(hoverHost)
        +' activeActivity='+irHoverRootActivityTime(active)
        +' hostChanged='+(hoverHost&&hoverHost.__irContentChangedAt||0)
        +' activeChanged='+(active&&active.__irContentChangedAt||0));
    }
    return false;
  }catch(_){return true}
}
function irRemoveInactiveHoverArtifacts(activeHover,reason){
  var removed=0, artifacts=0;
  if(activeHover&&!irIsRenderableHoverRoot(activeHover)){
    irDisposeHiddenActiveHover(reason||'inactive-sweep');
    activeHover=window.__irActiveHoverEl;
  }
  try{artifacts+=irHideGlobalHoverNativeHandles(activeHover,true)||0}catch(_){}
  try{
    var roots=document.querySelectorAll(IR_HOVER_ROOT_SELECTOR);
    var pendingKeepRoot=irPickPendingHoverRootToKeep(roots,activeHover);
    for(var i=0;i<roots.length;i++){
      var h=roots[i];
      if(irRootContains(activeHover,h)||irRootContains(h,activeHover))continue;
      if(irShouldKeepRecentPendingHoverRoot(h,activeHover,pendingKeepRoot))continue;
      if(irShouldKeepRecentEmptyHoverRoot(h,activeHover,pendingKeepRoot))continue;
      irDisposeStaleHover(h,reason||'inactive-sweep');
      removed++;
    }
  }catch(_){}
  try{
    var stray=document.querySelectorAll(IR_HOVER_GLOBAL_ARTIFACT_SELECTOR);
    for(var si=0;si<stray.length;si++){
      var node=stray[si];
      if(irRootContains(activeHover,node))continue;
      artifacts++;
      try{
        if(node.parentNode)node.parentNode.removeChild(node);
        else irQuarantineHoverNativeHandle(node,true);
      }catch(_){try{irQuarantineHoverNativeHandle(node,true)}catch(_){}}
    }
  }catch(_){}
  try{
    var stale=document.querySelectorAll('.ir-stale-hover');
    for(var st=0;st<stale.length;st++){
      var sh=stale[st];
      if(irRootContains(activeHover,sh))continue;
      if(sh.parentNode){sh.parentNode.removeChild(sh);removed++}
    }
  }catch(_){}
  if((removed||artifacts)&&window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: inactive hover sweep '+(reason||'')+' panels='+removed+' artifacts='+artifacts+' active={'+irHoverBrief(activeHover)+'}');
  }
}
function irDisposeStaleHover(hoverEl,reason){
  if(!hoverEl||!hoverEl.classList)return;
  var beforeBrief=irHoverBrief(hoverEl);
  try{if(hoverEl.__irStickyTimer)irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  try{if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(hoverEl)}catch(_){}
  try{irResetHoverViewportShift(hoverEl)}catch(_){}
  try{irHideHoverNativeHandles(hoverEl,true)}catch(_){}
  if(irIsNativeHoverRoot(hoverEl)){
    var refireGrace=false;
    try{refireGrace=!!(window.__irNativeHoverRefireUntil&&Date.now()<window.__irNativeHoverRefireUntil)}catch(_){}
    try{
      hoverEl.__irPrimaryPreviewTarget=null;
      hoverEl.__irPreviewAppliedAt=0;
      hoverEl.__irStickyUntil=0;
      hoverEl.__irLastInsideAt=0;
      hoverEl.classList.remove('ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive','ir-empty-hover-root','ir-native-released-hover');
      if(hoverEl.removeAttribute){
        hoverEl.removeAttribute('data-ir-empty-hover-root');
        hoverEl.removeAttribute('data-ir-native-released-hover');
      }
      irResetNativeHoverMutations(hoverEl);
      irMarkNativeHoverReleased(hoverEl,reason||'stale-native',true);
    }catch(_){}
    try{
      if(window.__irActiveHoverEl===hoverEl)window.__irActiveHoverEl=null;
      if(window.__irHistoryFor===hoverEl){
        window.__irHistoryFor=null;
        window.__irHistory=[];
        window.__irHistoryCurrent=null;
      }
    }catch(_){}
    if(window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: native hover shell cleaned '+(reason||'')+' refireGrace='+(refireGrace?'1':'0')+' retained=1 victim={'+beforeBrief+'}');
    }
    return;
  }
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
  if(window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: stale hover removed '+(reason||'')+' victim={'+beforeBrief+'}');
  }
}
function irSetActiveHoverLayer(hoverEl){
  if(!hoverEl)return;
  if(!irIsRenderableHoverRoot(hoverEl)){
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: skip active hover layer unrenderable '+irHoverBrief(hoverEl));
    }
    return;
  }
  irRememberVisibleHoverRect(hoverEl,'set-active');
  var prev=window.__irActiveHoverEl;
  if(window.__irActiveHoverEl!==hoverEl)irStopActiveHoverHandleObserver();
  window.__irActiveHoverEl=hoverEl;
  try{hoverEl.__irActivatedAt=Date.now()}catch(_){}
  if(prev!==hoverEl&&window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: active hover switch prev={'+irHoverBrief(prev)+'} next={'+irHoverBrief(hoverEl)+'}');
  }
  irEnsureHoverPointer(hoverEl);
  irRemoveInactiveHoverArtifacts(hoverEl,'active-switch');
  irWatchHoverNativeHandles(hoverEl);
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
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

var IR_HOVER_LINK_SKIP={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'self':1,'cls':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'throws':1,'since':1,'see':1,'deprecated':1,'alias':1,'overload':1,'module':1,'variable':1,'None':1,'True':1,'False':1,'Cannot':1,'Could':1,'Would':1,'Should':1,'This':1,'That':1,'These':1,'Those':1,'Here':1,'There':1,'Warning':1,'Warnings':1,'See':1,'Also':1,'More':1,'Given':1,'Available':1,'Required':1,'Reference':1,'Examples':1};
var IR_HOVER_LINK_MAX_TYPES=240;
var IR_HOVER_LINK_MAX_LOWER_DECLS=100;
var IR_HOVER_LINK_MAX_CONSTANTS=80;
var IR_HOVER_LINK_MAX_BROAD_IDENTIFIERS=160;
var IR_HOVER_EAGER_WRAP_MAX_TEXT=24000;
var IR_HOVER_DEFERRED_CANDIDATE_MAX_TEXT=50000;
var IR_HOVER_DEFERRED_CANDIDATE_MAX_LINES=900;
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
function irTextBeforeNodeOffset(block,node,offset,limit){
  var out='';
  try{
    var walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    var n;
    while(n=walker.nextNode()){
      if(n===node){
        out+=String(n.nodeValue||'').slice(0,Math.max(0,offset||0));
        break;
      }
      out+=String(n.nodeValue||'');
      if(out.length>limit)out=out.slice(out.length-limit);
    }
  }catch(_){}
  return out.length>limit?out.slice(out.length-limit):out;
}
function irPointAllowsDecorator(node,info,block){
  if(!node||!info||!block||!irLowerCallableName(info.word))return false;
  var text=String(node.nodeValue||'');
  var localBefore=text.slice(Math.max(0,info.start-24),info.start);
  if(/@\\s*$/.test(localBefore))return true;
  var before=irTextBeforeNodeOffset(block,node,info.start,80);
  return /@\\s*$/.test(before);
}
function irSetPointActiveLink(link){
  try{
    var prev=window.__irPointActiveLink;
    if(prev&&prev!==link&&prev.classList)prev.classList.remove('ir-point-active');
    window.__irPointActiveLink=link||null;
    if(link&&link.classList)link.classList.add('ir-point-active');
  }catch(_){}
}
function irSetHoverLinkCandidates(block,types){
  try{
    var m={};
    for(var i=0;types&&i<types.length;i++){
      if(types[i])m[types[i]]=1;
    }
    block.__irHoverLinkCandidates=m;
  }catch(_){}
}
function irBlockCandidateAllowsWord(block,word){
  try{
    var m=block&&block.__irHoverLinkCandidates;
    return !!(m&&m[word]);
  }catch(_){return false}
}
function irShouldLogPointWrapReject(e){
  try{return !!(e&&(e.type==='pointerdown'||e.type==='mousedown'||e.type==='click'))}catch(_){return false}
}
function irLogPointWrapReject(e,reason,extra){
  try{
    if(!irShouldLogPointWrapReject(e)||window.__irPointWrapRejectLogCount>=40)return;
    window.__irPointWrapRejectLogCount++;
    var hover=irClosestHover(e&&e.target);
    irLog('renderer: point-wrap reject reason='+reason+' event='+(e&&e.type||'')+' target='+irElementBrief(irEventElement(e&&e.target))+' hoverRect='+irRectBrief(hover)+(extra?' '+extra:'')+irPointWordSummary(e,hover));
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
  try{
    var prev=window.__irPointActiveLink;
    if(prev&&prev!==span&&prev.classList)prev.classList.remove('ir-point-active');
    window.__irPointActiveLink=span;
    span.classList.add('ir-point-active');
  }catch(_){}
  return span;
}
function irWrapWordAtPoint(e){
  var hover=irClosestHover(e&&e.target);
  if(!hover){irSetPointActiveLink(null);irLogPointWrapReject(e,'no-hover','');return null}
  var directLink=irClosestTypeLink(e&&e.target);
  if(directLink&&hover.contains(directLink)){
    irSetPointActiveLink(directLink);
    return directLink;
  }
  var nearDirect=irUseNearbyTypeLink(e,hover,'pre-range');
  if(nearDirect)return nearDirect;
  var range=irPointRange(e);
  var node=range&&range.startContainer;
  if(!node||node.nodeType!==3||!node.parentNode){
    var nearNoText=irUseNearbyTypeLink(e,hover,'no-text-node');
    if(nearNoText)return nearNoText;
    irSetPointActiveLink(null);irLogPointWrapReject(e,'no-text-node','nodeType='+(node&&node.nodeType));return null;
  }
  var parentEl=node.parentNode.nodeType===1?node.parentNode:node.parentNode.parentElement;
  var existingLink=parentEl&&parentEl.closest?parentEl.closest('.ir-type-link'):null;
  if(existingLink&&hover.contains(existingLink)){
    irSetPointActiveLink(existingLink);
    return existingLink;
  }
  var block=parentEl&&parentEl.closest?parentEl.closest('.rendered-markdown'):null;
  if(!block||!hover.contains(block)||irTextNodeInAnchor(node,block)){
    var nearInvalid=irUseNearbyTypeLink(e,hover,'invalid-block');
    if(nearInvalid)return nearInvalid;
    irSetPointActiveLink(null);irLogPointWrapReject(e,'invalid-block','block='+(!!block)+' inHover='+(block?hover.contains(block):false)+' inAnchor='+(block?irTextNodeInAnchor(node,block):false));return null;
  }
  var info=irWordAtOffset(node.nodeValue||'',range.startOffset||0);
  if(!info){
    var nearNoWord=irUseNearbyTypeLink(e,hover,'no-word');
    if(nearNoWord)return nearNoWord;
    irSetPointActiveLink(null);irLogPointWrapReject(e,'filtered-word','candidate=');return null;
  }
  if(IR_HOVER_LINK_SKIP[info.word]||info.word.length<=2){irSetPointActiveLink(null);irLogPointWrapReject(e,'filtered-word','candidate='+(info&&info.word||''));return null}
  var candidateKnown=irBlockCandidateAllowsWord(block,info.word);
  var hasCandidateSet=!!(block&&block.__irHoverLinkCandidates);
  var lowerCallable=irPointAllowsLowerCallable(node,info);
  var decoratorContext=irPointAllowsDecorator(node,info,block);
  if(hasCandidateSet){
    if(!candidateKnown&&!lowerCallable&&!decoratorContext&&!irTypeShapedName(info.word)&&!irConstantHoverLinkName(info.word)){irSetPointActiveLink(null);irLogPointWrapReject(e,'candidate-rejected','candidate='+info.word+' hasCandidates='+hasCandidateSet+' known='+candidateKnown+' lower='+lowerCallable+' decorator='+decoratorContext);return null}
  }else if(!irTypeShapedName(info.word)&&!irConstantHoverLinkName(info.word)&&!lowerCallable&&!decoratorContext){
    irLogPointWrapReject(e,'shape-rejected','candidate='+info.word+' lower='+lowerCallable+' decorator='+decoratorContext);
    irSetPointActiveLink(null);return null;
  }
  var span=irWrapTextNodeWord(node,info);
  if(span){
    irSetPointActiveLink(span);
    irMarkHoverManaged(hover,true);
    if(window.__irPointWrapLogCount<20){
      window.__irPointWrapLogCount++;
      irLog('renderer: point-wrap "'+info.word+'" event='+(e&&e.type||'')+' hasCandidates='+hasCandidateSet+' known='+candidateKnown+' lower='+lowerCallable+' decorator='+decoratorContext+' blockText='+(block?String(block.textContent||'').length:0)+' hoverRect='+irRectBrief(hover));
    }
  }else{
    irLogPointWrapReject(e,'wrap-failed','candidate='+info.word);
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
function irDecoratorNamesInLine(line){
  var out=[];
  var text=String(line||'');
  if(!/^\\s*@/.test(text))return out;
  var mergedFirst=null;
  try{
    var firstToken=/^\\s*@([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text);
    var merged=/^\\s*@([A-Za-z_$][A-Za-z0-9_$]*?)(?=(?:class|def)\\s+[A-Za-z_$])/.exec(text);
    if(merged&&merged[1]){
      out.push(merged[1]);
      mergedFirst=firstToken&&firstToken[1]&&firstToken[1]!==merged[1]?firstToken[1]:null;
    }
  }catch(_){}
  var expr=text.replace(/(['"])(?:\\\\.|(?!\\1).)*\\1/g,function(m){return new Array(m.length+1).join(' ')});
  var re=/\\b[A-Za-z_$][A-Za-z0-9_$]*\\b/g;
  var seen={};
  for(var oi=0;oi<out.length;oi++)seen[out[oi]]=1;
  var m;
  while((m=re.exec(expr))!==null){
    if(mergedFirst&&m[0]===mergedFirst)continue;
    if(!m[0]||seen[m[0]])continue;
    seen[m[0]]=1;
    out.push(m[0]);
  }
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
function irLineLooksLikeCode(line){
  var trimmed=String(line||'').trim();
  if(!trimmed)return false;
  if(trimmed.indexOf('#')===0||trimmed.indexOf('//')===0)return false;
  return /[@.=():\\[\\],]/.test(trimmed)
    || /^(?:class|def|async\\s+def|return|from|import|with|for|if|elif|while)\\b/.test(trimmed);
}
function irLineWithoutComments(line){
  return String(line||'')
    .replace(/#.*/,'')
    .replace(/\\/\\/.*$/,'');
}
function irCollectBroadIdentifierCandidates(text,skip,types,seen,maxChars,maxLines){
  var src=String(text||'');
  var lines=src.split(/\\n/);
  var used=0;
  var broad=0;
  var re=/\\b[A-Za-z_$][A-Za-z0-9_$]*\\b/g;
  var inTriple=false;
  for(var li=0;li<lines.length&&li<maxLines&&used<maxChars&&types.length<IR_HOVER_LINK_MAX_TYPES;li++){
    var raw=lines[li]||'';
    used+=raw.length+1;
    var tripleCount=(raw.match(/'''|"""/g)||[]).length;
    if(inTriple){
      if(tripleCount%2===1)inTriple=false;
      continue;
    }
    if(/^[ \\t]*(?:'''|""")/.test(raw.trim())){
      if(tripleCount%2===1)inTriple=true;
      continue;
    }
    var line=irLineWithoutComments(raw);
    if(!irLineLooksLikeCode(raw)&&!line.trim())continue;
    re.lastIndex=0;
    var m;
    while((m=re.exec(line))!==null){
      var w=m[0];
      if(!w||skip[w]||seen[w]||w.length<=2)continue;
      irAddHoverLinkName(types,seen,skip,w,true);
      broad++;
      if(types.length>=IR_HOVER_LINK_MAX_TYPES||broad>=IR_HOVER_LINK_MAX_BROAD_IDENTIFIERS)return;
    }
  }
}
function irCollectHoverLinkNames(text,skip,deferBroadScan){
  var src=String(text||'');
  var scanSrc=src;
  if(deferBroadScan&&src.length>IR_HOVER_DEFERRED_CANDIDATE_MAX_TEXT){
    scanSrc=src.slice(0,IR_HOVER_DEFERRED_CANDIDATE_MAX_TEXT);
  }
  var types=[],seen={};
  var decoratorDecls=[];
  var lowerDecls=[];
  var lines=scanSrc.split(/\\n/);
  for(var li=0;li<lines.length;li++){
    var decorators=irDecoratorNamesInLine(lines[li]);
    for(var deco=0;deco<decorators.length;deco++){
      decoratorDecls.push(decorators[deco]);
    }
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
  for(var dd=0;dd<decoratorDecls.length;dd++){
    irAddHoverLinkName(types,seen,skip,decoratorDecls[dd],true);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)return types;
  }
  for(var ld=0;ld<lowerDecls.length&&ld<IR_HOVER_LINK_MAX_LOWER_DECLS;ld++){
    irAddHoverLinkName(types,seen,skip,lowerDecls[ld],true);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)return types;
  }
  // Large definition previews can be tens of KB. Earlier patches returned
  // after declaration scanning, so type annotations like "owner: User" were
  // never wrapped in hover links. Keep the scan bounded but always inspect
  // the visible/front-loaded code for type-shaped names.
  irCollectTypeShapedCandidates(src,skip,types,seen,
    deferBroadScan?IR_HOVER_DEFERRED_CANDIDATE_MAX_TEXT:src.length+1,
    deferBroadScan?IR_HOVER_DEFERRED_CANDIDATE_MAX_LINES:lines.length);
  // Mirror editor Cmd+Click more closely: once the high-confidence names are
  // added, include ordinary identifiers from code-looking lines too. The
  // extension host still resolves clicks through VS Code's definition provider,
  // so non-navigable noise becomes a harmless no-location click while
  // property/method access like self.owner.get_display_name() is no longer
  // invisible to drill-down.
  if(!deferBroadScan){
    irCollectBroadIdentifierCandidates(src,skip,types,seen,src.length+1,lines.length);
  }
  for(var d=IR_HOVER_LINK_MAX_LOWER_DECLS;d<lowerDecls.length;d++){
    irAddHoverLinkName(types,seen,skip,lowerDecls[d],true);
    if(types.length>=IR_HOVER_LINK_MAX_TYPES)break;
  }
  return types;
}
function irEscapeHoverLinkRegex(w){
  return String(w||'').replace(/[\\^$.*+?()[\\]{}|]/g,'\\\\$&');
}
function irBuildHoverLinkRegex(types){
  try{
    if(!types||!types.length)return null;
    var sorted=types.slice().sort(function(a,b){return String(b||'').length-String(a||'').length});
    var parts=[];
    for(var i=0;i<sorted.length;i++){
      if(sorted[i])parts.push(irEscapeHoverLinkRegex(sorted[i]));
    }
    if(!parts.length)return null;
    return new RegExp(parts.join('|'),'g');
  }catch(_){return null}
}
function irHoverLinkCandidateText(block,fallbackText){
  try{
    var codeBlocks=block&&block.querySelectorAll?block.querySelectorAll('.monaco-tokenized-source, pre'):[];
    var parts=[];
    for(var i=0;i<codeBlocks.length;i++){
      var text=String(codeBlocks[i].textContent||'').trim();
      if(text)parts.push(text);
    }
    if(parts.length)return parts.join('\\n');
  }catch(_){}
  return String(fallbackText||'');
}
function irCompactHoverScanSample(text){
  return String(text||'').replace(/\\s+/g,' ').slice(0,220);
}
function irInterestingHoverScanText(text){
  var s=String(text||'');
  return s.indexOf('BaseModel')>=0
    || s.indexOf('TimestampedModel')>=0
    || s.indexOf('DIRECTOR_DECISION_DUMMY_FILE_LINK')>=0
    || s.indexOf('@property')>=0
    || s.indexOf('property')>=0;
}
function irHoverScanSnippet(text){
  var s=String(text||'');
  var needles=['BaseModel','TimestampedModel','DIRECTOR_DECISION_DUMMY_FILE_LINK','@property','property'];
  var idx=-1;
  for(var i=0;i<needles.length;i++){
    idx=s.indexOf(needles[i]);
    if(idx>=0)break;
  }
  if(idx<0)return irCompactHoverScanSample(s);
  return s.slice(Math.max(0,idx-100),Math.min(s.length,idx+180)).replace(/\\s+/g,' ');
}
function irLogHoverScanDecision(reason,block,hoverHost,text,candidateText,types,extra){
  try{
    var existingLinks=block&&block.querySelectorAll?block.querySelectorAll('.ir-type-link').length:0;
    var interesting=irInterestingHoverScanText(text)||irInterestingHoverScanText(candidateText);
    if(window.__irScanDecisionLogCount>=140&&!interesting)return;
    if(!interesting&&!(types&&types.length)&&!existingLinks&&(reason==='skip-short'||reason==='skip-same'))return;
    if(window.__irScanDecisionLogCount<260)window.__irScanDecisionLogCount++;
    var tokenized=block&&block.querySelectorAll?block.querySelectorAll('.monaco-tokenized-source').length:0;
    var pres=block&&block.querySelectorAll?block.querySelectorAll('pre').length:0;
    var mtk=block&&block.querySelectorAll?block.querySelectorAll('[class*="mtk"]').length:0;
    var hasBase=(types||[]).indexOf('BaseModel')>=0;
    var hasTimestamp=(types||[]).indexOf('TimestampedModel')>=0;
    irLog('renderer: scan-decision '+reason
      +' text='+String(text||'').length
      +' candidate='+String(candidateText||'').length
      +' types='+(types&&types.length||0)
      +' links='+existingLinks
      +' tokenized='+tokenized
      +' pre='+pres
      +' mtk='+mtk
      +' hasBase='+hasBase
      +' hasTimestamp='+hasTimestamp
      +' active='+(window.__irActiveHoverEl===hoverHost)
      +' host={'+irHoverBrief(hoverHost)+'}'
      +(extra?' '+extra:'')
      +' typesSample='+(types&&types.length?types.slice(0,16).join(','):'')
      +' textSample='+JSON.stringify(irHoverScanSnippet(text))
      +' candidateSample='+JSON.stringify(irHoverScanSnippet(candidateText)));
  }catch(eScanDecision){
    try{irLog('renderer: scan-decision-log-error '+String(eScanDecision&&eScanDecision.message||eScanDecision))}catch(_){}
  }
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
  if(fallbackTextLength&&fallbackTextLength>IR_HOVER_SIZE_TIERS[1].maxText){
    var largeTier=IR_HOVER_SIZE_TIERS[2];
    largeTier.measure={textLength:fallbackTextLength,lineCount:Infinity,longest:Infinity};
    return largeTier;
  }
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
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
  irKeepHoverInViewport(hoverEl);
  try{
    if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame);
    hoverEl.__irFitFrame=requestAnimationFrame(function(){
      hoverEl.__irFitFrame=0;
      irScheduleHoverNativeHandleCleanup(hoverEl,true);
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
  hoverEl.style.overflow='hidden';
  hoverEl.style.boxSizing='border-box';
  var sc=irPrimaryHoverScroller(hoverEl);
  if(sc){
    sc.style.width='100%';
    sc.style.height=height+'px';
    sc.style.maxWidth=width+'px';
    sc.style.maxHeight=height+'px';
    sc.style.overflowY='auto';
    sc.style.overflowX='auto';
    sc.style.scrollbarWidth='none';
    sc.style.scrollbarColor='transparent transparent';
    sc.style.overscrollBehavior='contain';
    sc.style.position='relative';
    sc.style.boxSizing='border-box';
    if(resetScroll)sc.scrollTop=0;
  }
  var hContent=hoverEl.querySelector('.monaco-hover-content');
  if(hContent){
    hContent.style.width='100%';
    hContent.style.maxWidth='100%';
    hContent.style.boxSizing='border-box';
    hContent.style.transform='none';
    hContent.style.top='0';
    hContent.style.left='0';
    hContent.style.position='static';
    hContent.style.overflow='visible';
  }
  var wrappers=hoverEl.querySelectorAll('.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown');
  for(var wi=0;wi<wrappers.length;wi++){
    wrappers[wi].style.width='100%';
    wrappers[wi].style.maxWidth='100%';
    wrappers[wi].style.boxSizing='border-box';
  }
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
  irFlattenNestedScrollLayers(hoverEl);
  if(resetScroll)hoverEl.scrollTop=0;
  if(hoverEl.__irSizeTierName!==tier.name){
    hoverEl.__irSizeTierName=tier.name;
  }
  irScheduleHoverViewportFit(hoverEl);
  return tier;
}

function irTypeLinkClick(e){
  var directLink=irClosestTypeLink(e.target);
  var wrappedLink=null;
  if(!directLink)wrappedLink=irWrapWordAtPoint(e);
  var link=directLink||wrappedLink;
  irLogPointerActionTrace(e,'click-capture',link,directLink?'direct':(wrappedLink?'wrapped':'none'));
  if(!link){
    irLogHoverPointerMiss(e,'click');
    return;
  }
  if(window.__irPointerActionLogCount<140){
    window.__irPointerActionLogCount++;
    var pointEl=(typeof document.elementFromPoint==='function'&&typeof e.clientX==='number')?document.elementFromPoint(e.clientX,e.clientY):null;
    irLog('renderer: link click "'+(link.getAttribute&&link.getAttribute('data-type')||'')+'" target='+irElementBrief(irEventElement(e&&e.target))+' point='+irElementBrief(pointEl)+' link='+irElementBrief(link)+' hoverRect='+irRectBrief(irClosestHover(link)));
  }
  irClearPendingTypeLinkPointerDown(link,'click');
  irRunTypeLinkAction(link,e,'click');
}
track(window,'click',irTypeLinkClick,true);
track(document,'click',irTypeLinkClick,true);

function irClosestBackControl(target){
  var el=irEventElement(target);
  if(!el||!el.closest)return null;
  return el.closest('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"]');
}
function irBackControlPointerDown(e){
  var back=irClosestBackControl(e.target);
  if(!back)return;
  irMarkHoverManaged(irClosestHover(back),true);
  e.preventDefault();
  e.stopImmediatePropagation();
}
function irBackControlClick(e){
  var back=irClosestBackControl(e.target);
  if(!back)return;
  irMarkHoverManaged(irClosestHover(back),true);
  e.preventDefault();
  e.stopImmediatePropagation();
  if(typeof window.irGoToType==='function')window.irGoToType('BACK');
  else irScheduleOriginalHoverRestoreFallback();
}
track(window,'pointerdown',irBackControlPointerDown,true);
track(window,'mousedown',irBackControlPointerDown,true);
track(document,'pointerdown',irBackControlPointerDown,true);
track(document,'mousedown',irBackControlPointerDown,true);
track(window,'click',irBackControlClick,true);
track(document,'click',irBackControlClick,true);

function irMakeHoverScrollable(hoverEl, resetScroll, fallbackTextLength){
  if(!hoverEl)return;
  try{
    var scrollSignature=String(Math.max(0,fallbackTextLength||0));
    if(!resetScroll&&hoverEl.classList&&hoverEl.classList.contains('ir-scrollable')&&hoverEl.__irScrollableSignature===scrollSignature){
      irEnsureHoverPointer(hoverEl);
      irSetActiveHoverLayer(hoverEl);
      return;
    }
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
    hoverEl.__irScrollableSignature=scrollSignature;
  }catch(_){}
}
window.__irTestHooks={
  primaryHoverScroller:irPrimaryHoverScroller,
  makeHoverScrollable:irMakeHoverScrollable,
  setActiveHoverLayer:irSetActiveHoverLayer,
  activateHoverRoot:irActivateHoverRoot,
  refreshEmptyHoverRootState:irRefreshEmptyHoverRootState,
  applyHoverSizeTier:irApplyHoverSizeTier,
  disposeStaleHover:irDisposeStaleHover,
  removeInactiveHoverArtifacts:irRemoveInactiveHoverArtifacts,
  pruneDetachedHoverState:irPruneDetachedHoverState,
  scanRenderedMarkdown:irScanRenderedMarkdown
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
// span elements with VS Code's native .mtkN theme classes only. It
// never paints token colors itself; when grammar tokenization is
// unavailable it reuses the active theme's loaded mtk palette.
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
var IR_MTK_THEME_PALETTE = null;
function irCollectThemeMtkPalette(){
  if(IR_MTK_THEME_PALETTE)return IR_MTK_THEME_PALETTE;
  var out=[];
  var seenVisual={};
  var host=null;
  try{
    host=document.createElement('div');
    host.style.cssText='position:fixed;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(host);
    for(var n=1;n<=255;n++){
      var sp=document.createElement('span');
      sp.className='mtk'+n;
      sp.textContent='x';
      host.appendChild(sp);
    }
    for(var i=0;i<host.children.length;i++){
      var el=host.children[i];
      var cs=getComputedStyle(el);
      var visual=(cs.color||'')+'|'+(cs.fontStyle||'')+'|'+(cs.fontWeight||'')+'|'+(cs.textDecorationLine||cs.textDecoration||'');
      if(!visual||seenVisual[visual])continue;
      seenVisual[visual]=1;
      out.push(el.className);
      if(out.length>=32)break;
    }
  }catch(_){}
  try{if(host&&host.parentNode)host.parentNode.removeChild(host)}catch(_){}
  IR_MTK_THEME_PALETTE=out;
  irLog('mtk-palette: '+(out.length?out.slice(0,16).join(','):'none'));
  return out;
}
function irFillMtkMapFromThemePalette(map){
  var palette=irCollectThemeMtkPalette();
  if(!palette||palette.length<2)return map;
  var def=map.def||palette[0]||'mtk1';
  var usable=[];
  for(var i=0;i<palette.length;i++){
    if(palette[i]&&palette[i]!==def)usable.push(palette[i]);
  }
  if(!usable.length)return map;
  var kinds=['kw','str','num','cls','fn','cm','prim','op','pn','bk','prop','var','deco'];
  for(var ki=0;ki<kinds.length;ki++){
    var kind=kinds[ki];
    if(!map[kind]||map[kind]===map.def){
      map[kind]=usable[ki%usable.length];
    }
  }
  return map;
}
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
  map = irFillMtkMapFromThemePalette(map);
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
    var cls = clsFor(kind);
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
var IR_MTS_STYLE = 'font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace)); font-weight: normal; font-size: var(--vscode-editor-font-size, 12px); font-feature-settings: "liga" 0, "calt" 0; font-variation-settings: normal; line-height: normal; letter-spacing: 0px; white-space: pre;';
var IR_USE_NATIVE_MD_RENDERER = false;
var IR_NATIVE_MTS_STYLE_CACHE = '';
function irCacheNativeTokenizedSourceStyle(root){
  try{
    var scope=root&&root.querySelectorAll?root:document;
    var nativeBlocks=scope.querySelectorAll('.monaco-hover .monaco-tokenized-source, .monaco-editor-hover .monaco-tokenized-source, .monaco-tokenized-source');
    for(var ni=0;ni<nativeBlocks.length;ni++){
      var block=nativeBlocks[ni];
      if(!block||!block.getAttribute)continue;
      if(block.closest&&block.closest('.ir-applied'))continue;
      var styleText=block.getAttribute('style')||'';
      if(styleText
        && styleText.indexOf('--vscode-editor-font-family')>=0
        && styleText.indexOf('white-space')>=0){
        IR_NATIVE_MTS_STYLE_CACHE=styleText;
        return styleText;
      }
    }
  }catch(_){}
  return '';
}
function irNativeTokenizedSourceStyle(){
  try{
    var live=irCacheNativeTokenizedSourceStyle(document);
    if(live)return live;
  }catch(_){}
  if(IR_NATIVE_MTS_STYLE_CACHE)return IR_NATIVE_MTS_STYLE_CACHE;
  return IR_MTS_STYLE;
}
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
    box.setAttribute('style', irNativeTokenizedSourceStyle());
    if(lang) box.setAttribute('data-lang',lang);
    if(frag && !irFragmentTokenizationUseful(frag)){
      irLog('renderer: token fragment degenerate; using fallback tokenizer');
      frag=null;
    }
    if(frag){
      box.setAttribute('data-ir-tokenization-source','captured');
      box.appendChild(frag);
    } else {
      box.setAttribute('data-ir-tokenization-source','fallback');
      try {
        irTokenizeCode(code,lang,box);
      } catch(eFT) {
        irLog('renderer: fallback tokenizer err: '+(eFT&&eFT.message));
      }
      if(!box.textContent){
        // No tokenizer — at least match the native structure so font /
        // line-height / letter-spacing are right. mtk1 = default fg.
        var sp=document.createElement('span');
        sp.className='mtk1';
        sp.textContent=code;
        box.appendChild(sp);
      }
    }
    if(!frag||!irFragmentTokenizationUseful(box)){
      irInstallAsyncThemeTokenization(box,code,lang);
    }
    parent.appendChild(box);
    i=endFence+3; if(md.charAt(i)==='\\n') i++;
  }
}

function irTokenizedClassCount(root,pattern){
  var set={};
  try{
    var spans=root?root.querySelectorAll('[class]'):[];
    for(var i=0;i<spans.length;i++){
      var cls=String(spans[i].className||'');
      var matches=cls.match(pattern)||[];
      for(var j=0;j<matches.length;j++)set[matches[j]]=1;
    }
  }catch(_){}
  return Object.keys(set).length;
}
function irFragmentTokenizationUseful(fragment){
  if(!fragment)return false;
  var host=document.createElement('div');
  try{host.appendChild(fragment.cloneNode(true));}
  catch(_){return false}
  var mtkSpans=host.querySelectorAll('[class*="mtk"]');
  var mtkClasses=irTokenizedClassCount(host,/mtk\\d+/g);
  return mtkSpans.length>1&&mtkClasses>1;
}
function irDecodeHtmlText(s){
  return String(s||'')
    .replace(/&nbsp;/g,'\\u00a0')
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&amp;/g,'&');
}
function irColorizedHtmlToFragment(html){
  var src=String(html||'');
  if(src.indexOf('mtk')<0)return null;
  var frag=document.createDocumentFragment();
  var spanCount=0;
  var re=/<span\\s+class="([^"]*\\bmtk\\d+[^"]*)"[^>]*>([\\s\\S]*?)<\\/span>|<br\\s*\\/?\\s*>|([^<]+)/gi;
  var m;
  while((m=re.exec(src))!==null){
    if(m[1]!==undefined){
      var cls=String(m[1]||'').replace(/[^A-Za-z0-9_\\-\\s]/g,'').trim();
      if(!/\\bmtk\\d+\\b/.test(cls))continue;
      var sp=document.createElement('span');
      sp.className=cls;
      sp.textContent=irDecodeHtmlText(m[2]||'');
      frag.appendChild(sp);
      spanCount++;
    }else if(/^<br/i.test(m[0]||'')){
      frag.appendChild(document.createTextNode('\\n'));
    }else if(m[3]){
      frag.appendChild(document.createTextNode(irDecodeHtmlText(m[3])));
    }
  }
  return spanCount>1&&irFragmentTokenizationUseful(frag)?frag:null;
}
function irInstallAsyncThemeTokenization(box,code,lang){
  try{
    if(!box||typeof window.__irTokenizeCodeAsync!=='function'||!lang)return;
    var p=window.__irTokenizeCodeAsync(code,lang);
    if(!p||typeof p.then!=='function')return;
    p.then(function(html){
      try{
        if(!box||!document.body.contains(box))return;
        var frag=irColorizedHtmlToFragment(html);
        if(!frag)return;
        while(box.firstChild)box.removeChild(box.firstChild);
        box.setAttribute('data-ir-tokenization-source','async');
        box.appendChild(frag);
        irLog('renderer: async theme tokenization applied lang='+lang);
        try{irScheduleScan()}catch(_){}
      }catch(eA){irLog('renderer: async theme tokenization err: '+(eA&&eA.message));}
    },function(eP){irLog('renderer: async colorize rejected: '+(eP&&eP.message?eP.message:String(eP)));});
  }catch(eI){irLog('renderer: async colorize install err: '+(eI&&eI.message));}
}
function irNativeTokenizationUseful(root,requireCodeBlock){
  var blocks=root?root.querySelectorAll('.monaco-tokenized-source'):[];
  if(!blocks||!blocks.length)return !requireCodeBlock;
  for(var i=0;i<blocks.length;i++){
    var text=String(blocks[i].textContent||'').trim();
    if(!text)continue;
    var mtkSpans=blocks[i].querySelectorAll('[class*="mtk"]');
    var mtkClasses=irTokenizedClassCount(blocks[i],/mtk\\d+/g);
    if(mtkSpans.length>1&&mtkClasses>1)return true;
  }
  return false;
}
function irClearHoverForPreview(hoverEl,target){
  if(!hoverEl||!target)return;
  try{
    var normalized=irNormalizePreviewTarget(target)||target;
    var targetRow=(normalized.closest&&normalized.closest('.hover-row,.markdown-hover'))||normalized;
    var oldButtons=hoverEl.querySelectorAll('.ir-back-btn');
    for(var bi=0;bi<oldButtons.length;bi++){
      if(oldButtons[bi].parentNode)oldButtons[bi].parentNode.removeChild(oldButtons[bi]);
    }
    var rows=hoverEl.querySelectorAll('.hover-row,.markdown-hover');
    for(var ri=0;ri<rows.length;ri++){
      var row=rows[ri];
      if(row===targetRow||row.contains(normalized)||normalized.contains(row)){
        var siblingBlocks=row.querySelectorAll('.rendered-markdown');
        for(var si=0;si<siblingBlocks.length;si++){
          var block=siblingBlocks[si];
          if(block===normalized||block.contains(normalized)||normalized.contains(block))continue;
          if(block.parentNode)block.parentNode.removeChild(block);
        }
        continue;
      }
      if(row.parentNode)row.parentNode.removeChild(row);
    }
    var blocks=hoverEl.querySelectorAll('.rendered-markdown');
    for(var mi=0;mi<blocks.length;mi++){
      var mdBlock=blocks[mi];
      if(mdBlock===normalized||mdBlock.contains(normalized)||normalized.contains(mdBlock))continue;
      if(mdBlock.parentNode)mdBlock.parentNode.removeChild(mdBlock);
    }
  }catch(eCH){irLog('renderer: clear hover preview err: '+(eCH&&eCH.message));}
}
function irEnsurePreviewBackButton(hoverEl,target){
  if(!hoverEl||!target)return;
  try{
    var oldButtons=hoverEl.querySelectorAll('.ir-back-btn');
    for(var bi=0;bi<oldButtons.length;bi++){
      if(oldButtons[bi].parentNode)oldButtons[bi].parentNode.removeChild(oldButtons[bi]);
    }
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='ir-back-btn';
    btn.setAttribute('aria-label','Back');
    btn.textContent='\\u2190 Back';
    btn.onclick=function(e){
      try{e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}catch(_){}
      if(typeof window.irGoToType==='function'){
        window.irGoToType('BACK');
        return false;
      }
      var hist=window.__irHistory||[];
      if(!hist.length)return false;
      var prev=hist[hist.length-1];
      if(prev&&typeof window.irApplyPreview==='function'){
        window.irApplyPreview(prev.typeName,prev.md,true,prev.scroll||null);
      }
      return false;
    };
    var host=(target.parentNode&&hoverEl.contains(target.parentNode))?target.parentNode:target;
    host.insertBefore(btn,host===target?(target.firstChild||null):target);
  }catch(eBB){irLog('renderer: back button err: '+(eBB&&eBB.message));}
}
function irEnsurePreviewBackButtonForScannedHover(hoverEl,target){
  try{
    if(!hoverEl||!target)return;
    if(hoverEl.querySelector&&hoverEl.querySelector('.ir-back-btn'))return;
    var hasPreviewHistory=!!(window.__irHistoryCurrent||((window.__irHistory||[]).length));
    var nativePreviewBackActive=false;
    try{nativePreviewBackActive=!!(window.__irNativePreviewBackUntil&&Date.now()<window.__irNativePreviewBackUntil);}catch(_){}
    if(!hasPreviewHistory&&!nativePreviewBackActive)return;
    irEnsurePreviewBackButton(hoverEl,target);
    if((window.__irPreviewApplyLogCount||0)<80){
      window.__irPreviewApplyLogCount=(window.__irPreviewApplyLogCount||0)+1;
      irLog('renderer: back button repaired during scan hover={'+irHoverBrief(hoverEl)+'}');
    }
  }catch(_){}
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

window.irApplyPreview=function(typeName,md,fromBack,restoreScroll){
  irLog('renderer: irApplyPreview "'+typeName+'" md='+md.length+'B'+(fromBack?' [back]':''));
  irPruneDetachedHoverState();
  var target=irNormalizePreviewTarget(window.__irLastPreviewTarget);
  var src='stored';
  if(!target||!document.body.contains(target)){
    src='fallback';
    target=null;
    var active=window.__irActiveHoverEl;
    if(active&&document.body.contains(active)){
      target=irStoredPreviewTarget(active);
      if(!target){
        var activeNodes=active.querySelectorAll('.rendered-markdown.ir-applied, .rendered-markdown');
        for(var ai=activeNodes.length-1;ai>=0;ai--){
          if(activeNodes[ai].offsetParent!==null){target=irNormalizePreviewTarget(activeNodes[ai]);break}
        }
      }
    }
    if(!target){
      var nodes=document.querySelectorAll('.monaco-hover .rendered-markdown.ir-applied, .monaco-editor-hover .rendered-markdown.ir-applied, .monaco-hover .rendered-markdown, .monaco-editor-hover .rendered-markdown');
      for(var i=nodes.length-1;i>=0;i--){
        if(nodes[i].offsetParent!==null){target=irNormalizePreviewTarget(nodes[i]);break}
      }
    }
  }
  if(!target){ irLog('renderer: irApplyPreview no target for "'+typeName+'"'); return false; }
  var hoverElForHistory=target.closest('.monaco-hover, .monaco-editor-hover');
  var restoreScrollState=irNormalizePreviewScrollState(restoreScroll);
  if(window.__irHistoryFor!==hoverElForHistory){
    window.__irHistoryFor=hoverElForHistory;
    window.__irHistory=[];
    window.__irHistoryCurrent=null;
    if(window.__irOriginalHoverSnapshot&&window.__irOriginalHoverSnapshot.hoverEl!==hoverElForHistory){
      window.__irOriginalHoverSnapshot=null;
    }
  }
  if(!window.__irHistory)window.__irHistory=[];
  if(window.__irHistoryCurrent&&hoverElForHistory){
    window.__irHistoryCurrent.scroll=irPreviewScrollSnapshot(hoverElForHistory,target);
  }
  if(fromBack){
    var histBack=window.__irHistory;
    if(histBack.length){
      var matchIndex=-1;
      for(var hb=histBack.length-1;hb>=0;hb--){
        if(histBack[hb]&&histBack[hb].typeName===typeName){matchIndex=hb;break}
      }
      if(matchIndex>=0)histBack.length=matchIndex;
      else histBack.pop();
    }
  }else if(window.__irHistoryCurrent
    && (window.__irHistoryCurrent.typeName!==typeName||window.__irHistoryCurrent.md!==md)){
    window.__irHistory.push(window.__irHistoryCurrent);
    if(window.__irHistory.length>20)window.__irHistory.splice(0,window.__irHistory.length-20);
  }
  if(!fromBack&&hoverElForHistory)irCaptureOriginalHoverSnapshot(hoverElForHistory,target);
  window.__irHistoryCurrent={ typeName:typeName, md:md, scroll:restoreScrollState||null };
  try {
    var decoded=irDecodeContent(md);
    var outerHover=target.closest('.monaco-hover, .monaco-editor-hover');
    if(outerHover)irClearHoverForPreview(outerHover,target);
    while(target.firstChild) target.removeChild(target.firstChild);
    target.classList.add('ir-applied');
    // Prefer VS Code's captured MarkdownRenderer if we found one — it
    // produces native-quality output (TextMate + semantic tokens, plus
    // exact chrome). Falls through to our own DOM builder if not found
    // or rendering fails.
    var nativeOk = false;
    if (IR_USE_NATIVE_MD_RENDERER && window.__irMdRenderer && typeof window.__irMdRenderer.render === 'function') {
      try {
        var nr = window.__irMdRenderer.render({ value: decoded, isTrusted: true, supportThemeIcons: true });
        if (nr && nr.element instanceof HTMLElement) {
          target.appendChild(nr.element);
          nativeOk = true;
          irLog('renderer: native MdRenderer used (children='+nr.element.children.length+')');
          if(!irNativeTokenizationUseful(target,decoded.indexOf('\\\`\\\`\\\`')>=0)){
            while(target.firstChild) target.removeChild(target.firstChild);
            nativeOk=false;
            irLog('renderer: native MdRenderer degenerate tokenization; using fallback tokenizer');
          }
        }
      } catch(eMR){ irLog('renderer: native MdRenderer threw: '+(eMR&&eMR.message)); }
    }
    if (!nativeOk) irBuildMdDom(decoded,target);
    if(outerHover)irEnsurePreviewBackButton(outerHover,target);
    if(outerHover){
      outerHover.__irPreviewAppliedAt=Date.now();
      irRememberVisibleHoverRect(outerHover,'preview-applied');
    }
    try{irScheduleScan()}catch(_){}
  } catch(eAP){
    irLog('renderer: irApplyPreview build err: '+(eAP&&eAP.message?eAP.message:String(eAP)));
    return false;
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
      irSetPreviewTarget(hoverEl,target);
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
      // Reset scrolltops on forward drill-downs. Back restores the previous
      // page's captured position after layout settles.
      if(!restoreScrollState){
        if(hoverEl.scrollTop) hoverEl.scrollTop=0;
        if(scTop&&scTop.scrollTop) scTop.scrollTop=0;
        if(ourRow.scrollTop) ourRow.scrollTop=0;
        var rowScrolls=ourRow.querySelectorAll('*');
        for(var s=0;s<rowScrolls.length;s++){ if(rowScrolls[s].scrollTop) rowScrolls[s].scrollTop=0; }
      }
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
          sc.style.scrollbarWidth='none';
          sc.style.scrollbarColor='transparent transparent';
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
        irApplyHoverSizeTier(hoverEl,(target.textContent||'').length,!restoreScrollState);
        irRememberVisibleHoverRect(hoverEl,'preview-layout');
        if(restoreScrollState)irRestorePreviewScroll(hoverEl,target,restoreScrollState);
        // Hide VS Code\\'s overlay handles; their slider geometry was
        // computed from the pre-expanded hover.
        irScheduleHoverNativeHandleCleanup(hoverEl,true);
        // Force layout flush.
        try { var _=hoverEl.scrollHeight; var __=hoverEl.offsetHeight; } catch(_) {}
      } catch(_) {}
      try { window.dispatchEvent(new Event('resize')); } catch(_) {}
    } else if(restoreScrollState){
      irRestorePreviewScroll(target,target,restoreScrollState);
    } else if(target.scrollTop){ target.scrollTop=0; }
  } catch(_) {}
  window.__irLastPreviewTarget=null;
  irLog('renderer: applied "'+typeName+'" via '+src);
  return true;
};

window.irShowHoverFallback=function(identifier,md,opts){
  try{
    identifier=String(identifier||'').trim();
    md=String(md||'');
    opts=opts||{};
    if(!identifier||md.trim().length<20){
      return {ok:false,reason:'empty-input',patchVersion:Number(window.__irPatchVersion)||0};
    }
    var forceNativeReplace=/^preview-/.test(String(opts.source||""));
    var pointer=window.__irLastPointer||null;
    var pointerFresh=pointer&&pointer.at&&Date.now()-pointer.at<5000;
    var x=pointerFresh&&typeof pointer.x==='number'?pointer.x:Math.floor((window.innerWidth||1000)/2);
    var y=pointerFresh&&typeof pointer.y==='number'?pointer.y:Math.floor((window.innerHeight||700)/3);
    var pointEl=(typeof document.elementFromPoint==='function')?document.elementFromPoint(x,y):null;
    var pointHover=pointEl&&pointEl.closest?pointEl.closest('.monaco-hover,.monaco-editor-hover'):null;
    var pointToken='';
    try{pointToken=irEventTargetTokenText({target:pointEl,clientX:x,clientY:y,type:'native-refire-probe'});}catch(_){}
    var roots=Array.prototype.slice.call(document.querySelectorAll('.monaco-hover,.monaco-editor-hover'));
    var existing=null;
    for(var i=0;i<roots.length;i++){
      var h=roots[i];
      if(!h||!document.body.contains(h)||irIsStaleHoverRoot(h))continue;
      var visibility=irHoverRootVisibility(h);
      var hText=String(h.textContent||'');
      if(visibility&&visibility.visible&&hText.indexOf(identifier)>=0&&hText.length>40){
        existing=h;
        break;
      }
    }
    if(existing&&!forceNativeReplace){
      irMarkHoverManaged(existing,true);
      irSetActiveHoverLayer(existing);
      try{irScheduleScan()}catch(_){}
      return {
        ok:true,
        created:false,
        reason:'existing-hover',
        textLength:String(existing.textContent||'').length,
        rect:irRectBrief(existing),
        token:pointToken,
        patchVersion:Number(window.__irPatchVersion)||0
      };
    }
    var forcedRemoved=0;
    var released=0;
    var preservedHiddenNative=0;
    var removedHiddenNative=0;
    try{ window.__irNativeHoverRefireUntil=Date.now()+1800; }catch(_){}
    for(var ri=0;ri<roots.length;ri++){
      var rootOld=roots[ri];
      if(!rootOld||!document.body.contains(rootOld))continue;
      try{
        if(rootOld.getAttribute&&rootOld.getAttribute('data-ir-forced-hover')==='1'){
          if(rootOld.parentNode)rootOld.parentNode.removeChild(rootOld);
          forcedRemoved++;
          continue;
        }
      }catch(_){}
      try{
        if(irHoverRootVisibility(rootOld).visible){
          if(irReleaseNativeHoverManagement(rootOld,'native-refire-replace'))released++;
        }else if(irIsNativeHoverRoot(rootOld)){
          var oldHiddenText=String(rootOld.textContent||'');
          var refireGraceActive=false;
          try{refireGraceActive=!!(window.__irNativeHoverRefireUntil&&Date.now()<window.__irNativeHoverRefireUntil)}catch(_){}
          if(oldHiddenText.trim()&&oldHiddenText.indexOf(identifier)<0&&!refireGraceActive){
            if(window.__irActiveHoverEl===rootOld)window.__irActiveHoverEl=null;
            if(rootOld.parentNode)rootOld.parentNode.removeChild(rootOld);
            removedHiddenNative++;
            continue;
          }
          // Hidden native shells can be VS Code's in-flight hover widget
          // between provider resolution and paint. Keep them during native
          // refire so the real hover can finish rendering.
          try{
            if(rootOld.__irReleaseRemoveTimer){
              irClearTimer(rootOld.__irReleaseRemoveTimer);
              rootOld.__irReleaseRemoveTimer=null;
            }
            rootOld.__irReleasedAt=0;
            rootOld.__irReleasedText='';
            rootOld.__irNativeRefirePreservedAt=Date.now();
            if(rootOld.classList)rootOld.classList.remove('ir-native-released-hover','ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive','hidden');
            if(rootOld.removeAttribute){
              rootOld.removeAttribute('data-ir-native-released-hover');
              rootOld.removeAttribute('aria-hidden');
              rootOld.removeAttribute('hidden');
            }
            if(rootOld.style){
              rootOld.style.removeProperty('pointer-events');
              rootOld.style.removeProperty('display');
              rootOld.style.removeProperty('visibility');
              rootOld.style.removeProperty('opacity');
            }
          }catch(_){}
          preservedHiddenNative++;
        }else if(irDisposeStaleHover(rootOld,'native-refire-hidden')){
          released++;
        }
      }catch(_){}
    }
    try{
      if(window.__irActiveHoverEl&&!document.body.contains(window.__irActiveHoverEl))window.__irActiveHoverEl=null;
      window.__irLastPreviewTarget=null;
    }catch(_){}
    function fireNativeHoverRefireEvent(type,Ctor,target){
      try{
        if(!target)return false;
        var ev=new Ctor(type,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,screenX:x,screenY:y,buttons:0,button:0});
        target.dispatchEvent(ev);
        return true;
      }catch(_){return false;}
    }
    try{
      var eventTarget=(typeof document.elementFromPoint==='function'?document.elementFromPoint(x,y):null)||document.body;
      if(eventTarget&&eventTarget.closest&&eventTarget.closest('.monaco-hover,.monaco-editor-hover')){
        eventTarget=document.querySelector('.monaco-editor.focused .view-lines,.monaco-editor .view-lines')||document.body;
      }
      fireNativeHoverRefireEvent('pointerover',window.PointerEvent||window.MouseEvent,eventTarget);
      fireNativeHoverRefireEvent('mouseover',window.MouseEvent,eventTarget);
      fireNativeHoverRefireEvent('pointermove',window.PointerEvent||window.MouseEvent,eventTarget);
      fireNativeHoverRefireEvent('mousemove',window.MouseEvent,eventTarget);
      try{
        var editorEl=eventTarget&&eventTarget.closest?eventTarget.closest('.monaco-editor'):null;
        if(editorEl&&editorEl.focus)editorEl.focus({preventScroll:true});
      }catch(_){}
    }catch(_){}
    if(window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: native hover refire requested identifier="'+identifier+'" source='+(opts.source||'')+' pointer='+(pointerFresh?'fresh':'fallback')+' token="'+pointToken+'" forcedRemoved='+forcedRemoved+' released='+released+' preservedHiddenNative='+preservedHiddenNative+' removedHiddenNative='+removedHiddenNative);
    }
    return {
      ok:true,
      created:false,
      refired:true,
      reason:'native-refire-requested',
      identifier:identifier,
      token:pointToken,
      pointerFresh:!!pointerFresh,
      pointHover:!!pointHover,
      forcedRemoved:forcedRemoved,
      released:released,
      preservedHiddenNative:preservedHiddenNative,
      removedHiddenNative:removedHiddenNative,
      patchVersion:Number(window.__irPatchVersion)||0
    };
  }catch(eFallback){
    return {ok:false,reason:String(eFallback&&eFallback.message||eFallback),patchVersion:Number(window.__irPatchVersion)||0};
  }
};

var irLastContainerCount=0;
var IR_HOVER_DOM_DEDUPE_ENABLED=true;

function irNormalizeHoverDedupeText(text){
  return String(text||'')
    .replace(/<!--ir-direct-hover-->/g,'')
    .replace(/\\r\\n?/g,'\\n')
    .replace(/[ \\t]+$/gm,'')
    .replace(/\\n{3,}/g,'\\n\\n')
    .trim();
}
function irDedupeHoverContent(hoverHost){
  if(!hoverHost||!hoverHost.querySelectorAll)return;
  if(!IR_HOVER_DOM_DEDUPE_ENABLED)return;
  try{
    var seen=Object.create(null), removed=0;
    var blocks=hoverHost.querySelectorAll('.rendered-markdown');
    if(blocks.length<2)return;
    for(var bi=0;bi<blocks.length;bi++){
      var block=blocks[bi];
      if(!block||!document.body.contains(block))continue;
      var key=irNormalizeHoverDedupeText(block.textContent||'');
      if(!key)continue;
      if(irIsTransientHoverText(key)){
        if(window.__irLazyHoverLifecycleLogCount<120){
          window.__irLazyHoverLifecycleLogCount++;
          irLog('renderer: lazy-hover dedupe-skip transient len='+key.length+' host={'+irHoverBrief(hoverHost)+'}');
        }
        continue;
      }
      var prior=seen[key];
      if(prior&&!document.body.contains(prior)){
        prior=null;
        seen[key]=null;
      }
      if(prior){
        var currentManaged=!!(block.classList&&block.classList.contains('ir-applied'));
        var priorManaged=!!(prior.classList&&prior.classList.contains('ir-applied'));
        if(currentManaged&&priorManaged)continue;
        var removeBlock=(currentManaged&&!priorManaged)?prior:block;
        if(irRemoveDuplicateHoverBlock(removeBlock)){
          removed++;
          if(removeBlock===prior)seen[key]=block;
        }
        continue;
      }
      seen[key]=block;
    }
    if(removed&&window.__irWrapLogCount<20){
      window.__irWrapLogCount++;
      irLog('renderer: dedupe hover blocks removed='+removed);
    }
  }catch(_){}
}
function irRemoveDuplicateHoverBlock(block){
  try{
    var victim=irSafeDuplicateHoverVictim(block);
    if(victim&&victim.parentNode){
      victim.parentNode.removeChild(victim);
      return true;
    }
  }catch(_){}
  return false;
}
function irSafeDuplicateHoverVictim(block){
  if(!block)return null;
  var row=block.closest&&block.closest('.hover-row,.markdown-hover');
  if(row&&row.querySelectorAll){
    var markdownBlocks=row.querySelectorAll('.rendered-markdown');
    if(markdownBlocks.length===1&&markdownBlocks[0]===block){
      var rowText=irNormalizeHoverDedupeText(row.textContent||'');
      var blockText=irNormalizeHoverDedupeText(block.textContent||'');
      if(rowText&&rowText===blockText)return row;
    }
  }
  return block;
}

function irScanRenderedMarkdown(){
  var containers=document.querySelectorAll('.monaco-hover .rendered-markdown, .monaco-editor-hover .rendered-markdown, .ij-find-hover-tooltip .rendered-markdown');
  if(containers.length!==irLastContainerCount) irLastContainerCount=containers.length;
  for(var pre=0;pre<containers.length;pre++){
    try{
      var preBlock=containers[pre];
      if(!document.body.contains(preBlock))continue;
      var preText=preBlock.textContent||'';
      var preHost=preBlock.closest('.monaco-hover, .monaco-editor-hover');
      if(preHost&&preBlock.__irLastScanText!==preText){
        irTouchHoverRootContent(preHost,'pre-scan-text-change',preText);
      }
    }catch(_){}
  }
  irPruneDetachedHoverState();
  var dedupedHosts=[];
  for(var j=0;j<containers.length;j++){var block=containers[j];
    if(!document.body.contains(block))continue;
    var text=block.textContent||'';
    var hoverHost=block.closest('.monaco-hover, .monaco-editor-hover');
    if(!irShouldProcessHoverBlock(hoverHost,block))continue;
    irCacheNativeTokenizedSourceStyle(block);
    if(hoverHost){
      var alreadyDeduped=false;
      for(var dh=0;dh<dedupedHosts.length;dh++){
        if(dedupedHosts[dh]===hoverHost){alreadyDeduped=true;break;}
      }
      if(!alreadyDeduped){
        dedupedHosts.push(hoverHost);
        irDedupeHoverContent(hoverHost);
      }
    }
    if(!document.body.contains(block))continue;
    irEnsureHoverPointer(hoverHost);
    irEnsurePreviewBackButtonForScannedHover(hoverHost,block);
    // VS Code can replace a hover row with the same text while removing our
    // spans. Same text is only a skip when the clickable links still exist.
    var hasTypeLinks=!!block.querySelector('.ir-type-link');
    if(block.__irLastScanText===text&&(hasTypeLinks||text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT)){
      if(irInterestingHoverScanText(text)){
        irLogHoverScanDecision('skip-same-text',block,hoverHost,text,'',[], 'hasTypeLinks='+hasTypeLinks+' eagerTooLarge='+(text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT));
      }
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
    if(text.length<3){
      irLogHoverScanDecision('skip-short',block,hoverHost,text,'',[], '');
      continue;
    }
    var skip=IR_HOVER_LINK_SKIP;
    var candidateText=irHoverLinkCandidateText(block,text);
    var deferEagerWrap=text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT;
    var types=irCollectHoverLinkNames(candidateText,skip,deferEagerWrap);
    irSetHoverLinkCandidates(block,types);
    block.__irLastScanText=text;
    var existingLinks=block.querySelectorAll?block.querySelectorAll('.ir-type-link').length:0;
    if(window.__irScanLogCount<20&&(text.length>800||types.length||existingLinks)){
      window.__irScanLogCount++;
      irLog('renderer: scan text='+text.length+' types='+types.length+' existing='+existingLinks+' sample='+types.slice(0,10).join(','));
    }
    if(irInterestingHoverScanText(text)||irInterestingHoverScanText(candidateText)){
      irLogHoverScanDecision('candidate-result',block,hoverHost,text,candidateText,types,'defer='+deferEagerWrap+' existing='+existingLinks);
    }
    if(!types.length){
      irLogHoverScanDecision('skip-no-types',block,hoverHost,text,candidateText,types,'defer='+deferEagerWrap);
      continue;
    }
    if(deferEagerWrap){
      if(window.__irWrapLogCount<20){
        window.__irWrapLogCount++;
        irLog('renderer: defer wrap text='+text.length+' types='+types.length+' existing='+existingLinks+' sample='+types.slice(0,10).join(','));
      }
      irLogHoverScanDecision('skip-defer-wrap',block,hoverHost,text,candidateText,types,'existing='+existingLinks);
      continue;
    }
    var linkRe=irBuildHoverLinkRegex(types);
    if(!linkRe){
      irLogHoverScanDecision('skip-no-regex',block,hoverHost,text,candidateText,types,'');
      continue;
    }
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
        if(nAnc.nodeName==='A'||nAnc.nodeName==='BUTTON'||(nAnc.classList&&nAnc.classList.contains('ir-type-link'))){inAnchor=true;break}
        nAnc=nAnc.parentNode;
      }
      if(inAnchor)continue;
      var nv=node.nodeValue||'';
      var matches=[];
      linkRe.lastIndex=0;
      var lm;
      while((lm=linkRe.exec(nv))!==null){
        var typeName=lm[0];
        var idx=lm.index;
        if(!typeName){linkRe.lastIndex++;continue}
        var before=idx>0?nv[idx-1]:'';
        var afterC=nv[idx+typeName.length]||'';
        if(!afterC&&node.nextSibling){var ns=node.nextSibling.textContent||'';afterC=ns[0]||''}
        if(!before&&node.previousSibling){var ps=node.previousSibling.textContent||'';before=ps[ps.length-1]||''}
        if(!wc.test(before)&&!wc.test(afterC)){matches.push({type:typeName,idx:idx})}
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
      if(hoverHost&&(hoverHost.__irContentChangedAt||0)&&Date.now()-(hoverHost.__irContentChangedAt||0)<1200){
        hoverHost.__irActivatedAt=Date.now();
        irSetActiveHoverLayer(hoverHost);
      }
    }
    if(window.__irWrapLogCount<20&&(wrappedCount>0||types.length>0)){
      window.__irWrapLogCount++;
      irLog('renderer: wrap text='+text.length+' types='+types.length+' wrapped='+wrappedCount+' sample='+types.slice(0,10).join(','));
    }
    if(wrappedCount===0||irInterestingHoverScanText(text)||irInterestingHoverScanText(candidateText)){
      irLogHoverScanDecision('wrap-result',block,hoverHost,text,candidateText,types,'wrapped='+wrappedCount+' nodes='+textNodes.length);
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
    var nodes=mut.addedNodes||[];
    var activated=0;
    for(var ni=0;ni<nodes.length;ni++){
      activated+=irActivateAddedHoverRoots(nodes[ni],'mutation-added');
      try{
        var addedEl=nodes[ni]&&(nodes[ni].nodeType===1?nodes[ni]:nodes[ni].parentElement);
        var addedHover=addedEl&&addedEl.closest?addedEl.closest('.monaco-hover,.monaco-editor-hover'):null;
        if(addedHover)irTouchHoverRootContent(addedHover,'mutation-added',addedEl.textContent||'');
      }catch(_){}
    }
    var target=mut.target;
    var targetEl=target&&(target.nodeType===1?target:target.parentElement);
    if(targetEl&&targetEl.closest&&targetEl.closest('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip')){
      try{
        var targetHover=targetEl.closest('.monaco-hover,.monaco-editor-hover');
        if(targetHover)irTouchHoverRootContent(targetHover,'mutation-'+(mut.type||'target'),targetEl.textContent||'');
      }catch(_){}
      irScheduleScan();
      return;
    }
    for(var ni=0;ni<nodes.length;ni++){
      var n=nodes[ni];
      if(!n||n.nodeType!==1)continue;
      if((n.matches&&n.matches('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip'))||
         (n.querySelector&&n.querySelector('.rendered-markdown'))){
        try{
          var nodeHover=n.closest?n.closest('.monaco-hover,.monaco-editor-hover'):null;
          if(!nodeHover&&n.querySelector)nodeHover=n.querySelector('.monaco-hover,.monaco-editor-hover');
          if(nodeHover)irTouchHoverRootContent(nodeHover,'mutation-query',n.textContent||'');
        }catch(_){}
        irScheduleScan();
        return;
      }
    }
  }
}));
window.__irMarkdownObserver.observe(document.body,{childList:true,subtree:true,characterData:true});
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

return 'hover patch installed v'+IR_PATCH_VERSION;
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

function decoratorIdentifiersInLine(line: string): Array<{ id: string; index: number }> {
  const out: Array<{ id: string; index: number }> = [];
  if (!/^\s*@/.test(line)) { return out; }
  const expr = line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, match => ' '.repeat(match.length));
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(expr)) !== null) {
    const id = match[0];
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    out.push({ id, index: match.index });
  }
  return out;
}

function findTypeNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const decl of decoratorIdentifiersInLine(line)) {
      addNavigableName(out, seen, decl.id, true);
    }
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

function activeDocUriString(): string {
  return vscode.window.activeTextEditor?.document.uri.toString() || lastHoverDocUri || '';
}

function commandArgUriString(value: unknown): string {
  if (!value) { return ''; }
  if (value instanceof vscode.Uri) { return value.toString(); }
  if (typeof value === 'string') { return value; }
  const obj = value as any;
  if (obj?.scheme && (obj.path || obj.fsPath) && typeof obj.toString === 'function') {
    return obj.toString();
  }
  return '';
}

function commandArgIdentifier(value: unknown): string {
  if (!value) { return ''; }
  if (typeof value === 'string') { return value; }
  const obj = value as any;
  for (const key of ['identifier', 'typeName', 'type', 'name', 'symbol']) {
    if (typeof obj?.[key] === 'string' && obj[key]) { return obj[key]; }
  }
  return '';
}

function normalizeGoToTypeCommandArgs(first?: unknown, second?: unknown): { docUriStr: string; identifier: string } {
  if (second === undefined) {
    const identifier = commandArgIdentifier(first);
    const docUriStr = typeof first === 'object' && first !== null
      ? commandArgUriString((first as any).docUri ?? (first as any).uri) || activeDocUriString()
      : activeDocUriString();
    return { docUriStr, identifier };
  }
  return {
    docUriStr: commandArgUriString(first) || activeDocUriString(),
    identifier: commandArgIdentifier(second),
  };
}

async function previewTypeCommandHandler(first?: unknown, second?: unknown): Promise<void> {
  const { docUriStr, identifier } = normalizeGoToTypeCommandArgs(first, second);
  const previewIdentifier = identifier.startsWith('PREVIEW:') ? identifier.substring('PREVIEW:'.length) : identifier;
  if (previewIdentifier.length <= 2) {
    log.info(`preview: "${previewIdentifier}" skipped (too short)`);
    return;
  }
  await previewTypeHandler(docUriStr, previewIdentifier, false);
}

async function goToTypeHandler(docUriArg?: unknown, identifierArg?: unknown) {
  const { docUriStr, identifier } = normalizeGoToTypeCommandArgs(docUriArg, identifierArg);
  if (!identifier) {
    log.info('goToType: skipped (missing identifier)');
    return;
  }
  if (identifier.startsWith('PREVIEW:')) {
    const previewIdentifier = identifier.substring('PREVIEW:'.length);
    await previewTypeHandler(docUriStr, previewIdentifier, false);
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
  for (const timer of rendererHoverFallbackTimers) {
    clearTimeout(timer);
  }
  rendererHoverFallbackTimers.clear();
  await cleanupRendererInjection('deactivate');
  closeMainWebSocket();
  clearAllExtensionCaches();
  indexManager?.dispose();
  indexManager = null;
  log.info('Extension deactivated');
  log.dispose();
}
