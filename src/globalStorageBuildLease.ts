import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MINUTE_MS = 60 * 1_000;
const INTENT_FILE_RE = /^build-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

interface BuildIntent {
  schema: 1;
  pid: number;
  nonce: string;
  label: string;
}

interface PublishedIntent {
  fileName: string;
  path: string;
  temporaryPath: string;
}

export interface GlobalStorageBuildLeaseOptions {
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  random?: () => number;
  retryMinMs?: number;
  retryMaxMs?: number;
  heartbeatMs?: number;
  maxIntentAgeMs?: number;
  malformedIntentGraceMs?: number;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM and unknown errors fail closed: the owner may still be alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function abortError(): Error {
  const error = new Error('global storage build lease cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { throw abortError(); }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Cross-extension-host single-slot lease for CPU-heavy generated work.
 *
 * Every contender publishes a UUID-qualified file and only ever removes its
 * own file or another UUID-qualified file whose owner is provably stale. No
 * shared lock path is replaced or unlinked, avoiding stale-reclaim races.
 * A contender proceeds only while no other live contender is visible. If two
 * arrive together both may yield and retry, but they can never both enter the
 * critical section concurrently.
 */
export class GlobalStorageBuildLease {
  private readonly intentDirectory: string;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly random: () => number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly maxIntentAgeMs: number;
  private readonly malformedIntentGraceMs: number;

  constructor(storagePath: string, options: GlobalStorageBuildLeaseOptions = {}) {
    this.intentDirectory = path.join(storagePath, '.build-intents');
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.random = options.random ?? Math.random;
    this.retryMinMs = Math.max(1, options.retryMinMs ?? 200);
    this.retryMaxMs = Math.max(this.retryMinMs, options.retryMaxMs ?? 600);
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 30_000);
    this.maxIntentAgeMs = Math.max(MINUTE_MS, options.maxIntentAgeMs ?? 15 * MINUTE_MS);
    this.malformedIntentGraceMs = Math.max(MINUTE_MS, options.malformedIntentGraceMs ?? 60 * MINUTE_MS);
  }

  async runExclusive<T>(
    label: string,
    task: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const intent = await this.acquire(label, signal);
    const heartbeat = setInterval(() => {
      const now = new Date(this.now());
      void fs.promises.utimes(intent.path, now, now).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      throwIfAborted(signal);
      return await task(signal);
    } finally {
      clearInterval(heartbeat);
      await this.removeIntent(intent);
    }
  }

  private async acquire(label: string, signal?: AbortSignal): Promise<PublishedIntent> {
    await fs.promises.mkdir(this.intentDirectory, { recursive: true });
    for (;;) {
      throwIfAborted(signal);
      const intent = await this.publishIntent(label);
      let contended: boolean;
      try {
        contended = await this.hasLiveCompetitor(intent);
      } catch (err) {
        await this.removeIntent(intent);
        throw err;
      }
      if (!contended) { return intent; }
      await this.removeIntent(intent);
      await waitForRetry(this.retryDelayMs(), signal);
    }
  }

  private async publishIntent(label: string): Promise<PublishedIntent> {
    const nonce = crypto.randomUUID();
    const fileName = `build-${process.pid}-${nonce}.json`;
    const intentPath = path.join(this.intentDirectory, fileName);
    const temporaryPath = `${intentPath}.tmp`;
    const intent: BuildIntent = { schema: 1, pid: process.pid, nonce, label };
    try {
      await fs.promises.writeFile(temporaryPath, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporaryPath, intentPath);
      return { fileName, path: intentPath, temporaryPath };
    } catch (err) {
      try { await fs.promises.rm(temporaryPath, { force: true }); } catch {}
      try { await fs.promises.rm(intentPath, { force: true }); } catch {}
      throw err;
    }
  }

  private async hasLiveCompetitor(own: PublishedIntent): Promise<boolean> {
    const entries = await fs.promises.readdir(this.intentDirectory, { withFileTypes: true });
    let contended = false;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === own.fileName) { continue; }
      const match = INTENT_FILE_RE.exec(entry.name);
      if (!match) { continue; }
      const contenderPath = path.join(this.intentDirectory, entry.name);
      const filePid = Number(match[1]);
      const fileNonce = match[2];
      let contender: Partial<BuildIntent> | null = null;
      let ageMs = 0;
      try {
        contender = JSON.parse(await fs.promises.readFile(contenderPath, 'utf8')) as Partial<BuildIntent>;
        ageMs = this.now() - (await fs.promises.stat(contenderPath)).mtimeMs;
      } catch {}
      const valid = contender?.schema === 1
        && contender.pid === filePid
        && contender.nonce === fileNonce
        && typeof contender.label === 'string';
      if (valid && this.isProcessAlive(filePid) && ageMs <= this.maxIntentAgeMs) {
        contended = true;
        continue;
      }
      if (!valid && ageMs <= this.malformedIntentGraceMs) {
        // Atomic publication means a legitimate file should be complete, but
        // a recent malformed contender still fails closed.
        contended = true;
        continue;
      }
      // The path contains the contender's UUID, so stale reclamation cannot
      // remove a newly-published lease belonging to another process.
      try { await fs.promises.rm(contenderPath, { force: true }); } catch {}
    }
    return contended;
  }

  private retryDelayMs(): number {
    const range = this.retryMaxMs - this.retryMinMs;
    const random = Math.min(1, Math.max(0, this.random()));
    return this.retryMinMs + Math.floor(random * (range + 1));
  }

  private async removeIntent(intent: PublishedIntent): Promise<void> {
    try { await fs.promises.rm(intent.path, { force: true }); } catch {}
    try { await fs.promises.rm(intent.temporaryPath, { force: true }); } catch {}
  }
}
