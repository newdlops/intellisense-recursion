/** Verify production renderer startup/reinjection delegates lifecycle ownership and reuses clients. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
const source=fs.readFileSync(path.resolve(__dirname,'../../../src/extension.ts'),'utf8');
const tree=ts.createSourceFile('extension.ts',source,ts.ScriptTarget.Latest,true);
const names=['injectRenderer','reinjectRenderer','cleanupRendererInjection'],bodies:string[]=[];
function visit(node:ts.Node):void{if(ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text)){bodies.push(node.getText(tree));}ts.forEachChild(node,visit);}
visit(tree);assert.equal(bodies.length,names.length);
const script=ts.transpileModule(bodies.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
function context(extra:Record<string,unknown>):any{
  const opened:string[]=[];
  class Socket{static OPEN=1;constructor(url:string){opened.push(url);throw Error('stop before connection');}}
  const sandbox=vm.createContext({WebSocket:Socket,extensionDeactivated:false,isTestRendererDebugMode:()=>false,
    rendererUserDataDirHint:null,extensionRunsInTestMode:false,findCurrentVSCodeMainPid:()=>4242,
    log:{info(){},warn(){},error(){}},process:{kill:()=>assert.fail('uncoordinated signal')},...extra});
  vm.runInContext(script,sandbox,{timeout:1000});(sandbox as any).opened=opened;return sandbox;
}
test('production startup discovers an existing main inspector without any signal or startup delay',async()=>{
  let discovered=0,coordinated=0;
  const runtime=context({findInspectorWebSocketUrlForPid:async()=>{discovered++;return'ws://127.42.7.9:43123/id';},
    acquireMainInspector:async(pid:number,options:any)=>{assert.equal(pid,4242);coordinated++;return options.discover();},
    setTimeout:()=>assert.fail('unnecessary activation delay')});
  await runtime.injectRenderer();assert.equal(coordinated,1);assert.equal(discovered,1);
  assert.deepEqual(runtime.opened,['ws://127.42.7.9:43123/id']);
});
test('periodic reinjection reuses the active endpoint without signalling, waiting or discovery',async()=>{
  const runtime=context({mainWsRef:{readyState:1},mainWsRefTargetUrl:'ws://127.42.7.9:43123/id',
    findInspectorWebSocketUrlForPid:()=>assert.fail('warm endpoint rescan'),setTimeout:()=>assert.fail('warm delay')});
  await runtime.reinjectRenderer();
  assert.deepEqual(runtime.opened,['ws://127.42.7.9:43123/id']);
});
test('a lost client uses the coordinated startup path rather than signalling directly',async()=>{
  let coordinated=0;
  const runtime=context({mainWsRef:null,findInspectorWebSocketUrlForPid:async()=>null,
    acquireMainInspector:async()=>{coordinated++;throw Error('unavailable');}});
  await runtime.reinjectRenderer();assert.equal(coordinated,1);
});

test('deactivation cleans only the last owned renderer and preserves peer/shared-workspace owners',async()=>{
  const owner='111:primary',peer='222:peer';
  const ownership=new Map([[1,new Set([owner])],[2,new Set([peer])],[3,new Set([owner,peer])]]);
  const bridges=new Map<number,unknown>([[1,{}],[2,{}],[3,{}],[4,{}]]);
  const cleaned:number[]=[],removed:number[]=[];
  const windows=[1,2,3,4].map(id=>({id,webContents:{debugger:{isAttached:()=>true,
    attach:()=>assert.fail('cleanup must not attach a debugger'),
    sendCommand:async()=>{cleaned.push(id);},removeListener:()=>removed.push(id)}}}));
  let listener:(data:string)=>void=()=>{};
  const ws={readyState:1,on:(_name:string,fn:typeof listener)=>{listener=fn;},off(){},send(data:string){
    const request=JSON.parse(data);
    const result=vm.runInNewContext(request.params.expression,{require:()=>({BrowserWindow:{getAllWindows:()=>windows}}),
      global:{__irRendererOwners:ownership,__irGoToTypeBridgeListeners:bridges},
      process:{kill:(pid:number,signal:number)=>{assert.equal(pid,222);assert.equal(signal,0);}}});
    void result.then((value:number)=>listener(JSON.stringify({id:request.id,result:{result:{value}}})));
  }};
  const runtime=context({mainWsRef:ws,mainWsRefIsRendererTarget:false,rendererOwnerId:owner,setTimeout,clearTimeout});
  await runtime.cleanupRendererInjection('deactivate');
  assert.deepEqual(cleaned,[1]);assert.deepEqual(removed,[1]);
  assert.equal(ownership.has(1),false);assert.deepEqual([...ownership.get(3)!],[peer]);
  assert.deepEqual([...bridges.keys()],[2,3,4]);
});
