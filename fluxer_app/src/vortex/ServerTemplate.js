// SPDX-License-Identifier: AGPL-3.0-or-later
// Validate the entire layout before creating anything. Permission-bearing
// templates must not silently become channels shared with every server member.
export function serverTemplatePlan(template) {
	if (!template) return null;
	if (!Array.isArray(template.channels) || !template.channels.length || template.channels.length > 100)
		throw new Error('Import a template containing 1–100 channels');
	if (template.roles != null && (!Array.isArray(template.roles) || template.roles.length))
		throw new Error(
			'This template includes roles. Role and permission migration must be supported before this template can be imported safely.',
		);
	const ids = new Map();
	const channels = template.channels.map((channel) => {
		const id = String(channel.id);
		if (ids.has(id) || !/^\d+$/u.test(id) || ![0, 2, 4, 5].includes(channel.type))
			throw new Error(
				'Templates currently support text, voice, category, and announcement channels with unique numeric IDs',
			);
		if (
			(channel.permission_overwrites != null &&
				(!Array.isArray(channel.permission_overwrites) || channel.permission_overwrites.length)) ||
			channel.user_limit ||
			channel.voice_connection_limit ||
			channel.rate_limit_per_user
		)
			throw new Error('This template contains channel permissions or limits that cannot yet be preserved');
		if (typeof channel.name !== 'string' || !channel.name.trim() || channel.name.length > 100)
			throw new Error('Template channel names must contain 1–100 characters');
		if (channel.topic != null && (typeof channel.topic !== 'string' || channel.topic.length > 4096))
			throw new Error('Template channel topic is too long');
		if (channel.bitrate != null && (channel.type !== 2 || ![32000, 64000, 128000].includes(channel.bitrate)))
			throw new Error('Choose a supported voice bitrate: 32, 64, or 128 kbps');
		if (
			channel.position != null &&
			(!Number.isSafeInteger(channel.position) || channel.position < 0 || channel.position > 10000)
		)
			throw new Error('Invalid template channel position');
		const value = { ...channel, id, parent_id: channel.parent_id == null ? null : String(channel.parent_id) };
		ids.set(id, value);
		return value;
	});
	for (const channel of channels)
		if (channel.parent_id && (channel.type === 4 || ids.get(channel.parent_id)?.type !== 4))
			throw new Error('Template channels must refer to a valid parent category');
	return channels.sort(
		(a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || (a.position || 0) - (b.position || 0),
	);
}
