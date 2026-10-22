// SPDX-License-Identifier: AGPL-3.0-or-later
import {auth} from './vendor/auth.js';
import {createVortexCore} from './Core.js';
import {registerAttachment,registerAttachmentAlias,unregisterAttachments} from './AttachmentDownloads.js';
import {VortexIds,channelView,guildView,userView,materializeMessages} from './Projection.js';

export class VortexSession {
  ids=new VortexIds();listeners=new Set();attachmentUrls=new Map();attachmentReferences=new Map();previewBytes=0;voice=null;
  constructor(pair) {
    this.pair=pair;
    this.core=createVortexCore({notice:message=>this.emit('VORTEX_NOTICE',{message}),mediaEpochChanged:()=>this.updateMediaEpoch()});
  }
  async open() {await this.core.connect(this.pair,await auth.restoreRoot(this.pair));await this.refresh();return this;}
  emit(type,data){for(const listener of this.listeners)listener(type,data);}
  async refresh() {await this.core.sync();await this.ids.index(this.core.state);}
  currentUser(){const s=this.core.state;return userView(this.ids,s.users.find(u=>u.id===s.me.id)||s.me,s.me);}
  room(id){return this.core.state.rooms.find(room=>this.ids.get('channel',room.id)===id);}
  async ready(sessionId) {
    const state=this.core.state;
    const friends=(await this.core.action('friends')).friends;
    return {session_id:sessionId,user:this.currentUser(),users:state.users.map(user=>userView(this.ids,user)),
      guilds:state.spaces.map(space=>guildView(this.ids,state,space)),private_channels:state.rooms.filter(room=>!room.space).map(room=>channelView(this.ids,state,room)),
      relationships:friends.map(friend=>{const incoming=friend.user!==state.me.id;const id=incoming?friend.user:friend.other;return {id:this.ids.get('user',id),user:userView(this.ids,state.users.find(u=>u.id===id)),
        type:friend.status==='friend'?1:friend.status==='blocked'?2:incoming?3:4,since:new Date(0).toISOString(),share_voice_activity:false,friend_shares_voice_activity:false};}),
      user_settings:state.prefs.fluxer||undefined,
      read_states:state.rooms.flatMap(room=>{const id=state.prefs.read?.[room.id];if(!id)return [];try{return [{id:this.ids.get('channel',room.id),last_message_id:this.ids.get('message',id),mention_count:0}];}catch{return [];}}),
      user_guild_settings:Object.values(state.prefs.guildSettings||{}),presences:state.users.map(user=>({user:{id:this.ids.get('user',user.id)},status:user.status||'offline',activities:[]})),
      rtc_regions:[],notes:state.prefs.notes||{},pinned_dms:state.prefs.pinnedDms||[],favorite_memes:[],webauthn_credentials:[]};
  }
  async attachment(file) {
    let reference=this.attachmentReferences.get(file.id);
    if(!reference){reference=registerAttachment(this,file);this.attachmentReferences.set(file.id,reference);}
    let pending=this.attachmentUrls.get(file.id);
    const previewable=/^image\/(png|jpeg|webp|gif|avif)$/u.test(file.type)&&file.size<=8*1024**2;
    if(!pending&&previewable&&this.previewBytes+file.size<=32*1024**2) {
      this.previewBytes+=file.size;
      pending=this.core.download(file).then(async blob=>{
        const url=URL.createObjectURL(blob);
        try {
          const bitmap=await createImageBitmap(blob);
          const dimensions={width:bitmap.width,height:bitmap.height};bitmap.close();
          registerAttachmentAlias(url,reference);return {url,...dimensions};
        }catch(error){URL.revokeObjectURL(url);throw error;}
      });
      this.attachmentUrls.set(file.id,pending);
      pending.catch(()=>{this.attachmentUrls.delete(file.id);this.previewBytes-=file.size;});
    }
    const preview=pending?await pending.catch(()=>null):null;
    return {id:await this.ids.add('attachment',file.id),filename:file.name,size:file.size,content_type:preview?file.type:'application/octet-stream',url:reference,proxy_url:preview?.url||reference,
      width:preview?.width||file.width||null,height:preview?.height||file.height||null,flags:0};
  }
  async message(room,event,attachments=true) {
    const state=this.core.state;
    const payload=event.payload;
    const result={id:this.ids.get('message',event.id),channel_id:this.ids.get('channel',room.id),guild_id:room.space?this.ids.get('guild',room.space):undefined,
      author:userView(this.ids,state.users.find(u=>u.id===event.sender)||state.formerUsers?.find(u=>u.id===event.sender)||{id:event.sender,username:'deleted-user'}),
      content:payload.text||'',timestamp:new Date(event.at*1000).toISOString(),edited_timestamp:event.editedAt?new Date(event.editedAt*1000).toISOString():null,
      type:payload.reply?19:0,tts:false,mention_everyone:false,mentions:[],mention_roles:[],attachments:attachments?await Promise.all((payload.files||[]).map(file=>this.attachment(file))):[],
      embeds:[],sticker_items:[],flags:0,pinned:!!event.pinned,nonce:payload.nonce,
      reactions:[...event.reactions||[]].filter(([,people])=>people.size).map(([name,people])=>({count:people.size,me:people.has(state.me.id),emoji:{id:null,name,animated:false}}))};
    if(payload.reply) {
      try {result.message_reference={message_id:this.ids.get('message',payload.reply),channel_id:result.channel_id,guild_id:result.guild_id};}catch{}
    }
    return result;
  }
  async messages(room,query={}) {
    if(query.before) {
      const raw=this.ids.raw('message',query.before);
      const event=(this.core.state.messages.get(room.id)||[]).find(e=>e.id===raw);
      if(event)await this.core.loadHistory(room,event.seq);
      await this.ids.index(this.core.state);
    }
    let messages=materializeMessages(this.core.state,room).filter(event=>!event.deleted);
    if(query.before)messages=messages.filter(event=>BigInt(this.ids.get('message',event.id))<BigInt(query.before));
    if(query.after)messages=messages.filter(event=>BigInt(this.ids.get('message',event.id))>BigInt(query.after));
    return Promise.all(messages.slice(-Math.min(100,Number(query.limit)||50)).reverse().map(event=>this.message(room,event)));
  }
  async updateMediaEpoch() {
    if(!this.voice)return;
    const room=this.core.state.rooms.find(room=>room.id===this.voice.room);
    if(!room){this.emit('VORTEX_VOICE_REVOKED',{});this.voice=null;return;}
    const key=auth.b64(await this.core.mediaKey(room));
    if(key!==this.voice.key){this.voice.key=key;this.emit('VORTEX_MEDIA_KEY',{key});}
  }
  close(){unregisterAttachments(this);this.core.close();for(const pending of this.attachmentUrls.values())pending.then(value=>URL.revokeObjectURL(value.url),()=>{});this.attachmentUrls.clear();this.attachmentReferences.clear();this.listeners.clear();}
}

const sessions=new Map();
async function pairKey(token){return 'fluxer-pair:'+await auth.digest(auth.enc.encode(token));}
async function savePair(pair) {
  const key=await pairKey(pair.token),deviceKey=await auth.store('get','device-key');
  if(!deviceKey)throw new Error('Local account key is unavailable');
  await auth.store('set',key,auth.b64(await auth.seal(deviceKey,auth.enc.encode(JSON.stringify(pair)),key)));
  // The source authentication helper uses this transient record during owner migration.
  await auth.store('delete','pair');
}
export async function getSession(token,origin) {
  if(!token)throw Object.assign(new Error('Sign in to unlock Chat'),{status:401});
  let pending=sessions.get(token);
  if(!pending) {
    pending=(async()=>{
      const key=await pairKey(token),encrypted=await auth.store('get',key),deviceKey=await auth.store('get','device-key');
      if(!encrypted||!deviceKey)throw Object.assign(new Error('Sign in to unlock this device'),{status:401});
      const pair=JSON.parse(auth.dec.decode(await auth.open(deviceKey,auth.un64(encrypted),key)));
      if(pair.token!==token||pair.url!==origin)throw new Error('Session origin mismatch');
      return new VortexSession(pair).open();
    })();
    sessions.set(token,pending);pending.catch(()=>sessions.delete(token));
  }
  const session=await pending;if(session.pair.url!==origin)throw new Error('Session origin mismatch');return session;
}
export async function login(origin,body) {
  const pair=await auth.login({url:origin,username:body.login||body.username||body.email,password:body.password,otp:body.code||'',months:12});
  await savePair(pair);
  const session=await getSession(pair.token,origin);
  return {token:pair.token,user_id:session.currentUser().id,user:session.currentUser()};
}
export async function register(origin,body) {
  await auth.register({url:origin,username:body.username,password:body.password,invite:body.invite_code||new URL(globalThis.location?.href||origin).searchParams.get('invite')||''});
  return login(origin,body);
}
export async function logout(token,origin) {
  const session=await getSession(token,origin);
  await session.core.action('logout');session.close();sessions.delete(token);await auth.store('delete',await pairKey(token));
}
