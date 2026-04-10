import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testWorkspace = path.resolve(extensionDevelopmentPath, 'perf-fixtures');
    const userExtensionsDir = path.join(os.homedir(), '.vscode', 'extensions');

    console.log('Running PERFORMANCE STRESS tests');
    console.log(`  workspace: ${testWorkspace} (100K files)`);
    console.log(`  extensions: ${userExtensionsDir}`);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspace,
        `--extensions-dir=${userExtensionsDir}`,
        '--disable-extension=github.copilot',
        '--disable-extension=github.copilot-chat',
      ],
    });
  } catch (err) {
    console.error('Failed to run perf tests:', err);
    process.exit(1);
  }
}

main();
