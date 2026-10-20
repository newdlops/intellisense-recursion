import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { cdpRequest } from '../../cdp-eval';
import { httpGet } from '../../cdp-discovery';
import { PIN_HOVER_COMMAND } from '../../pin-hover-command';
import { buildDefinitionPreviewResult } from '../../preview-builder';

suite('Keyboard hover symbols', () => {
  let ws: WebSocket;
  let uri: vscode.Uri;
  const providers: vscode.Disposable[] = [];
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = async (expression: string): Promise<any> => {
    const response = await cdpRequest(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const waitFor = async (expression: string, label: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await evaluate(expression);
      if (result) { return result; }
      await pause(100);
    }
    const diagnostics = await evaluate(`(function(){var s=window.__irSymbolsTest&&window.__irSymbolsTest.first,q=document.querySelector('.quick-input-widget'),i=q&&q.querySelector('input');return {focus:document.activeElement&&document.activeElement.className,input:i&&i.value,pickerRect:q&&q.getBoundingClientRect().toJSON(),pickerTitle:q&&q.querySelector('.quick-input-title')&&q.querySelector('.quick-input-title').textContent,state:s&&{connected:!!s.el,busy:s.previewBusy,error:s.symbolError,disabled:s.symbolsButton.disabled,picker:s.symbolPicker&&{id:s.symbolPicker.id,query:s.symbolPicker.queryId,names:s.symbolPicker.names.slice(0,3)}}};})()`);
    assert.fail(label + ': ' + JSON.stringify(diagnostics));
  };
  const key = async (name: string, code: string, value: number, modifiers = 0, text?: string) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdpRequest(ws, 'Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: value, modifiers,
        ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
    }
  };
  const click = async (selector: string) => {
    const point = await waitFor(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x:x,y:y}:null;})()`, 'Pointer control must be hittable: ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdpRequest(ws, 'Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  };
  const typeQuery = async (text: string) => {
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2);
    await cdpRequest(ws, 'Input.insertText', { text });
  };
  const capture = async (name: string) => {
    const directory = process.env.IR_SYMBOL_CAPTURE_DIR;
    if (!directory) { return; }
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.mkdir(directory, { recursive: true });
    const result = await cdpRequest(ws, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  const pickerReady = () => waitFor(`(function(){var q=document.querySelector('.quick-input-widget'),s=window.__irSymbolsTest.first,p=s&&s.symbolPicker;if(!q||!p||!p.names.length)return false;var i=q.querySelector('input'),r=i&&i.getBoundingClientRect(),b=q.getBoundingClientRect(),row=Array.from(q.querySelectorAll('.monaco-list-row')).some(row=>row.textContent.includes(p.names[0])&&row.getBoundingClientRect().height>0);return !!(row&&r&&r.width&&i.contains(document.elementFromPoint(r.left+20,r.top+10))&&q.contains(document.elementFromPoint(b.left+b.width/2,Math.min(b.bottom-8,b.top+160)))&&document.activeElement===i);})()`, 'The native picker must show its results and own input above pinned panels');

  suiteSetup(async function () {
    if (process.env.IR_TEST_PRODUCTION_INJECTION !== '1') { this.skip(); return; }
    this.timeout(60000);
    const marker = process.env.IR_TEST_WINDOW_MARKER!;
    await vscode.workspace.getConfiguration('window').update('title', marker + ' — ${rootName}', vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    let page: any;
    for (let attempt = 0; attempt < 40 && !page; attempt++) {
      const pages = JSON.parse(await httpGet(`http://127.0.0.1:${process.env.IR_TEST_REMOTE_DEBUGGING_PORT}/json/list`));
      page = pages.find((row: any) => row.type === 'page' && String(row.title).includes(marker));
      if (!page) { await pause(100); }
    }
    assert.ok(page);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await cdpRequest(ws, 'Page.bringToFront');
    await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    const compact = process.env.IR_SYMBOL_VIEWPORT === 'compact';
    await cdpRequest(ws, 'Emulation.setDeviceMetricsOverride', { width: compact ? 1024 : 1440, height: compact ? 768 : 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(`typeof window.irReadDetachedHoverSymbols==='function'&&window.__irStyleEl.isConnected`, 'Production symbol picker must load');
    uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '__ir_keyboard_symbols_test__.py');
    const source = ['class KeyboardTailReference:', '    """선택한 정의의 설명을 보존합니다."""', '    tail_value = "KEYBOARD_TARGET_COMPLETE"', '',
      'class KeyboardCompleteDefinition:', '    """Keep all source and highlighting."""',
      ...Array.from({ length: 260 }, (_, i) => '    # CandidateType' + i),
      ...Array.from({ length: 10025 }, (_, i) => '    # source detail ' + i),
      '    final_owner: KeyboardTailReference', '    def late_callable(self): pass', '    final_value = "KEYBOARD_FULL_TAIL"', '',
      'value: KeyboardCompleteDefinition', ''].join('\n');
    await fs.writeFile(uri.fsPath, source);
    const document = await vscode.workspace.openTextDocument(uri);
    const preview = buildDefinitionPreviewResult('KeyboardCompleteDefinition', uri, document, 4, 6, false);
    // Deterministic language providers avoid waiting for a third-party index
    // of this freshly created 10,000-line fixture. Rendering, Pin, Quick Pick,
    // binding transport, definition delivery and Back use production code.
    providers.push(vscode.languages.registerHoverProvider({ language: 'python', scheme: 'file', pattern: uri.fsPath }, {
      provideHover: (_doc, position) => position.line === document.lineCount - 2
        ? new vscode.Hover(new vscode.MarkdownString(preview.preview), new vscode.Range(position.line, 7, position.line, 33)) : undefined,
    }), vscode.languages.registerDefinitionProvider({ language: 'python', scheme: 'file', pattern: uri.fsPath }, {
      provideDefinition: (doc, position) => {
        const range = doc.getWordRangeAtPosition(position);
        const word = range && doc.getText(range);
        const line = word === 'KeyboardTailReference' ? 0 : word === 'KeyboardCompleteDefinition' ? 4 : -1;
        return line < 0 ? undefined : new vscode.Location(uri, new vscode.Position(line, 6));
      },
    }));
  });

  suiteTeardown(async () => {
    for (const provider of providers) { provider.dispose(); }
    if (ws) {
      await evaluate('window.__irTestHooks.clearDetachedHovers(\'symbols-suite-cleanup\');delete window.__irSymbolsTest;');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      await cdpRequest(ws, 'Emulation.clearDeviceMetricsOverride');
      ws.close();
    }
    if (uri) { await fs.rm(uri.fsPath, { force: true }); }
  });

  setup(async function () {
    this.timeout(45000);
    await evaluate(`window.__irTestHooks.clearDetachedHovers('symbols-start');window.__irSymbolsTest={};`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.lineCount - 2;
    const position = new vscode.Position(line, doc.lineAt(line).text.indexOf('KeyboardCompleteDefinition') + 4);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
      ready = !!hovers?.some(hover => hover.contents.some(content =>
        (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('KEYBOARD_FULL_TAIL')));
      if (!ready) { await pause(150); }
    }
    assert.ok(ready, 'Use the real complete definition provider');
    await vscode.commands.executeCommand('editor.action.showHover');
    await waitFor(`(function(){var b=document.querySelector('.monaco-resizable-hover .ir-native-hover-pin');return b&&!b.disabled&&b.closest('.monaco-resizable-hover').textContent.includes('KEYBOARD_FULL_TAIL');})()`, 'Wait for complete native highlighting');
    const result = await vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND);
    assert.ok(result.ok, JSON.stringify(result));
    await evaluate(`(function(){var s=window.__irDetachedHovers[0];window.__irSymbolsTest.first=s; s.left=48;s.top=100;s.el.style.setProperty('left','48px','important');s.el.style.setProperty('top','100px','important');})()`);
    await waitFor(`document.activeElement===window.__irSymbolsTest.first.closeButton`, 'Pin must focus Close');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await evaluate('window.__irTestHooks.clearDetachedHovers(\'symbols-teardown\');');
    await vscode.commands.executeCommand('editor.action.hideHover');
  });

  test('keyboard search reaches the complete source tail, then Back restores all tokens and scroll', async function () {
    this.timeout(90000);
    try {
      await evaluate(`(function(){var t=window.__irSymbolsTest,s=t.first,sc=window.__irTestHooks.primaryHoverScroller(s.root);sc.scrollTop=2000;t.original={text:s.previewTarget.textContent,tokens:Array.from(s.root.querySelectorAll('[class*="mtk"]')).map(n=>n.className+'|'+n.textContent).join('\\n'),scroll:sc.scrollTop,links:s.root.querySelectorAll('.ir-type-link').length};})()`);
      await key('Tab', 'Tab', 9, 8);
      assert.strictEqual(await evaluate('document.activeElement===window.__irSymbolsTest.first.symbolsButton'), true);
      await capture('symbols-keyboard-button');
      await key('Enter', 'Enter', 13, 0, '\r');
      await pickerReady();
      await waitFor(`document.querySelector('.quick-input-widget .quick-input-title').textContent.includes('first 200 matches')`, 'The completed bounded list must show its narrowing hint');
      const bounded = await evaluate(`({count:window.__irSymbolsTest.first.symbolPicker.names.length,more:document.querySelector('.quick-input-widget').textContent.includes('first 200 matches'),links:window.__irSymbolsTest.first.root.querySelectorAll('.ir-type-link').length===window.__irSymbolsTest.original.links})`);
      assert.deepStrictEqual(bounded, { count: 200, more: true, links: true });
      await capture('symbols-native-list');
      await typeQuery('noSuchKeyboardSymbol');
      await waitFor(`document.querySelector('.quick-input-widget').textContent.includes('No matching symbols')`, 'Empty search must explain the next action');
      await capture('symbols-no-matches');
      await typeQuery('CandidateType');
      await typeQuery('late_callable');
      await waitFor(`(function(){var p=window.__irSymbolsTest.first.symbolPicker;return p&&p.names.length===1&&p.names[0]==='late_callable';})()`, 'A lowercase callable after the eager prefix must also be searchable');
      await pickerReady();
      await typeQuery('KeyboardTailReference');
      await waitFor(`(function(){var p=window.__irSymbolsTest.first.symbolPicker;return p&&p.names.length===1&&p.names[0]==='KeyboardTailReference';})()`, 'The newest query must find a name after 10,000 lines');
      await pickerReady();
      await capture('symbols-tail-match');
      await key('ArrowDown', 'ArrowDown', 40);
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`(function(){var s=window.__irSymbolsTest.first;return s.currentTypeName==='KeyboardTailReference'&&!s.previewBusy&&s.root.textContent.includes('KEYBOARD_TARGET_COMPLETE');})()`, 'Accept must use real isolated definition delivery');
      assert.strictEqual(await evaluate('window.__irSymbolsTest.first.symbolPicker===null'), true);
      await waitFor(`document.activeElement===window.__irSymbolsTest.first.closeButton`, 'Successful selection must return focus to the panel');
      await capture('symbols-preview-success');
      await key('Tab', 'Tab', 9, 8);
      assert.strictEqual(await evaluate('document.activeElement===window.__irSymbolsTest.first.backButton'), true);
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`(function(){var t=window.__irSymbolsTest,s=t.first;return s.previewTarget.textContent===t.original.text&&window.__irTestHooks.primaryHoverScroller(s.root).scrollTop===t.original.scroll;})()`, 'Back must restore the complete page and exact scroll');
      assert.strictEqual(await evaluate(`Array.from(window.__irSymbolsTest.first.root.querySelectorAll('[class*="mtk"]')).map(n=>n.className+'|'+n.textContent).join('\\n')===window.__irSymbolsTest.original.tokens`), true);
      await key('Escape', 'Escape', 27);
      await waitFor(`window.__irDetachedHovers.length===0&&!!document.activeElement.closest('.monaco-editor')`, 'Escape must close the focused panel and restore editor focus');
      assert.strictEqual(await evaluate(`!!document.querySelector('.monaco-workbench.ir-has-detached-hovers')`), false, 'The final panel releases its native input stacking override');
    } catch (error) {
      await capture('symbols-failure');
      console.log('  symbols diagnostics: ' + JSON.stringify(await evaluate(`({focus:document.activeElement&&document.activeElement.outerHTML.slice(0,300),picker:document.querySelector('.quick-input-widget')&&document.querySelector('.quick-input-widget').textContent,panels:window.__irTestHooks.detachedHoverSnapshot()})`)));
      throw error;
    }
  });

  test('pointer opening, cancel, independent panels and stale callbacks preserve source', async function () {
    this.timeout(60000);
    const second = await vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND);
    assert.ok(second.ok, JSON.stringify(second));
    await evaluate(`(function(){var t=window.__irSymbolsTest,s=window.__irDetachedHovers[1];t.second=s;t.otherText=s.previewTarget.textContent;t.first.width=t.first.naturalWidth=250;['width','min-width','max-width'].forEach(p=>t.first.el.style.setProperty(p,'250px','important'));s.width=s.naturalWidth=330;['width','min-width','max-width'].forEach(p=>s.el.style.setProperty(p,'330px','important'));s.left=650;s.top=100;s.el.style.setProperty('left','650px','important');s.el.style.setProperty('top','100px','important');})()`);
    const selector = await evaluate(`'.ir-detached-hover[data-ir-detached-hover-id="'+window.__irSymbolsTest.first.id+'"]'`);
    await click(selector + ' .ir-detached-hover-symbols');
    await pickerReady();
    await evaluate(`(function(){var s=window.__irSymbolsTest.first;window.irGoToType('DETACHED:'+JSON.stringify({op:'symbols-dismiss',sessionKey:s.sessionKey,pickerId:s.symbolPicker.id-1}));})()`);
    await pause(100);
    await pickerReady();
    await capture('symbols-narrow-and-independent');
    await key('Escape', 'Escape', 27);
    await waitFor(`document.activeElement===window.__irSymbolsTest.first.symbolsButton&&!window.__irSymbolsTest.first.symbolPicker`, 'Escape cancels only the picker and restores Symbols focus');
    assert.strictEqual(await evaluate('window.__irDetachedHovers.length'), 2);
    await key('Enter', 'Enter', 13, 0, '\r');
    await pickerReady();
    await key('P', 'KeyP', 80, process.platform === 'darwin' ? 12 : 10);
    await waitFor(`(function(){var q=document.querySelector('.quick-input-widget'),s=window.__irSymbolsTest.first;if(!q||s.symbolPicker)return false;var i=q.querySelector('input'),r=q.getBoundingClientRect();return i===document.activeElement&&r.height>0&&q.contains(document.elementFromPoint(r.left+r.width/2,Math.min(r.bottom-8,r.top+160)));})()`, 'Opening the command palette must keep its input and list above both panels');
    await key('Escape', 'Escape', 27);
    // A page transition invalidates all picker/query identities. A late
    // accept cannot navigate either the replaced page or another window.
    await click(selector + ' .ir-detached-hover-symbols');
    await pickerReady();
    const stale = await evaluate(`(function(){var s=window.__irSymbolsTest.first,p=s.symbolPicker,id=++s.previewRequestSeq;window.irApplyDetachedPreview(s.sessionKey,id,'Replacement','\`\`\`python\\nclass Replacement:\\n    owner: ClosedLateTarget\\n\`\`\`');window.irCommitDetachedPreview(s.sessionKey,id);return window.irFinishDetachedHoverSymbols(s.sessionKey,p.id,p.queryId,p.names[0],true,'');})()`);
    assert.deepStrictEqual(stale, { ok: false, reason: 'stale-picker' });
    await waitFor(`(function(){var q=document.querySelector('.quick-input-widget');return !q||q.getBoundingClientRect().height===0;})()`, 'Changing page must dismiss the native picker');
    assert.strictEqual(await evaluate('window.__irSymbolsTest.second.previewTarget.textContent===window.__irSymbolsTest.otherText'), true);
    await click(selector + ' .ir-detached-hover-symbols');
    await pickerReady();
    const closed = await evaluate(`(function(){var s=window.__irSymbolsTest.first,p=s.symbolPicker,key=s.sessionKey;window.__irTestHooks.removeDetachedHover(s,'symbols-close-test');return window.irFinishDetachedHoverSymbols(key,p.id,p.queryId,p.names[0],true,'');})()`);
    assert.deepStrictEqual(closed, { ok: false, reason: 'stale-picker' });
    await waitFor(`(function(){var q=document.querySelector('.quick-input-widget');return !q||q.getBoundingClientRect().height===0;})()`, 'Closing the source panel must dismiss its picker');
    assert.strictEqual(await evaluate('window.__irDetachedHovers.length'), 1);
    assert.strictEqual(await evaluate('window.__irSymbolsTest.second.previewTarget.textContent===window.__irSymbolsTest.otherText'), true);
  });

  test('missing acknowledgement and failed reads release the picker and preserve the page', async function () {
    this.timeout(30000);
    const selector = await evaluate(`'.ir-detached-hover[data-ir-detached-hover-id="'+window.__irSymbolsTest.first.id+'"]'`);
    await evaluate(`(function(){var t=window.__irSymbolsTest;t.binding=window.irGoToType;t.reader=window.irReadDetachedHoverSymbols;t.original=t.first.previewTarget.innerHTML;window.irGoToType=function(payload){var m=JSON.parse(payload.slice(9));if(m.op!=='symbols')t.binding(payload);};})()`);
    try {
      await click(selector + ' .ir-detached-hover-symbols');
      await waitFor(`(function(){var s=window.__irSymbolsTest.first;return !s.symbolPicker&&!s.symbolsButton.disabled&&s.titleLabel.textContent.includes('connection lost');})()`, 'A missing acknowledgement must release the disabled action and temporary source');
      await capture('symbols-connection-error');
      assert.strictEqual(await evaluate('window.__irSymbolsTest.first.previewTarget.innerHTML===window.__irSymbolsTest.original'), true);
      await evaluate(`window.irGoToType=window.__irSymbolsTest.binding;window.irReadDetachedHoverSymbols=async function(){var args=arguments;await new Promise(resolve=>setTimeout(resolve,400));return window.__irSymbolsTest.reader.apply(window,args);};`);
      await click(selector + ' .ir-detached-hover-symbols');
      await waitFor(`(function(){var s=window.__irSymbolsTest.first,q=document.querySelector('.quick-input-widget');return s.symbolPicker&&s.symbolsButton.disabled&&q&&q.getBoundingClientRect().height>0&&s.symbolPicker.queryId===0;})()`, 'Loading uses the native picker while the source stays available');
      await capture('symbols-loading');
      await pickerReady();
      await key('Escape', 'Escape', 27);
      await waitFor(`!window.__irSymbolsTest.first.symbolPicker&&document.activeElement===window.__irSymbolsTest.first.symbolsButton`, 'Cancel a completed delayed query');
      await evaluate(`window.irGoToType=window.__irSymbolsTest.binding;window.irReadDetachedHoverSymbols=async function(){return {ok:false,reason:'test-read-failed'};};`);
      await click(selector + ' .ir-detached-hover-symbols');
      await waitFor(`(function(){var s=window.__irSymbolsTest.first;return !s.symbolPicker&&!s.symbolsButton.disabled&&s.titleLabel.textContent.includes('Could not read symbols')&&document.activeElement===s.symbolsButton;})()`, 'Read failures must close the native picker and return focus for retry');
      assert.strictEqual(await evaluate('window.__irSymbolsTest.first.previewTarget.innerHTML===window.__irSymbolsTest.original'), true);
      await evaluate(`window.irReadDetachedHoverSymbols=window.__irSymbolsTest.reader;`);
      await key('Enter', 'Enter', 13, 0, '\r');
      await pickerReady();
      await key('Escape', 'Escape', 27);
      await waitFor(`document.activeElement===window.__irSymbolsTest.first.symbolsButton&&!window.__irSymbolsTest.first.symbolPicker`, 'Symbols can reopen after either error');
      await key('Enter', 'Enter', 13, 0, '\r');
      await pickerReady();
      await typeQuery('KeyboardTailReference');
      await waitFor(`window.__irSymbolsTest.first.symbolPicker.names[0]==='KeyboardTailReference'`, 'Prepare an interrupted definition request');
      await pickerReady();
      await evaluate(`window.irGoToType=function(payload){var m=JSON.parse(payload.slice(9));if(m.op==='preview')window.__irSymbolsTest.held=m;else window.__irSymbolsTest.binding(payload);};`);
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`window.__irSymbolsTest.held&&window.__irSymbolsTest.first.previewBusy&&!!window.__irDetachedSymbolFocus`, 'Keep one definition delivery pending');
      const editorPoint = await evaluate(`(function(){var s=window.__irSymbolsTest.first,e=s.originEditor.getDomNode(),r=e.getBoundingClientRect(),x=Math.min(window.innerWidth-32,r.left+80),y=Math.min(window.innerHeight-100,r.bottom-100);return {x:x,y:y,hit:e.contains(document.elementFromPoint(x,y))};})()`);
      assert.strictEqual(editorPoint.hit, true);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdpRequest(ws, 'Input.dispatchMouseEvent', { type, x: editorPoint.x, y: editorPoint.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
      await waitFor(`!window.__irDetachedSymbolFocus&&!!document.activeElement.closest('.monaco-editor')`, 'User pointer input cancels deferred panel focus');
      await evaluate(`(function(){var s=window.__irSymbolsTest.first,r=window.__irSymbolsTest.held;window.irApplyDetachedPreview(s.sessionKey,r.requestId,'KeyboardTailReference','\`\`\`python\\nclass KeyboardTailReference: pass\\n\`\`\`');window.irCommitDetachedPreview(s.sessionKey,r.requestId);})()`);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      assert.strictEqual(await evaluate(`!!document.activeElement.closest('.monaco-editor')&&!window.__irDetachedSymbolFocus`), true, 'Late delivery must not steal focus from the user');
    } finally {
      await evaluate(`window.irGoToType=window.__irSymbolsTest.binding;window.irReadDetachedHoverSymbols=window.__irSymbolsTest.reader;`);
    }
  });
});
