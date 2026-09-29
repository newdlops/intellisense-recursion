import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildDefinitionPreviewResult, buildDefinitionPreviewResultFromRawFile, clearPreviewLocations } from '../../preview-builder';
import { evictRawDefFileCacheEntry } from '../../preview-engine';
import { parsePreviewMarkdownSource } from '../../preview-markdown';

suite('Complete definition previews', () => {
  let directory: string;
  suiteSetup(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-complete-preview-')); });
  suiteTeardown(async () => {
    clearPreviewLocations();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const cases = [
    {
      name: 'decorated Python class beyond 10,000 lines',
      file: 'complete_class.py', identifier: 'CompleteDefinition', start: 1,
      lines: [
        '@decorate',
        'class CompleteDefinition:',
        '    """Keep this description ... verbatim."""',
        '    placeholder = ...',
        ...Array.from({ length: 10_025 }, (_, i) => `    field_${i}: int = ${i}`),
        '    final_value = "IR_PREVIEW_COMPLETE"',
      ],
      neighbor: 'class NextDefinition: pass',
    },
    {
      name: 'TypeScript class beyond 10,000 lines',
      file: 'complete_class.ts', identifier: 'CompleteDefinition', start: 0,
      lines: [
        'class CompleteDefinition {',
        '  description = "Keep this ... verbatim.";',
        ...Array.from({ length: 10_025 }, (_, i) => `  field_${i}: number = ${i};`),
        '  final_value = "IR_PREVIEW_COMPLETE";',
        '}',
      ],
      neighbor: 'class NextDefinition {}',
    },
    {
      name: 'Python value beyond 600 lines',
      file: 'complete_value.py', identifier: 'COMPLETE_VALUE', start: 0,
      lines: [
        'COMPLETE_VALUE = [',
        '    ...,',
        ...Array.from({ length: 750 }, (_, i) => `    "entry_${i}",`),
        '    "... IR_PREVIEW_COMPLETE",',
        ']',
      ],
      neighbor: 'NEXT_VALUE = "outside the definition"',
    },
    {
      name: 'TypeScript value beyond 600 lines',
      file: 'complete_value.ts', identifier: 'COMPLETE_VALUE', start: 0,
      lines: [
        'const COMPLETE_VALUE = {',
        '  ...defaults,',
        ...Array.from({ length: 750 }, (_, i) => `  field_${i}: "entry_${i}",`),
        '  final_value: "... IR_PREVIEW_COMPLETE",',
        '};',
      ],
      neighbor: 'const NEXT_VALUE = "outside the definition";',
    },
  ];

  for (const sample of cases) {
    test(`${sample.name} stays exact in document and raw-file previews`, async () => {
      const uri = vscode.Uri.file(path.join(directory, sample.file));
      const code = sample.lines.join('\n');
      await fs.writeFile(uri.fsPath, code + '\n' + sample.neighbor + '\n');
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        // Header-only LSP ranges must never cap a structural definition.
        const fromDocument = buildDefinitionPreviewResult(sample.identifier, uri, doc, sample.start, sample.start);
        const fromFile = await buildDefinitionPreviewResultFromRawFile(sample.identifier, uri, uri.fsPath, sample.start, sample.start);
        assert.strictEqual(fromDocument.preview, fromFile.preview);
        for (const result of [fromDocument, fromFile]) {
          assert.strictEqual(parsePreviewMarkdownSource(result.preview)?.code, code,
            'Preserve every source line, including real ellipses and the final sentinel');
          assert.strictEqual(result.previewLineCount, sample.lines.length);
          assert.strictEqual(result.location.range.end.line, sample.lines.length);
          assert.ok(!result.preview.includes(sample.neighbor), 'Stop at the definition, not the next declaration');
          assert.ok(!result.preview.includes('more lines'), 'Never replace the tail with a generated summary');
        }
      } finally { evictRawDefFileCacheEntry(uri.fsPath); }
    });
  }
});
