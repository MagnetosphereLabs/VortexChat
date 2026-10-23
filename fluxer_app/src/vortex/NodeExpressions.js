// SPDX-License-Identifier: AGPL-3.0-or-later
// Node expressions use the existing signed, recipient-encrypted catalog format.
import { auth } from './vendor/auth.js';
import { setEmojiMedia, emojiName } from './EmojiMedia.js';

export async function expressionBlob(session, file) {
	return file.nodeBytes ? new Blob([auth.un64(file.nodeBytes)], { type: file.type }) : session.core.download(file);
}
async function publish(session, item, value, secret = auth.random(32)) {
	if (!session.core.state.me.owner)
		throw Object.assign(new Error('Only the Node administrator can manage Node expressions'), { status: 403 });
	const { core } = session,
		context = 'emoji:' + item.id,
		boxes = Object.create(null);
	for (const user of core.state.users) boxes[user.id] = await core.wrapKey(user.id, secret, context);
	const cipher = auth.b64(
		await auth.seal(await auth.hkdf(secret, 'archive:' + context), auth.enc.encode(JSON.stringify(value)), context),
	);
	const data = JSON.stringify({ version: 1, id: item.id, boxes, cipher });
	return core.action('emoji.publish', {
		id: item.id,
		version: item.version || '',
		body: { data, signature: await core.sign(data) },
	});
}
export async function hydrateNodeExpressions(session) {
	const { core } = session,
		{ state } = core;
	const { items } = await core.action('emoji.list');
	const live = new Set(items.map((item) => item.id));
	for (const id of session.nodeExpressions.keys())
		if (!live.has(id)) {
			URL.revokeObjectURL(session.nodeExpressions.get(id)?.url);
			session.nodeExpressions.delete(id);
		}
	const queue = items.filter((item) => item.ready);
	await Promise.all(
		Array.from({ length: Math.min(4, queue.length) }, async () => {
			while (queue.length) {
				const item = queue.shift(),
					previous = session.nodeExpressions.get(item.id);
				if (previous?.version === item.version) continue;
				try {
					const creator = state.users.find((user) => user.id === item.creator);
					if (!creator?.owner) throw new Error('Node expression publisher could not be verified');
					const response = await core.action('emoji.get', { id: item.id }),
						envelope = response.body;
					await core.verifyIdentity(creator);
					await core.verifySignature(creator.id, envelope.data, envelope.signature);
					const data = JSON.parse(envelope.data),
						context = 'emoji:' + item.id;
					if (data.version !== 1 || data.id !== item.id || !data.boxes?.[state.me.id]) continue;
					const keys = await core.roomKeys({ id: context, creator: creator.id, box: data.boxes[state.me.id] });
					const value = JSON.parse(auth.dec.decode(await auth.open(keys.key, auth.un64(data.cipher), context)));
					if (!/^[A-Za-z0-9_-]{1,32}$/u.test(value.name) || !/^image\/(png|webp|gif)$/u.test(value.type))
						throw new Error('Invalid Node expression');
					const bytes = auth.un64(value.bytes);
					if (!bytes.length || bytes.length > 256 * 1024) throw new Error('Node expression is too large');
					const blob = new Blob([bytes], { type: value.type }),
						bitmap = await createImageBitmap(blob);
					bitmap.close();
					const kind = value.kind === 'sticker' ? 'sticker' : 'emoji',
						id = await session.ids.add(kind, 'node:' + item.id),
						url = URL.createObjectURL(blob);
					if (previous?.url) URL.revokeObjectURL(previous.url);
					setEmojiMedia(session, kind === 'sticker' ? 'sticker:' + id : id, url);
					session.nodeExpressions.set(item.id, {
						...item,
						rawId: item.id,
						kind,
						id,
						url,
						value,
						secret: keys.secret,
						version: response.version,
						view: {
							id,
							name: value.name,
							description: String(value.description || '').slice(0, 100),
							tags: Array.isArray(value.tags) ? value.tags.slice(0, 5) : [],
							animated: value.type === 'image/gif',
							available: true,
							managed: false,
							roles: [],
							require_colons: true,
						},
						file: {
							id: 'node:' + item.id,
							nodeBytes: value.bytes,
							type: value.type,
							size: bytes.length,
							name: value.name,
						},
					});
				} catch {
					if (previous?.url) URL.revokeObjectURL(previous.url);
					session.nodeExpressions.delete(item.id);
				}
			}
		}),
	);
	// The publisher can grant new accounts catalog access without disclosing keys
	// to the Node. Only changed recipient sets require expensive key wrapping.
	if (state.me.owner)
		for (const item of items) {
			const entry = session.nodeExpressions.get(item.id);
			if (entry && state.users.some((user) => !item.recipients?.includes(user.id))) {
				try {
					const result = await publish(session, item, entry.value, entry.secret);
					entry.version = result.version;
				} catch {}
			}
		}
	state.nodeEmojis = [...session.nodeExpressions.values()]
		.filter((item) => item.kind === 'emoji')
		.map((item) => ({ ...item.view, file: item.file, nodeId: item.rawId, catalog: true }));
	state.nodeStickers = [...session.nodeExpressions.values()]
		.filter((item) => item.kind === 'sticker')
		.map((item) => ({ ...item.view, file: item.file, nodeId: item.rawId, catalog: true }));
}
export async function nodeExpressionRequest(session, method, id, body = {}) {
	if (method === 'GET') {
		await hydrateNodeExpressions(session);
		return {
			emojis: session.core.state.nodeEmojis.map(({ file, ...view }) => view),
			stickers: session.core.state.nodeStickers.map(({ file, ...view }) => view),
		};
	}
	if (!session.core.state.me.owner)
		throw Object.assign(new Error('Only the Node administrator can manage Node expressions'), { status: 403 });
	if (method === 'DELETE') {
		const entry = [...session.nodeExpressions.values()].find((item) => item.id === id);
		if (!entry) throw new Error('Expression unavailable');
		await session.core.action('emoji.delete', { id: session.ids.raw(entry.kind, id).slice(5) });
	} else if (method === 'POST') {
		if (!/^[A-Za-z0-9_-]{1,32}$/u.test(body.name)) throw new Error('Use 1–32 letters, numbers, underscores or hyphens');
		const match =
			typeof body.image === 'string' && body.image.match(/^data:(image\/(?:png|webp|gif));base64,([A-Za-z0-9+/=]+)$/u);
		if (!match || match[2].length > 350000) throw new Error('Choose a PNG, WebP or GIF up to 256 KiB');
		const bytes = auth.un64(match[2]);
		if (!bytes.length || bytes.length > 256 * 1024) throw new Error('Choose an image up to 256 KiB');
		const bitmap = await createImageBitmap(new Blob([bytes], { type: match[1] }));
		bitmap.close();
		await publish(
			session,
			{ id: auth.b64(auth.random(24)) },
			{
				kind: body.kind === 'sticker' ? 'sticker' : 'emoji',
				name: emojiName(body.name),
				type: match[1],
				bytes: auth.b64(bytes),
				description: String(body.description || '').slice(0, 100),
				tags: [],
			},
		);
	} else throw new Error('Unsupported Node expression operation');
	await hydrateNodeExpressions(session);
	session.emit('VORTEX_EXPRESSIONS_UPDATE', {});
	return { ok: true };
}
