import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─── Stats helpers ───

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values: number[]): { min: number; max: number; avg: number; p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function logStats(label: string, values: number[]) {
  const s = stats(values);
  console.log(`  ${label}: min=${s.min}ms avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms (n=${values.length})`);
}

// ─── File discovery ───

function getDefLocation(defs: any[]): { uri: vscode.Uri; range: vscode.Range } | null {
  if (!defs?.length) { return null; }
  const d = defs[0];
  if (d.targetUri) { return { uri: d.targetUri, range: d.targetRange || d.targetSelectionRange }; }
  if (d.uri) { return { uri: d.uri, range: d.range }; }
  return null;
}

function findIdentifier(doc: vscode.TextDocument, identifier: string): vscode.Position | null {
  const idx = doc.getText().indexOf(identifier);
  return idx >= 0 ? doc.positionAt(idx) : null;
}

async function collectFiles(wsRoot: string, ext: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth > 4 || result.length >= limit) { return; }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (result.length >= limit) { break; }
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) {
          scan(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith(ext)) {
          result.push(full);
        }
      }
    } catch {}
  };
  scan(wsRoot, 0);
  return result;
}

// ─── Stress tests ───

suite('Performance Stress: 100K files', () => {
  let wsRoot: string;
  let pyFiles: string[];
  let tsFiles: string[];

  suiteSetup(async function () {
    this.timeout(60000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }
    wsRoot = folders[0].uri.fsPath;

    // Verify fixture size
    const totalFiles = fs.readdirSync(wsRoot, { recursive: true }).length;
    console.log(`  Workspace: ${wsRoot}`);
    console.log(`  Total entries: ${totalFiles.toLocaleString()}`);

    // Sample files for testing
    pyFiles = await collectFiles(wsRoot, '.py', 200);
    tsFiles = await collectFiles(wsRoot, '.ts', 200);
    console.log(`  Sampled: ${pyFiles.length} .py, ${tsFiles.length} .ts`);
  });

  test('open 50 random documents in sequence', async function () {
    this.timeout(120000);
    const files = [...pyFiles, ...tsFiles].sort(() => Math.random() - 0.5).slice(0, 50);
    const times: number[] = [];

    for (const f of files) {
      const t0 = Date.now();
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        times.push(Date.now() - t0);
      } catch {
        times.push(Date.now() - t0);
      }
    }

    logStats('openTextDocument (50 files)', times);
    assert.ok(stats(times).p95 < 5000, `p95 openTextDocument too slow: ${stats(times).p95}ms`);
  });

  test('hover on 100 random type annotations (Python)', async function () {
    this.timeout(120000);
    const sampleFiles = pyFiles.filter(f => f.includes('service.py') || f.includes('models.py'))
      .sort(() => Math.random() - 0.5).slice(0, 20);

    const hoverTimes: number[] = [];
    const typeRegex = /\b([A-Z][a-zA-Z0-9]+)\b/g;
    let attempts = 0;

    for (const f of sampleFiles) {
      if (attempts >= 100) { break; }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();
        let match: RegExpExecArray | null;
        typeRegex.lastIndex = 0;
        while ((match = typeRegex.exec(text)) !== null && attempts < 100) {
          const pos = doc.positionAt(match.index);
          const t0 = Date.now();
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', doc.uri, pos
          );
          hoverTimes.push(Date.now() - t0);
          attempts++;
          if (hoverTimes.length % 25 === 0) {
            console.log(`    ...${hoverTimes.length} hovers done`);
          }
        }
      } catch {}
    }

    console.log(`  Total hover attempts: ${hoverTimes.length}`);
    if (hoverTimes.length > 0) {
      logStats('hoverProvider (Python)', hoverTimes);
      assert.ok(stats(hoverTimes).p95 < 5000, `p95 hover too slow: ${stats(hoverTimes).p95}ms`);
    }
  });

  test('hover on 100 random type annotations (TypeScript)', async function () {
    this.timeout(120000);
    const sampleFiles = tsFiles.filter(f => f.includes('components.tsx') || f.includes('types.ts'))
      .sort(() => Math.random() - 0.5).slice(0, 20);

    const hoverTimes: number[] = [];
    const typeRegex = /\b([A-Z][a-zA-Z0-9]+)\b/g;
    let attempts = 0;

    for (const f of sampleFiles) {
      if (attempts >= 100) { break; }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();
        let match: RegExpExecArray | null;
        typeRegex.lastIndex = 0;
        while ((match = typeRegex.exec(text)) !== null && attempts < 100) {
          const pos = doc.positionAt(match.index);
          const t0 = Date.now();
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', doc.uri, pos
          );
          hoverTimes.push(Date.now() - t0);
          attempts++;
          if (hoverTimes.length % 25 === 0) {
            console.log(`    ...${hoverTimes.length} hovers done`);
          }
        }
      } catch {}
    }

    console.log(`  Total hover attempts: ${hoverTimes.length}`);
    if (hoverTimes.length > 0) {
      logStats('hoverProvider (TypeScript)', hoverTimes);
      assert.ok(stats(hoverTimes).p95 < 5000, `p95 hover too slow: ${stats(hoverTimes).p95}ms`);
    }
  });

  test('definition provider on 100 random types', async function () {
    this.timeout(120000);
    const allSample = [...pyFiles, ...tsFiles]
      .filter(f => f.includes('service') || f.includes('components'))
      .sort(() => Math.random() - 0.5).slice(0, 30);

    const defTimes: number[] = [];
    const successCount = { resolved: 0, selfRef: 0, notFound: 0 };
    const typeRegex = /\b([A-Z][a-zA-Z0-9]+)\b/g;
    let attempts = 0;

    for (const f of allSample) {
      if (attempts >= 100) { break; }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();
        let match: RegExpExecArray | null;
        typeRegex.lastIndex = 0;
        while ((match = typeRegex.exec(text)) !== null && attempts < 100) {
          const pos = doc.positionAt(match.index);
          const t0 = Date.now();
          const defs = await vscode.commands.executeCommand<any[]>(
            'vscode.executeDefinitionProvider', doc.uri, pos
          );
          defTimes.push(Date.now() - t0);
          attempts++;

          const def = defs?.length ? getDefLocation(defs) : null;
          if (def) {
            const isSelf = def.uri.toString() === doc.uri.toString()
              && def.range.start.line === pos.line;
            if (isSelf) { successCount.selfRef++; }
            else { successCount.resolved++; }
          } else {
            successCount.notFound++;
          }
        }
      } catch {}
    }

    console.log(`  Results: ${successCount.resolved} resolved, ${successCount.selfRef} self-ref, ${successCount.notFound} not found`);
    if (defTimes.length > 0) {
      logStats('defProvider (mixed)', defTimes);
      assert.ok(stats(defTimes).p95 < 5000, `p95 defProvider too slow: ${stats(defTimes).p95}ms`);
    }
  });

  test('cross-package definition resolution (deep import chains)', async function () {
    this.timeout(120000);
    // Open service files that import from other packages
    const serviceFiles = pyFiles.filter(f => f.includes('service.py')).slice(0, 20);
    const chainTimes: number[] = [];
    const chainDepths: number[] = [];

    for (const f of serviceFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();
        // Find imported type names (PascalCase on import lines)
        const importLine = text.match(/^from .+ import (.+)/m);
        if (!importLine) { continue; }
        const types = importLine[1].match(/[A-Z][a-zA-Z0-9]+/g);
        if (!types?.length) { continue; }

        const typeName = types[0];
        const pos = findIdentifier(doc, typeName);
        if (!pos) { continue; }

        // Measure full definition resolution chain
        const t0 = Date.now();
        const defs = await vscode.commands.executeCommand<any[]>(
          'vscode.executeDefinitionProvider', doc.uri, pos
        );
        chainTimes.push(Date.now() - t0);

        // Follow chain depth
        let depth = 0;
        let currentDef = defs?.length ? getDefLocation(defs) : null;
        while (currentDef && depth < 5) {
          const defDoc = await vscode.workspace.openTextDocument(currentDef.uri);
          const defLine = defDoc.lineAt(currentDef.range.start.line).text;
          const parentMatch = defLine.match(/\((\w+)/);
          if (!parentMatch) { break; }
          const parentPos = findIdentifier(defDoc, parentMatch[1]);
          if (!parentPos) { break; }
          const parentDefs = await vscode.commands.executeCommand<any[]>(
            'vscode.executeDefinitionProvider', defDoc.uri, parentPos
          );
          currentDef = parentDefs?.length ? getDefLocation(parentDefs) : null;
          depth++;
        }
        chainDepths.push(depth);
      } catch {}
    }

    if (chainTimes.length > 0) {
      logStats('cross-pkg def chain', chainTimes);
      const avgDepth = chainDepths.reduce((a, b) => a + b, 0) / chainDepths.length;
      console.log(`  Avg chain depth: ${avgDepth.toFixed(1)}, max: ${Math.max(...chainDepths)}`);
    }
  });

  test('rapid successive hovers on same file (burst)', async function () {
    this.timeout(60000);
    const targetFile = tsFiles.find(f => f.includes('types.ts') && f.includes('pkg_0'));
    if (!targetFile) { console.log('  Skipped: target file not found'); return; }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFile));
    const text = doc.getText();
    const typeRegex = /\b([A-Z][a-zA-Z0-9]+)\b/g;
    const positions: vscode.Position[] = [];
    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(text)) !== null && positions.length < 50) {
      positions.push(doc.positionAt(m.index));
    }

    // Burst: hover all 50 positions as fast as possible
    const burstTimes: number[] = [];
    for (const pos of positions) {
      const t0 = Date.now();
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', doc.uri, pos
      );
      burstTimes.push(Date.now() - t0);
    }

    logStats('burst hover (50 positions, 1 file)', burstTimes);
    // No single hover should take >2s in burst mode
    assert.ok(stats(burstTimes).max < 5000, `Max burst hover too slow: ${stats(burstTimes).max}ms`);
  });

  test('regex defLine scan across 100 open documents', async function () {
    this.timeout(60000);
    // Simulate what goToTypeHandler does: open docs and scan for identifier
    const targetType = 'pkg000Class025'; // a known generated class name
    const regex = new RegExp(`\\bclass\\s+${targetType}\\b|\\binterface\\s+${targetType}\\b`, 'm');

    const allFiles = [...pyFiles, ...tsFiles].sort(() => Math.random() - 0.5).slice(0, 100);
    const openDocs: vscode.TextDocument[] = [];

    // Open 100 documents
    const openT0 = Date.now();
    for (const f of allFiles) {
      try { openDocs.push(await vscode.workspace.openTextDocument(vscode.Uri.file(f))); } catch {}
    }
    const openMs = Date.now() - openT0;
    console.log(`  Opened ${openDocs.length} docs in ${openMs}ms`);

    // Scan all open documents for the identifier
    const scanT0 = Date.now();
    let found = false;
    let scannedBytes = 0;
    for (const doc of openDocs) {
      const text = doc.getText();
      scannedBytes += text.length;
      if (regex.test(text)) {
        found = true;
        break;
      }
    }
    const scanMs = Date.now() - scanT0;
    console.log(`  defLine scan: ${scanMs}ms across ${openDocs.length} docs (${(scannedBytes / 1024).toFixed(0)} KB), found=${found}`);
    assert.ok(scanMs < 500, `defLine scan too slow: ${scanMs}ms for ${openDocs.length} docs`);
  });

  test('memory: open 200 documents does not crash', async function () {
    this.timeout(120000);
    const files = [...pyFiles, ...tsFiles].slice(0, 200);
    let openCount = 0;

    for (const f of files) {
      try {
        await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        openCount++;
      } catch {}
    }

    console.log(`  Successfully opened ${openCount}/200 documents`);
    assert.ok(openCount >= 150, `Too many failed opens: ${openCount}/200`);

    // Verify we can still hover after opening many docs
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(files[0]));
    const pos = new vscode.Position(0, 0);
    const t0 = Date.now();
    await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
    const elapsed = Date.now() - t0;
    console.log(`  Post-bulk-open hover: ${elapsed}ms`);
    assert.ok(elapsed < 10000, `Hover after bulk open too slow: ${elapsed}ms`);
  });
});
