// Manages the lifecycle of the ir-indexer sidecar process and its on-disk index.
//
// Responsibilities:
//   - Locate the indexer binary (dev vs. packaged)
//   - Derive a per-workspace cache path
//   - Auto-detect extra roots (.venv/site-packages, Python stdlib, Pylance typeshed)
//   - Initial build on activation (async, non-blocking)
//   - Spawn the stdio sidecar once the index exists
//   - Re-build on save (debounced) and restart the sidecar

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import {
  IndexSidecar,
  SidecarHit,
  SidecarLanguage,
  SidecarLogger,
  SidecarRoot,
  SidecarSource,
} from './sidecar';

const REBUILD_DEBOUNCE_MS = 10_000;
const BUILD_TIMEOUT_MS = 180_000;
const SIDECAR_BUILD_TIMEOUT_MS = 600_000;
const SIDECAR_DOWNLOAD_TIMEOUT_MS = 120_000;
const SIDECAR_OUTPUT_TAIL_CHARS = 8_000;
const MAX_SIDECAR_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_CHECKSUM_DOWNLOAD_BYTES = 256 * 1024;
const MIN_SIDECAR_DOWNLOAD_BYTES = 512 * 1024;

// Extensions whose save events trigger a re-index, matching what the Rust
// indexer can parse.
const SUPPORTED_EXTS = new Set(['.py', '.pyi', '.ts', '.tsx']);

function isSupportedPath(fsPath: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(fsPath));
}

function sidecarExeName(): string {
  return process.platform === 'win32' ? 'ir-indexer.exe' : 'ir-indexer';
}

function packagedBinaryName(): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return `ir-indexer-${process.platform}-${process.arch}${suffix}`;
}

function bundledManifestPath(extensionPath: string): string {
  return path.join(extensionPath, 'indexer', 'Cargo.toml');
}

function sidecarTargetDir(extensionPath: string, storagePath: string): string {
  const hash = crypto.createHash('sha1').update(extensionPath).digest('hex').slice(0, 12);
  return path.join(storagePath, 'indexer-target', hash);
}

function sidecarDownloadDir(extensionPath: string, storagePath: string): string {
  const version = packageVersion(extensionPath) ?? 'unknown';
  return path.join(storagePath, 'downloaded-bin', `v${version}`);
}

function downloadedBinaryPath(extensionPath: string, storagePath: string): string {
  return path.join(sidecarDownloadDir(extensionPath, storagePath), packagedBinaryName());
}

function locateBinary(extensionPath: string, storagePath: string): string | null {
  const targetDir = sidecarTargetDir(extensionPath, storagePath);
  const candidates = [
    path.join(extensionPath, 'indexer', 'target', 'release', sidecarExeName()),
    path.join(extensionPath, 'bin', packagedBinaryName()),
    path.join(extensionPath, 'bin', `ir-indexer-${process.platform}-${process.arch}`),
    path.join(extensionPath, 'bin', 'ir-indexer'),
    downloadedBinaryPath(extensionPath, storagePath),
    path.join(targetDir, 'release', sidecarExeName()),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

function hasBundledIndexerSource(extensionPath: string): boolean {
  return fs.existsSync(bundledManifestPath(extensionPath));
}

function readPackageJson(extensionPath: string): any | null {
  try {
    const raw = fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function packageVersion(extensionPath: string): string | null {
  const version = readPackageJson(extensionPath)?.version;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

function repositorySlug(extensionPath: string): string | null {
  const pkg = readPackageJson(extensionPath);
  const repo = typeof pkg?.repository === 'string'
    ? pkg.repository
    : typeof pkg?.repository?.url === 'string'
      ? pkg.repository.url
      : '';
  const match = repo.match(/github\.com[:/](?<slug>[^/#?]+\/[^/#?.]+)(?:\.git)?/);
  return match?.groups?.slug ?? null;
}

function releaseAssetUrl(extensionPath: string): string | null {
  const version = packageVersion(extensionPath);
  const slug = repositorySlug(extensionPath);
  if (!version || !slug) { return null; }
  return `https://github.com/${slug}/releases/download/v${version}/${packagedBinaryName()}`;
}

function releaseChecksumsUrl(extensionPath: string): string | null {
  const version = packageVersion(extensionPath);
  const slug = repositorySlug(extensionPath);
  if (!version || !slug) { return null; }
  return `https://github.com/${slug}/releases/download/v${version}/SHA256SUMS`;
}

function appendLimited(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > SIDECAR_OUTPUT_TAIL_CHARS
    ? next.slice(next.length - SIDECAR_OUTPUT_TAIL_CHARS)
    : next;
}

function httpGetText(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  redirects = 0,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'intellisense-recursion-vscode' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects while fetching ${url}`));
          return;
        }
        resolve(httpGetText(new URL(location, url).toString(), timeoutMs, maxBytes, redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} while fetching ${url}`));
        return;
      }

      res.setEncoding('utf8');
      let bytes = 0;
      let body = '';
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          req.destroy(new Error(`download too large: ${url}`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`download timeout after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
  });
}

function downloadFile(
  url: string,
  dst: string,
  timeoutMs: number,
  maxBytes: number,
  redirects = 0,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'intellisense-recursion-vscode' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects while downloading ${url}`));
          return;
        }
        resolve(downloadFile(new URL(location, url).toString(), dst, timeoutMs, maxBytes, redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} while downloading ${url}`));
        return;
      }

      const out = fs.createWriteStream(dst, { mode: 0o755 });
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error(`download too large: ${url}`));
          out.destroy();
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close((err) => err ? reject(err) : resolve());
      });
      out.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`download timeout after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
  });
}

function checksumForAsset(sums: string, assetName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && path.basename(match[2]) === assetName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function cachePathFor(workspaceRoot: string): string {
  const hash = crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
  const dir = path.join(os.homedir(), '.cache', 'intellisense-recursion');
  return path.join(dir, `${hash}.bin`);
}

type ExtraRoot = { tag: Exclude<SidecarSource, 'project'>; path: string };

/**
 * Look for venv site-packages directories under the workspace root. Handles
 * both `.venv` and `venv` and any Python minor version.
 */
function detectVenvRoots(workspaceRoot: string): ExtraRoot[] {
  const found: ExtraRoot[] = [];
  for (const dirName of ['.venv', 'venv']) {
    const libDir = path.join(workspaceRoot, dirName, 'lib');
    let entries: string[];
    try { entries = fs.readdirSync(libDir); } catch { continue; }
    for (const ent of entries) {
      if (!ent.startsWith('python')) { continue; }
      const sp = path.join(libDir, ent, 'site-packages');
      try {
        if (fs.statSync(sp).isDirectory()) {
          found.push({ tag: 'venv', path: sp });
        }
      } catch {}
    }
  }
  return found;
}

/**
 * Ask the project's Python interpreter where its stdlib lives. Prefers the
 * venv interpreter so the reported path matches the Python that's actually
 * used by the project's type-checker.
 */
function detectStdlib(workspaceRoot: string): ExtraRoot | null {
  const candidates = [
    path.join(workspaceRoot, '.venv', 'bin', 'python3'),
    path.join(workspaceRoot, '.venv', 'bin', 'python'),
    path.join(workspaceRoot, 'venv', 'bin', 'python3'),
    path.join(workspaceRoot, 'venv', 'bin', 'python'),
    'python3',
    'python',
  ];
  const code = 'import sysconfig,sys\nprint(sysconfig.get_paths()["stdlib"])';
  for (const py of candidates) {
    try {
      const result = spawnSync(py, ['-c', code], { timeout: 3_000, encoding: 'utf8' });
      if (result.status !== 0) { continue; }
      const stdlib = (result.stdout || '').trim();
      if (stdlib && fs.existsSync(stdlib)) {
        return { tag: 'stdlib', path: stdlib };
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

/**
 * Find the newest Pylance extension on disk and return its typeshed-fallback
 * directory. Pylance ships a very complete set of stubs that compensate for
 * gaps in the venv's own typeshed.
 */
function detectPylanceTypeshed(): ExtraRoot | null {
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  let entries: string[];
  try { entries = fs.readdirSync(extDir); } catch { return null; }
  const pylances = entries
    .filter((n) => n.startsWith('ms-python.vscode-pylance-'))
    .sort();
  for (let i = pylances.length - 1; i >= 0; i--) {
    const p = path.join(extDir, pylances[i], 'dist', 'typeshed-fallback');
    if (fs.existsSync(p)) {
      return { tag: 'typeshed', path: p };
    }
  }
  return null;
}

/**
 * TypeScript/JavaScript dep directory — we index it as "other" so `.d.ts`
 * files (@apollo, @types, etc.) resolve without LSP.
 */
function detectNodeModules(workspaceRoot: string): ExtraRoot | null {
  const nm = path.join(workspaceRoot, 'node_modules');
  try {
    if (fs.statSync(nm).isDirectory()) {
      return { tag: 'other', path: nm };
    }
  } catch {}
  return null;
}

function detectExtraRoots(workspaceRoot: string, log: SidecarLogger): ExtraRoot[] {
  const roots: ExtraRoot[] = [];
  roots.push(...detectVenvRoots(workspaceRoot));
  const stdlib = detectStdlib(workspaceRoot);
  if (stdlib) { roots.push(stdlib); }
  const pylance = detectPylanceTypeshed();
  if (pylance) { roots.push(pylance); }
  const nm = detectNodeModules(workspaceRoot);
  if (nm) { roots.push(nm); }
  for (const r of roots) {
    log.info(`[ir] extra root: ${r.tag} → ${r.path}`);
  }
  if (roots.length === 0) {
    log.info('[ir] no extra roots detected (project-only index)');
  }
  return roots;
}

type State =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'ready'; sidecar: IndexSidecar }
  | { kind: 'failed'; reason: string };

export class IndexManager {
  private state: State = { kind: 'idle' };
  private binary: string | null;
  private workspaceRoot: string | null;
  private indexPath: string | null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildInFlight = false;
  private binaryDownloadInFlight: Promise<string | null> | null = null;
  private binaryBuildInFlight: Promise<string | null> | null = null;
  private extraRoots: ExtraRoot[] = [];
  private indexedRoots: SidecarRoot[] = [];

  constructor(
    private readonly extensionPath: string,
    private readonly storagePath: string,
    private readonly log: SidecarLogger,
  ) {
    this.binary = locateBinary(extensionPath, storagePath);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0 || folders[0].uri.scheme !== 'file') {
      this.workspaceRoot = null;
      this.indexPath = null;
    } else {
      this.workspaceRoot = folders[0].uri.fsPath;
      this.indexPath = cachePathFor(this.workspaceRoot);
    }
  }

  isAvailable(): boolean {
    return this.workspaceRoot !== null
      && (
        this.binary !== null
        || releaseAssetUrl(this.extensionPath) !== null
        || hasBundledIndexerSource(this.extensionPath)
      );
  }

  /** True once an index has been loaded that includes at least one external root. */
  hasFullCoverage(): boolean {
    return this.indexedRoots.some((r) => r.tag !== 'project');
  }

  /** The set of distinct source tags currently indexed (e.g. for logging/gating). */
  indexedSources(): SidecarSource[] {
    const set = new Set<SidecarSource>();
    for (const r of this.indexedRoots) { set.add(r.tag); }
    return Array.from(set);
  }

  /**
   * Start the manager: detect roots, build if missing, then spawn sidecar.
   * Non-blocking. Errors are logged, not thrown — the extension must keep
   * working via LSP.
   */
  async start(): Promise<void> {
    if (!this.workspaceRoot || !this.indexPath) {
      this.log.info('[ir] no workspace folder; fast lookup disabled');
      this.state = { kind: 'failed', reason: 'no-workspace' };
      return;
    }
    if (!this.binary) {
      this.binary = await this.ensureBinary();
    }
    if (!this.binary) {
      this.log.warn('[ir] sidecar binary not found and could not be downloaded or built; fast lookup disabled');
      this.state = { kind: 'failed', reason: 'binary-missing' };
      return;
    }
    this.log.info(`[ir] workspace=${this.workspaceRoot}`);
    this.log.info(`[ir] index=${this.indexPath}`);
    this.log.info(`[ir] binary=${this.binary}`);

    this.extraRoots = detectExtraRoots(this.workspaceRoot, this.log);

    if (fs.existsSync(this.indexPath)) {
      this.log.info('[ir] using existing index');
      try {
        await this.spawnSidecar();
        // If coverage is missing (e.g. v1 index predating external roots),
        // rebuild once in background so the next session has the full set.
        if (!this.hasFullCoverage() && this.extraRoots.length > 0) {
          this.log.info('[ir] existing index lacks external roots — rebuilding in background');
          void this.rebuild().catch((err) => this.log.warn(`[ir] bg rebuild error: ${err}`));
        }
        return;
      } catch (err) {
        this.log.warn(`[ir] existing index failed to load (${err}); rebuilding`);
      }
    } else {
      this.log.info('[ir] no existing index — building');
    }
    await this.rebuild();
  }

  /**
   * Query the sidecar. Returns [] if sidecar is not ready, the symbol isn't
   * known, or the query fails — callers treat this as "LSP fallback required".
   */
  async lookup(
    name: string,
    limit = 20,
    language?: SidecarLanguage,
  ): Promise<SidecarHit[]> {
    if (this.state.kind !== 'ready') { return []; }
    try {
      return await this.state.sidecar.lookup(name, limit, language);
    } catch (err) {
      this.log.warn(`[ir] lookup failed: ${err}`);
      return [];
    }
  }

  async lookupMany(
    names: string[],
    limit = 20,
    language?: SidecarLanguage,
  ): Promise<Array<{ name: string; hits: SidecarHit[]; total: number }>> {
    if (this.state.kind !== 'ready') { return []; }
    try {
      return await this.state.sidecar.lookupMany(names, limit, language);
    } catch (err) {
      this.log.warn(`[ir] lookup_many failed: ${err}`);
      return [];
    }
  }

  /** Register listeners: file save → debounced rebuild. */
  registerWatchers(context: vscode.ExtensionContext) {
    const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isSupportedPath(doc.uri.fsPath)) { return; }
      if (this.workspaceRoot && !doc.uri.fsPath.startsWith(this.workspaceRoot)) { return; }
      this.scheduleRebuild();
    });
    context.subscriptions.push(onSave);
  }

  /** Public command: force immediate rebuild. */
  async rebuildNow(): Promise<void> {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    await this.rebuild();
  }

  private scheduleRebuild() {
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild().catch((err) => this.log.warn(`[ir] rebuild error: ${err}`));
    }, REBUILD_DEBOUNCE_MS);
  }

  private async ensureBinary(): Promise<string | null> {
    const existing = locateBinary(this.extensionPath, this.storagePath);
    if (existing) { return existing; }

    const downloaded = await this.ensureDownloadedBinary();
    if (downloaded) { return downloaded; }

    if (!hasBundledIndexerSource(this.extensionPath)) { return null; }

    if (!this.binaryBuildInFlight) {
      this.binaryBuildInFlight = this.buildBundledSidecar()
        .catch((err) => {
          this.log.warn(`[ir] sidecar compile failed: ${err}`);
          return null;
        })
        .finally(() => {
          this.binaryBuildInFlight = null;
        });
    }
    return this.binaryBuildInFlight;
  }

  private async ensureDownloadedBinary(): Promise<string | null> {
    const existing = locateBinary(this.extensionPath, this.storagePath);
    if (existing) { return existing; }
    if (!releaseAssetUrl(this.extensionPath)) { return null; }

    if (!this.binaryDownloadInFlight) {
      this.binaryDownloadInFlight = this.downloadReleaseSidecar()
        .catch((err) => {
          this.log.warn(`[ir] sidecar download failed: ${err}`);
          return null;
        })
        .finally(() => {
          this.binaryDownloadInFlight = null;
        });
    }
    return this.binaryDownloadInFlight;
  }

  private async downloadReleaseSidecar(): Promise<string> {
    const url = releaseAssetUrl(this.extensionPath);
    const sumsUrl = releaseChecksumsUrl(this.extensionPath);
    if (!url || !sumsUrl) {
      throw new Error('release URL unavailable');
    }

    const assetName = packagedBinaryName();
    const dst = downloadedBinaryPath(this.extensionPath, this.storagePath);
    const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    this.log.info(`[ir] sidecar binary missing; downloading ${assetName}`);
    try {
      const sums = await httpGetText(
        sumsUrl,
        SIDECAR_DOWNLOAD_TIMEOUT_MS,
        MAX_CHECKSUM_DOWNLOAD_BYTES,
      );
      const expectedSha = checksumForAsset(sums, assetName);
      if (!expectedSha) {
        throw new Error(`checksum not found for ${assetName}`);
      }

      await downloadFile(url, tmp, SIDECAR_DOWNLOAD_TIMEOUT_MS, MAX_SIDECAR_DOWNLOAD_BYTES);
      const stat = fs.statSync(tmp);
      if (stat.size < MIN_SIDECAR_DOWNLOAD_BYTES) {
        throw new Error(`downloaded sidecar is unexpectedly small (${stat.size} bytes)`);
      }

      const actualSha = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (actualSha !== expectedSha) {
        throw new Error(`checksum mismatch for ${assetName}`);
      }

      if (process.platform !== 'win32') {
        fs.chmodSync(tmp, 0o755);
      }
      fs.renameSync(tmp, dst);
      this.log.info(`[ir] sidecar downloaded: ${dst}`);
      return dst;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  private buildBundledSidecar(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const cargo = spawnSync('cargo', ['--version'], { timeout: 3_000, encoding: 'utf8' });
      if (cargo.status !== 0) {
        reject(new Error('cargo not found on PATH; install Rust to enable the fast sidecar'));
        return;
      }

      const manifest = bundledManifestPath(this.extensionPath);
      const targetDir = sidecarTargetDir(this.extensionPath, this.storagePath);
      fs.mkdirSync(targetDir, { recursive: true });

      const args = [
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        manifest,
        '--target-dir',
        targetDir,
      ];
      this.log.info(`[ir] sidecar binary missing; compiling with cargo (${cargo.stdout.trim()})`);

      const proc = spawn('cargo', args, {
        cwd: this.extensionPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CARGO_TERM_COLOR: 'never' },
      });
      let output = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => { output = appendLimited(output, chunk); });
      proc.stderr.on('data', (chunk: string) => { output = appendLimited(output, chunk); });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`cargo build timeout after ${SIDECAR_BUILD_TIMEOUT_MS}ms`));
      }, SIDECAR_BUILD_TIMEOUT_MS);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`cargo build exited with code ${code}: ${output.slice(-1_000)}`));
          return;
        }

        const built = path.join(targetDir, 'release', sidecarExeName());
        if (!fs.existsSync(built)) {
          reject(new Error(`cargo build succeeded but binary is missing: ${built}`));
          return;
        }
        if (process.platform !== 'win32') {
          try { fs.chmodSync(built, 0o755); } catch {}
        }
        for (const line of output.trim().split('\n').slice(-16)) {
          if (line.trim()) { this.log.info(`[ir cargo] ${line}`); }
        }
        this.log.info(`[ir] sidecar compiled: ${built}`);
        resolve(built);
      });
    });
  }

  private async rebuild(): Promise<void> {
    if (!this.workspaceRoot || !this.indexPath) { return; }
    if (!this.binary) {
      this.binary = await this.ensureBinary();
    }
    if (!this.binary) {
      this.log.warn('[ir] rebuild skipped: sidecar binary unavailable');
      return;
    }
    if (this.rebuildInFlight) { return; }
    this.rebuildInFlight = true;

    const prevState = this.state;
    this.state = { kind: 'building' };

    try {
      const tmpPath = this.indexPath + '.tmp';
      fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });

      const t0 = Date.now();
      await this.runBuild(tmpPath);
      fs.renameSync(tmpPath, this.indexPath);
      const elapsed = Date.now() - t0;
      this.log.info(`[ir] build done in ${elapsed}ms`);

      // Tear down prior sidecar before respawn.
      if (prevState.kind === 'ready') {
        prevState.sidecar.dispose();
      }
      await this.spawnSidecar();
    } catch (err) {
      this.log.warn(`[ir] build failed: ${err}`);
      if (prevState.kind === 'ready') {
        this.state = prevState;
      } else {
        this.state = { kind: 'failed', reason: String(err) };
      }
    } finally {
      this.rebuildInFlight = false;
    }
  }

  private runBuild(outPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ['build', this.workspaceRoot!, '-o', outPath];
      for (const r of this.extraRoots) {
        args.push('--extra-root', `${r.tag}:${r.path}`);
      }
      const proc = spawn(this.binary!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.stdout.resume();

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`build timeout after ${BUILD_TIMEOUT_MS}ms`));
      }, BUILD_TIMEOUT_MS);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          for (const line of stderr.trim().split('\n').slice(-16)) {
            if (line.trim()) { this.log.info(`[ir build] ${line}`); }
          }
          resolve();
        } else {
          reject(new Error(`build exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });
    });
  }

  private async spawnSidecar(): Promise<void> {
    if (!this.binary || !this.indexPath) { return; }
    const sidecar = new IndexSidecar(this.binary, this.indexPath, this.log);
    const info = await sidecar.start(); // rethrow on failure so start() can recover
    this.indexedRoots = info.roots;
    const sources = info.roots.map((r) => r.tag).join(',') || 'project';
    this.log.info(
      `[ir] sidecar ready — ${info.files} files, ${info.symbols} symbols, ` +
        `${info.postings} postings, ${(info.size / 1024 / 1024).toFixed(2)} MiB ` +
        `(roots: ${sources})`,
    );
    this.state = { kind: 'ready', sidecar };
  }

  dispose() {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.state.kind === 'ready') {
      this.state.sidecar.dispose();
    }
    this.state = { kind: 'idle' };
    this.indexedRoots = [];
  }
}
