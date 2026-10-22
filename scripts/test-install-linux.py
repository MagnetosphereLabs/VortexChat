#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).parent.parent / 'install-linux.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class LinuxInstallerTests(unittest.TestCase):
    def archive(self, path, extra=()):
        with tarfile.open(path, 'w:gz') as bundle:
            for name, data in [('vortex-chat', b'\x7fELFapplication'), ('chrome-sandbox', b'\x7fELFsandbox'), ('resources/app.asar', b'app')]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o6777
                member.uid = member.gid = 12345
                bundle.addfile(member, io.BytesIO(data))
            for member in extra:
                bundle.addfile(member, io.BytesIO(b'') if member.isfile() else None)

    def test_extraction_strips_privileges_and_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.archive(root / 'client.tar.gz')
            destination = root / 'app'
            destination.mkdir()
            installer.extract(root / 'client.tar.gz', destination)
            self.assertEqual((destination / 'chrome-sandbox').stat().st_mode & 0o7777, 0o755)
            self.assertTrue((destination / 'resources/app.asar').is_file())

    def test_paths_links_and_devices_are_rejected(self):
        bad = []
        for name in ('../escape', '/escape', 'dir\\escape', 'vortex-chat'):
            bad.append(tarfile.TarInfo(name))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            member = tarfile.TarInfo('unsafe')
            member.type, member.linkname = kind, '/etc/passwd'
            bad.append(member)
        for member in bad:
            with self.subTest(member=member.name, kind=member.type), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.archive(root / 'client.tar.gz', [member])
                destination = root / 'app'
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(root / 'client.tar.gz', destination)

    def test_digest_is_checked_before_extracting(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(installer.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value.__enter__.return_value = io.BytesIO(b'tampered')
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    installer.download('https://github.com/file', Path(temporary) / 'download', hashlib.sha256(b'expected').hexdigest())

    def test_download_size_and_transport_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                installer.download('http://github.com/file', Path(temporary) / 'insecure')
            with patch.object(installer.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value.__enter__.return_value = io.BytesIO(b'oversize')
                with self.assertRaisesRegex(ValueError, 'size limit'):
                    installer.download('https://github.com/file', Path(temporary) / 'download', maximum=2)
        for url in ('http://example.org/file', 'https://user:password@example.org/file'):
            with self.assertRaises(ValueError):
                installer.HTTPSRedirect().redirect_request(None, None, 302, '', {}, url)

    def test_manifest_cannot_redirect_to_another_publisher_or_release(self):
        release = 'vortex-preview-0.1.0'
        manifest = {'protocol_version': 1, 'release': release, 'linux_x64': {
            'url': installer.RELEASES + release + '/vortex-chat-linux-x64.tar.gz', 'sha256': 'a' * 64}}
        installer.validate_manifest(manifest, release)
        for url in ('https://example.org/client', manifest['linux_x64']['url'].replace('MagnetosphereLabs', 'someone')):
            altered = json.loads(json.dumps(manifest))
            altered['linux_x64']['url'] = url
            with self.assertRaises(ValueError):
                installer.validate_manifest(altered, release)
        with self.assertRaises(ValueError):
            installer.validate_manifest(manifest, 'vortex-other')


if __name__ == '__main__':
    unittest.main()
