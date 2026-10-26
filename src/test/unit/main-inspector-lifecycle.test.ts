/** Regression coverage for shared startup ownership, reconnects and PID-owned loopback discovery. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireMainInspector, parseMainInspectorAddress, parseMainInspectorListeners,
  mainInspectorHttpOrigin, mainInspectorWebSocketMatches,
} from '../../main-inspector-lifecycle';

const pid = 2147483646;
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'main-inspector-test-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('existing inspector avoids process lookup, reservation and activation', async () => {
  const calls: string[] = [];
  assert.equal(await acquireMainInspector(pid, {
    discover: async () => 'ready', identity: async () => { calls.push('identity'); return 'unused'; },
    request: () => { calls.push('request'); },
  }), 'ready');
  assert.deepEqual(calls, []);
});

test('concurrent callers share one automatic activation and all retain their feature connection', async () => fixture(async directory => {
  let ready = false, starts = 0;
  const options = {
    directory, identity: async () => 'same-main-creation', timeoutMs: 1000,
    discover: async () => ready ? 'ready' : undefined,
    request: () => { starts++; ready = true; },
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => acquireMainInspector(pid, options)));
  assert.equal(starts, 1);assert.deepEqual(results, Array(12).fill('ready'));
}));

test('separately loaded extension copies share the on-disk reservation', async () => fixture(async directory => {
  const modulePath = require.resolve('../../main-inspector-lifecycle');
  delete require.cache[modulePath];
  const first: typeof import('../../main-inspector-lifecycle') = require(modulePath);
  delete require.cache[modulePath];
  const second: typeof import('../../main-inspector-lifecycle') = require(modulePath);
  assert.notEqual(first.acquireMainInspector, second.acquireMainInspector);
  let ready = false, starts = 0;
  const options = { directory, identity: async () => 'same-process', timeoutMs: 1000,
    discover: async () => ready ? 'ready' : undefined, request: () => { starts++; ready = true; } };
  assert.deepEqual(await Promise.all([first.acquireMainInspector(pid, options), second.acquireMainInspector(pid, options)]), ['ready', 'ready']);
  assert.equal(starts, 1);
}));

test('independent extension-host processes issue exactly one startup request', async () => fixture(async directory => {
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    const {acquireMainInspector}=require(process.argv[1]);
    const directory=process.argv[2],ready=path.join(directory,'ready');
    acquireMainInspector(${pid},{directory,identity:async()=>'shared-main-generation',timeoutMs:3000,
      discover:async()=>fs.existsSync(ready)?'ready':undefined,
      request:()=>{process.stdout.write('START\\n');fs.writeFileSync(ready,'ready');}
    }).then(value=>process.stdout.write(value+'\\n'),error=>{console.error(error.message);process.exitCode=1;});`;
  const launch = () => new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['-e', script, require.resolve('../../main-inspector-lifecycle'), directory],
      { timeout: 6000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  const output = await Promise.all(Array.from({ length: 4 }, launch));
  assert.equal(output.join('').split('\n').filter(line => line === 'START').length, 1);
  assert(output.every(value => value.endsWith('ready\n')));
}));

test('an unavailable inspector is not repeatedly activated on discovery retries or later host reloads', async () => fixture(async directory => {
  let starts = 0;
  const options = { directory, identity: async () => 'one-main', timeoutMs: 0,
    discover: async () => undefined, request: () => { starts++; } };
  await assert.rejects(acquireMainInspector(pid, options), /unavailable/);
  await assert.rejects(acquireMainInspector(pid, options), /unavailable/);
  assert.equal(starts, 1);
}));

test('an activation exception does not cause a second signal from another caller', async () => fixture(async directory => {
  let starts = 0;
  const options = { directory, identity: async () => 'one-main', timeoutMs: 0,
    discover: async () => undefined, request: () => { starts++; throw Error('activation failed'); } };
  await assert.rejects(acquireMainInspector(pid, options), /activation failed/);
  await assert.rejects(acquireMainInspector(pid, options), /unavailable/);
  assert.equal(starts, 1);
}));

test('a reused numeric PID with a different creation identity can start normally', async () => fixture(async directory => {
  let generation = 'first', ready = false, starts = 0;
  const options = { directory, identity: async () => generation,
    discover: async () => ready ? 'ready' : undefined, request: () => { starts++; ready = true; } };
  await acquireMainInspector(pid, options);generation = 'second';ready = false;
  await acquireMainInspector(pid, options);assert.equal(starts, 2);
}));

test('a debugger becoming ready during reservation is reused without activation', async () => fixture(async directory => {
  let polls = 0, starts = 0;
  assert.equal(await acquireMainInspector(pid, { directory, identity: async () => 'main',
    discover: async () => ++polls === 1 ? undefined : 'ready', request: () => { starts++; } }), 'ready');
  assert.equal(starts, 0);
}));

test('invalid process identities are rejected before any signal', async () => {
  for (const invalid of [0, 1, -1, 1.5, NaN, process.pid]) {
    await assert.rejects(acquireMainInspector(invalid, { discover: async () => 'ready', request: () => assert.fail('signal') }), /Invalid owning main PID/);
  }
});

test('a symlinked reservation directory cannot redirect writes', { skip: process.platform === 'win32' }, async () => fixture(async directory => {
  const target=path.join(directory,'target'),link=path.join(directory,'link');
  await fs.mkdir(target);await fs.symlink(target,link,'dir');
  await assert.rejects(acquireMainInspector(pid,{directory:link,identity:async()=>'main',discover:async()=>undefined,request:()=>assert.fail('signal')}),/privately owned/);
  assert.deepEqual(await fs.readdir(target),[]);
}));

test('loopback parsing supports dedicated IPv4, IPv6 and arbitrary ports', () => {
  assert.deepEqual(parseMainInspectorAddress('127.42.7.9:43123'), { host: '127.42.7.9', port: 43123 });
  assert.deepEqual(parseMainInspectorAddress('[::1]:43124'), { host: '::1', port: 43124 });
  assert.deepEqual(parseMainInspectorAddress('[::ffff:127.42.7.9]:43125'), { host: '127.42.7.9', port: 43125 });
  assert.equal(mainInspectorHttpOrigin({host:'::1',port:43124}),'http://[::1]:43124');
  for (const invalid of ['*:9229','0.0.0.0:9229','[::]:9229','192.168.1.1:9229','localhost:9229','127.0.0.999:9229','127.42.7.9:0','127.42.7.9:65536']) { assert.equal(parseMainInspectorAddress(invalid),undefined,invalid); }
});

test('listener discovery accepts only the requested process and loopback interfaces', () => {
  assert.deepEqual(parseMainInspectorListeners('p42\nn127.42.7.9:43123\np43\nn127.42.7.10:43124\np42\nn*:5000\nn[::1]:43125',42,'lsof'),[
    {host:'127.42.7.9',port:43123},{host:'::1',port:43125},
  ]);
  assert.deepEqual(parseMainInspectorListeners(' TCP 127.42.7.9:43123 0.0.0.0:0 LISTENING 42\n TCP 127.42.7.10:43124 0.0.0.0:0 LISTENING 43',42,'netstat'),[{host:'127.42.7.9',port:43123}]);
  assert.deepEqual(parseMainInspectorListeners('LISTEN 0 511 127.42.7.9:43123 0.0.0.0:* users:(("code",pid=42,fd=7))',42,'ss'),[{host:'127.42.7.9',port:43123}]);
});

test('an advertised WebSocket cannot redirect to another PID interface or port', () => {
  const endpoint={host:'127.42.7.9',port:43123};
  assert(mainInspectorWebSocketMatches('ws://127.42.7.9:43123/opaque-id',endpoint));
  assert(mainInspectorWebSocketMatches('ws://[::1]:43124/id',{host:'::1',port:43124}));
  for(const invalid of ['ws://127.42.7.10:43123/id','ws://127.42.7.9:43124/id','ws://user@127.42.7.9:43123/id','wss://127.42.7.9:43123/id','ws://example.com:43123/id','invalid']){assert.equal(mainInspectorWebSocketMatches(invalid,endpoint),false,invalid);}
});
