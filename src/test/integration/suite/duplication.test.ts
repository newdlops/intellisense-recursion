import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

// ─── Helpers ───

function findIdentifier(doc: vscode.TextDocument, identifier: string, occurrence = 0): vscode.Position | null {
  const text = doc.getText();
  const regex = new RegExp(`\\b${identifier}\\b`, 'g');
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = regex.exec(text)) !== null) {
    if (count === occurrence) {
      return doc.positionAt(match.index);
    }
    count++;
  }
  return null;
}

async function getRawHovers(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', uri, position
  );
  return hovers || [];
}

function hoverToText(hover: vscode.Hover): string {
  const parts: string[] = [];
  for (const content of hover.contents) {
    if (content instanceof vscode.MarkdownString) {
      parts.push(content.value);
    } else if (typeof content === 'string') {
      parts.push(content);
    } else if (content && typeof (content as any).value === 'string') {
      parts.push((content as any).value);
    }
  }
  return parts.join('\n');
}

function extractCodeFences(text: string): string[] {
  const fenceRegex = /```[\w]*\n([\s\S]*?)```/g;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    fences.push(m[1].trim());
  }
  return fences;
}

function extractPreviews(text: string): string[] {
  const parts = text.split(/\n---\n/);
  return parts.slice(1);
}

async function waitForLanguageServer(doc: vscode.TextDocument, identifier: string, maxWaitMs = 45000): Promise<void> {
  const pos = findIdentifier(doc, identifier);
  if (!pos) { return; }
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', doc.uri, pos
    );
    if (hovers && hovers.length > 0) {
      console.log(`  Language server ready after ${Date.now() - start}ms`);
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`  Language server not ready after ${maxWaitMs}ms`);
}

// ─── Fixture config ───

function getFixtureLang(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return 'unknown'; }
  const wsPath = folders[0].uri.fsPath;
  const langs = ['typescript', 'python', 'javascript', 'java', 'go', 'rust', 'cpp', 'csharp', 'dart'];
  for (const lang of langs) {
    if (wsPath.endsWith(`/${lang}`) || wsPath.endsWith(`\\${lang}`)) { return lang; }
  }
  for (const lang of langs) {
    if (wsPath.includes(lang)) { return lang; }
  }
  return 'unknown';
}

interface FixtureConfig {
  serviceFile: string;
  modelsFile: string;
  typeName: string;
  parentType: string;
}

const CONFIGS: Record<string, FixtureConfig> = {
  typescript: { serviceFile: 'service.ts', modelsFile: 'models.ts', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  python: { serviceFile: 'service.py', modelsFile: 'models.py', typeName: 'User', parentType: 'TimestampedModel' },
  javascript: { serviceFile: 'service.js', modelsFile: 'models.js', typeName: 'UserService', parentType: 'BaseEntity' },
  java: { serviceFile: 'Service.java', modelsFile: 'UserProfile.java', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  go: { serviceFile: 'service.go', modelsFile: 'models.go', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  rust: { serviceFile: 'src/service.rs', modelsFile: 'src/models.rs', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  cpp: { serviceFile: 'service.cpp', modelsFile: 'models.h', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  csharp: { serviceFile: 'Service.cs', modelsFile: 'Models.cs', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
  dart: { serviceFile: 'lib/service.dart', modelsFile: 'lib/models.dart', typeName: 'UserProfile', parentType: 'TimestampedEntity' },
};

// ─── Integration Tests ───

suite('Hover Duplication Integration', () => {
  const lang = getFixtureLang();
  const cfg = CONFIGS[lang];
  let patchActive = false;

  suiteSetup(async function () {
    this.timeout(90000);
    if (!cfg) { throw new Error(`Unsupported fixture: ${lang}`); }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }

    // Open files
    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.modelsFile));
    const modelsDoc = await vscode.workspace.openTextDocument(modelsFile);
    await vscode.window.showTextDocument(modelsDoc);

    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);

    await waitForLanguageServer(serviceDoc, cfg.typeName);

    // Check extension patch status
    try {
      const status = await vscode.commands.executeCommand<{ hoverPatchActive: boolean }>(
        'intellisenseRecursion.getPatchStatus'
      );
      patchActive = status?.hoverPatchActive ?? false;
      console.log(`  Extension patch status: ${patchActive ? 'ACTIVE' : 'INACTIVE'}`);
    } catch {
      console.log('  Extension patch status: UNAVAILABLE (command not found)');
      patchActive = false;
    }
  });

  test(`[${lang}] extension hover patch must be active`, function () {
    assert.ok(patchActive,
      'The $provideHover patch is NOT active in this environment. ' +
      'Integration tests require the full extension to be operational. ' +
      'Check that findSharedHoverService() succeeds.');
  });

  test(`[${lang}] hover should not contain tripled content`, async function () {
    this.timeout(30000);
    if (!patchActive) { this.skip(); }

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg!.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, cfg!.typeName);
    assert.ok(pos, `Could not find "${cfg!.typeName}"`);

    const hovers = await getRawHovers(doc.uri, pos!);
    console.log(`  Hover providers: ${hovers.length}`);

    // Collect all content across all hover providers
    const allTexts = hovers.map(h => hoverToText(h));
    for (let i = 0; i < allTexts.length; i++) {
      console.log(`  Hover[${i}]: ${allTexts[i].length} chars`);
    }

    // Check: preview sections should not be duplicated across providers
    const allPreviews: string[] = [];
    for (const text of allTexts) {
      allPreviews.push(...extractPreviews(text));
    }

    console.log(`  Total preview blocks: ${allPreviews.length}`);

    const previewCounts = new Map<string, number>();
    for (const p of allPreviews) {
      const trimmed = p.trim();
      previewCounts.set(trimmed, (previewCounts.get(trimmed) || 0) + 1);
    }

    const duplicates = [...previewCounts.entries()].filter(([, count]) => count > 1);
    for (const [preview, count] of duplicates) {
      console.log(`  DUPLICATE (x${count}): ${preview.substring(0, 80)}...`);
    }

    assert.strictEqual(duplicates.length, 0,
      `Same preview appears in ${duplicates.length} hover provider(s). ` +
      `Counts: ${duplicates.map(([, c]) => `x${c}`).join(', ')}. ` +
      `The $provideHover patch is appending previews to every provider's result.`);
  });

  test(`[${lang}] code fences should not be duplicated in combined hover`, async function () {
    this.timeout(30000);
    if (!patchActive) { this.skip(); }

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg!.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, cfg!.typeName);
    assert.ok(pos, `Could not find "${cfg!.typeName}"`);

    // Get combined hover text (as user sees it)
    const hovers = await getRawHovers(doc.uri, pos!);
    const combined = hovers.map(h => hoverToText(h)).join('\n');
    const fences = extractCodeFences(combined);

    console.log(`  Code fences in combined hover: ${fences.length}`);

    const fenceCounts = new Map<string, number>();
    for (const f of fences) {
      fenceCounts.set(f, (fenceCounts.get(f) || 0) + 1);
    }

    const duplicateFences = [...fenceCounts.entries()].filter(([, count]) => count > 1);
    for (const [fence, count] of duplicateFences) {
      console.log(`  DUPLICATE FENCE (x${count}): ${fence.substring(0, 60)}...`);
    }

    assert.strictEqual(duplicateFences.length, 0,
      `${duplicateFences.length} code fence(s) appear multiple times. ` +
      `The same definition preview is being injected by multiple hover providers.`);
  });

  test(`[${lang}] total hover size should be reasonable (no 3x bloat)`, async function () {
    this.timeout(30000);
    if (!patchActive) { this.skip(); }

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg!.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, cfg!.typeName);
    assert.ok(pos, `Could not find "${cfg!.typeName}"`);

    const hovers = await getRawHovers(doc.uri, pos!);

    // Find the largest single hover (assumed to contain the full preview)
    const sizes = hovers.map(h => hoverToText(h).length);
    const maxSize = Math.max(...sizes);
    const totalSize = sizes.reduce((a, b) => a + b, 0);

    console.log(`  Hover sizes: [${sizes.join(', ')}], total: ${totalSize}, max: ${maxSize}`);

    // If total is more than 2x the largest single hover, something is being duplicated
    if (maxSize > 0) {
      const ratio = totalSize / maxSize;
      console.log(`  Size ratio (total/max): ${ratio.toFixed(2)}`);
      assert.ok(ratio < 2.5,
        `Combined hover size (${totalSize}) is ${ratio.toFixed(1)}x the largest provider (${maxSize}). ` +
        `Expected < 2.5x — likely duplicate preview injection.`);
    }
  });
});
