// Tests optional Django Shell hover handshake behavior without requiring that extension.

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  HoverAnchor,
  OverlayHoverCommandExecutor,
  refireOverlayHover,
  resolveOverlayHoverAnchor,
} from '../../overlay-hover-handshake';

/** Creates a deterministic command executor and records its invocations. */
function commandExecutor(
  result: unknown,
  calls: Array<{ command: string; anchor: HoverAnchor }>,
): OverlayHoverCommandExecutor {
  return async (command, anchor) => {
    calls.push({ command, anchor });
    if (result instanceof Error) { throw result; }
    return result;
  };
}

suite('Django Shell overlay hover handshake', () => {
  const rawAnchor: HoverAnchor = {
    uri: vscode.Uri.file('/workspace/.django-shell/analysis.py'),
    line: 12,
    character: 7,
  };

  test('uses a handled overlay anchor', async () => {
    const calls: Array<{ command: string; anchor: HoverAnchor }> = [];
    const overlayAnchor: HoverAnchor = {
      uri: vscode.Uri.file('/workspace/.django-shell/console-cell.py'),
      line: 3,
      character: 2,
    };

    const resolved = await resolveOverlayHoverAnchor(
      rawAnchor,
      commandExecutor({ handled: true, ...overlayAnchor }, calls),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, 'djangoShell.resolveOverlayHoverAnchor');
    assert.strictEqual(calls[0].anchor, rawAnchor);
    assert.strictEqual(resolved.uri.toString(), overlayAnchor.uri.toString());
    assert.strictEqual(resolved.line, overlayAnchor.line);
    assert.strictEqual(resolved.character, overlayAnchor.character);
  });

  test('keeps the raw anchor when resolution is declined, malformed, or unavailable', async () => {
    const declined = await resolveOverlayHoverAnchor(rawAnchor, async () => ({ handled: false }));
    const malformed = await resolveOverlayHoverAnchor(rawAnchor, async () => ({ handled: true, uri: rawAnchor.uri, line: -1, character: 0 }));
    const unavailable = await resolveOverlayHoverAnchor(rawAnchor, async () => { throw new Error('command not found'); });

    assert.strictEqual(declined, rawAnchor);
    assert.strictEqual(malformed, rawAnchor);
    assert.strictEqual(unavailable, rawAnchor);
  });

  test('reports overlay refire handling and falls back for false or errors', async () => {
    const calls: Array<{ command: string; anchor: HoverAnchor }> = [];
    const handled = await refireOverlayHover(rawAnchor, commandExecutor({ handled: true }, calls));
    const declined = await refireOverlayHover(rawAnchor, async () => ({ handled: false }));
    const unavailable = await refireOverlayHover(rawAnchor, async () => { throw new Error('command not found'); });

    assert.strictEqual(handled, true);
    assert.strictEqual(calls[0].command, 'djangoShell.refireOverlayHover');
    assert.strictEqual(calls[0].anchor, rawAnchor);
    assert.strictEqual(declined, false);
    assert.strictEqual(unavailable, false);
  });

  test('short-circuits the shared refire path before opening the anchor document', async () => {
    const extension = vscode.extensions.getExtension('newdlops.intellisense-recursion');
    assert.ok(extension, 'IntelliSense Recursion extension should be available in the test host');
    await extension.activate();

    const syntheticAnchor: HoverAnchor = {
      uri: vscode.Uri.parse('django-shell-overlay:/console-cell.py'),
      line: 4,
      character: 9,
    };
    let received: HoverAnchor | undefined;
    const command = vscode.commands.registerCommand('djangoShell.refireOverlayHover', (anchor: HoverAnchor) => {
      received = anchor;
      return { handled: true };
    });
    const activeUriBefore = vscode.window.activeTextEditor?.document.uri.toString();
    try {
      await vscode.commands.executeCommand(
        'intellisenseRecursion.refireHoverAtAnchorForTests',
        syntheticAnchor,
      );
    } finally {
      command.dispose();
    }

    assert.ok(received, 'The shared refire path should consult the overlay command');
    assert.strictEqual(received?.uri.toString(), syntheticAnchor.uri.toString());
    assert.strictEqual(received?.line, syntheticAnchor.line);
    assert.strictEqual(received?.character, syntheticAnchor.character);
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), activeUriBefore);
    assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === syntheticAnchor.uri.toString()),
      'A handled overlay refire must not open its synthetic anchor as a text document');
  });
});
