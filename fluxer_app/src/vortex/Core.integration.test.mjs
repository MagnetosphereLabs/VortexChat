// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {auth} from './vendor/auth.js';
import {createVortexCore} from './Core.js';
import {vortexRequest} from './Rest.js';
import {VortexSession,getSession} from './Session.js';
import {invitationCodes} from './Invitations.js';
import {publicCredential} from './AccountSecurity.js';
import {VortexGateway} from './Gateway.js';

// The WASM store contains unordered maps. Compare their canonical digest so a
// reload cannot fail this check merely by reordering entries, and so an assertion
// failure never prints cryptographic material into build logs.
function ratchetDigest(engine) {
  const snapshot=JSON.parse(engine.snapshot());
  snapshot.groups.sort();
  snapshot.store.sort(([left],[right])=>left<right?-1:left>right?1:0);
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function startNode(t) {
  const cleanup=[];
  assert.ok(process.env.VORTEX_NODE_BINARY,'Set VORTEX_NODE_BINARY to the compiled Node binary');
  const binary=resolve(process.env.VORTEX_NODE_BINARY);
  const dir=await mkdtemp(join(tmpdir(),'vortex-integration-'));
  const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port; await new Promise(r=>server.close(r));
  const url=`http://127.0.0.1:${port}`;
  const password='integration-test-password-2026';
  const setup=spawnSync(binary,['setup','--data',dir,'--stdin-user','node.owner'],{input:password+'\n',encoding:'utf8'});
  assert.equal(setup.status,0,setup.stderr);
  const config=join(dir,'config.json');
  await writeFile(config,JSON.stringify({listen:`127.0.0.1:${port}`,data_dir:dir,vault_html:join(dir,'unused.html'),node_id:auth.b64(auth.random()),bridge:auth.b64(auth.random()),reserve_bytes:0,vault_enabled:false,public_url:url}));
  const nodeProcess=spawn(binary,['serve','--config',config],{env:{...globalThis.process.env,VORTEX_TEST:'1'},stdio:['ignore','pipe','pipe']});
  let stderr='';nodeProcess.stderr.on('data',data=>{stderr+=data;});
  t.after(async()=>{
    for(const close of cleanup.reverse())await close();
    if(nodeProcess.exitCode===null){
      const exited=new Promise(r=>nodeProcess.once('exit',r));
      nodeProcess.kill('SIGTERM');
      const deadline=setTimeout(()=>nodeProcess.kill('SIGKILL'),2000);
      await exited;clearTimeout(deadline);
    }
    await rm(dir,{recursive:true,force:true});
  });
  for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok)break;}catch{}await delay(50);}
  assert.equal((await fetch(url+'/health')).status,200,stderr);
  const owner=await auth.login({url,username:'node.owner',password});
  await auth.api(url,'policy',{title:'Private test Node',signupUntil:Math.floor(Date.now()/1000)+600,createSpaces:'everyone',chatQuota:0,maxUpload:10485760},owner.token);
  return {url,password,owner,cleanup};
}

test('OPAQUE, MLS, encrypted files, profiles and invitations remain private from the Node operator', {timeout:120000}, async t=>{
  const {url,password,owner,cleanup}=await startNode(t);
  await auth.register({url,username:'alice.test',password});
  const alicePair=await auth.login({url,username:'alice.test',password});
  const alice=createVortexCore({notice:message=>{throw new Error(message);}});
  await alice.connect(alicePair,await auth.restoreRoot(alicePair));cleanup.push(()=>alice.close());
  await auth.register({url,username:'bob.testxx',password});
  const bobPair=await auth.login({url,username:'bob.testxx',password});
  const bob=createVortexCore({notice:message=>{if(!message.startsWith('Uploading'))throw new Error(message);}});
  await bob.connect(bobPair,await auth.restoreRoot(bobPair));cleanup.push(()=>bob.close());
  await alice.sync();
  const space=(await alice.action('space.create',{sealed:auth.b64(auth.random(64))})).id;
  const room=await alice.createRoom('text',{space,spaceName:'Private Space',name:'private',members:[bobPair.id],background:true});
  assert.deepEqual(new Set(room.meta.members),new Set([alicePair.id,bobPair.id]));
  const ownerRooms=await auth.api(url,'rooms',{},owner.token);
  assert.equal(ownerRooms.rooms.length,0);
  assert.equal(ownerRooms.spaces.length,0);
  await assert.rejects(auth.api(url,'room.members',{room:room.id},owner.token));
  await bob.sync();await alice.sync();
  const plaintext='This sentence must never reach the Node in plaintext.';
  await alice.send({type:'message',text:plaintext},'message',room);
  await bob.sync();
  assert.equal(bob.state.messages.get(room.id).find(e=>e.payload.text===plaintext)?.sender,alicePair.id);
  const wire=await alice.action('events',{room:room.id,after:0});
  assert.equal(JSON.stringify(wire).includes(plaintext),false);
  const bobRoom=bob.state.rooms.find(r=>r.id===room.id);
  const file=new File([new Uint8Array(1048576+37).fill(42)],'private.bin',{type:'application/octet-stream'});
  const attachment=await bob.upload(file,bobRoom);
  const decrypted=await alice.download(attachment);
  assert.deepEqual(new Uint8Array(await decrypted.arrayBuffer()),new Uint8Array(await file.arrayBuffer()));
  await assert.rejects(alice.download({...attachment,secret:auth.b64(auth.random(32))}));
  assert.deepEqual(await alice.mediaKey(room),await bob.mediaKey(bobRoom));
  await alice.action('room.moderate',{room:room.id,user:bobPair.id,banned:true});
  await alice.removeMembers(room,bobPair.id);
  await assert.rejects(bob.action('events',{room:room.id,after:0}));
  await alice.send({type:'message',text:'After removal'},'message',alice.state.rooms.find(r=>r.id===room.id));
  alice.close();bob.close();
  const login=await vortexRequest(url,'POST','/auth/login',{body:{login:'alice.test',password}});
  const token=login.body.token;
  const client=await getSession(token,url);cleanup.push(()=>client.close());
  const request=(method,path,body)=>vortexRequest(url,method,path,{body},token);
  const discovery=await (await fetch(url+'/.well-known/fluxer')).json();
  assert.equal(discovery.endpoints.api,url+'/vortex/api');
  const me=(await request('GET','/users/@me')).body;
  assert.equal(me.username,'alice.test');
  const polling=client.refresh();
  const guild=(await request('POST','/guilds',{name:'Encrypted UI Space'})).body;
  await polling;
  assert.equal(guild.name,'Encrypted UI Space');
  const channels=(await request('GET','/guilds/'+guild.id+'/channels')).body;
  assert.equal(channels.length,1);
  const channel=channels[0].id;
  const category=(await request('POST','/guilds/'+guild.id+'/channels',{name:'Encrypted category',type:4})).body;
  assert.equal(category.type,4);
  const announcement=(await request('POST','/guilds/'+guild.id+'/channels',{name:'news',type:5})).body;
  assert.equal(announcement.type,5);
  await request('PATCH','/channels/'+announcement.id,{type:0});
  assert.equal((await request('GET','/channels/'+announcement.id)).body.type,0);
  await request('PATCH','/channels/'+announcement.id,{type:5});
  assert.equal((await request('GET','/channels/'+announcement.id)).body.type,5);
  const serversBefore=client.core.state.spaces.length;
  await assert.rejects(request('POST','/guilds',{name:'Unsafe import',template:{roles:[{name:'private'}],channels:[{id:1,name:'secret',type:0}]}}),/roles/);
  assert.equal(client.core.state.spaces.length,serversBefore);
  const template=(await request('POST','/guilds',{name:'Imported layout',template:{roles:[],channels:[{id:1,name:'Updates',type:4},{id:2,name:'news',type:5,parent_id:1}]}})).body;
  const imported=(await request('GET','/guilds/'+template.id+'/channels')).body;
  assert.deepEqual(imported.map(item=>item.type).sort(),[4,5]);
  assert.equal(imported.find(item=>item.type===5).parent_id,imported.find(item=>item.type===4).id);
  await request('POST','/guilds/'+template.id+'/delete');
  assert.equal(client.core.state.spaces.length,serversBefore);

  await request('PATCH','/guilds/'+guild.id+'/channels',[{id:channel,parent_id:category.id,position:1}]);
  assert.equal((await request('GET','/channels/'+channel)).body.parent_id,category.id);
  await assert.rejects(request('PATCH','/channels/'+channel,{permission_overwrites:[{id:guild.id,type:0,allow:'0',deny:'1024'}]}));
  const count=client.core.state.rooms.length;
  await assert.rejects(request('POST','/guilds/'+guild.id+'/channels',{name:'Must not be created as public',type:0,permission_overwrites:[{id:guild.id,type:0,allow:'0',deny:'1024'}]}));
  assert.equal(client.core.state.rooms.length,count);
  await assert.rejects(request('PATCH','/channels/'+category.id,{parent_id:category.id}));

  const bitmap=globalThis.createImageBitmap;
  globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
  try {
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=';
    const upload=(await request('POST','/guilds/'+guild.id+'/emojis/bulk',{emojis:[{name:'private_wave',image}]})).body;
    assert.equal(upload.failed.length,0);const emoji=upload.success[0];assert.ok(emoji.id);
    assert.equal((await request('GET','/guilds/'+guild.id+'/emojis')).body[0].name,'private_wave');
    const sent=(await request('POST','/channels/'+channel+'/messages',{content:`<:private_wave:${emoji.id}>`,nonce:'custom-emoji'})).body;
    assert.match(sent.content,/<:private_wave:\d+>/u);
    const raw=await client.core.action('events',{room:client.room(channel).id,after:0});
    assert.equal(JSON.stringify(raw).includes('private_wave'),false);
    assert.equal(JSON.stringify(raw).includes(image.slice(22)),false);
    await request('PUT','/channels/'+channel+'/messages/'+sent.id+'/reactions/'+encodeURIComponent('private_wave:'+emoji.id)+'/@me');
    const reacted=(await request('GET','/channels/'+channel+'/messages/'+sent.id)).body;
    assert.equal(reacted.reactions[0].emoji.id,emoji.id);
    const reactionPath='/channels/'+channel+'/messages/'+sent.id+'/reactions/'+encodeURIComponent('private_wave:'+emoji.id)+'/@me';
    await request('DELETE',reactionPath);await client.refresh(true);
    assert.equal((await request('GET','/channels/'+channel+'/messages/'+sent.id)).body.reactions.length,0,'Custom reactions stay removed after synchronization');
    const emojiFile=client.core.state.vortexEmojis.find(item=>item.id===emoji.id).file;
    const target=client.ids.raw('message',sent.id),reactionRoom=client.room(channel);
    await client.core.send({type:'reaction',target,emoji:'custom:node:legacy-wave',emojiFile,emojiName:'private_wave'},'message',reactionRoom);
    await client.core.send({type:'reaction',target,emoji:'custom:'+emojiFile.id,emojiFile,emojiName:'private_wave'},'message',reactionRoom);
    assert.equal((await request('GET','/channels/'+channel+'/messages/'+sent.id)).body.reactions.length,1,'Legacy aliases render one reaction');
    await request('DELETE',reactionPath);await client.refresh(true);
    assert.equal((await request('GET','/channels/'+channel+'/messages/'+sent.id)).body.reactions.length,0,'Removing an emoji also removes older aliases');
    await request('PATCH','/users/@me',{bio:'Encrypted profile biography',pronouns:'they/them',avatar:image,banner:image,accent_color:1234});
    const profile=(await request('GET','/users/'+me.id+'/profile')).body;
    assert.equal(profile.user_profile.bio,'Encrypted profile biography');assert.match(profile.user.avatar,/^vortex_/u);assert.match(profile.user_profile.banner,/^vortex_/u);
    assert.equal(JSON.stringify(await client.core.action('me')).includes('Encrypted profile biography'),false);
    const sticker=(await request('POST','/guilds/'+guild.id+'/stickers',{name:'private_sticker',image,description:'Private sticker',tags:['wave']})).body;
    assert.ok(sticker.id);assert.equal((await request('GET','/guilds/'+guild.id+'/stickers')).body.length,1);
    const stickerMessage=(await request('POST','/channels/'+channel+'/messages',{content:'',sticker_ids:[sticker.id],nonce:'sticker'})).body;
    assert.equal(stickerMessage.sticker_items[0].name,'private_sticker');assert.equal(stickerMessage.attachments.length,0);
    await request('PATCH','/guilds/'+guild.id+'/stickers/'+sticker.id,{description:'Updated description',tags:['hello']});
    assert.equal((await request('GET','/guilds/'+guild.id+'/stickers')).body[0].description,'Updated description');
    await request('DELETE','/guilds/'+guild.id+'/stickers/'+sticker.id);
    assert.equal((await request('GET','/guilds/'+guild.id+'/stickers')).body.length,0);
    const ownerClient=await new VortexSession(owner).open();cleanup.push(()=>ownerClient.close());
    const {nodeExpressionRequest}=await import('./NodeExpressions.js');
    const ownerRequest=async(method,path,body)=>({body:await nodeExpressionRequest(ownerClient,method,path.split('/')[3],body)});
    await assert.rejects(request('POST','/vortex/expressions',{kind:'emoji',name:'not_admin',image}));
    await ownerRequest('POST','/vortex/expressions',{kind:'emoji',name:'node_wave',image});
    await ownerRequest('POST','/vortex/expressions',{kind:'sticker',name:'node_sticker',image});
    const catalog=(await request('GET','/vortex/expressions')).body;
    assert.equal(catalog.emojis.length,1);assert.equal(catalog.stickers.length,1);
    assert.equal(JSON.stringify(await client.core.action('emoji.list')).includes('node_wave'),false);
    const nodeSent=(await request('POST','/channels/'+channel+'/messages',{content:`<:node_wave:${catalog.emojis[0].id}>`,sticker_ids:[catalog.stickers[0].id],nonce:'node-expressions'})).body;
    assert.match(nodeSent.content,/node_wave/u);assert.equal(nodeSent.sticker_items[0].name,'node_sticker');
    for(const expression of [...catalog.emojis,...catalog.stickers])await ownerRequest('DELETE','/vortex/expressions/'+expression.id);
    assert.equal((await request('GET','/vortex/expressions')).body.emojis.length,0);
    await request('PATCH','/guilds/'+guild.id+'/emojis/'+emoji.id,{name:'renamed_wave'});
    assert.equal((await request('GET','/guilds/'+guild.id+'/emojis')).body[0].name,'renamed_wave');
    await request('DELETE','/guilds/'+guild.id+'/emojis/'+emoji.id);
    assert.equal((await request('GET','/guilds/'+guild.id+'/emojis')).body.length,0);
    assert.match((await request('GET','/channels/'+channel+'/messages/'+sent.id)).body.content,/private_wave/u);
  } finally {globalThis.createImageBitmap=bitmap;}
  const voiceForm=new FormData();
  voiceForm.set('payload_json',JSON.stringify({flags:8192,nonce:'voice-message',attachments:[{duration:2.5,waveform:'AQID'}]}));
  voiceForm.set('files[0]',new File([new Uint8Array([79,103,103,83])],'voice.ogg',{type:'audio/ogg'}));
  const voiceMessage=(await vortexRequest(url,'POST','/channels/'+channel+'/messages',{body:voiceForm},token)).body;
  assert.equal(voiceMessage.flags,8192);assert.equal(voiceMessage.attachments[0].content_type,'audio/ogg');assert.match(voiceMessage.attachments[0].proxy_url,/^blob:/u);assert.equal(voiceMessage.attachments[0].waveform,'AQID');assert.equal(voiceMessage.attachments[0].duration,2.5);
  const message=(await request('POST','/channels/'+channel+'/messages' ,{content:'Through Fluxer',nonce:'test-nonce'})).body;
  assert.equal(message.content,'Through Fluxer');
  assert.equal((await request('POST','/channels/'+channel+'/messages',{content:'Through Fluxer',nonce:'test-nonce'})).body.id,message.id);
  await request('PATCH','/channels/'+channel+'/messages/'+message.id,{content:'Edited locally'});
  assert.equal((await request('GET','/channels/'+channel+'/messages')).body[0].content,'Edited locally');
  await request('PUT','/channels/'+channel+'/messages/'+message.id+'/reactions/'+encodeURIComponent('❤️')+'/@me');
  assert.equal((await request('GET','/channels/'+channel+'/messages')).body[0].reactions[0].count,1);
  assert.equal((await request('GET','/premium/state')).body.effective.is_premium,true);
  await request('POST','/users/@me/saved-messages',{channel_id:channel,message_id:message.id});
  assert.equal((await request('GET','/users/@me/saved-messages')).body[0].message.content,'Edited locally');
  const ratchetBeforeSearch=ratchetDigest(client.core.state.engine);
  const search=(await request('POST','/search/messages',{context_guild_id:guild.id,content:'Edited',has:[],page:1})).body;
  assert.equal(search.total,1);assert.equal(search.messages[0].id,message.id);
  assert.equal(ratchetDigest(client.core.state.engine),ratchetBeforeSearch,'Archive search must not consume the live ratchet');
  assert.equal((await request('POST','/search/messages',{context_guild_id:guild.id,content:'absent'})).body.total,0);
  assert.equal((await request('GET','/channels/'+channel+'/messages/'+message.id+'/reactions/'+encodeURIComponent('❤️'))).body[0].id,me.id);
  await request('DELETE','/users/@me/saved-messages/'+message.id);
  assert.equal((await request('GET','/users/@me/saved-messages')).body.length,0);
  const gateway=new VortexGateway(url.replace('http:','ws:')+'/vortex/gateway');
  cleanup.push(()=>gateway.dispose());
  const packets=[];gateway.on('message',event=>packets.push(JSON.parse(event.data)));gateway.start();await delay(0);
  await gateway.identify({token});
  const ready=packets.find(p=>p.t==='READY').d;
  assert.equal(ready.user.id,me.id);
  assert.equal(ready.user_settings.status,'online');
  assert.deepEqual(ready.user_settings.restricted_guilds,[]);
  assert.deepEqual(ready.user_settings.bot_restricted_guilds,[]);
  assert.deepEqual(ready.user_settings.guild_folders,[]);
  assert.equal(ready.user_settings.developer_mode,false);
  for(const status of ['invisible','online','idle','dnd','online']) {
    const settings=(await request('PATCH','/users/@me/settings',{status})).body;
    assert.equal(settings.status,status);
    assert.deepEqual(settings.guild_folders,[]);
    assert.equal(settings.developer_mode,false);
    assert.deepEqual(packets.filter(p=>p.t==='USER_SETTINGS_UPDATE').at(-1).d,settings);
    gateway.send(JSON.stringify({op:3,d:{status}}));await gateway.pending;
    assert.equal(gateway.readyState,1,'Changing presence must not close the encrypted session');
    assert.equal(client.core.state.users.find(user=>user.id===client.core.state.me.id).status,status==='invisible'?'offline':status);
  }
  assert.equal((await request('GET','/users/@me/settings')).body.status,'online');
  gateway.send(JSON.stringify({op:14,d:{subscriptions:{[guild.id]:{member_list_channels:{[channel]:[[0,99]]}}}}}));
  await gateway.pending;
  assert.ok(packets.some(packet=>packet.t==='GUILD_MEMBER_LIST_UPDATE'&&packet.d.channel_id===channel&&packet.d.ops[0].items.some(item=>item.member?.user.id===me.id)));
  await request('POST','/channels/'+channel+'/messages',{content:'Gateway event',nonce:'gateway-nonce'});
  assert.ok(packets.find(p=>p.t==='MESSAGE_CREATE'&&p.d.content==='Gateway event'));
  await request('DELETE','/channels/'+channel+'/messages/'+message.id);
  assert.ok(!(await request('GET','/channels/'+channel+'/messages')).body.find(m=>m.id===message.id));
  await assert.rejects(request('POST','https://unrelated.invalid/auth/login',{password}));

  // Targeted Space invitations reveal their title and keys only to the invitee.
  const bobLogin=await vortexRequest(url,'POST','/auth/login',{body:{login:'bob.testxx',password}});
  const bobClient=await getSession(bobLogin.body.token,url);cleanup.push(()=>bobClient.close());
  await client.refresh();
  const newSpace=client.ids.raw('guild',guild.id);
  const invitation=(await request('POST','/vortex/space-invites',{guild_id:guild.id,username:'bob.testxx'})).body.id;
  const bobRequest=(method,path,body)=>vortexRequest(url,method,path,{body},bobLogin.body.token);
  const inviteLink=url+'/invite/'+invitation;
  assert.equal(invitationCodes(inviteLink,url)[0].code,invitation);
  assert.equal(invitationCodes(url+'/channels/@me',url).length,0);
  assert.equal((await bobRequest('GET','/invites/'+invitation)).body.guild.name,'Encrypted UI Space');
  const invitationWire=await bobClient.core.action('space.invites');
  assert.equal(JSON.stringify(invitationWire).includes('Encrypted UI Space'),false);
  assert.equal((await bobClient.core.invitations())[0].name,'Encrypted UI Space');
  const joinEvents=[];bobClient.listeners.add((type,data)=>joinEvents.push({type,data}));
  await bobRequest('POST','/invites/'+invitation,{});
  assert.ok(joinEvents.some(event=>event.type==='GUILD_CREATE'&&event.data.id===guild.id));
  await client.refresh();await bobClient.refresh();
  await gateway.refresh(true);
  assert.ok(packets.some(packet=>packet.t==='GUILD_MEMBER_ADD'&&packet.d.guild_id===guild.id&&packet.d.user.id===bobClient.currentUser().id));
  const newRoom=client.room(channel);
  await client.core.send({type:'message',text:'After accepting an encrypted invitation'},'message',newRoom);
  await bobClient.refresh();
  assert.ok(bobClient.core.state.messages.get(newRoom.id).some(event=>event.payload.text==='After accepting an encrypted invitation'));
  await client.core.action('space.member',{space:newSpace,user:bobPair.id,banned:true,permissions:0});
  await assert.rejects(bobClient.core.action('events',{room:newRoom.id,after:0}));
  await client.core.send({type:'message',text:'After Space ban'},'message',newRoom);
  assert.equal(client.core.command('members',newRoom.id).members.length,1);
  await gateway.refresh(true);
  assert.ok(packets.some(packet=>packet.t==='GUILD_MEMBER_REMOVE'&&packet.d.guild_id===guild.id&&packet.d.user.id===bobClient.currentUser().id));

  // Closing a DM hides it for this account without deleting shared history.
  await bobRequest('PATCH','/users/@me/settings',{friend_source_flags:0,group_dm_add_permission_flags:16,incoming_call_flags:16});
  await assert.rejects(request('POST','/users/@me/relationships',{username:'bob.testxx'}),/accepting friend/);
  const ownerId=client.ids.get('user',owner.id);
  await assert.rejects(request('POST','/users/@me/channels',{recipients:[bobClient.currentUser().id,ownerId]}),/group invitation/);
  await bobRequest('PATCH','/users/@me/settings',{friend_source_flags:7,group_dm_add_permission_flags:4,incoming_call_flags:8});
  await request('POST','/users/@me/relationships',{username:'bob.testxx'});
  await bobRequest('PUT','/users/@me/relationships/'+me.id,{type:1});
  await client.refresh(true);
  const bobId=bobClient.currentUser().id;
  const dm=(await request('POST','/users/@me/channels',{recipients:[bobId]})).body;
  await bobClient.refresh(true);
  const direct=(await request('POST','/channels/'+dm.id+'/messages',{content:'Retained private conversation'})).body;
  await request('DELETE','/channels/'+dm.id);
  assert.equal((await request('GET','/users/@me/channels')).body.some(channel=>channel.id===dm.id),false);
  await bobClient.refresh(true);
  assert.equal((await bobRequest('GET','/channels/'+dm.id+'/messages')).body[0].id,direct.id);
  assert.equal((await request('POST','/users/@me/channels',{recipients:[bobId]})).body.id,dm.id);
  await request('DELETE','/channels/'+dm.id);
  await bobRequest('POST','/channels/'+dm.id+'/messages',{content:'A new message reopens the conversation'});
  await client.refresh(true);
  assert.equal((await request('GET','/users/@me/channels')).body.some(channel=>channel.id===dm.id),true);
  await bobRequest('DELETE','/users/@me/relationships/'+me.id);
  await client.refresh(true);
  await assert.rejects(request('POST','/channels/'+dm.id+'/messages',{content:'Must not send after the other person removes the friendship'}),/Become friends/);
  assert.equal((await request('GET','/channels/'+dm.id+'/messages')).body.some(message=>message.content==='Retained private conversation'),true);

  const bitmapForProfile=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
  try {
    await request('PATCH','/users/@me/settings',{profile_privacy:2});
    await request('PATCH','/users/@me',{bio:'Friends only profile'});
    await bobClient.refresh(true);
    assert.equal((await bobRequest('GET','/users/'+me.id+'/profile')).body.user_profile.bio,'','A removed friend cannot decrypt a newly restricted profile');
  } finally {globalThis.createImageBitmap=bitmapForProfile;}
  // Disabling an account also revokes its active authentication token.
  await auth.api(url,'admin.user',{user:bobPair.id,disabled:true,quota:1024},owner.token);
  await assert.rejects(bobClient.core.action('me'));

});

test('Password changes preserve account keys and revoke previous sessions', {timeout:120000}, async t=>{
  const {url,password,cleanup}=await startNode(t);
  // Password replacement rewraps the same root, revokes older sessions and rejects the old password.
  await auth.register({url,username:'password.user',password});
  const credentialLogin=await vortexRequest(url,'POST','/auth/login',{body:{login:'password.user',password}});
  const credentialClient=await getSession(credentialLogin.body.token,url);cleanup.push(()=>credentialClient.close());
  const credentialRoot=createHash('sha256').update(JSON.stringify(credentialClient.core.state.root)).digest('hex');
  const previous=await auth.login({url,username:'password.user',password});
  const newPassword='replacement-password-private-2026';
  await vortexRequest(url,'POST','/vortex/account/password',{body:{password,new_password:newPassword}},credentialLogin.body.token);
  assert.equal((await credentialClient.core.action('me')).username,'password.user');
  await assert.rejects(auth.api(url,'me',{},previous.token));
  await assert.rejects(auth.login({url,username:'password.user',password}));
  const changed=await auth.login({url,username:'password.user',password:newPassword});
  assert.equal(createHash('sha256').update(JSON.stringify(await auth.restoreRoot(changed))).digest('hex'),credentialRoot);
  const publicPart=publicCredential({id:'public',rawId:new Uint8Array([1]).buffer,type:'public-key',response:{clientDataJSON:new Uint8Array([2]).buffer},getClientExtensionResults:()=>({prf:{results:{first:'PRIVATE'}}})});
  assert.equal(JSON.stringify(publicPart).includes('PRIVATE'),false);assert.deepEqual(publicPart.extensions,{});

 });
