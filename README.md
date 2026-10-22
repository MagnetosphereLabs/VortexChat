# Vortex Chat

Vortex Chat connects Fluxer’s web and desktop interface to [Vortex Node](https://github.com/MagnetosphereLabs/VortexNode). Conversation contents and attachments are encrypted and decrypted on participants’ devices. Vortex Vault remains a separate application with its existing storage format.

**Integration branch:** `vortex/integration-20261022`. This branch is under active validation. A successful compilation is not a release qualification. Browser sign-in, conversation restore, packaged Linux startup, calls and screen sharing must pass their respective checks before a supported release is published.

## Install

The backend runs on your server. The desktop application runs on your computer. A browser connects to your Node’s HTTPS domain.

A published Vortex release contains the web archive, Linux application archive, checksums and a matching `desktop-release.json`. The Linux installer accepts an explicit release tag:

```sh
sudo python3 install-linux.py --release RELEASE_TAG
```

After the first installation, update with:

```sh
sudo /opt/vortex-chat/update --release RELEASE_TAG
```

Use the actual tag from a published Vortex release. The installer does not install an unverified development archive. Linux x86-64 requires glibc 2.35 or newer. Its dependency setup covers Ubuntu/Debian, Fedora and Arch families; hardware, portals and audio still need distribution-specific testing. It creates an application-menu entry, preserves the Chromium sandbox and uses the desktop keyring for local encryption keys.

The Node installer pins a matching web archive in `clients.lock.json`. Open the Node domain to use that client in a browser. See the [Node repository](https://github.com/MagnetosphereLabs/VortexNode) for server installation and updates.

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
