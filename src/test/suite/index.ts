import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60000,
  });

  const testsRoot = path.resolve(__dirname, '.');
  const requestedFiles = (process.env.IR_E2E_FILES || '')
    .split(',')
    .map(file => file.trim())
    .filter(Boolean);
  const files = requestedFiles.length
    ? requestedFiles
    : await glob('**/*.test.js', { cwd: testsRoot });

  if (process.env.IR_E2E_GREP) {
    mocha.grep(new RegExp(process.env.IR_E2E_GREP));
  }

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
