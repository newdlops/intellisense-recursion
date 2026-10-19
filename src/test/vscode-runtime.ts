import * as fs from 'fs';
import * as path from 'path';
import { download } from '@vscode/test-electron';

/** Keep every test entry point on the same explicitly selectable VS Code. */
export async function testVSCodeExecutablePath(extensionDevelopmentPath: string): Promise<string> {
  const configuredPath = process.env.IR_VSCODE_EXECUTABLE_PATH?.trim();
  if (configuredPath) {
    const executablePath = path.resolve(configuredPath);
    fs.accessSync(executablePath, fs.constants.X_OK);
    return executablePath;
  }

  const downloadedPath = await download({
    version: process.env.IR_VSCODE_VERSION || 'stable',
    cachePath: path.join(extensionDevelopmentPath, '.vscode-test'),
    extensionDevelopmentPath,
  });
  // Older test-electron versions expect Electron inside macOS app bundles.
  // Recent VS Code releases name that executable Code instead.
  const candidates = process.platform === 'darwin'
    ? [downloadedPath, ...['Code', 'Code - Insiders', 'Code - OSS'].map(name => path.join(path.dirname(downloadedPath), name))]
    : [downloadedPath];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    }
  }
  throw new Error(`VS Code test executable is missing: ${downloadedPath}. Set IR_VSCODE_EXECUTABLE_PATH to use an installed copy.`);
}
