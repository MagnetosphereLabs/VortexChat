// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VortexIds} from './Projection.js';
import {memberListView} from './MemberList.js';

test('member pages include groups, presence and only the requested conversation members', async () => {
  const ids=new VortexIds(),users=[{id:'alice',username:'alice',status:'online'},{id:'bob',username:'bob',status:'invisible'},{id:'other',username:'other',status:'online'}];
  const room={id:'room',space:'space',creator:'alice',kind:'text',meta:{members:['alice','bob']}};
  const state={users,me:users[0],spaces:[{id:'space',creator:'alice'}],rooms:[room],messages:new Map()};
  await ids.index(state);
  const guild=ids.get('guild','space'),channel=ids.get('channel','room');
  const view=memberListView(ids,state,guild,channel,[[0,99]]);
  assert.deepEqual(view.groups,[{id:'online',count:1},{id:'offline',count:1}]);
  assert.deepEqual(view.ops[0].items.filter(item=>item.member).map(item=>item.member.user.username),['alice','bob']);
  assert.equal(view.online_count,1);
  assert.equal(view.member_count,2);
  assert.equal(memberListView(ids,state,'unrelated',channel,[[0,99]]),null);
  assert.deepEqual(memberListView(ids,state,guild,channel,[[-1,99],[0,1000000]]).ops,[]);
  room.meta.members=['alice'];
  assert.equal(memberListView(ids,state,guild,channel,[[0,99]]).member_count,1);
});
