// SPDX-License-Identifier: AGPL-3.0-or-later
import { auth } from './vendor/auth.js';

export async function emojiCatalogRequest(session, spaceId, method, suffix, body) {
	const { state } = session.core;
	const space = state.spaces.find((item) => item.id === spaceId);
	if (!space) throw new Error('Server unavailable');
	const list = () =>
		(state.vortexEmojis || [])
			.filter((item) => item.space === spaceId && item.catalog === true)
			.map(({ file, space, catalog, ...item }) => item);
	if (method === 'GET' && !suffix) return { body: list(), status: 200 };
	if (space.creator !== state.me.id && !(space.permissions & 8))
		throw Object.assign(new Error('Manage emoji permission is required'), { status: 403 });
	const room = state.rooms.find((item) => item.space === spaceId && item.kind === 'text' && !item.meta.category);
	if (!room) throw new Error('Create a text channel before adding emoji');
	const name = (value) => {
		if (typeof value !== 'string' || !/^\w{2,32}$/u.test(value))
			throw new Error('Use 2–32 letters, numbers, or underscores for an emoji name');
		return value;
	};
	const publish = async (entry) => {
		await session.core.send({ type: 'emoji', name: entry.name, file: entry.file }, 'emoji', room);
		const value = await session.emoji({ ...entry, catalog: true }, spaceId);
		if (!value) throw new Error('The emoji image could not be decoded');
		const { file, space, catalog, ...view } = value;
		return view;
	};
	const upload = async (item) => {
		if (list().length >= 1024) throw new Error('This server has reached its 1,024 emoji limit');
		const label = name(item.name),
			match =
				typeof item.image === 'string' &&
				item.image.match(/^data:(image\/(?:png|webp|gif|jpeg|avif));base64,([A-Za-z0-9+/=]+)$/u);
		if (!match || match[2].length > 1400000)
			throw new Error('Choose a PNG, WebP, GIF, JPEG, or AVIF smaller than 1 MiB');
		const bytes = auth.un64(match[2]);
		if (!bytes.length || bytes.length > 1024 ** 2) throw new Error('Choose an emoji smaller than 1 MiB');
		const blob = new Blob([bytes], { type: match[1] }),
			bitmap = await createImageBitmap(blob);
		bitmap.close();
		const file = { ...(await session.core.upload(new File([blob], label, { type: match[1] }), room)), room: room.id };
		return publish({ name: label, file, creator: state.me.id });
	};
	let result,
		status = 200;
	if (method === 'POST' && suffix === '/bulk') {
		if (!Array.isArray(body.emojis) || body.emojis.length > 50) throw new Error('Upload at most 50 emoji at once');
		result = { success: [], failed: [] };
		for (const item of body.emojis)
			try {
				result.success.push(await upload(item));
			} catch (error) {
				result.failed.push({ name: String(item?.name || 'emoji'), error: error.message });
			}
	} else if (method === 'POST' && !suffix) result = await upload(body);
	else if (method === 'POST' && suffix === '/clone') {
		const entry = (state.vortexEmojis || []).find((item) => item.id === body.source_emoji_id);
		if (!entry) throw new Error('Source emoji unavailable');
		const blob = await session.core.download(entry.file);
		const file = {
			...(await session.core.upload(new File([blob], entry.name, { type: entry.file.type }), room)),
			room: room.id,
		};
		result = await publish({ name: name(entry.name), file, creator: state.me.id });
	} else {
		const entry = (state.vortexEmojis || []).find((item) => '/' + item.id === suffix && item.space === spaceId);
		if (!entry) throw new Error('Emoji unavailable');
		if (method === 'PATCH') result = await publish({ ...entry, name: name(body.name) });
		else if (method === 'DELETE') {
			await session.core.send({ type: 'emoji.remove', fileId: entry.file.id }, 'emoji', room);
			state.prefs.emoji = (state.prefs.emoji || []).filter((item) => item.file?.id !== entry.file.id);
			await session.core.savePreferences();
			status = 204;
		} else throw new Error('Unsupported emoji operation');
	}
	await session.refresh(true);
	session.emit('GUILD_EMOJIS_UPDATE', { guild_id: session.ids.get('guild', spaceId), emojis: list() });
	return { body: result, status };
}
