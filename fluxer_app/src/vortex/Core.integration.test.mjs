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
import {getSession} from './Session.js';
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

test('OPAQUE, MLS, encrypted files and a Space private from its Node operator', {timeout:120000}, async t=>{
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
  await request('PATCH','/guilds/'+guild.id+'/channels',[{id:channel,parent_id:category.id,position:1}]);
  assert.equal((await request('GET','/channels/'+channel)).body.parent_id,category.id);
  await assert.rejects(request('PATCH','/channels/'+channel,{permission_overwrites:[{id:guild.id,type:0,allow:'0',deny:'1024'}]}));
  const count=client.core.state.rooms.length;
  await assert.rejects(request('POST','/guilds/'+guild.id+'/channels',{name:'Must not be created as public',type:0,permission_overwrites:[{id:guild.id,type:0,allow:'0',deny:'1024'}]}));
  assert.equal(client.core.state.rooms.length,count);
  await assert.rejects(request('PATCH','/channels/'+category.id,{parent_id:category.id}));

  const message=(await request('POST','/channels/'+channel+'/messages',{content:'Through Fluxer',nonce:'test-nonce'})).body;
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
  assert.equal(packets.find(p=>p.t==='READY').d.user.id,me.id);
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
  const invitation=await client.core.inviteSpace(newSpace,bobPair.id);
  const invitationWire=await bobClient.core.action('space.invites');
  assert.equal(JSON.stringify(invitationWire).includes('Encrypted UI Space'),false);
  assert.equal((await bobClient.core.invitations())[0].name,'Encrypted UI Space');
  await bobClient.core.respondInvitation(invitation,true);
  await client.refresh();await bobClient.refresh();
  const newRoom=client.room(channel);
  await client.core.send({type:'message',text:'After accepting an encrypted invitation'},'message',newRoom);
  await bobClient.refresh();
  assert.ok(bobClient.core.state.messages.get(newRoom.id).some(event=>event.payload.text==='After accepting an encrypted invitation'));
  await client.core.action('space.member',{space:newSpace,user:bobPair.id,banned:true,permissions:0});
  await assert.rejects(bobClient.core.action('events',{room:newRoom.id,after:0}));
  await client.core.send({type:'message',text:'After Space ban'},'message',newRoom);
  assert.equal(client.core.command('members',newRoom.id).members.length,1);

  // Closing a DM hides it for this account without deleting shared history.
  const bobRequest=(method,path,body)=>vortexRequest(url,method,path,{body},bobLogin.body.token);
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

  // Disabling an account also revokes its active authentication token.
  await auth.api(url,'admin.user',{user:bobPair.id,disabled:true,quota:1024},owner.token);
  await assert.rejects(bobClient.core.action('me'));

});
