// SPDX-License-Identifier: AGPL-3.0-or-later
// These are local view models. Decrypted fields never form a Node API request.
import {auth} from './vendor/auth.js';

export class VortexIds {
  forward=new Map(); reverse=new Map();
  async add(kind,id,event) {
    const key=kind+':'+id;
    if(this.forward.has(key))return this.forward.get(key);
    let numeric;
    if(event) {
      if(!Number.isSafeInteger(event.seq)||!Number.isSafeInteger(event.at))throw new Error('Invalid message ordering');
      numeric=((BigInt(event.at)*1000n-1420070400000n)<<22n)|(BigInt(event.seq)&4194303n);
    } else {
      const hash=await auth.digest(auth.enc.encode('vortex-fluxer-v1:'+key));
      numeric=BigInt('0x'+hash.slice(0,16))&0x7fffffffffffffffn;
    }
    if(numeric<=0n)throw new Error('Invalid projected identifier');
    const wire=numeric.toString();
    const prior=this.reverse.get(kind+':'+wire);
    if(prior&&prior!==id)throw new Error('Identifier collision. Refusing ambiguous data.');
    this.forward.set(key,wire);this.reverse.set(kind+':'+wire,id);return wire;
  }
  get(kind,id) {const wire=this.forward.get(kind+':'+id);if(!wire)throw new Error('Unknown '+kind);return wire;}
  raw(kind,wire) {const id=this.reverse.get(kind+':'+wire);if(!id)throw new Error('Unknown '+kind);return id;}
  async index(state) {
    for(const user of [...state.users,...state.formerUsers||[]])await this.add('user',user.id);
    for(const space of state.spaces)await this.add('guild',space.id);
    for(const room of state.rooms) {
      await this.add('channel',room.id);
      for(const event of state.messages.get(room.id)||[])await this.add('message',event.id,event);
    }
  }
}

export function userView(ids,user,privateData) {
  const result={id:ids.get('user',user.id),username:user.username,discriminator:'0',global_name:user.display||user.username,
    avatar:null,avatar_color:null,bot:false,system:false,flags:0,traits:['premium'],premium_badge_hidden:true};
  if(!privateData)return result;
  return {...result,is_staff:false,acls:[],email:null,has_verified_phone:false,bio:null,pronouns:null,accent_color:null,
    banner:null,banner_color:null,mfa_enabled:privateData.totp,verified:true,premium_type:0,premium_since:null,premium_until:null,
    premium_will_cancel:false,premium_billing_cycle:null,premium_lifetime_sequence:null,premium_grace_ends_at:null,
    premium_discriminator:false,premium_badge_hidden:true,premium_badge_masked:false,premium_badge_timestamp_hidden:true,
    premium_badge_sequence_hidden:true,premium_purchase_disabled:true,premium_enabled_override:true,premium_perks_disabled:false,
    password_last_changed_at:null,last_voice_activity_sharing_change_at:null,required_actions:[],nsfw_allowed:true,
    has_dismissed_premium_onboarding:true,has_ever_purchased:false,has_unread_gift_inventory:false,unread_gift_inventory_count:0,
    pending_bulk_message_deletion:null,terms_agreed_at:null,privacy_agreed_at:null};
}

export function channelView(ids,state,room) {
  const events=state.messages.get(room.id)||[];
  const last=events.filter(e=>e.payload?.type==='message').at(-1);
  return {id:ids.get('channel',room.id),guild_id:room.space?ids.get('guild',room.space):undefined,
    type:room.space?(room.kind==='voice'?2:0):(room.kind==='dm'?1:3),name:room.meta.name,topic:room.meta.topic||null,
    parent_id:null,position:room.meta.position||0,nsfw:false,rate_limit_per_user:0,permission_overwrites:[],
    bitrate:room.audio*1000,user_limit:0,owner_id:ids.get('user',room.creator),icon:null,
    recipients:room.space?undefined:room.meta.members.filter(id=>id!==state.me.id).map(id=>userView(ids,state.users.find(u=>u.id===id)||state.formerUsers?.find(u=>u.id===id)||{id,username:'deleted-user'})),
    last_message_id:last?ids.get('message',last.id):null};
}

const memberPermissions=[0,6,9,10,11,14,15,16,18,20,21,25,54].reduce((value,bit)=>value|(1n<<BigInt(bit)),0n).toString();
export function guildView(ids,state,space) {
  const channels=state.rooms.filter(room=>room.space===space.id);
  const id=ids.get('guild',space.id);
  const memberIds=[...new Set([space.creator,...channels.flatMap(room=>room.meta.members)])];
  return {id,properties:{id,name:channels[0]?.meta.spaceName||'Space',icon:null,banner:null,owner_id:ids.get('user',space.creator),
    vanity_url_code:null,system_channel_id:null,features:['ANIMATED_ICON','ANIMATED_BANNER','BANNER','AUDIO_BITRATE_128_KBPS'],
    verification_level:0,mfa_level:0,explicit_content_filter:0,default_message_notifications:1},
    channels:channels.map(room=>channelView(ids,state,room)),roles:[{id,name:'@everyone',color:0,hoist:false,position:0,
      permissions:memberPermissions,managed:false,mentionable:false}],
    members:memberIds.map(userId=>({user:userView(ids,state.users.find(u=>u.id===userId)||{id:userId,username:'deleted-user'}),
      roles:[],joined_at:new Date(0).toISOString(),mute:false,deaf:false})),
    member_count:memberIds.length,online_count:memberIds.filter(userId=>state.users.find(u=>u.id===userId)?.status==='online').length,
    emojis:[],stickers:[],voice_states:[],presences:[],joined_at:new Date(0).toISOString()};
}

export function materializeMessages(state,room,events=state.messages.get(room.id)||[]) {
  const messages=new Map();
  const canModerate=id=>id===room.creator||(room.moderators||[]).includes(id);
  for(const event of [...events].sort((a,b)=>a.seq-b.seq)) {
    const payload=event.payload;
    if(payload.type==='message') {messages.set(event.id,{...event,payload:{...payload},reactions:new Map()});continue;}
    const target=messages.get(payload.target);if(!target)continue;
    if(payload.type==='edit'&&event.sender===target.sender&&typeof payload.text==='string') {
      target.payload.text=payload.text;target.editedAt=event.at;
    } else if(payload.type==='delete'&&(event.sender===target.sender||canModerate(event.sender))) {
      target.deleted=true;
    } else if(payload.type==='pin'&&(!room.space||canModerate(event.sender)))target.pinned=!!payload.enabled;
    else if(payload.type==='reaction'&&typeof payload.emoji==='string'&&payload.emoji.length<=256) {
      let people=target.reactions.get(payload.emoji);
      if(!people){people=new Set();target.reactions.set(payload.emoji,people);}
      payload.remove?people.delete(event.sender):people.add(event.sender);
    }
  }
  return [...messages.values()];
}

// Call membership and ringing are signed, encrypted conversation events. The
// short lease removes crashed clients without giving the relay their call state.
export function callView(ids,state,room,now=Date.now()/1000) {
  const active=new Map(),ringing=new Map(),members=new Set(room.meta.members);
  for(const event of state.messages.get(room.id)||[]) {
    if(event.at<now-90||event.at>now+30||event.payload?.type!=='call'||!members.has(event.sender))continue;
    const call=event.payload,voice=call.voice;
    if(voice&&typeof voice.connection_id==='string'&&voice.connection_id.length<=128) {
      const id=event.sender+':'+voice.connection_id;
      if(call.state==='ended')active.delete(id);
      else if(['joined','updated'].includes(call.state)) {
        active.set(id,{...voice,user_id:ids.get('user',event.sender),channel_id:ids.get('channel',room.id),
          guild_id:room.space?ids.get('guild',room.space):null,mute:false,deaf:false,e2ee_capable:true});
        ringing.delete(event.sender);
      }
    }
    if(call.state==='ring'&&[...active.keys()].some(id=>id.startsWith(event.sender+':'))&&event.at>now-35)
      for(const recipient of call.recipients||[])if(members.has(recipient)&&recipient!==event.sender)ringing.set(recipient,event.sender);
    if(call.state==='stop-ringing')for(const recipient of call.recipients||[])
      if(recipient===event.sender||ringing.get(recipient)===event.sender)ringing.delete(recipient);
  }
  if(!active.size)return null;
  for(const voice of active.values())ringing.delete(ids.raw('user',voice.user_id));
  return {channel_id:ids.get('channel',room.id),region:'auto',voice_states:[...active.values()],ringing:[...ringing.keys()].map(id=>ids.get('user',id))};
}

// All product entitlements are free. This view contains no billing identifiers.
export function freePremiumState() {
  const common={premium_type:0,premium_since:null,premium_until:null,premium_will_cancel:false,
    premium_billing_cycle:null,premium_lifetime_sequence:null,premium_grace_ends_at:null};
  return {
    actual:{...common,has_active_paid_premium:false,is_visionary:false,has_ever_purchased:false},
    effective:{...common,is_premium:true,premium_enabled_override:true,premium_purchase_disabled:true,
      premium_perks_disabled:false,self_hosted:true,bot:false},
    billing:{stripe_customer_id:null,current_subscription_price:null,pending_subscription_change:null,
      list_price_switch:{available:false,reason:'feature_unavailable',pending:false,current_price_id:null,
        current_amount_minor:null,list_price_id:null,list_amount_minor:null,currency:null,billing_cycle:null,effective_at:null},
      subscription:null,invoices:[],invoices_has_more:false,payment_methods:[],
      refund_eligibility:{eligible:false,reason:'feature_unavailable',invoice_id:null,invoice_amount_paid_cents:null,
        currency:null,paid_at:null,refund_window_expires_at:null,cooldown_expires_at:null,cancels_subscription:false}},
    pricing:{country_code:null,localized:null},store:null,subscription_provider:null,
  };
}
