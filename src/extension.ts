import * as vscode from 'vscode';
import * as inspector from 'node:inspector';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import WebSocket from 'ws';
import { IndexManager, IndexStatus } from './indexManager';
import type { SidecarHit, SidecarKind, SidecarLanguage } from './sidecar';
import {
  workspaceRootFsPath,
  isPythonFsPath,
  isSupportedFsPath,
  languageOf,
  TYPE_SHAPED_NAME,
  CONSTANT_SHAPED_NAME,
  IDENTIFIER_WORD_RE,
  IDENTIFIER_WORD_RE_G,
  identifierWordRegex,
  HOVER_NEARBY_SYMBOL_COLUMN_RADIUS,
  HOVER_NOISY_IDENTIFIER_MAX_LENGTH,
  IR_VTAIL_MODE,
  DEFINITION_PREVIEW_FALLBACK_LINES,
  DEFINITION_PREVIEW_SAFETY_MAX_LINES,
  DEFINITION_PREVIEW_VALUE_MAX_LINES,
  CODE_SCHEMES,
  isCodeDoc,
} from './util';
import {
  DefCacheEntry,
  DEF_CACHE_TTL,
  DEF_CACHE_NEG_TTL,
  DEF_CACHE_MAX_SIZE,
  defCacheKey,
  defCacheGet,
  defCacheSet,
  NOT_FOUND_NEG_TTL,
  NOT_FOUND_MAX,
  notFoundInDocsHas,
  notFoundInDocsRemember,
  CLICK_NEG_TTL,
  CLICK_NEG_MAX,
  previewClickDedupe,
  PREVIEW_CLICK_DEDUPE_MS,
  PREVIEW_CLICK_DEDUPE_MAX,
  clickNegGet,
  clickNegSet,
  clearClickNegCache,
  clearDefCache,
  invalidateDefCacheByPath,
} from './cache';
import {
  SKIP_WORDS,
  addNavigableName,
  declarationIdentifiersInLine,
  decoratorIdentifiersInLine,
} from './idents';
import {
  DefinitionPreview,
  TextLikeDocument,
  RawFileSnapshot,
  RAW_DEF_FILE_CACHE_MAX,
  rawDefFileCache,
  clearRawDefFileCache,
  evictRawDefFileCacheEntry,
  isPythonLikeDoc,
  indentationWidth,
  includeLeadingDefinitionDecorators,
  normalizePythonDecoratedDefinitionLine,
  textLikeLineDeclaresIdentifier,
  refineDefinitionLineForIdentifier,
  isPythonValueDefinitionLine,
  isBraceValueDefinitionLine,
  valueLineContinues,
  findValueDefinitionEndLine,
  findPythonHeaderEndLine,
  findPythonBlockEndLine,
  findBraceBlockEndLine,
} from './preview-engine';
import {
  PREVIEW_LOCATION_MAX_SIZE,
  lastPreviewLocations,
  lastPreviewDeclarationLocations,
  cappedPreviewLocationSet,
  cappedPreviewLocationGet,
  clearPreviewLocations,
  collectDefinitionPreview,
  rememberPreviewLocations,
  buildDefinitionPreviewResult,
  languageIdForFsPath,
  readRawFileSnapshot,
  buildDefinitionPreviewResultFromRawFile,
} from './preview-builder';
import {
  resolvePreviewMarkdownUri,
  parsePreviewMarkdownSource,
  declarationIndexInLine,
  registerPreviewMarkdownLocations,
} from './preview-markdown';
import {
  PosPreviewEntry,
  POS_PREVIEW_TTL,
  POS_PREVIEW_MAX,
  posPreviewGet,
  posPreviewSet,
  clearPosPreviewCache,
  invalidatePosPreviewCacheByPath,
} from './hover-state';
import {
  IR_DIRECT_HOVER_MARKER,
  HOVER_PREVIEW_SEPARATOR,
  normalizeHoverMarkdownForDedupe,
  splitHoverPreviewBlocks,
  hoverMarkdownCodeFenceKeys,
  hoverPreviewDedupeKeys,
  dedupeHoverPreviewBlocks,
} from './preview-dedupe';
import {
  HOVER_PREVIEW_DELIVERY_SUPPRESS_MS,
  HOVER_PREVIEW_DELIVERY_MAX,
  HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX,
  HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS,
  HOVER_PREVIEW_BLOCK_DELIVERY_MAX_GROUPS,
  HOVER_PREVIEW_BLOCK_DELIVERY_DEDUPE_ENABLED,
  HoverPreviewDeliveredBlockGroup,
  hoverPreviewDeliveries,
  hoverPreviewDeliveredBlocks,
  hoverPreviewPrimaryHandles,
  hoverFallbackPrimaryHandles,
  hoverFallbackPrimaryHandleAllowed,
  hoverPendingPrimaryHandleAllowed,
  clearHoverPreviewPrimaryHandles,
  hoverPreviewPrimaryHandleAllowed,
  hoverPreviewDeliveryKey,
  shouldSuppressHoverPreviewDelivery,
  pruneHoverPreviewDeliveredBlocks,
  filterDeliveredHoverPreviewBlocks,
  logHoverPreviewDeliverySuppressed,
  setHoverDeliverLogger,
  clearHoverDeliveryState,
} from './hover-deliver';
import {
  prefetchedDocs,
  schedulePrefetch,
  setPrefetchLogger,
  setPrefetchBackgroundResolver,
  clearPrefetchState,
  shutdownPrefetch,
} from './prefetch';
import {
  PreviewState,
  PreviewScrollState,
  PREVIEW_STATE_IDLE_TTL_MS,
  previewHistory,
  currentPreviewState,
  setCurrentPreviewState,
  scrollPendingFromDrill,
  setScrollPendingFromDrill,
  drillFlowInProgress,
  drillFlowEndedAt,
  markDrillFlowStart,
  markDrillFlowEnd,
  scheduleScrollRestoreHover,
  setPreviewHistoryLogger,
  setApplyPreviewStateAsHover,
} from './preview-history';
import {
  PendingPreviewHover,
  PREVIEW_HOVER_SUPPRESS_MS,
  PREVIEW_HOVER_SUPPRESS_MAX,
  PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE,
  PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE,
  pendingPreviewHover,
  previewHoverSuppressUntil,
  previewHoverSuppressKey,
  previewHoverSuppressCount,
  previewHoverWrongRequestLogCount,
  previewHoverDebugEvents,
  recordPreviewHoverDebug,
  hoverRequestUriKey,
  internalHoverRangeContains,
  internalRangeFromVsCode,
  pendingPreviewMatchesHoverRequest,
  previewStateMatchesHoverRequest,
  setPendingPreviewHover,
  setPreviewHoverSuppress,
  bumpPreviewHoverSuppressCount,
  bumpPreviewHoverWrongRequestLogCount,
} from './hover-pending';
import {
  rendererHoverFallbackTimers,
  nativeHoverRefireScheduledKeys,
  nativeHoverRefireLastAt,
  NATIVE_HOVER_REFIRE_SUPPRESS_MS,
  NativeHoverRefireAnchor,
  lastHoverFetchPosition,
  setLastHoverFetchPosition,
} from './native-refire';
import {
  resolveOverlayHoverAnchor,
  refireOverlayHover,
} from './overlay-hover-handshake';
import {
  withTimeout,
  ensureOpenDocIndex,
  findOpenDoc,
  registerOpenDocIndexListeners,
} from './common-utils';
import {
  setSidecarIndexManager,
  sidecarDefinitivelyMissing,
  sharedDirDepth,
  pickByProximity,
  ImportTarget,
  MODULE_IMPORT_TARGET,
  IMPORT_SCAN_MAX_LINES,
  workspaceRelPathForFsPath,
  sidecarHitRelPath,
  dedupeImportTargets,
  importScanText,
  isTsLikeRelPath,
  resolveRelativeModuleCandidates,
  importedNamesForLocalName,
  tsImportTargetsForIdentifier,
  pythonModuleCandidates,
  pythonImportTargetsForIdentifier,
  importTargetsForIdentifier,
  hitMatchesImportTarget,
  chooseSidecarHit,
  fastResolveTypeName,
} from './sidecar-resolve';
import {
  deriveUserDataDirHint,
  findCurrentVSCodeMainPid,
  httpGet,
  findInspectorWebSocketUrlForPid,
  setCdpDiscoveryLogger,
} from './cdp-discovery';
import {
  makeRendererEvalExpression,
  cdpRequest,
  findTestRendererWebSocketUrl,
  withRendererInputCdpSessionForTests,
  setCdpEvalLogger,
  setCdpEvalStaleMainSocketHandler,
  setCdpEvalEnv,
} from './cdp-eval';
import {
  RENDERER_PATCH_VERSION,
  getHoverPatchScript,
} from './renderer-patch';

const log = vscode.window.createOutputChannel('IntelliSense Recursion', { log: true });
setHoverDeliverLogger(log);
setPrefetchLogger(log);
setPrefetchBackgroundResolver(resolveInBackground);
setPreviewHistoryLogger(log);
setApplyPreviewStateAsHover(applyPreviewStateAsHover);
setCdpDiscoveryLogger(log);
setCdpEvalLogger(log);
setCdpEvalStaleMainSocketHandler((ws, method) => {
  if (ws === mainWsRef && method !== 'Input.dispatchMouseEvent') {
    log.warn(`[cdp] ${method} timed out; dropping stale renderer CDP socket`);
    closeMainWebSocket();
  }
});
setCdpEvalEnv({
  getMainSocket: () => ({ ws: mainWsRef, isRendererTarget: mainWsRefIsRendererTarget }),
  isTestMode: () => isTestRendererDebugMode(),
  rememberTestRendererUrl: (url) => { testRendererWebSocketUrlRef = url; },
});

// ── Rust sidecar fast-path manager (Phase 3) ──
// Null when no workspace or binary missing; all callers guard on this.
let indexManager: IndexManager | null = null;

/**
 * Ask the sidecar for the best definition of `typeName` and return it only
 * when the answer is unambiguous.
 *
 * Heuristic: exactly one non-alias hit across all kinds. If two or more
 * non-aliases exist (e.g. `Meta` defined in many Django models, `created_at`
 * on many models) we return null and let the LSP path disambiguate via type
 * inference.
 */

// sidecar resolution helpers + fastResolveTypeName moved to
// ./sidecar-resolve (Phase 6 split). IndexManager wired via
// setSidecarIndexManager() during activate().

// Definition preview interfaces + structural helpers moved to
// ./preview-engine (Phase 3b split). The rawDefFileCache lives there too.

// Preview builders + per-identifier preview-location maps moved to
// ./preview-builder (Phase 4 split). buildResultFromFastHit stays here
// because it still needs `log`, `findOpenDoc`, and `withTimeout`.

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

// PREVIEW_LOCATION_MAX_SIZE, lastPreviewLocations,
// lastPreviewDeclarationLocations, cappedPreviewLocationSet/Get moved to
// ./preview-builder (Phase 4 split).
let lastHoverDocUri = '';
let hoverRecursionDepth = 0;
let reinjectTimer: ReturnType<typeof setInterval> | undefined;
let rendererReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let rendererInjectInFlight: Promise<void> | null = null;
// Native-hover refire scheduling state moved to ./native-refire (Phase 14 split).
let rendererHoverFallbackLogCount = 0;
let extensionDeactivated = false;
let extensionRunsInTestMode = false;
let rendererUserDataDirHint: string | null = null;
let mainWsRefIsRendererTarget = false;
let testRendererWebSocketUrlRef: string | null = null;
let mainWsRefTargetUrl: string | null = null;
// lastTestRendererTargetLogSignature moved to ./cdp-eval (Phase 15b split).
let lastClickId = '';
let lastClickTime = 0;
// A new click aborts an in-flight click via this controller.
let currentClickController: AbortController | null = null;
let hoverPatchActive = false;
// Current main-process CDP WebSocket, tracked so reconnect cleanup only
// clears the listener that originally owned the socket.
let mainWsRef: WebSocket | null = null;

// NativeHoverRefireAnchor interface moved to ./native-refire (Phase 14 split).

// Preview-markdown helpers moved to ./preview-markdown (Phase 5 split).

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

// Pending-preview hover state machine + small range helpers moved to ./hover-pending (Phase 13).

// lastHoverFetchPosition state moved to ./native-refire (Phase 14 split).

// Drill-down history state machine + scroll-restore scheduler moved to ./preview-history (Phase 12).

// Caches moved to ./cache (Phase 2 split).
// Re-import the symbols this file still uses below.
// PREVIEW_DIRECT_RENDERER_APPLY stays local — it's a behaviour flag for
// applyPreviewStateAsHover, not a cache.
const PREVIEW_DIRECT_RENDERER_APPLY = true;

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
// IR_DIRECT_HOVER_MARKER + HOVER_PREVIEW_SEPARATOR + dedupe helpers moved
// to ./preview-dedupe (Phase 8 split).

const inflightResolves = new Map<string, Promise<DefCacheEntry['result']>>();
let internalHoverProviderRequestDepth = 0;

// withTimeout moved to ./common-utils (Phase 9 split).
// open-document index (ensureOpenDocIndex/findOpenDoc/registerOpenDocIndexListeners) moved to ./common-utils (Phase 9 split).

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
              log.trace(`[bg]   "${typeName}" → fast def ${fastHit.path}:${fastHit.line} lines=${entry.previewLineCount ?? '?'} md=${entry.preview.length} (${Date.now() - t0}ms)`);
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
// PosPreviewEntry + posPreviewCache + posPreviewGet/Set moved to
// ./hover-state (Phase 7 split).
// hover-preview delivery dedupe machinery moved to ./hover-deliver (Phase 10 split).

// ── (E) In-flight hover preview dedup (per-position) ──
// When VS Code calls $provideHover for multiple handles at the same position,
// the first handle computes and later handles await the same promise.
const inflightHoverPreviews = new Map<string, Promise<{ typesKey: string; previews: string } | null>>();

// (B) Document-open prefetch infrastructure moved to ./prefetch (Phase 11 split).

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
  const re = IDENTIFIER_WORD_RE_G;
  re.lastIndex = 0;
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

// internalRangeFromVsCode moved to ./hover-pending (Phase 13).

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
  // DISABLED: this separate registered provider caused our preview
  // content to appear in front of other extensions' (e.g., Pylance)
  // hover content in the same combined panel. VS Code shows registered
  // providers' results side-by-side in registration order, so our
  // result always took the top slot for lowercase / snake_case symbols.
  //
  // The $provideHover wrap (line ~2724) already attaches our preview
  // to other extensions' hover content via append-after, which gives
  // the right ordering (native content first, then our enhancement).
  // For symbols where no other extension provides hover content, the
  // wrap path also returns a content-only result without prepending.
  //
  // Net effect of disabling: lowercase symbols that previously got OUR
  // standalone preview now show only what the language server returns —
  // matching user expectation that our content enhances rather than
  // replaces native hover output.
  return null;
}

// schedulePrefetch moved to ./prefetch (Phase 11 split).

/**
 * Drop every in-memory hover-side cache. Called by the hard-rebuild path so a
 * user reaching for "Rebuild (Clear Cache)" actually gets a clean slate —
 * stale defCache / posPreviewCache entries can otherwise mask a freshly
 * rebuilt index.
 */
function clearAllExtensionCaches() {
  clearDefCache();
  clearPosPreviewCache();
  clearHoverDeliveryState();
  setPendingPreviewHover(null);
  setPreviewHoverSuppress(0, null, 0);
  previewHistory.length = 0;
  setCurrentPreviewState(null);
  previewClickDedupe.clear();
  clearRawDefFileCache();
  clearClickNegCache();
  clearPrefetchState();
  clearPreviewLocations();
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
  setSidecarIndexManager(indexManager);
  if (indexManager.isAvailable()) {
    indexManager.registerWatchers(context);
    setupStatusBar(context, indexManager);
    indexManager.start().catch((err) => log.warn(`[ir] start error: ${err}`));
  } else {
    log.info('[ir] sidecar unavailable; running in LSP-only mode');
  }
  context.subscriptions.push({ dispose: () => indexManager?.dispose() });

  registerOpenDocIndexListeners(context);

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
      const fsPath = savedDoc.uri.fsPath;
      invalidateDefCacheByPath(fsPath);
      invalidatePosPreviewCacheByPath(fsPath);
      evictRawDefFileCacheEntry(fsPath);
      // Any new save may have added a definition the prior scan missed.
      clearClickNegCache();
      // Allow prefetch to run again on next activation of this doc
      prefetchedDocs.delete(fsPath);
    }),
    // (B) Prefetch on active editor change — warms def cache for visible docs
    vscode.window.onDidChangeActiveTextEditor(editor => {
      schedulePrefetch(editor?.document);
    }),
    // (C) Restore drill hover after the editor scrolls. VS Code dismisses
    // the hover on every scroll event (default behavior); when a drill
    // session is active we re-fire applyPreviewStateAsHover so the
    // drilled content reappears at the symbol's new screen position
    // instead of leaving the user looking at a dead viewport. Debounced
    // so it doesn't run on every micro-scroll frame.
    vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      // Scroll-restore: re-fire applyPreviewStateAsHover when the
      // editor scrolls while a drill session is active. Gated by:
      //   1. an active currentPreviewState
      //   2. the anchor's URI matches the scrolled editor's
      //   3. the anchor line is still inside the visible range
      //   4. the user actually scrolled — verified via
      //      onDidChangeTextEditorSelection NOT having fired in the
      //      same tick. (Drill flows ALSO change the visible range
      //      because refireHoverAtAnchor moves the cursor; we mustn't
      //      mistake those for user scrolls.)
      if (!currentPreviewState) { return; }
      const stateAnchorUri = currentPreviewState.anchor.uri.toString();
      const eventUri = event.textEditor.document.uri.toString();
      if (eventUri !== stateAnchorUri) { return; }
      const anchorLine = currentPreviewState.anchor.line;
      const stillVisible = event.visibleRanges.some(range =>
        range.start.line <= anchorLine && range.end.line >= anchorLine);
      if (!stillVisible) { return; }
      // If the drill flow is mid-execution (refireHoverAtAnchor moves
      // the cursor, firing this listener), don't restore now — but
      // remember we saw a scroll so markDrillFlowEnd can flush after
      // the drill settles.
      if (drillFlowInProgress) {
        setScrollPendingFromDrill(true);
        return;
      }
      const sinceEnd = Date.now() - drillFlowEndedAt;
      if (sinceEnd < 400) {
        // Within the post-drill guard — schedule a retry after it
        // expires. (markDrillFlowEnd's own flush only catches scrolls
        // that arrived BEFORE the drill ended; this branch covers
        // scrolls that arrive shortly after.)
        const wait = 400 - sinceEnd + 80;
        setTimeout(() => {
          if (currentPreviewState) { scheduleScrollRestoreHover(); }
        }, wait);
        return;
      }
      scheduleScrollRestoreHover();
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
        'intellisenseRecursion.requestNativeShowHoverForTests',
        (reason?: string) => requestNativeShowHoverFromRendererPointer(String(reason || 'test-command')),
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.refireHoverAtAnchorForTests',
        refireHoverAtAnchor,
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
        'intellisenseRecursion.runHoverBoxCornerHarnessForTests',
        runHoverBoxCornerHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverGeometrySnapshotForTests',
        runHoverHoverGeometrySnapshotForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.drainHoverEventLogForTests',
        async () => {
          try {
            if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
              return { ok: false, reason: 'no-renderer-channel' };
            }
            const expr = '(window.__irHEDrain && window.__irHEDrain()) || {ok:false,reason:"no-drain"}';
            const result = await evaluateInMainProcessForTests(
              rendererTestWindowEvalExpression(expr, true),
              4000,
            );
            return result;
          } catch (err) {
            return { ok: false, reason: String((err as Error)?.message || err) };
          }
        },
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.getHoverPatchStatusForTests',
        async () => {
          try {
            if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
              return { ok: false, reason: 'no-renderer-channel' };
            }
            const expr = '(window.__irGetPatchStatus && window.__irGetPatchStatus()) || {ok:false,reason:"no-getter"}';
            const result = await evaluateInMainProcessForTests(
              rendererTestWindowEvalExpression(expr, true),
              4000,
            );
            return result;
          } catch (err) {
            return { ok: false, reason: String((err as Error)?.message || err) };
          }
        },
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.clearHoverEventLogForTests',
        async () => {
          try {
            if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
              return { ok: false, reason: 'no-renderer-channel' };
            }
            const expr = '(window.__irHEClear && window.__irHEClear()) || {ok:false,reason:"no-clear"}';
            const result = await evaluateInMainProcessForTests(
              rendererTestWindowEvalExpression(expr, true),
              2000,
            );
            return result;
          } catch (err) {
            return { ok: false, reason: String((err as Error)?.message || err) };
          }
        },
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
        runHoverSeedPreviewHarnessForTests,
      ),
      vscode.commands.registerCommand(
        'intellisenseRecursion.resetPreviewStateForTests',
        async () => {
          try { await setRendererDrillMode(false); } catch {}
          try {
            if (mainWsRef && mainWsRef.readyState === WebSocket.OPEN) {
              const expr = '(window.__irClearAnchorSession && window.__irClearAnchorSession()) || {ok:false}';
              await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(expr, true), 1500);
            }
          } catch {}
          setPendingPreviewHover(null);
          setPreviewHoverSuppress(0, null, 0);
          hoverPreviewDeliveries.clear();
          hoverPreviewDeliveredBlocks.clear();
          clearHoverPreviewPrimaryHandles();
          previewHistory.length = 0;
          setCurrentPreviewState(null);
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
    // Low-frequency safety pass for renderer windows that open after our
    // initial injection. Used to be every 60s, which was constant Node↔CDP
    // chatter and re-evaluation of the ~25KB injection bundle for no real
    // gain in steady state. Dropping to 5 minutes still catches new
    // windows quickly enough — and the WebSocket-close handler already
    // schedules an immediate reconnect+reinject when the renderer
    // actually goes away.
    reinjectTimer = setInterval(() => {
      runRendererInjection(reinjectRenderer).catch(() => {});
    }, 300000);
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

// L87 (2026-05-30): virtual-tail content channel for large hovers (custom scroller).
// STEP 1 — channel proof. When a preview is large, stash the FULL markdown into a
// renderer global via CDP (window.__irPreviewStash[id]) and PREPEND a detectable
// text marker. The preview is still returned WHOLE here (no perf change yet); this
// only proves the ext->renderer content channel + that the marker survives VS Code's
// markdown renderer and is found by renderer-patch, BEFORE step 2 head-splits to send
// VS Code just the head. Single main-renderer (mainWsRef) path; multi-window later.
// Ext-host change → needs a window reload to take effect.
// L88 (2026-05-31): vtail mode switch — the overlay work is preserved, native is added.
// 'overlay' = head-split + windowed virtual scroller (fast, but the custom overlay fights the
// reused-hover lifecycle and drilled/force-preview hovers bypass it). 'native' = send the FULL
// preview to VS Code's native hover (stable, highlighted, and our scan makes it drillable
// everywhere — drill chains included), accepting the native render cost. IR_VTAIL_MODE is
// imported from ./util (shared with preview-builder, which skips the L84 split in native mode).
let irVtailModeLogged = false;
const IR_VTAIL_THRESHOLD = 8000;
let irVtailCounter = 0;
async function irStashLargePreviewForChannelTest(previews: string): Promise<string> {
  try {
    if (IR_VTAIL_MODE === 'native') {
      if (!irVtailModeLogged) { irVtailModeLogged = true; log.info('[hover] vtail mode=native (overlay disabled; full native render + scan drill)'); }
      return previews;   // native: VS Code renders the full preview; the scan wraps drill links
    }
    if (!previews || previews.length < IR_VTAIL_THRESHOLD) { return previews; }
    if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return previews; }
    const id = 'v' + (++irVtailCounter);
    // L87 step 2 — head-split. L84 (renderPreviewCodeFences) emits a large code preview as a
    // head fence (highlighted) + a "```\n```\n" boundary + a plain tail fence. Send VS Code ONLY
    // the head (tiny → instant sync render); stash the plain TAIL TEXT and let the renderer append
    // it as a plain <pre> OFF the sync path (idle). No boundary (small or multi-block preview) =>
    // no split: stash the whole thing, render unchanged (mode=full).
    // L123 (2026-06-01): tail fence is now ```plaintext (was empty ```) — see renderPreviewCodeFences.
    // This managed-mode vtail stash path is dead in native (returns early above), but keep its
    // boundary detection in sync so re-enabling overlay mode still head-splits correctly.
    const VTAIL_BOUNDARY = '```\n```plaintext\n';
    const boundaryIdx = previews.indexOf(VTAIL_BOUNDARY);
    let headToSend = previews;
    let stashContent = previews;
    let mode = 'full';
    if (boundaryIdx >= 0) {
      headToSend = previews.slice(0, boundaryIdx + 3); // through the head fence's closing ```
      const afterHead = previews.slice(boundaryIdx + 3); // "\n```plaintext\n<TAIL>\n```" (+ maybe trailing blocks)
      const tOpen = afterHead.indexOf('```plaintext\n');
      if (tOpen >= 0) {
        const tStart = tOpen + '```plaintext\n'.length;
        const tEnd = afterHead.lastIndexOf('\n```');
        const tail = (tEnd > tStart) ? afterHead.slice(tStart, tEnd) : afterHead.slice(tStart);
        if (tail.length > 0) { stashContent = tail; mode = 'split'; }
      }
    }
    // mainWsRef is the MAIN-PROCESS inspector socket in production (findInspectorWebSocketUrlForPid),
    // so window.* there is the main process, NOT a renderer. v240 used webContents.executeJavaScript and
    // the stash was invisible to the patch (stashLen:-1) — executeJavaScript runs in a DIFFERENT world.
    // The patch is injected, and __irHostWindowMeta is pushed, via webContents.debugger.sendCommand(
    // 'Runtime.evaluate') (extension.ts ~2267/2271) and the patch reads those globals — so that is the
    // patch's world. Use the same channel. In the test path mainWsRef IS the renderer (eval directly).
    // awaitPromise so the stash lands before we return the head (renderer reads it when the marker renders).
    const rendererCode = `try{window.__irPreviewStash=window.__irPreviewStash||{};window.__irPreviewStash[${JSON.stringify(id)}]=${JSON.stringify(stashContent)};}catch(_){}`;
    // L87 diag: v240 (executeJavaScript) and v241 (debugger.sendCommand) BOTH showed the patch
    // reading stashLen:-1. Return a diagnostic so we know WHY: wins=window count, att=#with
    // debugger attached, sent=#sendCommand-evaluate succeeded, rb=Object.keys(__irPreviewStash)
    // length AS SEEN BY the sendCommand execution context. If rb>=1 but the patch reads -1 =>
    // execution-WORLD mismatch (the patch runs in a different context than debugger's default).
    const diagExpr = `(async function(){var d={wins:0,att:0,sent:0,rb:-2,errs:[]};try{var BW=require('electron').BrowserWindow;var c=${JSON.stringify(rendererCode)};var ws=BW.getAllWindows();d.wins=ws.length;for(var i=0;i<ws.length;i++){var w=ws[i];try{var a=!!(w&&w.webContents&&w.webContents.debugger&&w.webContents.debugger.isAttached());if(a){d.att++;await w.webContents.debugger.sendCommand('Runtime.evaluate',{expression:c,returnByValue:true});d.sent++;var r=await w.webContents.debugger.sendCommand('Runtime.evaluate',{expression:'(window.__irPreviewStash?Object.keys(window.__irPreviewStash).length:-1)',returnByValue:true});d.rb=(r&&r.result&&typeof r.result.value!=='undefined')?r.result.value:-3;}}catch(e){d.errs.push(String(e&&e.message||e).slice(0,60));}}}catch(e){d.errs.push('o:'+String(e&&e.message||e).slice(0,60));}return JSON.stringify(d);})()`;
    const expr = mainWsRefIsRendererTarget ? rendererCode + ';1' : diagExpr;
    let diag: any = '(none)';
    // includeCommandLineAPI:true is what exposes `require` in this Electron main-process
    // inspector context — the patch-injection eval passes it (2056/2295/2491); v242 omitted it
    // and the stash script died with "require is not defined" (diag wins:0). Match the injection.
    try { const res = await cdpRequest(mainWsRef, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }, 2500); diag = res?.result?.value; } catch (e) { diag = 'cdp-err:' + String(e).slice(0, 80); }
    log.info(`[hover] vtail stash id=${id} mode=${mode} stashLen=${stashContent.length} headLen=${headToSend.length} fullLen=${previews.length} diag=${diag} (L87)`);
    if (mode === 'split') {
      // Send VS Code just the head + the marker; the renderer renders the stashed tail. Marker
      // PREPENDED (top, on-screen) so the viewport-gated scan detects it — appended would sit below
      // the head fence (off-screen) and never be scanned.
      return '`IRVTAIL:' + id + ':' + stashContent.length + ':split`\n\n' + headToSend;
    }
    return '`IRVTAIL:' + id + ':' + previews.length + ':full`\n\n' + previews;
  } catch (err) {
    log.warn(`[hover] vtail stash failed: ${err}`);
    return previews;
  }
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
    // L85 (2026-05-30): is the large hover content OURS or NATIVE? 3 v=237 captures
    // showed ~59K hovers (demo_company_service) with NO source-block build log →
    // the bloat may be the native LSP hover, which L84 (our-preview fence split)
    // cannot touch. native = existing LSP content len, ours = our deduped preview
    // len, blocks = our block count, split = count of L84 head/tail splits engaged.
    // Retire once ours-vs-native is settled.
    try {
      const splitCount = (dedupedPreviews.match(/```\n```/g) || []).length;
      log.info(`[hover] attach native=${existingText.length} ours=${dedupedPreviews.length} blocks=${previewBlocks.length} split=${splitCount}`);
    } catch { /* diag must never break the hover */ }
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
      setLastHoverFetchPosition({ uri: vscode.Uri.parse(docUriStr2), line: apiL, character: apiC });
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
      // Log only the first matching handle in a multi-handle fanout — we
      // still return the preview content for every handle (VS Code may
      // render a later one), but logging each duplicates output 5–7× per
      // drill. matchCount was just incremented above.
      if (preview.matchCount === 1) {
        log.info(`[hover] page-transition handle=${handle} → "${preview.identifier}"`);
      }
      // L111 (2026-06-01): deliver the drill content for ONE handle only.
      // VS Code fans the showHover out to every registered provider handle and,
      // in native mode (no renderer management layer to collapse duplicates),
      // renders each returned result as its own hover-row. Returning
      // preview.contents for every handle stacked a 1657-line class 5× (59K→295K)
      // and re-tokenized/re-laid-out the widget O(N²) — 11.5s of main-thread
      // longtasks (412→4134ms), and the page-transition expired mid-render. Gate
      // by primary handle exactly like the normal-hover (hoverPreviewPrimaryHandle
      // Allowed) and currentPreviewState-fallback (hoverFallbackPrimaryHandleAllowed)
      // paths. The pending stays alive (not consumed), so whichever handle wins the
      // primary slot is the single one that paints; the rest return null and VS Code
      // merges them in without adding duplicate rows. cf. project_hover_rerender_*,
      // project_native_hover_only_switch memories.
      if (!hoverPendingPrimaryHandleAllowed(hoverRequestKey, handle)) {
        return null;
      }
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
      setPendingPreviewHover(null);
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
      setPendingPreviewHover(null);
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
      bumpPreviewHoverWrongRequestLogCount();
      log.info(`[hover] page-transition pending "${pendingPreviewHover.identifier}" ignored non-anchor request ${requestUriKey}:${requestLine}:${requestChar}`);
      recordPreviewHoverDebug({ kind: "pending-ignored", identifier: pendingPreviewHover.identifier, requestUriKey, requestLine, requestChar, anchorLine: pendingPreviewHover.anchorLine, anchorCharacter: pendingPreviewHover.anchorCharacter });
      return null;
    } else if (pendingPreviewHover) {
      return null;
    }
    // currentPreviewState fallback: when pendingPreviewHover has been
    // consumed/expired but the user is still interacting with the drilled
    // hover, VS Code may re-query the provider (e.g. mouse hover over the
    // hover widget's edge). Without this fallback the provider returns null
    // and VS Code dismisses the drilled hover. As long as currentPreviewState
    // anchors the same position the user is asking about, keep serving its
    // contents so the drill session survives idle/edge interactions.
    if (currentPreviewState
      && previewStateMatchesHoverRequest(currentPreviewState, requestUriKey, requestLine, requestChar)) {
      // Idle expiry: if the drill state hasn't been touched within
      // PREVIEW_STATE_IDLE_TTL_MS, the user mouse-out'd long enough ago
      // that this should be treated as a fresh hover session — drop the
      // state and fall through to the LSP path. Without this, hovering
      // the same symbol later replays the last drill state.
      const lastAct = currentPreviewState.lastActivityAt ?? 0;
      if (lastAct && Date.now() - lastAct > PREVIEW_STATE_IDLE_TTL_MS) {
        log.info(`[hover] drill state idle-expired (was at "${currentPreviewState.identifier}", idle=${Date.now() - lastAct}ms) — falling through to LSP`);
        previewHistory.length = 0;
        setCurrentPreviewState(null);
      } else {
      // Dedupe across parallel hover providers. VS Code fans the same
      // request out to every registered hover provider; each one hits
      // this branch. Without dedupe the same fallback markdown gets
      // returned 7+ times per request (the log showed 7 "fallback"
      // messages on a single drilled hover). Uses a SEPARATE primary-
      // handle map from the pending-preview path to avoid stealing
      // each other's slot.
      const fallbackPrimary = hoverFallbackPrimaryHandleAllowed(hoverRequestKey, handle);
      if (!fallbackPrimary) {
        return null;
      }
      // Refresh activity timestamp so the state stays alive while user
      // actively interacts with the drilled hover.
      currentPreviewState.lastActivityAt = Date.now();
      const ln = position?.lineNumber !== undefined ? position.lineNumber : (position?.line !== undefined ? position.line + 1 : 1);
      const col = position?.column !== undefined ? position.column : (position?.character !== undefined ? position.character + 1 : 1);
      const pointRange = { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col };
      const fallbackMarkdown = '[← Back](command:intellisenseRecursion.previewBack)\n\n'
        + currentPreviewState.markdown.replace(/^\s*\[← Back\]\(command:intellisenseRecursion\.previewBack\)\s*/, '');
      recordPreviewHoverDebug({
        kind: 'current-state-fallback',
        identifier: currentPreviewState.identifier,
        requestUriKey, requestLine, requestChar,
      });
      log.info(`[hover] currentPreviewState fallback → "${currentPreviewState.identifier}" (pending expired/consumed)`);
      return {
        contents: [{ value: fallbackMarkdown, isTrusted: true, supportThemeIcons: true }],
        range: internalRangeFromVsCode(currentPreviewState.anchorRange) ?? pointRange,
      };
      } // close idle-fresh else
    }
    // Suppression branch: parallel handles in the same showHover fanout return
    // null so the override isn't duplicated across providers and an empty
    // hover object cannot replace the populated one.
    if (Date.now() < previewHoverSuppressUntil
      && previewHoverSuppressKey === hoverRequestKey
      && previewHoverSuppressCount < PREVIEW_HOVER_SUPPRESS_MAX) {
      bumpPreviewHoverSuppressCount();
      log.info(`[hover] page-transition handle=${handle} suppressed (in window)`);
      return null;
    }
    if (Date.now() >= previewHoverSuppressUntil || previewHoverSuppressKey !== hoverRequestKey) {
      setPreviewHoverSuppress(0, null, 0);
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
        setCurrentPreviewState(null);
        // Fresh hover at a different anchor — release frozen position so
        // the new hover paints at its own location instead of the prior
        // session's frozen anchor.
        // Drill mode auto-clears in the renderer when the next hover content
  // arrives without the [← Back] link.
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
    // L102 (2026-05-31): key preview-delivery dedup by the WORD-anchored posKey,
    // not the exact-char hoverRequestKey. Intra-word mouse drift changes the char and
    // VS Code re-calls $provideHover; an exact-char key made every drift a NEW delivery
    // group -> re-deliver -> delivered content oscillated 57638<->59293 -> VS Code
    // re-rendered the ~58997-char preview (1164ms tokenize + renderer scan storm). The
    // word-anchored key folds all drift within one word into one delivery group, so
    // delivery stays consistent. The renderer already fixed the same range-vs-column
    // bug on its side (L71); this is the extension-side analog.
    // cf. project_hover_rerender_exact_position_key memory.
    const deliveryGroupKey = posKey;
    if (hoveredCandidate) {
      setLastHoverFetchPosition({
        uri: docUri,
        line: hoveredCandidate.anchor.line,
        character: hoveredCandidate.anchor.character,
      });
    }
    const hoveredInternalRange = hoveredCandidate
      ? internalRangeFromVsCode(hoveredCandidate.range)
      : internalFullWordRangeAt(hoverDocForCandidate, hoverApiPos);

    const result = await original.call(this, handle, uri, position, context, token);
    const postNativeT0 = Date.now();
    if (hoverResultText(result).includes(IR_DIRECT_HOVER_MARKER)) { return result; }
    const primaryHoverHandle = hoveredCandidate
      ? hoverPreviewPrimaryHandleAllowed(posKey, handle)   // L102: word-anchored key (same rationale as deliveryGroupKey) so intra-word drift keeps one stable primary handle instead of re-allocating per char
      : true;
    if (!result?.contents?.length && hoveredCandidate && !primaryHoverHandle) {
      return null;
    }
    if (!result?.contents?.length && !hoveredCandidate) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    const returnWithNativeFallback = (value: any, _source: string): any => {
      // native-only: VS Code's HoverProvider already returned the markdown and
      // VS Code's own hover widget will render it. No renderer-side fake DOM,
      // no refire scheduling — the native hover is "our" hover.
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
    // Position-only inflight key. Multiple handles at the same (uri, pos)
    // — VS Code dispatches one per registered language server — may produce
    // slightly different result.contents (and hence different typesKey),
    // but they're all hovering the same identifier, so let them share the
    // preview computation rather than each running it independently.
    const inflightKey = posKey;

    // (A) Position-level preview cache — short-circuits everything below for
    // repeated hovers at the same point with the same extracted types.
    const cachedPreviews = posPreviewGet(posKey, typesKey);
    if (cachedPreviews) {
      // L45: trace level — frequent hot-path event. Per-hover paint
      // produces this for every cached repeat. info-level callers can
      // re-enable by setting the output channel logLevel to Trace.
      log.trace(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} POS-CACHE hit (${hoverMs()})`);
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
        // L45: trace level — frequent multi-handle dedup event.
        log.trace(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} INFLIGHT attached (${hoverMs()}, post=${postNativeMs()})`);
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
          // L14: position-independent negative cache short-circuit. Avoids
          // the doc-wide regex + resolvedDefDocs walk for typeNames that
          // were not findable in this docUri within NOT_FOUND_NEG_TTL —
          // dominant cases are styled-components / Apollo codegen types.
          if (notFoundInDocsHas(docUri, typeName)) {
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
              const negPos = hoveredAnchor ?? hoverApiPos;
              defCacheSet(defCacheKey(docUri, negPos, typeName), null);
              notFoundInDocsRemember(docUri, typeName);
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
      // L45: trace level — fires for every hover paint. Re-enable at
      // logLevel=Trace if diagnosing preview build behaviour.
      log.trace(`[hover] previews built count=${previewsOut.length} md=${previews.length} (${hoverMs()})`);
      return { typesKey, previews };
    };

    const computePromise = runCompute();
    inflightHoverPreviews.set(inflightKey, computePromise);
    hoverRecursionDepth++;
    try {
      const computed = await computePromise;
      if (computed) {
        posPreviewSet(posKey, computed.typesKey, computed.previews);
        // L45: trace level — once-per-paint completion marker.
        log.trace(`[hover] done: first-hover preview attached md=${computed.previews.length} (${hoverMs()}, post=${postNativeMs()})`);
        const deliverPreviews = await irStashLargePreviewForChannelTest(computed.previews);
        return returnWithNativeFallback(attachPreviewsOnce(
          result,
          deliverPreviews,
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

// RENDERER_PATCH_VERSION + getHoverPatchScript moved to ./renderer-patch
// (Phase 16 split). The template literal is opaque ~10500-line JS-in-string;
// keeping it in its own file shrinks extension.ts and isolates the L48~L61
// hover stability surface.

// ProcessRow + listProcessRows + isVSCodeMainProcessCommand +
// deriveUserDataDirHint + commandHasUserDataDir + findCurrentVSCodeMainPid
// moved to ./cdp-discovery (Phase 15a split). findCurrentVSCodeMainPid now
// takes { userDataDirHint, testMode } so the helper stays pure; callers below
// pass the local module state.

// makeRendererEvalExpression + cdpRequest + findTestRendererWebSocketUrl +
// withRendererInputCdpSessionForTests moved to ./cdp-eval (Phase 15b split).
// Stale-main-socket cleanup + main-socket / test-mode access are wired in via
// setCdpEvalStaleMainSocketHandler + setCdpEvalEnv at module load.

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

// L112 (2026-06-01): how many extra discovery rounds to run before giving up to the
// 5-minute reinject safety timer. The renderer's V8 inspector occasionally takes longer
// than the initial 500ms to start listening after SIGUSR1 (window-reload race);
// without these retries a single miss leaves the renderer patch uninjected for
// up to 5 minutes (drill/scan dead). cf. 2026-06-01 10:46 injection failure.
const IR_INJECT_DISCOVERY_RETRIES = 4;

async function injectRenderer() {
  if (isTestRendererDebugMode()) {
    await injectRendererViaTestRemoteDebugging();
    return;
  }
  try {
    if (extensionDeactivated) { return; }
    log.info('[inject] Starting renderer injection...');
    const mainPid = findCurrentVSCodeMainPid({
      userDataDirHint: rendererUserDataDirHint,
      testMode: extensionRunsInTestMode,
    });
    if (!mainPid) {
      log.warn('[inject] Could not identify current VS Code main process');
      return;
    }
    log.info(`[inject] Main process PID: ${mainPid}`);

    process.kill(mainPid, 'SIGUSR1');
    log.info('[inject] SIGUSR1 sent, waiting for inspector...');
    await new Promise(r => setTimeout(r, 500));

    // The renderer's V8 inspector can take longer than 500ms to start listening
    // after SIGUSR1 — especially right after a window reload, when the renderer
    // process is still coming up. A single miss here used to fall straight
    // through to the 5-minute reinject safety timer (setInterval in activate),
    // leaving the renderer patch UNINJECTED: hovers still render (ext-host
    // $provideHover is patched) but nothing wraps type-links or handles drill
    // clicks, so drill silently dies for minutes. Observed 2026-06-01 10:46 —
    // "no inspector WebSocket matched main PID" once on reload and drill was dead
    // for the rest of the session. Retry discovery a few times with backoff,
    // re-arming the inspector each round in case the first SIGUSR1 raced ahead of
    // Electron's handler. SIGUSR1 is idempotent (re-sending when the inspector is
    // already open is a no-op).
    let wsUrl = await findInspectorWebSocketUrlForPid(mainPid);
    for (let attempt = 1; !wsUrl && attempt <= IR_INJECT_DISCOVERY_RETRIES; attempt++) {
      if (extensionDeactivated) { return; }
      const backoffMs = 500 * attempt;
      log.warn(`[inject] inspector not found yet (attempt ${attempt}/${IR_INJECT_DISCOVERY_RETRIES}) — re-arming + waiting ${backoffMs}ms`);
      try { process.kill(mainPid, 'SIGUSR1'); } catch {}
      await new Promise(r => setTimeout(r, backoffMs));
      wsUrl = await findInspectorWebSocketUrlForPid(mainPid);
    }
    if (!wsUrl) {
      log.warn('[inject] No matching CDP WebSocket URL found');
      return;
    }
    log.info('[inject] inspector found, injecting renderer patch');
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
    const mainPid = findCurrentVSCodeMainPid({
      userDataDirHint: rendererUserDataDirHint,
      testMode: extensionRunsInTestMode,
    });
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
          void requestNativeShowHoverFromRendererPointer(reason || 'renderer-binding')
            .then(result => {
              log.info(`[renderer] native show hover requested${reason ? ` ${reason}` : ''} ${JSON.stringify({
                ok: result?.ok,
                mode: result?.mode,
                reason: result?.reason,
                token: result?.token,
                pointerFresh: result?.pointerFresh,
                commandFallback: result?.commandFallback,
              })}`);
            })
            .catch(err => {
              log.warn(`[renderer] native show hover request failed${reason ? ` ${reason}` : ''}: ${err}`);
            });
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

async function readRendererNativeHoverPointerState(reason: string): Promise<any> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: 'renderer-cdp-not-open' };
  }
  const rendererExpr = `
    (function() {
      try {
        var now = Date.now();
        var request = window.__irNativeShowHoverRequest || null;
        var requestFresh = !!(request && request.at && now - request.at < 5000);
        var pointer = requestFresh && request.pointer ? request.pointer : (window.__irLastPointer || null);
        var ageMs = pointer && pointer.at ? now - pointer.at : null;
        var pointerFresh = !!(pointer && pointer.at && ageMs >= 0 && ageMs < 5000
          && typeof pointer.x === 'number' && typeof pointer.y === 'number');
        if (!pointerFresh) {
          return {
            ok: false,
            mode: 'pointer-state',
            reason: 'no-fresh-renderer-pointer',
            requestFresh: requestFresh,
            pointerAgeMs: ageMs,
            patchVersion: Number(window.__irPatchVersion) || 0
          };
        }
        var x = Math.max(1, Math.min((window.innerWidth || 1) - 2, Number(pointer.x)));
        var y = Math.max(1, Math.min((window.innerHeight || 1) - 2, Number(pointer.y)));
        var target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
        var token = requestFresh && request.token ? String(request.token || '') : '';
        if (!token && typeof irEventTargetTokenText === 'function') {
          try { token = irEventTargetTokenText({ target: target, clientX: x, clientY: y, type: 'host-show-hover-state' }) || ''; } catch (_) {}
        }
        var editorSurface = requestFresh && typeof request.editorSurface === 'boolean'
          ? request.editorSurface
          : (typeof irEventTargetsEditorSurface === 'function'
            ? !!irEventTargetsEditorSurface({ target: target, clientX: x, clientY: y, type: 'host-show-hover-state' })
            : !!(target && target.closest && target.closest('.monaco-editor')));
        return {
          ok: !!(pointerFresh && (editorSurface || token)),
          mode: 'pointer-state',
          reason: pointerFresh && (editorSurface || token) ? 'fresh-editor-pointer' : 'pointer-not-editor-symbol',
          requestReason: requestFresh ? String(request.reason || '') : '',
          hostReason: ${jsonStringifyAscii(reason)},
          requestFresh: requestFresh,
          pointerFresh: pointerFresh,
          pointerAgeMs: ageMs,
          x: x,
          y: y,
          token: token,
          editorSurface: editorSurface,
          targetClassName: target ? String(target.className || '') : '',
          targetText: target ? String(target.textContent || '').replace(/\\s+/g, ' ').slice(0, 160) : '',
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      } catch (err) {
        return { ok: false, mode: 'pointer-state', reason: String(err && err.message || err), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  const rows = await evaluateInMainProcessForTests(
    mainWsRefIsRendererTarget ? rendererExpr : rendererTestWindowEvalExpression(rendererExpr, true),
    2500,
  );
  return (Array.isArray(rows) ? rows : [{ value: rows }])
    .map((row: any) => row?.value)
    .find(Boolean) || { ok: false, reason: 'no-renderer-pointer-state' };
}

async function dispatchRendererNativeHoverAtPointer(reason: string): Promise<any> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: 'renderer-cdp-not-open' };
  }
  const rendererExpr = `
    (function() {
      try {
        var now = Date.now();
        var request = window.__irNativeShowHoverRequest || null;
        var requestFresh = !!(request && request.at && now - request.at < 5000);
        var pointer = requestFresh && request.pointer ? request.pointer : (window.__irLastPointer || null);
        var ageMs = pointer && pointer.at ? now - pointer.at : null;
        var pointerFresh = !!(pointer && pointer.at && ageMs >= 0 && ageMs < 5000
          && typeof pointer.x === 'number' && typeof pointer.y === 'number');
        if (!pointerFresh) {
          return {
            ok: false,
            mode: 'renderer-pointer-refire',
            reason: 'no-fresh-renderer-pointer',
            requestFresh: requestFresh,
            pointerAgeMs: ageMs,
            patchVersion: Number(window.__irPatchVersion) || 0
          };
        }
        var x = Math.max(1, Math.min((window.innerWidth || 1) - 2, Number(pointer.x)));
        var y = Math.max(1, Math.min((window.innerHeight || 1) - 2, Number(pointer.y)));
        var target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
        var token = requestFresh && request.token ? String(request.token || '') : '';
        if (!token && typeof irEventTargetTokenText === 'function') {
          try { token = irEventTargetTokenText({ target: target, clientX: x, clientY: y, type: 'host-show-hover-refire' }) || ''; } catch (_) {}
        }
        var editorSurface = requestFresh && typeof request.editorSurface === 'boolean'
          ? request.editorSurface
          : (typeof irEventTargetsEditorSurface === 'function'
            ? !!irEventTargetsEditorSurface({ target: target, clientX: x, clientY: y, type: 'host-show-hover-refire' })
            : !!(target && target.closest && target.closest('.monaco-editor')));
        if (!editorSurface && !token) {
          return {
            ok: false,
            mode: 'renderer-pointer-refire',
            reason: 'pointer-not-editor-symbol',
            requestFresh: requestFresh,
            pointerFresh: pointerFresh,
            pointerAgeMs: ageMs,
            x: x,
            y: y,
            token: token,
            editorSurface: editorSurface,
            patchVersion: Number(window.__irPatchVersion) || 0
          };
        }
        function describe(el) {
          return el ? {
            tag: String(el.tagName || ''),
            className: String(el.className || ''),
            text: String(el.textContent || '').replace(/\\s+/g, ' ').slice(0, 160)
          } : null;
        }
        function simpleTokenFrom(el) {
          try {
            var raw = String(el && el.textContent || '')
              .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
              .replace(/\\u00a0/g, ' ')
              .replace(/\\s+/g, ' ')
              .trim();
            if (!raw || raw.length > 180) return '';
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) return raw;
            var matches = raw.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
            return matches.length === 1 ? matches[0] : '';
          } catch (_) {
            return '';
          }
        }
        var cleanupToken = token || simpleTokenFrom(target);
        var removedReleasedNative = 0;
        var preservedReleasedNative = 0;
        var quarantinedStaleNative = 0;
        function quarantineOldNativeHover(oldRoot, oldText, qReason) {
          try {
            if (!oldRoot || !document.body.contains(oldRoot)) return false;
            if (window.__irActiveHoverEl === oldRoot) window.__irActiveHoverEl = null;
            if (document.activeElement && (document.activeElement === oldRoot || (oldRoot.contains && oldRoot.contains(document.activeElement)))) {
              try { document.activeElement.blur && document.activeElement.blur(); } catch (_) {}
            }
            if (oldRoot.__irReleaseRemoveTimer) {
              clearTimeout(oldRoot.__irReleaseRemoveTimer);
              oldRoot.__irReleaseRemoveTimer = null;
            }
            oldRoot.__irReleasedAt = Date.now();
            oldRoot.__irReleasedText = String(oldText || '');
            oldRoot.__irQuarantinedAt = Date.now();
            oldRoot.__irPrimaryPreviewTarget = null;
            oldRoot.__irPreviewAppliedAt = 0;
            oldRoot.__irStickyUntil = 0;
            oldRoot.__irLastInsideAt = 0;
            if (oldRoot.classList) {
              oldRoot.classList.add('ir-native-released-hover');
              oldRoot.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
            }
            if (oldRoot.setAttribute) {
              oldRoot.setAttribute('data-ir-native-released-hover', '1');
            }
            if (oldRoot.removeAttribute) {
              oldRoot.removeAttribute('data-ir-empty-hover-root');
            }
            if (typeof irResetNativeHoverMutations === 'function') irResetNativeHoverMutations(oldRoot);
            if (oldRoot.style) {
              oldRoot.style.setProperty('pointer-events', 'none', 'important');
            }
            return true;
          } catch (_) {
            return false;
          }
        }
        try {
          var oldRoots = Array.prototype.slice.call(document.querySelectorAll('.monaco-hover,.monaco-editor-hover'));
          for (var oi = 0; oi < oldRoots.length; oi++) {
            var oldRoot = oldRoots[oi];
            if (!oldRoot || !document.body.contains(oldRoot)) continue;
            var oldReleased = !!(oldRoot.getAttribute && oldRoot.getAttribute('data-ir-native-released-hover') === '1')
              || !!(oldRoot.classList && oldRoot.classList.contains('ir-native-released-hover'));
            if (!oldReleased) continue;
            var oldText = String(oldRoot.textContent || '');
            if (cleanupToken && oldText.indexOf(cleanupToken) >= 0) {
              preservedReleasedNative++;
              continue;
            }
            try {
              if (quarantineOldNativeHover(oldRoot, oldText, 'released-mismatch')) removedReleasedNative++;
            } catch (_) {}
          }
          for (var qi = 0; qi < oldRoots.length; qi++) {
            var staleRoot = oldRoots[qi];
            if (!staleRoot || !document.body.contains(staleRoot)) continue;
            if (staleRoot.getAttribute && staleRoot.getAttribute('data-ir-forced-hover') === '1') continue;
            var staleText = String(staleRoot.textContent || '');
            if (!staleText.trim()) continue;
            if (cleanupToken && staleText.indexOf(cleanupToken) >= 0) continue;
            var staleVisibility = typeof irHoverRootVisibility === 'function'
              ? irHoverRootVisibility(staleRoot)
              : { visible: true, reason: 'unknown' };
            var staleRect = staleRoot.getBoundingClientRect ? staleRoot.getBoundingClientRect() : null;
            var collapsed = !staleVisibility.visible
              || !staleRect
              || staleRect.width <= 4
              || staleRect.height <= 4
              || (document.activeElement === staleRoot);
            var managed = !!(staleRoot.classList && (
              staleRoot.classList.contains('ir-keepalive')
              || staleRoot.classList.contains('ir-scrollable')
              || staleRoot.classList.contains('ir-sticky')
              || staleRoot.classList.contains('ir-size-small')
              || staleRoot.classList.contains('ir-size-medium')
              || staleRoot.classList.contains('ir-size-large')
            ));
            if (collapsed || managed) {
              if (quarantineOldNativeHover(staleRoot, staleText, 'stale-mismatch')) quarantinedStaleNative++;
            }
          }
        } catch (_) {}
        function fire(type, Ctor) {
          var eventTarget = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : target;
          if (!eventTarget) eventTarget = target || document.body;
          try {
            eventTarget.dispatchEvent(new (Ctor || window.MouseEvent)(type, {
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
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true
            }));
            return { ok: true, type: type, target: describe(eventTarget) };
          } catch (_) {
            try {
              var ev = document.createEvent('MouseEvents');
              ev.initMouseEvent(type, true, true, window, 0, x, y, x, y, false, false, false, false, 0, null);
              eventTarget.dispatchEvent(ev);
              return { ok: true, type: type, target: describe(eventTarget), fallback: true };
            } catch (err) {
              return { ok: false, type: type, error: String(err && err.message || err), target: describe(eventTarget) };
            }
          }
        }
        var fired = [];
        fired.push(fire('pointerover', window.PointerEvent || window.MouseEvent));
        fired.push(fire('mouseover', window.MouseEvent));
        fired.push(fire('pointermove', window.PointerEvent || window.MouseEvent));
        fired.push(fire('mousemove', window.MouseEvent));
        try {
          var editorEl = target && target.closest ? target.closest('.monaco-editor') : null;
          var input = editorEl && editorEl.querySelector ? editorEl.querySelector('textarea.inputarea, textarea') : null;
          if (input && typeof input.focus === 'function') input.focus({ preventScroll: true });
        } catch (_) {}
        return {
          ok: fired.some(function(item) { return item && item.ok; }),
          mode: 'renderer-pointer-refire',
          reason: 'pointer-events-dispatched',
          requestReason: requestFresh ? String(request.reason || '') : '',
          hostReason: ${jsonStringifyAscii(reason)},
          requestFresh: requestFresh,
          pointerFresh: pointerFresh,
          pointerAgeMs: ageMs,
          x: x,
          y: y,
          token: token,
          cleanupToken: cleanupToken,
          editorSurface: editorSurface,
          removedReleasedNative: removedReleasedNative,
          preservedReleasedNative: preservedReleasedNative,
          quarantinedStaleNative: quarantinedStaleNative,
          target: describe(target),
          fired: fired,
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      } catch (err) {
        return { ok: false, mode: 'renderer-pointer-refire', reason: String(err && err.message || err), patchVersion: Number(window.__irPatchVersion) || 0 };
      }
    })()
  `.trim();
  const rows = await evaluateInMainProcessForTests(
    mainWsRefIsRendererTarget ? rendererExpr : rendererTestWindowEvalExpression(rendererExpr, true),
    2500,
  );
  return (Array.isArray(rows) ? rows : [{ value: rows }])
    .map((row: any) => row?.value)
    .find(Boolean) || { ok: false, reason: 'no-renderer-pointer-refire-result' };
}

async function requestNativeShowHoverFromRendererPointer(reason: string): Promise<any> {
  let pointerState: any;
  try {
    pointerState = await readRendererNativeHoverPointerState(reason);
  } catch (err) {
    pointerState = {
      ok: false,
      mode: 'pointer-state',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (pointerState?.ok && pointerState?.pointerFresh && (pointerState?.editorSurface || pointerState?.token)) {
    try { await vscode.commands.executeCommand('editor.action.hideHover'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 90));
    const refire = await dispatchRendererNativeHoverAtPointer(reason);
    let nativeMouseRefire: any = null;
    const x = Number(pointerState?.x);
    const y = Number(pointerState?.y);
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      try {
        nativeMouseRefire = await withRendererInputCdpSessionForTests(async (cdpWs, inputMode) => {
          await cdpRequest(cdpWs, 'Page.enable', {}, 1000).catch(() => undefined);
          await cdpRequest(cdpWs, 'Page.bringToFront', {}, 1000).catch(() => undefined);
          const points = [
            { x: Math.max(1, x - 28), y },
            { x: Math.max(1, x - 9), y },
            { x, y },
          ];
          for (const point of points) {
            await cdpRequest(cdpWs, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: Math.round(point.x * 100) / 100,
              y: Math.round(point.y * 100) / 100,
              button: 'none',
              buttons: 0,
              pointerType: 'mouse',
            }, 2500);
            await new Promise(resolve => setTimeout(resolve, 55));
          }
          return { ok: true, mode: inputMode, points };
        });
        await new Promise(resolve => setTimeout(resolve, 180));
      } catch (err) {
        nativeMouseRefire = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      ...refire,
      pointerState,
      nativeMouseRefire,
      commandFallback: false,
    };
  }
  try {
    await vscode.commands.executeCommand('editor.action.hideHover');
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 90));
  try {
    await vscode.commands.executeCommand('editor.action.showHover');
    return {
      ok: true,
      mode: 'command-fallback',
      reason: 'editor-action-showHover',
      pointerState,
      commandFallback: true,
    };
  } catch (err) {
    return {
      ok: false,
      mode: 'command-fallback',
      reason: err instanceof Error ? err.message : String(err),
      pointerState,
      commandFallback: true,
    };
  }
}

// native-only: VS Code's HoverProvider already returned the markdown and
// VS Code renders the native hover on its own. No fake DOM injection.
function scheduleRendererNativeHoverFallback(
  _identifier: string,
  _markdown: string,
  _source: string,
  _anchor?: NativeHoverRefireAnchor,
): void {
  return;
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
  // native-only: drilldown goes through pendingPreviewHover + refireHoverAtAnchor,
  // letting VS Code render the new hover natively. The renderer-direct apply
  // path that built a custom DOM is gone.
  return false;
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

// native-only: drilldown applies via pendingPreviewHover + refireHoverAtAnchor,
// letting VS Code render the new hover natively. No renderer-direct DOM.
async function applyPreviewStateInRenderer(_state: PreviewState, _fromBack: boolean): Promise<boolean> {
  return false;
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

// native-only: back-to-original-hover is a fresh refireHoverAtAnchor against
// the real LSP path, not a cached DOM snapshot.
async function restoreOriginalHoverSnapshotInRenderer(_scrollState: PreviewScrollState | undefined): Promise<boolean> {
  return false;
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
      function appendOrphanEmptyHoverShellNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var shell = document.createElement('div');
        shell.className = 'monaco-scrollable-element ir-e2e-empty-hover-shell';
        shell.style.cssText = 'position:fixed;left:' + Math.max(0, rect.left + 18)
          + 'px;top:' + Math.max(0, rect.top + 18)
          + 'px;width:' + Math.max(120, Math.min(360, rect.width - 36))
          + 'px;height:' + Math.max(42, Math.min(120, rect.height - 36))
          + 'px;z-index:2147483647;background:Canvas;border:1px solid rgba(128,128,128,0.45);box-shadow:0 2px 8px rgba(0,0,0,0.25);display:block;visibility:visible;';
        document.body.appendChild(shell);
        return shell;
      }
      function appendTopEmptyHoverCellNear(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var cell = document.createElement('div');
        cell.className = 'ir-e2e-empty-hover-top-cell';
        cell.style.cssText = 'position:fixed;left:' + Math.max(0, rect.left + 18)
          + 'px;top:' + Math.max(0, rect.top - 10)
          + 'px;width:' + Math.max(80, Math.min(260, rect.width - 36))
          + 'px;height:20px;z-index:2147483647;background:Canvas;border:1px solid rgba(128,128,128,0.62);box-shadow:0 1px 8px rgba(0,0,0,0.32);display:block;visibility:visible;pointer-events:auto;';
        document.body.appendChild(cell);
        return cell;
      }
      function appendInternalEmptyHoverCell(hoverEl) {
        var rect = hoverEl.getBoundingClientRect();
        var cell = document.createElement('div');
        cell.className = 'ir-e2e-empty-hover-cell';
        cell.style.cssText = 'position:absolute;left:18px;top:18px;width:'
          + Math.max(72, Math.min(220, rect.width - 36))
          + 'px;height:' + Math.max(36, Math.min(88, rect.height - 36))
          + 'px;z-index:2147483647;background:Canvas;border:1px solid rgba(128,128,128,0.55);box-shadow:0 1px 6px rgba(0,0,0,0.25);display:block;visibility:visible;';
        hoverEl.appendChild(cell);
        return cell;
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
      var hugeBefore = snap(huge);
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
      var orphanEmptyShell = appendOrphanEmptyHoverShellNear(small);
      var topEmptyCell = appendTopEmptyHoverCellNear(small);
      var internalEmptyCell = appendInternalEmptyHoverCell(small);
      try { if (typeof hooks.removeInactiveHoverArtifacts === 'function') hooks.removeInactiveHoverArtifacts(small, 'e2e-orphan-empty-shell'); } catch (_) {}
      await waitFrame();
      var orphanEmptyShellConnectedAfterCleanup = document.body.contains(orphanEmptyShell);
      var topEmptyCellConnectedAfterCleanup = document.body.contains(topEmptyCell);
      var internalEmptyCellConnectedAfterCleanup = document.body.contains(internalEmptyCell);
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
      try { orphanEmptyShell.parentNode && orphanEmptyShell.parentNode.removeChild(orphanEmptyShell); } catch (_) {}
      try { topEmptyCell.parentNode && topEmptyCell.parentNode.removeChild(topEmptyCell); } catch (_) {}
      try { internalEmptyCell.parentNode && internalEmptyCell.parentNode.removeChild(internalEmptyCell); } catch (_) {}
      try { bodyHandle.parentNode && bodyHandle.parentNode.removeChild(bodyHandle); } catch (_) {}
      try { unownedBodyHandle.parentNode && unownedBodyHandle.parentNode.removeChild(unownedBodyHandle); } catch (_) {}
      try { topBodyHandle.parentNode && topBodyHandle.parentNode.removeChild(topBodyHandle); } catch (_) {}
      try { workbenchSash.parentNode && workbenchSash.parentNode.removeChild(workbenchSash); } catch (_) {}
      try { topWorkbenchSash.parentNode && topWorkbenchSash.parentNode.removeChild(topWorkbenchSash); } catch (_) {}
      try { mutatingHandle.parentNode && mutatingHandle.parentNode.removeChild(mutatingHandle); } catch (_) {}

      // ── L54 column/bar wrapper gate E2E (Task #82) ──────────────
      // Reproduce the pillar/bar signatures the live-session logs
      // (L51..L54) showed:
      //   column: width 16px × height >40px
      //   bar   : width >200px × height 2px
      // and verify the 2-pass gate: first sweep ONLY marks
      // __irColumnSeenAt, ≥200ms later the second sweep strips our
      // keepalive classes from the inner. Transient single-frame
      // columns (no second sighting) must NOT lose their classes.
      function wait(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function buildStuckWrapper(shape) {
        var w = document.createElement('div');
        w.className = 'monaco-resizable-hover';
        var rect = shape === 'bar'
          ? { left: 100, top: 100, width: 680, height: 2 }
          : { left: 100, top: 100, width: 16,  height: 180 };
        // VS Code's own .monaco-resizable-hover CSS rules ship with
        // min-height/max-height that override plain inline width/height.
        // Use setProperty(..., 'important') so our synthesised rect
        // actually measures 16×180 / 680×2 instead of collapsing to
        // the platform default line-height (~17px).
        w.style.setProperty('position', 'fixed', 'important');
        w.style.setProperty('display', 'block', 'important');
        w.style.setProperty('visibility', 'visible', 'important');
        w.style.setProperty('left', rect.left + 'px', 'important');
        w.style.setProperty('top', rect.top + 'px', 'important');
        w.style.setProperty('width', rect.width + 'px', 'important');
        w.style.setProperty('height', rect.height + 'px', 'important');
        w.style.setProperty('min-width', rect.width + 'px', 'important');
        w.style.setProperty('max-width', rect.width + 'px', 'important');
        w.style.setProperty('min-height', rect.height + 'px', 'important');
        w.style.setProperty('max-height', rect.height + 'px', 'important');
        var inner = document.createElement('div');
        inner.className = 'monaco-hover ir-keepalive ir-sticky ir-scrollable ir-size-medium fade-in';
        inner.textContent = 'stuck ' + shape + ' wrapper synth content for column-gate harness';
        w.appendChild(inner);
        document.body.appendChild(w);
        return { wrap: w, inner: inner };
      }
      function snapWrap(s) {
        var r = s.wrap.getBoundingClientRect ? s.wrap.getBoundingClientRect() : null;
        var matches = false;
        try {
          var all = document.querySelectorAll('.monaco-resizable-hover');
          for (var ai = 0; ai < all.length; ai++) { if (all[ai] === s.wrap) { matches = true; break; } }
        } catch (_) {}
        return {
          hasKeepalive: !!(s.inner.classList && s.inner.classList.contains('ir-keepalive')),
          hasSticky:    !!(s.inner.classList && s.inner.classList.contains('ir-sticky')),
          hasScrollable:!!(s.inner.classList && s.inner.classList.contains('ir-scrollable')),
          seenAt:       Number(s.wrap.__irColumnSeenAt || 0),
          // L79: a content-bearing column pillar is remediated by clearing the
          // stuck inline width (so the stylesheet re-expands it) instead of
          // stripping our keepalive classes — captured so the gate test can
          // assert the width-restore path rather than the legacy class-strip.
          widthRestored: !!s.wrap.__irColumnWidthRestored,
          inlineWidth:   String(s.wrap.style && s.wrap.style.width || ''),
          rect:         r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
          inQuery:      matches,
          styleDisplay: String(s.wrap.style && s.wrap.style.display || ''),
          styleVisibility: String(s.wrap.style && s.wrap.style.visibility || ''),
          wrapClassName: String(s.wrap.className || ''),
          innerClassName: String(s.inner.className || '')
        };
      }
      var columnGateResult = { ok: false };
      // Drive ONLY the narrow-wrapper scan (column-detect + 2-pass
      // cleanup), not the full sweep — the full sweep would prune our
      // synthesised .monaco-hover inner before we can inspect its
      // post-gate classList. The narrow-wrapper scan was extracted to
      // irScanNarrowHoverWrappers + exposed via hooks for this reason.
      try {
        // ── column shape ──
        var c = buildStuckWrapper('column');
        hooks.scanNarrowHoverWrappers('harness-col-1');
        var colAfter1 = snapWrap(c);
        await wait(250);
        hooks.scanNarrowHoverWrappers('harness-col-2');
        var colAfter2 = snapWrap(c);
        try { c.wrap.parentNode && c.wrap.parentNode.removeChild(c.wrap); } catch(_) {}

        // ── bar shape ──
        var b = buildStuckWrapper('bar');
        hooks.scanNarrowHoverWrappers('harness-bar-1');
        var barAfter1 = snapWrap(b);
        await wait(250);
        hooks.scanNarrowHoverWrappers('harness-bar-2');
        var barAfter2 = snapWrap(b);
        try { b.wrap.parentNode && b.wrap.parentNode.removeChild(b.wrap); } catch(_) {}

        // ── transient (single-frame, no second sweep) ──
        var t = buildStuckWrapper('column');
        hooks.scanNarrowHoverWrappers('harness-trans-1');
        var transAfter1 = snapWrap(t);
        // Do NOT wait 200ms — dismiss synth wrapper immediately, like a
        // legitimate hover that resized away in <16ms. The gate must
        // not have stripped our classes on the first pass.
        try { t.wrap.parentNode && t.wrap.parentNode.removeChild(t.wrap); } catch(_) {}

        // ── freeze gate (L81) — a CONTENT column with a known last-good width
        // must be width-FROZEN (min-width floor) by the sweep so the 16px sliver
        // never paints, instead of waiting for the reactive L79 restore. This is
        // the engagement check L80 lacked (it hooked the style observer, which
        // never saw the computed collapse → 0 width-freeze events in v=233).
        var f = buildStuckWrapper('column');
        f.wrap.__irLastGoodWidth = 600;   // simulate a previously-healthy hover
        hooks.scanNarrowHoverWrappers('harness-freeze-1');
        var freezeAfter = {
          frozen:   !!f.wrap.__irWidthFrozen,
          minWidth: String(f.wrap.style && f.wrap.style.minWidth || ''),
        };
        try { f.wrap.parentNode && f.wrap.parentNode.removeChild(f.wrap); } catch(_) {}

        columnGateResult = {
          ok: true,
          freeze: freezeAfter,
          column: { first: colAfter1, second: colAfter2 },
          bar:    { first: barAfter1, second: barAfter2 },
          transient: { first: transAfter1 }
        };
      } catch (e) {
        columnGateResult = { ok: false, error: String(e && e.message || e) };
      }

      harnessMark('before-return');
      return {
        ok: true,
        columnGate: columnGateResult,
        patchVersion: Number(window.__irPatchVersion) || 0,
        viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
        largeBefore: largeBefore,
        largeAfterWheel: largeAfterWheel,
        hugeBefore: hugeBefore,
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
        orphanEmptyShellConnectedAfterCleanup: orphanEmptyShellConnectedAfterCleanup,
        topEmptyCellConnectedAfterCleanup: topEmptyCellConnectedAfterCleanup,
        internalEmptyCellConnectedAfterCleanup: internalEmptyCellConnectedAfterCleanup,
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
        var emptyOverlayConnected = !!(document.body && document.body.contains(emptyOverlay));
        var emptyOverlayPointerEvents = '';
        try { emptyOverlayPointerEvents = window.getComputedStyle(emptyOverlay).pointerEvents || ''; } catch (_) {}
        if (!emptyOverlayPointerEvents && emptyOverlay.style) emptyOverlayPointerEvents = emptyOverlay.style.pointerEvents || '';
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
          emptyOverlayConnected: emptyOverlayConnected,
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
      var roots = document.querySelectorAll('.ir-e2e-split-column-hover');
      var allHoverRoots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
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
        allHoverCountAfterRight: allHoverRoots.length,
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
        symbolEmptyOverlayConnected: !!symbolHover.emptyOverlayConnected,
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
  try {
    return await evaluateInMainProcessForTests(mainExpr, 12000);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    if (!/timed out/i.test(message)) { throw err; }
    log.warn(`[hover-test] split-column harness timed out once; retrying after renderer cleanup (${message})`);
    try { await cleanupRendererTestArtifactsAcrossWindowsForTests(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
    return evaluateInMainProcessForTests(mainExpr, 18000);
  }
}

async function runNativeHoverGeometryHarnessForTests(input?: {
  symbol?: string;
  lineFragment?: string;
  expectedColumn?: 'left' | 'right' | 'any';
  expectedTextFragments?: string[];
  absentTextFragments?: string[];
  injectEmptyTopCellForTests?: boolean;
  injectExternalHoverArtifactForTests?: boolean;
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
        absentTextFragments: ${JSON.stringify(absentTextFragments)},
        injectEmptyTopCellForTests: ${JSON.stringify(!!input?.injectEmptyTopCellForTests)},
        injectExternalHoverArtifactForTests: ${JSON.stringify(!!input?.injectExternalHoverArtifactForTests)}
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
      function transientHoverText(text) {
        var key = String(text || '').replace(/\\s+/g, ' ').trim();
        return !key || key === 'Loading' || key === 'Loading...' || key === 'Loading…' || key.length <= 2;
      }
      function rectDistance(a, b) {
        if (!a || !b) return Infinity;
        var dx = 0;
        var dy = 0;
        if (a.right < b.left) dx = b.left - a.right;
        else if (b.right < a.left) dx = a.left - b.right;
        if (a.bottom < b.top) dy = b.top - a.bottom;
        else if (b.bottom < a.top) dy = a.top - b.bottom;
        return Math.sqrt((dx * dx) + (dy * dy));
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
          && !el.classList.contains('ir-test-seeded-hover')
          && !el.classList.contains('workbench-hover');
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
      function emptyHoverOverlapMetrics(selectedRoot, selectedRect) {
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover,.monaco-editor-hover');
        for (var i = 0; i < roots.length && out.length < 20; i++) {
          var root = roots[i];
          if (!document.body.contains(root) || !isActualHover(root) || root === selectedRoot) continue;
          if (!visible(root)) continue;
          var text = normalizeText(root.textContent || '').trim();
          if (text.length > 0) continue;
          var rr = hoverRectObj(root);
          out.push({
            index: i,
            className: String(root.className || ''),
            rect: rr,
            overlapsSelected: !!(selectedRect && rectsIntersect(rr, selectedRect, 4)),
            active: root === window.__irActiveHoverEl,
            released: !!(root.getAttribute && root.getAttribute('data-ir-native-released-hover') === '1')
          });
        }
        var overlap = 0;
        for (var oi = 0; oi < out.length; oi++) {
          if (out[oi].overlapsSelected) overlap++;
        }
        return {
          visibleEmptyHoverCount: out.length,
          overlappingEmptyHoverCount: overlap,
          overlappingEmptyHoverRoots: out
        };
      }
      function emptyHoverShellMetrics(selectedRoot, selectedRect) {
        var out = [];
        var external = [];
        var seen = [];
        function addCandidate(node, source, point) {
          if (!node || node.nodeType !== 1 || seen.indexOf(node) >= 0) return;
          seen.push(node);
          candidates.push({ node: node, source: source, point: point || null });
        }
        function cssColorVisible(value) {
          var v = String(value || '').replace(/\\s+/g, '').toLowerCase();
          if (!v || v === 'transparent') return false;
          if (/^rgba?\\(0,0,0,0\\)$/.test(v)) return false;
          if (/^rgba\\([^)]*,0(?:\\.0+)?\\)$/.test(v)) return false;
          return true;
        }
        function cssPx(value) {
          var n = parseFloat(String(value || '0'));
          return Number.isFinite(n) ? n : 0;
        }
        function paintsBox(node, cs) {
          cs = cs || (window.getComputedStyle ? window.getComputedStyle(node) : null);
          if (!cs) return false;
          if (cssColorVisible(cs.backgroundColor)) return true;
          if (String(cs.boxShadow || '').toLowerCase() !== 'none') return true;
          if (String(cs.outlineStyle || '').toLowerCase() !== 'none' && cssPx(cs.outlineWidth) > 0 && cssColorVisible(cs.outlineColor)) return true;
          var sides = ['Top', 'Right', 'Bottom', 'Left'];
          for (var si = 0; si < sides.length; si++) {
            var side = sides[si];
            if (String(cs['border' + side + 'Style'] || '').toLowerCase() !== 'none'
              && cssPx(cs['border' + side + 'Width']) > 0
              && cssColorVisible(cs['border' + side + 'Color'])) return true;
          }
          return false;
        }
        function hoverProbePoints(rect) {
          var out = [];
          var seenPoints = {};
          if (!rect) return out;
          function add(x, y) {
            var cx = Math.max(1, Math.min((window.innerWidth || 1) - 2, x));
            var cy = Math.max(1, Math.min((window.innerHeight || 1) - 2, y));
            var key = Math.round(cx) + ':' + Math.round(cy);
            if (seenPoints[key]) return;
            seenPoints[key] = true;
            out.push({ x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 });
          }
          var w = Math.max(1, rect.width || (rect.right - rect.left));
          var h = Math.max(1, rect.height || (rect.bottom - rect.top));
          var xs = [
            rect.left + 2,
            rect.left + Math.min(12, w * 0.12),
            rect.left + w * 0.18,
            rect.left + w * 0.33,
            rect.left + w * 0.5,
            rect.right - w * 0.33,
            rect.right - w * 0.18,
            rect.right - Math.min(12, w * 0.12),
            rect.right - 2
          ];
          var ys = [
            rect.top - 28,
            rect.top - 16,
            rect.top - 6,
            rect.top + 1,
            rect.top + 6,
            rect.top + Math.min(18, h * 0.12),
            rect.top + h * 0.18,
            rect.top + h * 0.5,
            rect.bottom - Math.min(18, h * 0.12),
            rect.bottom - 2,
            rect.bottom + 6
          ];
          for (var xi = 0; xi < xs.length; xi++) {
            for (var yi = 0; yi < ys.length; yi++) add(xs[xi], ys[yi]);
          }
          return out;
        }
        function emptyHoverDangerRelation(rr, selectedRect) {
          if (!rr || !selectedRect) {
            return { near: false, overlaps: false, directOverlap: false, topBand: false, distance: null };
          }
          var direct = rectsIntersect(rr, selectedRect, 0);
          var padded = rectsIntersect(rr, selectedRect, 24);
          var topBand = rr.bottom >= selectedRect.top - 32
            && rr.top <= selectedRect.top + 32
            && rr.right >= selectedRect.left - 16
            && rr.left <= selectedRect.right + 16;
          var distance = rectDistance(rr, selectedRect);
          return {
            near: !!(padded || topBand || distance <= 24),
            overlaps: !!(padded || topBand),
            directOverlap: !!direct,
            topBand: !!topBand,
            distance: Math.round(distance)
          };
        }
        function stackIndexFor(stack, root) {
          if (!stack || !root) return -1;
          for (var si = 0; si < stack.length; si++) {
            var el = stack[si];
            try {
              if (el === root || (root.contains && root.contains(el))) return si;
            } catch (_) {}
          }
          return -1;
        }
        function artifactOccludesSelected(node, rr, selectedRoot, selectedRect, sourcePoint) {
          if (!node || !selectedRoot || !selectedRect || !document.elementsFromPoint) return false;
          try {
            if (node.classList && node.classList.contains('ir-e2e-external-hover-artifact')) return true;
            var points = [];
            function add(x, y) {
              if (!Number.isFinite(x) || !Number.isFinite(y)) return;
              points.push({
                x: Math.max(1, Math.min((window.innerWidth || 1) - 2, x)),
                y: Math.max(1, Math.min((window.innerHeight || 1) - 2, y))
              });
            }
            if (sourcePoint) add(sourcePoint.x, sourcePoint.y);
            var ixLeft = Math.max(rr.left, selectedRect.left);
            var ixRight = Math.min(rr.right, selectedRect.right);
            var ixTop = Math.max(rr.top, selectedRect.top);
            var ixBottom = Math.min(rr.bottom, selectedRect.bottom);
            if (ixRight >= ixLeft && ixBottom >= ixTop) {
              add((ixLeft + ixRight) / 2, (ixTop + ixBottom) / 2);
              add(ixLeft + Math.min(8, Math.max(1, ixRight - ixLeft)), ixTop + Math.min(8, Math.max(1, ixBottom - ixTop)));
            }
            add(Math.max(rr.left + 2, Math.min(rr.right - 2, selectedRect.left + 18)), Math.max(rr.top + 2, Math.min(rr.bottom - 2, selectedRect.top + 8)));
            for (var pi = 0; pi < points.length; pi++) {
              var stack = document.elementsFromPoint(points[pi].x, points[pi].y) || [];
              var nodeIndex = stackIndexFor(stack, node);
              if (nodeIndex < 0) continue;
              var selectedIndex = stackIndexFor(stack, selectedRoot);
              if (selectedIndex < 0 || nodeIndex < selectedIndex) return true;
            }
          } catch (_) {}
          return false;
        }
        var candidates = [];
        var nodes = document.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.context-view,[class*="hover"],[class*="Hover"],[class*="scrollable"],[class*="Scrollable"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"]');
        for (var ni = 0; ni < nodes.length; ni++) addCandidate(nodes[ni], 'selector', null);
        if (selectedRoot && selectedRoot.querySelectorAll) {
          var inside = selectedRoot.querySelectorAll('div,[class*="hover"],[class*="Hover"],[class*="scroll"],[class*="Scroll"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"],[style*="z-index"],[style*="position"]');
          for (var ii = 0; ii < inside.length; ii++) addCandidate(inside[ii], 'inside-active', null);
        }
        if (selectedRect && document.elementsFromPoint) {
          var points = hoverProbePoints(selectedRect);
          for (var pi = 0; pi < points.length; pi++) {
            var stack = document.elementsFromPoint(points[pi].x, points[pi].y) || [];
            for (var si2 = 0; si2 < stack.length; si2++) addCandidate(stack[si2], 'hit-test', points[pi]);
          }
        }
        for (var i = 0; i < candidates.length && out.length < 30; i++) {
          var item = candidates[i];
          var node = item.node;
          if (!document.body.contains(node)) continue;
          if (node === selectedRoot || node === document.body || node === document.documentElement) continue;
          if (selectedRoot && node.contains && node.contains(selectedRoot)) continue;
          var chromeCls = String(node.className || '');
          if ((node.closest && node.closest('.titlebar,.titlebar-container,.titlebar-drag-region,.command-center,.activitybar,.statusbar,.part.statusbar,.part.activitybar,.part.titlebar'))
            || /(titlebar|command-center|activitybar|statusbar|window-title|menubar|drag-region)/i.test(chromeCls)) continue;
          if (node.closest && node.closest('.tabs-and-actions-container,.tabs-container,.tab,.breadcrumbs-control,.monaco-breadcrumbs,.part.editor > .content,.editor-group-container > .title')) continue;
          var insideActive = !!(selectedRoot && selectedRoot.contains && selectedRoot.contains(node));
          var inHoverOverlay = !!(node.closest && node.closest('.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,.context-view'));
          if (!insideActive && !inHoverOverlay && node.closest && node.closest('.monaco-split-view2,.part.sidebar,.part.auxiliarybar,.part.panel,.pane-body,.composite')) continue;
          if (node.closest && node.closest('.suggest-widget,.quick-input-widget,.parameter-hints-widget,.monaco-menu,.action-widget,.peekview-widget,.rename-box,.zone-widget,.find-widget,.markers-panel,.notifications-toasts,.notifications-center')) continue;
          if (!insideActive && node.closest && node.closest('.monaco-editor')) continue;
          if (!visible(node)) continue;
          var rr = rectObj(node);
          if (!rr || rr.width < 4 || rr.height < 4) continue;
          var relation = emptyHoverDangerRelation(rr, selectedRect);
          if (!relation.near) continue;
          var occludesSelected = insideActive ? true : artifactOccludesSelected(node, rr, selectedRoot, selectedRect, item.point);
          var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
          var cls = String(node.className || '');
          if (/(^|\\s)(editor-instance|editor-container|editor-group-container|monaco-editor|overflow-guard|lines-content|view-lines|view-line)(\\s|$)/i.test(cls)) continue;
          if (/(sash|scrollbar|slider|shadow|decorationsOverviewRuler|scroll-decoration)/i.test(cls)) continue;
          var painted = paintsBox(node, cs);
          var positioned = !!(cs && /(absolute|fixed|sticky)/.test(String(cs.position || '')));
          var named = /(hover|scroll|context|overlay|cell|row|content)/i.test(cls);
          if (!painted && !positioned && !named) continue;
          var text = normalizeText(node.textContent || '').trim();
          var strongHoverNamed = /(monaco-hover|editor-hover|resizable-hover|monaco-scrollable-element|monaco-hover-content|hover-row|hover-contents|markdown-hover|rendered-markdown|context-view)/i.test(cls);
          if (!strongHoverNamed && node.matches) {
            try { strongHoverNamed = !!node.matches('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.context-view,.monaco-resizable-hover'); } catch (_) {}
          }
          if (!strongHoverNamed && node.closest) {
            try { strongHoverNamed = !!node.closest('.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,.context-view'); } catch (_) {}
          }
          if (!transientHoverText(text)) {
            if (!insideActive && occludesSelected && text && strongHoverNamed && external.length < 30) {
              external.push({
                index: i,
                tagName: String(node.tagName || ''),
                source: item.source,
                point: item.point,
                className: cls,
                rect: rr,
                textLength: text.length,
                textSample: text.slice(0, 160),
                overlapsSelected: relation.overlaps,
                directOverlapSelected: relation.directOverlap,
                topBandSelected: relation.topBand,
                distanceToSelected: relation.distance,
                occludesSelected: occludesSelected,
                position: cs ? String(cs.position || '') : '',
                zIndex: cs ? String(cs.zIndex || '') : '',
                backgroundColor: cs ? String(cs.backgroundColor || '') : '',
                pointerEvents: cs ? String(cs.pointerEvents || '') : '',
                parentClassName: node.parentElement ? String(node.parentElement.className || '') : ''
              });
            }
            continue;
          }
          if (!insideActive && !occludesSelected) continue;
          out.push({
            index: i,
            tagName: String(node.tagName || ''),
            source: item.source,
            point: item.point,
            insideActiveHover: insideActive,
            className: cls,
            rect: rr,
            textLength: text.length,
            textSample: text.slice(0, 80),
            overlapsSelected: relation.overlaps,
            directOverlapSelected: relation.directOverlap,
            topBandSelected: relation.topBand,
            distanceToSelected: relation.distance,
            occludesSelected: occludesSelected,
            position: cs ? String(cs.position || '') : '',
            zIndex: cs ? String(cs.zIndex || '') : '',
            backgroundColor: cs ? String(cs.backgroundColor || '') : '',
            pointerEvents: cs ? String(cs.pointerEvents || '') : '',
            parentClassName: node.parentElement ? String(node.parentElement.className || '') : ''
          });
        }
        var overlap = 0;
        for (var oi = 0; oi < out.length; oi++) {
          if (out[oi].overlapsSelected) overlap++;
        }
        var externalOverlap = 0;
        for (var ei = 0; ei < external.length; ei++) {
          if (external[ei].overlapsSelected) externalOverlap++;
        }
        return {
          visibleEmptyHoverShellCount: out.length,
          overlappingEmptyHoverShellCount: overlap,
          visibleEmptyHoverShells: out,
          visibleExternalHoverArtifactCount: external.length,
          overlappingExternalHoverArtifactCount: externalOverlap,
          visibleExternalHoverArtifacts: external
        };
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
          var cls = String(el.className || '');
          if (!item.ownedByHover && /decorationsOverviewRuler/i.test(cls)) continue;
          if (!item.ownedByHover && hoverRect && /(sash|monaco-sash)/i.test(cls) && r) {
            var spansBeyondHover = r.height > hoverRect.height + 96
              && r.top < hoverRect.top - 32
              && r.bottom > hoverRect.bottom + 32;
            if (spansBeyondHover) continue;
          }
          // VS Code keeps an inert .monaco-sash.disabled adjacent to hovers
          // for resize-affordance UI it never enables. It has no behavior and
          // can carry stale dimensions when our outer hover sizes dynamically,
          // so skip it for alignment accounting.
          if (/(?:^|\\s)disabled(?:\\s|$)/i.test(cls) && /(sash|monaco-sash)/i.test(cls)) {
            hiddenHandles++;
            continue;
          }
          if (/(^|\\s)slider(\\s|$)|(^|\\s)scrollbar(\\s|$)/i.test(cls) && !/(sash|monaco-sash)/i.test(cls)) {
            hiddenHandles++;
            continue;
          }
          var isVisible = visible(el) && r && r.width > 0 && r.height > 0;
          if (!isVisible) {
            hiddenHandles++;
            continue;
          }
          var alignment = handleKindAndAlignment(r, hoverRect);
          var summary = {
            className: cls,
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
          textSample: trimmed.slice(0, 2600),
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
      function releasedHoverConflictMetrics(selectedRoot, selectedRect) {
        var out = [];
        var overlap = 0;
        for (var ri = 0; ri < roots.length && out.length < 20; ri++) {
          var root = roots[ri];
          if (!root || !document.body.contains(root) || !isActualHover(root)) continue;
          var released = !!(root.getAttribute && root.getAttribute('data-ir-native-released-hover') === '1');
          var managed = !!(root.classList && root.classList.contains('ir-keepalive'));
          var rr = hoverRectObj(root);
          var text = normalizeText(root.textContent || '').trim();
          var overlaps = !!(selectedRect && rr && rectsIntersect(rr, selectedRect, 16));
          if (released && visibleHover(root)) {
            if (overlaps) overlap++;
            out.push({
              index: ri,
              className: String(root.className || ''),
              rect: rr,
              textLength: text.length,
              textSample: text.slice(0, 260),
              active: root === window.__irActiveHoverEl,
              managed: managed,
              released: released,
              overlapsSelected: overlaps,
              selected: root === selectedRoot
            });
          }
        }
        return {
          visibleReleasedHoverCount: out.length,
          overlappingReleasedHoverCount: overlap,
          visibleReleasedHoverRoots: out
        };
      }
      var injectedEmptyTopCell = null;
      var injectedEmptyTopCellRect = null;
      var injectedExternalHoverArtifact = null;
      var injectedExternalHoverArtifactRect = null;
      if (expected.injectEmptyTopCellForTests && hoverRect) {
        try {
          injectedEmptyTopCell = document.createElement('div');
          injectedEmptyTopCell.className = 'ir-e2e-empty-hover-top-cell';
          var topCellLeft = Math.max(1, hoverRect.left + 18);
          var topCellTop = Math.max(1, hoverRect.top - 10);
          var topCellWidth = Math.max(80, Math.min(260, hoverRect.width - 36));
          injectedEmptyTopCell.style.cssText = 'position:fixed;left:' + topCellLeft
            + 'px;top:' + topCellTop
            + 'px;width:' + topCellWidth
            + 'px;height:20px;z-index:2147483647;background:Canvas;border:1px solid rgba(128,128,128,0.62);box-shadow:0 1px 8px rgba(0,0,0,0.32);display:block;visibility:visible;pointer-events:auto;';
          document.body.appendChild(injectedEmptyTopCell);
          injectedEmptyTopCellRect = rectObj(injectedEmptyTopCell);
        } catch (_) {
          injectedEmptyTopCell = null;
        }
      }
      if (expected.injectExternalHoverArtifactForTests && hoverRect) {
        try {
          injectedExternalHoverArtifact = document.createElement('div');
          injectedExternalHoverArtifact.className = 'ir-e2e-external-hover-artifact monaco-scrollable-element monaco-hover-content';
          var artifactLeft = Math.max(1, hoverRect.left + Math.min(42, Math.max(6, hoverRect.width * 0.08)));
          var artifactTop = Math.max(1, hoverRect.top + Math.min(38, Math.max(6, hoverRect.height * 0.08)));
          var artifactWidth = Math.max(180, Math.min(360, hoverRect.width - 48));
          injectedExternalHoverArtifact.textContent = 'stale native hover artifact should be detected';
          injectedExternalHoverArtifact.style.cssText = 'position:fixed;left:' + artifactLeft
            + 'px;top:' + artifactTop
            + 'px;width:' + artifactWidth
            + 'px;height:34px;z-index:2147483647;background:Canvas;border:1px solid rgba(128,128,128,0.72);box-shadow:0 1px 8px rgba(0,0,0,0.32);display:block;visibility:visible;pointer-events:auto;color:CanvasText;padding:6px;';
          document.body.appendChild(injectedExternalHoverArtifact);
          injectedExternalHoverArtifactRect = rectObj(injectedExternalHoverArtifact);
        } catch (_) {
          injectedExternalHoverArtifact = null;
        }
      }
      var sashMetrics = hoverSashMetrics(hover, hoverRect);
      var emptyHoverMetrics = emptyHoverOverlapMetrics(hover, hoverRect);
      var emptyHoverShells = emptyHoverShellMetrics(hover, hoverRect);
      var releasedHoverMetrics = releasedHoverConflictMetrics(hover, hoverRect);
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
        && hoverNearSymbol
        && releasedHoverMetrics.visibleReleasedHoverCount === 0
        && releasedHoverMetrics.overlappingReleasedHoverCount === 0
        && emptyHoverMetrics.visibleEmptyHoverCount === 0
        && emptyHoverMetrics.overlappingEmptyHoverCount === 0
        && emptyHoverShells.visibleEmptyHoverShellCount === 0
        && emptyHoverShells.overlappingEmptyHoverShellCount === 0
        && emptyHoverShells.visibleExternalHoverArtifactCount === 0
        && emptyHoverShells.overlappingExternalHoverArtifactCount === 0;
      var reason = 'ok';
      if (!ok) {
        if (!symbolGeometry) reason = 'missing-symbol-geometry';
        else if (!hover) reason = 'missing-hover';
        else if (releasedHoverMetrics.overlappingReleasedHoverCount) reason = 'overlapping-visible-released-native-hover';
        else if (releasedHoverMetrics.visibleReleasedHoverCount) reason = 'visible-released-native-hover';
        else if (roots.length !== 1) reason = 'multiple-visible-hover-roots';
        else if (selected.textLength <= 40) reason = 'empty-or-white-hover';
        else if (!contentMatches) reason = 'hover-content-mismatch';
        else if (!hoverNearSymbol) reason = 'hover-not-near-symbol';
        else if (!hoverAnchoredToExpectedColumn) reason = 'hover-not-in-expected-column';
        else if (emptyHoverMetrics.overlappingEmptyHoverCount) reason = 'overlapping-empty-hover';
        else if (emptyHoverMetrics.visibleEmptyHoverCount) reason = 'visible-empty-hover';
        else if (emptyHoverShells.overlappingEmptyHoverShellCount) reason = 'overlapping-empty-hover-shell';
        else if (emptyHoverShells.visibleEmptyHoverShellCount) reason = 'visible-empty-hover-shell';
        else if (emptyHoverShells.overlappingExternalHoverArtifactCount) reason = 'overlapping-external-hover-artifact';
        else if (emptyHoverShells.visibleExternalHoverArtifactCount) reason = 'visible-external-hover-artifact';
        else reason = 'unknown';
      }
      try {
        if (injectedEmptyTopCell && injectedEmptyTopCell.parentNode) {
          injectedEmptyTopCell.parentNode.removeChild(injectedEmptyTopCell);
        }
        if (injectedExternalHoverArtifact && injectedExternalHoverArtifact.parentNode) {
          injectedExternalHoverArtifact.parentNode.removeChild(injectedExternalHoverArtifact);
        }
      } catch (_) {}
      return {
        ok: ok,
        reason: reason,
        patchVersion: Number(window.__irPatchVersion) || 0,
        windowTitle: String(document.title || ''),
        locationHref: String(location && location.href || ''),
        marker: ${JSON.stringify(process.env.IR_TEST_WINDOW_MARKER || '')},
        viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
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
        visibleReleasedHoverCount: releasedHoverMetrics.visibleReleasedHoverCount,
        overlappingReleasedHoverCount: releasedHoverMetrics.overlappingReleasedHoverCount,
        visibleReleasedHoverRoots: releasedHoverMetrics.visibleReleasedHoverRoots,
        injectedEmptyTopCellForTests: !!expected.injectEmptyTopCellForTests,
        injectedEmptyTopCellRect: injectedEmptyTopCellRect,
        injectedExternalHoverArtifactForTests: !!expected.injectExternalHoverArtifactForTests,
        injectedExternalHoverArtifactRect: injectedExternalHoverArtifactRect,
        visibleEmptyHoverCount: emptyHoverMetrics.visibleEmptyHoverCount,
        overlappingEmptyHoverCount: emptyHoverMetrics.overlappingEmptyHoverCount,
        overlappingEmptyHoverRoots: emptyHoverMetrics.overlappingEmptyHoverRoots,
        visibleEmptyHoverShellCount: emptyHoverShells.visibleEmptyHoverShellCount,
        overlappingEmptyHoverShellCount: emptyHoverShells.overlappingEmptyHoverShellCount,
        visibleEmptyHoverShells: emptyHoverShells.visibleEmptyHoverShells,
        visibleExternalHoverArtifactCount: emptyHoverShells.visibleExternalHoverArtifactCount,
        overlappingExternalHoverArtifactCount: emptyHoverShells.overlappingExternalHoverArtifactCount,
        visibleExternalHoverArtifacts: emptyHoverShells.visibleExternalHoverArtifacts,
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
  const removeHiddenNative = false;
  const rendererExpr = `
    (function() {
      var removeHiddenNative = ${JSON.stringify(removeHiddenNative)};
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
        if (!isHidden && root.getAttribute && root.getAttribute('data-ir-native-released-hover') === '1') {
          try {
            if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
            if (root.__irReleaseRemoveTimer) {
              clearTimeout(root.__irReleaseRemoveTimer);
              root.__irReleaseRemoveTimer = null;
            }
            root.__irStickyUntil = 0;
            root.__irLastInsideAt = 0;
            root.__irReleasedAt = Date.now();
            root.__irReleasedText = String(root.textContent || '');
            if (root.classList) {
              root.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
              root.classList.add('ir-native-released-hover');
            }
            if (root.removeAttribute) {
              root.removeAttribute('data-ir-empty-hover-root');
            }
            if (root.setAttribute) root.setAttribute('data-ir-native-released-hover', '1');
            if (typeof irResetNativeHoverMutations === 'function') irResetNativeHoverMutations(root);
            if (typeof irRequestNativeHideHover === 'function') irRequestNativeHideHover('cleanup-visible-released');
            retainedNative++;
          } catch (_) {}
          continue;
        }
        if (!isHidden && root.classList && (
          root.classList.contains('ir-keepalive')
          || root.classList.contains('ir-scrollable')
          || root.classList.contains('ir-sticky')
          || root.classList.contains('ir-size-small')
          || root.classList.contains('ir-size-medium')
          || root.classList.contains('ir-size-large')
        )) {
          try {
            if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
            if (root.__irReleaseRemoveTimer) {
              clearTimeout(root.__irReleaseRemoveTimer);
              root.__irReleaseRemoveTimer = null;
            }
            root.__irReleasedAt = Date.now();
            root.__irReleasedText = String(root.textContent || '');
            root.__irPrimaryPreviewTarget = null;
            root.__irPreviewAppliedAt = 0;
            root.__irStickyUntil = 0;
            root.__irLastInsideAt = 0;
            root.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
            root.classList.add('ir-native-released-hover');
            if (root.removeAttribute) {
              root.removeAttribute('data-ir-empty-hover-root');
            }
            if (root.setAttribute) root.setAttribute('data-ir-native-released-hover', '1');
            if (typeof irResetNativeHoverMutations === 'function') irResetNativeHoverMutations(root);
            if (typeof irRequestNativeHideHover === 'function') irRequestNativeHideHover('cleanup-managed-visible');
            retainedNative++;
          } catch (_) {}
          continue;
        }
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
              // This is VS Code's empty in-flight placeholder. Marking it as a
              // released hover can block the next native hover fill.
              if (removeHiddenNative) {
                try { if (root.parentNode) { root.parentNode.removeChild(root); removed++; } } catch (_) {}
              } else {
                retainedNative++;
              }
              continue;
            }
            if (rootText) {
              if (root === window.__irActiveHoverEl) window.__irActiveHoverEl = null;
              try {
                if (root.__irReleaseRemoveTimer) {
                  clearTimeout(root.__irReleaseRemoveTimer);
                  root.__irReleaseRemoveTimer = null;
                }
                root.__irReleasedAt = Date.now();
                root.__irReleasedText = rootText;
                root.__irPrimaryPreviewTarget = null;
                root.__irPreviewAppliedAt = 0;
                root.__irStickyUntil = 0;
                root.__irLastInsideAt = 0;
                if (root.classList) {
                  root.classList.remove('ir-scrollable', 'ir-sticky', 'ir-size-small', 'ir-size-medium', 'ir-size-large', 'ir-keepalive', 'ir-empty-hover-root');
                  root.classList.add('ir-native-released-hover');
                }
                if (root.removeAttribute) {
                  root.removeAttribute('data-ir-empty-hover-root');
                }
                if (root.setAttribute) root.setAttribute('data-ir-native-released-hover', '1');
                if (root.style) {
                  root.style.removeProperty('pointer-events');
                }
              } catch (_) {}
              if (removeHiddenNative) {
                try { if (root.parentNode) { root.parentNode.removeChild(root); removed++; } } catch (_) {}
              } else {
                retainedNative++;
              }
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
      var all = Array.prototype.slice.call(document.querySelectorAll('.monaco-editor, .quick-input-widget, .context-view, .monaco-dialog-box, .monaco-inputbox, .native-edit-context'));
      try {
        if (document.activeElement) all.push(document.activeElement);
      } catch (_) {}
      var removed = 0;
      var hidden = 0;
      var detected = 0;
      var matched = [];
      var nativeRecorderActive = false;
      var bodyLooksLikeRecorder = false;
      try {
        bodyLooksLikeRecorder = text(document.body).indexOf(needle) >= 0;
        nativeRecorderActive = bodyLooksLikeRecorder && !!document.querySelector('.native-edit-context')
          || !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('native-edit-context'));
      } catch (_) {}
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el === document.body || el === document.documentElement) continue;
        var elText = text(el);
        var nativeEditContext = !!(el && el.classList && el.classList.contains('native-edit-context'));
        var closestEditor = el && el.closest && el.closest('.monaco-editor');
        var closestEditorText = text(closestEditor);
        var closestEditorViewLines = closestEditor && closestEditor.querySelectorAll ? closestEditor.querySelectorAll('.view-line').length : 0;
        var editorViewLines = el && el.querySelectorAll ? el.querySelectorAll('.view-line').length : 0;
        var recorderByNativeEdit = nativeEditContext
          && (elText.indexOf(needle) >= 0 || (closestEditorViewLines === 0 && closestEditorText.indexOf(needle) >= 0));
        var recorderShellEditor = !!(el && el.classList && el.classList.contains('monaco-editor'))
          && editorViewLines === 0
          && elText.indexOf(needle) >= 0;
        var directRecorderElement = elText.indexOf(needle) >= 0
          && !(el && el.classList && el.classList.contains('monaco-editor') && editorViewLines > 0);
        if (!directRecorderElement && !recorderByNativeEdit && !recorderShellEditor) continue;
        detected++;
        matched.push(brief(el));
        try { if (el.blur && nativeEditContext) el.blur(); } catch (_) {}
        try {
          if (nativeEditContext || !(el.classList && el.classList.contains('monaco-editor'))) {
            if (el.style) {
              el.style.setProperty('display', 'none', 'important');
              el.style.setProperty('visibility', 'hidden', 'important');
              el.style.setProperty('pointer-events', 'none', 'important');
              hidden++;
            }
          }
        } catch (_) {}
      }
      try { document.body && document.body.focus && document.body.focus(); } catch (_) {}
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        removed: removed,
        hidden: hidden,
        detected: detected,
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
    const pinnedPointer = await cdpRequest(cdpWs, 'Runtime.evaluate', {
      expression: `(function(){
        var x=${JSON.stringify(Math.round(x * 100) / 100)}, y=${JSON.stringify(Math.round(y * 100) / 100)};
        var target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
        var token = '';
        var editorSurface = false;
        try { if (typeof irEventTargetTokenText === 'function') token = irEventTargetTokenText({ target: target, clientX: x, clientY: y, type: 'test-cdp-pin' }) || ''; } catch (_) {}
        try { if (typeof irEventTargetsEditorSurface === 'function') editorSurface = !!irEventTargetsEditorSurface({ target: target, clientX: x, clientY: y, type: 'test-cdp-pin' }); } catch (_) {}
        if (!editorSurface) {
          try { editorSurface = !!(target && target.closest && target.closest('.monaco-editor')); } catch (_) {}
        }
        var pointer = { x: x, y: y, at: Date.now(), type: 'test-cdp-mouse' };
        window.__irLastPointer = pointer;
        window.__irNativeShowHoverRequest = {
          reason: 'test-cdp-mouse',
          at: Date.now(),
          pointer: pointer,
          token: token,
          editorSurface: editorSurface
        };
        return {
          token: token,
          editorSurface: editorSurface,
          targetClassName: target ? String(target.className || '') : '',
          targetText: target ? String(target.textContent || '').slice(0, 120) : ''
        };
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
      pinnedPointer: pinnedPointer?.result?.value || null,
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
          && !el.classList.contains('ir-e2e-empty-hover')
          && !el.classList.contains('workbench-hover');
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
      function rectsIntersect(a, b, pad) {
        if (!a || !b) return false;
        pad = pad || 0;
        return a.right >= b.left - pad
          && a.left <= b.right + pad
          && a.bottom >= b.top - pad
          && a.top <= b.bottom + pad;
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

async function runHoverScrollHarnessForTests(scrollTop?: number | {
  scrollTop?: number;
  wheelDeltaY?: number;
  x?: number;
  y?: number;
}): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const options = typeof scrollTop === 'object' && scrollTop !== null ? scrollTop : { scrollTop };
  const targetTop = Number.isFinite(Number(options.scrollTop)) ? Math.max(0, Math.floor(Number(options.scrollTop))) : null;
  const wheelDeltaY = Number.isFinite(Number(options.wheelDeltaY)) ? Number(options.wheelDeltaY) : null;
  const wheelX = Number.isFinite(Number(options.x)) ? Number(options.x) : null;
  const wheelY = Number.isFinite(Number(options.y)) ? Number(options.y) : null;
  const rendererExpr = `
    (async function() {
      var targetTop = ${JSON.stringify(targetTop)};
      var wheelDeltaY = ${JSON.stringify(wheelDeltaY)};
      var wheelX = ${JSON.stringify(wheelX)};
      var wheelY = ${JSON.stringify(wheelY)};
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
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        try {
          var r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        } catch (_) {
          return null;
        }
      }
      function rectsIntersect(a, b, pad) {
        if (!a || !b) return false;
        pad = pad || 0;
        return a.right >= b.left - pad
          && a.left <= b.right + pad
          && a.bottom >= b.top - pad
          && a.top <= b.bottom + pad;
      }
      function rectDistance(a, b) {
        if (!a || !b) return Infinity;
        var dx = 0;
        var dy = 0;
        if (a.right < b.left) dx = b.left - a.right;
        else if (b.right < a.left) dx = a.left - b.right;
        if (a.bottom < b.top) dy = b.top - a.bottom;
        else if (b.bottom < a.top) dy = a.top - b.bottom;
        return Math.sqrt((dx * dx) + (dy * dy));
      }
      function transientHoverText(text) {
        var key = String(text || '').replace(/\\s+/g, ' ').trim();
        return !key || key === 'Loading' || key === 'Loading...' || key === 'Loading…' || key.length <= 2;
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover')
          && !el.classList.contains('workbench-hover');
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
      var wheel = null;
      if (wheelDeltaY !== null) {
        var rect = hover.getBoundingClientRect();
        var x = Number.isFinite(wheelX) ? wheelX : Math.floor(rect.left + rect.width / 2);
        var y = Number.isFinite(wheelY) ? wheelY : Math.floor(rect.top + rect.height / 2);
        x = Math.max(1, Math.min((window.innerWidth || 1200) - 2, x));
        y = Math.max(1, Math.min((window.innerHeight || 800) - 2, y));
        var target = (typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null) || scroller || hover;
        var beforeWheel = snap(scroller);
        var dispatchResult = false;
        var defaultPrevented = false;
        try {
          var ev = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            deltaY: wheelDeltaY,
            deltaMode: 0
          });
          dispatchResult = target.dispatchEvent(ev);
          defaultPrevented = !!ev.defaultPrevented;
        } catch (_) {
          try {
            scroller.scrollTop = Math.min(Math.max(0, (scroller.scrollTop || 0) + wheelDeltaY), beforeWheel.maxTop);
          } catch (_) {}
        }
        await wait(120);
        wheel = {
          point: { x: x, y: y },
          deltaY: wheelDeltaY,
          targetClassName: String(target && target.className || ''),
          targetText: String(target && target.textContent || '').replace(/\\s+/g, ' ').slice(0, 180),
          dispatchResult: dispatchResult,
          defaultPrevented: defaultPrevented,
          before: beforeWheel,
          after: snap(scroller)
        };
      }
      var after = snap(scroller);
      return {
        ok: true,
        patchVersion: Number(window.__irPatchVersion) || 0,
        before: before,
        after: after,
        wheel: wheel,
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
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        try {
          var r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        } catch (_) {
          return null;
        }
      }
      function rectsIntersect(a, b, pad) {
        if (!a || !b) return false;
        pad = pad || 0;
        return a.right >= b.left - pad
          && a.left <= b.right + pad
          && a.bottom >= b.top - pad
          && a.top <= b.bottom + pad;
      }
      function rectDistance(a, b) {
        if (!a || !b) return Infinity;
        var dx = 0;
        var dy = 0;
        if (a.right < b.left) dx = b.left - a.right;
        else if (b.right < a.left) dx = a.left - b.right;
        if (a.bottom < b.top) dy = b.top - a.bottom;
        else if (b.bottom < a.top) dy = a.top - b.bottom;
        return Math.sqrt((dx * dx) + (dy * dy));
      }
      function transientHoverText(text) {
        var key = String(text || '').replace(/\\s+/g, ' ').trim();
        return !key || key === 'Loading' || key === 'Loading...' || key === 'Loading…' || key.length <= 2;
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover')
          && !el.classList.contains('workbench-hover');
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
      var btn = root ? root.querySelector('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"],a[data-href*="intellisenseRecursion.previewBack"]') : null;
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
      function rectObj(el) {
        if (!el || !el.getBoundingClientRect) return null;
        try {
          var r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        } catch (_) {
          return null;
        }
      }
      function rectsIntersect(a, b, pad) {
        if (!a || !b) return false;
        pad = pad || 0;
        return a.right >= b.left - pad
          && a.left <= b.right + pad
          && a.bottom >= b.top - pad
          && a.top <= b.bottom + pad;
      }
      function rectDistance(a, b) {
        if (!a || !b) return Infinity;
        var dx = 0;
        var dy = 0;
        if (a.right < b.left) dx = b.left - a.right;
        else if (b.right < a.left) dx = a.left - b.right;
        if (a.bottom < b.top) dy = b.top - a.bottom;
        else if (b.bottom < a.top) dy = a.top - b.bottom;
        return Math.sqrt((dx * dx) + (dy * dy));
      }
      function transientHoverText(text) {
        var key = String(text || '').replace(/\\s+/g, ' ').trim();
        return !key || key === 'Loading' || key === 'Loading...' || key === 'Loading…' || key.length <= 2;
      }
      function isActualHover(el) {
        return !!el
          && !el.classList.contains('ir-e2e-hover')
          && !el.classList.contains('ir-e2e-hover-link')
          && !el.classList.contains('ir-e2e-empty-hover')
          && !el.classList.contains('workbench-hover');
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
      function visibleEmptyHoverMetrics(activeRoot, activeRect) {
        var out = [];
        var roots = document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
        for (var i = 0; i < roots.length && out.length < 20; i++) {
          var root = roots[i];
          if (!document.body.contains(root) || !isActualHover(root) || root === activeRoot) continue;
          if (!visible(root)) continue;
          var text = String(root.textContent || '').trim();
          if (text.length > 0) continue;
          var rr = rectObj(root);
          out.push({
            index: i,
            className: String(root.className || ''),
            rect: rr,
            overlapsActive: !!(activeRect && rectsIntersect(rr, activeRect, 4)),
            active: root === window.__irActiveHoverEl
          });
        }
        var overlaps = 0;
        for (var oi = 0; oi < out.length; oi++) {
          if (out[oi].overlapsActive) overlaps++;
        }
        return {
          visibleEmptyHoverCount: out.length,
          overlappingEmptyHoverCount: overlaps,
          overlappingEmptyHoverRoots: out
        };
      }
      function visibleEmptyHoverShellMetrics(activeRoot, activeRect) {
        var out = [];
        var external = [];
        var candidates = [];
        var seen = [];
        function addCandidate(node, source, point) {
          if (!node || node.nodeType !== 1 || seen.indexOf(node) >= 0) return;
          seen.push(node);
          candidates.push({ node: node, source: source, point: point || null });
        }
        function cssColorVisible(value) {
          var v = String(value || '').replace(/\\s+/g, '').toLowerCase();
          if (!v || v === 'transparent') return false;
          if (/^rgba?\\(0,0,0,0\\)$/.test(v)) return false;
          if (/^rgba\\([^)]*,0(?:\\.0+)?\\)$/.test(v)) return false;
          return true;
        }
        function cssPx(value) {
          var n = parseFloat(String(value || '0'));
          return Number.isFinite(n) ? n : 0;
        }
        function paintsBox(node, cs) {
          cs = cs || (window.getComputedStyle ? window.getComputedStyle(node) : null);
          if (!cs) return false;
          if (cssColorVisible(cs.backgroundColor)) return true;
          if (String(cs.boxShadow || '').toLowerCase() !== 'none') return true;
          if (String(cs.outlineStyle || '').toLowerCase() !== 'none' && cssPx(cs.outlineWidth) > 0 && cssColorVisible(cs.outlineColor)) return true;
          var sides = ['Top', 'Right', 'Bottom', 'Left'];
          for (var si = 0; si < sides.length; si++) {
            var side = sides[si];
            if (String(cs['border' + side + 'Style'] || '').toLowerCase() !== 'none'
              && cssPx(cs['border' + side + 'Width']) > 0
              && cssColorVisible(cs['border' + side + 'Color'])) return true;
          }
          return false;
        }
        function hoverProbePoints(rect) {
          var out = [];
          var seenPoints = {};
          if (!rect) return out;
          function add(x, y) {
            var cx = Math.max(1, Math.min((window.innerWidth || 1) - 2, x));
            var cy = Math.max(1, Math.min((window.innerHeight || 1) - 2, y));
            var key = Math.round(cx) + ':' + Math.round(cy);
            if (seenPoints[key]) return;
            seenPoints[key] = true;
            out.push({ x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 });
          }
          var w = Math.max(1, rect.width || (rect.right - rect.left));
          var h = Math.max(1, rect.height || (rect.bottom - rect.top));
          var xs = [
            rect.left + 2,
            rect.left + Math.min(12, w * 0.12),
            rect.left + w * 0.18,
            rect.left + w * 0.33,
            rect.left + w * 0.5,
            rect.right - w * 0.33,
            rect.right - w * 0.18,
            rect.right - Math.min(12, w * 0.12),
            rect.right - 2
          ];
          var ys = [
            rect.top - 28,
            rect.top - 16,
            rect.top - 6,
            rect.top + 1,
            rect.top + 6,
            rect.top + Math.min(18, h * 0.12),
            rect.top + h * 0.18,
            rect.top + h * 0.5,
            rect.bottom - Math.min(18, h * 0.12),
            rect.bottom - 2,
            rect.bottom + 6
          ];
          for (var xi = 0; xi < xs.length; xi++) {
            for (var yi = 0; yi < ys.length; yi++) add(xs[xi], ys[yi]);
          }
          return out;
        }
        function emptyHoverDangerRelation(rr, activeRect) {
          if (!rr || !activeRect) {
            return { near: false, overlaps: false, directOverlap: false, topBand: false, distance: null };
          }
          var direct = rectsIntersect(rr, activeRect, 0);
          var padded = rectsIntersect(rr, activeRect, 24);
          var topBand = rr.bottom >= activeRect.top - 32
            && rr.top <= activeRect.top + 32
            && rr.right >= activeRect.left - 16
            && rr.left <= activeRect.right + 16;
          var distance = rectDistance(rr, activeRect);
          return {
            near: !!(padded || topBand || distance <= 24),
            overlaps: !!(padded || topBand),
            directOverlap: !!direct,
            topBand: !!topBand,
            distance: Math.round(distance)
          };
        }
        function stackIndexFor(stack, root) {
          if (!stack || !root) return -1;
          for (var si = 0; si < stack.length; si++) {
            var el = stack[si];
            try {
              if (el === root || (root.contains && root.contains(el))) return si;
            } catch (_) {}
          }
          return -1;
        }
        function artifactOccludesActive(node, rr, activeRoot, activeRect, sourcePoint) {
          if (!node || !activeRoot || !activeRect || !document.elementsFromPoint) return false;
          try {
            if (node.classList && node.classList.contains('ir-e2e-external-hover-artifact')) return true;
            var points = [];
            function add(x, y) {
              if (!Number.isFinite(x) || !Number.isFinite(y)) return;
              points.push({
                x: Math.max(1, Math.min((window.innerWidth || 1) - 2, x)),
                y: Math.max(1, Math.min((window.innerHeight || 1) - 2, y))
              });
            }
            if (sourcePoint) add(sourcePoint.x, sourcePoint.y);
            var ixLeft = Math.max(rr.left, activeRect.left);
            var ixRight = Math.min(rr.right, activeRect.right);
            var ixTop = Math.max(rr.top, activeRect.top);
            var ixBottom = Math.min(rr.bottom, activeRect.bottom);
            if (ixRight >= ixLeft && ixBottom >= ixTop) {
              add((ixLeft + ixRight) / 2, (ixTop + ixBottom) / 2);
              add(ixLeft + Math.min(8, Math.max(1, ixRight - ixLeft)), ixTop + Math.min(8, Math.max(1, ixBottom - ixTop)));
            }
            add(Math.max(rr.left + 2, Math.min(rr.right - 2, activeRect.left + 18)), Math.max(rr.top + 2, Math.min(rr.bottom - 2, activeRect.top + 8)));
            for (var pi = 0; pi < points.length; pi++) {
              var stack = document.elementsFromPoint(points[pi].x, points[pi].y) || [];
              var nodeIndex = stackIndexFor(stack, node);
              if (nodeIndex < 0) continue;
              var activeIndex = stackIndexFor(stack, activeRoot);
              if (activeIndex < 0 || nodeIndex < activeIndex) return true;
            }
          } catch (_) {}
          return false;
        }
        var nodes = document.querySelectorAll('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.context-view,[class*="hover"],[class*="Hover"],[class*="scrollable"],[class*="Scrollable"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"]');
        for (var ni = 0; ni < nodes.length; ni++) addCandidate(nodes[ni], 'selector', null);
        if (activeRoot && activeRoot.querySelectorAll) {
          var inside = activeRoot.querySelectorAll('div,[class*="hover"],[class*="Hover"],[class*="scroll"],[class*="Scroll"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"],[style*="z-index"],[style*="position"]');
          for (var ii = 0; ii < inside.length; ii++) addCandidate(inside[ii], 'inside-active', null);
        }
        if (activeRect && document.elementsFromPoint) {
          var points = hoverProbePoints(activeRect);
          for (var pi = 0; pi < points.length; pi++) {
            var stack = document.elementsFromPoint(points[pi].x, points[pi].y) || [];
            for (var si2 = 0; si2 < stack.length; si2++) addCandidate(stack[si2], 'hit-test', points[pi]);
          }
        }
        for (var i = 0; i < candidates.length && out.length < 30; i++) {
          var item = candidates[i];
          var node = item.node;
          if (!document.body.contains(node)) continue;
          if (node === activeRoot || node === document.body || node === document.documentElement) continue;
          if (activeRoot && node.contains && node.contains(activeRoot)) continue;
          var chromeCls = String(node.className || '');
          if ((node.closest && node.closest('.titlebar,.titlebar-container,.titlebar-drag-region,.command-center,.activitybar,.statusbar,.part.statusbar,.part.activitybar,.part.titlebar'))
            || /(titlebar|command-center|activitybar|statusbar|window-title|menubar|drag-region)/i.test(chromeCls)) continue;
          if (node.closest && node.closest('.tabs-and-actions-container,.tabs-container,.tab,.breadcrumbs-control,.monaco-breadcrumbs,.part.editor > .content,.editor-group-container > .title')) continue;
          var insideActive = !!(activeRoot && activeRoot.contains && activeRoot.contains(node));
          var inHoverOverlay = !!(node.closest && node.closest('.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,.context-view'));
          if (!insideActive && !inHoverOverlay && node.closest && node.closest('.monaco-split-view2,.part.sidebar,.part.auxiliarybar,.part.panel,.pane-body,.composite')) continue;
          if (node.closest && node.closest('.suggest-widget,.quick-input-widget,.parameter-hints-widget,.monaco-menu,.action-widget,.peekview-widget,.rename-box,.zone-widget,.find-widget,.markers-panel,.notifications-toasts,.notifications-center')) continue;
          if (!insideActive && node.closest && node.closest('.monaco-editor')) continue;
          if (!visible(node)) continue;
          var rr = rectObj(node);
          if (!rr || rr.width < 4 || rr.height < 4) continue;
          var relation = emptyHoverDangerRelation(rr, activeRect);
          if (!relation.near) continue;
          var occludesActive = insideActive ? true : artifactOccludesActive(node, rr, activeRoot, activeRect, item.point);
          var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
          var cls = String(node.className || '');
          if (/(^|\\s)(editor-instance|editor-container|editor-group-container|monaco-editor|overflow-guard|lines-content|view-lines|view-line)(\\s|$)/i.test(cls)) continue;
          if (/(sash|scrollbar|slider|shadow|decorationsOverviewRuler|scroll-decoration)/i.test(cls)) continue;
          var painted = paintsBox(node, cs);
          var positioned = !!(cs && /(absolute|fixed|sticky)/.test(String(cs.position || '')));
          var named = /(hover|scroll|context|overlay|cell|row|content)/i.test(cls);
          if (!painted && !positioned && !named) continue;
          var text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
          var strongHoverNamed = /(monaco-hover|editor-hover|resizable-hover|monaco-scrollable-element|monaco-hover-content|hover-row|hover-contents|markdown-hover|rendered-markdown|context-view)/i.test(cls);
          if (!strongHoverNamed && node.matches) {
            try { strongHoverNamed = !!node.matches('.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.context-view,.monaco-resizable-hover'); } catch (_) {}
          }
          if (!strongHoverNamed && node.closest) {
            try { strongHoverNamed = !!node.closest('.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,.context-view'); } catch (_) {}
          }
          if (!transientHoverText(text)) {
            if (!insideActive && occludesActive && text && strongHoverNamed && external.length < 30) {
              external.push({
                index: i,
                tagName: String(node.tagName || ''),
                source: item.source,
                point: item.point,
                className: cls,
                rect: rr,
                textLength: text.length,
                textSample: text.slice(0, 160),
                overlapsActive: relation.overlaps,
                directOverlapActive: relation.directOverlap,
                topBandActive: relation.topBand,
                distanceToActive: relation.distance,
                occludesActive: occludesActive,
                position: cs ? String(cs.position || '') : '',
                zIndex: cs ? String(cs.zIndex || '') : '',
                backgroundColor: cs ? String(cs.backgroundColor || '') : '',
                pointerEvents: cs ? String(cs.pointerEvents || '') : '',
                parentClassName: node.parentElement ? String(node.parentElement.className || '') : ''
              });
            }
            continue;
          }
          if (!insideActive && !occludesActive) continue;
          out.push({
            index: i,
            tagName: String(node.tagName || ''),
            source: item.source,
            point: item.point,
            insideActiveHover: insideActive,
            className: cls,
            rect: rr,
            textLength: text.length,
            textSample: text.slice(0, 80),
            overlapsActive: relation.overlaps,
            directOverlapActive: relation.directOverlap,
            topBandActive: relation.topBand,
            distanceToActive: relation.distance,
            occludesActive: occludesActive,
            position: cs ? String(cs.position || '') : '',
            zIndex: cs ? String(cs.zIndex || '') : '',
            backgroundColor: cs ? String(cs.backgroundColor || '') : '',
            pointerEvents: cs ? String(cs.pointerEvents || '') : '',
            parentClassName: node.parentElement ? String(node.parentElement.className || '') : ''
          });
        }
        var overlaps = 0;
        for (var oi = 0; oi < out.length; oi++) {
          if (out[oi].overlapsActive) overlaps++;
        }
        var externalOverlaps = 0;
        for (var ei = 0; ei < external.length; ei++) {
          if (external[ei].overlapsActive) externalOverlaps++;
        }
        return {
          visibleEmptyHoverShellCount: out.length,
          overlappingEmptyHoverShellCount: overlaps,
          visibleEmptyHoverShells: out,
          visibleExternalHoverArtifactCount: external.length,
          overlappingExternalHoverArtifactCount: externalOverlaps,
          visibleExternalHoverArtifacts: external
        };
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
        var rectSummary = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
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
        var emptyMetrics = visibleEmptyHoverMetrics(root, rectSummary);
        var emptyShellMetrics = visibleEmptyHoverShellMetrics(root, rectSummary);
        var scroller = root && hooks && typeof hooks.primaryHoverScroller === 'function'
          ? hooks.primaryHoverScroller(root)
          : null;
        var scrollTop = scroller ? Math.floor(scroller.scrollTop || 0) : 0;
        var scrollHeight = scroller ? Math.floor(scroller.scrollHeight || 0) : 0;
        var clientHeight = scroller ? Math.floor(scroller.clientHeight || 0) : 0;
        var backButtons = root ? root.querySelectorAll('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"],a[data-href*="intellisenseRecursion.previewBack"]') : [];
        var visibleBackButtons = 0;
        for (var bb = 0; bb < backButtons.length; bb++) {
          try {
            var bcs = window.getComputedStyle(backButtons[bb]);
            var br = backButtons[bb].getBoundingClientRect();
            if (bcs.display !== 'none' && bcs.visibility !== 'hidden' && br.width > 0 && br.height > 0) visibleBackButtons++;
          } catch (_) {}
        }
        return {
          ok: roots.length > 0
            && text.trim().length > 0
            && missing.length === 0
            && emptyRoots === 0
            && emptyMetrics.visibleEmptyHoverCount === 0
            && emptyMetrics.overlappingEmptyHoverCount === 0
            && emptyShellMetrics.visibleEmptyHoverShellCount === 0
            && emptyShellMetrics.overlappingEmptyHoverShellCount === 0
            && emptyShellMetrics.visibleExternalHoverArtifactCount === 0
            && emptyShellMetrics.overlappingExternalHoverArtifactCount === 0,
          reason: roots.length === 0 ? 'no-hover'
            : (text.trim().length === 0 ? 'empty-hover'
              : (emptyRoots ? 'stale-empty-hover'
                : (emptyMetrics.overlappingEmptyHoverCount ? 'overlapping-empty-hover'
                  : (emptyMetrics.visibleEmptyHoverCount ? 'visible-empty-hover'
                    : (emptyShellMetrics.overlappingEmptyHoverShellCount ? 'overlapping-empty-hover-shell'
                      : (emptyShellMetrics.visibleEmptyHoverShellCount ? 'visible-empty-hover-shell'
                        : (emptyShellMetrics.overlappingExternalHoverArtifactCount ? 'overlapping-external-hover-artifact'
                          : (emptyShellMetrics.visibleExternalHoverArtifactCount ? 'visible-external-hover-artifact'
                            : (missing.length ? 'missing-links' : 'ok'))))))))),
          patchVersion: Number(window.__irPatchVersion) || 0,
          hoverCount: roots.length,
          populatedHoverCount: populatedRoots,
          emptyHoverCount: emptyRoots,
          visibleEmptyHoverCount: emptyMetrics.visibleEmptyHoverCount,
          overlappingEmptyHoverCount: emptyMetrics.overlappingEmptyHoverCount,
          overlappingEmptyHoverRoots: emptyMetrics.overlappingEmptyHoverRoots,
          visibleEmptyHoverShellCount: emptyShellMetrics.visibleEmptyHoverShellCount,
          overlappingEmptyHoverShellCount: emptyShellMetrics.overlappingEmptyHoverShellCount,
          visibleEmptyHoverShells: emptyShellMetrics.visibleEmptyHoverShells,
          visibleExternalHoverArtifactCount: emptyShellMetrics.visibleExternalHoverArtifactCount,
          overlappingExternalHoverArtifactCount: emptyShellMetrics.overlappingExternalHoverArtifactCount,
          visibleExternalHoverArtifacts: emptyShellMetrics.visibleExternalHoverArtifacts,
          forcedHover: !!(root && root.getAttribute && root.getAttribute('data-ir-forced-hover') === '1'),
          activeClassName: root ? String(root.className || '') : '',
          activeTextLength: text.trim().length,
          activeText: text.slice(0, 8000),
          activeRect: rectSummary,
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

async function runHoverBoxCornerHarnessForTests(): Promise<any[]> {
  await ensureRendererPatchForHarness();
  const rendererExpr = `
    (function() {
      function pickActiveHover() {
        var roots = Array.prototype.slice.call(
          document.querySelectorAll('.monaco-hover,.monaco-editor-hover')
        );
        var best = null;
        var bestArea = 0;
        for (var i = 0; i < roots.length; i++) {
          var el = roots[i];
          if (!el || !el.getBoundingClientRect) continue;
          var text = String(el.textContent || '').trim();
          if (!text) continue;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          var area = r.width * r.height;
          if (area > bestArea) { best = el; bestArea = area; }
        }
        return best;
      }
      var hover = pickActiveHover();
      if (!hover) {
        return {
          ok: false,
          reason: 'no-active-hover',
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      }
      var snap = (typeof window.irHoverBoxCornerSnapshot === 'function')
        ? window.irHoverBoxCornerSnapshot(hover)
        : null;
      if (!snap || !snap.outer || !snap.inner) {
        return {
          ok: false,
          reason: snap ? (snap.outer ? 'missing-inner' : 'missing-outer') : 'missing-helper',
          snap: snap,
          patchVersion: Number(window.__irPatchVersion) || 0
        };
      }
      var cs = window.getComputedStyle(hover);
      var n = function(v){var x=parseFloat(v);return Number.isFinite(x)?x:0};
      var computedMaxHeight = n(cs.maxHeight);
      var computedMaxWidth = n(cs.maxWidth);
      return {
        ok: true,
        snap: snap,
        sizeTierName: String(hover.__irSizeTierName || ''),
        className: String(hover.className || ''),
        computedMaxHeight: computedMaxHeight,
        computedMaxWidth: computedMaxWidth,
        patchVersion: Number(window.__irPatchVersion) || 0
      };
    })()
  `.trim();
  const mainExpr = rendererTestWindowEvalExpression(rendererExpr, true);
  return evaluateInMainProcessForTests(mainExpr, 5000);
}

async function runHoverHoverGeometrySnapshotForTests(label?: string): Promise<any[]> {
  await ensureRendererPatchForHarness();
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) {
    return [{ value: { ok: false, reason: 'no-cdp-socket' } }];
  }
  const safeLabel = String(label || 'unlabeled').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
  // Metadata-only snapshot: identify the active hover, walk its full DOM
  // ancestor chain, list every hover-related sibling, capture computed styles
  // for the active hover and each ancestor. No PNG, no visual overlay. The
  // E2E asserts the contract documented in docs/hover-ui-structure.md from
  // this payload alone.
  const expr = `(function() {
    function rectObj(rr) { return rr ? { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom, width: rr.width, height: rr.height } : null; }
    function safeStyle(el) {
      try {
        var cs = window.getComputedStyle(el);
        return {
          position: cs.position, display: cs.display,
          width: cs.width, height: cs.height,
          maxWidth: cs.maxWidth, maxHeight: cs.maxHeight,
          top: cs.top, left: cs.left,
          transform: cs.transform,
          visibility: cs.visibility, opacity: Number(cs.opacity)
        };
      } catch (_) { return null; }
    }
    var roots = Array.prototype.slice.call(document.querySelectorAll('.monaco-hover, .monaco-editor-hover'));
    var best = null, bestArea = 0;
    for (var i = 0; i < roots.length; i++) {
      var el = roots[i];
      if (!el || !el.getBoundingClientRect) continue;
      var cs0 = window.getComputedStyle(el);
      if (cs0.display === 'none' || cs0.visibility === 'hidden' || Number(cs0.opacity) === 0) continue;
      var rr = el.getBoundingClientRect();
      if (rr.width < 10 || rr.height < 10) continue;
      var area = rr.width * rr.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (!best) return { ok: false, reason: 'no-active-hover' };
    var r = best.getBoundingClientRect();
    var sc = best.querySelector('.monaco-scrollable-element');
    var scR = sc && sc.getBoundingClientRect ? sc.getBoundingClientRect() : null;
    var content = best.querySelector('.monaco-hover-content');
    var contentR = content && content.getBoundingClientRect ? content.getBoundingClientRect() : null;
    var rmBest = null, rmBestArea = 0;
    var rmList = best.querySelectorAll('.rendered-markdown') || [];
    for (var rmi = 0; rmi < rmList.length; rmi++) {
      var rmEl = rmList[rmi];
      if (!rmEl || !rmEl.getBoundingClientRect) continue;
      var rmR = rmEl.getBoundingClientRect();
      var rmArea = Math.max(0, rmR.width) * Math.max(0, rmR.height);
      if (rmArea > rmBestArea) { rmBest = rmEl; rmBestArea = rmArea; }
    }
    var rmRect = rmBest && rmBest.getBoundingClientRect ? rmBest.getBoundingClientRect() : null;
    // Verify inner-as-scroller is the DOM descendant of outer (best). This
    // assertion is the foundation of the box-corner contract.
    var innerEl = sc;
    var sameTree = !!(innerEl && best.contains && best.contains(innerEl));
    var ancestorDepth = -1;
    if (sameTree) {
      var node = innerEl, depth = 0;
      while (node && node !== best && depth < 16) { node = node.parentNode; depth++; }
      if (node === best) ancestorDepth = depth;
    }
    // Walk up from best to document, capturing every ancestor (no class
    // filter — VS Code's true outer is .monaco-resizable-hover which is a
    // direct parent).
    var ancestors = [];
    var anc = best.parentNode, ad = 0;
    while (anc && anc !== document.documentElement && ad < 20) {
      try {
        var ar = anc.getBoundingClientRect ? anc.getBoundingClientRect() : null;
        var visible = !!(ar && ar.width > 0 && ar.height > 0);
        ancestors.push({
          depth: ad,
          tag: String(anc.tagName || ''),
          className: String(anc.className || '').slice(0, 200),
          rect: rectObj(ar),
          visible: visible,
          style: safeStyle(anc)
        });
      } catch (_) {}
      anc = anc.parentNode;
      ad++;
    }
    // Find siblings (other hover/widget elements in the document).
    var allRelated = document.querySelectorAll(
      '.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,[class*="workbench-hover"],[class*="content-widget"],[class*="hover-widget"]'
    );
    var siblings = [];
    for (var si = 0; si < allRelated.length; si++) {
      var oh = allRelated[si];
      if (oh === best) continue;
      try {
        var ohr = oh.getBoundingClientRect();
        var ocs = window.getComputedStyle(oh);
        var visible2 = ocs.display !== 'none' && ocs.visibility !== 'hidden' && Number(ocs.opacity) !== 0 && ohr.width > 4 && ohr.height > 4;
        siblings.push({
          tag: String(oh.tagName || ''),
          className: String(oh.className || '').slice(0, 200),
          rect: rectObj(ohr),
          visible: visible2,
          hasResizableParent: !!(oh.closest && oh.closest('.monaco-resizable-hover'))
        });
      } catch (_) {}
    }
    return {
      ok: true,
      label: ${jsonStringifyAscii(safeLabel)},
      outer: rectObj(r),
      scroller: rectObj(scR),
      content: rectObj(contentR),
      text: rectObj(rmRect),
      sameTree: sameTree,
      ancestorDepth: ancestorDepth,
      ancestors: ancestors,
      siblings: siblings,
      activeStyle: safeStyle(best),
      patchVersion: Number(window.__irPatchVersion) || 0
    };
  })()`;
  try {
    const resp = await cdpRequest(mainWsRef, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      includeCommandLineAPI: true,
      awaitPromise: false,
    }, 3000);
    const value = resp?.result?.value ?? resp?.result;
    return [{ value }];
  } catch (err) {
    return [{ value: { ok: false, reason: 'eval-failed', error: err instanceof Error ? err.message : String(err) } }];
  }
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
      if (applied && String(hover.textContent || '').trim().length === 0) {
        try {
          var buildMd = hooks && typeof hooks.buildMdDom === 'function' ? hooks.buildMdDom : (typeof irBuildMdDom === 'function' ? irBuildMdDom : null);
          var decodeMd = hooks && typeof hooks.decodeContent === 'function' ? hooks.decodeContent : (typeof irDecodeContent === 'function' ? irDecodeContent : function(s) { return s; });
          if (buildMd) {
            window.__irActiveHoverEl = hover;
            window.__irLastPreviewTarget = md;
            hover.__irPrimaryPreviewTarget = md;
            while (md.firstChild) md.removeChild(md.firstChild);
            md.classList.add('ir-applied');
            buildMd(decodeMd(markdown), md);
            if (typeof irEnsurePreviewBackButton === 'function') irEnsurePreviewBackButton(hover, md);
            if (typeof irSetPreviewTarget === 'function') irSetPreviewTarget(hover, md);
            try { hooks.scanRenderedMarkdown(); } catch (_) {}
          }
        } catch (_) {}
      }
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

  const re = identifierWordRegex(identifier, 'g');
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
  const re = identifierWordRegex(identifier, 'g');

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
  const rawAnchorPos = lastHoverFetchPosition;
  if (!rawAnchorPos) {
    log.warn(`preview: "${identifier}" no anchorPos — skipping (no prior hover position)`);
    return;
  }
  // Keep docUriStr (the backing analysis document) for definition lookup,
  // but let an overlay owner replace the anchor used by state, pending-hover
  // matching, click dedupe, and the eventual refire.
  const anchorPos = await resolveOverlayHoverAnchor(rawAnchorPos);
  const anchorUriKey = hoverRequestUriKey(anchorPos.uri);
  const originScrollState = currentPreviewState?.originScrollState
    ?? (previewHistory.length === 0 ? await capturePreviewScrollStateInRenderer() : undefined);
  if (dedupeRendererClick) {
    // (1) Anchor-and-identifier match: already showing this exact identifier
    // at this exact anchor — never re-drill.
    if (currentPreviewState?.identifier === identifier
      && previewStateMatchesHoverRequest(currentPreviewState, anchorUriKey, anchorPos.line, anchorPos.character)) {
      log.info(`preview: "${identifier}" duplicate ignored (already current)`);
      return;
    }
    // (2) Same-identifier-in-current-preview guard: when an identifier name
    // appears in multiple locations (e.g. Django `verbose_name`), each click
    // drilldown moves the anchor to the resolved definition. The new hover
    // then wraps the identifier again, the user (or a stray click) re-fires
    // it, and we resolve to a different anchor for the same name, building
    // an oscillation loop. If the click target equals the identifier of the
    // hover the user is currently looking at, we refuse — the user clicked
    // the name of the page they're already on.
    if (currentPreviewState?.identifier === identifier) {
      log.info(`preview: "${identifier}" duplicate ignored (same as current preview identifier, ambiguous re-drill)`);
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
    // (3) Identifier-only rapid dedupe: regardless of anchor, ignore repeat
    // clicks of the same identifier within the dedupe window. Catches the
    // oscillation-by-anchor-change case above when the previous resolve
    // landed on a different name (so guard #2 didn't catch it).
    const identifierOnlyKey = `__name:${identifier}`;
    const lastIdentifierClick = previewClickDedupe.get(identifierOnlyKey);
    if (lastIdentifierClick && previewClickNow - lastIdentifierClick <= PREVIEW_CLICK_DEDUPE_MS) {
      log.info(`preview: "${identifier}" duplicate ignored (${previewClickNow - lastIdentifierClick}ms, same-name rapid)`);
      return;
    }
    previewClickDedupe.set(identifierOnlyKey, previewClickNow);
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
        const re = identifierWordRegex(identifier);
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
    setCurrentPreviewState(await withCurrentRendererScrollState(currentPreviewState));
    previewHistory.push(currentPreviewState!);
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
  nextPreviewState.lastActivityAt = Date.now();
  setCurrentPreviewState(nextPreviewState);
}

async function refireHoverAtAnchor(anchor: { uri: vscode.Uri; line: number; character: number }): Promise<void> {
  // Overlay editors are renderer-owned and cannot be targeted through the
  // active file editor. Give the owner the first chance to refire in-place;
  // absent/declined/failed commands retain the native editor fallback below.
  if (await refireOverlayHover(anchor)) {
    recordPreviewHoverDebug({
      kind: "overlay-refire-handled",
      uri: anchor.uri.toString(),
      line: anchor.line,
      character: anchor.character,
    });
    return;
  }
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
  // Single hideHover with short settle. Earlier the double-hide + 280ms
  // total wait was there to guarantee VS Code's hover widget fully
  // disposed before the new showHover, but in practice one hide + 60 ms
  // is enough — the showHover that follows reuses the same content
  // widget. The previous combined 1100+ ms wait dominated the
  // user-perceived drill latency.
  await vscode.commands.executeCommand('editor.action.hideHover');
  await new Promise(resolve => setTimeout(resolve, 60));
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
  // Two attempts. The first usually works; the second is a safety net
  // for the rare case where VS Code's hover pipeline races the cursor
  // move. Gap of 180 ms instead of 360 ms — empirically that's still
  // long enough for the hover widget to redraw and short enough that
  // the user doesn't notice.
  const attemptCount = 2;
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
      await new Promise(resolve => setTimeout(resolve, 180));
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
    prev.lastActivityAt = Date.now();
    setCurrentPreviewState(prev);
    log.info(`previewBack: → "${prev.identifier}" stack=${previewHistory.length}`);
    // Capture drill wrapper position so the restored hover (still a
    // drilled page in this branch, since we popped to a previous drill)
    // also lands at the current visual location for smooth transition.
    try { await captureBackRestoreAnchor(); } catch {}
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
  setPendingPreviewHover(null);
  setPreviewHoverSuppress(0, null, 0);
  setCurrentPreviewState(null);
  log.info(`previewBack: → original native hover at ${anchorRef.line}:${anchorRef.character} (${ms()})`);
  await clearRendererPreviewNavigationStateInRenderer();
  // Capture drill wrapper position before refire so the restored initial
  // hover can land at the drill spot (= where mouse currently is) instead
  // of teleporting to symbol position. Avoids the "immediately focus-out"
  // case the user reports — mouse far from new hover → dismiss on next move.
  try { await captureBackRestoreAnchor(); } catch {}
  try {
    await Promise.race([
      refireHoverAtAnchor(anchorRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error('native refire timed out')), 4200)),
    ]);
  } catch (err) {
    log.warn(`previewBack: native refire error: ${err} (${ms()})`);
  }
  void originScrollState;
  await clearRendererPreviewNavigationStateInRenderer();
  setPendingPreviewHover(null);
  setPreviewHoverSuppress(0, null, 0);
  previewHistory.length = 0;
  setCurrentPreviewState(null);
  // Drill session ended — release frozen hover position so the next
  // fresh hover paints at its own anchor.
  // Drill mode auto-clears in the renderer when the next hover content
  // arrives without the [← Back] link.
}

/**
 * Build pendingPreviewHover from a PreviewState (always prepends a
 * "← Back" command link — first drill-down's back returns to the LSP
 * hover; deeper drill-downs pop the prior page off history), move the
 * editor cursor to the state's anchor, then hide+show the hover so VS
 * Code's native pipeline picks up the override. Shared by drill-down
 * and back.
 */
/**
 * Capture the current drill wrapper's position in the renderer and stash
 * it as window.__irBackRestoreAnchor. Called from previewBackHandler
 * before refireHoverAtAnchor so the restored initial hover can land at
 * the drill spot (= where mouse currently is, where the user just
 * clicked Back) instead of teleporting to the symbol's screen position.
 *
 * The renderer-side click listener (irInstallBackRestoreCapture) doesn't
 * reliably catch [← Back] clicks — VS Code's handler runs in capture phase
 * before ours. This extension-side eval is the dependable fallback.
 */
async function captureBackRestoreAnchor(): Promise<void> {
  if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) { return; }
  const rendererExpr = `
    (function() {
      try {
        var wrappers = document.querySelectorAll('.monaco-resizable-hover');
        var picked = null;
        var pickedRect = null;
        for (var i = 0; i < wrappers.length; i++) {
          var w = wrappers[i];
          if (!w || !document.body.contains(w)) continue;
          try {
            var cs = window.getComputedStyle(w);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          } catch (_) {}
          var r;
          try { r = w.getBoundingClientRect(); } catch (_) { continue; }
          if (!r || r.width < 60 || r.height < 60) continue;
          var hasBack = !!w.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
          if (!hasBack) {
            try { if (String(w.textContent || '').indexOf('← Back') >= 0) hasBack = true; } catch (_) {}
          }
          if (!hasBack) continue;
          picked = w;
          pickedRect = r;
          break;
        }
        if (!picked || !pickedRect) {
          return { ok: false, reason: 'no-visible-drill-wrapper' };
        }
        window.__irBackRestoreAnchor = {
          top: Math.round(pickedRect.top),
          left: Math.round(pickedRect.left),
          width: Math.round(pickedRect.width),
          height: Math.round(pickedRect.height),
          at: Date.now()
        };
        try {
          if (typeof window.__irHoverEventLog !== 'undefined' && window.__irHoverEventLog) {
            window.__irHoverEventLog.push({
              seq: (++window.__irHoverEventSeq) || 1,
              at: Date.now(),
              kind: 'back-restore-anchor-captured',
              anchor: window.__irBackRestoreAnchor,
              via: 'ext-eval'
            });
          }
        } catch (_) {}
        try {
          if (typeof window.irGoToType === 'function') {
            window.irGoToType('LOG:' + 'he-event back-restore-anchor-captured (ext-eval) ' + JSON.stringify(window.__irBackRestoreAnchor));
          }
        } catch (_) {}
        return { ok: true, anchor: window.__irBackRestoreAnchor };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e) };
      }
    })()
  `.trim();
  try {
    await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(rendererExpr, true), 1500);
  } catch (err) {
    log.warn("captureBackRestoreAnchor: " + (err instanceof Error ? err.message : String(err)));
  }
}

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
  // Tell the scroll-restore listener to ignore visibleRanges events
  // for the duration of this drill — refireHoverAtAnchor moves the
  // cursor, which fires visibleRanges, which would re-enter restore.
  markDrillFlowStart();
  // Prepend a [← Back] command link so VS Code's native hover, which renders
  // our markdown directly, exposes a control for previewBackHandler. First
  // drill-down pops back to the LSP hover; deeper drill-downs pop the prior
  // page off previewHistory.
  const backLink = '[← Back](command:intellisenseRecursion.previewBack)';
  const baseMarkdown = state.markdown.trimStart();
  const renderedMarkdown = baseMarkdown.startsWith(backLink)
    ? baseMarkdown
    : `${backLink}\n\n${baseMarkdown}`;
  const renderedMarkdownContent = {
    value: renderedMarkdown,
    isTrusted: true,
    supportThemeIcons: true,
  };
  const anchorDoc = findOpenDoc(state.anchor.uri);
  const pendingRange = internalRangeFromVsCode(state.anchorRange)
    ?? internalFullWordRangeAt(anchorDoc, new vscode.Position(state.anchor.line, state.anchor.character));
  const nextPendingPreviewHover: PendingPreviewHover = {
    identifier: state.identifier,
    contents: [renderedMarkdownContent],
    range: pendingRange,
    anchorUriKey: hoverRequestUriKey(state.anchor.uri),
    anchorLine: state.anchor.line,
    anchorCharacter: state.anchor.character,
    expiresAt: Date.now() + 3000,
  };
  setPendingPreviewHover(nextPendingPreviewHover);
  recordPreviewHoverDebug({
    kind: "pending-set",
    identifier: state.identifier,
    anchorUriKey: nextPendingPreviewHover.anchorUriKey,
    anchorLine: nextPendingPreviewHover.anchorLine,
    anchorCharacter: nextPendingPreviewHover.anchorCharacter,
    hasRange: !!nextPendingPreviewHover.range,
    range: nextPendingPreviewHover.range || null,
    markdownLength: renderedMarkdown.length,
  });
  setPreviewHoverSuppress(0, null, 0);

  // Flip the renderer into drill mode BEFORE we re-fire the hover. The
  // prototype-patched widget.getPosition() will freeze the position
  // (captured from the initial hover's natural position) and return it
  // for VS Code's layout pass — so the drilled hover paints at the same
  // anchor as the initial hover, even though its content changed.
  // Flip the renderer into drill mode. The hover widget's wrapped
  // getPosition() will replay the frozen natural position captured before
  // drill started — VS Code's layout pass then paints the drilled hover
  // at the same anchor as the initial hover.
  // Drill mode is detected in the renderer by inspecting hover content
  // for the [← Back] command link — no extension→renderer eval needed
  // here. (Previous eval-based signaling occasionally tripped the
  // keybinding-recorder UI.)

  try {
    recordPreviewHoverDebug({
      kind: "renderer-refire-native-only",
      identifier: state.identifier,
      source: fromBack ? 'preview-back-native' : 'preview-forward-native',
    });
    await refireHoverAtAnchor(state.anchor);
    log.info(`preview: "${state.identifier}" hide+showHover hist=${previewHistory.length} (${state.markdown.length}md, ${ms()})`);
  } catch (err) {
    log.warn(`preview: hide+showHover error: ${err} (${ms()})`);
  } finally {
    markDrillFlowEnd();
  }
}

async function setRendererDrillMode(active: boolean): Promise<void> {
  try {
    if (!mainWsRef || mainWsRef.readyState !== WebSocket.OPEN) return;
    const expr = `(window.__irSetDrillMode && window.__irSetDrillMode(${JSON.stringify(!!active)})) || {ok:false,reason:'no-setter'}`;
    await evaluateInMainProcessForTests(rendererTestWindowEvalExpression(expr, true), 1500);
  } catch (err) {
    log.warn(`setRendererDrillMode error: ${err}`);
  }
}

// httpGet + evaluateInspectorExpression + findInspectorWebSocketUrlForPid
// moved to ./cdp-discovery (Phase 15a split).

// getHoverPatchScript() (the ~10500-line renderer JS-in-string) moved to
// ./renderer-patch (Phase 16 split). All callers continue to import it.

// ── Type detection (for $provideHover preview) ──
// SKIP_WORDS, declarationIdentifiersInLine, decoratorIdentifiersInLine,
// addNavigableName moved to ./idents (Phase 3a split).

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
// CODE_SCHEMES + isCodeDoc moved to ./util (Phase 5 prep).

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
  shutdownPrefetch();
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
  setSidecarIndexManager(null);
  log.info('Extension deactivated');
  log.dispose();
}
