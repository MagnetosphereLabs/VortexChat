// SPDX-License-Identifier: AGPL-3.0-or-later
import { auth } from './vendor/auth.js';
import { channelView, userView } from './Projection.js';

export function invitationCodes(content, origin) {
	if (!content) return [];
	const values = [];
	for (const match of content.matchAll(/https?:\/\/[^\s<>]+/gu)) {
		const matchedText = match[0].replace(/[),.!]+$/u, '');
		try {
			const url = new URL(matchedText);
			if (url.origin !== origin) continue;
			const code =
				url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{16,128})\/?$/u)?.[1] || url.searchParams.get('server_invite');
			if (code && /^[A-Za-z0-9_-]{16,128}$/u.test(code) && !values.some((item) => item.code === code))
				values.push({ code, matchedText, index: match.index });
		} catch {}
	}
	return values;
}
export async function invitationView(session, id) {
	const { core, ids } = session,
		{ state } = core;
	const item = (await core.action('space.invites')).invites.find(
		(item) => item.id === id && item.status === 'pending' && item.created > Date.now() / 1000 - 7 * 86400,
	);
	if (!item)
		throw Object.assign(new Error('This invitation expired or was already answered. Ask for a new invitation.'), {
			status: 404,
		});
	const recipient = item.recipient === state.me.id;
	if (!recipient && item.sender !== state.me.id)
		throw Object.assign(new Error('This invitation belongs to another account'), { status: 403 });
	let rooms, name;
	if (recipient) {
		await core.verifyIdentity(state.users.find((user) => user.id === item.sender));
		const pending = (await core.invitations()).find((value) => value.id === id);
		if (!pending) throw new Error('Invitation unavailable');
		name = pending.name;
		rooms = [];
		for (const channel of pending.body.rooms) {
			const bytes = await core.openInvitationBox(channel.box, channel.room, item.sender);
			const bundle = bytes.length === 32 ? { active: auth.b64(bytes) } : JSON.parse(auth.dec.decode(bytes));
			const meta = JSON.parse(
				auth.dec.decode(
					await auth.open(
						await auth.hkdf(auth.un64(bundle.active), 'archive:' + channel.room),
						auth.un64(channel.sealed),
						channel.room,
					),
				),
			);
			if (!meta.members?.includes(state.me.id) || !meta.members.includes(channel.creator))
				throw new Error('Invalid invitation membership');
			rooms.push({ id: channel.room, space: item.space, creator: channel.creator, kind: 'text', meta });
		}
	} else {
		rooms = state.rooms.filter((room) => room.space === item.space);
		name = rooms[0]?.meta.spaceName || 'Server';
	}
	const selected = rooms.find((room) => !room.meta.category) || rooms[0];
	if (!selected) throw new Error('This invitation has no available channels');
	await ids.add('guild', item.space);
	for (const room of rooms) await ids.add('channel', room.id);
	return {
		code: id,
		type: 0,
		temporary: false,
		expires_at: new Date((item.created + 7 * 86400) * 1000).toISOString(),
		inviter: userView(
			ids,
			state.users.find((user) => user.id === item.sender),
		),
		guild: { id: ids.get('guild', item.space), name, icon: null, banner: null, features: [], description: null },
		channel: channelView(ids, state, selected),
		member_count: selected.meta.members.length,
		presence_count: 0,
	};
}
