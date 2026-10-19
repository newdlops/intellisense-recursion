const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const ts = require(root + '/node_modules/typescript');
// Construct the renderer string without loading VS Code's unrelated URI API.
const rendererContext = vm.createContext({exports:{},require(name){
  if(name==='./preview-file-link')return {parsePreviewFileLink:function parsePreviewFileLink(){}};
  throw new Error('Unexpected dependency: '+name);
}});
vm.runInContext(fs.readFileSync(root+'/out/renderer-patch.js','utf8'),rendererContext);
const script = rendererContext.exports.getHoverPatchScript();
const ast = ts.createSourceFile('renderer.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set([
  'irCollectTypeShapedCandidates', 'irPrimaryHoverLinkName', 'irConstantHoverLinkName',
  'irTypeShapedName', 'irAddHoverLinkName',
]);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
    functions.set(node.name.text, node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (functions.size !== names.size) throw new Error('Missing source function');
const current = [...functions.values()].join('\n');
const splitLine = 'var lines=src.split(/\\n/);';
const limitedSplitLine = 'var lines=src.split(/\\n/,maxLines);';
const original = current.replace(limitedSplitLine, splitLine);
if (!original.includes(splitLine)) throw new Error('Source split changed');
const limitedSource = original.replace(splitLine, limitedSplitLine);
const alternative = original.replace(splitLine, `var lines=[]; var offset=0;
while(lines.length<maxLines && offset<maxChars && offset<=src.length){
  var end=src.indexOf(String.fromCharCode(10),offset);
  if(end<0){lines.push(src.slice(offset));break;}
  lines.push(src.slice(offset,end));offset=end+1;
}`);
function load(source) {
  const context = vm.createContext({});
  vm.runInContext('var IR_HOVER_LINK_MAX_CONSTANTS=80,IR_HOVER_LINK_MAX_TYPES=240;\n'+source, context);
  return text => {
    const types = [];
    context.irCollectTypeShapedCandidates(text, {}, types, {}, 50000, 900);
    return types;
  };
}
const baseline = load(original), bounded = load(alternative), limited = load(limitedSource);
function median(fn, text, iterations) {
  const samples=[];
  for(let warm=0;warm<3;warm++)fn(text);
  for(let pass=0;pass<7;pass++){
    const start=performance.now();
    for(let i=0;i<iterations;i++)fn(text);
    samples.push((performance.now()-start)/iterations);
  }
  return samples.sort((a,b)=>a-b)[3];
}
const equivalenceCases = [
  '', 'class OneThing:\n  owner: OtherThing\n',
  'class AThing:\r\n  owner: BThing\r\n',
  'LongThing '.repeat(7000)+'\nTailThing',
  Array.from({length:1100},(_,i)=>'TypeName'+i).join('\n'),
];
for(const input of equivalenceCases){
  if(JSON.stringify(baseline(input))!==JSON.stringify(bounded(input)))throw new Error('Candidate mismatch');
  if(JSON.stringify(baseline(input))!==JSON.stringify(limited(input)))throw new Error('Limited split candidate mismatch');
}
const rows=[];
for(const lines of [1000,10000,100000]){
  const text='class ExampleType:\n    owner: OwnerType\n'+('    # explanation and source text without new identifier names\n'.repeat(lines));
  if(JSON.stringify(baseline(text))!==JSON.stringify(bounded(text)))throw new Error('Workload mismatch');
  if(JSON.stringify(baseline(text))!==JSON.stringify(limited(text)))throw new Error('Limited split workload mismatch');
  rows.push({lines:lines+2,chars:text.length,baselineMs:median(baseline,text,10),boundedMs:median(bounded,text,10),limitedMs:median(limited,text,10)});
}
const report={scope:'Node utility microbenchmark of the current renderer function; not browser latency or RSS',candidateLimit:{chars:50000,lines:900},equivalenceCases:equivalenceCases.length+rows.length,rows};
fs.writeFileSync(process.argv[2] || path.join(__dirname, 'candidate-benchmark.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
