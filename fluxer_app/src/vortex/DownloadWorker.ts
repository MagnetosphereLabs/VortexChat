// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker relays bounded plaintext chunks to an explicit browser download.
// It never receives account keys or tokens, and never writes into a cache.
interface Download {
  port: MessagePort;
  name: string;
  size: number;
  owner: string;
  timer: ReturnType<typeof setTimeout>;
}
const downloads = new Map<string, Download>();
export function receiveDownload(event: ExtendableMessageEvent, origin: string): boolean {
  const data = event.data;
  if (data?.type !== 'VORTEX_DOWNLOAD') return false;
  const source = event.source as Client | null;
  const port = event.ports[0];
  if (!source || !port || new URL(source.url).origin !== origin || typeof data.ticket !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(data.ticket) || typeof data.name !== 'string' || data.name.length > 200
    || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > 100 * 1024 ** 3 || downloads.size >= 16) {
    port?.postMessage({type: 'cancel'});return true;
  }
  const timer = setTimeout(() => {downloads.delete(data.ticket);port.postMessage({type: 'cancel'});port.close();}, 60000);
  downloads.set(data.ticket, {port, name: data.name, size: data.size, owner: source.id, timer});
  port.postMessage({type: 'ready'});return true;
}
export function fetchDownload(event: FetchEvent, origin: string): boolean {
  const url = new URL(event.request.url);
  if (url.origin !== origin || !url.pathname.startsWith('/vortex/local-download/')) return false;
  const id = url.pathname.slice('/vortex/local-download/'.length), item = downloads.get(id);
  if (!item || event.request.method !== 'GET' || (event.clientId && event.clientId !== item.owner)) {
    event.respondWith(new Response('Download unavailable', {status: 404}));return true;
  }
  downloads.delete(id);clearTimeout(item.timer);
  let written = 0, complete = false;
  let resolvePending: (() => void) | undefined;
  let finish!: () => void;
  event.waitUntil(new Promise<void>(resolve => {finish = resolve;}));
  const close = () => {
    if (complete) return;
    complete = true;clearTimeout(item.timer);item.port.postMessage({type: 'cancel'});item.port.close();resolvePending?.();finish();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      item.port.onmessage = event => {
        if (complete) return;
        clearTimeout(item.timer);
        const data = event.data;
        if (data?.type !== 'chunk' || (data.done && written !== item.size)
          || (!data.done && (!(data.value instanceof Uint8Array) || data.value.byteLength > 1048576 || written + data.value.byteLength > item.size))) {
          controller.error(new Error('Encrypted download failed'));close();return;
        }
        if (data.done) {controller.close();close();return;}
        written += data.value.byteLength;controller.enqueue(data.value);resolvePending?.();resolvePending = undefined;
      };
      item.port.onmessageerror = () => {controller.error(new Error('Download interrupted'));close();};
    },
    pull(controller) {
      if (complete) return;
      item.timer = setTimeout(() => {controller.error(new Error('Download timed out'));close();}, 120000);
      const next = new Promise<void>(resolve => {resolvePending = resolve;});item.port.postMessage({type: 'pull'});return next;
    },
    cancel() {close();},
  });
  const filename = encodeURIComponent(item.name.replace(/[\\/\u0000-\u001f]/gu, '_')).replace(/'/gu, '%27');
  event.respondWith(new Response(stream, {headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(item.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  }}));return true;
}
