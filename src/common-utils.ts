// Phase 9 split: common standalone utilities.
//
// This module hosts pure, dependency-light helpers that were previously
// inlined near the top of extension.ts:
//   - `withTimeout`: a generic promise timeout wrapper.
//   - Open-document index: a lazy fsPath -> TextDocument map plus the
//     listeners that keep it in sync with the workspace.
//
// Behaviour is intentionally identical to the inline originals; only the
// physical location of the definitions has changed.

import * as vscode from 'vscode';

export function withTimeout<T>(p: Thenable<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

// Lazy map of open documents keyed by canonical fsPath. Used to be a
// linear .find() over workspace.textDocuments; with many open files and
// findOpenDoc called from every hover/Cmd+Click path that scan went
// quadratic on idle. The map is rebuilt on first use and kept in sync by
// onDidOpenTextDocument / onDidCloseTextDocument listeners registered in
// activate().
let openDocByFsPath: Map<string, vscode.TextDocument> | null = null;
export function ensureOpenDocIndex(): Map<string, vscode.TextDocument> {
  if (!openDocByFsPath) {
    openDocByFsPath = new Map();
    for (const d of vscode.workspace.textDocuments) {
      openDocByFsPath.set(d.uri.fsPath, d);
    }
  }
  return openDocByFsPath;
}
export function findOpenDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  return ensureOpenDocIndex().get(uri.fsPath);
}
export function registerOpenDocIndexListeners(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => {
      ensureOpenDocIndex().set(d.uri.fsPath, d);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      ensureOpenDocIndex().delete(d.uri.fsPath);
    }),
  );
}
