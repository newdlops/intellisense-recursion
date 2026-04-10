import * as assert from 'assert';
import * as vscode from 'vscode';
import * as inspector from 'node:inspector';

suite('Inspector Diagnostic', () => {

  test('V8 Inspector can connect and evaluate', function () {
    const session = new inspector.Session();
    session.connect();

    let evalOk = false;
    session.post('Runtime.evaluate', { expression: '1+1', returnByValue: true }, (err, result: any) => {
      if (!err && result?.result?.value === 2) { evalOk = true; }
    });

    // Flush
    for (let i = 0; i < 100 && !evalOk; i++) {
      try { session.post('Runtime.evaluate', { expression: '1', returnByValue: true }, () => {}); } catch {}
    }
    session.disconnect();

    console.log(`  Inspector evaluate: ${evalOk ? 'OK' : 'FAILED'}`);
    assert.ok(evalOk, 'V8 Inspector Runtime.evaluate failed');
  });

  test('registerHoverProvider scope chain is explorable', function () {
    this.timeout(10000);
    const session = new inspector.Session();
    session.connect();
    (globalThis as any).__testFn = vscode.languages.registerHoverProvider;

    const diagnostics: string[] = [];
    let foundEt = false;
    let scopeCount = 0;
    let varNames: string[] = [];

    session.post('Runtime.evaluate', { expression: '__testFn', returnByValue: false }, (err, evalResult: any) => {
      if (err) { diagnostics.push(`eval error: ${err}`); return; }
      if (!evalResult?.result?.objectId) { diagnostics.push('no objectId for __testFn'); return; }
      diagnostics.push(`objectId: ${evalResult.result.objectId.substring(0, 30)}...`);

      session.post('Runtime.getProperties', {
        objectId: evalResult.result.objectId,
        ownProperties: false,
        accessorPropertiesOnly: false
      }, (err2, propsResult: any) => {
        if (err2) { diagnostics.push(`getProperties error: ${err2}`); return; }

        const scopesProp = propsResult?.internalProperties?.find((p: any) => p.name === '[[Scopes]]');
        if (!scopesProp?.value?.objectId) {
          diagnostics.push(`no [[Scopes]] found. internalProperties: ${propsResult?.internalProperties?.map((p: any) => p.name).join(', ')}`);
          return;
        }
        diagnostics.push('[[Scopes]] found');

        session.post('Runtime.getProperties', { objectId: scopesProp.value.objectId }, (err3, scopesResult: any) => {
          if (err3) { diagnostics.push(`scopes error: ${err3}`); return; }
          scopeCount = scopesResult?.result?.length || 0;
          diagnostics.push(`scope entries: ${scopeCount}`);

          for (const entry of (scopesResult?.result || [])) {
            if (!entry.value?.objectId) { continue; }
            session.post('Runtime.getProperties', { objectId: entry.value.objectId }, (err4, varsResult: any) => {
              if (err4) { return; }
              const names = (varsResult?.result || []).map((v: any) => v.name);
              varNames.push(...names);

              for (const v of (varsResult?.result || [])) {
                if (v.value?.objectId) {
                  // Check if this object has $provideHover
                  session.post('Runtime.callFunctionOn', {
                    objectId: v.value.objectId,
                    functionDeclaration: 'function() { return typeof this.$provideHover === "function" ? this.constructor?.name || "has$provideHover" : null; }',
                    returnByValue: true,
                  }, (err5, callResult: any) => {
                    if (!err5 && callResult?.result?.value) {
                      diagnostics.push(`FOUND $provideHover on var "${v.name}": ${callResult.result.value}`);
                      foundEt = true;
                      (globalThis as any).__testEt = true;
                    }
                  });
                }
              }
            });
          }
        });
      });
    });

    // Flush inspector callbacks
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { session.post('Runtime.evaluate', { expression: '1', returnByValue: true }, () => {}); } catch {}
      if ((globalThis as any).__testEt) { break; }
    }

    session.disconnect();
    delete (globalThis as any).__testFn;
    delete (globalThis as any).__testEt;

    console.log(`  Diagnostics:`);
    for (const d of diagnostics) { console.log(`    ${d}`); }
    console.log(`  Unique var names in scope: ${[...new Set(varNames)].sort().join(', ')}`);
    console.log(`  Found $provideHover: ${foundEt}`);

    // This test is diagnostic — it reports findings but doesn't fail
    // The actual assertion is in the main integration test
    if (!foundEt) {
      console.log(`  WARNING: Could not find ExtHostLanguageFeatures via inspector.`);
      console.log(`  This means the hover duplication tests cannot run in this environment.`);
    }
  });
});
