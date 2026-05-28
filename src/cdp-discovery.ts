// CDP / inspector discovery helpers extracted from extension.ts (Phase 15a).
//
// Scope:
//   * ProcessRow + listProcessRows() — `ps`-driven process table snapshot.
//   * isVSCodeMainProcessCommand() — Electron main vs. Code Helper.
//   * deriveUserDataDirHint() + commandHasUserDataDir() — pair globalStorage
//     path with `--user-data-dir=` so we can disambiguate concurrent VS Code
//     instances.
//   * findCurrentVSCodeMainPid() — locate THIS window's main process via
//     user-data-dir hint, parent chain, VSCODE_PID env, then single-main
//     fallback. Pure: the caller supplies the hint + test-mode flag.
//   * httpGet() / evaluateInspectorExpression() /
//     findInspectorWebSocketUrlForPid() — probe ports 9229..9249 after
//     SIGUSR1, ask each candidate inspector for process.pid, and return the
//     matching webSocketDebuggerUrl.
//
// Cross-module dependencies kept wire-in (not imported) to avoid circular
// imports back into extension.ts:
//   * Logger — set via setCdpDiscoveryLogger() before any injection could fire.
//
// Callers of these helpers (injectRenderer, reinjectRenderer,
// injectRendererViaTestRemoteDebugging) remain in extension.ts for now and
// will move out in later Phase 15 slices.

import * as path from 'node:path';
import WebSocket from 'ws';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };
let _logger: Logger | null = null;
/** Wire the logger into this module. Called from extension.activate() after
 * the OutputChannel is created. */
export function setCdpDiscoveryLogger(logger: Logger): void {
  _logger = logger;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export function listProcessRows(): ProcessRow[] {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
    return out.split(/\r?\n/)
      .map((line: string) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) { return null; }
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3],
        } satisfies ProcessRow;
      })
      .filter((row: ProcessRow | null): row is ProcessRow => !!row);
  } catch (err) {
    _logger?.warn(`[inject] process scan failed: ${err}`);
    return [];
  }
}

export function isVSCodeMainProcessCommand(command: string): boolean {
  // Match the Electron/Code executable itself, not Code Helper processes.
  return /\/Contents\/MacOS\/(?:Code|Code - Insiders|Code - OSS|Electron)(?:\s+--|$)/.test(command);
}

export function deriveUserDataDirHint(globalStorageFsPath: string): string | null {
  const marker = `${path.sep}User${path.sep}globalStorage${path.sep}`;
  const idx = globalStorageFsPath.indexOf(marker);
  return idx >= 0 ? globalStorageFsPath.slice(0, idx) : null;
}

export function commandHasUserDataDir(command: string, userDataDir: string): boolean {
  if (!command || !userDataDir) { return false; }
  return command.includes(`--user-data-dir=${userDataDir}`)
    || command.includes(`--user-data-dir ${userDataDir}`)
    || command.includes(`--user-data-dir="${userDataDir}"`)
    || command.includes(`--user-data-dir "${userDataDir}"`)
    || command.includes(`--user-data-dir='${userDataDir}'`);
}

export interface FindMainPidOptions {
  userDataDirHint: string | null;
  testMode: boolean;
}

export function findCurrentVSCodeMainPid(opts: FindMainPidOptions): number | null {
  const { userDataDirHint, testMode } = opts;
  const rows = listProcessRows();
  if (!rows.length) { return null; }
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) { byPid.set(row.pid, row); }
  const mainRows = rows.filter(row => isVSCodeMainProcessCommand(row.command));

  if (userDataDirHint) {
    const hinted = mainRows.filter(row => commandHasUserDataDir(row.command, userDataDirHint));
    if (hinted.length === 1) { return hinted[0].pid; }
    if (hinted.length > 1) {
      _logger?.warn(`[inject] multiple VS Code main processes match user-data-dir hint; skipping renderer injection (${hinted.map(row => row.pid).join(',')})`);
      return null;
    }
    if (testMode) {
      _logger?.warn(`[inject] test-mode renderer injection: no VS Code main process matched user-data-dir ${userDataDirHint}; trying extension-host parent/env PID only`);
    }
  }

  const seen = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) { break; }
    if (isVSCodeMainProcessCommand(row.command)) { return row.pid; }
    pid = row.ppid;
  }

  const envPid = Number(process.env.VSCODE_PID || '');
  if (envPid && byPid.has(envPid) && isVSCodeMainProcessCommand(byPid.get(envPid)!.command)) {
    return envPid;
  }

  if (process.env.IR_SKIP_RENDERER_INJECTION === '1') {
    _logger?.warn('[inject] test-mode renderer injection could not identify a matching VS Code main process');
    return null;
  }
  if (mainRows.length === 1) { return mainRows[0].pid; }
  if (mainRows.length > 1) {
    _logger?.warn(`[inject] multiple VS Code main processes found; skipping ambiguous renderer injection (${mainRows.map(row => row.pid).join(',')})`);
  }
  return null;
}

export function httpGet(url: string): Promise<string> {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export function evaluateInspectorExpression(wsUrl: string, expression: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = Math.floor(Math.random() * 1_000_000_000);
    let done = false;
    const finish = (err: Error | null, value?: any) => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) { reject(err); } else { resolve(value); }
    };
    const timeout = setTimeout(() => finish(new Error('inspector probe timed out')), timeoutMs);
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ id: requestId - 1, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({
          id: requestId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('message', (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id !== requestId) { return; }
        if (resp.error || resp.result?.exceptionDetails) {
          finish(new Error(resp.error?.message || resp.result?.exceptionDetails?.text || 'inspector probe failed'));
          return;
        }
        finish(null, resp.result?.result?.value);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('error', err => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function findInspectorWebSocketUrlForPid(mainPid: number): Promise<string | null> {
  const seen = new Set<string>();
  for (let port = 9229; port <= 9249; port++) {
    let targets: any[];
    try {
      targets = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
    } catch {
      continue;
    }
    for (const target of targets || []) {
      const wsUrl = String(target?.webSocketDebuggerUrl || '');
      if (!wsUrl || seen.has(wsUrl)) { continue; }
      seen.add(wsUrl);
      try {
        const pid = Number(await evaluateInspectorExpression(wsUrl, 'process.pid', 800));
        if (pid === mainPid) {
          _logger?.info(`[inject] matched inspector port ${port} for main PID ${mainPid}`);
          return wsUrl;
        }
      } catch {}
    }
  }
  _logger?.warn(`[inject] no inspector WebSocket matched main PID ${mainPid}`);
  return null;
}
