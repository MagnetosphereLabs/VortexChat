# Build and install on your Linux PC

Use this when you want to compile the client yourself or do not want to wait for a GitHub build. The builder uses your PC's processor in a cached Ubuntu 22.04 container. The installed application runs directly on your desktop. It does not require a container to run.

This builds a local development application, not a qualified release. The backend must also be a matching Vortex Node integration version. An upstream Fluxer server or an old Vortex Node does not provide this protocol.

## Updating the desktop app and existing Node together

From your checkout, run this once with your SSH connection details:

```sh
bash scripts/update-local.sh --host YOUR_VPS_IP --port YOUR_SSH_PORT --user YOUR_SSH_USERNAME
```

For subsequent updates, run the same script without arguments:

```sh
bash scripts/update-local.sh
```

It pulls the source, remembers the connection privately in the ignored `.vortex-build/connection.json`, builds and installs the desktop app, updates the existing Node backend when its revision changes, and deploys the matching web client afterward. A client build failure stops before any backend update. Completed unchanged builds are checksum-verified and reused on a retry. Compiler caches and the build container are retained. SSH connections are shared during deployment; passwords and private keys are never stored in the connection file or mounted in the builder. Authentication and sudo may still prompt when required by your system.

Use `--configure` to change the saved connection. Run the script as your normal desktop user. Your existing Node account, domain and application selection are handled by its installed updater. The source-built web client is deployed after the backend so a backend update cannot leave the older published browser bundle selected.

## 1. Install the build launcher

On Ubuntu, Pop!_OS or Linux Mint:

```sh
sudo apt update
sudo apt install git python3 podman
```

On Fedora:

```sh
sudo dnf install git python3 podman
```

On Arch or CachyOS, use an up-to-date system:

```sh
sudo pacman -S --needed git python podman
```

An already configured Docker installation also works: add `--engine docker` to the build command. The engine must work as your regular user. Do not run the builder with `sudo` or add a privileged-container option. Rootless Podman needs the normal user-namespace and subordinate UID/GID configuration supplied by your distribution.

Use an x86-64 PC with glibc 2.35 or newer. Allow about 40 GiB for the checkout, dependencies, compiler outputs and container cache; 16 GiB RAM or more is recommended. The first build downloads several toolchains and dependencies. Later builds reuse them. A powerful CPU helps compilation; download speed still matters.

## 2. Download the source and build

Run these commands in a terminal as your regular desktop user:

```sh
git clone --branch vortex/integration-20261022 --single-branch https://github.com/MagnetosphereLabs/VortexChat.git
cd VortexChat
python3 scripts/build-linux.py --install
```

The command installs the pinned Node.js, pnpm and Rust toolchains inside the builder, compiles the shared interface and native Linux integrations, verifies the patched Electron runtime, packages the application, and asks for `sudo` only when installing it on your desktop. It prints the failing command if a step fails. Fix that error and rerun the same command; compilation caches are retained.

PipeWire headers are prepared inside the build container; this does not replace your desktop's PipeWire installation. The pinned source archive is downloaded from PipeWire's GitHub mirror, with the upstream GitLab archive as a fallback. Downloads have bounded timeouts and retries, and only checksum-verified complete files enter the persistent container source cache. The libfido2 source uses the same verified cache and retry behavior. A failed download can be retried with the same update command.

The default Rust job count considers your CPU and RAM. On a PC with enough RAM, explicitly choose a larger count, for example:

```sh
python3 scripts/build-linux.py --install --jobs 16
```

The build keeps a stopped container named `vortex-chat-build-…` and files in `.vortex-build`. On SELinux systems, the checkout is labeled for container access. Use a dedicated checkout rather than mounting a home directory or unrelated files. The builder mounts only this checkout; it does not mount your desktop session, keyring or SSH agent.

## 3. Open the application

Open **Vortex Chat** from your application menu, or run:

```sh
vortex-chat
```

Choose **Add instance**, enter your Node's HTTPS domain and sign in with your Node account. Keep your desktop keyring unlocked. Never launch the app with `sudo`, `--no-sandbox` or a plaintext password-store option.

The installer supports the Ubuntu/Debian, Fedora and Arch families. COSMIC, GNOME, KDE and other desktop sessions need their working screen-capture portal and audio services. Test your actual microphone, display and shared audio using the [test guide](TESTING.md).

## Updates and build files

From the same checkout, with no local source edits:

```sh
git pull --ff-only
python3 scripts/build-linux.py --install
```

Close and reopen the app after installation. Your account data stays in its existing desktop profile. Local builds do not change the stable release feed or claim to have passed release qualification.

To build without installing, omit `--install`. The command prints the complete installation command with the source commit and archive checksum. Outputs are `.vortex-build/vortex-chat-linux-x64.tar.gz` and `.vortex-build/build-result.json`.

Add `--with-web` to also create `.vortex-build/vortex-chat-web.tar.gz`. That archive is for development and does not replace the Node installer's published, checksum-pinned client manifest. Normal Node releases install their matching web client automatically.

To install the Linux app and deploy the matching web build to an existing Node, use your normal SSH account for that server:

```sh
python3 scripts/build-linux.py --install --deploy-web root@your-node-domain --ssh-port 2222
```

Use the same SSH IP address, hostname or alias you normally connect to; the remote account needs sudo access. Replace `2222` with your SSH port. The chosen port is used for file transfer, activation and cleanup. Omit `--ssh-port` to use your existing SSH configuration. IPv4 and IPv6 addresses are supported. The command builds both clients on this PC, installs the desktop app locally, transfers the web archive over SSH, verifies its recorded checksum on the server, and switches only the Node's web-client directory. It preserves configuration ownership and permissions, accounts, encrypted storage and Vault selection. A failed service restart restores the previous configuration. SSH host-key checking remains enabled, and the build container has no access to your SSH keys.

This is a direct local testing path, independent of GitHub Actions. The server records the source commit and checksum in `vortex-local-build.json`. Open the Node domain and reload the browser after deployment. Do not clear browser storage or reinstall the Node to apply an interface fix.

A normal Node updater selects the published web client pinned by that Node revision. Until a matched release includes your source fix, update the backend first and run the local build/deploy command afterward. Subsequent local iterations use `git pull --ff-only` followed by the same command and reuse the existing compiler/dependency caches.

The local builder runs installer tests, desktop type checks and encrypted database tests. It does not itself perform the browser, packaged GUI or actual screen-sharing acceptance checks. Those have separate CI and hardware test procedures; compiling successfully does not prove every feature works.
