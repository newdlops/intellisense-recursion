// Phase 13 split: pending-preview hover state machine + small range helpers.
//
// Extracted verbatim from extension.ts. Holds the "page-transition" state
// consumed by the patched $provideHover, plus the suppression window and
// debug-event ring used during a drill-down hand-off. The small range
// helpers (hoverRequestUriKey, internalHoverRangeContains,
// internalRangeFromVsCode) live here because they're only used by the
// hover-pending matchers and one call site that already imports from this
// module.
//
// Mutable lets are exposed via setters because ES module exports are
// read-only for consumers — see extension.ts for the corresponding
// setPendingPreviewHover/setPreviewHoverSuppress/bump* call sites.

import * as vscode from 'vscode';
import { PreviewState } from './preview-history';

// "Page-transition" state: when set, the next $provideHover call (within
// the time window) returns this markdown as its only content instead of
// the original symbol's hover. Set by previewTypeHandler before
// triggering editor.action.showHover, consumed and cleared by the
// patched $provideHover. VS Code re-renders via its native pipeline so
// theme + tokenization are applied for free.
export interface PendingPreviewHover {
  identifier: string;
  contents: any[];   // vscode.Hover['contents']-shaped array
  range?: any;
  anchorUriKey: string;
  anchorLine: number;
  anchorCharacter: number;
  expiresAt: number;
  matchedAt?: number;
  matchCount?: number;
}
export let pendingPreviewHover: PendingPreviewHover | null = null;
// After the override is delivered to the first handle, suppress only the
// parallel handles for the same hover request. This must be short and
// position-scoped; otherwise closing a drill-down and immediately reopening
// the original hover can be swallowed into an empty hover widget.
export const PREVIEW_HOVER_SUPPRESS_MS = 90;
export const PREVIEW_HOVER_SUPPRESS_MAX = 8;
export const PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE = 0;
// Tightened from 120 → 5. The wide 120-char tolerance caused drill state
// to match unrelated symbols on the same line: VS Code combined our
// drill content with another extension's hover content into one panel.
// 5 chars is enough to absorb VS Code's micro-jitter when it re-queries
// the provider during active drill (same identifier, slightly different
// offset), but small enough to reject neighboring symbols.
export const PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE = 5;
export let previewHoverSuppressUntil = 0;
export let previewHoverSuppressKey: string | null = null;
export let previewHoverSuppressCount = 0;
export let previewHoverWrongRequestLogCount = 0;
let previewHoverDebugSeq = 0;
export const previewHoverDebugEvents: any[] = [];
export function recordPreviewHoverDebug(event: any): void {
  try {
    previewHoverDebugEvents.push({ seq: ++previewHoverDebugSeq, at: Date.now(), ...event });
    while (previewHoverDebugEvents.length > 80) { previewHoverDebugEvents.shift(); }
  } catch {}
}

export function hoverRequestUriKey(uri: any): string {
  return uri?.scheme
    ? `${uri.scheme}://${uri.authority || ''}${uri.path}`
    : String(uri?.path || uri);
}

export function internalHoverRangeContains(range: any, line: number, character: number): boolean {
  if (!range) { return false; }
  const startLine = range.startLineNumber ?? (range.start?.line !== undefined ? range.start.line + 1 : undefined);
  const startColumn = range.startColumn ?? (range.start?.character !== undefined ? range.start.character + 1 : undefined);
  const endLine = range.endLineNumber ?? (range.end?.line !== undefined ? range.end.line + 1 : undefined);
  const endColumn = range.endColumn ?? (range.end?.character !== undefined ? range.end.character + 1 : undefined);
  if (startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined) {
    return false;
  }
  const lineNumber = line + 1;
  const column = character + 1;
  if (lineNumber < startLine || lineNumber > endLine) { return false; }
  if (lineNumber === startLine && column < startColumn) { return false; }
  if (lineNumber === endLine && column > endColumn) { return false; }
  return true;
}

export function pendingPreviewMatchesHoverRequest(
  preview: PendingPreviewHover,
  requestUriKey: string,
  requestLine: number,
  requestCharacter: number,
): boolean {
  if (preview.anchorUriKey !== requestUriKey) { return false; }
  if (internalHoverRangeContains(preview.range, requestLine, requestCharacter)) { return true; }
  if (preview.anchorLine === requestLine && preview.anchorCharacter === requestCharacter) { return true; }
  return Math.abs(preview.anchorLine - requestLine) <= PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE
    && Math.abs(preview.anchorCharacter - requestCharacter) <= PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE;
}

export function previewStateMatchesHoverRequest(
  state: PreviewState,
  requestUriKey: string,
  requestLine: number,
  requestCharacter: number,
): boolean {
  if (hoverRequestUriKey(state.anchor.uri) !== requestUriKey) { return false; }
  const anchorRange = internalRangeFromVsCode(state.anchorRange);
  if (internalHoverRangeContains(anchorRange, requestLine, requestCharacter)) { return true; }
  if (state.anchor.line === requestLine && state.anchor.character === requestCharacter) { return true; }
  return Math.abs(state.anchor.line - requestLine) <= PREVIEW_HOVER_ANCHOR_LINE_TOLERANCE
    && Math.abs(state.anchor.character - requestCharacter) <= PREVIEW_HOVER_ANCHOR_CHAR_TOLERANCE;
}

export function internalRangeFromVsCode(range: vscode.Range | undefined): any | undefined {
  if (!range) { return undefined; }
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ─── Setters for mutable exports (ES module bindings are read-only for consumers) ───

export function setPendingPreviewHover(v: PendingPreviewHover | null): void {
  pendingPreviewHover = v;
}

export function setPreviewHoverSuppress(until: number, key: string | null, count: number): void {
  previewHoverSuppressUntil = until;
  previewHoverSuppressKey = key;
  previewHoverSuppressCount = count;
}

export function bumpPreviewHoverSuppressCount(): void {
  previewHoverSuppressCount++;
}

export function bumpPreviewHoverWrongRequestLogCount(): void {
  previewHoverWrongRequestLogCount++;
}
