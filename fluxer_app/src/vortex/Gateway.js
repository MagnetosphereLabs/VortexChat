// SPDX-License-Identifier: AGPL-3.0-or-later
import {getSession} from './Session.js';
import {verifyNode} from './Rest.js';
import {auth} from './vendor/auth.js';
import {channelView,guildView,materializeMessages,callView} from './Projection.js';

export class VortexGateway {
  kind='browser';readyState=0;listeners=new Map();sequence=0;sessionId=crypto.randomUUID();seen=new Map();channels=new Map();guilds=new Map();relationships=new Map();voiceEvents=new Set();
  presences=new Map();typing=new Map();calls=new Map();status='online';
  constructor(url){const parsed=new URL(url);parsed.protocol=parsed.protocol==='wss:'?'https:':'http:';this.origin=auth.origin(parsed.origin);}
  on(event,listener){let listeners=this.listeners.get(event);if(!listeners){listeners=new Set();this.listeners.set(event,listeners);}listeners.add(listener);return()=>listeners.delete(listener);}
  emit(event,detail){for(const listener of this.listeners.get(event)||[])listener({target:this,...detail});}
  packet(op,d,t){if(this.readyState!==1)return;this.emit('message',{data:JSON.stringify({op,d,...t?{t,s:++this.sequence}:{}})});}
  dispatch(type,data){this.packet(0,data,type);}
  start(){queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this.emit('open',{});this.packet(10,{heartbeat_interval:20000});});}
  send(raw) {
    let packet;try{packet=JSON.parse(typeof raw==='string'?raw:new TextDecoder().decode(raw));}catch{this.fail(new Error('Invalid gateway packet'));return;}
    if(packet.op===1){this.packet(11,null);return;}
    this.pending=(this.pending||Promise.resolve()).then(async()=>{
      if(packet.op===2||packet.op===6)await this.identify(packet.d);
      else if(packet.op===4)await this.voice(packet.d);
      else if(packet.op===3&&this.session){
        this.status=packet.d.status||'online';
        await this.session.core.action('status',{status:this.status});
        await this.heartbeat();
      }
      else if(packet.op===8&&this.session) {
        const ids=Array.isArray(packet.d.guild_id)?packet.d.guild_id:[packet.d.guild_id];
        for(const id of ids){const guild=this.guilds.get(id);if(guild)this.dispatch('GUILD_MEMBERS_CHUNK',{guild_id:id,members:guild.members,chunk_index:0,chunk_count:1,nonce:packet.d.nonce});}
      }
    }).catch(error=>this.fail(error));
  }
  async identify(data) {
    await verifyNode(this.origin);
    this.session=await getSession(data.token,this.origin);
    if(this.readyState!==1)return;
    this.unsubscribe=()=>this.session.listeners.delete(this.onDispatch);
    this.onDispatch=(type,body)=>{
      if(type==='VORTEX_MEDIA_KEY'){globalThis.dispatchEvent?.(new CustomEvent('vortex-media-key',{detail:{channelId:this.lastVoice?.channel_id,key:body.key}}));return;}
      if(type==='VORTEX_VOICE_REVOKED'){void this.voice({channel_id:null});return;}
      if(type.startsWith('VORTEX_'))return;
      this.dispatch(type,body);
    };
    this.session.listeners.add(this.onDispatch);
    await this.heartbeat();await this.session.refresh();
    const ready=await this.session.ready(this.sessionId);
    for(const guild of ready.guilds)this.guilds.set(guild.id,guild);
    for(const channel of [...ready.private_channels,...ready.guilds.flatMap(g=>g.channels)])this.channels.set(channel.id,channel);
    for(const relationship of ready.relationships)this.relationships.set(relationship.id,relationship);
    // READY provides channels and read state; old messages are loaded by history requests.
    for(const room of this.session.core.state.rooms)for(const event of materializeMessages(this.session.core.state,room))this.seen.set(event.id,JSON.stringify({...event,reactions:[...event.reactions].map(([key,people])=>[key,[...people]])}));
    this.dispatch('READY',ready);
    for(const presence of ready.presences)this.presences.set(presence.user.id,presence.status);
    this.heartbeatTimer=setInterval(()=>{void this.heartbeat().catch(error=>this.fail(error));},20000);
    this.poll=setInterval(()=>{void this.refresh().catch(error=>this.fail(error));},5000);
    this.streamAbort=new AbortController();void this.stream(this.streamAbort.signal);
  }
  async heartbeat() {
    if(!this.session||this.readyState!==1)return;
    await this.session.core.action('presence',{idle:this.status==='idle',instance:this.sessionId,viewing:globalThis.document?.visibilityState!=='hidden'});
    if(this.lastVoice) {
      const room=this.session.room(this.lastVoice.channel_id);
      if(room)await this.session.core.send({type:'call',state:'updated',voice:this.lastVoice},'call',room);
    }
  }
  async stream(signal) {
    while(!signal.aborted&&this.readyState===1) {
      try {
        const response=await fetch(this.origin+'/chat/stream',{headers:{Authorization:'Bearer '+this.session.pair.token},signal,cache:'no-store'});
        if(!response.ok||!response.body)throw new Error('Event stream is unavailable');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        try {while(!signal.aborted){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>65536)throw new Error('Invalid event stream');let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);if(frame.includes('data:'))await this.refresh();}}}
        finally{await reader.cancel().catch(()=>{});}
      } catch(error) {if(signal.aborted)return;}
      await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,2000);signal.addEventListener('abort',done,{once:true});});
    }
  }
  async refresh() {
    if(this.refreshing||!this.session||this.readyState!==1)return;
    this.refreshing=true;
    try {
      await this.session.refresh();const {state}=this.session.core,ids=this.session.ids;
      for(const user of state.users) {
        const id=ids.get('user',user.id),status=user.status||'offline';
        if(this.presences.get(id)!==status){this.dispatch('PRESENCE_UPDATE',{user:{id},status,activities:[]});this.presences.set(id,status);}
      }
      const liveGuilds=new Set(),liveChannels=new Set();
      for(const space of state.spaces){const guild=guildView(ids,state,space);liveGuilds.add(guild.id);if(!this.guilds.has(guild.id))this.dispatch('GUILD_CREATE',guild);this.guilds.set(guild.id,guild);}
      for(const [id]of this.guilds)if(!liveGuilds.has(id)){this.dispatch('GUILD_DELETE',{id});this.guilds.delete(id);}
      for(const room of state.rooms) {
        if(!this.session.visibleRoom(room))continue;
        const channel=channelView(ids,state,room);liveChannels.add(channel.id);
        if(!this.channels.has(channel.id))this.dispatch('CHANNEL_CREATE',channel);
        else if(JSON.stringify(this.channels.get(channel.id))!==JSON.stringify(channel))this.dispatch('CHANNEL_UPDATE',channel);
        this.channels.set(channel.id,channel);
        for(const event of materializeMessages(state,room)) {
          const value=JSON.stringify({...event,reactions:[...event.reactions].map(([key,people])=>[key,[...people]])});
          const prior=this.seen.get(event.id);
          if(prior===value)continue;
          this.seen.set(event.id,value);
          if(event.deleted){if(prior)this.dispatch('MESSAGE_DELETE',{id:ids.get('message',event.id),channel_id:channel.id});}
          else this.dispatch(prior?'MESSAGE_UPDATE':'MESSAGE_CREATE',await this.session.message(room,event));
        }
        for(const user of room.meta.members) {
          const key=room.id+':'+user,at=state.typing.get(key);
          if(at&&at>Date.now()/1000-10&&this.typing.get(key)!==at){this.typing.set(key,at);this.dispatch('TYPING_START',{channel_id:channel.id,guild_id:channel.guild_id,user_id:ids.get('user',user),timestamp:at});}
        }
        const call=callView(ids,state,room),previous=this.calls.get(channel.id);
        if(JSON.stringify(call)!==JSON.stringify(previous||null)) {
          for(const voice of call?.voice_states||[])if(!(previous?.voice_states||[]).some(old=>JSON.stringify(old)===JSON.stringify(voice)))this.dispatch('VOICE_STATE_UPDATE',voice);
          for(const voice of previous?.voice_states||[])if(!(call?.voice_states||[]).some(current=>current.user_id===voice.user_id&&current.connection_id===voice.connection_id))this.dispatch('VOICE_STATE_UPDATE',{...voice,channel_id:null});
          if(!room.space){if(call)this.dispatch(previous?'CALL_UPDATE':'CALL_CREATE',call);else if(previous)this.dispatch('CALL_DELETE',{channel_id:channel.id});}
          if(call)this.calls.set(channel.id,call);else this.calls.delete(channel.id);
        }
      }
      for(const [id,channel]of this.channels)if(!liveChannels.has(id)){this.dispatch('CHANNEL_DELETE',channel);this.channels.delete(id);}
      const current=(await this.session.ready(this.sessionId)).relationships,newIds=new Set(current.map(r=>r.id));
      for(const relationship of current){if(JSON.stringify(this.relationships.get(relationship.id))!==JSON.stringify(relationship))this.dispatch('RELATIONSHIP_ADD',relationship);this.relationships.set(relationship.id,relationship);}
      for(const [id,relationship]of this.relationships)if(!newIds.has(id)){this.dispatch('RELATIONSHIP_REMOVE',relationship);this.relationships.delete(id);}
    } finally {this.refreshing=false;}
  }
  async voice(request) {
    if(!this.session)return;
    const core=this.session.core,state=core.state;
    if(!request.channel_id) {
      if(this.lastVoice){const room=this.session.room(this.lastVoice.channel_id);if(room)await core.send({type:'call',state:'ended',voice:this.lastVoice},'call',room).catch(()=>{});
        this.dispatch('VOICE_STATE_UPDATE',{...this.lastVoice,channel_id:null,user_id:this.session.currentUser().id});}
      this.lastVoice=null;this.session.voice=null;return;
    }
    const room=this.session.room(request.channel_id);if(!room)throw new Error('Conversation unavailable');
    if(this.lastVoice&&this.lastVoice.channel_id!==request.channel_id)await this.voice({channel_id:null});
    await core.withDeviceLock(()=>core.syncRoom(room));
    const connection=request.connection_id||(this.lastVoice?.channel_id===request.channel_id?this.lastVoice.connection_id:null)||crypto.randomUUID();
    const voice={guild_id:request.guild_id||null,channel_id:request.channel_id,connection_id:connection,session_id:this.sessionId,
      self_mute:!!request.self_mute,self_deaf:!!request.self_deaf,self_video:!!request.self_video,self_stream:!!request.self_stream,mute:false,deaf:false,e2ee_capable:true};
    if(this.lastVoice?.channel_id===voice.channel_id) {
      this.lastVoice={...this.lastVoice,...voice};this.dispatch('VOICE_STATE_UPDATE',{...this.lastVoice,user_id:this.session.currentUser().id});
      await core.send({type:'call',state:'updated',voice:this.lastVoice},'call',room);return;
    }
    const response=await fetch(this.origin+'/chat/media',{method:'POST',headers:{Authorization:'Bearer '+this.session.pair.token,'Content-Type':'application/json'},
      body:JSON.stringify({room:room.id,device:state.device,client:'fluxer',connection})});
    const media=await response.json();if(!response.ok)throw new Error(media.error||'Calling is unavailable');
    const key=auth.b64(await core.mediaKey(room));
    this.session.voice={room:room.id,key};this.lastVoice=voice;
    this.dispatch('VOICE_STATE_UPDATE',{...voice,user_id:this.session.currentUser().id});
    this.dispatch('VOICE_SERVER_UPDATE',{channel_id:voice.channel_id,guild_id:voice.guild_id,connection_id:connection,endpoint:media.url,token:media.token,e2ee_key:'vortex:'+voice.channel_id+':'+key});
    await core.send({type:'call',state:'joined',voice},'call',room);
  }
  fail(error){this.emit('error',{error});this.close(error?.status===401?4004:4000,'Encrypted session interrupted');}
  close(code=1000,reason='Closed'){if(this.readyState===3)return;this.readyState=3;clearInterval(this.poll);clearInterval(this.heartbeatTimer);this.streamAbort?.abort();this.unsubscribe?.();
    if(this.session){void this.voice({channel_id:null}).catch(()=>{});void this.session.core.action('presence',{instance:this.sessionId,leave:true}).catch(()=>{});}
    this.emit('close',{code,reason,wasClean:code===1000});}
  dispose(){this.close();this.listeners.clear();}
}
