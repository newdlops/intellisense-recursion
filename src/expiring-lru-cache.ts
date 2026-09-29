/** A cache budget counts retained payload estimates, not V8's total heap.
 * One unref'ed timeout releases expired entries even when the user goes idle.
 * Hits update recency without extending freshness or creating more timers.
 */
export class ExpiringLruCache<K, V> {
  private readonly items = new Map<K, { value: V; bytes: number; expires: number }>();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextExpiry = Infinity;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly weigh: (value: V, key: K) => number,
  ) {}

  get size(): number { return this.items.size; }
  get retainedBytes(): number { return this.bytes; }
  keys(): IterableIterator<K> { return this.items.keys(); }

  *entries(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.items) { yield [key, entry.value]; }
  }

  get(key: K): V | undefined {
    const entry = this.items.get(key);
    if (!entry) { return undefined; }
    if (Date.now() >= entry.expires) {
      this.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    this.delete(key);
    const bytes = this.weigh(value, key);
    // The caller still receives a full result; oversized results simply bypass
    // retention instead of evicting the reusable working set or being truncated.
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes || ttlMs <= 0) { return; }
    while (this.items.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.items.keys().next();
      if (oldest.done) { break; }
      this.delete(oldest.value);
    }
    const expires = Date.now() + ttlMs;
    this.items.set(key, { value, bytes, expires });
    this.bytes += bytes;
    this.scheduleExpiry(expires);
  }

  delete(key: K): boolean {
    const entry = this.items.get(key);
    if (!entry) { return false; }
    this.bytes -= entry.bytes;
    this.items.delete(key);
    if (!this.items.size) { this.clear(); }
    return true;
  }

  clear(): void {
    this.items.clear();
    this.bytes = 0;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = undefined;
    this.nextExpiry = Infinity;
  }

  private scheduleExpiry(expires: number): void {
    if (this.timer && this.nextExpiry <= expires) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.nextExpiry = expires;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextExpiry = Infinity;
      const now = Date.now();
      let next = Infinity;
      for (const [key, entry] of this.items) {
        if (entry.expires <= now) { this.delete(key); }
        else { next = Math.min(next, entry.expires); }
      }
      if (next < Infinity) { this.scheduleExpiry(next); }
    }, Math.max(1, expires - Date.now()));
    this.timer.unref();
  }
}
