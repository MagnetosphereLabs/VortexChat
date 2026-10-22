// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VortexIds, channelView} from './Projection.js';

test('a message arriving after indexing can immediately appear in the channel view', async () => {
  const ids=new VortexIds(),user={id:'alice',username:'alice'};
  const room={id:'room',space:'',creator:'alice',kind:'group',meta:{name:'Private',members:['alice']}};
  const state={users:[user],me:user,spaces:[],rooms:[room],messages:new Map()};
  await ids.index(state);
  const event={id:'message',seq:10,at:1800000000,payload:{type:'message',text:'Local only'}};
  state.messages.set(room.id,[event]);
  const view=channelView(ids,state,room);
  assert.equal(ids.raw('message',view.last_message_id),event.id);
  assert.equal(await ids.add('message',event.id,event),view.last_message_id);
});

test('ambiguous message ordering fails without remapping an existing message', () => {
  const ids=new VortexIds(),first={id:'one',seq:1,at:1800000000};
  const wire=ids.messageId(first);
  assert.throws(()=>ids.messageId({...first,id:'two'}),/collision/);
  assert.equal(ids.raw('message',wire),'one');
});
