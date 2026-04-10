import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

// Helper: normalize definition results (can be Location or LocationLink)
function getDefLocation(defs: any[]): { uri: vscode.Uri; range: vscode.Range } | null {
  if (!defs?.length) { return null; }
  const d = defs[0];
  // LocationLink: { targetUri, targetRange, ... }
  if (d.targetUri) {
    return { uri: d.targetUri, range: d.targetRange || d.targetSelectionRange };
  }
  // Location: { uri, range }
  if (d.uri) {
    return { uri: d.uri, range: d.range };
  }
  return null;
}

// Helper: wait for language server to be ready by polling hover on a known type
async function waitForLanguageServer(doc: vscode.TextDocument, identifierToCheck: string, maxWaitMs = 45000): Promise<void> {
  const pos = findIdentifier(doc, identifierToCheck);
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
  console.log(`  Language server not ready after ${maxWaitMs}ms — tests may fail`);
}

// Helper: get hover content as concatenated string
async function getHoverText(uri: vscode.Uri, position: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', uri, position
  );
  if (!hovers?.length) { return ''; }
  const parts: string[] = [];
  for (const hover of hovers) {
    for (const content of hover.contents) {
      if (content instanceof vscode.MarkdownString) {
        parts.push(content.value);
      } else if (typeof content === 'string') {
        parts.push(content);
      } else if (content && typeof (content as any).value === 'string') {
        parts.push((content as any).value);
      }
    }
  }
  return parts.join('\n');
}

// Helper: get raw hover objects for per-provider analysis
async function getRawHovers(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', uri, position
  );
  return hovers || [];
}

// Helper: extract text content from a single Hover object
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

// Helper: extract preview blocks (content after ---) from hover text
function extractPreviews(text: string): string[] {
  const parts = text.split(/\n---\n/);
  return parts.slice(1); // everything after the first --- separator is a preview
}

// Helper: find position of identifier in document
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

// Helper: count occurrences of a pattern in text
function countOccurrences(text: string, pattern: string): number {
  const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return (text.match(regex) || []).length;
}

// Helper: count code fence blocks
function countCodeFences(text: string): number {
  return (text.match(/```/g) || []).length / 2;  // pairs of ```
}

// ─── Language-specific fixture configuration ───

interface LangConfig {
  /** File containing type/class definitions */
  modelsFile: string;
  /** File that uses/imports types */
  serviceFile: string;
  /** Type name to look for in service file (e.g. UserProfile, User) */
  typeName: string;
  /** Parent/base type name used in inheritance (e.g. TimestampedEntity) */
  parentType: string;
  /** Root base type name used in service file (e.g. BaseEntity, BaseModel) */
  baseName: string;
  /** File where typeName definition should resolve to */
  typeExpectedFile: string;
  /** File where baseName definition should resolve to */
  baseExpectedFile: string;
}

const LANG_CONFIGS: Record<string, LangConfig> = {
  typescript: {
    modelsFile: 'models.ts',
    serviceFile: 'service.ts',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'models.ts',
    baseExpectedFile: 'models.ts',
  },
  python: {
    modelsFile: 'models.py',
    serviceFile: 'service.py',
    typeName: 'User',
    parentType: 'TimestampedModel',
    baseName: 'BaseModel',
    typeExpectedFile: 'models.py',
    baseExpectedFile: 'models.py',
  },
  javascript: {
    modelsFile: 'models.js',
    serviceFile: 'service.js',
    typeName: 'UserService',
    parentType: 'BaseEntity',
    baseName: 'UserService',
    typeExpectedFile: 'models.js',
    baseExpectedFile: 'models.js',
  },
  java: {
    modelsFile: 'UserProfile.java',
    serviceFile: 'Service.java',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'UserProfile.java',
    baseExpectedFile: 'BaseEntity.java',
  },
  go: {
    modelsFile: 'models.go',
    serviceFile: 'service.go',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'models.go',
    baseExpectedFile: 'models.go',
  },
  rust: {
    modelsFile: 'src/models.rs',
    serviceFile: 'src/service.rs',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'models.rs',
    baseExpectedFile: 'models.rs',
  },
  cpp: {
    modelsFile: 'models.h',
    serviceFile: 'service.cpp',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'models.h',
    baseExpectedFile: 'models.h',
  },
  csharp: {
    modelsFile: 'Models.cs',
    serviceFile: 'Service.cs',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'Models.cs',
    baseExpectedFile: 'Models.cs',
  },
  dart: {
    modelsFile: 'lib/models.dart',
    serviceFile: 'lib/service.dart',
    typeName: 'UserProfile',
    parentType: 'TimestampedEntity',
    baseName: 'BaseEntity',
    typeExpectedFile: 'models.dart',
    baseExpectedFile: 'models.dart',
  },
};

// ─── Detect fixture language from workspace ───

function getFixtureLang(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return 'unknown'; }
  const wsPath = folders[0].uri.fsPath;
  // Check each supported language by folder name
  for (const lang of Object.keys(LANG_CONFIGS)) {
    if (wsPath.endsWith(`/${lang}`) || wsPath.endsWith(`\\${lang}`)) {
      return lang;
    }
  }
  // Fallback: partial match
  for (const lang of Object.keys(LANG_CONFIGS)) {
    if (wsPath.includes(lang)) {
      return lang;
    }
  }
  return 'unknown';
}

function getLangConfig(lang: string): LangConfig {
  const config = LANG_CONFIGS[lang];
  if (!config) {
    throw new Error(`Unsupported fixture language: "${lang}". Supported: ${Object.keys(LANG_CONFIGS).join(', ')}`);
  }
  return config;
}

// ─── Tests ───

suite('Hover Preview E2E', () => {
  const lang = getFixtureLang();
  const cfg = LANG_CONFIGS[lang];

  suiteSetup(async function () {
    this.timeout(90000);
    if (!cfg) {
      console.log(`Skipping: unknown fixture language "${lang}"`);
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }

    // Open models file first (has the type definitions)
    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.modelsFile));
    const modelsDoc = await vscode.workspace.openTextDocument(modelsFile);
    await vscode.window.showTextDocument(modelsDoc);

    // Then open service file
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);

    // Wait for language server to be ready on a known type
    await waitForLanguageServer(serviceDoc, cfg.typeName);
  });

  test(`[${lang}] hover on type annotation should return content`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    assert.ok(pos, `Could not find "${c.typeName}" in ${c.serviceFile}`);

    const hoverText = await getHoverText(doc.uri, pos!);
    assert.ok(hoverText.length > 0, `Hover on "${c.typeName}" returned empty content`);
    console.log(`  hover on "${c.typeName}": ${hoverText.length} chars`);
  });

  test(`[${lang}] hover content should not contain duplicate previews`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    assert.ok(pos, `Could not find "${c.typeName}"`);

    const hoverText = await getHoverText(doc.uri, pos!);
    if (!hoverText) { return; }  // skip if no hover

    // Count --- separators (each preview is separated by ---)
    const separators = countOccurrences(hoverText, '---');
    const codeFences = countCodeFences(hoverText);

    console.log(`  separators: ${separators}, code fences: ${codeFences}`);

    // With up to 3 type previews, we should have at most 3 --- and 4 code fences (1 original + 3 previews)
    // But definitely NOT 3x duplication (9 separators, 12 fences)
    assert.ok(separators <= 4, `Too many separators (${separators}) — possible duplication in hover content`);
    assert.ok(codeFences <= 5, `Too many code fences (${codeFences}) — possible duplication in hover content`);
  });

  test(`[${lang}] definition provider should resolve type to correct file`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    assert.ok(pos, `Could not find "${c.typeName}"`);

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', doc.uri, pos!
    );
    const def = getDefLocation(defs!);
    assert.ok(def, `No definition found for "${c.typeName}"`);

    const defPath = def!.uri.fsPath;
    assert.ok(defPath.endsWith(c.typeExpectedFile),
      `Expected definition in ${c.typeExpectedFile}, got ${path.basename(defPath)}`);

    console.log(`  "${c.typeName}" → ${path.basename(defPath)}:${def!.range.start.line + 1}`);
  });

  test(`[${lang}] hover on base class should resolve parent type`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.modelsFile));
    const doc = await vscode.workspace.openTextDocument(modelsFile);

    const pos = findIdentifier(doc, c.parentType);
    assert.ok(pos, `Could not find "${c.parentType}" in ${c.modelsFile}`);

    const hoverText = await getHoverText(doc.uri, pos!);
    assert.ok(hoverText.length > 0, `Hover on "${c.parentType}" returned empty content`);

    console.log(`  hover on "${c.parentType}": ${hoverText.length} chars`);
  });

  test(`[${lang}] multiple hovers should not accumulate duplicate content`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    if (!pos) { return; }

    // Execute hover 3 times — content should be identical each time
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await getHoverText(doc.uri, pos));
    }

    assert.strictEqual(results[0], results[1], 'Hover content changed between 1st and 2nd call');
    assert.strictEqual(results[1], results[2], 'Hover content changed between 2nd and 3rd call');
    console.log(`  3 identical hovers: ${results[0].length} chars each`);
  });

  test(`[${lang}] preview content should not be duplicated across hover providers`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    if (!pos) { return; }

    const hovers = await getRawHovers(doc.uri, pos);
    console.log(`  hover providers returned: ${hovers.length} Hover object(s)`);

    // Collect all preview blocks from all hover objects
    const allPreviews: string[] = [];
    for (const hover of hovers) {
      const text = hoverToText(hover);
      const previews = extractPreviews(text);
      allPreviews.push(...previews);
    }

    if (allPreviews.length === 0) {
      console.log(`  no preview blocks found (extension may not be active)`);
      return;
    }

    console.log(`  total preview blocks: ${allPreviews.length}`);

    // Each unique preview should appear only once across all hovers
    const seen = new Map<string, number>();
    for (const preview of allPreviews) {
      const trimmed = preview.trim();
      seen.set(trimmed, (seen.get(trimmed) || 0) + 1);
    }

    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    if (duplicates.length > 0) {
      const details = duplicates.map(([preview, count]) =>
        `  "${preview.substring(0, 60)}..." appeared ${count} times`
      ).join('\n');
      console.log(`  DUPLICATE PREVIEWS:\n${details}`);
    }

    assert.strictEqual(duplicates.length, 0,
      `Found ${duplicates.length} duplicate preview(s) across ${hovers.length} hover provider(s) — same content repeated ${duplicates.map(([, c]) => c).join(', ')} times`);
  });

  test(`[${lang}] hover should not contain more than one copy of the same code fence`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.typeName);
    if (!pos) { return; }

    const hoverText = await getHoverText(doc.uri, pos);
    if (!hoverText) { return; }

    // Extract all code fence blocks
    const fenceRegex = /```[\w]*\n([\s\S]*?)```/g;
    const fences: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(hoverText)) !== null) {
      fences.push(m[1].trim());
    }

    if (fences.length <= 1) {
      console.log(`  ${fences.length} code fence(s) — no duplication possible`);
      return;
    }

    // Check for identical code fences
    const fenceCounts = new Map<string, number>();
    for (const fence of fences) {
      fenceCounts.set(fence, (fenceCounts.get(fence) || 0) + 1);
    }

    const duplicateFences = [...fenceCounts.entries()].filter(([, count]) => count > 1);
    console.log(`  ${fences.length} code fence(s), ${duplicateFences.length} duplicate(s)`);

    assert.strictEqual(duplicateFences.length, 0,
      `Same code fence content appears multiple times in hover (${duplicateFences.map(([code, count]) => `"${code.substring(0, 40)}..." x${count}`).join(', ')})`);
  });
});

suite('Go To Definition E2E', () => {
  const lang = getFixtureLang();

  test(`[${lang}] definition chain: service → models`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const pos = findIdentifier(doc, c.baseName);
    assert.ok(pos, `Could not find "${c.baseName}" in ${c.serviceFile}`);

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', doc.uri, pos!
    );
    const def = getDefLocation(defs!);
    assert.ok(def, `No definition for "${c.baseName}"`);

    // Should point to models file
    assert.ok(def!.uri.fsPath.endsWith(c.baseExpectedFile),
      `Expected ${c.baseExpectedFile}, got ${path.basename(def!.uri.fsPath)}`);

    console.log(`  ${c.baseName}: service → ${c.baseExpectedFile}:${def!.range.start.line + 1}`);
  });

  test(`[${lang}] definition from models resolves inheritance`, async function () {
    this.timeout(30000);
    const c = getLangConfig(lang);
    const folders = vscode.workspace.workspaceFolders!;
    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, c.modelsFile));
    const doc = await vscode.workspace.openTextDocument(modelsFile);

    // Find parent type at the inheritance position (not the definition) — 2nd occurrence
    const pos = findIdentifier(doc, c.parentType, 1);
    if (!pos) {
      console.log(`  Skipped: "${c.parentType}" not found at inheritance position`);
      return;
    }

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', doc.uri, pos
    );
    const def = getDefLocation(defs!);
    assert.ok(def, `No definition for "${c.parentType}" at inheritance`);

    // Should resolve to the class/interface definition in same file
    assert.ok(def!.uri.fsPath.endsWith(c.typeExpectedFile),
      `Expected ${c.typeExpectedFile}, got ${path.basename(def!.uri.fsPath)}`);

    console.log(`  ${c.parentType} inheritance → line ${def!.range.start.line + 1}`);
  });
});
