# Native Hover UI Structure

How VS Code's native hover is built, what we touch, and the contract our golden
E2E enforces. This document is the source of truth for the hover layout — if
you change behavior, update this file.

## TL;DR

We render drill-down hovers by piping our markdown back through VS Code's
`HoverProvider` and `editor.action.showHover`. VS Code does all painting,
positioning, theming. Our only DOM responsibilities are:

- Wrap discovered type names with `.ir-type-link` so they become clickable.
- Insert a `[← Back](command:intellisenseRecursion.previewBack)` link at the
  top of the markdown when there's drill-down history.
- Keep VS Code's two hover containers (`.monaco-resizable-hover` wrapper and
  `.monaco-hover` child) geometrically aligned (see "JS aligner" below).
- Keep automatic hovers inside a compact `680px × 48vh` envelope, while
  allowing an explicit native-sash drag to expand toward the viewport edge.
- Pin a native hover after a primary click inside it, keeping it open across
  pointer movement until the next primary click outside the wrapper.

VS Code still chooses width/height and owns all positioning. Our size rules
only provide the automatic and user-resize upper bounds described below.

## DOM hierarchy

VS Code wraps every hover in a stack that looks like:

```
.overflowingContentWidgets               (workbench-level widget host)
└── .monaco-resizable-hover              ← VS Code's true outer; positioning anchor
    └── .monaco-hover.ir-scrollable      ← what we used to call "outer"
        └── .monaco-scrollable-element   ← scroll viewport, fills parent
            └── .monaco-hover-content    ← content frame
                └── .hover-row           (one per content section)
                    └── .hover-row-contents
                        └── .markdown-hover
                            └── .rendered-markdown  ← actual text/code box
```

Key facts:

- `.monaco-resizable-hover` is fixed-positioned by VS Code. Its `top`/`left`
  decide where the hover paints. Without our aligner it can collapse to ~2×2.
- `.monaco-hover` inside it has TWO position modes:
  - **Static** on the first show at a location (in-flow inside the wrapper).
  - **Fixed** on every subsequent show — VS Code sets inline
    `style="position:fixed;top:Ypx;left:Xpx;..."`. This takes the child out of
    the parent's flow, which is why the wrapper collapses without our aligner.
- The "inner scroller" we expose via `irHoverBoxCornerSnapshot` is
  `.monaco-scrollable-element`, not `.rendered-markdown`. The scroller is the
  element whose bbox always matches `.monaco-hover`.
- `.rendered-markdown` is the actual text-bearing box. It can be smaller than
  the scroller (short content) or larger (overflowing/scrolling content).

There are also parallel hover widgets that VS Code may keep in the DOM:

- `.overflowingOverlayWidget` hosts a separate hidden `.monaco-hover` used in
  some hover variants. We treat these as siblings and ignore them.

## Position modes

VS Code's hover lifecycle has two visible position modes for `.monaco-hover`:

| Mode    | When                                     | Inline `style`         | Wrapper sizing |
|---------|------------------------------------------|------------------------|----------------|
| static  | first show at a fresh anchor             | (no inline pos)        | wrapper grows to content (✓ aligned)   |
| fixed   | every show after that, including drills  | `position:fixed; top:Ypx; left:Xpx` | wrapper collapses to ~2×2 (needs aligner) |

Switching modes happens silently inside VS Code; we can't predict it and we
can't reliably suppress the second mode (CSS `position:static !important` is
beaten by VS Code's inline writes at the same priority).

## What we enforce

Implementation lives primarily in `src/renderer-patch.ts`. Search for these symbols:

| Concern                | Implementation                                     |
|------------------------|----------------------------------------------------|
| Native-only hover      | `applyPreviewStateAsHover` + `refireHoverAtAnchor` |
| Back link in markdown  | `applyPreviewStateAsHover` (prepends `[← Back]`)   |
| Link wrapping          | `irScanRenderedMarkdown` walks rendered-markdown nodes and wraps type identifiers with `.ir-type-link` |
| Back-button click      | `irBackControlClick` (capture-phase listener)      |
| Wrapper↔child alignment| `irAlignResizableHoverToChild` (currently no-op)   |
| Flexible native resize | `irEnableFlexibleHoverResize` + `.ir-flexible-hover-size` |
| Click-to-pin lifecycle | `irPinNativeHoverRoot` + `irClearClickPinnedHover` |

Both directions of forced alignment broke real interactive positioning:
- "wrapper follows child" pinned wrapper to stale child coords.
- "child follows wrapper" pinned child to stale wrapper coords.

VS Code's internal positioning model isn't symmetric and we don't yet have a
clean signal for when to trust which. The aligner is a no-op for now;
geometry assertions in the golden E2E may report deltas between wrapper and
child until we land on a position model that doesn't fight VS Code.

We deliberately do NOT set:

- `position`, `top`, `left`, `transform`, `margin-*` on `.monaco-hover`
- Background or border colors

We do set upper bounds on the wrapper/host/scroller chain: automatic hovers
use `max-width: 680px` and `max-height: 48vh`. These caps prevent injected or
transient content from briefly expanding to the whole viewport and preserve
the inner scrolling contract.

## Dual size envelope

The compact cap is an automatic-layout safety boundary, not a permanent user
resize limit. When the user grabs a sash that is actually contained by a
`.monaco-resizable-hover`, `irEnableFlexibleHoverResize`:

1. snapshots the currently painted width/height, preventing stale transient
   inline geometry from flashing when the compact cap is relaxed;
2. unlocks only the grabbed axis toward the corresponding viewport edge,
   retaining an 8px gutter; and
3. leaves VS Code in sole control of the drag, width/height writes, and
   placement.

The host then fills the resized wrapper and the flex scroller keeps
`min-height: 0` plus `overflow: auto`, so larger content remains contained and
scrollable. Sashes outside a hover wrapper (workbench splitters and unrelated
overlays) are ignored. Once VS Code has stably dismissed the hover, the opt-in
class, bounds, and size snapshot are cleared before the shared wrapper is
reused; transient 0×0 resize frames do not trigger that reset.

## Click-to-pin lifecycle

A primary pointer-down inside a real `.monaco-resizable-hover` pins that hover.
The pin uses VS Code's own lifecycle rather than the legacy `ir-sticky` overlay
management:

- the native `.monaco-hover` receives focus;
- the owning `ContentHoverController.shouldKeepOpenOnEditorMouseMoveOrLeave`
  value is saved and temporarily enabled; and
- only the pinned wrapper's direct `mouseleave` event is intercepted, because
  VS Code's wrapper listener otherwise hides even a focused hover.

All ordinary move/over/out events continue untouched. A primary pointer-down
outside the wrapper first restores the controller's previous flag, removes the
pin markers, and requests `editor.action.hideHover`; it never prevents or stops
the destination click. Right-click and an initial resize-sash grab do not pin.
Stable native dismissal, active-wrapper replacement, and patch cleanup also
clear stale pin state so the shared hover widget cannot carry a pin into a new
session.

Once pointer movement crosses the 5 px drag threshold, the visible hover is
promoted to an independent `.ir-detached-hover` snapshot. Its viewport
position, size, rendered content, and scroll offset are copied before the
native pin is cleared. The owning controller is then hidden directly (with the
normal `editor.action.hideHover` request as fallback), returning VS Code's
single reusable hover widget for the next symbol. This is the transition that
allows multiple moved hover windows to coexist.

Detached windows are isolated from native-hover activation, markdown rescans,
history, and wrapper-layout observers. They can be dragged again, are clamped
to an 8 px viewport gutter, and remain until their `×` control closes them or
the renderer patch is cleaned up. At most 12 detached windows are retained;
creating another closes the oldest snapshot to bound large-hover DOM memory.
They are intentionally read-only: cloned links, copy actions, and form controls
are disabled, while scrolling, window dragging, and the `×` control remain
active. Large virtualized hover tails get their own scroll renderer so moving a
window does not freeze it at the lines that happened to be visible at detach.

## Box-corner contract (what the golden E2E checks)

For each captured hover sample we check:

1. **DOM relationship**: the inner box (chosen via `irHoverBoxCornerSnapshot`)
   is a descendant of the outer (`hoverEl.contains(innerEl) === true`,
   `ancestorDepth >= 0`).
2. **Bbox fits**: inner sits inside outer with a deterministic 1px gap on
   every edge (outer carries the 1px hover borderline). So
   `inner.width === outer.width − 2` and `inner.height === outer.height − 2`
   within sub-pixel rounding (≤ 0.5px). Anything wider means the borderline
   is missing; anything narrower means we lost interior space.
3. ~~**Outer↔wrapper alignment**~~: skipped. Both alignment directions
   mispositioned hovers in real interactive use, so the aligner is no-op.
   Wrapper geometry is treated as VS Code internal state — the visible
   hover (inner) is what the user sees regardless.
4. **No drift across samples**: when we take multiple snapshots at the same
   logical moment (e.g., +0/+100/+250/+600ms after a drill), outer's bbox is
   stable across them (Δleft/top/width/height ≤ 1.5px).
5. **Back button present after drill**: either a `.ir-back-btn` or an anchor
   whose `href`/`data-href` references `intellisenseRecursion.previewBack`
   exists in the active hover.

Failures here indicate either a real layout regression or that VS Code
introduced a new position mode we haven't covered.

## What we observed and decided against

- **Forcing outer to shrink to content** (sync measurement, RAF measurement,
  `height: max-content`): breaks VS Code's click pipeline — the drilled hover
  is dismissed or relocated mid-click. Reverted.
- **Outer background transparent** (so visual shape = inner only): triggers
  the existing safety assertion "hover must use the real VS Code hover
  background, not a transparent fallback". Reverted.
- **Stripping `ir-keepalive`/`ir-sticky`**: regresses focus stability when the
  mouse moves over the hover. We keep these classes.
- **Removing the resizable-hover wrapper entirely**: not possible — it's a
  VS Code structural element.

Whenever a future change is tempted to shrink the outer or repaint it, this
section is the receipt that those paths were tried and abandoned.

## Visibility gate & zero-size pre-adoption state

`.monaco-hover` is **0 × 0 and `visibility: hidden`** by default. The
post-adoption rule selector `.monaco-resizable-hover .monaco-hover` is what
restores natural sizing and visibility. Reasoning:

- Without it, a freshly-created hover with verbose content paints at the
  inner element's natural size (huge) before our caps and the wrapper attach.
  The user sees the screen briefly covered, then the hover collapsing into
  place — visual terror.
- The 0×0 starting size also keeps the hover from being anchored at
  viewport (0,0) while VS Code is still computing its real anchor. The
  aligner skips wrappers that haven't been positioned yet (still at 0,0),
  so the hover doesn't park itself far from the symbol the user hovered.

## Known open issues

- **Drilled hover dismissed at `hover-bottom-right` (root cause identified
  2026-05-24):** in the focus-stability probe sequence (center → right-edge
  → bottom-edge → bottom-right), the drilled hover survives the first three
  corners and dismisses on the fourth. The diagnostic surveillance recorder
  added to `src/extension.ts` (search for `__irHoverEventLog` / `irHERecord`
  / `intellisenseRecursion.drainHoverEventLogForTests`) captured the exact
  event timeline at the failing probe. Findings:

  - The drilled hover paints at `(854, 322, 307 × 262)` so its right edge
    sits at `x = 1160.99`. In the test environment VS Code's built-in
    Chat / Agent welcome view (`.chat-welcome-view-container`) lives in the
    auxiliary bar at `x ≥ ~1140`, so the hover's right ~20 px overlap the
    chat panel region.
  - At the bottom-right probe `(1158.99, 582)`, `document.elementFromPoint`
    returns `chat-welcome-view-container`, not the hover. We bumped both
    `.monaco-hover` and `.monaco-resizable-hover` to `z-index:
    2147483647`, but the chat panel still wins the hit-test — the chat
    panel sits in a workbench stacking context (`.part.auxiliarybar` /
    `.composite.auxiliarybar`) that the hover's `position:fixed` z-index
    does not cleanly escape.
  - The event recorder shows the dismissal chain: a `pointerleave` fires on
    `.monaco-resizable-hover` (`relatedTarget = chat-welcome-view-container`),
    then a cascade up through `.monaco-editor` → `editor-instance` → ...
    → `monaco-grid-view`, then a `pointerenter` cascade down into the chat
    container. VS Code's HoverWidget interprets the `pointerleave` chain
    as "mouse left hover" and hides the wrapper (visibility/display).
    `.monaco-hover` style flips to `display:block; visibility:hidden;
    opacity:0; pointer-events:none`. Our `irDisposeHiddenActiveHover` then
    converts the hidden hover to `ir-native-released-hover`.

  Attempted fixes (none merged):

  - Swallowing leave events on `.monaco-resizable-hover` / `.monaco-hover`
    only (capture-phase `stopImmediatePropagation`) — VS Code still
    dismisses via the cascading leave on `.monaco-editor`.
  - Swallowing leaves on `.monaco-editor` too — opens the keybinding
    recorder during later probes (`Press desired key combination`),
    suggesting we are blocking focus/state tracking VS Code relies on.
  - Conditioning the editor-level swallow on
    `relatedTarget ∉ {.monaco-editor, .monaco-resizable-hover}` — same
    recorder regression.
  - Closing the auxiliary bar in test setup with
    `workbench.action.closeAuxiliaryBar` — that command itself triggers
    the keybinding recorder in our environment.

  Update (2026-05-24, late): the chat-welcome-view-container theory is
  *not the architectural root cause*; the user pointed out that the
  default VS Code hover at the same symbol works fine, so chat overlap is
  a symptom, not a cause. The real issue is that **we don't own the
  positioning of `.monaco-resizable-hover`**:

  - The widget class is `ResizableContentHoverWidget` (VS Code 1.121
    minified ID `Xk`, contribution ID
    `editor.contrib.resizableContentHoverWidget`).
  - Instances are registered via `this._editor.addContentWidget(this)`.
  - The drilled hover paints with the SAME top as the initial hover (good
    — that part is stable in the test). But VS Code keeps top fixed and
    lets the BOTTOM grow downward when the drilled content is taller,
    pushing the hover into screen rows occupied by other workbench panels.
  - To match the user's directive "drill-down을 해도 이전 symbol의 기준
    위치를 지켜야해", we need to keep the BOTTOM (or the symbol-anchored
    edge) fixed across drill-downs and let the top move UP into space
    we know is safely on top of the editor — same area the initial hover
    already validated. Setting `style.top/left` on the wrapper from a
    MutationObserver fights VS Code's positioning pipeline; when a stale
    anchor session from a prior probe bled into a fresh editor column,
    the wrapper became viewport-sized. Mutation-time enforcement is the
    wrong layer.

  The clean fix is to intercept `editor.addContentWidget` for content
  widgets whose `.getId()` is
  `editor.contrib.resizableContentHoverWidget`, capture the instance, and
  override `instance.getPosition()` to return our chosen anchor. That
  positions the widget at VS Code's natural layout step instead of
  fighting it afterwards. The diagnostic surveillance recorder and the
  anchor-session-tracking renderer code currently in `src/extension.ts`
  (search for `__irHoverAnchorSession`, `irMaybeBeginAnchorSession`,
  `__irSetDrillMode`) is the scaffold a future attempt can build on; the
  enforce path (`irEnforceWrapperAnchor`) is intentionally diagnostic-only
  for now and logs `anchor-drift-observed` events without mutating the
  DOM.

  Resolution (2026-05-25): Empirically, VS Code preserves the wrapper's
  `top` automatically when drill content swaps in — the drilled hover
  paints at the same top as the initial hover. The *real* visible
  problem is that VS Code lets the wrapper grow **downward** to fit the
  taller drilled content, so the new bottom sits in screen rows the
  initial hover never occupied. Even when those rows are pure editor
  text (no chat panel), the cursor can leave the hover bbox at slight
  mouse moves below the original symbol line.

  Fix (Option 3 of the dimension-control experiments): pure CSS using
  `:has(a[href*="previewBack"])` on the wrapper selects the drilled
  hover (it's the only one that renders the [← Back] command link from
  `applyPreviewStateAsHover`). The CSS caps `max-height` of the
  wrapper, `.monaco-hover`, and `.monaco-scrollable-element` so the
  drilled hover stays in the same screen footprint as the initial
  hover. Overflow scrolls internally via the scroller's existing
  `overflow:auto`. See the rules block in `src/renderer-patch.ts` (search
  for `previewBack`).

  Why CSS-only and not a JS hook: every JS-side attempt to influence
  the wrapper's height — patching `_setHoverWidgetDimensions`,
  `_resizableNode.layout`, the individual contents/scrollable/container
  setters, or setting `wrapperEl.style.height` directly — either
  failed (VS Code measured the natural content height first and used
  that to size the wrapper, ignoring the inner clamp) or tripped VS
  Code's keybinding-recorder UI in the test workbench. The pure-CSS
  path doesn't mutate any element or method, so VS Code's hover
  lifecycle runs untouched.

  Capture infrastructure (Map.set/Set.add/Array.push prototype patches,
  addContentWidget patch on the editor prototype, getPosition wrap on
  the hover widget) is left in place under `if(false)` guards. Pattern
  borrowed from the intellij-styled-search extension's renderer patch;
  reusable for future hooks that genuinely require a widget instance
  reference.

  The surveillance recorder is intentionally left active in the renderer
  (read-only, low overhead). To dump the buffer in tests, call
  `intellisenseRecursion.drainHoverEventLogForTests`; the focus-stability
  test (`src/test/suite/hover.test.ts`,
  `assertNativeHoverFocusStability`) already auto-drains when a probe
  records `hoverCount === 0`.
