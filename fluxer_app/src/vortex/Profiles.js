// SPDX-License-Identifier: AGPL-3.0-or-later
import { auth } from './vendor/auth.js';
import { setEmojiMedia } from './EmojiMedia.js';

export function profileAudience(state) {
	const selected = new Set([state.me.id, ...(state.friendIds || [])]);
	const privacy = state.prefs.fluxer?.profile_privacy ?? 0;
	if (privacy !== 2)
		for (const space of state.spaces) {
			const members = new Set(
				state.rooms.filter((room) => room.space === space.id).flatMap((room) => room.meta.members),
			);
			if (privacy === 1 && members.size > 200) continue;
			for (const id of members) selected.add(id);
		}
	return state.users
		.filter((user) => selected.has(user.id))
		.map((user) => user.id)
		.sort();
}
function validateProfile(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile');
	const out = {};
	for (const [field, max] of [
		['bio', 2000],
		['pronouns', 80],
		['status', 100],
		['timezone', 80],
	]) {
		if (value[field] != null && (typeof value[field] !== 'string' || value[field].length > max))
			throw new Error('Profile ' + field + ' is too long');
		out[field] = value[field] || '';
	}
	for (const field of ['avatar', 'banner']) {
		const image = value[field];
		if (
			image != null &&
			image !== '' &&
			(typeof image !== 'string' ||
				image.length > 400000 ||
				!/^data:image\/(?:png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/u.test(image))
		)
			throw new Error('Choose a supported profile image smaller than 290 KiB');
		out[field] = image || null;
	}
	for (const field of ['accent_color', 'banner_color'])
		out[field] = Number.isInteger(value[field]) && value[field] >= 0 && value[field] <= 0xffffff ? value[field] : null;
	return out;
}
export async function publishProfile(session, patch = {}, refresh = true) {
	const { core } = session,
		{ state } = core;
	const previous = state.prefs.profile || session.profiles?.get(state.me.id)?.value || {};
	const value = validateProfile({ ...previous, ...patch });
	const audience = profileAudience(state),
		context = 'profile:' + state.me.id,
		secret = auth.random(32),
		boxes = Object.create(null);
	for (const id of audience) boxes[id] = await core.wrapKey(id, secret, context);
	const cipher = auth.b64(
		await auth.seal(await auth.hkdf(secret, 'archive:' + context), auth.enc.encode(JSON.stringify(value)), context),
	);
	const data = JSON.stringify({ boxes, cipher });
	const profile = auth.b64(auth.enc.encode(JSON.stringify({ data, signature: await core.sign(data) })));
	if (profile.length > 512 * 1024) throw new Error('Profile is too large. Use smaller avatar and banner images.');
	const display =
		patch.global_name ?? state.users.find((user) => user.id === state.me.id)?.display ?? state.me.username;
	if (typeof display !== 'string' || !display.trim() || display.length > 80)
		throw new Error('Use a display name containing 1–80 characters');
	await core.action('profile', { display, status: state.prefs.status || 'online', profile });
	state.prefs.profile = value;
	state.prefs.profileAudience = audience;
	await core.savePreferences();
	if (refresh) await session.refresh(true);
	session.emit('USER_UPDATE', session.currentUser());
	return session.currentUser();
}
export async function hydrateProfiles(session) {
	const { core } = session,
		{ state } = core;
	const queue = [...state.users];
	await Promise.all(
		Array.from({ length: Math.min(4, queue.length) }, async () => {
			while (queue.length) {
				const user = queue.shift();
				let cached = session.profiles.get(user.id);
				const version = user.profile_version ?? 0;
				if (!cached || cached.version !== version || cached.shared !== user.profile) {
					try {
						let value = {};
						if (user.profile) {
							const response = await core.action('profile.get', { user: user.id });
							if (response.profile) {
								const envelope = JSON.parse(auth.dec.decode(auth.un64(response.profile)));
								await core.verifyIdentity(user);
								await core.verifySignature(user.id, envelope.data, envelope.signature);
								const data = JSON.parse(envelope.data),
									context = 'profile:' + user.id;
								if (data.boxes?.[state.me.id]) {
									const keys = await core.roomKeys({ id: context, creator: user.id, box: data.boxes[state.me.id] });
									value = validateProfile(
										JSON.parse(auth.dec.decode(await auth.open(keys.key, auth.un64(data.cipher), context))),
									);
								}
							}
						} else if (user.id === state.me.id && state.prefs.profile) value = validateProfile(state.prefs.profile);
						if (cached?.urls)
							for (const url of cached.urls) {
								URL.revokeObjectURL(url);
								session.profileUrls.delete(url);
							}
						cached = { version, shared: user.profile, value, urls: [] };
						for (const field of ['avatar', 'banner'])
							if (value[field]) {
								const [prefix, encoded] = value[field].split(','),
									type = prefix.slice(5, -7);
								const bytes = auth.un64(encoded),
									blob = new Blob([bytes], { type });
								const bitmap = await createImageBitmap(blob);
								bitmap.close();
								const hash = 'vortex_' + (await auth.digest(bytes)).slice(0, 32),
									url = URL.createObjectURL(blob);
								session.profileUrls.add(url);
								cached.urls.push(url);
								cached[field] = hash;
								setEmojiMedia(session, field + ':' + session.ids.get('user', user.id) + ':' + hash, url);
							}
						session.profiles.set(user.id, cached);
					} catch {
						cached = { version, shared: user.profile, value: {} };
						session.profiles.set(user.id, cached);
					}
				}
				user.vortexProfile = cached.value;
				user.vortexAvatar = cached.avatar || null;
				user.vortexBanner = cached.banner || null;
			}
		}),
	);
}
