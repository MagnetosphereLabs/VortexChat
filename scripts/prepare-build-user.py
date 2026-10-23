#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Select a container account matching the desktop user's numeric identity."""
import grp
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys


def prepare(uid, gid, cache_root=Path('/var/cache/vortex-chat-build')):
    if uid <= 0 or gid < 0:
        raise ValueError('The builder requires a non-root desktop UID')
    try:
        grp.getgrgid(gid)
    except KeyError:
        subprocess.run(['groupadd', '--gid', str(gid), 'vortex-build-' + str(gid)], check=True, stdout=sys.stderr)
    try:
        account = pwd.getpwuid(uid)
    except KeyError:
        for name in ('builder', 'vortex-builder-' + str(uid)):
            try:
                pwd.getpwnam(name)
            except KeyError:
                break
        else:
            raise ValueError('No free name is available for the container build account')
        subprocess.run(['useradd', '--uid', str(uid), '--gid', str(gid), '--create-home',
                        '--shell', '/bin/bash', name], check=True, stdout=sys.stderr)
        account = pwd.getpwuid(uid)
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*\$?', account.pw_name):
        raise ValueError('The existing build account has an unsupported name')
    directory = Path(account.pw_dir)
    # Rootless Podman can inject the host UID with /work as its home. Do not
    # change that passwd entry or the mounted checkout's ownership.
    if (not directory.is_absolute() or directory == Path('/')
            or directory.resolve().is_relative_to('/root')
            or directory.resolve().is_relative_to('/work')):
        directory = cache_root / str(uid)
    directory.mkdir(parents=True, exist_ok=True)
    os.chown(directory, uid, gid)
    return {'user': account.pw_name, 'uid': uid, 'gid': gid, 'home': str(directory)}


if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise SystemExit('Run inside the build container as root with UID and GID')
    print(json.dumps(prepare(int(sys.argv[1]), int(sys.argv[2]))))
