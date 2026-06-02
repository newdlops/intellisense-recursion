import * as vscode from 'vscode';

// Drill-down history: each forward drill-down pushes the previously
// rendered drill-down state onto previewHistory; "Back" pops it back
// into currentPreviewState and refires the hover. The stack is reset
// whenever $provideHover reaches the genuine LSP path (i.e. past the
// pending-preview consume + suppression window) — that's the moment a
// brand-new hover session starts, so no prior chain should carry over.
export interface PreviewState {
  identifier: string;
  markdown: string;          // raw drill-down body, no back link prepended
  anchor: { uri: vscode.Uri; line: number; character: number };
  anchorRange?: vscode.Range;
  scrollState?: PreviewScrollState;
  originScrollState?: PreviewScrollState;
  /** Last time this state was created, drilled, back'd, or served as a
   * same-anchor re-query response. Used to expire stale state after
   * the user mouses out — without this, hovering the same symbol later
   * replays the last drill state instead of showing a fresh initial hover. */
  lastActivityAt?: number;
}
export const PREVIEW_STATE_IDLE_TTL_MS = 1500;
export interface PreviewScrollState {
  scrollerScrollTop?: number;
  hoverScrollTop?: number;
  rowScrollTop?: number;
  targetScrollTop?: number;
}
export const previewHistory: PreviewState[] = [];
export let currentPreviewState: PreviewState | null = null;
export function setCurrentPreviewState(s: PreviewState | null): void { currentPreviewState = s; }

let scrollRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let scrollRestoreInFlight = false;
let scrollRestoreLastAt = 0;
export let drillFlowInProgress = false;
export let drillFlowEndedAt = 0;
export let scrollPendingFromDrill = false;
export function setScrollPendingFromDrill(v: boolean): void { scrollPendingFromDrill = v; }

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };
type ApplyPreviewStateAsHover = (state: PreviewState, ms: () => string, fromScrollRestore: boolean) => Promise<unknown>;
let _logger: Logger | null = null;
let _applyPreviewStateAsHover: ApplyPreviewStateAsHover | null = null;
export function setPreviewHistoryLogger(logger: Logger): void { _logger = logger; }
export function setApplyPreviewStateAsHover(fn: ApplyPreviewStateAsHover): void { _applyPreviewStateAsHover = fn; }

export function markDrillFlowStart(): void {
  drillFlowInProgress = true;
}
export function markDrillFlowEnd(): void {
  drillFlowInProgress = false;
  drillFlowEndedAt = Date.now();
  // If a scroll event arrived while the drill was in flight, flush
  // the deferred restore now that we're clear. Add a small delay so
  // the post-drill guard window expires first.
  if (scrollPendingFromDrill) {
    scrollPendingFromDrill = false;
    setTimeout(() => {
      if (currentPreviewState) { scheduleScrollRestoreHover(); }
    }, 480);
  }
}
// DEPRECATED / DISABLED (native-only pivot): scroll is now 100% VS Code's.
// scheduleScrollRestoreHover re-fired applyPreviewStateAsHover →
// refireHoverAtAnchor on every scroll while currentPreviewState was alive,
// and refireHoverAtAnchor reveals the anchor (revealRange
// InCenterIfOutsideViewport). Because the drill session was never cleared on
// native dismiss (focus-out), scrolling AFTER focus-out kept yanking the
// editor back to the symbol — the "scroll jumps to symbol" annoyance. Per the
// native-only direction (VS Code owns scroll/dismiss; we keep ONLY content +
// drill), let a scroll dismiss the drilled hover natively: no re-show, no
// editor reveal/jump. Flip to re-enable the old re-fire behavior.
// `: boolean` (not the inferred `false` literal) keeps the body reachable to
// the type checker so its existing control-flow narrowing still holds.
const SCROLL_RESTORE_ENABLED: boolean = false;
export function scheduleScrollRestoreHover(): void {
  // Single chokepoint: gating here covers the visibleRanges listener, the
  // markDrillFlowEnd flush, and the post-guard retry timer.
  if (!SCROLL_RESTORE_ENABLED) { return; }
  // Guards:
  //   - scrollRestoreInFlight: refireHoverAtAnchor moves the cursor
  //     which fires onDidChangeTextEditorVisibleRanges again. Without
  //     the in-flight flag we'd re-enter.
  //   - scrollRestoreLastAt: skip restores within 800 ms of the
  //     previous one.
  //   - drillFlowInProgress / drillFlowEndedAt: if a drill
  //     (previewTypeHandler → applyPreviewStateAsHover →
  //     refireHoverAtAnchor) is mid-execution, the cursor moves it
  //     does fire visibleRanges events we did NOT cause from the user.
  //     Restoring on those races the in-flight drill. Wait at least
  //     400 ms after drill completion before re-acting to scrolls.
  const now = Date.now();
  if (scrollRestoreInFlight) { return; }
  if (drillFlowInProgress) { return; }
  if (now - drillFlowEndedAt < 400) { return; }
  // Bumped from 800 ms to 2000 ms: log analysis showed a continuous
  // scroll producing two restores 1.1 s apart (452ms + 416ms drill
  // re-fire each). The 800 ms window let the second one through.
  if (now - scrollRestoreLastAt < 2000) { return; }
  if (scrollRestoreTimer) { clearTimeout(scrollRestoreTimer); }
  scrollRestoreTimer = setTimeout(async () => {
    scrollRestoreTimer = null;
    if (!currentPreviewState) { return; }
    if (drillFlowInProgress) { return; }
    if (Date.now() - drillFlowEndedAt < 400) { return; }
    scrollRestoreInFlight = true;
    scrollRestoreLastAt = Date.now();
    try {
      const t0 = Date.now();
      const ms = () => `${Date.now() - t0}ms`;
      if (_applyPreviewStateAsHover) { await _applyPreviewStateAsHover(currentPreviewState, ms, true); }
      _logger?.info(`preview: scroll-restore re-fired drilled hover at ${currentPreviewState.anchor.line}:${currentPreviewState.anchor.character} (${ms()})`);
    } catch (err) {
      _logger?.warn(`scroll-restore re-fire error: ${err}`);
    } finally {
      scrollRestoreInFlight = false;
    }
  }, 220);
}
