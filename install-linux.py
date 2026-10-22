#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Install a verified Vortex Chat desktop release without disabling its sandbox."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request

REPOSITORY = 'MagnetosphereLabs/VortexChat'
RELEASES = 'https://github.com/' + REPOSITORY + '/releases/download/'
MAX_ARCHIVE = 1024**3
MAX_EXTRACTED = 4 * 1024**3
ROOT = Path('/opt/vortex-chat')


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        if url.scheme != 'https' or url.username or url.password:
            raise ValueError('The download attempted an insecure redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, destination, expected=None, maximum=MAX_ARCHIVE):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password:
        raise ValueError('Downloads require HTTPS')
    digest, size = hashlib.sha256(), 0
    request = urllib.request.Request(url, headers={'User-Agent': 'VortexChat-Installer/1'})
    with urllib.request.build_opener(HTTPSRedirect()).open(request, timeout=60) as source:
        with Path(destination).open('xb') as output:
            while chunk := source.read(1024**2):
                size += len(chunk)
                if size > maximum:
                    raise ValueError('The download exceeds its size limit')
                digest.update(chunk)
                output.write(chunk)
    if expected is not None and digest.hexdigest() != expected:
        raise ValueError('The download does not match the release checksum')


def validate_manifest(manifest, release):
    if manifest.get('protocol_version') != 1 or manifest.get('release') != release:
        raise ValueError('The release manifest is incompatible')
    client = manifest['linux_x64']
    if client['url'] != RELEASES + release + '/vortex-chat-linux-x64.tar.gz':
        raise ValueError('Unexpected Linux release URL')
    if not re.fullmatch(r'[a-f0-9]{64}', client['sha256']):
        raise ValueError('Invalid release checksum')
    return client


def extract(archive, destination):
    """Do not honor archive ownership, links, device files or privileged modes."""
    destination = Path(destination)
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 50000 or sum(member.size for member in members) > MAX_EXTRACTED:
            raise ValueError('The application exceeds its extraction limit')
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name:
                raise ValueError('Unsafe archive path')
            if not member.isdir() and not member.isfile():
                raise ValueError('Archive links and special files are forbidden')
            if str(path) == '.':
                if not member.isdir():
                    raise ValueError('Invalid archive root')
                continue
            if path in seen:
                raise ValueError('Duplicate archive path')
            seen.add(path)
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024**2)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for name in ('vortex-chat', 'chrome-sandbox'):
            executable = destination / name
            with executable.open('rb') as source:
                if source.read(4) != b'\x7fELF':
                    raise ValueError('The release is missing its native application or sandbox')
        if not (destination / 'resources' / 'app.asar').is_file():
            raise ValueError('The release is missing its application bundle')
        for directory, _, _ in os.walk(destination):
            Path(directory).chmod(0o755)


def run(*args):
    subprocess.run(args, check=True)


def dependencies():
    release = {}
    for line in Path('/etc/os-release').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            release[key] = shlex.split(value)[0] if value else ''
    family = (release.get('ID', '') + ' ' + release.get('ID_LIKE', '')).split()
    if any(name in family for name in ('debian', 'ubuntu')):
        run('apt-get', 'update', '-qq')
        def package(old, new):
            result = subprocess.run(['apt-cache', 'show', new], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return new if result.returncode == 0 else old
        run('apt-get', 'install', '--yes', '--no-install-recommends', 'ca-certificates', 'libnss3',
            package('libgtk-3-0', 'libgtk-3-0t64'), package('libasound2', 'libasound2t64'),
            'libgbm1', 'libsecret-1-0', 'libxss1', 'libpulse0', 'libpipewire-0.3-0',
            'xdg-desktop-portal', 'gnome-keyring')
    elif any(name in family for name in ('fedora', 'rhel')):
        run('dnf', 'install', '--assumeyes', 'ca-certificates', 'nss', 'gtk3', 'alsa-lib',
            'mesa-libgbm', 'libsecret', 'libXScrnSaver', 'pulseaudio-libs', 'pipewire-libs',
            'xdg-desktop-portal', 'gnome-keyring')
    elif 'arch' in family:
        # No database refresh: a partial Arch upgrade can break the user's desktop.
        run('pacman', '-S', '--needed', '--noconfirm', 'ca-certificates', 'nss', 'gtk3',
            'alsa-lib', 'mesa', 'libsecret', 'libxss', 'libpulse', 'libpipewire',
            'xdg-desktop-portal', 'gnome-keyring')
    else:
        raise ValueError('Supported desktop families are Ubuntu/Debian, Fedora and Arch')


def atomic_text(path, text, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', prefix='.vortex-', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
            temporary.chmod(mode)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def integrate(destination):
    # Ubuntu restricts unprivileged namespaces through AppArmor. Grant the
    # application its own namespace permission; never change the global policy.
    restriction = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    if restriction.exists() and restriction.read_text().strip() == '1':
        if not shutil.which('apparmor_parser'):
            raise ValueError('AppArmor tools are required to configure the application sandbox')
        profile = Path('/etc/apparmor.d/vortex-chat')
        atomic_text(profile, 'abi <abi/4.0>,\ninclude <tunables/global>\n'
                    'profile vortex-chat /opt/vortex-chat/releases/*/vortex-chat flags=(unconfined) {\n'
                    '  userns,\n}\n')
        run('apparmor_parser', '-r', str(profile))
    sandbox = destination / 'chrome-sandbox'
    os.chown(sandbox, 0, 0)
    sandbox.chmod(0o4755)
    atomic_text('/usr/local/bin/vortex-chat', '#!/bin/sh\nexec /opt/vortex-chat/current/vortex-chat "$@"\n', 0o755)
    icon = destination / 'vortex-chat.png'
    if icon.is_file():
        icon_target = Path('/usr/local/share/icons/hicolor/256x256/apps/vortex-chat.png')
        icon_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(icon, icon_target)
        icon_target.chmod(0o644)
    atomic_text('/usr/local/share/applications/vortex-chat.desktop',
                '[Desktop Entry]\nType=Application\nName=Vortex Chat\n'
                'Comment=Private conversations on your Vortex Node\nExec=vortex-chat %U\n'
                'Icon=vortex-chat\nTerminal=false\nCategories=Network;InstantMessaging;\n'
                'StartupWMClass=Vortex Chat\nMimeType=x-scheme-handler/vortexchat;\n')
    if shutil.which('update-desktop-database'):
        run('update-desktop-database', '/usr/local/share/applications')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, help='Published Vortex release tag')
    args = parser.parse_args()
    if not re.fullmatch(r'vortex-[A-Za-z0-9][A-Za-z0-9._-]{0,100}', args.release):
        parser.error('Enter a Vortex release tag')
    if os.geteuid() != 0:
        parser.error('Run this installer with sudo; the application itself runs as your normal user')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('This release supports 64-bit x86 Linux')
    libc, version = platform.libc_ver()
    if libc != 'glibc' or tuple(map(int, version.split('.')[:2])) < (2, 35):
        parser.error('This release requires glibc 2.35 or newer')
    os.umask(0o022)
    with Path('/run/vortex-chat-install.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases = ROOT / 'releases'
        releases.mkdir(parents=True, exist_ok=True)
        destination = releases / args.release
        with tempfile.TemporaryDirectory(prefix='.install-', dir=releases) as temporary:
            work = Path(temporary)
            manifest_path = work / 'desktop-release.json'
            print('Downloading the release manifest…', flush=True)
            download(RELEASES + args.release + '/desktop-release.json', manifest_path, maximum=65536)
            manifest = json.loads(manifest_path.read_text())
            client = validate_manifest(manifest, args.release)
            if destination.exists():
                installed = json.loads((destination / 'vortex-release.json').read_text())
                if installed != manifest:
                    raise ValueError('A different application already occupies this immutable release')
            else:
                print('Downloading and verifying Vortex Chat…', flush=True)
                archive = work / 'desktop.tar.gz'
                download(client['url'], archive, client['sha256'])
                staging = work / 'application'
                staging.mkdir()
                extract(archive, staging)
                (staging / 'vortex-release.json').write_text(json.dumps(manifest, sort_keys=True))
                print('Preparing desktop dependencies…', flush=True)
                dependencies()
                staging.rename(destination)
            integrate(destination)
            if Path(__file__).is_file():
                atomic_text(ROOT / 'update', Path(__file__).read_text(), 0o755)
            current = ROOT / 'current'
            if current.exists() and not current.is_symlink():
                raise ValueError('An unmanaged directory occupies the application link')
            temporary_link = work / 'current'
            temporary_link.symlink_to(destination)
            os.replace(temporary_link, current)
    print('Vortex Chat is installed. Open it from your application menu. Close and reopen it after updating.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit('Installation stopped: ' + str(error)) from error
