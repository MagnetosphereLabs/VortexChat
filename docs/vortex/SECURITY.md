# Security boundaries

## Keys and authentication

OPAQUE authenticates accounts and unlocks account secrets on the client. A bearer session token authorizes requests; it does not replace an encryption key. Conversation membership is authenticated, and the application refuses to send plaintext messages as an alternative when encryption is unavailable.

The initial integration preserves Node’s existing OpenMLS, archive encryption and chunked attachment format. The vendoring script pins the source bundle and verifies its digest before extracting WebAssembly and bindings. An independent review and complete reproducible source build of those crypto bindings remain release requirements; a pinned binary is not an audit.

Native desktop wrapping keys are derived from a key protected by the OS keyring. Plaintext fallback keyring modes are refused. Browser wrapping keys use non-extractable Web Crypto keys in device storage. Browser storage does not provide the same protection as a hardware-backed native key store.

## Who can read what

Participants decrypt messages, attachment contents and media locally. A Node operator who is not a participant is not automatically given conversation keys. Vault uses its own existing encrypted data storage; Chat does not reuse a Vault bucket or expose a Vault decryption key.

The Node still sees account identifiers, membership and authorization metadata, encrypted object sizes, network addresses, timing and delivery activity. These are not concealed by content encryption.

Removing a member revokes server access and causes future key rotation. It cannot erase plaintext or keys already copied by that member. The archive key history intentionally supports conversation history, so this format must not be described as providing complete forward secrecy for stored history.

## Client trust

A web client trusts the server that supplies its JavaScript. A compromised host can replace the web application even if stored messages remain encrypted. Installed clients reduce that exposure by bundling the renderer. Their release supply chain and local device still need to be trusted.

Identity keys currently use trust on first use with change detection. User-visible out-of-band identity verification and a more complete multi-device recovery policy remain necessary improvements.

Calls require E2EE and obtain media keys from the local conversation state, not from the relay. Signaling and routing metadata remain visible to the relay. Unsupported encryption must result in a failed connection, never an unencrypted call.

## Installation and updates

Release archives are pinned by SHA-256. Installers reject traversal paths, links and device files and activate only a validated installation. Checksums protect artifact integrity relative to the trusted release manifest; they do not protect against a compromised publisher account changing both. Repository access control, release signing/provenance and review are part of the security model.

Linux builds refuse launch switches that disable browser sandboxing. The installer configures the application’s sandbox helper and, where required, an application-specific AppArmor namespace permission. It never disables the global namespace policy.

## Notification privacy

Push services receive generic wakeups, not message text, attachment names or sender details. Private notification previews require authenticated local decryption and an explicit device setting. Push delivery metadata and device tokens remain sensitive operational data. Mobile delivery needs separate platform credentials and suspended-device testing before support is claimed.
