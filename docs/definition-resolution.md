# Original definition resolution

## Import-aware fallback (2026-09-29)

A production `Company` hover resolved to the unrelated `Company` attribute in
`openpyxl/packaging/extended.py:49`. The existing index contained that attribute
but lacked the project's original class. The source document explicitly imported
`Company` from `zuzu.db.models.company.company` under `TYPE_CHECKING`.

The fast resolver now keeps explicit imports scoped to their module, including
multiline Python imports and aliases. Within that scope, implementation files
take precedence over stubs. If the index misses a workspace import, the resolver
reads the exact candidate files through the existing bounded raw-file cache and
looks for the imported top-level declaration. Open documents take precedence so
unsaved source remains visible. This adds no workspace-wide scan or index rebuild.

Unresolved explicit imports, conflicting bindings and ambiguous external
definitions fall back to the language server. Unqualified external attributes
and methods cannot stand in for a same-named type. An index miss no longer
suppresses the language server for an explicitly imported name. Valid third-party
imports still resolve normally; this is not a package blacklist.

The existing production index and actual project files were checked read-only:
the resolver now selects `zuzu/db/models/company/company.py:252`, a `Company`
class. The reason that class was absent from the existing index is not established.

The shipping bundle passed 13 focused checks: eight resolver cases, a real VS Code
hover-provider and go-to-command integration test, and four complete-source preview
tests. The integration test opens only the importer, leaving the source outside
the index and unopened. This correction changes definition selection; no new
renderer or visual verification is claimed.

```sh
npm run bundle
IR_E2E_FILES=definition-origin.test.js,preview-content.test.js TEST_FIXTURE=python node out/test/runTest.js
```
