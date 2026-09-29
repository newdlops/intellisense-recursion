import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExpiringLruCache } from '../../expiring-lru-cache';
import { clearDefCache, DEF_CACHE_MAX_BYTES, defCacheGet, defCacheSet, invalidateDefCacheByPath } from '../../cache';
import { clearPosPreviewCache, POS_PREVIEW_MAX_BYTES, posPreviewGet, posPreviewSet } from '../../hover-state';

suite('Preview cache resource budgets', () => {
  teardown(() => { clearDefCache(); clearPosPreviewCache(); });

  test('a large preview working set keeps recently used entries within the byte budget', () => {
    const uri = vscode.Uri.file('/tmp/ir-preview-budget.py');
    const location = new vscode.Location(uri, new vscode.Position(0, 0));
    const preview = 'class ResourceBudget:\n' + '# comment\n'.repeat(26000);
    const result = { preview, location, defUri: uri };
    defCacheSet('hot', result);
    posPreviewSet('hot', 'ResourceBudget', preview);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(defCacheGet('hot')?.result, result);
      assert.strictEqual(posPreviewGet('hot', 'ResourceBudget'), preview);
      defCacheSet(`cold-${i}`, result);
      posPreviewSet(`cold-${i}`, 'ResourceBudget', preview);
    }
    const retainedDefs = Array.from({ length: 100 }, (_, i) => defCacheGet(`cold-${i}`)).filter(Boolean).length + 1;
    const retainedPositions = Array.from({ length: 100 }, (_, i) => posPreviewGet(`cold-${i}`, 'ResourceBudget')).filter(Boolean).length + 1;
    assert.ok(retainedDefs * preview.length * 2 <= DEF_CACHE_MAX_BYTES);
    assert.ok(retainedPositions * preview.length * 2 <= POS_PREVIEW_MAX_BYTES);
    assert.ok(retainedDefs > 1 && retainedPositions > 1, 'Reusable entries must remain cached');
    assert.strictEqual(defCacheGet('cold-0'), undefined);
    assert.strictEqual(posPreviewGet('cold-0', 'ResourceBudget'), undefined);
    // A result beyond the retention budget stays complete for this request.
    const huge = { ...result, preview: 'x'.repeat(DEF_CACHE_MAX_BYTES) };
    defCacheSet('huge', huge);
    posPreviewSet('huge', 'ResourceBudget', huge.preview);
    assert.strictEqual(huge.preview.length, DEF_CACHE_MAX_BYTES);
    assert.strictEqual(defCacheGet('huge'), undefined);
    assert.strictEqual(posPreviewGet('huge', 'ResourceBudget'), undefined);
    assert.strictEqual(defCacheGet('hot')?.result, result);
    assert.strictEqual(posPreviewGet('hot', 'ResourceBudget'), preview);
    invalidateDefCacheByPath(uri.fsPath);
    assert.strictEqual(defCacheGet('hot'), undefined, 'Closing/saving a definition must release references from other source files');
  });

  test('idle expiry releases memory without lookups and cache hits keep the original TTL', async () => {
    const cache = new ExpiringLruCache<string, string>(3, 100, value => value.length * 2);
    try {
      cache.set('short', 'short', 25);
      cache.set('long', 'long', 1000);
      assert.strictEqual(cache.get('short'), 'short');
      await new Promise(resolve => setTimeout(resolve, 70));
      assert.strictEqual(cache.size, 1, 'Expiry must happen without requesting the expired key');
      assert.strictEqual(cache.retainedBytes, 8);
      assert.strictEqual(cache.get('short'), undefined);
      cache.set('long', 'new', 25);
      await new Promise(resolve => setTimeout(resolve, 70));
      assert.strictEqual(cache.size, 0);
      assert.strictEqual(cache.retainedBytes, 0);
    } finally { cache.clear(); }
  });
});
