import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 300000, // 5 minutes per test (stress tests are slow)
  });

  const testsRoot = path.resolve(__dirname, '.');
  const files = await glob('**/*.test.js', { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} perf test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
