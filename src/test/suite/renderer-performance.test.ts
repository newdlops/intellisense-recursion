import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { cdpRequest, withRendererInputCdpSessionForTests } from '../../cdp-eval';
import { getHoverPatchScript } from '../../renderer-patch';

suite('Renderer performance', () => {
  suiteSetup(async function () {
    if (path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') !== 'python') {
      this.skip();
    }
    await vscode.workspace.getConfiguration('window').update('title',
      `${process.env.IR_TEST_WINDOW_MARKER} — \${rootName}`, vscode.ConfigurationTarget.Global);
  });

  test('measures collection hooks and unrelated workbench updates', async function () {
    this.timeout(90000);
    const extension = vscode.extensions.getExtension('newdlops.intellisense-recursion');
    assert.ok(extension, 'Development extension should be installed');
    await extension!.activate();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'service.py'));
    await vscode.window.showTextDocument(doc);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await vscode.commands.executeCommand('intellisenseRecursion.runHoverRendererHarnessForTests', 'performance');
    console.log('  performance: renderer initialized');
    const report = await withRendererInputCdpSessionForTests(async ws => {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdpRequest(ws, 'Performance.enable');
      const evaluate = async (expression: string) => {
        const result = await cdpRequest(ws, 'Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        }, 20000);
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      // Give startup observers a chance to settle before both baseline and
      // optimized runs. Wall-clock numbers are diagnostic, not CI thresholds.
      await new Promise(resolve => setTimeout(resolve, 2500));
      const pointerMotion = await evaluate(`(function() {
        var mount = document.createElement('div');
        mount.className = 'ir-perf-pointer-target';
        document.body.appendChild(mount);
        var queries = 0, geometryReads = 0, closestCalls = 0;
        var originalQuery = Document.prototype.querySelector;
        var originalRect = Element.prototype.getBoundingClientRect;
        var originalClosest = Element.prototype.closest;
        Document.prototype.querySelector = function() { queries++; return originalQuery.apply(this, arguments); };
        Element.prototype.getBoundingClientRect = function() { geometryReads++; return originalRect.apply(this, arguments); };
        Element.prototype.closest = function() { closestCalls++; return originalClosest.apply(this, arguments); };
        var start = performance.now();
        try {
          for (var i = 0; i < 1000; i++) {
            var init = {bubbles:true, clientX:100+i%200, clientY:100+i%50};
            mount.dispatchEvent(new PointerEvent('pointermove', init));
            mount.dispatchEvent(new MouseEvent('mousemove', init));
          }
          return {moves:1000, elapsedMs:performance.now()-start, queries:queries,
            geometryReads:geometryReads, closestCalls:closestCalls};
        } finally {
          Document.prototype.querySelector = originalQuery;
          Element.prototype.getBoundingClientRect = originalRect;
          Element.prototype.closest = originalClosest;
          mount.remove();
        }
      })()`);
      const collections = await evaluate(`(function() {
        var records = Array.from({length: 50000}, function(_, i) { return {index: i}; });
        var samples = [];
        for (var pass = 0; pass < 7; pass++) {
          var map = new Map(), weak = new WeakMap(), set = new Set(), array = [];
          var start = performance.now();
          for (var i = 0; i < records.length; i++) {
            map.set(i, records[i]); weak.set(records[i], records[i]);
            set.add(records[i]); array.push(records[i]);
          }
          samples.push(performance.now() - start);
        }
        samples.sort(function(a,b) { return a-b; });
        return {medianMs: samples[3], samplesMs: samples};
      })()`);
      console.log('  performance: collections measured');
      const before = await cdpRequest(ws, 'Performance.getMetrics');
      const mutations = await evaluate(`(async function() {
        var mount = document.createElement('div');
        mount.className = 'ir-perf-workbench-updates';
        mount.style.cssText = 'position:fixed;left:0;bottom:0;width:200px;height:100px;overflow:hidden;contain:strict;';
        document.body.appendChild(mount);
        var queries = 0, geometryReads = 0;
        var originalQuery = Element.prototype.querySelectorAll;
        var originalSingle = Element.prototype.querySelector;
        var originalRect = Element.prototype.getBoundingClientRect;
        Element.prototype.querySelectorAll = function() { queries++; return originalQuery.apply(this, arguments); };
        Element.prototype.querySelector = function() { queries++; return originalSingle.apply(this, arguments); };
        Element.prototype.getBoundingClientRect = function() { geometryReads++; return originalRect.apply(this, arguments); };
        var started = performance.now();
        try {
          for (var batch = 0; batch < 40; batch++) {
            var fragment = document.createDocumentFragment();
            for (var line = 0; line < 50; line++) {
              var row = document.createElement('div');
              row.className = 'view-line';
              for (var token = 0; token < 5; token++) {
                var span = document.createElement('span');
                span.className = 'mtk1'; span.textContent = 'value_' + batch + '_' + token;
                row.appendChild(span);
              }
              fragment.appendChild(row);
            }
            mount.replaceChildren(fragment);
            // MessageChannel yields to mutation observers without Electron's
            // one-second background-window timer clamp skewing the workload.
            await new Promise(function(resolve) {
              var channel = new MessageChannel();
              channel.port1.onmessage = function() { channel.port1.close(); channel.port2.close(); resolve(); };
              channel.port2.postMessage(null);
            });
          }
          return {elapsedMs: performance.now()-started, queries: queries, geometryReads: geometryReads, batches: 40};
        } finally {
          Element.prototype.querySelectorAll = originalQuery;
          Element.prototype.querySelector = originalSingle;
          Element.prototype.getBoundingClientRect = originalRect;
          mount.remove();
        }
      })()`);
      console.log('  performance: mutations measured');
      const after = await cdpRequest(ws, 'Performance.getMetrics');
      const metrics: Record<string, number> = {};
      for (const name of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']) {
        metrics[name] = (after.metrics.find((m: any) => m.name === name)?.value || 0)
          - (before.metrics.find((m: any) => m.name === name)?.value || 0);
      }
      const retention = await evaluate(`(function() {
        var captured = [];
        class TestEditor {
          constructor() { this._domElement = document.createElement('div'); this._contentWidgets = {}; }
          layout() {} getModel() { return null; } getDomNode() { return this._domElement; }
          addContentWidget() {} onDidDispose(fn) { this.disposeListener = fn; return {dispose: function(){}}; }
        }
        var set = new Set();
        for (var i = 0; i < 64; i++) { var ed = new TestEditor(); captured.push(ed); set.add(ed); }
        var before = (window.__irCapturedEditorList || []).filter(function(ed) { return captured.indexOf(ed) >= 0; }).length;
        for (var i = 0; i < captured.length; i++) {
          captured[i]._isDisposed = true;
          if (captured[i].disposeListener) captured[i].disposeListener();
        }
        var after = (window.__irCapturedEditorList || []).filter(function(ed) { return captured.indexOf(ed) >= 0; }).length;
        window.__irCapturedEditorList = (window.__irCapturedEditorList || []).filter(function(ed) { return captured.indexOf(ed) < 0; });
        if (captured.indexOf(window.__irCapturedEditor) >= 0) window.__irCapturedEditor = null;
        return {created: captured.length, retainedBeforeDispose: before, retainedAfterDispose: after};
      })()`);
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      return {pointerMotion, collections, mutations, metrics, retention};
    });
    const label = process.env.IR_PERF_LABEL || 'current';
    const output = path.join(os.tmpdir(), `ir-renderer-perf-${label}.json`);
    const payload = {label, rendererBytes: Buffer.byteLength(getHoverPatchScript()), ...report};
    fs.writeFileSync(output, JSON.stringify(payload, null, 2));
    console.log(`Renderer performance: ${JSON.stringify(payload)}\nReport: ${output}`);
    assert.strictEqual(report.mutations.batches, 40);
    assert.strictEqual(report.pointerMotion.queries, 0,
      'Pointer movement outside hovers must not query the document');
    assert.strictEqual(report.pointerMotion.geometryReads, 0,
      'Pointer movement outside hovers must not measure layout');
    assert.ok(report.mutations.queries < 100,
      `Ordinary editor painting must not scan every added token row: ${JSON.stringify(report.mutations)}`);
    assert.strictEqual(report.retention.retainedAfterDispose, 0,
      'Disposed editors must not remain in the renderer capture list');
  });

  test('retires global collection hooks after discovering the native editor service', async function () {
    this.timeout(30000);
    const extension = vscode.extensions.getExtension('newdlops.intellisense-recursion');
    await extension!.activate();
    await vscode.commands.executeCommand('intellisenseRecursion.runHoverRendererHarnessForTests', 'performance');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'service.py'));
    // Creating a real split editor after injection discovers the service even
    // when the original editor was constructed before the extension activated.
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    try {
      const state = await withRendererInputCdpSessionForTests(async ws => {
        let value: any;
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await cdpRequest(ws, 'Runtime.evaluate', {
            expression: `({watching:!!window.__irNativeEditorApi, capturing:!!window.__irMapPrototypePatched,
              editors:window.__irNativeEditorApi ? window.__irNativeEditorApi.getEditors().length : 0})`,
            returnByValue: true,
          });
          value = result.result.value;
          if (value.watching && !value.capturing) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return value;
      });
      assert.ok(state.watching && !state.capturing && state.editors >= 2,
        `Native service events must replace the global hooks: ${JSON.stringify(state)}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeGroup');
    }
  });

  test('diagnostics release listeners and observers on disable and reinjection', async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    await vscode.commands.executeCommand('intellisenseRecursion.runHoverRendererHarnessForTests', 'performance');
    await withRendererInputCdpSessionForTests(async ws => {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      const evaluate = async (expression: string) => {
        const result = await cdpRequest(ws, 'Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true,
        });
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const countListeners = 'Object.values(getEventListeners(document)).reduce((n,list)=>n+list.length,0)';
      try {
        const baseline = await evaluate(countListeners);
        const initiallyOff = await evaluate('window.__irHoverEventLogConfig.enabled===false&&!window.__irLongTaskObs');
        assert.ok(initiallyOff, 'Diagnostic instrumentation must stay dormant at startup');
        for (let cycle = 0; cycle < 3; cycle++) {
          await evaluate('window.__irHoverEventLogConfig.enabled=true');
          assert.strictEqual(await evaluate(countListeners), baseline + 22);
          const recorded = await evaluate(`(async function(){
            var probe=document.createElement('div');
            probe.className='monaco-hover';
            document.body.appendChild(probe);
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            probe.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:10,clientY:10}));
            probe.setAttribute('aria-hidden','true');
            await Promise.resolve();
            var kinds=window.__irHEDrain().events.map(e=>e.kind);
            probe.remove();
            return {event:kinds.includes('evt'),attribute:kinds.includes('attr')};
          })()`);
          assert.deepStrictEqual(recorded, { event: true, attribute: true });
          if (cycle === 1) {
            // Upgrade while diagnostics are enabled. Cleanup must remove the
            // old closures before another patch installs its own listeners.
            await evaluate('window.__irCleanup("resource-test")');
            await evaluate(getHoverPatchScript());
            assert.strictEqual(await evaluate(countListeners), baseline + 22);
          }
          const disabled = await evaluate('window.__irSetHoverEventLogging(false)');
          assert.deepStrictEqual(disabled, {
            enabled: false, listeners: 0, observedHovers: 0, bodyObserver: false, longTaskObserver: false,
          });
          assert.strictEqual(await evaluate(countListeners), baseline);
          assert.strictEqual(await evaluate('window.__irHoverEventLog.length'), 0);
        }
      } finally {
        await evaluate('window.__irSetHoverEventLogging(false)').catch(() => undefined);
        await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      }
    });
  });
});
