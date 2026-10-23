#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Activate a locally built web client on an existing Vortex Node."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time

MAX_ARCHIVE = 512 * 1024**2
MAX_EXTRACTED = 2 * 1024**3


def extract(archive, destination):
    with tarfile.open(archive, 'r:gz') as bundle:
        entries = bundle.getmembers()
        if len(entries) > 25000 or sum(entry.size for entry in entries) > MAX_EXTRACTED:
            raise ValueError('Web archive exceeds its extraction limit')
        seen = set()
        for entry in entries:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.name:
                raise ValueError('Unsafe web archive path')
            if not entry.isdir() and not entry.isfile():
                raise ValueError('Web archives cannot contain links or special files')
            if str(path) == '.':
                if not entry.isdir():
                    raise ValueError('Invalid archive root')
                continue
            if path in seen:
                raise ValueError('Duplicate web archive entry')
            seen.add(path)
            target = destination.joinpath(*path.parts)
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(entry) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024**2)
                target.chmod(0o644)
        if not (destination / 'index.html').is_file() or not (destination / 'assets').is_dir():
            raise ValueError('Web archive is missing index.html or assets')


def snapshot(source, target, expected):
    digest, total = hashlib.sha256(), 0
    with Path(source).open('rb') as incoming, Path(target).open('xb') as outgoing:
        while block := incoming.read(1024**2):
            total += len(block)
            if total > MAX_ARCHIVE:
                raise ValueError('Web archive exceeds its download limit')
            outgoing.write(block)
            digest.update(block)
    if digest.hexdigest() != expected:
        raise ValueError('Transferred web archive does not match the PC build checksum')


def write_config(path, contents):
    metadata = path.stat()
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, metadata.st_mode & 0o777)
        os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_idle(settings):
    database = Path(settings.get('data_dir', '/var/lib/vortex-node')) / 'node.sqlite'
    if not database.exists():
        return
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        now = int(time.time())
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'shares' in tables and connection.execute("SELECT COUNT(*) FROM shares WHERE (state='uploading' AND created>?) OR (state='ready' AND expires>?) OR (state='receiving' AND deadline>?)", (now-86400, now, now)).fetchone()[0]:
            raise ValueError('A Vault delivery is active. Finish it before updating the web client.')
        if 'object_jobs' in tables and connection.execute('SELECT COUNT(*) FROM object_jobs WHERE deadline>?', (now,)).fetchone()[0]:
            raise ValueError('An encrypted save is active. Let it finish before updating.')


def activate(archive, digest, commit, config=Path('/etc/vortex-node.json'),
             root=Path('/opt/vortex-node/local-clients'), restart=None):
    if not re.fullmatch(r'[a-f0-9]{64}', digest) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('A full source commit and archive SHA-256 are required')
    original = config.read_bytes()
    settings = json.loads(original)
    check_idle(settings)
    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    root.chmod(0o755)
    destination = root / (commit + '-' + digest[:16])
    with tempfile.TemporaryDirectory(prefix='.deploy-', dir=root) as temporary:
        temporary = Path(temporary)
        copied = temporary / 'client.tar.gz'
        snapshot(archive, copied, digest)
        if not destination.exists():
            staging = temporary / 'web'
            staging.mkdir(mode=0o755)
            extract(copied, staging)
            (staging / 'vortex-local-build.json').write_text(json.dumps({
                'source_commit': commit, 'sha256': digest, 'build_type': 'local-source',
                'qualified_release': False}, indent=2) + '\n')
            for directory, _, _ in os.walk(staging):
                Path(directory).chmod(0o755)
            staging.rename(destination)
    backup = config.with_name(config.name + '.before-local-web')
    if not backup.exists():
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(original)
    settings['chat_web_dir'] = str(destination)
    restart = restart or (lambda: subprocess.run(['systemctl', 'restart', 'vortex-node.service'], check=True))
    write_config(config, (json.dumps(settings, indent=2) + '\n').encode())
    try:
        restart()
    except BaseException:
        write_config(config, original)
        restart()
        raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run this deployment helper with sudo on the Node server')
    with open('/run/vortex-node-install.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination = activate(args.archive, args.sha256, args.source_commit)
    print('Patched web client activated: ' + str(destination))
    print('Existing accounts, Chat storage and Vault configuration were preserved.')
    print('Reload your Node domain. This is a local build, not a qualified release.')


if __name__ == '__main__':
    main()
