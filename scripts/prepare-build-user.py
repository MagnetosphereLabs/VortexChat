#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Select a container account matching the desktop user's numeric identity."""
import grp
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys


def prepare(uid, gid):
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
    if account.pw_gid != gid:
        subprocess.run(['usermod', '--gid', str(gid), account.pw_name], check=True, stdout=sys.stderr)
    directory = Path(account.pw_dir)
    if not directory.is_absolute() or directory in (Path('/'), Path('/root'), Path('/work')):
        raise ValueError('The build account must have its own absolute home directory')
    directory.mkdir(parents=True, exist_ok=True)
    os.chown(directory, uid, gid)
    return account.pw_name


if __name__ == '__main__':
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise SystemExit('Run inside the build container as root with UID and GID')
    print(prepare(int(sys.argv[1]), int(sys.argv[2])))
