# Vortex Chat client compatibility

The web app and Linux app share the React renderer and Vortex protocol adapter.
A visible upstream control is not evidence that its operation is implemented.
The adapter must reject unsupported changes before modifying encrypted state.

| Experience | Vortex integration |
| --- | --- |
| Login and two-factor authentication | Vortex OPAQUE account restoration and TOTP. Node account security manages password changes, authenticator enrollment/recovery codes and passkeys. Passkeys require browser PRF support on the Node website; desktop users can open that website from settings. |
| Registration | Node policy controls public registration. Both `registration_url` and legacy `invite` links are accepted; the Node validates invitation expiry and use counts. |
| Friends and direct messages | Node relationships, accepted-friendship checks, encrypted conversations and retained history. |
| Servers | Encrypted Space metadata is presented as servers. Creation, renaming, deletion, channel categories and private account-addressed invitations are integrated. |
| Joining a server | Pending encrypted invitations appear in the join screen and Friends page. The inviter can select a friend or enter a Node username. Paste links into Join server or open their private invitation cards in chat. Signed-out visitors are asked to sign in; only the invited account can decrypt and accept. |
| Text, voice and announcement channels | Creation and settings preserve their type in encrypted metadata. Text channels can be converted to announcements and back. Announcement publishing to external followers is not implemented. |
| Custom emoji | Legacy message descriptors and custom reactions decrypt through the authenticated attachment path. Published server emoji populate the picker. Upload, rename, clone and removal use encrypted catalog events with server permission checks. |
| Emoji between conversations | Referenced images are uploaded encrypted for the destination conversation. Image keys and names remain inside encrypted events. A missing image retains a readable name. |
| Node-wide emoji catalog | The existing signed, recipient-encrypted catalog populates desktop and mobile pickers. Only the Node administrator can add/remove Node-wide emoji and stickers, from a picker or Node management. New accounts receive catalog keys when the publisher next synchronizes. |
| Storage | Effective limits follow available filesystem capacity, pending Chat/Vault reservations and the protected reserve. Optional Node caps and account/server allowances remain enforced. The transfer protocol currently caps plaintext files at 100 GiB. |
| Node management | Visible only to the authenticated Node administrator. Backend authorization remains authoritative. Account security and preferences remain available to standard users. |
| Notifications | Existing native, browser and service-worker delivery paths remain. OS notifications use generic encrypted-activity text; content and sender imagery are excluded. Background delivery still depends on browser/OS permissions. |
| Discord templates | Role-free layouts containing text, voice, category and announcement channels can be imported. Roles, permission overwrites and unsupported limits are rejected before server creation. Failed layout creation attempts remove the newly created server. |
| Roles, permission editing, moderation and private-channel UI | The Node has membership/permission operations, but complete upstream editor compatibility is still pending. Unsupported changes must not silently produce public channels. |
| Stickers | Node-wide and server catalogs, upload, metadata editing, removal and encrypted sending. Raster PNG, WebP and GIF images use local decrypted media. |
| Profiles | Existing encrypted avatars and profiles load locally. Display name, avatar, banner, biography, pronouns and colors save through the Node adapter. Profile audience settings select friends/shared server members; recipient removal affects newly published versions. |
| Communication privacy | The Node enforces friend request and private group addition preferences, blocks and call alert policy. Direct messages and one-to-one calls require an accepted friendship. |
| Voice messages | Signed encrypted attachments retain their audio MIME type, duration and waveform and play from local decrypted blobs within the preview budget. |
| Layout and Vault | Narrow desktop windows use the responsive navigation layout. Mobile calls avoid desktop overlay positioning. Same-origin Vault Chat embedding is permitted; external framing remains blocked. |
| Threads, forums, polls, bots and webhooks | Additional adapter/backend work is required. No plaintext compatibility fallback is permitted. |
| Branding | Vortex Chat wordmark, application mark, Linux icons, splash, web install manifest and English server terminology. Upstream copyright and license notices remain. Other locale terminology and future native platform artwork require separate review. |

## Security boundaries

Node administration does not grant conversation membership or decryption keys.
Files, custom emoji, messages and calls retain their participant-controlled
cryptographic paths. The Node still sees routing and connection metadata.

Only authenticated `emoji` catalog events can publish or remove server emoji;
an ordinary encrypted message cannot impersonate a catalog management event.
Decrypted image lookups are isolated by Node origin and authenticated account,
including when multiple accounts remain connected.
Removing an emoji from the picker does not erase previously sent encrypted
images or history from participants' devices.

There has not been an independent security audit. Browser-host trust, identity
verification, recovery, device lifecycle and reproducible crypto builds remain
separate qualification work. Federation is not enabled by these integrations.

## Building a matching web and Linux client

Use `bash "$HOME/VortexChat-Local/scripts/update-local.sh"` from the existing
configured PC checkout. Keep that checkout on `vortex/integration-20261022`.
The combined updater builds both clients, updates the existing Node preview
backend if needed, then activates the matching web client. It reuses connection
settings and caches. A later standalone backend update can select an older
published web client, so use the combined updater for local source iterations.
