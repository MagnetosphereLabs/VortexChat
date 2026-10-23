// SPDX-License-Identifier: AGPL-3.0-or-later
import {ShieldCheckIcon} from '@phosphor-icons/react';
import styles from './NodeConnectionNotice.module.css';
export function NodeConnectionNotice({endpoint, register = false}: {endpoint: string; register?: boolean}) {
	const url = new URL(endpoint);
	return (
		<div className={styles.notice}>
			<ShieldCheckIcon size={25} aria-hidden="true" />
			<div>
				<span className={styles.label}>{register ? 'Create your account on' : 'Connected to your Vortex Node'}</span>
				<strong>{url.host}</strong>
				<span className={styles.description}>
					Your account belongs to this Node.{' '}
					{register
						? 'Choose a username and keep your password safe.'
						: 'Use the username and password you created here.'}
				</span>
			</div>
		</div>
	);
}
