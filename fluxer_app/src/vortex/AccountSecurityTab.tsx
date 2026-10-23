// SPDX-License-Identifier: AGPL-3.0-or-later
import {useEffect, useState} from 'react';
import {BlockedUsersContent} from '@app/features/user/components/modals/tabs/BlockedUsersTab';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {SettingsTabContainer, SettingsTabContent} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import {http} from '@app/features/platform/transport/RestTransport';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import styles from './NodeSettingsTab.module.css';
type Key = {id: string; name: string; created: number; used: number};
export default function VortexAccountSecurityTab() {
	const [keys, setKeys] = useState<Array<Key>>([]),
		[password, setPassword] = useState(''),
		[code, setCode] = useState(''),
		[next, setNext] = useState(''),
		[confirm, setConfirm] = useState(''),
		[name, setName] = useState('My passkey'),
		[seed, setSeed] = useState(''),
		[recovery, setRecovery] = useState<Array<string>>([]),
		[status, setStatus] = useState(''),
		[error, setError] = useState(false),
		[busy, setBusy] = useState(false),
		[totp, setTotp] = useState(!!Users.getCurrentUser()?.mfaEnabled);
	const origin = new URL(RuntimeConfig.apiEndpoint).origin,
		user = Users.getCurrentUser();
	async function refresh() {
		setKeys((await http.get<{keys: Array<Key>}>('/vortex/account/passkeys')).body.keys);
	}
	useEffect(() => {
		void refresh().catch((cause) => {
			setError(true);
			setStatus(String(cause.message || cause));
		});
	}, []);
	async function run(operation: () => Promise<void>, message: string) {
		setBusy(true);
		setStatus('');
		setError(false);
		try {
			await operation();
			setStatus(message);
		} catch (cause) {
			setError(true);
			setStatus(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<SettingsTabContainer>
			<SettingsTabContent>
				<div className={styles.page}>
					<header className={styles.hero}>
						<div className={styles.heroText}>
							<span className={styles.eyebrow}>VORTEX NODE ACCOUNT</span>
							<h1>Sign-in & security</h1>
							<span className={styles.origin}>{origin}</span>
						</div>
					</header>
					<section id="account" className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Your account</h2>
							<p>
								@{user?.username} · {user?.vortexNodeOwner ? 'Node administrator' : 'Member'}
							</p>
						</div>
						<p>Your password, authenticator and passkeys protect this account on this Vortex Node.</p>
					</section>
					<section id="security" className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Confirm sensitive changes</h2>
							<p>Enter your current credentials before changing your password or passkeys.</p>
						</div>
						<div className={styles.form}>
							<label className={styles.field}>
								Current password
								<input
									type="password"
									autoComplete="current-password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
								/>
							</label>
							{totp && (
								<label className={styles.field}>
									Authenticator code
									<input
										inputMode="numeric"
										autoComplete="one-time-code"
										value={code}
										onChange={(event) => setCode(event.target.value)}
									/>
								</label>
							)}
						</div>
					</section>
					<section className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Password</h2>
							<p>Changing your password keeps your conversation keys and signs out your other sessions.</p>
						</div>
						<form
							className={styles.form}
							onSubmit={(event) => {
								event.preventDefault();
								void run(async () => {
									if (next !== confirm) throw new Error('The new passwords do not match');
									await http.post('/vortex/account/password', {body: {password, code, new_password: next}});
									setPassword('');
									setNext('');
									setConfirm('');
									setCode('');
								}, 'Password updated. Your encrypted conversations are retained.');
							}}
						>
							<label className={styles.field}>
								New password
								<input
									required
									type="password"
									autoComplete="new-password"
									minLength={15}
									maxLength={128}
									value={next}
									onChange={(event) => setNext(event.target.value)}
								/>
								<small>15–128 characters</small>
							</label>
							<label className={styles.field}>
								Confirm new password
								<input
									required
									type="password"
									autoComplete="new-password"
									value={confirm}
									onChange={(event) => setConfirm(event.target.value)}
								/>
							</label>
							<div className={styles.actions}>
								<Button type="submit" disabled={busy || !password} submitting={busy}>
									Update password
								</Button>
							</div>
						</form>
					</section>
					<section className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Two-factor authentication</h2>
							<p>{totp ? 'Your authenticator is enabled.' : 'Add an authenticator app to protect password sign-in.'}</p>
						</div>
						{!totp && !seed && (
							<Button
								disabled={busy}
								onClick={() =>
									void run(async () => {
										setSeed((await http.post<{seed: string}>('/users/@me/mfa/totp/start', {body: {}})).body.seed);
									}, 'Add the setup key to your authenticator app, then enter its code.')
								}
							>
								Set up authenticator
							</Button>
						)}
						{seed && (
							<>
								<p>Authenticator setup key</p>
								<code>{seed}</code>
								<p>Add this key to your authenticator using your Node username, then confirm below.</p>
							</>
						)}
						{(totp || seed) && (
							<div className={styles.form}>
								<label className={styles.field}>
									Authenticator code
									<input
										inputMode="numeric"
										autoComplete="one-time-code"
										value={code}
										onChange={(event) => setCode(event.target.value)}
									/>
								</label>
								<Button
									disabled={busy || !code}
									variant={totp ? 'danger' : 'primary'}
									onClick={() =>
										void run(
											async () => {
												if (totp) {
													await http.post('/users/@me/mfa/totp/disable', {body: {code}});
													setTotp(false);
													setRecovery([]);
												} else {
													const response = await http.post<{backup_codes: Array<{code: string}>}>(
														'/users/@me/mfa/totp/enable',
														{body: {code}},
													);
													setRecovery(response.body.backup_codes.map((item) => item.code));
													setTotp(true);
													setSeed('');
												}
												setCode('');
											},
											totp ? 'Authenticator disabled.' : 'Authenticator enabled. Save your recovery codes privately.',
										)
									}
								>
									{totp ? 'Disable authenticator' : 'Confirm authenticator'}
								</Button>
							</div>
						)}
						{recovery.length > 0 && (
							<div>
								<h3>Recovery codes</h3>
								<p>Store these privately. Each code can be used once.</p>
								<pre>{recovery.join('\n')}</pre>
							</div>
						)}
					</section>
					<section className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Passkeys</h2>
							<p>Use a supported passkey to sign in and unlock your encrypted account.</p>
						</div>
						{location.origin !== origin ? (
							<p>
								Manage passkeys on{' '}
								<a href={origin + '/settings/user?tab=account_security'} target="_blank" rel="noopener noreferrer">
									your Node website
								</a>
								.
							</p>
						) : (
							<div className={styles.form}>
								<label className={styles.field}>
									Passkey name
									<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
								</label>
								<Button
									disabled={busy || !password || !name.trim()}
									onClick={() =>
										void run(async () => {
											await http.post('/vortex/account/passkeys', {body: {password, code, name}});
											await refresh();
											setPassword('');
											setCode('');
										}, 'Passkey added.')
									}
								>
									Add passkey
								</Button>
							</div>
						)}
						{keys.map((key) => (
							<div className={styles.invitation} key={key.id}>
								<div>
									<strong>{key.name}</strong>
									<small>Added {new Date(key.created * 1000).toLocaleDateString()}</small>
								</div>
								<Button
									compact
									variant="secondary"
									disabled={busy || !password}
									onClick={() =>
										void run(async () => {
											await http.delete('/vortex/account/passkeys', {body: {id: key.id, password, code}});
											await refresh();
											setPassword('');
											setCode('');
										}, 'Passkey removed.')
									}
								>
									Remove
								</Button>
							</div>
						))}
					</section>
					<section id="blocked_users" className={styles.card}>
						<div className={styles.cardHeader}>
							<h2>Blocked accounts</h2>
							<p>Manage the accounts you have blocked on this Node.</p>
						</div>
						<BlockedUsersContent />
					</section>
					{user?.vortexNodeOwner && (
						<p className={styles.hint}>
							This is the Node administrator account. Account disable and deletion controls do not apply to it.
						</p>
					)}
					{status && (
						<p className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>
							{status}
						</p>
					)}
				</div>
			</SettingsTabContent>
		</SettingsTabContainer>
	);
}
