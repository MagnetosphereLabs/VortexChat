// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import {open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent} from 'electron';
import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';

interface Download {
  owner: number;
  file: FileHandle;
  temporary: string;
  destination: string;
  expected: number;
  written: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}
const downloads = new Map<string, Download>();
async function abort(id: string): Promise<void> {
  const download = downloads.get(id);if (!download) return;
  downloads.delete(id);clearTimeout(download.timer);download.detach();
  await download.file.close().catch(() => {});
  await unlink(download.temporary).catch(() => {});
}
function owned(event: IpcMainInvokeEvent, id: unknown): Download {
  requirePrivilegedRendererDocumentSender(event, 'vortex-download');
  const value = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!value || value.owner !== event.sender.id) throw new Error('Download unavailable');
  value.timer.refresh();return value;
}
export function registerVortexDownloads(): void {
  ipcMain.handle('vortex-download-start', async (event, name: unknown, expected: unknown) => {
    requirePrivilegedRendererDocumentSender(event, 'vortex-download-start');
    if (typeof name !== 'string' || name.length > 200 || !name || /[\\/\u0000-\u001f]/u.test(name)
      || typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0 || expected > 100 * 1024 ** 3) throw new Error('Invalid file');
    if ([...downloads.values()].filter(value => value.owner === event.sender.id).length >= 4) throw new Error('Finish another download first');
    const window = BrowserWindow.fromWebContents(event.sender);if (!window) throw new Error('Window unavailable');
    const selected = await dialog.showSaveDialog(window, {defaultPath: basename(name)});
    if (selected.canceled || !selected.filePath) return null;
    const id = randomUUID(), temporary = join(dirname(selected.filePath), '.vortex-' + id + '.part');
    const file = await open(temporary, 'wx', 0o600);
    const destroyed = () => {void abort(id);};
    event.sender.once('destroyed', destroyed);
    const timer = setTimeout(() => {void abort(id);}, 600000);timer.unref();
    downloads.set(id, {owner: event.sender.id, file, temporary, destination: selected.filePath, expected,
      written: 0, busy: false, timer, detach: () => {event.sender.removeListener('destroyed', destroyed);}});
    return id;
  });
  ipcMain.handle('vortex-download-chunk', async (event, id: string, chunk: unknown) => {
    const value = owned(event, id);
    if (value.busy || !(chunk instanceof Uint8Array) || chunk.byteLength > 1048576 || value.written + chunk.byteLength > value.expected) throw new Error('Invalid download chunk');
    value.busy = true;
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await value.file.write(chunk, offset, chunk.byteLength - offset, value.written + offset);
        if (result.bytesWritten === 0) throw new Error('The destination cannot accept more data');
        offset += result.bytesWritten;
      }
      value.written += chunk.byteLength;
    } catch (error) {await abort(id);throw error;}
    finally {value.busy = false;}
  });
  ipcMain.handle('vortex-download-finish', async (event, id: string) => {
    const value = owned(event, id);
    if (value.busy || value.written !== value.expected) throw new Error('Incomplete download');
    try {await value.file.sync();await value.file.close();await rename(value.temporary, value.destination);}
    finally {await abort(id);}
  });
  ipcMain.handle('vortex-download-abort', async (event, id: string) => {owned(event, id);await abort(id);});
}
