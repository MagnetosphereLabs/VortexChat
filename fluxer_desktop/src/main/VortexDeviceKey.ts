// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomBytes, hkdfSync} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {app, ipcMain, safeStorage} from 'electron';
import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';

/** Never permit Electron's plaintext Linux fallback for saved account credentials. */
export function deviceDatabaseKey(databasePath: string): string {
    if (!safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('Unlock your desktop keyring to save Vortex accounts securely');
    }
    const directory = dirname(databasePath);
    const file = join(directory, 'vortex-device-key');
    mkdirSync(directory, {recursive: true, mode: 0o700});
    let encrypted: Buffer;
    try {encrypted = readFileSync(file);} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        encrypted = safeStorage.encryptString(randomBytes(32).toString('hex'));
        try {writeFileSync(file, encrypted, {flag: 'wx', mode: 0o600});}
        catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
            encrypted = readFileSync(file);
        }
    }
    const key = safeStorage.decryptString(encrypted);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('The Vortex device key is invalid');
    return key;
}

export function registerVortexDeviceKey(): void {
    ipcMain.handle('vortex-device-key', (event, purpose: unknown) => {
        requirePrivilegedRendererDocumentSender(event, 'vortex-device-key');
        if (purpose !== 'account' && purpose !== 'local') throw new Error('Invalid device key purpose');
        const databaseKey = deviceDatabaseKey(join(app.getPath('userData'), 'desktop-app-store.sqlite3'));
        // The SQLCipher key never crosses IPC. Each renderer wrapping key has its own domain.
        const key = hkdfSync('sha256', Buffer.from(databaseKey, 'hex'),
            Buffer.from('Vortex Chat device storage v1'), Buffer.from(purpose), 32);
        return Buffer.from(key).toString('base64');
    });
}
