#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Update the local Linux application and an existing Vortex Node together."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('vortex_builder', ROOT / 'scripts/build-linux.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def save_connection(path, connection):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.connection-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(connection, output, indent=2)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def connection_settings(args, path):
    saved = json.loads(path.read_text()) if path.exists() else {}
    def choose(field, default, label):
        explicit = getattr(args, field)
        if explicit is not None:
            return explicit
        value = saved.get(field, default)
        if args.configure or field not in saved:
            value = input(label + (' [' + str(value) + ']' if value else '') + ': ').strip() or value
        return value
    connection = {'host': choose('host', '', 'VPS IP address or hostname'),
                  'port': int(choose('port', 22, 'SSH port')),
                  'user': choose('user', 'root', 'SSH username')}
    builder.ssh_transport(connection['user'] + '@' + connection['host'], connection['port'])
    save_connection(path, connection)
    return connection


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            result.update(block)
    return result.hexdigest()


def build_clients(args, output):
    source = builder.run('git', 'rev-parse', 'HEAD', cwd=ROOT, capture_output=True, text=True).stdout.strip()
    clean = subprocess.run(['git', 'diff', '--quiet', 'HEAD'], cwd=ROOT, check=False).returncode == 0
    result_path = output / 'build-result.json'
    if clean and result_path.exists():
        result = json.loads(result_path.read_text())
        desktop, web = output / 'vortex-chat-linux-x64.tar.gz', output / 'vortex-chat-web.tar.gz'
        if (result.get('source_commit') == source and desktop.exists() and web.exists()
                and result.get('sha256') == digest(desktop) and result.get('web_sha256') == digest(web)):
            print('Reusing the completed build of this source revision.', flush=True)
            builder.run('sudo', 'python3', ROOT / 'install-linux.py', '--local-archive', desktop,
                        '--sha256', result['sha256'], '--source-commit', source)
            return result
    command = [sys.executable, str(ROOT / 'scripts/build-linux.py'), '--install', '--with-web']
    if args.engine:
        command.extend(['--engine', args.engine])
    if args.jobs:
        command.extend(['--jobs', str(args.jobs)])
    builder.run(*command, cwd=ROOT)
    return json.loads(result_path.read_text())


def update(args, connection, output):
    # Finish the client build before changing the running server.
    result = build_clients(args, output)
    selected = builder.run('git', 'ls-remote', 'https://github.com/MagnetosphereLabs/VortexNode.git',
                           'refs/heads/vortex/preview', capture_output=True, text=True).stdout.split()
    if len(selected) != 2 or not re.fullmatch(r'[a-f0-9]{40}', selected[0]):
        raise ValueError('Could not determine the current Vortex Node preview revision')
    target = connection['user'] + '@' + connection['host']
    with tempfile.TemporaryDirectory(prefix='vortex-ssh-') as temporary:
        options = ['ControlMaster=auto', 'ControlPersist=300', 'ControlPath=' + temporary + '/connection']
        try:
            builder.deploy_web(output, result, target, connection['port'],
                               node_revision=selected[0], ssh_options=options)
        finally:
            ssh, _, normalized, _ = builder.ssh_transport(target, connection['port'], options)
            subprocess.run([*ssh, '-O', 'exit', normalized], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('\nLinux app and existing Node website updated. Reopen Vortex Chat and reload the website.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', help='VPS IP, hostname or SSH alias; remembered for future updates')
    parser.add_argument('--port', type=int, help='SSH port; remembered for future updates')
    parser.add_argument('--user', help='SSH username; remembered for future updates')
    parser.add_argument('--configure', action='store_true', help='Change the saved connection')
    parser.add_argument('--engine', choices=('podman', 'docker'))
    parser.add_argument('--jobs', type=int)
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error('Run as your normal desktop user; installation will request sudo when needed')
    output = ROOT / '.vortex-build'
    output.mkdir(exist_ok=True)
    with (output / 'update.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        connection = connection_settings(args, output / 'connection.json')
        update(args, connection, output)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        raise SystemExit('Update stopped: ' + str(error) + '\nYour connection and build caches are retained. Rerun the same update command.') from error
