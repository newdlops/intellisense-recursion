// In-memory caches extracted from extension.ts (Phase 2).
//
// Three independent cache layers + their helpers:
//   * defCache             — position-keyed definition resolution result
//   * notFoundInDocs       — global negative cache for "this type isn't in
//                            this document" (avoids repeated doc-wide regex
//                            scans for styled-components / TS infra types)
//   * clickNegCache        — identifier-level negative cache for Cmd+Click
//                            that walked every fallback and came up empty
//   * previewClickDedupe   — identifier-level click rate limiter
//
// Each cache owns its own Map; nothing here depends on mutable extension.ts
// state.

import * as vscode from 'vscode';

// ── Definition cache (LRU-style with TTL) ───────────────────────────────
// Key: "uri:line:character:typeName", Value: cached result or negative marker
export interface DefCacheEntry {
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
export const DEF_CACHE_TTL = 60_000;       // positive cache: 60s
export const DEF_CACHE_NEG_TTL = 30_000;   // negative cache: 30s
export const DEF_CACHE_MAX_SIZE = 200;

export function defCacheKey(uri: vscode.Uri, pos: vscode.Position, typeName: string): string {
  return `${uri.fsPath}:${pos.line}:${pos.character}:${typeName}`;
}

export function defCacheGet(key: string): DefCacheEntry | undefined {
  const entry = defCache.get(key);
  if (!entry) { return undefined; }
  const ttl = entry.result ? DEF_CACHE_TTL : DEF_CACHE_NEG_TTL;
  if (Date.now() - entry.timestamp > ttl) {
    defCache.delete(key);
    return undefined;
  }
  return entry;
}

export function defCacheSet(key: string, result: DefCacheEntry['result']) {
  // Simple eviction: drop oldest entries when over limit
  if (defCache.size >= DEF_CACHE_MAX_SIZE) {
    const firstKey = defCache.keys().next().value;
    if (firstKey !== undefined) { defCache.delete(firstKey); }
  }
  defCache.set(key, { timestamp: Date.now(), result });
}

// ── "Not found in docs" global negative cache ────────────────────────────
// L14: keyed by (uri.fsPath, typeName) — independent of cursor position. The
// position-keyed defCache misses when the user hovers the same identifier
// at different positions in the same file (e.g. styled-components TS infra
// types like IStyledComponentBase / FastOmit that appear in every React
// component hover). Log analysis showed those two alone accounted for 42 of
// 50 "not found in docs" entries in a single 63-minute session, each
// repeating the full doc.getText() + regex scan + resolvedDefDocs walk.
export const NOT_FOUND_NEG_TTL = 60_000;
export const NOT_FOUND_MAX = 256;
const notFoundInDocs = new Map<string, number>();
function notFoundInDocsKey(docUri: vscode.Uri, typeName: string): string {
  return `${docUri.fsPath}\0${typeName}`;
}
export function notFoundInDocsHas(docUri: vscode.Uri, typeName: string): boolean {
  const k = notFoundInDocsKey(docUri, typeName);
  const ts = notFoundInDocs.get(k);
  if (ts === undefined) { return false; }
  if (Date.now() - ts > NOT_FOUND_NEG_TTL) {
    notFoundInDocs.delete(k);
    return false;
  }
  // LRU touch
  notFoundInDocs.delete(k);
  notFoundInDocs.set(k, ts);
  return true;
}
export function notFoundInDocsRemember(docUri: vscode.Uri, typeName: string): void {
  const k = notFoundInDocsKey(docUri, typeName);
  notFoundInDocs.delete(k);
  notFoundInDocs.set(k, Date.now());
  while (notFoundInDocs.size > NOT_FOUND_MAX) {
    const first = notFoundInDocs.keys().next().value;
    if (first === undefined) { break; }
    notFoundInDocs.delete(first);
  }
}

// ── Click negative cache ──────────────────────────────────────────────
// Identifier-level: short-circuits goToTypeHandler when a prior click already
// walked every fallback (steps 1-6) and came up empty. Avoids re-running the
// ~3-4s import-source scan for genuinely unresolvable tokens. Cleared on save.
const clickNegCache = new Map<string, number>();
export const CLICK_NEG_TTL = 60_000;
export const CLICK_NEG_MAX = 200;
export const previewClickDedupe = new Map<string, number>();
export const PREVIEW_CLICK_DEDUPE_MS = 1500;
export const PREVIEW_CLICK_DEDUPE_MAX = 200;
export function clickNegGet(identifier: string): boolean {
  const ts = clickNegCache.get(identifier);
  if (ts === undefined) { return false; }
  if (Date.now() - ts > CLICK_NEG_TTL) { clickNegCache.delete(identifier); return false; }
  return true;
}
export function clickNegSet(identifier: string) {
  if (clickNegCache.size >= CLICK_NEG_MAX) {
    const k = clickNegCache.keys().next().value;
    if (k !== undefined) { clickNegCache.delete(k); }
  }
  clickNegCache.set(identifier, Date.now());
}

/** Drop the entire click-fallback negative cache. */
export function clearClickNegCache(): void {
  clickNegCache.clear();
}
/** Drop every cached definition resolution. */
export function clearDefCache(): void {
  defCache.clear();
}
/** Drop every "not found in docs" entry. */
export function clearNotFoundInDocs(): void {
  notFoundInDocs.clear();
}
/**
 * Drop every defCache entry whose key starts with `fsPath:` (the prefix
 * shape used by defCacheKey). Called on file save to invalidate stale
 * resolutions for that document.
 */
export function invalidateDefCacheByPath(fsPath: string): void {
  const prefix = fsPath + ':';
  for (const key of defCache.keys()) {
    if (key.startsWith(prefix)) { defCache.delete(key); }
  }
}
