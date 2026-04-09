---
name: project_goal
description: IntelliSense Recursion - hover Cmd+Click navigation via V8 Inspector + CDP renderer injection
type: project
---

VS Code extension: Cmd+Click on type names in hover tooltips → navigate to definition.

**Architecture (3 layers):**

1. **$provideHover monkey-patch** (Extension Host, V8 Inspector)
   - Extracts shared `ExtHostLanguageFeatures` (var `et`) from `registerHoverProvider` closure
   - Patches `$provideHover` to intercept ALL hover results (Pylance included)
   - Adds definition preview to hover content

2. **Renderer DOM injection** (SIGUSR1 → Main Process CDP → Renderer debugger)
   - SIGUSR1 to VS Code main process → inspector on port 9229
   - WebSocket CDP → `BrowserWindow.webContents.debugger.sendCommand('Runtime.evaluate')`
   - base64-encoded script injected into Extension Dev Host renderer
   - setInterval polls `.rendered-markdown code` → splitText wrapping of PascalCase types
   - CSS: `body.ir-cmd-held .ir-type-link:hover { underline }` (Cmd + mouse position)

3. **Click communication** (Runtime.addBinding → global polling)
   - `Runtime.addBinding({name: 'irGoToType'})` on renderer (CSP bypass)
   - Click handler calls `window.irGoToType(typeName)`
   - Main process `debugger.on('message')` sets `global.__irClickedType`
   - Extension host polls `global.__irClickedType` every 1s via main process CDP

**Working:**
- Hover type signature: Cmd+hover underline + Cmd+Click → definition navigation
- Runtime.addBinding CSP bypass
- 1s polling (no hover interference)

**Issues:**
- Preview code fences appended to hover value don't render as `<code>` DOM elements
- Possible cause: Pylance's `<!--moduleHash:-->` comment breaks markdown parsing
- Renderer `.rendered-markdown code` selector sometimes finds 0 elements (window switching?)

**Key fragilities:**
- V8 Inspector var name `et` is minified, changes across VS Code versions
- SIGUSR1 + port 9229 assumption
- Main process PID detection via `ps aux` grep (macOS only)
- Multiple Extension Dev Host windows can confuse injection target
