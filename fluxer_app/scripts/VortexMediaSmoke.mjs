// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise real encoded media through the shipped relay and client SDK, including
// a relay-authorized observer that deliberately lacks the conversation key.
import assert from 'node:assert/strict';
import {createHmac, createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, mkdir, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import 'fake-indexeddb/auto';
import {auth} from '../src/vortex/vendor/auth.js';
import {createVortexCore} from '../src/vortex/Core.js';

const playwright = await import(pathToFileURL(resolve(process.env.VORTEX_PLAYWRIGHT_MODULE)));
const binary = resolve(process.env.VORTEX_NODE_BINARY);
const nodeSource = resolve(process.env.VORTEX_NODE_SOURCE || 'node-server');
const dir = await mkdtemp(join(tmpdir(), 'vortex-media-'));
const assets = join(dir, 'assets'); await mkdir(assets);
const origin = 'http://127.0.0.1:18748';
const relayUrl = 'ws://127.0.0.1:17880';
const password = 'media-test-only-password-2026';
const relayKey = 'test-relay-key', relaySecret = auth.b64(auth.random(48));
const clients = [], processes = [], browsers = [];
let server, diagnostics = '';
const record = data => {diagnostics = (diagnostics + data).slice(-16000);};
async function waitFor(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {if (await check()) return; await delay(200);}
  throw new Error(message);
}
function start(command, args) {
  const child = spawn(command, args, {env: {...process.env, VORTEX_TEST: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', record); child.stderr.on('data', record); processes.push(child); return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited; clearTimeout(timer);
}
try {
  await build({entryPoints: [resolve('fluxer_app/scripts/fixtures/VortexMediaProbe.ts')], outfile: join(assets, 'probe.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022'});
  await build({entryPoints: [resolve('fluxer_app/pkgs/livekit-client/src/e2ee/worker/e2ee.worker.ts')], outfile: join(assets, 'worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022'});
  server = createServer(async (request, response) => {
    if (request.url === '/') {response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Encrypted media test</title><script type="module" src="/probe.js"></script>'); return;}
    if (!['/probe.js', '/worker.js'].includes(request.url)) {response.writeHead(404).end(); return;}
    response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(assets, request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = 'http://127.0.0.1:' + server.address().port;
  const archive = join(nodeSource, 'media/livekit_1.13.10_linux_amd64.tar.gz');
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), 'c25a3e45fb922e9a93c6443d10c0ed041ba64342097e38632331736630283165');
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', dir, 'livekit-server']); assert.equal(unpack.status, 0);
  const relayConfig = join(dir, 'media.yaml');
  await writeFile(relayConfig, `port: 17880\nbind_addresses: ["127.0.0.1"]\nrtc:\n  node_ip: "127.0.0.1"\n  use_external_ip: false\n  enable_loopback_candidate: true\n  tcp_port: 17881\n  udp_port: 17882\nkeys:\n  "${relayKey}": "${relaySecret}"\nlogging:\n  level: error\n`);
  start(join(dir, 'livekit-server'), ['--config', relayConfig]);
  await waitFor(async () => {try {return (await fetch('http://127.0.0.1:17880/')).ok;} catch {return false;}}, 'Media relay did not start');
  const setup = spawnSync(binary, ['setup', '--data', dir, '--stdin-user', 'media.owner'], {input: password + '\n', encoding: 'utf8'});
  assert.equal(setup.status, 0, setup.stderr);
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({listen: '127.0.0.1:18748', public_url: origin, data_dir: dir, vault_html: join(dir, 'unused.html'), node_id: auth.b64(auth.random()), bridge: auth.b64(auth.random()), reserve_bytes: 0, vault_enabled: false, media: {url: relayUrl, http: 'http://127.0.0.1:17880', key: relayKey, secret: relaySecret}}));
  start(binary, ['serve', '--config', config]);
  await waitFor(async () => {try {return (await fetch(origin + '/health')).ok;} catch {return false;}}, 'Node did not start');
  const owner = await auth.login({url: origin, username: 'media.owner', password});
  await auth.api(origin, 'policy', {signupUntil: Math.floor(Date.now()/1000) + 600, createSpaces: 'everyone', chatQuota: 0}, owner.token);
  for (const username of ['media.alice', 'media.bobxx']) {
    await auth.register({url: origin, username, password});
    const pair = await auth.login({url: origin, username, password});
    const core = createVortexCore(); await core.connect(pair, await auth.restoreRoot(pair)); clients.push(core);
  }
  const [alice, bob] = clients; await alice.sync();
  const space = (await alice.action('space.create', {sealed: auth.b64(auth.random(64))})).id;
  const room = await alice.createRoom('voice', {space, spaceName: 'Media test', name: 'private call', members: [bob.state.me.id], background: true});
  await bob.sync(); await alice.sync();
  const aliceKey = auth.b64(await alice.mediaKey(room));
  const bobRoom = bob.state.rooms.find(value => value.id === room.id);
  assert.equal(auth.b64(await bob.mediaKey(bobRoom)), aliceKey, 'Both members must derive the same current media key');
  const grants = [];
  for (const core of clients) {
    const response = await fetch(origin + '/chat/media', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + core.state.pair.token}, body: JSON.stringify({room: room.id, device: core.state.device, client: 'fluxer', connection: crypto.randomUUID()})});
    assert.equal(response.status, 200); grants.push(await response.json());
  }
  // A malicious relay can issue itself a valid signaling token. It must still
  // receive no decodable media without the participant-owned encryption key.
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encoded({alg: 'HS256', typ: 'JWT'}) + '.' + encoded({iss: relayKey, sub: 'untrusted-relay-observer', exp: Math.floor(Date.now()/1000) + 120, video: {roomJoin: true, room: room.id, canSubscribe: true, canPublish: false}});
  grants.push({url: relayUrl, token: unsigned + '.' + createHmac('sha256', relaySecret).update(unsigned).digest('base64url')});
  const pages = [];
  for (let index = 0; index < grants.length; index++) {
    const browser = await playwright.chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']}); browsers.push(browser);
    const page = await browser.newPage(); pages.push(page);
    await page.goto(pageUrl); await page.waitForFunction(() => Boolean(window.probe));
    await page.evaluate(input => window.probe.join(input), {...grants[index], key: index === 2 ? auth.b64(auth.random(32)) : aliceKey});
  }
  await pages[0].evaluate(() => window.probe.publish());
  await waitFor(async () => {const stats = await pages[1].evaluate(() => window.probe.stats()); return stats.frames > 5 && stats.energy > 0 && stats.sources.includes('screen_share') && stats.sources.includes('screen_share_audio');}, 'Authorized participant did not decode encrypted video and shared audio', 30000);
  await waitFor(async () => (await pages[2].evaluate(() => window.probe.stats())).packets > 10, 'Observer did not receive enough ciphertext to exercise decryption rejection');
  const observer = await pages[2].evaluate(() => window.probe.stats());
  assert.equal(observer.frames, 0, 'Relay observer decoded video without the key');
  assert.equal(observer.energy, 0, 'Relay observer decoded audio without the key');
  await alice.action('space.member', {space, user: bob.state.me.id, banned: true, permissions: 0});
  await waitFor(async () => (await pages[1].evaluate(() => window.probe.stats())).state === 'disconnected', 'Removed participant remained in the media room');
  const revoked = await fetch(origin + '/chat/media', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + bob.state.pair.token}, body: JSON.stringify({room: room.id, device: bob.state.device})});
  assert.equal(revoked.status, 403);
  console.log('Encrypted screen video and audio decoded only by a participant; relay observer rejected; removed participant disconnected');
} catch (error) {
  // Relay credentials and participant JWTs must never appear in diagnostics.
  console.error(diagnostics.replaceAll(relaySecret, '[redacted]').split('\n').filter(line => !/token|authorization/i.test(line)).join('\n'));
  throw error;
} finally {
  for (const browser of browsers) await browser.close();
  for (const core of clients) core.close();
  for (const child of processes.reverse()) await stop(child);
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
