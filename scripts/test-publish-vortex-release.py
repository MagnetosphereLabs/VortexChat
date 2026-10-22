import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-vortex-release.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class ReleaseQualificationTests(unittest.TestCase):
    def test_only_successful_runs_of_the_exact_source_are_accepted(self):
        repo, sha, workflow = 'MagnetosphereLabs/VortexChat', '1' * 40, '.github/workflows/vortex-client.yml'
        qualified = dict(status='completed', conclusion='success', head_sha=sha, path=workflow,
                         event='push', head_repository={'full_name': repo})
        with patch.object(publisher, 'api', return_value=qualified):
            self.assertEqual(publisher.verify_run(repo, 1, sha, workflow), qualified)
        for field, value in [('status', 'in_progress'), ('conclusion', 'failure'), ('conclusion', 'cancelled'),
                             ('head_sha', '2' * 40), ('path', '.github/workflows/unrelated.yml'),
                             ('event', 'pull_request'), ('event', 'pull_request_target'),
                             ('head_repository', {'full_name': 'untrusted/fork'})]:
            altered = copy.deepcopy(qualified)
            altered[field] = value
            with self.subTest(field=field, value=value), patch.object(publisher, 'api', return_value=altered):
                with self.assertRaises(ValueError):
                    publisher.verify_run(repo, 1, sha, workflow)

    def test_modified_missing_and_ambiguous_assets_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, sums = Path(directory) / 'client.tar.gz', Path(directory) / 'SHA256SUMS'
            archive.write_bytes(b'original release')
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            sums.write_text(digest + '  client.tar.gz\n')
            self.assertEqual(publisher.checked_file(archive, sums), digest)
            archive.write_bytes(b'modified release')
            with self.assertRaises(ValueError):
                publisher.checked_file(archive, sums)
            archive.write_bytes(b'original release')
            for contents in ['', (digest + '  client.tar.gz\n') * 2]:
                sums.write_text(contents)
                with self.assertRaises(ValueError):
                    publisher.checked_file(archive, sums)


if __name__ == '__main__':
    unittest.main()
