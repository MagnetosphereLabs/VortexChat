// SPDX-License-Identifier: AGPL-3.0-or-later

import {ExternalE2EEKeyProvider, type Room} from 'livekit-client';

const roomKeyCleanup = new WeakMap<Room, () => void>();

const roomE2EEWorkers = new WeakMap<Room, Worker>();

export function createE2EEWorker(): Worker {
	return new Worker(
		new URL(/* webpackChunkName: "livekit-e2ee.worker" */ 'livekit-client/e2ee-worker', import.meta.url),
		{
			type: 'module',
			name: 'livekit-e2ee-worker',
		},
	);
}

export function createE2EEKeyProvider(): ExternalE2EEKeyProvider {
	return new ExternalE2EEKeyProvider();
}

export function ownE2EEWorker(room: Room, worker: Worker | null): void {
	if (worker === null) return;
	const previous = roomE2EEWorkers.get(room) ?? null;
	if (previous !== null && previous !== worker) previous.terminate();
	roomE2EEWorkers.set(room, worker);
}

export function releaseE2EEWorker(room: Room | null): boolean {
	if (room === null) return false;
	roomKeyCleanup.get(room)?.();
	const worker = roomE2EEWorkers.get(room) ?? null;
	if (worker === null) return false;
	roomE2EEWorkers.delete(room);
	worker.terminate();
	return true;
}

/** Vortex keys come from the local MLS exporter; the relay never supplies them. */
export async function initializeVortexMediaKey(room: Room, provider: ExternalE2EEKeyProvider, value: string): Promise<void> {
    const match = /^vortex:(\d+):([A-Za-z0-9_-]+)$/.exec(value);
    if (!match) throw new Error('A locally derived Vortex media key is required');
    const channelId = match[1];
    const decode = (encoded: string): ArrayBuffer => {
        const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        if (bytes.byteLength !== 32) throw new Error('Invalid Vortex media key');
        return bytes.buffer;
    };
    await provider.setKey(decode(match[2]!));
    let pending = Promise.resolve();
    const onKey = (event: Event): void => {
        const detail = (event as CustomEvent<{channelId: string; key: string}>).detail;
        if (detail?.channelId !== channelId) return;
        pending = pending.then(() => provider.setKey(decode(detail.key))).catch(() => {
            // A failed epoch transition must never leave a call publishing with the old key.
            void room.disconnect();
        });
    };
    globalThis.addEventListener('vortex-media-key', onKey);
    const cleanup = (): void => {
        globalThis.removeEventListener('vortex-media-key', onKey);
        roomKeyCleanup.delete(room);
    };
    roomKeyCleanup.set(room, cleanup);
    room.once('disconnected', cleanup);
}
