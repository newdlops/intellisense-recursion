import * as assert from 'assert';
import { Script, runInNewContext } from 'vm';
import * as ts from 'typescript';
import { getHoverPatchScript } from '../../renderer-patch';

suite('Hover link candidate preservation', () => {
  let scan: (text: string, maxChars: number, maxLines: number, skip?: Record<string, number>, initial?: string[]) => string[];

  suiteSetup(() => {
    // Exercise the actual generated JavaScript. TypeScript cannot check code
    // inside the renderer string, and executing the full patch needs a DOM.
    const script = getHoverPatchScript();
    new Script(script);
    const source = ts.createSourceFile('renderer.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set([
      'irCollectTypeShapedCandidates', 'irAddHoverLinkName',
      'irPrimaryHoverLinkName', 'irConstantHoverLinkName', 'irTypeShapedName',
    ]);
    const declarations: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && names.delete(node.name.text)) {
        declarations.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.strictEqual(names.size, 0, `Missing renderer functions: ${Array.from(names)}`);
    const collect = runInNewContext([
      'var IR_HOVER_LINK_MAX_TYPES=240, IR_HOVER_LINK_MAX_CONSTANTS=80;',
      ...declarations,
      'irCollectTypeShapedCandidates;',
    ].join('\n'));
    scan = (text, maxChars, maxLines, skip = {}, initial = []) => {
      const types = [...initial];
      const seen = Object.fromEntries(types.map(type => [type, 1]));
      collect(text, skip, types, seen, maxChars, maxLines);
      return types;
    };
  });

  test('small previews retain identifier order, constants, skip words and existing candidates', () => {
    const text = 'AlreadyType IgnoreType FreshType\r\nOtherType FRESH_CONSTANT FreshType';
    assert.deepStrictEqual(scan(text, text.length + 1, 10, { IgnoreType: 1 }, ['AlreadyType']),
      ['AlreadyType', 'FreshType', 'OtherType', 'FRESH_CONSTANT']);
  });

  test('the character budget retains the complete last scanned line', () => {
    const text = 'prefix '.repeat(10_000) + 'EndOfFirstLineType\nBeyondBudgetType';
    assert.deepStrictEqual(scan(text, 8, 900), ['EndOfFirstLineType']);
  });

  test('large previews keep the final candidate inside the existing line budget', () => {
    const text = ['FirstType', ...Array(898).fill('# source detail'), 'LastWithinBudgetType', 'BeyondLineBudgetType',
      ...Array(100_000).fill('# full source remains available')].join('\n');
    assert.deepStrictEqual(scan(text, 50_000, 900), ['FirstType', 'LastWithinBudgetType']);
  });

  test('an unrestricted scan still reaches names beyond 900 lines', () => {
    const lines = ['FirstType', ...Array(1_000).fill('# source detail'), 'FinalSourceType'];
    const text = lines.join('\n');
    assert.deepStrictEqual(scan(text, text.length + 1, lines.length), ['FirstType', 'FinalSourceType']);
    assert.deepStrictEqual(scan('', 0, 0), []);
  });

  test('large candidate sets preserve the reserved constant slots and maximum size', () => {
    const primary = Array.from({ length: 170 }, (_, i) => `Type${i}`);
    const constants = Array.from({ length: 90 }, (_, i) => `CONSTANT_${i}`);
    const text = [...primary, ...constants].join('\n');
    assert.deepStrictEqual(scan(text, text.length + 1, 900),
      [...primary.slice(0, 160), ...constants.slice(0, 80)]);
  });
});
