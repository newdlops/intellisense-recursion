#!/usr/bin/env bash
# Build the ir-indexer sidecar for every VS Code-supported platform and
# stage the results in `bin/` with <platform>-<arch> filenames.
#
# Strategy (most reliable first):
#   - macOS (arm64 + x64): native cargo on the local Rust toolchain.
#   - Linux (arm64 + x64): Docker runs a native-Linux rust image. On Apple
#     Silicon, arm64 is native; x64 requires Rosetta in Docker Desktop
#     (Settings → General → "Use Rosetta for x86_64/amd64 emulation"),
#     otherwise QEMU crashes rustc.
#   - Windows (x64 + arm64): CI only (no reliable local cross-compile
#     path from macOS for tree-sitter's C bindings). See
#     `.github/workflows/build-binaries.yml`.
#
# Prerequisites:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   Docker Desktop running (for Linux builds)

set -euo pipefail

# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/indexer"

bin_dir="$repo_root/bin"
mkdir -p "$bin_dir"

has_target() {
  rustup target list --installed | grep -q "^${1}$"
}

native_mac() {
  local triple="$1" out_name="$2"
  if ! has_target "$triple"; then
    echo "[skip] rustup target not installed: $triple"
    return 0
  fi
  echo "[native]  $triple → bin/$out_name"
  cargo build --release --target "$triple"
  cp "target/$triple/release/ir-indexer" "$bin_dir/$out_name"
  chmod +x "$bin_dir/$out_name"
}

# Linux build: docker runs a native-arch rust container. On Apple Silicon,
# linux/arm64 is fast (native); linux/amd64 needs Rosetta to avoid QEMU
# rustc segfaults.
linux_docker() {
  local platform="$1" out_name="$2"
  if ! command -v docker >/dev/null 2>&1; then
    echo "[skip] docker missing — $platform skipped"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "[skip] docker daemon not running — $platform skipped"
    return 0
  fi
  local target_dir="target-${platform//\//-}"
  echo "[docker]  $platform → bin/$out_name"
  if docker run --rm \
      --platform "$platform" \
      -v "$repo_root":/work \
      -v "/tmp/cargo-registry-${platform//\//-}:/usr/local/cargo/registry" \
      -w /work/indexer \
      rust:1.95 \
      cargo build --release --target-dir "/work/indexer/${target_dir}"; then
    cp "${target_dir}/release/ir-indexer" "$bin_dir/$out_name"
    chmod +x "$bin_dir/$out_name"
  else
    echo "[warn]   docker build failed for $platform — see output above"
    echo "         hint: enable Rosetta in Docker Desktop for linux/amd64"
    return 0
  fi
}

# ── macOS ──
native_mac aarch64-apple-darwin ir-indexer-darwin-arm64
native_mac x86_64-apple-darwin  ir-indexer-darwin-x64

# macOS universal (fat) binary — `bin/ir-indexer` fallback for unknown
# archs or when platform-specific lookup fails.
if [[ -f "$bin_dir/ir-indexer-darwin-arm64" && -f "$bin_dir/ir-indexer-darwin-x64" ]] \
   && command -v lipo >/dev/null 2>&1; then
  echo "[lipo]    → bin/ir-indexer (universal)"
  lipo -create \
    "$bin_dir/ir-indexer-darwin-arm64" \
    "$bin_dir/ir-indexer-darwin-x64" \
    -output "$bin_dir/ir-indexer"
  chmod +x "$bin_dir/ir-indexer"
fi

# ── Linux (via Docker) ──
linux_docker linux/arm64 ir-indexer-linux-arm64
linux_docker linux/amd64 ir-indexer-linux-x64

# ── Windows ──
echo "[note]    Windows binaries build reliably only in CI"
echo "          → trigger .github/workflows/build-binaries.yml"

echo
echo "── bin/ contents ──"
ls -lh "$bin_dir" 2>/dev/null || echo "(empty)"
