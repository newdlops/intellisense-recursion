/**
 * Shared main-inspector startup protocol used by both local UI extensions.
 * A main process gets at most one automatic activation request for its lifetime. Client reconnects
 * only observe/reuse its listener; no caller owns or shuts down the shared inspector server.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MainInspectorEndpoint { readonly host: string; readonly port: number }
export interface MainInspectorStartup<T> {
  readonly discover: () => Promise<T | undefined>;
  readonly request: () => void | Promise<void>;
  readonly log?: (message: string) => void;
  readonly timeoutMs?: number;
  /** Test/process-adapter seam; the real token includes the OS process creation time. */
  readonly identity?: () => Promise<string>;
  readonly directory?: string;
}
const creationTimes = new Map<number, Promise<string>>();

function capture(file: string, args: string[], allowEmptyExit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !(allowEmptyExit && error.code === 1 && !stdout.trim() && !stderr.trim())) { reject(error); }
      else { resolve(stdout); }
    });
  });
}

/** Reads a creation stamp rather than letting a reused numeric PID inherit an old reservation. */
async function creationIdentity(pid: number): Promise<string> {
  let pending = creationTimes.get(pid);
  if (!pending) {
    pending = (async () => {
      const stamp = process.platform === 'win32'
        ? await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`])
        : await capture(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-p', String(pid), '-o', 'lstart=']);
      if (!stamp.trim()) { throw new Error(`Cannot verify creation time of main PID ${pid}`); }
      return `${pid}:${stamp.trim()}`;
    })();
    creationTimes.set(pid, pending);
    pending.catch(() => { if (creationTimes.get(pid) === pending) { creationTimes.delete(pid); } });
  }
  return pending;
}

/** Atomically reserves startup across extension hosts and across the two separately bundled copies. */
async function reserveStart(pid: number, options: MainInspectorStartup<unknown>): Promise<boolean> {
  const identity = await (options.identity?.() ?? creationIdentity(pid));
  if (!identity || identity.length > 4096) { throw new Error('Invalid main-process creation identity'); }
  const uid = process.getuid?.();
  const directory = options.directory ?? path.join(os.tmpdir(), `vscode-main-inspector-start-v1-${uid ?? 'user'}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new Error('Main-inspector reservation directory is not privately owned');
  }
  const key = createHash('sha256').update(identity).digest('hex');
  const marker = path.join(directory, `${pid}-${key}.json`);
  let file;
  try { file = await fs.open(marker, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
    const existing = await fs.lstat(marker);
    if (!existing.isFile() || existing.isSymbolicLink() ||
        (uid !== undefined && (existing.uid !== uid || (existing.mode & 0o077) !== 0))) {
      throw new Error('Main-inspector reservation is not a privately owned file');
    }
    return false;
  }
  try { await file.writeFile(JSON.stringify({ schema: 1, pid, identity, requester: process.pid, at: Date.now() }) + '\n'); }
  finally { await file.close(); }
  // Retain the tiny reservation even after failure/host exit. Reclaiming it could repeat a signal
  // while Node's inspector thread is still initializing. A new process creation stamp gets a new key.
  return true;
}

/** Reuses a discovered inspector, or requests it once and polls without re-signalling. */
export async function acquireMainInspector<T>(pid: number, options: MainInspectorStartup<T>): Promise<T> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) { throw new Error('Invalid owning main PID'); }
  const ready = await options.discover();
  if (ready !== undefined) { return ready; }
  const reserved = await reserveStart(pid, options);
  const raced = await options.discover();
  if (raced !== undefined) { return raced; }
  if (reserved) {
    options.log?.(`Main PID ${pid}: requesting inspector once for this process lifetime`);
    await options.request();
  } else {
    options.log?.(`Main PID ${pid}: observing the existing startup request without another signal`);
  }
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  do {
    const result = await options.discover();
    if (result !== undefined) { return result; }
    if (Date.now() >= deadline) { break; }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error(`Main inspector for owned PID ${pid} is unavailable; no repeated activation or foreign debugger shutdown was attempted`);
}

/** Accepts loopback listeners only; wildcard and external interfaces are never debugger targets. */
export function parseMainInspectorAddress(value: string): MainInspectorEndpoint | undefined {
  const match = /^(?:\[([^\]]+)\]|([^\s]+)):(\d+)$/u.exec(value.trim());
  if (!match) { return undefined; }
  const host = (match[1] ?? match[2]).replace(/^::ffff:/iu, '');
  const port = Number(match[3]);
  if (port < 1 || port > 65535) { return undefined; }
  if (host === '::1') { return { host, port }; }
  const octets = host.split('.');
  if (octets.length !== 4 || octets[0] !== '127' || octets.some(part => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) { return undefined; }
  return { host: octets.map(Number).join('.'), port };
}

/** Parses only listeners reported for the requested PID, including arbitrary/dedicated loopbacks. */
export function parseMainInspectorListeners(text: string, pid: number, format: 'lsof' | 'netstat' | 'ss'): MainInspectorEndpoint[] {
  const result = new Map<string, MainInspectorEndpoint>();
  let lsofPid: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    let address: string | undefined;
    if (format === 'lsof') {
      if (/^p\d+$/u.test(line)) { lsofPid = Number(line.slice(1)); }
      else if (lsofPid === pid && line.startsWith('n')) { address = line.slice(1); }
    } else if (format === 'netstat') {
      const columns = line.trim().split(/\s+/u);
      if (columns[0] === 'TCP' && columns[3] === 'LISTENING' && Number(columns[4]) === pid) { address = columns[1]; }
    } else if (line.includes(`pid=${pid},`) || line.includes(`pid=${pid})`)) {
      const columns = line.trim().split(/\s+/u);
      if (columns[0] === 'LISTEN') { address = columns[3]; }
    }
    const endpoint = address === undefined ? undefined : parseMainInspectorAddress(address);
    if (endpoint) { result.set(`${endpoint.host}:${endpoint.port}`, endpoint); }
  }
  return [...result.values()];
}

/** Queries the owning process's actual listeners instead of guessing localhost or a port range. */
export async function readMainInspectorEndpoints(pid: number): Promise<MainInspectorEndpoint[]> {
  if (!Number.isSafeInteger(pid) || pid <= 1) { throw new Error('Invalid owning main PID'); }
  if (process.platform === 'win32') {
    return parseMainInspectorListeners(await capture('netstat.exe', ['-ano', '-p', 'tcp']), pid, 'netstat');
  }
  try {
    const text = await capture(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], true);
    return parseMainInspectorListeners(text, pid, 'lsof');
  } catch (error) {
    if (process.platform === 'darwin' || (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    return parseMainInspectorListeners(await capture('ss', ['-ltnp']), pid, 'ss');
  }
}

export function mainInspectorHttpOrigin(endpoint: MainInspectorEndpoint): string {
  return `http://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

/** Rejects advertised WebSocket redirects to any other interface, port or credentialed URL. */
export function mainInspectorWebSocketMatches(value: string, endpoint: MainInspectorEndpoint): boolean {
  try {
    const url = new URL(value);
    const address = parseMainInspectorAddress(`${url.hostname}:${url.port || '80'}`);
    return url.protocol === 'ws:' && !url.username && !url.password && !!address &&
      address.host === endpoint.host && address.port === endpoint.port;
  } catch { return false; }
}
