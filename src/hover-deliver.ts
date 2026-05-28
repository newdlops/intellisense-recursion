// Hover-preview delivery dedupe machinery extracted from extension.ts (Phase 10).
//
// Scope:
//   * Time-based per-position delivery suppression
//     (HOVER_PREVIEW_DELIVERY_SUPPRESS_MS / hoverPreviewDeliveries /
//     shouldSuppressHoverPreviewDelivery).
//   * Per-block delivery dedupe with a longer TTL
//     (HOVER_PREVIEW_BLOCK_DELIVERY_*, hoverPreviewDeliveredBlocks,
//     filterDeliveredHoverPreviewBlocks, pruneHoverPreviewDeliveredBlocks).
//   * Primary-handle gating for the pendingPreviewHover path
//     (hoverPreviewPrimaryHandles / hoverPreviewPrimaryHandleAllowed) and
//     the currentPreviewState fallback path
//     (hoverFallbackPrimaryHandles / hoverFallbackPrimaryHandleAllowed),
//     kept as two separate maps so the two paths never steal each other's
//     primary slot.
//   * Rate-limited suppress logging
//     (HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX /
//     hoverPreviewDeliverySuppressLogCount /
//     logHoverPreviewDeliverySuppressed).
//
// The logger dependency is held in module-level state set by
// setHoverDeliverLogger() during extension.activate() rather than imported
// as a vscode OutputChannel — keeps this module decoupled from the vscode
// surface and matches the sidecar-resolve.ts wire-in pattern.

import {
  normalizeHoverMarkdownForDedupe,
  splitHoverPreviewBlocks,
  hoverPreviewDedupeKeys,
  dedupeHoverPreviewBlocks,
  HOVER_PREVIEW_SEPARATOR,
} from './preview-dedupe';

type Logger = { info: (msg: string) => void };
let _logger: Logger | null = null;
/** Wire the logger into this module. Called from extension.activate() after
 * the OutputChannel is created. */
export function setHoverDeliverLogger(logger: Logger): void {
  _logger = logger;
}

export const hoverPreviewDeliveries = new Map<string, number>();
export const HOVER_PREVIEW_DELIVERY_SUPPRESS_MS = 120;
export const HOVER_PREVIEW_DELIVERY_MAX = 200;
export const HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX = 30;
let hoverPreviewDeliverySuppressLogCount = 0;
export interface HoverPreviewDeliveredBlockGroup {
  timestamp: number;
  blocks: Map<string, number>;
}
export const hoverPreviewDeliveredBlocks = new Map<string, HoverPreviewDeliveredBlockGroup>();
export const HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS = 2_500;
export const HOVER_PREVIEW_BLOCK_DELIVERY_MAX_GROUPS = 200;
export const HOVER_PREVIEW_BLOCK_DELIVERY_DEDUPE_ENABLED = true;
export const hoverPreviewPrimaryHandles = new Map<string, { handle: number; cleanup: ReturnType<typeof setTimeout> | null }>();
// Separate map for the currentPreviewState fallback dedupe — must not
// share state with the pendingPreviewHover primary-handle map above,
// because the two paths fire on different request keys/timing and
// stealing each other's primary slot would suppress legitimate hover
// content.
export const hoverFallbackPrimaryHandles = new Map<string, { handle: number; cleanup: ReturnType<typeof setTimeout> | null }>();
export function hoverFallbackPrimaryHandleAllowed(requestKey: string, handle: number): boolean {
  let entry = hoverFallbackPrimaryHandles.get(requestKey);
  if (!entry) {
    entry = { handle, cleanup: null };
    hoverFallbackPrimaryHandles.set(requestKey, entry);
  } else if (entry.cleanup) {
    clearTimeout(entry.cleanup);
  }
  const primary = entry.handle;
  entry.cleanup = setTimeout(() => {
    const current = hoverFallbackPrimaryHandles.get(requestKey);
    if (current?.handle === primary) {
      hoverFallbackPrimaryHandles.delete(requestKey);
    }
  }, 2000);
  return primary === handle;
}

export function clearHoverPreviewPrimaryHandles() {
  for (const entry of hoverPreviewPrimaryHandles.values()) {
    if (entry.cleanup) { clearTimeout(entry.cleanup); }
  }
  hoverPreviewPrimaryHandles.clear();
  for (const entry of hoverFallbackPrimaryHandles.values()) {
    if (entry.cleanup) { clearTimeout(entry.cleanup); }
  }
  hoverFallbackPrimaryHandles.clear();
}

export function hoverPreviewPrimaryHandleAllowed(requestKey: string, handle: number): boolean {
  let entry = hoverPreviewPrimaryHandles.get(requestKey);
  if (!entry) {
    entry = { handle, cleanup: null };
    hoverPreviewPrimaryHandles.set(requestKey, entry);
  } else if (entry.cleanup) {
    clearTimeout(entry.cleanup);
  }
  const primary = entry.handle;
  entry.cleanup = setTimeout(() => {
    const current = hoverPreviewPrimaryHandles.get(requestKey);
    if (current?.handle === primary) {
      hoverPreviewPrimaryHandles.delete(requestKey);
    }
  }, 2000);
  return primary === handle;
}

export function hoverPreviewDeliveryKey(posKey: string, previews: string): string {
  const normalized = normalizeHoverMarkdownForDedupe(previews);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${posKey}:${normalized.length}:${(hash >>> 0).toString(16)}`;
}
export function shouldSuppressHoverPreviewDelivery(posKey: string, previews: string): boolean {
  const now = Date.now();
  for (const [key, ts] of hoverPreviewDeliveries) {
    if (now - ts > HOVER_PREVIEW_DELIVERY_SUPPRESS_MS) {
      hoverPreviewDeliveries.delete(key);
    }
  }
  const key = hoverPreviewDeliveryKey(posKey, previews);
  const prev = hoverPreviewDeliveries.get(key);
  if (prev && now - prev <= HOVER_PREVIEW_DELIVERY_SUPPRESS_MS) {
    return true;
  }
  while (hoverPreviewDeliveries.size >= HOVER_PREVIEW_DELIVERY_MAX) {
    const first = hoverPreviewDeliveries.keys().next().value;
    if (first === undefined) { break; }
    hoverPreviewDeliveries.delete(first);
  }
  hoverPreviewDeliveries.set(key, now);
  return false;
}

export function pruneHoverPreviewDeliveredBlocks(now = Date.now()) {
  for (const [groupKey, group] of hoverPreviewDeliveredBlocks) {
    for (const [blockKey, ts] of group.blocks) {
      if (now - ts > HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS) {
        group.blocks.delete(blockKey);
      }
    }
    if (group.blocks.size === 0 || now - group.timestamp > HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS) {
      hoverPreviewDeliveredBlocks.delete(groupKey);
    }
  }
  while (hoverPreviewDeliveredBlocks.size > HOVER_PREVIEW_BLOCK_DELIVERY_MAX_GROUPS) {
    const first = hoverPreviewDeliveredBlocks.keys().next().value;
    if (first === undefined) { break; }
    hoverPreviewDeliveredBlocks.delete(first);
  }
}

export function filterDeliveredHoverPreviewBlocks(existingText: string, previews: string, deliveryGroupKey: string): string {
  if (!HOVER_PREVIEW_BLOCK_DELIVERY_DEDUPE_ENABLED) { return previews; }
  const now = Date.now();
  pruneHoverPreviewDeliveredBlocks(now);
  const existingKeys = new Set<string>();
  for (const block of splitHoverPreviewBlocks(existingText)) {
    for (const key of hoverPreviewDedupeKeys(block)) { existingKeys.add(key); }
  }
  const out: string[] = [];
  let group = hoverPreviewDeliveredBlocks.get(deliveryGroupKey);
  for (const block of dedupeHoverPreviewBlocks(splitHoverPreviewBlocks(previews))) {
    const keys = hoverPreviewDedupeKeys(block);
    if (!keys.length || keys.some(key => existingKeys.has(key))) { continue; }
    const delivered = keys.some(key => {
      const prev = group?.blocks.get(key);
      return !!(prev && now - prev <= HOVER_PREVIEW_BLOCK_DELIVERY_SUPPRESS_MS);
    });
    if (delivered) { continue; }
    if (!group) {
      group = { timestamp: now, blocks: new Map<string, number>() };
      hoverPreviewDeliveredBlocks.set(deliveryGroupKey, group);
    }
    group.timestamp = now;
    for (const key of keys) { group.blocks.set(key, now); }
    out.push(block);
  }
  return out.join(HOVER_PREVIEW_SEPARATOR);
}

export function logHoverPreviewDeliverySuppressed(message: string) {
  if (hoverPreviewDeliverySuppressLogCount >= HOVER_PREVIEW_DELIVERY_SUPPRESS_LOG_MAX) { return; }
  hoverPreviewDeliverySuppressLogCount++;
  _logger?.info(message);
}

/** Reset everything this module owns. Called from clearAllExtensionCaches. */
export function clearHoverDeliveryState(): void {
  hoverPreviewDeliveries.clear();
  hoverPreviewDeliveredBlocks.clear();
  clearHoverPreviewPrimaryHandles();
  hoverPreviewDeliverySuppressLogCount = 0;
}
