// SPDX-License-Identifier: AGPL-3.0-or-later
import {useEffect, useState} from 'react';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {http} from '@app/features/platform/transport/RestTransport';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import * as AvatarUtils from '@app/features/user/utils/AvatarUtils';
import type {FlatEmoji} from '@app/features/emoji/types/EmojiTypes';
import {GuildSticker} from '@app/features/expressions/models/GuildSticker';
import {vortexOrigin} from './Rest.js';
import styles from './NodeExpressionsPanel.module.css';
type Expression = {id: string; name: string; animated: boolean; description: string; tags: Array<string>};
type Catalog = {emojis: Array<Expression>; stickers: Array<Expression>};
export function NodeExpressionsPanel({
	kind = 'emoji',
	manage = false,
	search = '',
	onEmoji,
	onSticker,
}: {
	kind?: 'emoji' | 'sticker';
	manage?: boolean;
	search?: string;
	onEmoji?: (emoji: FlatEmoji, shiftKey?: boolean) => void;
	onSticker?: (sticker: GuildSticker, shiftKey?: boolean) => void;
}) {
	const [catalog, setCatalog] = useState<Catalog>({emojis: [], stickers: []}),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[editing, setEditing] = useState(false),
		[name, setName] = useState(''),
		[type, setType] = useState<'emoji' | 'sticker'>(kind);
	const enabled = !!vortexOrigin(RuntimeConfig.apiEndpoint),
		owner = Users.getCurrentUser()?.vortexNodeOwner === true;
	async function load() {
		const response = await http.get<Catalog>('/vortex/expressions');
		setCatalog(response.body);
	}
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void http
			.get<Catalog>('/vortex/expressions')
			.then((response) => {
				if (active) setCatalog(response.body);
			})
			.catch((cause) => {
				if (active) setError(String(cause.message || cause));
			});
		return () => {
			active = false;
		};
	}, [enabled]);
	if (!enabled) return null;
	const all = manage
		? [
				...catalog.emojis.map((item) => ({...item, kind: 'emoji' as const})),
				...catalog.stickers.map((item) => ({...item, kind: 'sticker' as const})),
			]
		: (kind === 'emoji' ? catalog.emojis : catalog.stickers).map((item) => ({...item, kind}));
	const items = all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
	const url = (item: Expression & {kind: 'emoji' | 'sticker'}) =>
		item.kind === 'emoji' ? AvatarUtils.getEmojiURL(item) : AvatarUtils.getStickerURL(item);
	return (
		<section className={styles.panel} aria-label="Node emoji and stickers">
			<div className={styles.header}>
				<strong>{manage ? 'Node emoji & stickers' : kind === 'emoji' ? 'Node emoji' : 'Node stickers'}</strong>
				{owner && (
					<Button compact variant="secondary" disabled={busy} onClick={() => setEditing(!editing)}>
						Add {manage ? 'expression' : kind}
					</Button>
				)}
			</div>
			{manage && (
				<p>
					Available across this Node’s conversations. Server-specific emoji and stickers stay in their server settings.
				</p>
			)}
			{!items.length && (
				<p className={styles.empty}>
					{search ? 'No matching Node expressions.' : `No Node ${kind === 'emoji' ? 'emoji' : 'stickers'} yet.`}
				</p>
			)}
			<div className={styles.grid}>
				{items.map((item) => (
					<div className={styles.item} key={item.id}>
						<button
							type="button"
							disabled={busy}
							title={item.name}
							aria-label={item.name}
							onClick={(event) => {
								if (item.kind === 'emoji')
									onEmoji?.(
										{
											id: item.id,
											name: item.name,
											uniqueName: item.name,
											allNamesString: item.name,
											animated: item.animated,
											url: url(item),
											managed: false,
											useSpriteSheet: false,
										},
										event.shiftKey,
									);
								else onSticker?.(new GuildSticker('', item), event.shiftKey);
							}}
						>
							<img src={url(item)} alt={item.name} loading="lazy" />
						</button>
						{manage && (
							<>
								<span>{item.name}</span>
								<button
									type="button"
									disabled={busy}
									aria-label={'Remove ' + item.name}
									onClick={async () => {
										setBusy(true);
										setError('');
										try {
											await http.delete('/vortex/expressions/' + item.id);
											await load();
										} catch (cause) {
											setError(cause instanceof Error ? cause.message : String(cause));
										} finally {
											setBusy(false);
										}
									}}
								>
									Remove
								</button>
							</>
						)}
					</div>
				))}
			</div>
			{editing && owner && (
				<form className={styles.form} onSubmit={(event) => event.preventDefault()}>
					<label>
						Name
						<input
							required
							maxLength={32}
							pattern="[A-Za-z0-9_-]{1,32}"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					{manage && (
						<label>
							Type
							<select value={type} onChange={(event) => setType(event.target.value as 'emoji' | 'sticker')}>
								<option value="emoji">Emoji</option>
								<option value="sticker">Sticker</option>
							</select>
						</label>
					)}
					<label>
						Image
						<input
							type="file"
							accept="image/png,image/webp,image/gif"
							disabled={busy || !name.trim()}
							onChange={async (event) => {
								const file = event.target.files?.[0];
								if (!file) return;
								setError('');
								if (file.size > 256 * 1024) {
									setError('Choose a PNG, WebP or GIF up to 256 KiB');
									return;
								}
								setBusy(true);
								try {
									const image = await new Promise<string>((resolve, reject) => {
										const reader = new FileReader();
										reader.onload = () => resolve(String(reader.result));
										reader.onerror = reject;
										reader.readAsDataURL(file);
									});
									await http.post('/vortex/expressions', {
										body: {name: name.trim(), kind: manage ? type : kind, image},
									});
									await load();
									setName('');
									setEditing(false);
								} catch (cause) {
									setError(cause instanceof Error ? cause.message : String(cause));
								} finally {
									setBusy(false);
								}
							}}
						/>
						<small>PNG, WebP or GIF · up to 256 KiB</small>
					</label>
				</form>
			)}
			{busy && <p role="status">Saving encrypted expression…</p>}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</section>
	);
}
