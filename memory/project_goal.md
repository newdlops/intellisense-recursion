---
name: project_goal
description: IntelliSense Recursion extension - make hover type names navigable like IntelliJ, using V8 Inspector monkey-patch on $provideHover
type: project
---

VS Code extension that enables navigating to type definitions from hover tooltips, like IntelliJ IDEA.

**Why:** VS Code hover code fences are static HTML — no Cmd+Click. IntelliJ allows clicking type names in quick docs to navigate.

**How to apply:**
- Core technique: V8 Inspector extracts shared `ExtHostLanguageFeatures` (variable `et`) from `registerHoverProvider` closure
- Patch `$provideHover` on the shared instance to intercept ALL hover results (including Pylance)
- Current approach: suppress hover, open Peek Editor instead (real Monaco Editor with Cmd+Click)
- User wants peek to look/feel more like hover with descriptions, not just raw definition peek

**Key files:**
- `src/extension.ts` — all logic in one file
- V8 Inspector closure extraction is fragile (minified var name `et` may change across VS Code versions)
