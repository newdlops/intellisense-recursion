import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { cdpRequest } from '../../cdp-eval';
import { httpGet } from '../../cdp-discovery';
import { buildDefinitionPreviewResult } from '../../preview-builder';
import { PIN_HOVER_COMMAND } from '../../pin-hover-command';

suite('Explicit hover pinning', () => {
  let ws: WebSocket | undefined;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = async (expression: string) => {
    const result = await cdpRequest(ws!, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression: string, label: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await evaluate(expression);
      if (result) { return result; }
      await pause(100);
    }
    assert.fail(label);
  };
  const key = async (keyName: string, code: string, windowsVirtualKeyCode: number, modifiers = 0, text?: string) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdpRequest(ws!, 'Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode, modifiers,
        ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
    }
  };
  const click = async (selector: string) => {
    const point = await waitFor(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x:x,y:y}:null;})()`, 'The control must receive pointer input: ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdpRequest(ws!, 'Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      if (selector.includes('ir-native-hover-pin')) {
        await evaluate(`(function(){var t=window.__irPinTest;if(!t)return;t.trace=t.trace||[];var r=document.querySelector('.monaco-resizable-hover .monaco-hover');t.trace.push({event:${JSON.stringify(type)},native:r?window.__irTestHooks.primaryHoverScroller(r).scrollTop:null,detached:(window.__irDetachedHovers||[]).map(s=>({top:window.__irTestHooks.primaryHoverScroller(s.root).scrollTop,captured:s.capturedScrollTop})),focus:document.activeElement&&document.activeElement.className});})()`);
      }
    }
  };
  const capture = async (name: string) => {
    const directory = process.env.IR_PIN_CAPTURE_DIR;
    if (!directory) { return; }
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.mkdir(directory, { recursive: true });
    const result = await cdpRequest(ws!, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
  };

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
    assert.ok(page, 'Use the isolated test workbench');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
    await cdpRequest(ws, 'Page.bringToFront');
    await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor('window.__irStyleEl&&window.__irStyleEl.isConnected&&typeof window.irPinVisibleHover===\'function\'', 'Production Pin controls must load');
  });

  suiteTeardown(async () => {
    if (!ws) { return; }
    await evaluate('window.__irTestHooks.clearDetachedHovers(\'pin-suite-cleanup\');delete window.__irPinTest;');
    await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    ws.close();
  });

  test('mouse, command and command-palette pinning preserve full source, Back and independent windows', async function () {
    this.timeout(90000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-pin-source-'));
    let provider: vscode.Disposable | undefined;
    try {
      await evaluate('window.__irTestHooks.clearDetachedHovers(\'pin-start\');');
      const code = ['class CompletePinnedDefinition:', '    """Complete description remains visible."""',
        ...Array.from({ length: 10025 }, (_, i) => '    # source detail ' + i),
        '    final_value = "PIN_COMPLETE_TAIL"'].join('\n');
      const sourceUri = vscode.Uri.file(path.join(directory, 'complete.py'));
      await fs.writeFile(sourceUri.fsPath, code + '\nclass NextDefinition: pass\n');
      const source = await vscode.workspace.openTextDocument(sourceUri);
      const preview = buildDefinitionPreviewResult('CompletePinnedDefinition', sourceUri, source, 0, 0, false);
      const anchor = await vscode.workspace.openTextDocument({ content: '\n'.repeat(18) + 'CompletePinnedDefinition\n', language: 'plaintext' });
      provider = vscode.languages.registerHoverProvider({ scheme: 'untitled', language: 'plaintext' }, {
        provideHover: document => document.uri.toString() === anchor.uri.toString()
          ? new vscode.Hover(new vscode.MarkdownString(preview.preview), new vscode.Range(18, 0, 18, 24)) : undefined,
      });
      const editor = await vscode.window.showTextDocument(anchor);
      editor.selection = new vscode.Selection(18, 4, 18, 4);
      editor.revealRange(new vscode.Range(18, 4, 18, 4), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.showHover');
      await waitFor(`(function(){var w=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(w=>w.textContent.includes('PIN_COMPLETE_TAIL')&&w.getBoundingClientRect().height>100);if(!w)return false;var b=w.querySelector('.ir-native-hover-pin');return b&&!b.disabled&&(w.textContent.match(/source detail /g)||[]).length===10025;})()`, 'A complete native source and enabled Pin must be visible');
      await capture('pin-native');
      const wheelPoint = await evaluate(`(function(){var w=document.querySelector('.monaco-resizable-hover'),r=w.getBoundingClientRect();return {x:r.right-60,y:r.top+90};})()`);
      await cdpRequest(ws!, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...wheelPoint, button: 'none' });
      await cdpRequest(ws!, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaY: 2000, deltaX: 0 });
      await waitFor(`(function(){var h=document.querySelector('.monaco-resizable-hover .monaco-hover');return h&&window.__irTestHooks.primaryHoverScroller(h).scrollTop>1000;})()`, 'The native body must scroll while Pin stays reachable');
      for (let attempt = 0; attempt < 20; attempt++) {
        const before = await evaluate(`window.__irTestHooks.primaryHoverScroller(document.querySelector('.monaco-resizable-hover .monaco-hover')).scrollTop`);
        await pause(75);
        const after = await evaluate(`window.__irTestHooks.primaryHoverScroller(document.querySelector('.monaco-resizable-hover .monaco-hover')).scrollTop`);
        if (before === after) { break; }
      }
      const original = await evaluate(`(function(){var w=document.querySelector('.monaco-resizable-hover'),root=w.querySelector('.monaco-hover'),sc=window.__irTestHooks.primaryHoverScroller(root),blocks=Array.from(root.querySelectorAll('.rendered-markdown'));window.__irPinTest={text:blocks.map(b=>b.textContent).join(''),tokens:Array.from(root.querySelectorAll('.monaco-tokenized-source [class*="mtk"]')).map(n=>n.className+'|'+n.textContent).join('\\n'),scroll:sc.scrollTop};return {scroll:sc.scrollTop,pins:w.querySelectorAll('.ir-native-hover-pin').length};})()`);
      assert.strictEqual(original.pins, 1);
      await capture('pin-native-scrolled');
      await click('.monaco-resizable-hover .ir-native-hover-pin');
      const first = await waitFor(`(function(){var a=window.__irDetachedHovers||[];if(a.length!==1)return null;var s=a[0],t=window.__irPinTest;window.__irPinTest.first=s;var sc=window.__irTestHooks.primaryHoverScroller(s.root);if(sc.scrollTop!==t.scroll)return null;return {id:s.id,key:s.sessionKey,text:s.root.querySelector('.rendered-markdown').textContent===t.text,tokens:Array.from(s.root.querySelectorAll('.monaco-tokenized-source [class*="mtk"]')).map(n=>n.className+'|'+n.textContent).join('\\n')===t.tokens,scroll:sc.scrollTop,controls:s.root.querySelectorAll('.ir-native-hover-actions').length,focused:document.activeElement===s.closeButton};})()`, 'Mouse Pin must create one complete independent window at the saved scroll position');
      assert.strictEqual(first.text, true);
      assert.strictEqual(first.tokens, true);
      assert.strictEqual(first.scroll, original.scroll, JSON.stringify(await evaluate('window.__irPinTest.trace')));
      assert.strictEqual(first.controls, 0);
      assert.strictEqual(first.focused, true);
      await capture('pin-mouse-detached');
      const applied = await evaluate(`(function(){var s=window.__irPinTest.first,id=++s.previewRequestSeq,r=window.irApplyDetachedPreview(s.sessionKey,id,'NextDefinition','\`\`\`python\\nclass NextDefinition: pass\\n\`\`\`');window.irCommitDetachedPreview(s.sessionKey,id);return r.ok;})()`);
      assert.strictEqual(applied, true);
      await key('Tab', 'Tab', 9, 8);
      assert.strictEqual(await evaluate('document.activeElement===window.__irPinTest.first.backButton'), true);
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`(function(){var t=window.__irPinTest,s=t.first;return s.root.querySelector('.rendered-markdown').textContent===t.text&&window.__irTestHooks.primaryHoverScroller(s.root).scrollTop===t.scroll;})()`, 'Back must restore complete source and its exact scroll offset');
      assert.strictEqual(await evaluate('document.activeElement===window.__irPinTest.first.closeButton'), true,
        'When Back disappears, Close must retain keyboard focus');
      await evaluate(`(function(){var s=window.__irPinTest.first;s.left=48;s.top=100;s.width=s.naturalWidth=250;s.el.style.setProperty('left','48px','important');s.el.style.setProperty('top','100px','important');['width','min-width','max-width'].forEach(p=>s.el.style.setProperty(p,'250px','important'));})()`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      const [a, b] = await Promise.all([
        vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND), vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND),
      ]);
      assert.ok(a?.ok, JSON.stringify(a));
      assert.strictEqual(b?.id, a.id, 'Concurrent commands must share one Pin operation');
      assert.notStrictEqual(a.id, first.id);
      assert.strictEqual(await evaluate('(window.__irDetachedHovers||[]).length'), 2);
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`(window.__irDetachedHovers||[]).length===1&&!!document.activeElement.closest('.monaco-editor')&&!document.activeElement.closest('.ir-detached-hover')`, 'Enter on Close must return focus to the editor and keep the first window');
      // Exercise the public command from the real palette, including native
      // dismissal when focus leaves the editor and reopening at the cursor.
      await key('P', 'KeyP', 80, 12);
      await waitFor(`(function(){var q=document.querySelector('.quick-input-widget');return q&&q.getBoundingClientRect().height>0;})()`, 'The command palette must open from keyboard input');
      await cdpRequest(ws!, 'Input.insertText', { text: 'IR: Pin Hover at Cursor' });
      await waitFor(`document.querySelector('.quick-input-widget').textContent.includes('IR: Pin Hover at Cursor')`, 'The Pin command must be discoverable in the palette');
      await key('Enter', 'Enter', 13, 0, '\r');
      await waitFor(`(function(){var a=window.__irDetachedHovers||[];if(a.length!==2)return false;var s=a.find(s=>s.id!==${first.id}),t=window.__irPinTest;return s&&document.activeElement===s.closeButton&&s.root.querySelector('.rendered-markdown').textContent===t.text&&t.first.root.textContent.includes('PIN_COMPLETE_TAIL');})()`, 'Keyboard Pin must retain complete source and leave the first window intact');
      await waitFor(`(function(){var a=window.__irDetachedHovers||[],f=window.__irPinTest.first,s=a.find(s=>s.id!==f.id);if(!s)return false;var r=f.el.getBoundingClientRect(),b=s.el.getBoundingClientRect();return r.width===250&&r.right<=b.left&&f.el.contains(document.elementFromPoint(r.left+20,r.top+12));})()`, 'Both independent panels must remain visible for narrow-panel QA');
      await capture('pin-keyboard-and-narrow');
      await key('Escape', 'Escape', 27);
      await waitFor(`(window.__irDetachedHovers||[]).length===1&&!!document.activeElement.closest('.monaco-editor')&&!document.activeElement.closest('.ir-detached-hover')`, 'Escape must close only the focused window and restore editor focus');
      await click(`.ir-detached-hover[data-ir-detached-hover-id="${first.id}"] .ir-detached-hover-close`);
      assert.strictEqual(await evaluate('(window.__irDetachedHovers||[]).length'), 0);
    } catch (error) {
      await capture('pin-failure');
      console.log('  Pin failure: ' + JSON.stringify(await evaluate(`({focus:document.activeElement&&document.activeElement.className,trace:window.__irPinTest&&window.__irPinTest.trace,windows:window.__irTestHooks.detachedHoverSnapshot().windows.map(s=>({id:s.id,rect:s.rect,scrollTop:s.scrollTop,captured:s.capturedScrollTop})),native:Array.from(document.querySelectorAll('.monaco-resizable-hover')).map(w=>({rect:w.getBoundingClientRect().toJSON(),head:w.textContent.slice(0,160)}))})`)));
      throw error;
    } finally {
      provider?.dispose();
      await evaluate('window.__irTestHooks.clearDetachedHovers(\'pin-test-finally\');delete window.__irPinTest;');
      await vscode.commands.executeCommand('editor.action.hideHover');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('missing hover and missing editor never create empty pinned windows', async function () {
    this.timeout(20000);
    const document = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
    const editor = await vscode.window.showTextDocument(document);
    const result = await vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND);
    assert.deepStrictEqual(result, { ok: false, reason: 'no-native-hover' });
    assert.strictEqual(vscode.window.activeTextEditor, editor);
    assert.strictEqual(await evaluate('(window.__irDetachedHovers||[]).length'), 0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const missing = await vscode.commands.executeCommand<any>(PIN_HOVER_COMMAND);
    assert.deepStrictEqual(missing, { ok: false, reason: 'no-editor' });
    assert.strictEqual(await evaluate('(window.__irDetachedHovers||[]).length'), 0);
  });
});
