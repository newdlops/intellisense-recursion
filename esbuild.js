const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['./out/extension.js'],
  bundle: true,
  outfile: './out/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  allowOverwrite: true,
  minify: false,
  sourcemap: true,
});

console.log('Bundled with esbuild (ws included)');
