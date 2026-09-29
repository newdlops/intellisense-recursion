import * as assert from 'assert';
import { NATIVE_HOVER_MARKDOWN_LIMIT, splitNativeHoverMarkdown, withCompleteHoverContents } from '../../hover-content';

suite('Native hover content delivery', () => {
  const body = Array.from({ length: 10_025 }, (_, i) => `    field_${i}: int = ${i}`).join('\n');

  test('large code is delivered in order with a language fence around every part', () => {
    const value = `Full description ... preserved.\n\n\`\`\`python\n${body}\n\`\`\``;
    const chunks = splitNativeHoverMarkdown(value);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= NATIVE_HOVER_MARKDOWN_LIMIT));
    assert.ok(chunks[0].startsWith('Full description ... preserved.'));
    const code = chunks.map(chunk => /```python\n([\s\S]*?)\n```/.exec(chunk)?.[1]);
    assert.ok(code.every(part => part !== undefined));
    assert.strictEqual(code.join('\n'), body);
  });

  test('descriptions and very long Unicode lines retain every character', () => {
    for (const value of ['Full description ...\n'.repeat(12_000), '한글🧭...'.repeat(30_000)]) {
      const chunks = splitNativeHoverMarkdown(value);
      assert.strictEqual(chunks.join(''), value);
      assert.ok(chunks.every(chunk => chunk.length <= NATIVE_HOVER_MARKDOWN_LIMIT));
      assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
    }
    const line = '한글🧭...'.repeat(30_000);
    const chunks = splitNativeHoverMarkdown('```python\n' + line + '\n```');
    assert.ok(chunks.every(chunk => chunk.length <= NATIVE_HOVER_MARKDOWN_LIMIT));
    assert.strictEqual(chunks.map(chunk => /^```python\n([\s\S]*?)\n```$/.exec(chunk)?.[1]).join(''), line);
  });

  test('fence transitions, tilde fences and literal backticks keep their contents', () => {
    const value = '````python\n# literal ```\n' + body + '\n````\n\nDescription\n\n~~~typescript\n' + body + '\n~~~';
    const chunks = splitNativeHoverMarkdown(value);
    assert.ok(chunks.every(chunk => chunk.length <= NATIVE_HOVER_MARKDOWN_LIMIT));
    assert.strictEqual((chunks.join('\n').match(/field_10024/g) || []).length, 2);
    assert.ok(chunks[0].includes('# literal ```'));
    assert.ok(chunks[chunks.length - 1].startsWith('~~~typescript\n'));
    assert.ok(chunks[chunks.length - 1].endsWith('\n~~~'));
  });

  test('all result metadata is retained and small results keep their identity', () => {
    const short = { contents: [{ value: 'small' }], range: { start: 3 } };
    assert.strictEqual(withCompleteHoverContents(short), short);
    assert.strictEqual(withCompleteHoverContents(null), null);
    const content = { value: '```python\n' + body + '\n```', isTrusted: { enabledCommands: ['test.command'] }, supportThemeIcons: true, supportHtml: false, baseUri: { path: '/source/' } };
    const source = { contents: [short.contents[0], content], range: short.range, id: 42 };
    const delivered = withCompleteHoverContents(source);
    assert.strictEqual(delivered.range, source.range);
    assert.strictEqual(delivered.id, source.id);
    assert.strictEqual(source.contents.length, 2, 'Delivery must not mutate cached/history content');
    for (const part of delivered.contents.slice(1) as typeof content[]) {
      assert.strictEqual(part.isTrusted, content.isTrusted);
      assert.strictEqual(part.supportThemeIcons, true);
      assert.strictEqual(part.supportHtml, false);
      assert.strictEqual(part.baseUri, content.baseUri);
    }
  });
});
