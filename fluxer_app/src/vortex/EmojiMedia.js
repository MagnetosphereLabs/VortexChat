// SPDX-License-Identifier: AGPL-3.0-or-later
// Only authenticated, locally decrypted image URLs enter this registry.
// Concurrent accounts and Nodes must never share decrypted media by image ID.
const media = new Map();
export function setEmojiMedia(session, id, url) {
	if (!url.startsWith('blob:')) throw new Error('Custom emoji require a local image');
	const origin = new URL(session.pair.url).origin;
	const userId = session.ids.get('user', session.pair.id);
	let entries = media.get(id);
	if (!entries) media.set(id, (entries = new Map()));
	entries.set(session, { origin, userId, url });
}
export function getEmojiMedia(id, origin, userId) {
	if (!origin || !userId) return null;
	for (const entry of media.get(id)?.values() || []) {
		if (entry.origin === origin && entry.userId === userId) return entry.url;
	}
	return null;
}
export function clearEmojiMedia(session) {
	for (const [id, entries] of media) {
		entries.delete(session);
		if (!entries.size) media.delete(id);
	}
}
export function emojiName(value) {
	return (
		String(value || 'emoji')
			.replace(/[^\p{L}\p{N}_-]/gu, '_')
			.slice(0, 32) || 'emoji'
	);
}
export function validEmojiFile(file) {
	return (
		!!file &&
		typeof file.id === 'string' &&
		!!file.id &&
		/^image\/(png|webp|gif|jpeg|avif)$/u.test(file.type) &&
		Number.isSafeInteger(file.size) &&
		file.size >= 0 &&
		file.size <= 1024 ** 2
	);
}
export function messageEmojiEntries(payload) {
	return Array.isArray(payload?.emojiMedia) ? payload.emojiMedia.slice(0, 100) : [];
}
export function messageEmojiFiles(payload) {
	const files = [...(Array.isArray(payload.files) ? payload.files : [])];
	if (validEmojiFile(payload.emoji?.file) && !files.some((file) => file?.id === payload.emoji.file.id))
		files.push(payload.emoji.file);
	return files;
}
