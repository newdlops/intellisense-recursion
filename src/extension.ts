import * as vscode from 'vscode';
import * as inspector from 'node:inspector';
import * as path from 'node:path';
import WebSocket from 'ws';
import { IndexManager } from './indexManager';
import type { SidecarHit, SidecarLanguage } from './sidecar';

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

async function fastResolveTypeName(
  typeName: string,
  originFsPath: string,
): Promise<SidecarHit | null> {
  if (!indexManager) { return null; }
  // Ask the sidecar for same-language hits only. Cross-language jumps
  // (e.g. `.tsx` → Python stub file) are always wrong for our users.
  const language = languageOf(originFsPath);
  const hits = await indexManager.lookup(typeName, 10, language);
  if (hits.length === 0) { return null; }

  const nonAlias = hits.filter((h) => h.kind !== 'alias');
  if (nonAlias.length === 0) { return null; }

  // If the workspace itself defines the symbol, prefer project-side hits.
  const projectNonAlias = nonAlias.filter((h) => h.source === 'project');
  if (projectNonAlias.length === 1) { return projectNonAlias[0]; }
  if (projectNonAlias.length > 1) {
    // Multiple project definitions (e.g. `class Meta` across Django models,
    // `DIRECTOR` across several enum classes). LSP can disambiguate via type
    // inference, but it usually times out on large workspaces. Try proximity
    // first: whichever hit shares the deepest directory prefix with the
    // origin is almost certainly the intended one. Only fall back to LSP
    // when proximity ties — otherwise showing a reasonable candidate beats
    // a 1.5 s stall with no preview.
    if (!TYPE_SHAPED_NAME.test(typeName)) { return null; }
    return pickByProximity(projectNonAlias, originFsPath);
  }

  // All non-alias hits are in external roots. Gate on identifier shape:
  // lowercase names (`modal`, `common`, `form`, `predicate`) are almost
  // always local params / properties — jumping to a random library's
  // `const modal = ...` is worse than falling through to LSP. PascalCase /
  // SCREAMING_SNAKE only.
  if (!TYPE_SHAPED_NAME.test(typeName)) { return null; }
  // Duplicate stubs across venv/typeshed point at the same logical symbol,
  // so picking the top one is safe (and dramatically better than a 1.5 s
  // LSP timeout).
  return nonAlias[0];
}

/**
 * Build the same DefCacheEntry payload as resolveInBackground's LSP success
 * path, but from a sidecar hit. Opens the target doc, extracts a 15-line
 * preview, populates lastPreviewLocations, and returns the entry.
 */
async function buildResultFromFastHit(
  typeName: string,
  hit: SidecarHit,
): Promise<DefCacheEntry['result']> {
  // hit.path is always absolute (v2 format reconstructs root + relative).
  const defUri = vscode.Uri.file(hit.path);
  const defDoc = findOpenDoc(defUri)
    ?? await withTimeout(vscode.workspace.openTextDocument(defUri), 1_000, 'openDef (fast)');
  const startLine = Math.max(0, hit.line - 1);
  const endLine = Math.min(startLine + 15, defDoc.lineCount);
  const lines: string[] = [];
  for (let i = startLine; i < endLine; i++) { lines.push(defDoc.lineAt(i).text); }
  const previewCode = lines.join('\n');
  const relPath = vscode.workspace.asRelativePath(defUri);
  const lang = defDoc.languageId || 'python';
  const preview = `\`${typeName}\` — *${relPath}:${startLine + 1}*\n\`\`\`${lang}\n${previewCode}\n\`\`\``;
  const previewLoc = new vscode.Location(defUri, new vscode.Range(startLine, 0, endLine, 0));
  lastPreviewLocations.set(typeName, previewLoc);
  for (const pt of findTypeNames(previewCode)) { lastPreviewLocations.set(pt, previewLoc); }
  return { preview, location: previewLoc, defUri, defDoc };
}

const lastPreviewLocations = new Map<string, vscode.Location>();
let lastHoverDocUri = '';
let hoverRecursionDepth = 0;
let reinjectTimer: ReturnType<typeof setInterval> | undefined;
let lastClickId = '';
let lastClickTime = 0;
// A new click aborts an in-flight click via this controller.
let currentClickController: AbortController | null = null;
let hoverPatchActive = false;
let lastPreviewKey = '';
let lastPreviewTime = 0;
// Persistent main-process CDP WebSocket — set by startClickListener after
// injection succeeds. previewTypeHandler reuses it via sendToRenderer to
// push Runtime.evaluate calls back into the renderer (in-place hover
// content swap on plain click).
let mainWsRef: WebSocket | null = null;
let cdpMsgIdCounter = 100_000;

// "Page-transition" state: when set, the next $provideHover call (within
// the time window) returns this markdown as its only content instead of
// the original symbol's hover. Set by previewTypeHandler before
// triggering editor.action.showHover, consumed and cleared by the
// patched $provideHover. VS Code re-renders via its native pipeline so
// theme + tokenization are applied for free.
interface PendingPreviewHover {
  identifier: string;
  contents: any[];   // vscode.Hover['contents']-shaped array
  expiresAt: number;
}
let pendingPreviewHover: PendingPreviewHover | null = null;

// Last position where VS Code's native hover was successfully fetched.
// Captured by the patched $provideHover so previewTypeHandler can move
// the text cursor there before triggering editor.action.showHover —
// otherwise showHover is a no-op when a hover is already visible, or
// triggers hover for the wrong position.
let lastHoverFetchPosition: { uri: vscode.Uri; line: number; character: number } | null = null;

// ── Definition cache (LRU-style with TTL) ──
// Key: "uri:line:character:typeName", Value: cached result or negative marker
interface DefCacheEntry {
  timestamp: number;
  /** null = negative cache (defProvider returned 0 and hover fallback failed) */
  result: { preview: string; location: vscode.Location; defUri: vscode.Uri; defDoc?: vscode.TextDocument } | null;
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

// ── Hover budget + background resolve ──
// Goal: hover overhead ≤ 10ms. On cache miss, race a resolve against a tight
// budget; if it doesn't finish in time, return preview-less hover and let the
// resolve finish in the background to populate cache for the next hover.
const HOVER_BUDGET_MS = 5;
// defProvider is the hot path — Pylance/Jedi commonly stalls up to several
// seconds on cold symbols. 1500ms keeps the ceiling low without dropping most
// successful resolves (observed p95 ~1300ms).
const BG_RESOLVE_DEF_TIMEOUT_MS = 1_500;
// Hover fallback can pull docstrings over the wire; allow a bit more headroom.
const BG_RESOLVE_HOVER_TIMEOUT_MS = 2_000;

const inflightResolves = new Map<string, Promise<DefCacheEntry['result']>>();

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
          const fastHit = await fastResolveTypeName(typeName, matchUri.fsPath);
          if (fastHit) {
            const entry = await buildResultFromFastHit(typeName, fastHit);
            if (entry) {
              defCacheSet(cacheKey, entry);
              log.info(`[bg]   "${typeName}" → fast def ${fastHit.path}:${fastHit.line} (${Date.now() - t0}ms)`);
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
        vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', matchUri, pos),
        BG_RESOLVE_DEF_TIMEOUT_MS,
        'defProvider',
      );

      if (defs?.length && defs[0]?.uri && defs[0]?.range?.start) {
        const def = defs[0];
        const defDoc = findOpenDoc(def.uri) ?? await withTimeout(
          vscode.workspace.openTextDocument(def.uri),
          BG_RESOLVE_DEF_TIMEOUT_MS,
          'openDef',
        );
        const startLine = def.range.start.line;
        const endLine = Math.min(startLine + 15, defDoc.lineCount);
        const lines: string[] = [];
        for (let i = startLine; i < endLine; i++) { lines.push(defDoc.lineAt(i).text); }
        const previewCode = lines.join('\n');
        const relPath = vscode.workspace.asRelativePath(def.uri);
        const lang = defDoc.languageId || 'python';
        const preview = `\`${typeName}\` — *${relPath}:${startLine + 1}*\n\`\`\`${lang}\n${previewCode}\n\`\`\``;
        const previewLoc = new vscode.Location(def.uri, new vscode.Range(startLine, 0, endLine, 0));
        lastPreviewLocations.set(typeName, previewLoc);
        for (const pt of findTypeNames(previewCode)) { lastPreviewLocations.set(pt, previewLoc); }
        const result = { preview, location: previewLoc, defUri: def.uri, defDoc };
        defCacheSet(cacheKey, result);
        log.info(`[bg]   "${typeName}" → def ${relPath}:${startLine + 1} (${Date.now() - t0}ms)`);
        return result;
      }

      // Hover fallback
      try {
        const hovers = await withTimeout(
          vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', matchUri, pos),
          BG_RESOLVE_HOVER_TIMEOUT_MS,
          'hoverProvider',
        );
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
            lastPreviewLocations.set(typeName, hoverLoc);
            for (const ht of findTypeNames(hoverParts.join('\n'))) { lastPreviewLocations.set(ht, hoverLoc); }
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

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activating...');

  // Rust sidecar: non-blocking; if it fails we continue with LSP-only path.
  indexManager = new IndexManager(context.extensionPath, context.globalStorageUri.fsPath, {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
  });
  if (indexManager.isAvailable()) {
    indexManager.registerWatchers(context);
    indexManager.start().catch((err) => log.warn(`[ir] start error: ${err}`));
  } else {
    log.info('[ir] sidecar unavailable; running in LSP-only mode');
  }
  context.subscriptions.push({ dispose: () => indexManager?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('intellisenseRecursion.goToType', goToTypeHandler),
    vscode.commands.registerCommand('intellisenseRecursion.getPatchStatus', () => ({
      hoverPatchActive,
      hoverRecursionDepth,
    })),
    vscode.commands.registerCommand('intellisenseRecursion.rebuildIndex', async () => {
      if (!indexManager) { vscode.window.showWarningMessage('IR: sidecar not available'); return; }
      vscode.window.showInformationMessage('IR: rebuilding symbol index...');
      await indexManager.rebuildNow();
      vscode.window.showInformationMessage('IR: rebuild complete');
    }),
    // Invalidate caches when documents are saved (content may have changed)
    vscode.workspace.onDidSaveTextDocument(savedDoc => {
      const prefix = savedDoc.uri.fsPath + ':';
      for (const key of defCache.keys()) {
        if (key.startsWith(prefix)) { defCache.delete(key); }
      }
      for (const key of posPreviewCache.keys()) {
        if (key.startsWith(prefix)) { posPreviewCache.delete(key); }
      }
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

  // Prefetch current active editor on startup
  schedulePrefetch(vscode.window.activeTextEditor?.document);

  // Patch $provideHover on shared ExtHostLanguageFeatures
  const sharedService = findSharedHoverService();
  if (sharedService) {
    patchSharedService(sharedService);
  } else {
    log.warn('Could not find shared ExtHostLanguageFeatures');
  }

  // Inject renderer script + re-inject periodically for new windows
  await injectRenderer();
  reinjectTimer = setInterval(() => { reinjectRenderer().catch(() => {}); }, 10000);

  // Trigger Monaco service captures by briefly side-opening an editor.
  // The renderer's prototype hooks (defined by the patch script but
  // dormant by default) are activated by __irStartCapture and torn
  // down by __irStopCapture immediately after — total active window
  // ~1s, no impact on click handlers or hover underline.
  setTimeout(() => { triggerMonacoCapture().catch(() => {}); }, 2000);

  log.info('Extension activated');
}

async function triggerMonacoCapture() {
  try {
    const active = vscode.window.activeTextEditor;
    if (!active) {
      log.info('[capture] no active editor — skipping');
      return;
    }
    sendToRenderer("(window.__irStartCapture && window.__irStartCapture('side-open'))");
    log.info(`[capture] side-opening ${vscode.workspace.asRelativePath(active.document.uri)}`);
    try {
      await vscode.window.showTextDocument(active.document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
      });
    } catch (e) { log.warn(`[capture] showTextDocument err: ${e}`); }
    await new Promise(r => setTimeout(r, 700));
    try { await vscode.commands.executeCommand('workbench.action.closeEditorsInGroup'); } catch {}
    await new Promise(r => setTimeout(r, 300));
    sendToRenderer("(window.__irStopCapture && window.__irStopCapture())");
    await new Promise(r => setTimeout(r, 500));
    // DIAG: ask renderer which .mtkN color rules actually exist in the
    // document. The renderer prints via irLog so it lands in our log.
    sendToRenderer("if(window.__irProbeMtk){var p=window.__irProbeMtk(); window.irGoToType('LOG:probe-mtk: '+p);}");
    await new Promise(r => setTimeout(r, 200));
    sendToRenderer("if(window.__irProbeMdRenderer){var p=window.__irProbeMdRenderer(); window.irGoToType('LOG:probe-mdr: '+p);}");
  } catch (e) {
    log.warn(`[capture] trigger error: ${e}`);
  }
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
  function attachPreviews(res: any, previews: string): any {
    const newContents = [...res.contents];
    for (let ci = 0; ci < newContents.length; ci++) {
      if (newContents[ci]?.value && typeof newContents[ci].value === 'string') {
        newContents[ci] = { ...newContents[ci], value: newContents[ci].value + '\n\n---\n' + previews };
        break;
      }
    }
    return { ...res, contents: newContents };
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
    // hover request to return the clicked symbol's content. We only
    // honor it on the FIRST handle within the window so multiple
    // providers don't all duplicate the same content. VS Code renders
    // this via its native MarkdownRenderer, so theme + TextMate tokens
    // come for free — no DOM manipulation on the renderer side.
    if (pendingPreviewHover && Date.now() < pendingPreviewHover.expiresAt) {
      const preview = pendingPreviewHover;
      // DON'T clear: keep persistent until expiresAt so every handle
      // (29 = main editor hover, 220 = others) returns the same redirected
      // content. The visible hover widget needs handle=29 to re-fire to
      // refresh; clearing on first hit means later handles miss the
      // redirect and we lose the page transition.
      log.info(`[hover] page-transition handle=${handle} → "${preview.identifier}"`);
      const ln = position?.lineNumber !== undefined ? position.lineNumber : (position?.line !== undefined ? position.line + 1 : 1);
      const col = position?.column !== undefined ? position.column : (position?.character !== undefined ? position.character + 1 : 1);
      return {
        contents: preview.contents,
        range: { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col },
      };
    }

    const result = await original.call(this, handle, uri, position, context, token);
    if (!result?.contents?.length) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    // Canonical position key (0-based, stable across internal vs API shapes)
    const apiLine = position?.lineNumber !== undefined ? position.lineNumber - 1 : (position?.line ?? 0);
    const apiChar = position?.column !== undefined ? position.column - 1 : (position?.character ?? 0);
    const posKey = `${uri?.path || uri}:${apiLine}:${apiChar}`;
    const now = Date.now();

    // Legacy 200ms dedup — protects against recursive re-entrancy and recent
    // successful handles re-emitting previews on the same result object.
    if (posKey === lastPreviewKey && now - lastPreviewTime < 200) {
      return result;
    }

    // Extract types from code fences
    const types: string[] = [];
    for (const content of result.contents) {
      if (!content || typeof content.value !== 'string') { continue; }
      const fence = content.value.match(/```\w*\n?([\s\S]*?)```/);
      if (fence) { types.push(...findTypeNames(fence[1].trim())); }
    }
    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length === 0) { return result; }

    const hoverMs = () => `${Date.now() - hoverT0}ms`;
    const typesKey = uniqueTypes.slice(0, 3).sort().join(',');

    // (A) Position-level preview cache — short-circuits everything below for
    // repeated hovers at the same point with the same extracted types.
    const cachedPreviews = posPreviewGet(posKey, typesKey);
    if (cachedPreviews) {
      log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} POS-CACHE hit (${hoverMs()})`);
      lastPreviewKey = posKey;
      lastPreviewTime = now;
      return attachPreviews(result, cachedPreviews);
    }

    // (E) In-flight preview dedup — share work with other handles called
    // for the same hover event at the same position with the same types.
    const inflightKey = `${posKey}:${typesKey}`;
    const existingInflight = inflightHoverPreviews.get(inflightKey);
    if (existingInflight) {
      log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} INFLIGHT shared (${hoverMs()})`);
      try {
        const shared = await existingInflight;
        if (shared) { return attachPreviews(result, shared.previews); }
      } catch { /* fall through to original */ }
      return result;
    }

    log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} types=[${uniqueTypes.join(',')}] (${hoverMs()})`);

    const docUriStr = uri?.scheme ? `${uri.scheme}://${uri.authority || ''}${uri.path}` : String(uri);
    lastHoverDocUri = docUriStr;

    // Compute previews and cache. Install promise in inflightHoverPreviews
    // BEFORE awaiting so concurrent handles can share.
    const computePromise = (async (): Promise<{ typesKey: string; previews: string } | null> => {
      const docUri = vscode.Uri.parse(docUriStr);
      const doc = findOpenDoc(docUri) ?? await vscode.workspace.openTextDocument(docUri);

      // (C) Smart anchor — if the word under the cursor is itself a PascalCase
      // identifier, we can skip the full docText regex scan for it.
      const hoverApiPos = new vscode.Position(apiLine, apiChar);
      let hoveredWord = '';
      let hoveredAnchor: vscode.Position | undefined;
      try {
        const wr = doc.getWordRangeAtPosition(hoverApiPos);
        if (wr) {
          hoveredWord = doc.getText(wr);
          hoveredAnchor = wr.start;
        }
      } catch { /* invalid position — fall back to scan */ }

      // Lazy-load docText only when we actually need to scan (i.e. no smart anchor)
      let docTextCache: string | undefined;
      const getDocText = () => (docTextCache ??= doc.getText());

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
          // (D) Cached compiled regex, scan hovered doc first
          const regex = typeRegex(typeName);
          regex.lastIndex = 0;
          let match = regex.exec(getDocText());
          let matchDoc = doc;
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

        const cached = defCacheGet(cacheKey);
        if (cached) {
          if (cached.result) {
            log.info(`[hover]   "${typeName}" → cached def (${Date.now() - typeT0}ms)`);
            lastPreviewLocations.set(typeName, cached.result.location);
            if (cached.result.defDoc) {
              resolvedDefDocs.push({ uri: cached.result.defUri, doc: cached.result.defDoc });
            }
            return cached.result.preview;
          }
          log.info(`[hover]   "${typeName}" → cached negative (${Date.now() - typeT0}ms)`);
          return null;
        }

        const bgPromise = resolveInBackground(typeName, matchUri, pos, cacheKey);
        bgPromise.catch(() => {});
        const BUDGET = Symbol('budget-exceeded');
        const raced = await Promise.race<DefCacheEntry['result'] | typeof BUDGET>([
          bgPromise,
          new Promise(r => setTimeout(() => r(BUDGET), HOVER_BUDGET_MS)),
        ]);
        if (raced === BUDGET) {
          log.info(`[hover]   "${typeName}" → budget ${HOVER_BUDGET_MS}ms exceeded, bg running (${Date.now() - typeT0}ms)`);
          return null;
        }
        if (raced) {
          if (raced.defDoc) {
            resolvedDefDocs.push({ uri: raced.defUri, doc: raced.defDoc });
          }
          log.info(`[hover]   "${typeName}" → resolved in budget (${Date.now() - typeT0}ms)`);
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
      return { typesKey, previews: previewsOut.join('\n\n---\n') };
    })();

    inflightHoverPreviews.set(inflightKey, computePromise);
    hoverRecursionDepth++;
    try {
      const computed = await computePromise;
      if (computed) {
        lastPreviewKey = posKey;
        lastPreviewTime = now;
        posPreviewSet(posKey, computed.typesKey, computed.previews);
        log.info(`[hover] done: previews cached (${hoverMs()})`);
        return attachPreviews(result, computed.previews);
      }
      log.info(`[hover] done: no previews (${hoverMs()})`);
    } catch (err) {
      log.error(`[hover] error: ${err} (${hoverMs()})`);
    } finally {
      hoverRecursionDepth--;
      inflightHoverPreviews.delete(inflightKey);
    }
    return result;
  };

  hoverPatchActive = true;
  log.info('$provideHover patched');
}

// ── Renderer injection via main process CDP ──

async function injectRenderer() {
  try {
    log.info('[inject] Starting renderer injection...');
    const { execSync } = require('child_process');
    const psOutput = execSync('ps aux | grep "[V]isual Studio Code.app/Contents/MacOS/Code$" || true', { encoding: 'utf8' });
    const pidMatch = psOutput.match(/\S+\s+(\d+)/);
    if (!pidMatch) {
      log.warn('[inject] Could not find main VS Code process via ps aux');
      return;
    }
    const mainPid = parseInt(pidMatch[1]);
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
      ws.on('open', () => {
        // Enable Runtime events & add main-process binding for instant click notification
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.addBinding', params: { name: 'irClickNotify' } }));

        const patchB64 = Buffer.from(getHoverPatchScript()).toString('base64');
        const evalExpr = "eval(atob('" + patchB64 + "'))";

        const injectScript = `
          (async function() {
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var results = [];
            for (var i = 0; i < wins.length; i++) {
              var w = wins[i];
              try {
                try { w.webContents.debugger.detach(); } catch(e2) {}
                w.webContents.debugger.attach('1.3');
                await w.webContents.debugger.sendCommand('Runtime.enable');
                var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)} });
                if (r.result && (r.result.value === 'hover patch installed' || r.result.value === 'already patched')) {
                  results.push('injected:' + w.id + '(' + r.result.value + ')');
                  try {
                    await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: 'irGoToType' });
                    w.webContents.debugger.on('message', function(event, method, params) {
                      if (method === 'Runtime.bindingCalled' && params.name === 'irGoToType') {
                        if(typeof global.irClickNotify==='function'){global.irClickNotify(params.payload)}
                      }
                    });
                    results.push('binding:' + w.id + ':ok');
                  } catch(eb) { results.push('binding:' + w.id + ':' + eb.message); }
                } else {
                  results.push('skip:' + w.id + '(' + (r.result ? r.result.value : 'no result') + ')');
                  w.webContents.debugger.detach();
                }
              } catch(e) { results.push('err:' + w.id + ':' + e.message); }
            }
            return results.join(' | ');
          })()
        `.trim();

        evalMsgId = msgId++;
        ws.send(JSON.stringify({ id: evalMsgId, method: 'Runtime.evaluate', params: { expression: injectScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }));
      });

      let done = false;
      ws.on('message', (data: string) => {
        try {
          const resp = JSON.parse(data);
          if (resp.id === evalMsgId && !done) {
            done = true;
            const val = resp.result?.result?.value;
            if (val) { log.info(`Renderer injection: ${val}`); }
            startClickListener(ws);
            resolve();
          }
        } catch {}
      });
      ws.on('error', () => { resolve(); });
      setTimeout(() => { resolve(); }, 10000);
    });
  } catch (err) {
    log.error(`Renderer injection error: ${err}`);
  }
}

async function reinjectRenderer() {
  try {
    const targetsJson = await httpGet('http://127.0.0.1:9229/json/list');
    const targets = JSON.parse(targetsJson);
    if (!targets.length || !targets[0].webSocketDebuggerUrl) { return; }

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        const patchB64 = Buffer.from(getHoverPatchScript()).toString('base64');
        const evalExpr = "eval(atob('" + patchB64 + "'))";
        const injectScript = `
          (async function() {
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var n = 0;
            for (var i = 0; i < wins.length; i++) {
              try {
                wins[i].webContents.debugger.attach('1.3');
                var r = await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)} });
                if (r.result && r.result.value === 'hover patch installed') n++;
                wins[i].webContents.debugger.detach();
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
            ws.close();
            resolve();
          }
        } catch {}
      });
      ws.on('error', () => { resolve(); });
      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 3000);
    });
  } catch {}
}

function startClickListener(mainWs: any) {
  log.info('[listen] Click event listener started (binding-driven)');
  mainWsRef = mainWs;

  mainWs.on('message', (data: string) => {
    try {
      const resp = JSON.parse(data);
      // sendToRenderer responses use ids >= 100000 — surface exceptions
      // and result values so silent failures aren't invisible.
      if (typeof resp.id === 'number' && resp.id >= 100_000) {
        if (resp.error) {
          log.warn(`[send-resp] id=${resp.id} error=${JSON.stringify(resp.error)}`);
        } else if (resp.result?.exceptionDetails) {
          const ex = resp.result.exceptionDetails;
          const msg = ex.exception?.description || ex.exception?.value || ex.text || '?';
          log.warn(`[send-resp] id=${resp.id} exception=${msg}`);
        } else if (resp.result?.result) {
          const r = resp.result.result;
          const v = r.value !== undefined ? JSON.stringify(r.value) : `(type=${r.type})`;
          log.info(`[send-resp] id=${resp.id} value=${v}`);
        }
        return;
      }
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
    setTimeout(() => {
      log.info('[listen] Attempting CDP reconnect...');
      injectRenderer().catch(err => log.error(`[listen] Reconnect failed: ${err}`));
    }, 2000);
  });

  mainWs.on('error', (err: any) => {
    log.warn(`[listen] CDP WebSocket error: ${err}`);
  });
}

/**
 * Push a Runtime.evaluate via the persistent main-process CDP WebSocket so
 * the given JS runs inside the focused renderer window (where our hover
 * popup lives). Used to update visible hover content in place after a
 * plain click on a type link, and to start/stop monaco capture hooks.
 */
function sendToRenderer(rendererJs: string): void {
  const ws = mainWsRef;
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    log.warn(`sendToRenderer: no active main-process WebSocket`);
    return;
  }
  const b64 = Buffer.from(rendererJs).toString('base64');
  const expr = `(async function() {
    var BW = require('electron').BrowserWindow;
    var w = BW.getFocusedWindow();
    if (!w) {
      if (typeof global.irClickNotify === 'function') { global.irClickNotify('SEND:no-focused-window'); }
      return 'no-focused-window';
    }
    var wid = w.id;
    var summary;
    try {
      var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: "eval(atob('" + ${JSON.stringify(b64)} + "'))" });
      if (r && r.exceptionDetails) {
        var et = r.exceptionDetails.exception ? (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value) : r.exceptionDetails.text;
        summary = 'wid=' + wid + ' exc=' + (et || '?');
      } else {
        summary = 'wid=' + wid + ' ok';
      }
    } catch (e) {
      summary = 'wid=' + wid + ' snd=' + (e && e.message ? e.message : String(e));
    }
    if (typeof global.irClickNotify === 'function') { global.irClickNotify('SEND:' + summary); }
    return summary;
  })()`;
  const id = ++cdpMsgIdCounter;
  try {
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
    }));
  } catch (err) {
    log.warn(`sendToRenderer error: ${err}`);
  }
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
  log.info(`preview: "${identifier}" start`);

  // Resolve location: sidecar first (resolves nested types correctly),
  // then hover-side cache+find as fallback.
  let loc: vscode.Location | null = null;
  let originFs = '';
  try { if (docUriStr) { originFs = vscode.Uri.parse(docUriStr).fsPath; } } catch {}
  if (!originFs) { originFs = vscode.window.activeTextEditor?.document.uri.fsPath ?? ''; }
  if (originFs && indexManager) {
    try {
      const fastHit = await fastResolveTypeName(identifier, originFs);
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
    const cached = lastPreviewLocations.get(identifier);
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
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', loc.uri, loc.range.start,
    );
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
    }
  } catch (err) {
    log.warn(`preview: hoverProvider error: ${err} (${ms()})`);
  }

  if (!markdown) {
    const startLine = loc.range.start.line;
    const endLine = Math.min(startLine + 15, doc.lineCount);
    const lines: string[] = [];
    for (let i = startLine; i < endLine; i++) { lines.push(doc.lineAt(i).text); }
    const previewCode = lines.join('\n');
    const relPath = vscode.workspace.asRelativePath(loc.uri);
    const lang = doc.languageId || '';
    markdown = `\`${identifier}\` — *${relPath}:${startLine + 1}*\n\`\`\`${lang}\n${previewCode}\n\`\`\``;
  }

  // Send markdown to the renderer's irApplyPreview which clears the
  // visible .rendered-markdown and rebuilds DOM via createElement
  // (TrustedHTML-safe). Theme variables in the patch script's CSS
  // make the result match VS Code's hover styling.
  const safeId = jsonStringifyAscii(identifier);
  const safeMd = jsonStringifyAscii(markdown);
  const rendererJs = `if(typeof window.irApplyPreview==='function')window.irApplyPreview(${safeId},${safeMd})`;
  sendToRenderer(rendererJs);
  log.info(`preview: "${identifier}" sent (${markdown.length}md, ${ms()})`);
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
var IR_PATCH_VERSION = 41;
if(window.__irPatchVersion === IR_PATCH_VERSION) return 'already patched';

// Tear down any prior version's listeners and style so the new patch
// has a clean slate. Each version stores its registered listeners on
// window.__irListeners so the next install can remove them precisely.
try {
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
  if (window.__irStopCapture) { try { window.__irStopCapture(); } catch(_) {} }
} catch(_) {}
window.__irListeners = [];
window.__irPatchVersion = IR_PATCH_VERSION;
window.__irHoverPatched = true;  // legacy compat

function irLog(msg){if(typeof window.irGoToType==='function')window.irGoToType('LOG:'+msg)}
irLog('renderer: patch v'+IR_PATCH_VERSION+' installing');

function track(target, type, fn, capture){
  target.addEventListener(type, fn, capture);
  window.__irListeners.push({target:target,type:type,fn:fn,capture:capture});
}

var style=document.createElement('style');
style.textContent=[
  // Always-on underline + pointer on hover. cmd/ctrl is no longer
  // required to see the hint that a symbol is clickable.
  '.ir-type-link,.ir-type-link *{cursor:pointer !important}',
  '.ir-type-link:hover,.ir-type-link:hover *{text-decoration:underline !important;color:var(--vscode-textLink-foreground) !important}',
  // ── Drill-down content styling using VS Code theme variables ──
  // VS Code's hover CSS uses 2-3 class selectors which beat single-
  // class .ir-applied rules. We mirror their specificity by scoping
  // under .monaco-hover/.monaco-editor-hover and adding !important
  // on color/font properties so theme variables actually take effect.
  '.monaco-hover .ir-applied,.monaco-editor-hover .ir-applied{color:var(--vscode-editor-foreground,var(--vscode-foreground)) !important;font-family:var(--vscode-font-family) !important;font-size:var(--vscode-font-size,13px) !important;line-height:1.5 !important}',
  '.monaco-hover .ir-applied p,.monaco-editor-hover .ir-applied p{margin:6px 0 !important;color:var(--vscode-editor-foreground) !important}',
  '.monaco-hover .ir-applied h1,.monaco-hover .ir-applied h2,.monaco-hover .ir-applied h3,.monaco-hover .ir-applied h4,.monaco-hover .ir-applied h5,.monaco-hover .ir-applied h6,.monaco-editor-hover .ir-applied h1,.monaco-editor-hover .ir-applied h2,.monaco-editor-hover .ir-applied h3{margin:8px 0 4px !important;font-weight:600 !important;color:var(--vscode-editor-foreground) !important}',
  '.monaco-hover .ir-applied hr,.monaco-editor-hover .ir-applied hr{border:none !important;border-top:1px solid var(--vscode-textSeparator-foreground,rgba(128,128,128,0.35)) !important;margin:8px 0 !important}',
  '.monaco-hover .ir-applied a,.monaco-editor-hover .ir-applied a{color:var(--vscode-textLink-foreground) !important;text-decoration:none !important}',
  '.monaco-hover .ir-applied a:hover,.monaco-editor-hover .ir-applied a:hover{text-decoration:underline !important}',
  '.monaco-hover .ir-applied strong,.monaco-editor-hover .ir-applied strong{font-weight:600 !important;color:var(--vscode-editor-foreground) !important}',
  '.monaco-hover .ir-applied em,.monaco-editor-hover .ir-applied em{font-style:italic !important}',
  // Inline code (not the code-block code) — uses textPreformat tokens.
  '.monaco-hover .ir-applied code:not(.ir-md-code),.monaco-editor-hover .ir-applied code:not(.ir-md-code){color:var(--vscode-textPreformat-foreground) !important;background:var(--vscode-textPreformat-background,var(--vscode-textCodeBlock-background,rgba(128,128,128,0.1))) !important;padding:1px 4px !important;border-radius:3px !important;font-family:var(--vscode-editor-font-family,monospace) !important;font-size:0.95em !important}',
  // Code blocks — theme-aware chrome with single-color tokens.
  '.monaco-hover .ir-applied pre.ir-md-pre,.monaco-editor-hover .ir-applied pre.ir-md-pre{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,0.1)) !important;color:var(--vscode-editor-foreground) !important;font-family:var(--vscode-editor-font-family,monospace) !important;font-size:var(--vscode-editor-font-size,12px) !important;padding:8px 10px !important;margin:6px 0 !important;border-radius:4px !important;overflow-x:auto !important;white-space:pre !important;border:1px solid var(--vscode-textSeparator-foreground,rgba(128,128,128,0.2)) !important}',
  '.monaco-hover .ir-applied pre.ir-md-pre code.ir-md-code,.monaco-editor-hover .ir-applied pre.ir-md-pre code.ir-md-code{background:transparent !important;color:inherit !important;font-family:inherit !important;font-size:inherit !important;padding:0 !important;border:0 !important}',
  // Token color comes directly from VS Code's theme via .mtkN classes
  // we sample at runtime. Just keep italic for comments — the color
  // is whatever user theme assigns to .mtkN for the comment token.
  '.monaco-hover .ir-applied .ir-tk-cm,.monaco-editor-hover .ir-applied .ir-tk-cm{font-style:italic !important}',
].join('');
document.head.appendChild(style);
window.__irStyleEl = style;
irLog('renderer: CSS injected');

// Eat mousedown on type-links so VS Code's selection / focus-change
// logic can't fire before our click handler — some hover widgets
// dismiss on mousedown outside the editor.
track(document,'mousedown',function(e){
  var t=e.target;
  if(!t||!t.classList||!t.classList.contains('ir-type-link'))return;
  e.preventDefault();e.stopPropagation();
},true);

track(document,'click',function(e){
  var t=e.target;
  if(!t||!t.classList||!t.classList.contains('ir-type-link'))return;
  var typeName=t.getAttribute('data-type');
  if(!typeName)return;
  e.preventDefault();e.stopPropagation();
  if(e.metaKey||e.ctrlKey){
    irLog('renderer: cmd-click on "'+typeName+'"');
    if(typeof window.irGoToType==='function'){window.irGoToType(typeName)}
  }else{
    var anc=t.closest('.rendered-markdown');
    window.__irLastPreviewTarget=anc;
    irLog('renderer: plain-click on "'+typeName+'"');
    if(typeof window.irGoToType==='function'){window.irGoToType('PREVIEW:'+typeName)}
  }
},true);

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
  var map = { kw:'', str:'', num:'', cls:'', fn:'', cm:'', prim:'', def:'mtk1' };
  var KW = /^(function|const|let|var|class|interface|type|enum|if|else|for|while|do|return|import|export|from|as|new|delete|typeof|instanceof|in|of|async|await|yield|throw|try|catch|finally|switch|case|break|continue|default|extends|implements|public|private|protected|static|abstract|readonly|override|namespace|declare|keyof|infer|never|any|unknown|null|undefined|true|false|this|super|self|cls|def|lambda|pass|global|nonlocal|raise|and|or|not|None|True|False|module|with)$/;
  var PRIM = /^(string|number|boolean|object|symbol|bigint|void|any|never|unknown|int|str|float|bool|list|dict|tuple|set|bytes)$/;
  try {
    var spans = document.querySelectorAll('.monaco-editor .view-line span > span');
    for (var i = 0; i < spans.length && i < 1500; i++) {
      var sp = spans[i];
      var text = (sp.textContent || '').replace(/\\u00a0/g, ' ').trim();
      var cls = sp.className || '';
      var m = /(?:^|\\s)(mtk\\d+)/.exec(cls);
      if (!m) continue;
      var mtk = m[1];
      if (!map.kw && KW.test(text)) map.kw = mtk;
      else if (!map.prim && PRIM.test(text)) map.prim = mtk;
      else if (!map.str && (text.charAt(0) === '"' || text.charAt(0) === "'" || text.charAt(0) === '\`')) map.str = mtk;
      else if (!map.num && /^[0-9]/.test(text)) map.num = mtk;
      else if (!map.cls && /^[A-Z][A-Za-z0-9_]+$/.test(text) && text.length > 1) map.cls = mtk;
      else if (!map.cm && (text.indexOf('//') === 0 || text.indexOf('/*') === 0 || text.indexOf('#') === 0)) map.cm = mtk;
    }
  } catch(_) {}
  // Fall back to default for any unfound type.
  for (var k in map) if (!map[k]) map[k] = 'mtk1';
  IR_MTK_MAP = map;
  irLog('mtk-map: kw='+map.kw+' prim='+map.prim+' str='+map.str+' num='+map.num+' cls='+map.cls+' cm='+map.cm);
  return map;
}

function irTokenizeCode(code, lang, target){
  var L = (lang||'').toLowerCase();
  var isPy = (L==='py'||L==='python');
  var lineComment = isPy ? '#' : '//';
  var i = 0; var len = code.length;
  var mtk = irSampleMtk();
  // Map token kind → sampled .mtkN class (theme-defined color).
  function clsFor(kind){
    return kind === 'kw' ? mtk.kw
      : kind === 'prim' ? mtk.prim
      : kind === 'str' ? mtk.str
      : kind === 'num' ? mtk.num
      : kind === 'cls' ? mtk.cls
      : kind === 'fn' ? (mtk.fn || mtk.def)
      : kind === 'cm' ? mtk.cm
      : mtk.def;
  }
  function emit(kind, text){
    if (!text) return;
    if (kind === 'id') { target.appendChild(document.createTextNode(text)); return; }
    var sp = document.createElement('span');
    sp.className = clsFor(kind) + ' ir-tk-' + kind; // both sampled .mtkN AND our marker
    sp.textContent = text;
    target.appendChild(sp);
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
    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      var j = i;
      while (j < len && /[A-Za-z0-9_$]/.test(code.charAt(j))) j++;
      var word = code.substring(i, j);
      if (IR_KW[word]) emit('kw', word);
      else if (IR_PRIM[word]) emit('prim', word);
      // Capitalized → likely a class/type
      else if (word.charAt(0) >= 'A' && word.charAt(0) <= 'Z') emit('cls', word);
      // Followed by '(' → function call
      else if (j < len && code.charAt(j) === '(') emit('fn', word);
      else emit('id', word);
      i = j; continue;
    }
    // Punctuation / operators — leave as plain text
    target.appendChild(document.createTextNode(ch));
    i++;
  }
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
    var pre=document.createElement('pre');
    pre.className='ir-md-pre';
    if(lang) pre.setAttribute('data-lang',lang);
    var c=document.createElement('code');
    c.className='ir-md-code';
    if(lang) c.classList.add('language-'+lang);
    irTokenizeCode(code, lang, c);
    pre.appendChild(c);
    parent.appendChild(pre);
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

window.irApplyPreview=function(typeName,md){
  irLog('renderer: irApplyPreview "'+typeName+'" md='+md.length+'B');
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
  try {
    var decoded=irDecodeContent(md);
    while(target.firstChild) target.removeChild(target.firstChild);
    target.classList.add('ir-applied');
    // DIAG: confirm class added + check if hover ancestor exists for
    // the .monaco-hover scoped CSS rules to match.
    var hasHoverAnc = !!target.closest('.monaco-hover, .monaco-editor-hover');
    irLog('renderer: ir-applied="'+target.className.slice(0,80)+'" hoverAnc='+hasHoverAnc);
    // DIAG: dump ancestor chain so we can see what scopes us.
    try {
      var anc = target;
      var chain = [];
      for (var ai = 0; ai < 8 && anc; ai++) {
        var cls = (anc.className || '').toString().slice(0,60);
        chain.push(anc.tagName + (cls ? '.'+cls.replace(/\\s+/g,'.') : ''));
        anc = anc.parentElement;
      }
      irLog('renderer: ancestors: '+chain.join(' < '));
    } catch(_) {}
    irBuildMdDom(decoded,target);
    // DIAG: walk the rendered children, report tag/class/computed style
    // for the first few. Tells us whether our CSS rules actually match.
    try {
      var walked = 0;
      var lines = ['target='+target.tagName+' cls="'+target.className.slice(0,80)+'"'];
      var ts = window.getComputedStyle(target);
      lines.push('  target style: color='+ts.color+' bg='+ts.backgroundColor+' font='+ts.fontFamily.slice(0,30));
      function walkDiag(el, depth){
        if (walked >= 6 || !el || depth > 3) return;
        for (var i = 0; i < el.children.length && walked < 6; i++) {
          var c = el.children[i];
          var cs = window.getComputedStyle(c);
          lines.push('  '+'  '.repeat(depth)+c.tagName + (c.className?'.'+c.className.toString().replace(/\\s+/g,'.').slice(0,50):'') + ' color='+cs.color+' bg='+cs.backgroundColor+' fs='+cs.fontSize);
          walked++;
          walkDiag(c, depth + 1);
        }
      }
      walkDiag(target, 0);
      // Specifically check a token span if any
      var tk = target.querySelector('.ir-tk-kw, .ir-tk-cls, .ir-tk-str, .ir-tk-num');
      if (tk) {
        var tcs = window.getComputedStyle(tk);
        lines.push('  TOKEN '+tk.tagName+'.'+tk.className+' text="'+(tk.textContent||'').slice(0,20)+'" color='+tcs.color);
      } else {
        lines.push('  TOKEN: no span found in code blocks');
      }
      irLog('renderer: dom-styles:\\n'+lines.join('\\n'));
    } catch(eD) { irLog('renderer: dom-styles err: '+(eD&&eD.message)); }
  } catch(eAP){
    irLog('renderer: irApplyPreview build err: '+(eAP&&eAP.message?eAP.message:String(eAP)));
    return;
  }
  // Let the popup grow to fit new content. Scoped to the hover subtree
  // so we never touch workbench layout (walking up to body broke the
  // entire UI in earlier versions). Reset scroll so the user lands at
  // the top of the new content.
  try {
    var hoverEl=target.closest('.monaco-hover, .monaco-editor-hover');
    if(hoverEl){
      hoverEl.style.height=''; hoverEl.style.maxHeight=''; hoverEl.style.bottom='';
      var inners=hoverEl.querySelectorAll('.monaco-scrollable-element, .hover-row, .hover-contents, .markdown-hover, .rendered-markdown');
      for(var i2=0;i2<inners.length;i2++){
        inners[i2].style.height=''; inners[i2].style.maxHeight='';
      }
      if(hoverEl.scrollTop) hoverEl.scrollTop=0;
      var scrolls=hoverEl.querySelectorAll('*');
      for(var s=0;s<scrolls.length;s++){ if(scrolls[s].scrollTop) scrolls[s].scrollTop=0; }
    } else if(target.scrollTop){ target.scrollTop=0; }
  } catch(_) {}
  window.__irLastPreviewTarget=null;
  irLog('renderer: applied "'+typeName+'" via '+src);
};

var irScanCount=0;
var irWrapCount=0;
var irLastContainerCount=0;

window.__irScanInterval = setInterval(function(){
  var containers=document.querySelectorAll('.rendered-markdown');
  if(containers.length!==irLastContainerCount){
    irLog('renderer: scan containers='+containers.length+' (was '+irLastContainerCount+')');
    irLastContainerCount=containers.length;
  }
  for(var j=0;j<containers.length;j++){var block=containers[j];
    if(block.querySelector('.ir-type-link'))continue;
    var text=block.textContent||'';
    if(text.length<3)continue;
    var skip={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'throws':1,'since':1,'see':1,'deprecated':1,'alias':1,'overload':1,'module':1,'variable':1};
    var re=/([a-zA-Z_][a-zA-Z0-9_]{2,})/g;
    var m,types=[];
    while(m=re.exec(text)){var w=m[1];if(types.indexOf(w)<0&&!skip[w])types.push(w)}
    if(!types.length)continue;
    irScanCount++;
    irLog('renderer: scan#'+irScanCount+' block['+j+'] types=['+types.slice(0,5).join(',')+']'+(types.length>5?' +'+( types.length-5)+' more':''));
    var walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    var node,replacements=[];
    while(node=walker.nextNode()){
      var nv=node.nodeValue||'';
      for(var k=0;k<types.length;k++){
        var idx=nv.indexOf(types[k]);
        if(idx>=0){
          var wc=/[a-zA-Z0-9_]/;
          var before=idx>0?nv[idx-1]:'';
          var afterC=nv[idx+types[k].length]||'';
          if(!afterC&&node.nextSibling){var ns=node.nextSibling.textContent||'';afterC=ns[0]||''}
          if(!before&&node.previousSibling){var ps=node.previousSibling.textContent||'';before=ps[ps.length-1]||''}
          if(!wc.test(before)&&!wc.test(afterC)){replacements.push({node:node,type:types[k],idx:idx})}
          else{irLog('renderer: boundary reject "'+types[k]+'" before="'+before+'" after="'+afterC+'"')}
        }
      }
    }
    irLog('renderer: scan#'+irScanCount+' replacements='+replacements.length);
    for(var r2=replacements.length-1;r2>=0;r2--){
      var rep=replacements[r2];
      try{
        var after=rep.node.splitText(rep.idx);
        var rest=after.splitText(rep.type.length);
        var span=document.createElement('span');
        span.className='ir-type-link';
        span.setAttribute('data-type',rep.type);
        after.parentNode.insertBefore(span,after);
        span.appendChild(after);
        irWrapCount++;
      }catch(e2){irLog('renderer: wrap error "'+rep.type+'": '+e2.message)}
    }
    if(replacements.length>0)irLog('renderer: total wrapped='+irWrapCount);
  }
},100);

irLog('renderer: setInterval started');

// ── Monaco capture (host-driven, brief activation) ────────────────────
// Modern VS Code hides the monaco namespace and AMD loader. To get
// theme-matched syntax highlighting we capture VS Code's internal
// IInstantiationService + CodeEditorWidget constructor + IModelService
// by hooking native Map/WeakMap/Set/Array prototypes during widget
// creation. Hooks are EXPENSIVE (every push/set in the renderer flows
// through us), so they only activate during the brief window between
// __irStartCapture() and __irStopCapture() — both driven by the host.
// Default: no hooks, no impact on normal editor operation.
window.__irStartCapture = function(reason){
  if (window.__irCaptureActive) return 'already-active';
  var caps = { widgets: [], services: [], widgetCtors: [] };
  window.__irMonacoCaps = caps;
  window.__irCaptureActive = true;
  var capturing = true;
  function sniff(v){
    if(!capturing || !v || typeof v !== 'object') return;
    try {
      if (typeof v.layout==='function' && typeof v.getModel==='function' && typeof v.getDomNode==='function') {
        if (caps.widgets.length < 50) caps.widgets.push(v);
        var ctor = v.constructor;
        if (ctor && caps.widgetCtors.indexOf(ctor) < 0 && caps.widgetCtors.length < 10) caps.widgetCtors.push(ctor);
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
  }
  var oM=Map.prototype.set, oW=WeakMap.prototype.set, oS=Set.prototype.add, oA=Array.prototype.push, oR=Reflect.construct;
  Map.prototype.set = function(k,v){ try { sniff(v); } catch(_) {} return oM.call(this,k,v); };
  WeakMap.prototype.set = function(k,v){ try { sniff(v); } catch(_) {} return oW.call(this,k,v); };
  Set.prototype.add = function(v){ try { sniff(v); } catch(_) {} return oS.call(this,v); };
  Array.prototype.push = function(){ try { for(var i=0;i<arguments.length;i++) sniff(arguments[i]); } catch(_) {} return oA.apply(this,arguments); };
  Reflect.construct = function(target){
    try {
      if (capturing && target && target.prototype) {
        var p = target.prototype;
        if (typeof p.layout==='function' && typeof p.getModel==='function' && typeof p.getDomNode==='function') {
          if (caps.widgetCtors.indexOf(target) < 0 && caps.widgetCtors.length < 20) caps.widgetCtors.push(target);
        }
      }
    } catch(_) {}
    return oR.apply(Reflect, arguments);
  };
  window.__irStopCapture = function(){
    if (!capturing) return 'already-stopped';
    capturing = false;
    try { Map.prototype.set = oM; } catch(_) {}
    try { WeakMap.prototype.set = oW; } catch(_) {}
    try { Set.prototype.add = oS; } catch(_) {}
    try { Array.prototype.push = oA; } catch(_) {}
    try { Reflect.construct = oR; } catch(_) {}
    window.__irCaptureActive = false;
    var kinds = {};
    for (var i = 0; i < caps.services.length; i++) { kinds[caps.services[i].kind] = (kinds[caps.services[i].kind]||0)+1; }
    irLog('capture stopped: widgets='+caps.widgets.length+' ctors='+caps.widgetCtors.length+' svcs='+JSON.stringify(kinds));
    try {
      var mz = window.__irMaterializeMonaco ? window.__irMaterializeMonaco() : 'no-fn';
      irLog('materialize: '+mz);
    } catch(eMz) { irLog('materialize threw: '+(eMz&&eMz.message)); }
    return 'stopped';
  };
  setTimeout(function(){ try { if (window.__irCaptureActive) window.__irStopCapture(); } catch(_) {} }, 3000);
  irLog('capture started ('+reason+', max 3s)');
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

// Materialize a hidden, off-screen Monaco CodeEditorWidget using the
// captured services. Try every (inst × ctor) pair — DI stubs throw,
// real combos succeed. IModelService fallback: walk captured widgets
// and the new widget itself for a private field matching the duck-type.
window.__irMaterializeMonaco = function(){
  if (window.__irMonaco) return 'already';
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
      modelSvc = irDeepFind(insts[ix], 3, new Set(), irIsModelSvc);
    }
    if (modelSvc) irLog('modelSvc found via inst deep-find');
  }
  // Fallback 2: deep-search captured widgets (each has a private
  // _modelService injected by DI).
  if (!modelSvc) {
    for (var w = 0; w < caps.widgets.length && !modelSvc; w++) {
      modelSvc = irDeepFind(caps.widgets[w], 3, new Set(), irIsModelSvc);
    }
    if (modelSvc) irLog('modelSvc found via widget deep-find');
  }
  if (!codeEditorSvc) {
    for (var w2 = 0; w2 < caps.widgets.length && !codeEditorSvc; w2++) {
      codeEditorSvc = irDeepFind(caps.widgets[w2], 3, new Set(), irIsCodeEditorSvc);
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
          // Register the widget with ICodeEditorService so the workbench
          // theme service applies token colors and the language service
          // attaches grammar-driven tokenizers to its models.
          if (codeEditorSvc) {
            try { codeEditorSvc.addCodeEditor(ed); irLog('addCodeEditor ok'); }
            catch(eAdd) { irLog('addCodeEditor err: '+(eAdd&&eAdd.message)); }
          }
          window.__irMonaco = { editor: ed, host: host, modelSvc: modelSvc, inst: insts[ii], ctor: ctor, uriCtor: uriCtor, codeEditorSvc: codeEditorSvc };
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
        uri = m.uriCtor.parse('file:///tmp/ir-tokenize/'+Date.now()+'-'+Math.random().toString(36).slice(2,6)+'.'+ext);
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
      }
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
    irLog('tokenize threw: '+(e&&e.message?e.message:String(e)));
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

function findTypeNames(text: string): string[] {
  const ids = text.match(/\b[A-Za-z_]\w*\b/g) || [];
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id) || SKIP_WORDS.has(id) || id.length <= 2) return false;
    seen.add(id);
    return true;
  });
}

// ── Go to definition handler ──

class AbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new AbortError(); }
}

async function goToTypeHandler(docUriStr: string, identifier: string) {
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

// Definition-like line patterns (class/interface/struct/def/fn etc.)
const DEF_PATTERN = /^\s*(export\s+)?(class|interface|struct|enum|type|def|fn|func|pub\s+struct|pub\s+enum|pub\s+fn)\s+/;
// Assignment-style definitions (e.g. MutableMapping = _alias(...), X = TypeVar(...))
const ASSIGN_DEF_PATTERN_PREFIX = /^[A-Z]/;

// ── Import-follow engine: resolve identifier by tracing import statements ──

// Scan a file for a definition of identifier.
// Priority: class/interface > function/method > const/let/var > field/property > assignment
function findDefInText(text: string, identifier: string, doc: vscode.TextDocument): vscode.Position | null {
  const escaped = esc(identifier);
  const patterns: RegExp[] = [
    // 1. Class-level: class X, interface X, type X, enum X, struct X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:class|interface|type|enum|struct)[ \\t]+${escaped}\\b`, 'm'),
    // 2. Function/method: def X, fn X, func X, function X, async def X, async function X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?(?:def|fn|func|function)[ \\t]+${escaped}\\b`, 'm'),
    // 3. Rust pub items: pub struct/enum/fn/type X
    new RegExp(`^[ \\t]*pub[ \\t]+(?:struct|enum|fn|type|const|static)[ \\t]+${escaped}\\b`, 'm'),
    // 4. const/let/var declaration: const X, let X, var X, export const X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escaped}\\b`, 'm'),
    // 5. Method signature (TS interface/class): X(... or X<T>(... at indented line
    new RegExp(`^[ \\t]+(?:readonly[ \\t]+)?${escaped}[ \\t]*[<(]`, 'm'),
    // 6. Field/property declaration: X: Type (indented, in class/interface body)
    new RegExp(`^[ \\t]+(?:readonly[ \\t]+)?${escaped}[ \\t]*[:?][ \\t]*\\w`, 'm'),
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
  const previewLoc = lastPreviewLocations.get(identifier);
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
      const fastHit = await fastResolveTypeName(identifier, originFsPath);
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

export function deactivate() {
  if (reinjectTimer) { clearInterval(reinjectTimer); }
  indexManager?.dispose();
  indexManager = null;
  log.info('Extension deactivated');
  log.dispose();
}
