# IntelliSense Recursion

**Cmd+Click on type names in hover tooltips** to navigate to their definitions — like IntelliJ IDEA.

VS Code's hover tooltips show type information but the text is static. This extension makes type names in hover clickable, so you can drill into definitions without leaving the hover context.

## Features

- **Cmd+Click in hover**: Hold Cmd and hover over a type name in the tooltip — it underlines. Click to jump to its definition.
- **Definition preview**: Hover tooltips are enriched with source code previews of referenced types.
- **Language-agnostic**: Works with any language that has a VS Code language server (Python, TypeScript, JavaScript, Java, C/C++, Go, Rust, etc.)
- **Recursive navigation**: Types in the definition preview are also clickable — keep drilling down.

## How It Works

1. **Protocol-level hover interception**: Patches the shared `ExtHostLanguageFeatures.$provideHover` via V8 Inspector to intercept all hover results (including from Pylance, TypeScript LS, etc.)
2. **Renderer DOM injection**: Injects JavaScript into VS Code's Electron renderer via CDP (Chrome DevTools Protocol) to add Cmd+Click behavior to hover code blocks.
3. **Click communication**: Uses `Runtime.addBinding` (CSP-safe) to communicate clicks from the renderer back to the extension host.
4. **Language server integration**: Navigation uses `executeDefinitionProvider` — the same mechanism as the editor's native Cmd+Click.

## Usage

1. Install the extension
2. Hover over any symbol in supported languages
3. Hold **Cmd** (macOS) / **Ctrl** (Windows/Linux) and move your mouse over type names in the hover tooltip
4. The type name underlines — **click** to navigate to its definition

## Supported Languages

Python, JavaScript, TypeScript, JSX/TSX, Java, C, C++, C#, Go, Rust, Ruby, PHP, Swift, Kotlin — any language with a definition provider.

## Requirements

- VS Code 1.75+
- macOS (Windows/Linux support planned)

## Known Limitations

- The V8 Inspector technique depends on VS Code's internal structure, which may change across versions
- Renderer injection requires the main VS Code process to be detectable
- Preview code fences in hover may not always render as interactive elements due to VS Code's markdown renderer limitations

## License

MIT
