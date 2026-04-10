import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    const fixture = process.env.TEST_FIXTURE || 'python';
    const testWorkspace = path.resolve(extensionDevelopmentPath, `src/test/fixtures/${fixture}`);

    // Use the user's installed extensions (Pylance, TS server, etc.)
    const userExtensionsDir = path.join(os.homedir(), '.vscode', 'extensions');

    console.log(`Running E2E tests with fixture: ${fixture}`);
    console.log(`  workspace: ${testWorkspace}`);
    console.log(`  extensions: ${userExtensionsDir}`);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspace,
        `--extensions-dir=${userExtensionsDir}`,
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
