import hashlib
import importlib.util
from pathlib import Path
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
            self.assertLess(command.index('install.sh update'), command.index('sudo python3'))

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


if __name__ == '__main__':
    unittest.main()
