#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

if [[ ! -f /.dockerenv && ! -f /run/.containerenv ]]; then
  echo 'Use python3 scripts/build-linux.py; this helper only runs inside its build container.' >&2
  exit 1
fi

if [[ "${1:-}" == --prepare ]]; then
  [[ "$EUID" == 0 && "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ ]]
  builder_uid="$2"
  builder_gid="$3"
  if [[ ! -f /var/lib/vortex-builder-tools-v1 && ! -f /var/lib/vortex-builder-v1 ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=3 update
    apt-get -o Acquire::Retries=3 install --yes --no-install-recommends \
      ca-certificates curl git python3 sudo xz-utils unzip build-essential pkg-config clang lld
    node_version=24.21.0
    if [[ "$(node --version 2>/dev/null || true)" != "v${node_version}" ]]; then
    node_directory="$(mktemp -d)"
    (
      cd "$node_directory"
      curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
        "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o SHASUMS256.txt
      curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
        "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" -o node.tar.xz
      python3 - "$node_version" <<'PY'
import hashlib, pathlib, sys
name = 'node-v' + sys.argv[1] + '-linux-x64.tar.xz'
matches = [line.split()[0] for line in pathlib.Path('SHASUMS256.txt').read_text().splitlines()
           if len(line.split()) == 2 and line.split()[1] == name]
actual = hashlib.sha256(pathlib.Path('node.tar.xz').read_bytes()).hexdigest()
if matches != [actual]:
    raise SystemExit('The Node.js archive does not match its published checksum')
PY
      tar -xJf node.tar.xz -C /usr/local --strip-components=1
    )
    rm -rf -- "$node_directory"
    fi
    if [[ "$(pnpm --version 2>/dev/null || true)" != 11.27.0 ]]; then
      npm install --global pnpm@11.27.0
    fi
    touch /var/lib/vortex-builder-tools-v1
  fi
  builder_user="$(python3 /work/scripts/prepare-build-user.py "$builder_uid" "$builder_gid")"
  printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$builder_user" > /etc/sudoers.d/vortex-builder
  chmod 0440 /etc/sudoers.d/vortex-builder
  printf '%s\n' "$builder_user" > /var/lib/vortex-builder-user
  touch /var/lib/vortex-builder-v1
  exit 0
fi

[[ "${1:-}" == --build && "$EUID" != 0 && "${2:-}" =~ ^[0-9]+$ ]]
cd /work
export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"
export CARGO_BUILD_JOBS="$2" CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
export RUSTUP_TOOLCHAIN=1.99.1 NODE_OPTIONS=--max-old-space-size=6144
export BUILD_CHANNEL=stable PUBLIC_RELEASE_CHANNEL=stable
export PUBLIC_BUILD_VERSION=0.1.0 BUILD_VERSION=0.1.0
export PUBLIC_BUILD_SHA="$(git rev-parse HEAD)"
export VORTEX_BUILD_TARGET="${3:-desktop}"
export FLUXER_DESKTOP_PRODUCTION=true FLUXER_OFFLINE=1 FLUXER_MODULES=0
export FLUXER_CI_BIN=/work/target/debug/fluxer-ci USE_SYSTEM_FPM=true
export FLUXER_ELECTRON_DIST=/work/.vortex-build/electron-runtime

if ! command -v rustup >/dev/null; then
  rustup_script="$(mktemp)"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 https://sh.rustup.rs -o "$rustup_script"
  sh "$rustup_script" -y --profile minimal --default-toolchain 1.99.1 --no-modify-path
  rm -f -- "$rustup_script"
fi
rustup toolchain install 1.99.1 --profile minimal --target wasm32-unknown-unknown
printf '\nBuilding with %s parallel Rust jobs. Dependencies and build outputs are cached.\n' "$CARGO_BUILD_JOBS"
pnpm install --frozen-lockfile --ignore-scripts
cargo build --locked -p fluxer-ci
dependency_hash="$(sha256sum tools/ci/src/desktop.rs | cut -d ' ' -f 1)"
if [[ ! -f "$HOME/.vortex-desktop-dependencies" || "$(cat "$HOME/.vortex-desktop-dependencies")" != "$dependency_hash" ]]; then
  tools/ci/run.sh build-desktop --step install_linux_deps
  printf '%s\n' "$dependency_hash" > "$HOME/.vortex-desktop-dependencies"
fi
python3 scripts/test-install-linux.py
pnpm --filter fluxer_desktop typecheck
cargo test --locked --manifest-path fluxer_desktop/native/app-store/Cargo.toml
if [[ "${3:-}" == web ]]; then
  pnpm --filter fluxer_app build
  pnpm --filter fluxer_app typecheck:only
  cp fluxer_app/src/vortex/vendor/PROVENANCE.json fluxer_app/dist/vortex-crypto-provenance.json
  cp fluxer_app/src/vortex/vendor/THIRD_PARTY_NOTICES.txt fluxer_app/dist/vortex-crypto-notices.txt
  tar -C fluxer_app/dist -czf .vortex-build/vortex-chat-web.tar.gz .
fi
pnpm --filter fluxer_desktop build --shared-assets
pnpm --filter fluxer_desktop build --use-shared-renderer
mkdir -p "$FLUXER_ELECTRON_DIST"
(
  cd "$FLUXER_ELECTRON_DIST"
  for name in electron-v44.9.1-linux-x64.zip electron-v44.9.1-linux-x64.fluxer.json; do
    if [[ ! -f "$name" ]]; then
      curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
        "https://github.com/fluxerapp/fluxer/releases/download/desktop-electron-runtime-44.9.1-fluxer.1/$name" -o "$name.partial"
      mv -- "$name.partial" "$name"
    fi
  done
  sha256sum --check <<'CHECKSUMS'
ae36cae3dd723d94b414302598014beb6230a0c596ac6dc7a2dc95a6198a2568  electron-v44.9.1-linux-x64.zip
7eb2c5207392dc20e3a600b4608e1a9cdcbdfd0a9ad85a0b7f414906611733e9  electron-v44.9.1-linux-x64.fluxer.json
CHECKSUMS
)
(
  cd fluxer_desktop
  pnpm exec electron-builder --linux --dir --x64 --config electron-builder.config.cjs \
    --config.extraMetadata.version=0.1.0 --publish never
)
cp fluxer_desktop/build_resources/icons-stable/256x256.png fluxer_desktop/dist-electron/linux-unpacked/vortex-chat.png
tar --dereference --hard-dereference -C fluxer_desktop/dist-electron/linux-unpacked \
  -czf .vortex-build/vortex-chat-linux-x64.tar.gz .
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
archive = Path('.vortex-build/vortex-chat-linux-x64.tar.gz')
digest = hashlib.sha256()
with archive.open('rb') as stream:
    for block in iter(lambda: stream.read(1024**2), b''):
        digest.update(block)
result = {
    'source_commit': os.environ['PUBLIC_BUILD_SHA'], 'sha256': digest.hexdigest(),
    'build_type': 'local-source', 'qualified_release': False}
if os.environ['VORTEX_BUILD_TARGET'] == 'web':
    web_digest = hashlib.sha256()
    with Path('.vortex-build/vortex-chat-web.tar.gz').open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            web_digest.update(block)
    result['web_sha256'] = web_digest.hexdigest()
Path('.vortex-build/build-result.json').write_text(json.dumps(result, indent=2) + '\n')
PY
