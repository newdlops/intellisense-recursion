/** Verify cold Windows metadata startup with a real delayed child, without signalling a main process. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

test('cold Windows creation-time lookup may outlast listener probes without repeated activation', { timeout: 20_000 }, async () => {
  const source = readFileSync(path.resolve(__dirname, '../../../src/main-inspector-lifecycle.ts'), 'utf8');
  const exports: Record<string, unknown> = {};
  let queries = 0;
  const context = vm.createContext({
    exports, setTimeout, clearTimeout,
    process: { platform: 'win32', pid: process.pid, getuid: process.getuid?.bind(process) },
    require(name: string) {
      if (name !== 'node:child_process') { return require(name); }
      return { execFile(file: string, args: string[], options: object, callback: (...values: any[]) => void) {
        assert.equal(file, 'powershell.exe');
        assert.match(args.join(' '), /StartTime/);
        queries++;
        // Actual process/pipe startup and execFile timeout handling remain in use.
        return execFile(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('creation-stamp\\n'),4000)"], options, callback);
      } };
    },
  });
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const runtime = exports as unknown as typeof import('../../main-inspector-lifecycle');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'main-inspector-slow-identity-'));
  let ready = false, requests = 0;
  const options = {
    directory, timeoutMs: 0,
    discover: async () => ready ? 'ready' : undefined,
    request: () => { requests++; ready = true; },
  };
  try {
    assert.equal(await runtime.acquireMainInspector(2147483646, options), 'ready');
    assert.equal(queries, 1);
    assert.equal(requests, 1);
    assert.equal(await runtime.acquireMainInspector(2147483646, options), 'ready');
    ready = false;
    await assert.rejects(runtime.acquireMainInspector(2147483646, options), /unavailable/);
    assert.equal(queries, 1, 'a verified creation time stays cached');
    assert.equal(requests, 1, 'a lost listener never permits a second automatic signal');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
