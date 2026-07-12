// Optional Django Shell command handshake for overlay-owned hover anchors and refires.

import * as vscode from 'vscode';

/** Identifies the document position where a native hover should be requested. */
export interface HoverAnchor {
  uri: vscode.Uri;
  line: number;
  character: number;
}

/** Executes one optional cross-extension command with a hover anchor payload. */
export type OverlayHoverCommandExecutor = (command: string, anchor: HoverAnchor) => Thenable<unknown>;

/** Runs a VS Code command using the production extension-host command registry. */
function executeOverlayHoverCommand(command: string, anchor: HoverAnchor): Thenable<unknown> {
  return vscode.commands.executeCommand(command, anchor);
}

/** Returns whether a command result contains a usable handled hover anchor. */
function isHandledHoverAnchor(value: unknown): value is HoverAnchor & { handled: true } {
  if (!value || typeof value !== 'object') { return false; }
  const candidate = value as Partial<HoverAnchor> & { handled?: unknown };
  return candidate.handled === true
    && !!candidate.uri
    && typeof candidate.uri.scheme === 'string'
    && typeof candidate.uri.path === 'string'
    && typeof candidate.uri.toString === 'function'
    && Number.isInteger(candidate.line)
    && Number.isInteger(candidate.character)
    && (candidate.line ?? -1) >= 0
    && (candidate.character ?? -1) >= 0;
}

/** Lets Django Shell replace a backing-file hover position with its live overlay anchor. */
export async function resolveOverlayHoverAnchor(
  anchor: HoverAnchor,
  execute: OverlayHoverCommandExecutor = executeOverlayHoverCommand,
): Promise<HoverAnchor> {
  try {
    const result = await execute('djangoShell.resolveOverlayHoverAnchor', anchor);
    return isHandledHoverAnchor(result)
      ? { uri: result.uri, line: result.line, character: result.character }
      : anchor;
  } catch {
    return anchor;
  }
}

/** Asks Django Shell to refire a hover inside its overlay editor when it owns the anchor. */
export async function refireOverlayHover(
  anchor: HoverAnchor,
  execute: OverlayHoverCommandExecutor = executeOverlayHoverCommand,
): Promise<boolean> {
  try {
    const result = await execute('djangoShell.refireOverlayHover', anchor);
    return !!result && typeof result === 'object' && (result as { handled?: unknown }).handled === true;
  } catch {
    return false;
  }
}
