import * as vscode from 'vscode';

interface SymbolResult {
  ok: boolean;
  names?: string[];
  more?: boolean;
  reason?: string;
}

type RendererCall = (method: 'irReadDetachedHoverSymbols' | 'irFinishDetachedHoverSymbols', args: unknown[]) => Promise<SymbolResult>;

/** Native Quick Pick owns filtering input, list virtualization and keyboard UI. */
export class HoverSymbolPicker implements vscode.Disposable {
  private active?: { key: string; pickerId: number; close: (restoreFocus: boolean) => void };

  dismiss(key?: string, pickerId?: number): void {
    if ((!key || this.active?.key === key) && (pickerId === undefined || this.active?.pickerId === pickerId)) { this.active?.close(false); }
  }

  dispose(): void { this.dismiss(); }

  show(key: string, pickerId: number, call: RendererCall): void {
    this.dismiss();
    const picker = vscode.window.createQuickPick();
    picker.title = 'Symbols in pinned hover';
    picker.placeholder = 'Type part of a symbol name to preview its definition';
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    // Keep the originating panel until an explicit accept or Escape. Moving
    // to another OS window must not dismiss and refocus this workbench.
    picker.ignoreFocusOut = true;
    let closed = false;
    let queryId = 0;
    let readyQuery = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const listeners: vscode.Disposable[] = [];
    const finish = (restoreFocus: boolean, selected?: string, error?: string) => {
      if (closed) { return; }
      closed = true;
      if (debounce) { clearTimeout(debounce); }
      if (this.active === active) { this.active = undefined; }
      for (const listener of listeners) { listener.dispose(); }
      picker.hide();
      picker.dispose();
      void call('irFinishDetachedHoverSymbols', [key, pickerId, readyQuery, selected || '', restoreFocus, error || '']).catch(() => {});
    };
    const active = { key, pickerId, close: (restoreFocus: boolean) => finish(restoreFocus) };
    this.active = active;
    const search = async (value: string, id: number) => {
      try {
        const result = await call('irReadDetachedHoverSymbols', [key, pickerId, id, value]);
        if (closed || id !== queryId) { return; }
        if (!result.ok) {
          finish(true, undefined, result.reason === 'stale-picker' ? '' : 'read-failed');
          return;
        }
        picker.items = (result.names || []).map(label => ({ label }));
        picker.title = result.more ? 'Symbols in pinned hover — first 200 matches; type to narrow'
          : picker.items.length ? 'Symbols in pinned hover' : 'No matching symbols — try another name';
        readyQuery = id;
        picker.busy = false;
      } catch {
        if (!closed && id === queryId) { finish(true, undefined, 'read-failed'); }
      }
    };
    const schedule = (value: string) => {
      const id = ++queryId;
      readyQuery = 0;
      picker.items = [];
      picker.busy = true;
      if (debounce) { clearTimeout(debounce); }
      debounce = setTimeout(() => { debounce = undefined; void search(value, id); }, value ? 100 : 0);
    };
    listeners.push(picker.onDidChangeValue(schedule), picker.onDidHide(() => finish(true)),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0]?.label;
        if (readyQuery === queryId && selected) { finish(true, selected); }
      }));
    picker.show();
    schedule('');
  }
}
