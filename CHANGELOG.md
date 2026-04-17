# Changelog

All notable changes to the IntelliSense Recursion extension.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-04-17

Major hover performance overhaul. Target: ≤10 ms overhead on every hover, no
UI freeze on language-server stalls.

### Added
- **Position-level preview cache** — full preview block keyed by
  `uri:line:col` with 30 s TTL and types-list verification. Repeat hovers at
  the same point short-circuit the entire pipeline.
- **Document-open prefetch** — on active-editor change, extract the top 30
  PascalCase tokens by frequency and warm the definition cache in a throttled
  background queue (3 concurrent workers, 100 ms gap, 500 ms debounce, 1 MB
  file size cap). First hovers on visible files now serve from cache.
- **In-flight hover dedup** — when VS Code calls `$provideHover` for multiple
  providers at the same position, only the first handle computes; the rest
  share the same promise.
- **Smart anchor shortcut** — if the word under the cursor matches the type
  name, skip the full `docText` regex scan and use the word range directly.
- **Compiled-regex cache** — boundary-anchored regex per type name is reused
  across hovers and prefetch.
- **Absolute background timeout** — every `executeDefinitionProvider`,
  `executeHoverProvider`, and `openTextDocument` call in the background
  resolver is wrapped with a 3 s timeout, preventing zombie LS calls.

### Changed
- Hover handler now splits into a fast synchronous cache path and a
  best-effort race against a tight 5 ms budget. On budget miss, the resolve
  continues in the background to populate cache for the next hover.
- In-flight definition resolves are deduplicated per `uri:line:col:typeName`,
  avoiding duplicate LS calls across concurrent handles or types.
- `docText` is now lazy-loaded — skipped entirely when the smart-anchor path
  applies.
- Cache invalidation on save now clears both the definition cache and the
  new position-level preview cache, and re-enables prefetch for the saved
  document.

### Performance
- Repeat hover (same position): **<0.5 ms** (was 1–3 ms).
- First hover on prefetched file: **<1 ms** (was budget miss, no preview).
- LS stall or error: hover never freezes; bounded by 5 ms race + 3 s
  background timeout + 30 s negative cache.

## [0.1.8] - 2026

### Added
- Negative cache (30 s TTL) for definition-resolve failures, preventing
  repeated language-server hits on symbols with no definition.

### Fixed
- Hover document-resolution error on certain fallback paths.

## [0.1.7]

### Added
- Performance test suite and fixture code generators for multiple languages.
- Cleanup script for performance-test fixtures.

### Changed
- Import-follow engine and definition-search heuristics tightened.

## [0.1.6] and earlier

### Added
- Stress tests for TypeScript and Python fixtures.
- TypeScript model and service fixtures for integration tests.
- Multi-step go-to-definition fallback engine (regex → imports → defProvider
  → hover → package scanning) with per-step timeouts.
- Hover Cmd+Click navigation on type names via CDP renderer injection and
  protocol-level `$provideHover` patch.
- Initial release: hover type previews inside tooltips across 14+ languages.

[0.2.0]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.2.0
[0.1.8]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.1.8
[0.1.7]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.1.7
