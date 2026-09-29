# Renderer performance

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
