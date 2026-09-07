import * as vscode from 'vscode';

export const OPEN_PREVIEW_FILE_COMMAND = 'intellisenseRecursion.openPreviewFile';

export interface PreviewFileTarget {
  uri: string;
  line: number;
  path: string;
}

export function previewFileLink(uri: vscode.Uri, line: number): string {
  const target: PreviewFileTarget = { uri: uri.toString(), line, path: vscode.workspace.asRelativePath(uri) };
  const label = `${target.path}:${line + 1}`.replace(/[\\`*_{}\[\]()<>#!|&]/g, '\\$&');
  const query = encodeURIComponent(JSON.stringify([target]))
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `*[${label}](command:${OPEN_PREVIEW_FILE_COMMAND}?${query} "Open file in a new tab")*`;
}

// This self-contained decoder also runs in the renderer patch. Only our file
// command is enabled in detached snapshots; other command links stay inert.
export function parsePreviewFileLink(href: string): PreviewFileTarget | null {
  const prefix = 'command:intellisenseRecursion.openPreviewFile?';
  if (!href.startsWith(prefix)) { return null; }
  try {
    const args = JSON.parse(decodeURIComponent(href.slice(prefix.length)));
    if (!Array.isArray(args) || args.length !== 1) { return null; }
    const target = args[0];
    if (!target || typeof target.uri !== 'string' || !/^[a-z][a-z\d+.-]*:/i.test(target.uri)
      || !Number.isSafeInteger(target.line) || target.line < 0 || typeof target.path !== 'string') {
      return null;
    }
    return { uri: target.uri, line: target.line, path: target.path };
  } catch { return null; }
}

export async function openPreviewFile(target: PreviewFileTarget): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri, true));
  const line = Math.min(Math.max(0, target.line), doc.lineCount - 1);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false,
    selection: new vscode.Range(line, 0, line, 0),
  });
}
