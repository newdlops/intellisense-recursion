import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildDefinitionPreviewResult, buildDefinitionPreviewResultFromRawFile } from '../../preview-builder';
import { OPEN_PREVIEW_FILE_COMMAND, parsePreviewFileLink, previewFileLink } from '../../preview-file-link';
import { parsePreviewMarkdownSource } from '../../preview-markdown';

suite('Preview file path links', () => {
  let directory: string;
  let origin: vscode.Uri;
  let target: vscode.Uri;

  suiteSetup(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-file-link-'));
    origin = vscode.Uri.file(path.join(directory, 'origin.py'));
    target = vscode.Uri.file(path.join(directory, '한글 [model](copy)_#%.py'));
    await fs.writeFile(origin.fsPath, 'class Origin: pass\n');
    await fs.writeFile(target.fsPath, '# source\n\nclass LinkedModel:\n    value: int = 1\n');
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('text-document and raw-file previews retain exact URI, line and escaped path', async () => {
    const doc = await vscode.workspace.openTextDocument(target);
    const fromDoc = buildDefinitionPreviewResult('LinkedModel', target, doc, 2);
    const fromFile = await buildDefinitionPreviewResultFromRawFile('LinkedModel', target, target.fsPath, 2);
    assert.strictEqual(fromDoc.preview, fromFile.preview);
    const parsed = parsePreviewMarkdownSource(fromDoc.preview);
    assert.ok(parsed);
    assert.strictEqual(parsed.uri, target.toString());
    assert.strictEqual(parsed.relPath, target.fsPath);
    assert.strictEqual(parsed.definitionLine, 2);
    assert.ok(parsed.code.includes('class LinkedModel:'));
    assert.ok(fromDoc.preview.includes('\\[model\\]\\(copy\\)\\_\\#%.py:3'));
    const href = /\]\((command:[^\s)]+)/.exec(fromDoc.preview)![1];
    assert.ok(!/[()]/.test(href), 'Parentheses in paths must not terminate the Markdown destination');
    assert.deepStrictEqual(parsePreviewFileLink(href), { uri: target.toString(), line: 2, path: target.fsPath });
  });

  test('legacy preview headers still resolve for existing history', () => {
    const parsed = parsePreviewMarkdownSource('`LinkedModel` — *models.py:3*\n```python\nclass LinkedModel: pass\n```');
    assert.strictEqual(parsed?.relPath, 'models.py');
    assert.strictEqual(parsed?.definitionLine, 2);
    assert.strictEqual(parsed?.uri, undefined);
  });

  test('malformed destinations and unrelated commands are not file links', () => {
    for (const href of [
      'command:workbench.action.closeAllEditors',
      `command:${OPEN_PREVIEW_FILE_COMMAND}?%broken`,
      `command:${OPEN_PREVIEW_FILE_COMMAND}?${encodeURIComponent(JSON.stringify([{ uri: target.toString(), line: -1, path: 'file' }]))}`,
      `command:${OPEN_PREVIEW_FILE_COMMAND}?${encodeURIComponent(JSON.stringify([{ uri: 'relative.py', line: 0, path: 'file' }]))}`,
    ]) {
      assert.strictEqual(parsePreviewFileLink(href), null);
    }
  });

  test('opening a file pins its tab and clamps a stale line after the file shrinks', async () => {
    await vscode.window.showTextDocument(origin, { preview: false });
    await vscode.commands.executeCommand(OPEN_PREVIEW_FILE_COMMAND, { uri: target.toString(), line: 999, path: target.fsPath });
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), target.toString());
    assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 4);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, false);
    assert.ok(vscode.window.tabGroups.activeTabGroup.tabs.some(tab => tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() === origin.toString()), 'Opening the source must preserve the original tab');
  });

  for (const mode of ['native click', 'detached click', 'detached Enter']) {
    test(`${mode} opens the source at the indicated line`, async function () {
      this.timeout(60000);
      await vscode.window.showTextDocument(origin, { preview: false });
      const markdown = '`LinkedModel` — ' + previewFileLink(target, 2) + '\n```python\nclass LinkedModel: pass\n```';
      const rows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runPreviewFileLinkHarnessForTests', markdown,
        mode.startsWith('detached'), mode.endsWith('Enter'),
      );
      const result = rows?.map(row => row?.value).find(value => value?.ok);
      assert.ok(result, JSON.stringify(rows));
      assert.strictEqual(result.text, `${target.fsPath}:3`);
      assert.notStrictEqual(result.disabled, 'true');
      assert.ok(result.tabIndex >= 0);
      assert.strictEqual(result.focused, true);
      assert.strictEqual(result.unrelatedDisabled, true);
      assert.strictEqual(result.historyUnchanged, true);
      const deadline = Date.now() + 5000;
      while (vscode.window.activeTextEditor?.document.uri.toString() !== target.toString() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), target.toString());
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 2);
      assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, false);
    });
  }
});
