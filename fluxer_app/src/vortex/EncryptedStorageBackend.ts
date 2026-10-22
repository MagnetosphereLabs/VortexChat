// SPDX-License-Identifier: AGPL-3.0-or-later
import type {PersistentStorageBackend, AppStorageEntry} from '@app/features/platform/state/PersistentStorageBackend';
import {sealLocal, openLocal} from './LocalCipher.js';

export function encryptStorageBackend(backend: PersistentStorageBackend): PersistentStorageBackend {
    if (backend.kind === 'memory') return backend;
    const open = async (scope: string, key: string, entry: AppStorageEntry): Promise<AppStorageEntry> =>
        ({...entry, value: await openLocal(scope, key, entry.value)});
    return {
        kind: backend.kind,
        async load(scope) {
            const entries = await backend.load(scope);
            return new Map(await Promise.all([...entries].map(async ([key, entry]) => [key, await open(scope, key, entry)] as const)));
        },
        async get(scope, key) {
            const entry = await backend.get(scope, key);
            return entry === null ? null : open(scope, key, entry);
        },
        async set(scope, key, value) {await backend.set(scope, key, await sealLocal(scope, key, value));},
        delete: (scope, key) => backend.delete(scope, key),
        clearAllForScope: scope => backend.clearAllForScope(scope),
        clearAllExcept: keys => backend.clearAllExcept(keys),
        async setMany(writes) {
            await backend.setMany(await Promise.all(writes.map(async write => ({...write, value: await sealLocal(write.scope, write.key, write.value)}))));
        },
    };
}
