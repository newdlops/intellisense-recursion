// Position-keyed hover preview cache extracted from extension.ts (Phase 7).
//
// Scope (intentionally narrow — bigger hover state machinery stays in
// extension.ts for now):
//   * PosPreviewEntry interface
//   * posPreviewCache (per-position LRU, 30s TTL, max 100 / 4 MiB estimate)
//   * posPreviewGet / posPreviewSet
//   * clearPosPreviewCache / invalidatePosPreviewCacheByPath helpers
//     (mirror the cache.ts pattern so callers don't reach into the raw
//     Map for clear/invalidate operations)

import { ExpiringLruCache } from './expiring-lru-cache';

export interface PosPreviewEntry {
  timestamp: number;
  typesKey: string;  // sorted, comma-joined type names
  previews: string;  // joined preview blocks, ready to append
}
export const POS_PREVIEW_TTL = 30_000;
export const POS_PREVIEW_MAX = 100;
export const POS_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const posPreviewCache = new ExpiringLruCache<string, PosPreviewEntry>(
  POS_PREVIEW_MAX, POS_PREVIEW_MAX_BYTES,
  (entry, key) => 96 + 2 * (key.length + entry.typesKey.length + entry.previews.length),
);

export function posPreviewGet(posKey: string, typesKey: string): string | undefined {
  const e = posPreviewCache.get(posKey);
  if (!e) { return undefined; }
  if (e.typesKey !== typesKey) { return undefined; }
  return e.previews;
}

export function posPreviewSet(posKey: string, typesKey: string, previews: string) {
  posPreviewCache.set(posKey, { timestamp: Date.now(), typesKey, previews }, POS_PREVIEW_TTL);
}

/** Drop every cached position preview. Used on hard rebuild. */
export function clearPosPreviewCache(): void {
  posPreviewCache.clear();
}

/** Drop every entry whose key starts with `fsPath:` (the prefix shape used
 *  by posKey construction in $provideHover). Called on file save. */
export function invalidatePosPreviewCacheByPath(fsPath: string): void {
  const prefix = fsPath + ':';
  for (const key of posPreviewCache.keys()) {
    if (key.startsWith(prefix)) { posPreviewCache.delete(key); }
  }
}
