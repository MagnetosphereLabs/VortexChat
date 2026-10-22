import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callView,VortexIds} from './Projection.js';

test('call events cannot impersonate another participant or ring after their lease expires',async()=>{
  const ids=new VortexIds(),room={id:'dm',meta:{members:['alice','bob']}};
  const state={users:[{id:'alice'},{id:'bob'},{id:'outsider'}],spaces:[],rooms:[room],messages:new Map()};
  await ids.index(state);
  const event=(sender,payload,at=1000)=>({sender,at,payload:{type:'call',...payload}});
  const joined=event('alice',{state:'joined',voice:{connection_id:'one',user_id:ids.get('user','bob'),channel_id:'unrelated'}});
  state.messages.set(room.id,[joined,event('alice',{state:'ring',recipients:['bob','outsider']})]);
  let call=callView(ids,state,room,1001);
  assert.equal(call.voice_states[0].user_id,ids.get('user','alice'));
  assert.equal(call.voice_states[0].channel_id,ids.get('channel',room.id));
  assert.deepEqual(call.ringing,[ids.get('user','bob')]);
  state.messages.get(room.id).push(event('outsider',{state:'joined',voice:{connection_id:'unauthorized'}}));
  assert.equal(callView(ids,state,room,1001).voice_states.length,1);
  state.messages.get(room.id).push(event('bob',{state:'stop-ringing',recipients:['bob']}));
  assert.deepEqual(callView(ids,state,room,1001).ringing,[]);
  assert.equal(callView(ids,state,room,1091),null);
  state.messages.get(room.id).push(event('alice',{state:'ended',voice:{connection_id:'one'}}));
  assert.equal(callView(ids,state,room,1001),null);
});
