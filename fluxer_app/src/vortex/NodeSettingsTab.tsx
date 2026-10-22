// SPDX-License-Identifier: AGPL-3.0-or-later
import {useEffect, useState} from 'react';
import {http} from '@app/features/platform/transport/RestTransport';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Button} from '@app/features/ui/button/Button';
import {SettingsTabContainer, SettingsTabContent, SettingsTabSection} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import styles from './NodeSettingsTab.module.css';

type Policy = {title: string; signupUntil: number; createSpaces: string; maxUpload: number; chatQuota: number};
type NodeInfo = {owner: boolean; canInvite: boolean; policy: Policy; applications: {vault: boolean}};
type Member = {id: string; username: string; owner: boolean; quota: number; invite: boolean; spaces: boolean; disabled: boolean};
type Space = {id: string; name: string; canInvite: boolean};
type Invitation = {id: string; name: string; sender: string; channels: number};
const GiB = 1024 ** 3;

export default function NodeSettingsTab() {
    const [node, setNode] = useState<NodeInfo | null>(null);
    const [policy, setPolicy] = useState<Policy | null>(null);
    const [users, setUsers] = useState<Array<Member>>([]);
    const [spaces, setSpaces] = useState<Array<Space>>([]);
    const [invites, setInvites] = useState<Array<Invitation>>([]);
    const [space, setSpace] = useState('');
    const [username, setUsername] = useState('');
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [registrationLink, setRegistrationLink] = useState('');
    async function refresh() {
        const info = (await http.get<NodeInfo>('/vortex/node')).body;
        setNode(info);setPolicy(info.policy);
        setSpaces((await http.get<Array<Space>>('/vortex/spaces')).body);
        setInvites((await http.get<Array<Invitation>>('/vortex/space-invites')).body);
        if (info.owner) setUsers((await http.get<{users: Array<Member>}>('/vortex/users')).body.users);
    }
    async function run(operation: () => Promise<void>, success: string) {
        setBusy(true);setStatus('');
        try {await operation();await refresh();setStatus(success);}
        catch (error) {setStatus(error instanceof Error ? error.message : 'The request could not be completed');}
        finally {setBusy(false);}
    }
    useEffect(() => {void refresh().catch(error => setStatus(String(error)));}, []);
    const origin = new URL(RuntimeConfig.apiEndpoint).origin;
    return <SettingsTabContainer><SettingsTabContent>
        <SettingsTabSection title="Vortex Node" description="Your account, invitations, and the settings for this self-hosted Node.">
            <p className={styles.origin}>{origin}</p>
            <p>Only conversation participants receive Chat keys. Node administrators manage access and storage.</p>
            {node?.applications.vault && <a className={styles.link} href={origin + '/vault'} target="_blank" rel="noreferrer">Open Vortex Vault</a>}
            <p role="status" aria-live="polite">{status || (node ? '' : 'Connecting to your Node…')}</p>
        </SettingsTabSection>
        <SettingsTabSection title="Space invitations">
            {invites.length === 0 && <p>No pending invitations.</p>}
            {invites.map(invite => <div key={invite.id} className={styles.row}>
                <div><strong>{invite.name}</strong><p>From @{invite.sender} · {invite.channels} channels</p></div>
                <Button disabled={busy} onClick={() => void run(async () => {await http.patch('/vortex/space-invites', {body: {id: invite.id, accept: true}});}, 'Joined Space')}>Join</Button>
                <Button disabled={busy} variant="secondary" onClick={() => void run(async () => {await http.patch('/vortex/space-invites', {body: {id: invite.id, accept: false}});}, 'Invitation declined')}>Decline</Button>
            </div>)}
            {spaces.some(item => item.canInvite) && <form className={styles.form} onSubmit={event => {event.preventDefault();void run(async () => {await http.post('/vortex/space-invites', {body: {space, username}});setUsername('');}, 'Encrypted invitation sent');}}>
                <label className={styles.field}>Space<select required value={space} onChange={event => setSpace(event.target.value)}><option value="">Choose a Space</option>{spaces.filter(item => item.canInvite).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className={styles.field}>Invite by username<input required value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" placeholder="Their username on this Node" /></label>
                <Button type="submit" disabled={busy}>Send invitation</Button>
            </form>}
        </SettingsTabSection>
        {node?.canInvite && <SettingsTabSection title="Invite someone to this Node" description="Create a registration link valid for one person for 24 hours.">
            <Button disabled={busy} onClick={() => void run(async () => {
                const invitation = (await http.post<{secret: string}>('/vortex/invite', {body: {uses: 1, seconds: 86400}})).body;
                setRegistrationLink(origin + '/register?invite=' + encodeURIComponent(invitation.secret));
            }, 'Registration link created')}>Create registration link</Button>
            {registrationLink && <label className={styles.field}>Registration link<input readOnly value={registrationLink} onFocus={event => event.target.select()} /></label>}
        </SettingsTabSection>}
        {node?.owner && policy && <>
            <SettingsTabSection title="Node administration" description="These controls apply to Chat. Vault keeps its own storage and encryption settings.">
                <form className={styles.form} onSubmit={event => {event.preventDefault();void run(async () => {await http.patch('/vortex/node', {body: policy});}, 'Node settings saved');}}>
                    <label className={styles.field}>Node name<input required maxLength={80} value={policy.title || ''} onChange={event => setPolicy({...policy, title: event.target.value})} /></label>
                    <label className={styles.row}><input type="checkbox" checked={policy.signupUntil > Date.now()/1000} onChange={event => setPolicy({...policy, signupUntil: event.target.checked ? Math.floor(Date.now()/1000)+30*86400 : 0})} />Allow public registration for 30 days</label>
                    <label className={styles.field}>Who can create Spaces<select value={policy.createSpaces || 'owner'} onChange={event => setPolicy({...policy, createSpaces: event.target.value})}><option value="owner">Node administrator</option><option value="selected">Selected accounts</option><option value="everyone">Everyone</option></select></label>
                    <label className={styles.field}>Maximum file size (GiB)<input type="number" min="0.001" max="100" step="0.001" value={policy.maxUpload/GiB} onChange={event => setPolicy({...policy, maxUpload: Math.round(Number(event.target.value)*GiB)})} /></label>
                    <label className={styles.field}>Total Chat storage (GiB, 0 for available disk space)<input type="number" min="0" step="1" value={policy.chatQuota/GiB} onChange={event => setPolicy({...policy, chatQuota: Math.round(Number(event.target.value)*GiB)})} /></label>
                    <Button type="submit" disabled={busy}>Save Node settings</Button>
                </form>
            </SettingsTabSection>
            <SettingsTabSection title="Accounts">
                {users.filter(user => !user.owner).map(user => <AccountRow key={user.id} member={user} busy={busy} save={value => run(async () => {await http.patch('/vortex/users', {body: {...value, user: value.id}});}, 'Account settings saved')} />)}
            </SettingsTabSection>
        </>}
    </SettingsTabContent></SettingsTabContainer>;
}
function AccountRow({member, busy, save}: {member: Member; busy: boolean; save: (member: Member) => Promise<void>}) {
    const [value, setValue] = useState(member);
    return <form className={styles.account} onSubmit={event => {event.preventDefault();void save(value);}}>
        <strong>@{member.username}</strong>
        <label className={styles.field}>Storage (GiB)<input type="number" min="0" max="1024" step="1" value={value.quota/GiB} onChange={event => setValue({...value, quota: Math.round(Number(event.target.value)*GiB)})} /></label>
        <label className={styles.row}><input type="checkbox" checked={value.invite} onChange={event => setValue({...value, invite: event.target.checked})} />Can invite accounts</label>
        <label className={styles.row}><input type="checkbox" checked={value.spaces} onChange={event => setValue({...value, spaces: event.target.checked})} />Can create Spaces</label>
        <label className={styles.row}><input type="checkbox" checked={value.disabled} onChange={event => setValue({...value, disabled: event.target.checked})} />Account disabled</label>
        <Button type="submit" disabled={busy} variant="secondary">Save account</Button>
    </form>;
}
