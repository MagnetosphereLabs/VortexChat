import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('accounts', Path(__file__).with_name('prepare-build-user.py'))
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)


class BuildUserTests(unittest.TestCase):
    def test_existing_uid_is_reused_and_its_home_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'ubuntu'
            directory.mkdir()
            cache = directory / 'existing-cache'
            cache.write_text('keep')
            account = SimpleNamespace(pw_name='ubuntu', pw_gid=1000, pw_dir=str(directory))
            with patch.object(accounts.grp, 'getgrgid'), patch.object(accounts.pwd, 'getpwuid', return_value=account), patch.object(accounts.subprocess, 'run') as run, patch.object(accounts.os, 'chown'):
                self.assertEqual(accounts.prepare(1000, 1000), 'ubuntu')
                self.assertEqual(accounts.prepare(1000, 1000), 'ubuntu')
            run.assert_not_called()
            self.assertEqual(cache.read_text(), 'keep')

    def test_unused_uid_creates_one_account_with_the_requested_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            account = SimpleNamespace(pw_name='builder', pw_gid=1000, pw_dir=str(Path(temporary) / 'builder'))
            with patch.object(accounts.grp, 'getgrgid'), patch.object(accounts.pwd, 'getpwuid', side_effect=[KeyError(1000), account]), patch.object(accounts.pwd, 'getpwnam', side_effect=KeyError('builder')), patch.object(accounts.subprocess, 'run') as run, patch.object(accounts.os, 'chown'):
                self.assertEqual(accounts.prepare(1000, 1000), 'builder')
            self.assertEqual(run.call_args.args[0], ['useradd', '--uid', '1000', '--gid', '1000', '--create-home', '--shell', '/bin/bash', 'builder'])

    def test_occupied_builder_name_does_not_remap_another_uid(self):
        with tempfile.TemporaryDirectory() as temporary:
            account = SimpleNamespace(pw_name='vortex-builder-1000', pw_gid=1000, pw_dir=str(Path(temporary) / 'home'))
            with patch.object(accounts.grp, 'getgrgid'), patch.object(accounts.pwd, 'getpwuid', side_effect=[KeyError(1000), account]), patch.object(accounts.pwd, 'getpwnam', side_effect=[SimpleNamespace(pw_uid=1001), KeyError('free')]), patch.object(accounts.subprocess, 'run') as run, patch.object(accounts.os, 'chown'):
                self.assertEqual(accounts.prepare(1000, 1000), 'vortex-builder-1000')
            self.assertEqual(run.call_args.args[0][-1], 'vortex-builder-1000')
            self.assertNotIn('usermod', run.call_args.args[0])

    def test_existing_uid_primary_group_is_aligned_without_changing_its_uid(self):
        with tempfile.TemporaryDirectory() as temporary:
            account = SimpleNamespace(pw_name='ubuntu', pw_gid=1001, pw_dir=temporary)
            with patch.object(accounts.grp, 'getgrgid'), patch.object(accounts.pwd, 'getpwuid', return_value=account), patch.object(accounts.subprocess, 'run') as run, patch.object(accounts.os, 'chown'):
                self.assertEqual(accounts.prepare(1000, 1000), 'ubuntu')
            self.assertEqual(run.call_args.args[0], ['usermod', '--gid', '1000', 'ubuntu'])


if __name__ == '__main__':
    unittest.main()
