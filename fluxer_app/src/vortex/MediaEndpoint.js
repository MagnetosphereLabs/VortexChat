// SPDX-License-Identifier: AGPL-3.0-or-later
export function mediaEndpoint(value) {
  const url = new URL(value);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) || url.username || url.password || url.hash) {
    throw new Error('Calls require a secure WebSocket relay');
  }
  return url.href;
}
