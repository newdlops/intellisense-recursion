import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
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
    const testWindowMarker = `IR_E2E_WINDOW_${process.pid}`;
    const remoteDebuggingPort = String(39000 + (process.pid % 10000));

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
        IR_SKIP_RENDERER_INJECTION: '1',
        IR_TEST_USER_DATA_DIR: userDataDir,
        IR_TEST_WINDOW_MARKER: testWindowMarker,
        IR_TEST_REMOTE_DEBUGGING_PORT: remoteDebuggingPort,
        IR_E2E_FILES: process.env.IR_E2E_FILES || '',
        IR_E2E_GREP: process.env.IR_E2E_GREP || '',
      },
      launchArgs: [
        testWorkspace,
        `--extensions-dir=${userExtensionsDir}`,
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${remoteDebuggingPort}`,
        '--disable-features=EditContext',
        ...disabledBuiltinUiExtensions.map(id => `--disable-extension=${id}`),
        ...disabledUiExtensions.map(id => `--disable-extension=${id}`),
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
