import * as vscode from 'vscode';
import * as inspector from 'node:inspector';
import WebSocket from 'ws';

const log = vscode.window.createOutputChannel('IntelliSense Recursion', { log: true });

const lastPreviewLocations = new Map<string, vscode.Location>();
let lastHoverDocUri = '';
let hoverRecursionDepth = 0;
let reinjectTimer: ReturnType<typeof setInterval> | undefined;
let lastClickId = '';
let lastClickTime = 0;
let goToTypeBusy = false;
let hoverPatchActive = false;
let lastPreviewKey = '';
let lastPreviewTime = 0;

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activating...');

  context.subscriptions.push(
    vscode.commands.registerCommand('intellisenseRecursion.goToType', goToTypeHandler),
    vscode.commands.registerCommand('intellisenseRecursion.getPatchStatus', () => ({
      hoverPatchActive,
      hoverRecursionDepth,
    }))
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
                if (v.value?.objectId) {
                  session.post('Runtime.callFunctionOn', {
                    objectId: v.value.objectId,
                    functionDeclaration: 'function() { if (typeof this.$provideHover === "function") { globalThis.__irEt = this; } }',
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
    const hoverT0 = Date.now();
    const fileName = (uri?.path || '').split('/').pop() || '?';
    // Internal position format: {lineNumber, column} (1-based) vs VS Code API {line, character} (0-based)
    const posLine = position?.lineNumber ?? position?.line;
    const posChar = position?.column ?? position?.character;
    const result = await original.call(this, handle, uri, position, context, token);
    if (!result?.contents?.length) { return result; }
    if (hoverRecursionDepth > 1) { return result; }

    // Dedup: only add previews once per hover position (multiple handles are called for the same hover event)
    const posKey = `${uri?.path || uri}:${position?.line}:${position?.character}`;
    const now = Date.now();
    if (posKey === lastPreviewKey && now - lastPreviewTime < 200) {
      return result;
    }

    // Extract PascalCase types from code fences
    const types: string[] = [];
    for (const content of result.contents) {
      if (!content || typeof content.value !== 'string') { continue; }
      const fence = content.value.match(/```\w*\n?([\s\S]*?)```/);
      if (fence) { types.push(...findTypeNames(fence[1].trim())); }
    }
    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length === 0) { return result; }

    const hoverMs = () => `${Date.now() - hoverT0}ms`;
    log.info(`[hover] ${fileName}:${posLine}:${posChar} handle=${handle} types=[${uniqueTypes.join(',')}] (${hoverMs()})`);

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
        const typeT0 = Date.now();
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
          if (!match) {
            log.info(`[hover]   "${typeName}" not found in docs (${hoverMs()})`);
            continue;
          }
        }

        const pos = matchDoc.positionAt(match.index);
        log.info(`[hover]   "${typeName}" → defProvider ${vscode.workspace.asRelativePath(matchUri)}:${pos.line + 1} (${hoverMs()})`);
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
          log.info(`[hover]   "${typeName}" → def ${relPath}:${startLine + 1} (${Date.now() - typeT0}ms)`);

          // Store preview location for type names in preview code (not all identifiers)
          const previewLoc = new vscode.Location(def.uri, new vscode.Range(startLine, 0, endLine, 0));
          lastPreviewLocations.set(typeName, previewLoc);
          const previewTypes = findTypeNames(previewCode);
          for (const pt of previewTypes) { lastPreviewLocations.set(pt, previewLoc); }
        } else {
          // No definition → hover fallback (recursive: doc preview)
          log.info(`[hover]   "${typeName}" → defProvider returned 0, trying hover fallback (${hoverMs()})`);
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
                log.info(`[hover]   "${typeName}" → hover fallback ok (${Date.now() - typeT0}ms)`);
                const hoverLoc = new vscode.Location(matchUri, new vscode.Range(pos, pos));
                lastPreviewLocations.set(typeName, hoverLoc);
                // Store only PascalCase type names from hover content (not all identifiers)
                const hoverText = hoverParts.join('\n');
                const hoverTypes = findTypeNames(hoverText);
                for (const ht of hoverTypes) { lastPreviewLocations.set(ht, hoverLoc); }
              } else {
                log.info(`[hover]   "${typeName}" → hover fallback empty (${Date.now() - typeT0}ms)`);
              }
            } else {
              log.info(`[hover]   "${typeName}" → no hover (${Date.now() - typeT0}ms)`);
            }
          } catch (hoverErr) {
            log.warn(`[hover]   "${typeName}" → hover error: ${hoverErr} (${Date.now() - typeT0}ms)`);
          }
        }
      }

      if (previews.length > 0) {
        lastPreviewKey = posKey;
        lastPreviewTime = now;

        const newContents = [...result.contents];
        for (let ci = 0; ci < newContents.length; ci++) {
          if (newContents[ci]?.value && typeof newContents[ci].value === 'string') {
            newContents[ci] = { ...newContents[ci], value: newContents[ci].value + '\n\n---\n' + previews.join('\n\n---\n') };
            break;
          }
        }
        log.info(`[hover] done: ${previews.length} preview(s) added (${hoverMs()})`);
        return { ...result, contents: newContents };
      }
      log.info(`[hover] done: no previews (${hoverMs()})`);
    } catch (err) {
      log.error(`[hover] error: ${err} (${hoverMs()})`);
    } finally {
      hoverRecursionDepth--;
    }
    return result;
  };

  hoverPatchActive = true;
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
        if (val.startsWith('LOG:')) { return; }

        // Debounce: ignore duplicate clicks for same identifier within 300ms
        const now = Date.now();
        if (val === lastClickId && now - lastClickTime < 300) { return; }
        lastClickId = val;
        lastClickTime = now;

        log.info(`Click: "${val}"`);
        const editor = vscode.window.activeTextEditor;
        if (editor) { goToTypeHandler(editor.document.uri.toString(), val); }
      }
    } catch {}
  });

  mainWs.on('close', () => {
    log.warn('[listen] CDP WebSocket closed — click listener lost. Will attempt reconnect...');
    setTimeout(() => {
      log.info('[listen] Attempting CDP reconnect...');
      injectRenderer().catch(err => log.error(`[listen] Reconnect failed: ${err}`));
    }, 2000);
  });

  mainWs.on('error', (err: any) => {
    log.warn(`[listen] CDP WebSocket error: ${err}`);
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
    var skip={'class':1,'def':1,'if':1,'else':1,'elif':1,'for':1,'while':1,'return':1,'import':1,'from':1,'as':1,'with':1,'try':1,'except':1,'finally':1,'raise':1,'pass':1,'break':1,'continue':1,'and':1,'or':1,'not':1,'is':1,'in':1,'lambda':1,'yield':1,'async':1,'await':1,'var':1,'let':1,'const':1,'function':1,'new':1,'delete':1,'typeof':1,'instanceof':1,'void':1,'this':1,'switch':1,'case':1,'default':1,'throw':1,'catch':1,'export':1,'extends':1,'implements':1,'interface':1,'enum':1,'abstract':1,'static':1,'public':1,'private':1,'protected':1,'readonly':1,'override':1,'struct':1,'union':1,'typedef':1,'extern':1,'register':1,'signed':1,'unsigned':1,'auto':1,'goto':1,'include':1,'define':1,'ifdef':1,'endif':1,'pragma':1,'namespace':1,'using':1,'template':1,'virtual':1,'inline':1,'constexpr':1,'nullptr':1,'the':1,'The':1,'that':1,'will':1,'are':1,'was':1,'has':1,'have':1,'can':1,'should':1,'may':1,'must':1,'been':1,'being':1,'does':1,'did':1,'its':1,'also':1,'than':1,'then':1,'when':1,'where':1,'which':1,'what':1,'how':1,'who':1,'all':1,'each':1,'every':1,'some':1,'any':1,'Returns':1,'Raises':1,'Args':1,'Parameters':1,'Note':1,'Example':1,'param':1,'throws':1,'since':1,'see':1,'deprecated':1,'alias':1,'overload':1,'module':1,'variable':1};
    var re=/([a-zA-Z_][a-zA-Z0-9_]{2,})/g;
    var m,types=[];
    while(m=re.exec(text)){var w=m[1];if(types.indexOf(w)<0&&!skip[w])types.push(w)}
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

// Only language keywords and documentation words — NOT type/variable names
const SKIP_WORDS = new Set([
  // Language keywords (not navigable)
  'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'super', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'of', 'in',
  'async', 'await', 'yield', 'throw', 'try', 'catch', 'finally',
  'def', 'self', 'pass', 'with', 'isinstance', 'property',
  'public', 'private', 'protected', 'static', 'abstract',
  'struct', 'union', 'typedef', 'extern', 'register',
  'virtual', 'inline', 'constexpr', 'namespace', 'using', 'template',
  // Documentation/markup words
  'the', 'The', 'that', 'will', 'are', 'was', 'has', 'have', 'can',
  'should', 'may', 'must', 'been', 'being', 'does', 'did', 'its',
  'also', 'than', 'then', 'when', 'where', 'which', 'what', 'how', 'who',
  'all', 'each', 'every', 'some', 'any', 'Returns', 'Raises', 'Args',
  'Parameters', 'Note', 'Example', 'param', 'throws', 'since', 'see',
  'deprecated', 'alias', 'overload', 'module', 'variable',
]);

function findTypeNames(text: string): string[] {
  const ids = text.match(/\b[A-Za-z_]\w*\b/g) || [];
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id) || SKIP_WORDS.has(id) || id.length <= 2) return false;
    seen.add(id);
    return true;
  });
}

// ── Go to definition handler ──

async function goToTypeHandler(docUriStr: string, identifier: string) {
  if (goToTypeBusy) { log.info(`goToType: "${identifier}" skipped (busy)`); return; }
  if (identifier.length <= 2) {
    log.info(`goToType: "${identifier}" skipped (too short)`);
    return;
  }
  goToTypeBusy = true;
  // Safety timeout: release busy flag after 15s even if goToTypeHandlerInner hangs
  const safetyTimer = setTimeout(() => {
    if (goToTypeBusy) {
      log.warn(`goToType: "${identifier}" safety timeout (15s) — releasing busy flag`);
      goToTypeBusy = false;
    }
  }, 15000);
  try { await goToTypeHandlerInner(docUriStr, identifier); } finally { goToTypeBusy = false; clearTimeout(safetyTimer); }
}

// Normalize defProvider result (Location or LocationLink) to {uri, range}
function normalizeDef(d: any): { uri: vscode.Uri; range: vscode.Range } | null {
  if (d.targetUri) {
    return { uri: d.targetUri, range: d.targetRange || d.targetSelectionRange };
  }
  if (d.uri && d.range) {
    return { uri: d.uri, range: d.range };
  }
  return null;
}

// Filter out non-code documents (logs, git buffers, output channels, etc.)
const CODE_SCHEMES = new Set(['file', 'untitled', 'vscode-userdata']);
function isCodeDoc(doc: vscode.TextDocument): boolean {
  if (!CODE_SCHEMES.has(doc.uri.scheme)) { return false; }
  const p = doc.uri.fsPath;
  if (p.endsWith('.log') || p.endsWith('.md') || p.endsWith('.git') || p.includes('/scm')) { return false; }
  return true;
}

// Definition-like line patterns (class/interface/struct/def/fn etc.)
const DEF_PATTERN = /^\s*(export\s+)?(class|interface|struct|enum|type|def|fn|func|pub\s+struct|pub\s+enum|pub\s+fn)\s+/;
// Assignment-style definitions (e.g. MutableMapping = _alias(...), X = TypeVar(...))
const ASSIGN_DEF_PATTERN_PREFIX = /^[A-Z]/;

// ── Import-follow engine: resolve identifier by tracing import statements ──

// Scan a file for a definition of identifier.
// Priority: class/interface > function/method > const/let/var > field/property > assignment
function findDefInText(text: string, identifier: string, doc: vscode.TextDocument): vscode.Position | null {
  const escaped = esc(identifier);
  const patterns: RegExp[] = [
    // 1. Class-level: class X, interface X, type X, enum X, struct X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:class|interface|type|enum|struct)[ \\t]+${escaped}\\b`, 'm'),
    // 2. Function/method: def X, fn X, func X, function X, async def X, async function X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?(?:def|fn|func|function)[ \\t]+${escaped}\\b`, 'm'),
    // 3. Rust pub items: pub struct/enum/fn/type X
    new RegExp(`^[ \\t]*pub[ \\t]+(?:struct|enum|fn|type|const|static)[ \\t]+${escaped}\\b`, 'm'),
    // 4. const/let/var declaration: const X, let X, var X, export const X
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${escaped}\\b`, 'm'),
    // 5. Method signature (TS interface/class): X(... or X<T>(... at indented line
    new RegExp(`^[ \\t]+(?:readonly[ \\t]+)?${escaped}[ \\t]*[<(]`, 'm'),
    // 6. Field/property declaration: X: Type (indented, in class/interface body)
    new RegExp(`^[ \\t]+(?:readonly[ \\t]+)?${escaped}[ \\t]*[:?][ \\t]*\\w`, 'm'),
    // 7. Django/Python field: X = models.SomeField(...) or X = SomeType(...)
    new RegExp(`^[ \\t]+${escaped}[ \\t]*=[ \\t]*(?:models\\.)?\\w+\\(`, 'm'),
    // 8. Python @property: @property followed by def X
    new RegExp(`^[ \\t]*@property\\s+def[ \\t]+${escaped}\\b`, 'ms'),
    // 9. Top-level assignment: X = ... (PascalCase only, no indent)
    new RegExp(`^${escaped}[ \\t]*(?::[ \\t]*\\w+)?[ \\t]*=[ \\t]*`, 'm'),
  ];

  for (const regex of patterns) {
    const match = regex.exec(text);
    if (match) {
      // Find exact identifier position within the match
      const idIdx = text.indexOf(identifier, match.index);
      return doc.positionAt(idIdx >= 0 ? idIdx : match.index);
    }
  }
  return null;
}

async function followImports(identifier: string, docs: vscode.TextDocument[], ms: () => string): Promise<vscode.Location | null> {
  // Python: from module.path import Identifier (single-line)
  const pyImportSingle = new RegExp(`^[ \\t]*from[ \\t]+([\\w.]+)[ \\t]+import[ \\t]+.*\\b${esc(identifier)}\\b`, 'm');
  // Python: from module.path import (\n  ...\n  Identifier,\n) (multi-line)
  const pyImportMulti = new RegExp(`^[ \\t]*from[ \\t]+([\\w.]+)[ \\t]+import[ \\t]*\\([^)]*\\b${esc(identifier)}\\b[^)]*\\)`, 'ms');
  // TS/JS: import { Identifier } from 'path' (single or multi-line)
  const tsImportRegex = new RegExp(`import[ \\t]+(?:\\{[^}]*\\b${esc(identifier)}\\b[^}]*\\}|${esc(identifier)})[ \\t]+from[ \\t]+['"]([^'"]+)['"]`, 's');

  for (const doc of docs) {
    const text = doc.getText();
    const isPython = doc.languageId === 'python' || doc.uri.fsPath.endsWith('.py') || doc.uri.fsPath.endsWith('.pyi');
    const isTS = doc.languageId === 'typescript' || doc.languageId === 'javascript'
      || doc.languageId === 'typescriptreact' || doc.languageId === 'javascriptreact';

    // ── Python imports ──
    if (isPython) {
      const pyMatch = pyImportSingle.exec(text) || pyImportMulti.exec(text);
      if (pyMatch) {
        const modulePath = pyMatch[1];
        const filePath = modulePath.replace(/\./g, '/');
        log.info(`  [import] Python: from ${modulePath} import ${identifier} (${ms()})`);

        const patterns = [`**/${filePath}.py`, `**/${filePath}/__init__.py`, `**/${filePath}.pyi`];
        for (const pattern of patterns) {
          try {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
            // Prefer project files over .venv/site-packages
            files.sort((a, b) => {
              const aVenv = a.fsPath.includes('.venv') || a.fsPath.includes('site-packages') ? 1 : 0;
              const bVenv = b.fsPath.includes('.venv') || b.fsPath.includes('site-packages') ? 1 : 0;
              if (aVenv !== bVenv) { return aVenv - bVenv; }
              return a.fsPath.length - b.fsPath.length; // shorter path = likely more direct
            });
            for (const fileUri of files) {
              try {
                const targetDoc = await vscode.workspace.openTextDocument(fileUri);
                const targetText = targetDoc.getText();
                const pos = findDefInText(targetText, identifier, targetDoc);
                if (pos) {
                  const line = targetDoc.lineAt(pos.line).text.trim();
                  log.info(`  [import] → ${vscode.workspace.asRelativePath(fileUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                  return new vscode.Location(fileUri, new vscode.Range(pos, pos));
                }
                // __init__.py barrel: follow "from .submodule import *" or "from .submodule import Identifier"
                if (fileUri.fsPath.endsWith('__init__.py')) {
                  const reExportNamed = new RegExp(`^[ \\t]*from[ \\t]+(\\.\\w+)[ \\t]+import[ \\t]+.*\\b${esc(identifier)}\\b`, 'm');
                  const reExportStar = /^[ \t]*from[ \t]+(\.\w+)[ \t]+import[ \t]+\*/gm;
                  const subModules: string[] = [];
                  const namedMatch = reExportNamed.exec(targetText);
                  if (namedMatch) { subModules.push(namedMatch[1]); }
                  let starMatch: RegExpExecArray | null;
                  while ((starMatch = reExportStar.exec(targetText)) !== null) {
                    subModules.push(starMatch[1]);
                  }
                  for (const relModule of subModules) {
                    try {
                      const subUri = vscode.Uri.joinPath(fileUri, '..', relModule.replace('.', '') + '.py');
                      const subDoc = await vscode.workspace.openTextDocument(subUri);
                      const subPos = findDefInText(subDoc.getText(), identifier, subDoc);
                      if (subPos) {
                        const subLine = subDoc.lineAt(subPos.line).text.trim();
                        log.info(`  [import] → ${vscode.workspace.asRelativePath(subUri)}:${subPos.line + 1} "${subLine.substring(0, 60)}" (barrel, ${ms()})`);
                        return new vscode.Location(subUri, new vscode.Range(subPos, subPos));
                      }
                    } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
        }
        log.info(`  [import] module "${modulePath}" not resolved (${ms()})`);
      }
    }

    // ── TS/JS imports ──
    if (isTS) {
      const tsMatch = tsImportRegex.exec(text);
      if (tsMatch) {
        const importPath = tsMatch[1];
        log.info(`  [import] TS/JS: import ${identifier} from '${importPath}' (${ms()})`);

        if (importPath.startsWith('.')) {
          // Relative import
          const docDir = vscode.Uri.joinPath(doc.uri, '..');
          const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
          for (const ext of extensions) {
            try {
              const targetUri = vscode.Uri.joinPath(docDir, importPath + ext);
              const targetDoc = await vscode.workspace.openTextDocument(targetUri);
              const pos = findDefInText(targetDoc.getText(), identifier, targetDoc);
              if (pos) {
                const line = targetDoc.lineAt(pos.line).text.trim();
                log.info(`  [import] → ${vscode.workspace.asRelativePath(targetUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                return new vscode.Location(targetUri, new vscode.Range(pos, pos));
              }
            } catch {}
          }
        } else {
          // Package import (e.g. '@emotion/react', 'react', 'formik')
          // Strategy: find package.json → read "types"/"typings" field → scan that file
          const pkgPatterns = [
            `**/node_modules/${importPath}/package.json`,
            `**/node_modules/@types/${importPath.replace(/^@[^/]+\//, '')}/package.json`,
          ];
          for (const pkgPattern of pkgPatterns) {
            try {
              const pkgFiles = await vscode.workspace.findFiles(pkgPattern, undefined, 2);
              for (const pkgUri of pkgFiles) {
                try {
                  const pkgDoc = await vscode.workspace.openTextDocument(pkgUri);
                  const pkgJson = JSON.parse(pkgDoc.getText());
                  const typesPath = pkgJson.types || pkgJson.typings;
                  if (typesPath) {
                    const typesUri = vscode.Uri.joinPath(pkgUri, '..', typesPath);
                    const typesDoc = await vscode.workspace.openTextDocument(typesUri);
                    const typesText = typesDoc.getText();
                    // Direct def in types entry file
                    const pos = findDefInText(typesText, identifier, typesDoc);
                    if (pos) {
                      const line = typesDoc.lineAt(pos.line).text.trim();
                      log.info(`  [import] → ${vscode.workspace.asRelativePath(typesUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                      return new vscode.Location(typesUri, new vscode.Range(pos, pos));
                    }
                    // Check re-exports: export { X } from './sub' or export * from './sub'
                    const reExportPaths: string[] = [];
                    // Named: export { Identifier } from './path'
                    const namedReExport = new RegExp(`export\\s*\\{[^}]*\\b${esc(identifier)}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`, 's');
                    const namedMatch = namedReExport.exec(typesText);
                    if (namedMatch) { reExportPaths.push(namedMatch[1]); }
                    // Star: export * from './path' — check all star re-exports
                    const starRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
                    let starMatch: RegExpExecArray | null;
                    while ((starMatch = starRegex.exec(typesText)) !== null) {
                      reExportPaths.push(starMatch[1]);
                    }
                    for (const subPath of reExportPaths) {
                      const subExts = ['.d.ts', '.ts', '/index.d.ts'];
                      for (const ext of subExts) {
                        try {
                          const subUri = vscode.Uri.joinPath(typesUri, '..', subPath + ext);
                          const subDoc = await vscode.workspace.openTextDocument(subUri);
                          const subPos = findDefInText(subDoc.getText(), identifier, subDoc);
                          if (subPos) {
                            const subLine = subDoc.lineAt(subPos.line).text.trim();
                            log.info(`  [import] → ${vscode.workspace.asRelativePath(subUri)}:${subPos.line + 1} "${subLine.substring(0, 60)}" (${ms()})`);
                            return new vscode.Location(subUri, new vscode.Range(subPos, subPos));
                          }
                        } catch {}
                      }
                    }
                  }
                } catch {}
              }
            } catch {}
          }
          // Fallback: direct file patterns
          const directPatterns = [
            `**/node_modules/${importPath}/index.d.ts`,
            `**/node_modules/@types/${importPath}/index.d.ts`,
          ];
          for (const pattern of directPatterns) {
            try {
              const files = await vscode.workspace.findFiles(pattern, undefined, 2);
              for (const fileUri of files) {
                try {
                  const targetDoc = await vscode.workspace.openTextDocument(fileUri);
                  const pos = findDefInText(targetDoc.getText(), identifier, targetDoc);
                  if (pos) {
                    const line = targetDoc.lineAt(pos.line).text.trim();
                    log.info(`  [import] → ${vscode.workspace.asRelativePath(fileUri)}:${pos.line + 1} "${line.substring(0, 60)}" (${ms()})`);
                    return new vscode.Location(fileUri, new vscode.Range(pos, pos));
                  }
                } catch {}
              }
            } catch {}
          }
        }
        log.info(`  [import] path "${importPath}" not resolved (${ms()})`);
      }
    }
  }
  return null;
}

/** showTextDocument with a 5s timeout to prevent permanent hangs */
async function safeShowTextDocument(docOrUri: vscode.TextDocument | vscode.Uri, options: { selection: vscode.Range; preserveFocus: boolean }): Promise<void> {
  const doc = docOrUri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(docOrUri) : docOrUri;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('showTextDocument timeout (5s)')), 5000));
  try {
    await Promise.race([vscode.window.showTextDocument(doc, options), timeout]);
  } catch (err) {
    log.warn(`safeShowTextDocument: ${err}`);
  }
}

async function goToTypeHandlerInner(docUriStr: string, identifier: string) {
  const regexSource = `\\b${esc(identifier)}\\b`;
  log.info(`goToType: "${identifier}" regex=/${regexSource}/g`);
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  const regex = new RegExp(regexSource, 'g');

  // ── Collect all searchable docs ──
  const previewLoc = lastPreviewLocations.get(identifier);
  const priorityUris: string[] = [];
  if (previewLoc?.uri) { priorityUris.push(previewLoc.uri.toString()); }
  if (lastHoverDocUri) { priorityUris.push(lastHoverDocUri); }
  if (docUriStr) { priorityUris.push(docUriStr); }
  const editor = vscode.window.activeTextEditor;
  if (editor) { priorityUris.push(editor.document.uri.toString()); }

  const seen = new Set<string>();
  const allDocs: vscode.TextDocument[] = [];
  for (const uriStr of priorityUris) {
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    try {
      const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
      if (isCodeDoc(d)) { allDocs.push(d); }
    } catch {}
  }
  for (const openDoc of vscode.workspace.textDocuments) {
    const uriStr = openDoc.uri.toString();
    if (seen.has(uriStr)) { continue; }
    seen.add(uriStr);
    if (isCodeDoc(openDoc)) { allDocs.push(openDoc); }
  }
  // Sort: project files first, then node_modules/@types, then stdlib/.venv last
  allDocs.sort((a, b) => {
    const score = (d: vscode.TextDocument) => {
      const p = d.uri.fsPath;
      if (p.includes('.venv') || p.includes('site-packages') || p.includes('.asdf')
        || p.includes('typeshed') || p.includes('/lib/python')) { return 3; } // stdlib/.venv last
      if (p.includes('node_modules') || p.includes('lib.dom.d.ts') || p.includes('lib.es')) { return 2; } // TS lib
      if (p.includes('package.json')) { return 4; } // config files last
      return 0; // project files first
    };
    return score(a) - score(b);
  });
  log.info(`  docs: [${allDocs.map(d => vscode.workspace.asRelativePath(d.uri)).join(', ')}] (${ms()})`);

  // ── Step 1: Fast definition-line scan (no language server, pure regex) ──
  // Two-pass: project files first, then stdlib/.venv/node_modules
  log.info(`  [1] defLine scan... (${ms()})`);
  const isExternalDoc = (d: vscode.TextDocument) => {
    const p = d.uri.fsPath;
    return p.includes('.venv') || p.includes('site-packages') || p.includes('.asdf')
      || p.includes('typeshed') || p.includes('/lib/python') || p.includes('node_modules')
      || p.includes('lib.dom.d.ts') || p.includes('lib.es');
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let di = 0; di < allDocs.length; di++) {
      const doc = allDocs[di];
      const external = isExternalDoc(doc);
      if (pass === 0 && external) { continue; }  // pass 0: project only
      if (pass === 1 && !external) { continue; }  // pass 1: external only

      const relPath = vscode.workspace.asRelativePath(doc.uri);
      const text = doc.getText();

      const pos = findDefInText(text, identifier, doc);
      if (pos) {
        const line = doc.lineAt(pos.line).text.trim();
        log.info(`→ ${relPath}:${pos.line + 1} "${line.substring(0, 60)}" (defLine${pass === 1 ? '/ext' : ''}, ${ms()})`);
        await safeShowTextDocument(doc, {
          selection: new vscode.Range(pos, pos), preserveFocus: false
        });
        return;
      }
    }
    if (pass === 0) { log.info(`  [1] not in project docs, checking external... (${ms()})`); }
  }

  // ── Step 2: Import-follow (trace import statements to source file) ──
  log.info(`  [2] import-follow... (${ms()})`);
  try {
    const importLoc = await followImports(identifier, allDocs, ms);
    if (importLoc) {
      log.info(`→ ${vscode.workspace.asRelativePath(importLoc.uri)}:${importLoc.range.start.line + 1} (import-follow, ${ms()})`);
      await safeShowTextDocument(importLoc.uri, {
        selection: importLoc.range, preserveFocus: false
      });
      return;
    }
  } catch (err) {
    log.warn(`  [2] import-follow error: ${err} (${ms()})`);
  }

  // ── Step 3: Definition provider (with per-call timeout, skip if first call is slow) ──
  log.info(`  [3] defProvider scan... (${ms()})`);
  for (let di = 0; di < allDocs.length; di++) {
    const doc = allDocs[di];
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const text = doc.getText();
    regex.lastIndex = 0;

    const matchPositions: number[] = [];
    let mc: RegExpExecArray | null;
    while ((mc = regex.exec(text)) !== null) {
      matchPositions.push(mc.index);
      if (matchPositions.length > 20) { break; }
    }
    if (matchPositions.length === 0) { continue; }
    log.info(`  [3.${di}] ${relPath}: ${matchPositions.length} match(es) (${ms()})`);

    try {
      let slowFile = false;
      for (let mi = 0; mi < matchPositions.length; mi++) {
        if (slowFile) {
          log.info(`  [3.${di}] skip remaining (slow file) (${ms()})`);
          break;
        }
        const pos = doc.positionAt(matchPositions[mi]);
        log.info(`  [3.${di}.${mi}] defProvider :${pos.line + 1}:${pos.character} (${ms()})`);
        const callT0 = Date.now();
        const defPromise = vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, pos);
        const defTimeout = new Promise<null>(r => setTimeout(() => r(null), 5000));
        const defs = await Promise.race([defPromise, defTimeout]);

        if (defs === null) {
          log.warn(`  [3.${di}.${mi}] TIMEOUT 5s → skip file (${ms()})`);
          slowFile = true;
          continue;
        }
        const callMs = Date.now() - callT0;
        log.info(`  [3.${di}.${mi}] returned ${defs?.length || 0} def(s) [${callMs}ms] (${ms()})`);
        if (callMs > 3000) { slowFile = true; } // mark file as slow for remaining matches

        const def = defs?.length ? normalizeDef(defs[0]) : null;
        if (def) {
          const defRelPath = vscode.workspace.asRelativePath(def.uri);
          const isSameFile = def.uri.toString() === doc.uri.toString();
          const isSameLine = isSameFile && def.range.start.line === pos.line;
          const isSelfRef = isSameLine && Math.abs(def.range.start.character - pos.character) < 3;

          log.info(`  [3.${di}.${mi}] → ${defRelPath}:${def.range.start.line + 1}${isSelfRef ? ' (self-ref)' : ''}`);

          if (isSelfRef) {
            const defLineText = doc.lineAt(def.range.start.line).text;
            const isDefLine = /^\s*(?:export\s+)?(?:class|interface|type|enum|const|let|var|function|def|struct)\s+/.test(defLineText);
            if (isDefLine) {
              log.info(`  [3.${di}.${mi}] self-ref on defLine → accept`);
            } else {
              log.info(`  [3.${di}.${mi}] self-ref → skip`);
              continue;
            }
          }

          log.info(`→ ${defRelPath}:${def.range.start.line + 1} (${ms()})`);
          await safeShowTextDocument(def.uri, {
            selection: def.range, preserveFocus: false
          });
          return;
        }
      }
    } catch (err) {
      log.warn(`  [3.${di}] error: ${err} (${ms()})`);
    }
  }

  // ── Step 4: Scan import sources of the hover-origin file (max 3s) ──
  const step4Deadline = Date.now() + 3000;
  log.info(`  [4] import-source scan... (${ms()})`);
  try {
    // Find the file where hover was triggered, scan its imports for packages that might define this type
    let hoverDoc: vscode.TextDocument | null = null;
    if (lastHoverDocUri) {
      try { hoverDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(lastHoverDocUri)); } catch {}
    }
    if (hoverDoc) {
      const hoverText = hoverDoc.getText();
      // Collect all import sources from the hover file
      const importSources: vscode.Uri[] = [];

      if (hoverDoc.languageId === 'typescript' || hoverDoc.languageId === 'typescriptreact'
        || hoverDoc.languageId === 'javascript' || hoverDoc.languageId === 'javascriptreact') {
        // TS: extract all "from 'package'" paths, resolve to type files
        const fromRegex = /from\s+['"]([^'"]+)['"]/g;
        let fm: RegExpExecArray | null;
        const seenPkgs = new Set<string>();
        const MAX_PKG_SCAN = 5;
        while ((fm = fromRegex.exec(hoverText)) !== null) {
          if (Date.now() > step4Deadline || seenPkgs.size >= MAX_PKG_SCAN) { break; }
          const pkg = fm[1];
          if (pkg.startsWith('.') || seenPkgs.has(pkg)) { continue; }
          seenPkgs.add(pkg);
          // Try @types/<pkg>/index.d.ts and <pkg> package.json → types
          const candidates = [
            `**/node_modules/@types/${pkg.replace(/^@[^/]+\//, '')}/index.d.ts`,
            `**/node_modules/${pkg}/index.d.ts`,
          ];
          for (const pat of candidates) {
            try {
              const files = await vscode.workspace.findFiles(pat, undefined, 1);
              for (const f of files) { if (!seen.has(f.toString())) { importSources.push(f); seen.add(f.toString()); } }
            } catch {}
          }
          // Also try package.json → types field
          try {
            const pkgFiles = await vscode.workspace.findFiles(`**/node_modules/${pkg}/package.json`, undefined, 1);
            for (const pkgUri of pkgFiles) {
              const pkgDoc = await vscode.workspace.openTextDocument(pkgUri);
              const pkgJson = JSON.parse(pkgDoc.getText());
              const typesPath = pkgJson.types || pkgJson.typings;
              if (typesPath) {
                const typesUri = vscode.Uri.joinPath(pkgUri, '..', typesPath);
                if (!seen.has(typesUri.toString())) { importSources.push(typesUri); seen.add(typesUri.toString()); }
              }
            }
          } catch {}
        }
      }

      if (hoverDoc.languageId === 'python') {
        const pyFromRegex = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import/gm;
        let pfm: RegExpExecArray | null;
        let pyPkgCount = 0;
        while ((pfm = pyFromRegex.exec(hoverText)) !== null) {
          if (Date.now() > step4Deadline || pyPkgCount >= 5) { break; }
          pyPkgCount++;
          const modPath = pfm[1].replace(/\./g, '/');
          const pats = [`**/${modPath}.py`, `**/${modPath}/__init__.py`, `**/${modPath}.pyi`];
          for (const pat of pats) {
            if (Date.now() > step4Deadline) { break; }
            try {
              const files = await vscode.workspace.findFiles(pat, '**/node_modules/**', 2);
              for (const f of files) { if (!seen.has(f.toString())) { importSources.push(f); seen.add(f.toString()); } }
            } catch {}
          }
        }
      }

      log.info(`  [4] scanning ${importSources.length} import source(s) (${ms()})`);
      for (const srcUri of importSources) {
        if (Date.now() > step4Deadline) {
          log.info(`  [4] timeout after 3s (${ms()})`);
          break;
        }
        try {
          const srcDoc = await vscode.workspace.openTextDocument(srcUri);
          const pos = findDefInText(srcDoc.getText(), identifier, srcDoc);
          if (pos) {
            const line = srcDoc.lineAt(pos.line).text.trim();
            log.info(`→ ${vscode.workspace.asRelativePath(srcUri)}:${pos.line + 1} "${line.substring(0, 60)}" (importSource, ${ms()})`);
            await safeShowTextDocument(srcDoc, {
              selection: new vscode.Range(pos, pos), preserveFocus: false
            });
            return;
          }
        } catch {}
      }
    }

    // Fallback: file-name based search (only if still within deadline)
    if (Date.now() > step4Deadline) {
      log.info(`  [4] timeout before findFiles (${ms()})`);
    } else {
    const wsPatterns = [`**/${identifier}.py`, `**/${identifier}.ts`, `**/${identifier}.d.ts`,
      `**/${identifier}.tsx`, `**/${identifier.toLowerCase()}.py`, `**/${identifier.toLowerCase()}.ts`];
    for (const wsPat of wsPatterns) {
      if (Date.now() > step4Deadline) { break; }
      const wsFiles = await vscode.workspace.findFiles(wsPat, '**/node_modules/**', 3);
      for (const wsFileUri of wsFiles) {
        if (seen.has(wsFileUri.toString())) { continue; }
        try {
          const wsDoc = await vscode.workspace.openTextDocument(wsFileUri);
          const wsPos = findDefInText(wsDoc.getText(), identifier, wsDoc);
          if (wsPos) {
            const wsLine = wsDoc.lineAt(wsPos.line).text.trim();
            log.info(`→ ${vscode.workspace.asRelativePath(wsFileUri)}:${wsPos.line + 1} "${wsLine.substring(0, 60)}" (findFiles, ${ms()})`);
            await safeShowTextDocument(wsDoc, {
              selection: new vscode.Range(wsPos, wsPos), preserveFocus: false
            });
            return;
          }
        } catch {}
      }
    }
    } // end if deadline check
  } catch (err) {
    log.warn(`  [4] error: ${err} (${ms()})`);
  }

  // ── Step 5: Direct defProvider on previewLoc (for types the LS knows about) ──
  if (previewLoc?.uri) {
    log.info(`  [5] previewLoc defProvider... (${ms()})`);
    try {
      const pvDoc = await vscode.workspace.openTextDocument(previewLoc.uri);
      const pvText = pvDoc.getText();
      regex.lastIndex = 0;
      let pvMatch: RegExpExecArray | null;
      while ((pvMatch = regex.exec(pvText)) !== null) {
        const pvPos = pvDoc.positionAt(pvMatch.index);
        const callT0 = Date.now();
        const pvDefs = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', pvDoc.uri, pvPos);
        const callMs = Date.now() - callT0;
        const pvDef = pvDefs?.length ? normalizeDef(pvDefs[0]) : null;
        if (pvDef) {
          const isSelf = pvDef.uri.toString() === pvDoc.uri.toString()
            && pvDef.range.start.line === pvPos.line
            && Math.abs(pvDef.range.start.character - pvPos.character) < 3;
          if (!isSelf) {
            log.info(`→ ${vscode.workspace.asRelativePath(pvDef.uri)}:${pvDef.range.start.line + 1} (previewLoc+def, ${ms()})`);
            await safeShowTextDocument(pvDef.uri, {
              selection: pvDef.range, preserveFocus: false
            });
            return;
          }
        }
        if (callMs > 3000) {
          log.info(`  [5] slow (${callMs}ms) → skip (${ms()})`);
          break;
        }
      }
    } catch (err) {
      log.warn(`  [5] previewLoc defProvider error: ${err} (${ms()})`);
    }
  }

  // ── Step 6: Hover fallback ──
  log.info(`  [6] hover fallback... (${ms()})`);
  for (let di = 0; di < allDocs.length; di++) {
    const doc = allDocs[di];
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    try {
      const text = doc.getText();
      regex.lastIndex = 0;
      const m = regex.exec(text);
      if (!m) { continue; }
      const pos = doc.positionAt(m.index);
      log.info(`  [6.${di}] ${relPath}:${pos.line + 1} hoverProvider (${ms()})`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      log.info(`  [6.${di}] returned ${hovers?.length || 0} hover(s) (${ms()})`);
      if (hovers?.length) {
        log.info(`→ hover at ${relPath}:${pos.line + 1} (${ms()})`);
        await safeShowTextDocument(doc, { selection: new vscode.Range(pos, pos), preserveFocus: false });
        await vscode.commands.executeCommand('editor.action.showHover');
        return;
      }
    } catch {}
  }

  log.warn(`"${identifier}" not found (${ms()})`);
}

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function deactivate() {
  if (reinjectTimer) { clearInterval(reinjectTimer); }
  log.info('Extension deactivated');
  log.dispose();
}
