import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import { runTests } from '@vscode/test-electron';

function discoverInstalledExtensionIds(extensionsDir: string): string[] {
  if (!fs.existsSync(extensionsDir)) { return []; }
  const ids = new Set<string>();
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) { continue; }
    const packagePath = path.join(extensionsDir, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : '';
      const name = typeof manifest.name === 'string' ? manifest.name : '';
      if (publisher && name) {
        ids.add(`${publisher}.${name}`.toLowerCase());
      }
    } catch {
      // Ignore malformed or partial extension installs.
    }
  }
  return Array.from(ids).sort();
}

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    const fixture = process.env.TEST_FIXTURE || 'python';
    const testWorkspace = path.resolve(extensionDevelopmentPath, `src/test/fixtures/${fixture}`);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-vsc-'));
    const settingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      // Geometry tests read native DOM tokens. Set this before the first
      // editor is created, rather than switching its input renderer mid-test.
      'editor.editContext': false,
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
    }));
    const testWindowMarker = `IR_E2E_WINDOW_${process.pid}`;
    const productionInjection = process.env.IR_TEST_PRODUCTION_INJECTION === '1';
    let inspectorPort = 0;
    if (productionInjection) {
      // The normal injection path discovers a PID-matched main inspector.
      // Never compete with a running user's VS Code for the default 9229.
      for (let candidate = 9230; candidate <= 9249; candidate++) {
        const available = await new Promise<boolean>(resolve => {
          // A local port manager may redirect bind() to another loopback
          // address. Probe the exact address Electron's inspector will use.
          const probe = net.createConnection({ host: '127.0.0.1', port: candidate });
          const finish = (free: boolean) => { probe.destroy(); resolve(free); };
          probe.once('connect', () => finish(false));
          probe.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED'));
          probe.setTimeout(300, () => finish(false));
        });
        if (available) { inspectorPort = candidate; break; }
      }
      if (!inspectorPort) { throw new Error('No isolated main inspector port available for startup verification'); }
    }
    // A PID-derived port can belong to another editor/test process. Ask the
    // OS for an available loopback port before starting this isolated host.
    const remoteDebuggingPort = await new Promise<string>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(err => err ? reject(err) : resolve(String(port)));
      });
    });

    // Use the user's installed extensions (Pylance, TS server, etc.)
    const userExtensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
    const extensionAllowlist = new Set([
      'newdlops.intellisense-recursion',
      'ms-python.python',
      'ms-python.vscode-pylance',
      'ms-python.debugpy',
      'ms-python.vscode-python-envs',
    ]);
    const disabledUiExtensions = discoverInstalledExtensionIds(userExtensionsDir)
      .filter(id => !extensionAllowlist.has(id));
    const disabledBuiltinUiExtensions = [
      'github.copilot-chat',
      'typescriptteam.jsts-chat-features',
    ];

    console.log(`Running E2E tests with fixture: ${fixture}`);
    console.log(`  workspace: ${testWorkspace}`);
    console.log(`  extensions: ${userExtensionsDir}`);
    console.log(`  disabled user extensions: ${disabledUiExtensions.join(', ') || '(none)'}`);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        IR_SKIP_RENDERER_INJECTION: productionInjection ? '0' : '1',
        IR_TEST_PRODUCTION_INJECTION: productionInjection ? '1' : '0',
        IR_TEST_USER_DATA_DIR: userDataDir,
        IR_TEST_WINDOW_MARKER: testWindowMarker,
        IR_TEST_REMOTE_DEBUGGING_PORT: remoteDebuggingPort,
        IR_E2E_FILES: process.env.IR_E2E_FILES || '',
        IR_E2E_GREP: process.env.IR_E2E_GREP || '',
      },
      launchArgs: [
        `--extensions-dir=${userExtensionsDir}`,
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${remoteDebuggingPort}`,
        // SIGUSR1 on a test host must not take the real editor's default port.
        productionInjection ? `--inspect=${inspectorPort}` : '--inspect-port=0',
        '--disable-features=EditContext',
        '--disable-renderer-backgrounding',
        ...disabledBuiltinUiExtensions.map(id => `--disable-extension=${id}`),
        ...disabledUiExtensions.map(id => `--disable-extension=${id}`),
        testWorkspace,
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
