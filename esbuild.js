const esbuild = require('esbuild');
const vm = require('node:vm');

async function bundle() {
  // The renderer is a JS string: minifying the extension alone leaves its
  // comments, whitespace and inactive branches in every CDP injection. Build
  // its self-contained generator, then parse/minify the generated script too.
  const generator = esbuild.buildSync({
    entryPoints: ['./src/renderer-patch.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
  });
  const rendererModule = { exports: {} };
  vm.runInNewContext(generator.outputFiles[0].text, {
    module: rendererModule,
    require(id) {
      // preview-file-link's decoder is pure; its VS Code helpers are not run.
      if (id === 'vscode') return {};
      throw new Error(`Unexpected renderer generator dependency: ${id}`);
    },
  }, { timeout: 1000 });
  const { getHoverPatchScript, RENDERER_PATCH_VERSION } = rendererModule.exports;
  const originalScript = getHoverPatchScript();
  const rendererScript = esbuild.transformSync(originalScript, {
    loader: 'js', target: 'es2022', minify: true,
  }).code;

  await esbuild.build({
    entryPoints: ['./out/extension.js'],
    bundle: true,
    outfile: './out/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    allowOverwrite: true,
    minify: true,
    sourcemap: true,
    define: { __IR_TEST_BUILD__: process.env.IR_TEST_BUILD === '1' ? 'true' : 'false' },
    plugins: [{
      name: 'compact-renderer-script',
      setup(build) {
        build.onLoad({ filter: /[/\\]renderer-patch\.js$/ }, () => ({
          contents: `export const RENDERER_PATCH_VERSION = ${RENDERER_PATCH_VERSION};
            export function getHoverPatchScript() { return ${JSON.stringify(rendererScript)}; }`,
          loader: 'js',
        }));
      },
    }],
  });
  console.log(`Bundled with esbuild (ws included); renderer ${Buffer.byteLength(originalScript)} → ${Buffer.byteLength(rendererScript)} bytes`);
}

bundle().catch(err => { console.error(err); process.exitCode = 1; });
