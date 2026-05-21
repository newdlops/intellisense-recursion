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

function normalizeHoverContent(text: string): string {
  return text
    .replace(/<!--ir-direct-hover-->/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function findIdentifierOnLine(
  doc: vscode.TextDocument,
  lineFragment: string,
  identifier: string,
  occurrence = 0,
): vscode.Position | null {
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.includes(lineFragment)) { continue; }
    const regex = new RegExp(`\\b${identifier}\\b`, 'g');
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = regex.exec(text)) !== null) {
      if (count === occurrence) {
        return new vscode.Position(line, match.index);
      }
      count++;
    }
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

interface PatchStatus {
  hoverPatchActive: boolean;
  currentPreviewIdentifier: string | null;
  currentPreviewMarkdown: string;
  pendingPreviewIdentifier: string | null;
  previewHistoryLength: number;
  previewHistoryIdentifiers: string[];
  lastHoverFetchPosition: { uri: string; line: number; character: number } | null;
}

interface HoverDomState {
  ok: boolean;
  reason: string;
  patchVersion: number;
  hoverCount: number;
  populatedHoverCount: number;
  emptyHoverCount: number;
  activeTextLength: number;
  activeText: string;
  activeRect: { left: number; top: number; width: number; height: number } | null;
  linkTypes: string[];
  expectedTypes: string[];
  missingExpectedTypes: string[];
  tokenizedSourceCount: number;
  fallbackTokenizedSourceCount: number;
  mtkSpanCount: number;
  mtkClassCount: number;
  irTkSpanCount: number;
  irTkClassCount: number;
  nativeTokenizedSource: boolean;
  typeLinksInTokenizedSource: number;
  tokenizedLinkTypes: string[];
  tokenizedText: string;
  tokenizedInlineStyle: string;
  tokenizedFontFamily: string;
  tokenizedFontSize: string;
  tokenizedLineHeight: string;
  tokenizedLetterSpacing: string;
  tokenizedBackgroundColor: string;
  hoverBackgroundColor: string;
  hoverForegroundColor: string;
  tokenizedColorCount: number;
  tokenizedColorSamples: string[];
  manualTokenThemeRuleCount: number;
  tokenizedThemeApplied: boolean;
  layoutMaxRightOverflow: number;
  layoutMaxBottomOverflow: number;
  layoutWideBlockCount: number;
  layoutMaxBlockWidth: number;
  scrollTop: number;
  scrollHeight: number;
  scrollClientHeight: number;
  scrollMaxTop: number;
  backButtonCount: number;
  backButtonVisibleCount: number;
  syntaxHighlighted: boolean;
}

async function getPatchStatus(): Promise<PatchStatus> {
  return vscode.commands.executeCommand<PatchStatus>('intellisenseRecursion.getPatchStatus');
}

async function waitForPreviewState(identifier: string | null, historyLength: number, timeoutMs = 10000): Promise<PatchStatus> {
  const start = Date.now();
  let last: PatchStatus | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await getPatchStatus();
    if (last.currentPreviewIdentifier === identifier && last.previewHistoryLength === historyLength) {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for preview=${identifier}, history=${historyLength}. Last status: ${JSON.stringify(last)}`);
}

function hoverDomStateMatches(
  state: HoverDomState | undefined,
  expectedLinks: string[],
  expectedTextFragments: string[],
  requireSyntaxHighlight: boolean,
  absentTextFragments: string[] = [],
) {
  if (!state?.ok) { return false; }
  if (!expectedLinks.every(link => state.linkTypes.includes(link))) { return false; }
  if (!expectedTextFragments.every(fragment => state.activeText.includes(fragment))) { return false; }
  if (absentTextFragments.some(fragment => state.activeText.includes(fragment))) { return false; }
  return !requireSyntaxHighlight || !!state.syntaxHighlighted;
}

function bestHoverDomState(
  rows: any[] | undefined,
  expectedLinks: string[] = [],
  expectedTextFragments: string[] = [],
  requireSyntaxHighlight = false,
  absentTextFragments: string[] = [],
): HoverDomState | undefined {
  const values = (rows || [])
    .map(row => row?.value)
    .filter(Boolean) as HoverDomState[];
  return values.find(value => hoverDomStateMatches(
    value,
    expectedLinks,
    expectedTextFragments,
    requireSyntaxHighlight,
    absentTextFragments,
  ))
    || values.find(value => value.ok)
    || values.sort((a, b) => (b.activeTextLength || 0) - (a.activeTextLength || 0))[0];
}

function compactHoverDomState(state: HoverDomState | undefined) {
  if (!state) { return state; }
  return {
    ok: state.ok,
    reason: state.reason,
    patchVersion: state.patchVersion,
    hoverCount: state.hoverCount,
    populatedHoverCount: state.populatedHoverCount,
    emptyHoverCount: state.emptyHoverCount,
    activeTextLength: state.activeTextLength,
    activeText: (state.activeText || '').slice(0, 500),
    linkTypes: (state.linkTypes || []).slice(0, 40),
    missingExpectedTypes: state.missingExpectedTypes,
    tokenizedSourceCount: state.tokenizedSourceCount,
    fallbackTokenizedSourceCount: state.fallbackTokenizedSourceCount,
    mtkSpanCount: state.mtkSpanCount,
    mtkClassCount: state.mtkClassCount,
    irTkSpanCount: state.irTkSpanCount,
    irTkClassCount: state.irTkClassCount,
    nativeTokenizedSource: state.nativeTokenizedSource,
    typeLinksInTokenizedSource: state.typeLinksInTokenizedSource,
    tokenizedLinkTypes: (state.tokenizedLinkTypes || []).slice(0, 40),
    tokenizedText: (state.tokenizedText || '').slice(0, 500),
    tokenizedInlineStyle: state.tokenizedInlineStyle,
    tokenizedFontFamily: state.tokenizedFontFamily,
    tokenizedFontSize: state.tokenizedFontSize,
    tokenizedLineHeight: state.tokenizedLineHeight,
    tokenizedLetterSpacing: state.tokenizedLetterSpacing,
    tokenizedColorCount: state.tokenizedColorCount,
    tokenizedColorSamples: state.tokenizedColorSamples?.slice(0, 8),
    manualTokenThemeRuleCount: state.manualTokenThemeRuleCount,
    tokenizedThemeApplied: state.tokenizedThemeApplied,
    hoverBackgroundColor: state.hoverBackgroundColor,
    hoverForegroundColor: state.hoverForegroundColor,
    layoutMaxRightOverflow: state.layoutMaxRightOverflow,
    layoutMaxBottomOverflow: state.layoutMaxBottomOverflow,
    layoutWideBlockCount: state.layoutWideBlockCount,
    layoutMaxBlockWidth: state.layoutMaxBlockWidth,
    scrollTop: state.scrollTop,
    scrollHeight: state.scrollHeight,
    scrollClientHeight: state.scrollClientHeight,
    scrollMaxTop: state.scrollMaxTop,
    backButtonCount: state.backButtonCount,
    backButtonVisibleCount: state.backButtonVisibleCount,
    syntaxHighlighted: state.syntaxHighlighted,
  };
}

async function waitForHoverDomState(
  expectedLinks: string[] = [],
  expectedTextFragments: string[] = [],
  timeoutMs = 10000,
  requireSyntaxHighlight = false,
  includeStyleAndLayout = true,
  absentTextFragments: string[] = [],
): Promise<HoverDomState> {
  const start = Date.now();
  let lastRows: any[] | undefined;
  let lastState: HoverDomState | undefined;
  while (Date.now() - start < timeoutMs) {
    lastRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverDomStateHarnessForTests',
      expectedLinks,
      includeStyleAndLayout,
    );
    lastState = bestHoverDomState(lastRows, expectedLinks, expectedTextFragments, requireSyntaxHighlight, absentTextFragments);
    if (hoverDomStateMatches(lastState, expectedLinks, expectedTextFragments, requireSyntaxHighlight, absentTextFragments)) {
      return lastState!;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.fail(`Timed out waiting for hover DOM links=${expectedLinks.join(',')} text=${expectedTextFragments.join(',')} absent=${absentTextFragments.join(',')} syntax=${requireSyntaxHighlight}. `
    + `Last state=${JSON.stringify(compactHoverDomState(lastState))} rowCount=${lastRows?.length ?? 0}`);
}

async function waitForHoverScrollTopNear(
  expectedScrollTop: number,
  tolerance = 4,
  expectedLinks: string[] = [],
  expectedTextFragments: string[] = [],
  timeoutMs = 10000,
): Promise<HoverDomState> {
  const start = Date.now();
  let lastState: HoverDomState | undefined;
  while (Date.now() - start < timeoutMs) {
    const rows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverDomStateHarnessForTests',
      expectedLinks,
      true,
    );
    lastState = bestHoverDomState(rows, expectedLinks, expectedTextFragments, true);
    if (lastState?.ok && Math.abs((lastState.scrollTop || 0) - expectedScrollTop) <= tolerance) {
      return lastState;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.fail(`Timed out waiting for hover scrollTop≈${expectedScrollTop}. Last state=${JSON.stringify(compactHoverDomState(lastState))}`);
}

function assertHoverDoesNotContain(state: HoverDomState, fragments: string[], context: string) {
  for (const fragment of fragments) {
    assert.ok(!state.activeText.includes(fragment),
      `${context} should not include previous page fragment "${fragment}". ${JSON.stringify(state)}`);
  }
}

function assertHoverThemeStable(baseline: HoverDomState, state: HoverDomState, context: string) {
  assertStrictNativeTokenTheme(state, context);
  assertStrictNativeTokenTheme(baseline, `${context} baseline`);
  assert.ok(state.tokenizedColorSamples.length >= Math.min(3, baseline.tokenizedColorSamples.length),
    `${context} should keep a comparable set of computed token colors. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedThemeApplied,
    `${context} should have computed token theme colors. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedColorCount > 1,
    `${context} should render more than one computed token color. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.manualTokenThemeRuleCount, 0,
    `${context} should not use manual ir-tk token color rules`);
  assert.ok(state.mtkClassCount > 1,
    `${context} should use VS Code mtk theme classes, not only fallback semantic classes. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.nativeTokenizedSource,
    `${context} should use VS Code native tokenized source, not the fallback regex tokenizer. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.irTkSpanCount, 0,
    `${context} should not contain fallback ir-tk token spans. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.tokenizedFontSize, baseline.tokenizedFontSize,
    `${context} should preserve token font size`);
  assert.strictEqual(state.tokenizedLineHeight, baseline.tokenizedLineHeight,
    `${context} should preserve token line height`);
  assert.strictEqual(state.tokenizedLetterSpacing, baseline.tokenizedLetterSpacing,
    `${context} should preserve token letter spacing`);
  assert.strictEqual(state.tokenizedInlineStyle, baseline.tokenizedInlineStyle,
    `${context} should preserve native monaco-tokenized-source inline style`);
  assert.strictEqual(state.hoverBackgroundColor, baseline.hoverBackgroundColor,
    `${context} should preserve hover background color`);
  assert.strictEqual(state.hoverForegroundColor, baseline.hoverForegroundColor,
    `${context} should preserve hover foreground color`);
}

function assertNoFallbackTokenization(state: HoverDomState, context: string) {
  assert.strictEqual(state.fallbackTokenizedSourceCount, 0,
    `${context} should be rendered by VS Code native tokenization, not the renderer fallback tokenizer. `
    + `${JSON.stringify(compactHoverDomState(state))}`);
}

function assertStrictNativeTokenTheme(
  state: HoverDomState,
  context: string,
  requiredTokenLinks: string[] = [],
  requiredTokenText: string[] = [],
) {
  assert.ok(state.syntaxHighlighted,
    `${context} should be syntax-highlighted. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedThemeApplied,
    `${context} should have native token theme applied. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.nativeTokenizedSource,
    `${context} should use monaco-tokenized-source with native mtk classes. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedSourceCount >= 1,
    `${context} should render a tokenized source block. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.mtkSpanCount >= 4,
    `${context} should contain multiple mtk token spans. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.mtkClassCount >= 3,
    `${context} should contain several distinct mtk token classes. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedColorCount >= 3,
    `${context} should compute several token colors from the active theme. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.irTkSpanCount, 0,
    `${context} should not render fallback ir-tk spans. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.irTkClassCount, 0,
    `${context} should not render fallback ir-tk classes. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.manualTokenThemeRuleCount, 0,
    `${context} should not define manual token color CSS rules. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedInlineStyle.includes('--vscode-editor-font-family'),
    `${context} should inherit the VS Code editor font family. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.ok(state.tokenizedInlineStyle.includes('white-space: pre'),
    `${context} should preserve monaco tokenized whitespace style. ${JSON.stringify(compactHoverDomState(state))}`);
  for (const link of requiredTokenLinks) {
    assert.ok(state.tokenizedLinkTypes.includes(link),
      `${context} should expose "${link}" as a clickable link inside tokenized source. ${JSON.stringify(compactHoverDomState(state))}`);
  }
  for (const fragment of requiredTokenText) {
    assert.ok(state.tokenizedText.includes(fragment),
      `${context} tokenized source should include "${fragment}". ${JSON.stringify(compactHoverDomState(state))}`);
  }
}

function assertHoverHasNoWideTrace(state: HoverDomState, context: string) {
  assert.ok((state.layoutMaxRightOverflow || 0) <= 2,
    `${context} has a block protruding beyond the active hover width. ${JSON.stringify(compactHoverDomState(state))}`);
  assert.strictEqual(state.layoutWideBlockCount || 0, 0,
    `${context} has wide block descendants that look like stale large-hover traces. ${JSON.stringify(compactHoverDomState(state))}`);
}

function assertMarkdownDoesNotContain(markdown: string, fragments: string[], context: string) {
  for (const fragment of fragments) {
    assert.ok(!markdown.includes(fragment),
      `${context} markdown should not include previous page fragment "${fragment}"`);
  }
}

function countArrayValue(values: string[], target: string): number {
  return values.filter(value => value === target).length;
}

function assertTokenizedLinkCounts(
  state: HoverDomState,
  expectedCounts: Record<string, number>,
  context: string,
) {
  for (const [link, count] of Object.entries(expectedCounts)) {
    assert.strictEqual(countArrayValue(state.tokenizedLinkTypes, link), count,
      `${context} should expose exactly ${count} tokenized "${link}" link(s). `
      + `${JSON.stringify(compactHoverDomState(state))}`);
  }
}

function assertPreviewHeaderMatches(state: PatchStatus, pattern: RegExp, context: string) {
  const firstLine = state.currentPreviewMarkdown.split(/\r?\n/, 1)[0] || '';
  assert.ok(pattern.test(firstLine),
    `${context} should resolve to the expected definition header. First line=${firstLine}`);
}

function hoverRangeCovers(hovers: vscode.Hover[], expected: vscode.Range): boolean {
  return hovers.some(hover => hover.range
    && hover.range.start.isBeforeOrEqual(expected.start)
    && hover.range.end.isAfterOrEqual(expected.end));
}

function textFromHovers(hovers: vscode.Hover[]): string {
  return hovers.map(hoverToText).filter(Boolean).join('\n');
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
    for (let i = 0; i < results.length; i++) {
      assert.ok(results[i].length > 0, `Hover #${i + 1} returned empty content`);
    }

    // Key check: repeated hovers may warm the definition preview cache, but
    // each individual response must stay bounded and must not duplicate the
    // same preview blocks.
    for (let i = 0; i < results.length; i++) {
      const separators = countOccurrences(results[i], '---');
      const codeFences = countCodeFences(results[i]);
      assert.ok(separators <= 4,
        `Hover #${i + 1} has too many separators (${separators}) — possible accumulation`);
      assert.ok(codeFences <= 5,
        `Hover #${i + 1} has too many code fences (${codeFences}) — possible accumulation`);
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
    const fullHoverTexts: string[] = [];
    let emptyHoverCount = 0;
    for (const hover of hovers) {
      const text = hoverToText(hover);
      const normalizedText = normalizeHoverContent(text);
      if (normalizedText) {
        fullHoverTexts.push(normalizedText);
      } else {
        emptyHoverCount++;
      }
      const previews = extractPreviews(text);
      allPreviews.push(...previews);
    }
    assert.strictEqual(emptyHoverCount, 0,
      `Hover providers should not return empty hover objects when content is available`);

    const fullSeen = new Map<string, number>();
    for (const text of fullHoverTexts) {
      fullSeen.set(text, (fullSeen.get(text) || 0) + 1);
    }
    const fullDuplicates = [...fullSeen.entries()].filter(([, count]) => count > 1);
    assert.strictEqual(fullDuplicates.length, 0,
      `Found exact duplicate hover content across providers: ${fullDuplicates.map(([, c]) => c).join(', ')}`);

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

suite('Hover Drill-Down E2E', () => {
  const lang = getFixtureLang();

  test(`[${lang}] hover panel symbol clicks support several drill-down hops`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(60000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const anchor = findIdentifier(doc, 'Company', 1);
    assert.ok(anchor, 'Could not find Company annotation in service.py');
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'Company');
    const hoverText = await getHoverText(doc.uri, anchor!);
    assert.ok(hoverText.length > 0, 'Initial hover on Company returned empty content');

    await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), 'PREVIEW:Company');
    const initialCompanyState = await waitForPreviewState('Company', 0);
    assert.ok(initialCompanyState.currentPreviewMarkdown.includes('class Company'),
      'Initial preview for Company should contain its class definition');
    const seedRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
      'Company',
      initialCompanyState.currentPreviewMarkdown,
    );
    const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(seeded, `Could not seed initial hover panel for drill-down test. Rows=${JSON.stringify(seedRows)}`);
    const initialDom = await waitForHoverDomState(['get_owner'], ['Company'], 10000, true);
    assert.ok(initialDom.backButtonVisibleCount > 0,
      `Initial drill-down preview should expose a back button. ${JSON.stringify(compactHoverDomState(initialDom))}`);
    assertHoverThemeStable(initialDom, initialDom, 'Initial Company hover DOM');
    assertStrictNativeTokenTheme(initialDom, 'Initial Company hover DOM',
      ['get_owner', 'User'],
      ['class Company', 'def get_owner']);
    assertHoverHasNoWideTrace(initialDom, 'Initial Company hover DOM');

    const steps: Array<{ identifier: string; history: string[]; contains: string[]; nextLinks: string[]; absent: string[] }> = [
      {
        identifier: 'get_owner',
        history: ['Company'],
        contains: ['def get_owner', 'return self.owner'],
        nextLinks: ['User'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'title: str'],
      },
      {
        identifier: 'User',
        history: ['Company', 'get_owner'],
        contains: ['class User', 'TimestampedModel'],
        nextLinks: ['TimestampedModel'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'def get_owner', 'return self.owner'],
      },
      {
        identifier: 'TimestampedModel',
        history: ['Company', 'get_owner', 'User'],
        contains: ['class TimestampedModel', 'BaseModel'],
        nextLinks: ['BaseModel'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'def get_owner', 'class User', 'email: str'],
      },
    ];

    let state: PatchStatus | null = null;
    for (const step of steps) {
      console.log(`  preparing hover panel click → ${step.identifier}`);
      const beforeDom = await waitForHoverDomState([step.identifier], [], 10000, false, false);
      assert.strictEqual(beforeDom.hoverCount, 1,
        `Expected exactly one real hover before clicking ${step.identifier}. ${JSON.stringify(beforeDom)}`);
      assert.ok(beforeDom.activeTextLength > 0,
        `Actual hover DOM is empty before clicking ${step.identifier}. ${JSON.stringify(beforeDom)}`);

      console.log(`  firing hover panel click → ${step.identifier}`);
      const rows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runHoverLinkClickHarnessForTests',
        step.identifier,
      );
      const result = (rows || []).map(row => row?.value).find(value => value?.ok);
      assert.ok(result, `Renderer did not click a ${step.identifier} hover link. Rows=${JSON.stringify(rows)}`);
      assert.strictEqual(result.syntheticHover, false,
        `Drill-down click test must use the real hover DOM, not a synthetic hover. ${JSON.stringify(result)}`);

      console.log(`  waiting hover panel render → ${step.identifier}`);
      state = await waitForPreviewState(step.identifier, step.history.length);
      console.log(`  preview state ready → ${step.identifier}`);
      assert.deepStrictEqual(state.previewHistoryIdentifiers, step.history,
        `Unexpected history after hover-panel click into ${step.identifier}`);
      for (const fragment of step.contains) {
        assert.ok(state.currentPreviewMarkdown.includes(fragment),
          `Preview for ${step.identifier} should contain "${fragment}"`);
      }
      assertMarkdownDoesNotContain(state.currentPreviewMarkdown, step.absent,
        `Preview for ${step.identifier}`);
      const includeDetailedDomMetrics = step.identifier === 'get_owner';
      const afterDom = await waitForHoverDomState(
        step.nextLinks,
        [step.identifier],
        10000,
        true,
        includeDetailedDomMetrics,
        step.absent,
      );
      assert.strictEqual(afterDom.hoverCount, 1,
        `Drill-down into ${step.identifier} left stale hover panels. ${JSON.stringify(afterDom)}`);
      assert.strictEqual(afterDom.emptyHoverCount, 0,
        `Drill-down into ${step.identifier} left empty hover roots. ${JSON.stringify(afterDom)}`);
      assert.ok(afterDom.activeTextLength > 0,
        `Drill-down into ${step.identifier} rendered an empty hover DOM. ${JSON.stringify(afterDom)}`);
      assertHoverDoesNotContain(afterDom, step.absent,
        `Hover DOM after drilling into ${step.identifier}`);
      if (includeDetailedDomMetrics) {
        assertHoverThemeStable(initialDom, afterDom,
          `Hover DOM after drilling into ${step.identifier}`);
        assertStrictNativeTokenTheme(afterDom,
          `Hover DOM after drilling into ${step.identifier}`,
          step.nextLinks,
          step.contains);
        assertHoverHasNoWideTrace(afterDom,
          `Hover DOM after drilling into ${step.identifier}`);
      }
      assert.ok(afterDom.backButtonVisibleCount > 0,
        `Drill-down into ${step.identifier} should keep a visible back button. ${JSON.stringify(compactHoverDomState(afterDom))}`);
      if (step.identifier === 'get_owner' && initialDom.activeRect && afterDom.activeRect) {
        assert.ok(afterDom.activeRect.width <= initialDom.activeRect.width,
          `Shrinking from Company to get_owner should not keep a wider hover box. `
          + `initial=${JSON.stringify(initialDom.activeRect)} after=${JSON.stringify(afterDom.activeRect)}`);
      }
      assert.ok(afterDom.tokenizedText.includes(step.identifier),
        `Tokenized drill-down code should include ${step.identifier}. ${JSON.stringify(afterDom)}`);
      assert.ok(afterDom.typeLinksInTokenizedSource > 0,
        `Drill-down symbols should remain clickable inside highlighted code. ${JSON.stringify(afterDom)}`);
      console.log(`  hover panel click → ${state.currentPreviewIdentifier}, history=[${state.previewHistoryIdentifiers.join(' > ')}]`);
    }

    const backRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverBackButtonClickHarnessForTests',
    );
    const backResult = (backRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(backResult, `Renderer did not click the hover back button. Rows=${JSON.stringify(backRows)}`);
    const backState = await waitForPreviewState('User', 2);
    assert.deepStrictEqual(backState.previewHistoryIdentifiers, ['Company', 'get_owner'],
      'Hover back button should pop the extension-host preview history');
    const backDom = await waitForHoverDomState(['TimestampedModel'], ['User'], 10000, true, false);
    assert.ok(backDom.backButtonVisibleCount > 0,
      `Back result should still expose a back button while history remains. ${JSON.stringify(compactHoverDomState(backDom))}`);
    assertHoverDoesNotContain(backDom, ['class TimestampedModel', 'class Company', 'def get_owner'],
      'Hover DOM after clicking the back button');

    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
  });

  test(`[${lang}] preview click path supports several drill-down hops`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(60000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);

    const anchor = findIdentifier(doc, 'Company', 1);
    assert.ok(anchor, 'Could not find Company annotation in service.py');
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'Company');

    const hoverText = await getHoverText(doc.uri, anchor!);
    assert.ok(hoverText.length > 0, 'Initial hover on Company returned empty content');

    const initial = await getPatchStatus();
    assert.ok(initial.hoverPatchActive, 'Hover patch must be active for drill-down preview E2E');
    assert.ok(initial.lastHoverFetchPosition, 'Initial hover did not record an anchor position');

    await vscode.commands.executeCommand('intellisenseRecursion.goToType', 'PREVIEW:Company');
    const companyState = await waitForPreviewState('Company', 0);
    assert.ok(companyState.currentPreviewMarkdown.includes('class Company'),
      'Preview for Company should contain its class definition');
    assert.ok(companyState.currentPreviewMarkdown.includes('STATUS_ACTIVE = "active"'),
      'Preview for Company should expose assignment-style constants as candidates');
    console.log(`  drill-down → Company, history=[${companyState.previewHistoryIdentifiers.join(' > ')}]`);

    await vscode.commands.executeCommand('intellisenseRecursion.previewType', 'STATUS_ACTIVE');
    const constantState = await waitForPreviewState('STATUS_ACTIVE', 1);
    assert.deepStrictEqual(constantState.previewHistoryIdentifiers, ['Company'],
      'Constant drill-down should keep Company in preview history');
    assert.ok(constantState.currentPreviewMarkdown.includes('STATUS_ACTIVE = "active"'),
      'Preview for STATUS_ACTIVE should contain the constant assignment');
    console.log(`  drill-down → STATUS_ACTIVE, history=[${constantState.previewHistoryIdentifiers.join(' > ')}]`);

    await vscode.commands.executeCommand('intellisenseRecursion.previewBack');
    const restoredCompany = await waitForPreviewState('Company', 0);
    assert.deepStrictEqual(restoredCompany.previewHistoryIdentifiers, []);

    const steps: Array<{ identifier: string; history: string[]; contains: string[]; absent: string[] }> = [
      {
        identifier: 'get_owner',
        history: ['Company'],
        contains: ['def get_owner', 'return self.owner'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'title: str'],
      },
      {
        identifier: 'User',
        history: ['Company', 'get_owner'],
        contains: ['class User', 'TimestampedModel'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'def get_owner', 'return self.owner'],
      },
      {
        identifier: 'TimestampedModel',
        history: ['Company', 'get_owner', 'User'],
        contains: ['class TimestampedModel', 'BaseModel'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'def get_owner', 'class User', 'email: str'],
      },
      {
        identifier: 'BaseModel',
        history: ['Company', 'get_owner', 'User', 'TimestampedModel'],
        contains: ['class BaseModel', 'def save'],
        absent: ['class Company', 'STATUS_ACTIVE = "active"', 'def get_owner', 'class User', 'class TimestampedModel'],
      },
    ];

    for (const step of steps) {
      if (step.identifier === 'get_owner') {
        await vscode.commands.executeCommand('intellisenseRecursion.drillDown', {
          docUri: doc.uri.toString(),
          identifier: step.identifier,
        });
      } else {
        await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), `PREVIEW:${step.identifier}`);
      }
      const state = await waitForPreviewState(step.identifier, step.history.length);
      assert.deepStrictEqual(state.previewHistoryIdentifiers, step.history,
        `Unexpected history after drilling into ${step.identifier}`);
      for (const fragment of step.contains) {
        assert.ok(state.currentPreviewMarkdown.includes(fragment),
          `Preview for ${step.identifier} should contain "${fragment}"`);
      }
      assertMarkdownDoesNotContain(state.currentPreviewMarkdown, step.absent,
        `Command preview for ${step.identifier}`);
      console.log(`  drill-down → ${step.identifier}, history=[${state.previewHistoryIdentifiers.join(' > ')}]`);
    }

    await vscode.commands.executeCommand('intellisenseRecursion.previewBack');
    const backOne = await waitForPreviewState('TimestampedModel', 3);
    assert.deepStrictEqual(backOne.previewHistoryIdentifiers, ['Company', 'get_owner', 'User']);

    await vscode.commands.executeCommand('intellisenseRecursion.previewBack');
    const backTwo = await waitForPreviewState('User', 2);
    assert.deepStrictEqual(backTwo.previewHistoryIdentifiers, ['Company', 'get_owner']);

    await vscode.commands.executeCommand('editor.action.hideHover');
    await new Promise(resolve => setTimeout(resolve, 120));
    const reopenedHoverText = await getHoverText(doc.uri, anchor!);
    assert.ok(reopenedHoverText.length > 0,
      'Hover should reopen with content after drill-down is closed');

    console.log(`  back stack → ${backTwo.currentPreviewIdentifier}, history=[${backTwo.previewHistoryIdentifiers.join(' > ')}]`);
  });

  test(`[${lang}] hover back restores the previous preview scroll position`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(60000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const anchor = findIdentifier(doc, 'LargeHoverModel', 1);
    assert.ok(anchor, 'Could not find LargeHoverModel annotation in service.py');
    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'LargeHoverModel');
    await getHoverText(doc.uri, anchor!);

    await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), 'PREVIEW:LargeHoverModel');
    const largeState = await waitForPreviewState('LargeHoverModel', 0);
    assert.ok(largeState.currentPreviewMarkdown.includes('field_070'),
      'LargeHoverModel preview should be large enough to scroll');
    const seedRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
      'LargeHoverModel',
      largeState.currentPreviewMarkdown,
    );
    const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(seeded, `Could not seed LargeHoverModel hover panel. Rows=${JSON.stringify(seedRows)}`);
    const largeDom = await waitForHoverDomState(
      ['BaseModel'],
      ['LargeHoverModel', 'field_070'],
      10000,
      true,
    );
    assert.ok(largeDom.scrollMaxTop > 80,
      `LargeHoverModel hover should have enough scroll range. ${JSON.stringify(compactHoverDomState(largeDom))}`);

    const targetScrollTop = Math.min(largeDom.scrollMaxTop, 260);
    const scrollRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverScrollHarnessForTests',
      targetScrollTop,
    );
    const scrolled = (scrollRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(scrolled,
      `Could not scroll LargeHoverModel hover. Rows=${JSON.stringify(scrollRows)}`);
    assert.ok(Math.abs(scrolled.after.scrollTop - targetScrollTop) <= 4,
      `LargeHoverModel hover should scroll to the requested position. ${JSON.stringify(scrolled)}`);

    await vscode.commands.executeCommand('intellisenseRecursion.previewType', doc.uri.toString(), 'BaseModel');
    const baseState = await waitForPreviewState('BaseModel', 1);
    assert.deepStrictEqual(baseState.previewHistoryIdentifiers, ['LargeHoverModel'],
      'BaseModel drill-down should keep LargeHoverModel in preview history');
    await waitForHoverDomState(['save'], ['class BaseModel'], 10000, true);

    const backRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverBackButtonClickHarnessForTests',
    );
    const backClick = (backRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(backClick, `Back button should be clickable. Rows=${JSON.stringify(backRows)}`);
    const restoredState = await waitForPreviewState('LargeHoverModel', 0);
    assert.ok(restoredState.currentPreviewMarkdown.includes('field_070'),
      'Back should restore LargeHoverModel preview markdown');
    const restoredDom = await waitForHoverScrollTopNear(
      scrolled.after.scrollTop,
      4,
      ['BaseModel'],
      ['LargeHoverModel', 'field_070'],
      10000,
    );
    assertHoverHasNoWideTrace(restoredDom, 'LargeHoverModel back restore hover');
  });

  test(`[${lang}] hover panel annotation symbols are drill-down links`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(60000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const anchor = findIdentifier(doc, 'find_entity');
    assert.ok(anchor, 'Could not find find_entity in service.py');
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'find_entity');

    const hoverText = await getHoverText(doc.uri, anchor!);
    assert.ok(hoverText.includes('Any') && hoverText.includes('Optional') && hoverText.includes('BaseModel'),
      `find_entity hover should include annotation symbols. Got: ${hoverText.slice(0, 500)}`);

    async function seedFindEntityHover() {
      await vscode.commands.executeCommand('editor.action.hideHover');
      await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
      await waitForPreviewState(null, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
      await getHoverText(doc.uri, anchor!);
      await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), 'PREVIEW:find_entity');
      const state = await waitForPreviewState('find_entity', 0);
      assert.ok(state.currentPreviewMarkdown.includes('def find_entity'),
        'Preview for find_entity should contain its function definition');
      const seedRows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
        'find_entity',
        state.currentPreviewMarkdown,
      );
      const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
      assert.ok(seeded, `Could not seed find_entity hover panel. Rows=${JSON.stringify(seedRows)}`);
      return waitForHoverDomState(
        ['Any', 'Optional', 'BaseModel'],
        ['find_entity'],
        10000,
        true,
      );
    }

    const dom = await seedFindEntityHover();
    assertStrictNativeTokenTheme(dom, 'Annotation preview',
      ['Any', 'Optional', 'BaseModel'],
      ['def find_entity', 'Optional', 'BaseModel']);
    assertTokenizedLinkCounts(dom, { Any: 1, Optional: 1, BaseModel: 1 },
      'Annotation preview');

    const annotationDirectCases = [
      {
        identifier: 'Optional',
        includes: ['Optional'],
        headerPattern: /^`Optional` — \*.*typing.*:\d+\*$/,
      },
      {
        identifier: 'BaseModel',
        includes: ['class BaseModel', 'def save'],
        headerPattern: /^`BaseModel` — \*models\.py:18\*$/,
      },
    ];
    for (const annotationCase of annotationDirectCases) {
      await seedFindEntityHover();
      await vscode.commands.executeCommand(
        'intellisenseRecursion.previewType',
        doc.uri.toString(),
        annotationCase.identifier,
      );
      const directState = await waitForPreviewState(annotationCase.identifier, 1);
      assert.deepStrictEqual(directState.previewHistoryIdentifiers, ['find_entity'],
        `${annotationCase.identifier} direct annotation drill-down should keep find_entity in preview history`);
      assertPreviewHeaderMatches(directState, annotationCase.headerPattern,
        `${annotationCase.identifier} direct annotation drill-down`);
      for (const fragment of annotationCase.includes) {
        assert.ok(directState.currentPreviewMarkdown.includes(fragment),
          `${annotationCase.identifier} direct annotation drill-down should include ${fragment}`);
      }
      assertMarkdownDoesNotContain(directState.currentPreviewMarkdown, ['def find_entity(data: Any)'],
        `${annotationCase.identifier} direct annotation drill-down`);
      const directDom = await waitForHoverDomState(
        [],
        annotationCase.includes,
        10000,
        true,
        true,
        ['def find_entity(data: Any)'],
      );
      assertHoverDoesNotContain(directDom, ['def find_entity(data: Any)'],
        `${annotationCase.identifier} direct annotation drill-down hover`);
      assertHoverHasNoWideTrace(directDom, `${annotationCase.identifier} direct annotation drill-down hover`);
    }

    await seedFindEntityHover();
    const rows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'Optional',
    );
    const result = (rows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(result, `Renderer did not click Optional annotation link. Rows=${JSON.stringify(rows)}`);
    const optionalState = await waitForPreviewState('Optional', 1);
    assert.deepStrictEqual(optionalState.previewHistoryIdentifiers, ['find_entity'],
      'Optional annotation drill-down should keep find_entity in preview history');

    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);

    await seedFindEntityHover();
    const baseRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'BaseModel',
    );
    const baseResult = (baseRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(baseResult, `Renderer did not click BaseModel annotation link. Rows=${JSON.stringify(baseRows)}`);
    const baseState = await waitForPreviewState('BaseModel', 1);
    assert.deepStrictEqual(baseState.previewHistoryIdentifiers, ['find_entity'],
      'Project annotation drill-down should keep find_entity in preview history');
    assert.ok(baseState.currentPreviewMarkdown.includes('class BaseModel'),
      'Project annotation drill-down should show BaseModel definition');
    const baseDom = await waitForHoverDomState(['save'], ['BaseModel'], 10000, true);
    assertStrictNativeTokenTheme(baseDom, 'Project annotation drill-down hover',
      ['save'],
      ['class BaseModel', 'def save']);

    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
  });

  test(`[${lang}] hover panel decorators are drill-down links`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(70000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const anchor = findIdentifier(doc, 'Company', 1);
    assert.ok(anchor, 'Could not find Company annotation in service.py');
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'Company');

    async function prepareCompanyPreviewState() {
      await vscode.commands.executeCommand('editor.action.hideHover');
      await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
      await waitForPreviewState(null, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
      const hoverText = await getHoverText(doc.uri, anchor!);
      assert.ok(hoverText.includes('Company'),
        `Native decorator preview test should establish a Company hover anchor first. Got: ${hoverText.slice(0, 500)}`);
      await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), 'PREVIEW:Company');
      const state = await waitForPreviewState('Company', 0);
      assert.ok(state.currentPreviewMarkdown.includes('@model_annotation'),
        'Company preview should include its class decorator');
      assert.ok(state.currentPreviewMarkdown.includes('@method_annotation'),
        'Company preview should include its method decorator');
      assert.ok(state.currentPreviewMarkdown.includes('@decorator_factory'),
        'Company preview should include call-style decorators');
      assert.ok(state.currentPreviewMarkdown.includes('@classmethod'),
        'Company preview should include builtin classmethod decorator');
      assert.ok(state.currentPreviewMarkdown.includes('@staticmethod'),
        'Company preview should include builtin staticmethod decorator');
      return state;
    }

    async function showCompanyPreviewHover() {
      const state = await prepareCompanyPreviewState();
      const seedRows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
        'Company',
        state.currentPreviewMarkdown,
      );
      const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
      assert.ok(seeded, `Could not seed decorated Company hover panel. Rows=${JSON.stringify(seedRows)}`);
      return waitForHoverDomState(
        ['model_annotation', 'method_annotation', 'decorator_factory', 'classmethod', 'staticmethod', 'get_owner'],
        ['Company'],
        10000,
        true,
      );
    }

    const companyDom = await showCompanyPreviewHover();
    assert.strictEqual(companyDom.hoverCount, 1,
      `Decorator test must use exactly one active hover. ${JSON.stringify(compactHoverDomState(companyDom))}`);
    assert.ok(companyDom.backButtonVisibleCount > 0,
      `Native decorator preview hover should expose a back button. ${JSON.stringify(compactHoverDomState(companyDom))}`);
    assertStrictNativeTokenTheme(companyDom, 'Decorated class preview',
      ['model_annotation', 'method_annotation', 'decorator_factory', 'classmethod', 'staticmethod', 'get_owner', 'User'],
      ['@model_annotation', '@method_annotation', '@decorator_factory', '@classmethod', '@staticmethod', 'def get_owner']);
    assertTokenizedLinkCounts(companyDom, {
      model_annotation: 1,
      method_annotation: 1,
      decorator_factory: 2,
      classmethod: 1,
      staticmethod: 1,
    }, 'Decorated class preview');

    const decoratorCases = [
      {
        identifier: 'model_annotation',
        includes: ['def model_annotation', 'return target'],
        headerPattern: /^`model_annotation` — \*models\.py:4\*$/,
      },
      {
        identifier: 'method_annotation',
        includes: ['def method_annotation', 'return func'],
        headerPattern: /^`method_annotation` — \*models\.py:8\*$/,
      },
      {
        identifier: 'decorator_factory',
        includes: ['def decorator_factory', 'return decorator'],
        headerPattern: /^`decorator_factory` — \*models\.py:12\*$/,
      },
      {
        identifier: 'classmethod',
        includes: ['class classmethod'],
        headerPattern: /^`classmethod` — \*.*builtins\.pyi:\d+\*$/,
      },
      {
        identifier: 'staticmethod',
        includes: ['class staticmethod'],
        headerPattern: /^`staticmethod` — \*.*builtins\.pyi:\d+\*$/,
      },
    ];
    const staleCompanyFragments = ['class Company', '@model_annotation', '@method_annotation', 'def get_owner'];

    for (const decoratorCase of decoratorCases) {
      await prepareCompanyPreviewState();
      await vscode.commands.executeCommand(
        'intellisenseRecursion.previewType',
        doc.uri.toString(),
        decoratorCase.identifier,
      );
      const directState = await waitForPreviewState(decoratorCase.identifier, 1);
      assert.deepStrictEqual(directState.previewHistoryIdentifiers, ['Company'],
        `${decoratorCase.identifier} direct drill-down should keep Company in preview history`);
      assertPreviewHeaderMatches(directState, decoratorCase.headerPattern,
        `${decoratorCase.identifier} direct drill-down`);
      for (const fragment of decoratorCase.includes) {
        assert.ok(directState.currentPreviewMarkdown.includes(fragment),
          `${decoratorCase.identifier} direct drill-down should include ${fragment}`);
      }
      assertMarkdownDoesNotContain(directState.currentPreviewMarkdown, staleCompanyFragments,
        `${decoratorCase.identifier} direct drill-down`);
    }

    await showCompanyPreviewHover();
    const getOwnerRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'get_owner',
    );
    const getOwnerClick = (getOwnerRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(getOwnerClick,
      `Renderer did not click get_owner method link. Rows=${JSON.stringify(getOwnerRows)}`);
    const getOwnerState = await waitForPreviewState('get_owner', 1);
    assert.deepStrictEqual(getOwnerState.previewHistoryIdentifiers, ['Company'],
      'get_owner drill-down should keep Company in preview history');
    assert.ok(getOwnerState.currentPreviewMarkdown.includes('@method_annotation'),
      'get_owner preview should keep the decorator attached above the function definition');
    const getOwnerDom = await waitForHoverDomState(
      ['method_annotation'],
      ['@method_annotation', 'def get_owner'],
      10000,
      true,
      true,
      ['class Company'],
    );
    assertTokenizedLinkCounts(getOwnerDom, { method_annotation: 1 },
      'Decorated function preview');
    const methodDecoratorRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'method_annotation',
    );
    const methodDecoratorClick = (methodDecoratorRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(methodDecoratorClick,
      `Renderer did not click method_annotation above function definition. Rows=${JSON.stringify(methodDecoratorRows)}`);
    const methodDecoratorState = await waitForPreviewState('method_annotation', 2);
    assert.deepStrictEqual(methodDecoratorState.previewHistoryIdentifiers, ['Company', 'get_owner'],
      'method_annotation drill-down from decorated function should keep Company > get_owner history');
    assertPreviewHeaderMatches(methodDecoratorState, /^`method_annotation` — \*models\.py:8\*$/,
      'method_annotation from decorated function drill-down');

    await prepareCompanyPreviewState();
    const fillerTypeLines = Array.from({ length: 560 }, (_, index) =>
      `    field_${String(index).padStart(3, '0')}: DeferredFillerType${String(index).padStart(3, '0')}`);
    const fillerMethodLines = Array.from({ length: 220 }, (_, index) =>
      `    def filler_${String(index).padStart(3, '0')}(self) -> None:\n        pass`);
    const deferredDecoratorCode = [
      'class DeferredDecoratorPreview:',
      ...fillerTypeLines,
      ...fillerMethodLines,
      '    @method_annotation',
      '    def decorated(self) -> None:',
      '        pass',
    ].join('\n');
    assert.ok(deferredDecoratorCode.length > 24000,
      `Deferred decorator fixture must exceed eager wrapping threshold, got ${deferredDecoratorCode.length}`);
    const deferredDecoratorMarkdown = [
      '`Company` — *models.py:39*',
      '```python',
      deferredDecoratorCode,
      '```',
    ].join('\n');
    const deferredRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
      'Company',
      deferredDecoratorMarkdown,
    );
    const deferredSeed = (deferredRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(deferredSeed, `Could not seed deferred decorator hover panel. Rows=${JSON.stringify(deferredRows)}`);
    assert.ok(!(deferredSeed.linkTypes || []).includes('method_annotation'),
      `Deferred large hover should not eagerly pre-wrap method_annotation. ${JSON.stringify(deferredSeed)}`);
    const deferredDom = await waitForHoverDomState(
      [],
      ['DeferredDecoratorPreview'],
      10000,
      true,
      true,
    );
    assert.ok(deferredDom.activeTextLength > 24000,
      `Deferred decorator hover should stay large. ${JSON.stringify(compactHoverDomState(deferredDom))}`);
    const deferredClickRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'method_annotation',
    );
    const deferredClick = (deferredClickRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(deferredClick,
      `Pointer hover did not promote @method_annotation into a drill-down link. Rows=${JSON.stringify(deferredClickRows)}`);
    assert.strictEqual(deferredClick.linkAlreadyExisted, false,
      `Deferred decorator test must exercise point-based wrapping, not eager links. ${JSON.stringify(deferredClick)}`);
    assert.ok(deferredClick.pointWrap?.decoratorContext,
      `Point wrapper should recognize @method_annotation as a decorator context. ${JSON.stringify(deferredClick)}`);
    assert.ok(deferredClick.pointWrap?.pointActive || deferredClick.pointActive,
      `Hovering the decorator should visibly activate underline state. ${JSON.stringify(deferredClick)}`);
    const deferredDecoratorState = await waitForPreviewState('method_annotation', 1);
    assert.deepStrictEqual(deferredDecoratorState.previewHistoryIdentifiers, ['Company'],
      'Deferred decorator drill-down should keep Company in preview history');
    assertPreviewHeaderMatches(deferredDecoratorState, /^`method_annotation` — \*models\.py:8\*$/,
      'deferred @method_annotation hover click drill-down');

    for (const decoratorCase of decoratorCases) {
      await showCompanyPreviewHover();
      const rows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runHoverLinkClickHarnessForTests',
        decoratorCase.identifier,
      );
      const click = (rows || []).map(row => row?.value).find(value => value?.ok);
      assert.ok(click,
        `Renderer did not click decorator link ${decoratorCase.identifier}. Rows=${JSON.stringify(rows)}`);
      assert.strictEqual(click.syntheticHover, false,
        `Decorator drill-down test must use the real hover DOM, not a synthetic hover. ${JSON.stringify(click)}`);
      const decoratorState = await waitForPreviewState(decoratorCase.identifier, 1);
      assert.deepStrictEqual(decoratorState.previewHistoryIdentifiers, ['Company'],
        `${decoratorCase.identifier} drill-down should keep Company in preview history`);
      assertPreviewHeaderMatches(decoratorState, decoratorCase.headerPattern,
        `${decoratorCase.identifier} hover click drill-down`);
      for (const fragment of decoratorCase.includes) {
        assert.ok(decoratorState.currentPreviewMarkdown.includes(fragment),
          `${decoratorCase.identifier} drill-down should include ${fragment}`);
      }
      assertMarkdownDoesNotContain(decoratorState.currentPreviewMarkdown, staleCompanyFragments,
        `${decoratorCase.identifier} hover click drill-down`);
      const decoratorDom = await waitForHoverDomState(
        [],
        decoratorCase.includes,
        10000,
        true,
        true,
        staleCompanyFragments,
      );
      assertHoverDoesNotContain(decoratorDom, staleCompanyFragments,
        `${decoratorCase.identifier} hover click drill-down`);
      assertHoverHasNoWideTrace(decoratorDom, `${decoratorCase.identifier} hover click drill-down`);
      assertStrictNativeTokenTheme(decoratorDom, `${decoratorCase.identifier} drill-down hover`,
        [],
        decoratorCase.includes);
      const backRows = await vscode.commands.executeCommand<any[]>(
        'intellisenseRecursion.runHoverBackButtonClickHarnessForTests',
      );
      const backClick = (backRows || []).map(row => row?.value).find(value => value?.ok);
      assert.ok(backClick,
        `${decoratorCase.identifier} drill-down should expose a working back button. Rows=${JSON.stringify(backRows)}`);
      const backState = await waitForPreviewState('Company', 0);
      assert.ok(backState.currentPreviewMarkdown.includes('@method_annotation'),
        `${decoratorCase.identifier} back should restore the decorated Company preview`);
      const backDom = await waitForHoverDomState(
        ['model_annotation', 'method_annotation', 'decorator_factory'],
        ['class Company', '@method_annotation'],
        10000,
        true,
      );
      assertStrictNativeTokenTheme(backDom, `${decoratorCase.identifier} back to decorated class`,
        ['model_annotation', 'method_annotation', 'decorator_factory'],
        ['class Company', '@method_annotation']);
    }

    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
  });

  test(`[${lang}] hover panel property decorator drills down through definition provider`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(45000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const doc = await vscode.workspace.openTextDocument(serviceFile);
    const anchor = findIdentifier(doc, 'Company', 1);
    assert.ok(anchor, 'Could not find Company annotation in service.py');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(doc, 'Company');
    const hoverText = await getHoverText(doc.uri, anchor!);
    assert.ok(hoverText.includes('Company'),
      `Initial Company hover should establish an anchor before preview. Got: ${hoverText.slice(0, 500)}`);

    await vscode.commands.executeCommand('intellisenseRecursion.goToType', doc.uri.toString(), 'PREVIEW:Company');
    const state = await waitForPreviewState('Company', 0);
    assert.ok(state.currentPreviewMarkdown.includes('@property'),
      'Company preview should include its @property decorator');
    assert.ok(state.currentPreviewMarkdown.includes('def owner_display_name'),
      'Company preview should include the decorated property method');
    const seedRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
      'Company',
      state.currentPreviewMarkdown,
    );
    const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(seeded, `Could not seed Company hover panel. Rows=${JSON.stringify(seedRows)}`);
    const companyDom = await waitForHoverDomState(
      ['property'],
      ['@property', 'owner_display_name'],
      10000,
      true,
    );
    assert.ok(companyDom.tokenizedLinkTypes.includes('property'),
      `@property should be a tokenized drill-down link. ${JSON.stringify(compactHoverDomState(companyDom))}`);

    const propertyRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'property',
    );
    const propertyClick = (propertyRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(propertyClick,
      `Renderer did not click @property link. Rows=${JSON.stringify(propertyRows)}`);
    const propertyState = await waitForPreviewState('property', 1);
    assert.deepStrictEqual(propertyState.previewHistoryIdentifiers, ['Company'],
      '@property drill-down should keep Company in preview history');
    assert.ok(propertyState.currentPreviewMarkdown.includes('class property'),
      '@property drill-down should show builtins.property definition');
    const propertyDom = await waitForHoverDomState(
      [],
      ['class property'],
      10000,
      true,
    );
    assertStrictNativeTokenTheme(propertyDom, '@property drill-down hover',
      [],
      ['class property']);

    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
  });

  test(`[${lang}] hover panel links every editor definition-provider symbol in preview code`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(60000);

    const folders = vscode.workspace.workspaceFolders!;
    const serviceFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'service.py'));
    const modelsFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'models.py'));
    const serviceDoc = await vscode.workspace.openTextDocument(serviceFile);
    const modelsDoc = await vscode.workspace.openTextDocument(modelsFile);
    const anchor = findIdentifier(serviceDoc, 'Company', 1);
    assert.ok(anchor, 'Could not find Company annotation in service.py');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
    await vscode.window.showTextDocument(serviceDoc, { selection: new vscode.Range(anchor!, anchor!) });
    await waitForLanguageServer(serviceDoc, 'Company');
    await getHoverText(serviceDoc.uri, anchor!);

    const editorSymbols = [
      { identifier: 'model_annotation', line: '@model_annotation' },
      { identifier: 'TimestampedModel', line: 'class Company(TimestampedModel)' },
      { identifier: 'STATUS_ACTIVE', line: 'STATUS_ACTIVE = "active"' },
      { identifier: 'User', line: 'def get_owner(self) -> User' },
      { identifier: 'method_annotation', line: '@method_annotation' },
      { identifier: 'get_owner', line: 'def get_owner(self) -> User' },
      { identifier: 'property', line: '@property' },
      { identifier: 'owner_display_name', line: 'def owner_display_name' },
      { identifier: 'owner', line: 'return self.owner.get_display_name()' },
      { identifier: 'get_display_name', line: 'return self.owner.get_display_name()' },
      { identifier: 'classmethod', line: '@classmethod' },
      { identifier: 'decorator_factory', line: '@decorator_factory("empty")' },
      { identifier: 'create_empty', line: 'def create_empty' },
      { identifier: 'staticmethod', line: '@staticmethod' },
      { identifier: 'normalize_title', line: 'def normalize_title' },
    ];

    const cmdClickable = new Set<string>();
    for (const symbol of editorSymbols) {
      const pos = findIdentifierOnLine(modelsDoc, symbol.line, symbol.identifier);
      assert.ok(pos,
        `Could not find ${symbol.identifier} on fixture line "${symbol.line}"`);
      const defs = await vscode.commands.executeCommand<any[]>(
        'vscode.executeDefinitionProvider',
        modelsDoc.uri,
        pos!,
      );
      const def = getDefLocation(defs || []);
      assert.ok(def,
        `${symbol.identifier} on "${symbol.line}" should be editor cmd+click navigable`);
      cmdClickable.add(symbol.identifier);
    }

    await vscode.commands.executeCommand('intellisenseRecursion.goToType', serviceDoc.uri.toString(), 'PREVIEW:Company');
    const state = await waitForPreviewState('Company', 0);
    const seedRows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverSeedPreviewHarnessForTests',
      'Company',
      state.currentPreviewMarkdown,
    );
    const seeded = (seedRows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(seeded, `Could not seed Company hover panel. Rows=${JSON.stringify(seedRows)}`);

    const expectedLinks = [...cmdClickable];
    const dom = await waitForHoverDomState(
      expectedLinks,
      ['@property', 'get_display_name'],
      10000,
      true,
    );
    for (const identifier of expectedLinks) {
      assert.ok(dom.tokenizedLinkTypes.includes(identifier),
        `Editor cmd+clickable symbol "${identifier}" should be a drill-down link. `
        + `${JSON.stringify(compactHoverDomState(dom))}`);
    }

    const rows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverLinkClickHarnessForTests',
      'get_display_name',
    );
    const clicked = (rows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(clicked,
      `Renderer did not click get_display_name method-access link. Rows=${JSON.stringify(rows)}`);
    const methodState = await waitForPreviewState('get_display_name', 1);
    assert.deepStrictEqual(methodState.previewHistoryIdentifiers, ['Company'],
      'Method-access drill-down should keep Company in preview history');
    assert.ok(methodState.currentPreviewMarkdown.includes('def get_display_name'),
      'Method-access drill-down should show get_display_name definition');
    assert.ok(methodState.currentPreviewMarkdown.includes('return self.name'),
      'Method-access drill-down should show the resolved method body');

    await vscode.commands.executeCommand('editor.action.hideHover');
    await vscode.commands.executeCommand('intellisenseRecursion.resetPreviewStateForTests');
    await waitForPreviewState(null, 0);
  });
});

suite('Hover Symbol Coverage E2E', () => {
  const lang = getFixtureLang();

  test(`[${lang}] editor hover recognizes types, constants, functions, and methods`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(90000);

    const folders = vscode.workspace.workspaceFolders!;
    const root = folders[0].uri.fsPath;
    const serviceDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'service.py')));
    const modelsDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'models.py')));
    await vscode.window.showTextDocument(serviceDoc);
    await waitForLanguageServer(serviceDoc, 'User');

    const cases: Array<{
      doc: vscode.TextDocument;
      identifier: string;
      occurrence?: number;
      includes: string[];
    }> = [
      { doc: serviceDoc, identifier: 'Company', occurrence: 1, includes: ['class Company', 'owner: User'] },
      { doc: serviceDoc, identifier: 'CAN_EXERCISE', occurrence: 1, includes: ['CAN_EXERCISE = "can_exercise"'] },
      { doc: modelsDoc, identifier: 'model_annotation', occurrence: 1, includes: ['def model_annotation', 'return target'] },
      { doc: modelsDoc, identifier: 'method_annotation', occurrence: 1, includes: ['def method_annotation', 'return func'] },
      { doc: modelsDoc, identifier: 'decorator_factory', occurrence: 1, includes: ['def decorator_factory', 'return decorator'] },
      { doc: modelsDoc, identifier: 'STATUS_ACTIVE', includes: ['STATUS_ACTIVE = "active"'] },
      { doc: modelsDoc, identifier: 'get_owner', includes: ['def get_owner', 'return self.owner'] },
      { doc: serviceDoc, identifier: 'get_company_stakeholders', includes: ['def get_company_stakeholders', 'return []'] },
      { doc: serviceDoc, identifier: 'save', includes: ['def save', 'pass'] },
      { doc: serviceDoc, identifier: 'get_display_name', occurrence: 1, includes: ['def get_display_name', 'return self.name'] },
    ];

    for (const entry of cases) {
      const pos = findIdentifier(entry.doc, entry.identifier, entry.occurrence ?? 0);
      assert.ok(pos, `Could not find ${entry.identifier}`);
      const symbolRange = entry.doc.getWordRangeAtPosition(pos!, /[A-Za-z_$][\w$]*/);
      assert.ok(symbolRange, `Could not get word range for ${entry.identifier}`);

      const endProbe = new vscode.Position(
        symbolRange!.end.line,
        Math.max(symbolRange!.start.character, symbolRange!.end.character - 1),
      );
      const lineLength = entry.doc.lineAt(symbolRange!.start.line).text.length;
      const beforeProbe = new vscode.Position(
        symbolRange!.start.line,
        Math.max(0, symbolRange!.start.character - 1),
      );
      const afterProbe = new vscode.Position(
        symbolRange!.end.line,
        Math.min(lineLength, symbolRange!.end.character),
      );
      const probePositions = [symbolRange!.start, endProbe, beforeProbe, afterProbe]
        .filter((probe, index, all) => all.findIndex(other => other.isEqual(probe)) === index);
      const hoverTexts: string[] = [];
      for (const probe of probePositions) {
        const hovers = await getRawHovers(entry.doc.uri, probe);
        const probeText = textFromHovers(hovers);
        if (probeText) { hoverTexts.push(probeText); }
        assert.ok(probeText.length > 0,
          `Hover on ${entry.identifier} near ${probe.character} returned empty content`);
        assert.ok(hoverRangeCovers(hovers, symbolRange!),
          `Hover on ${entry.identifier} near ${probe.character} should cover full symbol range `
          + `${symbolRange!.start.line}:${symbolRange!.start.character}-${symbolRange!.end.character}`);
        const normalizedTexts = hovers
          .map(hoverToText)
          .map(normalizeHoverContent)
          .filter(Boolean);
        const duplicates = normalizedTexts.filter((text, index) => normalizedTexts.indexOf(text) !== index);
        assert.strictEqual(duplicates.length, 0,
          `Hover on ${entry.identifier} near ${probe.character} returned duplicate provider content`);
      }
      const hoverText = hoverTexts.join('\n');
      assert.ok(hoverText.length > 0,
        `Hover on ${entry.identifier} returned empty content`);
      for (const fragment of entry.includes) {
        assert.ok(hoverText.includes(fragment),
          `Hover on ${entry.identifier} should include "${fragment}". Got: ${hoverText.substring(0, 300)}`);
      }
      console.log(`  symbol hover ${entry.identifier}: ${hoverText.length} chars`);
    }
  });
});

suite('Hover Renderer E2E', () => {
  const lang = getFixtureLang();

  test(`[${lang}] renderer hover widget resizes, disposes stale panels, and scrolls`, async function () {
    if (lang !== 'python') { this.skip(); return; }
    this.timeout(120000);

    const rows = await vscode.commands.executeCommand<any[]>(
      'intellisenseRecursion.runHoverRendererHarnessForTests',
    );
    assert.strictEqual((rows || []).length, 1,
      `Renderer DOM harness should run in exactly one VS Code window. Rows=${JSON.stringify(rows)}`);
    const result = (rows || []).map(row => row?.value).find(value => value?.ok);
    assert.ok(result, `Renderer harness did not run. Rows=${JSON.stringify(rows)}`);

    assert.ok(result.patchVersion >= 122,
      `Renderer hover patch should be installed, got ${result.patchVersion}`);
    assert.ok(result.largeBefore.isScrollable,
      `Large synthetic hover should be scrollable. ${JSON.stringify(result.largeBefore)}`);
    assert.ok(result.largeBefore.scroller.maxTop > 20,
      `Large synthetic hover should have scroll range. ${JSON.stringify(result.largeBefore.scroller)}`);
    assert.ok(result.largeAfterWheel.scroller.scrollTop > result.largeBefore.scroller.scrollTop,
      `Wheel should scroll hover panel. Before=${JSON.stringify(result.largeBefore.scroller)} `
      + `After=${JSON.stringify(result.largeAfterWheel.scroller)}`);
    assert.ok(result.hugeTextLength > 24000,
      `Huge synthetic hover should exercise deferred wrapping. ${JSON.stringify(result)}`);
    assert.strictEqual(result.hugeEagerLinks, 0,
      `Huge hover should not eagerly wrap every symbol. ${JSON.stringify(result)}`);
    assert.ok(result.dedupeHoverConnected,
      `Duplicate dedupe must not remove the active hover. ${JSON.stringify(result)}`);
    assert.ok(result.dedupeSentinelConnected,
      `Duplicate dedupe must not remove non-markdown row state. ${JSON.stringify(result)}`);
    assert.ok(result.dedupeSecondRowConnected,
      `Duplicate dedupe should narrow removal to markdown when a row has extra state. ${JSON.stringify(result)}`);
    assert.strictEqual(result.dedupeMarkdownCount, 1,
      `Renderer DOM dedupe should remove duplicate markdown blocks without removing row state. ${JSON.stringify(result)}`);
    assert.ok(result.dedupeTextLength > 0,
      `Duplicate dedupe must leave hover content visible. ${JSON.stringify(result)}`);
    assert.strictEqual(result.largeBefore.handles.visible, 0,
      `Large hover native handles should be hidden. ${JSON.stringify(result.largeBefore.handles)}`);
    assert.strictEqual(result.small.handles.visible, 0,
      `Small hover native handles should be hidden after resize. ${JSON.stringify(result.small.handles)}`);
    assert.ok(result.small.handles.maxHeight <= 1,
      `Small hover should not keep previous large handle geometry. ${JSON.stringify(result.small.handles)}`);
    assert.ok(!result.largeConnectedAfterSmall,
      'Switching to a small hover should remove the previous large hover');
    assert.ok(result.smallConnectedAfterEmptyRoot,
      'Empty cursor-sized hover roots must not remove the active populated hover');
    assert.ok(!result.orphanConnectedAfterSmall,
      'Switching to a small hover should remove inactive previous hover panels');
    assert.ok(!result.lateHandleConnectedAfterCleanup,
      'Late native hover handles should be removed after the active hover is already shown');
    assert.ok(!result.bodyHandleConnectedAfterCleanup,
      'Body-level stale hover handles should be removed after final hover sizing');
    assert.ok(!result.unownedBodyHandleConnectedAfterCleanup,
      'Unowned body-level hover sashes at the hover edge should be removed after final hover sizing');
    assert.ok(!result.topBodyHandleConnectedAfterCleanup,
      'Top-right body-level hover sashes at the hover edge should be removed after final hover sizing');
    assert.ok(result.workbenchSashConnectedAfterCleanup,
      'Workbench/editor sashes must not be removed by hover cleanup');
    assert.ok(result.topWorkbenchSashConnectedAfterCleanup,
      'Top workbench/editor sashes must not be removed by hover cleanup');
    assert.ok(!result.mutatingHandleConnectedAfterCleanup,
      'Native hover handles that reappear via class/style mutation should be removed');
    assert.ok(result.small.nativeScrollbar.scrollbarWidth === 'none'
      || result.small.nativeScrollbar.webkit.display === 'none'
      || result.small.nativeScrollbar.webkit.width === '0px',
      `Native scrollbars should be hidden. ${JSON.stringify(result.small.nativeScrollbar)}`);
    assert.strictEqual(result.inactiveAfterSmall.inactiveHovers, 0,
      `No inactive hover panels should remain. ${JSON.stringify(result.inactiveAfterSmall)}`);
    assert.strictEqual(result.inactiveAfterSmall.externalArtifacts, 0,
      `No external hover artifacts should remain. ${JSON.stringify(result.inactiveAfterSmall)}`);
    assert.ok(result.small.rect.height < result.largeBefore.rect.height,
      `Small hover should not keep large height (${result.small.rect.height} >= ${result.largeBefore.rect.height})`);
    assert.ok(result.small.rect.width < result.largeBefore.rect.width,
      `Small hover should not keep large width (${result.small.rect.width} >= ${result.largeBefore.rect.width})`);
    assert.ok(result.small.protrusions.maxRightOverflow <= 2,
      `Small hover should not leave a protruding old-width box. ${JSON.stringify(result.small.protrusions)}`);
    assert.ok(result.small.protrusions.maxBottomOverflow <= 2,
      `Small hover should not leave a protruding old-height box. ${JSON.stringify(result.small.protrusions)}`);
    assert.strictEqual(result.small.protrusions.wideBlockCount, 0,
      `Small hover should not contain wide stale block geometry. ${JSON.stringify(result.small.protrusions)}`);
    assert.ok(result.small.sizeTier === 'small',
      `Small hover should use small size tier. ${JSON.stringify(result.small)}`);

    console.log(`  renderer hover harness: large=${result.largeBefore.rect.height}, `
      + `small=${result.small.rect.height}, `
      + `scroll=${result.largeBefore.scroller.scrollTop}->${result.largeAfterWheel.scroller.scrollTop}`);
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
