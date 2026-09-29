import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { httpGet } from '../../cdp-discovery';
import { cdpRequest } from '../../cdp-eval';
import { buildDefinitionPreviewResult } from '../../preview-builder';

suite('Complete preview rendering', () => {
  test('native and dragged panels can scroll to the end of a definition beyond 10,000 lines', async function () {
    if (process.env.IR_TEST_PRODUCTION_INJECTION !== '1') { this.skip(); return; }
    this.timeout(90000);
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const marker = process.env.IR_TEST_WINDOW_MARKER!;
    await vscode.workspace.getConfiguration('window').update('title', marker + ' — ${rootName}', vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    let page: any;
    for (let attempt = 0; attempt < 40 && !page; attempt++) {
      const pages = JSON.parse(await httpGet(`http://127.0.0.1:${process.env.IR_TEST_REMOTE_DEBUGGING_PORT}/json/list`));
      page = pages.find((p: any) => p.type === 'page' && String(p.title).includes(marker));
      if (!page) { await pause(100); }
    }
    assert.ok(page, 'Use the isolated test renderer');
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
    const mouse = (type: string, x: number, y: number, buttons = 0) => cdpRequest(ws, 'Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1,
    });
    const capture = async (name: string) => {
      const directory = process.env.IR_CONTENT_CAPTURE_DIR;
      if (!directory) { return; }
      await fs.mkdir(directory, { recursive: true });
      const result = await cdpRequest(ws, 'Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-complete-render-'));
    let provider: vscode.Disposable | undefined;
    try {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      await waitFor('window.__irTestHooks&&window.__irStyleEl&&window.__irStyleEl.isConnected', 'Production renderer injection');
      const code = [
        'class CompleteDefinition:',
        '    """Full description ... preserved."""',
        ...Array.from({ length: 10_025 }, (_, i) => `    # source detail ${i}`),
        '    final_value = "IR_PREVIEW_COMPLETE"',
      ].join('\n');
      const uri = vscode.Uri.file(path.join(directory, 'complete.py'));
      await fs.writeFile(uri.fsPath, code + '\nclass NextDefinition: pass\n');
      const source = await vscode.workspace.openTextDocument(uri);
      const preview = buildDefinitionPreviewResult('CompleteDefinition', uri, source, 0, 0, false);
      const anchor = await vscode.workspace.openTextDocument({ content: '\n'.repeat(18) + 'CompleteDefinition\n', language: 'plaintext' });
      const position = new vscode.Position(18, 4);
      // A deterministic provider still uses the actual builder, native Markdown
      // renderer, scrolling and pointer gestures from the production bundle.
      provider = vscode.languages.registerHoverProvider({ scheme: 'untitled', language: 'plaintext' }, {
        provideHover: () => new vscode.Hover(new vscode.MarkdownString(preview.preview), new vscode.Range(18, 0, 18, 18)),
      });
      const editor = await vscode.window.showTextDocument(anchor);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', anchor.uri, position);
      assert.ok(hovers?.some(hover => hover.contents.some(content => typeof content !== 'string' && content.value.includes('IR_PREVIEW_COMPLETE'))),
        'The native provider result must contain the full definition before painting');
      await vscode.commands.executeCommand('editor.action.showHover');
      const hover = await waitFor(`(function(){
        var w=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(w=>w.getBoundingClientRect().height>200&&w.textContent.includes('IR_PREVIEW_COMPLETE'));
        if(!w)return null;
        var text=w.textContent,r=w.getBoundingClientRect();
        return {rect:r.toJSON(),details:(text.match(/source detail /g)||[]).length,description:text.includes('Full description ... preserved.'),border:getComputedStyle(w).borderTopWidth};
      })()`, 'The entire source must reach the native rendered hover');
      assert.strictEqual(hover.details, 10_025);
      assert.strictEqual(hover.description, true);
      assert.strictEqual(hover.border, '1px');
      console.log('  complete native content: ' + JSON.stringify(hover));
      const point = { x: hover.rect.right - 50, y: hover.rect.top + 70 };
      await mouse('mouseMoved', point.x, point.y);
      await mouse('mousePressed', point.x, point.y, 1);
      await mouse('mouseReleased', point.x, point.y);
      await capture('native-complete-start');
      // Read the last actual rendered source line and require it to be inside
      // the scroll viewport, not merely present somewhere in offscreen DOM.
      const visibleTail = (selector: string) => `(function(){
        var root=document.querySelector(${JSON.stringify(selector)});if(!root)return null;
        var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),node;
        while(node=walker.nextNode()){
          if(!node.textContent.includes('IR_PREVIEW_COMPLETE'))continue;
          var range=document.createRange();range.selectNodeContents(node);
          var r=range.getBoundingClientRect(),b=root.getBoundingClientRect();
          if(r.height>0&&r.top>=b.top&&r.bottom<=b.bottom)return {line:node.textContent,rect:r.toJSON()};
        }
        return null;
      })()`;
      const scrollToTail = async (selector: string) => {
        for (let attempt = 0; attempt < 12; attempt++) {
          if (await evaluate(visibleTail(selector))) { return; }
          const rect = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
          const point = { x: rect.right - 50, y: rect.top + 70 };
          await mouse('mouseMoved', point.x, point.y);
          await cdpRequest(ws, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1_000_000 });
          // Native code fences finish tokenizing asynchronously. Keep scrolling
          // as the later blocks acquire their final height.
          await pause(300);
        }
        assert.ok(await evaluate(visibleTail(selector)), 'The last source line must be visible after scrolling');
      };
      await scrollToTail('.monaco-resizable-hover');
      await capture('native-complete-tail');
      // Drag unused space in the body so the content survives native dismissal.
      const rect = await evaluate("document.querySelector('.monaco-resizable-hover').getBoundingClientRect().toJSON()");
      const x = rect.right - 50, y = rect.top + 55;
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, 1);
      try {
        for (let step = 1; step <= 8; step++) {
          await mouse('mouseMoved', x + 100 * step / 8, y + 45 * step / 8, 1);
        }
      } finally { await mouse('mouseReleased', x + 100, y + 45); }
      await mouse('mouseMoved', 12, 12);
      await vscode.commands.executeCommand('editor.action.hideHover');
      const detached = await waitFor(`(function(){
        var w=document.querySelector('.ir-detached-hover');if(!w)return null;
        var text=w.textContent;return {rect:w.getBoundingClientRect().toJSON(),details:(text.match(/source detail /g)||[]).length,hasTail:text.includes('IR_PREVIEW_COMPLETE')};
      })()`, 'Dragging must retain a complete persistent panel');
      assert.strictEqual(detached.details, 10_025);
      assert.strictEqual(detached.hasTail, true);
      await scrollToTail('.ir-detached-hover');
      await capture('detached-complete-tail');
      // A split native preview consists of multiple Markdown roots. The
      // detached navigation lane must replace and restore all of those roots.
      const forward = await evaluate(`(function(){
        var state=window.__irDetachedHovers[0],id=++state.previewRequestSeq;
        var result=window.irApplyDetachedPreview(state.sessionKey,id,'ShortDefinition','\`\`\`python\\nclass ShortDefinition: pass\\n\`\`\`');
        window.irCommitDetachedPreview(state.sessionKey,id);
        return {ok:result.ok,text:state.root.textContent};
      })()`);
      assert.strictEqual(forward.ok, true);
      assert.ok(forward.text.includes('ShortDefinition'));
      assert.ok(!forward.text.includes('source detail'), 'Navigation must replace every continuation block');
      const back = await evaluate("document.querySelector('.ir-detached-hover-back').getBoundingClientRect().toJSON()");
      await mouse('mouseMoved', back.left + back.width / 2, back.top + back.height / 2);
      await mouse('mousePressed', back.left + back.width / 2, back.top + back.height / 2, 1);
      await mouse('mouseReleased', back.left + back.width / 2, back.top + back.height / 2);
      await waitFor("(document.querySelector('.ir-detached-hover').textContent.match(/source detail /g)||[]).length===10025", 'Back must restore every source line');
      await scrollToTail('.ir-detached-hover');
      await capture('detached-restored-tail');
    } catch (err) {
      await capture('content-failure');
      console.log('  complete-content renderer failure: ' + JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('.monaco-hover')).map(h=>({rect:h.getBoundingClientRect().toJSON(),length:h.textContent.length,head:h.textContent.slice(0,200),tail:h.textContent.slice(-200),details:(h.textContent.match(/source detail /g)||[]).length,scrollers:Array.from(h.querySelectorAll('.monaco-scrollable-element')).map(s=>({top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,rect:s.getBoundingClientRect().toJSON()})),html:h.innerHTML.slice(-600)}))`)));
      throw err;
    } finally {
      provider?.dispose();
      await evaluate('window.__irTestHooks&&window.__irTestHooks.clearDetachedHovers()');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      ws.close();
      await vscode.commands.executeCommand('editor.action.hideHover');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
