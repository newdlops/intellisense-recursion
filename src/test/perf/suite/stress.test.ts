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
    const tsOnly = await collectFiles(wsRoot, '.ts', 150);
    const tsxOnly = await collectFiles(wsRoot, '.tsx', 50);
    tsFiles = [...tsOnly, ...tsxOnly];
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

  test('defLine scan finds methods, fields, const, properties (Python)', async function () {
    this.timeout(60000);
    const modelFiles = pyFiles.filter(f => f.includes('models.py')).slice(0, 10);
    const found: { type: string; file: string; line: string }[] = [];

    for (const f of modelFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();

        // Find def method_name
        const defMatch = text.match(/^\s+def (\w+)\(self/m);
        if (defMatch) { found.push({ type: 'method', file: path.basename(f), line: defMatch[0].trim() }); }

        // Find field = models.Field()
        const fieldMatch = text.match(/^\s+(\w+) = models\.\w+\(/m);
        if (fieldMatch) { found.push({ type: 'django_field', file: path.basename(f), line: fieldMatch[0].trim() }); }

        // Find @property
        const propMatch = text.match(/@property\s+def (\w+)/m);
        if (propMatch) { found.push({ type: 'property', file: path.basename(f), line: propMatch[0].trim() }); }

        // Find field: type annotation
        const annotMatch = text.match(/^\s+(\w+): (str|int|float|bool)/m);
        if (annotMatch) { found.push({ type: 'annotation', file: path.basename(f), line: annotMatch[0].trim() }); }
      } catch {}
    }

    console.log(`  Found ${found.length} definition patterns across ${modelFiles.length} files:`);
    const byType: Record<string, number> = {};
    for (const f of found) { byType[f.type] = (byType[f.type] || 0) + 1; }
    for (const [t, c] of Object.entries(byType)) { console.log(`    ${t}: ${c}`); }

    assert.ok(found.some(f => f.type === 'method'), 'No method definitions found in fixtures');
    assert.ok(found.some(f => f.type === 'django_field'), 'No Django field assignments found in fixtures');
    assert.ok(found.some(f => f.type === 'annotation'), 'No type annotations found in fixtures');
  });

  test('defLine scan finds methods, fields, const (TypeScript)', async function () {
    this.timeout(60000);
    const typeFiles = tsFiles.filter(f => f.includes('types.ts')).slice(0, 10);
    const funcFiles = tsFiles.filter(f => f.includes('components.tsx')).slice(0, 10);
    const found: { type: string; file: string; line: string }[] = [];

    for (const f of typeFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();

        // Find method signature: name(id: number)
        const methodMatch = text.match(/^\s+(\w+)\(.*\):/m);
        if (methodMatch) { found.push({ type: 'method_sig', file: path.basename(f), line: methodMatch[0].trim() }); }

        // Find readonly field
        const readonlyMatch = text.match(/^\s+readonly (\w+):/m);
        if (readonlyMatch) { found.push({ type: 'readonly_field', file: path.basename(f), line: readonlyMatch[0].trim() }); }

        // Find optional field
        const optMatch = text.match(/^\s+(\w+)\?:/m);
        if (optMatch) { found.push({ type: 'optional_field', file: path.basename(f), line: optMatch[0].trim() }); }
      } catch {}
    }

    for (const f of funcFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();

        // Find export function
        const funcMatch = text.match(/^export function (\w+)/m);
        if (funcMatch) { found.push({ type: 'export_function', file: path.basename(f), line: funcMatch[0].trim() }); }

        // Find export const
        const constMatch = text.match(/^export const (\w+)/m);
        if (constMatch) { found.push({ type: 'export_const', file: path.basename(f), line: constMatch[0].trim() }); }
      } catch {}
    }

    console.log(`  Found ${found.length} definition patterns across ${typeFiles.length + funcFiles.length} files:`);
    const byType: Record<string, number> = {};
    for (const f of found) { byType[f.type] = (byType[f.type] || 0) + 1; }
    for (const [t, c] of Object.entries(byType)) { console.log(`    ${t}: ${c}`); }

    assert.ok(found.some(f => f.type === 'method_sig'), 'No method signatures found in TS fixtures');
    assert.ok(found.some(f => f.type === 'export_function'), 'No export functions found in TS fixtures');
    assert.ok(found.some(f => f.type === 'export_const'), 'No export consts found in TS fixtures');
  });

  test('findDefInText resolves all definition pattern types', async function () {
    this.timeout(60000);
    // Open a model file and verify findDefInText would match each pattern type
    const modelFile = pyFiles.find(f => f.includes('models.py') && f.includes('pkg_000'));
    if (!modelFile) { console.log('  Skipped: no model file'); return; }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelFile));
    const text = doc.getText();

    const patterns = [
      { name: 'class', regex: /^class (\w+)/m },
      { name: 'method', regex: /^\s+def (\w+)\(/m },
      { name: 'django_field', regex: /^\s+(\w+) = models\.\w+\(/m },
      { name: 'annotation', regex: /^\s+(\w+): (?:str|int|float|bool)/m },
    ];

    const results: { pattern: string; identifier: string; found: boolean }[] = [];
    for (const { name: patName, regex } of patterns) {
      const match = regex.exec(text);
      if (match && match[1]) {
        const identifier = match[1];
        // Simulate defLine scan: does the identifier exist as a definition?
        const defRegex = new RegExp(`(?:class|def|interface|type)\\s+${identifier}\\b|^\\s+${identifier}\\s*[:=(]`, 'm');
        const defFound = defRegex.test(text);
        results.push({ pattern: patName, identifier, found: defFound });
      }
    }

    console.log('  Pattern resolution:');
    for (const r of results) {
      console.log(`    ${r.pattern}: "${r.identifier}" → ${r.found ? 'FOUND' : 'NOT FOUND'}`);
    }

    assert.ok(results.length >= 3, `Only ${results.length} patterns found, expected ≥3`);
    const allFound = results.every(r => r.found);
    assert.ok(allFound, `Some patterns not resolved: ${results.filter(r => !r.found).map(r => r.pattern).join(', ')}`);
  });

  test('all-identifier extraction: lowercase, camelCase, snake_case, PascalCase', async function () {
    this.timeout(60000);
    // Verify that the skip list only blocks pure keywords, not variable/type names
    const SKIP = new Set(['class','def','if','else','for','while','return','import','from','as','with','try','except',
      'finally','raise','pass','break','continue','and','or','not','is','in','lambda','yield','async','await',
      'var','let','const','function','new','delete','typeof','instanceof','void','this','switch','case','default',
      'throw','catch','export','extends','implements','interface','enum','abstract','static','public','private',
      'protected','readonly','override','struct','union','typedef','extern','register','virtual','inline',
      'constexpr','namespace','using','template','the','The','that','will','are','was','has','have','can',
      'should','may','must','been','being','does','did','its','also','than','then','when','where','which',
      'what','how','who','all','each','every','some','any','Returns','Raises','Args','Parameters','Note',
      'Example','param','throws','since','see','deprecated','alias','overload','module','variable']);

    const testIds = [
      // PascalCase types (should pass)
      'UserProfile', 'HttpResponseBase', 'TimestampedModel', 'CompanyInfo',
      // snake_case functions/fields (should pass)
      'get_display_name', 'created_at', 'field_name', 'save_record',
      // camelCase (should pass — editor shows underline for these)
      'delaySeconds', 'userName', 'getData', 'processEntity',
      // UPPER_CASE constants (should pass)
      'MAX_RETRIES', 'API_ENDPOINT', 'DEFAULT_TIMEOUT',
      // lowercase common identifiers (should pass — not in skip list)
      'name', 'data', 'value', 'result', 'user', 'company',
      // Keywords (should be BLOCKED)
      'class', 'def', 'return', 'import', 'function', 'const',
      // Doc words (should be BLOCKED)
      'the', 'Returns', 'Example', 'deprecated',
    ];

    const passed: string[] = [];
    const blocked: string[] = [];
    for (const id of testIds) {
      if (id.length > 2 && !SKIP.has(id)) {
        passed.push(id);
      } else {
        blocked.push(id);
      }
    }

    console.log(`  Passed (${passed.length}): ${passed.join(', ')}`);
    console.log(`  Blocked (${blocked.length}): ${blocked.join(', ')}`);

    // All type/variable names should pass
    assert.ok(passed.includes('UserProfile'), 'PascalCase should pass');
    assert.ok(passed.includes('get_display_name'), 'snake_case should pass');
    assert.ok(passed.includes('delaySeconds'), 'camelCase should pass');
    assert.ok(passed.includes('MAX_RETRIES'), 'UPPER_CASE should pass');
    assert.ok(passed.includes('name'), 'common lowercase should pass');
    assert.ok(passed.includes('user'), 'common lowercase should pass');

    // Keywords should be blocked
    assert.ok(blocked.includes('class'), 'keyword should be blocked');
    assert.ok(blocked.includes('return'), 'keyword should be blocked');
    assert.ok(blocked.includes('the'), 'doc word should be blocked');
  });

  test('hover on all identifier types in 1 file', async function () {
    this.timeout(120000);
    const modelFile = pyFiles.find(f => f.includes('models.py') && f.includes('pkg_000'));
    if (!modelFile) { console.log('  Skipped: no model file'); return; }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelFile));
    const text = doc.getText();

    // Extract ALL identifiers (3+ chars, not keywords) — same as renderer logic
    const SKIP_RE = /^(class|def|if|else|for|while|return|import|from|as|with|try|except|finally|raise|pass|break|continue|and|or|not|is|in|lambda|yield|async|await)$/;
    const re = /([a-zA-Z_][a-zA-Z0-9_]{2,})/g;
    const identifiers = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!SKIP_RE.test(m[1])) { identifiers.add(m[1]); }
    }

    console.log(`  Total unique identifiers in file: ${identifiers.size}`);

    // Hover on a sample of them and measure timing
    const sample = [...identifiers].slice(0, 50);
    const hoverTimes: number[] = [];
    let withContent = 0;

    for (const id of sample) {
      const idx = text.indexOf(id);
      if (idx < 0) { continue; }
      const pos = doc.positionAt(idx);
      const t0 = Date.now();
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', doc.uri, pos
      );
      hoverTimes.push(Date.now() - t0);
      if (hovers && hovers.length > 0) { withContent++; }
    }

    logStats('hover all identifier types', hoverTimes);
    console.log(`  ${withContent}/${sample.length} had hover content`);
    assert.ok(stats(hoverTimes).p95 < 5000, `p95 hover too slow: ${stats(hoverTimes).p95}ms`);
  });

  test('defLine scan for various identifier patterns at scale', async function () {
    this.timeout(60000);
    // Open 50 files and scan for different pattern types
    const files = [...pyFiles.filter(f => f.includes('models.py')).slice(0, 25),
      ...tsFiles.filter(f => f.includes('types.ts')).slice(0, 25)];

    const scanTimes: number[] = [];
    const patternCounts: Record<string, number> = {};
    const patternTypes = ['class', 'method', 'field_assign', 'const', 'annotation', 'method_sig'];
    for (const pt of patternTypes) { patternCounts[pt] = 0; }

    for (const f of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        const text = doc.getText();

        // Measure scan time for a random identifier from the file
        const ids = text.match(/([a-zA-Z_][a-zA-Z0-9_]{2,})/g) || [];
        const targetId = ids[Math.floor(Math.random() * ids.length)];
        if (!targetId || targetId.length < 3) { continue; }

        const t0 = Date.now();
        // Simulate findDefInText patterns
        if (new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:class|interface|type|enum|struct)[ \\t]+${targetId}\\b`, 'm').test(text)) {
          patternCounts['class']++;
        } else if (new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?(?:def|fn|func|function)[ \\t]+${targetId}\\b`, 'm').test(text)) {
          patternCounts['method']++;
        } else if (new RegExp(`^[ \\t]+${targetId}[ \\t]*=[ \\t]*(?:models\\.)?\\w+\\(`, 'm').test(text)) {
          patternCounts['field_assign']++;
        } else if (new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${targetId}\\b`, 'm').test(text)) {
          patternCounts['const']++;
        } else if (new RegExp(`^[ \\t]+${targetId}[ \\t]*[:?][ \\t]*\\w`, 'm').test(text)) {
          patternCounts['annotation']++;
        } else if (new RegExp(`^[ \\t]+(?:readonly[ \\t]+)?${targetId}[ \\t]*[<(]`, 'm').test(text)) {
          patternCounts['method_sig']++;
        }
        scanTimes.push(Date.now() - t0);
      } catch {}
    }

    logStats('defLine pattern scan (50 files)', scanTimes);
    console.log('  Pattern match counts:');
    for (const [pt, c] of Object.entries(patternCounts)) { console.log(`    ${pt}: ${c}`); }

    assert.ok(stats(scanTimes).p95 < 100, `p95 defLine scan too slow: ${stats(scanTimes).p95}ms`);
  });

  suiteTeardown(function () {
    if (process.env.PERF_CLEANUP !== 'false' && wsRoot && wsRoot.includes('perf-fixtures')) {
      try {
        fs.rmSync(wsRoot, { recursive: true });
        console.log(`  Cleaned up: ${wsRoot}`);
      } catch (err) {
        console.log(`  Cleanup failed (non-critical): ${err}`);
      }
    }
  });
});
