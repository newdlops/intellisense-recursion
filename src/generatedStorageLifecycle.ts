import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export type GeneratedStorageGroup = 'indexer-target' | 'downloaded-bin' | 'workspace-indexes';

export interface GeneratedStorageGenerationIds {
  target?: string;
  download?: string;
  workspace?: string;
}

export interface GeneratedStorageGroupPolicy {
  maxAgeMs: number;
  minEvictionAgeMs: number;
  retainNewestEntries: number;
  maxEntries: number;
  maxBytes: number;
  isValidGeneration: (name: string) => boolean;
}

export interface GeneratedStoragePolicy {
  groups: Record<GeneratedStorageGroup, GeneratedStorageGroupPolicy>;
  staleTemporaryFileAgeMs: number;
}

export interface GeneratedStorageCleanupReport {
  deletedGenerations: Record<GeneratedStorageGroup, number>;
  deletedTemporaryFiles: number;
  deletedStaleLeases: number;
  measuredBytesReclaimed: number;
  cleanupSkippedBecauseLocked: boolean;
}

interface StorageLease {
  schema: 1;
  pid: number;
  generations: GeneratedStorageGenerationIds;
}

interface CleanupIntent {
  schema: 1;
  pid: number;
  nonce: string;
}

interface GenerationEntry {
  name: string;
  fullPath: string;
  mtimeMs: number;
  size?: number;
}

export interface GeneratedStorageLifecycleOptions {
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  policy?: GeneratedStoragePolicy;
}

const TARGET_GENERATION_RE = /^[a-f0-9]{12}$/;
const WORKSPACE_GENERATION_RE = /^[a-f0-9]{20}$/;
const DOWNLOAD_GENERATION_RE = /^v[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const LEASE_FILE_RE = /^session-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const CLEANUP_INTENT_FILE_RE = /^cleanup-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const TEMPORARY_INDEX_RE = /^index\.bin\.tmp(?:-\d+-[0-9a-f-]{36})?$/i;
const STALE_MALFORMED_INTENT_AGE_MS = HOUR_MS;

export const DEFAULT_GENERATED_STORAGE_POLICY: GeneratedStoragePolicy = {
  groups: {
    'indexer-target': {
      maxAgeMs: 14 * DAY_MS,
      minEvictionAgeMs: DAY_MS,
      retainNewestEntries: 1,
      maxEntries: 3,
      maxBytes: 512 * 1024 * 1024,
      isValidGeneration: (name) => TARGET_GENERATION_RE.test(name),
    },
    'downloaded-bin': {
      maxAgeMs: 90 * DAY_MS,
      minEvictionAgeMs: DAY_MS,
      retainNewestEntries: 1,
      maxEntries: 3,
      maxBytes: 192 * 1024 * 1024,
      isValidGeneration: (name) => DOWNLOAD_GENERATION_RE.test(name),
    },
    'workspace-indexes': {
      maxAgeMs: 45 * DAY_MS,
      minEvictionAgeMs: DAY_MS,
      retainNewestEntries: 1,
      maxEntries: 32,
      maxBytes: 512 * 1024 * 1024,
      isValidGeneration: (name) => WORKSPACE_GENERATION_RE.test(name),
    },
  },
  staleTemporaryFileAgeMs: 6 * HOUR_MS,
};

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but cannot be signalled. Any unknown
    // result is also treated as alive so cleanup fails closed.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function groupGeneration(ids: GeneratedStorageGenerationIds, group: GeneratedStorageGroup): string | undefined {
  switch (group) {
    case 'indexer-target': return ids.target;
    case 'downloaded-bin': return ids.download;
    case 'workspace-indexes': return ids.workspace;
  }
}

function emptyReport(): GeneratedStorageCleanupReport {
  return {
    deletedGenerations: {
      'indexer-target': 0,
      'downloaded-bin': 0,
      'workspace-indexes': 0,
    },
    deletedTemporaryFiles: 0,
    deletedStaleLeases: 0,
    measuredBytesReclaimed: 0,
    cleanupSkippedBecauseLocked: false,
  };
}

async function directorySize(directory: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return 0; }
    throw err;
  }

  let size = 0;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      size += await directorySize(child);
    } else if (entry.isFile()) {
      try {
        size += (await fs.promises.stat(child)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
      }
    }
    // Symbolic links and special files are never followed.
  }
  return size;
}

/**
 * Owns only generated data below the extension's globalStorage directory.
 * Unknown files and directory names are deliberately ignored.
 */
export class GeneratedStorageLifecycle {
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly policy: GeneratedStoragePolicy;
  private readonly leaseDirectory: string;
  private readonly leasePath: string;
  private readonly leaseTemporaryPath: string;
  private readonly cleanupIntentDirectory: string;
  private readonly cleanupIntentNonce = crypto.randomUUID();
  private readonly cleanupIntentPath: string;
  private readonly cleanupIntentTemporaryPath: string;
  private cleanupIntentActive = false;
  private startPromise: Promise<GeneratedStorageCleanupReport> | null = null;
  private disposed = false;

  constructor(
    private readonly storagePath: string,
    private readonly generations: GeneratedStorageGenerationIds,
    options: GeneratedStorageLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.policy = options.policy ?? DEFAULT_GENERATED_STORAGE_POLICY;
    this.leaseDirectory = path.join(storagePath, '.sessions');
    this.cleanupIntentDirectory = path.join(storagePath, '.cleanup-intents');
    this.leasePath = path.join(
      this.leaseDirectory,
      `session-${process.pid}-${crypto.randomUUID()}.json`,
    );
    this.leaseTemporaryPath = `${this.leasePath}.tmp`;
    this.cleanupIntentPath = path.join(
      this.cleanupIntentDirectory,
      `cleanup-${process.pid}-${this.cleanupIntentNonce}.json`,
    );
    this.cleanupIntentTemporaryPath = `${this.cleanupIntentPath}.tmp`;
  }

  start(): Promise<GeneratedStorageCleanupReport> {
    if (!this.startPromise) {
      this.startPromise = this.startOnce();
    }
    return this.startPromise;
  }

  dispose(): void {
    this.disposed = true;
    try { fs.rmSync(this.leasePath, { force: true }); } catch {}
    try { fs.rmSync(this.leaseTemporaryPath, { force: true }); } catch {}
    // If cleanup is active, its intent must remain published until the
    // cleanup's finally block releases it. Otherwise a new host could begin a
    // second cleanup while this disposed host is still deleting generations.
    if (!this.cleanupIntentActive) {
      try { fs.rmSync(this.cleanupIntentPath, { force: true }); } catch {}
      try { fs.rmSync(this.cleanupIntentTemporaryPath, { force: true }); } catch {}
    }
  }

  private async startOnce(): Promise<GeneratedStorageCleanupReport> {
    const report = emptyReport();
    await fs.promises.mkdir(this.leaseDirectory, { recursive: true });
    await fs.promises.writeFile(
      this.leaseTemporaryPath,
      JSON.stringify({ schema: 1, pid: process.pid, generations: this.generations } satisfies StorageLease),
      { flag: 'wx', mode: 0o600 },
    );
    await fs.promises.rename(this.leaseTemporaryPath, this.leasePath);
    if (this.disposed) {
      await fs.promises.rm(this.leasePath, { force: true });
      return report;
    }

    await this.touchCurrentGenerations();
    if (!await this.acquireCleanupIntent()) {
      report.cleanupSkippedBecauseLocked = true;
      return report;
    }
    if (this.disposed) {
      await this.releaseCleanupIntent();
      return report;
    }
    try {
      const protectedGenerations = await this.readLiveLeases(report);
      for (const group of Object.keys(this.policy.groups) as GeneratedStorageGroup[]) {
        await this.cleanupGroup(group, protectedGenerations[group], report);
      }
      await this.cleanupTemporaryIndexes(report);
    } finally {
      await this.releaseCleanupIntent();
    }
    return report;
  }

  private async acquireCleanupIntent(): Promise<boolean> {
    await fs.promises.mkdir(this.cleanupIntentDirectory, { recursive: true });
    const intent: CleanupIntent = {
      schema: 1,
      pid: process.pid,
      nonce: this.cleanupIntentNonce,
    };
    this.cleanupIntentActive = true;
    try {
      await fs.promises.writeFile(this.cleanupIntentTemporaryPath, JSON.stringify(intent), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(this.cleanupIntentTemporaryPath, this.cleanupIntentPath);
    } catch (err) {
      await this.releaseCleanupIntent();
      throw err;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.cleanupIntentDirectory, { withFileTypes: true });
    } catch (err) {
      await this.releaseCleanupIntent();
      throw err;
    }
    let hasLiveCompetitor = false;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === path.basename(this.cleanupIntentPath)) { continue; }
      const match = CLEANUP_INTENT_FILE_RE.exec(entry.name);
      if (!match) { continue; }
      const contenderPath = path.join(this.cleanupIntentDirectory, entry.name);
      const filePid = Number(match[1]);
      const fileNonce = match[2];
      let contender: Partial<CleanupIntent> | null = null;
      let contenderAgeMs = 0;
      try {
        contender = JSON.parse(await fs.promises.readFile(contenderPath, 'utf8')) as Partial<CleanupIntent>;
        contenderAgeMs = this.now() - (await fs.promises.stat(contenderPath)).mtimeMs;
      } catch {}
      const valid = contender?.schema === 1
        && contender.pid === filePid
        && contender.nonce === fileNonce;
      if (valid && this.isProcessAlive(filePid)) {
        hasLiveCompetitor = true;
        continue;
      }
      if (!valid && contenderAgeMs <= STALE_MALFORMED_INTENT_AGE_MS) {
        // A newly-created malformed file may still be owned by a process that
        // is publishing it. Fail closed and leave its unique path untouched.
        hasLiveCompetitor = true;
        continue;
      }
      // Every contender owns a UUID-qualified path. Removing a stale path can
      // never unlink a different process's newly-published live intent.
      try { await fs.promises.rm(contenderPath, { force: true }); } catch {}
    }
    if (hasLiveCompetitor) {
      await this.releaseCleanupIntent();
      return false;
    }
    return true;
  }

  private async releaseCleanupIntent(): Promise<void> {
    try {
      try { await fs.promises.rm(this.cleanupIntentPath, { force: true }); } catch {}
      try { await fs.promises.rm(this.cleanupIntentTemporaryPath, { force: true }); } catch {}
    } finally {
      this.cleanupIntentActive = false;
    }
  }

  private async touchCurrentGenerations(): Promise<void> {
    const now = new Date(this.now());
    for (const group of Object.keys(this.policy.groups) as GeneratedStorageGroup[]) {
      const generation = groupGeneration(this.generations, group);
      if (!generation || !this.policy.groups[group].isValidGeneration(generation)) { continue; }
      const generationPath = path.join(this.storagePath, group, generation);
      try { await fs.promises.utimes(generationPath, now, now); } catch {}
    }
  }

  private async readLiveLeases(
    report: GeneratedStorageCleanupReport,
  ): Promise<Record<GeneratedStorageGroup, Set<string>>> {
    const protectedGenerations: Record<GeneratedStorageGroup, Set<string>> = {
      'indexer-target': new Set(),
      'downloaded-bin': new Set(),
      'workspace-indexes': new Set(),
    };
    for (const group of Object.keys(this.policy.groups) as GeneratedStorageGroup[]) {
      const current = groupGeneration(this.generations, group);
      if (current && this.policy.groups[group].isValidGeneration(current)) {
        protectedGenerations[group].add(current);
      }
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.leaseDirectory, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return protectedGenerations; }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) { continue; }
      const match = LEASE_FILE_RE.exec(entry.name);
      if (!match) { continue; }
      const leasePath = path.join(this.leaseDirectory, entry.name);
      const filePid = Number(match[1]);
      let lease: StorageLease | null = null;
      try {
        const parsed = JSON.parse(await fs.promises.readFile(leasePath, 'utf8')) as Partial<StorageLease>;
        if (parsed.schema === 1 && parsed.pid === filePid && parsed.generations && typeof parsed.generations === 'object') {
          lease = parsed as StorageLease;
        }
      } catch {}

      if (!lease || !this.isProcessAlive(filePid)) {
        try {
          await fs.promises.rm(leasePath, { force: true });
          report.deletedStaleLeases += 1;
        } catch {}
        continue;
      }
      for (const group of Object.keys(this.policy.groups) as GeneratedStorageGroup[]) {
        const generation = groupGeneration(lease.generations, group);
        if (generation && this.policy.groups[group].isValidGeneration(generation)) {
          protectedGenerations[group].add(generation);
        }
      }
    }
    return protectedGenerations;
  }

  private async cleanupGroup(
    group: GeneratedStorageGroup,
    protectedGenerations: Set<string>,
    report: GeneratedStorageCleanupReport,
  ): Promise<void> {
    const groupPath = path.join(this.storagePath, group);
    const groupPolicy = this.policy.groups[group];
    let directoryEntries: fs.Dirent[];
    try {
      directoryEntries = await fs.promises.readdir(groupPath, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return; }
      throw err;
    }

    const entries: GenerationEntry[] = [];
    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isDirectory() || !groupPolicy.isValidGeneration(directoryEntry.name)) { continue; }
      const fullPath = path.join(groupPath, directoryEntry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        entries.push({ name: directoryEntry.name, fullPath, mtimeMs: stat.mtimeMs });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    // Keep one last-known-good generation even when it is old. This protects
    // an extension host from the immediately preceding version during a
    // rolling update; current and explicitly leased generations are retained
    // separately below.
    const retainNewestEntries = Math.max(0, groupPolicy.retainNewestEntries);
    const retainedNewest = new Set(
      (retainNewestEntries > 0 ? entries.slice(-retainNewestEntries) : []).map((entry) => entry.name),
    );

    const remaining: GenerationEntry[] = [];
    for (const entry of entries) {
      const expired = this.now() - entry.mtimeMs > groupPolicy.maxAgeMs;
      if (expired && !protectedGenerations.has(entry.name) && !retainedNewest.has(entry.name)) {
        if (await this.deleteGeneration(entry.fullPath)) {
          report.deletedGenerations[group] += 1;
          continue;
        }
      }
      remaining.push(entry);
    }

    for (const entry of remaining) {
      entry.size = await directorySize(entry.fullPath);
    }
    let totalBytes = remaining.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    let totalEntries = remaining.length;
    for (const entry of remaining) {
      if (totalEntries <= groupPolicy.maxEntries && totalBytes <= groupPolicy.maxBytes) { break; }
      const oldEnough = this.now() - entry.mtimeMs > groupPolicy.minEvictionAgeMs;
      if (!oldEnough || protectedGenerations.has(entry.name) || retainedNewest.has(entry.name)) { continue; }
      if (await this.deleteGeneration(entry.fullPath)) {
        const size = entry.size ?? 0;
        totalEntries -= 1;
        totalBytes -= size;
        report.deletedGenerations[group] += 1;
        report.measuredBytesReclaimed += size;
      }
    }
  }

  private async deleteGeneration(generationPath: string): Promise<boolean> {
    try {
      await fs.promises.rm(generationPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupTemporaryIndexes(report: GeneratedStorageCleanupReport): Promise<void> {
    const workspaceRoot = path.join(this.storagePath, 'workspace-indexes');
    let generations: fs.Dirent[];
    try {
      generations = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return; }
      throw err;
    }
    for (const generation of generations) {
      if (!generation.isDirectory() || !WORKSPACE_GENERATION_RE.test(generation.name)) { continue; }
      const generationPath = path.join(workspaceRoot, generation.name);
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(generationPath, { withFileTypes: true });
      } catch { continue; }
      for (const file of files) {
        if (!file.isFile() || !TEMPORARY_INDEX_RE.test(file.name)) { continue; }
        const temporaryPath = path.join(generationPath, file.name);
        try {
          const stat = await fs.promises.stat(temporaryPath);
          if (this.now() - stat.mtimeMs <= this.policy.staleTemporaryFileAgeMs) { continue; }
          await fs.promises.rm(temporaryPath, { force: true });
          report.deletedTemporaryFiles += 1;
        } catch {}
      }
    }
  }
}
