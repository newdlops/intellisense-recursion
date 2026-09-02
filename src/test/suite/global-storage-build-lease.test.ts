import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlobalStorageBuildLease } from '../../globalStorageBuildLease';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function intentFiles(root: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(path.join(root, '.build-intents')))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

function shortLease(root: string): GlobalStorageBuildLease {
  return new GlobalStorageBuildLease(root, {
    isProcessAlive: (pid) => pid === process.pid,
    random: () => 0,
    retryMinMs: 5,
    retryMaxMs: 5,
  });
}

suite('GlobalStorageBuildLease', () => {
  test('allows only one extension host into the build section', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-build-lease-'));
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let active = 0;
    let maxActive = 0;
    let secondEntered = false;
    try {
      const first = shortLease(root).runExclusive('first', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        firstStarted.resolve();
        await releaseFirst.promise;
        active -= 1;
      });
      await firstStarted.promise;
      const [firstIntent] = await intentFiles(root);
      assert.ok(firstIntent, 'the active builder must keep its intent published');

      const second = shortLease(root).runExclusive('second', async () => {
        secondEntered = true;
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.strictEqual(secondEntered, false);
      assert.strictEqual(fs.existsSync(path.join(root, '.build-intents', firstIntent)), true,
        'a racing contender must not remove the live owner intent');
      releaseFirst.resolve();
      await Promise.all([first, second]);
      assert.strictEqual(maxActive, 1);
      assert.deepStrictEqual(await intentFiles(root), []);
    } finally {
      releaseFirst.resolve();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('reclaims only a dead UUID-qualified contender while preserving the live owner', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-build-lease-'));
    const release = deferred<void>();
    try {
      const intents = path.join(root, '.build-intents');
      await fs.promises.mkdir(intents, { recursive: true });
      const staleName = 'build-999999999-123e4567-e89b-42d3-a456-426614174020.json';
      await fs.promises.writeFile(path.join(intents, staleName), JSON.stringify({
        schema: 1,
        pid: 999999999,
        nonce: '123e4567-e89b-42d3-a456-426614174020',
        label: 'dead-builder',
      }));

      const running = shortLease(root).runExclusive('live-builder', async () => {
        assert.strictEqual(fs.existsSync(path.join(intents, staleName)), false);
        await release.promise;
      });
      let liveName: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const files = await intentFiles(root);
        if (files.length === 1 && files[0] !== staleName) {
          [liveName] = files;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(liveName && liveName !== staleName);
      assert.strictEqual(fs.existsSync(path.join(intents, liveName)), true);
      release.resolve();
      await running;
      assert.deepStrictEqual(await intentFiles(root), []);
    } finally {
      release.resolve();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('releases its intent after task failure, active cancellation, and waiting cancellation', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-build-lease-'));
    try {
      const lease = shortLease(root);
      await assert.rejects(
        lease.runExclusive('throws', async () => { throw new Error('expected failure'); }),
        /expected failure/,
      );
      assert.deepStrictEqual(await intentFiles(root), []);

      const activeController = new AbortController();
      const activeStarted = deferred<void>();
      const cancelledTask = lease.runExclusive('active-cancellation', async (signal) => {
        activeStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('task cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }, activeController.signal);
      await activeStarted.promise;
      activeController.abort();
      await assert.rejects(cancelledTask, (err: Error) => err.name === 'AbortError');
      assert.deepStrictEqual(await intentFiles(root), []);

      const ownerStarted = deferred<void>();
      const releaseOwner = deferred<void>();
      const owner = lease.runExclusive('owner', async () => {
        ownerStarted.resolve();
        await releaseOwner.promise;
      });
      await ownerStarted.promise;
      const [ownerIntent] = await intentFiles(root);
      const controller = new AbortController();
      const waiter = shortLease(root).runExclusive('cancelled-waiter', async () => {}, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      await assert.rejects(waiter, (err: Error) => err.name === 'AbortError');
      assert.strictEqual(fs.existsSync(path.join(root, '.build-intents', ownerIntent)), true);
      releaseOwner.resolve();
      await owner;
      assert.deepStrictEqual(await intentFiles(root), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
