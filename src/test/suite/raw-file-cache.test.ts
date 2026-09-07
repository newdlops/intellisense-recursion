import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readRawFileSnapshot } from '../../preview-builder';
import {
  RAW_DEF_FILE_CACHE_MAX,
  RAW_DEF_FILE_CACHE_MAX_BYTES,
  rawDefFileCache,
  clearRawDefFileCache,
  evictRawDefFileCacheEntry,
} from '../../preview-engine';

suite('Raw preview file cache resource budget', () => {
  let directory: string;

  setup(async () => {
    clearRawDefFileCache();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-raw-cache-'));
  });

  teardown(async () => {
    clearRawDefFileCache();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('large working sets evict old snapshots while retaining recently used files', async () => {
    const line = '# ' + 'x'.repeat(97) + '\n';
    const source = line.repeat(5243);
    const firstPath = path.join(directory, 'first.py');
    await fs.writeFile(firstPath, source);
    const first = await readRawFileSnapshot(firstPath);
    for (let i = 0; i < 24; i++) {
      assert.strictEqual(await readRawFileSnapshot(firstPath), first);
      const file = path.join(directory, `file_${i}.py`);
      await fs.writeFile(file, source);
      const snapshot = await readRawFileSnapshot(file);
      assert.strictEqual(snapshot.lineCount, 5244);
      assert.strictEqual(snapshot.lineAt(0).text, line.trimEnd());
      const retained = [...rawDefFileCache.values()].reduce((sum, entry) => sum + entry.retainedBytes, 0);
      assert.ok(retained <= RAW_DEF_FILE_CACHE_MAX_BYTES);
      assert.ok(rawDefFileCache.size <= RAW_DEF_FILE_CACHE_MAX);
    }
    assert.strictEqual(rawDefFileCache.get(firstPath)?.snapshot, first);
    assert.ok(!rawDefFileCache.has(path.join(directory, 'file_0.py')));
    assert.ok(rawDefFileCache.has(path.join(directory, 'file_23.py')));
  });

  test('oversized snapshots remain readable without displacing reusable small files', async () => {
    const smallPath = path.join(directory, 'small.py');
    const largePath = path.join(directory, 'large.py');
    await fs.writeFile(smallPath, 'class Small: pass\n');
    const small = await readRawFileSnapshot(smallPath);
    const source = '#' + 'x'.repeat(RAW_DEF_FILE_CACHE_MAX_BYTES / 2);
    await fs.writeFile(largePath, source);
    const large = await readRawFileSnapshot(largePath);
    assert.strictEqual(large.lineCount, 1);
    assert.strictEqual(large.lineAt(0).text, source);
    assert.ok(!rawDefFileCache.has(largePath));
    assert.strictEqual(await readRawFileSnapshot(smallPath), small);
  });

  test('small files remain capped by count and save invalidation refreshes content', async () => {
    for (let i = 0; i < RAW_DEF_FILE_CACHE_MAX + 2; i++) {
      const file = path.join(directory, `file_${i}.py`);
      await fs.writeFile(file, 'class Before: pass\n');
      await readRawFileSnapshot(file);
    }
    assert.strictEqual(rawDefFileCache.size, RAW_DEF_FILE_CACHE_MAX);
    assert.ok(!rawDefFileCache.has(path.join(directory, 'file_0.py')));
    const newest = path.join(directory, `file_${RAW_DEF_FILE_CACHE_MAX + 1}.py`);
    evictRawDefFileCacheEntry(newest);
    assert.ok(!rawDefFileCache.has(newest));
    await fs.writeFile(newest, 'class After: pass\n');
    const refreshed = await readRawFileSnapshot(newest);
    assert.strictEqual(refreshed.lineAt(0).text, 'class After: pass');
  });
});
