# Trying Vortex Chat

Install a matched Vortex Node and Vortex Chat release. The server installer installs the web client automatically. The Linux application is installed separately on your computer; it connects to the same HTTPS address and account.

## First connection

1. Open your Node's HTTPS domain in a current browser and sign in with the account created during Node setup.
2. In the Linux application, finish the welcome screens, choose **Add instance**, and enter that same Node address. Sign in with your Node account.
3. Open user settings and choose **Vortex Node**. The Node owner can manage registration, invitations, upload limits, storage allowances and account access there.
4. If Vault is enabled, open it through **Open Vortex Vault** in Node settings or at `/vault` on the Node domain.

Keep the desktop keyring unlocked. Vortex refuses to store account keys through a plaintext keyring fallback. After installation, run the application as your regular desktop user, without `sudo`.

Before other tests, open your user menu and switch to **Invisible**, then **Online**. The client should stay connected and continue sending messages. Repeat after a reload and check the status from the second account. An invisible account should appear offline to other users.

## Test with two accounts

Use separate browser profiles or a browser and the Linux application. A second tab in the same profile can share the first account's local storage.

1. In Node settings, create a registration link and open it in the second profile. Register a second account.
2. Add the second username as a friend, accept the request, and exchange direct messages.
3. Create a server and a text channel. Use **Invite** to send the second account a private invitation by username. Accept it from the Friends page, the Join server screen, or its invitation card.
4. Send messages from both accounts. Try a reply, edit, reaction, pin and saved message. Search for a distinctive word in a message.
5. Send a small image and a file. Check the image preview and download the file from the other account. Compare the downloaded file with the original.
6. Close and reopen the Linux app and reload the browser. Check that acknowledged messages and attachments remain available.
7. Temporarily disconnect one device from the network. Reconnect it and verify that delivery resumes without duplicated messages.

Private server invitations are addressed to an existing account on the same Node. Registration links create accounts; they do not automatically enroll the recipient in a server or give them its keys.

## Profiles, expressions and account security

Save an avatar, banner and biography, reload, and check them from a friend account. Change profile privacy and confirm a newly restricted version is unavailable to an account outside that audience. Add Node emoji and stickers as the administrator, then select and send them as a member. Upload a server sticker separately. Add and remove a custom reaction, wait for synchronization and reload the conversation.

Send a voice message and play it inline. Resize a desktop window to half-screen width and try a call on the phone website. Open Chat from Vault when Vault is enabled.

In Sign-in & security, change the Chat password and sign in again with the new password. Configure an authenticator and save the recovery codes. On a Node website with a PRF-capable browser/authenticator, add a passkey, sign out and use it to sign in. Password sign-in remains available. The administrator account has no self-disable or self-delete controls.

## Calls and screen sharing

Create a voice channel, join it from both accounts, and allow microphone access. Check mute, deafen, camera, disconnect and rejoin. Share a window or screen, enable shared audio when offered, and confirm the other participant receives both picture and sound.

For Linux, test the desktop session you use: GNOME, KDE, Cinnamon, COSMIC or another environment, with X11 or Wayland as appropriate. Capture permissions and audio routing involve the operating system's portal, PipeWire or PulseAudio services. Automated relay checks use generated media; they do not substitute for testing your actual microphone, display, webcam and speakers.

If calls connect but media does not arrive, check the media firewall ports printed by the Node installer. A hosting provider's external firewall must also allow them. The installer configures the Node services and an active UFW firewall, but cannot change a provider's control panel.

## Administration and updates

Try an upload below and above the configured maximum size. Test an account's storage allowance and the public registration setting. Keep a backup of the Node data and configuration before updating, and preserve client keys and account credentials.

Update the Node with its installed updater and the source reference supplied by the next matched release. Update Linux with:

```sh
sudo /opt/vortex-chat/update --release RELEASE_TAG
```

Close and reopen the desktop app after updating. Reload the browser to activate the Node's updated web client. Release candidates use explicit tags; the stable automatic update feed does not select prereleases.

## Reporting a problem

Include the release tag, distribution and version, desktop environment, X11/Wayland session, browser version, and the shortest steps that reproduce the problem. Describe whether it occurs with both accounts and whether reopening the app changes it. Remove session tokens, private message contents, credentials and encryption keys from any logs or screenshots you choose to share.

## Scope

The integration implements the shared web/Linux conversation experience, encrypted attachments, private invitations, local search, Node administration and the encrypted call transport. It does not yet implement every upstream Fluxer backend feature. Full role and permission editing, the complete moderation interface, threads/forums/polls, bots/webhooks and recovery-kit management need additional integration. Unsupported operations are rejected instead of being sent as plaintext or appearing to save successfully.

See [security boundaries](SECURITY.md) and [platform implementation](PLATFORMS.md). Windows, macOS, Android and iOS native releases require the platform work described there. Federation is outside this release.
