#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build Vortex Chat on this PC in a reusable Ubuntu 22.04 container."""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
LABEL = 'org.magnetospherelabs.vortex.build-directory'


def run(*args, **kwargs):
    print('+ ' + shlex.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def default_jobs():
    memory = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    return max(1, min(os.cpu_count() or 2, memory // (2 * 1024**3)))


def ssh_transport(target, port=None, ssh_options=()):
    if port is not None and (not isinstance(port, int) or not 1 <= port <= 65535):
        raise ValueError('SSH port must be between 1 and 65535')
    if '@' in target:
        user, host = target.rsplit('@', 1)
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', user):
            raise ValueError('Enter a valid SSH username')
        prefix = user + '@'
    else:
        host, prefix = target, ''
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    if ':' in host:
        ipaddress.IPv6Address(host)
        copy_host = '[' + host + ']'
    elif re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', host):
        copy_host = host
    else:
        raise ValueError('Enter a valid VPS IP address, hostname or SSH alias')
    ssh = ['ssh'] + (['-p', str(port)] if port is not None else [])
    scp = ['scp'] + (['-P', str(port)] if port is not None else [])
    for option in ssh_options:
        ssh.extend(['-o', option])
        scp.extend(['-o', option])
    return ssh, scp, prefix + host, prefix + copy_host


def deploy_web(output, result, target, port=None, node_revision=None, ssh_options=()):
    ssh, scp, ssh_target, copy_target = ssh_transport(target, port, ssh_options)
    if node_revision is not None and not re.fullmatch(r'[a-f0-9]{40}', node_revision):
        raise ValueError('A full Node revision is required')
    web = output / 'vortex-chat-web.tar.gz'
    checksum = hashlib.sha256()
    with web.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            checksum.update(block)
    digest = checksum.hexdigest()
    if result.get('web_sha256') != digest:
        raise ValueError('Web archive differs from its recorded build checksum')
    remote = run(*ssh, ssh_target, 'mktemp -d /tmp/vortex-web.XXXXXXXX', capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r'/tmp/vortex-web\.[A-Za-z0-9]{8}', remote):
        raise ValueError('The server returned an unexpected temporary path')
    try:
        run(*scp, str(web), str(ROOT / 'scripts/deploy-local-web.py'), copy_target + ':' + remote + '/')
        command = shlex.join(['sudo', 'python3', remote + '/deploy-local-web.py',
            '--archive', remote + '/vortex-chat-web.tar.gz', '--sha256', digest,
            '--source-commit', result['source_commit']])
        if node_revision:
            repository = 'https://github.com/MagnetosphereLabs/VortexNode.git'
            source = remote + '/node-source'
            installer = remote + '/node-install.sh'
            # An installed updater cannot learn new build dependencies until it
            # succeeds. Bootstrap the selected revision's installer without sudo.
            prepare = [
                shlex.join(['git', 'init', '--quiet', source]),
                shlex.join(['git', '-C', source, '-c', 'protocol.file.allow=never',
                            'fetch', '--depth', '1', '--quiet', repository, node_revision]),
                '[ "$(' + shlex.join(['git', '-C', source, 'rev-parse', 'FETCH_HEAD'])
                    + ')" = ' + node_revision + ' ] || { echo "Node installer revision mismatch" >&2; exit 1; }',
                shlex.join(['git', '-C', source, 'show', node_revision + ':install.sh'])
                    + ' > ' + shlex.quote(installer),
                shlex.join(['sudo', 'bash', installer, 'update', '--repo', repository,
                            '--ref', 'vortex/preview']),
            ]
            command = ('set -e\n'
                'test -x /opt/vortex-node/install.sh || { echo "Existing Vortex Node installer was not found" >&2; exit 1; }\n'
                'vortex_installed_ref=$(basename "$(readlink -f /opt/vortex-node/current)")\n'
                'if [ "$vortex_installed_ref" != ' + shlex.quote(node_revision) + ' ]; then\n'
                + '\n'.join('  ' + step for step in prepare) + '\n'
                'else\n  echo "Vortex Node backend is already current"\nfi\n' + command)
        run(*ssh, '-tt', ssh_target, command)
    finally:
        subprocess.run([*ssh, ssh_target, 'rm -rf -- ' + shlex.quote(remote)], check=False)


def container_build_command(engine, container, identity, jobs, with_web):
    user, home = identity['user'], identity['home']
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*\$?', user) or not Path(home).is_absolute():
        raise ValueError('The build container returned an invalid account')
    # These login environment values apply only to the container build process.
    return [engine, 'exec', '--user', str(identity['uid']) + ':' + str(identity['gid']),
            '--env', 'HOME=' + home, '--env', 'USER=' + user, '--env', 'LOGNAME=' + user,
            container, 'bash', '/work/scripts/build-linux-container.sh', '--build', str(jobs),
            'web' if with_web else 'desktop']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', help='Install the completed local build on this computer')
    parser.add_argument('--engine', choices=('podman', 'docker'), help='Use an already configured container engine')
    parser.add_argument('--jobs', type=int, default=default_jobs(), help='Parallel Rust jobs (default: CPU/RAM based)')
    parser.add_argument('--with-web', action='store_true', help='Also produce a separate web client archive')
    parser.add_argument('--deploy-web', metavar='USER@VPS', help='Also build and activate the web client on your existing Node over SSH')
    parser.add_argument('--ssh-port', type=int, metavar='PORT', help='SSH/SCP port for --deploy-web (otherwise use SSH configuration)')
    args = parser.parse_args()
    if args.deploy_web:
        try:
            ssh_transport(args.deploy_web, args.ssh_port)
        except ValueError as error:
            parser.error(str(error))
        args.with_web = True
    elif args.ssh_port is not None:
        parser.error('--ssh-port requires --deploy-web')
    if os.geteuid() == 0:
        parser.error('Run as your normal desktop user. Only the final installation uses sudo.')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('This builder supports x86-64 Linux')
    if not 1 <= args.jobs <= 512:
        parser.error('--jobs must be between 1 and 512')
    engine = args.engine or next((name for name in ('podman', 'docker') if shutil.which(name)), None)
    if not engine or not shutil.which(engine):
        parser.error('Install Podman first; see docs/vortex/BUILD_LINUX.md. Existing Docker installations also work.')
    if ':' in str(ROOT) or '\n' in str(ROOT):
        parser.error('The checkout path cannot contain a colon or newline')
    if shutil.disk_usage(ROOT).free < 10 * 1024**3:
        parser.error('At least 10 GiB must be free to continue; allow 40 GiB for a first build and its caches.')
    run(engine, 'info', stdout=subprocess.DEVNULL)
    output = ROOT / '.vortex-build'
    output.mkdir(exist_ok=True)
    container = 'vortex-chat-build-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    with (output / 'build.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        inspection = subprocess.run([engine, 'container', 'inspect', container], capture_output=True, text=True)
        if inspection.returncode == 0:
            state = json.loads(inspection.stdout)[0]
            if (state.get('Config', {}).get('Labels') or {}).get(LABEL) != str(ROOT):
                raise ValueError('An unrelated container occupies the build name; it was not changed')
            run(engine, 'start', container)
        else:
            options = ['--userns=keep-id'] if engine == 'podman' else []
            run(engine, 'run', '--detach', '--name', container, '--user', '0',
                '--label', LABEL + '=' + str(ROOT), '--volume', str(ROOT) + ':/work:Z',
                '--workdir', '/work', *options, 'docker.io/library/ubuntu:22.04', 'sleep', 'infinity')
        try:
            run(engine, 'exec', '--user', '0', container, 'bash', '/work/scripts/build-linux-container.sh',
                '--prepare', os.getuid(), os.getgid())
            identity = json.loads(run(engine, 'exec', '--user', '0', container, 'cat',
                                 '/var/lib/vortex-builder.json', capture_output=True, text=True).stdout)
            if identity['uid'] != os.getuid() or identity['gid'] != os.getgid():
                raise ValueError('The container build account does not match this desktop user')
            (output / 'build-result.json').unlink(missing_ok=True)
            run(*container_build_command(engine, container, identity, args.jobs, args.with_web))
        finally:
            subprocess.run([engine, 'stop', '--time', '10', container], check=False)
        result = json.loads((output / 'build-result.json').read_text())
        archive = output / 'vortex-chat-linux-x64.tar.gz'
        digest = hashlib.sha256()
        with archive.open('rb') as stream:
            for block in iter(lambda: stream.read(1024**2), b''):
                digest.update(block)
        if result['sha256'] != digest.hexdigest():
            raise ValueError('The build archive does not match its recorded checksum')
        install = ['sudo', 'python3', str(ROOT / 'install-linux.py'), '--local-archive', str(archive),
                   '--sha256', result['sha256'], '--source-commit', result['source_commit']]
        print('\nLocal build complete: ' + str(archive), flush=True)
        print('Source: ' + result['source_commit'] + ' (local build; not a qualified release)', flush=True)
        if args.install:
            run(*install)
        else:
            print('Install it with:\n' + shlex.join(install), flush=True)
        if args.deploy_web:
            deploy_web(output, result, args.deploy_web, args.ssh_port)
        print('Rerun the same build command to update. The stopped builder and compilation caches are retained.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        raise SystemExit('Build stopped: ' + str(error) + '\nFix the reported step and rerun the same command; caches are retained.') from error
