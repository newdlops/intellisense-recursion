# Renderer performance

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
