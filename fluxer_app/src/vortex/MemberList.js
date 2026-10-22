// SPDX-License-Identifier: AGPL-3.0-or-later
import {guildView} from './Projection.js';

export function memberListView(ids,state,guildId,channelId,ranges) {
  const space=state.spaces.find(space=>ids.get('guild',space.id)===guildId);
  const room=state.rooms.find(room=>ids.get('channel',room.id)===channelId&&room.space===space?.id);
  if(!space||!room)return null;
  const guild=guildView(ids,state,space),users=new Map(state.users.map(user=>[ids.get('user',user.id),user]));
  const present=new Set(room.meta.members.map(id=>ids.get('user',id)));
  const members=guild.members.filter(member=>present.has(member.user.id)).map(member=>{
    const status=users.get(member.user.id)?.status;
    return {...member,presence:{status:['online','idle','dnd'].includes(status)?status:'offline',custom_status:null}};
  }).sort((a,b)=>a.user.username.localeCompare(b.user.username)||a.user.id.localeCompare(b.user.id));
  const online=members.filter(member=>member.presence.status!=='offline'),offline=members.filter(member=>member.presence.status==='offline');
  const groups=[],items=[];
  for(const [id,list] of [['online',online],['offline',offline]]) {
    if(!list.length)continue;
    const group={id,count:list.length};groups.push(group);items.push({group},...list.map(member=>({member})));
  }
  const valid=(Array.isArray(ranges)?ranges:[]).slice(0,16).filter(range=>Array.isArray(range)&&range.length===2&&range.every(Number.isSafeInteger)&&range[0]>=0&&range[1]>=range[0]&&range[1]<=100000&&range[1]-range[0]<=99);
  return {guild_id:guildId,channel_id:channelId,id:'everyone',member_count:members.length,online_count:online.length,groups,
    ops:valid.map(range=>({op:'SYNC',range,items:items.slice(range[0],range[1]+1)}))};
}
