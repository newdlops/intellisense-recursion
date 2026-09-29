import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { httpGet } from '../../cdp-discovery';
import { cdpRequest } from '../../cdp-eval';

suite('Production renderer startup', () => {
  test('automatic injection preserves the border, native resize, link bridge and persistent drag', async function () {
    if (process.env.IR_TEST_PRODUCTION_INJECTION !== '1') { this.skip(); return; }
    this.timeout(90000);
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const marker = process.env.IR_TEST_WINDOW_MARKER!;
    await vscode.workspace.getConfiguration('window').update('title', marker + ' — ${rootName}', vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension('newdlops.intellisense-recursion');
    assert.ok(extension, 'The production bundle must be available');
    await extension!.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(!commands.includes('intellisenseRecursion.runHoverRendererHarnessForTests'),
      'Run this regression with the shipping bundle, without test injection commands');

    let page: any;
    for (let attempt = 0; attempt < 30 && !page; attempt++) {
      const pages = JSON.parse(await httpGet(`http://127.0.0.1:${process.env.IR_TEST_REMOTE_DEBUGGING_PORT}/json/list`));
      page = pages.find((p: any) => p.type === 'page' && String(p.title).includes(marker));
      if (!page) { await pause(100); }
    }
    assert.ok(page, 'The isolated test renderer must be available');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const evaluate = async (expression: string) => {
      const result = await cdpRequest(ws, 'Runtime.evaluate', { expression, returnByValue: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression: string, label: string) => {
      let value: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        value = await evaluate(expression);
        if (value) { return value; }
        await pause(150);
      }
      assert.fail(`${label}: ${JSON.stringify(value)}`);
    };
    const snapshot = () => waitFor(`(function(){
      var w=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(function(w){var r=w.getBoundingClientRect();return r.width>60&&r.height>20&&getComputedStyle(w).visibility==='visible'&&w.textContent.includes('def save')&&window.__irTestHooks.hoverOwnerForWrapper(w).widget});
      if(!w)return null;
      var cs=getComputedStyle(w),r=w.getBoundingClientRect();
      var owner=window.__irTestHooks.hoverOwnerForWrapper(w);
      return {rect:r.toJSON(),border:[cs.borderTopWidth,cs.borderRightWidth,cs.borderBottomWidth,cs.borderLeftWidth],style:cs.borderTopStyle,color:cs.borderTopColor,
        native:{width:owner.widget._resizableNode.size.width,height:owner.widget._resizableNode.size.height},
        above:owner.widget._positionPreference===1};
    })()`, 'The visible hover must have an owning native widget');
    const waitForContentFit = () => waitFor(`(function(){
      var w=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(w=>w.getBoundingClientRect().height>20&&w.textContent.includes('def save'));
      var h=w&&w.querySelector('.monaco-hover'),s=h&&window.__irTestHooks.primaryHoverScroller(h);
      return !!(w&&s&&w.getBoundingClientRect().height>200&&s.scrollHeight-s.clientHeight<10);
    })()`, 'The short preview must finish growing to fit its content');
    const mouse = (type: string, x: number, y: number, buttons = 0) => cdpRequest(ws, 'Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1,
    });
    const capture = async (name: string) => {
      const directory = process.env.IR_STARTUP_CAPTURE_DIR;
      if (!directory) { return; }
      fs.mkdirSync(directory, { recursive: true });
      const result = await cdpRequest(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    try {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      // Observe automatic startup; never call a renderer injection harness.
      const startup = await waitFor(`window.__irTestHooks&&window.__irStyleEl&&window.__irStyleEl.isConnected&&({version:window.__irPatchVersion,phase:window.__irHostWindowMeta&&window.__irHostWindowMeta.phase})`,
        'Automatic renderer installation did not complete');
      assert.strictEqual(startup.phase, 'initial', 'Use the normal main-process injection path');
      console.log('  production startup: ' + JSON.stringify(startup));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'service.py'));
      const editor = await vscode.window.showTextDocument(doc);
      const line = doc.getText().split(/\r?\n/).findIndex(text => text.includes('def process_model(model: BaseModel)'));
      assert.ok(line >= 0);
      const position = new vscode.Position(line, doc.lineAt(line).text.indexOf('BaseModel') + 3);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      for (let attempt = 0; attempt < 40; attempt++) {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
        if (hovers?.length) { break; }
        await pause(250);
      }
      await vscode.commands.executeCommand('editor.action.showHover');
      await waitFor(`Array.from(document.querySelectorAll('.monaco-resizable-hover')).some(w=>w.getBoundingClientRect().height>20&&w.textContent.includes('def save'))`, 'Native hover did not appear');
      await waitForContentFit();
      const initial = await snapshot();
      assert.deepStrictEqual(initial.border, ['1px', '1px', '1px', '1px']);
      assert.strictEqual(initial.style, 'solid');
      assert.notStrictEqual(initial.color, 'rgba(0, 0, 0, 0)');
      await capture('native-1px-border');
      await mouse('mouseMoved', initial.rect.left + 24, initial.above ? initial.rect.bottom - 12 : initial.rect.top + 12);
      // Real native sash input on the first hover also covers short content:
      // manual dimensions must exceed its natural content without detaching.
      for (const edge of ['right', 'corner']) {
        const handle = await waitFor(`(function(){
          var wrapper=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(w=>w.getBoundingClientRect().height>20&&getComputedStyle(w).visibility==='visible'&&w.textContent.includes('def save')&&window.__irTestHooks.hoverOwnerForWrapper(w).widget);
          if(!wrapper)return null;
          var above=window.__irTestHooks.hoverOwnerForWrapper(wrapper).widget._positionPreference===1;
          var sash=Array.from(wrapper.querySelectorAll('.monaco-sash:not(.disabled)')).find(el=>${JSON.stringify(edge)}==='right'
            ?el.classList.contains('vertical'):el.classList.contains(above?'orthogonal-edge-north':'orthogonal-edge-south'));
          if(!sash)return null;
          var handle=${JSON.stringify(edge)}==='corner'?sash.querySelector('.orthogonal-drag-handle.end'):sash;
          if(!handle)return null;
          var r=handle.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
          return r.width&&r.height&&handle.contains(document.elementFromPoint(x,y))?{x:x,y:y,above:above,hit:true}:null;
        })()`, `${edge} resize handle must be visible and owned by the native hover`);
        assert.ok(handle.hit, `${edge} resize handle must receive pointer input`);
        const beforeResize = await snapshot();
        const dx = edge === 'right' ? 50 : 25;
        const dy = edge === 'right' ? 0 : (handle.above ? -40 : 40);
        await mouse('mouseMoved', handle.x, handle.y);
        await mouse('mousePressed', handle.x, handle.y, 1);
        try {
          for (let step = 1; step <= 5; step++) {
            await mouse('mouseMoved', handle.x + dx * step / 5, handle.y + dy * step / 5, 1);
          }
        } finally { await mouse('mouseReleased', handle.x + dx, handle.y + dy); }
        const resized = await snapshot();
        assert.ok(resized.rect.width > beforeResize.rect.width + dx - 10, 'Native width must follow the sash drag');
        if (dy) { assert.ok(resized.rect.height > beforeResize.rect.height + 25, 'Corner drag must expand short content vertically'); }
        assert.ok(Math.abs(resized.native.width - resized.rect.width) <= 2);
        assert.ok(Math.abs(resized.native.height - resized.rect.height) <= 2);
        assert.strictEqual(await evaluate('(window.__irDetachedHovers||[]).length'), 0);
      }
      await capture('native-resized');
      const preferredSize = await snapshot();
      const link = await waitFor(`(function(){
        var links=Array.from(document.querySelectorAll('.monaco-resizable-hover .ir-type-link[data-type="BaseModel"]'));
        for(var link of links){var r=link.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(r.width&&link.contains(document.elementFromPoint(x,y)))return {x:x,y:y};}
        return null;
      })()`, 'A visible type link must be clickable');
      await mouse('mouseMoved', link.x, link.y);
      await mouse('mousePressed', link.x, link.y, 1);
      await mouse('mouseReleased', link.x, link.y);
      let preview: any;
      for (let attempt = 0; attempt < 80; attempt++) {
        preview = await vscode.commands.executeCommand('intellisenseRecursion.getPatchStatus');
        if (preview?.currentPreviewIdentifier === 'BaseModel') { break; }
        await pause(150);
      }
      assert.strictEqual(preview?.currentPreviewIdentifier, 'BaseModel', 'The production click bridge must reach the extension host');
      await waitFor(`Array.from(document.querySelectorAll('.monaco-resizable-hover')).some(w=>w.getBoundingClientRect().height>20&&w.textContent.includes('Back')&&w.textContent.includes('def save'))`, 'The clicked page must render');
      await waitForContentFit();
      const before = await snapshot();
      assert.ok(Math.abs(before.rect.width - preferredSize.rect.width) <= 2
        && Math.abs(before.rect.height - preferredSize.rect.height) <= 2,
      `Drilling must preserve the completed manual resize: ${JSON.stringify({before:preferredSize.rect,after:before.rect})}`);
      const x = before.rect.right - 70, y = before.rect.top + 50;
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, 1);
      try {
        for (let step = 1; step <= 8; step++) {
          await mouse('mouseMoved', x - 160 * step / 8, y + 48 * step / 8, 1);
        }
      } finally {
        await mouse('mouseReleased', x - 160, y + 48);
      }
      await mouse('mouseMoved', 12, 12);
      await vscode.commands.executeCommand('editor.action.hideHover');
      await pause(1500);
      const detached = await evaluate('window.__irTestHooks.detachedHoverSnapshot()');
      assert.strictEqual(detached.count, 1, 'Dragging must persist the panel after native dismissal');
      assert.ok(detached.windows[0].text.includes('def save'));
      assert.ok(detached.windows[0].rect.left < before.rect.left - 100, 'The panel must follow the drag');
      assert.strictEqual(await evaluate("getComputedStyle(document.querySelector('.ir-detached-hover')).borderTopWidth"), '1px');
      await capture('persistent-drag');
      console.log('  production border and drag: ' + JSON.stringify({ border: initial.border, detached: detached.count }));
    } finally {
      await evaluate('window.__irTestHooks&&window.__irTestHooks.clearDetachedHovers()');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      ws.close();
      await vscode.commands.executeCommand('editor.action.hideHover');
    }
  });
});
