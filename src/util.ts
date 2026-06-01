// Pure utility helpers extracted from extension.ts (Phase 1).
//
// Scope:
//   - workspace-root + language/file detection
//   - identifier regex patterns + LRU-cached factory
//   - definition-preview tunable constants
//
// Nothing in this module imports any mutable extension state — all functions
// are side-effect-free apart from the per-identifier escape cache, which is
// confined to this module.

import * as vscode from 'vscode';
import type { SidecarLanguage } from './sidecar';

export function workspaceRootFsPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || folders[0].uri.scheme !== 'file') { return null; }
  return folders[0].uri.fsPath;
}

export function isPythonFsPath(fsPath: string): boolean {
  return fsPath.endsWith('.py') || fsPath.endsWith('.pyi');
}

export function isSupportedFsPath(fsPath: string): boolean {
  return (
    isPythonFsPath(fsPath)
    || fsPath.endsWith('.ts')
    || fsPath.endsWith('.tsx')
    || fsPath.endsWith('.d.ts')
  );
}

/**
 * Derive the sidecar language tag from the file that triggered a lookup.
 * Returns undefined for files we don't index (means: don't apply a language
 * filter on the sidecar query — but we also wouldn't reach here since the
 * fast-path is gated by isSupportedFsPath).
 */
export function languageOf(fsPath: string): SidecarLanguage | undefined {
  if (isPythonFsPath(fsPath)) { return 'python'; }
  if (fsPath.endsWith('.ts') || fsPath.endsWith('.tsx') || fsPath.endsWith('.d.ts')) {
    return 'typescript';
  }
  return undefined;
}

// PascalCase / SCREAMING_SNAKE only — names shaped like parameter/method
// (snake_case, starts lowercase) stay on the LSP path because the sidecar
// doesn't index parameters or local variables.
export const TYPE_SHAPED_NAME = /^[A-Z_][A-Za-z0-9_]*$/;
export const CONSTANT_SHAPED_NAME = /^_*[A-Z][A-Z0-9_]*$/;
export const IDENTIFIER_WORD_RE = /[A-Za-z_$][\w$]*/;
// Reusable global-flag variant; reset .lastIndex before each use. Hoisted
// out of nearbyHoverWordCandidateAt where it used to be re-allocated on
// every hover/cursor probe.
export const IDENTIFIER_WORD_RE_G = /[A-Za-z_$][\w$]*/g;

// Per-identifier escaped pattern cache. Builds \b<identifier>\b regexes
// without re-running the escape replace each call. We always return a
// fresh RegExp so callers can mutate .lastIndex across awaits without
// stepping on each other.
const ESC_IDENTIFIER_CACHE_MAX = 256;
const escIdentifierCache = new Map<string, string>();
export function identifierWordRegex(identifier: string, flags = ''): RegExp {
  let escaped = escIdentifierCache.get(identifier);
  if (escaped === undefined) {
    escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escIdentifierCache.size >= ESC_IDENTIFIER_CACHE_MAX) {
      const first = escIdentifierCache.keys().next().value;
      if (first !== undefined) { escIdentifierCache.delete(first); }
    }
    escIdentifierCache.set(identifier, escaped);
  } else {
    // LRU touch
    escIdentifierCache.delete(identifier);
    escIdentifierCache.set(identifier, escaped);
  }
  return new RegExp(`\\b${escaped}\\b`, flags);
}

export const HOVER_NEARBY_SYMBOL_COLUMN_RADIUS = 8;
export const HOVER_NOISY_IDENTIFIER_MAX_LENGTH = 80;

/** URI schemes whose documents are considered "real code" by the
 * hover/preview pipeline. Filters out output channels, debug consoles,
 * git diffs, etc. */
export const CODE_SCHEMES = new Set(['file', 'untitled', 'vscode-userdata']);

/** True when `doc` looks like a real source file we should scan/wrap. */
export function isCodeDoc(doc: vscode.TextDocument): boolean {
  if (!CODE_SCHEMES.has(doc.uri.scheme)) { return false; }
  const p = doc.uri.fsPath;
  if (p.endsWith('.log') || p.endsWith('.md') || p.endsWith('.git') || p.includes('/scm')) { return false; }
  return true;
}

/**
 * Definition preview extraction is intentionally more verbose than native
 * language-server hovers: show the whole syntactic block, then let the hover
 * widget scroll when the block is long.
 */
export const DEFINITION_PREVIEW_FALLBACK_LINES = 120;
export const DEFINITION_PREVIEW_SAFETY_MAX_LINES = 10_000;
export const DEFINITION_PREVIEW_VALUE_MAX_LINES = 600;
// L84 (2026-05-30): how many lines of a code preview get syntax-highlighted (the
// head — what's visible when the hover first opens). Lines beyond this render as a
// PLAIN fence so VS Code skips TextMate tokenization of huge off-screen blocks —
// the #2 hover-jank cause (a genuine 1,657-line class blocked the renderer ~2.4s
// during synchronous render). Full content + code-block layout preserved; only the
// scrolled-out tail loses colour. Tunable.
// L129 (2026-06-01): 60 -> 200. User wants syntax color while scrolling, but VS Code's hover
// tokenizes the WHOLE code block at once (no native viewport-lazy tokenization for hovers — only
// the editor does that), so "native + dynamic + no-freeze" is impossible; only full(freeze) /
// fast-partial / non-native-dynamic(overlay/re-deliver churn) exist. 200 is the pragmatic native
// pick: covers most scrolling with color, freeze bounded (~1ms/line on show — a 200-line class
// ≈ ~400ms; smaller classes less), no churn. Lines past 200 stay plain (plaintext tail, L123).
// TUNABLE: higher = more color + more show-freeze; lower = faster + less color.
export const HOVER_HIGHLIGHT_MAX_LINES = 200;
// L125: hard cap on TOTAL preview lines rendered into the hover. A genuine 1,657-line class
// otherwise builds ~1,657 DOM line elements (even the plain tail) + a 206-name candidate scan —
// the residual resource cost after head/tail split (L84) + plaintext tail (L123). Cap renders
// head(60 highlighted) + tail up to here (plain) + a "N more lines truncated" note; the full
// definition is one ⌘-click away. Generous enough that most classes render whole.
export const HOVER_PREVIEW_MAX_LINES = 300;
// L88 (2026-05-31): vtail render mode (shared by extension.ts + preview-builder.ts).
// 'overlay' = head-split + windowed virtual scroller (fast but the custom overlay fights the
// reused-hover lifecycle and drilled hovers bypass it; tail is plain). 'native' = full preview
// to VS Code's native hover, FULLY syntax-highlighted (no L84 head/tail split), scan-drillable
// everywhere, accepting VS Code's native render cost on big hovers. Flip to compare.
export const IR_VTAIL_MODE: 'native' | 'overlay' = 'native';
