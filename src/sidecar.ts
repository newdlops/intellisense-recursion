// Stdio JSON-RPC client for the ir-indexer sidecar binary.
//
// Protocol: one JSON object per line. Requests carry an id; the sidecar replies
// with an object carrying the same id. See indexer/src/serve.rs for the server
// side.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';
import { existsSync } from 'node:fs';

export type SidecarKind = 'class' | 'function' | 'method' | 'variable' | 'attribute' | 'alias';
export type SidecarSource = 'project' | 'venv' | 'stdlib' | 'typeshed' | 'other';
export type SidecarLanguage = 'python' | 'typescript' | 'other';

export interface SidecarHit {
  /** Absolute filesystem path. */
  path: string;
  line: number;
  col: number;
  kind: SidecarKind;
  source: SidecarSource;
  language: SidecarLanguage;
}

export interface SidecarRoot {
  tag: SidecarSource;
  path: string;
}

export interface SidecarReady {
  files: number;
  symbols: number;
  postings: number;
  size: number;
  roots: SidecarRoot[];
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SidecarLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const REQUEST_TIMEOUT_MS = 2_000;

export class IndexSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<SidecarReady> | null = null;
  private disposed = false;

  constructor(
    private binary: string,
    private indexPath: string,
    private log: SidecarLogger,
  ) {}

  /** Spawn the server process. Resolves once it emits the ready banner. */
  start(): Promise<SidecarReady> {
    if (this.ready) { return this.ready; }
    if (this.disposed) { return Promise.reject(new Error('sidecar disposed')); }

    if (!existsSync(this.binary)) {
      return Promise.reject(new Error(`sidecar binary not found: ${this.binary}`));
    }
    if (!existsSync(this.indexPath)) {
      return Promise.reject(new Error(`index file not found: ${this.indexPath}`));
    }

    this.ready = new Promise<SidecarReady>((resolve, reject) => {
      const proc = spawn(this.binary, ['serve', this.indexPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;

      proc.on('error', (err) => {
        this.log.warn(`[sidecar] spawn error: ${err}`);
        reject(err);
        this.teardown();
      });

      proc.on('exit', (code, signal) => {
        this.log.warn(`[sidecar] exit code=${code} signal=${signal}`);
        this.failAllPending(new Error(`sidecar exited (${code ?? signal})`));
        this.teardown();
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) { this.log.warn(`[sidecar err] ${line}`); }
        }
      });

      proc.stdout.setEncoding('utf8');
      const rl = createInterface({ input: proc.stdout });
      this.rl = rl;

      let readyReceived = false;
      rl.on('line', (line: string) => {
        if (!line.trim()) { return; }
        let msg: any;
        try { msg = JSON.parse(line); } catch {
          this.log.warn(`[sidecar] bad json: ${line.slice(0, 200)}`);
          return;
        }

        if (!readyReceived && msg?.ready === true) {
          readyReceived = true;
          resolve({
            files: msg.files ?? 0,
            symbols: msg.symbols ?? 0,
            postings: msg.postings ?? 0,
            size: msg.size ?? 0,
            roots: Array.isArray(msg.roots) ? msg.roots : [],
          });
          return;
        }

        const id = typeof msg?.id === 'number' ? msg.id : -1;
        const pend = this.pending.get(id);
        if (!pend) { return; }
        this.pending.delete(id);
        clearTimeout(pend.timer);
        if (msg.ok) { pend.resolve(msg); }
        else { pend.reject(new Error(msg.error || 'sidecar error')); }
      });
    });

    return this.ready;
  }

  private send<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc || this.proc.stdin.destroyed) {
      return Promise.reject(new Error('sidecar not running'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, op, ...params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar ${op} timeout`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async lookup(
    name: string,
    limit = 20,
    language?: SidecarLanguage,
  ): Promise<SidecarHit[]> {
    const resp = await this.send<{ hits: SidecarHit[]; total: number }>('lookup', {
      name,
      limit,
      language,
    });
    return resp.hits || [];
  }

  async lookupMany(
    names: string[],
    limit = 20,
    language?: SidecarLanguage,
  ): Promise<Array<{ name: string; hits: SidecarHit[]; total: number }>> {
    if (names.length === 0) { return []; }
    const resp = await this.send<{
      results: Array<{ name: string; hits: SidecarHit[]; total: number }>;
    }>('lookup_many', { names, limit, language });
    return resp.results || [];
  }

  async ping(): Promise<boolean> {
    try { await this.send('ping'); return true; } catch { return false; }
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed && !this.proc.stdin.destroyed;
  }

  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    this.failAllPending(new Error('sidecar disposed'));
    this.teardown();
  }

  private failAllPending(err: Error) {
    for (const pend of this.pending.values()) {
      clearTimeout(pend.timer);
      pend.reject(err);
    }
    this.pending.clear();
  }

  private teardown() {
    try { this.rl?.close(); } catch {}
    this.rl = null;
    if (this.proc) {
      try {
        this.proc.stdin.end();
        if (!this.proc.killed) { this.proc.kill(); }
      } catch {}
    }
    this.proc = null;
    this.ready = null;
  }
}
