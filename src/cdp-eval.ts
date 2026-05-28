// CDP eval / request primitives extracted from extension.ts (Phase 15b).
//
// Scope:
//   * makeRendererEvalExpression() — base64-wrap a JS string so we can hand
//     a single safe expression to CDP `Runtime.evaluate` regardless of the
//     embedded code's quoting.
//   * cdpRequest() — minimal CDP request/response shim over a ws WebSocket.
//     When a request against the main renderer socket times out (and isn't
//     the noisy Input.dispatchMouseEvent), the stale-socket handler hook
//     fires so the caller can drop and reconnect.
//   * findTestRendererWebSocketUrl() — probe IR_TEST_REMOTE_DEBUGGING_PORT
//     until we find the renderer target whose document body/title contains
//     IR_TEST_WINDOW_MARKER. Used only in extension-host tests.
//   * withRendererInputCdpSessionForTests() — give a test a fresh CDP socket
//     to the test renderer (or fall back to the production main socket).
//
// Cross-module dependencies kept wire-in (not imported) to avoid circular
// imports back into extension.ts:
//   * Logger — setCdpEvalLogger().
//   * Stale-main-socket handler — setCdpEvalStaleMainSocketHandler(). Called
//     when a cdpRequest against the current main socket times out, so
//     extension.ts can close + reconnect.
//   * Env accessor — setCdpEvalEnv(). Bundles main-socket readers + test-mode
//     probe + the setter that records the discovered test renderer URL.

import WebSocket from 'ws';
import { httpGet } from './cdp-discovery';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };
let _logger: Logger | null = null;
export function setCdpEvalLogger(logger: Logger): void {
  _logger = logger;
}

type StaleMainSocketHandler = (ws: WebSocket, method: string) => void;
let _staleMainSocketHandler: StaleMainSocketHandler | null = null;
/** Wire the timeout side-effect for the main renderer socket. Called when a
 * cdpRequest against `ws` times out so the extension can decide whether to
 * drop the socket (it skips Input.dispatchMouseEvent because that's a high-
 * volume hover refire that frequently noises up the timeout path). */
export function setCdpEvalStaleMainSocketHandler(fn: StaleMainSocketHandler): void {
  _staleMainSocketHandler = fn;
}

export interface CdpEvalEnv {
  /** Snapshot of the current main renderer CDP socket. The socket may be
   * null if injection hasn't happened yet or has been torn down. */
  getMainSocket: () => { ws: WebSocket | null; isRendererTarget: boolean };
  /** True when we're in test mode and the test driver provided
   * IR_TEST_REMOTE_DEBUGGING_PORT. */
  isTestMode: () => boolean;
  /** Record the discovered test renderer URL for later cleanup paths. */
  rememberTestRendererUrl: (url: string) => void;
}
let _env: CdpEvalEnv | null = null;
export function setCdpEvalEnv(env: CdpEvalEnv): void {
  _env = env;
}

export function makeRendererEvalExpression(script: string): string {
  const patchB64 = Buffer.from(script, 'utf8').toString('base64');
  return `(function(){var bin=atob(${JSON.stringify(patchB64)});var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){bytes[i]=bin.charCodeAt(i);}return eval(new TextDecoder('utf-8').decode(bytes));})()`;
}

export function cdpRequest(ws: WebSocket, method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000);
    let done = false;
    const finish = (err: Error | null, value?: any) => {
      if (done) { return; }
      done = true;
      clearTimeout(timeout);
      try { ws.off('message', onMessage); } catch {}
      if (err) { reject(err); } else { resolve(value); }
    };
    const timeout = setTimeout(() => {
      const err = new Error(`CDP ${method} timed out`);
      finish(err);
      if (_staleMainSocketHandler) {
        try { _staleMainSocketHandler(ws, method); } catch {}
      }
    }, timeoutMs);
    const onMessage = (data: string) => {
      try {
        const resp = JSON.parse(data);
        if (resp.id !== id) { return; }
        if (resp.error) {
          finish(new Error(resp.error.message || String(resp.error)));
          return;
        }
        finish(null, resp.result);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.on('message', onMessage);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

let lastTestRendererTargetLogSignature = '';

export async function findTestRendererWebSocketUrl(): Promise<string | null> {
  const port = Number(process.env.IR_TEST_REMOTE_DEBUGGING_PORT || '');
  if (!port) { return null; }
  const marker = process.env.IR_TEST_WINDOW_MARKER || '';
  for (let attempt = 0; attempt < 40; attempt++) {
    let targets: any[] = [];
    try {
      targets = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const candidates = (targets || []).filter(target => {
      const wsUrl = String(target?.webSocketDebuggerUrl || '');
      const url = String(target?.url || '');
      return wsUrl && (/workbench/i.test(url) || /vscode-file:|vscode-app:/i.test(url));
    });
    if (!candidates.length && targets?.length) {
      candidates.push(...targets.filter(target => String(target?.webSocketDebuggerUrl || '')));
    }
    if (!marker) {
      const first = candidates[0]?.webSocketDebuggerUrl;
      if (first) { return String(first); }
    }
    const probeSummaries: string[] = [];
    for (const candidate of candidates) {
      const wsUrl = String(candidate?.webSocketDebuggerUrl || '');
      if (!wsUrl) { continue; }
      const ws = new WebSocket(wsUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
          setTimeout(() => reject(new Error('test renderer target connect timed out')), 1000);
        });
        await cdpRequest(ws, 'Runtime.enable', {}, 1000).catch(() => undefined);
        const probe = await cdpRequest(ws, 'Runtime.evaluate', {
          expression: `(function(){var m=${JSON.stringify(marker)};var b=String(document.body&&document.body.textContent||'');return {title:String(document.title||''),href:String(location&&location.href||''),bodyHasMarker:!!(m&&b.indexOf(m)>=0),titleHasMarker:!!(m&&String(document.title||'').indexOf(m)>=0),bodySample:b.replace(/\\s+/g,' ').slice(0,160)}})()`,
          returnByValue: true,
        }, 1500);
        const value = probe?.result?.value;
        probeSummaries.push([
          `title=${JSON.stringify(String(value?.title || '').slice(0, 120))}`,
          `bodyMarker=${value?.bodyHasMarker ? '1' : '0'}`,
          `titleMarker=${value?.titleHasMarker ? '1' : '0'}`,
          `targetUrl=${JSON.stringify(String(candidate?.url || value?.href || '').slice(0, 160))}`,
          `body=${JSON.stringify(String(value?.bodySample || '').slice(0, 120))}`,
        ].join(' '));
        if (value?.bodyHasMarker || value?.titleHasMarker) {
          const signature = `match:${wsUrl}:${probeSummaries[probeSummaries.length - 1] || ''}`;
          if (signature !== lastTestRendererTargetLogSignature) {
            lastTestRendererTargetLogSignature = signature;
            _logger?.info(`[cdp] test renderer target matched attempt=${attempt + 1} ${probeSummaries[probeSummaries.length - 1] || ''}`);
          }
          return wsUrl;
        }
      } catch (err) {
        probeSummaries.push(`probe-error targetUrl=${JSON.stringify(String(candidate?.url || '').slice(0, 160))} error=${JSON.stringify(String(err instanceof Error ? err.message : err).slice(0, 160))}`);
        // Try the next target.
      } finally {
        try { ws.close(); } catch {}
      }
    }
    if (probeSummaries.length) {
      const signature = `miss:${marker}:${probeSummaries.join(' | ')}`;
      if (signature !== lastTestRendererTargetLogSignature) {
        lastTestRendererTargetLogSignature = signature;
        _logger?.info(`[cdp] test renderer target scan attempt=${attempt + 1} marker=${marker ? JSON.stringify(marker) : '(none)'} ${probeSummaries.join(' | ')}`);
      }
    }
    if (candidates.length === 1 && !marker) {
      return String(candidates[0].webSocketDebuggerUrl || '') || null;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (marker) {
    _logger?.warn(`[cdp] test renderer target not found for marker ${JSON.stringify(marker)}`);
  }
  return null;
}

export async function withRendererInputCdpSessionForTests<T>(
  fn: (ws: WebSocket, mode: string) => Promise<T>,
): Promise<T> {
  if (_env?.isTestMode()) {
    try {
      const wsUrl = await findTestRendererWebSocketUrl();
      if (wsUrl) {
        _env.rememberTestRendererUrl(wsUrl);
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (err?: Error) => {
            if (done) { return; }
            done = true;
            clearTimeout(timeout);
            if (err) { reject(err); } else { resolve(); }
          };
          const timeout = setTimeout(() => finish(new Error('test renderer input CDP connect timed out')), 3000);
          ws.once('open', () => finish());
          ws.once('error', err => finish(err instanceof Error ? err : new Error(String(err))));
        });
        try {
          await cdpRequest(ws, 'Runtime.enable', {}, 1500).catch(() => undefined);
          return await fn(ws, 'fresh-test-renderer');
        } finally {
          try { ws.close(); } catch {}
        }
      }
    } catch (err) {
      _logger?.warn(`[cdp] fresh test renderer input session failed: ${err}`);
    }
  }
  const snapshot = _env?.getMainSocket();
  const mainWs = snapshot?.ws ?? null;
  if (!mainWs || mainWs.readyState !== WebSocket.OPEN) {
    throw new Error('renderer CDP socket is not open');
  }
  return fn(mainWs, snapshot?.isRendererTarget ? 'main-renderer-ref' : 'main-process-ref');
}
