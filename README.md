# Vortex Chat

Vortex Chat connects Fluxer’s web and desktop interface to [Vortex Node](https://github.com/MagnetosphereLabs/VortexNode). Conversation contents and attachments are encrypted and decrypted on participants’ devices. Vortex Vault remains a separate application with its existing storage format.

**Candidate:** [0.1.0-rc.1](https://github.com/MagnetosphereLabs/VortexChat/releases/tag/vortex-v0.1.0-rc.1). The tested application source is `261a9ecb4ece935be04ecf6f4d37c2b80d94d971` on `vortex/integration-20261022`. Automated browser, packaged Linux and encrypted-media checks passed for the matched build. This is ready for hands-on testing; full Fluxer feature parity, actual hardware capture testing and independent security review remain work.

## Install

The backend runs on your server. The desktop application runs on your computer. A browser connects to your Node’s HTTPS domain.

On your Linux x86-64 desktop, run:

```sh
(set -e; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/MagnetosphereLabs/VortexChat/261a9ecb4ece935be04ecf6f4d37c2b80d94d971/install-linux.py' -o "$f"; sudo python3 "$f" --release vortex-v0.1.0-rc.1)
```

Then open **Vortex Chat**, choose **Add instance**, enter your Node's HTTPS domain and sign in. The [matched Node installer](https://github.com/MagnetosphereLabs/VortexNode/tree/vortex/preview) runs on your Ubuntu server and installs the browser client automatically. For an existing Node, use that candidate installation command once to switch from the older alpha; subsequent manual updates remember the preview reference.

After the first installation, update with:

```sh
sudo /opt/vortex-chat/update --release RELEASE_TAG
```

Use the actual tag from a published Vortex release, such as `vortex-v0.1.0-rc.1`. Release downloads are checksum-verified. The separate local-build mode requires an explicit archive, source commit and checksum and does not claim release qualification. Linux x86-64 requires glibc 2.35 or newer. Its dependency setup covers Ubuntu/Debian, Fedora and Arch families; hardware, portals and audio still need distribution-specific testing. It creates an application-menu entry, preserves the Chromium sandbox and uses the desktop keyring for local encryption keys.

The Node installer pins a matching web archive in `clients.lock.json`. Open the Node domain to use that client in a browser. See the [Node repository](https://github.com/MagnetosphereLabs/VortexNode) for server installation and updates.

To compile on your own Linux PC, follow the [local build guide](docs/vortex/BUILD_LINUX.md). After installing Git, Python and Podman, the build-and-install command from this checkout is:

```sh
python3 scripts/build-linux.py --install
```

It keeps the compiler toolchains and dependencies in a reusable build container, then installs the application with its desktop launcher and sandbox. See [trying Vortex Chat](docs/vortex/TESTING.md) for first connection, two-account testing and screen sharing.

## Development

The shared web/desktop adapter is in `fluxer_app/src/vortex`. It translates Fluxer view models into encrypted Node operations locally. The server does not implement a plaintext Discord-compatible message API.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter fluxer_app build
pnpm --filter fluxer_app typecheck:only
VORTEX_NODE_BINARY=/absolute/path/to/vortex-node pnpm --filter fluxer_app vortex:test
```

Use the exact Node and toolchain versions pinned in `.github/workflows/vortex-client.yml` and `vortex-linux.yml`. Those workflows build the browser client and Linux application, exercise Node integration, and retain diagnostics for failed UI checks. Do not install upstream Fluxer artifacts expecting them to speak the Vortex encryption protocol.

## Scope and verification

See [security design](docs/vortex/SECURITY.md) for the trust boundaries, and [platform work](docs/vortex/PLATFORMS.md) for Windows, macOS, Android and iOS.

Subscription checks are removed from the Vortex user entitlement projection. Storage and upload limits still follow the Node owner’s policy. A free entitlement does not imply that every upstream backend feature has been implemented.

Federation is outside this integration. Accounts, authorization, storage and media routing currently belong to one Node.

## License and attribution

This fork retains Fluxer’s [AGPL-3.0-or-later license](LICENSE) and source copyright notices. Vortex protocol files retain their original license notices. Bundled Fluxer artwork retains its [CC BY-SA 4.0 license](fluxer_static/LICENSE) and [third-party notices](fluxer_static/THIRD_PARTY_LICENSES.md). Crypto build provenance and notices are included with web release archives.

The original upstream project information is preserved in [UPSTREAM_README.md](docs/vortex/UPSTREAM_README.md). Upstream download links install Fluxer, not Vortex Chat.
