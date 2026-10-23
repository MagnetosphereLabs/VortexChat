// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import * as Modal from '@app/features/app/components/dialogs/Modal';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import { http } from '@app/features/platform/transport/RestTransport';
import { Button } from '@app/features/ui/button/Button';
import { Input } from '@app/features/ui/components/form/FormInput';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import { vortexOrigin } from './Rest.js';
import styles from './SpaceInvitations.module.css';

type Invitation = { id: string; name: string; sender: string; channels: number };
export function SpaceInvitationModal({ guildId, name }: { guildId: string; name: string }) {
	const [friends, setFriends] = useState<Array<{ username: string }>>([]);
	const [inviteLink, setInviteLink] = useState('');
	useEffect(() => {
		let active = true;
		void http
			.get<Array<{ type: number; user: { username: string } }>>('/users/@me/relationships')
			.then((response) => {
				if (active) setFriends(response.body.filter((item) => item.type === 1).map((item) => item.user));
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);
	const [username, setUsername] = useState(''),
		[status, setStatus] = useState(''),
		[busy, setBusy] = useState(false);
	return (
		<Modal.Root size="small" centered>
			<Modal.Header title={'Invite to ' + name} />
			<Modal.Content>
				<form
					id="vortex-space-invite"
					className={styles.form}
					onSubmit={async (event) => {
						event.preventDefault();
						setBusy(true);
						setStatus('');
						try {
							const invitation = (
								await http.post<{ id: string }>('/vortex/space-invites', {
									body: { guild_id: guildId, username: username.trim() },
								})
							).body;
							setInviteLink(
								new URL(
									'/channels/@me?server_invite=' + encodeURIComponent(invitation.id),
									new URL(RuntimeConfig.apiEndpoint).origin,
								).href,
							);
							setStatus('Invitation sent. They can accept it in their server invitations on the Friends page.');
							setUsername('');
						} catch (error) {
							setStatus(error instanceof Error ? error.message : 'The invitation could not be sent');
						} finally {
							setBusy(false);
						}
					}}
				>
					<p>
						Choose a friend or enter a username on this Vortex Node. The invitation shares encrypted server access only
						with that account.
					</p>
					{friends.length > 0 && (
						<div className={styles.friends} aria-label="Choose a friend">
							{friends.map((friend) => (
								<Button
									key={friend.username}
									compact
									variant="secondary"
									disabled={busy}
									onClick={() => setUsername(friend.username)}
								>
									@{friend.username}
								</Button>
							))}
						</div>
					)}
					<Input
						label="Username"
						required
						autoFocus
						autoComplete="off"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
					/>
					<p role="status" aria-live="polite">
						{status}
					</p>
					{inviteLink && (
						<label>
							Invitation link
							<input
								className={styles.inviteLink}
								readOnly
								value={inviteLink}
								onFocus={(event) => event.target.select()}
							/>
							<small>
								This link opens the invited account’s server invitations. It grants no access to anyone else.
							</small>
						</label>
					)}
				</form>
			</Modal.Content>
			<Modal.Footer>
				<Button variant="secondary" onClick={ModalCommands.pop}>
					Close
				</Button>
				<Button type="submit" form="vortex-space-invite" submitting={busy} disabled={!username.trim()}>
					Send invitation
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
}
export function SpaceInvitations({ showEmpty = false }: { showEmpty?: boolean } = {}) {
	const [items, setItems] = useState<Array<Invitation>>([]),
		[error, setError] = useState(''),
		[busy, setBusy] = useState(false);
	const enabled = Boolean(vortexOrigin(RuntimeConfig.apiEndpoint));
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const refresh = () => {
			void http
				.get<Array<Invitation>>('/vortex/space-invites')
				.then((response) => {
					if (active) setItems(response.body);
				})
				.catch(() => {});
		};
		refresh();
		const interval = setInterval(refresh, 10000);
		return () => {
			active = false;
			clearInterval(interval);
		};
	}, [enabled]);
	if (!items.length && !showEmpty) return null;
	async function respond(id: string, accept: boolean) {
		setBusy(true);
		setError('');
		try {
			await http.patch('/vortex/space-invites', { body: { id, accept } });
			setItems((items) => items.filter((item) => item.id !== id));
		} catch (error) {
			setError(error instanceof Error ? error.message : 'The invitation could not be updated');
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className={styles.invitations} aria-label="Server invitations">
			{showEmpty && (
				<>
					<h2>Your server invitations</h2>
					<p>Server owners invite your username on this Vortex Node. Accept a private invitation here to join.</p>
					{!items.length && <p>No pending invitations. New invitations appear here automatically.</p>}
				</>
			)}
			{items.map((item) => (
				<div className={styles.invitation} key={item.id}>
					<div className={styles.label}>
						<strong>{item.name}</strong>
						<span>@{item.sender} invited you to join</span>
					</div>
					<Button compact disabled={busy} onClick={() => void respond(item.id, true)}>
						Join server
					</Button>
					<Button compact variant="secondary" disabled={busy} onClick={() => void respond(item.id, false)}>
						Decline
					</Button>
				</div>
			))}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
