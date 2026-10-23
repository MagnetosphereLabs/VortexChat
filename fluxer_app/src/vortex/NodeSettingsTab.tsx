// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { http } from '@app/features/platform/transport/RestTransport';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import { Button } from '@app/features/ui/button/Button';
import {
	SettingsTabContainer,
	SettingsTabContent,
} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import { DatabaseIcon, GlobeIcon, HardDrivesIcon, ShieldCheckIcon, UsersIcon } from '@phosphor-icons/react';
import styles from './NodeSettingsTab.module.css';

type Policy = { title: string; signupUntil: number; createSpaces: string; maxUpload: number; chatQuota: number };
type NodeInfo = {
	owner: boolean;
	canInvite: boolean;
	username: string;
	media: boolean;
	policy: Policy;
	applications: { vault: boolean };
};
type Member = {
	id: string;
	username: string;
	owner: boolean;
	quota: number;
	invite: boolean;
	spaces: boolean;
	disabled: boolean;
};
type Storage = {
	used: number;
	diskTotal: number;
	diskFree: number;
	reserve: number;
	remaining: number;
	effectiveQuota: number;
	effectiveMaxUpload: number;
	protocolMaxUpload: number;
};
type Invitation = { id: string; name: string; sender: string; channels: number };
type Section = 'overview' | 'storage' | 'access' | 'accounts';
const GiB = 1024 ** 3;
const sections = [
	{ id: 'overview', label: 'Overview', icon: GlobeIcon },
	{ id: 'storage', label: 'Storage', icon: HardDrivesIcon },
	{ id: 'access', label: 'Access & invitations', icon: ShieldCheckIcon },
	{ id: 'accounts', label: 'Accounts', icon: UsersIcon },
] as const;
function bytes(value: number) {
	if (!Number.isFinite(value)) return 'Unavailable';
	for (const [unit, size] of [
		['TiB', 1024 ** 4],
		['GiB', GiB],
		['MiB', 1024 ** 2],
	] as const)
		if (value >= size) return `${(value / size).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
	return `${Math.max(0, value).toLocaleString()} bytes`;
}
function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return (
		<section className={styles.card}>
			<div className={styles.cardHeader}>
				<h2>{title}</h2>
				{description && <p>{description}</p>}
			</div>
			{children}
		</section>
	);
}
export default function NodeSettingsTab() {
	const [node, setNode] = useState<NodeInfo | null>(null),
		[policy, setPolicy] = useState<Policy | null>(null);
	const [storage, setStorage] = useState<Storage | null>(null),
		[users, setUsers] = useState<Array<Member>>([]),
		[invites, setInvites] = useState<Array<Invitation>>([]);
	const [section, setSection] = useState<Section>('overview'),
		[query, setQuery] = useState('');
	const [status, setStatus] = useState(''),
		[error, setError] = useState(false),
		[busy, setBusy] = useState(false),
		[loading, setLoading] = useState(true);
	const [registrationLink, setRegistrationLink] = useState('');
	const origin = new URL(RuntimeConfig.apiEndpoint).origin;
	async function refresh(resetDraft = false) {
		const info = (await http.get<NodeInfo>('/vortex/node')).body;
		setNode(info);
		if (resetDraft)
			setPolicy({
				title: info.policy.title || 'Vortex Node',
				signupUntil: info.policy.signupUntil || 0,
				createSpaces: info.policy.createSpaces || 'owner',
				maxUpload: info.policy.maxUpload ?? 0,
				chatQuota: info.policy.chatQuota ?? 0,
			});
		const [invitations, capacity, members] = await Promise.all([
			http.get<Array<Invitation>>('/vortex/space-invites'),
			info.owner ? http.get<Storage>('/vortex/storage') : null,
			info.owner ? http.get<{ users: Array<Member> }>('/vortex/users') : null,
		]);
		setInvites(invitations.body);
		setStorage(capacity?.body || null);
		setUsers(members?.body.users || []);
	}
	async function run(operation: () => Promise<void>, success: string, resetDraft = false) {
		setBusy(true);
		setStatus('');
		setError(false);
		try {
			await operation();
			await refresh(resetDraft);
			setStatus(success);
		} catch (cause) {
			setError(true);
			setStatus(cause instanceof Error ? cause.message : 'The request could not be completed. Try again.');
		} finally {
			setBusy(false);
		}
	}
	useEffect(() => {
		let active = true;
		void refresh(true)
			.catch((cause) => {
				if (active) {
					setError(true);
					setStatus(String(cause));
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);
	const dirty =
		policy &&
		node &&
		JSON.stringify(policy) !==
			JSON.stringify({
				title: node.policy.title || 'Vortex Node',
				signupUntil: node.policy.signupUntil || 0,
				createSpaces: node.policy.createSpaces || 'owner',
				maxUpload: node.policy.maxUpload ?? 0,
				chatQuota: node.policy.chatQuota ?? 0,
			});
	const visibleUsers = users.filter((user) =>
		`${user.username} ${user.owner ? 'administrator' : ''}`.toLowerCase().includes(query.toLowerCase()),
	);
	async function savePolicy() {
		if (!policy) return;
		await run(
			async () => {
				await http.patch('/vortex/node', { body: policy });
			},
			'Node settings saved.',
			true,
		);
	}
	if (node && !node.owner)
		return (
			<SettingsTabContainer>
				<SettingsTabContent>
					<p>Node management is available only to this Node’s administrator.</p>
				</SettingsTabContent>
			</SettingsTabContainer>
		);
	return (
		<SettingsTabContainer>
			<SettingsTabContent>
				<div className={styles.page}>
					<header className={styles.hero}>
						<div className={styles.nodeIcon}>
							<ShieldCheckIcon size={30} weight="duotone" />
						</div>
						<div className={styles.heroText}>
							<span className={styles.eyebrow}>VORTEX CHAT · CONNECTED NODE</span>
							<h1>{node?.policy.title || 'Your Vortex Node'}</h1>
							<span className={styles.origin}>{origin}</span>
						</div>
						<span className={styles.badge}>{node?.owner ? 'Administrator' : 'Member'}</span>
					</header>
					<p className={styles.intro}>
						Manage this Node’s access, accounts, and capacity. Your profile, sign-in security, and notifications live in
						account and app settings.
					</p>
					{node && (
						<nav className={styles.navigation} aria-label="Node management">
							{sections
								.filter((item) => node.owner || item.id === 'overview' || item.id === 'access')
								.map((item) => (
									<button
										key={item.id}
										type="button"
										aria-current={section === item.id ? 'page' : undefined}
										className={section === item.id ? styles.selected : ''}
										onClick={() => setSection(item.id)}
									>
										<item.icon size={18} />
										{item.label}
									</button>
								))}
						</nav>
					)}
					{(status || loading) && (
						<div role={error ? 'alert' : 'status'} aria-live="polite" className={error ? styles.error : styles.notice}>
							{status || 'Loading your Node…'}
							{error && !node && (
								<Button compact variant="secondary" onClick={() => void run(async () => {}, 'Connected.')}>
									Retry
								</Button>
							)}
						</div>
					)}
					{section === 'overview' && node && (
						<>
							<div className={styles.stats}>
								<div>
									<span>Connection</span>
									<strong>Connected</strong>
									<small>{new URL(origin).hostname}</small>
								</div>
								<div>
									<span>Account</span>
									<strong>@{node.username}</strong>
									<small>{node.owner ? 'Node administrator' : 'Standard member'}</small>
								</div>
								<div>
									<span>Encrypted calls</span>
									<strong>{node.media ? 'Available' : 'Not configured'}</strong>
									<small>Voice, video & screen sharing</small>
								</div>
							</div>
							<Card
								title="Private conversations, familiar experience"
								description="Vortex Chat encrypts messages, calls, and attachments on participants’ devices."
							>
								<div className={styles.privacy}>
									<ShieldCheckIcon size={24} />
									<p>
										Node administrators control membership and storage. Administrative access does not grant private
										conversation keys. The Node still handles routing and connection metadata.
									</p>
								</div>
							</Card>
							<Card title="This Node" description="The address above is the server your account is connected to.">
								<dl className={styles.details}>
									<div>
										<dt>Application</dt>
										<dd>Vortex Chat</dd>
									</div>
									<div>
										<dt>Public registration</dt>
										<dd>
											{node.policy.signupUntil > Date.now() / 1000
												? `Open until ${new Date(node.policy.signupUntil * 1000).toLocaleDateString()}`
												: 'Invitation required'}
										</dd>
									</div>
									<div>
										<dt>Server creation</dt>
										<dd>
											{node.policy.createSpaces === 'everyone'
												? 'Everyone'
												: node.policy.createSpaces === 'selected'
													? 'Selected accounts'
													: 'Administrator'}
										</dd>
									</div>
									{storage && (
										<div>
											<dt>File size available now</dt>
											<dd>{bytes(storage.effectiveMaxUpload)}</dd>
										</div>
									)}
								</dl>
								{node.applications.vault && (
									<a className={styles.link} href={origin + '/vault'} target="_blank" rel="noreferrer">
										Open Vortex Vault ↗
									</a>
								)}
							</Card>
						</>
					)}
					{section === 'storage' && node?.owner && policy && (
						<>
							<Card
								title="Storage & capacity"
								description="Calculated from the disk that holds this Node’s data, with room reserved for the operating system and transfers already in progress."
							>
								{storage ? (
									<>
										<div className={styles.capacity}>
											<DatabaseIcon size={28} />
											<div>
												<strong>{bytes(storage.used)}</strong>
												<span> Chat data and pending uploads</span>
											</div>
											<Button
												compact
												variant="secondary"
												disabled={busy}
												onClick={() => void run(async () => {}, 'Capacity refreshed.')}
											>
												Refresh
											</Button>
										</div>
										<progress
											className={styles.meter}
											max={Math.max(storage.effectiveQuota, 1)}
											value={storage.used}
											aria-label="Chat storage used"
										/>
										<div className={styles.stats}>
											<div>
												<span>Available to Chat</span>
												<strong>{bytes(storage.remaining)}</strong>
											</div>
											<div>
												<span>Disk capacity</span>
												<strong>{bytes(storage.diskTotal)}</strong>
											</div>
											<div>
												<span>Protected reserve</span>
												<strong>{bytes(storage.reserve)}</strong>
											</div>
										</div>
										<p className={styles.hint}>
											Vault and other applications share this disk. Their usage and pending transfers reduce the
											capacity available to Chat.
										</p>
									</>
								) : (
									<p>Capacity details are unavailable on this Node version. Update the backend and refresh.</p>
								)}
							</Card>
							<Card
								title="Upload & storage limits"
								description="Automatic limits adapt to available space. You can set a lower cap for this Node."
							>
								<form
									className={styles.form}
									onSubmit={(event) => {
										event.preventDefault();
										void savePolicy();
									}}
								>
									<label className={styles.toggle}>
										<input
											type="checkbox"
											checked={policy.maxUpload === 0}
											onChange={(event) =>
												setPolicy({
													...policy,
													maxUpload: event.target.checked ? 0 : Math.min(storage?.effectiveMaxUpload || GiB, 100 * GiB),
												})
											}
										/>
										<span>
											<strong>Automatic file size</strong>
											<small>
												Use available capacity, up to the 100 GiB encrypted-transfer limit. Account and server
												allowances also apply.
											</small>
										</span>
									</label>
									{policy.maxUpload !== 0 && (
										<label className={styles.field}>
											Maximum size per file (GiB)
											<input
												required
												type="number"
												min={1 / GiB}
												max="100"
												step="any"
												value={policy.maxUpload / GiB}
												onChange={(event) =>
													setPolicy({ ...policy, maxUpload: Math.round(Number(event.target.value) * GiB) })
												}
											/>
										</label>
									)}
									<label className={styles.toggle}>
										<input
											type="checkbox"
											checked={policy.chatQuota === 0}
											onChange={(event) =>
												setPolicy({
													...policy,
													chatQuota: event.target.checked
														? 0
														: Math.max(GiB, Math.ceil((storage?.effectiveQuota || GiB) / GiB) * GiB),
												})
											}
										/>
										<span>
											<strong>Use available disk capacity for Chat</strong>
											<small>
												Automatically adapt as the disk fills or expands. The protected reserve stays in place.
											</small>
										</span>
									</label>
									{policy.chatQuota !== 0 && (
										<label className={styles.field}>
											Total Chat allowance (GiB)
											<input
												required
												type="number"
												min={1 / GiB}
												max={9007199254740991 / GiB}
												step="any"
												value={policy.chatQuota / GiB}
												onChange={(event) =>
													setPolicy({ ...policy, chatQuota: Math.round(Number(event.target.value) * GiB) })
												}
											/>
										</label>
									)}
									<div className={styles.actions}>
										<span>Lowering a limit preserves existing files.</span>
										<Button type="submit" disabled={busy || !dirty} submitting={busy}>
											Save changes
										</Button>
									</div>
								</form>
							</Card>
						</>
					)}
					{section === 'access' && node && (
						<>
							{node.owner && policy && (
								<Card title="Node identity & access" description="These settings apply to every account on this Node.">
									<form
										className={styles.form}
										onSubmit={(event) => {
											event.preventDefault();
											void savePolicy();
										}}
									>
										<label className={styles.field}>
											Node name
											<input
												required
												maxLength={80}
												value={policy.title}
												onChange={(event) => setPolicy({ ...policy, title: event.target.value })}
											/>
										</label>
										<label className={styles.field}>
											Who can create servers?
											<select
												value={policy.createSpaces}
												onChange={(event) => setPolicy({ ...policy, createSpaces: event.target.value })}
											>
												<option value="owner">Administrator only</option>
												<option value="selected">Selected accounts</option>
												<option value="everyone">Everyone</option>
											</select>
											<small>Manage individual permissions in Accounts.</small>
										</label>
										<label className={styles.toggle}>
											<input
												type="checkbox"
												checked={policy.signupUntil > Date.now() / 1000}
												onChange={(event) =>
													setPolicy({
														...policy,
														signupUntil: event.target.checked ? Math.floor(Date.now() / 1000) + 30 * 86400 : 0,
													})
												}
											/>
											<span>
												<strong>Allow public registration</strong>
												<small>
													{policy.signupUntil > Date.now() / 1000
														? `Closes ${new Date(policy.signupUntil * 1000).toLocaleString()}. Disabling requires an invitation for new accounts.`
														: 'Enable for 30 days. Existing accounts can always sign in.'}
												</small>
											</span>
										</label>
										<div className={styles.actions}>
											<span>{dirty ? 'You have unsaved changes.' : 'Settings are up to date.'}</span>
											<Button type="submit" disabled={busy || !dirty} submitting={busy}>
												Save changes
											</Button>
										</div>
									</form>
								</Card>
							)}
							{node.canInvite && (
								<Card
									title="Invite someone to this Node"
									description="A registration link creates one account and expires after 24 hours. Server membership is granted separately."
								>
									<Button
										disabled={busy}
										onClick={() =>
											void run(async () => {
												const invitation = (
													await http.post<{ secret: string }>('/vortex/invite', { body: { uses: 1, seconds: 86400 } })
												).body;
												setRegistrationLink(
													origin + '/register?registration_url=' + encodeURIComponent(invitation.secret),
												);
											}, 'Registration invitation created.')
										}
									>
										Create registration link
									</Button>
									{registrationLink && (
										<label className={styles.field}>
											Private registration link
											<input readOnly value={registrationLink} onFocus={(event) => event.target.select()} />
											<small>Share only with the person you are inviting.</small>
										</label>
									)}
								</Card>
							)}
							<Card title="Server invitations" description="Server invitations are encrypted for the invited account.">
								{invites.length === 0 ? (
									<p className={styles.empty}>You’re all caught up. No pending invitations.</p>
								) : (
									invites.map((invite) => (
										<div key={invite.id} className={styles.invitation}>
											<div>
												<strong>{invite.name}</strong>
												<small>
													From @{invite.sender} · {invite.channels} channels
												</small>
											</div>
											<Button
												compact
												disabled={busy}
												onClick={() =>
													void run(async () => {
														await http.patch('/vortex/space-invites', { body: { id: invite.id, accept: true } });
													}, 'Server joined.')
												}
											>
												Join
											</Button>
											<Button
												compact
												disabled={busy}
												variant="secondary"
												onClick={() =>
													void run(async () => {
														await http.patch('/vortex/space-invites', { body: { id: invite.id, accept: false } });
													}, 'Invitation declined.')
												}
											>
												Decline
											</Button>
										</div>
									))
								)}
							</Card>
						</>
					)}
					{section === 'accounts' && node?.owner && (
						<Card
							title="Accounts"
							description="Manage access and encrypted storage allowances. These controls do not reveal private messages or content keys."
						>
							<label className={styles.field}>
								Find an account
								<input
									type="search"
									placeholder="Search by username"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</label>
							<p className={styles.hint}>
								{users.length} accounts · {users.filter((user) => user.disabled).length} disabled
							</p>
							{visibleUsers.map((user) =>
								user.owner ? (
									<div key={user.id} className={styles.owner}>
										<strong>@{user.username}</strong>
										<span className={styles.badge}>Administrator</span>
									</div>
								) : (
									<AccountRow
										key={user.id}
										member={user}
										busy={busy}
										save={(value) =>
											run(async () => {
												await http.patch('/vortex/users', { body: { ...value, user: value.id } });
											}, `Settings saved for @${user.username}.`)
										}
									/>
								),
							)}
							{!visibleUsers.length && <p className={styles.empty}>No accounts match your search.</p>}
						</Card>
					)}
				</div>
			</SettingsTabContent>
		</SettingsTabContainer>
	);
}
function AccountRow({
	member,
	busy,
	save,
}: {
	member: Member;
	busy: boolean;
	save: (member: Member) => Promise<void>;
}) {
	const [value, setValue] = useState(member);
	useEffect(() => setValue(member), [member]);
	const changed = JSON.stringify(value) !== JSON.stringify(member);
	return (
		<details className={styles.account}>
			<summary>
				<span>
					<strong>@{member.username}</strong>
					<small>{bytes(member.quota)} allowance</small>
				</span>
				<span className={member.disabled ? styles.disabledBadge : styles.badge}>
					{member.disabled ? 'Disabled' : 'Active'}
				</span>
			</summary>
			<form
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault();
					void save(value);
				}}
			>
				<label className={styles.field}>
					Storage allowance (GiB)
					<input
						required
						type="number"
						min="0"
						max="1024"
						step="any"
						value={value.quota / GiB}
						onChange={(event) => setValue({ ...value, quota: Math.round(Number(event.target.value) * GiB) })}
					/>
					<small>An allowance of 0 prevents new uploads and messages. Existing encrypted history is retained.</small>
				</label>
				<label className={styles.toggle}>
					<input
						type="checkbox"
						checked={value.invite}
						onChange={(event) => setValue({ ...value, invite: event.target.checked })}
					/>
					<span>Create registration invitations</span>
				</label>
				<label className={styles.toggle}>
					<input
						type="checkbox"
						checked={value.spaces}
						onChange={(event) => setValue({ ...value, spaces: event.target.checked })}
					/>
					<span>Create servers when access is limited to selected accounts</span>
				</label>
				<label className={styles.toggle}>
					<input
						type="checkbox"
						checked={value.disabled}
						onChange={(event) => setValue({ ...value, disabled: event.target.checked })}
					/>
					<span>
						<strong>Disable account</strong>
						<small>
							Revokes active sign-ins and conversation access. Re-enabling does not automatically restore memberships.
						</small>
					</span>
				</label>
				<div className={styles.actions}>
					<span>{changed ? 'Unsaved account changes' : ''}</span>
					<Button type="submit" disabled={busy || !changed} variant="secondary">
						Save account
					</Button>
				</div>
			</form>
		</details>
	);
}
