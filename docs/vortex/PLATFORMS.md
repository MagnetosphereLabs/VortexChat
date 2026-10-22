# Platform implementation

## One web renderer for browsers and desktop

`fluxer_app` contains the interface and Vortex protocol adapter. Electron packages that same renderer for Linux, Windows and macOS. Shared features belong in the adapter or UI, not in separate platform copies. The desktop layer owns keyring access, protected local storage, file saving, capture, notifications and packaging.

Linux is the initial native target. Windows and macOS retain their upstream integrations, but still need Vortex release workflows, application identifiers, signing, update feeds and native acceptance testing. macOS builds require a macOS runner; notarization and App Store distribution require the publisher’s Apple credentials. Windows signed installers require the publisher’s signing configuration. No signing secrets belong in source control.

## Flutter mobile is a separate client

[VortexChatMobile](https://github.com/MagnetosphereLabs/VortexChatMobile) and [VortexChatDartSDK](https://github.com/MagnetosphereLabs/VortexChatDartSDK) are separate from the React renderer. The upstream Flutter client is a beta and does not become a Vortex client by changing its API URL.

Implement one native protocol library used by both iOS and Android. It must match the web client’s OPAQUE exchange, device identity/certificates, signed key packages, MLS membership transitions, archive key format and attachment chunk AAD exactly. Recover and review the complete crypto wrapper source before producing native bindings. Share protocol fixtures and cross-client test vectors with `fluxer_app/src/vortex`; never invent a second wire format for mobile.

Expose that library through a small Dart service with account unlock, conversation state, encrypt/decrypt, membership transitions and media-key events. The Dio/gateway adapter should project decrypted local models to the existing Flutter screens. It must intercept message and file operations before network serialization; the generated Fluxer REST client alone is unsuitable.

Use Android Keystore and iOS Keychain for wrapping keys. Encrypted databases and attachments need versioned migrations, crash recovery and explicit backup policy. Credentials, roots and message text must be excluded from analytics and crash reports.

Set Vortex application IDs consistently across Android activities, iOS app groups, share/broadcast extensions, keychain groups, URL schemes and push entitlements. Add APK/AAB and iOS archive workflows only after the crypto interoperability checks pass. Signing and store credentials are configured through repository secrets and protected release environments.

## Push and background calls

Use an opaque wakeup reference for APNs, FCM and UnifiedPush. The device fetches ciphertext from its selected Node and decrypts locally. A relay must not receive names, conversation titles, message text, file names or content keys. Tokens must be scoped to the device and Node, revocable and rotated on logout.

Test delivery, deduplication, missed calls and reconnect while the device is locked, suspended, offline and restored from backup. iOS background execution and call notifications impose platform-specific constraints; reusing the UI does not remove that work.

## Keeping forks maintainable

Pin tested commits across repositories. Update shared interfaces and protocol version checks before publishing a new client/Node pair. Keep changes concentrated in the Vortex adapter, native security boundary, installer and release configuration. Review upstream fixes individually; do not automatically merge upstream authentication, storage, telemetry or update-system changes into the encrypted client.
