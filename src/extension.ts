import * as vscode from 'vscode';
import * as inspector from 'node:inspector';

const log = vscode.window.createOutputChannel('IntelliSense Recursion', { log: true });

export async function activate(context: vscode.ExtensionContext) {
  log.info('=== Extension activating ===');

  context.subscriptions.push(
    vscode.commands.registerCommand('intellisenseRecursion.goToType', goToTypeHandler)
  );

  const sharedService = findSharedHoverService();
  if (sharedService) {
    patchSharedService(sharedService);
  } else {
    log.warn('[patch] Shared service not found');
  }

  // Explore main thread access via electron
  exploreElectronAccess();

  log.info('=== Extension activated ===');
}

// ---------- Extract shared ExtHostLanguageFeatures via V8 Inspector ----------

function findSharedHoverService(): any | null {
  log.info('[explore] Extracting "et" from registerHoverProvider closure via V8 inspector...');

  // registerHoverProvider.toString() revealed:
  //   registerHoverProvider(y,x){return et.registerHoverProvider(k,Lt(y),x,k.identifier)}
  // "et" is the shared ExtHostLanguageFeatures instance captured in the closure.
  // We use the V8 Inspector Protocol to read closure (scope) variables.

  try {
    const session = new inspector.Session();
    session.connect();

    // Store the function globally so the inspector can find it
    (globalThis as any).__irFn = vscode.languages.registerHoverProvider;

    let et: any = null;

    // Step 1: Evaluate to get the function's remote object ID
    session.post('Runtime.evaluate', { expression: '__irFn', returnByValue: false }, (err, evalResult: any) => {
      if (err || !evalResult?.result?.objectId) {
        log.error(`[explore] Runtime.evaluate failed: ${err || 'no objectId'}`);
        return;
      }
      const fnObjectId = evalResult.result.objectId;
      log.info(`[explore] Got function objectId: ${fnObjectId}`);

      // Step 2: Get internal properties (includes [[Scopes]])
      session.post('Runtime.getProperties', {
        objectId: fnObjectId,
        ownProperties: false,
        accessorPropertiesOnly: false,
      }, (err2, propsResult: any) => {
        if (err2) {
          log.error(`[explore] getProperties failed: ${err2}`);
          return;
        }

        const internalProps = propsResult?.internalProperties || [];
        log.info(`[explore] Internal properties: [${internalProps.map((p: any) => p.name).join(', ')}]`);

        const scopesProp = internalProps.find((p: any) => p.name === '[[Scopes]]');
        if (!scopesProp?.value?.objectId) {
          log.warn('[explore] [[Scopes]] not found');
          return;
        }

        // Step 3: Get scope entries
        session.post('Runtime.getProperties', {
          objectId: scopesProp.value.objectId,
        }, (err3, scopesResult: any) => {
          if (err3) {
            log.error(`[explore] getScopeEntries failed: ${err3}`);
            return;
          }

          const scopeEntries = scopesResult?.result || [];
          log.info(`[explore] Scope entries: ${scopeEntries.length}`);

          // Step 4: Iterate each scope, look for "et" variable
          for (const entry of scopeEntries) {
            if (!entry.value?.objectId) { continue; }
            log.info(`[explore] Scope entry: ${entry.name}, type=${entry.value.type}, subtype=${entry.value.subtype}`);

            session.post('Runtime.getProperties', {
              objectId: entry.value.objectId,
            }, (err4, scopeVarsResult: any) => {
              if (err4) { return; }

              const vars = scopeVarsResult?.result || [];
              const varNames = vars.map((v: any) => v.name).slice(0, 30);
              log.info(`[explore]   Scope vars: [${varNames.join(', ')}]`);

              // Look for "et" or any variable that has $provideHover
              for (const v of vars) {
                if (v.name === 'et' && v.value?.objectId) {
                  log.info(`[explore]   FOUND "et"! type=${v.value.type}, className=${v.value.className}`);

                  // Step 5: Evaluate et to bring it into our JS scope
                  // Store the objectId for later use
                  session.post('Runtime.callFunctionOn', {
                    objectId: v.value.objectId,
                    functionDeclaration: 'function() { globalThis.__irEt = this; }',
                  }, (err5) => {
                    if (err5) {
                      log.error(`[explore] callFunctionOn failed: ${err5}`);
                    } else {
                      log.info('[explore] "et" stored in globalThis.__irEt!');
                    }
                  });
                }

                // Also log any variable with $provideHover
                if (v.value?.description?.includes('provideHover')) {
                  log.info(`[explore]   Variable "${v.name}" mentions provideHover: ${v.value.description}`);
                }
              }
            });
          }
        });
      });
    });

    // The inspector calls are async via callbacks.
    // Give them a moment to complete, then check if et was found.
    // We'll use a synchronous spin-wait (ugly but necessary for sync activate).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // Force microtask processing
      try { session.post('Runtime.evaluate', { expression: '1' }, () => {}); } catch {}
      if ((globalThis as any).__irEt) { break; }
    }

    session.disconnect();
    delete (globalThis as any).__irFn;

    et = (globalThis as any).__irEt;
    if (et) {
      log.info(`[explore] SUCCESS! Got "et". Keys: [${Object.getOwnPropertyNames(Object.getPrototypeOf(et)).slice(0, 20).join(', ')}]`);
      log.info(`[explore] Has $provideHover: ${'$provideHover' in et}`);
      return et;
    } else {
      log.warn('[explore] Could not extract "et" from closure');
    }
  } catch (err) {
    log.error(`[explore] Inspector error: ${err}`);
  }

  return null;
}

// ---------- Patch shared service ----------

function patchSharedService(service: any) {
  const original = service.$provideHover;
  log.info(`[patch] Patching $provideHover (type=${typeof original})`);

  service.$provideHover = async function (handle: number, uri: any, position: any, context: any, token: any) {
    const result = await original.call(this, handle, uri, position, context, token);
    if (!result || !result.contents || result.contents.length === 0) {
      return result;
    }

    // Extract types from code fences
    const types: string[] = [];
    for (const content of result.contents) {
      if (!content || typeof content.value !== 'string') { continue; }
      const fence = content.value.match(/```\w*\n?([\s\S]*?)```/);
      if (fence) { types.push(...findTypeNames(fence[1].trim())); }
    }

    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length === 0) {
      return result;
    }

    const docUriStr = uri?.scheme
      ? `${uri.scheme}://${uri.authority || ''}${uri.path}`
      : String(uri);

    log.info(`[patch] Types: [${uniqueTypes.join(', ')}] — resolving definitions for preview`);

    // Resolve definitions and read source preview for each type
    try {
      const docUri = vscode.Uri.parse(docUriStr);
      const doc = await vscode.workspace.openTextDocument(docUri);
      const docText = doc.getText();

      const previews: string[] = [];
      for (const typeName of uniqueTypes.slice(0, 3)) { // max 3 types
        const regex = new RegExp(`\\b${esc(typeName)}\\b`);
        const match = regex.exec(docText);
        if (!match) { continue; }

        const pos = doc.positionAt(match.index);
        const defs = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', docUri, pos
        );
        if (!defs || defs.length === 0) { continue; }

        const def = defs[0];
        const defDoc = await vscode.workspace.openTextDocument(def.uri);
        const startLine = def.range.start.line;
        const endLine = Math.min(startLine + 10, defDoc.lineCount); // 10 lines preview
        const previewLines: string[] = [];
        for (let i = startLine; i < endLine; i++) {
          previewLines.push(defDoc.lineAt(i).text);
        }
        const previewCode = previewLines.join('\n');
        const relPath = vscode.workspace.asRelativePath(def.uri);
        const lang = defDoc.languageId || 'python';

        previews.push(`\`${typeName}\` — *${relPath}:${startLine + 1}*\n\`\`\`${lang}\n${previewCode}\n\`\`\``);
        log.info(`[patch] Preview for "${typeName}": ${relPath}:${startLine + 1}`);
      }

      if (previews.length > 0) {
        // Append definition previews to hover contents
        const previewContent = {
          value: '---\n' + previews.join('\n\n---\n'),
          isTrusted: true,
        };
        return {
          ...result,
          contents: [...result.contents, previewContent],
        };
      }
    } catch (err) {
      log.error(`[patch] Preview error: ${err}`);
    }

    return result;
  };

  log.info('[patch] $provideHover patched successfully');
}

// ---------- Electron main thread access ----------

function exploreElectronAccess() {
  log.info('[electron] Exploring main thread access...');

  // Try 1: direct require('electron')
  try {
    const electron = require('electron');
    log.info(`[electron] require('electron') succeeded. Keys: [${Object.keys(electron).join(', ')}]`);
    if (electron.BrowserWindow) {
      const windows = electron.BrowserWindow.getAllWindows();
      log.info(`[electron] BrowserWindow.getAllWindows(): ${windows.length} window(s)`);
    }
    if (electron.remote) {
      log.info(`[electron] electron.remote available. Keys: [${Object.keys(electron.remote).join(', ')}]`);
    }
  } catch (e) {
    log.info(`[electron] require('electron') failed: ${e}`);
  }

  // Try 2: require('@electron/remote')
  try {
    const remote = require('@electron/remote');
    log.info(`[electron] require('@electron/remote') succeeded. Keys: [${Object.keys(remote).join(', ')}]`);
  } catch (e) {
    log.info(`[electron] require('@electron/remote') failed: ${e}`);
  }

  // Try 3: search require.cache for electron modules
  const electronModules = Object.keys(require.cache).filter(k =>
    k.includes('electron') || k.includes('browser-window') || k.includes('web-contents')
  );
  log.info(`[electron] Electron modules in cache: ${electronModules.length}`);
  for (const m of electronModules.slice(0, 10)) {
    log.info(`[electron]   ${m}`);
  }

  // Try 4: check process.type (electron process type)
  log.info(`[electron] process.type = ${(process as any).type}`);
  log.info(`[electron] process.versions.electron = ${(process as any).versions?.electron}`);

  // Try 5: check if we can access globalThis for electron refs
  const electronGlobals = Object.getOwnPropertyNames(globalThis).filter(k =>
    k.toLowerCase().includes('electron') || k.toLowerCase().includes('browser') || k.toLowerCase().includes('webcontents')
  );
  log.info(`[electron] Electron-related globals: [${electronGlobals.join(', ')}]`);

  // Try 6: process.parentPort details
  const parentPort = (process as any).parentPort;
  log.info(`[electron] process.parentPort = ${typeof parentPort}`);
  if (parentPort) {
    log.info(`[electron] parentPort keys: [${Object.getOwnPropertyNames(parentPort).join(', ')}]`);
    log.info(`[electron] parentPort proto: [${Object.getOwnPropertyNames(Object.getPrototypeOf(parentPort)).join(', ')}]`);
  }

  // Try 7: look for renderer debug port via env/argv
  const inspectorOpts = process.env.VSCODE_INSPECTOR_OPTIONS;
  log.info(`[electron] VSCODE_INSPECTOR_OPTIONS = ${inspectorOpts?.substring(0, 200)}`);
  const relevantEnv = Object.entries(process.env).filter(([k]) =>
    k.includes('INSPECT') || k.includes('DEBUG') || k.includes('DEVTOOLS') || k.includes('CDP')
  );
  log.info(`[electron] Debug-related env vars: ${relevantEnv.map(([k,v]) => `${k}=${String(v).substring(0, 80)}`).join('; ')}`);
  log.info(`[electron] process.debugPort = ${(process as any).debugPort}`);

  // Try 8: explore et._proxy to find RPC protocol to main thread
  const et = (globalThis as any).__irEt;
  if (et?._proxy) {
    const proxyKeys = Reflect.ownKeys(et._proxy);
    log.info(`[electron] et._proxy keys: [${proxyKeys.map(String).join(', ')}]`);
    const proxyProto = Object.getPrototypeOf(et._proxy);
    if (proxyProto) {
      log.info(`[electron] et._proxy proto keys: [${Object.getOwnPropertyNames(proxyProto).join(', ')}]`);
    }
    // Check if proxy has a reference to the RPC protocol
    for (const key of proxyKeys) {
      const val = (et._proxy as any)[key];
      if (typeof val === 'object' && val !== null) {
        log.info(`[electron] et._proxy[${String(key)}] = object { ${Object.keys(val).slice(0, 10).join(', ')} }`);
      }
    }
  }

  // Try 9: scan for renderer CDP endpoints
  scanForRendererCDP();
}

// ---------- Renderer CDP connection ----------

async function scanForRendererCDP() {
  const http = require('http');
  const CDP_PORT = 9222; // Set via --remote-debugging-port in launch.json

  log.info(`[cdp] Checking renderer CDP on port ${CDP_PORT}...`);

  try {
    // Get debuggable targets
    const targetsJson = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const targets = JSON.parse(targetsJson);
    log.info(`[cdp] Found ${targets.length} target(s)`);

    for (const t of targets) {
      log.info(`[cdp] Target: type=${t.type}, title="${t.title?.substring(0, 60)}", wsUrl=${t.webSocketDebuggerUrl?.substring(0, 80)}`);
    }

    // Find the page target (renderer)
    const page = targets.find((t: any) => t.type === 'page') || targets[0];
    if (!page?.webSocketDebuggerUrl) {
      log.warn('[cdp] No page target with WebSocket URL found');
      return;
    }

    log.info(`[cdp] Connecting to renderer: ${page.webSocketDebuggerUrl}`);
    await injectHoverCmdClick(page.webSocketDebuggerUrl);

  } catch (err) {
    log.info(`[cdp] Renderer CDP not available on port ${CDP_PORT}: ${err}`);
    log.info('[cdp] To enable: add "--remote-debugging-port=9222" to launch.json args');
  }
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

async function injectHoverCmdClick(wsUrl: string) {
  const WebSocket = require('ws') as typeof import('ws') | undefined;
  let ws: any;

  // ws module might not be available, try native
  if (WebSocket) {
    ws = new WebSocket(wsUrl);
  } else {
    // Fallback: use Node.js http to upgrade
    log.warn('[cdp] ws module not available, trying raw connection...');
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let msgId = 1;

    ws.on('open', () => {
      log.info('[cdp] WebSocket connected to renderer!');

      // Inject MutationObserver script into the renderer DOM
      const script = getHoverPatchScript();
      const msg = JSON.stringify({
        id: msgId++,
        method: 'Runtime.evaluate',
        params: {
          expression: script,
          awaitPromise: false,
        }
      });

      ws.send(msg);
      log.info('[cdp] Sent hover patch script to renderer');
    });

    ws.on('message', (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id) {
          log.info(`[cdp] Response: ${JSON.stringify(resp.result || resp.error).substring(0, 200)}`);
          resolve();
        }
      } catch {}
    });

    ws.on('error', (err: Error) => {
      log.error(`[cdp] WebSocket error: ${err}`);
      reject(err);
    });

    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

/**
 * JavaScript to inject into VS Code's renderer process.
 * Adds Cmd+Click behavior to type names in hover code blocks.
 */
function getHoverPatchScript(): string {
  return `
(function() {
  if (window.__irHoverPatched) return 'already patched';
  window.__irHoverPatched = true;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Look for hover widget
        const hoverWidget = node.closest?.('.monaco-hover') || node.querySelector?.('.monaco-hover');
        if (hoverWidget) {
          patchHoverCodeBlocks(hoverWidget);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  function patchHoverCodeBlocks(hover) {
    const codeBlocks = hover.querySelectorAll('pre code, code');
    codeBlocks.forEach(block => {
      if (block.dataset.irPatched) return;
      block.dataset.irPatched = 'true';

      // Find PascalCase words (potential type names)
      const text = block.textContent;
      const typePattern = /\\b[A-Z][A-Za-z0-9_]+\\b/g;
      let match;
      const types = new Set();
      while ((match = typePattern.exec(text)) !== null) {
        types.add(match[0]);
      }

      if (types.size === 0) return;

      // Replace type names with interactive spans
      let html = block.innerHTML;
      for (const typeName of types) {
        const regex = new RegExp('\\\\b(' + typeName + ')\\\\b', 'g');
        html = html.replace(regex, '<span class="ir-type-link" data-type="$1">$1</span>');
      }
      block.innerHTML = html;

      // Style
      const style = document.createElement('style');
      style.textContent = \`
        .ir-type-link {
          cursor: default;
          transition: text-decoration 0.1s;
        }
        body.ir-cmd-held .ir-type-link {
          text-decoration: underline;
          cursor: pointer;
          color: var(--vscode-textLink-foreground);
        }
      \`;
      hover.appendChild(style);
    });
  }

  // Track Cmd key state
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) document.body.classList.add('ir-cmd-held');
  });
  document.addEventListener('keyup', (e) => {
    if (!e.metaKey && !e.ctrlKey) document.body.classList.remove('ir-cmd-held');
  });

  // Handle Cmd+Click on type names
  document.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target;
    if (!target.classList?.contains('ir-type-link')) return;

    const typeName = target.dataset.type;
    if (!typeName) return;

    e.preventDefault();
    e.stopPropagation();

    // Send command to extension host via VS Code's command system
    // The workbench exposes commandService on the window
    try {
      // Access VS Code's internal command service
      const commandService = window._commandService ||
        document.querySelector('.monaco-workbench')?.__proto__?.constructor?._services?.get?.('ICommandService');

      if (commandService) {
        commandService.executeCommand('intellisenseRecursion.goToType',
          window.activeEditor?.getModel()?.uri?.toString() || '', typeName);
      } else {
        // Fallback: use keyboard shortcut simulation or other mechanism
        console.log('[IR] goToType:', typeName);
      }
    } catch(err) {
      console.error('[IR] Error executing command:', err);
    }
  }, true);

  return 'hover patch installed';
})()
  `.trim();
}


// ---------- Type detection ----------

const SKIP_WORDS = new Set([
  'str', 'bool', 'dict', 'list', 'tuple', 'set', 'frozenset', 'bytes',
  'int', 'float', 'double', 'char', 'byte', 'short', 'long',
  'string', 'number', 'boolean', 'void', 'any', 'null', 'undefined',
  'never', 'unknown', 'object', 'symbol', 'bigint', 'true', 'false',
  'String', 'Number', 'Boolean', 'Object', 'Symbol', 'Function',
  'None', 'True', 'False', 'Optional', 'Union', 'Literal', 'Final',
  'Callable', 'Any', 'Type', 'ClassVar', 'Protocol', 'TypeVar',
  'Generic', 'Awaitable', 'Coroutine', 'Generator', 'Iterator',
  'Mapping', 'Sequence', 'Tuple', 'List', 'Dict', 'Set', 'Deque',
  'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'super', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'of', 'in',
  'async', 'await', 'yield', 'throw', 'try', 'catch', 'finally',
  'def', 'self', 'pass', 'with', 'isinstance', 'property',
  'public', 'private', 'protected', 'static', 'abstract',
  'method', 'constructor', 'field', 'getter', 'setter',
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

// ---------- goToType ----------

async function goToTypeHandler(docUriStr: string, typeName: string) {
  log.info(`[goToType] "${typeName}"`);
  try {
    const uri = vscode.Uri.parse(docUriStr);
    const doc = await vscode.workspace.openTextDocument(uri);
    const m = new RegExp(`\\b${esc(typeName)}\\b`).exec(doc.getText());
    if (!m) { vscode.window.showWarningMessage(`"${typeName}" not found.`); return; }
    const pos = doc.positionAt(m.index);
    const defs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider', uri, pos
    );
    if (!defs?.length) { vscode.window.showWarningMessage(`No definition for "${typeName}".`); return; }
    const d = defs[0];
    log.info(`[goToType] → ${d.uri.fsPath}:${d.range.start.line}`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(d.uri), {
      selection: d.range, preserveFocus: false
    });
  } catch (err) { log.error(`[goToType] ${err}`); }
}

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function deactivate() {
  log.info('Deactivating');
  log.dispose();
}
