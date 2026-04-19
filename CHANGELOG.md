# Changelog

All notable changes to the IntelliSense Recursion extension.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.2] - 2026-04-19

Rust sidecar: a compact symbol index that replaces most LSP fallback work.
Target: go-to-definition in µs for project and library symbols, no more
1.5 s `defProvider` timeouts on cold lookups.

### Added
- **`ir-indexer` sidecar binary** (new `indexer/` Rust crate) — tree-sitter
  based symbol extractor for Python and TypeScript. Produces a compact
  mmap-friendly binary index (header + FST + varint postings + roots table).
  Parses class / function / method / type alias / enum / module-level
  assignments / `self.X = …` in `__init__` / import aliases.
- **Multi-root indexing with source tags** (v2 format) — project, `venv`,
  `stdlib`, `typeshed`, `other`. `IndexManager` auto-detects:
  `.venv/lib/pythonX.Y/site-packages`, Python stdlib via `sysconfig`,
  the latest Pylance `typeshed-fallback`, and `node_modules/`.
- **Stdio JSON-RPC protocol** between extension and sidecar
  (`ping`, `stats`, `lookup`, `lookup_many`). Hits are returned with
  `path`, `line`, `col`, `kind`, `source`, `language`.
- **Fast-path in `resolveInBackground` and `goToTypeHandler`** — sidecar
  lookup runs before LSP. On an unambiguous hit, jump / preview directly.
- **Definitively-missing short-circuit** — when the sidecar has full
  library coverage for the origin language and returns zero hits for a
  type-shaped identifier (PascalCase / SCREAMING_SNAKE), skip the 1.5 s
  LSP cascade entirely.
- **Rebuild Symbol Index command** — force a rebuild from the command
  palette.
- **On-save re-index** — `.py` / `.pyi` / `.ts` / `.tsx` saves schedule a
  debounced (10 s) background rebuild, followed by an atomic sidecar
  restart.
- Expanded `SKIP_WORDS` with ~30 documentation / prose words
  (`Cannot`, `Could`, `This`, `That`, `Initially`, `Filesystem`, `F401`,
  …) to cut LSP calls on obvious non-symbols.

### Changed
- Ranking across sidecar hits now sorts by
  `(kind, source, path)` with two semantic overrides:
  - **Canonical type modules** (`node_modules/typescript/lib/lib.*`,
    `typing.py` / `typing.pyi`) have their `Variable` kind promoted to
    `Class`-level rank and their source promoted to project-level. The TS
    built-in `type Omit = …` and Python stdlib `Union = _SpecialForm(…)`
    now beat a library's `static Omit()` method or a vendored copy.
  - **Path sub-rank** within a source prefers `typescript/lib/` →
    `@types/node/` → `@types/react/` → `@types/*/` → other packages, and
    demotes `test-data/`, `tests/`, `jedi/third_party/`, `mypy/typeshed/`.
- `fastResolveTypeName` accepts a sidecar hit only when there is exactly
  one project-side non-alias candidate, or (for external-only hits) the
  identifier passes a shape gate — prevents spurious jumps from
  lowercase params (`modal`, `common`, `form`) landing in random
  dependencies.
- Language filter on every lookup: `.py` / `.pyi` queries return only
  Python hits, `.ts` / `.tsx` / `.d.ts` queries only TypeScript. No more
  cross-language jumps from `.tsx` into `.pyi` stubs.
- Click handler gates Step 0 on `docUriStr`'s language so TS clicks
  aren't funnelled through a Python-only index.
- Walker no longer excludes `dist/` / `build/` inside extra roots —
  npm packages (styled-components, @apollo, MUI) ship their `.d.ts` in
  `dist/`, which was previously skipped, leading to missing
  `IStyledComponentBase` / `FastOmit` and similar.
- Walker no longer inherits the project's `.gitignore` into extra roots
  (`parents(false)`), so `node_modules/` entries in the workspace's
  `.gitignore` don't invalidate the explicitly-requested root.

### Performance (captain monorepo, 73 k files indexed)
- Index size: 21.06 MiB total
  (project 20 937 / venv 24 829 / stdlib 2 590 / typeshed 4 672 /
  node_modules 20 352).
- Cold build: ~11 s. Rebuild on save: debounced 10 s + ~11 s.
- Sidecar cold lookup (Rust query): p50 0.25 µs, p99 &lt;150 µs for
  1000-hit symbols.
- End-to-end lookup from Node (stdio JSON): p50 20 µs, p99 134 µs.
- Observed real-world impact:
  - `IStyledComponentBase` click: 3550 ms timeout → 18 ms.
  - `_RWrapped` (stdlib `functools.pyi`): timeout → 11 µs.
  - `TYPE_CHECKING` / `Self` / `Any`: 1.5–2.2 s LSP timeout →
    `typing.pyi` fast-path.
  - Type-shaped names that nowhere match (e.g. `FIXME`, `LLC`, generic
    type parameters in jQuery stubs): 1.5 s timeout → µs short-circuit.

### Packaging
- Dev builds locate the binary at `indexer/target/release/ir-indexer`.
  Packaged builds download the current-OS sidecar from the matching GitHub
  Release into VS Code global storage on first activation, verify it against
  `SHA256SUMS`, then use it. If the download is unavailable, they compile
  the bundled Rust source via `cargo build --locked --release`. If both
  paths fail, the extension logs a warning and runs in LSP-only mode.
- Per-workspace index cached at
  `~/.cache/intellisense-recursion/<sha1-16>.bin`. The cache key is the
  workspace root path. Cleared on uninstall.

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

[0.2.2]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.2.2
[0.2.0]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.2.0
[0.1.8]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.1.8
[0.1.7]: https://github.com/newdlops/intellisense-recursion/releases/tag/v0.1.7
