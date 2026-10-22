// SPDX-License-Identifier: AGPL-3.0-or-later
// Import the existing Vortex cryptographic dependencies from an immutable source.
// Hashes cover the entire source files before any extraction or transformation.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const revision = '3e208d315d8c1a3ca547dd929f9503325d062f67';
const sources = {
	'Vortex Chat.html': '62c6089dc124d30fde888010c73d477cc9878a35a2bb27150816c146cc33b05d',
	'web/chat-auth.js': '6d416113a1b4e6a93f58db45893243840539763aab8b268be070e6386196b98a',
};
const destination = fileURLToPath(new URL('../src/vortex/vendor/', import.meta.url));
await mkdir(destination, {recursive: true});
const source = {};
for (const [name, expected] of Object.entries(sources)) {
	let bytes;
	if (process.env.VORTEX_NODE_SOURCE) {
		bytes = await readFile(path.join(process.env.VORTEX_NODE_SOURCE, name));
	} else {
		const url = `https://raw.githubusercontent.com/MagnetosphereLabs/VortexNode/${revision}/${encodeURI(name)}`;
		const response = await fetch(url, {signal: AbortSignal.timeout(60_000)});
		if (!response.ok) throw new Error(`Cannot obtain pinned Vortex source: ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
	}
	if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Vortex source digest mismatch: ${name}`);
	source[name] = bytes.toString('utf8');
}
const html = source['Vortex Chat.html'];
const wasm = html.match(/async function Pf\(\)\{if\(await AI\(\{module_or_path:V\("(AGFzb[A-Za-z0-9+/=]+)"/u)?.[1];
const bindingStart = html.indexOf('var K;function GA(');
const bindingEnd = html.indexOf('var AI=$c;', bindingStart);
if (!wasm || bindingStart < 0 || bindingEnd < bindingStart) throw new Error('Pinned MLS module layout changed');
const mls = Buffer.from(wasm, 'base64');
if (createHash('sha256').update(mls).digest('hex') !== '2950d93934b6ab34eb9d42331c7221ccd684dc766e401f9a2a29220772980809') {
	throw new Error('MLS binary digest mismatch');
}
await writeFile(path.join(destination, 'mls.js'), `${html.slice(bindingStart, bindingEnd)}\nexport {ae as Engine, $c as initMls};\n`);
await writeFile(path.join(destination, 'mls-bytes.js'), `export const mlsBytes = ${JSON.stringify(wasm)};\n`);
const auth = source['web/chat-auth.js'].trim();
if (!auth.startsWith('(()=>{') || !auth.endsWith('window.VortexChatAuth=t;})();')) throw new Error('Pinned authentication module layout changed');
await writeFile(path.join(destination, 'auth.js'), `export const auth = ${auth.replace('window.VortexChatAuth=t;', 'return t;')}\n`);
const notices = html.match(/<script[^>]+type="[^"]*"[^>]*>([\s\S]*?)<\/script>/gu)?.filter(s => /notice|license|copyright/iu.test(s)).join('\n');
await writeFile(path.join(destination, 'PROVENANCE.json'), JSON.stringify({repository:'MagnetosphereLabs/VortexNode',revision,sources,mlsSha256:createHash('sha256').update(mls).digest('hex')}, null, 2)+'\n');
await writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), notices || html.slice(html.lastIndexOf('<script')));
console.log('Verified and imported Vortex OPAQUE and OpenMLS dependencies.');
