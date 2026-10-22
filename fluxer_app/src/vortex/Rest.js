// SPDX-License-Identifier: AGPL-3.0-or-later
import {auth} from './vendor/auth.js';
import {getSession,login,register,logout} from './Session.js';
import {channelView,guildView,userView,materializeMessages,callView,freePremiumState} from './Projection.js';
import {readConversationArchive,searchPrivateMessages} from './PrivateSearch.js';

export function vortexOrigin(endpoint) {
  if(!endpoint)return null;
  try {const url=new URL(endpoint);return url.pathname.replace(/\/$/u,'')==='/vortex/api'?auth.origin(url.origin):null;}catch{return null;}
}
const capabilities=new Map();
export async function verifyNode(origin) {
  let pending=capabilities.get(origin);
  if(!pending) {
    pending=(async()=>{
      const response=await fetch(origin+'/.well-known/vortex',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('This server does not support Vortex encryption');
      const data=await response.json();
      if(data.protocol!=='vortex-chat'||data.version!==1||data.authentication!=='opaque-v1'||data.conversations!=='mls-archive-v1')throw new Error('Unsupported Vortex encryption protocol');
      return data;
    })();capabilities.set(origin,pending);pending.catch(()=>capabilities.delete(origin));
  }
  return pending;
}
function unsupported(path){throw Object.assign(new Error('This operation is not available on this Vortex Node client yet'),{status:501,code:'VORTEX_UNSUPPORTED_OPERATION'});}
// Reject unsupported settings before changing anything. In particular, private
// channel permissions must never appear to save while admitting every member.
function supportedChannelFields(body,keys) {
  for(const [key,value]of Object.entries(body)) {
    if(value==null||keys.includes(key))continue;
    if(key==='permission_overwrites'&&Array.isArray(value)&&!value.length)continue;
    if(['lock_permissions','user_limit','voice_connection_limit'].includes(key)&&!value)continue;
    unsupported('/channels/settings/'+key);
  }
}
function parentRoom(session,space,parentId) {
  if(parentId==null)return null;
  const parent=session.room(parentId);
  if(!parent||parent.space!==space||parent.meta.category!==true)throw new Error('Choose a category in this Space');
  return parent.id;
}
function channelPatch(session,room,body) {
  supportedChannelFields(body,['name','topic','position','parent_id','nsfw','bitrate']);
  const patch={name:body.name,topic:body.topic,position:body.position,nsfw:body.nsfw};
  if(body.name!==undefined&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>100))throw new Error('Enter a channel name of at most 100 characters');
  if(body.topic!=null&&(typeof body.topic!=='string'||body.topic.length>4096))throw new Error('Channel topic is too long');
  if(body.position!==undefined&&(!Number.isSafeInteger(body.position)||body.position<0||body.position>10000))throw new Error('Invalid channel position');
  if(body.nsfw!==undefined&&typeof body.nsfw!=='boolean')throw new Error('Invalid channel setting');
  if(body.parent_id!==undefined){if(room.meta.category&&body.parent_id!==null)throw new Error('Categories cannot be nested');patch.parent=parentRoom(session,room.space,body.parent_id);}
  if(body.bitrate!=null&&(room.kind!=='voice'||![32000,64000,128000].includes(body.bitrate)))unsupported('/channels/bitrate');
  return patch;
}
const activeSends=new Map();
async function sendMessage(session,room,body,files) {
  const key=session.pair.url+':'+session.pair.id+':'+room.id+':'+body.nonce;
  if(body.nonce&&activeSends.has(key))return activeSends.get(key);
  const operation=(async()=>{
    await session.refresh(true);
    let prior=body.nonce&&materializeMessages(session.core.state,room).find(event=>event.sender===session.pair.id&&event.payload.nonce===body.nonce);
    if(prior)return session.message(room,prior);
    if(body.sticker_ids?.length)unsupported('/stickers');
    const attachments=[];
    for(const file of files)attachments.push(await session.core.upload(file,room));
    const payload={type:'message',text:body.content||'',nonce:body.nonce||crypto.randomUUID(),files:attachments};
    if(body.message_reference?.message_id)payload.reply=session.ids.raw('message',body.message_reference.message_id);
    await session.core.send(payload,'message',room);
    await session.ids.index(session.core.state);
    prior=materializeMessages(session.core.state,room).find(event=>event.sender===session.pair.id&&event.payload.nonce===payload.nonce);
    if(!prior)throw new Error('Message acknowledgement is pending. Reconnect to synchronize.');
    const result=await session.message(room,prior);session.emit('MESSAGE_CREATE',result);return result;
  })();
  if(body.nonce)activeSends.set(key,operation);
  try{return await operation;}finally{activeSends.delete(key);}
}

export async function vortexRequest(origin,method,path,options={},token) {
  options.signal?.throwIfAborted();
  await verifyNode(origin);
  const parsed=new URL(path,origin);
  if(parsed.origin!==origin)throw new Error('Request origin mismatch');
  const route=parsed.pathname.replace(/^\/vortex\/api(?:\/v1)?/u,'').replace(/\/$/u,'')||'/';
  const query=Object.fromEntries(parsed.searchParams);
  if(options.query instanceof URLSearchParams)Object.assign(query,Object.fromEntries(options.query));
  else Object.assign(query,options.query||{});
  let body=options.body||{};const files=[];
  const form=options.raw instanceof FormData?options.raw:body instanceof FormData?body:null;
  if(form){body=JSON.parse(String(form.get('payload_json')||'{}'));for(const [,value]of form)if(value instanceof File)files.push(value);}
  let data;let status=200;
  if(route==='/auth/login'&&method==='POST')data=await login(origin,body);
  else if(route==='/auth/register'&&method==='POST')data=await register(origin,body);
  else if(route==='/auth/username-availability'&&method==='GET') {
    const config=await auth.api(origin,'auth.config',{username:query.username});data={taken:config.registered};
  } else if(route==='/auth/logout'&&method==='POST'){await logout(token,origin);status=204;}
  else {
    const session=await getSession(token,origin),core=session.core,state=core.state,ids=session.ids;
    let match;
    if(route==='/premium/state'&&method==='GET')data=freePremiumState();
    else if(route==='/search/messages'&&method==='POST')data=await searchPrivateMessages(session,body,options.signal);
    else if(route==='/users/@me/saved-messages'&&method==='POST') {
      const room=session.room(body.channel_id);
      if(!room)throw Object.assign(new Error('Conversation unavailable'),{status:404});
      const target=ids.raw('message',body.message_id);
      const event=(await readConversationArchive(session,room,options.signal)).find(event=>event.id===target);
      if(!event)throw Object.assign(new Error('Message unavailable'),{status:404});
      const saved=state.prefs.savedMessages||[];
      if(!saved.some(item=>item.id===target)){
        if(saved.length>=2000)throw new Error('Remove a bookmark before saving another');
        state.prefs.savedMessages=[...saved,{id:target,room:room.id,wire:body.message_id,channel:body.channel_id}];
        await core.savePreferences();
      }
      data=await session.message(room,event);session.emit('SAVED_MESSAGE_CREATE',data);
    } else if(route==='/users/@me/saved-messages'&&method==='GET') {
      const saved=[...state.prefs.savedMessages||[]].filter(item=>!query.before||BigInt(item.wire)<BigInt(query.before));
      saved.sort((a,b)=>BigInt(a.wire)<BigInt(b.wire)?1:-1);
      const archives=new Map();data=[];
      for(const item of saved.slice(0,Math.max(1,Math.min(100,Number(query.limit)||50)))) {
        const room=state.rooms.find(room=>room.id===item.room);let message=null;
        if(room){
          if(!archives.has(room.id))archives.set(room.id,await readConversationArchive(session,room,options.signal));
          const event=archives.get(room.id).find(event=>event.id===item.id);
          if(event)message=await session.message(room,event);
        }
        data.push({id:item.wire,message_id:item.wire,channel_id:item.channel,status:message?'available':'missing_permissions',message});
      }
    } else if((match=route.match(/^\/users\/@me\/saved-messages\/(\d+)$/u))&&method==='DELETE') {
      state.prefs.savedMessages=(state.prefs.savedMessages||[]).filter(item=>item.wire!==match[1]);
      await core.savePreferences();session.emit('SAVED_MESSAGE_DELETE',{message_id:match[1]});status=204;
    }
    else if(route==='/users/@me'&&method==='GET')data=session.currentUser();
    else if(route==='/users/@me/mfa/totp/start'&&method==='POST')data=await core.action('totp.start');
    else if(route==='/users/@me/mfa/totp/enable'&&method==='POST'){
      const result=await core.action('totp.finish',{otp:body.code});
      state.me=await core.action('me');session.emit('USER_UPDATE',session.currentUser());
      data={backup_codes:result.recovery.map(code=>({code,consumed:false}))};
    } else if(route==='/users/@me/mfa/totp/disable'&&method==='POST'){
      await core.action('totp.disable',{otp:body.code});state.me=await core.action('me');session.emit('USER_UPDATE',session.currentUser());status=204;
    }
    else if(route==='/users/@me/settings') {
      if(method==='PATCH') {state.prefs.fluxer={...state.prefs.fluxer,...body};await core.savePreferences();session.emit('USER_SETTINGS_UPDATE',state.prefs.fluxer);}
      else if(method!=='GET')unsupported(route);
      data=state.prefs.fluxer||{};
    } else if(route==='/users/@me/channels'&&method==='GET')data=state.rooms.filter(room=>!room.space&&session.visibleRoom(room)).map(room=>channelView(ids,state,room));
    else if(route==='/users/@me/channels'&&method==='POST') {
      const recipients=(body.recipients||[body.recipient_id]).filter(Boolean).map(id=>ids.raw('user',id));
      const existing=recipients.length===1&&state.rooms.find(room=>room.kind==='dm'&&room.meta.members.includes(recipients[0]));
      const room=existing||await core.createRoom(recipients.length===1?'dm':'group',{name:body.name||state.users.find(u=>u.id===recipients[0])?.display||'Group chat',members:recipients,space:'',background:true});
      if(existing&&state.prefs.closedDms?.[room.id]!==undefined){delete state.prefs.closedDms[room.id];await core.savePreferences();}
      await ids.index(state);data=channelView(ids,state,room);session.emit('CHANNEL_CREATE',data);
    } else if(route==='/users/@me/relationships'&&method==='GET')data=(await session.ready('local')).relationships;
    else if(route==='/users/@me/relationships'&&method==='POST') {
      const user=state.users.find(user=>user.username===body.username||ids.get('user',user.id)===body.user_id);
      if(!user)throw Object.assign(new Error('No account has that username on this Node'),{status:404});
      await core.action('friend',{user:user.id,kind:'request'});status=204;
    } else if((match=route.match(/^\/users\/@me\/relationships\/(\d+)$/u))) {
      const id=ids.raw('user',match[1]);
      if(method==='PUT')await core.action('friend',{user:id,kind:body.type===2?'block':'accept'});
      else if(method==='DELETE')await core.action('friend',{user:id,kind:'remove'});else unsupported(route);
      await session.refresh(true);const relationship=(await session.ready('local')).relationships.find(r=>r.id===match[1]);
      session.emit(relationship?'RELATIONSHIP_ADD':'RELATIONSHIP_REMOVE',relationship||{id:match[1],type:1});status=204;
    } else if((match=route.match(/^\/users\/(\d+)(\/profile)?$/u))&&method==='GET') {
      const user=state.users.find(u=>u.id===ids.raw('user',match[1]));
      if(!user)throw Object.assign(new Error('Account unavailable'),{status:404});
      data=match[2]?{user:userView(ids,user),user_profile:{bio:'',pronouns:'',accent_color:null,banner:null},connected_accounts:[],mutual_guilds:[],mutual_friends:[]}:userView(ids,user);
    } else if(route==='/guilds'&&method==='POST') {
      if(typeof body.name!=='string'||!body.name.trim())throw Object.assign(new Error('Enter a Space name'),{status:400});
      const space=(await core.action('space.create',{sealed:auth.b64(auth.random(64))})).id;
      await core.createRoom('text',{space,spaceName:body.name,name:'general',members:[],background:true});
      await session.refresh(true);const guild=guildView(ids,state,state.spaces.find(s=>s.id===space));
      session.emit('GUILD_CREATE',guild);data={...guild.properties,roles:guild.roles,channels:guild.channels};
    } else if((match=route.match(/^\/guilds\/(\d+)\/channels$/u))) {
      const space=ids.raw('guild',match[1]);
      if(method==='GET')data=state.rooms.filter(room=>room.space===space).map(room=>channelView(ids,state,room));
      else if(method==='POST') {
        supportedChannelFields(body,['name','type','parent_id','bitrate']);
        if(![0,2,4].includes(body.type??0))unsupported(route);
        if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100)throw new Error('Enter a channel name of at most 100 characters');
        const parent=parentRoom(session,space,body.parent_id);
        if(body.type===4&&parent)throw new Error('Categories cannot be nested');
        if(body.bitrate!=null&&(body.type!==2||![32000,64000,128000].includes(body.bitrate)))unsupported('/channels/bitrate');
        const members=(await core.action('space.members',{space})).members.filter(member=>!member.banned).map(member=>member.user);
        const room=await core.createRoom(body.type===2?'voice':'text',{space,spaceName:state.rooms.find(r=>r.space===space)?.meta.spaceName||'Space',name:body.name,members,category:body.type===4,parent,background:true});
        if(body.bitrate!=null){await core.action('room.audio',{room:room.id,audio:body.bitrate/1000});room.audio=body.bitrate/1000;}
        await ids.index(state);data=channelView(ids,state,room);session.emit('CHANNEL_CREATE',data);
      } else if(method==='PATCH'&&Array.isArray(body)) {
        const changes=body.map(item=>{const room=session.room(item.id);if(!room||room.space!==space)throw new Error('Channel unavailable');const {id,...values}=item;supportedChannelFields(values,['position','parent_id']);return {room,patch:channelPatch(session,room,values)};});
        for(const {room,patch}of changes)await core.updateMetadata(room,patch);
        await session.refresh(true);for(const {room}of changes)session.emit('CHANNEL_UPDATE',channelView(ids,state,session.room(ids.get('channel',room.id))));
        status=204;
      } else unsupported(route);
    } else if((match=route.match(/^\/guilds\/(\d+)(?:\/members(?:\/(\d+))?)?$/u))&&method==='GET') {
      const guild=guildView(ids,state,state.spaces.find(s=>s.id===ids.raw('guild',match[1])));
      data=route.includes('/members')?(match[2]?guild.members.find(m=>m.user.id===match[2]):guild.members):{...guild.properties,roles:guild.roles};
    } else if((match=route.match(/^\/channels\/(\d+)(.*)$/u))) {
      const room=session.room(match[1]);if(!room)throw Object.assign(new Error('Conversation unavailable'),{status:404});
      const suffix=match[2];
      if(room.meta.category&&['/messages','/typing','/call'].some(path=>suffix.startsWith(path)))unsupported(route);
      if(suffix==='/messages'&&method==='GET')data=await session.messages(room,query);
      else if(suffix==='/messages'&&method==='POST')data=await sendMessage(session,room,body,files);
      else if(suffix===''&&method==='GET')data=channelView(ids,state,room);
      else if(suffix===''&&method==='PATCH'){
        const patch=channelPatch(session,room,body);
        await core.updateMetadata(room,patch);
        if(body.bitrate!=null)await core.action('room.audio',{room:room.id,audio:body.bitrate/1000});
        await session.refresh(true);data=channelView(ids,state,session.room(match[1]));session.emit('CHANNEL_UPDATE',data);
      }
      else if(suffix===''&&method==='DELETE') {
        if(room.kind==='dm') {
          // Closing a DM is an account preference, never deletion of shared history.
          state.prefs.closedDms??={};
          state.prefs.closedDms[room.id]=Math.max(0,...(state.messages.get(room.id)||[]).filter(event=>event.payload?.type==='message').map(event=>event.seq));
          await core.savePreferences();
        } else if(!room.space)unsupported(route);
        else await core.action('room.delete',{room:room.id});
        session.emit('CHANNEL_DELETE',channelView(ids,state,room));await session.refresh(true);status=204;
      }
      else if(suffix==='/typing'&&method==='POST'){await core.send({type:'typing'},'typing',room);status=204;}
      else if(suffix==='/call'&&method==='GET')data={ringable:!room.space,...callView(ids,state,room)};
      else if(['/call/ring','/call/stop-ringing'].includes(suffix)&&method==='POST'){
        if(room.space)throw new Error('Ringing is available in private conversations');
        const recipients=body.recipients?body.recipients.map(id=>ids.raw('user',id)):suffix==='/call/ring'?room.meta.members.filter(id=>id!==state.me.id):[state.me.id];
        if(recipients.some(id=>!room.meta.members.includes(id)))throw new Error('Call recipient is not in this conversation');
        if(suffix==='/call/ring'&&session.voice?.room!==room.id)throw new Error('Join the encrypted call before ringing');
        await core.send({type:'call',state:suffix==='/call/ring'?'ring':'stop-ringing',recipients},'call',room);status=204;
      } else if(suffix==='/rtc-regions'&&method==='GET')data=[];
      else if(suffix==='/call'&&method==='PATCH'){if(body.region&&body.region!=='auto')throw new Error('This Node uses its own media relay');data={region:'auto'};}
      else if(suffix==='/pins'&&method==='GET')data=await Promise.all(materializeMessages(state,room).filter(e=>e.pinned&&!e.deleted).map(e=>session.message(room,e)));
      else if(suffix.startsWith('/messages/search')&&method==='GET') {
        const matching=materializeMessages(state,room).filter(e=>!e.deleted&&(e.payload.text||'').toLocaleLowerCase().includes(String(query.content||'').toLocaleLowerCase()));
        data={total_results:matching.length,messages:await Promise.all(matching.slice(0,25).map(async e=>[await session.message(room,e)]))};
      } else {
        const eventRoute=suffix.match(/^\/(messages|pins)\/(\d+)(?:\/(ack|reactions)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/u);
        if(!eventRoute)unsupported(route);
        const target=ids.raw('message',eventRoute[2]);
        if(eventRoute[3]==='ack'){state.prefs.read??={};state.prefs.read[room.id]=target;await core.savePreferences();session.emit('MESSAGE_ACK',{channel_id:match[1],message_id:eventRoute[2],mention_count:0,manual:false});data={token:null};}
        else if(eventRoute[3]==='reactions'){
          if(method==='GET'){
            const event=materializeMessages(state,room).find(event=>event.id===target&&!event.deleted);
            const people=event?.reactions.get(decodeURIComponent(eventRoute[4]))||new Set();
            data=[...people].map(id=>state.users.find(user=>user.id===id)||state.formerUsers?.find(user=>user.id===id)).filter(Boolean).map(user=>userView(ids,user));
            if(query.after)data=data.filter(user=>BigInt(user.id)>BigInt(query.after));
            data.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);data=data.slice(0,Math.max(1,Math.min(100,Number(query.limit)||25)));
            return {ok:true,status:200,headers:{'content-type':'application/json'},body:data};
          }
          if(!['PUT','DELETE'].includes(method))unsupported(route);
          await core.send({type:'reaction',target,emoji:decodeURIComponent(eventRoute[4]),remove:method==='DELETE'},'message',room);status=204;
        } else if(eventRoute[1]==='pins'&&['PUT','DELETE'].includes(method)){await core.send({type:'pin',target,enabled:method==='PUT'},'message',room);status=204;}
        else if(method==='PATCH'){await core.send({type:'edit',target,text:body.content},'message',room);}
        else if(method==='DELETE'){await core.send({type:'delete',target},'message',room);session.emit('MESSAGE_DELETE',{id:eventRoute[2],channel_id:match[1]});status=204;}
        else if(method!=='GET')unsupported(route);
        if(status!==204&&eventRoute[3]!=='ack'){
          const event=materializeMessages(state,room).find(e=>e.id===target&&!e.deleted);
          if(!event)throw Object.assign(new Error('Message unavailable'),{status:404});data=await session.message(room,event);
          if(method!=='GET')session.emit('MESSAGE_UPDATE',data);
        }
      }
    } else if(route==='/users/@me/guilds'&&method==='GET')data=state.spaces.map(space=>guildView(ids,state,space).properties);
    else if((match=route.match(/^\/users\/@me\/guilds\/(\d+|@me)\/settings$/u))&&method==='PATCH'){
      const key=match[1];
      const until=config=>config?.end_time?Math.floor(Date.parse(config.end_time)/1000):Math.floor(Date.now()/1000)+10*365*86400;
      if(key!=='@me'&&typeof body.muted==='boolean')await core.action('mute',{scope:'space:'+ids.raw('guild',key),until:body.muted?until(body.mute_config):0});
      for(const [channel,override]of Object.entries(body.channel_overrides||{}))if(typeof override.muted==='boolean')
        await core.action('mute',{scope:'room:'+ids.raw('channel',channel),until:override.muted?until(override.mute_config):0});
      state.prefs.guildSettings??={};
      const previous=state.prefs.guildSettings[key]||{};
      state.prefs.guildSettings[key]={...previous,...body,channel_overrides:{...previous.channel_overrides,...body.channel_overrides},guild_id:key==='@me'?null:key};
      await core.savePreferences();data=state.prefs.guildSettings[key];session.emit('USER_GUILD_SETTINGS_UPDATE',data);
    } else if((match=route.match(/^\/users\/@me\/channels\/(\d+)\/pin$/u))&&['PUT','DELETE'].includes(method)){
      if(!session.room(match[1])||session.room(match[1]).space)throw new Error('Private conversation unavailable');
      state.prefs.pinnedDms=(state.prefs.pinnedDms||[]).filter(id=>id!==match[1]);
      if(method==='PUT')state.prefs.pinnedDms.push(match[1]);await core.savePreferences();status=204;
    }
    else if(route==='/vortex/node'&&method==='GET')data={...await core.action('me'),applications:(await verifyNode(origin)).applications};
    else if(route==='/vortex/node'&&method==='PATCH'){await core.action('policy',body);state.me=await core.action('me');data=state.me.policy;}
    else if(route==='/vortex/users'&&method==='GET')data=await core.action('admin.users');
    else if(route==='/vortex/users'&&method==='PATCH'){await core.action('admin.user',body);status=204;}
    else if(route==='/vortex/invite'&&method==='POST')data=await core.action('invite',body);
    else if(route==='/vortex/spaces'&&method==='GET')data=state.spaces.map(space=>({id:space.id,name:state.rooms.find(r=>r.space===space.id)?.meta.spaceName||'Space',canInvite:space.creator===state.me.id||!!(space.permissions&2)}));
    else if(route==='/vortex/space-invites'&&method==='GET')data=(await core.invitations()).map(item=>({id:item.id,name:item.name,sender:state.users.find(u=>u.id===item.sender)?.username,channels:item.body.rooms.length}));
    else if(route==='/vortex/space-invites'&&method==='POST'){
      const target=state.users.find(user=>user.username===body.username);if(!target)throw new Error('No account has that username on this Node');
      data={id:await core.inviteSpace(body.space||(body.guild_id&&ids.raw('guild',body.guild_id)),target.id)};
    }
    else if(route==='/vortex/space-invites'&&method==='PATCH'){await core.respondInvitation(body.id,body.accept===true);await session.refresh(true);status=204;}
    else if(route==='/vortex/storage'&&method==='GET')data=await core.action('admin.storage');
    else if(['/users/@me/push/subscribe','/users/@me/push/rotate'].includes(route)&&method==='POST'){
      await core.action('push',{endpoint:body.endpoint,p256dh:body.keys?.p256dh,auth:body.keys?.auth});
      if(body.old_endpoint&&body.old_endpoint!==body.endpoint)await core.action('push.remove',{endpoint:body.old_endpoint});
      data={subscription_id:(await auth.digest(auth.enc.encode(body.endpoint))).slice(0,32)};
    } else if(route==='/users/@me/push/subscriptions'&&method==='GET'){
      data={subscriptions:await Promise.all((await core.action('push.list')).endpoints.map(async endpoint=>({subscription_id:(await auth.digest(auth.enc.encode(endpoint))).slice(0,32),user_agent:null})))};
    } else if((match=route.match(/^\/users\/@me\/push\/subscriptions\/([a-f0-9]{32})$/u))&&method==='DELETE'){
      for(const endpoint of (await core.action('push.list')).endpoints)if((await auth.digest(auth.enc.encode(endpoint))).slice(0,32)===match[1])await core.action('push.remove',{endpoint});status=204;
    }
    else if(route==='/users/@me/notes'&&method==='GET')data=state.prefs.notes||{};
    else if((match=route.match(/^\/users\/@me\/notes\/(\d+)$/u))&&method==='PUT'){state.prefs.notes??={};state.prefs.notes[match[1]]=body.note;await core.savePreferences();status=204;}
    else if(['/users/@me/connections','/users/@me/favorite-memes','/users/@me/gifts','/rtc/regions'].includes(route)&&method==='GET')data=[];
    else unsupported(route);
  }
  options.signal?.throwIfAborted();
  return {ok:true,status,headers:{'content-type':'application/json'},body:data};
}
