import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('update-local.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class LocalUpdateTests(unittest.TestCase):
    def test_connection_is_saved_privately_and_reused_without_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            first = SimpleNamespace(host='192.0.2.10', port=7142, user='admin', configure=False)
            saved = updater.connection_settings(first, path)
            again = SimpleNamespace(host=None, port=None, user=None, configure=False)
            with patch('builtins.input', side_effect=AssertionError('Unexpected prompt')):
                self.assertEqual(updater.connection_settings(again, path), saved)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(set(json.loads(path.read_text())), {'host', 'port', 'user'})

    def test_failed_client_build_never_updates_the_server(self):
        with patch.object(updater, 'build_clients', side_effect=RuntimeError('compile failed')), patch.object(updater.builder, 'run') as run, patch.object(updater.builder, 'deploy_web') as deploy:
            with self.assertRaises(RuntimeError):
                updater.update(SimpleNamespace(), {'host': '192.0.2.10', 'port': 7142, 'user': 'admin'}, Path('/unused'))
        run.assert_not_called()
        deploy.assert_not_called()

    def test_completed_clients_precede_backend_and_web_deployment(self):
        events = []
        result = {'source_commit': 'b' * 40}
        with tempfile.TemporaryDirectory() as directory, patch.object(updater, 'build_clients', side_effect=lambda *args: events.append('build') or result), patch.object(updater.builder, 'run', side_effect=lambda *args, **kwargs: events.append('revision') or subprocess.CompletedProcess([], 0, 'a' * 40 + '\trefs/heads/vortex/preview\n')), patch.object(updater.builder, 'deploy_web', side_effect=lambda *args, **kwargs: events.append('deploy')) as deploy, patch.object(updater.subprocess, 'run'):
            updater.update(SimpleNamespace(), {'host': '192.0.2.10', 'port': 7142, 'user': 'admin'}, Path(directory))
        self.assertEqual(events, ['build', 'revision', 'deploy'])
        self.assertEqual(deploy.call_args.args[2:], ('admin@192.0.2.10', 7142))
        self.assertEqual(deploy.call_args.kwargs['node_revision'], 'a' * 40)
        self.assertIn('ControlMaster=auto', deploy.call_args.kwargs['ssh_options'])

    def test_completed_unchanged_build_is_verified_and_reinstalled_without_recompiling(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            desktop, web = output / 'vortex-chat-linux-x64.tar.gz', output / 'vortex-chat-web.tar.gz'
            desktop.write_bytes(b'desktop')
            web.write_bytes(b'web')
            result = {'source_commit': 'a' * 40, 'sha256': hashlib.sha256(b'desktop').hexdigest(), 'web_sha256': hashlib.sha256(b'web').hexdigest()}
            (output / 'build-result.json').write_text(json.dumps(result))
            with patch.object(updater.builder, 'run', return_value=subprocess.CompletedProcess([], 0, 'a' * 40 + '\n')) as run, patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                self.assertEqual(updater.build_clients(SimpleNamespace(engine=None, jobs=None), output), result)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0], 'sudo')
            self.assertIn('--local-archive', run.call_args.args)


if __name__ == '__main__':
    unittest.main()
