// Phase 14 split: native-hover refire scheduling state.
// Extracted from extension.ts to isolate the timers/keys/anchor used by the
// native-hover refire scheduler and the last-hover-fetch position cursor.

import * as vscode from 'vscode';

export const rendererHoverFallbackTimers = new Set<ReturnType<typeof setTimeout>>();
export const nativeHoverRefireScheduledKeys = new Set<string>();
export const nativeHoverRefireLastAt = new Map<string, number>();
export const NATIVE_HOVER_REFIRE_SUPPRESS_MS = 1600;

export interface NativeHoverRefireAnchor {
  uri: vscode.Uri;
  line: number;
  character: number;
}

// Last position where VS Code's native hover was successfully fetched.
// Captured by the patched $provideHover so previewTypeHandler can move
// the text cursor there before triggering editor.action.showHover —
// otherwise showHover is a no-op when a hover is already visible, or
// triggers hover for the wrong position.
export let lastHoverFetchPosition: { uri: vscode.Uri; line: number; character: number } | null = null;

export function setLastHoverFetchPosition(v: { uri: vscode.Uri; line: number; character: number } | null): void {
  lastHoverFetchPosition = v;
}
