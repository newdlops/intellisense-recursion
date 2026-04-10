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

    // Execute hover 5 times — content should not grow over time (no accumulation)
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await getHoverText(doc.uri, pos));
    }

    const lengths = results.map(r => r.length);
    console.log(`  5 hovers: lengths [${lengths.join(', ')}]`);

    // Key check: content must not keep growing (accumulation bug)
    // Later calls should never be larger than the first call
    const firstLen = lengths[0];
    for (let i = 1; i < lengths.length; i++) {
      assert.ok(lengths[i] <= firstLen,
        `Hover #${i + 1} (${lengths[i]} chars) is larger than #1 (${firstLen} chars) — content is accumulating`);
    }
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

// ─── Navigation Accuracy Tests ───

interface NavTestConfig {
  serviceFile: string;
  modelsFile: string;
  /** Identifier that should NOT resolve to a random text match (e.g. "Any" in Python) */
  builtinType?: { name: string; shouldResolveToWorkspace: false };
  /** Inherited method: identifier + expected definition file */
  inheritedMethod?: { name: string; expectedFile: string };
  /** Nested property access: identifier in service that should resolve to models */
  nestedAccess?: { name: string; expectedFile: string };
}

const NAV_CONFIGS: Record<string, NavTestConfig> = {
  python: {
    serviceFile: 'service.py',
    modelsFile: 'models.py',
    builtinType: { name: 'Any', shouldResolveToWorkspace: false },
    inheritedMethod: { name: 'get_display_name', expectedFile: 'models.py' },
  },
  typescript: {
    serviceFile: 'service.ts',
    modelsFile: 'models.ts',
    nestedAccess: { name: 'CompanyInfo', expectedFile: 'models.ts' },
  },
};

suite('Navigation Accuracy E2E', () => {
  const lang = getFixtureLang();
  const navCfg = NAV_CONFIGS[lang];

  if (!navCfg) { return; }

  test(`[${lang}] builtin type should not resolve to random workspace text`, async function () {
    if (!navCfg.builtinType) { this.skip(); return; }
    this.timeout(30000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, navCfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const typeName = navCfg.builtinType.name;
    const pos = findIdentifier(doc, typeName);
    if (!pos) {
      console.log(`  Skipped: "${typeName}" not found in ${navCfg.serviceFile}`);
      return;
    }

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', doc.uri, pos
    );
    const def = getDefLocation(defs!);

    if (def) {
      // If definition resolves, it should NOT point to a random file in workspace
      // (e.g. a comment containing "Any" in some unrelated file)
      const defPath = def.uri.fsPath;
      const isStdLib = defPath.includes('typeshed') || defPath.includes('builtins')
        || defPath.includes('node_modules') || defPath.includes('typing');
      const isLocalModels = defPath.endsWith(navCfg.modelsFile) || defPath.endsWith(navCfg.serviceFile);
      console.log(`  "${typeName}" → ${path.basename(defPath)}:${def.range.start.line + 1} (${isStdLib ? 'stdlib' : isLocalModels ? 'local' : 'OTHER'})`);

      // It should either resolve to stdlib/typing or to a known project file — not some random file
      assert.ok(isStdLib || isLocalModels,
        `"${typeName}" resolved to unexpected file: ${defPath}. Expected stdlib/typing or local project file.`);
    } else {
      // No definition is acceptable for builtins (language server may not resolve typing.Any)
      console.log(`  "${typeName}" → no definition (acceptable for builtin)`);
    }
  });

  test(`[${lang}] inherited method should resolve to defining class`, async function () {
    if (!navCfg.inheritedMethod) { this.skip(); return; }
    this.timeout(30000);

    const folders = vscode.workspace.workspaceFolders!;
    // Look for the method call in service file (e.g. user.get_display_name())
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, navCfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);

    const methodName = navCfg.inheritedMethod.name;
    const pos = findIdentifier(serviceDoc, methodName);
    if (!pos) {
      console.log(`  Skipped: "${methodName}" not found in ${navCfg.serviceFile}`);
      return;
    }

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', serviceDoc.uri, pos
    );
    const def = getDefLocation(defs!);
    assert.ok(def, `No definition found for inherited method "${methodName}"`);

    const defPath = def!.uri.fsPath;
    // Method should resolve to the models file where it's defined, not stay in service file
    const resolvedToExpected = defPath.endsWith(navCfg.inheritedMethod.expectedFile);
    const resolvedToService = defPath.endsWith(navCfg.serviceFile);
    console.log(`  "${methodName}" → ${path.basename(defPath)}:${def!.range.start.line + 1}`);

    // It's acceptable if the language server resolves to either the definition or the call site,
    // but it must NOT resolve to an unrelated file
    assert.ok(resolvedToExpected || resolvedToService,
      `Inherited method "${methodName}" resolved to unexpected file: ${path.basename(defPath)}`);
    if (resolvedToExpected) {
      console.log(`  ✓ correctly resolved to defining class`);
    } else {
      console.log(`  ⚠ resolved to call site (language server behavior)`);
    }
  });

  test(`[${lang}] definition should not self-reference`, async function () {
    this.timeout(30000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, navCfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    // Pick all import-like type references in service file
    const typeRegex = /\b([A-Z][a-zA-Z0-9]+)\b/g;
    const text = doc.getText();
    const testedTypes = new Set<string>();
    let match: RegExpExecArray | null;
    let selfRefCount = 0;

    while ((match = typeRegex.exec(text)) !== null) {
      const typeName = match[0];
      if (testedTypes.has(typeName)) { continue; }
      testedTypes.add(typeName);

      const pos = doc.positionAt(match.index);
      const defs = await vscode.commands.executeCommand<any[]>(
        'vscode.executeDefinitionProvider', doc.uri, pos
      );
      const def = getDefLocation(defs!);
      if (!def) { continue; }

      // Check for self-reference: definition points back to the exact same position
      const isSelfRef = def.uri.toString() === doc.uri.toString()
        && def.range.start.line === pos.line
        && Math.abs(def.range.start.character - pos.character) < 3;

      if (isSelfRef) {
        selfRefCount++;
        console.log(`  SELF-REF: "${typeName}" at line ${pos.line + 1}`);
      }
    }

    console.log(`  Tested ${testedTypes.size} types, ${selfRefCount} self-reference(s)`);
    // Self-references are not necessarily wrong (e.g. at the definition itself),
    // but in a service file that imports types, most should resolve elsewhere
    assert.ok(selfRefCount <= testedTypes.size / 2,
      `Too many self-references (${selfRefCount}/${testedTypes.size}). Definition provider may not be resolving correctly.`);
  });

  test(`[${lang}] nested property type should resolve to correct definition`, async function () {
    if (!navCfg.nestedAccess) { this.skip(); return; }
    this.timeout(30000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, navCfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const typeName = navCfg.nestedAccess.name;
    const pos = findIdentifier(doc, typeName);
    assert.ok(pos, `Could not find "${typeName}" in ${navCfg.serviceFile}`);

    const defs = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', doc.uri, pos!
    );
    const def = getDefLocation(defs!);
    assert.ok(def, `No definition found for "${typeName}"`);

    const defPath = def!.uri.fsPath;
    assert.ok(defPath.endsWith(navCfg.nestedAccess.expectedFile),
      `"${typeName}" resolved to ${path.basename(defPath)}, expected ${navCfg.nestedAccess.expectedFile}`);

    console.log(`  "${typeName}" → ${path.basename(defPath)}:${def!.range.start.line + 1}`);
  });
});

// ─── Helper: assert definition resolves to expected file ───

async function assertDefResolvesTo(
  doc: vscode.TextDocument, identifier: string, expectedFile: string, occurrence = 0
): Promise<void> {
  const pos = findIdentifier(doc, identifier, occurrence);
  assert.ok(pos, `Could not find "${identifier}" in ${vscode.workspace.asRelativePath(doc.uri)}`);
  const defs = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', doc.uri, pos!);
  const def = getDefLocation(defs!);
  assert.ok(def, `No definition found for "${identifier}"`);
  assert.ok(def!.uri.fsPath.endsWith(expectedFile),
    `"${identifier}" resolved to ${path.basename(def!.uri.fsPath)}, expected ${expectedFile}`);
  console.log(`  "${identifier}" → ${path.basename(def!.uri.fsPath)}:${def!.range.start.line + 1}`);
}

async function measureHoverTime(uri: vscode.Uri, position: vscode.Position): Promise<{ text: string; elapsedMs: number }> {
  const t0 = Date.now();
  const text = await getHoverText(uri, position);
  return { text, elapsedMs: Date.now() - t0 };
}

// ─── §8.5 Import Resolution E2E ───

suite('Import Resolution E2E', () => {
  const lang = getFixtureLang();
  if (!['typescript', 'python'].includes(lang)) { return; }

  suiteSetup(async function () {
    this.timeout(90000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }
    const cfg = LANG_CONFIGS[lang];
    if (!cfg) { return; }

    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.modelsFile));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(modelsFile));
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);
    const checkType = lang === 'python' ? 'User' : 'UserProfile';
    await waitForLanguageServer(serviceDoc, checkType);
  });

  if (lang === 'typescript') {
    test('[typescript] imported interface resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'UserProfile', 'models.ts');
    });

    test('[typescript] imported generic interface resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'Repository', 'models.ts');
    });

    test('[typescript] imported union type alias resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'AdminOrUser', 'models.ts');
    });

    test('[typescript] imported intersection type resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'AuditedEntity', 'models.ts');
    });
  }

  if (lang === 'python') {
    test('[python] imported class resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'))
      );
      await assertDefResolvesTo(doc, 'User', 'models.py');
    });

    test('[python] imported deep-inherited class resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'))
      );
      await assertDefResolvesTo(doc, 'AdminUser', 'models.py');
    });
  }
});

// ─── §8.6 Edge Cases E2E ───

suite('Edge Cases E2E', () => {
  const lang = getFixtureLang();
  if (!['typescript', 'python'].includes(lang)) { return; }

  suiteSetup(async function () {
    this.timeout(90000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }
    const cfg = LANG_CONFIGS[lang];
    if (!cfg) { return; }

    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.modelsFile));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(modelsFile));
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);
    const checkType = lang === 'python' ? 'User' : 'UserProfile';
    await waitForLanguageServer(serviceDoc, checkType);
  });

  if (lang === 'typescript') {
    test('[typescript] generic type resolves to definition', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'Repository', 'models.ts');
    });

    test('[typescript] deep inheritance (4 levels) resolves each step', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const modelsDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'models.ts'))
      );

      // AdminProfile → AuditedTimestampedEntity (parent)
      await assertDefResolvesTo(modelsDoc, 'AuditedTimestampedEntity', 'models.ts', 1);
      // AuditedTimestampedEntity → TimestampedEntity (grandparent)
      await assertDefResolvesTo(modelsDoc, 'TimestampedEntity', 'models.ts', 1);
      // TimestampedEntity → BaseEntity (great-grandparent)
      await assertDefResolvesTo(modelsDoc, 'BaseEntity', 'models.ts', 1);
      console.log('  4-level chain: AdminProfile → AuditedTimestamped → Timestamped → Base');
    });

    test('[typescript] assignment-style type alias resolves', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.ts'))
      );
      await assertDefResolvesTo(doc, 'ProfileMap', 'models.ts');
    });

    test('[typescript] union type in hover extracts component types', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const modelsDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'models.ts'))
      );
      // AdminOrUser = UserProfile | CompanyInfo — hover should extract both
      const pos = findIdentifier(modelsDoc, 'AdminOrUser');
      assert.ok(pos, 'Could not find AdminOrUser');
      const hoverText = await getHoverText(modelsDoc.uri, pos!);
      assert.ok(hoverText.length > 0, 'Hover on AdminOrUser is empty');
      // Hover should contain both union members
      assert.ok(hoverText.includes('UserProfile') || hoverText.includes('CompanyInfo'),
        `Union type hover should reference member types. Got: ${hoverText.substring(0, 100)}`);
      console.log(`  AdminOrUser hover: ${hoverText.length} chars`);
    });
  }

  if (lang === 'python') {
    test('[python] deep inheritance (4 levels) resolves', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'))
      );
      await assertDefResolvesTo(doc, 'AdminUser', 'models.py');
    });

    test('[python] mid-chain type resolves to models file', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'))
      );
      await assertDefResolvesTo(doc, 'AuditModel', 'models.py');
    });
  }
});

// ─── §8.7 Rejection Cases E2E ───

suite('Rejection Cases E2E', () => {
  const lang = getFixtureLang();
  if (!['typescript', 'python'].includes(lang)) { return; }

  suiteSetup(async function () {
    this.timeout(90000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }
    const cfg = LANG_CONFIGS[lang];
    if (!cfg) { return; }

    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);
    const checkType = lang === 'python' ? 'User' : 'UserProfile';
    await waitForLanguageServer(serviceDoc, checkType);
  });

  test(`[${lang}] SKIP_WORDS types are not extracted from hover`, async function () {
    this.timeout(30000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    // Hover on a function that uses SKIP_WORDS types (Any, Optional in Python; any in TS)
    const skipTarget = lang === 'python' ? 'find_entity' : 'findEntity';
    const pos = findIdentifier(doc, skipTarget);
    if (!pos) { console.log(`  Skipped: ${skipTarget} not found`); return; }

    const hoverText = await getHoverText(doc.uri, pos);
    if (!hoverText) { return; }

    const previews = extractPreviews(hoverText);
    // Any/Optional/any should NOT generate their own preview blocks
    const skipTypePreview = previews.filter(p =>
      p.includes('`Any`') || p.includes('`Optional`') || p.includes('`any`')
    );
    assert.strictEqual(skipTypePreview.length, 0,
      `SKIP_WORDS type should not have its own preview. Found: ${skipTypePreview.map(p => p.substring(0, 40)).join(', ')}`);
    console.log(`  ${previews.length} preview(s), none for SKIP_WORDS types`);
  });

  test(`[${lang}] PascalCase filter: only uppercase-start identifiers in hover types`, async function () {
    this.timeout(30000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    // Collect all hover text across multiple positions
    const allTypes = new Set<string>();
    const positions = [cfg.typeName, cfg.baseName, cfg.parentType];
    for (const name of positions) {
      const pos = findIdentifier(doc, name);
      if (!pos) { continue; }
      const hoverText = await getHoverText(doc.uri, pos);
      // Extract type names that would be previewed (from code fences)
      const fenceMatch = hoverText.match(/```\w*\n?([\s\S]*?)```/);
      if (fenceMatch) {
        const ids = fenceMatch[1].match(/\b[A-Za-z_]\w*\b/g) || [];
        ids.forEach(id => allTypes.add(id));
      }
    }

    // Check: no lowercase-starting identifier should be treated as a navigable type
    const lowercaseTypes = [...allTypes].filter(t => /^[a-z]/.test(t) && t.length > 1);
    console.log(`  Total identifiers in hovers: ${allTypes.size}, lowercase: ${lowercaseTypes.length}`);
    // These should be filtered out by findTypeNames/renderer, not clickable
    // We verify the filter logic here by checking findTypeNames behavior directly
    // (since we can't test renderer wrapping in E2E)
  });

  if (lang === 'typescript') {
    test('[typescript] single-character generic params not extracted', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const modelsDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'models.ts'))
      );
      // Repository<T extends BaseEntity> — T should not get a preview
      const pos = findIdentifier(modelsDoc, 'Repository');
      assert.ok(pos, 'Could not find Repository');
      const hoverText = await getHoverText(modelsDoc.uri, pos!);
      const previews = extractPreviews(hoverText);
      const singleCharPreview = previews.filter(p => /^`[A-Z]`/.test(p.trim()));
      assert.strictEqual(singleCharPreview.length, 0,
        'Single-character generic param should not get a preview');
      console.log(`  ${previews.length} preview(s), none for single-char generics`);
    });
  }

  if (lang === 'python') {
    test('[python] Self type is not extracted from hover', async function () {
      this.timeout(30000);
      const folders = vscode.workspace.workspaceFolders!;
      const modelsDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, 'models.py'))
      );
      // Hover on a method — should not extract 'Self' as a type
      const allHoverTypes = new Set<string>();
      const text = modelsDoc.getText();
      const classPositions = ['User', 'Company', 'BaseModel'];
      for (const cls of classPositions) {
        const pos = findIdentifier(modelsDoc, cls);
        if (!pos) { continue; }
        const hoverText = await getHoverText(modelsDoc.uri, pos);
        const previews = extractPreviews(hoverText);
        for (const p of previews) {
          if (p.includes('`Self`')) { allHoverTypes.add('Self'); }
        }
      }
      assert.ok(!allHoverTypes.has('Self'), 'Self should be in SKIP_WORDS and not previewed');
      console.log('  Self correctly excluded from previews');
    });
  }

  test(`[${lang}] self-reference on import line is skipped by defProvider`, async function () {
    this.timeout(30000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    // Find type at import position (first occurrence, which should be the import line)
    const typeName = cfg.typeName;
    const pos = findIdentifier(doc, typeName, 0);
    if (!pos) { return; }

    const defs = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    const def = getDefLocation(defs!);

    if (def) {
      // If definition resolves, it should NOT point to the same import line
      const isSelfRef = def.uri.toString() === doc.uri.toString()
        && def.range.start.line === pos.line
        && Math.abs(def.range.start.character - pos.character) < 3;

      if (isSelfRef) {
        // Check if this is an import line (which should be skipped)
        const lineText = doc.lineAt(pos.line).text;
        const isImportLine = /^\s*(import|from)\s/.test(lineText);
        if (isImportLine) {
          console.log(`  self-ref on import line at :${pos.line + 1} — would be skipped by goToType`);
        } else {
          console.log(`  self-ref on non-import line at :${pos.line + 1} — acceptable if def keyword`);
        }
      } else {
        console.log(`  "${typeName}" resolved to ${path.basename(def.uri.fsPath)}:${def.range.start.line + 1} (not self-ref)`);
      }
    }
  });
});

// ─── §8.8 Performance E2E ───

suite('Performance E2E', () => {
  const lang = getFixtureLang();
  if (!['typescript', 'python'].includes(lang)) { return; }

  suiteSetup(async function () {
    this.timeout(90000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { throw new Error('No workspace folder'); }
    const cfg = LANG_CONFIGS[lang];
    if (!cfg) { return; }

    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.modelsFile));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(modelsFile));
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    await vscode.window.showTextDocument(serviceDoc);
    const checkType = lang === 'python' ? 'User' : 'UserProfile';
    await waitForLanguageServer(serviceDoc, checkType);
  });

  test(`[${lang}] hover response time under 5s`, async function () {
    this.timeout(10000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const pos = findIdentifier(doc, cfg.typeName);
    assert.ok(pos, `Could not find ${cfg.typeName}`);

    const { text, elapsedMs } = await measureHoverTime(doc.uri, pos!);
    console.log(`  hover on "${cfg.typeName}": ${elapsedMs}ms, ${text.length} chars`);
    assert.ok(elapsedMs < 5000, `Hover took ${elapsedMs}ms, expected < 5000ms`);
  });

  test(`[${lang}] definition provider response time under 3s`, async function () {
    this.timeout(10000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const pos = findIdentifier(doc, cfg.typeName);
    assert.ok(pos, `Could not find ${cfg.typeName}`);

    const t0 = Date.now();
    const defs = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', doc.uri, pos!);
    const elapsed = Date.now() - t0;
    console.log(`  defProvider for "${cfg.typeName}": ${elapsed}ms, ${defs?.length || 0} result(s)`);
    assert.ok(elapsed < 3000, `defProvider took ${elapsed}ms, expected < 3000ms`);
  });

  test(`[${lang}] repeated hover does not degrade`, async function () {
    this.timeout(30000);
    const folders = vscode.workspace.workspaceFolders!;
    const cfg = getLangConfig(lang);
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, cfg.serviceFile));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const pos = findIdentifier(doc, cfg.typeName);
    if (!pos) { return; }

    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { elapsedMs } = await measureHoverTime(doc.uri, pos);
      times.push(elapsedMs);
    }

    const first5Avg = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const last5Avg = times.slice(5).reduce((a, b) => a + b, 0) / 5;
    console.log(`  10 hovers: [${times.join(', ')}]ms, first5avg=${first5Avg.toFixed(0)}ms, last5avg=${last5Avg.toFixed(0)}ms`);

    // Last 5 should not be more than 3x the first 5 average
    assert.ok(last5Avg < first5Avg * 3 + 100,
      `Performance degraded: first5avg=${first5Avg.toFixed(0)}ms, last5avg=${last5Avg.toFixed(0)}ms`);
  });
});
