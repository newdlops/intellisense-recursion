# Renderer performance

## Keyboard symbols release 0.2.6053 / patch 326

2026-10-20. Pinned hovers offer a named Symbols button using the existing native
tokens and codicon. It opens VS Code's Quick Pick: type part of a name, choose
with arrows/Enter and preview in the originating panel. The picker searches
the complete original page, including types and lowercase callables beyond
the eager link prefix. Only its result list is limited to 200 unique matches;
the source, comments, description, token nodes and history are not shortened.
Queries debounce for 100ms and yield between matched source chunks. A temporary
source snapshot is released on cancellation, navigation, close or failure.

Picker, query, page and preview-request identities reject stale results and
selections. A delayed dismissal of an older picker cannot close its successor.
An unacknowledged open releases the disabled button after five seconds; read
failures keep the page and offer another attempt through the same action.
Native Quick Pick/Command Palette controls paint above the detached portal.

Rendered tests exposed native focus work arriving after picker hide and
definition delivery. Focus returns after bounded animation frames; keyboard,
pointer or wheel input cancels that return. Another visible native input or
unfocused document prevents it. Pin also reuses the native refire path bound
to the document editor, checks the cursor before/after hide, and uses no native
autofocus. An absent result can be requested again within the existing wait;
highlighting in progress is not restarted. This avoids a global Show Hover
targeting another input or delayed native hover focus disrupting the picker.

### Functional and visual verification

The shipping minified bundle passed **21 checks** in VS Code 1.142.0 on macOS
ARM64: the existing 18 content/candidate/startup/recovery/Pin checks and three
keyboard-symbol checks. Normal key/pointer events cover Pin → Symbols → query
→ real definition delivery → Back → Close, no matches, a lowercase callable
and type after 10,025 source-detail lines, rapid queries, cancellation, native
command-palette replacement, independent panels, stale accepts after page/close,
stale dismissal, missing acknowledgement, delayed reads and read errors. A late
delivery after an actual editor click does not steal focus. Whole source text,
ordered token classes and the exact saved scroll offset survive Back. Pin's
provider intentionally returns empty once, then the normal command recovers.

The symbol tests use deterministic language providers for a freshly created
large file, plus the real preview builder, native renderer, public Pin command,
Quick Pick, binding transport and definition delivery. Error/late cases control
the binding only to reproduce failures and delays. Native startup, resize,
source-file links and detached session isolation have separate existing checks.

The final bundle passed the same three symbol checks at a 1024 × 768 desktop
viewport. Screenshots were inspected at 1440 × 900 and 1024 × 768, including a
250px-wide panel, a dense list, empty and delayed query states, errors, keyboard
focus, successful preview, full highlighted tail after Back, native resize and
Retry. The smaller viewport uses Electron CDP metrics emulation. Document focus
emulation isolates the test host; this does not certify physical OS focus routing.

Fourteen development-build compatibility/performance checks also passed. For
1,000 pointer movement pairs, the workload used zero document queries and zero
geometry reads (8.2ms). Forty editor paint batches used two queries and zero
geometry reads (8.8ms); none of 64 disposed probes remained retained. The
[raw measurements](../reports/ui-audit-2026-10-20/renderer-release-6053.json) and
[release record](../reports/ui-audit-2026-10-20/release-0.2.6053.json) retain the
evidence. These are workload regressions, not whole-process CPU/GPU, memory or
general speedup claims.

Impeccable's scoped detector returned no findings during implementation. Final
source review against the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)
checked button names/semantics, decorative icons, focus-visible and disabled
states, polite failure status, large-list handling, keyboard alternatives and
native layering. Quick Pick is provided through the [VS Code API](https://code.visualstudio.com/api/references/vscode-api#QuickPick).
Other operating systems, VS Code versions, physical multiple-window focus,
light/high-contrast themes, screen readers, touch and mobile/tablet viewports
were not checked. Source copy, body-text search and the window-cap policy
remain separate future candidates.

```sh
npm run bundle
IR_VSCODE_VERSION=1.142.0 IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=renderer-startup.test.js,hover-link-candidates.test.js,hover-content.test.js,preview-content.test.js,preview-content-renderer.test.js,detached-preview-recovery.test.js,pin-hover.test.js,hover-symbol-picker.test.js TEST_FIXTURE=python node out/test/runTest.js
IR_VSCODE_VERSION=1.142.0 IR_TEST_PRODUCTION_INJECTION=1 IR_SYMBOL_VIEWPORT=compact IR_E2E_FILES=hover-symbol-picker.test.js TEST_FIXTURE=python node out/test/runTest.js

npm run compile
IR_VSCODE_VERSION=1.142.0 IR_PERF_LABEL=release-6053-final IR_E2E_FILES=renderer-performance.test.js,preview-cache-budget.test.js,preview-file-link.test.js,hover.test.js IR_E2E_GREP='Renderer performance|Preview cache resource budgets|Preview file path links|detached hover links use an isolated end-to-end preview protocol|content-aware native hover stays adjacent' TEST_FIXTURE=python node out/test/runTest.js

npm run bundle
```

## Explicit Pin release 0.2.6052 / patch 325

2026-10-20. Native hovers now offer a sticky Pin action and the
`IR: Pin Hover at Cursor` command. Both reuse complete detached snapshots and
isolated preview sessions. The command uses normal native Show Hover when the
palette dismissed the tooltip; missing hover/editor states create no empty
window, and concurrent invocations share one operation. Native wrapper sizing
and resize sashes remain owned by VS Code.

Pin waits for native asynchronous code-block highlighting. A cloned unfinished
placeholder would not inherit the callback that replaces it. The action shows a
preparing status while disabled, and the command waits briefly before returning
an informative native notification. A focused pinned window closes with Enter
on Close or Escape, returning focus to its connected editor. When Back hides,
focus moves to Close instead of disappearing with the button.

Rendered tests exposed two independent scroll hazards: browser anchoring while
Markdown blocks are consolidated, and offsets clamped against temporary layout
heights. Detached scrollers disable browser anchoring, and Pin/Back share a
restoration bounded to four animation frames. New navigation, closing or direct
scroll/pointer/key input invalidates pending restoration. No source lines,
comments, docstrings, token classes or history pages are removed by this change.

### Functional and visual verification

The final shipping bundle passed 18 checks in VS Code 1.142.0 on macOS ARM64.
The existing 16 content/candidate/startup/recovery checks and two Pin checks
cover real pointer Pin, wheel scrolling with a reachable sticky action, the
public command, actual command-palette keyboard input, coalesced invocations,
Shift+Tab/Enter on Back, Enter on Close, Escape and editor focus restoration.
The Pin test compares all rendered source text and ordered token classes for
10,025 source detail lines, then verifies the exact saved offset after Pin and
Back. Independent panels and missing hover/editor guards are included.

Fourteen additional development-build checks passed for renderer performance,
cache budgets, preview file links, real detached preview transport/session
isolation and repeated native sizing/forward/Back behavior. The pointer workload
performed zero document queries and zero geometry reads for 1,000 movement pairs
(9.3 ms in this run). Forty editor paint batches used two queries and zero
geometry reads; none of 64 disposed probes remained retained. These are existing
regression checks, not general CPU/GPU, memory or interaction-speed claims.
[Release measurements](../reports/ui-audit-2026-10-20/renderer-release-6052.json)
retain the complete workload report.

Screenshots were inspected at 1440 × 900 for initial and scrolled native Pin,
the new detached panel, two independent pinned panels and a 250px-wide panel.
The prior long-source final-line highlighting, native sash and Retry cases
remain part of the release checks. This is desktop/panel QA; whole mobile and
tablet viewports, other operating systems, light/high-contrast themes and screen
readers were not checked. The focused-document fallback was exercised by the
isolated Electron tests; multiple OS-level workbench windows were not tested.

Impeccable's detector completed without findings. Source review against the
Web Interface Guidelines checked button semantics and names, decorative icon
labels, focus-visible styling, live preparing/error status, sticky focus padding
and the keyboard alternative to dragging. This is a scoped review, not a claim
that the existing product's remaining keyboard type-navigation gap is resolved.

```sh
npm run bundle
IR_VSCODE_VERSION=1.142.0 IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=renderer-startup.test.js,hover-link-candidates.test.js,hover-content.test.js,preview-content.test.js,preview-content-renderer.test.js,detached-preview-recovery.test.js,pin-hover.test.js TEST_FIXTURE=python node out/test/runTest.js

npm run compile
IR_VSCODE_VERSION=1.142.0 IR_PERF_LABEL=release-6052-final IR_E2E_FILES=renderer-performance.test.js,preview-cache-budget.test.js,preview-file-link.test.js,hover.test.js IR_E2E_GREP='Renderer performance|Preview cache resource budgets|Preview file path links|detached hover links use an isolated end-to-end preview protocol|content-aware native hover stays adjacent' TEST_FIXTURE=python node out/test/runTest.js

npm run bundle
```

## Preview recovery release 0.2.6051 / patch 324

2026-10-20. Failed detached previews now retain the current complete source and
scroll position while showing a specific status and a native Retry button.
Retries share the existing isolated request protocol; older apply, failure and
commit responses cannot overwrite or unlock a newer request. Back retains the
original source DOM and waits a bounded number of frames for its scroll layout.

Rendered verification also exposed a titlebar painted behind cloned content.
The titlebar now owns a stacking context, and its full status is available in a
tooltip and a polite live region. A detached window's consolidated active page
keeps its full layout height after restoration and resizing. Native multi-block
hovers retain their existing content-visibility optimization. Displayed source,
syntax highlighting and navigation history are not shortened.

### Release verification

VS Code 1.142.0 on macOS ARM64, Python fixture:

- Shipping minified bundle: 16 passed, covering the 15 content/candidate/startup
  checks below plus detached error and recovery. Actual mouse Retry, Tab and
  Shift+Tab, Enter, Back and Close preserve 10,025 source detail lines, exact
  source markup and the saved scroll offset. Duplicate retries and stale
  apply/failure/commit messages are rejected. A second window remains intact.
- Development build: 14 passed, covering renderer performance, cache budgets,
  source-file navigation, actual detached preview transport and independent
  sessions, and repeated native sizing/forward/Back behavior.
- Actual screenshots were inspected at 1440 × 900: failure and disabled loading
  states, a 250px-wide detached panel with a long Korean/Latin name, highlighted
  complete-source tails after native scrolling, drag and Back, and native sash
  resizing. Retry and Close remain visible in the narrow titlebar; the source
  remains visible at its restored offset.

The recovery test controls the binding only to produce deterministic errors and
delayed replies. The separate detached-protocol test uses the real extension
transport. Geometry/readiness checks precede the final narrow screenshot.
Light/high-contrast themes, screen readers, other operating systems and whole
mobile/tablet viewports were not checked. A live region is implemented; no
screen-reader certification is inferred.

The final pointer workload used zero document queries and zero geometry reads
for 1,000 movement pairs (6.4 ms in this run). Forty editor paint batches used
two queries and zero geometry reads. These are regression checks, not a general
CPU/GPU, memory or interaction-latency claim. The
[release measurements](../reports/ui-audit-2026-10-20/renderer-release-6051.json)
are retained alongside the patch 323 candidate microbenchmark below.

```sh
npm run bundle
IR_VSCODE_VERSION=1.142.0 IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=hover-link-candidates.test.js,hover-content.test.js,preview-content.test.js,preview-content-renderer.test.js,renderer-startup.test.js,detached-preview-recovery.test.js TEST_FIXTURE=python node out/test/runTest.js

npm run compile
IR_VSCODE_VERSION=1.142.0 IR_PERF_LABEL=release-6051-final IR_E2E_FILES=renderer-performance.test.js,preview-cache-budget.test.js,preview-file-link.test.js,hover.test.js IR_E2E_GREP='Renderer performance|Preview cache resource budgets|Preview file path links|detached hover links use an isolated end-to-end preview protocol|content-aware native hover stays adjacent' TEST_FIXTURE=python node out/test/runTest.js

npm run bundle
```

## Complete source preserving cleanup in patch 323

2026-10-20. Complete original code is the primary product requirement. This
cleanup changes only a temporary candidate array and the test launchers. It
does not cap displayed lines or characters, remove syntax highlighting, shorten
comments, change native layout, or prune navigation history.

`irCollectTypeShapedCandidates` now supplies its existing line budget to
`String.split`. Previously it allocated an array for the entire definition
before scanning its bounded prefix. Candidate order, constant slots, skip words
and the complete last scanned line remain the same. On-demand type links still
work after the eagerly indexed prefix.

Five new generated-renderer checks cover those rules, including a long first
line and names beyond 900 lines when an unrestricted scan is requested. The
existing full-content renderer test now also requires syntax highlighting on
the final source line and creates a real pointer-driven type link after 10,025
source detail lines. Native scrolling, drag-to-detach and Back restore the whole
definition as before.

### Candidate collection measurement

Node VM function microbenchmark, seven samples of ten calls each. The current
limited split is compared with the original full split and the earlier manual
line-reader experiment. All eight comparison inputs produce identical candidate
lists. This does not measure Electron interaction latency or whole-process RSS.

| Source lines | Original full split | Manual line reader | Limited split in patch 323 |
| --- | ---: | ---: | ---: |
| 1,002 | 0.061 ms | 0.119 ms | 0.056 ms |
| 10,002 | 0.174 ms | 0.105 ms | 0.033 ms |
| 100,002 | 2.091 ms | 0.090 ms | 0.037 ms |

[Raw candidate measurements](../reports/ui-audit-2026-10-20/candidate-after-cleanup.json)
and the [benchmark](../reports/ui-audit-2026-10-20/candidate-benchmark.cjs) are retained.
The existing pointer workload still performs zero document queries and zero
geometry reads outside hovers. The verification run took 7.7 ms for 1,000
pointer/mouse movement pairs; timings vary with workbench activity. Forty editor
paint batches used six DOM queries and zero geometry reads, and none of 64
disposed editor probes remained retained. These pass the existing regression
thresholds; no general CPU or GPU improvement is inferred.
[Renderer measurements](../reports/ui-audit-2026-10-20/renderer-after-cleanup.json)
record the full workload.

### Functional and visual verification

The unchanged patch 322 first passed nine content checks in VS Code 1.142.0 on
macOS ARM64. Patch 323 then passed 29 checks in two runs:

- Shipping minified bundle: five candidate checks, four native delivery checks,
  four Python/TypeScript document-versus-file source comparisons, the strengthened
  long-content renderer test, and production startup: 15 passed.
- Development build: three renderer performance checks, two cache budget checks,
  seven file-link checks, detached-session isolation, and content-aware native
  sizing with repeated forward/Back navigation: 14 passed.

The long source, native resize and persistent-drag captures were inspected at
1440 × 900, including the highlighted final line, late type link and Back-restored
detached content. The preview retains every numbered source line. Native sash
growth, preserved manual dimensions after a type click, the production click
bridge, native/detached source-file click and detached Enter all passed. The
independent-window test confirms that navigating or closing one window leaves
the second window and native hover state intact.

Smaller viewports, light/high-contrast themes, screen readers, other operating
systems and whole-process memory were not rechecked in this cleanup. Native
history retention is unchanged because a new limit must first preserve the
existing Back behavior. Impeccable's detector reported no findings; the source
diff changes no CSS, token, control, displayed-source or highlighting path.

### Reproduction

All three test launchers now share `testVSCodeExecutablePath`. Set
`IR_VSCODE_VERSION` to pin a downloaded version, or `IR_VSCODE_EXECUTABLE_PATH`
to use an executable already installed. The helper supports both the old macOS
`Electron` filename and the current `Code` filename. The cached 1.142.0 path was
resolved and both test runs completed without a temporary wrapper.

```sh
npm run bundle
IR_VSCODE_VERSION=1.142.0 IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=hover-link-candidates.test.js,hover-content.test.js,preview-content.test.js,preview-content-renderer.test.js,renderer-startup.test.js TEST_FIXTURE=python node out/test/runTest.js

npm run compile
IR_VSCODE_VERSION=1.142.0 IR_PERF_LABEL=cleanup-323 IR_E2E_FILES=renderer-performance.test.js,preview-cache-budget.test.js,preview-file-link.test.js,hover.test.js IR_E2E_GREP='Renderer performance|Preview cache resource budgets|Preview file path links|detached hover links use an isolated end-to-end preview protocol|content-aware native hover stays adjacent' TEST_FIXTURE=python node out/test/runTest.js

node reports/ui-audit-2026-10-20/candidate-benchmark.cjs reports/ui-audit-2026-10-20/candidate-after-cleanup.json
npm run bundle
```

## Complete content delivery in patch 322 (2026-09-29)

Performance limits must not shorten hover content. Removed the 10,000-line
definition cap and 600-line value scan cap; builders now retain each resolved
definition through its structural end. Eager navigation indexing splits only
its first 24 lines into a temporary array, keeping the full display payload.
The existing cache byte/entry budgets and expiry still apply to retention.

Actual rendering exposed a second limit: VS Code 1.139.1 truncates each Markdown
item after 100,000 UTF-16 code units and appends an ellipsis. The final provider
boundary now delivers large Markdown in smaller items, reopening code fences
with their language. Original Markdown stays whole in caches/history and small
results pass through unchanged. Detached clones consolidate the rendered blocks
into one page target so navigation and Back replace/restore every continuation.

The shipping bundle passed ten targeted checks: four complete-source comparisons
(Python/TypeScript classes beyond 10,000 lines and values beyond 600 lines, each
through document and raw-file builders), four delivery/Unicode/metadata checks,
a large-content rendering test, and the production startup regression. In the
rendering test, a deterministic provider supplies the real builder's result to
VS Code's native hover. Real wheel and drag input reaches the final source line
in native and detached panels; a renderer navigation round trip replaces and
restores all 10,025 numbered lines. The startup regression covers real source
hovering, 1px borders, native resize and the production type-link bridge.

Screenshots of the native tail, detached tail, Back-restored tail and resized
native hover were inspected at 1440 × 900. Smaller viewports and whole-process
resource usage were not measured in this correction. Build and JavaScript syntax
checks passed. A large visible definition necessarily retains its full content;
the cache budget is not a limit on the active panel's memory.

```sh
npm run bundle
IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=hover-content.test.js,preview-content.test.js,preview-content-renderer.test.js,renderer-startup.test.js TEST_FIXTURE=python node out/test/runTest.js
```

## Resource reduction in patch 321 (2026-09-29)

The always-installed diagnostic event recorder was doing DOM searches and
geometry reads before checking whether recording was enabled. Its 22 document
listeners and body/attribute observers also survived patch cleanup.

- Install diagnostic listeners, hover observers and the long-task observer only
  while `window.__irHoverEventLogConfig.enabled` is true. Toggling that existing
  flag works after startup. Disabling or replacing the patch disconnects every
  diagnostic observer, cancels queued work and releases recorded DOM references.
- Keep 128 recent audit entries in normal operation; full diagnostic recording
  retains its configurable limit. Native mode uses one link-intent handler;
  compatibility mouse events at the same position share the pointer work.
- Cancel the markdown scan with the matching idle/animation/timer API, and stop
  editor discovery retries during cleanup. Cleanup is safe to repeat.
- Give the definition and position-preview caches a **4 MiB estimated retained
  payload budget each**, in addition to their existing 200/100 entry limits.
  Cache hits update recency without extending the existing 60/30 second TTLs.
  One timeout per populated cache releases expired entries during idle periods;
  empty caches have no timeout. Closed definition documents are released from
  both source-keyed and destination-keyed cache entries.
- Oversized preview results bypass retention and remain complete for the current
  request. The cache limit never truncates displayed code. Repeated oversized
  requests may need to rebuild their preview; the existing raw-file cache still
  applies.

### Measurements

Same Python fixture in isolated VS Code 1.139.1 windows on macOS ARM64. Patch
320 was saved before implementation. The pointer workload dispatches 1,000
movement pairs (`pointermove` + compatibility `mousemove`) outside any hover.
These are focused workload measurements, not whole-process CPU or RSS figures.

| Workload | Patch 320 | Patch 321 |
| --- | ---: | ---: |
| Document-wide queries during pointer workload | 2,000 | 0 |
| `closest()` calls during pointer workload | 22,000 | 4,000 |
| Pointer workload duration | 75.2 ms | 9.4 ms (first run: 10.7 ms) |
| DOM queries during 40 editor-paint batches | 2 | 2 |
| Disposed editor probes retained, out of 64 | 0 | 0 |
| Diagnostic listeners installed with recording disabled | 22 | 0 |

Timing is diagnostic, not a CI threshold. The unchanged collection workload's
median varied from 11.1 to 15.2 ms across these runs; no general CPU percentage
is inferred. The new memory budgets estimate UTF-16 payloads plus per-entry
overhead; they do not bound VS Code's total heap or the size of an open document.
GPU usage, RSS and cold-start latency were not measured.

Reports are `ir-renderer-perf-resources-before.json` and
`ir-renderer-perf-resources-after-final.json` in the system temporary directory.
The unbundled performance tests now establish their own isolated window marker:

```sh
npm run compile
IR_PERF_LABEL=current IR_E2E_FILES=renderer-performance.test.js,preview-cache-budget.test.js TEST_FIXTURE=python node out/test/runTest.js
```

The three renderer performance tests and two preview-cache budget tests passed.
They cover recording opt-in, actual event/attribute recording, repeated enable /
disable, reinjection while recording, bounded LRU retention, oversized results,
destination invalidation and expiry without lookups. The existing three raw-file
cache tests also passed.

### Functional and visual verification

The minified renderer passed three real mouse drag tests (body, text and held
type link), including two independent persistent panels, titlebar movement and
closing only one panel. Automatic sizing above/below the token, two real
forward/Back cycles, the flexible sash opt-in and seven preview file-link tests
also passed in VS Code 1.139.1.

The shipping bundle, with test injection commands removed, passed automatic
production startup, all four 1px borders, real right-edge/corner sash drags,
type navigation and persistent dragging. Screenshots were inspected at
1440 × 900 for native, resized, drilled, restored and detached content. Smaller
viewports and hardware GPU counters were not rechecked in this pass.

This stronger startup check exposed a pre-existing combination failure:
resizing then drilling shrank the native panel while its manual-size flag
prevented automatic growth. The saved patch 320 reproduced it. Patch 321 saves
the completed drag dimensions and restores them through the native widget after
content replacement, within viewport/anchor limits. The shipping regression
now waits for content to fit and asserts those dimensions survive navigation
before detaching. It passed with the full preview visible in the final capture.

The final production extension is 619,599 bytes; the renderer script is 346,983
bytes after minification. The additional lifecycle bookkeeping slightly grows
the bundle; this pass targets runtime work and retained memory. No cold-start
speedup is claimed.

```sh
npm run bundle
IR_TEST_PRODUCTION_INJECTION=1 IR_E2E_FILES=renderer-startup.test.js node out/test/runTest.js
```

After installing the new build, reload the VS Code window. Patch 320 did not
keep handles for its diagnostic listeners/observers, so an in-place script
replacement cannot retroactively remove those older handlers.

## Changes in renderer patch 317

- Stop intercepting `Map`, `WeakMap`, `Set`, `Array` and `Reflect` once a native
  editor service is available. Subscribe to its editor add/remove events instead.
  Before discovery, check native widget fields before inspecting methods; this
  also avoids mistaking RPC proxies for editor widgets.
- Release captured editors on disposal and dispose capture subscriptions on
  patch cleanup. Use the native service to enumerate live editors.
- Skip ordinary Monaco token/line mutations outside a hover before searching
  their descendants. Prune hover state when its roots detach or relevant hover
  content changes.
- Coalesce type-link bounds reads per block into one animation frame after DOM
  wrapping. Pointer handlers still measure the clicked link immediately.
- Start renderer injection without blocking extension activation on CDP
  discovery. Commands and hover providers are registered first.
- Minify the generated renderer script as well as the extension bundle. Remove
  test command harnesses from production builds and package only
  `out/extension.js` from the compiled output directory.

Native positioning, content-aware height, manual resize preferences, theme
colors, and scrolling remain owned by the existing hover paths. Reload the
VS Code window after installing a new build: old renderer versions cannot
retroactively release their permanently installed prototype hooks.

## Measurements

Measured on macOS ARM64 with an isolated VS Code 1.128.0 development host and
the Python fixture. The baseline was patch 316, including the native hover
anchor fix. These are focused workloads, not whole-application resource usage.

| Workload | Baseline | Optimized |
| --- | ---: | ---: |
| DOM queries during 40 editor-paint batches | 4,002 | 2 |
| Disposed editor probes retained by our capture list, out of 64 | 64 | 0 |
| 50,000 records through four collection APIs, median of seven passes | 33.1 ms | 23.8 ms; 20.9 ms on the verification run |
| Production extension JavaScript | 1,589,172 bytes | 609,785 bytes (61.6% smaller) |

Each DOM batch replaces 50 `.view-line` rows containing five token spans each.
MessageChannel yields let observers run without background-window timer
throttling. Query counts and retained references are regression assertions;
timings are diagnostic only. The first optimized DOM run took 23.8 ms versus
41.0 ms for the baseline, but a later run took 179.7 ms while the workbench was
busy. This is why no stable overall CPU or startup-speed percentage is claimed.

The production renderer generator emits 732,437 bytes before minification and
339,737 bytes afterward. Fewer bytes are loaded, parsed and sent over CDP.
GPU utilization, GPU memory, full-process RSS and cold-start latency were not
measured. Batching layout reads reduces avoidable rendering work; it does not
establish a hardware GPU usage reduction.

After the native resize and navigation fixes, patch 319's production bundle is
614,427 bytes; its renderer script is 739,622 bytes before minification and
343,690 bytes afterward. Test command harnesses remain excluded.

## Verification

- TypeScript compilation and production bundling.
- Two renderer performance tests: mutation work/reference release, and switching
  a real split editor from global interception to native service events.
- Minified build: seven preview file-link tests, including native click,
  detached click and Enter activation.
- Minified build: real native hover growth above and below its token, repeated
  layout, short-content sizing, native sash alignment, direct pointer entry,
  and an actual type-link click that drills into `BaseModel`.
- Final production build with test commands removed: three smoke tests for
  hover content, duplicate-preview prevention and definition-provider results.
- `vsce ls --no-dependencies`: the only packaged compiled module is
  `out/extension.js`.

The pre-existing annotation drill test (`hover panel annotation symbols are
drill-down links`) failed with both the saved baseline and patch 317 build.
It uses a seeded hover and was not rerun for patch 319; it must not be counted
as passing coverage.

Patch 319 corrected native type-click routing to the source editor and cleared
stale click deduplication on Back. Its minified automatic-size test passed two
real mouse forward/Back cycles, including short-content fit and token placement.
Both real sash-drag tests passed separately. The earlier combined run had a
scroll-range failure and CDP input timeouts; these isolated results do not claim
combined-suite stability. See [hover behavior](hover-ui-structure.md#refiring-the-owning-native-hover).

Visual inspection covered real rendered hovers in the test renderer at
1440 × 900 and an emulated 1024 × 768 viewport. The additional emulation run's
scroll-range assertion also failed with the saved baseline, so full behavior
at the smaller size is not claimed as verified. Electron does not expose the
CDP `Browser.getWindowForTarget` method here, preventing the attempted native
window-resize check. This is a desktop extension; phone layouts were not tested.

## Reproduction

```sh
npm run compile
IR_PERF_LABEL=current IR_E2E_GREP='Renderer performance' TEST_FIXTURE=python npm run test:python
```

The performance test writes `ir-renderer-perf-current.json` in the system
temporary directory. Run it from an unbundled development build because its
CDP helper shares the extension's module state.

To exercise the minified renderer with the command-based hover harnesses:

```sh
IR_TEST_BUILD=1 npm run bundle
IR_E2E_GREP='content-aware native hover stays|Preview file path links' TEST_FIXTURE=python npm run test:python
```

Run `npm run bundle` again to produce the shipping build. Production bundles
deliberately exclude the test commands. No additional runtime dependency is
needed for these optimizations.
