// Sidecar resolution pipeline extracted from extension.ts (Phase 6).
//
// Scope:
//   * sidecarDefinitivelyMissing — short-circuit LSP when the sidecar has
//     authoritative coverage and returns 0 hits
//   * import-target resolver (TS + Python) — narrow sidecar lookups to
//     candidates the source file actually imports
//   * chooseSidecarHit / pickByProximity — pick the right hit when the
//     sidecar returns multiple non-alias candidates
//   * fastResolveTypeName — the orchestrator that combines the above and
//     returns at most one definitive hit
//
// The IndexManager dependency is held in module-level state set by
// setSidecarIndexManager() during extension.activate() rather than
// passed through every call site — keeps the function signatures
// unchanged from their original shape.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { IndexManager } from './indexManager';
import type { SidecarHit } from './sidecar';
import {
  TYPE_SHAPED_NAME,
  CONSTANT_SHAPED_NAME,
  workspaceRootFsPath,
  languageOf,
} from './util';

let _indexManager: IndexManager | null = null;
/** Wire the IndexManager instance into this module. Called from
 * extension.activate() after the manager is constructed. */
export function setSidecarIndexManager(im: IndexManager | null): void {
  _indexManager = im;
}

/**
 * Short-circuit the LSP path only when we're confident the symbol doesn't
 * exist anywhere the sidecar would find it. Python has full library coverage
 * (venv + stdlib + typeshed), so a miss is authoritative. TypeScript coverage
 * is partial (node_modules has .d.ts but also parameters/generics we skip) —
 * we don't short-circuit there.
 */
export async function sidecarDefinitivelyMissing(
  typeName: string,
  originFsPath: string,
): Promise<boolean> {
  if (!_indexManager?.hasFullCoverage()) { return false; }
  if (!TYPE_SHAPED_NAME.test(typeName)) { return false; }
  if (CONSTANT_SHAPED_NAME.test(typeName)) { return false; }
  const language = languageOf(originFsPath);
  if (!language) { return false; }
  // Applies to Python (.venv + stdlib + typeshed covered) and TypeScript
  // (node_modules covered). If the sidecar finds nothing in the appropriate
  // language pool, LSP will almost always time out too — skip it.
  const hits = await _indexManager.lookup(typeName, 1, language);
  return hits.length === 0;
}

/** Shared directory-component depth between two absolute paths. */
export function sharedDirDepth(a: string, b: string): number {
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
export function pickByProximity<T extends { path: string }>(
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

export type ImportTarget = {
  relPath: string;
  importedName: string;
};

export const MODULE_IMPORT_TARGET = '*module*';
export const IMPORT_SCAN_MAX_LINES = 500;

export function workspaceRelPathForFsPath(fsPath: string): string | null {
  const root = workspaceRootFsPath();
  if (!root) { return null; }
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return rel.replace(/\\/g, '/');
}

export function sidecarHitRelPath(hit: SidecarHit): string | null {
  return workspaceRelPathForFsPath(hit.path);
}

export function dedupeImportTargets(targets: ImportTarget[]): ImportTarget[] {
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

export function importScanText(doc: vscode.TextDocument): string {
  const max = Math.min(doc.lineCount, IMPORT_SCAN_MAX_LINES);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    lines.push(doc.lineAt(i).text);
  }
  return lines.join('\n');
}

export function isTsLikeRelPath(relPath: string): boolean {
  return /\.(?:tsx?|jsx?|mjs|cjs)$/.test(relPath);
}

export function resolveRelativeModuleCandidates(sourceRelPath: string, moduleSpecifier: string): string[] {
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

export function importedNamesForLocalName(importClause: string, localName: string): string[] {
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

export function tsImportTargetsForIdentifier(documentText: string, sourceRelPath: string, localName: string): ImportTarget[] {
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

export function pythonModuleCandidates(sourceRelPath: string, moduleName: string): string[] {
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

export function pythonImportTargetsForIdentifier(documentText: string, sourceRelPath: string, localName: string): ImportTarget[] {
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

export function importTargetsForIdentifier(
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

export function hitMatchesImportTarget(hit: SidecarHit, queryName: string, target: ImportTarget): boolean {
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

export function chooseSidecarHit(
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

export async function fastResolveTypeName(
  typeName: string,
  originFsPath: string,
  originDoc?: vscode.TextDocument,
): Promise<SidecarHit | null> {
  if (!_indexManager) { return null; }
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
    const results = await _indexManager.lookupMany(queryNames, 50, language);
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

  const hits = await _indexManager.lookup(typeName, 50, language);
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
