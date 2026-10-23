// SPDX-License-Identifier: AGPL-3.0-or-later
import { auth } from './vendor/auth.js';

export async function confirmAccount(session, password, otp = '') {
	const pair = await auth.login({ url: session.pair.url, username: session.pair.username, password, otp, months: 1 });
	try {
		if (pair.id !== session.pair.id) throw new Error('Account identity mismatch');
		const root = await auth.restoreRoot(pair);
		if (JSON.stringify(root.identity) !== JSON.stringify(session.core.state.root.identity))
			throw new Error('Account identity changed');
		return pair.token;
	} catch (error) {
		await auth.api(session.pair.url, 'logout', {}, pair.token).catch(() => {});
		throw error;
	} finally {
		await auth.store('delete', 'pair');
	}
}
export async function changePassword(session, { password, code, new_password }) {
	if (
		typeof new_password !== 'string' ||
		[...new_password].length < 15 ||
		[...new_password].length > 128 ||
		auth.enc.encode(new_password).length > 512
	)
		throw new Error('Use a 15–128 character password');
	const proof = await confirmAccount(session, password, code);
	try {
		await auth.ready;
		const start = auth.opaque.startRegistration({ password: new_password });
		const response = await session.core.action('password.start', { proof, request: start.registrationRequest });
		const completed = auth.opaque.finishRegistration({
			password: new_password,
			registrationResponse: response.response,
			clientRegistrationState: start.clientRegistrationState,
			keyStretching: 'memory-constrained',
		});
		const key = await auth.hkdf(
			auth.un64(completed.exportKey),
			'account:' + session.pair.url + ':' + session.pair.username,
		);
		const bundle = auth.b64(
			await auth.seal(key, auth.enc.encode(JSON.stringify(session.core.state.root)), session.pair.username),
		);
		await session.core.action('password.finish', {
			proof,
			id: response.id,
			record: completed.registrationRecord,
			bundle,
		});
	} finally {
		await auth.api(session.pair.url, 'logout', {}, proof).catch(() => {});
	}
	return { ok: true };
}
function onNode(origin) {
	if (globalThis.location?.origin !== origin || !globalThis.PublicKeyCredential)
		throw new Error('Open your Node website to manage or use passkeys');
}
function creationOptions(value) {
	const options = { ...value.publicKey };
	options.challenge = auth.un64(options.challenge);
	options.user = { ...options.user, id: auth.un64(options.user.id) };
	options.excludeCredentials = options.excludeCredentials?.map((item) => ({ ...item, id: auth.un64(item.id) }));
	return options;
}
function requestOptions(value) {
	const options = { ...value.publicKey };
	options.challenge = auth.un64(options.challenge);
	options.allowCredentials = options.allowCredentials?.map((item) => ({ ...item, id: auth.un64(item.id) }));
	return options;
}
// PRF results and private key material must never enter a server-bound credential.
export function publicCredential(credential) {
	const response = {};
	for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle'])
		if (credential.response[key]) response[key] = auth.b64(new Uint8Array(credential.response[key]));
	return {
		id: credential.id,
		rawId: auth.b64(new Uint8Array(credential.rawId)),
		type: credential.type,
		response,
		extensions: {},
	};
}
async function prfResult(credential, options, salt) {
	let result = credential.getClientExtensionResults()?.prf?.results?.first;
	if (!result) {
		const assertion = await navigator.credentials.get({
			publicKey: {
				challenge: auth.random(32),
				rpId: options.rp.id,
				userVerification: 'required',
				allowCredentials: [{ type: 'public-key', id: credential.rawId }],
				extensions: { prf: { eval: { first: salt } } },
			},
		});
		if (assertion?.id !== credential.id) throw new Error('Passkey identity mismatch');
		result = assertion.getClientExtensionResults()?.prf?.results?.first;
	}
	if (!result)
		throw new Error('This passkey cannot unlock encrypted Chat on this browser. Use your password or another passkey.');
	return new Uint8Array(result);
}
export async function addPasskey(session, body) {
	onNode(session.pair.url);
	const proof = await confirmAccount(session, body.password, body.code);
	try {
		const start = await session.core.action('passkey.start', { proof }),
			options = creationOptions(start.options),
			salt = auth.random(32);
		options.extensions = { ...options.extensions, prf: { eval: { first: salt } } };
		const credential = await navigator.credentials.create({ publicKey: options });
		if (!credential) throw new Error('Passkey creation was cancelled');
		const output = await prfResult(credential, options, salt),
			context = 'passkey:' + session.pair.url + ':' + credential.id;
		const key = await auth.hkdf(output, context);
		output.fill(0);
		const wrapped = auth.b64(await auth.seal(key, auth.enc.encode(JSON.stringify(session.core.state.root)), context));
		await session.core.action('passkey.finish', {
			proof,
			id: start.id,
			credential: publicCredential(credential),
			wrapped,
			salt: auth.b64(salt),
			name: body.name || 'My passkey',
		});
		return { ok: true };
	} finally {
		await auth.api(session.pair.url, 'logout', {}, proof).catch(() => {});
	}
}
export async function deletePasskey(session, body) {
	const proof = await confirmAccount(session, body.password, body.code);
	try {
		return await session.core.action('passkey.delete', { proof, id: body.id });
	} finally {
		await auth.api(session.pair.url, 'logout', {}, proof).catch(() => {});
	}
}
export async function passkeyPair(origin, username) {
	onNode(origin);
	if (typeof username !== 'string' || !username.trim()) throw new Error('Enter your Node username first');
	const start = await auth.api(origin, 'auth.passkey.start', { username: username.trim() }),
		options = requestOptions(start.options);
	options.extensions = {
		...options.extensions,
		prf: {
			evalByCredential: Object.fromEntries(
				Object.entries(start.salts).map(([id, salt]) => [id, { first: auth.un64(salt) }]),
			),
		},
	};
	const credential = await navigator.credentials.get({ publicKey: options });
	if (!credential) throw new Error('Passkey sign-in was cancelled');
	const output = credential.getClientExtensionResults()?.prf?.results?.first;
	if (!output) throw new Error('This browser cannot unlock this passkey’s encrypted Chat keys. Use your password.');
	const result = await auth.api(origin, 'auth.passkey.finish', {
		id: start.id,
		credential: publicCredential(credential),
		device: navigator.userAgent.slice(0, 80),
	});
	try {
		const context = 'passkey:' + origin + ':' + credential.id,
			key = await auth.hkdf(new Uint8Array(output), context);
		const root = JSON.parse(auth.dec.decode(await auth.open(key, auth.un64(result.wrapped), context)));
		if (JSON.stringify(root.identity) !== JSON.stringify(result.identity)) throw new Error('Account identity mismatch');
		const config = await auth.api(origin, 'auth.config'),
			pair = { ...result, url: origin, gate: config.gate, node: config.node };
		delete pair.wrapped;
		delete pair.salt;
		await auth.remember(pair, root);
		return pair;
	} catch (error) {
		await auth.api(origin, 'logout', {}, result.token).catch(() => {});
		throw error;
	}
}
