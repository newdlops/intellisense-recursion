import * as vscode from 'vscode';
import * as inspector from 'node:inspector';
import WebSocket from 'ws';

const log = vscode.window.createOutputChannel('IntelliSense Recursion', { log: true });

const lastPreviewLocations = new Map<string, vscode.Location>();
let lastHoverDocUri = '';
let hoverRecursionDepth = 0;
let reinjectTimer: ReturnType<typeof setInterval> | undefined;

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activating...');

  context.subscriptions.push(
    vscode.commands.registerCommand('intellisenseRecursion.goToType', goToTypeHandler)
  );

  // Patch $provideHover on shared ExtHostLanguageFeatures
  const sharedService = findSharedHoverService();
  if (sharedService) {
    patchSharedService(sharedService);
  } else {
    log.warn('Could not find shared ExtHostLanguageFeatures');
  }

  // Inject renderer script + re-inject periodically for new windows
  await injectRenderer();
  reinjectTimer = setInterval(() => { reinjectRenderer().catch(() => {}); }, 10000);

  log.info('Extension activated');
}

// ── V8 Inspector: extract shared ExtHostLanguageFeatures ──

function findSharedHoverService(): any | null {
  try {
    const session = new inspector.Session();
    session.connect();
    (globalThis as any).__irFn = vscode.languages.registerHoverProvider;

    session.post('Runtime.evaluate', { expression: '__irFn', returnByValue: false }, (err, evalResult: any) => {
      if (err || !evalResult?.result?.objectId) { return; }
      session.post('Runtime.getProperties', { objectId: evalResult.result.objectId, ownProperties: false, accessorPropertiesOnly: false }, (err2, propsResult: any) => {
        if (err2) { return; }
        const scopesProp = propsResult?.internalProperties?.find((p: any) => p.name === '[[Scopes]]');
        if (!scopesProp?.value?.objectId) { return; }
        session.post('Runtime.getProperties', { objectId: scopesProp.value.objectId }, (err3, scopesResult: any) => {
          if (err3) { return; }
          for (const entry of (scopesResult?.result || [])) {
            if (!entry.value?.objectId) { continue; }
            session.post('Runtime.getProperties', { objectId: entry.value.objectId }, (err4, varsResult: any) => {
              if (err4) { return; }
              for (const v of (varsResult?.result || [])) {
                if (v.name === 'et' && v.value?.objectId) {
                  session.post('Runtime.callFunctionOn', {
                    objectId: v.value.objectId,
                    functionDeclaration: 'function() { globalThis.__irEt = this; }',
                  }, () => {});
                }
              }
            });
          }
        });
      });
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { session.post('Runtime.evaluate', { expression: '1' }, () => {}); } catch {}
      if ((globalThis as any).__irEt) { break; }
    }

    session.disconnect();
    delete (globalThis as any).__irFn;

    const et = (globalThis as any).__irEt;
    if (et && '$provideHover' in et) {
      log.info('Found shared ExtHostLanguageFeatures');
      return et;
    }
  } catch (err) {
    log.error(`V8 Inspector error: ${err}`);
  }
  return null;
}

// ── Patch $provideHover ──

function patchSharedService(service: any) {
  const original = service.$provideHover;

  service.$provideHover = async function (handle: number, uri: any, position: any, context: any, token: any) {
    const result = await original.call(this, handle, uri, position, context, token);
    if (!result?.contents?.length) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    // Extract PascalCase types from code fences
    const types: string[] = [];
    for (const content of result.contents) {
      if (!content || typeof content.value !== 'string') { continue; }
      const fence = content.value.match(/```\w*\n?([\s\S]*?)```/);
      if (fence) { types.push(...findTypeNames(fence[1].trim())); }
    }
    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length === 0) { return result; }

    const docUriStr = uri?.scheme ? `${uri.scheme}://${uri.authority || ''}${uri.path}` : String(uri);
    lastHoverDocUri = docUriStr;

    // Resolve definition previews for types (with hover fallback for doc-only symbols)
    hoverRecursionDepth++;
    try {
      const docUri = vscode.Uri.parse(docUriStr);
      const doc = await vscode.workspace.openTextDocument(docUri);
      const docText = doc.getText();
      const previews: string[] = [];
      const resolvedDefDocs: { uri: vscode.Uri; doc: vscode.TextDocument }[] = [];

      for (const typeName of uniqueTypes.slice(0, 3)) {
        const regex = new RegExp(`\\b${esc(typeName)}\\b`);
        let match = regex.exec(docText);
        let matchUri = docUri;
        let matchDoc = doc;

        // If not found in hovered doc, search already-resolved definition files
        if (!match) {
          for (const rd of resolvedDefDocs) {
            match = regex.exec(rd.doc.getText());
            if (match) { matchUri = rd.uri; matchDoc = rd.doc; break; }
          }
          if (!match) { continue; }
        }

        const pos = matchDoc.positionAt(match.index);
        const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', matchUri, pos);

        if (defs?.length && defs[0]?.uri && defs[0]?.range?.start) {
          // Definition found → show file preview (existing)
          const def = defs[0];
          const defDoc = await vscode.workspace.openTextDocument(def.uri);
          resolvedDefDocs.push({ uri: def.uri, doc: defDoc });
          const startLine = def.range.start.line;
          const endLine = Math.min(startLine + 15, defDoc.lineCount);
          const lines: string[] = [];
          for (let i = startLine; i < endLine; i++) { lines.push(defDoc.lineAt(i).text); }
          const previewCode = lines.join('\n');
          const relPath = vscode.workspace.asRelativePath(def.uri);
          const lang = defDoc.languageId || 'python';

          previews.push(`\`${typeName}\` — *${relPath}:${startLine + 1}*\n\`\`\`${lang}\n${previewCode}\n\`\`\``);

          // Store preview location for all identifiers in preview code
          const previewLoc = new vscode.Location(def.uri, new vscode.Range(startLine, 0, endLine, 0));
          lastPreviewLocations.set(typeName, previewLoc);
          const previewIds = previewCode.match(/([a-zA-Z_][a-zA-Z0-9_]{2,})/g) || [];
          for (const pid of previewIds) { lastPreviewLocations.set(pid, previewLoc); }
        } else {
          // No definition → hover fallback (recursive: doc preview)
          try {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
              'vscode.executeHoverProvider', matchUri, pos
            );
            if (hovers?.length) {
              const hoverParts: string[] = [];
              for (const h of hovers) {
                for (const c of (h.contents as any[])) {
                  const val = typeof c === 'string' ? c
                    : c instanceof vscode.MarkdownString ? c.value
                    : (c && typeof c.value === 'string') ? c.value
                    : null;
                  if (val) { hoverParts.push(val); }
                }
              }
              if (hoverParts.length > 0) {
                previews.push(`\`${typeName}\` — *doc*\n${hoverParts.join('\n')}`);
                const hoverLoc = new vscode.Location(matchUri, new vscode.Range(pos, pos));
                lastPreviewLocations.set(typeName, hoverLoc);
                // Extract identifiers from hover content for click tracking
                const hoverText = hoverParts.join('\n');
                const hoverIds = hoverText.match(/([a-zA-Z_][a-zA-Z0-9_]{2,})/g) || [];
                for (const hid of hoverIds) { lastPreviewLocations.set(hid, hoverLoc); }
              }
            }
          } catch (hoverErr) {
            log.warn(`Hover fallback error for ${typeName}: ${hoverErr}`);
          }
        }
      }

      if (previews.length > 0) {
        const newContents = [...result.contents];
        for (let ci = 0; ci < newContents.length; ci++) {
          if (newContents[ci]?.value && typeof newContents[ci].value === 'string') {
            newContents[ci] = { ...newContents[ci], value: newContents[ci].value + '\n\n---\n' + previews.join('\n\n---\n') };
            break;
          }
        }
        return { ...result, contents: newContents };
      }
    } catch (err) {
      log.error(`Preview error: ${err}`);
    } finally {
      hoverRecursionDepth--;
    }
    return result;
  };

  log.info('$provideHover patched');
}

// ── Renderer injection via main process CDP ──

async function injectRenderer() {
  try {
    log.info('[inject] Starting renderer injection...');
    const { execSync } = require('child_process');
    const psOutput = execSync('ps aux | grep "[V]isual Studio Code.app/Contents/MacOS/Code$" || true', { encoding: 'utf8' });
    const pidMatch = psOutput.match(/\S+\s+(\d+)/);
    if (!pidMatch) {
      log.warn('[inject] Could not find main VS Code process via ps aux');
      return;
    }
    const mainPid = parseInt(pidMatch[1]);
    log.info(`[inject] Main process PID: ${mainPid}`);

    process.kill(mainPid, 'SIGUSR1');
    log.info('[inject] SIGUSR1 sent, waiting for inspector...');
    await new Promise(r => setTimeout(r, 500));

    const targetsJson = await httpGet('http://127.0.0.1:9229/json/list');
    const targets = JSON.parse(targetsJson);
    log.info(`[inject] CDP targets: ${targets.length}`);
    if (!targets.length || !targets[0].webSocketDebuggerUrl) {
      log.warn('[inject] No CDP WebSocket URL found');
      return;
    }
    log.info(`[inject] Connecting WebSocket...`);
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);

    await new Promise<void>((resolve) => {
      let msgId = 1;
      let evalMsgId = -1;
      ws.on('open', () => {
        // Enable Runtime events & add main-process binding for instant click notification
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.addBinding', params: { name: 'irClickNotify' } }));

        const patchB64 = Buffer.from(getHoverPatchScript()).toString('base64');
        const evalExpr = "eval(atob('" + patchB64 + "'))";

        const injectScript = `
          (async function() {
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var results = [];
            for (var i = 0; i < wins.length; i++) {
              var w = wins[i];
              try {
                try { w.webContents.debugger.detach(); } catch(e2) {}
                w.webContents.debugger.attach('1.3');
                await w.webContents.debugger.sendCommand('Runtime.enable');
                var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)} });
                if (r.result && (r.result.value === 'hover patch installed' || r.result.value === 'already patched')) {
                  results.push('injected:' + w.id + '(' + r.result.value + ')');
                  try {
                    await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: 'irGoToType' });
                    w.webContents.debugger.on('message', function(event, method, params) {
                      if (method === 'Runtime.bindingCalled' && params.name === 'irGoToType') {
                        if(typeof global.irClickNotify==='function'){global.irClickNotify(params.payload)}
                      }
                    });
                    results.push('binding:' + w.id + ':ok');
                  } catch(eb) { results.push('binding:' + w.id + ':' + eb.message); }
                } else {
                  results.push('skip:' + w.id + '(' + (r.result ? r.result.value : 'no result') + ')');
                  w.webContents.debugger.detach();
                }
              } catch(e) { results.push('err:' + w.id + ':' + e.message); }
            }
            return results.join(' | ');
          })()
        `.trim();

        evalMsgId = msgId++;
        ws.send(JSON.stringify({ id: evalMsgId, method: 'Runtime.evaluate', params: { expression: injectScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }));
      });

      let done = false;
      ws.on('message', (data: string) => {
        try {
          const resp = JSON.parse(data);
          if (resp.id === evalMsgId && !done) {
            done = true;
            const val = resp.result?.result?.value;
            if (val) { log.info(`Renderer injection: ${val}`); }
            startClickListener(ws);
            resolve();
          }
        } catch {}
      });
      ws.on('error', () => { resolve(); });
      setTimeout(() => { resolve(); }, 10000);
    });
  } catch (err) {
    log.error(`Renderer injection error: ${err}`);
  }
}

async function reinjectRenderer() {
  try {
    const targetsJson = await httpGet('http://127.0.0.1:9229/json/list');
    const targets = JSON.parse(targetsJson);
    if (!targets.length || !targets[0].webSocketDebuggerUrl) { return; }

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        const patchB64 = Buffer.from(getHoverPatchScript()).toString('base64');
        const evalExpr = "eval(atob('" + patchB64 + "'))";
        const injectScript = `
          (async function() {
            var BW = require('electron').BrowserWindow;
            var wins = BW.getAllWindows();
            var n = 0;
            for (var i = 0; i < wins.length; i++) {
              try {
                wins[i].webContents.debugger.attach('1.3');
                var r = await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(evalExpr)} });
                if (r.result && r.result.value === 'hover patch installed') n++;
                wins[i].webContents.debugger.detach();
              } catch(e) {}
            }
            return n;
          })()
        `.trim();
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: injectScript, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true } }));
      });
      ws.on('message', (data: string) => {
        try {
          const resp = JSON.parse(data);
          if (resp.id === 1) {
            const n = resp.result?.result?.value;
            if (n && n > 0) { log.info(`Re-injected into ${n} window(s)`); }
            ws.close();
            resolve();
          }
        } catch {}
      });
      ws.on('error', () => { resolve(); });
      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 3000);
    });
  } catch {}
}

function startClickListener(mainWs: any) {
  log.info('[listen] Click event listener started (binding-driven)');

  mainWs.on('message', (data: string) => {
    try {
      const resp = JSON.parse(data);
      if (resp.method === 'Runtime.bindingCalled' && resp.params?.name === 'irClickNotify') {
        const val = String(resp.params.payload);
        if (val.startsWith('LOG:')) { log.info(`[renderer] ${val.slice(4)}`); return; }
        log.info(`Click: "${val}"`);
        const editor = vscode.window.activeTextEditor;
        if (editor) { goToTypeHandler(editor.document.uri.toString(), val); }
      }
    } catch {}
  });
}

function httpGet(url: string): Promise<string> {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Renderer patch script ──

function getHoverPatchScript(): string {
  return `(function(){
if(window.__irHoverPatched)return 'already patched';
window.__irHoverPatched=true;

function irLog(msg){if(typeof window.irGoToType==='function')window.irGoToType('LOG:'+msg)}
irLog('renderer: patch installing');

var style=document.createElement('style');
style.textContent='.ir-type-link{cursor:default}body.ir-cmd-held .ir-type-link:hover{text-decoration:underline !important;cursor:pointer !important;color:var(--vscode-textLink-foreground) !important}';
document.head.appendChild(style);
irLog('renderer: CSS injected');

document.addEventListener('keydown',function(e){if(e.metaKey||e.ctrlKey)document.body.classList.add('ir-cmd-held')});
document.addEventListener('keyup',function(e){if(!e.metaKey&&!e.ctrlKey)document.body.classList.remove('ir-cmd-held')});
irLog('renderer: key listeners added');

document.addEventListener('click',function(e){
  if(!(e.metaKey||e.ctrlKey))return;
  var t=e.target;
  if(!t||!t.classList||!t.classList.contains('ir-type-link'))return;
  var typeName=t.getAttribute('data-type');
  if(!typeName)return;
  e.preventDefault();e.stopPropagation();
  irLog('renderer: click on "'+typeName+'"');
  if(typeof window.irGoToType==='function'){window.irGoToType(typeName)}
  else{irLog('renderer: irGoToType binding not available!')}
},true);

var irScanCount=0;
var irWrapCount=0;
var irLastContainerCount=0;

setInterval(function(){
  var containers=document.querySelectorAll('.rendered-markdown');
  if(containers.length!==irLastContainerCount){
    irLog('renderer: scan containers='+containers.length+' (was '+irLastContainerCount+')');
    irLastContainerCount=containers.length;
  }
  for(var j=0;j<containers.length;j++){var block=containers[j];
    if(block.querySelector('.ir-type-link'))continue;
    var text=block.textContent||'';
    if(text.length<3)continue;
    var skip={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'True':1,'False':1,'None':1,'self':1,'cls':1,'str':1,'int':1,'float':1,'bool':1,'list':1,'dict':1,'tuple':1,'set':1,'type':1,'bytes':1,'object':1,'property':1,'staticmethod':1,'classmethod':1,'super':1,'print':1,'len':1,'range':1,'isinstance':1,'hasattr':1,'getattr':1,'setattr':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'final':1,'native':1,'volatile':1,'synchronized':1,'transient':1,'null':1,'undefined':1,'true':1,'false':1,'number':1,'string':1,'boolean':1,'any':1,'never':1,'unknown':1,'symbol':1,'bigint':1,'sizeof':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'char':1,'short':1,'long':1,'double':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'typename':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'return':1,'throws':1,'since':1,'see':1,'deprecated':1};
    var re=/([a-zA-Z_][a-zA-Z0-9_]{2,})/g;
    var m,types=[];
    while(m=re.exec(text)){if(types.indexOf(m[1])<0&&!skip[m[1]])types.push(m[1])}
    if(!types.length)continue;
    irScanCount++;
    irLog('renderer: scan#'+irScanCount+' block['+j+'] types=['+types.slice(0,5).join(',')+']'+(types.length>5?' +'+( types.length-5)+' more':''));
    var walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    var node,replacements=[];
    while(node=walker.nextNode()){
      var nv=node.nodeValue||'';
      for(var k=0;k<types.length;k++){
        var idx=nv.indexOf(types[k]);
        if(idx>=0){
          var wc=/[a-zA-Z0-9_]/;
          var before=idx>0?nv[idx-1]:'';
          var afterC=nv[idx+types[k].length]||'';
          if(!afterC&&node.nextSibling){var ns=node.nextSibling.textContent||'';afterC=ns[0]||''}
          if(!before&&node.previousSibling){var ps=node.previousSibling.textContent||'';before=ps[ps.length-1]||''}
          if(!wc.test(before)&&!wc.test(afterC)){replacements.push({node:node,type:types[k],idx:idx})}
          else{irLog('renderer: boundary reject "'+types[k]+'" before="'+before+'" after="'+afterC+'"')}
        }
      }
    }
    irLog('renderer: scan#'+irScanCount+' replacements='+replacements.length);
    for(var r2=replacements.length-1;r2>=0;r2--){
      var rep=replacements[r2];
      try{
        var after=rep.node.splitText(rep.idx);
        var rest=after.splitText(rep.type.length);
        var span=document.createElement('span');
        span.className='ir-type-link';
        span.setAttribute('data-type',rep.type);
        after.parentNode.insertBefore(span,after);
        span.appendChild(after);
        irWrapCount++;
      }catch(e2){irLog('renderer: wrap error "'+rep.type+'": '+e2.message)}
    }
    if(replacements.length>0)irLog('renderer: total wrapped='+irWrapCount);
  }
},100);

irLog('renderer: setInterval started');
return 'hover patch installed';
})()`;
}

// ── Type detection (for $provideHover preview) ──

const SKIP_WORDS = new Set([
  'str', 'bool', 'dict', 'list', 'tuple', 'set', 'frozenset', 'bytes',
  'int', 'float', 'double', 'char', 'byte', 'short', 'long',
  'string', 'number', 'boolean', 'void', 'any', 'null', 'undefined',
  'never', 'unknown', 'object', 'symbol', 'bigint', 'true', 'false',
  'String', 'Number', 'Boolean', 'Object', 'Symbol', 'Function',
  'None', 'True', 'False', 'Optional', 'Union', 'Literal', 'Final',
  'Callable', 'Any', 'Type', 'ClassVar', 'Protocol', 'TypeVar',
  'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'super', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'of', 'in',
  'async', 'await', 'yield', 'throw', 'try', 'catch', 'finally',
  'def', 'self', 'pass', 'with', 'isinstance', 'property',
  'public', 'private', 'protected', 'static', 'abstract',
]);

function findTypeNames(text: string): string[] {
  const ids = text.match(/\b[A-Za-z_]\w*\b/g) || [];
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id) || !/^[A-Z]/.test(id) || SKIP_WORDS.has(id) || id.length <= 1) return false;
    seen.add(id);
    return true;
  });
}

// ── Go to definition handler ──

async function goToTypeHandler(docUriStr: string, identifier: string) {
  log.info(`goToType: "${identifier}"`);
  const t0 = Date.now();
  const regex = new RegExp(`\\b${esc(identifier)}\\b`);

  // Build priority doc list, then append all open docs
  const priorityUris: string[] = [];
  const previewLoc = lastPreviewLocations.get(identifier);
  if (previewLoc?.uri) {
    priorityUris.push(previewLoc.uri.toString());
    log.info(`  [1] preview doc: ${vscode.workspace.asRelativePath(previewLoc.uri)}`);
  } else {
    log.info(`  [1] no preview location (map size=${lastPreviewLocations.size})`);
  }
  if (lastHoverDocUri) { priorityUris.push(lastHoverDocUri); }
  if (docUriStr) { priorityUris.push(docUriStr); }
  const editor = vscode.window.activeTextEditor;
  if (editor) { priorityUris.push(editor.document.uri.toString()); }

  // Merge priority + all open docs (priority first, deduped)
  const seen = new Set<string>();
  const allDocs: vscode.TextDocument[] = [];
  for (const uriStr of priorityUris) {
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    try { allDocs.push(await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr))); } catch {}
  }
  for (const openDoc of vscode.workspace.textDocuments) {
    const uriStr = openDoc.uri.toString();
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    allDocs.push(openDoc);
  }

  log.info(`  [2] searching ${allDocs.length} doc(s)`);

  // Fast text scan → first hit gets definitionProvider call
  for (let di = 0; di < allDocs.length; di++) {
    const doc = allDocs[di];
    try {
      const m = regex.exec(doc.getText());
      if (!m) { continue; }

      const pos = doc.positionAt(m.index);
      const relPath = vscode.workspace.asRelativePath(doc.uri);
      log.info(`  [2.${di}] found in ${relPath}:${pos.line}, calling definitionProvider...`);
      const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, pos);
      log.info(`  [2.${di}] definitionProvider returned ${defs?.length || 0} result(s) (${Date.now() - t0}ms)`);

      if (defs?.length && defs[0]?.uri && defs[0]?.range) {
        log.info(`→ ${defs[0].uri.fsPath}:${defs[0].range.start.line} (${Date.now() - t0}ms)`);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(defs[0].uri), {
          selection: defs[0].range, preserveFocus: false
        });
        return;
      }

      // Definition provider returned nothing — open at identifier position
      log.info(`→ ${relPath}:${pos.line} (identifier position, ${Date.now() - t0}ms)`);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preserveFocus: false });
      return;
    } catch (err) {
      log.warn(`  [2.${di}] error: ${err}`);
    }
  }

  // Workspace symbols
  log.info(`  [3] trying workspace symbols... (${Date.now() - t0}ms)`);
  try {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', identifier);
    log.info(`  [3] workspace returned ${symbols?.length || 0} symbol(s) (${Date.now() - t0}ms)`);
    const exact = symbols?.find(s => s.name === identifier);
    if (exact?.location?.uri && exact.location.range) {
      log.info(`→ ${exact.location.uri.fsPath}:${exact.location.range.start.line} (workspace, ${Date.now() - t0}ms)`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(exact.location.uri), {
        selection: exact.location.range, preserveFocus: false
      });
      return;
    }
    if (symbols?.length) {
      log.info(`  [3] no exact match. Candidates: ${symbols.slice(0, 5).map(s => s.name).join(', ')}`);
    }
  } catch (err) {
    log.warn(`  [3] workspace error: ${err}`);
  }

  // Hover fallback — navigate and trigger hover for doc-only symbols
  log.info(`  [4] trying hover fallback... (${Date.now() - t0}ms)`);
  for (const doc of allDocs) {
    try {
      const m = regex.exec(doc.getText());
      if (!m) { continue; }
      const pos = doc.positionAt(m.index);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      if (hovers?.length) {
        log.info(`→ hover at ${vscode.workspace.asRelativePath(doc.uri)}:${pos.line} (${Date.now() - t0}ms)`);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preserveFocus: false });
        await vscode.commands.executeCommand('editor.action.showHover');
        return;
      }
    } catch {}
  }

  log.warn(`"${identifier}" not found (${Date.now() - t0}ms)`);
}

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function deactivate() {
  if (reinjectTimer) { clearInterval(reinjectTimer); }
  log.info('Extension deactivated');
  log.dispose();
}
