// Pre-package step: stage an already-built Rust sidecar binary under `bin/`
// with a VS Code-style `<platform>-<arch>` name when one exists.
//
// Optional helper for local builds; `vscode:prepublish` no longer requires
// a prebuilt sidecar.
//
// Behaviour:
//   1. If `bin/ir-indexer-<platform>-<arch>` already exists (e.g. placed
//      there by `scripts/build-all.sh` or a CI workflow), leave it.
//   2. Otherwise copy `indexer/target/release/ir-indexer` into place.
//   3. If no binary exists, leave packaging in on-demand sidecar mode. The
//      extension first tries to download a matching GitHub Release binary,
//      then compiles `indexer/` when cargo is available on the client machine.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const binDir = path.join(repoRoot, 'bin');
const exe = process.platform === 'win32' ? '.exe' : '';
const nativeName = `ir-indexer-${process.platform}-${process.arch}${exe}`;
const nativeDst = path.join(binDir, nativeName);
const cargoOut = path.join(repoRoot, 'indexer', 'target', 'release', `ir-indexer${exe}`);
const manifest = path.join(repoRoot, 'indexer', 'Cargo.toml');

function human(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

fs.mkdirSync(binDir, { recursive: true });

// List what's already in bin/ (after a `build-all.sh` run there may be
// several platform binaries plus a lipo'd universal one).
const existing = fs.readdirSync(binDir).filter((f) => f.startsWith('ir-indexer'));
if (existing.length > 0) {
  console.log('[prepackage] bin/ already populated — leaving as is:');
  for (const f of existing) {
    const s = fs.statSync(path.join(binDir, f));
    console.log(`  ${f}  (${human(s.size)})`);
  }
  // Ensure the current platform is represented; if not, copy it in.
  if (!fs.existsSync(nativeDst) && fs.existsSync(cargoOut)) {
    fs.copyFileSync(cargoOut, nativeDst);
    fs.chmodSync(nativeDst, 0o755);
    console.log(`[prepackage] + ${nativeName}  (copied from indexer/target/release/)`);
  }
  process.exit(0);
}

if (!fs.existsSync(cargoOut)) {
  if (fs.existsSync(manifest)) {
    console.log('[prepackage] no prebuilt sidecar found; packaging Rust source for on-demand sidecar fallback');
    process.exit(0);
  }
  console.error(`[prepackage] neither sidecar binary nor Rust source found: ${cargoOut}`);
  process.exit(1);
}

fs.copyFileSync(cargoOut, nativeDst);
fs.chmodSync(nativeDst, 0o755);
console.log(`[prepackage] ${path.relative(repoRoot, cargoOut)} → ${path.relative(repoRoot, nativeDst)}`);
