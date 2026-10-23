import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-linux.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SSHTransportTests(unittest.TestCase):
    def test_rootless_build_uses_numeric_identity_and_dedicated_home(self):
        identity = {'user': 'desktop', 'uid': 1000, 'gid': 1000, 'home': '/var/cache/vortex-chat-build/1000'}
        command = builder.container_build_command('podman', 'cached-builder', identity, 16, True)
        self.assertEqual(command[:4], ['podman', 'exec', '--user', '1000:1000'])
        self.assertIn('HOME=/var/cache/vortex-chat-build/1000', command)
        self.assertNotIn('su', command)
        self.assertEqual(command[-3:], ['--build', '16', 'web'])

    def test_backend_update_and_web_activation_share_connection_and_port(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'vortex-chat-web.tar.gz').write_bytes(b'web')
            result = {'web_sha256': hashlib.sha256(b'web').hexdigest(), 'source_commit': 'b' * 40}
            options = ['ControlMaster=auto', 'ControlPath=/tmp/private-connection']
            with patch.object(builder, 'run', return_value=subprocess.CompletedProcess([], 0, '/tmp/vortex-web.12345678\n')) as run, patch.object(builder.subprocess, 'run'):
                builder.deploy_web(output, result, 'admin@192.0.2.10', 7142, node_revision='a' * 40, ssh_options=options)
            transfer, activate = run.call_args_list[1].args, run.call_args_list[2].args
            self.assertEqual(transfer[:3], ('scp', '-P', '7142'))
            self.assertIn('ControlPath=/tmp/private-connection', transfer)
            self.assertEqual(activate[:3], ('ssh', '-p', '7142'))
            self.assertIn('ControlPath=/tmp/private-connection', activate)
            command = activate[-1]
            self.assertIn('"$vortex_installed_ref" != ' + 'a' * 40, command)
            self.assertIn('fetch --depth 1 --quiet https://github.com/MagnetosphereLabs/VortexNode.git ' + 'a' * 40, command)
            self.assertIn('show ' + 'a' * 40 + ':install.sh', command)
            self.assertNotIn('sudo /opt/vortex-node/install.sh', command)
            self.assertLess(command.index('node-install.sh update'), command.index('sudo python3'))

    def test_custom_port_reaches_transfer_activation_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            web = output / 'vortex-chat-web.tar.gz'
            web.write_bytes(b'local web archive')
            result = {'web_sha256': hashlib.sha256(web.read_bytes()).hexdigest(), 'source_commit': 'a' * 40}
            with patch.object(builder, 'run', return_value=subprocess.CompletedProcess([], 0, '/tmp/vortex-web.12345678\n')) as run, patch.object(builder.subprocess, 'run') as cleanup:
                builder.deploy_web(output, result, 'admin@192.0.2.10', 2222)
            calls = [call.args for call in run.call_args_list]
            self.assertEqual(calls[0][:4], ('ssh', '-p', '2222', 'admin@192.0.2.10'))
            self.assertEqual(calls[1][:3], ('scp', '-P', '2222'))
            self.assertEqual(calls[1][-1], 'admin@192.0.2.10:/tmp/vortex-web.12345678/')
            self.assertEqual(calls[2][:5], ('ssh', '-p', '2222', '-tt', 'admin@192.0.2.10'))
            self.assertEqual(cleanup.call_args.args[0][:4], ['ssh', '-p', '2222', 'admin@192.0.2.10'])

    def test_omitting_port_preserves_ssh_configuration(self):
        ssh, scp, target, copy = builder.ssh_transport('my-node')
        self.assertEqual((ssh, scp, target, copy), (['ssh'], ['scp'], 'my-node', 'my-node'))

    def test_ipv6_copy_destination_is_bracketed(self):
        for host in ('2001:db8::10', '[2001:db8::10]'):
            _, _, target, copy = builder.ssh_transport('admin@' + host, 2200)
            self.assertEqual(target, 'admin@2001:db8::10')
            self.assertEqual(copy, 'admin@[2001:db8::10]')

    def test_invalid_ports_and_shell_options_are_rejected(self):
        for port in (0, -1, 65536, '2222'):
            with self.subTest(port=port), self.assertRaises(ValueError):
                builder.ssh_transport('admin@192.0.2.10', port)
        for target in ('-oProxyCommand=bad', 'root@node;id', 'root@node\nother', '-admin@node', 'root@bad:address'):
            with self.subTest(target=target), self.assertRaises(ValueError):
                builder.ssh_transport(target, 2222)


class BackendBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git = shutil.which('git')
        self.source = self.root / 'repository'
        subprocess.run([self.git, 'init', '--quiet', self.source], check=True)
        (self.source / 'install.sh').write_text(
            '#!/bin/bash\nset -e\nprintf "%s\\n" "$@" > "$VORTEX_TEST_ROOT/backend-args"\n'
            'exit "${VORTEX_TEST_BACKEND_STATUS:-0}"\n')
        subprocess.run([self.git, '-C', self.source, 'add', 'install.sh'], check=True)
        subprocess.run([self.git, '-C', self.source, '-c', 'user.name=Updater Tests',
                        '-c', 'user.email=updater@example.invalid', 'commit', '--quiet', '-m', 'Installer fixture'], check=True)
        self.revision = subprocess.run([self.git, '-C', self.source, 'rev-parse', 'HEAD'],
                                       check=True, capture_output=True, text=True).stdout.strip()
        self.installed = self.root / 'installed'
        self.installed.mkdir()
        (self.installed / 'install.sh').write_text('#!/bin/bash\ntouch "$VORTEX_TEST_ROOT/old-installer-ran"\nexit 88\n')
        (self.installed / 'install.sh').chmod(0o755)
        (self.installed / 'current').symlink_to(self.installed / ('0' * 40))
        (self.installed / 'encrypted-data').write_bytes(b'preserve existing data')
        self.remote = self.root / 'remote'
        self.remote.mkdir()
        (self.remote / 'deploy-local-web.py').write_text(
            'import os\nfrom pathlib import Path\nPath(os.environ["VORTEX_TEST_ROOT"], "web-activated").touch()\n')
        binaries = self.root / 'bin'
        binaries.mkdir()
        # Exercise the real fetch/show path using a local Git repository. Only
        # transport is redirected; the production shell and installer run intact.
        (binaries / 'git').write_text(
            '#!/usr/bin/env python3\nimport os, sys\nargs = sys.argv[1:]\n'
            'if "fetch" in args and os.getenv("VORTEX_TEST_FETCH_FAIL"): sys.exit(73)\n'
            'if "rev-parse" in args and os.getenv("VORTEX_TEST_REVISION_MISMATCH"):\n'
            '    print("f" * 40)\n    sys.exit(0)\n'
            'args = [os.environ["VORTEX_TEST_REPOSITORY"] if a == '
            '"https://github.com/MagnetosphereLabs/VortexNode.git" else '
            '"protocol.file.allow=always" if a == "protocol.file.allow=never" else a for a in args]\n'
            'os.execv(os.environ["VORTEX_TEST_GIT"], [os.environ["VORTEX_TEST_GIT"], *args])\n')
        (binaries / 'sudo').write_text('#!/bin/sh\nexec "$@"\n')
        for binary in binaries.iterdir():
            binary.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'],
                                VORTEX_TEST_ROOT=str(self.root), VORTEX_TEST_GIT=self.git,
                                VORTEX_TEST_REPOSITORY=str(self.source))

    def deploy(self, **environment):
        output = self.root / 'build'
        output.mkdir(exist_ok=True)
        (output / 'vortex-chat-web.tar.gz').write_bytes(b'web')
        result = {'web_sha256': hashlib.sha256(b'web').hexdigest(), 'source_commit': 'b' * 40}
        with patch.object(builder, 'run', return_value=subprocess.CompletedProcess([], 0, '/tmp/vortex-web.12345678\n')) as run, patch.object(builder.subprocess, 'run'):
            builder.deploy_web(output, result, 'admin@node', node_revision=self.revision)
        command = run.call_args_list[2].args[-1]
        command = command.replace('/tmp/vortex-web.12345678', str(self.remote))
        command = command.replace('/opt/vortex-node', str(self.installed))
        return subprocess.run(['bash', '-c', command], env=dict(self.environment, **environment),
                              capture_output=True, text=True)

    def test_stale_installer_is_bypassed_and_preview_tracking_is_preserved(self):
        completed = self.deploy()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse((self.root / 'old-installer-ran').exists())
        self.assertEqual((self.root / 'backend-args').read_text().splitlines(),
                         ['update', '--repo', 'https://github.com/MagnetosphereLabs/VortexNode.git',
                          '--ref', 'vortex/preview'])
        self.assertTrue((self.root / 'web-activated').exists())

    def test_failed_backend_update_leaves_web_and_encrypted_data_untouched(self):
        completed = self.deploy(VORTEX_TEST_BACKEND_STATUS='42')
        self.assertEqual(completed.returncode, 42, completed.stderr)
        self.assertFalse((self.root / 'web-activated').exists())
        self.assertEqual((self.installed / 'encrypted-data').read_bytes(), b'preserve existing data')

    def test_fetch_failure_and_revision_mismatch_stop_before_installation(self):
        for environment in ({'VORTEX_TEST_FETCH_FAIL': '1'}, {'VORTEX_TEST_REVISION_MISMATCH': '1'}):
            with self.subTest(environment=environment):
                completed = self.deploy(**environment)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse((self.root / 'backend-args').exists())
                self.assertFalse((self.root / 'web-activated').exists())

    def test_current_backend_skips_bootstrap_and_still_activates_web(self):
        (self.installed / 'current').unlink()
        (self.installed / 'current').symlink_to(self.installed / self.revision)
        completed = self.deploy(VORTEX_TEST_FETCH_FAIL='1')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse((self.remote / 'node-source').exists())
        self.assertFalse((self.root / 'backend-args').exists())
        self.assertTrue((self.root / 'web-activated').exists())


if __name__ == '__main__':
    unittest.main()
