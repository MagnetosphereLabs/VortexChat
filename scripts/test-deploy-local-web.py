import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy-local-web.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def bundle(path, extra=None):
    with tarfile.open(path, 'w:gz') as archive:
        for name, body in [('index.html', b'<html></html>'), ('assets/client.js', b'local client')]:
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
        if extra:
            archive.addfile(extra)
    return hashlib.sha256(path.read_bytes()).hexdigest()


class LocalWebTests(unittest.TestCase):
    def test_activation_preserves_node_settings_and_configuration_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, archive = root / 'config.json', root / 'web.tar.gz'
            original = {'vault_enabled': True, 'data_dir': '/existing/storage', 'domain': 'node.example', 'chat_web_dir': '/old/client'}
            config.write_text(json.dumps(original))
            config.chmod(0o640)
            digest = bundle(archive)
            calls = []
            path = deploy.activate(archive, digest, 'a' * 40, config, root / 'clients', lambda: calls.append('restart'))
            self.assertTrue((path / 'assets/client.js').is_file())
            actual = json.loads(config.read_text())
            self.assertEqual(actual, {**original, 'chat_web_dir': str(path)})
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o640)
            self.assertEqual(json.loads(config.with_name('config.json.before-local-web').read_text()), original)
            self.assertEqual(calls, ['restart'])
            self.assertFalse(json.loads((path / 'vortex-local-build.json').read_text())['qualified_release'])

    def test_restart_failure_restores_previous_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, archive = root / 'config.json', root / 'web.tar.gz'
            original = b'{"vault_enabled":true,"chat_web_dir":"/old/client"}'
            config.write_bytes(original)
            digest = bundle(archive)
            calls = []
            def restart():
                calls.append(True)
                if len(calls) == 1:
                    raise RuntimeError('simulated startup failure')
            with self.assertRaises(RuntimeError):
                deploy.activate(archive, digest, 'a' * 40, config, root / 'clients', restart)
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(len(calls), 2)

    def test_wrong_checksum_does_not_change_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, archive = root / 'config.json', root / 'web.tar.gz'
            config.write_text('{"chat_web_dir":"/old/client"}')
            before = config.read_bytes()
            bundle(archive)
            with self.assertRaises(ValueError):
                deploy.activate(archive, '0' * 64, 'a' * 40, config, root / 'clients', lambda: None)
            self.assertEqual(config.read_bytes(), before)

    def test_links_and_parent_paths_are_rejected_before_activation(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config, archive = root / 'config.json', root / 'web.tar.gz'
                config.write_text('{}')
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                digest = bundle(archive, entry)
                with self.assertRaises(ValueError):
                    deploy.activate(archive, digest, 'a' * 40, config, root / 'clients', lambda: None)
                self.assertEqual(config.read_text(), '{}')


if __name__ == '__main__':
    unittest.main()
