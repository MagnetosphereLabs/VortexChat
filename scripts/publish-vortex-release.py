#!/usr/bin/env python3
"""Publish a matched release only from successful, explicitly selected build runs."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import zipfile

REPOSITORY = 'MagnetosphereLabs/VortexChat'
NODE_REPOSITORY = 'MagnetosphereLabs/VortexNode'


def gh(*args, **kwargs):
    return subprocess.run(['gh', *args], check=True, **kwargs)


def api(path):
    return json.loads(gh('api', path, capture_output=True, text=True).stdout)


def verify_run(repository, run_id, sha, workflow):
    run = api(f'repos/{repository}/actions/runs/{run_id}')
    if (run['conclusion'] != 'success' or run['status'] != 'completed'
            or run['head_sha'] != sha or run['path'] != workflow
            or run['event'] not in ('push', 'workflow_dispatch')
            or run['head_repository']['full_name'] != repository):
        raise ValueError(f'{repository} run {run_id} is not a qualified build of {sha}')
    return run


def artifact(repository, run_id, name, destination):
    items = api(f'repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100')['artifacts']
    matches = [item for item in items if item['name'] == name and not item['expired']]
    if len(matches) != 1:
        raise ValueError(f'Expected one unexpired {name} artifact')
    item = matches[0]
    if item['size_in_bytes'] > 2 * 1024**3:
        raise ValueError('Artifact exceeds the release size limit')
    destination.mkdir()
    archive = destination / 'artifact.zip'
    with archive.open('xb') as output:
        gh('api', f'repos/{repository}/actions/artifacts/{item["id"]}/zip', stdout=output)
    digest = 'sha256:' + file_digest(archive)
    if digest != item.get('digest'):
        raise ValueError('Artifact archive does not match its GitHub digest')
    with zipfile.ZipFile(archive) as bundle:
        seen, size = set(), 0
        for entry in bundle.infolist():
            path = PurePosixPath(entry.filename)
            size += entry.file_size
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                    or entry.filename in seen or size > 4 * 1024**3
                    or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('Unsafe artifact archive')
            seen.add(entry.filename)
            target = destination.joinpath(*path.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024**2)
    archive.unlink()


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked_file(path, checksums):
    actual = file_digest(path)
    matches = [line.split()[0] for line in checksums.read_text().splitlines()
               if len(line.split()) == 2 and PurePosixPath(line.split()[1]).name == path.name]
    if matches != [actual]:
        raise ValueError(f'Build checksum mismatch for {path.name}')
    return actual


def main():
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise ValueError('Release publication is restricted to the Vortex repository')
    request = json.loads(Path('release-request.json').read_text())
    tag, sha, node_sha = request['release'], request['client_sha'], request['node_sha']
    if not re.fullmatch(r'vortex-v\d+\.\d+\.\d+-rc\.\d+', tag):
        raise ValueError('This workflow publishes explicit release candidates only')
    for value in (sha, node_sha):
        if not re.fullmatch(r'[0-9a-f]{40}', value):
            raise ValueError('Full immutable source commits are required')
    for key in ('web_run', 'linux_run', 'node_run'):
        if type(request[key]) is not int or request[key] <= 0:
            raise ValueError('Invalid build run identifier')
    verify_run(REPOSITORY, request['web_run'], sha, '.github/workflows/vortex-client.yml')
    verify_run(REPOSITORY, request['linux_run'], sha, '.github/workflows/vortex-linux.yml')
    verify_run(NODE_REPOSITORY, request['node_run'], node_sha, '.github/workflows/verify.yml')
    # A successful backend run is relevant only if both clients used that exact
    # backend in their integration checks.
    for workflow in ('vortex-client.yml', 'vortex-linux.yml'):
        source = api(f'repos/{REPOSITORY}/contents/.github/workflows/{workflow}?ref={sha}')
        contents = base64.b64decode(source['content'], validate=False).decode()
        pinned = re.findall(r'repository: MagnetosphereLabs/VortexNode\s+ref: ([0-9a-f]{40})', contents)
        if pinned != [node_sha]:
            raise ValueError(f'{workflow} did not test the selected Node revision')
    with tempfile.TemporaryDirectory(prefix='vortex-release-') as directory:
        work = Path(directory)
        artifact(REPOSITORY, request['web_run'], 'vortex-chat-web', work / 'web')
        artifact(REPOSITORY, request['linux_run'], 'vortex-chat-linux-x64', work / 'linux')
        web = work / 'web/vortex-chat-web.tar.gz'
        linux = work / 'linux/vortex-chat-linux-x64.tar.gz'
        web_hash = checked_file(web, work / 'web/SHA256SUMS')
        linux_hash = checked_file(linux, work / 'linux/Linux-SHA256SUMS')
        base = f'https://github.com/{REPOSITORY}/releases/download/{tag}/'
        manifest = {'protocol_version': 1, 'release': tag, 'version': tag.removeprefix('vortex-v'),
                    'source_commit': sha, 'node_commit': node_sha,
                    'pub_date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'web': {'url': base + web.name, 'sha256': web_hash},
                    'linux_x64': {'url': base + linux.name, 'sha256': linux_hash},
                    'build_runs': {key: request[key] for key in ('web_run', 'linux_run', 'node_run')}}
        manifest_path = work / 'desktop-release.json'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        lock = work / 'clients.lock.json'
        lock.write_text(json.dumps({key: manifest[key] for key in ('protocol_version', 'release', 'source_commit', 'web')}, indent=2) + '\n')
        notes = work / 'release-notes.md'
        notes.write_text(request['notes'] + '\n')
        sums = work / 'SHA256SUMS'
        assets = [web, linux, manifest_path, lock]
        sums.write_text(''.join(file_digest(path) + '  ' + path.name + '\n' for path in assets))
        # An existing release is never overwritten. Published assets remain immutable.
        gh('release', 'create', tag, *map(str, assets), str(sums), '--repo', REPOSITORY,
           '--target', sha, '--title', 'Vortex Chat ' + manifest['version'],
           '--notes-file', str(notes), '--prerelease', '--latest=false')


if __name__ == '__main__':
    main()
