// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planChannelMoves} from './ChannelLayout.js';

const channels = [
  {id:'1', type:4, parent_id:null, position:0},
  {id:'2', type:0, parent_id:'1', position:0},
  {id:'3', type:0, parent_id:'1', position:1},
  {id:'4', type:2, parent_id:'1', position:2},
  {id:'5', type:0, parent_id:null, position:1},
];
test('channel drag uses the preceding sibling ahead of its numeric position', () => {
  assert.deepEqual(planChannelMoves(channels, [{id:'3', preceding_sibling_id:null, position:50}]), [
    {id:'3', position:0, parent_id:'1'}, {id:'2', position:1, parent_id:'1'},
  ]);
});
test('moving between categories renumbers both affected sibling lists', () => {
  const result = planChannelMoves(channels, [{id:'5', parent_id:'1', preceding_sibling_id:'3'}]);
  assert.deepEqual(result, [{id:'5', position:2, parent_id:'1'}, {id:'4', position:3, parent_id:'1'}]);
});
test('invalid siblings, nested categories and voice placement reject the whole operation', () => {
  const before = JSON.stringify(channels);
  for (const changes of [
    [{id:'2', preceding_sibling_id:'5'}],
    [{id:'2', preceding_sibling_id:'2'}],
    [{id:'1', parent_id:'1'}],
    [{id:'4', preceding_sibling_id:null}],
    [{id:'2', position:1}, {id:'3', parent_id:'missing'}],
  ]) assert.throws(() => planChannelMoves(channels, changes));
  assert.equal(JSON.stringify(channels), before);
});
