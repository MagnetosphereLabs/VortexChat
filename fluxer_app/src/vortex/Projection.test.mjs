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

test('announcement channels preserve their encrypted type and account ownership stays private', async () => {
  const {userView,guildView,materializeMessages}=await import('./Projection.js');
  const ids=new VortexIds(),user={id:'alice',username:'alice'},space={id:'server',creator:'alice'};
  const room={id:'news',space:space.id,creator:'alice',kind:'text',meta:{name:'announcements',announcement:true,members:['alice']}};
  const state={users:[user],me:user,spaces:[space],rooms:[room],messages:new Map()};await ids.index(state);
  assert.equal(channelView(ids,state,room).type,5);
  assert.equal(userView(ids,user).vortex_node_owner,undefined);
  assert.equal(userView(ids,user,{owner:true}).vortex_node_owner,true);
  assert.equal(userView(ids,user,{owner:false}).vortex_node_owner,false);
  state.vortexEmojis=[{id:'emoji',name:'wave',catalog:true,space:space.id,file:{secret:'local-only'}}];
  assert.equal(guildView(ids,state,space).emojis[0].file,undefined);
  const events=[{id:'message',sender:'alice',seq:1,payload:{type:'message'}},{id:'reaction',sender:'alice',seq:2,payload:{type:'reaction',target:'message',emoji:'custom:image',emojiName:'wave',emojiFile:{id:'image'}}}];
  const message=materializeMessages(state,room,events)[0];
  assert.equal(message.reactionMedia.get('custom:image').name,'wave');
  assert.equal(message.reactions.get('custom:image').size,1);
});

test('legacy encrypted custom emoji renders locally and failures retain its name', async () => {
  const {VortexSession}=await import('./Session.js');
  const {getEmojiMedia}=await import('./EmojiMedia.js');
  const session=new VortexSession({id:'alice',url:'https://node.test'});
  const user={id:'alice',username:'alice'},room={id:'room',creator:user.id,space:'',meta:{members:['alice']}};
  session.core.state.me=user;session.core.state.users=[user];session.core.state.rooms=[room];session.core.state.spaces=[];
  await session.ids.index(session.core.state);
  const file={id:'image',type:'image/gif',name:'wave.gif',size:4};
  session.attachment=async()=>({id:await session.ids.add('attachment',file.id),proxy_url:'blob:https://node.test/decrypted'});
  const event={id:'legacy',sender:user.id,seq:1,at:1800000000,payload:{type:'message',emoji:{name:'wave',file}}};
  const view=await session.message(room,event);
  assert.match(view.content,/<a:wave:\d+>/u);assert.equal(view.attachments.length,0);
  const id=session.ids.get('emoji',file.id);assert.equal(getEmojiMedia(id,session.pair.url,session.ids.get('user',user.id)),'blob:https://node.test/decrypted');
  session.attachment=async()=>({id:'fallback',proxy_url:'https://node.test/vortex/local-file/opaque'});
  const fallback=await session.message(room,{...event,id:'failed',seq:2});
  assert.equal(fallback.content,':wave:');assert.equal(fallback.attachments.length,1);
  session.close();assert.equal(getEmojiMedia(id,session.pair.url,session.ids.get('user',user.id)),null);
});


test('template imports reject permissions and invalid parents before creating a server', async () => {
  const {serverTemplatePlan}=await import('./ServerTemplate.js');
  assert.throws(()=>serverTemplatePlan({roles:[{name:'private'}],channels:[{id:1,name:'general',type:0}]}),/roles/);
  assert.throws(()=>serverTemplatePlan({channels:[{id:1,name:'secret',type:0,permission_overwrites:[{deny:'1024'}]}]}),/permissions/);
  assert.throws(()=>serverTemplatePlan({channels:[{id:1,name:'general',type:0,parent_id:99}]}),/parent/);
  const plan=serverTemplatePlan({channels:[{id:2,name:'news',type:5,parent_id:1},{id:1,name:'Updates',type:4}]});
  assert.deepEqual(plan.map(item=>item.type),[4,5]);
});


test('ordinary encrypted messages cannot impersonate catalog publication or removal', async () => {
  const {VortexSession}=await import('./Session.js');
  const session=new VortexSession({id:'alice',url:'https://node.test'}),user={id:'alice',username:'alice'};
  const room={id:'room',space:'server',creator:'alice',kind:'text',meta:{members:['alice']}};
  const file={id:'approved',type:'image/png',size:10};
  Object.assign(session.core.state,{me:user,users:[user],rooms:[room],spaces:[{id:'server',creator:'alice'}]});
  await session.ids.index(session.core.state);
  session.attachment=async file=>({id:await session.ids.add('attachment',file.id),proxy_url:'blob:https://node.test/'+file.id});
  session.core.archiveEvents=async function*(){};
  session.core.state.messages.set(room.id,[
    {seq:1,kind:'emoji',sender:'alice',payload:{type:'emoji',name:'approved',file}},
    {seq:2,kind:'message',sender:'alice',payload:{type:'emoji.remove',fileId:file.id}},
    {seq:3,kind:'message',sender:'alice',payload:{type:'emoji',name:'forged',file:{...file,id:'forged'}}}
  ]);
  await session.hydrateEmojis();
  assert.deepEqual(session.core.state.vortexEmojis.filter(item=>item.catalog).map(item=>item.name),['approved']);
  session.close();
});


test('decrypted emoji registry isolates concurrent accounts and Nodes', async () => {
  const {setEmojiMedia,getEmojiMedia,clearEmojiMedia,messageEmojiEntries,messageEmojiFiles}=await import('./EmojiMedia.js');
  const session=(url,userId)=>({pair:{url,id:userId},ids:{get:(_kind,id)=>id}});
  const alice=session('https://one.test','alice'),bob=session('https://one.test','bob'),other=session('https://two.test','alice');
  setEmojiMedia(alice,'same-image','blob:alice');
  assert.equal(getEmojiMedia('same-image','https://one.test','bob'),null);
  assert.equal(getEmojiMedia('same-image','https://two.test','alice'),null);
  assert.equal(getEmojiMedia('same-image','https://one.test',null),null);
  setEmojiMedia(bob,'same-image','blob:bob');setEmojiMedia(other,'same-image','blob:other');
  assert.equal(getEmojiMedia('same-image','https://one.test','alice'),'blob:alice');
  assert.equal(getEmojiMedia('same-image','https://one.test','bob'),'blob:bob');
  assert.equal(getEmojiMedia('same-image','https://two.test','alice'),'blob:other');
  clearEmojiMedia(alice);
  assert.equal(getEmojiMedia('same-image','https://one.test','alice'),null);
  assert.equal(getEmojiMedia('same-image','https://one.test','bob'),'blob:bob');
  clearEmojiMedia(bob);clearEmojiMedia(other);
  assert.deepEqual(messageEmojiEntries({emojiMedia:{bad:true}}),[]);
  assert.deepEqual(messageEmojiFiles({emoji:{file:{id:'bad',type:'image/png',size:-1}}}),[]);
});
