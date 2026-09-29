import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IndexManager } from '../../indexManager';
import type { SidecarHit } from '../../sidecar';
import { buildDefinitionPreviewResultFromRawFile } from '../../preview-builder';
import { clearRawDefFileCache } from '../../preview-engine';
import {
  chooseSidecarHit,
  fastResolveTypeName,
  hitMatchesImportTarget,
  pythonImportTargetsForIdentifier,
  setSidecarIndexManager,
  sidecarDefinitivelyMissing,
} from '../../sidecar-resolve';

suite('Definition origin resolution', () => {
  let directory: string;
  let relative: string;
  let hits: SidecarHit[];
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const hit = (file: string, kind: SidecarHit['kind'] = 'class', source: SidecarHit['source'] = 'project'): SidecarHit => ({
    path: file, kind, source, language: 'python', line: 1, col: 7,
  });
  const origin = (text: string): vscode.TextDocument => ({
    uri: vscode.Uri.file(path.join(directory, 'service.py')),
    lineCount: text.split('\n').length,
    lineAt: (line: number) => ({ text: text.split('\n')[line] }),
  } as unknown as vscode.TextDocument);
  const resolve = (name: string, doc: vscode.TextDocument) => fastResolveTypeName(name, doc.uri.fsPath, doc);

  setup(async () => {
    directory = await fs.mkdtemp(path.join(root, 'ir-origin-'));
    relative = path.relative(root, directory).replace(/\\/g, '/');
    hits = [];
    setSidecarIndexManager({
      lookup: async () => hits,
      lookupMany: async (names: string[]) => names.map(name => ({ name, hits })),
      hasFullCoverage: () => true,
    } as unknown as IndexManager);
  });
  teardown(async () => {
    setSidecarIndexManager(null);
    clearRawDefFileCache();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('an index miss recovers the imported original instead of openpyxl Company attributes', async () => {
    const original = path.join(directory, 'company.py');
    const code = '# source\nclass Company(  # type: ignore[django-manager-missing]\n    TimestampedModel,\n    SoftDeletableModel,\n):\n    original_definition = True\n';
    await fs.writeFile(original, code);
    hits = [hit(path.join(root, '.venv/lib/python3.11/site-packages/openpyxl/packaging/extended.py'), 'attribute', 'venv')];
    const doc = origin('from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .company import Company\n');
    const result = await resolve('Company', doc);
    assert.strictEqual(result?.path, original);
    assert.strictEqual(result?.line, 2);
    assert.strictEqual(result?.kind, 'class');
    const preview = await buildDefinitionPreviewResultFromRawFile('Company', vscode.Uri.file(result!.path), result!.path, result!.line - 1);
    assert.ok(preview.preview.includes('original_definition = True'));
    assert.ok(!preview.preview.includes('openpyxl'));
  });

  test('multiline conditional imports and aliases preserve the binding', async () => {
    const original = path.join(directory, 'company.py');
    await fs.writeFile(original, 'class Company:\n    original_definition = True\n');
    const text = 'if TYPE_CHECKING:\n    from .company import (\n        Company as OriginalCompany,  # source alias\n        Other,\n    )\n';
    const targets = pythonImportTargetsForIdentifier(text, `${relative}/service.py`, 'OriginalCompany');
    assert.deepStrictEqual(targets[0], { relPath: `${relative}/company.py`, importedName: 'Company' });
    hits = [hit(path.join(root, 'unrelated.py'))];
    assert.strictEqual((await resolve('OriginalCompany', origin(text)))?.path, original);
  });

  test('an unresolved explicit import never falls back to unrelated project or library names', async () => {
    const doc = origin('from .missing import Company\n');
    hits = [hit(path.join(directory, 'unrelated.py')), hit('/env/site-packages/other/company.py', 'class', 'venv')];
    assert.strictEqual(await resolve('Company', doc), null);
    hits = [];
    assert.strictEqual(await sidecarDefinitivelyMissing('Company', doc.uri.fsPath, doc), false,
      'A missing index entry must still allow definition-provider fallback');
  });

  test('an imported implementation wins over an indexed stub counterpart', async () => {
    const source = path.join(directory, 'company.py');
    const stub = path.join(directory, 'company.pyi');
    await fs.writeFile(source, 'class Company:\n    original_definition = True\n');
    await fs.writeFile(stub, 'class Company: ...\n');
    hits = [hit(stub)];
    assert.strictEqual((await resolve('Company', origin('from .company import Company\n')))?.path, source);
    hits = [hit(stub), hit(source)];
    assert.strictEqual((await resolve('Company', origin('from .company import Company\n')))?.path, source);
  });

  test('a nested same-named class is not mistaken for a module export', async () => {
    await fs.writeFile(path.join(directory, 'company.py'), 'class Container:\n    class Company: pass\n');
    assert.strictEqual(await resolve('Company', origin('from .company import Company\n')), null);
  });

  test('conditional bindings to different modules require scope analysis', async () => {
    await fs.writeFile(path.join(directory, 'primary.py'), 'class Company: pass\n');
    await fs.writeFile(path.join(directory, 'fallback.py'), 'class Company: pass\n');
    const doc = origin('if enabled:\n    from .primary import Company\nelse:\n    from .fallback import Company\n');
    assert.strictEqual(await resolve('Company', doc), null);
  });

  test('explicit third-party imports still resolve their own definitions', async () => {
    const original = '/env/lib/python3.11/site-packages/openpyxl/workbook/workbook.py';
    const stub = '/pylance/dist/typeshed-fallback/stubs/openpyxl/openpyxl/workbook/workbook.pyi';
    hits = [hit(path.join(directory, 'unrelated.py')), hit(stub, 'class', 'typeshed'), hit(original, 'class', 'venv')];
    assert.strictEqual((await resolve('Workbook', origin('from openpyxl.workbook.workbook import Workbook\n')))?.path, original);
    assert.strictEqual(hitMatchesImportTarget(hit('/env/site-packages/vendor/tests/openpyxl/workbook/workbook.py', 'class', 'venv'), 'Workbook', {
      relPath: 'openpyxl/workbook/workbook.py', importedName: 'Workbook',
    }), false, 'Do not use suffix matches to pick vendored copies');
  });

  test('unqualified external fields and ambiguous definitions require the language server', () => {
    const location = path.join(directory, 'service.py');
    assert.strictEqual(chooseSidecarHit([hit('/env/site-packages/openpyxl/extended.py', 'attribute', 'venv')], location, 'Company'), null);
    assert.strictEqual(chooseSidecarHit([hit('/env/site-packages/a.py', 'class', 'venv'), hit('/env/site-packages/b.py', 'class', 'venv')], location, 'Company'), null);
    const unique = hit('/env/site-packages/a.py', 'class', 'venv');
    assert.deepStrictEqual(chooseSidecarHit([unique, { ...unique }], location, 'Company'), unique);
  });
});

suite('Imported source hover and navigation', () => {
  test('the shipping provider and go-to command retain the explicitly imported source', async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    // Hidden files are absent from the ordinary project index. Opening only
    // the importer reproduces a missing original with no warm document entry.
    const directory = await fs.mkdtemp(path.join(root, '.ir-origin-'));
    const source = vscode.Uri.file(path.join(directory, 'company.py'));
    const origin = vscode.Uri.file(path.join(directory, 'service.py'));
    let provider: vscode.Disposable | undefined;
    try {
      await fs.writeFile(source.fsPath, 'class Company(  # original source\n    object,\n):\n    original_definition = "IMPORT_SOURCE_ORIGINAL"\n');
      await fs.writeFile(origin.fsPath, 'from .company import Company\n\nvalue: Company\n');
      provider = vscode.languages.registerHoverProvider({ scheme: 'file', pattern: new vscode.RelativePattern(directory, 'service.py') }, {
        provideHover: () => new vscode.Hover('Type hint: Company', new vscode.Range(2, 7, 2, 14)),
      });
      const doc = await vscode.workspace.openTextDocument(origin);
      const editor = await vscode.window.showTextDocument(doc);
      const position = new vscode.Position(2, 9);
      editor.selection = new vscode.Selection(position, position);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', origin, position);
      const text = (hovers ?? []).flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
      assert.ok(text.includes('IMPORT_SOURCE_ORIGINAL'), 'Hover must show the imported implementation body');
      assert.ok(!text.includes('openpyxl/'), 'Unrelated library fields must not enter the preview');
      await vscode.commands.executeCommand('intellisenseRecursion.goToType', origin.toString(), 'Company');
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), source.toString());
      assert.strictEqual(vscode.window.activeTextEditor?.selection.start.line, 0);
    } finally {
      provider?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
