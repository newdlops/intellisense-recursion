import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { cdpRequest, withRendererInputCdpSessionForTests } from '../../cdp-eval';

suite('Hover symbol search performance', () => {
  suiteSetup(function () {
    if (path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') !== 'python') {
      this.skip();
    }
  });

  test('compares published and current scans in the same renderer with native timers', async function () {
    this.timeout(90000);
    await vscode.workspace.getConfiguration('window').update('title',
      `${process.env.IR_TEST_WINDOW_MARKER} — \${rootName}`, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('newdlops.intellisense-recursion')!.activate();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'service.py'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('intellisenseRecursion.runHoverRendererHarnessForTests', 'performance');
    const benchmark = require(path.resolve(__dirname, '../../../scripts/benchmark-hover-symbol-search.cjs'));
    const sources = benchmark.variants();
    const expression = `(async function(){
      var run={baseline:(${sources.baseline})(fn=>window.setTimeout(fn,0)),current:(${sources.current})(fn=>window.setTimeout(fn,0))};
      var inputs=${JSON.stringify(benchmark.workloads())},rows=[];
      for(var input of inputs){
        var samples={baseline:[],current:[]},yields={},expected=null;
        for(var pass=-2;pass<7;pass++){
          for(var name of (pass%2?['current','baseline']:['baseline','current'])){
            var start=performance.now(),out=await run[name](input),elapsed=performance.now()-start;
            var result=JSON.stringify(out.result);
            if(expected!==null&&result!==expected)throw new Error('Search result mismatch: '+input.name);
            expected=result;if(pass>=0)samples[name].push(elapsed);yields[name]=out.yields;
          }
        }
        rows.push({name:input.name,chars:input.text.length,baselineMs:samples.baseline.sort((a,b)=>a-b)[3],currentMs:samples.current.sort((a,b)=>a-b)[3],yields:yields});
      }
      return {...${JSON.stringify(sources.metadata)},scope:'Scan functions in a real VS Code renderer with native timers and mock page/session; excludes DOM, debounce, provider, CDP and Quick Pick latency; interleaved medians of seven samples',rows:rows};
    })()`;
    const report = await withRendererInputCdpSessionForTests(async ws => {
      await cdpRequest(ws, 'Page.bringToFront');
      await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      try {
        const response = await cdpRequest(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 60000);
        assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
        return response.result.value;
      } finally {
        await cdpRequest(ws, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      }
    });
    const output = path.join(os.tmpdir(), 'ir-symbol-search-renderer.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('  symbol scan benchmark: ' + JSON.stringify(report) + '\nReport: ' + output);
    for (const name of ['10025-lines-tail-type', '10025-lines-tail-callable', '10025-lines-absent']) {
      const row = report.rows.find((row: any) => row.name === name);
      assert.ok(row.yields.current < row.yields.baseline, 'Search avoids irrelevant word chunks: ' + name);
    }
  });
});
