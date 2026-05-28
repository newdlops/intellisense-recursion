// Document-open prefetch infrastructure extracted from extension.ts (Phase 11).
//
// Scope:
//   * Per-document scheduling state (prefetchedDocs) + debounce timer
//     (prefetchDebounce) gating schedulePrefetch().
//   * Single-worker FIFO queue (prefetchQueue / prefetchWorkers /
//     PREFETCH_MAX_WORKERS / PREFETCH_WORKER_DELAY_MS / enqueuePrefetch).
//   * PascalCase token extraction with per-(fsPath, version) memoization
//     (prefetchTokenCache / PASCAL_TOKEN_RE / extractPrefetchTokens) and an
//     LRU cap (PREFETCH_TOKEN_CACHE_MAX).
//   * schedulePrefetch(): debounced entry point. Skips oversized docs
//     (PREFETCH_MAX_DOC_LINES / PREFETCH_MAX_DOC_BYTES) and queues a
//     background resolve for each extracted token whose def cache slot is
//     still empty.
//
// Cross-module dependencies kept wire-in (not imported) to avoid circular
// imports back into extension.ts:
//   * Logger — set via setPrefetchLogger() before any schedule could fire.
//   * Background resolver — set via setPrefetchBackgroundResolver() so
//     schedulePrefetch can dispatch resolveInBackground without importing
//     extension.ts.

import * as vscode from 'vscode';
import { SKIP_WORDS } from './idents';
import { isCodeDoc } from './util';
import { defCacheKey, defCacheGet } from './cache';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };
let _logger: Logger | null = null;
/** Wire the logger into this module. Called from extension.activate() after
 * the OutputChannel is created. */
export function setPrefetchLogger(logger: Logger): void {
  _logger = logger;
}

type BackgroundResolver = (
  typeName: string,
  uri: vscode.Uri,
  pos: vscode.Position,
  cacheKey: string,
  mode: 'prefetch' | 'hover',
) => Promise<unknown>;
let _backgroundResolver: BackgroundResolver | null = null;
/** Wire the background resolver into this module. Called from
 * extension.activate(); resolveInBackground is a function declaration so it's
 * hoisted and addressable from anywhere inside activate(). */
export function setPrefetchBackgroundResolver(fn: BackgroundResolver): void {
  _backgroundResolver = fn;
}

// ── (B) Document-open prefetch infrastructure ──
export const prefetchedDocs = new Set<string>();  // uri.fsPath → already scheduled
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

export function enqueuePrefetch(task: () => Promise<void>) {
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
// Result is memoized per (fsPath, version) so repeated tab switches on an
// unchanged document don't re-scan the entire text.
const PREFETCH_TOKEN_CACHE_MAX = 32;
const prefetchTokenCache = new Map<string, Array<{ name: string; pos: vscode.Position }>>();
const PASCAL_TOKEN_RE = /\b[A-Z][A-Za-z0-9_]{2,}\b/g;
export function extractPrefetchTokens(doc: vscode.TextDocument): Array<{ name: string; pos: vscode.Position }> {
  const cacheKey = `${doc.uri.fsPath}\0${doc.version}`;
  const cached = prefetchTokenCache.get(cacheKey);
  if (cached) {
    prefetchTokenCache.delete(cacheKey);
    prefetchTokenCache.set(cacheKey, cached);
    return cached;
  }
  const text = doc.getText();
  PASCAL_TOKEN_RE.lastIndex = 0;
  const seen = new Map<string, { pos: vscode.Position; count: number }>();
  let m: RegExpExecArray | null;
  while ((m = PASCAL_TOKEN_RE.exec(text)) !== null) {
    const name = m[0];
    if (SKIP_WORDS.has(name)) { continue; }
    const prev = seen.get(name);
    if (prev) { prev.count++; } else { seen.set(name, { pos: doc.positionAt(m.index), count: 1 }); }
  }
  const result = [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, PREFETCH_MAX_TOKENS)
    .map(([name, v]) => ({ name, pos: v.pos }));
  // Evict any prior entry for this fsPath (different version) before inserting.
  const fsPrefix = `${doc.uri.fsPath}\0`;
  for (const key of prefetchTokenCache.keys()) {
    if (key !== cacheKey && key.startsWith(fsPrefix)) { prefetchTokenCache.delete(key); }
  }
  if (prefetchTokenCache.size >= PREFETCH_TOKEN_CACHE_MAX) {
    const first = prefetchTokenCache.keys().next().value;
    if (first !== undefined) { prefetchTokenCache.delete(first); }
  }
  prefetchTokenCache.set(cacheKey, result);
  return result;
}

export function schedulePrefetch(doc: vscode.TextDocument | undefined) {
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
        _logger?.info(`[prefetch] skip ${vscode.workspace.asRelativePath(doc.uri)} — too many lines (${doc.lineCount})`);
        prefetchedDocs.add(doc.uri.fsPath);
        return;
      }
      const textLen = doc.getText().length;
      if (textLen > PREFETCH_MAX_DOC_BYTES) {
        _logger?.info(`[prefetch] skip ${vscode.workspace.asRelativePath(doc.uri)} — too large (${textLen}B)`);
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
          if (_backgroundResolver) { await _backgroundResolver(t.name, doc.uri, t.pos, key, 'prefetch'); }
        });
        queued++;
      }
      _logger?.info(`[prefetch] ${vscode.workspace.asRelativePath(doc.uri)}: queued ${queued}/${tokens.length} tokens`);
    } catch (err) {
      _logger?.warn(`[prefetch] scheduling error: ${err}`);
    }
  }, PREFETCH_DEBOUNCE_MS);
}

/** Reset every prefetch-related cache. Called from clearAllExtensionCaches. */
export function clearPrefetchState(): void {
  prefetchedDocs.clear();
  prefetchTokenCache.clear();
}

/** Tear down pending timers + queued tasks. Called from extension.deactivate(). */
export function shutdownPrefetch(): void {
  if (prefetchDebounce) {
    clearTimeout(prefetchDebounce);
    prefetchDebounce = undefined;
  }
  prefetchQueue.length = 0;
}
