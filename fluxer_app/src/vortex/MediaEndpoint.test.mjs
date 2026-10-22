// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mediaEndpoint} from './MediaEndpoint.js';

test('relay discovery permits secure WebSockets and loopback development only', () => {
  assert.equal(mediaEndpoint('wss://node.example/chat/relay'), 'wss://node.example/chat/relay');
  assert.equal(mediaEndpoint('ws://127.0.0.1:7880'), 'ws://127.0.0.1:7880/');
  for (const endpoint of ['ws://node.example', 'https://node.example', 'mesh://node.example', 'wss://user:secret@node.example', 'wss://node.example/#secret']) {
    assert.throws(() => mediaEndpoint(endpoint), /secure WebSocket/);
  }
});
