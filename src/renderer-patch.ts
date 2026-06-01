// Renderer patch script extracted from extension.ts (Phase 16).
//
// Scope:
//   The entire JS-in-string that gets eval'd inside the VS Code renderer
//   process to install ir-keepalive / drill hover / sweep cleanup / DOM-
//   level markdown rendering / Monaco capture / native hover anatomy probe.
//   This is the L48~L61 hover stability surface — every byte here is
//   load-bearing.
//
// Why split: the in-extension template literal grew past 10k lines and was
// dominating bundle search/edit cost in extension.ts. The string itself
// remains byte-identical to the pre-Phase-16 version; only the file it
// lives in changed. RENDERER_PATCH_VERSION moved here too because the
// `${RENDERER_PATCH_VERSION}` interpolation inside the template needs the
// constant in the same module scope to resolve.
//
// Cross-module dependencies: none. The string is opaque to TS — embedded
// JS comments / banners inside it are NOT TS structure.

// v279 (L111+L112+L113, 2026-06-01): the log's v= confirms which build is loaded.
// (L108/L109/L110 were already taken by prior work; this session's fixes are L111+.)
//   L111 — primary-handle gate on the page-transition (drill) content return, so
//          native mode stops stacking the drill preview N× per showHover fanout
//          (was 11.5s on a 1657-line class). [ext-host]
//   L112 — retry the renderer-injection CDP discovery with backoff instead of giving
//          up to the 5-minute safety timer; a transient inspector race on reload left
//          the patch uninjected and drill dead (2026-06-01 10:46). [ext-host]
//   L113 — native mode skips the dead "outside-editor-new-token" management branch in
//          irHoverGuard (logged managed={disposed} 80×/session of pure overlay churn).
//   L114 — native mode early-returns from irHoverGuard doing ONLY drill-link wrapping;
//          skips ALL remaining management (active-near-non-editor-pass +
//          stopImmediatePropagation storm, sticky/release/refire, .ir-keepalive). The
//          per-branch gating (L113) was whack-a-mole; this abandons overlay wholesale.
//   L115 — scroll listener re-arms __irViewportWrap + re-scans ONLY for huge (>24K)
//          band-wrapped blocks; small hovers no longer re-tokenize every scroll tick
//          (mtk≈108ms storm = "char col 변경시 hover 깨짐").
//   L116 — (REVERTED by L117) tried to grow large hovers past VS Code's minimal ~177px box.
//   L117 — reverted L116 (intrinsic wrapper broke host height:100% → scroll died, maxTop:0).
//   L118 — (ROLLED BACK by L119) all-content-driven sizing to grow the box to content.
//   L119 — rolled back L118: the taller box covered the symbol. Settled: VS Code owns box height
//          AND placement; accept its (smaller) height — box scrolls. (v283 A state.)
//   L120 — KEEP the resize sash in native so the user can drag a small drill hover taller.
//   L121 — cache the candidate-name list + alternation regex per block (viewport-wrap re-scan reuse).
//   L122 — native cleanup of OUR bookkeeping when VS Code dismisses the active hover (drop ref +
//          stop observer + clear timers) — fixes CPU that persisted after the hover.
//   L123 — huge-hover tail fence now ```plaintext (was empty ```): cut TextMate tokenization
//          (mtk 6693->2045 spans, longtask 1687->573ms). Full content kept. [ext-host]
//   L124 — native mode stops the scroll-driven band-wrap re-scan (storm). Drill wraps on-demand.
//   L125 — shrink huge-hover DOM at source: head highlight 120->60 + 300-line cap (mtk 2045->494).
//   L126 — eager-wrap threshold 24000->4000 (capped hover: full-wrap 394 spans -> band-wrap 12).
//   L127 — coalesce the on-demand wrap in native irHoverGuard (pointer dedup ±4px/40ms; ~halves it).
//   L128 — REVERTED L125's line cap (truncation not wanted). Full content; cost held by L123+L126.
//   L129 — (superseded by L130) head highlight 60->200.
//   L130 — user chose B: FULL highlight, NO head/tail split. Freeze acceptable even on a 52k class.
//   L131 — free retained per-block scan caches on dismiss (memory leak fix). Confirmed our code is
//          clean post-dismiss: 19:10+ log had 0 ir-sync-longtask (all 20 longtasks attribution:
//          unknown = VS Code) and no extension hover-resolves after the last hover — the residual
//          CPU/retained 52k DOM is VS Code's (full-highlight B + VS Code keeps hidden hover content).
//   L132 — hover border 2px -> 1px (user: thinner).
// If the running window still logs v<298, the new build is NOT loaded yet.
export const RENDERER_PATCH_VERSION = 298;

export function getHoverPatchScript(): string {
  return `(function(){
var IR_PATCH_VERSION = ${RENDERER_PATCH_VERSION};
// L89/L91 (2026-05-31): native-hover restoration master switch. MUST be assigned HERE at the
// top of the IIFE — before the CSS array (style.textContent=[...] below) reads it synchronously,
// and before any hover runs. When true the patch stops "adopting" VS Code's hover: function
// gates skip staging/keepalive/sticky/forced-size/width-freeze/reposition, so VS Code places the
// hover natively. (v256: the CSS size/sash-takeover REMOVAL was reverted — it dropped the
// max-height cap and ballooned big hovers; native resize/size is still TODO via a capped
// approach.) We still attach our markdown (patched provideHover, IR_VTAIL_MODE='native')
// and wrap navigable type names for drill. false = full managed behaviour (L48-L88).
var IR_HOVER_NATIVE_ONLY=true;
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
    // L34: 250ms throttle. This runs at the start of every
    // irScanRenderedMarkdown, which a mutation burst can trigger many
    // times in a frame. Each pass does querySelectorAll over all hover
    // roots + iterates to dispose stale ones — purely cleanup work that
    // doesn't need to run multiple times per drill burst. The throttle
    // collapses the 37+/burst prune calls observed in logs down to ~1.
    var pruneNow=Date.now();
    var lastPruneAt=Number(window.__irLastPruneAt)||0;
    if(pruneNow-lastPruneAt<250)return;
    window.__irLastPruneAt=pruneNow;
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
  // We take full control of VS Code's resizable-hover wrapper too. Without
  // this, VS Code caps it at its own internal max-height (~252px) while our
  // .monaco-hover grows to content, leaving the two boxes visually drifting.
  // Force resizable-hover to follow content size, no transform, no inherited
  // max-height cap from VS Code internals.
  // Pre-adoption state: a freshly-created .monaco-hover that has NOT yet been
  // adopted into a .monaco-resizable-hover wrapper has ZERO size and is
  // hidden. Otherwise the inner content (especially with raised verbosity)
  // would briefly cover the viewport before our caps and the wrapper attach.
  // The post-adoption rule below restores natural sizing once VS Code wraps
  // the hover into .monaco-resizable-hover. Children (scroller, content,
  // rows, rendered-markdown) are also clamped to 0×0 so nothing inside can
  // escape and paint while the hover is in the unwrapped state.
  // L91 NOTE (v256, 2026-05-31): REMOVING this "resizable-hover takeover" block in native mode
  // (v255) dropped the max-height:48vh cap + scroller overflow, so big hovers ballooned to full
  // content height (~32000px) = no scroll + slow layout. Reverted to unconditional. Native
  // resize/size must be done by KEEPING the caps and only unpinning width/height + showing the
  // sash, NOT by removing the block. TODO.
  '.monaco-hover,.monaco-editor-hover{box-sizing:border-box !important;width:0 !important;height:0 !important;min-width:0 !important;min-height:0 !important;max-width:0 !important;max-height:0 !important;overflow:hidden !important;visibility:hidden !important;pointer-events:auto !important;z-index:2147483647 !important}',
  '.monaco-hover .monaco-scrollable-element,.monaco-hover .monaco-hover-content,.monaco-hover .hover-row,.monaco-hover .hover-row-contents,.monaco-hover .markdown-hover,.monaco-hover .rendered-markdown,.monaco-editor-hover .monaco-scrollable-element,.monaco-editor-hover .monaco-hover-content,.monaco-editor-hover .hover-row,.monaco-editor-hover .hover-row-contents,.monaco-editor-hover .markdown-hover,.monaco-editor-hover .rendered-markdown{width:0 !important;height:0 !important;min-width:0 !important;min-height:0 !important;max-width:0 !important;max-height:0 !important;overflow:hidden !important}',
  // Inner sizing is restored as soon as the hover is inside .monaco-resizable-hover.
  // (Earlier attempt to gate this on a .ir-ready class created a chicken-and-egg
  // — inner stayed 0×0 → aligner saw 0×0 child → never marked wrapper ready —
  // and hovers never appeared.) The viewport-cover-during-creation flash is now
  // mitigated by the base caps (max-width 680, max-height 48vh) which apply
  // immediately, and by the visibility check on the wrapper bbox in aligner.
  // L103-fix (2026-05-31): height:100% (not auto) makes the host fill the
  // wrapper's DEFINITE inline px height (VS Code sizes the resizable wrapper to
  // ~177/250px). MEASURED via hover-size-audit.
  // L104-fix (2026-05-31): height:100% on the host was NOT enough. The audit
  // (v269) proved the host DID resolve to the wrapper (hostH=246) but the
  // scroller's height:calc(100% - 2px) STILL did not resolve — it fell through to
  // its max-height:48vh and sized to content (scrollerH=511). So a 511px scroller
  // sat inside a 246px host: the native scrollbar ran off the bottom of the
  // visible hover and the bottom content was unreachable; short hovers (488px
  // scroller in a 246px host, maxTop=0) were cut off with no scrollbar at all.
  // FIX: make the host a flex column and the scroller flex:1 1 auto (height:auto,
  // max-height:none). The flex algorithm fills the host's definite height EXACTLY
  // — no fragile percentage-height resolution — so scrollerH == hostH and the
  // scrollbar always lives inside the visible host (overflow:auto scrolls the
  // content within it). min-height:0 is REQUIRED so a flex item can shrink below
  // its content height; without it the flex item refuses to shrink and overflows
  // again. NOTE: this fits the scroller to VS Code's chosen box height; the box
  // itself stays at VS Code's (arbitrary 246/177) height so native resize keeps
  // working. Growing the box to content is a separate opt-in (see wrapper rule
  // below). cf. project_hover_rerender_exact_position_key.
  // L119 (2026-06-01): ROLLED BACK L118. The all-content-driven box (grow to content/48vh)
  // made the box taller, and VS Code positions a taller hover OVER the symbol it describes
  // (user: "호버 위치가 심볼을 가리네"). Back to A (v283): host height:100% fills VS Code's
  // definite box, scroller flex-fills it, box stays VS Code's (smaller) height + placement.
  // Growing the box conflicts with native placement; not pursued further without a position fix.
  '.monaco-resizable-hover .monaco-hover,.monaco-resizable-hover .monaco-editor-hover{display:flex !important;flex-direction:column !important;width:min(max-content,680px) !important;height:100% !important;min-width:0 !important;min-height:0 !important;max-width:680px !important;max-height:48vh !important;visibility:visible !important}',
  '.monaco-resizable-hover .monaco-hover .monaco-scrollable-element,.monaco-resizable-hover .monaco-editor-hover .monaco-scrollable-element{flex:1 1 auto !important;width:calc(100% - 2px) !important;height:auto !important;max-width:calc(100% - 2px) !important;max-height:none !important;min-width:0 !important;min-height:0 !important;overflow:auto !important;overscroll-behavior:contain !important;margin:1px !important}',
  '.monaco-resizable-hover .monaco-hover .monaco-hover-content,.monaco-resizable-hover .monaco-hover .hover-row,.monaco-resizable-hover .monaco-hover .hover-row-contents,.monaco-resizable-hover .monaco-hover .markdown-hover,.monaco-resizable-hover .monaco-hover .rendered-markdown{width:auto !important;height:auto !important;max-width:100% !important;max-height:none !important;min-width:0 !important;min-height:0 !important;overflow:visible !important}',
  // The drilled hover's wrapper transiently grows to viewport size
  // (e.g., 1800×1069) during content swap before settling. Log
  // analysis showed 63+ "visible" frames at that size. Hard-clamp
  // width to 680px regardless of what _resizableNode.layout writes
  // to inline style — without !important on width:min(...) VS Code's
  // inline width="1800px" wins; we use width:min() to combine our
  // soft sizing with a hard ceiling, plus overflow:hidden on the
  // wrapper so a stretchier inner can't escape.
  // L60 (2026-05-28): lead with --vscode-focusBorder so the stroke wins in both light and
  // dark themes (L58's editorHoverWidget-border alone read as nearly invisible on light themes —
  // a very faint platform gray). focusBorder is theme-specified to stand out (blue/accent), with
  // editorHoverWidget-border as a quieter fallback and a darker neutral gray (0.85 alpha) last.
  // L132 (2026-06-01): width 2px -> 1px (user: thinner border). box-sizing border-box absorbs it.
  // L92 (2026-05-31): native mode drops the !important on width/height so VS Code's inline resize
  // (the native sash) wins, but KEEPS the max-width/max-height caps (no balloon, scroll preserved)
  // — max-width:680 still clamps VS Code's transient 1800px mid-resize write. Managed = original pin.
  // L104 NOTE (2026-05-31): height:max-content is INTENTIONALLY non-!important here so the wrapper
  // keeps VS Code's inline height (resize works). The L104 scroll-fit fix lives on the host/scroller
  // (flex, above), NOT here.
  // L104 NOTE: height:max-content is non-!important so the wrapper keeps VS Code's inline height
  // (resize + native placement work). L116/L118 both tried to grow it to content and both
  // regressed (L116: scroll died maxTop:0; L118: taller box covered the symbol). Conclusion:
  // VS Code owns the box height AND placement — growing the box past VS Code's height fights its
  // positioning. Accept VS Code's (smaller) height; the box scrolls. cf. feedback_vscode_owns_hover_height.
  (IR_HOVER_NATIVE_ONLY
    ? '.monaco-resizable-hover{box-sizing:border-box !important;width:min(max-content,680px);height:max-content;max-width:680px !important;max-height:48vh !important;min-width:0 !important;min-height:0 !important;overflow:hidden !important;transform:none !important;padding:0 !important;margin:0 !important;pointer-events:auto !important;z-index:2147483647 !important;border:1px solid var(--vscode-focusBorder, var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.85))) !important;border-radius:4px !important}'
    : '.monaco-resizable-hover{box-sizing:border-box !important;width:min(max-content,680px) !important;height:max-content !important;max-width:680px !important;max-height:48vh !important;min-width:0 !important;min-height:0 !important;overflow:hidden !important;transform:none !important;padding:0 !important;margin:0 !important;pointer-events:auto !important;z-index:2147483647 !important;border:1px solid var(--vscode-focusBorder, var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.85))) !important;border-radius:4px !important}'),
  // Force inner .monaco-hover (and its primary inner panels) to stick
  // to the ancestor wrapper via position:static and clear any fixed/
  // absolute placement VS Code may have applied. Diagnostic showed inner
  // .monaco-hover with computed position:fixed at (1112,522) while the
  // ancestor wrapper sat at (1865,831) — completely decoupled.
  // Use a descendant selector (not '>') because there can be an
  // intermediate wrapper between .monaco-resizable-hover and .monaco-hover.
  // Repeat the class to bump specificity above VS Code's
  // ".monaco-editor .monaco-hover.fade-in" (0,3,0) selector that would
  // otherwise re-impose position:fixed.
  '.monaco-resizable-hover .monaco-hover.monaco-hover.monaco-hover,.monaco-resizable-hover .monaco-hover-content.monaco-hover-content,.monaco-resizable-hover .monaco-scrollable-element.monaco-scrollable-element{position:static !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;transform:none !important;inset:auto !important}',
  '.monaco-resizable-hover > .monaco-hover{width:100% !important;height:auto !important;max-width:100% !important;max-height:100% !important;margin:0 !important}',
  // L92: native mode does NOT hide the resize sash — VS Code's native resize handle UI works.
  (IR_HOVER_NATIVE_ONLY ? '' : '.monaco-resizable-hover .monaco-sash,.monaco-resizable-hover [class*="sash"]{display:none !important;visibility:hidden !important;pointer-events:none !important}'),
  // The .overflowingContentWidgets host is the workbench-level positioning
  // root that VS Code mounts overflow hovers under. Other panels (e.g., the
  // chat / Agent welcome view in the auxiliary bar) can occupy the same
  // screen pixels at the right/bottom edges of an editor; if their stacking
  // context wins, the hover's bottom-right corner hit-tests to the chat
  // container and VS Code dismisses the hover when the mouse "leaves". Bump
  // the entire overflow host above any sibling workbench part.
  '.overflowingContentWidgets{z-index:2147483647 !important}',
  // .monaco-hover.ir-scrollable: content-sized in all cases. When inside
  // .monaco-resizable-hover the more-specific rule above fills 100% of parent;
  // when not (e.g., drilled hovers that VS Code may host differently), this
  // keeps width bounded so it cannot stretch to viewport width.
  '.monaco-hover.ir-scrollable,.monaco-editor-hover.ir-scrollable{box-sizing:border-box !important;width:max-content !important;height:max-content !important;max-width:680px !important;max-height:48vh !important;overflow:hidden !important;border-color:transparent !important;outline:0 !important;box-shadow:none !important}',
  '.monaco-hover.ir-scrollable,.monaco-hover.ir-scrollable *,.monaco-editor-hover.ir-scrollable,.monaco-editor-hover.ir-scrollable *{scrollbar-width:none !important;scrollbar-color:transparent transparent !important;-ms-overflow-style:none !important}',
  '.monaco-hover.ir-scrollable::-webkit-scrollbar,.monaco-hover.ir-scrollable *::-webkit-scrollbar,.monaco-editor-hover.ir-scrollable::-webkit-scrollbar,.monaco-editor-hover.ir-scrollable *::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important;background:transparent !important}',
  // Inner scroller is inset by 1px on every edge because outer carries the
  // 1px hover border-line. So inner.bbox is deterministically outer.bbox − 2px
  // in both width and height; the bbox-corner assertion checks against that.
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element{overflow:auto !important;overscroll-behavior:contain !important;width:calc(100% - 2px) !important;height:calc(100% - 2px) !important;max-width:calc(100% - 2px) !important;max-height:calc(48vh - 2px) !important;margin:1px !important;border:0 !important;outline:0 !important;box-shadow:none !important}',
  '.monaco-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-hover.ir-scrollable > .monaco-scrollable-element > .shadow,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .scrollbar,.monaco-editor-hover.ir-scrollable > .monaco-scrollable-element > .shadow{display:none !important}',
  // L120 (2026-06-01): native mode KEEPS the resize sash so the user can drag a small
  // drill hover taller (box can't auto-grow — that covered the symbol, L116/L118; the sash
  // is the manual escape hatch the user asked for: "핸들이라도 잘 쓰게 하자"). These rules
  // hide the scrollbar/slider/shadow/decorations for a clean look but USED to also hide
  // .sash/.monaco-sash/[class*=sash] — unconditionally, so the resize handle was dead in
  // native too (line 419's sash-hide was gated; these weren't). Drop the sash selectors in
  // native; managed mode still hides everything. Resize is bounded by our caps (max-width:680,
  // max-height:48vh). The JS sash quarantine + grab-dismiss are already gated (L93/L94).
  (IR_HOVER_NATIVE_ONLY
    ? '.monaco-hover.ir-scrollable .scrollbar,.monaco-hover.ir-scrollable .slider,.monaco-hover.ir-scrollable .shadow,.monaco-hover.ir-scrollable .scroll-decoration,.monaco-hover.ir-scrollable .decorationsOverviewRuler,.monaco-editor-hover.ir-scrollable .scrollbar,.monaco-editor-hover.ir-scrollable .slider,.monaco-editor-hover.ir-scrollable .shadow,.monaco-editor-hover.ir-scrollable .scroll-decoration,.monaco-editor-hover.ir-scrollable .decorationsOverviewRuler{display:none !important;visibility:hidden !important;pointer-events:none !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}'
    : '.monaco-hover.ir-scrollable .scrollbar,.monaco-hover.ir-scrollable .slider,.monaco-hover.ir-scrollable .shadow,.monaco-hover.ir-scrollable .sash,.monaco-hover.ir-scrollable .monaco-sash,.monaco-hover.ir-scrollable .scroll-decoration,.monaco-hover.ir-scrollable .decorationsOverviewRuler,.monaco-editor-hover.ir-scrollable .scrollbar,.monaco-editor-hover.ir-scrollable .slider,.monaco-editor-hover.ir-scrollable .shadow,.monaco-editor-hover.ir-scrollable .sash,.monaco-editor-hover.ir-scrollable .monaco-sash,.monaco-editor-hover.ir-scrollable .scroll-decoration,.monaco-editor-hover.ir-scrollable .decorationsOverviewRuler{display:none !important;visibility:hidden !important;pointer-events:none !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}'),
  (IR_HOVER_NATIVE_ONLY
    ? '.monaco-hover.ir-scrollable [class*="scrollbar"],.monaco-editor-hover.ir-scrollable [class*="scrollbar"]{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}'
    : '.monaco-hover.ir-scrollable [class*="sash"],.monaco-hover.ir-scrollable [class*="scrollbar"],.monaco-editor-hover.ir-scrollable [class*="sash"],.monaco-editor-hover.ir-scrollable [class*="scrollbar"]{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}'),
  '.ir-native-hover-handle-hidden{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important;width:0 !important;height:0 !important;min-width:0 !important;min-height:0 !important;max-width:0 !important;max-height:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}',
  '.monaco-hover.ir-native-released-hover,.monaco-editor-hover.ir-native-released-hover{visibility:hidden !important;pointer-events:none !important}',
  '.ir-hover-artifact-hidden{display:none !important;visibility:hidden !important;pointer-events:none !important;opacity:0 !important}',
  '.ir-stale-hover{display:none !important;visibility:hidden !important;pointer-events:none !important}',
  // L76 (2026-05-29): staging — hide the wrapper while it forms (content
  // render + sizing + our reposition) and reveal it only once settled (or at
  // the ~500ms budget). visibility:hidden keeps layout/sizing live (rect stays
  // measurable) so the settle-check works while invisible. The user never sees
  // the collapse/0x0/reposition flicker; they see a finished hover.
  '.monaco-resizable-hover.ir-hover-staging{visibility:hidden !important}',
  '.ir-empty-hover-root{opacity:0 !important;pointer-events:none !important}',
  '.ir-empty-hover-root *{pointer-events:none !important}',
  // Drilled hover height clamp via CSS :has() — when our [← Back] link
  // is rendered inside the hover, the wrapper visually shrinks to 180px
  // so the drilled hover stays in the same screen footprint as the
  // initial hover. Inner .monaco-scrollable-element already has
  // overflow:auto so overflow is scrollable. The selector matches the
  // anchor or button we render in applyPreviewStateAsHover.
  // Drilled-hover height clamp uses a CSS custom property
  // (--ir-drill-max-h) set on the wrapper by JS when the initial hover
  // first paints for this session. Fallback to 162px when no session
  // measurement has happened yet. So a large initial hover (e.g., a
  // class with many fields, ~432px tall) keeps that footprint on
  // drill-down — drilled content scrolls internally up to the same
  // height — while a small initial hover (~162px) keeps the small
  // footprint. Either way, drilled hover never grows BIGGER than the
  // initial. Inner .monaco-hover and .monaco-scrollable-element track
  // the wrapper with the usual 2/4px insets.
  // L104b (2026-06-01): drill hover must size IDENTICALLY to the first hover —
  // VS Code owns the box height, host follows the wrapper, scroller flex-fills.
  // (cf. [[feedback_vscode_owns_hover_height]].) The OLD drill rules below capped
  // the host at 48vh minus 2px (decoupled from the wrapper). In the v270 native model
  // the wrapper is pinned by VS Code (~250px), so a host capped at 48vh GREW to
  // the content (measured hostH=511) and OVERFLOWED the 250px wrapper → its
  // scrollbar + bottom ran off-screen (the user's drill scroll-mismatch report).
  // FIX: cap the drill host at the WRAPPER (max-height:100%, same as rule 370 for
  // the first hover) and let the scroller flex-fill (max-height:none, same as the
  // base scroller rule). Now drill == first hover: box stays VS Code's height,
  // content scrolls inside. (--ir-drill-max-h is dead — its JS setter is disabled
  // — so the old var() fallback was always plain 48vh anyway.)
  '.monaco-resizable-hover:has(a[href*="previewBack"]),.monaco-resizable-hover:has(a[data-href*="previewBack"]){max-height:48vh !important}',
  // L119: rolled back to A — drill host fills the wrapper, scroller uncapped (flex-fills).
  '.monaco-resizable-hover:has(a[href*="previewBack"]) .monaco-hover,.monaco-resizable-hover:has(a[data-href*="previewBack"]) .monaco-hover{max-height:100% !important}',
  '.monaco-resizable-hover:has(a[href*="previewBack"]) .monaco-scrollable-element,.monaco-resizable-hover:has(a[data-href*="previewBack"]) .monaco-scrollable-element{max-height:none !important}',
  // L47: native virtual list for large hover bodies. content-visibility:
  // auto makes the brower skip layout+paint for off-screen .rendered-
  // markdown blocks (and their descendants) — turning a 57K-char drill
  // hover from "lay out everything on every reflow" into "lay out only
  // what is in view, plus a small lookahead area". contain-intrinsic-
  // size tells the brower how much space to reserve when the block is
  // skipped so the scrollbar stays accurate. Pairs with our existing
  // L32 visibility gate (which already prevents OUR wrap walks on
  // off-screen blocks); this rule extends the same idea to the brower
  // engine itself for the layout/paint side. Pure CSS, applies to all
  // hovers — brower no-ops fast when the block fits in view anyway,
  // so there is no measurable cost on small hovers.
  '.monaco-hover .rendered-markdown,.monaco-editor-hover .rendered-markdown{content-visibility:auto;contain-intrinsic-size:0 80px}',
  // L48: also virtualize the syntax-highlighted code blocks. These are
  // the dominant cost for large class hovers — many tokenized spans
  // per line × many lines = the biggest layout work. Intrinsic height
  // hint uses an average code-row height (18px-line × several lines).
  '.monaco-hover .monaco-tokenized-source,.monaco-editor-hover .monaco-tokenized-source{content-visibility:auto;contain-intrinsic-size:0 200px}',
  // L86 reverted (v240): content-visibility on plain code blocks did NOT reduce the
  // render block — the cost is VS Code PARSING the 59K markdown + building the DOM +
  // our scan, not off-screen LAYOUT (which content-visibility skips), and width:
  // max-content forces full-content measurement anyway. The real fix is rendering
  // LESS content initially (L87+ custom virtual scroller). See log-analysis.md #2.
].join('');
document.head.appendChild(style);
window.__irStyleEl = style;
irLog('renderer: CSS injected');

// ── Hover ancestor event surveillance ─────────────────────────────────────
// Records EVERY mouse / pointer / focus event whose target is inside any
// .monaco-resizable-hover or .monaco-hover, OR whose target is one of those
// elements' ancestors up to document.body. Plus attribute/childList
// mutations on every live hover element. The buffer is drained by
// intellisenseRecursion.drainHoverEventLogForTests; the bottom-right
// dismiss case writes the buffer to test stdout for analysis.
if(!window.__irHoverEventLog)window.__irHoverEventLog=[];
// telemetry is opt-in; tests/diag tools can flip it via window.__irHoverEventLogConfig.enabled=true before activation
if(!window.__irHoverEventLogConfig)window.__irHoverEventLogConfig={enabled:false,max:4000};
window.__irHoverEventSeq=Number(window.__irHoverEventLogSeq)||0;
function irHEDescribe(el){
  if(!el||el.nodeType!==1)return null;
  var tag=String(el.tagName||'').toLowerCase();
  var cls=String(el.className||'').slice(0,160);
  var id=String(el.id||'').slice(0,80);
  var rect=null;
  try{var r=el.getBoundingClientRect();rect={l:Math.round(r.left*100)/100,t:Math.round(r.top*100)/100,r:Math.round(r.right*100)/100,b:Math.round(r.bottom*100)/100,w:Math.round(r.width*100)/100,h:Math.round(r.height*100)/100};}catch(_){}
  return {tag:tag,cls:cls,id:id,rect:rect};
}
function irHEHoverRoot(target){
  var el=target&&(target.nodeType===1?target:target.parentElement);
  if(!el||!el.closest)return null;
  var resizable=el.closest('.monaco-resizable-hover');
  if(resizable)return resizable;
  var hov=el.closest('.monaco-hover, .monaco-editor-hover');
  return hov||null;
}
function irHEHoverState(){
  try{
    var resizables=document.querySelectorAll('.monaco-resizable-hover');
    var hovers=document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
    var rezSummary=[];
    for(var i=0;i<resizables.length&&i<6;i++){
      var r=resizables[i].getBoundingClientRect();
      var cs=null;try{cs=window.getComputedStyle(resizables[i]);}catch(_){}
      rezSummary.push({
        idx:i,
        cls:String(resizables[i].className||'').slice(0,120),
        rect:{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
        zIndex:cs?cs.zIndex:null,
        position:cs?cs.position:null,
        visibility:cs?cs.visibility:null,
        opacity:cs?cs.opacity:null,
        pointerEvents:cs?cs.pointerEvents:null,
        display:cs?cs.display:null,
        connected:document.body.contains(resizables[i])
      });
    }
    var hovSummary=[];
    for(var j=0;j<hovers.length&&j<8;j++){
      var rr=hovers[j].getBoundingClientRect();
      hovSummary.push({
        idx:j,
        cls:String(hovers[j].className||'').slice(0,120),
        rect:{l:Math.round(rr.left),t:Math.round(rr.top),w:Math.round(rr.width),h:Math.round(rr.height)},
        textSample:String(hovers[j].textContent||'').replace(/\\s+/g,' ').slice(0,60)
      });
    }
    return {resizables:rezSummary,hovers:hovSummary};
  }catch(_){return null;}
}
// Diagnostic event kinds that must also reach log.txt (via irLog). These
// are low-frequency lifecycle events used to debug widget capture +
// drill-reposition. High-frequency event kinds (evt, attr, child) stay
// in the in-renderer buffer only.
var IR_HE_FORWARDED_KINDS={
  'hover-widget-captured':1,
  'wrapper-resize-observer-attached':1,
  'drill-reposition':1,
  'drill-reposition-byel':1,
  'drill-reposition-error':1,
  'drill-reposition-byel-error':1,
  'drill-reposition-skip-transient':1,
  'drill-reposition-byel-skip-transient':1,
  'drill-reposition-skip-already-positioned':1,
  'drill-reposition-byel-skip-already-positioned':1,
  'initial-reposition':1,
  'initial-reposition-error':1,
  'initial-reposition-skip':1,
  'initial-reposition-skip-transient':1,
  'initial-reposition-anchor-moved':1,
  'drill-style-reapplied':1,
  'drill-settle-observer-armed':1,
  'drill-settle-observer-fired':1,
  'drill-settle-observer-timeout':1,
  'hover-pointer-enter':1,
  'hover-pointer-leave':1,
  'hover-pointer-diag-installed':1,
  'inner-force-static-applied':1,
  'bare-hover-handler-installed':1,
  'bare-hover-lifted':1,
  'bare-hover-after-lift':1,
  'back-restore-capture-installed':1,
  'back-restore-anchor-captured':1,
  'back-restore-applied':1,
  'wrapper-state-reset':1,
  // L55 (2026-05-28): retired noisy diagnostics — see the matching
  // comment block on IR_HE_FORCE_LOG_KINDS above. cleanup/detection
  // events stay forwarded so log.txt still shows the pillar/bar fix
  // audit trail; the per-event 30-field state dumps do not.
  'force-preview-cleanup':1,
  'column-wrapper-detected':1,
  'column-wrapper-cleaned':1,
  'column-wrapper-width-restored':1,
  'width-collapse-transition':1,
  'width-freeze':1,
  'hidden-active-zero-rect-skip':1,
  'hover-stage-reveal':1,
  'hover-position-anomaly':1,
  'drill-body-observer-installed':1,
  'editor-captured-via-map':1,
  'editor-proto-patched':1,
  'editor-scroll-watched':1,
  'editor-scroll':1,
  'global-prototype-patched':1,
  'main-thread-longtask':1,
  'ir-sync-longtask':1,
  'vtail-channel-test':1,
  'vtail-stash-visible':1,
  'vtail-tail-rendered':1,
  'vtail-windowed':1
};
// L20-L24 diagnostic force-logs were used to root-cause drill jump
// (L23+L24) and drill-mutation throughput (L36+L37). All fixes
// verified via the captured logs; the diagnostic allowlist is cleared
// here so telemetry-off users don't pay the WebSocket + disk overhead
// for events whose timing no longer needs surfacing. If a future drill
// regression appears, repopulate this set with the specific kinds
// being investigated.
var IR_HE_FORCE_LOG_KINDS={
  // L49/L50 (2026-05-28): diagnostic captures retired in L55 once
  // the pillar/bar fix landed. The kinds (unrenderable-hover-diag,
  // force-preview-failed-diag) still record into the in-memory
  // hover-event ring when telemetry is enabled, but no longer
  // force-log to disk — they were noisy (~30 fields × dozens of
  // events per session). If a pillar/bar regression resurfaces,
  // re-add the kind here and to IR_HE_FORWARDED_KINDS below to
  // capture diagnostic context to log.txt again.
  //
  // The three cleanup/detection kinds below remain force-logged:
  // they fire only when we actually mutate state (or are about to),
  // so they double as production audit trail of the pillar/bar fix.
  'force-preview-cleanup':1,
  'column-wrapper-detected':1,
  'column-wrapper-cleaned':1,
  'column-wrapper-width-restored':1,
  // L72 (2026-05-29): width=16px collapse TRANSITION diagnostic — fires only
  // on a collapsed<->normal boundary crossing (bounded volume). Captures the
  // exact moment L71's residual width collapse happens. See the transition
  // logger in irAttachStyleObserverToWrapper.
  'width-collapse-transition':1,
  // L80 (2026-05-30): proactive width-freeze audit — fires when we hold a
  // collapsing-but-content-present wrapper at its last-good width (phase=hold)
  // and when we release that floor once content rebuilt / timed out
  // (phase=release). The root of the #3 re-preview churn is VS Code rebuilding
  // an already-shown hover on same-anchor re-fires (mouse drift + hover delay),
  // which transiently collapses the wrapper to a 16px sliver; freezing the
  // width makes that rebuild invisible instead of band-aiding it after the fact
  // (L79). Force-logged to confirm it engages and to measure hold duration.
  'width-freeze':1,
  // L74 (2026-05-29): transient zero-rect skip audit — fires when we leave a
  // 0x0-but-content-present hover alone (VS Code mid-swap) instead of releasing
  // it. Force-logged so we can confirm it engages (unlike L73, which was 0).
  'hidden-active-zero-rect-skip':1,
  // L78 (2026-05-30): force-preview transient zero-rect keep-alive audit — fires
  // when irForcePreviewHoverVisible lands on a 0x0-but-content-present root (VS
  // Code mid content-swap / link re-wrap) and we keep it alive + hold off the
  // release instead of returning the hard failure that let the revive→dispose
  // path RELEASE the drilled hover. phase=force-keepalive (force-preview branch)
  // or dispose-hold (release guard). Force-logged because the L74 dispose guard
  // fired 0× for this path across 28 observed zero-rect force-preview failures.
  'force-preview-zero-rect-transient':1,
  // L76 (2026-05-29): staging reveal audit — fires when a staged (hidden-until-
  // settled) hover is revealed, with reason (settled/budget/hard-cap/...) + ms.
  // Force-logged to confirm staging engages and measure reveal latency.
  'hover-stage-reveal':1,
  // L56 (2026-05-28): diagnose hover-covers-symbol / hover-far-from-symbol
  // user-reported regression. Only fires when the active-switch detects
  // an actual anomaly (mouse inside wrapper, or distance > 80px), so
  // cost is gated even though it is force-logged.
  // L59 (2026-05-28): hover-position-fixed kind retired alongside the
  // L57 hardcoded reposition that emitted it. Diagnostic still flows
  // through hover-position-anomaly above; if a positioning fix is ever
  // reintroduced here, restore this kind to either set.
  'hover-position-anomaly':1,
  // L62 (2026-05-28): symbol-anchored initial-hover reposition replaces
  // L57's mouse-anchored override. Audit trail so we can verify when
  // our fix engages (vs leaving the wrapper at VS Code's anchor).
  'initial-reposition':1,
  // L62 diagnostic: skip + error force-logged temporarily so we can see
  // why irRepositionInitialHover exits when telemetry is off. Demote to
  // forwarded-only once the v=213 wire-in is confirmed to engage.
  'initial-reposition-skip':1,
  'initial-reposition-skip-transient':1,
  'initial-reposition-error':1,
  // L68 diagnostic: force-log anchor-moved (content swap re-position) so we
  // can confirm fast symbol-to-symbol moves re-anchor. Demote once stable.
  'initial-reposition-anchor-moved':1,
  // L83 (2026-05-30): main-thread block instrumentation for #2 staging budget
  // outliers (5× reason=budget ms 641-952 = a ~562ms silent gap starving the
  // settle poll + hard timer). main-thread-longtask = Long Tasks API (any task
  // >=100ms + browser attribution); ir-sync-longtask = our own wrapped heavy sync
  // fns (scan/wrap, markdown MO burst) at >=50ms. Retire once the blocker lands.
  'main-thread-longtask':1,
  'ir-sync-longtask':1,
  'vtail-channel-test':1,
  'vtail-stash-visible':1,
  'vtail-tail-rendered':1,
  'vtail-windowed':1,
  // L98 (2026-05-31): native viewport clamp audit — fires only when a capped
  // hover's bottom sat below the viewport and we nudged it up (#1 structural).
  // Force-logged so we can confirm the clamp engages live; demote to
  // forwarded-only once verified.
  'hover-viewport-clamp':1,
  // L103 (2026-05-31): hover size-audit — real wrapper/host/scroller heights vs
  // content length, to pin the VS-Code-height-vs-our-content mismatch the user sees.
  'hover-size-audit':1
};
function irHERecord(kind,detail){
  try{
    var forceLog=!!IR_HE_FORCE_LOG_KINDS[kind];
    if(!forceLog && (!window.__irHoverEventLogConfig||!window.__irHoverEventLogConfig.enabled))return;
    if(forceLog && !window.__irHoverEventLogConfig){window.__irHoverEventLogConfig={enabled:false,max:4000};}
    if(forceLog && !window.__irHoverEventLog){window.__irHoverEventLog=[];}
    if(forceLog && typeof window.__irHoverEventSeq!=='number'){window.__irHoverEventSeq=0;}
    var entry={
      seq:++window.__irHoverEventSeq,
      at:Date.now(),
      kind:kind
    };
    if(detail){for(var k in detail){if(Object.prototype.hasOwnProperty.call(detail,k))entry[k]=detail[k];}}
    window.__irHoverEventLog.push(entry);
    var max=Number(window.__irHoverEventLogConfig.max)||4000;
    while(window.__irHoverEventLog.length>max)window.__irHoverEventLog.shift();
    // Forward selected diagnostic kinds to log.txt via irLog. Wrap in a
    // try so a stringify error never breaks the in-renderer buffer write.
    // forceLog kinds (L20+) bypass the IR_HE_FORWARDED_KINDS allowlist —
    // they were added to surface diagnostic data when telemetry is off
    // and must reach log.txt regardless.
    if(IR_HE_FORWARDED_KINDS[kind]||forceLog){
      try{
        var line='he-event '+kind+' seq='+entry.seq;
        if(detail){
          var compact={};
          for(var ck in detail){
            if(!Object.prototype.hasOwnProperty.call(detail,ck))continue;
            compact[ck]=detail[ck];
          }
          // JSON.stringify with replacer to bound any single string.
          var json=JSON.stringify(compact,function(_k,_v){
            if(typeof _v==='string'&&_v.length>200)return _v.slice(0,200)+'…';
            return _v;
          });
          if(json&&json.length>1400)json=json.slice(0,1400)+'…';
          line+=' '+json;
        }
        irLog(line);
      }catch(_){}
    }
  }catch(_){}
}
var IR_HE_EVENT_TYPES=['mousedown','mouseup','mousemove','click','mouseleave','mouseenter','mouseout','mouseover','pointerdown','pointermove','pointerup','pointerleave','pointerenter','pointerout','pointerover','focusin','focusout','blur','wheel','contextmenu','keydown','keyup'];
for(var __irHE_i=0;__irHE_i<IR_HE_EVENT_TYPES.length;__irHE_i++){(function(type){
  document.addEventListener(type,function(e){
    try{
      var tgt=e.target;
      var root=irHEHoverRoot(tgt);
      var anyHover=document.querySelector('.monaco-resizable-hover, .monaco-hover, .monaco-editor-hover');
      // Always record events while a hover is alive (so we can correlate
      // mouse path with hover lifecycle). Limit detail for high-frequency
      // movement events.
      if(!root && !anyHover) return;
      var detail={
        type:type,
        target:irHEDescribe(tgt),
        related:e.relatedTarget?irHEDescribe(e.relatedTarget):null,
        x:(typeof e.clientX==='number')?Math.round(e.clientX*100)/100:null,
        y:(typeof e.clientY==='number')?Math.round(e.clientY*100)/100:null,
        button:(typeof e.button==='number')?e.button:null,
        buttons:(typeof e.buttons==='number')?e.buttons:null,
        insideHover:!!root,
        hoverRootCls:root?String(root.className||'').slice(0,120):null
      };
      if(type==='mousemove'||type==='pointermove'){
        // Sample only when target/root crossing changes; otherwise spam ~60Hz.
        var prev=window.__irHEMoveSampleState||{};
        var sig=(detail.target?detail.target.cls:'')+'|'+(detail.insideHover?'h':'o');
        if(prev.sig===sig && (Date.now()-(prev.at||0))<40)return;
        window.__irHEMoveSampleState={sig:sig,at:Date.now()};
        detail.movementSample=true;
      }
      irHERecord('evt',detail);
    }catch(_){}
  },true);
})(IR_HE_EVENT_TYPES[__irHE_i]);}
function irHEAttachAttributeObserver(el){
  if(!el||el.__irHEAttrObserved)return;
  el.__irHEAttrObserved=true;
  try{
    var observer=new MutationObserver(function(records){
      for(var r=0;r<records.length;r++){
        var rec=records[r];
        if(rec.type==='attributes'){
          var attrName=rec.attributeName;
          var newVal=null;
          try{newVal=String(el.getAttribute(attrName)||'').slice(0,200);}catch(_){}
          irHERecord('attr',{
            target:irHEDescribe(el),
            attrName:attrName,
            oldValue:rec.oldValue===null?null:String(rec.oldValue).slice(0,200),
            newValue:newVal
          });
        } else if(rec.type==='childList'){
          var added=[],removed=[];
          for(var a=0;a<rec.addedNodes.length;a++)added.push(irHEDescribe(rec.addedNodes[a]));
          for(var d=0;d<rec.removedNodes.length;d++)removed.push(irHEDescribe(rec.removedNodes[d]));
          irHERecord('child',{target:irHEDescribe(el),added:added,removed:removed});
        }
      }
    });
    observer.observe(el,{attributes:true,attributeOldValue:true,attributeFilter:['style','class','aria-hidden','hidden'],childList:true,subtree:false});
    el.__irHEAttrObserver=observer;
  }catch(_){}
}
function irHEScanForHovers(){
  try{
    var nodes=document.querySelectorAll('.monaco-resizable-hover, .monaco-hover, .monaco-editor-hover');
    for(var i=0;i<nodes.length;i++)irHEAttachAttributeObserver(nodes[i]);
  }catch(_){}
}
var IR_HE_BODY_OBSERVER=null;
var IR_HE_PENDING_RECORDS=null;
var IR_HE_RAF_HANDLE=null;
function irHEProcessRecords(records){
  for(var r=0;r<records.length;r++){
    var rec=records[r];
    if(rec.type!=='childList')continue;
    for(var a=0;a<rec.addedNodes.length;a++){
      var n=rec.addedNodes[a];
      if(!n||n.nodeType!==1)continue;
      // Cheap pre-filter: typing-induced mutations are dominated by
      // editor internals (.view-line, .mtk*, .monaco-list-row, ...) that
      // never directly host a hover widget. We still inspect added nodes
      // that could plausibly be a hover wrapper or contain one.
      var cls=typeof n.className==='string'?n.className:'';
      var couldBeHover=cls.indexOf('monaco-hover')>=0||cls.indexOf('resizable-hover')>=0||cls.indexOf('context-view')>=0||cls.indexOf('monaco-editor-hover')>=0;
      var hasChildren=!!(n.firstElementChild);
      if(!couldBeHover&&!hasChildren)continue;
      if(n.matches&&(n.matches('.monaco-resizable-hover')||n.matches('.monaco-hover')||n.matches('.monaco-editor-hover'))){
        irHEAttachAttributeObserver(n);
        irHERecord('hover-added',{target:irHEDescribe(n)});
      }
      // Only deep-scan children when the node looks like a plausible
      // hover container — avoids querySelectorAll on every Monaco line.
      if(couldBeHover){
        try{
          var inner=n.querySelectorAll&&n.querySelectorAll('.monaco-resizable-hover, .monaco-hover, .monaco-editor-hover');
          if(inner)for(var k=0;k<inner.length;k++){irHEAttachAttributeObserver(inner[k]);irHERecord('hover-added',{target:irHEDescribe(inner[k])});}
        }catch(_){}
      }
    }
    for(var d=0;d<rec.removedNodes.length;d++){
      var rn=rec.removedNodes[d];
      if(!rn||rn.nodeType!==1)continue;
      if(rn.matches&&(rn.matches('.monaco-resizable-hover')||rn.matches('.monaco-hover')||rn.matches('.monaco-editor-hover'))){
        irHERecord('hover-removed',{target:irHEDescribe(rn)});
      }
    }
  }
}
function irHESetupBodyObserver(){
  if(IR_HE_BODY_OBSERVER||!document.body)return;
  try{
    IR_HE_BODY_OBSERVER=new MutationObserver(function(records){
      // Coalesce mutation bursts (typing, layout) into one rAF-batched
      // pass. Was processing every batch synchronously which made hot
      // paths quadratic when many .view-line nodes are added/removed.
      if(IR_HE_PENDING_RECORDS){
        for(var i=0;i<records.length;i++)IR_HE_PENDING_RECORDS.push(records[i]);
        return;
      }
      IR_HE_PENDING_RECORDS=records.slice();
      var schedule=window.requestAnimationFrame||function(cb){return setTimeout(cb,16);};
      IR_HE_RAF_HANDLE=schedule(function(){
        var pending=IR_HE_PENDING_RECORDS;
        IR_HE_PENDING_RECORDS=null;
        IR_HE_RAF_HANDLE=null;
        if(pending)irHEProcessRecords(pending);
      });
    });
    IR_HE_BODY_OBSERVER.observe(document.body,{childList:true,subtree:true});
    irHEScanForHovers();
  }catch(_){}
}
if(document.body)irHESetupBodyObserver();else document.addEventListener('DOMContentLoaded',irHESetupBodyObserver,{once:true});
window.__irHEDrain=function(){
  var out=window.__irHoverEventLog.slice();
  return {ok:true,count:out.length,events:out,hoverState:irHEHoverState(),patchVersion:Number(window.__irPatchVersion)||0};
};
window.__irHEClear=function(){window.__irHoverEventLog=[];window.__irHoverEventSeq=0;return {ok:true};};

// ── Resizable-hover anchor freeze ─────────────────────────────────────────
// Drill-down hovers must stay anchored to the SAME screen location as the
// initial hover for this hover session. If VS Code repaints the wrapper at
// a different top/left for a drill-down (e.g., because the cursor moved to
// the drill target's definition position), the new hover lands far from
// the user's mouse and dismisses on the next mouse move.
//
// We track this session-scoped:
//   - window.__irHoverAnchorSession = null when no active hover
//   - On first .monaco-resizable-hover positioning, capture {left,top,width,height}
//   - Extension code sets window.__irDrillModeActive = true when drilling
//   - While drillModeActive, every wrapper position change is forced back to the saved anchor
//   - Session resets when the wrapper is removed/disposed for a fresh hover
window.__irHoverAnchorSession=window.__irHoverAnchorSession||null;
window.__irDrillModeActive=window.__irDrillModeActive||false;
function irCaptureWrapperAnchor(wrapper){
  if(!wrapper||!wrapper.getBoundingClientRect)return null;
  try{
    var r=wrapper.getBoundingClientRect();
    if(r.width<2||r.height<2)return null;
    return {
      left:Math.round(r.left*100)/100,
      top:Math.round(r.top*100)/100,
      bottom:Math.round(r.bottom*100)/100,
      width:Math.round(r.width),
      height:Math.round(r.height),
      capturedAt:Date.now()
    };
  }catch(_){return null}
}
function irEnforceWrapperAnchor(wrapper,reason){
  // DIAGNOSTIC ONLY. The actual style-mutation enforcement is disabled
  // pending a cleaner widget-level intercept (see docs/hover-ui-structure
  // .md "Known open issues" — taking control of ResizableContentHoverWidget
  // creation). Previous attempts to setProperty('left'/'top','important')
  // on the wrapper fought VS Code's natural positioning pipeline and
  // produced viewport-sized hovers when the saved anchor and the new
  // wrapper belonged to different editor columns. Record what we WOULD
  // have enforced so the user can see the drift, but don't mutate.
  try{
    if(!wrapper)return false;
    var session=window.__irHoverAnchorSession;
    if(!session||!session.firstAnchor)return false;
    var anchor=session.firstAnchor;
    var current=wrapper.getBoundingClientRect();
    var desiredTop=anchor.bottom-current.height;
    var leftDelta=Math.abs(current.left-anchor.left);
    var topDelta=Math.abs(current.top-desiredTop);
    if(leftDelta<2&&topDelta<2)return false;
    irHERecord('anchor-drift-observed',{
      reason:String(reason||''),
      current:{left:Math.round(current.left),top:Math.round(current.top),width:Math.round(current.width),height:Math.round(current.height)},
      sessionAnchor:anchor,
      desiredTopIfEnforced:Math.max(0,Math.round(desiredTop)),
      drillModeActive:!!window.__irDrillModeActive,
      sessionAge:Date.now()-(session.startedAt||0)
    });
    return false;
  }catch(_){return false}
}
function irMaybeBeginAnchorSession(wrapper){
  try{
    if(!wrapper)return;
    var captured=irCaptureWrapperAnchor(wrapper);
    if(!captured)return;
    if(window.__irHoverAnchorSession){
      // Existing session — if drill mode active, freeze; else update.
      if(window.__irDrillModeActive){
        irEnforceWrapperAnchor(wrapper,'session-continuing-drill');
      }else{
        // Fresh hover (not drilling) — replace anchor.
        window.__irHoverAnchorSession={firstAnchor:captured,startedAt:Date.now(),wrapper:wrapper};
        irHERecord('anchor-session-replace',{anchor:captured});
      }
    }else{
      window.__irHoverAnchorSession={firstAnchor:captured,startedAt:Date.now(),wrapper:wrapper};
      irHERecord('anchor-session-start',{anchor:captured});
    }
  }catch(_){}
}
function irMaybeEndAnchorSession(wrapper){
  try{
    if(!wrapper)return;
    var session=window.__irHoverAnchorSession;
    if(session&&session.wrapper===wrapper){
      irHERecord('anchor-session-end',{anchor:session.firstAnchor});
      window.__irHoverAnchorSession=null;
    }
  }catch(_){}
}
// Wire up anchor session lifecycle to wrapper DOM events. When a
// .monaco-resizable-hover is added we (a) skip until it has real geometry
// (VS Code starts it at 0×0 then positions/sizes it), (b) call
// irMaybeBeginAnchorSession on first non-empty measurement, then (c) use a
// ResizeObserver to re-enforce whenever the wrapper changes size — that's
// the moment a drill-down expands it and we need to pull the bottom back
// to the saved anchor.
if(!window.__irAnchorWrapperObserver){
  try{
    var resizeObsCtor=typeof ResizeObserver==='function'?ResizeObserver:null;
    window.__irAnchorWrapperObserver=new MutationObserver(function(records){
      for(var i=0;i<records.length;i++){
        var rec=records[i];
        for(var a=0;a<rec.addedNodes.length;a++){
          var n=rec.addedNodes[a];
          if(n&&n.nodeType===1&&n.matches&&n.matches('.monaco-resizable-hover')){
            (function(node){
              // Poll briefly until VS Code has positioned + sized the wrapper.
              var attempts=0;
              var settle=function(){
                attempts++;
                try{
                  var r=node.getBoundingClientRect();
                  if(r.width>=10&&r.height>=10){
                    irMaybeBeginAnchorSession(node);
                    if(window.__irDrillModeActive)irEnforceWrapperAnchor(node,'settle-initial');
                    if(resizeObsCtor){
                      try{
                        var ro=new resizeObsCtor(function(){
                          if(window.__irDrillModeActive)irEnforceWrapperAnchor(node,'resize-observed');
                        });
                        ro.observe(node);
                        node.__irAnchorResizeObs=ro;
                      }catch(_){}
                    }
                    return;
                  }
                }catch(_){}
                if(attempts<30)requestAnimationFrame(settle);
              };
              try{requestAnimationFrame(settle);}catch(_){settle();}
            })(n);
          }
        }
        for(var d=0;d<rec.removedNodes.length;d++){
          var rn=rec.removedNodes[d];
          if(rn&&rn.nodeType===1&&rn.matches&&rn.matches('.monaco-resizable-hover')){
            try{if(rn.__irAnchorResizeObs)rn.__irAnchorResizeObs.disconnect();}catch(_){}
            irMaybeEndAnchorSession(rn);
          }
        }
      }
    });
    if(document.body)window.__irAnchorWrapperObserver.observe(document.body,{childList:true,subtree:true});
  }catch(_){}
}
function irStartDrillEnforceLoop(){
  // Disabled — the polling loop fought VS Code's natural positioning
  // pipeline and caused worse regressions (whole-viewport hover when drill
  // session bled across probes). Keep the stub so callers compile but do
  // nothing. The wrapper observer + ResizeObserver path is the only
  // enforcement that runs.
  return;
}
window.__irSetDrillMode=function(active){
  var prev=!!window.__irDrillModeActive;
  window.__irDrillModeActive=!!active;
  irHERecord('drill-mode',{active:!!active,prev:prev});
  // Transition off→on: this is the moment a drill starts. Capture the
  // currently-visible wrapper's geometry as the session anchor — even if
  // VS Code reuses a wrapper across hovers (no MutationObserver childList
  // event), we still get a fresh anchor measurement here. This is the
  // canonical "previous symbol's basis position" the user asked us to
  // preserve across drill-downs.
  if(!prev&&active){
    try{
      var wrappers=document.querySelectorAll('.monaco-resizable-hover');
      var picked=null;
      for(var i=0;i<wrappers.length;i++){
        var r=wrappers[i].getBoundingClientRect();
        if(r.width>=10&&r.height>=10){picked=wrappers[i];break;}
      }
      if(picked){
        var captured=irCaptureWrapperAnchor(picked);
        if(captured){
          window.__irHoverAnchorSession={firstAnchor:captured,startedAt:Date.now(),wrapper:picked};
          irHERecord('anchor-session-drill-capture',{anchor:captured});
        }
      }
    }catch(_){}
    irStartDrillEnforceLoop();
  }
  // Transition on→off: drill session ended, clear stored anchor so the
  // next initial hover paints at its own location.
  if(prev&&!active){
    if(window.__irHoverAnchorSession){
      irHERecord('anchor-session-drill-end',{anchor:window.__irHoverAnchorSession.firstAnchor});
      window.__irHoverAnchorSession=null;
    }
  }
  return {ok:true,drillModeActive:window.__irDrillModeActive,prev:prev};
};
window.__irReadAnchorSession=function(){
  return {ok:true,session:window.__irHoverAnchorSession,drillModeActive:!!window.__irDrillModeActive};
};
window.__irClearAnchorSession=function(){
  window.__irHoverAnchorSession=null;
  window.__irDrillModeActive=false;
  window.__irDrillFrozenPosition=null;
  return {ok:true};
};

// ── ResizableContentHoverWidget interception ──────────────────────────────
// Hook into VS Code's content-widget pipeline at the layout layer rather
// than fighting it from a DOM MutationObserver. When a widget with ID
// 'editor.contrib.resizableContentHoverWidget' is added to an editor, we
// wrap its getPosition() method. While the drill session is active, the
// wrapped getPosition returns a FROZEN position captured from the initial
// hover — VS Code then naturally lays out the drilled hover at the same
// anchor as the initial hover. This is exactly the "keep the previous
// symbol's basis position" guarantee the user asked for.
//
// Why patch addContentWidget on the prototype instead of mutating the DOM:
//   - VS Code calls widget.getPosition() during its own layout pass; if we
//     return a different position here, VS Code positions the widget at
//     that point. No race with VS Code's own positioning code.
//   - DOM-level top/left forcing fights VS Code's natural pipeline and
//     produced viewport-sized hovers in prior attempts.
//   - Class names of Monaco's UI (.monaco-resizable-hover etc.) can't be
//     refactored away by VS Code releases — they're part of the public
//     theme surface — so this hook is stable across versions.
window.__irDrillFrozenPosition=window.__irDrillFrozenPosition||null;
function irGetMonacoEditorApi(){
  try{
    var api=window.monaco&&window.monaco.editor;
    if(api&&typeof api.getEditors==='function')return api;
    if(typeof require==='function'){
      try{
        var editorMain=require('vs/editor/editor.main');
        if(editorMain&&editorMain.editor&&typeof editorMain.editor.getEditors==='function')return editorMain.editor;
      }catch(_){}
    }
  }catch(_){}
  return null;
}
function irLooksLikeCodeEditorWidget(v){
  if(!v||typeof v!=='object')return false;
  return typeof v.layout==='function'
    &&typeof v.getModel==='function'
    &&typeof v.getDomNode==='function'
    &&typeof v.addContentWidget==='function';
}
// ── Global capture via Map/Set/Reflect prototype patching ────────────────
// VS Code's CodeEditorWidget instances are kept inside module closures —
// they never get attached as DOM properties, so a static DOM scan can't
// find them. BUT the workbench inevitably stores them inside Map / Set /
// WeakMap / Array instances during normal operation (editor groups,
// content widgets, model bindings, etc.). By instrumenting
// Map.prototype.set / WeakMap.prototype.set / Set.prototype.add /
// Array.prototype.push / Reflect.construct, we catch any widget that
// flows through those data structures.
//
// This mirrors the strategy from the intellij-styled-search extension on
// the same machine — its renderer patch confirms this is the working
// path on the same VS Code build that hosts us.
//
// We install the hooks once per renderer session and leave them in place;
// the sniff function is constant-time so the global slowdown is
// negligible. The CodeEditorWidget instance is parked at
// window.__irCapturedEditor; an "on capture" callback notifies our
// prototype patcher so it can hook addContentWidget the instant we have
// a reference.
window.__irCapturedEditor=window.__irCapturedEditor||null;
window.__irCapturedEditorList=window.__irCapturedEditorList||[];
window.__irCapturedHoverWidget=window.__irCapturedHoverWidget||null;
// Coord helpers — convert a (clientX, clientY) pair into three frames:
//   viewport: relative to the renderer viewport (clientX, clientY)
//   document: relative to the renderer's document root, includes window scroll
//   screen:   relative to the physical display, includes window.screenX/Y
// We log all three so we can correlate mouse vs. hover wrapper position
// across scroll states and multi-monitor setups.
function irCoordTriplet(cx,cy){
  try{
    if(typeof cx!=='number'||typeof cy!=='number')return null;
    var sx=(typeof window.scrollX==='number'?window.scrollX:(window.pageXOffset||0));
    var sy=(typeof window.scrollY==='number'?window.scrollY:(window.pageYOffset||0));
    var wsx=(typeof window.screenX==='number'?window.screenX:0);
    var wsy=(typeof window.screenY==='number'?window.screenY:0);
    return {
      v:{x:Math.round(cx),y:Math.round(cy)},
      d:{x:Math.round(cx+sx),y:Math.round(cy+sy)},
      s:{x:Math.round(cx+wsx),y:Math.round(cy+wsy)}
    };
  }catch(_){return null;}
}
function irRectTriplet(el){
  try{
    if(!el||typeof el.getBoundingClientRect!=='function')return null;
    var r=el.getBoundingClientRect();
    var sx=(typeof window.scrollX==='number'?window.scrollX:(window.pageXOffset||0));
    var sy=(typeof window.scrollY==='number'?window.scrollY:(window.pageYOffset||0));
    var wsx=(typeof window.screenX==='number'?window.screenX:0);
    var wsy=(typeof window.screenY==='number'?window.screenY:0);
    return {
      v:{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
      d:{l:Math.round(r.left+sx),t:Math.round(r.top+sy)},
      s:{l:Math.round(r.left+wsx),t:Math.round(r.top+wsy)}
    };
  }catch(_){return null;}
}
function irViewportInfo(){
  try{
    return {
      innerW:(window.innerWidth||0),
      innerH:(window.innerHeight||0),
      scrollX:Math.round(window.scrollX||window.pageXOffset||0),
      scrollY:Math.round(window.scrollY||window.pageYOffset||0),
      screenX:Math.round(window.screenX||0),
      screenY:Math.round(window.screenY||0),
      dpr:(window.devicePixelRatio||1)
    };
  }catch(_){return null;}
}
function irPointerTriplet(){
  try{
    var p=window.__irLastPointer;
    if(!p)return null;
    var t=irCoordTriplet(p.x,p.y);
    if(!t)return null;
    return {v:t.v,d:t.d,s:t.s,at:p.at,type:p.type};
  }catch(_){return null;}
}
// WeakSet-based dedupe for editor captures. The previous Array+indexOf
// approach was O(n) per call → O(n²) total. For Company-scale hover
// content, VS Code creates 20K+ EmbeddedCodeEditorWidget instances for
// syntax-highlighted code blocks, blowing up CPU and frame timing.
window.__irCapturedEditorSet=window.__irCapturedEditorSet||(typeof WeakSet==='function'?new WeakSet():null);
window.__irCapturedEditorCount=window.__irCapturedEditorCount||0;
function irOnEditorCaptured(widget){
  try{
    if(!widget||!irLooksLikeCodeEditorWidget(widget))return;
    // O(1) dedupe via WeakSet.
    if(window.__irCapturedEditorSet){
      if(window.__irCapturedEditorSet.has(widget))return;
      window.__irCapturedEditorSet.add(widget);
    }
    window.__irCapturedEditorCount=(window.__irCapturedEditorCount||0)+1;
    if(!window.__irCapturedEditor)window.__irCapturedEditor=widget;
    // Throttle log spam: workbench creates many short-lived editor
    // instances (peek view, suggest overlay, minimap, hover code blocks).
    // Record only the first few + every 500th.
    var idx=window.__irCapturedEditorCount-1;
    if(idx<3||idx%500===0){
      irHERecord('editor-captured-via-map',{idx:idx});
    }
    // Skip the heavy follow-up work for embedded code-block editors —
    // they're small read-only editors inside hover content with no
    // _contentWidgets and no need for our scroll watch. Only the main
    // editing surfaces benefit from our patching.
    var isEmbedded=false;
    try{
      var dom=widget.getDomNode&&widget.getDomNode();
      if(dom&&typeof dom.closest==='function'){
        if(dom.closest('.monaco-hover,.monaco-resizable-hover,.monaco-editor-hover')){
          isEmbedded=true;
        }
      }
    }catch(_){}
    if(isEmbedded){
      return; // skip prototype patch / content widget walk / scroll watch
    }
    // Track non-embedded editors in the list (used by irScanAndPatchEditors
    // as a fallback source for prototype patching).
    try{window.__irCapturedEditorList.push(widget);}catch(_){}
    // Patch the prototype immediately. Subsequent addContentWidget calls
    // (including ones for the hover widget) will flow through our wrap.
    try{irPatchEditorPrototype(widget);}catch(_){}
    // Also walk this editor's existing content widgets in case the hover
    // widget was already installed before our prototype hook landed.
    try{
      var cw=widget._contentWidgets;
      if(cw){
        var keys=Object.keys(cw);
        for(var i=0;i<keys.length;i++){
          if(keys[i]==='editor.contrib.resizableContentHoverWidget'){
            var entry=cw[keys[i]];
            if(entry&&entry.widget){
              irWrapHoverWidgetGetPosition(entry.widget);
              try{irAttachWrapperResizeReposition(entry.widget);}catch(_){}
            }
          }
        }
      }
    }catch(_){}
    // Attach a scroll listener so we can observe how the hover behaves
    // when the editor scrolls. The user reported the hover position
    // breaking on scroll — this records the editor scroll event +
    // the live hover wrapper rect so we can see whether VS Code
    // repositions, dismisses, or leaves it stale.
    try{irAttachEditorScrollWatch(widget);}catch(_){}
    // (ResizeObserver-on-wrapper is attached when the HOVER widget is
    // captured, not when the editor is — the editor instance has no
    // _resizableNode. See irOnHoverWidgetCaptured.)
  }catch(_){}
}
// Style-attribute observer: VS Code's _resizableNode.layout() writes
// inline top/left on the wrapper AFTER our reposition. Without re-applying,
// the drilled hover snaps back near the original symbol's anchor. We
// re-write our top/left whenever the wrapper still has drill content and
// the style was changed by something other than us. Looking at the
// wrapper subtree directly (no widget handle needed) so this also works
// from the body MutationObserver fallback path.
// L68 (2026-05-29): has the live hover anchor moved away from the symbol we
// last positioned this wrapper for? The content-hover widget is a reused
// singleton — when the user moves to a NEW symbol the content swaps in place
// (no dismiss), so our one-shot __irInitialPositioned and the style
// observer's __irDesired would otherwise pin the wrapper at the OLD symbol's
// coordinates while VS Code fills in the new symbol's content ("content
// changes, position doesn't"). Comparing the widget's current getPosition()
// against __irPositionedForPos detects the swap so we can re-run the
// symbol-anchored placement for the new symbol.
function irHoverAnchorMoved(wrapperEl){
  try{
    var prev=wrapperEl&&wrapperEl.__irPositionedForPos;
    if(!prev)return false;
    var hw=window.__irCapturedHoverWidget;
    if(!hw||typeof hw.getPosition!=='function')return false;
    var gp=hw.getPosition();
    var a=gp&&gp.position;
    if(!a)return false;
    // L71 (2026-05-29): a hover anchors to a WORD/symbol RANGE, not a single
    // column. Moving the cursor within the same identifier keeps the same
    // range but reports a different column — that is NOT a symbol swap and
    // must not trigger a follow-the-cursor reposition. Before L71 the column
    // check fired on every micro-move inside one symbol, so the hover jumped
    // char-by-char (each reposition coinciding with VS Code's re-render
    // width-collapse) — exactly the user-reported "위치가 char단위로 갱신되며
    // width collapse". Compare the RANGE when both the stored and the live
    // anchor carry one; only a different range is a real swap. Fall back to
    // line/column when range info is absent (e.g. the L64 DOM-target fallback
    // positioned us without a word range) so the L68 swap detection still
    // works there.
    var live=gp.range;
    if(live&&prev.range){
      return live.startLineNumber!==prev.range.startLineNumber
        ||live.startColumn!==prev.range.startColumn
        ||live.endLineNumber!==prev.range.endLineNumber
        ||live.endColumn!==prev.range.endColumn;
    }
    return a.lineNumber!==prev.lineNumber||a.column!==prev.column;
  }catch(_){return false;}
}
// L73 (2026-05-29): is the pointer still within the word RANGE the currently
// shown hover is anchored to? Used to suppress redundant native-hover refires
// when the user micro-moves WITHIN the same symbol. Re-firing in that case
// makes VS Code re-render the hover into a fresh .monaco-hover element which we
// then re-scan/re-size (a reflow); that repeated reflow is what collapsed the
// wrapper width to 16px / 0x0 on every micro-move (v=225 width-collapse diag).
// Range (vs the old text-containment check) is authoritative AND distinguishes
// different occurrences of a same-named symbol — a different position yields a
// different range, so a real relocation still refires (no "stuck at first
// occurrence" regression). Conservative: returns false whenever the anchor
// range or the pointer's editor position can't be resolved, so a refire that
// is actually needed is never suppressed.
function irPointerWithinActiveHoverAnchor(e){
  try{
    var hw=window.__irCapturedHoverWidget;
    if(!hw||typeof hw.getPosition!=='function')return false;
    var gp=hw.getPosition();
    var range=gp&&gp.range;
    if(!range)return false;
    var ed=hw._editor;
    if(!ed||typeof ed.getTargetAtClientPoint!=='function')return false;
    var ptr=window.__irLastPointer;
    var x=(e&&typeof e.clientX==='number')?e.clientX:(ptr&&typeof ptr.x==='number'?ptr.x:null);
    var y=(e&&typeof e.clientY==='number')?e.clientY:(ptr&&typeof ptr.y==='number'?ptr.y:null);
    if(typeof x!=='number'||typeof y!=='number')return false;
    var tgt=ed.getTargetAtClientPoint(x,y);
    var pos=tgt&&tgt.position;
    if(!pos)return false;
    if(pos.lineNumber<range.startLineNumber||pos.lineNumber>range.endLineNumber)return false;
    if(pos.lineNumber===range.startLineNumber&&pos.column<range.startColumn)return false;
    if(pos.lineNumber===range.endLineNumber&&pos.column>range.endColumn)return false;
    return true;
  }catch(_){return false;}
}
// ── L76: reveal-when-settled staging ──────────────────────────────────────
// User directive (2026-05-29): "호버를 너무 민감하게 띄울 필요는 없으니 500ms
// 예산으로 hover 위치 계산을 다 끝내고 렌더링을 끝낸 뒤에 보여주자." Instead of
// guarding each transient (collapse / 0x0 / reposition-jump) — which kept
// missing (L73, L74 both 0 engagement) — we hide the wrapper for its whole
// formation and reveal it once, settled. The formation (content render + size +
// our reposition) still runs while hidden (visibility:hidden keeps layout), so
// the user only ever sees the finished hover.
var IR_HOVER_STAGE_BUDGET_MS=500;   // hard ceiling: never hide longer than this
var IR_HOVER_STAGE_POLL_MS=40;      // settle-check cadence
var IR_WIDTH_FREEZE_MAX_MS=600;     // L80: max time to hold a frozen width before forced release
var IR_WIDTH_FREEZE_OSC_WINDOW_MS=80;   // L82: a re-freeze within this of a release = premature release (oscillation)
var IR_WIDTH_FREEZE_OSC_LATCH=3;        // L82: consecutive rapid re-freezes before we latch the floor
var IR_WIDTH_FREEZE_LATCH_MAX_MS=8000;  // L82: backstop — release a latched floor after this even without a dismiss
var IR_WIDTH_FREEZE_LATCH_POLL_MS=250;  // L82: slow poll cadence while latched (floor is static, no per-frame work)
function irHoverContentSig(wrapperEl){
  try{
    var inner=wrapperEl.querySelector?wrapperEl.querySelector('.monaco-hover,.monaco-editor-hover'):null;
    var t=inner?String(inner.textContent||''):'';
    return t.length+':'+t.slice(0,40)+':'+t.slice(-20);
  }catch(_){return '';}
}
function irStageHover(wrapperEl){
  if(IR_HOVER_NATIVE_ONLY)return;   // L89: native hover shows immediately (no staging)
  try{
    if(!wrapperEl||!wrapperEl.classList)return;
    var sig=irHoverContentSig(wrapperEl);
    if(!sig||sig.indexOf('0:')===0)return;            // no content yet — wait
    if(wrapperEl.__irStageRevealedSig===sig)return;   // this exact content already shown
    if(wrapperEl.__irStaging){wrapperEl.__irStageSig=sig;return;} // mid-session: keep budget clock
    wrapperEl.__irStaging=true;
    wrapperEl.__irStageSig=sig;
    wrapperEl.__irStageStart=Date.now();
    window.__irActiveStageWrapper=wrapperEl;   // L83: correlate main-thread longtasks with active staging
    wrapperEl.__irStagePrevRect=null;
    wrapperEl.classList.add('ir-hover-staging');
    // Hard fail-safe: reveal no matter what shortly after the budget, even if
    // the poll dies / tab backgrounds. Guarantees no "hover never shows".
    if(wrapperEl.__irStageHardTimer){try{clearTimeout(wrapperEl.__irStageHardTimer);}catch(_){}}
    wrapperEl.__irStageHardTimer=setTimeout(function(){try{irStageReveal(wrapperEl,'hard-cap');}catch(_){}},IR_HOVER_STAGE_BUDGET_MS+120);
    irStageSettleCheck(wrapperEl);
  }catch(_){try{irStageReveal(wrapperEl,'error');}catch(_){}}
}
function irStageSettleCheck(wrapperEl){
  try{
    if(!wrapperEl||!wrapperEl.__irStaging)return;
    if(!document.body||!document.body.contains(wrapperEl)){irStageReveal(wrapperEl,'detached');return;}
    var elapsed=Date.now()-(wrapperEl.__irStageStart||0);
    if(elapsed>=IR_HOVER_STAGE_BUDGET_MS){irStageReveal(wrapperEl,'budget');return;}
    var r=wrapperEl.getBoundingClientRect();
    var inner=wrapperEl.querySelector?wrapperEl.querySelector('.monaco-hover,.monaco-editor-hover'):null;
    var hasContent=!!(inner&&String(inner.textContent||'').trim().length>0);
    var notCollapsed=r.width>=60&&r.height>=20;       // not 16px column / 0x0 / bar
    var prev=wrapperEl.__irStagePrevRect;
    var stable=!!(prev&&Math.abs(prev.w-r.width)<=2&&Math.abs(prev.h-r.height)<=2);
    if(notCollapsed&&hasContent&&stable){irStageReveal(wrapperEl,'settled');return;}
    wrapperEl.__irStagePrevRect={w:r.width,h:r.height};
    wrapperEl.__irStageTimer=setTimeout(function(){try{irStageSettleCheck(wrapperEl);}catch(_){try{irStageReveal(wrapperEl,'error');}catch(__){}}},IR_HOVER_STAGE_POLL_MS);
  }catch(_){try{irStageReveal(wrapperEl,'error');}catch(__){}}
}
function irStageReveal(wrapperEl,reason){
  try{
    if(!wrapperEl)return;
    if(wrapperEl.__irStageTimer){try{clearTimeout(wrapperEl.__irStageTimer);}catch(_){}wrapperEl.__irStageTimer=null;}
    if(wrapperEl.__irStageHardTimer){try{clearTimeout(wrapperEl.__irStageHardTimer);}catch(_){}wrapperEl.__irStageHardTimer=null;}
    var was=!!wrapperEl.__irStaging;
    var ms=Date.now()-(wrapperEl.__irStageStart||0);
    // Per the directive: finish computing the position BEFORE revealing, so the
    // hover appears already at its final spot (no post-reveal jump).
    if(was&&(reason==='settled'||reason==='budget')){
      try{var ed=(window.__irCapturedHoverWidget&&window.__irCapturedHoverWidget._editor)||window.__irCapturedEditor;if(ed)irRepositionInitialHover(ed,wrapperEl);}catch(_){}
    }
    wrapperEl.__irStageRevealedSig=wrapperEl.__irStageSig||wrapperEl.__irStageRevealedSig;
    wrapperEl.__irStaging=false;
    try{if(window.__irActiveStageWrapper===wrapperEl)window.__irActiveStageWrapper=null;}catch(_){}
    wrapperEl.__irStageSig=null;
    wrapperEl.__irStagePrevRect=null;
    try{if(wrapperEl.classList)wrapperEl.classList.remove('ir-hover-staging');}catch(_){}
    if(was)irHERecord('hover-stage-reveal',{reason:String(reason||''),ms:ms});
    // L77: the hover is now shown & stable — run the deferred navigable-name
    // wrap. Schedule on idle so the reveal paints first; the scan finds the
    // wrapper no longer staging and wraps it once. (textContent is unchanged by
    // wrapping, so this does not re-enter staging.)
    if(was){
      try{
        var doDeferredWrap=function(){try{irScheduleScan();}catch(_){}};
        if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(doDeferredWrap,{timeout:300});
        else setTimeout(doDeferredWrap,60);
      }catch(_){}
    }
  }catch(_){try{if(wrapperEl&&wrapperEl.classList)wrapperEl.classList.remove('ir-hover-staging');}catch(__){}}
}
// ── L83 (2026-05-30): main-thread block instrumentation (#2 staging outliers) ──
// v=235 showed 5 hover-stage-reveal reason=budget with ms 641-952: a ~562ms gap
// with ZERO logs right after hover formation starved the 40ms settle poll AND the
// 620ms hard timer, so the reveal slipped past the 500ms ceiling. The gap is NOT
// the L82 strobe (collapse count 0 in those seconds). To find what blocks the
// loop: the Long Tasks API reports any task >=IR_LONGTASK_MIN_MS with the browser's
// own attribution, and irTimeSync wraps our heaviest synchronous suspects (the
// 57K-char navigable-name wrap scan — see irScheduleScan's own comment — and the
// markdown MutationObserver burst) so a longtask can be pinned on OUR code vs VS
// Code's hover render. Diagnostic only; retire (like L55) once the blocker lands.
var IR_LONGTASK_MIN_MS=100;       // report main-thread tasks at/over this (ms)
var IR_SYNC_LONGTASK_MIN_MS=50;   // report our own wrapped sync fns at/over this (ms)
function irNowMs(){try{return (window.performance&&performance.now)?performance.now():Date.now();}catch(_){return Date.now();}}
function irStageElapsedNow(){
  try{var w=window.__irActiveStageWrapper;if(w&&w.__irStaging&&w.__irStageStart)return Date.now()-w.__irStageStart;}catch(_){}
  return -1;
}
function irTimeSync(label,fn){
  var t0=irNowMs();
  try{return fn();}
  finally{
    try{var dur=irNowMs()-t0;if(dur>=IR_SYNC_LONGTASK_MIN_MS)irHERecord('ir-sync-longtask',{fn:String(label),durMs:Math.round(dur),staging:irStageElapsedNow()});}catch(_){}
  }
}
function irInstallLongTaskObserver(){
  try{
    if(window.__irLongTaskObs)return;
    if(typeof window.PerformanceObserver!=='function')return;
    var obs=new PerformanceObserver(function(list){
      try{
        var ents=list.getEntries();
        for(var i=0;i<ents.length;i++){
          var e=ents[i];
          if((e.duration|0)<IR_LONGTASK_MIN_MS)continue;
          var attr='';
          try{var a=e.attribution&&e.attribution[0];if(a)attr=String(a.name||'')+'/'+String(a.containerType||'')+'/'+String(a.containerName||a.containerId||'');}catch(_){}
          irHERecord('main-thread-longtask',{durMs:Math.round(e.duration),startMs:Math.round(e.startTime),name:String(e.name||''),attribution:attr,staging:irStageElapsedNow()});
        }
      }catch(_){}
    });
    try{obs.observe({entryTypes:['longtask']});}catch(_){try{obs.observe({type:'longtask',buffered:true});}catch(__){}}
    window.__irLongTaskObs=obs;
  }catch(_){}
}
// L80 (2026-05-30): proactive width-freeze for the #3 re-preview churn.
//
// Root cause (v=232 log trace): while a hover is shown, the pointer drifts
// slowly WITHIN the same word; VS Code's hover delay (~300ms) re-fires
// $provideHover at the same word-anchor every ~2s (pos-cache hit — NOT our
// renderer refire, so the L73 refire guard never sees it). Each re-fire makes
// VS Code REBUILD the hover DOM, which transiently collapses the wrapper to a
// 16px sliver via our width:min(max-content,680px) rule while the inner content
// is mid-rebuild. L79 restores the width REACTIVELY (after a >=200ms 2-pass
// sweep) — the user still sees the sliver flash, and the re-stage settle stalls
// to the 500ms budget. Freezing the width PROACTIVELY makes the rebuild
// invisible: a min-width floor at the last-good width beats VS Code's width:16px
// (min-width wins over width) WITHOUT fighting it frame-by-frame, so the box
// stays at its prior size while the content rebuilds, then we release the floor
// once the inner content is back (so a genuinely smaller/larger next render
// still sizes naturally). Only engages on a content-present collapse of a
// wrapper WE positioned — empty shells (real dismiss) are left alone.
function irReleaseWidthFreeze(wrapperEl,reason){
  if(!wrapperEl||!wrapperEl.__irWidthFrozen)return;
  try{wrapperEl.style.removeProperty('min-width');}catch(_){}
  wrapperEl.__irWidthFrozen=false;
  wrapperEl.__irFreezeLatched=false;                 // L82: a release ends the latch; a re-freeze re-evaluates it
  wrapperEl.__irLastFreezeReleaseAt=Date.now();      // L82: anchor for the oscillation window in irFreezeWidth
  var ageMs=Date.now()-(wrapperEl.__irWidthFrozenAt||Date.now());
  irHERecord('width-freeze',{phase:'release',reason:String(reason||''),ageMs:ageMs});
}
function irScheduleWidthFreezeReleaseCheck(wrapperEl){
  var tries=0;
  var raf=window.requestAnimationFrame?function(f){return window.requestAnimationFrame(f);}:function(f){return setTimeout(f,16);};
  function check(){
    try{
      if(!wrapperEl.__irWidthFrozen)return;
      var ageMs=Date.now()-(wrapperEl.__irWidthFrozenAt||Date.now());
      // L82 (2026-05-30): latched freeze = persistent pillar. Do NOT release on
      // content-ready. The inner-width gate below is structurally always-true for
      // the pillar: the inner .monaco-hover is width:max-content, so it measures
      // its own text width (hundreds of px) even while the WRAPPER computes
      // width:min(max-content,680px)→16px. Releasing the floor therefore just re-
      // exposes the 16px sliver and we re-freeze on the next frame — the 510-cycle
      // 16↔670 strobe seen in the v=234 capture (1,019 freeze events in 43s).
      // irFreezeWidth latches once it has watched us re-freeze right after a release
      // IR_WIDTH_FREEZE_OSC_LATCH times; from then we hold the floor at last-good
      // width (a stable, readable box) until the dismiss/clear path drops it, with a
      // backstop so a detached/forgotten floor can't outlive the hover. Poll slowly
      // while latched — the floor is static, no per-frame work to do.
      if(wrapperEl.__irFreezeLatched){
        if(ageMs>IR_WIDTH_FREEZE_LATCH_MAX_MS){irReleaseWidthFreeze(wrapperEl,'latch-timeout');return;}
        setTimeout(check,IR_WIDTH_FREEZE_LATCH_POLL_MS);
        return;
      }
      tries++;
      // The inner .monaco-hover is width:max-content (content-sized) and is NOT
      // stretched by the wrapper's min-width floor, so its width is an honest
      // "content rebuilt" signal that the floor cannot mask — for a GENUINE
      // transient (the wrapper stays wide after release, so we never re-freeze).
      var innerReady=false;
      try{var fi=wrapperEl.querySelector('.monaco-hover,.monaco-editor-hover');innerReady=!!(fi&&fi.getBoundingClientRect().width>=60&&String(fi.textContent||'').length>0);}catch(_){}
      if(innerReady){irReleaseWidthFreeze(wrapperEl,'content-ready');return;}
      if(ageMs>IR_WIDTH_FREEZE_MAX_MS||tries>40){irReleaseWidthFreeze(wrapperEl,'timeout');return;}
      raf(check);
    }catch(_){try{irReleaseWidthFreeze(wrapperEl,'error');}catch(__){}}
  }
  raf(check);
}
function irFreezeWidth(wrapperEl,floorW){
  if(IR_HOVER_NATIVE_ONLY)return;   // L89: no width-freeze on native hover
  if(!wrapperEl||wrapperEl.__irWidthFrozen)return;
  var w=Math.round(floorW);
  if(!(w>=60))return;
  if(w>680)w=680;                                   // never exceed the 680px width budget
  // L82 (2026-05-30): oscillation detector. A re-freeze landing within
  // IR_WIDTH_FREEZE_OSC_WINDOW_MS of the last release means that release was
  // premature — content-ready fired but the wrapper immediately re-collapsed (a
  // persistent 16px pillar, not a transient rebuild). Count consecutive rapid
  // re-freezes; at IR_WIDTH_FREEZE_OSC_LATCH, latch so the release check stops
  // letting go and the strobe ends. A genuine transient releases once and never
  // re-freezes (the box stays wide), so osc resets to 0 and behaviour is unchanged.
  var now=Date.now();
  if(wrapperEl.__irLastFreezeReleaseAt&&(now-wrapperEl.__irLastFreezeReleaseAt)<IR_WIDTH_FREEZE_OSC_WINDOW_MS){
    wrapperEl.__irFreezeOsc=(wrapperEl.__irFreezeOsc|0)+1;
  }else{
    wrapperEl.__irFreezeOsc=0;
  }
  var latched=((wrapperEl.__irFreezeOsc|0)>=IR_WIDTH_FREEZE_OSC_LATCH);
  wrapperEl.__irFreezeLatched=latched;
  try{wrapperEl.style.setProperty('min-width',w+'px','important');}catch(_){return;}
  wrapperEl.__irWidthFrozen=true;
  wrapperEl.__irWidthFrozenAt=now;
  irHERecord('width-freeze',{phase:'hold',w:w,osc:(wrapperEl.__irFreezeOsc|0),latched:latched});
  irScheduleWidthFreezeReleaseCheck(wrapperEl);
}
// L81 (2026-05-30): centralised freeze decision, called from EVERY path that
// can witness the collapse. L80 only hooked the style observer, which fires on
// wrapper STYLE-attribute mutations — but v=233 live showed the real 16px
// pillar is COMPUTED (width:min(max-content,680px) recomputing when the inner
// content transiently narrows during VS Code's rebuild), not an inline-style
// write, so the style observer never saw it (0 width-freeze events; the 9 style-
// observer collapses were all 0×0 display:none dismisses). The collapse IS seen
// by the ResizeObserver/content-MO reposition path (irRepositionInitialHover's
// collapse guard logged 6 rawW:16 content pillars) and the periodic sweep
// (column-wrapper-detected w:16 ×15). So freeze from there instead.
function irMaybeFreezeCollapsedWidth(wrapperEl){
  try{
    if(!wrapperEl||wrapperEl.__irWidthFrozen)return;
    if(String(wrapperEl.style.display||'')==='none')return;   // real dismiss, not a pillar
    var r=wrapperEl.getBoundingClientRect();
    // Pillar/column collapse only: narrow width but real height. Excludes the
    // 0×0 dismiss (height<=40) and the height<20 bar (a min-width floor can't fix
    // a height collapse). Matches irScanNarrowHoverWrappers' column shape.
    if(!(r.width<60&&r.height>40))return;
    var inner=wrapperEl.querySelector?wrapperEl.querySelector('.monaco-hover,.monaco-editor-hover'):null;
    if(!inner||String(inner.textContent||'').length===0)return;   // empty shell = not the pillar bug
    if((wrapperEl.__irLastGoodWidth|0)<60)return;                 // no known-good width to hold
    irFreezeWidth(wrapperEl,wrapperEl.__irLastGoodWidth);
  }catch(_){}
}
function irAttachStyleObserverToWrapper(wrapperEl){
  if(!wrapperEl||wrapperEl.__irStyleObs)return;
  if(typeof MutationObserver!=='function')return;
  var styleReapplyPending=false;
  var styleObs=new MutationObserver(function(){
    try{
      // L72 (2026-05-29): width-collapse TRANSITION diagnostic. L71 stopped
      // the char-by-char anchor follow, but the user still sees the width
      // collapse to a 16px column on micro-moves. The periodic sweep only
      // samples the collapsed state after the fact; this fires at the exact
      // style mutation crossing the collapsed<->normal boundary, so PAIRED
      // events bracket the collapse DURATION and record what set the width
      // (inline value), the content state, and whether a point-wrap re-fire
      // or our navigable-name wrapping just ran. Pure observation, no behavior
      // change; bounded to transitions to avoid per-mutation spam.
      try{
        var dgR=wrapperEl.getBoundingClientRect();
        var dgCol=(dgR.width<60||dgR.height<20);
        // L80: continuously remember the last healthy (non-collapsed) width so a
        // later transient collapse can be frozen to it. Skip while frozen (the
        // floored width is not the natural content width).
        if(!dgCol&&dgR.width>=60&&!wrapperEl.__irWidthFrozen){wrapperEl.__irLastGoodWidth=Math.round(dgR.width);}
        if(dgCol!==!!wrapperEl.__irDiagCollapsed){
          wrapperEl.__irDiagCollapsed=dgCol;
          // L79 (2026-05-30): recovering to normal width ends a collapse episode
          // — clear the one-shot guard so a LATER pillar on this (reused) wrapper
          // can be width-restored again. See irScanNarrowHoverWrappers.
          if(!dgCol){try{delete wrapperEl.__irColumnWidthRestored;}catch(_){wrapperEl.__irColumnWidthRestored=0;}}
          var dgInner=wrapperEl.querySelector?wrapperEl.querySelector('.monaco-hover'):null;
          var dgCls=[];
          try{if(dgInner&&dgInner.classList){['ir-keepalive','ir-sticky','ir-scrollable','ir-size-small','ir-size-medium','ir-size-large','fade-in'].forEach(function(c){if(dgInner.classList.contains(c))dgCls.push(c);});}}catch(_){}
          var dgPtr=window.__irLastPointer;
          var dgNow=Date.now();
          irHERecord('width-collapse-transition',{
            to:dgCol?'collapsed':'normal',
            rect:{w:Math.round(dgR.width),h:Math.round(dgR.height)},
            inlineW:String(wrapperEl.style.width||''),
            inlineMaxW:String(wrapperEl.style.maxWidth||''),
            inlineH:String(wrapperEl.style.height||''),
            inlineTop:String(wrapperEl.style.top||''),
            inlineLeft:String(wrapperEl.style.left||''),
            inlineMinW:String(wrapperEl.style.minWidth||''),
            inlineDisplay:String(wrapperEl.style.display||''),
            inlineVisibility:String(wrapperEl.style.visibility||''),
            hasDesired:!!wrapperEl.__irDesired,
            initPositioned:!!wrapperEl.__irInitialPositioned,
            innerTextLen:dgInner?String(dgInner.textContent||'').length:-1,
            innerClasses:dgCls,
            ptr:dgPtr?{x:dgPtr.x,y:dgPtr.y,ageMs:(dgPtr.at?dgNow-dgPtr.at:-1),type:String(dgPtr.type||'')}:null,
            msSincePointWrap:window.__irLastPointWrapAt?(dgNow-window.__irLastPointWrapAt):-1,
            msSinceWrap:window.__irLastWrapAt?(dgNow-window.__irLastWrapAt):-1
          });
          // L80/L81: try to freeze from the style-observer transition too. This
          // covers the case where VS Code writes an inline width:16px (a style
          // mutation this observer DOES see, e.g. v=232). The dominant COMPUTED
          // collapse (v=233) is invisible to this observer and is handled on the
          // reposition-guard + sweep paths via the same helper.
          if(dgCol)irMaybeFreezeCollapsedWidth(wrapperEl);
        }
      }catch(_){}
      if(styleReapplyPending)return;
      var desired=wrapperEl.__irDesired;
      if(!desired)return;
      // L69 (2026-05-29): hands-off while the wrapper is collapsed / mid-
      // resize. During a content swap VS Code transiently shrinks the
      // content-hover to ~scrollbar width (16px column) or a thin bar.
      // Re-pinning top/left or running the L68 anchor-moved branch here
      // keeps our __irDesired glued to that collapsed shell and (via the
      // anchor-moved -> irRepositionInitialHover call) spins a transient-
      // skip retry loop every frame VS Code mutates the style — exactly the
      // v=221 "width narrowing" regression (62% of collapsed columns carried
      // __irDesired vs 17% before). Returning lets VS Code's
      // width:min(max-content,680px) recover the size; the resize observer
      // re-runs our placement once it is full again. This only ever fires
      // for wrappers WE positioned (foreign overlays never get __irDesired
      // or this observer), so other extensions' overlays are untouched.
      var soRect=null;
      try{soRect=wrapperEl.getBoundingClientRect();}catch(_){}
      if(soRect&&(soRect.width<60||soRect.height<20))return;
      // L62 (2026-05-28): re-apply for BOTH drill and initial wrappers.
      // The earlier hasBackStyle gate was added when initial hovers used
      // a mouse-anchored override (L57, retired in L59) that the user
      // disliked. The new initial-hover reposition (L62) is symbol-
      // anchored and viewport-clamped — it needs the same protection
      // against VS Code's _resizableNode.layout() rewriting top/left.
      var curTop=parseInt(wrapperEl.style.top,10);
      var curLeft=parseInt(wrapperEl.style.left,10);
      if(curTop===desired.top&&curLeft===desired.left)return;
      // L68: VS Code wrote a different top/left. If the hover content has
      // swapped to a NEW symbol, this mutation is VS Code moving to the new
      // anchor — do NOT pin it back to the old symbol. Drop our stale state
      // and re-run symbol-anchored placement for the new symbol instead.
      if(irHoverAnchorMoved(wrapperEl)){
        try{delete wrapperEl.__irDesired;}catch(_){wrapperEl.__irDesired=undefined;}
        wrapperEl.__irInitialPositioned=false;
        irHERecord('initial-reposition-anchor-moved',{via:'style-obs'});
        try{irRepositionInitialHover((window.__irCapturedHoverWidget&&window.__irCapturedHoverWidget._editor)||window.__irCapturedEditor,wrapperEl);}catch(_){}
        return;
      }
      // Stop re-applying once the desired pose is older than 4s — the
      // hover may have been re-purposed for a fresh non-drill render.
      if(Date.now()-desired.at>4000)return;
      // L23: Was setTimeout(...,0) which deferred the re-apply to the
      // next macrotask. Between VS Code writing top/left and our timer
      // firing, a layout+paint could occur, so the user saw the wrapper
      // briefly at VS Code's anchor before snapping back — i.e. the
      // reported drill jump. MutationObserver callbacks already run in
      // a microtask before the next paint, so re-applying synchronously
      // (with the re-entry guard) lands the correction in the same
      // frame VS Code wrote its mutation.
      styleReapplyPending=true;
      try{
        wrapperEl.style.top=desired.top+'px';
        wrapperEl.style.left=desired.left+'px';
        irHERecord('drill-style-reapplied',{
          desired:desired,prev:{top:curTop,left:curLeft}
        });
      }catch(_){}
      styleReapplyPending=false;
    }catch(_){}
  });
  try{styleObs.observe(wrapperEl,{attributes:true,attributeFilter:['style']});}catch(_){}
  wrapperEl.__irStyleObs=styleObs;
}
// Clear all positioning state we stored on a wrapper. Called when the
// wrapper goes 0×0 / hidden (VS Code dismissed it) so the next hover
// session starts fresh at VS Code's natural position. Without this,
// inline style.top/left + __irPositionedOnce persist across dismiss and
// the next hover on the same symbol appears at the previous coord.
function irResetWrapperPositionState(wrapperEl,reason){
  try{
    if(!wrapperEl)return;
    // L76: a reset means VS Code dismissed/cleared this wrapper — drop staging
    // state (and reveal) so a dismissed-mid-stage hover never sticks hidden and
    // a later re-show stages fresh. Runs before the early-return below because a
    // staged wrapper may not yet carry __irDesired/positioned flags.
    try{
      if(wrapperEl.__irStaging||wrapperEl.__irStageRevealedSig||(wrapperEl.classList&&wrapperEl.classList.contains('ir-hover-staging'))){
        if(wrapperEl.__irStageTimer){try{clearTimeout(wrapperEl.__irStageTimer);}catch(_){}wrapperEl.__irStageTimer=null;}
        if(wrapperEl.__irStageHardTimer){try{clearTimeout(wrapperEl.__irStageHardTimer);}catch(_){}wrapperEl.__irStageHardTimer=null;}
        if(wrapperEl.classList)wrapperEl.classList.remove('ir-hover-staging');
        wrapperEl.__irStaging=false;
        wrapperEl.__irStageSig=null;
        wrapperEl.__irStageRevealedSig=null;
        wrapperEl.__irStagePrevRect=null;
      }
    }catch(_){}
    // L80: a dismiss/clear releases any held width-freeze floor and drops the
    // last-good-width memory so a re-shown hover freezes against its own size.
    try{
      if(wrapperEl.__irWidthFrozen){try{wrapperEl.style.removeProperty('min-width');}catch(_){}wrapperEl.__irWidthFrozen=false;}
      wrapperEl.__irWidthFrozenAt=0;
      wrapperEl.__irLastGoodWidth=0;
      wrapperEl.__irFreezeLatched=false;   // L82: new content/anchor — re-evaluate the latch from scratch
      wrapperEl.__irFreezeOsc=0;
      wrapperEl.__irLastFreezeReleaseAt=0;
    }catch(_){}
    var hasDrillHeight=false;
    try{
      hasDrillHeight=!!(wrapperEl.style&&(wrapperEl.style.height||wrapperEl.style.maxHeight))
        ||!!(wrapperEl.classList&&wrapperEl.classList.contains('ir-drill-hover'));
    }catch(_){}
    if(!wrapperEl.__irPositionedOnce&&!wrapperEl.__irInitialPositioned&&!wrapperEl.__irDesired&&!hasDrillHeight)return;
    try{wrapperEl.style.removeProperty('top');}catch(_){}
    try{wrapperEl.style.removeProperty('left');}catch(_){}
    try{wrapperEl.style.removeProperty('max-width');}catch(_){}
    try{wrapperEl.style.removeProperty('max-height');}catch(_){}
    try{wrapperEl.style.removeProperty('width');}catch(_){}
    // L48: also strip the forced inline height (set by checkDrillState
    // when ir-drill-hover was active) and the drill class. Without this,
    // dismiss left the wrapper with a frozen "height: 180px !important"
    // — VS Code content-clear ran but the wrapper kept its dimensions,
    // showing as a pillar / empty hover box until the next session.
    try{wrapperEl.style.removeProperty('height');}catch(_){}
    try{if(wrapperEl.classList)wrapperEl.classList.remove('ir-drill-hover');}catch(_){}
    // Inner .monaco-hover element carries its own forced height too.
    try{
      var innerHoverReset=wrapperEl.querySelector&&wrapperEl.querySelector('.monaco-hover');
      if(innerHoverReset&&innerHoverReset.style){
        innerHoverReset.style.removeProperty('height');
        innerHoverReset.style.removeProperty('max-height');
        innerHoverReset.style.removeProperty('width');
        innerHoverReset.style.removeProperty('max-width');
      }
    }catch(_){}
    try{delete wrapperEl.__irPositionedOnce;}catch(_){wrapperEl.__irPositionedOnce=undefined;}
    try{delete wrapperEl.__irInitialPositioned;}catch(_){wrapperEl.__irInitialPositioned=undefined;}
    try{delete wrapperEl.__irPositionedForPos;}catch(_){wrapperEl.__irPositionedForPos=undefined;}
    try{delete wrapperEl.__irDesired;}catch(_){wrapperEl.__irDesired=undefined;}
    try{delete wrapperEl.__irReposRetries;}catch(_){wrapperEl.__irReposRetries=undefined;}
    try{delete wrapperEl.__irReposByelRetries;}catch(_){wrapperEl.__irReposByelRetries=undefined;}
    try{delete wrapperEl.__irInitReposRetries;}catch(_){wrapperEl.__irInitReposRetries=undefined;}
    try{
      if(wrapperEl.__irStyleObs&&typeof wrapperEl.__irStyleObs.disconnect==='function'){
        wrapperEl.__irStyleObs.disconnect();
      }
    }catch(_){}
    try{delete wrapperEl.__irStyleObs;}catch(_){wrapperEl.__irStyleObs=undefined;}
    irHERecord('wrapper-state-reset',{reason:String(reason||''),
      rect:irRectTriplet(wrapperEl)});
  }catch(_){}
}
function irAttachWrapperResizeReposition(widget){
  // L95 (2026-05-31) DEPRECATED in native mode: the per-resize ResizeObserver re-enforcement fought
  // VS Code's own resize (frame drops on handle drag). Native lets VS Code own resize. Logic kept
  // (not deleted) for the legacy managed mode — restore by IR_HOVER_NATIVE_ONLY=false.
  if(IR_HOVER_NATIVE_ONLY)return;
  if(!widget){irHERecord('attach-wrr-skip',{reason:'no-widget'});return;}
  // The hover widget's _resizableNode may be lazily constructed.
  // Retry a few times so we still attach when the widget is captured
  // before its resizable node lands.
  if(!widget._resizableNode||!widget._resizableNode.domNode){
    var tries=(widget.__irAttachTries||0)+1;
    widget.__irAttachTries=tries;
    if(tries===1)irHERecord('attach-wrr-defer',{reason:'no-resizable-node',tries:tries});
    if(tries===20)irHERecord('attach-wrr-give-up',{tries:tries});
    if(tries<=20){setTimeout(function(){try{irAttachWrapperResizeReposition(widget);}catch(_){}},50);}
    return;
  }
  var wrapperEl=widget._resizableNode.domNode;
  if(wrapperEl.__irResizeRepositioned){irHERecord('attach-wrr-skip',{reason:'already-attached'});return;}
  if(typeof ResizeObserver!=='function'){irHERecord('attach-wrr-skip',{reason:'no-ResizeObserver'});return;}
  wrapperEl.__irResizeRepositioned=true;
  try{
    var debounce=null;
    var lastReposAt=0;
    var ro=new ResizeObserver(function(){
      // Debounce — a single drill content swap can fire several
      // resize entries (container, contents, scroller).
      if(debounce)clearTimeout(debounce);
      debounce=setTimeout(function(){
        try{
          // Detect dismiss: wrapper went 0×0 (display:none or removed
          // from layout) OR its content went empty even though VS Code
          // kept the wrapper alive. L48: the latter case used to leave
          // a forced-height "pillar" visible because we only reset on
          // 0×0. Now also reset when contentEl exists but renders no
          // text — that means VS Code cleared the content but our
          // pinned style.height was keeping the wrapper drawn.
          var liveRect=wrapperEl.getBoundingClientRect();
          var contentElLive=widget._hover&&widget._hover.containerDomNode;
          var liveText=contentElLive?String(contentElLive.textContent||'').trim():'';
          var dismissed=liveRect.width<2||liveRect.height<2;
          var emptyButPinned=!dismissed&&!liveText&&!!wrapperEl.__irDesired;
          if(dismissed||emptyButPinned){
            if(wrapperEl.__irPositionedOnce||wrapperEl.__irDesired||emptyButPinned){
              irResetWrapperPositionState(wrapperEl,emptyButPinned?'content-emptied':'resize-observed-dismiss');
            }
            return;
          }
          // L62: route based on drill vs initial content. Drill wrappers
          // (← Back link) go to mouse-anchored reposition. Initial hovers
          // (no Back link) go to symbol-anchored reposition with viewport
          // clamp. Both use widget._editor — the most reliable editor
          // handle (does not depend on __irCapturedEditor being populated
          // via the Map.prototype.set prototype patch, which misses
          // editors that existed before patch install).
          var contentEl=widget._hover&&widget._hover.containerDomNode;
          if(!contentEl)return;
          var hasBack=!!contentEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
          if(!hasBack){
            var txt=String(contentEl.textContent||'');
            if(txt.indexOf('← Back')>=0)hasBack=true;
          }
          var now=Date.now();
          if(now-lastReposAt<300)return;
          lastReposAt=now;
          var ed=widget._editor||window.__irCapturedEditor;
          if(hasBack){
            irRepositionDrilledHover(ed,widget);
          }else{
            try{irRepositionInitialHover(ed,wrapperEl);}catch(_){}
          }
        }catch(_){}
      },60);
    });
    ro.observe(wrapperEl);
    wrapperEl.__irRepositionResizeObs=ro;
    try{irAttachStyleObserverToWrapper(wrapperEl);}catch(_){}
    // L24: Wrap _resizableNode.layout(). VS Code's layout call writes
    // intermediate top/left to the wrapper style mid-flight (multi-stage
    // measurement), and the user saw those intermediate positions as a
    // "drill jump" before our MutationObserver could correct them.
    // Wrapping here lets us re-apply __irDesired synchronously inside
    // the same call frame as the original layout — paint sees only our
    // desired pose. Only takes effect when the wrapper is in drill mode
    // (← Back link present) and __irDesired was set within 4s.
    try{
      var resizable=widget._resizableNode;
      if(resizable&&typeof resizable.layout==='function'&&!resizable.__irLayoutWrapped){
        resizable.__irLayoutWrapped=true;
        var origLayout=resizable.layout;
        resizable.layout=function(){
          var rv;
          try{rv=origLayout.apply(this,arguments);}
          catch(layoutErr){throw layoutErr;}
          try{
            var desired=wrapperEl.__irDesired;
            if(desired&&Date.now()-desired.at<4000){
              var hasBackLW=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
              if(!hasBackLW){
                try{var tLW=String(wrapperEl.textContent||'');if(tLW.indexOf('← Back')>=0)hasBackLW=true;}catch(_){}
              }
              if(hasBackLW){
                var lwCurTop=parseInt(wrapperEl.style.top,10);
                var lwCurLeft=parseInt(wrapperEl.style.left,10);
                if(lwCurTop!==desired.top||lwCurLeft!==desired.left){
                  wrapperEl.style.top=desired.top+'px';
                  wrapperEl.style.left=desired.left+'px';
                  irHERecord('drill-layout-wrap-reapplied',{
                    desired:desired,
                    prev:{top:lwCurTop,left:lwCurLeft}
                  });
                }
              }
            }
          }catch(_){}
          return rv;
        };
        irHERecord('resizable-layout-wrapped',{});
      }
    }catch(_){}
    irHERecord('wrapper-resize-observer-attached',{
      hoverRect:irRectTriplet(wrapperEl),
      pointer:irPointerTriplet(),
      viewport:irViewportInfo()
    });
  }catch(_){}
}
function irAttachEditorScrollWatch(editor){
  if(!editor||editor.__irScrollWatched)return;
  editor.__irScrollWatched=true;
  try{
    if(typeof editor.onDidScrollChange==='function'){
      editor.onDidScrollChange(function(e){
        try{
          // L27: pre-gate. This handler only forwards telemetry — its
          // reposition logic was removed earlier. When telemetry is off
          // (default after L1) AND there is no scroll change to report,
          // we must do NOTHING. Previously we still read wrapper rect
          // and the hover's full textContent (57K chars in the user's
          // large-class case) on every scroll tick — a major scroll
          // jank source on huge hovers. editor-scroll is not in the
          // force-log set, so when enabled is false the irHERecord call
          // below would early-return anyway; just skip the expensive
          // reads up front.
          var telOn=!!(window.__irHoverEventLogConfig&&window.__irHoverEventLogConfig.enabled);
          if(!telOn)return;
          if(!e.scrollTopChanged&&!e.scrollLeftChanged)return;
          var widget=window.__irCapturedHoverWidget;
          if(!widget){
            irHERecord('editor-scroll',{
              scrollTop:Math.round(e.scrollTop),
              scrollLeft:Math.round(e.scrollLeft),
              scrollTopChanged:e.scrollTopChanged,
              scrollLeftChanged:e.scrollLeftChanged
            });
            return;
          }
          var wrapperEl=widget._resizableNode&&widget._resizableNode.domNode;
          var bbox=null;
          var isDrill=false;
          if(wrapperEl){
            try{
              var r=wrapperEl.getBoundingClientRect();
              bbox={l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};
            }catch(_){}
            try{
              // Faster drill detection: query for the back link element
              // instead of stringifying 50K+ char textContent. The link
              // is the canonical drill marker; falling back to the text
              // scan is only needed if the link wasn't rendered yet,
              // which won't be the case here (handler runs post-paint).
              var contentEl=widget._hover&&widget._hover.containerDomNode;
              isDrill=!!(contentEl&&contentEl.querySelector&&contentEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]'));
            }catch(_){}
          }
          if(isDrill||(bbox&&bbox.w>0)){
            irHERecord('editor-scroll',{
              scrollTop:Math.round(e.scrollTop),
              scrollLeft:Math.round(e.scrollLeft),
              scrollTopChanged:e.scrollTopChanged,
              scrollLeftChanged:e.scrollLeftChanged,
              wrapperBbox:bbox,
              isDrill:isDrill
            });
          }
          // (Scroll-triggered reposition removed. Per user policy, the
          // drill hover should be placed at mouse cursor on first
          // pop-in only — not continuously chase the symbol or the
          // mouse on subsequent scrolls. The wrapper stays where it
          // first settled.)
        }catch(_){}
      });
      irHERecord('editor-scroll-watched',{});
    }
  }catch(_){}
}
function irRepositionDrilledHover(editor,widget){
  if(IR_HOVER_NATIVE_ONLY)return;   // L110 (2026-06-01): VS Code owns drill hover position (user directive). We no longer move drill hovers; they stay where VS Code/the original hover places them.
  // Compute desired screen coordinates for the drilled hover wrapper
  // from the original symbol's document position (line+column) +
  // current editor scroll + viewport bounds. Sets wrapper top/left so
  // the hover stays attached to the symbol as the user scrolls.
  //
  // Inputs:
  //   - widget._editor (or passed editor parameter): the CodeEditorWidget instance.
  //     editor.getScrolledVisiblePosition({lineNumber,column}) gives the
  //     symbol's current pixel offset inside the editor's content area.
  //   - widget._resizableNode.domNode: the .monaco-resizable-hover element
  //     whose top/left we'll set.
  //   - window.__irHoverNaturalPosition: anchor saved by the
  //     getPosition() wrap when the initial hover was shown. Contains
  //     {position:{lineNumber,column}, preference:[...]}.
  //   - window.__irLastPointer (captured by existing pointer trackers):
  //     latest mouse coords, used to keep the hover horizontally close
  //     to the cursor so micro-mouse-moves don't cross the bbox edge.
  try{
    if(!widget||!widget._resizableNode||!widget._resizableNode.domNode)return;
    if(!editor||typeof editor.getScrolledVisiblePosition!=='function')return;
    var anchor=window.__irHoverNaturalPosition;
    if(!anchor||!anchor.position)return;
    var pos=anchor.position;
    var visible;
    try{visible=editor.getScrolledVisiblePosition({lineNumber:pos.lineNumber,column:pos.column});}catch(_){visible=null;}
    if(!visible)return;
    var editorDom=editor.getDomNode&&editor.getDomNode();
    if(!editorDom)return;
    var editorRect=editorDom.getBoundingClientRect();
    var symbolScreenTop=editorRect.top+visible.top;
    var symbolScreenLeft=editorRect.left+visible.left;
    var lineHeight=visible.height||18;
    var wrapperEl=widget._resizableNode.domNode;
    var wrapperRect=wrapperEl.getBoundingClientRect();
    var rawH=wrapperRect.height;
    var rawW=wrapperRect.width;
    // Skip transient/invisible state: raw rect 0×0 means the wrapper is
    // not yet rendered, and any top/left we write would be overwritten by
    // VS Code's _resizableNode.layout() when it lands. Same for the
    // height-2 mid-resize gap between drill content swaps. Schedule a
    // deferred retry so we don't miss the settled state (the resize
    // observer may not fire again once the wrapper is at its final size).
    if(rawH<60||rawW<60){
      irHERecord('drill-reposition-skip-transient',{rawW:Math.round(rawW),rawH:Math.round(rawH)});
      var retries=(wrapperEl.__irReposRetries||0);
      if(retries<3){
        wrapperEl.__irReposRetries=retries+1;
        setTimeout(function(){
          try{irRepositionDrilledHover(editor,widget);}catch(_){}
        },250);
      }
      return;
    }
    // Settled — reset retry counter so the next drill starts fresh.
    wrapperEl.__irReposRetries=0;
    // One-shot per drill wrapper: reposition ONLY at first pop-in. Once
    // we've placed the wrapper at the mouse anchor, leave it alone — the
    // user reported that continuously following the mouse is wrong UX.
    // The flag is reset when the wrapper is recreated for a new drill.
    if(wrapperEl.__irPositionedOnce){
      irHERecord('drill-reposition-skip-already-positioned',{});
      return;
    }
    // Drilled-wrapper width clamp via JS. CSS :has(a[href*="previewBack"])
    // doesn't always apply in the real DOM (link rendered with data-href
    // and href="#"). Without a width clamp the 680px-wide wrapper
    // hits viewport-edge clamp regardless of mouse X, so the hover
    // appears "fixed". Force a narrower drilled wrapper here.
    var hasBack=false;
    try{
      hasBack=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
      if(!hasBack){
        var t=String(wrapperEl.textContent||'');
        if(t.indexOf('← Back')>=0)hasBack=true;
      }
    }catch(_){}
    if(hasBack){
      try{
        // Width clamp stays (prevents viewport-edge pinning), but
        // height is allowed to grow up to 48vh (set by our CSS rule
        // for drill wrappers). Large classes (Company-scale) need
        // the full vertical space; small drill content stays compact
        // via height:max-content.
        wrapperEl.style.maxWidth='560px';
        wrapperEl.style.width='auto';
        var inner=wrapperEl.querySelector('.monaco-hover');
        if(inner){
          inner.style.maxWidth='560px';
        }
        var rectAfter=wrapperEl.getBoundingClientRect();
        rawH=rectAfter.height;
        rawW=rectAfter.width;
      }catch(_){}
    }
    var hoverH=rawH;
    var hoverW=rawW;
    var viewportH=(window.innerHeight||document.documentElement.clientHeight||900);
    var viewportW=(window.innerWidth||document.documentElement.clientWidth||1440);
    // Drilled-hover positioning policy (user request): the drilled
    // hover should be anchored to the MOUSE CURSOR position, not the
    // original symbol's screen position. The user clicked a link
    // inside the previous hover, and the new content should appear
    // right under the cursor so micro-mouse-moves don't leave the
    // bbox. Symbol screen position is the fallback when no fresh
    // pointer is available.
    var pointer=window.__irLastPointer;
    var anchorX, anchorY;
    var anchorSource='symbol';
    if(pointer&&typeof pointer.x==='number'&&typeof pointer.y==='number'){
      anchorX=pointer.x;
      anchorY=pointer.y;
      anchorSource='mouse';
    }else{
      anchorX=symbolScreenLeft;
      anchorY=symbolScreenTop;
    }
    // Place top so the mouse falls into the upper-third of the hover
    // (gives the user a comfortable read area below the cursor).
    // If there's not enough room above, flip below.
    var topAboveAnchor=anchorY-Math.min(hoverH*0.25,40);
    var top;
    if(topAboveAnchor>=2&&topAboveAnchor+hoverH+2<=viewportH){
      top=topAboveAnchor;
    }else if(anchorY+lineHeight+hoverH+2<=viewportH){
      top=anchorY+lineHeight+2;
    }else{
      top=Math.max(2,Math.min(viewportH-hoverH-2,topAboveAnchor));
    }
    // Place left so mouse is at the same ~25% from left edge.
    var left=anchorX-Math.min(hoverW*0.25,80);
    if(left+hoverW>viewportW)left=viewportW-hoverW-2;
    if(left<2)left=2;
    // Apply WITHOUT !important. Inline style without !important loses
    // to our CSS rules that DON'T set top/left (we never override those
    // in CSS), so it survives. Avoids the keybinding-recorder side
    // effect we saw with !important earlier.
    var roundedTop=Math.round(top);
    var roundedLeft=Math.round(left);
    wrapperEl.style.top=roundedTop+'px';
    wrapperEl.style.left=roundedLeft+'px';
    // Record desired pose so the style-attribute MutationObserver can
    // re-apply after VS Code's _resizableNode.layout() rewrites top/left.
    wrapperEl.__irDesired={top:roundedTop,left:roundedLeft,at:Date.now()};
    // Lock: one reposition per drill wrapper. Subsequent triggers
    // (scroll, pointer enter, mutations) will skip via __irPositionedOnce.
    wrapperEl.__irPositionedOnce=true;
    irHERecord('drill-reposition',{
      anchorSource:anchorSource,
      anchorX:Math.round(anchorX),
      anchorY:Math.round(anchorY),
      top:Math.round(top),
      left:Math.round(left),
      hoverH:Math.round(hoverH),
      hoverW:Math.round(hoverW),
      symbolScreenTop:Math.round(symbolScreenTop),
      symbolScreenLeft:Math.round(symbolScreenLeft),
      viewport:{w:viewportW,h:viewportH},
      hoverRectBefore:irRectTriplet(wrapperEl),
      anchorTriplet:irCoordTriplet(anchorX,anchorY),
      symbolTriplet:irCoordTriplet(symbolScreenLeft,symbolScreenTop),
      pointer:irPointerTriplet(),
      window:irViewportInfo()
    });
  }catch(err){
    try{irHERecord('drill-reposition-error',{err:String(err).slice(0,100)});}catch(_){}
  }
}
function irLooksLikeHoverWidget(v){
  if(!v||typeof v!=='object')return false;
  try{
    if(typeof v.getId==='function'){
      var id=String(v.getId()||'');
      if(id==='editor.contrib.resizableContentHoverWidget')return true;
    }
  }catch(_){}
  return false;
}
// Body-level fallback: watch document.body subtree mutations and, when
// a .monaco-resizable-hover that contains a previewBack link appears
// (i.e. a drilled hover lands in the DOM), trigger reposition. This
// catches cases where the widget-capture path missed because VS Code
// recreated the wrapper element rather than re-rendering into the
// existing one.
function irInstallDrillBodyObserver(){
  try{
    if(window.__irDrillBodyObserverInstalled)return;
    if(typeof MutationObserver!=='function')return;
    if(!document.body)return;
    window.__irDrillBodyObserverInstalled=true;
    var lastRepositionedAt=0;
    var pendingTimer=null;
    function maybeReposition(){
      try{
        var now=Date.now();
        if(now-lastRepositionedAt<200)return;
        var wrappers=document.querySelectorAll('.monaco-resizable-hover');
        if(!wrappers||!wrappers.length)return;
        // Multiple .monaco-resizable-hover may exist (peek view, stale
        // panels, hidden ones from previous sessions). Filter to the one
        // that's currently in layout: connected, not display:none, with
        // a non-zero rect. Without this filter our retries keep
        // retargeting the same stale 0×0 element and never settle.
        // Per-wrapper cached flags reduce layout-thrash during scroll:
        // once we've decided a wrapper is visible AND forced its inner
        // statics, skip the getComputedStyle calls on subsequent fires.
        // Scroll bursts in large hover content used to trigger body-MO
        // mutations that ran 6+ forced-layout calls per wrapper per
        // mutation → frame drops. Now each wrapper does it ONCE.
        var visibleWrappers=[];
        for(var fi=0;fi<wrappers.length;fi++){
          var w=wrappers[fi];
          if(!w||!document.body.contains(w))continue;
          // Cached visibility (refreshed only if explicitly invalidated).
          if(!w.__irVisCached){
            try{
              var cs=window.getComputedStyle(w);
              if(cs.display==='none'||cs.visibility==='hidden'){w.__irVisCached='hidden';continue;}
            }catch(_){}
            try{
              var r=w.getBoundingClientRect();
              if(r.width<=0||r.height<=0){w.__irVisCached='zero';continue;}
            }catch(_){continue;}
            w.__irVisCached='visible';
          }else if(w.__irVisCached!=='visible'){
            // Cheap re-check: only the rect (no getComputedStyle).
            try{
              var rChk=w.getBoundingClientRect();
              if(rChk.width<=0||rChk.height<=0)continue;
              w.__irVisCached='visible';
            }catch(_){continue;}
          }
          visibleWrappers.push(w);
        }
        // Dismiss-detection pass: only check wrappers that were
        // previously positioned. Use cheap rect-only check (skip
        // getComputedStyle) — display:none gives 0×0 rect too.
        for(var di=0;di<wrappers.length;di++){
          var dw=wrappers[di];
          if(!dw.__irPositionedOnce)continue;
          try{
            var dwRect=dw.getBoundingClientRect();
            if(dwRect.width<2||dwRect.height<2||!document.body.contains(dw)){
              irResetWrapperPositionState(dw,'body-mo-dismiss');
              dw.__irVisCached=null;
              dw.__irInnerForcedOnce=false;
            }
          }catch(_){}
        }
        if(!visibleWrappers.length)return;
        // Arm settle observer on every visible wrapper. The drill check
        // (← Back link) happens INSIDE the observer after the wrapper
        // grows — at body-MO fire time the markdown content hasn't been
        // rendered yet (textContent empty, no <a> tag), so a synchronous
        // hasBack check at find-time always misses drill wrappers.
        for(var i=0;i<visibleWrappers.length;i++){
          var w2=visibleWrappers[i];
          irArmDrillSettleObserver(w2);
          // Proactively force inner position:static — but only ONCE per
          // wrapper. Once we've applied inline !important styles, the
          // inner stays static for the wrapper's lifetime; re-checking
          // on every mutation just thrashes layout.
          if(!w2.__irInnerForcedOnce){
            try{
              var inners=w2.querySelectorAll('.monaco-hover,.monaco-hover-content,.monaco-scrollable-element');
              for(var ie=0;ie<inners.length;ie++){
                var el=inners[ie];
                if(!el||!el.style||typeof el.style.setProperty!=='function')continue;
                el.style.setProperty('position','static','important');
                el.style.setProperty('top','auto','important');
                el.style.setProperty('left','auto','important');
                el.style.setProperty('right','auto','important');
                el.style.setProperty('bottom','auto','important');
                el.style.setProperty('transform','none','important');
                el.style.setProperty('inset','auto','important');
              }
              w2.__irInnerForcedOnce=true;
            }catch(_){}
          }
        }
        lastRepositionedAt=now;
      }catch(_){}
    }
    var mo=new MutationObserver(function(){
      if(pendingTimer)clearTimeout(pendingTimer);
      // Debounce 120ms: a single drill content swap fires a burst of
      // mutations, and scroll-induced mutations elsewhere on the page
      // also reach us (subtree observer). 120ms catches settle while
      // letting scroll bursts coalesce into a single check.
      pendingTimer=setTimeout(maybeReposition,120);
    });
    mo.observe(document.body,{childList:true,subtree:true});
    window.__irDrillBodyObserver=mo;
    irHERecord('drill-body-observer-installed',{});
    // Bare .monaco-hover handler — when an extension-only hover lands
    // WITHOUT a .monaco-resizable-hover wrapper, our CSS keeps the bare
    // .monaco-hover hidden (visibility:hidden, 0×0). Detect this case
    // and lift the clamp via inline style so the hover becomes visible
    // and positionable. Without this, extension-only hovers (drill or
    // first hover when VS Code provides no native content) appear
    // broken — no mouse focus, no position.
    try{irInstallBareHoverHandler();}catch(_){}
    // Back-restore capture — record drill wrapper position when [← Back]
    // is clicked so the next initial hover can be restored to that spot
    // instead of teleporting to the original symbol position.
    try{irInstallBackRestoreCapture();}catch(_){}
    // Pointer enter/leave diagnostics on hover wrappers. Single delegated
    // listener on document.body catches enter/leave for all current and
    // future .monaco-resizable-hover. Records wrapper identification,
    // pointer coords (all 3 frames), and hover rect at the event moment.
    // On pointerenter into a drill wrapper, also trigger a reposition —
    // mouse is right there so it's the perfect time to anchor at mouse.
    try{irInstallHoverPointerDiagnostic();}catch(_){}
  }catch(_){}
}
// Capture the drill wrapper's position when user clicks the [← Back]
// link, so the next initial-hover refire can be repositioned to the
// same spot instead of teleporting back to the symbol's screen
// position (which is typically far from the user's current mouse).
//
// Without this, the back-button flow looks broken: drill hover at
// (mouse near, e.g. 500,400) → click Back at (~510,420) → refire at
// symbol (e.g. 100,200) → user sees the initial hover suddenly leap
// to a distant point.
function irInstallBackRestoreCapture(){
  if(window.__irBackRestoreCaptureInstalled)return;
  if(!document.body)return;
  window.__irBackRestoreCaptureInstalled=true;
  function onClick(e){
    try{
      var t=e.target;
      if(!t||typeof t.closest!=='function')return;
      var backLink=t.closest('a[href*="previewBack"],a[data-href*="previewBack"]');
      if(!backLink)return;
      var wrap=t.closest('.monaco-resizable-hover');
      if(!wrap){
        // Fallback: bare .monaco-hover
        wrap=t.closest('.monaco-hover');
      }
      if(!wrap)return;
      var r=wrap.getBoundingClientRect();
      if(r.width<2||r.height<2)return;
      window.__irBackRestoreAnchor={
        top:Math.round(r.top),
        left:Math.round(r.left),
        width:Math.round(r.width),
        height:Math.round(r.height),
        clickX:typeof e.clientX==='number'?e.clientX:0,
        clickY:typeof e.clientY==='number'?e.clientY:0,
        at:Date.now()
      };
      irHERecord('back-restore-anchor-captured',{anchor:window.__irBackRestoreAnchor});
    }catch(_){}
  }
  // Capture in capture phase so we record BEFORE the click triggers
  // navigation/dismiss handlers downstream.
  document.body.addEventListener('click',onClick,true);
  document.body.addEventListener('pointerdown',onClick,true);
  irHERecord('back-restore-capture-installed',{});
}
// Apply __irBackRestoreAnchor to a freshly-appeared initial hover
// wrapper. Returns true if applied (one-shot — anchor cleared).
function irMaybeApplyBackRestore(wrapperEl){
  try{
    var anchor=window.__irBackRestoreAnchor;
    if(!anchor)return false;
    // Anchor TTL: 3s. After that, restored hover is too late to be
    // associated with the back click — let VS Code's natural position win.
    if(Date.now()-anchor.at>3000){
      window.__irBackRestoreAnchor=null;
      return false;
    }
    // Skip if wrapper still has drill content (← Back) — we're looking
    // for the INITIAL hover that follows the back-refire.
    var hasBack=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
    if(!hasBack){
      try{var t=String(wrapperEl.textContent||'');if(t.indexOf('← Back')>=0)hasBack=true;}catch(_){}
    }
    if(hasBack)return false;
    // Wrapper must be settled (>=60×60) before we move it.
    var r=wrapperEl.getBoundingClientRect();
    if(r.width<60||r.height<60)return false;
    // Skip if already positioned by another path.
    if(wrapperEl.__irPositionedOnce)return false;
    // Apply pose. Keep wrapper width/height as VS Code laid them out;
    // only adjust top/left to match the captured anchor.
    if(wrapperEl.style&&typeof wrapperEl.style.setProperty==='function'){
      wrapperEl.style.top=anchor.top+'px';
      wrapperEl.style.left=anchor.left+'px';
      wrapperEl.__irDesired={top:anchor.top,left:anchor.left,at:Date.now()};
      wrapperEl.__irPositionedOnce=true;
      try{irAttachStyleObserverToWrapper(wrapperEl);}catch(_){}
      irHERecord('back-restore-applied',{anchor:anchor,wrapperRect:irRectTriplet(wrapperEl)});
      window.__irBackRestoreAnchor=null;
      return true;
    }
  }catch(_){}
  return false;
}
// Detect .monaco-hover with content that is NOT inside .monaco-resizable-hover
// — extension-only hovers occasionally land like this. The standalone CSS
// clamp (line ~11359) keeps such elements hidden 0×0, so the user sees
// nothing and can't position the hover. Lift the clamp inline so the
// element is visible and laid out naturally.
function irInstallBareHoverHandler(){
  if(window.__irBareHoverHandlerInstalled)return;
  if(typeof MutationObserver!=='function')return;
  if(!document.body)return;
  window.__irBareHoverHandlerInstalled=true;
  function liftClamp(el){
    if(!el||!el.style||typeof el.style.setProperty!=='function')return false;
    if(el.__irBareLifted)return false;
    try{
      // Restore visibility + natural sizing. Use !important inline so
      // our own author CSS (which forces 0×0 + hidden) is overridden
      // for this specific element only.
      el.style.setProperty('width','auto','important');
      el.style.setProperty('height','auto','important');
      el.style.setProperty('min-width','0','important');
      el.style.setProperty('min-height','0','important');
      el.style.setProperty('max-width','680px','important');
      el.style.setProperty('max-height','48vh','important');
      el.style.setProperty('visibility','visible','important');
      el.style.setProperty('overflow','visible','important');
      el.__irBareLifted=true;
      return true;
    }catch(_){return false;}
  }
  function checkAll(){
    try{
      // Find .monaco-hover elements that are NOT inside .monaco-resizable-hover
      // AND have some textContent (meaning they got content from a provider).
      var allHovers=document.querySelectorAll('.monaco-hover');
      var lifted=0;
      for(var i=0;i<allHovers.length;i++){
        var el=allHovers[i];
        if(!document.body.contains(el))continue;
        // Skip if inside a resizable wrapper — those go through the
        // normal path that lifts the clamp via the descendant CSS rule.
        if(el.closest&&el.closest('.monaco-resizable-hover'))continue;
        var textLen=0;
        try{textLen=(el.textContent||'').trim().length;}catch(_){}
        if(textLen<=0)continue;
        // This is a bare .monaco-hover with content — lift the clamp.
        if(liftClamp(el)){
          lifted++;
          irHERecord('bare-hover-lifted',{
            textLen:textLen,
            sample:String(el.textContent||'').replace(/\s+/g,' ').slice(0,80),
            rectBefore:irRectTriplet(el),
            cls:String(el.className||'')
          });
        }
      }
      if(lifted>0){
        // Re-measure after lift to confirm
        setTimeout(function(){
          for(var j=0;j<allHovers.length;j++){
            var e2=allHovers[j];
            if(!e2.__irBareLifted)continue;
            try{
              irHERecord('bare-hover-after-lift',{rect:irRectTriplet(e2)});
            }catch(_){}
            // Only record once per lifted element
            e2.__irBareLifted=2;
          }
        },50);
      }
    }catch(_){}
  }
  var pending=null;
  var bareMo=new MutationObserver(function(){
    if(pending)clearTimeout(pending);
    pending=setTimeout(checkAll,30);
  });
  bareMo.observe(document.body,{childList:true,subtree:true});
  window.__irBareHoverObserver=bareMo;
  // Immediate scan in case some are already in DOM.
  checkAll();
  irHERecord('bare-hover-handler-installed',{});
}
function irInstallHoverPointerDiagnostic(){
  if(window.__irHoverPointerDiagInstalled)return;
  if(!document.body)return;
  window.__irHoverPointerDiagInstalled=true;
  function forceInnerStatic(el){
    // Inline style with !important beats any author CSS — use this when
    // CSS specificity battles fail to neutralize VS Code's position:fixed
    // on inner hover elements. Idempotent: setProperty re-writes the
    // same value when called repeatedly.
    if(!el||!el.style||typeof el.style.setProperty!=='function')return false;
    try{
      el.style.setProperty('position','static','important');
      el.style.setProperty('top','auto','important');
      el.style.setProperty('left','auto','important');
      el.style.setProperty('right','auto','important');
      el.style.setProperty('bottom','auto','important');
      el.style.setProperty('transform','none','important');
      el.style.setProperty('inset','auto','important');
      return true;
    }catch(_){return false;}
  }
  function describeWrapper(w){
    try{
      var r=w.getBoundingClientRect();
      var hasBack=!!w.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
      if(!hasBack){
        try{var t=String(w.textContent||'');if(t.indexOf('← Back')>=0)hasBack=true;}catch(_){}
      }
      var textSample='';
      try{textSample=String(w.textContent||'').replace(/\s+/g,' ').slice(0,60);}catch(_){}
      // Measure inner descendants — user reported the ancestor wrapper is
      // positioned correctly but the visible content (inner) is somewhere
      // else. We need to see if .monaco-hover / .monaco-hover-content /
      // .rendered-markdown rects diverge from the ancestor.
      function probeChild(sel){
        try{
          var el=w.querySelector(sel);
          if(!el)return null;
          var rr=el.getBoundingClientRect();
          var cs=null;
          try{cs=window.getComputedStyle(el);}catch(_){}
          return {
            sel:sel,
            rect:{l:Math.round(rr.left),t:Math.round(rr.top),w:Math.round(rr.width),h:Math.round(rr.height)},
            position:cs?cs.position:'',
            transform:cs?cs.transform:'',
            top:cs?cs.top:'',
            left:cs?cs.left:'',
            visibility:cs?cs.visibility:'',
            display:cs?cs.display:''
          };
        }catch(_){return null;}
      }
      var inner={
        monacoHover:probeChild('.monaco-hover'),
        hoverContent:probeChild('.monaco-hover-content'),
        scrollable:probeChild('.monaco-scrollable-element'),
        renderedMarkdown:probeChild('.rendered-markdown')
      };
      // Force inline position:static on any inner with non-static
      // computed position. Inline !important beats VS Code's author
      // stylesheets — if we observed a decoupled inner here, fix it now.
      var forcedAny=false;
      try{
        ['.monaco-hover','.monaco-hover-content','.monaco-scrollable-element'].forEach(function(sel){
          var el=w.querySelector(sel);
          if(!el)return;
          var cs2=null;try{cs2=window.getComputedStyle(el);}catch(_){}
          if(cs2&&cs2.position&&cs2.position!=='static'){
            if(forceInnerStatic(el))forcedAny=true;
          }
        });
      }catch(_){}
      if(forcedAny){
        try{irHERecord('inner-force-static-applied',{wrapperRect:{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}});}catch(_){}
      }
      // Wrapper-level CSS
      var ancestorCs=null;
      try{ancestorCs=window.getComputedStyle(w);}catch(_){}
      return {
        rect:{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
        rectTriplet:irRectTriplet(w),
        hasBack:hasBack,
        textSample:textSample,
        connected:document.body.contains(w),
        styleTop:w.style.top||'',
        styleLeft:w.style.left||'',
        ancestorComputed:ancestorCs?{
          position:ancestorCs.position,
          overflow:ancestorCs.overflow,
          height:ancestorCs.height,
          maxHeight:ancestorCs.maxHeight,
          transform:ancestorCs.transform
        }:null,
        inner:inner
      };
    }catch(_){return null;}
  }
  function onPointerIn(e){
    try{
      var t=e.target;
      if(!t||!t.closest)return;
      var wrap=t.closest('.monaco-resizable-hover');
      if(!wrap)return;
      // Dedupe per-wrapper: track current entered wrapper.
      if(wrap.__irPointerInside)return;
      wrap.__irPointerInside=true;
      irHERecord('hover-pointer-enter',{
        wrapper:describeWrapper(wrap),
        pointer:irCoordTriplet(e.clientX,e.clientY)
      });
      // (Pointer-enter reposition removed. Per user policy, the drill
      // hover should be placed at mouse cursor only on first pop-in.
      // The wrapper stays put once positioned; mouse subsequently
      // entering the wrapper should NOT re-position it.)
    }catch(_){}
  }
  function onPointerOut(e){
    try{
      var t=e.target;
      if(!t||!t.closest)return;
      var wrap=t.closest('.monaco-resizable-hover');
      if(!wrap)return;
      // Only fire leave when truly leaving the wrapper (not entering a child)
      var to=e.relatedTarget;
      if(to&&typeof to.closest==='function'&&to.closest('.monaco-resizable-hover')===wrap)return;
      if(!wrap.__irPointerInside)return;
      wrap.__irPointerInside=false;
      irHERecord('hover-pointer-leave',{
        wrapper:describeWrapper(wrap),
        pointer:irCoordTriplet(e.clientX,e.clientY)
      });
    }catch(_){}
  }
  document.body.addEventListener('pointerenter',onPointerIn,true);
  document.body.addEventListener('pointerleave',onPointerOut,true);
  // Also listen mouseover/mouseout as backup — pointerenter doesn't bubble
  // in all WebKit implementations, but mouseover does and we can re-check
  // with the same target.closest('.monaco-resizable-hover') trick.
  document.body.addEventListener('mouseover',onPointerIn,true);
  document.body.addEventListener('mouseout',onPointerOut,true);
  irHERecord('hover-pointer-diag-installed',{});
}
// Arm a one-shot ResizeObserver on a candidate drill wrapper. Fires the
// reposition once the wrapper grows beyond the transient/border-only
// state (≥60×60). Auto-disconnects after a successful reposition or a
// 4-second timeout — prevents lingering observers when VS Code recycles
// the wrapper for non-drill content.
function irArmDrillSettleObserver(wrapperEl){
  try{
    if(!wrapperEl)return;
    // Check immediate state — if already settled AND has drill content,
    // reposition now. If already settled but no drill content yet, still
    // arm the observer so a later content swap (initial → drill) gets
    // caught. Initial hovers without drill content don't get repositioned.
    var initialRect=wrapperEl.getBoundingClientRect();
    if(initialRect.width>=60&&initialRect.height>=60){
      var hasBackArm=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
      if(!hasBackArm){
        try{var tArm=String(wrapperEl.textContent||'');if(tArm.indexOf('← Back')>=0)hasBackArm=true;}catch(_){}
      }
      if(hasBackArm){
        var ed0=window.__irCapturedEditor;
        if(ed0)irRepositionDrilledHoverByElement(ed0,wrapperEl);
        return;
      }
      // L62: settled initial hover — reposition immediately so it lands
      // above/below the symbol and stays inside the viewport. Still arm
      // the observer below to catch later drill content swaps.
      try{
        var edInit0=window.__irCapturedEditor;
        if(edInit0)irRepositionInitialHover(edInit0,wrapperEl);
      }catch(_){}
      // Fall through: arm observer to catch a later content swap.
    }
    if(wrapperEl.__irSettleObs)return;
    if(typeof ResizeObserver!=='function')return;
    // Originally L2/L8 skipped arming on 0×0 wrappers (91% of which timed
    // out without firing). User reported drill hovers jumping in position
    // afterwards — caused by genuine drills that started at 0×0 never
    // getting their reposition observer. We now always arm, but for 0×0
    // wrappers (where most arms are wasted) we use a short 1.5s timeout
    // instead of the default 4s, keeping the wasted-observer cost down.
    var armedAt0x0=(initialRect.width===0&&initialRect.height===0);
    var disposed=false;
    var ro=new ResizeObserver(function(){
      if(disposed)return;
      try{
        // Drill-only check happens inside, not at arm time, because
        // markdown content arrives asynchronously. If the wrapper grew
        // but has no ← Back link yet, KEEP observing (don't disconnect)
        // — we may catch the next resize that follows content arrival.
        var r=wrapperEl.getBoundingClientRect();
        if(r.width<60||r.height<20)return; // L70: collapse = column(w<60) || bar(h<20); short hovers must reposition
        var hasBackInner=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
        if(!hasBackInner){
          try{var t=String(wrapperEl.textContent||'');if(t.indexOf('← Back')>=0)hasBackInner=true;}catch(_){}
        }
        if(!hasBackInner){
          // Initial hover (no back link). Check if we just came from a
          // back-button click — if so, restore at the drill's position
          // for a smooth transition. Otherwise (L62) reposition the
          // initial hover to a symbol-anchored, viewport-clamped pose.
          if(irMaybeApplyBackRestore(wrapperEl)){
            disposed=true;
            try{ro.disconnect();}catch(_){}
            try{delete wrapperEl.__irSettleObs;}catch(_){wrapperEl.__irSettleObs=null;}
          }else{
            try{
              var edInitR=window.__irCapturedEditor;
              if(edInitR)irRepositionInitialHover(edInitR,wrapperEl);
            }catch(_){}
          }
          return;
        }
        var ed=window.__irCapturedEditor;
        if(!ed)return;
        irRepositionDrilledHoverByElement(ed,wrapperEl);
        disposed=true;
        try{ro.disconnect();}catch(_){}
        try{delete wrapperEl.__irSettleObs;}catch(_){wrapperEl.__irSettleObs=null;}
        irHERecord('drill-settle-observer-fired',{rawW:Math.round(r.width),rawH:Math.round(r.height)});
      }catch(_){}
    });
    ro.observe(wrapperEl);
    wrapperEl.__irSettleObs=ro;
    // Also watch subtree mutations — drill content may swap into an
    // already-settled wrapper without changing its size, so ResizeObserver
    // won't fire. The MutationObserver catches the content swap and
    // forwards to the resize callback's check logic.
    var contentMo=null;
    try{
      if(typeof MutationObserver==='function'){
        contentMo=new MutationObserver(function(){
          if(disposed)return;
          try{
            var r=wrapperEl.getBoundingClientRect();
            if(r.width<60||r.height<20)return; // L70: collapse = column(w<60) || bar(h<20); short hovers must reposition
            var hasBackMo=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
            if(!hasBackMo){
              try{var tMo=String(wrapperEl.textContent||'');if(tMo.indexOf('← Back')>=0)hasBackMo=true;}catch(_){}
            }
            if(!hasBackMo){
              if(irMaybeApplyBackRestore(wrapperEl)){
                disposed=true;
                try{ro.disconnect();}catch(_){}
                try{contentMo.disconnect();}catch(_){}
                try{delete wrapperEl.__irSettleObs;}catch(_){wrapperEl.__irSettleObs=null;}
              }else{
                // L62: reposition initial hover (symbol-anchored, viewport-clamped).
                try{
                  var edInitMo=window.__irCapturedEditor;
                  if(edInitMo)irRepositionInitialHover(edInitMo,wrapperEl);
                }catch(_){}
              }
              return;
            }
            var ed=window.__irCapturedEditor;
            if(!ed)return;
            irRepositionDrilledHoverByElement(ed,wrapperEl);
            disposed=true;
            try{ro.disconnect();}catch(_){}
            try{contentMo.disconnect();}catch(_){}
            try{delete wrapperEl.__irSettleObs;}catch(_){wrapperEl.__irSettleObs=null;}
            irHERecord('drill-settle-observer-fired',{rawW:Math.round(r.width),rawH:Math.round(r.height),via:'contentMo'});
          }catch(_){}
        });
        contentMo.observe(wrapperEl,{childList:true,subtree:true,characterData:true});
      }
    }catch(_){}
    // Safety timeout — disconnect if wrapper never grows or never drills.
    // 0×0 wrappers (transient initial hovers VS Code may discard) get a
    // tighter 1.5s window since most never become drills.
    setTimeout(function(){
      if(disposed)return;
      disposed=true;
      try{ro.disconnect();}catch(_){}
      try{if(contentMo)contentMo.disconnect();}catch(_){}
      try{delete wrapperEl.__irSettleObs;}catch(_){wrapperEl.__irSettleObs=null;}
      irHERecord('drill-settle-observer-timeout',{});
    },armedAt0x0?1500:4000);
    irHERecord('drill-settle-observer-armed',{rawW:Math.round(initialRect.width),rawH:Math.round(initialRect.height)});
  }catch(_){}
}
function irRepositionDrilledHoverByElement(editor,wrapperEl){
  if(IR_HOVER_NATIVE_ONLY)return;   // L110 (2026-06-01): VS Code owns drill hover position (user directive).
  try{
    if(!editor||typeof editor.getScrolledVisiblePosition!=='function')return;
    if(!wrapperEl||!wrapperEl.getBoundingClientRect)return;
    var anchor=window.__irHoverNaturalPosition;
    var symbolScreenTop=0,symbolScreenLeft=0,lineHeight=18;
    if(anchor&&anchor.position){
      var pos=anchor.position;
      var visible=null;
      try{visible=editor.getScrolledVisiblePosition({lineNumber:pos.lineNumber,column:pos.column});}catch(_){}
      if(visible){
        var editorDom=editor.getDomNode&&editor.getDomNode();
        if(editorDom&&typeof editorDom.getBoundingClientRect==='function'){
          var er=editorDom.getBoundingClientRect();
          symbolScreenTop=er.top+visible.top;
          symbolScreenLeft=er.left+visible.left;
          lineHeight=visible.height||18;
        }
      }
    }
    var wrapperRect=wrapperEl.getBoundingClientRect();
    var rawBH=wrapperRect.height;
    var rawBW=wrapperRect.width;
    // Skip transient/invisible state: 0×0 raw rect or mid-resize. Schedule
    // a deferred retry so we don't miss the wrapper's settled state.
    if(rawBH<60||rawBW<60){
      irHERecord('drill-reposition-byel-skip-transient',{rawW:Math.round(rawBW),rawH:Math.round(rawBH)});
      var bretries=(wrapperEl.__irReposByelRetries||0);
      if(bretries<3){
        wrapperEl.__irReposByelRetries=bretries+1;
        setTimeout(function(){
          try{irRepositionDrilledHoverByElement(editor,wrapperEl);}catch(_){}
        },250);
      }
      return;
    }
    wrapperEl.__irReposByelRetries=0;
    // One-shot per drill wrapper: reposition only at first pop-in.
    if(wrapperEl.__irPositionedOnce){
      irHERecord('drill-reposition-byel-skip-already-positioned',{});
      return;
    }
    // JS width clamp for drilled wrappers (CSS :has() unreliable). Same
    // rationale as in irRepositionDrilledHover.
    var hasBackBE=false;
    try{
      hasBackBE=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
      if(!hasBackBE){
        var tBE=String(wrapperEl.textContent||'');
        if(tBE.indexOf('← Back')>=0)hasBackBE=true;
      }
    }catch(_){}
    if(hasBackBE){
      try{
        // Width clamp stays; height allowed to grow to 48vh via CSS.
        wrapperEl.style.maxWidth='560px';
        wrapperEl.style.width='auto';
        var innerBE=wrapperEl.querySelector('.monaco-hover');
        if(innerBE){
          innerBE.style.maxWidth='560px';
        }
        var rectAfterBE=wrapperEl.getBoundingClientRect();
        rawBH=rectAfterBE.height;
        rawBW=rectAfterBE.width;
      }catch(_){}
    }
    var hoverH=rawBH;
    var hoverW=rawBW;
    var viewportH=(window.innerHeight||document.documentElement.clientHeight||900);
    var viewportW=(window.innerWidth||document.documentElement.clientWidth||1440);
    var pointer=window.__irLastPointer;
    var anchorX,anchorY,anchorSource='symbol';
    if(pointer&&typeof pointer.x==='number'&&typeof pointer.y==='number'){
      anchorX=pointer.x;anchorY=pointer.y;anchorSource='mouse';
    }else{anchorX=symbolScreenLeft;anchorY=symbolScreenTop;}
    var topAboveAnchor=anchorY-Math.min(hoverH*0.25,40);
    var top;
    if(topAboveAnchor>=2&&topAboveAnchor+hoverH+2<=viewportH){top=topAboveAnchor;}
    else if(anchorY+lineHeight+hoverH+2<=viewportH){top=anchorY+lineHeight+2;}
    else{top=Math.max(2,Math.min(viewportH-hoverH-2,topAboveAnchor));}
    var left=anchorX-Math.min(hoverW*0.25,80);
    if(left+hoverW>viewportW)left=viewportW-hoverW-2;
    if(left<2)left=2;
    var roundedTopBE=Math.round(top);
    var roundedLeftBE=Math.round(left);
    wrapperEl.style.top=roundedTopBE+'px';
    wrapperEl.style.left=roundedLeftBE+'px';
    wrapperEl.__irDesired={top:roundedTopBE,left:roundedLeftBE,at:Date.now()};
    wrapperEl.__irPositionedOnce=true;
    try{irAttachStyleObserverToWrapper(wrapperEl);}catch(_){}
    irHERecord('drill-reposition-byel',{
      anchorSource:anchorSource,top:Math.round(top),left:Math.round(left),
      hoverW:Math.round(hoverW),hoverH:Math.round(hoverH),
      hoverRectBefore:irRectTriplet(wrapperEl),
      anchorTriplet:irCoordTriplet(anchorX,anchorY),
      symbolTriplet:irCoordTriplet(symbolScreenLeft,symbolScreenTop),
      pointer:irPointerTriplet(),
      window:irViewportInfo()
    });
  }catch(err){
    try{irHERecord('drill-reposition-byel-error',{err:String(err).slice(0,100)});}catch(_){}
  }
}
// L66 (2026-05-29): foreign hover-overlay guard.
// Originally intended to catch "hover-on-hover" (a nested hover triggered
// while the pointer is over existing hover content). EMPIRICAL FINDING
// (v=219 telemetry): the common def-lookup hover-on-hover REUSES VS Code's
// single content-hover wrapper (content swaps in place, like drill), so
// there is no second overlay and this guard never fired for it — that case
// surfaces as no-natural-pos and is now resolved by L67 (widget anchor) or
// left at VS Code's placement. The guard is kept because it still correctly
// covers GENUINELY SEPARATE overlays stacked over the editor (peek view, a
// standalone .monaco-hover tooltip): when the last pointer sits over a
// hover/list overlay OTHER than the wrapper we're about to reposition, the
// anchor is not our editor symbol, so we skip and leave VS Code's placement
// (drill rule [[feedback_mouse_anchored_drill]]).
//
// Detection runs LIVE at reposition time (not via a stored pointer flag)
// to stay immune to the synthetic mouseover/mouseout boundary events that
// Chromium dispatches when a fresh hover paints under a stationary cursor:
// walk the hit-test stack under the last pointer and report a "foreign"
// overlay only when it is a hover/list overlay OTHER than wrapperEl. The
// covers-cursor case (the new wrapper itself sitting under the cursor) is
// intentionally NOT treated as foreign — that one we still symbol-anchor
// (now via L67).
function irPointerOverForeignHoverOverlay(wrapperEl){
  try{
    if(!wrapperEl||typeof document.elementsFromPoint!=='function')return false;
    var ptr=window.__irLastPointer;
    if(!ptr||typeof ptr.x!=='number'||typeof ptr.y!=='number')return false;
    var stack=document.elementsFromPoint(ptr.x,ptr.y);
    if(!stack||!stack.length)return false;
    for(var i=0;i<stack.length;i++){
      var el=stack[i];
      if(!el||!el.closest)continue;
      var overlay=el.closest('.monaco-resizable-hover')||el.closest('.monaco-hover')||el.closest('.monaco-list');
      if(!overlay)continue;
      // The wrapper being repositioned sitting under the cursor is the
      // covers-cursor case, not hover-on-hover — skip it, keep walking.
      if(overlay===wrapperEl)continue;
      if(wrapperEl.contains&&wrapperEl.contains(overlay))continue;
      if(overlay.contains&&overlay.contains(wrapperEl))continue;
      return true;
    }
    return false;
  }catch(_){return false;}
}
// L62 (2026-05-28): Initial (non-drill) hover positioning.
// User report: hovers appear neither above nor below the symbol — they
// cover the cursor, and large hovers extend past the VS Code window.
// Root cause: VS Code measures hover content at a smaller size than what
// our CSS finally expands it to (max 680px × 48vh), so its anchor calc
// is for a hover that ends up larger; the bigger wrapper then overlaps
// the symbol and/or spills past the viewport edge.
//
// Fix: anchor on the SYMBOL screen position (via __irHoverNaturalPosition
// + editor.getScrolledVisiblePosition), prefer above-symbol placement,
// fall back to below if above doesn't fit, else clamp to viewport. Drill
// hovers stay mouse-anchored (separate __irPositionedOnce flag, see
// [[feedback_mouse_anchored_drill]] memory rule). The L57 attempt used
// mouse position and was reverted in L59 because mouse and the hovered
// symbol can be on different tokens — using the symbol position avoids
// that whole class of mismatches.
function irRepositionInitialHover(editor,wrapperEl){
  if(IR_HOVER_NATIVE_ONLY)return;   // L91: native hover keeps VS Code's own placement (we never set top/left)
  try{
    if(!wrapperEl||!wrapperEl.getBoundingClientRect){irHERecord('initial-reposition-skip',{reason:'no-wrapper'});return;}
    // Skip drill wrappers — drill goes through irRepositionDrilledHover*.
    var hasBackInit=!!wrapperEl.querySelector('a[href*="previewBack"],a[data-href*="previewBack"]');
    if(!hasBackInit){
      try{var tInit=String(wrapperEl.textContent||'');if(tInit.indexOf('← Back')>=0)hasBackInit=true;}catch(_){}
    }
    if(hasBackInit)return;
    // L69 (2026-05-29): bail out BEFORE the one-shot / anchor-moved
    // bookkeeping while the wrapper is collapsed or mid-resize. The
    // post-measurement transient guard below already skips placement on a
    // collapsed wrapper, but it runs AFTER the L68 anchor-moved branch has
    // deleted __irDesired and cleared __irInitialPositioned — so a
    // reposition that fires during VS Code's content-swap collapse would
    // churn our state (desired flips true->false) and re-queue retries every
    // frame, which fed the v=221 column-collapse storm. Checking here keeps
    // our positioning state intact until the wrapper settles.
    // L70 (2026-05-29): "collapsed" is width<60 (16px column) OR height<20
    // (the 2-4px bar) — the SAME contract as the style observer guard
    // (irAttachStyleObserverToWrapper) and the column/bar detector. The
    // earlier height<60 over-rejected normal SHORT hovers: a 670x32 one-line
    // type hover is fully rendered, not transient, yet was never moved (v=222
    // success min height was 94). Worse, the style observer guard uses <20,
    // so it passed height=32 into its anchor-moved branch which called back
    // here only to hit height<60 and skip+retry — the v=222 670x32
    // skip-transient churn loop (23 events in one frame). Aligning both
    // guards to height<20 breaks the loop and lets short hovers reposition.
    var preRect=null;
    try{preRect=wrapperEl.getBoundingClientRect();}catch(_){}
    if(preRect&&(preRect.width<60||preRect.height<20)){
      irHERecord('initial-reposition-skip-transient',{rawW:Math.round(preRect.width),rawH:Math.round(preRect.height),phase:'pre-oneshot'});
      // L81: this guard is the PROVEN sighting of the content-bearing 16px pillar
      // (RO + content-MO feed it; v=233 logged 6 rawW:16 here). Freeze the width
      // so the sliver never paints while we wait out the transient + retry.
      try{irMaybeFreezeCollapsedWidth(wrapperEl);}catch(_){}
      var preRetries=(wrapperEl.__irInitReposRetries||0);
      if(preRetries<3){
        wrapperEl.__irInitReposRetries=preRetries+1;
        setTimeout(function(){try{irRepositionInitialHover(editor,wrapperEl);}catch(_){}},200);
      }
      return;
    }
    // One-shot per initial hover wrapper. Separate flag from
    // __irPositionedOnce (drill flag) so a later initial→drill content
    // swap can still trigger the drill reposition path.
    if(wrapperEl.__irInitialPositioned){
      // L68: the wrapper is a reused singleton; allow re-positioning when
      // its content swapped to a new symbol (live anchor moved). Without
      // this the one-shot keeps the hover at the previous symbol's coords.
      if(!irHoverAnchorMoved(wrapperEl))return;
      try{delete wrapperEl.__irDesired;}catch(_){wrapperEl.__irDesired=undefined;}
      wrapperEl.__irInitialPositioned=false;
      irHERecord('initial-reposition-anchor-moved',{via:'reposition'});
    }
    // L66: leave hover-on-hover (nested) hovers mouse-anchored — see
    // irPointerOverForeignHoverOverlay. Skipping here keeps the L64/L65
    // DOM fallback from flinging the hover onto a bogus editor token that
    // happens to sit under the source overlay.
    if(irPointerOverForeignHoverOverlay(wrapperEl)){
      irHERecord('initial-reposition-skip',{reason:'overlay-anchor'});
      return;
    }
    // L63: prefer the editor remembered at getPosition wrap time — it
    // is the editor that actually owns the current hover (correct
    // column, correct viewport). The passed editor param is fallback
    // for cases where the getPosition wrap has not fired yet.
    var useEditor=window.__irHoverNaturalEditor||editor;
    var anchor=window.__irHoverNaturalPosition;
    var pos=anchor&&anchor.position?anchor.position:null;
    var editorSrc=window.__irHoverNaturalEditor?'wrap':(editor?'arg':'none');
    var posSrc=pos?'wrap':'none';
    // L67 (2026-05-29): stationary-first-hover anchor recovery.
    // irWrapHoverWidgetGetPosition only populates __irHoverNaturalPosition
    // when VS Code itself calls the wrapped getPosition() AFTER our wrap
    // installed. When a hover opens under an ALREADY-stationary cursor, VS
    // Code positions the widget before the prototype-patch sniffer captures
    // it, so the wrap lands too late, the cache stays empty, and we emit
    // no-natural-pos — leaving the hover covering the cursor (v=219 telemetry
    // showed this as the dominant no-natural-pos cause once hover-on-hover
    // was ruled out). The content-hover widget is a reused singleton
    // (window.__irCapturedHoverWidget); calling its getPosition() ourselves
    // returns the live anchor regardless of capture timing (and back-fills
    // the cache as a side effect of the wrap). This authoritative source is
    // preferred over the L64/L65 pixel-under-pointer fallback below.
    if(!pos||!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function'){
      var hw=window.__irCapturedHoverWidget;
      if(hw&&typeof hw.getPosition==='function'){
        try{
          var gp=hw.getPosition();
          if(!pos&&gp&&gp.position){pos={lineNumber:gp.position.lineNumber,column:gp.position.column};posSrc='widget';}
        }catch(_){}
        if((!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function')&&hw._editor&&typeof hw._editor.getScrolledVisiblePosition==='function'){
          useEditor=hw._editor;editorSrc='widget';
        }
      }
    }
    // L64: column-change fallback. When widget capture missed (common
    // after opening a new editor column / split), __irHoverNaturalEditor
    // and __irHoverNaturalPosition are null. Locate the host editor by
    // finding the .monaco-editor under the last pointer, then derive
    // the symbol target from getTargetAtClientPoint. This makes our
    // reposition independent of the prototype-patch widget capture.
    //
    // L65: covers-cursor case — VS Code's natural hover wrapper has
    // already painted ON TOP of the cursor, so elementFromPoint(x,y)
    // returns the hover wrapper itself (no .monaco-editor ancestor) and
    // the L64 single-element lookup fails with no-natural-pos. Walk the
    // hit-test stack via elementsFromPoint and skip any node inside the
    // hover/list overlays to reach the underlying editor.
    if((!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function')||!pos){
      var ptr=window.__irLastPointer;
      if(ptr&&typeof ptr.x==='number'&&typeof ptr.y==='number'){
        var domEditor=null;
        var domEd=null;
        try{
          var stack=(document.elementsFromPoint)?document.elementsFromPoint(ptr.x,ptr.y):[];
          if((!stack||stack.length===0)&&document.elementFromPoint){
            var only=document.elementFromPoint(ptr.x,ptr.y);
            if(only)stack=[only];
          }
          for(var si=0;si<stack.length;si++){
            var stEl=stack[si];
            if(!stEl||!stEl.closest)continue;
            // Skip hover overlays — the wrapper we're trying to relocate
            // is the very thing covering the cursor right now.
            if(stEl.closest('.monaco-resizable-hover'))continue;
            if(stEl.closest('.monaco-hover'))continue;
            if(stEl.closest('.monaco-list'))continue;
            var maybeEd=stEl.closest('.monaco-editor');
            if(maybeEd){domEd=maybeEd;break;}
          }
          if(domEd){
            try{if(typeof irListAllCodeEditors==='function'){
              var allEds=irListAllCodeEditors();
              for(var aei=0;aei<allEds.length;aei++){
                var cand=allEds[aei];
                var cn=cand&&cand.getDomNode&&cand.getDomNode();
                if(cn&&(cn===domEd||(cn.contains&&cn.contains(domEd)))){domEditor=cand;break;}
              }
            }}catch(_){}
            if(!domEditor){try{domEditor=irFindWidgetOnElement(domEd);}catch(_){}}
          }
        }catch(_){}
        if(domEditor&&typeof domEditor.getScrolledVisiblePosition==='function'){
          if(!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function'){useEditor=domEditor;editorSrc='dom';}
          if(!pos&&typeof domEditor.getTargetAtClientPoint==='function'){
            try{
              var tgt=domEditor.getTargetAtClientPoint(ptr.x,ptr.y);
              if(tgt&&tgt.position){pos={lineNumber:tgt.position.lineNumber,column:tgt.position.column};posSrc='dom-target';}
            }catch(_){}
          }
        }
      }
    }
    if(!useEditor||typeof useEditor.getScrolledVisiblePosition!=='function'){irHERecord('initial-reposition-skip',{reason:'no-editor'});return;}
    if(!pos){irHERecord('initial-reposition-skip',{reason:'no-natural-pos'});return;}
    var visible=null;
    try{visible=useEditor.getScrolledVisiblePosition({lineNumber:pos.lineNumber,column:pos.column});}catch(_){}
    if(!visible){irHERecord('initial-reposition-skip',{reason:'no-visible',pos:pos});return;}
    var editorDom=useEditor.getDomNode&&useEditor.getDomNode();
    if(!editorDom){irHERecord('initial-reposition-skip',{reason:'no-editor-dom'});return;}
    // Some captured "editors" are inner code-block mini-editors inside
    // hover content — their getDomNode returns an object that fails the
    // getBoundingClientRect call. Validate before invoking so we don't
    // throw inside the resize callback and spin retries.
    if(typeof editorDom.getBoundingClientRect!=='function'){irHERecord('initial-reposition-skip',{reason:'no-editor-rect'});return;}
    var editorRect=editorDom.getBoundingClientRect();
    var symbolScreenTop=editorRect.top+visible.top;
    var symbolScreenLeft=editorRect.left+visible.left;
    var lineHeight=visible.height||18;
    var wrapperRect=wrapperEl.getBoundingClientRect();
    var rawH=wrapperRect.height;
    var rawW=wrapperRect.width;
    // Skip transient/mid-resize state — retry after the wrapper settles.
    // L70: collapse = width<60 (column) || height<20 (bar); see entry guard.
    if(rawW<60||rawH<20){
      irHERecord('initial-reposition-skip-transient',{rawW:Math.round(rawW),rawH:Math.round(rawH)});
      try{irMaybeFreezeCollapsedWidth(wrapperEl);}catch(_){}   // L81: hold width through the transient
      var retries=(wrapperEl.__irInitReposRetries||0);
      if(retries<3){
        wrapperEl.__irInitReposRetries=retries+1;
        setTimeout(function(){
          try{irRepositionInitialHover(editor,wrapperEl);}catch(_){}
        },200);
      }
      return;
    }
    wrapperEl.__irInitReposRetries=0;
    // L81: healthy measurement on the reposition path — remember it as the
    // last-good width so a later collapse on this wrapper can be frozen to it,
    // independent of whether the style observer happened to fire.
    if(!wrapperEl.__irWidthFrozen&&rawW>=60)try{wrapperEl.__irLastGoodWidth=Math.round(rawW);}catch(_){}
    var viewportH=(window.innerHeight||document.documentElement.clientHeight||900);
    var viewportW=(window.innerWidth||document.documentElement.clientWidth||1440);
    var hoverH=rawH,hoverW=rawW;
    // Prefer above the symbol; fall back to below; else clamp to viewport.
    var topAbove=symbolScreenTop-hoverH-2;
    var topBelow=symbolScreenTop+lineHeight+2;
    var placement='above';
    var top;
    if(topAbove>=2){
      top=topAbove;
    }else if(topBelow+hoverH+2<=viewportH){
      top=topBelow;placement='below';
    }else{
      var roomAbove=symbolScreenTop;
      var roomBelow=viewportH-(symbolScreenTop+lineHeight);
      if(roomAbove>=roomBelow){
        top=Math.max(2,topAbove);placement='above-clamped';
      }else{
        top=topBelow;placement='below-clamped';
      }
      if(top<2)top=2;
      if(top+hoverH+2>viewportH)top=Math.max(2,viewportH-hoverH-2);
    }
    var left=symbolScreenLeft;
    if(left+hoverW+2>viewportW)left=viewportW-hoverW-2;
    if(left<2)left=2;
    var roundedTop=Math.round(top);
    var roundedLeft=Math.round(left);
    wrapperEl.style.top=roundedTop+'px';
    wrapperEl.style.left=roundedLeft+'px';
    wrapperEl.__irDesired={top:roundedTop,left:roundedLeft,at:Date.now()};
    wrapperEl.__irInitialPositioned=true;
    // L68: remember which symbol we positioned for, so a later content swap
    // (new symbol in the reused wrapper) is detected by irHoverAnchorMoved.
    // L71: also store the word RANGE so a micro-move WITHIN this symbol is
    // not mistaken for a swap. Prefer the anchor we actually used
    // (__irHoverNaturalPosition carries a cloned range); fall back to the
    // live widget range. Null when neither provides one (DOM-target path).
    var posdRange=null;
    try{
      var posdAnchor=window.__irHoverNaturalPosition;
      if(posdAnchor&&posdAnchor.range){
        posdRange={startLineNumber:posdAnchor.range.startLineNumber,startColumn:posdAnchor.range.startColumn,endLineNumber:posdAnchor.range.endLineNumber,endColumn:posdAnchor.range.endColumn};
      }else{
        var posdHw=window.__irCapturedHoverWidget;
        if(posdHw&&typeof posdHw.getPosition==='function'){
          var posdGp=posdHw.getPosition();
          if(posdGp&&posdGp.range)posdRange={startLineNumber:posdGp.range.startLineNumber,startColumn:posdGp.range.startColumn,endLineNumber:posdGp.range.endLineNumber,endColumn:posdGp.range.endColumn};
        }
      }
    }catch(_){}
    wrapperEl.__irPositionedForPos={lineNumber:pos.lineNumber,column:pos.column,range:posdRange};
    try{irAttachStyleObserverToWrapper(wrapperEl);}catch(_){}
    irHERecord('initial-reposition',{
      placement:placement,
      editorSrc:editorSrc,posSrc:posSrc,
      top:roundedTop,left:roundedLeft,
      hoverW:Math.round(hoverW),hoverH:Math.round(hoverH),
      symbolTop:Math.round(symbolScreenTop),symbolLeft:Math.round(symbolScreenLeft),
      lineHeight:Math.round(lineHeight),
      viewport:{w:viewportW,h:viewportH},
      hoverRectBefore:irRectTriplet(wrapperEl)
    });
  }catch(err){
    try{irHERecord('initial-reposition-error',{err:String(err).slice(0,100)});}catch(_){}
  }
}
try{irInstallDrillBodyObserver();}catch(_){}
// Re-attempt install on DOMContentLoaded in case body wasn't ready.
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',function(){try{irInstallDrillBodyObserver();}catch(_){}});
}
function irOnHoverWidgetCaptured(widget){
  try{
    if(!irLooksLikeHoverWidget(widget))return;
    if(window.__irCapturedHoverWidget===widget)return;
    window.__irCapturedHoverWidget=widget;
    irHERecord('hover-widget-captured',{
      id:'editor.contrib.resizableContentHoverWidget',
      via:'sniffer',
      hoverRect:(widget._resizableNode&&widget._resizableNode.domNode)?irRectTriplet(widget._resizableNode.domNode):null,
      pointer:irPointerTriplet(),
      viewport:irViewportInfo()
    });
    irWrapHoverWidgetGetPosition(widget);
    // Attach ResizeObserver on the wrapper so we can reposition the
    // drilled hover to the mouse cursor when content swaps in. This
    // is the correct attach point — the hover widget owns
    // _resizableNode.domNode, not the editor.
    try{irAttachWrapperResizeReposition(widget);}catch(_){}
  }catch(_){}
}
function irSniffValue(value){
  if(!value||typeof value!=='object')return;
  if(irLooksLikeCodeEditorWidget(value))irOnEditorCaptured(value);
  if(irLooksLikeHoverWidget(value))irOnHoverWidgetCaptured(value);
}
if(!window.__irMapPrototypePatched){
  try{
    var origMapSet=Map.prototype.set;
    Map.prototype.set=function(k,v){
      try{irSniffValue(v);}catch(_){}
      return origMapSet.apply(this,arguments);
    };
    var origWeakMapSet=WeakMap.prototype.set;
    WeakMap.prototype.set=function(k,v){
      try{irSniffValue(v);}catch(_){}
      return origWeakMapSet.apply(this,arguments);
    };
    var origSetAdd=Set.prototype.add;
    Set.prototype.add=function(v){
      try{irSniffValue(v);}catch(_){}
      return origSetAdd.apply(this,arguments);
    };
    var origArrayPush=Array.prototype.push;
    Array.prototype.push=function(){
      try{for(var i=0;i<arguments.length;i++)irSniffValue(arguments[i]);}catch(_){}
      return origArrayPush.apply(this,arguments);
    };
    if(typeof Reflect!=='undefined'&&typeof Reflect.construct==='function'){
      var origRC=Reflect.construct;
      Reflect.construct=function(target,args,newTarget){
        var inst=origRC.apply(Reflect,arguments);
        try{irSniffValue(inst);}catch(_){}
        return inst;
      };
    }
    window.__irMapPrototypePatched=true;
    irHERecord('global-prototype-patched',{});
  }catch(_){}
}
function irFindWidgetOnElement(el){
  // Search direct properties (own + inherited enumerable) on the element
  // for an object that looks like a CodeEditorWidget. Some Monaco builds
  // attach the widget as a private own property; others stash it one
  // level deeper under .editor or ._editor. This mirrors the
  // intellij-styled-search "findMonacoWidgetOn" sniffing pattern.
  if(!el)return null;
  var seen={};
  var keys=[];
  try{var own=Object.getOwnPropertyNames(el);for(var oi=0;oi<own.length;oi++){keys.push(own[oi]);seen[own[oi]]=1;}}catch(_){}
  for(var k in el){if(!seen[k]){keys.push(k);seen[k]=1;}}
  for(var i=0;i<keys.length;i++){
    var v;try{v=el[keys[i]];}catch(_){continue;}
    if(!v||typeof v!=='object')continue;
    if(irLooksLikeCodeEditorWidget(v))return v;
    try{
      if(v.editor&&irLooksLikeCodeEditorWidget(v.editor))return v.editor;
      if(v._editor&&irLooksLikeCodeEditorWidget(v._editor))return v._editor;
    }catch(_){}
  }
  try{
    var syms=Object.getOwnPropertySymbols(el);
    for(var s=0;s<syms.length;s++){
      var sv;try{sv=el[syms[s]];}catch(_){continue;}
      if(!sv||typeof sv!=='object')continue;
      if(irLooksLikeCodeEditorWidget(sv))return sv;
    }
  }catch(_){}
  return null;
}
function irFindCodeEditorViaDom(){
  // Walks .monaco-editor, each of its ancestors up to .editor-group-
  // container, and a handful of common internal descendants
  // (.overflow-guard, .monaco-scrollable-element, .margin, .lines-content)
  // looking for the widget. Lifted from intellij-styled-search's
  // findMonacoWidget — the same multi-spot scan covers every Monaco
  // build we've observed.
  try{
    var nodes=document.querySelectorAll('.monaco-editor');
    for(var n=0;n<nodes.length;n++){
      var startEl=nodes[n];
      var candidates=[startEl];
      var el=startEl.parentElement;
      for(var p=0;p<6&&el;p++,el=el.parentElement){
        candidates.push(el);
        if(el.classList&&el.classList.contains('editor-group-container'))break;
      }
      var innerSel=['.overflow-guard','.monaco-scrollable-element','.margin','.lines-content'];
      for(var s=0;s<innerSel.length;s++){
        var inner=startEl.querySelector(innerSel[s]);
        if(inner)candidates.push(inner);
      }
      for(var c=0;c<candidates.length;c++){
        var w=irFindWidgetOnElement(candidates[c]);
        if(w)return w;
      }
    }
  }catch(_){}
  return null;
}
function irListAllCodeEditors(){
  // Walk every visible .monaco-editor and collect distinct widget
  // instances. Each editor group has its own widget, and we want to
  // patch every prototype we encounter (typically there's only one but
  // we don't assume it).
  var result=[];
  try{
    var seen=typeof WeakSet==='function'?new WeakSet():null;
    var protos=typeof WeakSet==='function'?new WeakSet():null;
    var nodes=document.querySelectorAll('.monaco-editor');
    for(var n=0;n<nodes.length;n++){
      var startEl=nodes[n];
      var candidates=[startEl];
      var el=startEl.parentElement;
      for(var p=0;p<6&&el;p++,el=el.parentElement){
        candidates.push(el);
        if(el.classList&&el.classList.contains('editor-group-container'))break;
      }
      var innerSel=['.overflow-guard','.monaco-scrollable-element','.margin','.lines-content'];
      for(var sIdx=0;sIdx<innerSel.length;sIdx++){
        var inner=startEl.querySelector(innerSel[sIdx]);
        if(inner)candidates.push(inner);
      }
      for(var c=0;c<candidates.length;c++){
        var w=irFindWidgetOnElement(candidates[c]);
        if(!w)continue;
        if(seen&&seen.has(w))continue;
        if(seen)seen.add(w);
        result.push(w);
      }
    }
    // Suppress unused warnings
    void protos;
  }catch(_){}
  return result;
}
function irClonePositionForFreeze(pos){
  // ContentWidget.getPosition() returns
  //   { position: IPosition|null, secondaryPosition: IPosition|null,
  //     range?: IRange|null, preference: ContentWidgetPositionPreference[] }
  // We clone deeply (and shallowly for preference) so freezing the object
  // doesn't share mutable references with VS Code's own state.
  if(!pos||typeof pos!=='object')return null;
  var clone={};
  if(pos.position){clone.position={lineNumber:pos.position.lineNumber,column:pos.position.column};}
  if(pos.secondaryPosition){clone.secondaryPosition={lineNumber:pos.secondaryPosition.lineNumber,column:pos.secondaryPosition.column};}
  if(pos.range){
    clone.range={
      startLineNumber:pos.range.startLineNumber,
      startColumn:pos.range.startColumn,
      endLineNumber:pos.range.endLineNumber,
      endColumn:pos.range.endColumn
    };
  }
  if(Array.isArray(pos.preference)){clone.preference=pos.preference.slice();}
  if(typeof pos.positionAffinity==='number')clone.positionAffinity=pos.positionAffinity;
  return clone;
}
function irWrapHoverWidgetGetPosition(widget){
  if(!widget||widget.__irGetPositionWrapped)return false;
  var origGetPosition=widget.getPosition;
  if(typeof origGetPosition!=='function')return false;
  widget.__irGetPositionOrig=origGetPosition;
  widget.__irGetPositionWrapped=true;
  widget.getPosition=function(){
    try{
      var natural=widget.__irGetPositionOrig.apply(this,arguments);
      if(natural&&natural.position){
        window.__irHoverNaturalPosition=irClonePositionForFreeze(natural);
        // L63: remember the editor that owns this hover. Required for
        // correct getScrolledVisiblePosition in irRepositionInitialHover
        // — the body-MO path otherwise falls back to __irCapturedEditor
        // which may be a stale mini-editor (captured from a code-block
        // inside a previous hover) or wrong column's editor.
        try{if(widget._editor)window.__irHoverNaturalEditor=widget._editor;}catch(_){}
      }
      return natural;
    }catch(_){
      return widget.__irGetPositionOrig.apply(this,arguments);
    }
  };
  irHERecord('hover-widget-wrapped',{id:widget.getId?widget.getId():'<no-id>'});
  // ── OPTION 1: clamp drilled-hover height via _setHoverWidgetDimensions
  //
  // We wrap the widget's _setHoverWidgetDimensions. Drill mode is
  // detected on-the-fly by checking whether the widget's current rendered
  // content contains our [← Back] command link. When drilling, the new
  // hover would render taller than the initial one (more content) and
  // extend downward into space already occupied by other workbench
  // panels — causing the hover-bottom-right hit-test to lose and VS Code
  // to dismiss the hover. By clamping the requested height back to the
  // saved initial height, the drilled hover stays in the original
  // screen footprint and overflow scrolls internally.
  // Patch both the inner-content sizer (_setHoverWidgetDimensions) and
  // the OUTER wrapper sizer (_resizableNode.layout). The inner sizer
  // alone is not enough — the .monaco-resizable-hover wrapper's height
  // is set via _resizableNode.layout(height, width) which sizes the
  // outer wrapper element. If we only clamp inner dims, the outer
  // wrapper stays the larger natural size and the bottom-right still
  // overlaps workbench panels.
  function irIsDrillContent(){
    try{
      var c=widget._hover&&widget._hover.containerDomNode;
      return !!(c&&String(c.textContent||'').indexOf('← Back')>=0);
    }catch(_){return false;}
  }
  // (option 1 & 2 inner-setter wraps removed — VS Code measures inner
  // first then sizes outer via _resizableNode.layout(), so inner clamp
  // alone doesn't shrink the visible wrapper. Option 3 (CSS-only)
  // operates at a different layer: we tag the wrapper with a class when
  // drill content is detected and let max-height in our CSS sheet do
  // the clamp. See drill-class observer below.)
  //
  // Skip the rest of the inner-setter wrap block.
  if(false){
  // ── OPTION 2: clamp each individual dimension setter
  // (_setContainerDomNodeDimensions / _setScrollableElementDimensions /
  // _setContentsDomNodeDimensions). Each sizes a different DOM node:
  //   - container: outer wrapper of the contents
  //   - scrollable: scroll container
  //   - contents:   the actual text/markdown box
  // Option 1 (the parent _setHoverWidgetDimensions which calls all three)
  // disrupted the drill content refresh — the drilled hover stayed on
  // the previous symbol's content. Option 2 tries individual setters so
  // we don't intercept the wrapper-level coordination.
  function irWrapDimSetter(methodName){
    if(typeof widget[methodName]!=='function')return;
    var flag='__irWrapped_'+methodName;
    if(widget[flag])return;
    var orig=widget[methodName];
    widget['__irOrig_'+methodName]=orig;
    widget[flag]=true;
    widget[methodName]=function(w,h){
      var clampedH=h;
      try{
        var isDrill=irIsDrillContent();
        // Trace every setter invocation so we can see what numeric vs
        // 'auto' values flow through during drill vs not.
        irHERecord('dim-setter-call',{
          setter:methodName,
          w:(typeof w==='number'?Math.round(w):String(w).slice(0,20)),
          h:(typeof h==='number'?Math.round(h):String(h).slice(0,20)),
          isDrill:isDrill,
          initial:window.__irInitialHoverHeight||null
        });
        if(isDrill&&typeof window.__irInitialHoverHeight==='number'){
          var maxH=window.__irInitialHoverHeight;
          if(typeof h==='number'&&h>maxH){
            clampedH=maxH;
            irHERecord('drill-dim-clamp',{
              setter:methodName,
              requested:Math.round(h),
              clamped:Math.round(clampedH),
              initial:Math.round(maxH)
            });
          }
        }else if(!isDrill){
          if(typeof h==='number'&&h>20&&methodName==='_setContentsDomNodeDimensions'){
            window.__irInitialHoverHeight=h;
          }
        }
      }catch(_){}
      return widget['__irOrig_'+methodName].call(this,w,clampedH);
    };
    irHERecord('hover-widget-dim-wrapped',{which:methodName});
  }
  irWrapDimSetter('_setContainerDomNodeDimensions');
  irWrapDimSetter('_setScrollableElementDimensions');
  irWrapDimSetter('_setContentsDomNodeDimensions');
  } // end if(false) — Option 2 disabled
  // ── OPTION 3: CSS-only height clamp via a class on the wrapper ──────
  // When the hover content contains our [← Back] link, mark the
  // .monaco-resizable-hover wrapper with class ir-drill-hover. CSS rule
  // (added in the style block) caps max-height to a recorded initial
  // hover height. The wrapper then visually shrinks; inner scroller
  // (which we already configure with overflow:auto) handles overflow.
  if(false && widget._resizableNode&&widget._resizableNode.domNode){
    var wrapperEl=widget._resizableNode.domNode;
    if(!wrapperEl.__irDrillClassObserved){
      wrapperEl.__irDrillClassObserved=true;
      var checkDrillState=function(){
        try{
          var contentEl=widget._hover&&widget._hover.containerDomNode;
          var text=contentEl?String(contentEl.textContent||''):'';
          var isDrill=text.indexOf('← Back')>=0;
          if(isDrill){
            if(!wrapperEl.classList.contains('ir-drill-hover')){
              wrapperEl.classList.add('ir-drill-hover');
              irHERecord('drill-class-on',{
                initialHeight:window.__irInitialHoverHeight||null
              });
            }
            // Also force the inline height/max-height. VS Code's
            // ResizableContentHoverWidget writes height directly to
            // wrapperEl.style.height during layout — without !important
            // it loses to our CSS class, but the timing/specificity
            // interplay is fragile. Setting it ourselves with
            // 'important' priority pins the size unconditionally.
            try{
              var initH=window.__irInitialHoverHeight||180;
              wrapperEl.style.setProperty('height',initH+'px','important');
              wrapperEl.style.setProperty('max-height',initH+'px','important');
              // Inner .monaco-hover too.
              var innerHover=wrapperEl.querySelector('.monaco-hover');
              if(innerHover){
                innerHover.style.setProperty('height',(initH-2)+'px','important');
                innerHover.style.setProperty('max-height',(initH-2)+'px','important');
              }
              irHERecord('drill-inline-clamp',{height:initH});
            }catch(_){}
          }else{
            if(wrapperEl.classList.contains('ir-drill-hover')){
              wrapperEl.classList.remove('ir-drill-hover');
              irHERecord('drill-class-off',{});
              // Release the forced height.
              try{
                wrapperEl.style.removeProperty('height');
                wrapperEl.style.removeProperty('max-height');
                var innerHover2=wrapperEl.querySelector('.monaco-hover');
                if(innerHover2){
                  innerHover2.style.removeProperty('height');
                  innerHover2.style.removeProperty('max-height');
                }
              }catch(_){}
            }
            // Update __irInitialHoverHeight from the current wrapper rect
            // (non-drill = the initial hover for this session)
            try{
              var r=wrapperEl.getBoundingClientRect();
              if(r.height>20)window.__irInitialHoverHeight=r.height;
            }catch(_){}
          }
        }catch(_){}
      };
      // Observe top-level content swap on the .monaco-hover container.
      // Drilling replaces the rendered-markdown subtree on each show, so
      // a shallow childList observation catches the transition without
      // firing on every type-link wrap or sub-pixel mutation we make
      // ourselves (a subtree observer creates a feedback storm and
      // delays the initial hover paint).
      try{
        var contentRoot=widget._hover&&widget._hover.containerDomNode;
        if(contentRoot){
          var contentObs=new MutationObserver(function(){
            // Debounce — coalesce bursts of child swaps that happen in a
            // single show into one drill-state check.
            try{
              if(wrapperEl.__irDrillCheckTimer)clearTimeout(wrapperEl.__irDrillCheckTimer);
            }catch(_){}
            wrapperEl.__irDrillCheckTimer=setTimeout(checkDrillState,50);
          });
          contentObs.observe(contentRoot,{childList:true,characterData:true,subtree:true});
          // Belt-and-suspenders: poll every 1000ms while the wrapper is
          // mounted. Catches content swaps the MutationObserver misses
          // (e.g., VS Code sets innerHTML in one shot which generates
          // only a single childList mutation that may race with our
          // observer registration). Was originally 150ms (major CPU
          // hog: serializes textContent + touches classList + queries
          // + setProperty 6.7×/sec). Then raised to 1000ms which caused
          // the drill class / inline height clamp to be applied up to
          // 1s LATE — visible as the hover "jumping" position when
          // drilling (user-reported). 250ms is the compromise: still
          // 4× cheaper than original yet within one render frame from
          // VS Code's perspective so the drill-mode CSS lands before
          // the user perceives the unclamped layout. The MutationObserver
          // above also calls checkDrillState within 50ms of mutation,
          // so this poll is the safety net for swaps the MO misses.
          wrapperEl.__irDrillPollTimer=setInterval(function(){
            try{
              if(!wrapperEl.isConnected){
                try{clearInterval(wrapperEl.__irDrillPollTimer);}catch(_){}
                wrapperEl.__irDrillPollTimer=null;
                try{if(wrapperEl.__irDrillContentObs)wrapperEl.__irDrillContentObs.disconnect();}catch(_){}
                wrapperEl.__irDrillContentObs=null;
                return;
              }
            }catch(_){}
            checkDrillState();
          },250);
          wrapperEl.__irDrillContentObs=contentObs;
        }
      }catch(_){}
      // Initial state — don't run synchronously here; let the show
      // pipeline finish first.
      setTimeout(checkDrillState,80);
    }
  }
  // Dynamic clamp (temporarily disabled — the MutationObserver here
  // collides with another test's drill flow timing, breaking the
  // hover-box-corner geometry check around the +1000ms mark. With it
  // off the static 162px fallback from the :has() clamp still applies.
  // Re-enable once we have a less invasive height capture path, e.g.
  // a ResizeObserver gated on a "first paint" event.)
  if(false && widget._resizableNode&&widget._resizableNode.domNode
    &&widget._hover&&widget._hover.containerDomNode){
    var wrapVarEl=widget._resizableNode.domNode;
    var contentVarEl=widget._hover.containerDomNode;
    if(!wrapVarEl.__irDrillMaxHObserved){
      wrapVarEl.__irDrillMaxHObserved=true;
      var captureInitialHeight=function(){
        try{
          var text=String(contentVarEl.textContent||'');
          if(text.indexOf('← Back')>=0)return;
          var r=wrapVarEl.getBoundingClientRect();
          if(r.height<20)return;
          var newH=Math.round(r.height);
          var prev=wrapVarEl.style.getPropertyValue('--ir-drill-max-h');
          if(prev===newH+'px')return;
          wrapVarEl.style.setProperty('--ir-drill-max-h',newH+'px');
          irHERecord('init-height-captured',{height:newH,prev:prev||null});
        }catch(_){}
      };
      try{
        var initDebounce=null;
        var initObs=new MutationObserver(function(){
          if(initDebounce)clearTimeout(initDebounce);
          initDebounce=setTimeout(captureInitialHeight,80);
        });
        initObs.observe(contentVarEl,{childList:true,subtree:false});
        wrapVarEl.__irDrillMaxHObserver=initObs;
      }catch(_){}
      setTimeout(captureInitialHeight,120);
    }
  }
  return true;
}
function irPatchEditorPrototype(editorInstance){
  if(!editorInstance)return false;
  var proto=Object.getPrototypeOf(editorInstance);
  if(!proto||proto.__irAddContentWidgetPatched)return false;
  if(typeof proto.addContentWidget!=='function')return false;
  var origAddContentWidget=proto.addContentWidget;
  proto.addContentWidget=function(widget){
    var ret=origAddContentWidget.apply(this,arguments);
    try{
      if(widget&&typeof widget.getId==='function'){
        var id=String(widget.getId()||'');
        if(id==='editor.contrib.resizableContentHoverWidget'){
          irWrapHoverWidgetGetPosition(widget);
          try{irAttachWrapperResizeReposition(widget);}catch(_){}
          try{window.__irCapturedHoverWidget=widget;}catch(_){}
          irHERecord('hover-widget-captured',{
            via:'addContentWidget',
            hoverRect:(widget&&widget._resizableNode&&widget._resizableNode.domNode)?irRectTriplet(widget._resizableNode.domNode):null,
            pointer:irPointerTriplet(),
            viewport:irViewportInfo()
          });
        }
      }
    }catch(_){}
    return ret;
  };
  // Walk existing widgets in case this editor already had the hover added.
  try{
    var cw=editorInstance._contentWidgets;
    if(cw&&typeof cw==='object'){
      var keys=Object.keys(cw);
      for(var i=0;i<keys.length;i++){
        if(keys[i]==='editor.contrib.resizableContentHoverWidget'){
          var entry=cw[keys[i]];
          if(entry&&entry.widget){
            irWrapHoverWidgetGetPosition(entry.widget);
            try{irAttachWrapperResizeReposition(entry.widget);}catch(_){}
            try{window.__irCapturedHoverWidget=entry.widget;}catch(_){}
            irHERecord('hover-widget-captured',{
              via:'cw-walk',
              hoverRect:(entry.widget._resizableNode&&entry.widget._resizableNode.domNode)?irRectTriplet(entry.widget._resizableNode.domNode):null,
              pointer:irPointerTriplet(),
              viewport:irViewportInfo()
            });
          }
        }
      }
    }
  }catch(_){}
  proto.__irAddContentWidgetPatched=true;
  irHERecord('editor-proto-patched',{});
  return true;
}
function irScanAndPatchEditors(){
  try{
    var editors=irListAllCodeEditors();
    if(!editors||!editors.length){
      var api=irGetMonacoEditorApi();
      if(api){
        var apiEditors=api.getEditors();
        if(apiEditors&&apiEditors.length)editors=apiEditors;
      }
    }
    if((!editors||!editors.length)&&window.__irCapturedEditorList&&window.__irCapturedEditorList.length){
      editors=window.__irCapturedEditorList.slice();
    }
    if(!editors||!editors.length)return false;
    var patchedAny=false;
    for(var i=0;i<editors.length;i++){
      if(irPatchEditorPrototype(editors[i]))patchedAny=true;
    }
    return patchedAny;
  }catch(_){return false}
}
// Try to patch immediately, then retry until at least one editor exists.
// Exponential backoff: 200→400→800→1600→3200ms, capped at 5000ms; give up
// after ~30s total. Previously this polled every 200ms for up to 40s
// straight, which was a noticeable CPU drag on workspaces that never spawn
// an editor (e.g., welcome view foregrounded).
if(!window.__irPatchEditorRetryTimer){
  var triedCount=0;
  var nextDelay=200;
  var startedAt=Date.now();
  function scheduleNextPatchAttempt(){
    if(window.__irPatchEditorRetryTimer){
      try{clearTimeout(window.__irPatchEditorRetryTimer);}catch(_){}
    }
    window.__irPatchEditorRetryTimer=setTimeout(tryPatch,nextDelay);
    nextDelay=Math.min(5000,Math.floor(nextDelay*2));
  }
  function tryPatch(){
    triedCount++;
    var elapsed=Date.now()-startedAt;
    if(irScanAndPatchEditors()||elapsed>=30000||triedCount>=20){
      try{if(window.__irPatchEditorRetryTimer)clearTimeout(window.__irPatchEditorRetryTimer);}catch(_){}
      window.__irPatchEditorRetryTimer=null;
      return;
    }
    scheduleNextPatchAttempt();
  }
  tryPatch();
}
window.__irGetPatchStatus=function(){
  try{
    var api=irGetMonacoEditorApi();
    var editors=irListAllCodeEditors();
    if((!editors||!editors.length)&&api&&typeof api.getEditors==='function'){
      editors=api.getEditors();
    }
    // Diagnostic dump: when no editors were found, sample properties from
    // the first .monaco-editor element so we can see where VS Code keeps
    // its editor instance reference. Also examines a .monaco-resizable-hover
    // wrapper if present.
    var domDiag=null;
    if(!editors||!editors.length){
      try{
        var el=document.querySelector('.monaco-editor');
        var wrapper=document.querySelector('.monaco-resizable-hover');
        domDiag={editorProbe:null,wrapperProbe:null};
        function probe(node){
          if(!node)return null;
          var out={tag:node.tagName,cls:String(node.className||'').slice(0,160),ownProps:[],symbols:[],protoMethods:[]};
          var own;try{own=Object.getOwnPropertyNames(node);}catch(_){own=[];}
          for(var p=0;p<own.length&&out.ownProps.length<50;p++){
            var key=own[p];var val=node[key];
            out.ownProps.push({key:key,type:typeof val,isObj:val&&typeof val==='object'});
          }
          try{
            var syms=Object.getOwnPropertySymbols(node);
            for(var s=0;s<syms.length&&out.symbols.length<20;s++)out.symbols.push(String(syms[s]));
          }catch(_){}
          try{
            var proto=Object.getPrototypeOf(node);
            var pm=proto?Object.getOwnPropertyNames(proto):[];
            for(var m=0;m<pm.length&&out.protoMethods.length<20;m++){
              if(pm[m].startsWith('_')||pm[m]==='constructor')continue;
              if(typeof node[pm[m]]==='function')out.protoMethods.push(pm[m]);
            }
          }catch(_){}
          return out;
        }
        domDiag.editorProbe=probe(el);
        domDiag.wrapperProbe=probe(wrapper);
        // Also try the AMD require path
        try{
          if(typeof require==='function'){
            var rl=[];
            try{var s1=require('vs/editor/browser/services/codeEditorService');if(s1)rl.push({path:'vs/editor/browser/services/codeEditorService',keys:Object.keys(s1).slice(0,10)});}catch(e){rl.push({path:'codeEditorService',err:String(e).slice(0,80)});}
            try{var s2=require('vs/editor/editor.api');if(s2)rl.push({path:'vs/editor/editor.api',keys:Object.keys(s2).slice(0,10)});}catch(e){rl.push({path:'editor.api',err:String(e).slice(0,80)});}
            domDiag.requireProbes=rl;
          }
        }catch(_){}
      }catch(_){}
    }
    var protoSeen=0,protoPatched=0,widgetsWrapped=0,hoverPresent=0;
    var sample=null;
    for(var i=0;i<editors.length;i++){
      var ed=editors[i];
      var proto=Object.getPrototypeOf(ed);
      if(proto){
        protoSeen++;
        if(proto.__irAddContentWidgetPatched)protoPatched++;
      }
      try{
        var cw=ed._contentWidgets;
        if(cw){
          var ks=Object.keys(cw);
          for(var k=0;k<ks.length;k++){
            if(ks[k]==='editor.contrib.resizableContentHoverWidget'){
              hoverPresent++;
              var entry=cw[ks[k]];
              if(entry&&entry.widget){
                if(entry.widget.__irGetPositionWrapped)widgetsWrapped++;
                if(!sample){
                  try{
                    var pos=entry.widget.getPosition&&entry.widget.getPosition();
                    sample={pos:pos?JSON.parse(JSON.stringify(pos)):null,wrapped:!!entry.widget.__irGetPositionWrapped};
                  }catch(_){}
                }
              }
            }
          }
        }
      }catch(_){}
    }
    var capturedHover=window.__irCapturedHoverWidget;
    var capturedHoverInfo=null;
    if(capturedHover){
      var wrapperEl=capturedHover._resizableNode&&capturedHover._resizableNode.domNode;
      capturedHoverInfo={
        wrapped:!!capturedHover.__irGetPositionWrapped,
        hasHoverField:!!(capturedHover._hover),
        hasContainerDomNode:!!(capturedHover._hover&&capturedHover._hover.containerDomNode),
        hasResizableNode:!!(capturedHover._resizableNode),
        hasWrapperDom:!!wrapperEl,
        wrapperHasDrillClass:!!(wrapperEl&&wrapperEl.classList&&wrapperEl.classList.contains('ir-drill-hover')),
        wrapperClass:wrapperEl?String(wrapperEl.className||''):null,
        irDrillMaxHVar:wrapperEl?wrapperEl.style.getPropertyValue('--ir-drill-max-h'):null,
        irDrillMaxHComputed:(function(){try{return wrapperEl?window.getComputedStyle(wrapperEl).getPropertyValue('--ir-drill-max-h'):null;}catch(_){return null;}})(),
        wrapperBbox:(function(){try{var r=wrapperEl&&wrapperEl.getBoundingClientRect();return r?{l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}:null;}catch(_){return null;}})(),
        drillClassObserved:!!(wrapperEl&&wrapperEl.__irDrillClassObserved),
        currentContent:(function(){
          try{return String(capturedHover._hover&&capturedHover._hover.containerDomNode&&capturedHover._hover.containerDomNode.textContent||'').slice(0,120);}catch(_){return '';}
        })()
      };
    }
    return {
      ok:true,
      monacoAvailable:!!api,
      editors:editors.length,
      capturedEditors:(window.__irCapturedEditorList||[]).length,
      protoSeen:protoSeen,
      protoPatched:protoPatched,
      hoverWidgetsPresent:hoverPresent,
      hoverWidgetsWrapped:widgetsWrapped,
      capturedHoverInfo:capturedHoverInfo,
      drillModeActive:!!window.__irDrillModeActive,
      drillFrozenPosition:window.__irDrillFrozenPosition,
      hoverNaturalPosition:window.__irHoverNaturalPosition,
      initialHoverHeight:window.__irInitialHoverHeight||null,
      sample:sample,
      domDiag:domDiag,
      patchVersion:Number(window.__irPatchVersion)||0
    };
  }catch(err){return {ok:false,reason:String(err)}}
};
window.__irForceRepatchEditors=function(){
  // Force re-scan: callable from extension to ensure widgets created
  // before our patch get wrapped too.
  try{
    var api=irGetMonacoEditorApi();
    if(!api)return {ok:false,reason:'no-monaco'};
    var editors=api.getEditors();
    var wrapped=0;
    for(var i=0;i<editors.length;i++){
      var ed=editors[i];
      irPatchEditorPrototype(ed);
      try{
        var cw=ed._contentWidgets;
        if(cw){
          var keys=Object.keys(cw);
          for(var k=0;k<keys.length;k++){
            if(keys[k]==='editor.contrib.resizableContentHoverWidget'){
              var entry=cw[keys[k]];
              if(entry&&entry.widget&&irWrapHoverWidgetGetPosition(entry.widget))wrapped++;
            }
          }
        }
      }catch(_){}
    }
    return {ok:true,editors:editors.length,wrapped:wrapped};
  }catch(err){return {ok:false,reason:String(err)}}
};

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
function irBoxCornersFor(el){
  if(!el||!el.getBoundingClientRect)return null;
  try{
    var r=el.getBoundingClientRect();
    var cs=window.getComputedStyle(el);
    var n=function(v){var x=parseFloat(v);return Number.isFinite(x)?x:0};
    var border={left:n(cs.borderLeftWidth),right:n(cs.borderRightWidth),top:n(cs.borderTopWidth),bottom:n(cs.borderBottomWidth)};
    var padding={left:n(cs.paddingLeft),right:n(cs.paddingRight),top:n(cs.paddingTop),bottom:n(cs.paddingBottom)};
    return {
      left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
      corners:{
        leftTop:{x:r.left,y:r.top},
        rightTop:{x:r.right,y:r.top},
        leftBottom:{x:r.left,y:r.bottom},
        rightBottom:{x:r.right,y:r.bottom}
      },
      border:border,
      padding:padding,
      boxSizing:String(cs.boxSizing||''),
      tagName:String(el.tagName||''),
      className:String(el.className||'')
    };
  }catch(_){return null}
}
function irHoverBoxCornerSnapshot(hoverEl){
  if(!hoverEl||!hoverEl.getBoundingClientRect)return null;
  var outer=irBoxCornersFor(hoverEl);
  // Pick the inner text-bearing box. Prefer .monaco-scrollable-element because
  // it is the actual scroll viewport — its bbox always sits inside outer
  // (because outer has overflow:hidden + scroller height matches outer height).
  // Fall back to the largest .rendered-markdown when no scroller is present.
  var inner=null;
  var innerEl=null;
  try{
    var sc=hoverEl.querySelector?hoverEl.querySelector('.monaco-scrollable-element'):null;
    if(sc&&sc.getBoundingClientRect){
      inner=irBoxCornersFor(sc);
      innerEl=sc;
    }
    if(!inner){
      var blocks=hoverEl.querySelectorAll?hoverEl.querySelectorAll('.rendered-markdown'):[];
      var bestBlock=null;
      var bestArea=0;
      for(var bi=0;bi<blocks.length;bi++){
        var b=blocks[bi];
        if(!b||!b.getBoundingClientRect)continue;
        var br=b.getBoundingClientRect();
        var area=Math.max(0,br.width)*Math.max(0,br.height);
        if(area>bestArea){bestBlock=b;bestArea=area}
      }
      if(bestBlock){inner=irBoxCornersFor(bestBlock);innerEl=bestBlock}
    }
  }catch(_){}
  // Verify the inner is actually a DOM descendant of the outer. If not, the
  // hover lifecycle is fragmented and outer.bbox cannot constrain inner.bbox.
  var sameTree=false;
  var ancestorDepth=-1;
  var parentChain=[];
  try{
    if(innerEl&&hoverEl.contains){
      sameTree=!!hoverEl.contains(innerEl);
      if(sameTree){
        var node=innerEl,depth=0;
        while(node&&node!==hoverEl&&depth<32){
          var pcs=window.getComputedStyle?window.getComputedStyle(node):null;
          var pr=node.getBoundingClientRect?node.getBoundingClientRect():null;
          parentChain.push({
            depth:depth,
            tagName:String(node.tagName||''),
            className:String(node.className||'').slice(0,180),
            width:pr?Math.round(pr.width):null,
            height:pr?Math.round(pr.height):null,
            left:pr?Math.round(pr.left):null,
            top:pr?Math.round(pr.top):null,
            overflow:pcs?(pcs.overflow||''):'',
            position:pcs?(pcs.position||''):''
          });
          node=node.parentNode;
          depth++;
        }
        if(node===hoverEl)ancestorDepth=depth;
      }
    }
  }catch(_){}
  if(!outer||!inner)return {outer:outer,inner:inner,fits:null,delta:null,sameTree:sameTree,ancestorDepth:ancestorDepth,parentChain:parentChain};
  // The inner text box must sit strictly inside the outer hover root, with
  // the gap on each side equal to outer's border+padding (give-or-take a
  // sub-pixel for rounding). Negative delta = inner protrudes outside outer.
  var delta={
    left:inner.left-(outer.left+outer.border.left+outer.padding.left),
    top:inner.top-(outer.top+outer.border.top+outer.padding.top),
    right:(outer.right-outer.border.right-outer.padding.right)-inner.right,
    bottom:(outer.bottom-outer.border.bottom-outer.padding.bottom)-inner.bottom
  };
  var tolerance=1.5;
  var fits={
    left:delta.left>=-tolerance,
    top:delta.top>=-tolerance,
    right:delta.right>=-tolerance,
    bottom:delta.bottom>=-tolerance,
    all:false
  };
  fits.all=fits.left&&fits.top&&fits.right&&fits.bottom;
  return {outer:outer,inner:inner,delta:delta,fits:fits,tolerance:tolerance,sameTree:sameTree,ancestorDepth:ancestorDepth,parentChain:parentChain};
}
function irLogHoverBoxCorners(hoverEl,reason){
  if(!hoverEl)return null;
  // L28: cap-first guard. The snapshot does heavy work
  // (getBoundingClientRect + getComputedStyle + parent chain walk) and
  // was running on every caller even after the log cap was reached —
  // a hot path for the 57K-char hover case where measurement happens
  // multiple times per drill paint. Skip when we wouldn't log anyway.
  if(!window.__irBoxCornerLogCount)window.__irBoxCornerLogCount=0;
  if(window.__irBoxCornerLogCount>=60)return null;
  var snap=irHoverBoxCornerSnapshot(hoverEl);
  if(!snap||!snap.outer||!snap.inner)return snap;
  if(window.__irBoxCornerLogCount<60){
    window.__irBoxCornerLogCount++;
    var o=snap.outer,i=snap.inner,d=snap.delta,f=snap.fits;
    var brief=function(c){return Math.round(c.x)+','+Math.round(c.y)};
    irLog('renderer: hover-box-corners reason='+(reason||'')
      +' outer={lt='+brief(o.corners.leftTop)+' rt='+brief(o.corners.rightTop)
      +' lb='+brief(o.corners.leftBottom)+' rb='+brief(o.corners.rightBottom)
      +' size='+Math.round(o.width)+'x'+Math.round(o.height)
      +' border='+o.border.left+'/'+o.border.top+'/'+o.border.right+'/'+o.border.bottom
      +' padding='+o.padding.left+'/'+o.padding.top+'/'+o.padding.right+'/'+o.padding.bottom+'}'
      +' inner={lt='+brief(i.corners.leftTop)+' rt='+brief(i.corners.rightTop)
      +' lb='+brief(i.corners.leftBottom)+' rb='+brief(i.corners.rightBottom)
      +' size='+Math.round(i.width)+'x'+Math.round(i.height)+'}'
      +' delta={l='+d.left.toFixed(1)+' t='+d.top.toFixed(1)+' r='+d.right.toFixed(1)+' b='+d.bottom.toFixed(1)+'}'
      +' fits='+(f.all?'1':'0'));
  }
  return snap;
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
  var ex=e&&typeof e.clientX==='number'?e.clientX|0:0;
  var ey=e&&typeof e.clientY==='number'?e.clientY|0:0;
  var nowTs=Date.now();
  var cache=window.__irNearLinkCache;
  if(cache&&cache.hover===hover&&Math.abs(cache.x-ex)<=5&&Math.abs(cache.y-ey)<=5&&(nowTs-cache.ts)<16){
    if(cache.link){
      try{irSetPointActiveLink(cache.link);}catch(_){}
      try{irMarkHoverManaged(hover,true);}catch(_){}
    }
    return cache.link;
  }
  var near=irFindNearbyTypeLink(e,hover,26,10);
  var link=(near&&near.link)?near.link:null;
  window.__irNearLinkCache={x:ex,y:ey,hover:hover,link:link,ts:nowTs};
  if(!link)return null;
  irSetPointActiveLink(link);
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
  try{if(link)irRememberTypeLinkGeometry(link,'run-'+(source||'action'),true)}catch(_){}
  var hover=link?irClosestHover(link):null;
  irMarkHoverManaged(hover,true);
  if(hover){
    irRememberPreviewTransitionRect(hover,'link-'+(source||'action'));
    hover.__irPreviewAppliedAt=Date.now();
  }
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
    var releasedAge=0;
    try{releasedAge=hoverEl.__irReleasedAt?Date.now()-hoverEl.__irReleasedAt:0}catch(_){}
    return 'rect='+irRectBrief(hoverEl)
      +' textLen='+String((hoverEl.textContent||'').length)
      +' links='+(hoverEl.querySelectorAll?hoverEl.querySelectorAll('.ir-type-link').length:0)
      +' connected='+(document.body&&document.body.contains(hoverEl))
      +' active='+(window.__irActiveHoverEl===hoverEl)
      +' renderable='+(visibility&&visibility.visible)
      +' visibilityReason='+(visibility&&visibility.reason||'')
      +' releasedAge='+releasedAge
      +' releasedTextLen='+String((hoverEl.__irReleasedText||'').length)
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
  // L94 (2026-05-31): native mode — a pointerdown on VS Code's native resize sash must NOT be
  // treated as an outside-click. The no-link branch below calls irDisposeActiveHoverForEditorTarget,
  // so grabbing the resize handle instantly dismissed the hover. Bow out so native resize runs.
  if(IR_HOVER_NATIVE_ONLY){try{var __sashT=e&&e.target;if(__sashT&&__sashT.closest&&__sashT.closest('.monaco-sash,[class*="sash"]'))return;}catch(_){}}
  var directLink=irClosestTypeLink(e.target);
  var wrappedLink=null;
  if(!directLink)wrappedLink=irWrapWordAtPoint(e);
  var recoveredLink=null;
  var link=directLink||wrappedLink;
  if(!link)recoveredLink=irFindRecentTypeLinkAtPoint(e,'pointerdown-capture');
  if(!link&&recoveredLink)link=recoveredLink.link;
  irLogPointerActionTrace(e,'pointerdown-capture',link,directLink?'direct':(wrappedLink?'wrapped':(recoveredLink?'recovered-'+recoveredLink.source:'none')));
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
  if(recoveredLink&&recoveredLink.target)window.__irLastPreviewTarget=recoveredLink.target;
  irScheduleTypeLinkPointerDownFallback(link,e);
  e.preventDefault();
  e.stopImmediatePropagation();
}
track(window,'pointerdown',irTypeLinkPointerDown,true);
track(window,'mousedown',irTypeLinkPointerDown,true);
track(document,'pointerdown',irTypeLinkPointerDown,true);
track(document,'mousedown',irTypeLinkPointerDown,true);

function irTypeLinkHoverIntent(e){
  try{
    var directLink=irClosestTypeLink(e&&e.target);
    var wrappedLink=null;
    if(!directLink)wrappedLink=irWrapWordAtPoint(e);
    var link=directLink||wrappedLink;
    if(!link)return;
    irSetPointActiveLink(link);
    irMarkHoverManaged(irClosestHover(link),true);
  }catch(_){}
}
// L42: window listeners alone suffice (capture phase fires window
// before document). Was registered on both — doubled the per-move
// handler call count for no functional gain.
track(window,'pointerover',irTypeLinkHoverIntent,true);
track(window,'mouseover',irTypeLinkHoverIntent,true);
track(window,'pointermove',irTypeLinkHoverIntent,true);
track(window,'mousemove',irTypeLinkHoverIntent,true);

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
  if(IR_HOVER_NATIVE_ONLY)return;   // L89: native hover uses VS Code's own sticky behaviour
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
  // L110 (2026-06-01): VS Code owns the hover lifecycle/position (user directive:
  // "hover의 위치가 vscode가 지정해 주기 때문에 더이상 우리가 관여할 필요가 없어"). Our
  // mouse-relocation re-show requests (outside-editor-new-token / token-relocation,
  // ~4995/5112/5168) re-drove VS Code to re-deliver the SAME drill preview, and the
  // extension APPENDED another copy each time → duplicate accumulation (v=275 log:
  // 58975→117950→176925 within ~1.5s as the mouse moved over the Company hover) →
  // VS Code tokenizes 3-7× the content = the multi-second freeze. Stop requesting
  // shows; VS Code shows hovers natively on its own. (Pairs with the already-gated
  // release side, irReleaseNativeHoverManagement L97.)
  if(IR_HOVER_NATIVE_ONLY)return;
  try{
    var now=Date.now();
    try{
      var pointer=window.__irLastPointer||null;
      var pointerFresh=!!(pointer&&pointer.at&&now-pointer.at<5000&&typeof pointer.x==='number'&&typeof pointer.y==='number');
      var x=pointerFresh?Number(pointer.x):0;
      var y=pointerFresh?Number(pointer.y):0;
      var target=pointerFresh&&typeof document.elementFromPoint==='function'?document.elementFromPoint(x,y):null;
      var token='';
      try{if(pointerFresh&&typeof irEventTargetTokenText==='function')token=irEventTargetTokenText({target:target,clientX:x,clientY:y,type:'native-show-hover-request'})||'';}catch(_){}
      var editorSurface=false;
      try{if(pointerFresh&&typeof irEventTargetsEditorSurface==='function')editorSurface=!!irEventTargetsEditorSurface({target:target,clientX:x,clientY:y,type:'native-show-hover-request'});}catch(_){}
      window.__irNativeShowHoverRequest={
        reason:String(reason||'release'),
        at:now,
        pointer:pointerFresh?{x:x,y:y,at:pointer.at,type:String(pointer.type||'')}:null,
        token:token,
        editorSurface:editorSurface
      };
    }catch(_){}
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
  if(IR_HOVER_NATIVE_ONLY)return;   // L96 (2026-05-31) DEPRECATED: VS Code owns dismiss/release (active-switch). Kept for legacy managed mode.
  try{
    if(!hoverEl)return;
    // L13 revised: VS Codes hover lifecycle can call this 3–6 times in the
    // same ms (prune + active-switch + outside-editor-new-token, etc).
    // Original L13 returned early to skip the whole body, but that risked
    // a UX issue: if the first call had hideVisual=false and a subsequent
    // call wanted hideVisual=true, the hover would remain visible until
    // the next cycle — the user would perceive a "delayed hide" / sudden
    // jump. Per the dedup-before-paint principle, we now ALWAYS mutate
    // state (state mutations are idempotent or use "hide-wins" semantics
    // for hideVisual) and only coalesce the LOG line, which is the only
    // truly redundant work.
    var prevReleasedAt=Number(hoverEl.__irReleasedAt)||0;
    var nowMs=Date.now();
    var alreadyMarkedThisFrame=prevReleasedAt && (nowMs-prevReleasedAt)<16;
    var releasedText=String(hoverEl.textContent||'');
    hoverEl.__irReleasedAt=nowMs;
    hoverEl.__irReleasedText=releasedText;
    // hide-wins: any call asking to hide upgrades the request; never downgrade.
    if(hideVisual || !hoverEl.__irReleaseHideVisualRequested){
      hoverEl.__irReleaseHideVisualRequested=!!hideVisual;
    }
    hoverEl.__irPrimaryPreviewTarget=null;
    hoverEl.__irPreviewAppliedAt=0;
    hoverEl.__irStickyUntil=0;
    hoverEl.__irLastInsideAt=0;
    try{if(hoverEl.__irReleaseRemoveTimer)irClearTimer(hoverEl.__irReleaseRemoveTimer)}catch(_){}
    hoverEl.__irReleaseRemoveTimer=null;
    if(hoverEl.classList)hoverEl.classList.add('ir-native-released-hover');
    if(hoverEl.setAttribute)hoverEl.setAttribute('data-ir-native-released-hover','1');
    if(!alreadyMarkedThisFrame && window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: native hover released retained '+(reason||'')+' hideVisual='+(hideVisual?'1':'0')+' textLen='+releasedText.length);
    }
  }catch(_){}
}
function irReleaseNativeHoverManagement(hoverEl,reason){
  if(IR_HOVER_NATIVE_ONLY)return false;   // L97 (2026-05-31) DEPRECATED: VS Code owns dismiss. Our release (outside-editor-new-token etc.) drove the release<->revive flicker churn. Kept for legacy managed mode.
  if(!hoverEl||!hoverEl.classList)return false;
  var beforeBrief=irHoverBrief(hoverEl);
  var releaseReason=String(reason||'release');
  try{
    if(typeof irHERecord==='function'){
      var stack='';
      try{stack=String((new Error('release-trace')).stack||'').split('\\n').slice(0,8).join(' | ');}catch(_){}
      irHERecord('release',{reason:releaseReason,hoverCls:String(hoverEl.className||'').slice(0,160),stack:stack});
    }
  }catch(_){}
  var requestNativeHide=/outside-editor|editor-target-active-hover|native-popup/.test(releaseReason);
  var hideReleased=releaseReason.indexOf('outside-editor')>=0;
  var removeReleased=false;
  var removedForRelocation=false;
  var hostHideRequested=false;
  try{if(hoverEl.__irStickyTimer)irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  try{if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(hoverEl)}catch(_){}
  try{irClearManagedHoverVisibilityKeepalive(hoverEl)}catch(_){}
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
    irMarkNativeHoverReleased(hoverEl,releaseReason,hideReleased);
    if(requestNativeHide)irRequestNativeHideHover(releaseReason);
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
  if(removeReleased){
    try{
      if(hoverEl.getAttribute&&hoverEl.getAttribute('data-ir-forced-hover')==='1'&&hoverEl.parentNode){
        hoverEl.parentNode.removeChild(hoverEl);
        removedForRelocation=true;
      }else if(hoverEl.parentNode){
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
  if(IR_HOVER_NATIVE_ONLY)return;   // L89: no keepalive/sticky in native-hover mode
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
    if(!hoverEl||!token||token.length<=1)return false;
    // L108 (2026-06-01): memoize the textContent scan. irHoverGuard binds this to
    // 8 mouse events incl. BOTH pointermove AND mousemove (renderer-patch ~5215),
    // so a single physical mouse move over the editor runs this 2x, and buffered-
    // move bursts hit it dozens of times/sec. A fresh String(hoverEl.textContent)
    // materialization + indexOf on a 57K-char class drill hover, per event, pinned
    // the main thread while moving the mouse over code (user-reported frame drops).
    // The content only changes on a real swap; our own .ir-type-link wrapping mutates
    // inner descendants but NOT the hover root's direct children, so a structural
    // signature (childElementCount + first/last child tag) stays stable across
    // wrapping and flips only when VS Code swaps content. Cache the string once per
    // signature and the per-token hit/miss in a null-proto map.
    var sig=(hoverEl.childElementCount||0)+':'+
      (hoverEl.firstElementChild?hoverEl.firstElementChild.nodeName:'_')+':'+
      (hoverEl.lastElementChild?hoverEl.lastElementChild.nodeName:'_');
    if(hoverEl.__irContainsSig!==sig){
      hoverEl.__irContainsSig=sig;
      hoverEl.__irContainsText=String(hoverEl.textContent||'');
      hoverEl.__irContainsTokenCache=Object.create(null);
    }
    var cache=hoverEl.__irContainsTokenCache||(hoverEl.__irContainsTokenCache=Object.create(null));
    var cached=cache[token];
    if(cached!==undefined)return cached;
    var hit=hoverEl.__irContainsText.indexOf(token)>=0;
    cache[token]=hit;
    return hit;
  }catch(_){return false}
}
function irHoverRecentlyPreviewApplied(hoverEl){
  try{
    return !!(hoverEl&&hoverEl.__irPreviewAppliedAt&&Date.now()-hoverEl.__irPreviewAppliedAt<2400);
  }catch(_){return false}
}
function irRememberPreviewTransitionRect(root,reason){
  try{
    if(!root||!root.getBoundingClientRect)return false;
    var r=root.getBoundingClientRect();
    if(!r||r.width<2||r.height<2)return false;
    var now=Date.now();
    var rect={
      left:Math.round(r.left),
      top:Math.round(r.top),
      right:Math.round(r.right),
      bottom:Math.round(r.bottom),
      width:Math.round(r.width),
      height:Math.round(r.height),
      at:now,
      until:now+4200,
      reason:String(reason||'')
    };
    root.__irPreviewTransitionRect=rect;
    root.__irPreviewTransitionUntil=rect.until;
    window.__irPreviewTransitionRect=rect;
    return true;
  }catch(_){return false}
}
function irCurrentPreviewTransitionRect(root){
  try{
    var now=Date.now();
    var local=root&&root.__irPreviewTransitionRect;
    if(local&&(local.until||((local.at||0)+4200))>now)return local;
    var global=window.__irPreviewTransitionRect;
    if(global&&(global.until||((global.at||0)+4200))>now)return global;
  }catch(_){}
  return null;
}
function irPointInsideRect(e,rect,pad){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number'||!rect)return false;
    pad=pad||0;
    return e.clientX>=rect.left-pad
      && e.clientX<=rect.right+pad
      && e.clientY>=rect.top-pad
      && e.clientY<=rect.bottom+pad;
  }catch(_){return false}
}
function irPointInPreviewTransitionRect(root,e,pad){
  var rect=irCurrentPreviewTransitionRect(root);
  return !!(rect&&irPointInsideRect(e,rect,pad||12));
}
function irShouldHoldPreviewTransition(root,e){
  try{
    if(!root||!e||!irHoverHasManagedContent(root))return false;
    if(irClosestNativePopup(e&&e.target))return false;
    return irPointInPreviewTransitionRect(root,e,16);
  }catch(_){return false}
}
function irRememberPointerEvent(e){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return;
    // L43: skip near-stationary mouse events. When the user pauses on
    // a hover, the OS still emits pointermove/mousemove at 100Hz+ and
    // each call did getBoundingClientRect (irPointInPreviewTransitionRect)
    // + a fresh __irLastPointer object allocation. ±2px / 16ms is well
    // below the perception threshold for pointer movement so behaviour
    // (drill positioning, etc.) is unaffected.
    var lastP=window.__irLastPointer;
    if(lastP && Math.abs(lastP.x-e.clientX)<=2 && Math.abs(lastP.y-e.clientY)<=2 && (Date.now()-lastP.at)<16){
      return;
    }
    var active=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
      ? window.__irActiveHoverEl
      : null;
    if(active&&!irClosestHover(e.target)&&irPointInPreviewTransitionRect(active,e,16)){
      var transitionToken='';
      try{transitionToken=irEventTargetTokenText(e)||''}catch(_){}
      if(!transitionToken)return;
    }
    var sx=(typeof window.scrollX==='number'?window.scrollX:(window.pageXOffset||0));
    var sy=(typeof window.scrollY==='number'?window.scrollY:(window.pageYOffset||0));
    var wsx=(typeof window.screenX==='number'?window.screenX:0);
    var wsy=(typeof window.screenY==='number'?window.screenY:0);
    window.__irLastPointer={
      x:e.clientX,y:e.clientY,
      pageX:(typeof e.pageX==='number'?e.pageX:e.clientX+sx),
      pageY:(typeof e.pageY==='number'?e.pageY:e.clientY+sy),
      screenX:(typeof e.screenX==='number'?e.screenX:e.clientX+wsx),
      screenY:(typeof e.screenY==='number'?e.screenY:e.clientY+wsy),
      at:Date.now(),type:String(e.type||'')
    };
    // L65: pre-cache the hover natural editor + symbol position on
    // token-cross events (mouseover/pointerover fire on element boundary
    // crossings, not on every pointermove). Bridges the race window
    // where the resizable hover widget gets painted before
    // irWrapHoverWidgetGetPosition has fired and __irHoverNaturalEditor
    // / Position are still null — irRepositionInitialHover would
    // otherwise fall back to the L64 DOM lookup, which itself fails
    // when the wrapper is covering the cursor (elementFromPoint returns
    // the wrapper). Pre-caching the editor/position at the last
    // pre-hover mouseover sidesteps both holes.
    irPrecacheHoverNaturalContext(e);
  }catch(_){}
}
function irPrecacheHoverNaturalContext(e){
  try{
    var ty=String(e&&e.type||'');
    if(ty!=='mouseover'&&ty!=='pointerover')return;
    var tgt=e&&e.target;
    if(!tgt||!tgt.closest)return;
    // Skip events fired inside hover overlays — drill mouse drift would
    // otherwise overwrite the cache with a position inside the hover
    // wrapper instead of the editor token that triggered the hover.
    if(tgt.closest('.monaco-resizable-hover'))return;
    if(tgt.closest('.monaco-hover'))return;
    if(tgt.closest('.monaco-list'))return;
    var edEl=tgt.closest('.monaco-editor');
    if(!edEl)return;
    var ed=null;
    try{
      if(typeof irListAllCodeEditors==='function'){
        var allEds=irListAllCodeEditors();
        for(var ai=0;ai<allEds.length;ai++){
          var cand=allEds[ai];
          var cn=cand&&cand.getDomNode&&cand.getDomNode();
          if(cn&&(cn===edEl||(cn.contains&&cn.contains(edEl)))){ed=cand;break;}
        }
      }
    }catch(_){}
    if(!ed){try{ed=irFindWidgetOnElement(edEl);}catch(_){}}
    if(!ed||typeof ed.getTargetAtClientPoint!=='function')return;
    var x=e.clientX, y=e.clientY;
    if(typeof x!=='number'||typeof y!=='number')return;
    var tgtPos=null;
    try{tgtPos=ed.getTargetAtClientPoint(x,y);}catch(_){}
    if(!tgtPos||!tgtPos.position)return;
    // Widget-capture path (irWrapHoverWidgetGetPosition) will overwrite
    // these with its own clone when getPosition() finally runs — both
    // values agree at token granularity, so the overwrite is harmless.
    window.__irHoverNaturalEditor=ed;
    window.__irHoverNaturalPosition={
      position:{lineNumber:tgtPos.position.lineNumber,column:tgtPos.position.column}
    };
  }catch(_){}
}
function irDisposeActiveHoverForEditorTarget(e,reason){
  // L95 (2026-05-31) DEPRECATED in native mode: VS Code owns hover dismiss. Our editor-target
  // dispose was too aggressive (dismissed on sash/handle interaction). Kept for legacy managed mode.
  if(IR_HOVER_NATIVE_ONLY)return;
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
// L19: shared dedup gate for outside/active/preview hoverguard log lines.
// Returns true when this caller should actually fire the irLog (and updates
// the cache to record this position). Returns false to suppress logging —
// the surrounding code STILL runs (early returns, state mutations) so this
// is purely a log-volume gate. ±5px / 16ms window, scoped per element.
function irHoverGuardShouldLogDedup(el,e){
  try{
    var x=e&&typeof e.clientX==='number'?e.clientX|0:0;
    var y=e&&typeof e.clientY==='number'?e.clientY|0:0;
    var now=Date.now();
    var last=window.__irHoverGuardOutsideLast;
    // L39: was ±5 / 16ms. Bumped to ±10 / 32ms — mouse jitter while
    // reading hover content is typically much larger than 5px and the
    // surrounding code paths (early returns + log) are pure no-ops on
    // repeat. Wider window catches more redundant calls without
    // changing observable hover behaviour.
    if(last && last.el===el && Math.abs(last.x-x)<=10 && Math.abs(last.y-y)<=10 && (now-last.ts)<32){
      return false;
    }
    window.__irHoverGuardOutsideLast={el:el,x:x,y:y,ts:now};
    return true;
  }catch(_){return true}
}
function irHoverGuard(e){
  if(IR_HOVER_NATIVE_ONLY){
    // L114 (2026-06-01): native mode — VS Code owns the ENTIRE hover lifecycle
    // (show/dismiss/sticky/position/scroll). Every managed-mode branch below
    // FIGHTS it: active-near-non-editor-pass + the inside-hover path both call
    // e.stopImmediatePropagation() (swallowing the mouse events VS Code needs),
    // plus sticky arming / release / refire / .ir-keepalive tracking. Gating only
    // the individual action fns (L89/L97/L110) and branch 3 (L113) left branch 2
    // storming every pointermove near the hover and breaking native handling
    // (user: "native를 안쓰고 overlay를 다시 주입해서 깨지고 있음 — 우린 overlay를 버렸음").
    // Keep ONLY the drill affordance: wrap the type name under the pointer into a
    // clickable .ir-type-link (the click itself is handled separately by
    // irTypeLinkPointerDown, which also wraps on its own). No propagation
    // interference, no lifecycle management. cf. project_native_hover_only_switch.
    try{
      if(e&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='pointerover'||e.type==='mouseover')
        &&irClosestHover(e.target)){
        // L127 (2026-06-01): coalesce the on-demand wrap. pointermove+mousemove fire for the SAME
        // physical move (2x at identical coords) and reading-jitter fires many at ~one spot;
        // irWrapWordAtPoint does DOM range/word/validate work on each call (point-wrap fired 120x +
        // near-link 80x in one session) and any new-word wrap forces a VS Code reflow. Skip when the
        // pointer has not moved >4px since the last wrap within 40ms — never skips a real move to a
        // new word (tokens are ~50px wide) and the click handler (irTypeLinkPointerDown) wraps on its
        // own regardless, so drill is unaffected. Halves the per-move cost.
        var __pwx=(e.clientX|0),__pwy=(e.clientY|0),__pwt=Date.now(),__pwl=window.__irPointWrapLast;
        if(!(__pwl&&Math.abs(__pwl.x-__pwx)<=4&&Math.abs(__pwl.y-__pwy)<=4&&(__pwt-__pwl.t)<40)){
          window.__irPointWrapLast={x:__pwx,y:__pwy,t:__pwt};
          try{irWrapWordAtPoint(e)}catch(_){}
        }
      }
    }catch(_){}
    return;
  }
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
      && irIsPointerNearHover(activeEditorHover,e)
      && !irEventTargetsEditorSurface(e)
      && !irClosestNativePopup(e&&e.target)){
      irArmHoverSticky(activeEditorHover,IR_HOVER_EXIT_GRACE_MS);
      try{e.stopImmediatePropagation()}catch(_){}
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(activeEditorHover,e)){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard active-near-non-editor-pass event='+e.type+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' active={'+irHoverBrief(activeEditorHover)+'}');
      }
      return;
    }
    if(!IR_HOVER_NATIVE_ONLY&&activeEditorHover&&irHoverHasManagedContent(activeEditorHover)
      && irIsHoverRelocationEvent(e)
      && irEventTargetsEditorSurface(e)
      && !irClosestHover(e.target)){
      // L113 (2026-06-01): native mode skips this whole "outside-editor-new-token"
      // branch. Its actions are already no-ops in native (irReleaseNativeHoverManagement
      // L97, irRequestNativeShowHover L110, irArmHoverSticky L89), yet the branch still
      // evaluated, logged "managed={disposed}", and returned on EVERY mousemove over an
      // editor token while a drill hover was up (80 events in one 11:03 session) — dead
      // overlay-management churn the user read as "still injecting overlay". VS Code
      // shows the new-token hover natively. cf. project_native_hover_only_switch.
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
      if(!editorMoveToken&&irShouldHoldPreviewTransition(activeEditorHover,e)){
        irArmHoverSticky(activeEditorHover,IR_HOVER_EXIT_GRACE_MS);
        try{e.stopImmediatePropagation()}catch(_){}
        if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(activeEditorHover,e)){
          window.__irHoverGuardOutsideLogCount++;
          irLog('renderer: hoverguard preview-transition-pass event='+e.type+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' active={'+irHoverBrief(activeEditorHover)+'}');
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
    }else if(!pointLink&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
      // Dedup: a single user mouse motion fires up to 3 events at the same
      // coordinates. Coalesce by 5px / 16ms so we do not log (and do not
      // run the irFindNearbyTypeLink scan) three times per move.
      var hgx=e&&typeof e.clientX==='number'?e.clientX|0:0;
      var hgy=e&&typeof e.clientY==='number'?e.clientY|0:0;
      var hgNow=Date.now();
      var hgLast=window.__irHoverGuardNoLinkLast;
      // L39: ±10 / 32ms (was ±5 / 16ms). This guard is for log-volume
      // reduction on a per-frame mousemove gauntlet — wider window
      // suppresses jitter-driven repeats without affecting the
      // (separately cached) link activation path.
      var hgDup=hgLast&&hgLast.hover===insideHv&&Math.abs(hgLast.x-hgx)<=10&&Math.abs(hgLast.y-hgy)<=10&&(hgNow-hgLast.ts)<32;
      if(!hgDup&&window.__irHoverGuardNoLinkLogCount<120){
        window.__irHoverGuardNoLinkLogCount++;
        window.__irHoverGuardNoLinkLast={hover:insideHv,x:hgx,y:hgy,ts:hgNow};
        var near=irFindNearbyTypeLink(e,insideHv,26,10);
        irLog('renderer: hoverguard no point-link event='+e.type+' '+irEventPointBrief(e)+' target='+irElementBrief(irEventElement(e.target))+' hoverRect='+irRectBrief(insideHv)+(near?' nearest="'+(near.link.getAttribute&&near.link.getAttribute('data-type')||'')+'" dx='+near.dx+' dy='+near.dy+' rect='+near.rect:' nearest=none')+irPointWordSummary(e,insideHv));
      }
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
    var editorToken=irEventTargetTokenText(e);
    // L73 (2026-05-29): range-based same-symbol guard. If the pointer is still
    // inside the shown hover's anchor word RANGE, keep the hover as-is — do NOT
    // release+refire. The release+refire paths below re-render the hover into a
    // fresh .monaco-hover that we re-scan/re-size (reflow); that repeated reflow
    // on micro-moves is what collapsed the wrapper width to 16px / 0x0 (v=225
    // width-collapse-transition diag). The irHoverContainsTokenText check below
    // missed this (the hover body need not contain the symbol name); range is
    // authoritative and still refires on a real relocation to a different
    // position (so no "stuck at first occurrence" regression).
    if(irPointerWithinActiveHoverAnchor(e)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(managed,e)){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-same-anchor-pass event='+e.type+' token='+JSON.stringify(editorToken)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    if(editorToken&&near&&irHoverContainsTokenText(managed,editorToken)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(managed,e)){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-same-token-pass event='+e.type+' token='+JSON.stringify(editorToken)+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    if(editorToken){
      // (Previously: same-token 800ms dedupe to suppress rapid hide+show
      // flicker when dragging across same-name occurrences. Removed
      // because it FROZE the hover at the first occurrence position
      // for symbols like "datetime" appearing many times in a file.
      // Subsequent occurrences could not update the position. User
      // report: "stuck at first detected symbol position". Small
      // flicker is preferable to wrong position.)
      window.__irLastReleasedToken=editorToken;
      window.__irLastReleasedAt=now;
      irReleaseHoverSticky(managed);
      irReleaseNativeHoverManagement(managed,'outside-editor-token-relocation');
      irRequestNativeShowHover('outside-editor-token-relocation');
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-editor-dispose event='+e.type+' token='+JSON.stringify(editorToken)+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={disposed}');
      }
      return;
    }
    if(irShouldHoldPreviewTransition(managed,e)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      try{e.stopImmediatePropagation()}catch(_){}
      if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(managed,e)){
        window.__irHoverGuardOutsideLogCount++;
        irLog('renderer: hoverguard outside-preview-transition-pass event='+e.type+' near='+near+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    if(managed.__irActivatedAt&&now-managed.__irActivatedAt<IR_HOVER_FRESH_EDITOR_GRACE_MS){
      // L16: same dedup principle as L11 — a single user mouse motion
      // fires up to 3 events at same coords. Outside-guard logs were
      // repeating per event. We always RETURN here (functional behaviour
      // unchanged); only the log is suppressed when same coords within
      // 16ms on the same managed element.
      var ogx0=e&&typeof e.clientX==='number'?e.clientX|0:0;
      var ogy0=e&&typeof e.clientY==='number'?e.clientY|0:0;
      var ogLast0=window.__irHoverGuardOutsideLast;
      var ogDup0=ogLast0&&ogLast0.el===managed&&Math.abs(ogLast0.x-ogx0)<=5&&Math.abs(ogLast0.y-ogy0)<=5&&(now-ogLast0.ts)<16;
      if(!ogDup0&&window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        window.__irHoverGuardOutsideLast={el:managed,x:ogx0,y:ogy0,ts:now};
        irLog('renderer: hoverguard outside-fresh-pass event='+e.type+' near='+near+' age='+(now-managed.__irActivatedAt)+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    if(!editorToken&&near&&(isSticky||recentlyInside)){
      irArmHoverSticky(managed,IR_HOVER_EXIT_GRACE_MS);
      // L16: same dedup for the near-pass branch
      var ogx1=e&&typeof e.clientX==='number'?e.clientX|0:0;
      var ogy1=e&&typeof e.clientY==='number'?e.clientY|0:0;
      var ogLast1=window.__irHoverGuardOutsideLast;
      var ogDup1=ogLast1&&ogLast1.el===managed&&Math.abs(ogLast1.x-ogx1)<=5&&Math.abs(ogLast1.y-ogy1)<=5&&(now-ogLast1.ts)<16;
      if(!ogDup1&&window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')){
        window.__irHoverGuardOutsideLogCount++;
        window.__irHoverGuardOutsideLast={el:managed,x:ogx1,y:ogy1,ts:now};
        irLog('renderer: hoverguard outside-unknown-token-near-pass event='+e.type+' near='+near+' recentlyInside='+!!recentlyInside+' sticky='+!!isSticky+' target='+irElementBrief(irEventElement(e&&e.target))+' '+irEventPointBrief(e)+' managed={'+irHoverBrief(managed)+'}');
      }
      return;
    }
    // (Previously: same-token dedupe fall-through; removed for the same
    // reason as the upper site — locked hover at first occurrence of
    // multi-occurrence symbols. Just record release tracking.)
    if(editorToken){
      window.__irLastReleasedToken=editorToken;
      window.__irLastReleasedAt=now;
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
    if(window.__irHoverGuardOutsideLogCount<80&&(e.type==='pointermove'||e.type==='mousemove'||e.type==='mouseover')&&irHoverGuardShouldLogDedup(managed,e)){
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
function irPreviewTransitionWheelGuard(e){
  // L97 (2026-05-31): NOT deprecated — wheel guard scrolls the hover CONTENT and preventDefaults at
  // the scroll boundary so an over-scroll does NOT propagate to the editor and dismiss the hover.
  // This is content/scroll support, not native-fighting management. (v261 wrongly gated it -> #4.)
  try{
    var active=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
      ? window.__irActiveHoverEl
      : null;
    if(!active||!irShouldHoldPreviewTransition(active,e)||irClosestHover(e.target))return;
    var sc=irPrimaryHoverScroller(active)||active;
    var before=sc?Number(sc.scrollTop)||0:0;
    // L29: same 250ms scrollHeight cache as irHoverInternalWheelGuard.
    var maxTop=0;
    if(sc){
      var pCacheAt=Number(sc.__irMaxTopAt)||0;
      var pNow=Date.now();
      if(pCacheAt && (pNow-pCacheAt)<250){
        maxTop=Number(sc.__irMaxTop)||0;
      }else{
        maxTop=Math.max(0,(Number(sc.scrollHeight)||0)-(Number(sc.clientHeight)||0));
        sc.__irMaxTop=maxTop;
        sc.__irMaxTopAt=pNow;
      }
    }
    var delta=Number(e&&e.deltaY)||0;
    if(sc&&maxTop>0&&delta){
      sc.scrollTop=irClamp(before+delta,0,maxTop);
      if(active.scrollTop)active.scrollTop=0;
    }
    irArmHoverSticky(active,IR_HOVER_EXIT_GRACE_MS);
    try{e.preventDefault()}catch(_){}
    try{e.stopImmediatePropagation()}catch(_){}
    if(window.__irHoverGuardOutsideLogCount<80){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: hoverguard preview-transition-wheel delta='+delta+' before='+before+' after='+(sc?sc.scrollTop:0)+' max='+maxTop+' target='+irElementBrief(irEventElement(e&&e.target))+' active={'+irHoverBrief(active)+'}');
    }
  }catch(_){}
}
// L42: window-only registration. The mirrored document listeners
// fired the same handler twice per mouse event without affecting any
// observable behaviour (handlers were idempotent + stopPropagation
// gated downstream native listeners equally well at the window stage).
track(window,'pointermove',irRememberPointerEvent,true);
track(window,'mousemove',irRememberPointerEvent,true);
track(window,'mouseover',irRememberPointerEvent,true);
track(window,'pointerover',irRememberPointerEvent,true);
track(window,'pointermove',irHoverGuard,true);
track(window,'pointerover',irHoverGuard,true);
track(window,'pointerout',irHoverGuard,true);
track(window,'pointerleave',irHoverGuard,true);
track(window,'mousemove',irHoverGuard,true);
track(window,'mouseover',irHoverGuard,true);
track(window,'mouseout',irHoverGuard,true);
track(window,'mouseleave',irHoverGuard,true);
function irHoverInternalWheelGuard(e){
  // L97 (2026-05-31): NOT deprecated — scrolls the hover CONTENT and preventDefaults at the scroll
  // boundary so over-scroll does NOT propagate to the editor and dismiss the hover (user: "스크롤
  // 끝에서 더 스크롤해도 dismiss 말자"). Content/scroll support, not management. (v261 wrongly gated -> #4.)
  // Wheel events that originate INSIDE a managed hover. We want the
  // hover's internal scroller to scroll, BUT block the wheel from
  // bleeding through to the editor below — VS Code's editor scrolls
  // on wheel, fires onDidChangeTextEditorVisibleRanges, and the
  // hover gets dismissed. By preventDefault + stopPropagation here we
  // keep the hover open even when the user wheels past the top or
  // bottom of the hover content.
  try{
    var hover=irClosestHover(e&&e.target);
    if(!hover)return;
    var scroller=irPrimaryHoverScroller(hover)||hover;
    if(!scroller)return;
    var delta=Number(e&&e.deltaY)||0;
    if(!delta)return;
    // L29: cache maxTop for 250ms. scrollHeight/clientHeight reads force
    // a full content layout on every wheel tick — on a 57K-char drill
    // hover this is the dominant scroll-lag source. The hover's content
    // doesn't change during a scroll gesture, so the cached value is
    // accurate enough; MutationObservers elsewhere can invalidate when
    // content actually swaps.
    var cacheAt=Number(scroller.__irMaxTopAt)||0;
    var nowWheel=Date.now();
    var maxTop;
    if(cacheAt && (nowWheel-cacheAt)<250){
      maxTop=Number(scroller.__irMaxTop)||0;
    }else{
      maxTop=Math.max(0,(Number(scroller.scrollHeight)||0)-(Number(scroller.clientHeight)||0));
      scroller.__irMaxTop=maxTop;
      scroller.__irMaxTopAt=nowWheel;
    }
    var before=Number(scroller.scrollTop)||0;
    var next=irClamp(before+delta,0,maxTop);
    // Apply the scroll ourselves. Even if next === before (already at
    // a boundary), we still preventDefault below so the wheel doesn't
    // chain into the editor.
    if(maxTop>0&&next!==before){
      scroller.scrollTop=next;
      if(hover.scrollTop)hover.scrollTop=0;
    }
    irArmHoverSticky(hover,IR_HOVER_EXIT_GRACE_MS);
    try{e.preventDefault()}catch(_){}
    try{e.stopPropagation()}catch(_){}
    try{e.stopImmediatePropagation()}catch(_){}
    if(window.__irHoverGuardOutsideLogCount<80){
      window.__irHoverGuardOutsideLogCount++;
      irLog('renderer: hover-internal-wheel delta='+delta+' before='+before+' after='+scroller.scrollTop+' max='+maxTop+' atBoundary='+(next===before?'1':'0'));
    }
  }catch(_){}
}
// L29: wheel handlers were registered on BOTH window and document with
// capture=true. User reported severe scroll lag inside large drill
// hovers — each wheel event fired up to 4 handlers, and every call
// reads scrollHeight which forces a full content layout on the 57K-char
// hover (=> measurable frame drop). Capture-phase listeners on window
// already fire before any document or target-phase listener; keeping
// only the window registrations halves the handler count without
// changing observable behaviour.
track(window,'wheel',irHoverInternalWheelGuard,true);
track(window,'wheel',irPreviewTransitionWheelGuard,true);
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
// L103 (2026-05-31): size-audit diagnostic. The user observes VS Code's chosen
// hover height does not match our injected content length. Capture the real
// element heights so we can fix the mismatch precisely (instead of guessing):
// the resizable wrapper (VS Code sizes this), the .monaco-hover host, the
// scroller (its scrollHeight/clientHeight drive the scrollbar thumb), and the
// content length. maxTop=0 means nothing scrolls; scrollerH>wrapH means the
// scrollbar extends past the visible hover bottom (the "thumb below" report).
function irAuditHoverSize(hoverEl){
  if(!IR_HOVER_NATIVE_ONLY)return;
  try{
    if(!hoverEl||!hoverEl.getBoundingClientRect)return;
    var nowA=Date.now();
    if(hoverEl.__irSizeAuditAt&&nowA-hoverEl.__irSizeAuditAt<1000)return;   // throttle: 1s per host
    var hr=hoverEl.getBoundingClientRect();
    if(hr.height<20)return;   // skip transient/collapsed
    var contentLen=String(hoverEl.textContent||'').length;
    if(contentLen<400)return;   // only audit substantial hovers (the mismatch case)
    var wrap=hoverEl.closest?hoverEl.closest('.monaco-resizable-hover'):null;
    var wr=wrap&&wrap.getBoundingClientRect?wrap.getBoundingClientRect():null;
    var sc=irPrimaryHoverScroller(hoverEl);
    var scr=sc&&sc.getBoundingClientRect?sc.getBoundingClientRect():null;
    hoverEl.__irSizeAuditAt=nowA;
    irHERecord('hover-size-audit',{
      contentLen:contentLen,
      wrapH:wr?Math.round(wr.height):null,
      hostH:Math.round(hr.height),
      scrollerH:scr?Math.round(scr.height):null,
      scrollH:(sc&&typeof sc.scrollHeight==='number')?sc.scrollHeight:null,
      clientH:(sc&&typeof sc.clientHeight==='number')?sc.clientHeight:null,
      maxTop:(sc&&typeof sc.scrollHeight==='number')?Math.max(0,sc.scrollHeight-(sc.clientHeight||0)):null,
      wrapInlineH:(wrap&&wrap.style)?String(wrap.style.height||''):null,
      wrapInlineMaxH:(wrap&&wrap.style)?String(wrap.style.maxHeight||''):null,
      scIsHost:sc===hoverEl,
      vpH:(window.innerHeight||document.documentElement.clientHeight||0)
    });
    // L106 (2026-06-01): when content is abnormally large (drill duplicate-copy
    // accumulation — a single class preview is ~58975 chars, so >80000 means the
    // content already holds extra copies), capture the DOM structure so the dedup
    // can target the RIGHT element level. v272 hover-dedupe-removed=0 proved the
    // copies are NOT being caught by .rendered-markdown dedup — find out what they
    // actually are (one giant block? duplicate rows? non-rendered-markdown?).
    if(contentLen>80000){
      var dupExtra=function(list){
        var seen=Object.create(null),extra=0;
        for(var i=0;i<list.length&&i<60;i++){
          var k=String(list[i].textContent||'').replace(/\s+/g,' ').trim().slice(0,160);
          if(!k)continue;
          if(seen[k])extra++;else seen[k]=1;
        }
        return extra;
      };
      var rms=hoverEl.querySelectorAll('.rendered-markdown');
      var rmLens=[];
      for(var ri=0;ri<rms.length&&ri<12;ri++)rmLens.push(String(rms[ri].textContent||'').length);
      var childTags=[];
      var kids=hoverEl.children||[];
      for(var ci=0;ci<kids.length&&ci<8;ci++)childTags.push(String(kids[ci].className||kids[ci].nodeName).slice(0,40));
      irHERecord('hover-structure',{
        contentLen:contentLen,
        renderedMarkdown:rms.length,
        rmDupExtra:dupExtra(rms),
        rmLens:rmLens,
        hoverRows:hoverEl.querySelectorAll('.hover-row').length,
        rowDupExtra:dupExtra(hoverEl.querySelectorAll('.hover-row')),
        hoverContents:hoverEl.querySelectorAll('.monaco-hover-content').length,
        scrollables:hoverEl.querySelectorAll('.monaco-scrollable-element').length,
        childTags:childTags
      });
    }
  }catch(_){}
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
var IR_HOVER_EMPTY_SHELL_SELECTOR='.monaco-scrollable-element,.monaco-hover-content,.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown,.context-view';
var IR_HOVER_EMPTY_VISUAL_SELECTOR=IR_HOVER_EMPTY_SHELL_SELECTOR+',[class*="hover"],[class*="Hover"],[class*="scrollable"],[class*="Scrollable"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"]';
var IR_HOVER_EXTERNAL_VISUAL_SELECTOR=IR_HOVER_EMPTY_VISUAL_SELECTOR+',.monaco-resizable-hover,[class*="resizable-hover"],[class*="ResizableHover"]';
var IR_NATIVE_POPUP_EXCLUSION_SELECTOR='.suggest-widget,.quick-input-widget,.parameter-hints-widget,.monaco-menu,.action-widget,.peekview-widget,.rename-box,.zone-widget,.find-widget,.markers-panel,.notifications-toasts,.notifications-center';
function irQuarantineHoverNativeHandle(handle,remove){
  if(IR_HOVER_NATIVE_ONLY)return;   // L93: native mode keeps VS Code's native scrollbar + resize sash (the CSS un-hide alone was undone by this JS quarantine)
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
function irRectDistance(a,b){
  if(!a||!b)return Infinity;
  var dx=0,dy=0;
  if(a.right<b.left)dx=b.left-a.right;
  else if(b.right<a.left)dx=a.left-b.right;
  if(a.bottom<b.top)dy=b.top-a.bottom;
  else if(b.bottom<a.top)dy=a.top-b.bottom;
  return Math.sqrt((dx*dx)+(dy*dy));
}
function irElementIsVisibleBox(el){
  try{
    if(!el||!el.getBoundingClientRect)return false;
    var cs=window.getComputedStyle?window.getComputedStyle(el):null;
    if(cs&&(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)===0))return false;
    var r=el.getBoundingClientRect();
    return !!(r&&r.width>=2&&r.height>=2);
  }catch(_){return false}
}
function irCssColorVisible(value){
  try{
    var v=String(value||'').replace(/\s+/g,'').toLowerCase();
    if(!v||v==='transparent')return false;
    if(/^rgba?\(0,0,0,0\)$/.test(v))return false;
    if(/^rgba\([^)]*,0(?:\.0+)?\)$/.test(v))return false;
    return true;
  }catch(_){return false}
}
function irCssNumericPx(value){
  var n=parseFloat(String(value||'0'));
  return isFinite(n)?n:0;
}
function irElementPaintsVisibleBox(node,cs){
  try{
    cs=cs||(window.getComputedStyle?window.getComputedStyle(node):null);
    if(!cs)return false;
    if(irCssColorVisible(cs.backgroundColor))return true;
    if(String(cs.boxShadow||'').toLowerCase()!=='none')return true;
    if(String(cs.outlineStyle||'').toLowerCase()!=='none'&&irCssNumericPx(cs.outlineWidth)>0&&irCssColorVisible(cs.outlineColor))return true;
    var sides=['Top','Right','Bottom','Left'];
    for(var i=0;i<sides.length;i++){
      var side=sides[i];
      if(String(cs['border'+side+'Style']||'').toLowerCase()!=='none'
        &&irCssNumericPx(cs['border'+side+'Width'])>0
        &&irCssColorVisible(cs['border'+side+'Color']))return true;
    }
  }catch(_){}
  return false;
}
function irHoverVisualProbePoints(rect){
  var out=[],seen={};
  if(!rect)return out;
  function add(x,y){
    var cx=Math.max(1,Math.min((window.innerWidth||1)-2,x));
    var cy=Math.max(1,Math.min((window.innerHeight||1)-2,y));
    var key=Math.round(cx)+':'+Math.round(cy);
    if(seen[key])return;
    seen[key]=true;
    out.push({x:Math.round(cx*100)/100,y:Math.round(cy*100)/100});
  }
  var w=Math.max(1,rect.width||(rect.right-rect.left));
  var h=Math.max(1,rect.height||(rect.bottom-rect.top));
  var xs=[
    rect.left+2,
    rect.left+Math.min(12,w*0.12),
    rect.left+w*0.18,
    rect.left+w*0.33,
    rect.left+w*0.5,
    rect.right-w*0.33,
    rect.right-w*0.18,
    rect.right-Math.min(12,w*0.12),
    rect.right-2
  ];
  var ys=[
    rect.top-28,
    rect.top-16,
    rect.top-6,
    rect.top+1,
    rect.top+6,
    rect.top+Math.min(18,h*0.12),
    rect.top+h*0.18,
    rect.top+h*0.5,
    rect.bottom-Math.min(18,h*0.12),
    rect.bottom-2,
    rect.bottom+6
  ];
  for(var xi=0;xi<xs.length;xi++){
    for(var yi=0;yi<ys.length;yi++)add(xs[xi],ys[yi]);
  }
  return out;
}
function irEmptyHoverDangerRelation(nr,hr){
  if(!nr||!hr)return {near:false,overlaps:false,directOverlap:false,topBand:false,distance:null};
  var direct=irRectsIntersect(nr,hr,0);
  var padded=irRectsIntersect(nr,hr,24);
  var topBand=nr.bottom>=hr.top-32&&nr.top<=hr.top+32&&nr.right>=hr.left-16&&nr.left<=hr.right+16;
  var distance=irRectDistance(nr,hr);
  return {
    near:!!(padded||topBand||distance<=24),
    overlaps:!!(padded||topBand),
    directOverlap:!!direct,
    topBand:!!topBand,
    distance:Math.round(distance)
  };
}
function irEmptyHoverVisualCandidates(activeHover){
  var out=[],seen=[];
  function add(node){
    try{
      if(!node||node.nodeType!==1||seen.indexOf(node)>=0)return;
      seen.push(node);
      out.push(node);
    }catch(_){}
  }
  try{
    var nodes=document.querySelectorAll(IR_HOVER_EMPTY_VISUAL_SELECTOR);
    for(var i=0;i<nodes.length;i++)add(nodes[i]);
  }catch(_){}
  try{
    if(activeHover&&activeHover.querySelectorAll){
      var inside=activeHover.querySelectorAll('div,[class*="hover"],[class*="Hover"],[class*="scroll"],[class*="Scroll"],[class*="overlay"],[class*="Overlay"],[class*="cell"],[class*="Cell"],[style*="z-index"],[style*="position"]');
      for(var ii=0;ii<inside.length;ii++)add(inside[ii]);
    }
  }catch(_){}
  try{
    if(activeHover&&document.elementsFromPoint){
      var hr=irElementRect(activeHover);
      if(hr){
        var points=irHoverVisualProbePoints(hr);
        for(var pi=0;pi<points.length;pi++){
          var stack=document.elementsFromPoint(points[pi].x,points[pi].y)||[];
          for(var si=0;si<stack.length;si++)add(stack[si]);
        }
      }
    }
  }catch(_){}
  return out;
}
function irLooksLikeEmptyHoverVisualBox(node,activeHover){
  try{
    if(!node||node.nodeType!==1||!activeHover||!document.body||!document.body.contains(activeHover))return false;
    if(node===activeHover||node===document.body||node===document.documentElement)return false;
    if(irRootContains(node,activeHover))return false;
    var insideActive=irRootContains(activeHover,node);
    if(irIsInsideNativePopup(node))return false;
    if(irIsWorkbenchChrome(node))return false;
    if(!insideActive&&node.closest&&node.closest('.monaco-editor'))return false;
    if(!irElementIsVisibleBox(node))return false;
    var nr=irElementRect(node), hr=irElementRect(activeHover);
    if(!nr||!hr)return false;
    if(nr.width<4||nr.height<4)return false;
    var relation=irEmptyHoverDangerRelation(nr,hr);
    if(!relation.near)return false;
    var text=String(node.textContent||'').replace(/\s+/g,' ').trim();
    if(text&&!irIsTransientHoverText(text))return false;
    var cls=String(node.className||'');
    if(/(^|\s)(editor-instance|editor-container|editor-group-container|monaco-editor|overflow-guard|lines-content|view-lines|view-line)(\s|$)/i.test(cls))return false;
    if(/(sash|scrollbar|slider|shadow|decorationsOverviewRuler|scroll-decoration)/i.test(cls))return false;
    var cs=window.getComputedStyle?window.getComputedStyle(node):null;
    var painted=irElementPaintsVisibleBox(node,cs);
    var overlayPosition=!!(cs&&/(absolute|fixed|sticky)/.test(String(cs.position||'')));
    var namedLikeHover=/(hover|scroll|context|overlay|cell|row|content)/i.test(cls);
    if(insideActive){
      if(!painted&&!overlayPosition&&!namedLikeHover)return false;
    }else if(!painted&&!overlayPosition&&!namedLikeHover){
      return false;
    }
    return true;
  }catch(_){return false}
}
function irHideEmptyHoverVisualBoxes(activeHover,remove){
  var removed=0;
  if(!activeHover||!document.body||!document.body.contains(activeHover))return removed;
  try{
    var now=Date.now();
    if(remove===false&&activeHover.__irLastEmptyVisualSweepAt&&now-activeHover.__irLastEmptyVisualSweepAt<120)return 0;
    activeHover.__irLastEmptyVisualSweepAt=now;
  }catch(_){}
  try{
    var shells=irEmptyHoverVisualCandidates(activeHover);
    for(var si=0;si<shells.length;si++){
      var shell=shells[si];
      if(!irLooksLikeEmptyHoverVisualBox(shell,activeHover))continue;
      removed++;
      try{
        if(remove!==false&&shell.parentNode)shell.parentNode.removeChild(shell);
        else irQuarantineHoverNativeHandle(shell,false);
      }catch(_){try{irQuarantineHoverNativeHandle(shell,false)}catch(__){}}
    }
  }catch(_){}
  if(removed&&window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: empty hover visual sweep panels='+removed+' active={'+irHoverBrief(activeHover)+'}');
  }
  return removed;
}
function irIsInsideNativePopup(node){
  try{
    if(!node||node.nodeType!==1)return false;
    if(node.closest&&node.closest(IR_NATIVE_POPUP_EXCLUSION_SELECTOR))return true;
    if(node.querySelector&&node.querySelector(IR_NATIVE_POPUP_EXCLUSION_SELECTOR))return true;
  }catch(_){}
  return false;
}
function irIsWorkbenchChrome(node){
  try{
    if(!node||node.nodeType!==1)return false;
    if(node.closest&&node.closest('.titlebar,.titlebar-container,.titlebar-drag-region,.command-center,.activitybar,.statusbar,.part.statusbar,.part.activitybar,.part.titlebar'))return true;
    var cls=String(node.className||'');
    return /(titlebar|command-center|activitybar|statusbar|window-title|menubar|drag-region)/i.test(cls);
  }catch(_){return false}
}
function irExternalHoverVisualCandidates(activeHover){
  var out=[],seen=[];
  function add(node){
    try{
      if(!node||node.nodeType!==1||seen.indexOf(node)>=0)return;
      seen.push(node);
      out.push(node);
    }catch(_){}
  }
  try{
    var nodes=document.querySelectorAll(IR_HOVER_EXTERNAL_VISUAL_SELECTOR);
    for(var i=0;i<nodes.length;i++)add(nodes[i]);
  }catch(_){}
  try{
    if(activeHover&&document.elementsFromPoint){
      var hr=irElementRect(activeHover);
      if(hr){
        var points=irHoverVisualProbePoints(hr);
        for(var pi=0;pi<points.length;pi++){
          var stack=document.elementsFromPoint(points[pi].x,points[pi].y)||[];
          for(var si=0;si<stack.length;si++)add(stack[si]);
        }
      }
    }
  }catch(_){}
  return out;
}
function irLooksLikeExternalHoverVisualArtifact(node,activeHover){
  try{
    if(!node||node.nodeType!==1||!activeHover||!document.body||!document.body.contains(activeHover))return false;
    if(node===activeHover||node===document.body||node===document.documentElement)return false;
    if(irRootContains(activeHover,node)||irRootContains(node,activeHover))return false;
    if(irIsInsideNativePopup(node))return false;
    if(irIsWorkbenchChrome(node))return false;
    var owner=irHoverRootFromElement(node);
    if(owner)return false;
    if(node.closest&&node.closest('.monaco-editor'))return false;
    if(!irElementIsVisibleBox(node))return false;
    var nr=irElementRect(node), hr=irElementRect(activeHover);
    if(!nr||!hr)return false;
    if(nr.width<4||nr.height<4)return false;
    var relation=irEmptyHoverDangerRelation(nr,hr);
    if(!relation.near)return false;
    var cls=String(node.className||'');
    if(/(^|\s)(editor-instance|editor-container|editor-group-container|monaco-editor|overflow-guard|lines-content|view-lines|view-line)(\s|$)/i.test(cls))return false;
    if(/(sash|scrollbar|slider|shadow|decorationsOverviewRuler|scroll-decoration)/i.test(cls))return false;
    var strongNamed=/(monaco-hover|editor-hover|resizable-hover|monaco-scrollable-element|monaco-hover-content|hover-row|hover-contents|markdown-hover|rendered-markdown|context-view)/i.test(cls);
    if(!strongNamed&&node.matches){
      try{strongNamed=!!node.matches(IR_HOVER_EMPTY_SHELL_SELECTOR+',.monaco-resizable-hover')}catch(_){}
    }
    if(!strongNamed&&node.closest){
      try{strongNamed=!!node.closest('.monaco-hover,.monaco-editor-hover,.monaco-resizable-hover,.context-view')}catch(_){}
    }
    if(!strongNamed)return false;
    var text=String(node.textContent||'').replace(/\s+/g,' ').trim();
    if(!text)return false;
    var cs=window.getComputedStyle?window.getComputedStyle(node):null;
    var painted=irElementPaintsVisibleBox(node,cs);
    var positioned=!!(cs&&/(absolute|fixed|sticky)/.test(String(cs.position||'')));
    if(!painted&&!positioned&&!strongNamed)return false;
    return true;
  }catch(_){return false}
}
function irHideExternalHoverVisualArtifacts(activeHover,remove){
  var removed=0;
  if(!activeHover||!document.body||!document.body.contains(activeHover))return removed;
  try{
    var now=Date.now();
    if(remove===false&&activeHover.__irLastExternalVisualSweepAt&&now-activeHover.__irLastExternalVisualSweepAt<120)return 0;
    activeHover.__irLastExternalVisualSweepAt=now;
  }catch(_){}
  try{
    var artifacts=irExternalHoverVisualCandidates(activeHover);
    for(var ai=0;ai<artifacts.length;ai++){
      var artifact=artifacts[ai];
      if(!irLooksLikeExternalHoverVisualArtifact(artifact,activeHover))continue;
      removed++;
      try{
        if(remove!==false&&artifact.parentNode)artifact.parentNode.removeChild(artifact);
        else irQuarantineHoverNativeHandle(artifact,false);
      }catch(_){try{irQuarantineHoverNativeHandle(artifact,false)}catch(__){}}
    }
  }catch(_){}
  if(removed&&window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: external hover visual sweep panels='+removed+' active={'+irHoverBrief(activeHover)+'}');
  }
  return removed;
}
function irLooksLikeOrphanEmptyHoverShell(node,activeHover){
  return irLooksLikeEmptyHoverVisualBox(node,activeHover);
}
function irHideOrphanEmptyHoverShells(activeHover,remove){
  return irHideEmptyHoverVisualBoxes(activeHover,remove);
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
    var cls=String(node.className||'');
    if(/(^|\s)ir-e2e-/i.test(cls))return false;
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
    if(!(verticalEdge||horizontalEdge||corner||topRightCorner||topRightHorizontal))return false;
    // VS Code spawns a resize sash next to its hover (often a sibling of the
    // hover root, inside the same .monaco-hover-container / .content-widget).
    // When our ir-scrollable hover sizes dynamically the sash can stay at a
    // stale width and the geometry test flags it. We don't expose a resize
    // affordance, so any monaco-sash that lives inside the hover's container
    // ancestry is safe to hide. We deliberately avoid touching workbench
    // sashes (column splitter etc.) which live outside the hover container.
    var isSashLikeHandle=/(?:^|\s)(?:monaco-)?sash(?:\s|$|-)/i.test(cls);
    if(isSashLikeHandle&&activeHover.classList&&activeHover.classList.contains('ir-scrollable')){
      var hoverHost=null;
      try{
        hoverHost=activeHover.closest?activeHover.closest('.monaco-hover-container,.monaco-editor-overlaymessage,.contentWidgets,.overlayWidgets,.context-view'):null;
      }catch(_){}
      if(hoverHost&&hoverHost.contains&&hoverHost.contains(node))return true;
    }
    return irExternalHoverHandleOccludesActive(node,activeHover,nr,hr);
  }catch(_){return false}
}
function irStackIndexForRoot(stack,root){
  if(!stack||!root)return -1;
  for(var i=0;i<stack.length;i++){
    var el=stack[i];
    try{
      if(el===root||(root.contains&&root.contains(el)))return i;
    }catch(_){}
  }
  return -1;
}
function irExternalHoverHandleOccludesActive(node,activeHover,nr,hr){
  try{
    if(!document.elementsFromPoint)return false;
    var points=[];
    function add(x,y){
      if(!isFinite(x)||!isFinite(y))return;
      points.push({
        x:Math.max(1,Math.min((window.innerWidth||1)-2,x)),
        y:Math.max(1,Math.min((window.innerHeight||1)-2,y))
      });
    }
    add((Math.max(nr.left,hr.left)+Math.min(nr.right,hr.right))/2,(Math.max(nr.top,hr.top)+Math.min(nr.bottom,hr.bottom))/2);
    add((nr.left+nr.right)/2,(nr.top+nr.bottom)/2);
    add(Math.max(nr.left+1,Math.min(nr.right-1,hr.right-2)),Math.max(nr.top+1,Math.min(nr.bottom-1,hr.bottom-2)));
    for(var pi=0;pi<points.length;pi++){
      var stack=document.elementsFromPoint(points[pi].x,points[pi].y)||[];
      var handleIndex=irStackIndexForRoot(stack,node);
      if(handleIndex<0)continue;
      var hoverIndex=irStackIndexForRoot(stack,activeHover);
      if(hoverIndex>=0&&handleIndex<hoverIndex)return true;
    }
  }catch(_){}
  return false;
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
    var shells=irNodeMatchesOrContains(node,IR_HOVER_EMPTY_VISUAL_SELECTOR);
    for(var si=0;si<shells.length;si++){
      var s=shells[si];
      if(irLooksLikeOrphanEmptyHoverShell(s,activeHover)){
        if(remove!==false&&s.parentNode)s.parentNode.removeChild(s);
        else irQuarantineHoverNativeHandle(s,false);
        cleaned=true;
      }
    }
    var visuals=irNodeMatchesOrContains(node,IR_HOVER_EXTERNAL_VISUAL_SELECTOR);
    for(var vi=0;vi<visuals.length;vi++){
      var v=visuals[vi];
      if(irLooksLikeExternalHoverVisualArtifact(v,activeHover)){
        if(remove!==false&&v.parentNode)v.parentNode.removeChild(v);
        else irQuarantineHoverNativeHandle(v,false);
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
function irClearManagedHoverVisibilityKeepalive(hoverEl){
  if(!hoverEl)return;
  try{
    if(hoverEl.__irVisibilityKeepaliveTimers){
      for(var ti=0;ti<hoverEl.__irVisibilityKeepaliveTimers.length;ti++)irClearTimer(hoverEl.__irVisibilityKeepaliveTimers[ti]);
    }
  }catch(_){}
  hoverEl.__irVisibilityKeepaliveTimers=[];
}
function irScheduleManagedHoverVisibilityKeepalive(hoverEl){
  if(IR_HOVER_NATIVE_ONLY)return;   // L100 (2026-05-31) DEPRECATED: don't schedule revive timers that fight VS Code's native visibility (the 22x visibility-keepalive churn in v264). VS Code owns dismiss. Kept for legacy managed mode.
  if(!hoverEl||!irIsNativeHoverRoot(hoverEl))return;
  irClearManagedHoverVisibilityKeepalive(hoverEl);
  var run=function(){
    try{
      if(!hoverEl||!document.body||!document.body.contains(hoverEl))return;
      if(window.__irActiveHoverEl!==hoverEl)return;
      if(!irHoverHasManagedContent(hoverEl))return;
      var visibility=irHoverRootVisibility(hoverEl);
      if(visibility&&visibility.visible)return;
      irReviveRecentlyManagedHover(hoverEl,'visibility-keepalive');
    }catch(_){}
  };
  hoverEl.__irVisibilityKeepaliveTimers=[
    irSetTimer(run,120),
    irSetTimer(run,320),
    irSetTimer(run,700),
    irSetTimer(run,1300),
    irSetTimer(run,2200)
  ];
}
function irScheduleHoverNativeHandleCleanup(hoverEl,remove){
  if(!hoverEl)return;
  irClearHoverHandleCleanup(hoverEl);
  var run=function(){
    try{
      if(!hoverEl||!document.body||!document.body.contains(hoverEl))return;
      irHideHoverNativeHandles(hoverEl,remove!==false);
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
function irIsWorkbenchHoverRoot(root){
  try{
    return !!(root&&root.classList&&root.classList.contains('workbench-hover'));
  }catch(_){return false}
}
function irIsNativeHoverRoot(root){
  try{
    return !!(root&&root.matches&&root.matches(IR_HOVER_ROOT_SELECTOR)&&!irIsSyntheticHoverRoot(root)&&!irIsWorkbenchHoverRoot(root));
  }catch(_){return false}
}
function irHoverRootVisibility(root){
  try{
    if(!root)return {visible:false,reason:'missing'};
    if(!document.body||!document.body.contains(root))return {visible:false,reason:'detached'};
    // L76: a wrapper we're staging is intentionally hidden by us until it
    // settles — report it visible so the dispose / force-visible / unrenderable
    // sweeps (all routed through this fn) leave it alone instead of fighting the
    // staging (and disposing the about-to-show hover). irStageReveal clears the
    // class when done; the hard-cap timer guarantees it never sticks hidden.
    try{if(root.closest&&root.closest('.monaco-resizable-hover.ir-hover-staging'))return {visible:true,reason:'staging'};}catch(_){}
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
      try{root.__irForceZeroRectSkips=0;root.__irZeroRectTransientUntil=0;}catch(_){}
      irRememberVisibleHoverRect(root,reason||'force-visible');
      return true;
    }
    // L78 (2026-05-30): a force-visible that resolves to a 'zero-rect' root
    // STILL carrying activating content is the transient collapse VS Code emits
    // mid content-swap / link re-wrap (v=230: full-size hover → wrap 530 links
    // → width-collapse to 0x0 → recovers in ~70ms). Returning false here is read
    // by the revive→dispose path as a hard failure, so the hover gets RELEASED
    // and the user sees the drilled content vanish. The L74 __irZeroRectSkips
    // guard in irDisposeHiddenActiveHover never engages for this path: at its
    // entry the root still reads as 'hidden-class', so its zero-rect-only match
    // is bypassed (verified — that skip fired 0× across 28 zero-rect force-
    // preview failures). At this single choke point all revive/preview paths
    // funnel through: for a bounded number of attempts keep the hover un-hidden,
    // stamp a short grace window the dispose path honours (so it will NOT
    // release the transient), nudge a reflow re-check next frame, and report
    // success. Counter + window reset on the next genuinely-visible measurement.
    if(visibility&&visibility.reason==='zero-rect'&&irHoverRootHasActivatingContent(root)){
      var fzSkips=(root.__irForceZeroRectSkips||0);
      if(fzSkips<10){
        root.__irForceZeroRectSkips=fzSkips+1;
        try{root.__irZeroRectTransientUntil=Date.now()+250;}catch(_){}
        irHERecord('force-preview-zero-rect-transient',{phase:'force-keepalive',skips:fzSkips+1,reason:String(reason||''),textLen:String(root.textContent||'').length});
        try{
          if(!root.__irForceZeroRectRAF){
            root.__irForceZeroRectRAF=requestAnimationFrame(function(){
              try{root.__irForceZeroRectRAF=0;}catch(_){}
              try{if(document.body&&document.body.contains(root))irForcePreviewHoverVisible(root,(reason||'force')+'-zr-retry');}catch(_){}
            });
          }
        }catch(_){}
        return true;
      }
      try{root.__irZeroRectTransientUntil=0;}catch(_){}
    }
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: force preview hover visible failed '+(reason||'')+' reason='+(visibility&&visibility.reason||'')+' active={'+irHoverBrief(root)+'}');
    }
    // L50 diag: when force-visible fails on a non-zero-text hover that
    // carries our keepalive/sticky classes, capture the WRAPPER state
    // (not just the root) — this is the strongest candidate for the
    // pillar/empty-hover bug the user reported.
    try{
      var fpvRoot=root;
      var fpvWrap=fpvRoot&&fpvRoot.closest?fpvRoot.closest('.monaco-resizable-hover'):null;
      var fpvWrapRect=fpvWrap&&fpvWrap.getBoundingClientRect?fpvWrap.getBoundingClientRect():null;
      var fpvWrapStyle=fpvWrap&&fpvWrap.style?fpvWrap.style:null;
      var fpvWrapClasses=[];
      try{
        if(fpvWrap&&fpvWrap.classList){
          ['ir-drill-hover','ir-keepalive','ir-sticky','ir-scrollable','hidden','ir-native-released-hover'].forEach(function(c){
            if(fpvWrap.classList.contains(c))fpvWrapClasses.push(c);
          });
        }
      }catch(_){}
      var fpvRootClasses=[];
      try{
        if(fpvRoot&&fpvRoot.classList){
          ['ir-keepalive','ir-sticky','ir-scrollable','ir-size-medium','ir-size-small','ir-size-large','ir-empty-hover-root','ir-native-released-hover','fade-in'].forEach(function(c){
            if(fpvRoot.classList.contains(c))fpvRootClasses.push(c);
          });
        }
      }catch(_){}
      var fpvRootRect=fpvRoot&&fpvRoot.getBoundingClientRect?fpvRoot.getBoundingClientRect():null;
      var fpvRootText=fpvRoot&&fpvRoot.textContent?String(fpvRoot.textContent):'';
      // L51 cleanup: when wrapper has been dismissed by VS Code
      // (display:none / visibility:hidden / zero-rect) AND the root
      // still carries OUR keepalive classes, drop our classes so the
      // next force-visible attempt does not pile on. Wrapper inline
      // width/height (e.g. residual 16px) is left untouched — we never
      // set it (wrapPositionedOnce/Desired both false), so VS Code may
      // intend to reuse those dimensions.
      // L54 safe cleanup (refined from L51 A): the previous version
      // dropped our keepalive classes on the FIRST failed force-visible.
      // For hovers in the middle of a normal dismiss/revive cycle this
      // stripped keepalive too eagerly — subsequent force-visible calls
      // could not anchor on our classes anymore, so re-hover stayed
      // failed and the user perceived "hover not showing".
      // Now use a 2-pass gate on the wrapper: first sighting only
      // stamps __irForcePreviewSeenAt; only when the wrapper is STILL
      // dismissed ≥500ms later do we strip the classes. That window
      // lets VS Code's natural revive/redirect-to-new-token paths win
      // first, and only persistent stale state gets cleaned.
      try{
        var fpvDismissed=
          (fpvWrapStyle&&(fpvWrapStyle.display==='none'||fpvWrapStyle.visibility==='hidden'))
          ||(fpvWrapRect&&(fpvWrapRect.width<2||fpvWrapRect.height<2));
        var fpvOurClassesPresent=fpvRootClasses.some(function(c){
          return c==='ir-keepalive'||c==='ir-sticky'||c==='ir-scrollable';
        });
        if(fpvDismissed&&fpvOurClassesPresent&&fpvWrap){
          var fpvSeenAt=fpvWrap.__irForcePreviewSeenAt||0;
          var fpvAgeMs=fpvSeenAt?Date.now()-fpvSeenAt:0;
          if(!fpvSeenAt||fpvAgeMs<500){
            try{fpvWrap.__irForcePreviewSeenAt=Date.now();}catch(_){}
          }else if(fpvRoot&&fpvRoot.classList){
            fpvRoot.classList.remove(
              'ir-keepalive','ir-sticky','ir-scrollable',
              'ir-size-small','ir-size-medium','ir-size-large',
              'ir-empty-hover-root','ir-native-released-hover'
            );
            try{delete fpvWrap.__irForcePreviewSeenAt;}catch(_){fpvWrap.__irForcePreviewSeenAt=0;}
            irHERecord('force-preview-cleanup',{
              reason:String(reason||''),
              ageMs:fpvAgeMs,
              removedClasses:fpvRootClasses,
              wrapDisplay:fpvWrapStyle?String(fpvWrapStyle.display||''):'',
              wrapVisibility:fpvWrapStyle?String(fpvWrapStyle.visibility||''):''
            });
          }
        }
      }catch(_){}
      irHERecord('force-preview-failed-diag',{
        reason:String(reason||''),
        visibilityReason:String(visibility&&visibility.reason||''),
        rootRect:fpvRootRect?{x:Math.round(fpvRootRect.left),y:Math.round(fpvRootRect.top),w:Math.round(fpvRootRect.width),h:Math.round(fpvRootRect.height)}:null,
        rootTextLen:fpvRootText.length,
        rootClasses:fpvRootClasses,
        hasWrap:!!fpvWrap,
        wrapRect:fpvWrapRect?{x:Math.round(fpvWrapRect.left),y:Math.round(fpvWrapRect.top),w:Math.round(fpvWrapRect.width),h:Math.round(fpvWrapRect.height)}:null,
        wrapHeight:fpvWrapStyle?String(fpvWrapStyle.height||''):'',
        wrapMaxHeight:fpvWrapStyle?String(fpvWrapStyle.maxHeight||''):'',
        wrapWidth:fpvWrapStyle?String(fpvWrapStyle.width||''):'',
        wrapTop:fpvWrapStyle?String(fpvWrapStyle.top||''):'',
        wrapLeft:fpvWrapStyle?String(fpvWrapStyle.left||''):'',
        wrapDisplay:fpvWrapStyle?String(fpvWrapStyle.display||''):'',
        wrapVisibility:fpvWrapStyle?String(fpvWrapStyle.visibility||''):'',
        wrapOpacity:fpvWrapStyle?String(fpvWrapStyle.opacity||''):'',
        wrapClasses:fpvWrapClasses,
        wrapPositionedOnce:!!(fpvWrap&&fpvWrap.__irPositionedOnce),
        wrapHasDesired:!!(fpvWrap&&fpvWrap.__irDesired)
      });
    }catch(_){}
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
function irReviveRecentlyManagedHover(root,reason){
  if(IR_HOVER_NATIVE_ONLY)return false;   // L100 (2026-05-31) DEPRECATED: reviving a hover VS Code made invisible = fighting native dismiss (the visibility-keepalive churn the user read as "overlay still alive"). VS Code owns the lifecycle; drill re-shows via page-transition -> $provideHover native re-hover. Kept for legacy managed mode.
  try{
    if(!root||!irHoverHasManagedContent(root))return false;
    if(irIsSyntheticHoverRoot(root))return false;
    var now=Date.now();
    var sticky=root.__irStickyUntil&&root.__irStickyUntil>now;
    var recentlyInside=root.__irLastInsideAt&&now-root.__irLastInsideAt<IR_HOVER_EXIT_GRACE_MS;
    var recentlyActivated=root.__irActivatedAt&&now-root.__irActivatedAt<1600;
    if(!sticky&&!recentlyInside&&!recentlyActivated)return false;
    if(root.classList)root.classList.remove('hidden','ir-stale-hover','ir-native-released-hover');
    if(root.removeAttribute){
      root.removeAttribute('aria-hidden');
      root.removeAttribute('hidden');
      root.removeAttribute('data-ir-native-released-hover');
    }
    if(root.style){
      root.style.removeProperty('display');
      root.style.removeProperty('visibility');
      root.style.removeProperty('opacity');
      root.style.setProperty('pointer-events','auto','important');
    }
    if(!irForcePreviewHoverVisible(root,reason||'recent-managed'))return false;
    irSetActiveHoverLayer(root);
    if(window.__irHiddenActiveHoverLogCount<80){
      window.__irHiddenActiveHoverLogCount++;
      irLog('renderer: revived recent managed hover '+(reason||'')+' sticky='+(sticky?'1':'0')+' inside='+(recentlyInside?'1':'0')+' activated='+(recentlyActivated?'1':'0')+' active={'+irHoverBrief(root)+'}');
    }
    return true;
  }catch(_){}
  return false;
}
function irNativeReleaseDismissedHoverBookkeeping(root){
  // L122 (2026-06-01): native-mode cleanup of OUR bookkeeping when VS Code has dismissed
  // the active hover (it went non-renderable / got the hidden class). The full release
  // (irReleaseNativeHiddenHover / irDisposeHiddenActiveHover) is gated off in native (L95-L97)
  // because it fought VS Code's dismiss (hide/revive/reposition). But gating it ALSO stopped us
  // dropping __irActiveHoverEl + stopping the per-hover MutationObserver (__irActiveHoverHandle
  // Observer, childList+attributes on the subtree) + clearing timers — so the scan kept treating
  // the dead hover as active and that observer kept firing on VS Code's mutations to the reused/
  // hidden widget. That is the CPU that "persists after the hover is gone" (user: cleanup missing).
  // This does ONLY safe bookkeeping: stop the observer, drop the ref, clear timers. NO visibility/
  // class/position writes — so if VS Code revives the widget the scan simply re-detects it as
  // active (scan-fallback); no release<->revive flicker (cf. feedback_zero_rect_with_content_is_transient).
  try{
    if(window.__irActiveHoverEl===root){
      try{irStopActiveHoverHandleObserver();}catch(_){}
      window.__irActiveHoverEl=null;
    }
  }catch(_){}
  try{if(root&&root.__irStickyTimer){irClearTimer(root.__irStickyTimer);root.__irStickyTimer=null;}}catch(_){}
  try{if(root&&root.__irScrollScanTimer){clearTimeout(root.__irScrollScanTimer);root.__irScrollScanTimer=null;}}catch(_){}
  try{if(root&&root.__irFitFrame){cancelAnimationFrame(root.__irFitFrame);root.__irFitFrame=null;}}catch(_){}
  // L131 (2026-06-01): free the retained per-block scan caches on dismiss. A full-highlight (B/L130)
  // 52k class otherwise keeps __irScanCacheText(52k) + candidateText(52k) + the ~240-name types array
  // + compiled regex + candidate set ALIVE after the hover is gone (the "메모리에서 해제 못함"). The
  // dismissed/hidden hover is skipped by the renderable check (scan ~7114) before the text guards, so
  // dropping these markers is safe (a revive re-scans). Frees the biggest retained renderer memory.
  try{
    var __blks=root&&root.querySelectorAll?root.querySelectorAll('.rendered-markdown'):null;
    if(__blks)for(var __bi=0;__bi<__blks.length;__bi++){
      var __b=__blks[__bi];
      try{__b.__irScanCacheText=null;__b.__irScanCacheCandidateText=null;__b.__irScanCacheTypes=null;__b.__irScanCacheRegex=null;}catch(_){}
      try{__b.__irLastScanText=null;__b.__irLastScanSig=null;__b.__irViewportWrap=false;__b.__irHoverLinkCandidates=null;}catch(_){}
    }
  }catch(_){}
}
function irReleaseNativeHiddenHover(root,reason,visibilityReason){
  // L95 (2026-05-31) DEPRECATED in native mode: VS Code owns dismiss/release. Our release on 0x0
  // transients (hidden-active-hoverguard / active-switch) dismissed the hover during native resize
  // (focus-out felt too sensitive). Kept for legacy managed mode.
  if(IR_HOVER_NATIVE_ONLY)return false;
  if(!root||!irIsNativeHoverRoot(root))return false;
  var refireGrace=false;
  try{refireGrace=!!(window.__irNativeHoverRefireUntil&&Date.now()<window.__irNativeHoverRefireUntil)}catch(_){}
  try{if(root.__irStickyTimer)irClearTimer(root.__irStickyTimer)}catch(_){}
  try{if(root.__irFitFrame)cancelAnimationFrame(root.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(root)}catch(_){}
  try{irClearManagedHoverVisibilityKeepalive(root)}catch(_){}
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
  // L95 (2026-05-31) DEPRECATED in native mode: VS Code owns dismiss. Kept for legacy managed mode.
  if(IR_HOVER_NATIVE_ONLY)return false;
  try{
    var active=window.__irActiveHoverEl;
    if(!active||!document.body||!document.body.contains(active))return false;
    var visibility=irHoverRootVisibility(active);
    if(visibility&&visibility.visible){try{if(active.__irZeroRectSkips)active.__irZeroRectSkips=0;}catch(_){}return false;}
    // L74 (2026-05-29): a 'zero-rect' hover (display:block + visible, but
    // momentarily 0x0) that STILL holds substantial content is a transient
    // layout state during VS Code's content swap — NOT a dismiss. v=226 diag:
    // these carried textLen up to 57k, were connected+active, and recovered to
    // full size within ~70ms; yet releasing/disposing them here kicked off a
    // release->revive churn that flickered the hover empty (the user-reported
    // "내용이 안보이는" / 0x0 collapse). Leave a transient zero-rect alone for a
    // bounded number of sweeps so VS Code's own relayout wins. The counter
    // resets the moment it becomes visible again (above); a genuinely stuck or
    // emptied hover still falls through after the cap.
    if(visibility&&visibility.reason==='zero-rect'&&irHoverRootHasActivatingContent(active)){
      var zrSkips=(active.__irZeroRectSkips||0);
      if(zrSkips<10){
        active.__irZeroRectSkips=zrSkips+1;
        irHERecord('hidden-active-zero-rect-skip',{skips:zrSkips+1,reason:String(reason||'')});
        return false;
      }
    }
    if(irReviveRecentlyManagedHover(active,reason||'hidden-active'))return false;
    if(irReviveRecentlyAppliedHover(active,reason||'hidden-active'))return false;
    // L78 (2026-05-30): the revive paths above route through
    // irForcePreviewHoverVisible, which stamps __irZeroRectTransientUntil when
    // it lands on a 0x0-but-content-present root (VS Code mid content-swap /
    // link re-wrap). Releasing inside that grace window is exactly the drill-
    // time "content vanishes" regression: the transient recovers to full size
    // on its own (~70ms) once VS Code relayouts, and force-preview already left
    // it un-hidden — so holding here is enough to let it reappear. Bounded by
    // the grace window + the force-preview skip counter; a genuinely stuck
    // hover still falls through to release once both lapse.
    if(active.__irZeroRectTransientUntil&&Date.now()<active.__irZeroRectTransientUntil&&irHoverRootHasActivatingContent(active)){
      irHERecord('force-preview-zero-rect-transient',{phase:'dispose-hold',reason:String(reason||'')});
      return false;
    }
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
      if(root.style)root.style.setProperty('pointer-events','none','important');
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
    // L36: cheap signature pre-check. Mutation bursts call this dozens
    // of times per drill paint, and each call extracted root.textContent
    // (a 57K — 400K char walk on large class hovers) just to update a
    // length comparison. When the children pattern is unchanged, the
    // text is overwhelmingly the same — skip the expensive read.
    var touchSig=(root.childElementCount||0)+':'+
      (root.firstElementChild?root.firstElementChild.nodeName:'_')+':'+
      (root.lastElementChild?root.lastElementChild.nodeName:'_');
    if(root.__irTouchSig===touchSig && (now-(Number(root.__irTouchSigAt)||0))<500){
      // Same structure within the last 500ms — only update the change
      // timestamp (other callers gate on it). Skip the textContent read,
      // sample build, transient-text detection, and downstream logging.
      root.__irContentChangedAt=now;
      return;
    }
    root.__irTouchSig=touchSig;
    root.__irTouchSigAt=now;
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
      // The currentLength>120 branch used to fire even when nothing
      // changed (currentLength === previousLength). With every preBlock
      // text mutation triggering this — but the host total textContent
      // length often unchanged — we were spamming "len=N prev=N transient=0"
      // entries that conveyed no signal. Now it only fires when length
      // actually moved.
      var interesting=irIsTransientHoverText(sample)
        || previousLength===0
        || Math.abs(currentLength-previousLength)>24
        || (currentLength>120 && currentLength!==previousLength);
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
  if(irIsWorkbenchHoverRoot(root))return false;
  try{
    try{
      var ownedReleased=root.getAttribute&&root.getAttribute('data-ir-native-released-hover')==='1';
      var releasedChanged=false;
      if(root.__irReleasedAt&&Date.now()-root.__irReleasedAt<8000){
        var releasedText=String(root.__irReleasedText||'');
        // L41: avoid the textContent walk when we can rule out equality
        // from cheap properties. The textContent walk on a 57K-char drill
        // hover dominates this code path when running on every activation.
        // childElementCount + last child node name change with content,
        // so when they differ we know text differs without materializing
        // the full string. When the cheap check is inconclusive (same
        // structure) we still pay the full string cost — but only then.
        var actSig=(root.childElementCount||0)+':'+
          (root.firstElementChild?root.firstElementChild.nodeName:'_')+':'+
          (root.lastElementChild?root.lastElementChild.nodeName:'_');
        var prevActSig=root.__irActivationSig;
        var currentText;
        if(prevActSig && prevActSig!==actSig){
          currentText='';  // structure changed → text changed; skip walk
        }else{
          currentText=String(root.textContent||'');
        }
        root.__irActivationSig=actSig;
        if(releasedText&&currentText===releasedText){
          try{
            if(root.classList)root.classList.add('hidden');
            if(root.style)root.style.setProperty('pointer-events','none','important');
            irRequestNativeShowHover('released-unchanged-hover');
          }catch(_){}
          if(window.__irHoverLifecycleLogCount<120){
            window.__irHoverLifecycleLogCount++;
            irLog('renderer: skip unchanged released native hover '+(reason||'')+' root={'+irHoverBrief(root)+'}');
          }
          return false;
        }
        if(releasedText&&currentText&&currentText!==releasedText)releasedChanged=true;
      }
      if(releasedChanged&&root.classList)root.classList.remove('hidden');
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
      // L49 diag: capture wrapper inline state so we can see whether the
      // pillar / empty hover bug is wrapper-with-frozen-height or
      // root-without-wrapper. forced-log kind, capped via the standard
      // hover-event ring so it cannot spam beyond max.
      try{
        var diagRoot=root;
        var diagWrap=diagRoot&&diagRoot.closest?diagRoot.closest('.monaco-resizable-hover'):null;
        var diagInner=diagWrap&&diagWrap.querySelector?diagWrap.querySelector('.monaco-hover'):null;
        var diagWrapRect=diagWrap&&diagWrap.getBoundingClientRect?diagWrap.getBoundingClientRect():null;
        var diagWrapStyle=diagWrap&&diagWrap.style?diagWrap.style:null;
        var diagInnerStyle=diagInner&&diagInner.style?diagInner.style:null;
        var diagRootText=diagRoot&&diagRoot.textContent?String(diagRoot.textContent):'';
        var diagWrapClasses=[];
        try{
          if(diagWrap&&diagWrap.classList){
            ['ir-drill-hover','ir-keepalive','ir-sticky','ir-scrollable','hidden','ir-native-released-hover'].forEach(function(c){
              if(diagWrap.classList.contains(c))diagWrapClasses.push(c);
            });
          }
        }catch(_){}
        irHERecord('unrenderable-hover-diag',{
          reason:String(reason||''),
          rootRect:irRectTriplet(diagRoot),
          rootTextLen:diagRootText.length,
          hasWrap:!!diagWrap,
          wrapRect:diagWrapRect?{x:Math.round(diagWrapRect.left),y:Math.round(diagWrapRect.top),w:Math.round(diagWrapRect.width),h:Math.round(diagWrapRect.height)}:null,
          wrapHeight:diagWrapStyle?String(diagWrapStyle.height||''):'',
          wrapMaxHeight:diagWrapStyle?String(diagWrapStyle.maxHeight||''):'',
          wrapWidth:diagWrapStyle?String(diagWrapStyle.width||''):'',
          wrapDisplay:diagWrapStyle?String(diagWrapStyle.display||''):'',
          wrapVisibility:diagWrapStyle?String(diagWrapStyle.visibility||''):'',
          wrapOpacity:diagWrapStyle?String(diagWrapStyle.opacity||''):'',
          wrapClasses:diagWrapClasses,
          wrapPositionedOnce:!!(diagWrap&&diagWrap.__irPositionedOnce),
          wrapHasDesired:!!(diagWrap&&diagWrap.__irDesired),
          innerHeight:diagInnerStyle?String(diagInnerStyle.height||''):'',
          innerMaxHeight:diagInnerStyle?String(diagInnerStyle.maxHeight||''):''
        });
      }catch(_){}
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
    // L12+L17+L18: skip hovers we should not be scanning.
    // L18 (state-based, time-agnostic): non-renderable hovers that are
    // not the currently active hover can be skipped immediately. The
    // previous time-based gate (L12 60s, L17 30s) missed freshly-released
    // opacity-zero hovers with releasedAge=0 — those were the dominant
    // contributors to the "skip unrenderable hover scan" cap (40 lines
    // per session). The active hover is never skipped — it may be the
    // live target the user is interacting with.
    // L17 stays: any released, non-active hover older than 30s is also
    // a clear skip target.
    try{
      var stalActive=window.__irActiveHoverEl;
      var isActiveStale=stalActive===hoverHost;
      if(!isActiveStale){
        if(!irIsRenderableHoverRoot(hoverHost)) return false;
        var stalAt=Number(hoverHost.__irReleasedAt)||0;
        if(stalAt && (Date.now()-stalAt) > 30000) return false;
      }
    }catch(_){}
    irMarkHoverRootSeen(hoverHost);
    irClearEmptyHoverRoot(hoverHost);
    var active=window.__irActiveHoverEl;
    if(active&&document.body&&document.body.contains(active)&&!irIsRenderableHoverRoot(active)){
      // L122: native keeps VS Code's dismiss but still clears OUR bookkeeping (the gated
      // irDisposeHiddenActiveHover is a no-op in native — that left the dead hover "active"
      // and its observer running = CPU persisting after the hover). Managed mode keeps the
      // full dispose.
      if(IR_HOVER_NATIVE_ONLY)irNativeReleaseDismissedHoverBookkeeping(active);
      else irDisposeHiddenActiveHover('scan');
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
      return irActivateHoverRoot(hoverHost,'scan-fallback');
    }
    if(irRootContains(active,block))return true;
    if(!irIsStaleHoverRoot(hoverHost)&&irHoverRootHasActivatingContent(hoverHost)){
      var activeHasContent=irHoverRootHasActivatingContent(active);
      var activeSeen=irHoverRootActivityTime(active);
      var hostSeen=irHoverRootActivityTime(hoverHost);
      var hostChanged=hoverHost.__irContentChangedAt||0;
      var freshHostChange=hostChanged&&Date.now()-hostChanged<1200;
      if(!activeHasContent||hostSeen>=activeSeen||freshHostChange){
        return irActivateHoverRoot(hoverHost,'scan-new-active');
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
// L51 column-wrapper detection (B), L54 broadened to narrow-wrapper.
// Extracted from irRemoveInactiveHoverArtifacts so the E2E harness can
// drive ONLY the column/bar gate without triggering full sweep prune
// (which would dispose synthesised hover roots before we can inspect
// their post-gate class state).
//
// Scans visible .monaco-resizable-hover wrappers for two pillar/bar
// signatures:
//   * vertical pillar: width < 60 && height > 40
//   * horizontal bar : height < 20 && width > 200
// First match per call applies the 2-pass gate: first sighting stamps
// __irColumnSeenAt on the wrapper, ≥200ms later the second sighting
// strips our ir-keepalive/ir-sticky/ir-scrollable classes from the
// inner .monaco-hover. Transient single-frame narrow wrappers (no
// second sighting) keep their classes — VS Code hover initial paint
// passes through 16px width briefly and must not be killed.
function irScanNarrowHoverWrappers(reason){
  if(IR_HOVER_NATIVE_ONLY)return;   // L96 DEPRECATED: VS Code owns size (no column/pillar sweep). Kept for legacy.
  try{
    var cwWraps=document.querySelectorAll('.monaco-resizable-hover');
    for(var cwI=0;cwI<cwWraps.length;cwI++){
      var cwWrap=cwWraps[cwI];
      var cwStyle=cwWrap&&cwWrap.style?cwWrap.style:null;
      if(cwStyle&&(cwStyle.display==='none'||cwStyle.visibility==='hidden'))continue;
      // L80: a frozen wrapper is being held at its last-good width by a min-width
      // floor (proactive width-freeze); its rect is >=60 so it won't match the
      // column test below anyway, but skip explicitly so the reactive restore
      // never strips the floor mid-hold.
      if(cwWrap.__irWidthFrozen)continue;
      var cwRect=cwWrap.getBoundingClientRect?cwWrap.getBoundingClientRect():null;
      if(!cwRect)continue;
      var cwIsColumn=cwRect.width<60&&cwRect.height>40;
      var cwIsBar=cwRect.height<20&&cwRect.width>200;
      if(!cwIsColumn&&!cwIsBar)continue;
      var cwShape=cwIsColumn?'column':'bar';
      var cwInner=cwWrap.querySelector?cwWrap.querySelector('.monaco-hover'):null;
      var cwInnerText=cwInner&&cwInner.textContent?String(cwInner.textContent):'';
      var cwInnerClasses=[];
      try{
        if(cwInner&&cwInner.classList){
          ['ir-keepalive','ir-sticky','ir-scrollable','ir-size-medium','ir-size-small','ir-size-large','ir-empty-hover-root','ir-native-released-hover','fade-in'].forEach(function(c){
            if(cwInner.classList.contains(c))cwInnerClasses.push(c);
          });
        }
      }catch(_){}
      irHERecord('column-wrapper-detected',{
        sweepReason:String(reason||''),
        shape:cwShape,
        wrapRect:{x:Math.round(cwRect.left),y:Math.round(cwRect.top),w:Math.round(cwRect.width),h:Math.round(cwRect.height)},
        wrapHeight:cwStyle?String(cwStyle.height||''):'',
        wrapWidth:cwStyle?String(cwStyle.width||''):'',
        wrapTop:cwStyle?String(cwStyle.top||''):'',
        wrapLeft:cwStyle?String(cwStyle.left||''):'',
        wrapDisplay:cwStyle?String(cwStyle.display||''):'',
        wrapVisibility:cwStyle?String(cwStyle.visibility||''):'',
        wrapPositionedOnce:!!cwWrap.__irPositionedOnce,
        wrapHasDesired:!!cwWrap.__irDesired,
        innerTextLen:cwInnerText.length,
        innerClasses:cwInnerClasses,
        msSincePointWrap:window.__irLastPointWrapAt?(Date.now()-window.__irLastPointWrapAt):-1,
        msSinceWrap:window.__irLastWrapAt?(Date.now()-window.__irLastWrapAt):-1
      });
      // L81: backstop freeze on the sweep — the MOST-proven sighting of the 16px
      // pillar (v=233: column-wrapper-detected w:16 ×15). Freezing holds the width
      // immediately; once frozen the wrapper measures >=60 so the top-of-loop
      // __irWidthFrozen guard skips it next pass (no conflict with L79 restore). No
      // freeze without a known-good width, so a never-healthy wrapper still falls
      // through to L79 restore / class-strip below.
      if(cwShape==='column')irMaybeFreezeCollapsedWidth(cwWrap);
      var cwInnerHasOurClasses=cwInnerClasses.some(function(c){
        return c==='ir-keepalive'||c==='ir-sticky'||c==='ir-scrollable';
      });
      if(cwInnerHasOurClasses){
        var cwSeenAt=cwWrap.__irColumnSeenAt||0;
        var cwAgeMs=cwSeenAt?Date.now()-cwSeenAt:0;
        if(!cwSeenAt||cwAgeMs<200){
          try{cwWrap.__irColumnSeenAt=Date.now();}catch(_){}
        }else{
          // L79 (2026-05-30): a PERSISTENT column pillar (≥200ms, 2-pass) that
          // still holds content is a LIVE hover VS Code stuck at scrollbar width
          // — inline width:16px overrides the stylesheet min(max-content,680px),
          // so it never self-recovers (v231 timeline: pillars stuck 5.5s and up
          // to 16.7s as a 16px vertical sliver while wrapDisplay=block, content
          // present). The original remedy below (strip our keepalive classes)
          // abandons a live hover WITHOUT restoring its width — the user keeps
          // seeing the sliver. For a content-bearing column, clear the stuck
          // inline width ONCE so the stylesheet re-expands it. One-shot per
          // collapse episode (__irColumnWidthRestored, cleared by the style
          // observer on the to:normal transition) so we never fight VS Code's
          // resize frame-by-frame; an empty/stale shell, a horizontal bar, or a
          // pillar that re-collapses within 1s of a restore falls through to the
          // class-strip. Clearing width (not re-pinning top/left) avoids the
          // v=221 position-loop regression L69 guards against.
          var cwHasContent=String(cwInnerText||'').trim().length>0;
          var cwRestoredRecently=cwWrap.__irColumnWidthRestored&&(Date.now()-cwWrap.__irColumnWidthRestored<1000);
          if(cwShape==='column'&&cwHasContent&&!cwRestoredRecently){
            var cwClearedW=cwStyle?String(cwStyle.width||''):'';
            try{
              cwWrap.style.removeProperty('width');
              cwWrap.style.removeProperty('min-width');
            }catch(_){}
            try{cwWrap.__irColumnWidthRestored=Date.now();}catch(_){}
            try{delete cwWrap.__irColumnSeenAt;}catch(_){cwWrap.__irColumnSeenAt=0;}
            irHERecord('column-wrapper-width-restored',{
              sweepReason:String(reason||''),
              shape:cwShape,
              ageMs:cwAgeMs,
              innerTextLen:String(cwInnerText||'').length,
              clearedInlineW:cwClearedW,
              inlineMaxW:cwStyle?String(cwStyle.maxWidth||''):''
            });
          }else{
            try{
              if(cwInner&&cwInner.classList){
                cwInner.classList.remove(
                  'ir-keepalive','ir-sticky','ir-scrollable',
                  'ir-size-small','ir-size-medium','ir-size-large',
                  'ir-empty-hover-root','ir-native-released-hover'
                );
              }
            }catch(_){}
            try{delete cwWrap.__irColumnSeenAt;}catch(_){cwWrap.__irColumnSeenAt=0;}
            irHERecord('column-wrapper-cleaned',{
              sweepReason:String(reason||''),
              shape:cwShape,
              ageMs:cwAgeMs,
              removedInnerClasses:cwInnerClasses
            });
          }
        }
      }
      break;
    }
  }catch(_){}
}

function irRemoveInactiveHoverArtifacts(activeHover,reason){
  if(IR_HOVER_NATIVE_ONLY)return;   // L96 DEPRECATED: VS Code owns hover lifecycle (no inactive-hover sweep). Kept for legacy.
  // L38: 50ms throttle. Called on every hover switch + every prune
  // pass. A burst of activations or mutation-driven prune calls used
  // to fire this several times within a single frame — each pass does
  // a querySelectorAll over all hover roots plus per-root predicate
  // checks. Throttling to one pass per 50ms still cleans up promptly
  // (sub-frame from the user's perspective) but collapses bursts. The
  // hidden-active disposal below this guard MUST still run (it's the
  // active hover's own state and isn't subject to the throttle).
  var sweepNow=Date.now();
  var lastSweepAt=Number(window.__irLastInactiveSweepAt)||0;
  var throttled=(sweepNow-lastSweepAt)<50;
  var removed=0, artifacts=0;
  if(activeHover&&!irIsRenderableHoverRoot(activeHover)){
    irDisposeHiddenActiveHover(reason||'inactive-sweep');
    activeHover=window.__irActiveHoverEl;
  }
  if(throttled)return;
  window.__irLastInactiveSweepAt=sweepNow;
  try{
    var roots=document.querySelectorAll(IR_HOVER_ROOT_SELECTOR);
    var pendingKeepRoot=irPickPendingHoverRootToKeep(roots,activeHover);
    for(var i=0;i<roots.length;i++){
      var h=roots[i];
      if(irIsWorkbenchHoverRoot(h))continue;
      if(irRootContains(activeHover,h)||irRootContains(h,activeHover))continue;
      if(irShouldKeepRecentPendingHoverRoot(h,activeHover,pendingKeepRoot))continue;
      if(irShouldKeepRecentEmptyHoverRoot(h,activeHover,pendingKeepRoot))continue;
      irDisposeStaleHover(h,reason||'inactive-sweep');
      removed++;
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
  irScanNarrowHoverWrappers(reason);
  if((removed||artifacts)&&window.__irHoverLifecycleLogCount<120){
    window.__irHoverLifecycleLogCount++;
    irLog('renderer: inactive hover sweep '+(reason||'')+' panels='+removed+' artifacts='+artifacts+' active={'+irHoverBrief(activeHover)+'}');
  }
}
function irDisposeStaleHover(hoverEl,reason){
  if(IR_HOVER_NATIVE_ONLY)return;   // L96 DEPRECATED: VS Code owns dismiss/cleanup (no shell-clean/dispose). Kept for legacy.
  if(!hoverEl||!hoverEl.classList)return;
  if(irIsWorkbenchHoverRoot(hoverEl))return;
  var beforeBrief=irHoverBrief(hoverEl);
  try{if(hoverEl.__irStickyTimer)irClearTimer(hoverEl.__irStickyTimer)}catch(_){}
  try{if(hoverEl.__irFitFrame)cancelAnimationFrame(hoverEl.__irFitFrame)}catch(_){}
  try{irClearHoverHandleCleanup(hoverEl)}catch(_){}
  try{irClearManagedHoverVisibilityKeepalive(hoverEl)}catch(_){}
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
    // L15: same coalesce principle as L13. State mutations above are
    // idempotent (class remove, attribute remove, irMarkNativeHoverReleased
    // already self-coalesces) so they always run; only the log line is
    // suppressed when called on the same element within one frame.
    var shellCleanedLast=Number(hoverEl.__irShellCleanedAt)||0;
    var shellCleanedNow=Date.now();
    var shellLogged=shellCleanedLast && (shellCleanedNow-shellCleanedLast)<16;
    hoverEl.__irShellCleanedAt=shellCleanedNow;
    if(!shellLogged && window.__irHoverLifecycleLogCount<120){
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
  // L56 (2026-05-28): diagnose user-reported hover-position regression
  // (hover covers symbol / first hover far from symbol). Capture mouse
  // pos + wrapper rect at every active-switch, flag the two anomalies:
  //   * covers-cursor   : mouse falls inside the wrapper rect
  //   * far-from-cursor : mouse is >150px outside the wrapper rect
  if(prev!==hoverEl){
    try{
      var lastP=window.__irLastPointer;
      var hp=hoverEl&&hoverEl.closest?hoverEl.closest('.monaco-resizable-hover'):null;
      var hpRect=hp&&hp.getBoundingClientRect?hp.getBoundingClientRect():null;
      // L61 (2026-05-28): exclude drill wrappers from the anomaly scan.
      // Drill hovers are INTENTIONALLY anchored to the mouse cursor so
      // the user can stay on the link they just clicked without micro-
      // mouse-moves leaving the bbox (see comment ~line 11557 and the
      // [[feedback_mouse_anchored_drill]] rule in saved memory). For
      // drill wrappers, mouse-inside-wrapper is the desired behavior,
      // not a regression — flagging them as covers-cursor produced
      // false positives (5/24 of the L60 anomalies were our drill
      // path). Skip when the wrapper carries our drill class, has a
      // recorded desired pose, or sits under our positioned-once mark.
      var isDrillWrap=false;
      try{
        isDrillWrap=!!(hp&&hp.classList&&hp.classList.contains('ir-drill-hover'))
          ||!!(hp&&hp.__irDesired)
          ||!!(hp&&hp.__irPositionedOnce);
      }catch(_){}
      if(lastP&&hpRect&&hpRect.width>4&&hpRect.height>4&&!isDrillWrap){
        var mx=Number(lastP.x)||0;
        var my=Number(lastP.y)||0;
        var insideX=mx>=hpRect.left&&mx<=hpRect.right;
        var insideY=my>=hpRect.top&&my<=hpRect.bottom;
        var inside=insideX&&insideY;
        var dx=inside?0:(mx<hpRect.left?hpRect.left-mx:(mx>hpRect.right?mx-hpRect.right:0));
        var dy=inside?0:(my<hpRect.top?hpRect.top-my:(my>hpRect.bottom?my-hpRect.bottom:0));
        var dist=Math.round(Math.max(dx,dy));
        // L57 (2026-05-28): tightened far-from-cursor threshold from
        // 150px to 80px. L56's 150px gate captured 0 far cases over
        // 21 anomalies — too coarse to catch the "first hover far
        // from symbol" regression. 80px still excludes routine drift
        // (anchor token underline width) but catches genuine misses.
        var anomaly=inside?'covers-cursor':(dist>80?'far-from-cursor':'');
        if(anomaly){
          var rr=hoverEl.getBoundingClientRect?hoverEl.getBoundingClientRect():null;
          irHERecord('hover-position-anomaly',{
            anomaly:anomaly,
            mouse:{x:Math.round(mx),y:Math.round(my),type:String(lastP.type||'')},
            mouseAgeMs:lastP.at?Date.now()-lastP.at:-1,
            wrapRect:{x:Math.round(hpRect.left),y:Math.round(hpRect.top),w:Math.round(hpRect.width),h:Math.round(hpRect.height)},
            rootRect:rr?{x:Math.round(rr.left),y:Math.round(rr.top),w:Math.round(rr.width),h:Math.round(rr.height)}:null,
            distance:dist,
            inside:inside,
            wrapPositionedOnce:!!(hp&&hp.__irPositionedOnce),
            wrapHasDesired:!!(hp&&hp.__irDesired)
          });
          // L59 (2026-05-28): the L57 hardcoded mouse.y+24px reposition
          // was removed. L58 logs showed 11/11 covers-cursor anomalies
          // had wrapPositionedOnce=false — i.e. VS Code's own placement.
          // Nudging the wrapper top with our own offset overrode VS
          // Code's anchor logic in a way that did not always match the
          // hovered symbol either. We keep the diagnostic record above
          // so future regressions are visible, but no longer mutate
          // the wrapper from this site.
        }
      }
    }catch(_){}
  }
  irEnsureHoverPointer(hoverEl);
  irRemoveInactiveHoverArtifacts(hoverEl,'active-switch');
  irWatchHoverNativeHandles(hoverEl);
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
  irScheduleManagedHoverVisibilityKeepalive(hoverEl);
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
// L126 (2026-06-01): 24000 -> 4000. Above this, the scan wraps ONLY the viewport band
// (+ on-demand via irWrapWordAtPoint, L124); below it, it wraps the WHOLE block in one pass.
// L125's 300-line cap dropped the huge Company hover from ~57K to ~11K — under the old 24000
// it fell into the FULL-wrap path and inserted 394 .ir-type-link spans synchronously (wrapped=394
// nodes=458) = a big reflow on every show + 394 spans injected into VS Code's hover DOM = the
// "overlay 흔적 / vscode 경합 / 딜레이" the user reported. 4000 keeps capped/long hovers on the
// band+on-demand path (~30 spans) so we inject far fewer traces and stop fighting VS Code's render.
var IR_HOVER_EAGER_WRAP_MAX_TEXT=4000;
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
    if(link&&link.classList){
      link.classList.add('ir-point-active');
      irRememberTypeLinkGeometry(link,'point-active',true);
    }
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
function irRememberTypeLinkGeometry(link,reason,markRecent){
  try{
    if(!link||!link.getBoundingClientRect)return null;
    var typeName=link.getAttribute&&link.getAttribute('data-type');
    if(!typeName)return null;
    var r=link.getBoundingClientRect();
    if(!r||r.width<=0||r.height<=0)return null;
    var rec={
      left:r.left,
      top:r.top,
      right:r.right,
      bottom:r.bottom,
      width:r.width,
      height:r.height,
      at:Date.now(),
      typeName:String(typeName),
      reason:String(reason||'')
    };
    link.__irLastVisibleTypeLinkRect=rec;
    var hover=irClosestHover(link);
    var target=null;
    try{target=irPreviewTargetForLink(link)}catch(_){}
    if(hover){
      if(!hover.__irTypeLinkRects)hover.__irTypeLinkRects=[];
      hover.__irTypeLinkRects.push({link:link,typeName:String(typeName),target:target,rect:rec,at:rec.at,reason:String(reason||'')});
      if(hover.__irTypeLinkRects.length>240)hover.__irTypeLinkRects.splice(0,hover.__irTypeLinkRects.length-240);
    }
    if(markRecent){
      window.__irLastTypeLinkAtPoint={link:link,typeName:String(typeName),target:target,hover:hover,rect:rec,at:rec.at,reason:String(reason||'')};
    }
    return rec;
  }catch(_){return null}
}
function irRefreshTypeLinkGeometry(root,reason){
  try{
    if(!root||!root.querySelectorAll)return 0;
    var links=root.querySelectorAll('.ir-type-link');
    var count=0;
    for(var i=0;i<links.length;i++){
      if(irRememberTypeLinkGeometry(links[i],reason||'refresh',false))count++;
    }
    return count;
  }catch(_){return 0}
}
function irPointInsideStoredTypeLinkRect(e,rec,padX,padY){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number'||!rec)return false;
    padX=padX==null?6:padX;
    padY=padY==null?8:padY;
    return e.clientX>=rec.left-padX&&e.clientX<=rec.right+padX&&e.clientY>=rec.top-padY&&e.clientY<=rec.bottom+padY;
  }catch(_){return false}
}
function irStoredTypeLinkPointScore(e,rec){
  try{
    var cx=(rec.left+rec.right)/2;
    var cy=(rec.top+rec.bottom)/2;
    var dx=e.clientX-cx;
    var dy=e.clientY-cy;
    return Math.sqrt(dx*dx+dy*dy);
  }catch(_){return 999999}
}
function irStoredTypeLinkRecordUsable(item,now){
  try{
    if(!item||!item.link||!item.typeName||!item.rect)return false;
    if(!document.body||!document.body.contains(item.link))return false;
    if(now-(item.at||item.rect.at||0)>5500)return false;
    return true;
  }catch(_){return false}
}
function irFindRecentTypeLinkAtPoint(e,reason){
  try{
    if(!e||typeof e.clientX!=='number'||typeof e.clientY!=='number')return null;
    var now=Date.now();
    var candidates=[];
    function add(item,source){
      try{
        if(!irStoredTypeLinkRecordUsable(item,now))return;
        if(!irPointInsideStoredTypeLinkRect(e,item.rect,8,10))return;
        candidates.push({
          link:item.link,
          typeName:item.typeName,
          target:item.target||null,
          hover:item.hover||(item.link&&irClosestHover(item.link))||null,
          rect:item.rect,
          source:source,
          score:irStoredTypeLinkPointScore(e,item.rect)
        });
      }catch(_){}
    }
    add(window.__irLastTypeLinkAtPoint,'last-link');
    var activeLink=window.__irPointActiveLink&&document.body&&document.body.contains(window.__irPointActiveLink)
      ? window.__irPointActiveLink
      : null;
    if(activeLink){
      add({
        link:activeLink,
        typeName:String(activeLink.getAttribute&&activeLink.getAttribute('data-type')||''),
        target:irPreviewTargetForLink(activeLink),
        hover:irClosestHover(activeLink),
        rect:activeLink.__irLastVisibleTypeLinkRect,
        at:(activeLink.__irLastVisibleTypeLinkRect&&activeLink.__irLastVisibleTypeLinkRect.at)||0
      },'active-link');
    }
    var activeHover=window.__irActiveHoverEl&&document.body&&document.body.contains(window.__irActiveHoverEl)
      ? window.__irActiveHoverEl
      : null;
    if(activeHover&&activeHover.__irTypeLinkRects){
      for(var i=activeHover.__irTypeLinkRects.length-1;i>=0&&candidates.length<40;i--){
        add(activeHover.__irTypeLinkRects[i],'active-hover-cache');
      }
    }
    if(!candidates.length){
      var managed=document.querySelector('.monaco-hover.ir-keepalive, .monaco-editor-hover.ir-keepalive');
      if(managed&&managed.__irTypeLinkRects){
        for(var mi=managed.__irTypeLinkRects.length-1;mi>=0&&candidates.length<40;mi--){
          add(managed.__irTypeLinkRects[mi],'managed-hover-cache');
        }
      }
    }
    if(!candidates.length)return null;
    candidates.sort(function(a,b){return a.score-b.score});
    var best=candidates[0];
    window.__irLastTypeLinkAtPoint={
      link:best.link,
      typeName:best.typeName,
      target:best.target,
      hover:best.hover,
      rect:best.rect,
      at:now,
      reason:String(reason||'recovered')+'-'+best.source
    };
    if(window.__irPointerActionLogCount<140){
      window.__irPointerActionLogCount++;
      irLog('renderer: recovered link at stale hover point "'+best.typeName+'" source='+best.source+' reason='+(reason||'')+' '+irEventPointBrief(e)+' rect='+Math.round(best.rect.left)+','+Math.round(best.rect.top)+','+Math.round(best.rect.width)+'x'+Math.round(best.rect.height)+' hover={'+irHoverBrief(best.hover)+'}');
    }
    return best;
  }catch(_){return null}
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
    irRememberTypeLinkGeometry(span,'point-wrap',true);
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
    // L72 diag: stamp so width-collapse-transition can correlate a collapse
    // with a just-fired point-wrap (def-lookup) re-render.
    try{window.__irLastPointWrapAt=Date.now();}catch(_){}
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
  var joinedDefRe=/(?:^|[^A-Za-z0-9_$])(?:async)?def([A-Za-z_]\\w*)\\s*\\(/g;
  var joinedDef;
  while((joinedDef=joinedDefRe.exec(scanSrc))!==null){
    var joinedName=joinedDef[1];
    if(joinedName&&!skip[joinedName])lowerDecls.push(joinedName);
  }
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
      var text=String(codeBlocks[i].innerText||codeBlocks[i].textContent||'').trim();
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
    || s.indexOf('method_annotation')>=0
    || s.indexOf('get_owner')>=0
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
  {name:'small',width:560,height:260,maxText:900,maxLines:35,widthRatio:0.64,heightRatio:0.38},
  {name:'medium',width:680,height:360,maxText:2500,maxLines:140,widthRatio:0.68,heightRatio:0.44},
  {name:'large',width:820,height:430,maxText:Infinity,maxLines:Infinity,widthRatio:0.72,heightRatio:0.48}
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
// Position enforcement removed by user directive. VS Code's hover widget
// positions itself; we no longer nudge margin-left/margin-top to keep the
// hover in viewport. irResetHoverViewportShift stays a stub (legacy call-sites
// compile against it); irKeepHoverInViewport is re-activated below as the one
// unavoidable native-mode viewport clamp.
function irResetHoverViewportShift(_hoverEl){return}
// L98 (2026-05-31): the ONE unavoidable size management in native mode. VS Code
// owns native placement, but it does NOT re-measure the large content we inject
// (v255 balloon proved this), so we MUST keep our 48vh max-height cap. A capped
// hover that VS Code placed low has its bottom — and the scroll-end / scrollbar —
// below the viewport: the structural #1 bug. We do NOT recompute placement (that
// is irRepositionInitialHover, gated off in native); we only nudge the wrapper UP
// by the bottom overflow so it comes back on-screen. Never moves it down, never
// touches left (drill stays mouse-anchored — see feedback_mouse_anchored_drill),
// and stays entirely out of overlay mode, where irRepositionInitialHover already
// clamps and owns __irDesired (a second writer would fight its style observer).
function irKeepHoverInViewport(hoverEl){
  if(!IR_HOVER_NATIVE_ONLY)return;
  try{
    if(!hoverEl)return;
    var wrapper=(hoverEl.classList&&hoverEl.classList.contains('monaco-resizable-hover'))?hoverEl:(hoverEl.closest?hoverEl.closest('.monaco-resizable-hover'):null);
    if(!wrapper||!wrapper.getBoundingClientRect)return;
    // L109 (2026-06-01): NEVER move a drill hover. Per user directive ("드릴의 호버
    // 위치를 이동할 필요가 없어") + [[feedback_mouse_anchored_drill]], drill hovers are
    // mouse-anchored and must stay where placed. Beyond honoring that: the clamp's
    // wrapper.getBoundingClientRect() below forces a SYNCHRONOUS layout of the drill
    // content, and a drilled class preview can be ~295K chars (v=274 log: prev=294875)
    // — that reflow is multi-second and compounds VS Code's own tokenization freeze
    // (the 4064/2720/1609ms longtasks). Bail on the cheap class/flag check BEFORE any
    // rect read so drill hovers cost zero layout here.
    if((wrapper.classList&&wrapper.classList.contains('ir-drill-hover'))||wrapper.__irDesired)return;
    var rect=wrapper.getBoundingClientRect();
    // Same collapse contract used everywhere (width<60 column || height<20 bar):
    // never clamp a transient 16px sliver or a 0x0 mid-swap shell.
    if(rect.width<60||rect.height<20)return;
    var margin=8;
    var viewportH=(window.innerHeight||document.documentElement.clientHeight||900);
    var overflow=rect.bottom-(viewportH-margin);
    if(overflow<2)return;   // bottom already on-screen (2px slack avoids sub-pixel churn)
    // Don't push the top off the TOP edge: a hover taller than the usable height
    // can't fully fit, so nudge only as far as the top margin and let the inner
    // scroller cover the remainder.
    var shift=Math.min(overflow,rect.top-margin);
    if(shift<=0)return;
    // style.top is a SCREEN coordinate for this wrapper (irRepositionInitialHover
    // sets it from editorRect.top+visible.top), so screen-top - shift IS the new
    // style.top. Use the live rect.top rather than the possibly-stale inline value.
    var newTop=Math.round(rect.top-shift);
    if(newTop<margin)newTop=margin;
    var prevTop=parseInt(wrapper.style.top,10);
    if(prevTop===newTop)return;   // idempotent — already clamped here this episode
    wrapper.style.top=newTop+'px';
    // Drill hovers re-apply __irDesired inside the wrapped _resizableNode.layout()
    // (L24); update it too so the clamp sticks instead of being snapped back to
    // the off-screen top on the next layout pass.
    if(wrapper.__irDesired)wrapper.__irDesired.top=newTop;
    irHERecord('hover-viewport-clamp',{
      from:isNaN(prevTop)?null:prevTop,to:newTop,
      shift:Math.round(shift),overflow:Math.round(overflow),
      rect:{top:Math.round(rect.top),bottom:Math.round(rect.bottom),h:Math.round(rect.height)},
      viewportH:viewportH,drill:!!wrapper.__irDesired
    });
  }catch(_){}
}
function irScheduleHoverViewportFit(hoverEl){
  if(!hoverEl)return;
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
}
function irMeasureNaturalHoverContentHeight(hoverEl){
  if(!hoverEl)return 0;
  try{
    var sc=irPrimaryHoverScroller(hoverEl);
    var content=hoverEl.querySelector?hoverEl.querySelector('.monaco-hover-content'):null;
    var natural=0;
    if(sc&&typeof sc.scrollHeight==='number')natural=Math.max(natural,sc.scrollHeight);
    if(content&&typeof content.scrollHeight==='number')natural=Math.max(natural,content.scrollHeight);
    var blocks=hoverEl.querySelectorAll?hoverEl.querySelectorAll('.rendered-markdown'):[];
    var blockSum=0;
    for(var bi=0;bi<blocks.length;bi++){
      var b=blocks[bi];
      if(!b||!b.getBoundingClientRect)continue;
      var br=b.getBoundingClientRect();
      if(br&&br.height>0)blockSum+=br.height;
    }
    if(blockSum>natural)natural=blockSum;
    return Math.ceil(natural);
  }catch(_){return 0}
}
function irApplyMeasuredHoverHeight(hoverEl,cap){
  if(!hoverEl||!cap)return null;
  try{
    var sc=irPrimaryHoverScroller(hoverEl);
    var natural=irMeasureNaturalHoverContentHeight(hoverEl);
    // Outer needs to hold scroller plus any padding/margin that sits between
    // outer and scroller. Compute the gap once via current bounding rects.
    var paddingGap=0;
    if(sc&&hoverEl.getBoundingClientRect&&sc.getBoundingClientRect){
      var hr=hoverEl.getBoundingClientRect();
      var sr=sc.getBoundingClientRect();
      paddingGap=Math.max(0,Math.round((hr.height||0)-(sr.height||0)));
    }
    var desired=Math.min(cap,Math.max(40,natural+paddingGap));
    hoverEl.style.setProperty('--ir-hover-height',desired+'px');
    hoverEl.__irMeasuredOuterHeight=desired;
    hoverEl.__irMeasuredInnerNatural=natural;
    if(window.__irMeasureLogCount===undefined)window.__irMeasureLogCount=0;
    if(window.__irMeasureLogCount<40){
      window.__irMeasureLogCount++;
      irLog('renderer: measure-hover-height natural='+natural+' paddingGap='+paddingGap+' cap='+cap+' desired='+desired);
    }
    return desired;
  }catch(_){return null}
}
function irMeasureAndFitHoverHeight(hoverEl,cap,resetScroll){
  if(!hoverEl)return;
  // Schedule on rAF so VS Code's content insertion / our DOM tweaks have time
  // to lay out before we measure the natural inner height.
  try{
    if(hoverEl.__irMeasureFrame)cancelAnimationFrame(hoverEl.__irMeasureFrame);
    hoverEl.__irMeasureFrame=requestAnimationFrame(function(){
      hoverEl.__irMeasureFrame=0;
      if(!document.body.contains(hoverEl))return;
      irApplyMeasuredHoverHeight(hoverEl,cap);
      if(resetScroll){
        try{hoverEl.scrollTop=0}catch(_){}
        var sc=irPrimaryHoverScroller(hoverEl);
        try{if(sc)sc.scrollTop=0}catch(_){}
      }
      irLogHoverBoxCorners(hoverEl,'measured-height');
    });
  }catch(_){irApplyMeasuredHoverHeight(hoverEl,cap)}
}

function irApplyHoverSizeTier(hoverEl,fallbackTextLength,resetScroll){
  if(!hoverEl)return null;
  var tier=irPickHoverSizeTier(hoverEl,fallbackTextLength);
  hoverEl.classList.remove('ir-size-small','ir-size-medium','ir-size-large');
  hoverEl.classList.add('ir-size-'+tier.name);
  // No size enforcement. The DOM parent chain handles containment: outer has
  // overflow:hidden so children are visually clipped to outer; the scroller
  // has overflow:auto so oversized content scrolls inside outer. We do not
  // set width/height/min-*/max-* on any element. VS Code decides the outer
  // size; everything inside flows from that via natural CSS containment.
  hoverEl.style.removeProperty('width');
  hoverEl.style.removeProperty('height');
  hoverEl.style.removeProperty('min-width');
  hoverEl.style.removeProperty('min-height');
  hoverEl.style.removeProperty('max-width');
  hoverEl.style.removeProperty('max-height');
  hoverEl.style.removeProperty('--ir-hover-width');
  hoverEl.style.removeProperty('--ir-hover-height');
  hoverEl.style.boxSizing='border-box';
  var sc=irPrimaryHoverScroller(hoverEl);
  if(sc){
    sc.style.removeProperty('width');
    sc.style.removeProperty('height');
    sc.style.removeProperty('min-width');
    sc.style.removeProperty('min-height');
    sc.style.removeProperty('max-width');
    sc.style.removeProperty('max-height');
    if(resetScroll)sc.scrollTop=0;
  }
  var hContent=hoverEl.querySelector('.monaco-hover-content');
  if(hContent){
    hContent.style.removeProperty('width');
    hContent.style.removeProperty('height');
    hContent.style.removeProperty('min-width');
    hContent.style.removeProperty('min-height');
    hContent.style.removeProperty('max-width');
    hContent.style.removeProperty('max-height');
  }
  var wrappers=hoverEl.querySelectorAll('.hover-row,.hover-row-contents,.hover-contents,.markdown-hover,.rendered-markdown');
  for(var wi=0;wi<wrappers.length;wi++){
    wrappers[wi].style.removeProperty('width');
    wrappers[wi].style.removeProperty('height');
    wrappers[wi].style.removeProperty('min-width');
    wrappers[wi].style.removeProperty('min-height');
    wrappers[wi].style.removeProperty('max-width');
    wrappers[wi].style.removeProperty('max-height');
  }
  irScheduleHoverNativeHandleCleanup(hoverEl,true);
  irFlattenNestedScrollLayers(hoverEl);
  if(resetScroll)hoverEl.scrollTop=0;
  if(hoverEl.__irSizeTierName!==tier.name){
    hoverEl.__irSizeTierName=tier.name;
  }
  irScheduleHoverViewportFit(hoverEl);
  irLogHoverBoxCorners(hoverEl,'size-tier-'+tier.name);
  return tier;
}

function irTypeLinkClick(e){
  var directLink=irClosestTypeLink(e.target);
  var wrappedLink=null;
  if(!directLink)wrappedLink=irWrapWordAtPoint(e);
  var recoveredLink=null;
  var link=directLink||wrappedLink;
  if(!link)recoveredLink=irFindRecentTypeLinkAtPoint(e,'click-capture');
  if(!link&&recoveredLink)link=recoveredLink.link;
  irLogPointerActionTrace(e,'click-capture',link,directLink?'direct':(wrappedLink?'wrapped':(recoveredLink?'recovered-'+recoveredLink.source:'none')));
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
  if(recoveredLink&&recoveredLink.target)window.__irLastPreviewTarget=recoveredLink.target;
  irRunTypeLinkAction(link,e,'click');
}
track(window,'click',irTypeLinkClick,true);
track(document,'click',irTypeLinkClick,true);

function irClosestBackControl(target){
  var el=irEventElement(target);
  if(!el||!el.closest)return null;
  return el.closest('.ir-back-btn,a[href*="intellisenseRecursion.previewBack"],a[data-href*="intellisenseRecursion.previewBack"]');
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
  if(IR_HOVER_NATIVE_ONLY)return;   // L89: keep VS Code's native hover sizing/scroll
  if(!hoverEl)return;
  try{
    // L31: throttle entire-body executions. A drill mutation burst calls
    // this 7+ times in ~10ms; each pass did a forced reflow + window
    // resize dispatch, draining frame time. resetScroll=true calls are
    // exempt (explicit user-driven reset must not be skipped).
    var nowMS=Date.now();
    var lastAt=Number(hoverEl.__irMakeScrollAt)||0;
    if(!resetScroll && lastAt && (nowMS-lastAt)<16){
      irEnsureHoverPointer(hoverEl);
      irSetActiveHoverLayer(hoverEl);
      return;
    }
    hoverEl.__irMakeScrollAt=nowMS;
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
    // L31 revised: scrollHeight + offsetHeight reads ARE needed — they
    // commit the styles applyHoverSizeTier just wrote into layout so the
    // internal scroller actually becomes scrollable. Removing them
    // (initial L30) broke wheel scrolling on large hovers entirely. We
    // keep them but the entry-throttle above already prevents the
    // mutation-burst frame drop.
    try { var _=hoverEl.scrollHeight; var __=hoverEl.offsetHeight; } catch(_) {}
    // resize dispatch still throttled — fan-out across all listeners
    // does not need to fire once per mutation tick.
    var nowResize=Date.now();
    var lastResizeAt=Number(window.__irLastHoverResizeAt)||0;
    if(nowResize-lastResizeAt>500){
      window.__irLastHoverResizeAt=nowResize;
      try { window.dispatchEvent(new Event('resize')); } catch(_) {}
    }
    hoverEl.__irScrollableSignature=scrollSignature;
  }catch(_){}
}
window.irHoverBoxCornerSnapshot=irHoverBoxCornerSnapshot;
window.__irTestHooks={
  primaryHoverScroller:irPrimaryHoverScroller,
  makeHoverScrollable:irMakeHoverScrollable,
  setActiveHoverLayer:irSetActiveHoverLayer,
  activateHoverRoot:irActivateHoverRoot,
  refreshEmptyHoverRootState:irRefreshEmptyHoverRootState,
  applyHoverSizeTier:irApplyHoverSizeTier,
  hoverBoxCornerSnapshot:irHoverBoxCornerSnapshot,
  disposeStaleHover:irDisposeStaleHover,
  removeInactiveHoverArtifacts:irRemoveInactiveHoverArtifacts,
  scanNarrowHoverWrappers:irScanNarrowHoverWrappers,
  pruneDetachedHoverState:irPruneDetachedHoverState,
  buildMdDom:irBuildMdDom,
  decodeContent:irDecodeContent,
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
    var hasPreviewHistory=!!((window.__irHistory||[]).length);
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
  var prePruneTarget=irNormalizePreviewTarget(window.__irLastPreviewTarget);
  var prePruneHover=prePruneTarget&&prePruneTarget.closest?prePruneTarget.closest('.monaco-hover, .monaco-editor-hover'):null;
  if(prePruneHover&&document.body&&document.body.contains(prePruneHover)
    &&irHoverHasManagedContent(prePruneHover)&&!irIsRenderableHoverRoot(prePruneHover)){
    irForcePreviewHoverVisible(prePruneHover,'apply-pre-prune');
  }
  irPruneDetachedHoverState();
  var target=irNormalizePreviewTarget(window.__irLastPreviewTarget);
  var src='stored';
  if((!target||!document.body.contains(target))&&prePruneTarget&&document.body&&document.body.contains(prePruneTarget)){
    target=prePruneTarget;
    src='pre-prune';
  }
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
    if(outerHover)irRememberPreviewTransitionRect(outerHover,'preview-apply-before-layout');
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
    if(outerHover&&!window.__irSuppressPreviewBackButtonOnce)irEnsurePreviewBackButton(outerHover,target);
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
        try{
          var anchorPoint=hoverEl.__irAnchorPoint||null;
          if(anchorPoint&&typeof anchorPoint.x==='number'&&typeof anchorPoint.y==='number'){
            irPlacePreviewHoverNearPointer(hoverEl,anchorPoint.x,anchorPoint.y,'preview-anchor');
          }
        }catch(_){}
        if(!irIsRenderableHoverRoot(hoverEl))irForcePreviewHoverVisible(hoverEl,'preview-layout-after-size');
        irSetActiveHoverLayer(hoverEl);
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

function irPlacePreviewHoverNearPointer(root,x,y,reason){
  try{
    if(!root||!root.style||typeof x!=='number'||typeof y!=='number'||!Number.isFinite(x)||!Number.isFinite(y))return false;
    var vw=window.innerWidth||1200;
    var vh=window.innerHeight||800;
    var rect=root.getBoundingClientRect?root.getBoundingClientRect():null;
    var width=Math.max(320,Math.min(rect&&rect.width>40?rect.width:560,Math.floor(vw*0.76)));
    var height=Math.max(160,Math.min(rect&&rect.height>40?rect.height:260,Math.floor(vh*0.52)));
    var gap=14;
    var left=x+gap;
    if(left+width>vw-12)left=x-width-gap;
    left=Math.max(12,Math.min(left,vw-width-12));
    var top=y+24;
    if(top+height>vh-12)top=y-height-24;
    top=Math.max(12,Math.min(top,vh-height-12));
    root.style.setProperty('position','fixed','important');
    root.style.setProperty('left',Math.round(left)+'px','important');
    root.style.setProperty('top',Math.round(top)+'px','important');
    root.style.removeProperty('right');
    root.style.removeProperty('bottom');
    root.style.removeProperty('margin-left');
    root.style.removeProperty('margin-top');
    root.__irViewportShiftX=0;
    root.__irViewportShiftY=0;
    irRememberVisibleHoverRect(root,reason||'fallback-place');
    return true;
  }catch(_){return false}
}

function irPickReusableNativeHoverTarget(identifier){
  try{
    var roots=Array.prototype.slice.call(document.querySelectorAll('.monaco-hover,.monaco-editor-hover'));
    var best=null;
    var bestScore=-1;
    for(var i=0;i<roots.length;i++){
      var root=roots[i];
      if(!root||!document.body.contains(root)||!irIsNativeHoverRoot(root))continue;
      if(root.getAttribute&&root.getAttribute('data-ir-forced-hover')==='1')continue;
      var text=String(root.textContent||'');
      if(!text.trim())continue;
      if(identifier&&text.indexOf(identifier)>=0)continue;
      var target=irStoredPreviewTarget(root);
      if(!target){
        var blocks=root.querySelectorAll?root.querySelectorAll('.rendered-markdown'):[];
        for(var bi=blocks.length-1;bi>=0;bi--){
          if(String(blocks[bi].textContent||'').trim()){
            target=irNormalizePreviewTarget(blocks[bi])||blocks[bi];
            break;
          }
        }
      }
      if(!target||!root.contains(target))continue;
      var visibility=irHoverRootVisibility(root);
      var rect=root.getBoundingClientRect?root.getBoundingClientRect():null;
      var released=!!(root.getAttribute&&root.getAttribute('data-ir-native-released-hover')==='1')
        || !!(root.classList&&root.classList.contains('ir-native-released-hover'));
      var hidden=!(visibility&&visibility.visible);
      var collapsed=!rect||rect.width<=4||rect.height<=4;
      var activeVisible=root===window.__irActiveHoverEl&&visibility&&visibility.visible&&!collapsed;
      var managed=!!(root.classList&&(
        root.classList.contains('ir-keepalive')
        || root.classList.contains('ir-scrollable')
        || root.classList.contains('ir-sticky')
      ));
      if(activeVisible){
        if(window.__irHoverLifecycleLogCount<120){
          window.__irHoverLifecycleLogCount++;
          irLog('renderer: native hover fallback reuse rejected active visible shell identifier="'+identifier+'" hover={'+irHoverBrief(root)+'}');
        }
        continue;
      }
      if(!released&&!hidden&&!collapsed)continue;
      var score=(released?1000:0)+(hidden?300:0)+(collapsed?200:0)+Math.min(80,text.length/10);
      if(score>bestScore){
        bestScore=score;
        best={root:root,target:target,score:score,released:released,hidden:hidden,collapsed:collapsed,managed:managed,textLength:text.length};
      }
    }
    return best;
  }catch(_){return null}
}

function irApplyFallbackIntoReusableNativeHover(identifier,md,opts,x,y){
  try{
    var source=String(opts&&opts.source||'');
    // first/pos-cache/native-only are expected to be satisfied by VS Code's
    // real hover widget. Reusing a hidden/collapsed shell here creates a
    // degraded preview and can short-circuit the native refire path.
    if(/^(first|pos-cache|native-only)$/.test(source)){
      return {ok:false,reason:'reusable-native-disabled-for-native-source',patchVersion:Number(window.__irPatchVersion)||0};
    }
    if(typeof window.irApplyPreview!=='function')return null;
    var picked=irPickReusableNativeHoverTarget(identifier);
    if(!picked||!picked.root||!picked.target)return null;
    var root=picked.root;
    var target=picked.target;
    try{
      if(root.__irReleaseRemoveTimer){
        irClearTimer(root.__irReleaseRemoveTimer);
        root.__irReleaseRemoveTimer=null;
      }
    }catch(_){}
    root.__irReleasedAt=0;
    root.__irReleasedText='';
    root.__irNativeFallbackAppliedAt=Date.now();
    root.__irAnchorPoint={x:x,y:y,at:Date.now(),identifier:identifier};
    if(root.classList){
      root.classList.remove('hidden','ir-native-released-hover','ir-stale-hover','ir-empty-hover-root');
    }
    if(root.removeAttribute){
      root.removeAttribute('data-ir-native-released-hover');
      root.removeAttribute('data-ir-empty-hover-root');
      root.removeAttribute('aria-hidden');
      root.removeAttribute('hidden');
    }
    if(root.style){
      root.style.setProperty('display','block','important');
      root.style.setProperty('visibility','visible','important');
      root.style.setProperty('opacity','1','important');
      root.style.setProperty('pointer-events','auto','important');
    }
    irResetNativeHoverMutations(root);
    if(root.style){
      root.style.setProperty('display','block','important');
      root.style.setProperty('visibility','visible','important');
      root.style.setProperty('opacity','1','important');
      root.style.setProperty('pointer-events','auto','important');
    }
    irForcePreviewHoverVisible(root,'fallback-reuse-before');
    irPlacePreviewHoverNearPointer(root,x,y,'fallback-reuse-before');
    window.__irLastPreviewTarget=target;
    var prevSuppressBack=window.__irSuppressPreviewBackButtonOnce;
    window.__irSuppressPreviewBackButtonOnce=true;
    var applied=false;
    try{
      applied=window.irApplyPreview(identifier,md,false) !== false;
    }finally{
      window.__irSuppressPreviewBackButtonOnce=prevSuppressBack;
    }
    if(!applied){
      window.__irLastPreviewTarget=null;
      return {ok:false,reason:'reusable-native-apply-failed',patchVersion:Number(window.__irPatchVersion)||0};
    }
    irPlacePreviewHoverNearPointer(root,x,y,'fallback-reuse-after');
    irMarkHoverManaged(root,true);
    if(!irIsRenderableHoverRoot(root))irForcePreviewHoverVisible(root,'fallback-reuse-after');
    irSetActiveHoverLayer(root);
    try{irScheduleScan()}catch(_){}
    var rect=root.getBoundingClientRect?root.getBoundingClientRect():null;
    if(window.__irHoverLifecycleLogCount<120){
      window.__irHoverLifecycleLogCount++;
      irLog('renderer: native hover fallback reused shell identifier="'+identifier+'" source='+(opts&&opts.source||'')+' picked={score='+picked.score+' released='+(picked.released?'1':'0')+' hidden='+(picked.hidden?'1':'0')+' collapsed='+(picked.collapsed?'1':'0')+' managed='+(picked.managed?'1':'0')+' textLen='+picked.textLength+'} hover={'+irHoverBrief(root)+'}');
    }
    return {
      ok:true,
      created:false,
      refired:false,
      applied:true,
      reason:'reused-native-hover-shell',
      identifier:identifier,
      textLength:String(root.textContent||'').length,
      rect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,
      patchVersion:Number(window.__irPatchVersion)||0
    };
  }catch(eApply){
    return {ok:false,reason:'reusable-native-error:'+String(eApply&&eApply.message||eApply),patchVersion:Number(window.__irPatchVersion)||0};
  }
}

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
    if(!forceNativeReplace){
      if(!pointerFresh){
        return {ok:false,created:false,reason:'stale-pointer',identifier:identifier,patchVersion:Number(window.__irPatchVersion)||0};
      }
      if(pointHover){
        return {ok:false,created:false,reason:'pointer-inside-hover',identifier:identifier,token:pointToken,patchVersion:Number(window.__irPatchVersion)||0};
      }
      if(pointToken&&identifier&&pointToken!==identifier){
        return {ok:false,created:false,reason:'pointer-token-mismatch:'+pointToken,identifier:identifier,token:pointToken,patchVersion:Number(window.__irPatchVersion)||0};
      }
      if(!pointToken&&/^(first|pos-cache|native-only)$/.test(String(opts.source||''))){
        return {ok:false,created:false,reason:'missing-pointer-token',identifier:identifier,patchVersion:Number(window.__irPatchVersion)||0};
      }
    }
    if(!forceNativeReplace){
      var reusableApply=irApplyFallbackIntoReusableNativeHover(identifier,md,opts,x,y);
      if(reusableApply&&reusableApply.ok)return reusableApply;
      if(reusableApply&&reusableApply.reason&&window.__irHoverLifecycleLogCount<120){
        window.__irHoverLifecycleLogCount++;
        irLog('renderer: native hover fallback reuse skipped identifier="'+identifier+'" source='+(opts.source||'')+' reason='+reusableApply.reason);
      }
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
          if(oldHiddenText.trim()&&identifier&&oldHiddenText.indexOf(identifier)<0){
            if(window.__irActiveHoverEl===rootOld)window.__irActiveHoverEl=null;
            try{
              if(rootOld.__irReleaseRemoveTimer){
                irClearTimer(rootOld.__irReleaseRemoveTimer);
                rootOld.__irReleaseRemoveTimer=null;
              }
              rootOld.__irReleasedAt=0;
              rootOld.__irReleasedText='';
              if(rootOld.parentNode){
                rootOld.parentNode.removeChild(rootOld);
              }else if(!IR_HOVER_NATIVE_ONLY){
                // L101 (2026-05-31) DEPRECATED in native: marking a detached/reused root
                // hidden+released was the LAST ungated writer of release state. It drove the
                // release<->revive churn (irTouchHoverRootContent un-hides on the next content
                // change -> content length oscillated 57638<->59293 -> VS Code re-tokenized the
                // 57K preview = 1603ms longtasks + re-scan storm) AND left VS Code's reused
                // single hover wrapper stuck-hidden when it re-showed the SAME content (the
                // "skip unchanged released native hover" path = a short class hover renders
                // nothing). With both this and irMarkNativeHoverReleased gated, NO root carries
                // ir-native-released-hover in native, so the whole revive/skip-unchanged
                // subsystem goes inert. VS Code owns visibility/dismiss.
                if(rootOld.classList)rootOld.classList.add('hidden','ir-native-released-hover');
                if(rootOld.setAttribute)rootOld.setAttribute('data-ir-native-released-hover','1');
                if(rootOld.style){
                  rootOld.style.setProperty('display','none','important');
                  rootOld.style.setProperty('visibility','hidden','important');
                  rootOld.style.setProperty('opacity','0','important');
                  rootOld.style.setProperty('pointer-events','none','important');
                }
              }
            }catch(_){}
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
            if(rootOld.classList)rootOld.classList.remove('ir-native-released-hover','ir-scrollable','ir-sticky','ir-size-small','ir-size-medium','ir-size-large','ir-keepalive');
            if(rootOld.removeAttribute){
              rootOld.removeAttribute('data-ir-native-released-hover');
            }
            if(rootOld.style){
              rootOld.style.removeProperty('pointer-events');
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
// L75 (2026-05-29): DISABLED as a test (suspected cause of size-collapse / "내용 안보임").
// L105 (2026-06-01): RE-ENABLED with the two fixes the L75 note itself prescribed
// ("dedupe BEFORE paint / once per content, not every scan"). MEASURED need: drilling
// into a large class accumulated DUPLICATE preview copies (one per mouseover over the
// drilled hover, up to 7 copies = 412825 chars) → a 10.3s main-thread tokenize freeze
// ("폭주"). Nothing removed them because this dedup was off. The original concerns are
// addressed so the re-enable is safe:
//   (a) per-scan regex cost — irDedupeHoverContent now early-outs unless the block set
//       changed since the last pass (cheap count+length signature, no regex), so it runs
//       once per content change instead of every storm scan.
//   (c) size-fighting side-effect — irKeepMouseInsideWrapperAfterDedupe is gated OFF in
//       native mode (VS Code owns size/position; cf. [[feedback_vscode_owns_hover_height]]).
//   (b) "eats content" — it only removes blocks whose NORMALIZED text is byte-identical
//       to an earlier block (true duplicates, e.g. the repeated class copies). Real
//       distinct content is never equal-keyed.
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
    // L105 (2026-06-01): only do the regex-heavy normalize when the block set
    // actually changed since the last pass — the scan re-fires many times/sec on
    // a drilled hover. Cheap signature (block count + last block text length); no
    // regex, no full-host textContent read.
    var lastBlk=blocks[blocks.length-1];
    var dedupeSig=blocks.length+':'+((lastBlk&&lastBlk.textContent)?lastBlk.textContent.length:0);
    if(hoverHost.__irLastDedupeSig===dedupeSig)return;
    hoverHost.__irLastDedupeSig=dedupeSig;
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
    if(removed){
      // L105: reliable (un-throttled) record so the drill-accumulation fix is verifiable.
      try{irHERecord('hover-dedupe-removed',{removed:removed,blocks:blocks.length});}catch(_){}
    }
    // L26: after dedup the wrapper may have shrunk and the user's mouse
    // may now be outside its bounds — next mousemove would mouseleave the
    // hover and dismiss it. Slide the wrapper toward the mouse so the
    // cursor stays at least pad px inside. Active drill wrappers also
    // need __irDesired updated so the layout/style observers (L23, L24)
    // restore to this safer pose rather than dragging back to the pre-
    // shrink desired position.
    if(removed&&!IR_HOVER_NATIVE_ONLY)irKeepMouseInsideWrapperAfterDedupe(hoverHost);   // L105: native owns size/position — don't nudge the wrapper
  }catch(_){}
}
function irKeepMouseInsideWrapperAfterDedupe(hoverHost){
  try{
    if(!hoverHost)return;
    var wrapperEl=hoverHost.closest&&hoverHost.closest('.monaco-resizable-hover');
    if(!wrapperEl||!wrapperEl.getBoundingClientRect)return;
    var mp=window.__irLastPointer;
    if(!mp||typeof mp.x!=='number'||typeof mp.y!=='number')return;
    // Force layout flush: getBoundingClientRect reads post-DOM-removal rect.
    var r=wrapperEl.getBoundingClientRect();
    if(r.width<20||r.height<20)return;
    var pad=8;
    var mx=mp.x,my=mp.y;
    var nx=r.left,ny=r.top,nw=r.width,nh=r.height;
    var newLeft=nx,newTop=ny;
    var shifted=false;
    if(mx<nx+pad){newLeft=mx-pad;shifted=true;}
    else if(mx>nx+nw-pad){newLeft=mx-nw+pad;shifted=true;}
    if(my<ny+pad){newTop=my-pad;shifted=true;}
    else if(my>ny+nh-pad){newTop=my-nh+pad;shifted=true;}
    if(!shifted)return;
    // Viewport clamp.
    var vw=window.innerWidth||document.documentElement.clientWidth||1440;
    var vh=window.innerHeight||document.documentElement.clientHeight||900;
    if(newLeft+nw>vw)newLeft=vw-nw-2;
    if(newLeft<2)newLeft=2;
    if(newTop+nh>vh)newTop=vh-nh-2;
    if(newTop<2)newTop=2;
    var rTop=Math.round(newTop);
    var rLeft=Math.round(newLeft);
    if(rTop===Math.round(ny)&&rLeft===Math.round(nx))return;
    wrapperEl.style.top=rTop+'px';
    wrapperEl.style.left=rLeft+'px';
    // Drill wrappers: update __irDesired so L23/L24 don't drag back.
    if(wrapperEl.__irDesired){
      wrapperEl.__irDesired={top:rTop,left:rLeft,at:Date.now()};
    }
    if(window.__irWrapLogCount<20){
      window.__irWrapLogCount++;
      irLog('renderer: dedupe-mouse-safe-shift mouse='+mx+','+my+' from='+Math.round(nx)+','+Math.round(ny)+' to='+rLeft+','+rTop+' size='+Math.round(nw)+'x'+Math.round(nh));
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

// Initialized eagerly so users can inspect window.__irUnwrappedHoverKeys /
// window.__irUnwrappedHoverLog at any time, even before any unwrapped hover
// has been seen. Empty arrays/objects mean "diagnostic active, nothing yet".
if(!window.__irUnwrappedHoverKeys)window.__irUnwrappedHoverKeys={};
if(!window.__irUnwrappedHoverLog)window.__irUnwrappedHoverLog=[];
if(window.__irUnwrappedHoverLogCount===undefined)window.__irUnwrappedHoverLogCount=0;
function irDiagnoseUnwrappedHovers(){
  // Track hovers that exist with content but NO .monaco-resizable-hover
  // ancestor — those get clamped to 0×0 by our gate, so they never paint.
  // Each unique content snippet is recorded once in window.__irUnwrappedHoverLog
  // with timestamp + brief; users can inspect interactively.
  try{
    var hovers=document.querySelectorAll('.monaco-hover, .monaco-editor-hover');
    for(var i=0;i<hovers.length;i++){
      var h=hovers[i];
      if(!h||!document.body.contains(h))continue;
      var text=String(h.textContent||'').replace(/\s+/g,' ').trim();
      if(text.length<10)continue;
      var hasWrap=!!(h.closest&&h.closest('.monaco-resizable-hover'));
      if(hasWrap)continue;
      var key=text.length+':'+text.slice(0,40);
      if(window.__irUnwrappedHoverKeys[key])continue;
      var stamp=Date.now();
      window.__irUnwrappedHoverKeys[key]=stamp;
      var entry={
        at:stamp,
        textLength:text.length,
        textSample:text.slice(0,180),
        className:String(h.className||'').slice(0,200),
        rect:(function(){
          try{var r=h.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};}
          catch(_){return null;}
        })()
      };
      window.__irUnwrappedHoverLog.push(entry);
      if(window.__irUnwrappedHoverLog.length>80)window.__irUnwrappedHoverLog.shift();
      if(window.__irUnwrappedHoverLogCount<40){
        window.__irUnwrappedHoverLogCount++;
        irLog('renderer: unwrapped hover detected (no .monaco-resizable-hover ancestor) text="'+text.slice(0,120)+'"');
      }
    }
  }catch(_){}
}
function irAlignResizableHoverToChild(){
  // No-op for now: both prior directions (wrapper-follows-child and child-
  // follows-wrapper) ended up mispositioning hovers in real interactive use.
  // We let VS Code position whatever it positions; visible hover is wherever
  // .monaco-hover paints, wrapper is wherever VS Code put it. Box-corner
  // assertions in tests may then report a delta — that's expected until we
  // find a position model that doesn't fight VS Code's internal logic.
  return;
}
// L32: visibility gate. A 57K-char drill hover may contain dozens of
// .rendered-markdown blocks but the viewport only ever shows ~10 of
// them. Processing offscreen blocks costs the full textContent read
// + token regex + DOM wrap per block; user-reported scroll lag on
// large drill hovers traces to this O(N) walk over every block on
// every scan tick. Skip a block when its rect falls outside the hover
// host viewport plus a 400 px lookahead margin (covers fast scrolls
// before the scroll listener re-fires).
function irIsBlockVisibleInHover(block,hoverHost){
  if(!block||!hoverHost||!block.getBoundingClientRect||!hoverHost.getBoundingClientRect)return true;
  try{
    var br=block.getBoundingClientRect();
    var hr=hoverHost.getBoundingClientRect();
    // L94 (2026-05-31): height<10 = hover either still FORMING (briefly 0 before layout) or already
    // DISMISSED/collapsed (reused 0x0 singleton). Returning true for both kept re-scanning a
    // dismissed big hover's off-screen blocks forever (scan -> wrap -> mutation -> re-scan loop),
    // burning CPU after the hover was dismissed. Only treat as forming (don't skip) when content
    // changed very recently; otherwise it's dismissed -> skip so the scan stops evaluating it.
    if(hr.height<10){
      var __ccAt=hoverHost.__irContentChangedAt||0;
      if(__ccAt&&(Date.now()-__ccAt)<1000)return true;   // forming: allow the first scan after content arrives
      return false;                                       // dismissed/collapsed: stop evaluating off-screen blocks
    }
    var margin=400;
    if(br.bottom<hr.top-margin)return false;
    if(br.top>hr.bottom+margin)return false;
    return true;
  }catch(_){return true}
}
// L107 (2026-06-01): debounce window for the scroll-driven wrap re-scan. A
// continuous wheel scroll of a huge drill hover fires one 'scroll' per tick
// (~25-30/sec); without this the scan re-ran the full block each tick. 140ms >
// a wheel tick (~16-33ms) so a settling gesture coalesces to ONE pass, yet is
// short enough that drill links appear effectively instantly once the user stops.
var IR_HOVER_SCROLL_SCAN_DEBOUNCE_MS=140;
function irEnsureHoverScrollListener(hoverHost){
  if(!hoverHost||hoverHost.__irScrollListenerAttached)return;
  // L124 (2026-06-01): native mode no longer re-scans on scroll. The scroll-driven
  // band-wrap (re-arm __irViewportWrap + re-scan to wrap newly-visible rows) was an
  // 18x/session re-scan STORM on huge hovers: each settle TreeWalked the block, rect-read
  // every text node to find the viewport band, and inserted .ir-type-link spans -> VS Code
  // reflow -> 100-573ms longtask. It is REDUNDANT: drill works on-demand. irHoverGuard
  // (pointer-move, L114) and irTypeLinkPointerDown (click, L94) both call irWrapWordAtPoint,
  // which validates against the candidate set the INITIAL scan already built for the WHOLE
  // block (not just the visible band) - so a row scrolled into view gets its drill link the
  // moment the pointer touches it. The initial visible-band wrap still runs on open (so the
  // hover shows links for what is on screen). Net: scroll storm + scroll-wrap reflows gone,
  // drill unchanged. cf. project_drill_cpu_wheel_rescan (this supersedes L107/L115's scroll scan).
  if(IR_HOVER_NATIVE_ONLY){hoverHost.__irScrollListenerAttached=true;return;}
  try{
    var scroller=irPrimaryHoverScroller(hoverHost)||hoverHost;
    if(!scroller||!scroller.addEventListener)return;
    hoverHost.__irScrollListenerAttached=true;
    scroller.addEventListener('scroll',function(){
      // L90: re-arm viewport-wrap on the markdown blocks so the NEXT scan wraps
      // rows that just scrolled into view. The wrappedCount==0 convergence guard
      // (irScanRenderedMarkdown) clears __irViewportWrap once a band is fully
      // wrapped; a scroll reveals new off-screen rows, so re-enable the skip-
      // bypass here. This flag flip is cheap (no layout, no textContent read).
      // L115 (2026-06-01): re-arm ONLY blocks large enough to use band wrapping
      // (deferEagerWrap, > IR_HOVER_EAGER_WRAP_MAX_TEXT). Small blocks are wrapped
      // whole on the first scan, so __irViewportWrap=true there just forces both
      // scan guards (irScanRenderedMarkdown ~10091/10119) to fail → a full
      // re-tokenize (mtk≈108ms, wrapped=0) on EVERY scroll/momentum tick of a
      // small hover (743-char "Service" hover re-scanned ~5×/sec = the jank the
      // user saw as "char col 변경시 hover가 깨져"). Gate on the cached scan text
      // length (O(1), no re-materialization); if nothing needs band wrapping,
      // skip the re-arm AND the debounced re-scan entirely.
      var needsBandWrap=false;
      try{
        var bs=hoverHost.querySelectorAll?hoverHost.querySelectorAll('.rendered-markdown'):null;
        if(bs)for(var bi=0;bi<bs.length;bi++){
          if((bs[bi].__irLastScanText||'').length>IR_HOVER_EAGER_WRAP_MAX_TEXT){bs[bi].__irViewportWrap=true;needsBandWrap=true;}
        }
      }catch(_){}
      if(!needsBandWrap)return;
      // L107 (2026-06-01): DEBOUNCE the heavy wrap re-scan during scrolling.
      // A wheel scroll of a 57K-char / 1657-line class hover ("company") used to
      // fire a FULL block re-scan PER wheel tick: re-read 57K textContent, rebuild
      // the ~200-name candidate list, compile a ~200-alternation regex, TreeWalk
      // the whole block (thousands of mtk token spans), and getBoundingClientRect
      // every text node above the scroll position — a 100-561ms longtask EACH, and
      // worse the deeper the scroll (more above-band nodes to rect-read). 45 scans
      // for 48 wheel ticks pinned a CPU core (user: "cpu사용률이 폭발"). irScheduleScan's
      // idle coalescing (L33) was meant to defer this but idle gaps open BETWEEN
      // wheel ticks so it fired anyway. A reset-on-scroll debounce runs the wrap
      // pass ONCE, ~140ms after scrolling settles (links appear when the user stops
      // to read/click, not mid-gesture). __irViewportWrap re-armed above makes that
      // settle-scan wrap the now-visible band.
      try{if(hoverHost.__irScrollScanTimer)clearTimeout(hoverHost.__irScrollScanTimer);}catch(_){}
      hoverHost.__irScrollScanTimer=setTimeout(function(){
        hoverHost.__irScrollScanTimer=null;
        try{irScheduleScan();}catch(_){}
      },IR_HOVER_SCROLL_SCAN_DEBOUNCE_MS);
    },{passive:true});
  }catch(_){}
}
// L87 step 3 (2026-05-31): windowed virtual scroller for the stashed tail. Step 2
// rendered the whole tail (~1500 lines) as one plain pre in idle -> a ~520ms block
// (moved off the sync path but still a stutter). This renders ONLY the visible line
// window into the DOM, with top/bottom spacer divs preserving the full scroll height,
// and re-renders the window on scroll. DOM stays ~50 lines regardless of total size,
// so there is no big layout. Mounts inside the hover scroller; the head (highlighted)
// is already painted above it by VS Code. Tail lines are plain text (no drill links yet
// -- a later refinement re-scans the visible window for navigable type names).
function irRenderVtailWindowed(block,tailText,id){
  try{
    var lines=tailText.split('\\n');
    var total=lines.length;
    var scroller=(block.closest&&(block.closest('.monaco-scrollable-element')||block.closest('.monaco-hover')))||block.parentElement;
    if(!scroller)return;
    var wrap=document.createElement('div');wrap.className='ir-vtail-scroller';wrap.setAttribute('style','margin:0;padding:0');
    var topSp=document.createElement('div');topSp.setAttribute('style','height:0;margin:0;padding:0');
    var win=document.createElement('pre');win.className='ir-vtail-window';win.setAttribute('style','margin:0;padding:0;white-space:pre');
    var winCode=document.createElement('code');win.appendChild(winCode);
    var botSp=document.createElement('div');botSp.setAttribute('style','height:0;margin:0;padding:0');
    wrap.appendChild(topSp);wrap.appendChild(win);wrap.appendChild(botSp);
    block.appendChild(wrap);
    // measure line height from a few probe lines (padding is 0 so height/N is the row height)
    var probeN=Math.min(5,total)||1;
    winCode.textContent=lines.slice(0,probeN).join('\\n')||' ';
    var lh=18;try{var h=win.getBoundingClientRect().height;if(h>0)lh=h/probeN;}catch(_){}
    if(!(lh>=6&&lh<=60))lh=18;
    var BUFFER=12;var lastS=-1,lastE=-1;
    function render(){
      try{
        if(!document.body.contains(wrap))return;
        var scRect=scroller.getBoundingClientRect();
        var wRect=wrap.getBoundingClientRect();
        var scTop=scroller.scrollTop||0;
        var vpH=scroller.clientHeight||scRect.height||400;
        var tailOffset=(wRect.top-scRect.top)+scTop;   // wrap offset within the scrollable content (stable)
        var relTop=scTop-tailOffset;
        var start=Math.max(0,Math.floor(relTop/lh)-BUFFER);
        var end=Math.min(total,Math.ceil((relTop+vpH)/lh)+BUFFER);
        if(end<start)end=start;
        if(start===lastS&&end===lastE)return;
        lastS=start;lastE=end;
        winCode.textContent=lines.slice(start,end).join('\\n');
        topSp.style.height=Math.round(start*lh)+'px';
        botSp.style.height=Math.round(Math.max(0,total-end)*lh)+'px';
      }catch(_){}
    }
    lastS=-1;lastE=-1;render();
    var pend=false;
    var onScroll=function(){if(pend)return;pend=true;(window.requestAnimationFrame||function(f){return setTimeout(f,16);})(function(){pend=false;render();});};
    try{scroller.addEventListener('scroll',onScroll,{passive:true});}catch(_){}
    irHERecord('vtail-windowed',{id:id,total:total,lh:Math.round(lh)});
  }catch(_){}
}
// L87 (2026-05-30): virtual-tail channel test (step 1). The extension prepends an
// IRVTAIL:<id>:<len> marker to large previews and stashes the full markdown into
// window.__irPreviewStash[id] via CDP. Detect the marker, confirm the stash arrived
// with the expected length, log it, and remove the visible marker element. Proves the
// ext->renderer content channel before step 2 (head-split + render tail from stash).
function irHandleVtailMarker(block,text){
  var m=/IRVTAIL:(v[0-9]+):([0-9]+):(split|full)/.exec(text);
  if(!m)return;
  var id=m[1];
  if(block.__irVtailLastId===id)return;   // already handled this marker id (block may be reused across hovers)
  block.__irVtailLastId=id;
  var expectedLen=parseInt(m[2],10)||0;var mode=m[3];
  var stash=null;try{stash=window.__irPreviewStash&&window.__irPreviewStash[id];}catch(_){}
  var stashLen=(typeof stash==='string')?stash.length:-1;
  irHERecord('vtail-channel-test',{id:id,mode:mode,expectedLen:expectedLen,stashLen:stashLen,match:(stashLen===expectedLen)});
  // remove the visible marker element
  try{var codes=block.querySelectorAll('code');for(var i=0;i<codes.length;i++){if((codes[i].textContent||'').indexOf('IRVTAIL:')>=0){var p=codes[i].parentNode;if(p)p.removeChild(codes[i]);break;}}}catch(_){}
  // L87 step 2: render the stashed plain tail OFF the sync path (idle), appended after the head.
  // The head (highlighted) already painted via VS Code's tiny sync render; this fills in the rest.
  if(mode==='split'&&typeof stash==='string'&&stash.length>0&&!block.__irVtailRendered){
    block.__irVtailRendered=true;
    irRenderVtailWindowed(block,stash,id);   // L87 step 3: windowed (visible-lines-only) render
  }
}
function irScanRenderedMarkdown(){
  // L87 channel proof (direct, marker-independent): does THIS patch (its JS world)
  // see the stash the extension set via debugger.sendCommand? Log when the key count
  // grows. If keys>=1 here, the ext->renderer content channel is confirmed end-to-end.
  try{var __vs=window.__irPreviewStash;var __vk=__vs?Object.keys(__vs).length:-1;if(__vk>=1&&window.__irVtailStashLogN!==__vk){window.__irVtailStashLogN=__vk;irHERecord('vtail-stash-visible',{keys:__vk});}}catch(_){}
  irDiagnoseUnwrappedHovers();
  irAlignResizableHoverToChild();
  var containers=document.querySelectorAll('.monaco-hover .rendered-markdown, .monaco-editor-hover .rendered-markdown, .ij-find-hover-tooltip .rendered-markdown');
  if(containers.length!==irLastContainerCount) irLastContainerCount=containers.length;
  for(var pre=0;pre<containers.length;pre++){
    try{
      var preBlock=containers[pre];
      if(!document.body.contains(preBlock))continue;
      var preHost=preBlock.closest('.monaco-hover, .monaco-editor-hover');
      // L32 viewport gate before the expensive textContent read.
      if(preHost&&!irIsBlockVisibleInHover(preBlock,preHost))continue;
      var preText=preBlock.textContent||'';
      if(preText.indexOf('IRVTAIL:')>=0){try{irHandleVtailMarker(preBlock,preText);}catch(_){}}
      if(preHost&&preBlock.__irLastScanText!==preText){
        irTouchHoverRootContent(preHost,'pre-scan-text-change',preText);
      }
    }catch(_){}
  }
  irPruneDetachedHoverState();
  var dedupedHosts=[];
  for(var j=0;j<containers.length;j++){var block=containers[j];
    if(!document.body.contains(block))continue;
    var hoverHost=block.closest('.monaco-hover, .monaco-editor-hover');
    if(!irShouldProcessHoverBlock(hoverHost,block))continue;
    // L32 viewport gate: skip offscreen blocks BEFORE the expensive
    // textContent read. Always allow blocks without an enclosing hover
    // host (defensive) and always allow when the hover is too small to
    // meaningfully have an offscreen region.
    if(hoverHost&&!irIsBlockVisibleInHover(block,hoverHost))continue;
    // Attach a scroll listener on the hover scroller exactly once per
    // hover so newly-scrolled-in blocks trigger a re-scan.
    if(hoverHost)irEnsureHoverScrollListener(hoverHost);
    // L98: native viewport clamp — nudge a capped hover whose bottom VS Code
    // placed below the viewport back on-screen (#1). No-op in overlay mode and
    // when the bottom is already visible. Idempotent, so the per-block redundancy
    // here (one host can own several .rendered-markdown blocks) costs only a
    // wrapper rect read once the first call has settled it.
    if(hoverHost){try{irKeepHoverInViewport(hoverHost);}catch(_){}}
    if(hoverHost){try{irAuditHoverSize(hoverHost);}catch(_){}}   // L103: measure wrapper/host/scroller height mismatch

    // L35: cheap signature pre-check. textContent extraction on a 57K
    // char block is the dominant per-scan cost; in logs we see
    // "skip-same-text" 27+ times per drill where the block hasn't
    // changed at all but we still pay the full string materialization.
    // Use childElementCount + first/last child node names as a fast
    // proxy for content change. Misses character-data-only edits, but
    // those are extremely rare in markdown hover output (VS Code rebuilds
    // the subtree). If signature matches AND we've previously wrapped
    // this block (has ir-type-link), skip without touching textContent.
    var blockSig=(block.childElementCount||0)+':'+
      (block.firstElementChild?block.firstElementChild.nodeName:'_')+':'+
      (block.lastElementChild?block.lastElementChild.nodeName:'_');
    if(block.__irLastScanSig===blockSig && block.querySelector('.ir-type-link') && !block.__irViewportWrap){
      continue;
    }
    var text=block.textContent||'';
    block.__irLastScanSig=blockSig;
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
    // Apply our fixed width/height tier to every active hover so the visible
    // hover always has consistent dimensions. Position is left to VS Code's
    // native placement (irKeepHoverInViewport may still nudge it in-bounds).
    if(text.length>=3){
      irMakeHoverScrollable(hoverHost, false, text.length);
    }
    if(block.__irLastScanText===text&&!block.__irViewportWrap&&(hasTypeLinks||text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT)){
      if(irInterestingHoverScanText(text)){
        irLogHoverScanDecision('skip-same-text',block,hoverHost,text,'',[], 'hasTypeLinks='+hasTypeLinks+' eagerTooLarge='+(text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT));
      }
      if(hasTypeLinks)irRefreshTypeLinkGeometry(block,'skip-same-text');
      continue;
    }
    if(text.length>24000){
      irMarkHoverManaged(hoverHost,true);
    }
    if(block.querySelector('.ir-type-link')){
      irMarkHoverManaged(hoverHost,true);
      irRefreshTypeLinkGeometry(block,'existing-links');
    }
    if(text.length<3){
      irLogHoverScanDecision('skip-short',block,hoverHost,text,'',[], '');
      continue;
    }
    var skip=IR_HOVER_LINK_SKIP;
    var deferEagerWrap=text.length>IR_HOVER_EAGER_WRAP_MAX_TEXT;
    // L121 (2026-06-01): cache the candidate-name list + regex per block, keyed on the
    // scanned text. A huge (viewport-wrapped) hover re-runs this scan on every scroll
    // settle to wrap the newly-visible band, but the content is UNCHANGED. Rebuilding the
    // ~206-name candidate list (a full scan of 57K chars) and recompiling the alternation
    // regex on each re-scan was the residual CPU on big drill hovers (the only big "ours"
    // cost — VS Code's tokenization longtasks are separate/attribution:unknown). Reuse on
    // text match; the tree-walk + band-wrap below still run. linkRe is reset per text node
    // (lastIndex=0) so the shared regex object is safe to reuse.
    var candidateText,types,cachedLinkRe=null;
    if(block.__irScanCacheText===text&&block.__irScanCacheTypes){
      candidateText=block.__irScanCacheCandidateText||text;
      types=block.__irScanCacheTypes;
      cachedLinkRe=block.__irScanCacheRegex||null;
    }else{
      candidateText=irHoverLinkCandidateText(block,text);
      types=irCollectHoverLinkNames(candidateText,skip,deferEagerWrap);
      try{block.__irScanCacheText=text;block.__irScanCacheCandidateText=candidateText;block.__irScanCacheTypes=types;block.__irScanCacheRegex=null;}catch(_){}
    }
    irSetHoverLinkCandidates(block,types);
    block.__irLastScanText=text;
    // L77 (2026-05-29): defer the heavy navigable-name wrapping while this hover
    // is staging (hidden & forming). Inserting the .ir-type-link spans (hundreds
    // on a large hover — v=229 saw wrapped=553) is a big reflow that, together
    // with the scan/size feedback loop, churns the wrapper into the width-
    // collapse and stops it settling inside the 500ms staging budget (v=229: 81%
    // revealed at budget, often still collapsed). makeScrollable (sizing) has
    // already run above, so the hover still settles to size; irStageReveal then
    // schedules a scan to wrap the now-shown, stable hover. Wrapping leaves
    // textContent unchanged, so the post-reveal wrap never re-stages.
    if(block.closest&&block.closest('.monaco-resizable-hover.ir-hover-staging')){
      block.__irWrapDeferred=true;
      continue;
    }
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
    // L88 (2026-05-31): big hovers (native mode sends the FULL preview, not a 120-line
    // head) exceed the eager-wrap budget. The old code skipped wrapping ENTIRELY here
    // (continue) -> native hovers got zero .ir-type-link spans -> drilldown was dead in
    // native mode. Instead fall through and wrap ONLY the text nodes currently in the
    // hover viewport (+margin, pre-filtered below); the off-screen remainder is wrapped
    // lazily on scroll (irEnsureHoverScrollListener re-fires the scan, and the
    // __irViewportWrap flag set after the wrap bypasses the same-text/same-sig skips so
    // newly-scrolled-in rows get wrapped too). Per-pass reflow stays bounded to ~one
    // screenful, avoiding the hundreds-of-spans synchronous reflow L77 guarded against,
    // while restoring the drill-link affordance everywhere in native mode.
    var vpLimit=deferEagerWrap;
    if(vpLimit&&window.__irWrapLogCount<20){
      window.__irWrapLogCount++;
      irLog('renderer: viewport-wrap text='+text.length+' types='+types.length+' existing='+existingLinks+' sample='+types.slice(0,10).join(','));
    }
    if(vpLimit){
      irLogHoverScanDecision('viewport-wrap',block,hoverHost,text,candidateText,types,'existing='+existingLinks);
    }
    var linkRe=cachedLinkRe||irBuildHoverLinkRegex(types);   // L121: reuse compiled regex across same-text re-scans
    if(!linkRe){
      irLogHoverScanDecision('skip-no-regex',block,hoverHost,text,candidateText,types,'');
      continue;
    }
    if(!cachedLinkRe){try{block.__irScanCacheRegex=linkRe;}catch(_){}}
    var walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    var node,textNodes=[];
    while(node=walker.nextNode()){textNodes.push(node)}
    // L88 viewport pre-filter: when vpLimit (big native hover) keep only text nodes whose
    // parent box intersects [hostTop-300, hostBottom+300] in screen coords. All rect READS
    // happen HERE, before any wrapping WRITE below, so there is no per-node read/write
    // layout thrash. A node below the band ends the pass (text-node order is vertical
    // within the code block); a 2000-node cap bounds the not-yet-laid-out fallback.
    if(vpLimit){
      var _vpTop=-1e9,_vpBot=1e9;
      if(hoverHost&&hoverHost.getBoundingClientRect){
        try{var _hbr=hoverHost.getBoundingClientRect();if(_hbr.height>=10){_vpTop=_hbr.top-300;_vpBot=_hbr.bottom+300;}}catch(_){}
      }
      var _vis=[];
      for(var _vi=0;_vi<textNodes.length;_vi++){
        var _vn=textNodes[_vi];if(!_vn||!_vn.parentNode)continue;
        var _vpe=_vn.parentElement||_vn.parentNode;
        var _vpr=(_vpe&&_vpe.getBoundingClientRect)?_vpe.getBoundingClientRect():null;
        if(_vpr&&(_vpr.width||_vpr.height)){
          if(_vpr.bottom<_vpTop)continue;
          if(_vpr.top>_vpBot)break;
        }
        _vis.push(_vn);
        if(_vis.length>=2000)break;
      }
      textNodes=_vis;
    }
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
        var decoratorJoined = before === '@';
        var prefix = nv.slice(Math.max(0, idx - 24), idx).replace(/\\s+/g, '');
        var declarationJoined = wc.test(before)
          && (/(?:^|[^A-Za-z0-9_$])(?:async)?def$/.test(prefix)
            || /@[A-Za-z_$][A-Za-z0-9_$]*(?:async)?def$/.test(prefix));
        if(!wc.test(before)&&!wc.test(afterC)||decoratorJoined||declarationJoined){
          matches.push({type:typeName,idx:idx});
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
    // L88/L90: stay in viewport-wrap mode (bypassing the same-text/same-sig skips) ONLY while
    // a pass still wraps NEW links — i.e. the hover is still growing to full size or rows just
    // scrolled in. Once a pass wraps 0 new links the visible viewport is fully covered, so
    // CLEAR the flag to re-engage the skips and stop re-scanning. L90 fix: our own
    // .ir-type-link inserts re-fire the markdown MutationObserver -> irScheduleScan, so a
    // settled 57K hover used to re-scan itself dozens of times/sec (scan storm; plateau of
    // identical link counts in the log). Scroll re-arms the flag (irEnsureHoverScrollListener)
    // so newly-visible rows still wrap. Small hovers (vpLimit=false): stays false as before.
    block.__irViewportWrap=vpLimit&&wrappedCount>0;
    if(wrappedCount>0){
      irRefreshTypeLinkGeometry(block,'wrap-result');
      irMarkHoverManaged(hoverHost,true);
      irMakeHoverScrollable(hoverHost, false, text.length);
      if(hoverHost&&(hoverHost.__irContentChangedAt||0)&&Date.now()-(hoverHost.__irContentChangedAt||0)<1200){
        hoverHost.__irActivatedAt=Date.now();
        irSetActiveHoverLayer(hoverHost);
      }
    }
    // L72 diag: stamp so width-collapse-transition can correlate a collapse
    // with our just-completed navigable-name wrapping (DOM rewrite of the
    // hover content, a candidate trigger for VS Code's relayout collapse).
    if(wrappedCount>0){try{window.__irLastWrapAt=Date.now();}catch(_){}}
    if(window.__irWrapLogCount<20&&(wrappedCount>0||types.length>0)){
      window.__irWrapLogCount++;
      irLog('renderer: wrap text='+text.length+' types='+types.length+' wrapped='+wrappedCount+' sample='+types.slice(0,10).join(','));
    }
    if(wrappedCount===0||irInterestingHoverScanText(text)||irInterestingHoverScanText(candidateText)){
      irLogHoverScanDecision('wrap-result',block,hoverHost,text,candidateText,types,'wrapped='+wrappedCount+' nodes='+textNodes.length+(vpLimit?' vpwrap=1':''));
    }
    if(text.length>4000) irMakeHoverScrollable(hoverHost, false, text.length);
  }
}

function irScheduleScan(){
  if(window.__irScanTimer)return;
  // L25 → L33 progression:
  //   L25 used rAF so dedup landed before paint (avoided "big → small"
  //   visual flicker on duplicate-heavy hovers).
  //   L33 swaps in requestIdleCallback so the heavy scan/wrap pass yields
  //   the main thread when the user is actively scrolling. User report
  //   was: drill hover pops, immediate scroll stutters for ~1s until
  //   the mutation burst finishes — main thread was blocked by our
  //   per-mutation rAF callbacks chewing through 57K-char textContent.
  //   With idle scheduling brower defers our work while wheel ticks are
  //   firing; scrolling stays responsive and the wrap pass finishes
  //   shortly after the user lifts the wheel.
  //   The 500 ms timeout guarantees the scan still runs even if idle
  //   time never opens (rare on busy systems) so type-link wrapping
  //   doesn't stall indefinitely.
  //   Fallback chain: requestIdleCallback → requestAnimationFrame →
  //   setTimeout — last two were the pre-L33 behaviour, preserved for
  //   test/headless environments.
  var schedule;
  if(typeof window.requestIdleCallback==='function'){
    schedule=function(cb){return window.requestIdleCallback(cb,{timeout:500});};
  }else if(typeof window.requestAnimationFrame==='function'){
    schedule=window.requestAnimationFrame;
  }else{
    schedule=function(cb){return setTimeout(cb,16);};
  }
  window.__irScanTimer=schedule(function(){
    window.__irScanTimer=null;
    try{irTimeSync('scan',irScanRenderedMarkdown)}catch(eScan){irLog('renderer: scan err '+(eScan&&eScan.message))}
  });
}

// L99 (2026-05-31): is this mutation purely our OWN .ir-type-link wrapping?
// Wrapping a navigable name splits a text node (splitText byproducts are text
// nodes) and inserts a <span class="ir-type-link"> around it, moving the matched
// text into the span. VS Code's real hover-content changes instead swap whole
// element subtrees (div.rendered-markdown, p, code, span.mtk*, ...). So a childList
// mutation whose added nodes are ALL text-or-ir-type-link (and whose removed nodes
// are all text) is one of our wraps, not a content change.
function irIsOwnLinkWrapMutation(mut){
  if(!mut||mut.type!=='childList')return false;
  var added=mut.addedNodes||[];
  var removed=mut.removedNodes||[];
  if(!added.length&&!removed.length)return false;
  // splitText leaves text nodes; insertBefore adds the <span class="ir-type-link">.
  for(var i=0;i<added.length;i++){
    var n=added[i];
    if(!n)return false;
    if(n.nodeType===3)continue;   // text node: splitText byproduct
    if(n.nodeType===1&&n.classList&&n.classList.contains('ir-type-link'))continue;
    return false;   // a real element added -> genuine content change
  }
  // span.appendChild(matchedText) MOVES the matched text out of its old parent, so
  // the parent fires a removal record with NO added nodes. That was the v264 storm
  // leak: the old guard bailed on !added.length and let this record set seenScan,
  // re-firing the scan ~50ms apart. A removal of only text / ir-type-link nodes is
  // still our own wrapping.
  for(var j=0;j<removed.length;j++){
    var rn=removed[j];
    if(!rn)continue;
    if(rn.nodeType===3)continue;   // text node moved into our span
    if(rn.nodeType===1&&rn.classList&&rn.classList.contains('ir-type-link'))continue;
    return false;   // a real element removed -> genuine content change
  }
  return true;
}
window.__irMarkdownObserver=irTrackObserver(new MutationObserver(function(muts){
  var __moT0=irNowMs();   // L83: time the markdown MO burst (a #2 block suspect on 57K-char content)
  irPruneDetachedHoverState();
  // L37: dedupe per-hover work within a single mutation-observer
  // callback. drill mutation bursts deliver 50+ records in one tick and
  // most reference the same hover host — without dedup we called
  // irTouchHoverRootContent once per record (each doing closest() walks
  // and a textContent read). The Set fast-paths repeat hovers.
  // We also defer irScheduleScan to once per callback at the end so a
  // single burst can't enqueue the scan multiple times via the early
  // returns that used to fire per-match.
  var seenHovers=null;
  var seenScan=false;
  function touchOnce(hover,reason,el){
    if(!hover)return;
    if(!seenHovers)seenHovers=new Set?new Set():null;
    if(seenHovers&&seenHovers.has(hover))return;
    if(seenHovers)seenHovers.add(hover);
    irTouchHoverRootContent(hover,reason,el?(el.textContent||''):null);
    // L76: content changed in this hover — stage it (hide until settled) so the
    // formation flicker isn't shown. Idempotent: irStageHover no-ops if this
    // exact content is already staging or already revealed.
    try{var stWrap=hover.closest&&hover.closest('.monaco-resizable-hover');if(stWrap)irStageHover(stWrap);}catch(_){}
  }
  for(var mi=0;mi<muts.length;mi++){
    var mut=muts[mi];
    // L99 (2026-05-31): a mutation that IS our own link-span insert must not
    // re-fire the scan. Without this, wrapping the visible band of a 57K hover
    // inserted spans -> this observer set seenScan -> irScheduleScan -> the scan
    // wrapped a few more links -> more span inserts -> a 94-pass, ~7.6s storm
    // (each pass re-reads 57K textContent + builds a 206-type regex = the scroll
    // jank; the content reflowing under the wheel = the "frozen" scroll). The scan
    // still runs on REAL content swaps (element subtrees) and on scroll
    // (irEnsureHoverScrollListener re-arms __irViewportWrap + irScheduleScan), so
    // newly-scrolled-in rows still get their drill links.
    if(irIsOwnLinkWrapMutation(mut))continue;
    var nodes=mut.addedNodes||[];
    for(var ni=0;ni<nodes.length;ni++){
      irActivateAddedHoverRoots(nodes[ni],'mutation-added');
      try{
        var addedEl=nodes[ni]&&(nodes[ni].nodeType===1?nodes[ni]:nodes[ni].parentElement);
        var addedHover=addedEl&&addedEl.closest?addedEl.closest('.monaco-hover,.monaco-editor-hover'):null;
        touchOnce(addedHover,'mutation-added',addedEl);
      }catch(_){}
    }
    var target=mut.target;
    var targetEl=target&&(target.nodeType===1?target:target.parentElement);
    if(targetEl&&targetEl.closest&&targetEl.closest('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip')){
      try{
        var targetHover=targetEl.closest('.monaco-hover,.monaco-editor-hover');
        touchOnce(targetHover,'mutation-'+(mut.type||'target'),targetEl);
      }catch(_){}
      seenScan=true;
      continue;
    }
    for(var nj=0;nj<nodes.length;nj++){
      var n=nodes[nj];
      if(!n||n.nodeType!==1)continue;
      if((n.matches&&n.matches('.rendered-markdown,.monaco-hover,.monaco-editor-hover,.ij-find-hover-tooltip'))||
         (n.querySelector&&n.querySelector('.rendered-markdown'))){
        try{
          var nodeHover=n.closest?n.closest('.monaco-hover,.monaco-editor-hover'):null;
          if(!nodeHover&&n.querySelector)nodeHover=n.querySelector('.monaco-hover,.monaco-editor-hover');
          touchOnce(nodeHover,'mutation-query',n);
        }catch(_){}
        seenScan=true;
        break;
      }
    }
  }
  if(seenScan)irScheduleScan();
  try{var __moDur=irNowMs()-__moT0;if(__moDur>=IR_SYNC_LONGTASK_MIN_MS)irHERecord('ir-sync-longtask',{fn:'markdown-mo',durMs:Math.round(__moDur),muts:muts&&muts.length,staging:irStageElapsedNow()});}catch(_){}
}));
// L40: characterData:true was firing the observer on every keystroke
// the user typed in the editor (each character data mutation in
// .view-line text nodes), even though hover content updates land
// through childList mutations (VS Code swaps entire markdown subtrees,
// not in-place text). Dropping characterData here cuts the global
// observer callback rate dramatically without losing real hover
// updates. Local drill-content observers (lines 13404, 13893) keep
// characterData:true since they cover small wrapper-only trees where
// the extra fidelity is cheap.
window.__irMarkdownObserver.observe(document.body,{childList:true,subtree:true});
try{irInstallLongTaskObserver();}catch(_){}   // L83: #2 main-thread block instrumentation
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
      var startIdx = tokens[t];
      var endIdx = t + 2 < tokens.length ? tokens[t + 2] : line.length;
      var meta = tokens[t + 1];
      if (startIdx < pos) startIdx = pos;
      if (endIdx < startIdx) endIdx = startIdx;
      if (startIdx > pos) {
        frag.appendChild(document.createTextNode(line.substring(pos, startIdx)));
      }
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
      var part = line.substring(startIdx, endIdx);
      pos = endIdx;
      if (!part) continue;
      var cls = 'mtk' + fg;
      if (italic) cls += ' mtki';
      if (bold) cls += ' mtkb';
      if (underline) cls += ' mtku';
      var span = document.createElement('span');
      span.className = cls;
      span.textContent = part;
      frag.appendChild(span);
    }
    if (pos < line.length) {
      frag.appendChild(document.createTextNode(line.substring(pos)));
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
