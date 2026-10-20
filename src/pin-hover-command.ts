import * as vscode from 'vscode';

export const PIN_HOVER_COMMAND = 'intellisenseRecursion.pinHover';

interface PinHoverResult {
  ok: boolean;
  reason?: string;
  id?: number;
  sessionKey?: string;
}

interface PinHoverDependencies {
  ensureRenderer(): Promise<void>;
  evaluate(expression: string): Promise<PinHoverResult>;
  warn(message: string): void;
}

/** The palette can dismiss a hover. Reopen it at the cursor before pinning. */
export function createPinHoverCommand(dependencies: PinHoverDependencies): () => Promise<PinHoverResult> {
  let pending: Promise<PinHoverResult> | undefined;
  const run = async (): Promise<PinHoverResult> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open an editor and place the cursor on a symbol to pin its hover.');
      return { ok: false, reason: 'no-editor' };
    }
    const uri = editor.document.uri.toString();
    const position = editor.selection.active;
    const anchorIsCurrent = () => vscode.window.activeTextEditor === editor
      && editor.document.uri.toString() === uri && editor.selection.active.isEqual(position);
    try {
      await dependencies.ensureRenderer();
      const expression = `(function(){return typeof window.irPinVisibleHover==='function'
        ?window.irPinVisibleHover(${JSON.stringify(uri)},${JSON.stringify({ lineNumber: position.line + 1, column: position.character + 1 })}):{ok:false,reason:'controls-not-ready'};})()`;
      const showHover = async () => {
        if (!anchorIsCurrent()) { return; }
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        if (!anchorIsCurrent()) { return; }
        // Reuse the native refire path bound to this editor. A global command
        // can resolve to a Quick Pick input instead of the document editor.
        const shown = await dependencies.evaluate(`(function(){return typeof window.irRefireNativeHoverAtAnchor==='function'
          ?window.irRefireNativeHoverAtAnchor(${JSON.stringify({ uri, line: position.line, character: position.character, onlyAtCursor: true })}):{ok:false};})()`);
        if (!shown.ok && anchorIsCurrent()) {
          await vscode.commands.executeCommand('editor.action.hideHover');
          if (anchorIsCurrent()) { await vscode.commands.executeCommand('editor.action.showHover'); }
        }
      };
      if (!anchorIsCurrent()) { return { ok: false, reason: 'anchor-editor-changed' }; }
      let result = await dependencies.evaluate(expression);
      if (result.ok) { return result; }
      const retryable = (reason?: string) => reason === 'no-native-hover' || reason === 'rendering-pending';
      if (!retryable(result.reason)) { throw new Error(result.reason || 'pin-failed'); }
      if (result.reason === 'no-native-hover') { await showHover(); }
      const deadline = Date.now() + 3000;
      let nextShow = Date.now() + 500;
      while (Date.now() < deadline && anchorIsCurrent()) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!anchorIsCurrent()) { break; }
        result = await dependencies.evaluate(expression);
        if (result.ok) { return result; }
        if (!retryable(result.reason)) { throw new Error(result.reason || 'pin-failed'); }
        // A preceding native dismissal or a temporarily empty provider can
        // win the first Show Hover. Retry only while no hover is visible;
        // never restart an asynchronously highlighting source block.
        if (result.reason === 'no-native-hover' && Date.now() >= nextShow) {
          await showHover();
          nextShow = Date.now() + 500;
        }
      }
      if (!anchorIsCurrent()) { return { ok: false, reason: 'anchor-editor-changed' }; }
      void vscode.window.showInformationMessage(result.reason === 'rendering-pending'
        ? 'The hover source is still rendering. Try Pin Hover again when highlighting is ready.'
        : 'No hover is available at the cursor. Move to a symbol with hover information and try Pin Hover again.');
      return result;
    } catch (error) {
      dependencies.warn(`[pin] ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showWarningMessage('Hover controls are not ready. Try Pin Hover again after the extension finishes starting.');
      return { ok: false, reason: 'controls-not-ready' };
    }
  };
  return () => {
    if (!pending) { pending = run().finally(() => { pending = undefined; }); }
    return pending;
  };
}
