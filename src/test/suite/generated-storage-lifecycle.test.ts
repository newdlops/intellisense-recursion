import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_GENERATED_STORAGE_POLICY,
  GeneratedStorageLifecycle,
  GeneratedStoragePolicy,
} from '../../generatedStorageLifecycle';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

async function makeGeneration(
  root: string,
  group: keyof GeneratedStoragePolicy['groups'],
  name: string,
  ageMs: number,
  bytes = 8,
): Promise<string> {
  const directory = path.join(root, group, name);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'artifact.bin'), Buffer.alloc(bytes, 1));
  const timestamp = new Date(NOW - ageMs);
  await fs.promises.utimes(directory, timestamp, timestamp);
  return directory;
}

function testPolicy(overrides: Partial<Record<keyof GeneratedStoragePolicy['groups'], Partial<GeneratedStoragePolicy['groups']['indexer-target']>>> = {}): GeneratedStoragePolicy {
  return {
    groups: {
      'indexer-target': { ...DEFAULT_GENERATED_STORAGE_POLICY.groups['indexer-target'], ...overrides['indexer-target'] },
      'downloaded-bin': { ...DEFAULT_GENERATED_STORAGE_POLICY.groups['downloaded-bin'], ...overrides['downloaded-bin'] },
      'workspace-indexes': { ...DEFAULT_GENERATED_STORAGE_POLICY.groups['workspace-indexes'], ...overrides['workspace-indexes'] },
    },
    staleTemporaryFileAgeMs: 6 * 60 * 60 * 1_000,
  };
}

suite('GeneratedStorageLifecycle', () => {
  test('removes expired generated data while preserving current, live, recent, and unknown entries', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-storage-lifecycle-'));
    const currentTarget = '111111111111';
    const expiredTarget = '222222222222';
    const liveTarget = '333333333333';
    const workspace = 'a'.repeat(20);
    try {
      await makeGeneration(root, 'indexer-target', currentTarget, 30 * DAY_MS);
      await makeGeneration(root, 'indexer-target', expiredTarget, 30 * DAY_MS);
      await makeGeneration(root, 'indexer-target', liveTarget, 30 * DAY_MS);
      const unknown = await makeGeneration(root, 'indexer-target', 'user-notes', 90 * DAY_MS);
      const workspaceDirectory = await makeGeneration(root, 'workspace-indexes', workspace, 0);
      const staleTemp = path.join(workspaceDirectory, 'index.bin.tmp');
      const recentTemp = path.join(workspaceDirectory, `index.bin.tmp-${process.pid}-123e4567-e89b-42d3-a456-426614174000`);
      await fs.promises.writeFile(staleTemp, 'stale');
      await fs.promises.writeFile(recentTemp, 'recent');
      await fs.promises.utimes(staleTemp, new Date(NOW - DAY_MS), new Date(NOW - DAY_MS));

      const sessions = path.join(root, '.sessions');
      await fs.promises.mkdir(sessions, { recursive: true });
      const liveLease = path.join(sessions, `session-${process.pid}-123e4567-e89b-42d3-a456-426614174001.json`);
      await fs.promises.writeFile(liveLease, JSON.stringify({
        schema: 1,
        pid: process.pid,
        generations: { target: liveTarget },
      }));
      const staleLease = path.join(sessions, 'session-999999999-123e4567-e89b-42d3-a456-426614174002.json');
      await fs.promises.writeFile(staleLease, JSON.stringify({
        schema: 1,
        pid: 999999999,
        generations: { target: expiredTarget },
      }));

      const lifecycle = new GeneratedStorageLifecycle(
        root,
        { target: currentTarget, workspace },
        { now: () => NOW, isProcessAlive: (pid) => pid === process.pid },
      );
      const report = await lifecycle.start();

      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', currentTarget)), true);
      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', expiredTarget)), false);
      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', liveTarget)), true);
      assert.strictEqual(fs.existsSync(unknown), true);
      assert.strictEqual(fs.existsSync(staleTemp), false);
      assert.strictEqual(fs.existsSync(recentTemp), true);
      assert.strictEqual(fs.existsSync(staleLease), false);
      assert.strictEqual(report.deletedGenerations['indexer-target'], 1);
      assert.strictEqual(report.deletedTemporaryFiles, 1);
      assert.strictEqual(report.deletedStaleLeases, 1);
      lifecycle.dispose();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('enforces generation and byte limits oldest-first after the safety grace period', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-storage-lifecycle-'));
    const currentTarget = 'aaaaaaaaaaaa';
    try {
      await makeGeneration(root, 'indexer-target', 'bbbbbbbbbbbb', 5 * DAY_MS, 10);
      await makeGeneration(root, 'indexer-target', 'cccccccccccc', 4 * DAY_MS, 10);
      await makeGeneration(root, 'indexer-target', 'dddddddddddd', 2 * 60 * 60 * 1_000, 100);
      await makeGeneration(root, 'indexer-target', currentTarget, 5 * DAY_MS, 10);

      const lifecycle = new GeneratedStorageLifecycle(root, { target: currentTarget }, {
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
        policy: testPolicy({
          'indexer-target': {
            maxAgeMs: 30 * DAY_MS,
            minEvictionAgeMs: DAY_MS,
            maxEntries: 2,
            maxBytes: 20,
          },
        }),
      });
      const report = await lifecycle.start();

      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', 'bbbbbbbbbbbb')), false);
      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', 'cccccccccccc')), false);
      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', 'dddddddddddd')), true,
        'a generation inside the one-day grace period must not be evicted');
      assert.strictEqual(fs.existsSync(path.join(root, 'indexer-target', currentTarget)), true,
        'the current generation must never be evicted');
      assert.strictEqual(report.deletedGenerations['indexer-target'], 2);
      assert.strictEqual(report.measuredBytesReclaimed, 20);
      lifecycle.dispose();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('retains the newest previous generation during a rolling extension update', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-storage-lifecycle-'));
    try {
      const older = await makeGeneration(root, 'indexer-target', '111111111111', 40 * DAY_MS);
      const previous = await makeGeneration(root, 'indexer-target', '222222222222', 30 * DAY_MS);
      const lifecycle = new GeneratedStorageLifecycle(root, { target: '333333333333' }, {
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
      });

      await lifecycle.start();

      assert.strictEqual(fs.existsSync(older), false);
      assert.strictEqual(fs.existsSync(previous), true,
        'the newest installed predecessor must survive while older generations are reclaimed');
      lifecycle.dispose();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('starts once and removes its lease on dispose', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-storage-lifecycle-'));
    try {
      const lifecycle = new GeneratedStorageLifecycle(root, {}, {
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
      });
      assert.strictEqual(await lifecycle.start(), await lifecycle.start());
      const sessions = await fs.promises.readdir(path.join(root, '.sessions'));
      assert.strictEqual(sessions.length, 1);
      lifecycle.dispose();
      assert.deepStrictEqual(await fs.promises.readdir(path.join(root, '.sessions')), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('reclaims a stale contender without deleting a racing live contender', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ir-storage-lifecycle-'));
    try {
      const expired = await makeGeneration(root, 'indexer-target', 'eeeeeeeeeeee', 30 * DAY_MS);
      const intents = path.join(root, '.cleanup-intents');
      await fs.promises.mkdir(intents, { recursive: true });
      const stalePath = path.join(intents, 'cleanup-999999999-123e4567-e89b-42d3-a456-426614174010.json');
      await fs.promises.writeFile(stalePath, JSON.stringify({
        schema: 1,
        pid: 999999999,
        nonce: '123e4567-e89b-42d3-a456-426614174010',
      }));
      const livePath = path.join(intents, `cleanup-${process.pid}-123e4567-e89b-42d3-a456-426614174011.json`);
      await fs.promises.writeFile(livePath, JSON.stringify({
        schema: 1,
        pid: process.pid,
        nonce: '123e4567-e89b-42d3-a456-426614174011',
      }));
      const lifecycle = new GeneratedStorageLifecycle(root, {}, {
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
      });

      const report = await lifecycle.start();

      assert.strictEqual(report.cleanupSkippedBecauseLocked, true);
      assert.strictEqual(fs.existsSync(expired), true);
      assert.strictEqual(fs.existsSync(stalePath), false,
        'only the stale contender\'s UUID-qualified path should be reclaimed');
      assert.strictEqual(fs.existsSync(livePath), true,
        'a concurrently-published live contender must remain untouched');
      lifecycle.dispose();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
