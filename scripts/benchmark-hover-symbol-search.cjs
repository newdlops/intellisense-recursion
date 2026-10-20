// Frozen published baseline + current generated renderer, without VS Code APIs.
// Node timings exclude timer delay, DOM, Quick Pick, providers and CDP latency.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const BASELINE = '6b7d3c6e5862d3f466ce91c734ffc13eaab3bc47';
const baselineFile = path.join(__dirname, 'fixtures/hover-symbol-search-0.2.6053.cjs');

function generatedScript(source) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const context = { exports: {}, require(name) {
    if (name === './preview-file-link') { return { parsePreviewFileLink() {} }; }
    throw new Error('Unexpected dependency: ' + name);
  } };
  vm.runInNewContext(code, context);
  return context.exports.getHoverPatchScript();
}

function extract(script) {
  const source = ts.createSourceFile('renderer.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helpers = new Set(['irTypeShapedName', 'irConstantHoverLinkName', 'irLowerCallableName', 'irEscapeHoverLinkRegex']);
  const parts = [];
  let scanner, skip, eager;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && helpers.delete(node.name.text)) { parts.push(node.getText(source)); }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'IR_HOVER_LINK_SKIP') { skip = node.initializer.getText(source); }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'IR_HOVER_EAGER_WRAP_MAX_TEXT') { eager = node.initializer.getText(source); }
    if (ts.isBinaryExpression(node) && node.left.getText(source) === 'window.irReadDetachedHoverSymbols') { scanner = node.right.getText(source); }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(scanner && skip && eager && !helpers.size, 'Extract the real generated scanner and its matching helpers');
  return { scanner, helpers: parts.join('\n'), skip, eager };
}

function factorySource(parts) {
  return `(function(schedule){
    var window={},state,yields=0,options;
    var IR_HOVER_LINK_SKIP=${parts.skip};
    var IR_HOVER_EAGER_WRAP_MAX_TEXT=${parts.eager};
    ${parts.helpers}
    function irDetachedHoverStateForSessionKey(){return state;}
    function irDetachedSymbolPickerIsCurrent(s,p){return !!(s&&s.symbolPicker===p&&!s.previewBusy&&s.previewRequestSeq===p.requestId);}
    function irClearTimer(){}
    function setTimeout(fn){yields++;if(options.cancelAtYield===yields)state.symbolPicker=null;return schedule(fn);}
    var scan=${parts.scanner};
    return async function(input){
      options=input;yields=0;
      var target={__irHoverLinkCandidates:input.known||{},__irDetachedLinkTypes:input.seeds||[]};
      state={el:{isConnected:true},previewRequestSeq:0,previewBusy:false,currentTypeName:input.current||'',
        symbolPicker:{id:1,requestId:0,target:target,text:input.text,queryId:0,names:[],timer:null}};
      var result=await scan('benchmark',1,1,input.query);
      return {result:result,yields:yields};
    };
  })`;
}

function variants() {
  // A checked-in frozen reference also works in shallow clones/offline CI.
  const baseline = require(baselineFile);
  assert.equal(baseline.baselineCommit, BASELINE);
  const currentSource = fs.readFileSync(path.join(root, 'src/renderer-patch.ts'), 'utf8');
  const current = extract(generatedScript(currentSource));
  return { baseline: '(' + baseline.factory.toString() + ')', current: factorySource(current),
    metadata: { baselineCommit: BASELINE, baselineFactorySha256: createHash('sha256').update(baseline.factory.toString()).digest('hex'), currentRendererSha256: createHash('sha256').update(currentSource).digest('hex') } };
}

function freezeBaseline() {
  const baseline = extract(generatedScript(execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', BASELINE + ':src/renderer-patch.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })));
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, '// Generated from published 0.2.6053 (' + BASELINE + ').\n'
    + '// Frozen scan + pure dependencies; mock session/page; never shipped.\n'
    + 'module.exports = {baselineCommit:' + JSON.stringify(BASELINE) + ',factory:' + factorySource(baseline) + '};\n');
}

function cases() {
  const result = [];
  const queries = ['', 'type', 'tail', 'call', '$', '_', '123', 'foo bar', '.*', 'İ', 'K', 'ſ', '한글', 'OWNER', 'a'.repeat(1000) + 'b', 'x'.repeat(128) + 'tailreference'];
  const texts = ['', 'TailReference tail_callable() @decorator\n', '123TailReference TailReference123 $TailReference _TailReference\r\n',
    '# late_callable not callable here\nclass LaterType: pass\nlate_callable()\n', 'İTailReference 한글OwnerType KOtherType 🧭LastType',
    'x'.repeat(300000) + 'TailReference\nTailReference', 'X'.repeat(300000) + 'tail\nTailReference',
    '.'.repeat(262140) + 'BoundaryType\n    owner: TailReference',
    '.'.repeat(262139) + '\n@   late_callable\nclass LaterType: pass\nlate_callable()',
    'CandidateType\n'.repeat(21844) + 'OtherType\nTailReference',
    Array.from({ length: 260 }, (_, i) => 'CandidateType' + i).join('\n')];
  for (const original of texts) {
    for (const text of [original, original + '\n# ' + '.'.repeat(4100), '.'.repeat(4100) + '\n' + original]) {
      for (const query of queries) {
        for (const seeds of [[], ['SeedType', 'TailReference']]) {
          result.push({ text, query, seeds, known: {}, current: 'OwnerType' });
        }
      }
    }
  }
  let seed = 0xdecafbad;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const words = ['OwnerType', 'OtherType', 'TAIL_CONSTANT', 'late_callable', 'decorator', '$call', '_thing', 'Type123', 'x', 'foo', 'constructor', 'toString', '__proto__', 'pass', 'Returns', 'K', 'İ', '한글'];
  const delimiters = [' ', '\n', '\r\n', '.', '(', '()', '@', '# ', '123', '$', '_', ':', '🧭', ' def ', ' function ', '\t', ' '.repeat(40)];
  for (let i = 0; i < 2500; i++) {
    let text = '';
    for (let j = 0; j < 30; j++) { text += delimiters[next(delimiters.length)] + words[next(words.length)]; }
    if (i % 2) { text += '\n# ' + '.'.repeat(4100); }
    const query = i % 3 ? queries[next(queries.length)] : words[next(words.length)].slice(next(3));
    result.push({ text, query, current: words[next(words.length)], seeds: words.slice(0, next(8)), known: { foo: 1, late_callable: 1 } });
  }
  return result;
}

function workloads() {
  const text = 'class ExampleType:\n    owner: OwnerType\n' + '    # explanation and source detail\n'.repeat(10025)
    + '    late_owner: TailReference\n    def late_callable(self): pass\n';
  return [
    { name: 'short-preview', text: 'class ExampleType: owner: OwnerType; tail: TailReference', query: 'tail' },
    { name: '10025-lines-tail-type', text, query: 'tailreference' },
    { name: '10025-lines-tail-callable', text, query: 'late_callable' },
    { name: '10025-lines-absent', text, query: 'doesnotexist' },
    { name: '10025-lines-empty', text, query: '' },
    { name: '300000-character-identifier', text: 'X'.repeat(300000) + 'TailReference\nTailReference', query: 'tailreference' },
    { name: 'dense-early-matches', text: Array.from({ length: 2000 }, (_, i) => 'CandidateType' + i).join('\n'), query: 'candidate' },
    { name: 'long-near-miss-query', text: 'A'.repeat(200000), query: 'a'.repeat(1000) + 'b' },
  ];
}

async function main() {
  const sources = variants();
  const run = Object.fromEntries(['baseline', 'current'].map(name => [name, vm.runInNewContext(sources[name])(fn => fn())]));
  const inputs = cases();
  for (const input of inputs) {
    const before = await run.baseline(input), after = await run.current(input);
    assert.equal(JSON.stringify(after.result), JSON.stringify(before.result), 'Result mismatch: ' + JSON.stringify({ ...input, text: input.text.slice(0,300) }));
  }
  for (const query of ['', 'tailreference', 'late_callable', '.*']) {
    const input = { ...workloads()[1], query, cancelAtYield: 1 };
    assert.equal(JSON.stringify((await run.current(input)).result), JSON.stringify((await run.baseline(input)).result));
  }
  const rows = [];
  for (const input of workloads()) {
    const samples = { baseline: [], current: [] }, yields = {};
    for (let pass = -2; pass < 7; pass++) {
      for (const name of pass % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const start = performance.now();
        const result = await run[name](input);
        if (pass >= 0) { samples[name].push(performance.now() - start); }
        yields[name] = result.yields;
      }
    }
    const median = a => a.sort((x,y)=>x-y)[3];
    rows.push({ name: input.name, chars: input.text.length, baselineMs: median(samples.baseline), currentMs: median(samples.current), yields });
  }
  const report = { ...sources.metadata, scope: 'Node VM scan microbenchmark; timer delay excluded; not UI latency, CPU utilization or RSS', equivalenceCases: inputs.length + 4, rows };
  if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { variants, workloads, factorySource, cases };
if (require.main === module) {
  if (process.argv[2] === '--freeze-baseline') { freezeBaseline(); }
  else { main().catch(error => { console.error(error); process.exitCode = 1; }); }
}
