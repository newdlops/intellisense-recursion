import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { cdpRequest } from '../../cdp-eval';
import { httpGet } from '../../cdp-discovery';

suite('Detached preview recovery', () => {
  test('failure and mouse or Enter retries preserve long source, scroll and independent windows', async function () {
    if (process.env.IR_TEST_PRODUCTION_INJECTION !== '1') { this.skip(); return; }
    this.timeout(90000);
    const marker = process.env.IR_TEST_WINDOW_MARKER!;
    await vscode.workspace.getConfiguration('window').update('title', marker + ' — ${rootName}', vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    let page: any;
    for (let attempt = 0; attempt < 30 && !page; attempt++) {
      const pages = JSON.parse(await httpGet(`http://127.0.0.1:${process.env.IR_TEST_REMOTE_DEBUGGING_PORT}/json/list`));
      page = pages.find((row: any) => row.type === 'page' && String(row.title).includes(marker));
      if (!page) { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(page);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const evaluate = async (expression: string) => {
      const result = await cdpRequest(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click = async (selector: string) => {
      const point = await evaluate(`(function(){var e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdpRequest(ws, 'Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
    };
    const capture = async (name: string) => {
      const directory = process.env.IR_RECOVERY_CAPTURE_DIR;
      if (!directory) { return; }
      fs.mkdirSync(directory, { recursive: true });
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const result = await cdpRequest(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
    };
    let provider: vscode.Disposable | undefined;
    try {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        ready = !!await evaluate('window.__irTestHooks&&window.__irStyleEl&&window.__irStyleEl.isConnected');
        if (!ready) { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      assert.ok(ready, 'Production renderer injection must complete');
      const code = 'class CompleteOriginal:\n'
        + Array.from({ length: 10025 }, (_, i) => '    # source detail ' + i).join('\n')
        + '\n    final_value = "COMPLETE_ORIGINAL_TAIL"';
      const anchor = await vscode.workspace.openTextDocument({ content: '\n'.repeat(18) + 'CompleteOriginal\n', language: 'plaintext' });
      provider = vscode.languages.registerHoverProvider({ scheme: 'untitled', language: 'plaintext' }, {
        provideHover: () => new vscode.Hover(new vscode.MarkdownString('```python\n' + code + '\n```'), new vscode.Range(18, 0, 18, 16)),
      });
      const editor = await vscode.window.showTextDocument(anchor);
      editor.selection = new vscode.Selection(18, 4, 18, 4);
      editor.revealRange(new vscode.Range(18, 4, 18, 4), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.showHover');
      let nativeReady = false;
      for (let attempt = 0; attempt < 100 && !nativeReady; attempt++) {
        nativeReady = !!await evaluate(`Array.from(document.querySelectorAll('.monaco-resizable-hover')).some(w=>w.getBoundingClientRect().height>100&&w.textContent.includes('COMPLETE_ORIGINAL_TAIL'))`);
        if (!nativeReady) { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      assert.ok(nativeReady, 'Use the native Markdown renderer and its real scrolling structure');
      const setup = await evaluate(`(async function(){
        var hooks=window.__irTestHooks;if(!hooks)return null;
        hooks.clearDetachedHovers('recovery-test');
        window.__irRecoveryTest={originalBinding:window.irGoToType,requests:[]};
        window.irGoToType=function(payload){window.__irRecoveryTest.requests.push(JSON.parse(payload.slice(9)));};
        var wrapper=Array.from(document.querySelectorAll('.monaco-resizable-hover')).find(w=>w.textContent.includes('COMPLETE_ORIGINAL_TAIL'));
        var root=wrapper.querySelector('.monaco-hover,.monaco-editor-hover');
        function make(left,width){
          var state=hooks.createDetachedHoverSnapshot({wrapper:wrapper,root:root});
          if(!state)return null;
          state.el.style.setProperty('left',left+'px','important');
          state.el.style.setProperty('top','100px','important');
          ['width','min-width','max-width'].forEach(p=>state.el.style.setProperty(p,width+'px','important'));
          ['height','min-height','max-height'].forEach(p=>state.el.style.setProperty(p,'388px','important'));
          return state;
        }
        var first=make(48,520),second=make(650,330);
        if(!first||!second)return null;
        second.root.querySelector('.monaco-hover-content').textContent='Second window original source';
        await new Promise(function(resolve){requestAnimationFrame(resolve);});
        var sc=hooks.primaryHoverScroller(first.root);
        for(var attempt=0;attempt<40&&sc.scrollHeight<=sc.clientHeight;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
        sc.scrollTop=2000;
        window.__irRecoveryTest.first=first;window.__irRecoveryTest.second=second;
        window.__irRecoveryTest.original={html:first.previewTarget.innerHTML,text:first.root.textContent,scroll:sc.scrollTop};
        first.previewRequestSeq=1;first.previewBusy=true;first.pendingTypeName='RetryTarget';first.requestedTypeName='RetryTarget';
        window.irFailDetachedPreview(first.sessionKey,1,'request-timeout');
        var ts=getComputedStyle(first.titleLabel),ss=getComputedStyle(sc);
        return {id:first.id,key:first.sessionKey,scroll:sc.scrollTop,title:first.titleLabel.textContent,role:first.titleLabel.getAttribute('role'),live:first.titleLabel.getAttribute('aria-live'),visible:getComputedStyle(first.retryButton).display,diagnostics:{scroller:{class:sc.className,height:sc.scrollHeight,client:sc.clientHeight,rect:sc.getBoundingClientRect().toJSON(),overflow:ss.overflow,display:ss.display},title:{rect:first.titleLabel.getBoundingClientRect().toJSON(),color:ts.color,font:ts.font,visibility:ts.visibility,display:ts.display,opacity:ts.opacity,fill:ts.webkitTextFillColor},root:first.root.getBoundingClientRect().toJSON(),rootClass:first.root.className,content:Array.from(first.root.querySelectorAll('.monaco-hover-content,.rendered-markdown,.monaco-tokenized-source')).slice(0,8).map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),height:e.scrollHeight,style:e.getAttribute('style')}))}};
      })()`);
      await vscode.commands.executeCommand('editor.action.hideHover');
      await capture('recovery-error');
      assert.ok(setup && setup.scroll > 0, JSON.stringify(setup));
      assert.strictEqual(setup.title, 'Preview timed out for RetryTarget');
      assert.strictEqual(setup.role, 'status');
      assert.strictEqual(setup.live, 'polite');
      assert.notStrictEqual(setup.visible, 'none');
      const first = `.ir-detached-hover[data-ir-detached-hover-id="${setup.id}"]`;
      const preserved = async () => evaluate(`(function(){var t=window.__irRecoveryTest,s=t.first,sc=window.__irTestHooks.primaryHoverScroller(s.root);return {html:s.previewTarget.innerHTML===t.original.html,text:s.root.textContent===t.original.text,tail:s.root.textContent.includes('COMPLETE_ORIGINAL_TAIL'),lines:(s.root.textContent.match(/source detail /g)||[]).length,scroll:sc.scrollTop===t.original.scroll,other:t.second.root.textContent==='Second window original source'};})()`);
      assert.deepStrictEqual(await preserved(), { html: true, text: true, tail: true, lines: 10025, scroll: true, other: true });
      await click(first + ' .ir-detached-hover-retry');
      const busy = await evaluate(`(function(){var t=window.__irRecoveryTest,s=t.first;s.retryButton.click();return {requests:t.requests.filter(r=>r.op==='preview'),busy:s.previewBusy,title:s.titleLabel.textContent,retryDisabled:s.retryButton.disabled,ariaBusy:s.root.getAttribute('aria-busy')};})()`);
      assert.strictEqual(busy.requests.length, 1, 'A repeated retry must not submit twice');
      assert.strictEqual(busy.requests[0].requestId, 2);
      assert.strictEqual(busy.requests[0].identifier, 'RetryTarget');
      assert.strictEqual(busy.busy, true);
      assert.strictEqual(busy.retryDisabled, true);
      assert.strictEqual(busy.ariaBusy, 'true');
      assert.strictEqual(busy.title, 'Loading RetryTarget…');
      await capture('recovery-loading');
      assert.deepStrictEqual(await preserved(), { html: true, text: true, tail: true, lines: 10025, scroll: true, other: true });
      const stale = await evaluate(`(function(){var s=window.__irRecoveryTest.first;s.lastAppliedPreview={requestId:1};return {failed:window.irFailDetachedPreview(s.sessionKey,1,'definition-not-found'),applied:window.irApplyDetachedPreview(s.sessionKey,1,'OldType','old result'),committed:window.irCommitDetachedPreview(s.sessionKey,1),busy:s.previewBusy};})()`);
      assert.strictEqual(stale.failed, false);
      assert.strictEqual(stale.applied.reason, 'stale-request');
      assert.strictEqual(stale.committed.reason, 'stale-request');
      assert.strictEqual(stale.busy, true);
      const applied = await evaluate(`(function(){var s=window.__irRecoveryTest.first,r=window.irApplyDetachedPreview(s.sessionKey,2,'RetryTarget','Retry succeeded');window.irCommitDetachedPreview(s.sessionKey,2);return {ok:r.ok,busy:s.previewBusy,title:s.titleLabel.textContent,retry:getComputedStyle(s.retryButton).display,depth:s.pageStack.length};})()`);
      assert.deepStrictEqual(applied, { ok: true, busy: false, title: 'RetryTarget', retry: 'none', depth: 1 });
      await click(first + ' .ir-detached-hover-back');
      for (let attempt = 0; attempt < 20 && !(await preserved()).scroll; attempt++) {
        await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
      }
      assert.deepStrictEqual(await preserved(), { html: true, text: true, tail: true, lines: 10025, scroll: true, other: true },
        JSON.stringify(await evaluate(`(function(){var t=window.__irRecoveryTest,sc=window.__irTestHooks.primaryHoverScroller(t.first.root);return {expected:t.original.scroll,actual:sc.scrollTop,height:sc.scrollHeight,client:sc.clientHeight};})()`)));
      await capture('recovery-restored');
      await evaluate(`(function(){var s=window.__irRecoveryTest.first;s.previewRequestSeq=4;s.previewBusy=true;s.pendingTypeName='VeryLong한국어DefinitionName'.repeat(8);s.requestedTypeName=s.pendingTypeName;window.irFailDetachedPreview(s.sessionKey,4,'definition-not-found');s.el.style.setProperty('width','250px','important');s.el.style.setProperty('min-width','250px','important');s.el.style.setProperty('max-width','250px','important');s.retryButton.focus();})()`);
      const narrow = await evaluate(`(function(){var s=window.__irRecoveryTest.first,a=s.el.getBoundingClientRect(),b=s.retryButton.getBoundingClientRect(),c=s.el.querySelector('.ir-detached-hover-close').getBoundingClientRect();return {label:s.titleLabel.textContent,tooltip:s.titleLabel.title,inside:b.left>=a.left&&c.right<=a.right,disabled:s.retryButton.disabled,focused:document.activeElement===s.retryButton};})()`);
      assert.ok(narrow.label.startsWith('No definition found for VeryLong한국어'));
      assert.strictEqual(narrow.tooltip, narrow.label);
      assert.strictEqual(narrow.inside, true);
      assert.strictEqual(narrow.disabled, false);
      assert.strictEqual(narrow.focused, true);
      // Tab to Close and Shift+Tab back must keep the native button reachable
      // and show the keyboard focus state without dispatching a DOM click.
      for (const modifiers of [0, 8]) {
        for (const type of ['keyDown', 'keyUp']) {
          await cdpRequest(ws, 'Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
        }
      }
      assert.strictEqual(await evaluate('document.activeElement===window.__irRecoveryTest.first.retryButton'), true);
      assert.ok(await evaluate(`(function(){var root=window.__irRecoveryTest.first.root,b=root.getBoundingClientRect(),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),node;while(node=walker.nextNode()){if(!node.textContent.includes('source detail'))continue;var range=document.createRange();range.selectNodeContents(node);var r=range.getBoundingClientRect();if(r.height>0&&r.height<30&&r.top>=b.top&&r.bottom<=b.bottom&&r.left<b.right&&r.right>b.left)return true;}return false;})()`), 'The narrow restored viewport must paint actual source lines');
      await capture('recovery-narrow-keyboard');
      for (const type of ['keyDown', 'keyUp']) {
        await cdpRequest(ws, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      }
      const keyboard = await evaluate(`(function(){var t=window.__irRecoveryTest;return {count:t.requests.filter(r=>r.op==='preview').length,busy:t.first.previewBusy,id:t.first.previewRequestSeq};})()`);
      assert.deepStrictEqual(keyboard, { count: 2, busy: true, id: 5 });
      await click(first + ' .ir-detached-hover-close');
      const closed = await evaluate(`(function(){var t=window.__irRecoveryTest;return {count:window.__irDetachedHovers.length,other:t.second.root.textContent,late:window.irApplyDetachedPreview(${JSON.stringify(setup.key)},5,'LateType','late content')};})()`);
      assert.strictEqual(closed.count, 1);
      assert.strictEqual(closed.other, 'Second window original source');
      assert.strictEqual(closed.late.reason, 'missing-session');
    } finally {
      provider?.dispose();
      await evaluate(`(function(){if(window.__irTestHooks)window.__irTestHooks.clearDetachedHovers('recovery-finally');var t=window.__irRecoveryTest;if(t)window.irGoToType=t.originalBinding;delete window.__irRecoveryTest;})()`);
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      ws.close();
      await vscode.commands.executeCommand('editor.action.hideHover');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
