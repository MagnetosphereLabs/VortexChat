// SPDX-License-Identifier: AGPL-3.0-or-later
import {materializeMessages,channelView} from './Projection.js';

const list=value=>value==null?[]:Array.isArray(value)?value:[value];
const lower=value=>String(value??'').toLocaleLowerCase();
const selected=(wanted,values)=>!list(wanted).length||list(wanted).some(value=>values.includes(value));
const excluded=(wanted,values)=>list(wanted).some(value=>values.includes(value));

export function matchesSearch(message,query) {
  const text=lower(message.content),files=message.attachments||[],mentions=(message.mentions||[]).map(user=>user.id);
  if(![...list(query.content),...list(query.contents),...list(query.exact_phrases)].every(term=>text.includes(lower(term))))return false;
  if(!selected(query.author_id,[message.author.id])||excluded(query.exclude_author_id,[message.author.id]))return false;
  if(!selected(query.author_type,['user'])||excluded(query.exclude_author_type,['user']))return false;
  if(!selected(query.mentions,mentions)||excluded(query.exclude_mentions,mentions))return false;
  if(query.mention_everyone!==undefined&&query.mention_everyone!==message.mention_everyone)return false;
  if(query.pinned!==undefined&&query.pinned!==message.pinned)return false;
  if(query.min_id&&BigInt(message.id)<=BigInt(query.min_id)||query.max_id&&BigInt(message.id)>=BigInt(query.max_id))return false;
  const links=[];for(const match of message.content.matchAll(/https?:\/\/[^\s<>]+/gu)){try{links.push(new URL(match[0]).hostname.toLowerCase());}catch{}}
  const kinds=[];
  if(files.length)kinds.push('file');if(links.length)kinds.push('link');
  for(const [prefix,kind]of [['image/','image'],['audio/','sound'],['video/','video']])if(files.some(file=>file.content_type?.startsWith(prefix)))kinds.push(kind);
  if(message.sticker_items?.length)kinds.push('sticker');if(message.poll)kinds.push('poll');if(message.message_snapshots?.length)kinds.push('snapshot');
  if(message.embeds?.length)kinds.push('embed');
  if(!list(query.has).every(kind=>kinds.includes(kind))||excluded(query.exclude_has,kinds))return false;
  if(!selected(query.embed_type,(message.embeds||[]).map(embed=>embed.type))||excluded(query.exclude_embed_type,(message.embeds||[]).map(embed=>embed.type)))return false;
  const providers=(message.embeds||[]).map(embed=>lower(embed.provider?.name));
  if(!selected(list(query.embed_provider).map(lower),providers)||excluded(list(query.exclude_embed_provider).map(lower),providers))return false;
  const hostname=term=>links.some(host=>host===lower(term)||host.endsWith('.'+lower(term)));
  if(list(query.link_hostname).length&&!list(query.link_hostname).some(hostname)||list(query.exclude_link_hostname).some(hostname))return false;
  const filename=term=>files.some(file=>lower(file.filename).includes(lower(term)));
  if(list(query.attachment_filename).length&&!list(query.attachment_filename).some(filename)||list(query.exclude_attachment_filename).some(filename))return false;
  const extension=term=>files.some(file=>lower(file.filename).endsWith('.'+lower(term).replace(/^\./u,'')));
  if(list(query.attachment_extension).length&&!list(query.attachment_extension).some(extension)||list(query.exclude_attachment_extension).some(extension))return false;
  return true;
}

export async function readConversationArchive(session,room,signal) {
  const events=[];let bytes=0;
  for await(const event of session.core.archiveEvents(room,signal)) {
    // Refuse an oversized in-memory index explicitly instead of silently
    // returning incomplete search results or exhausting the renderer.
    bytes+=JSON.stringify(event.payload).length*2;
    if(bytes>64*1024**2||events.length>=100000)throw new Error('This conversation is too large for the current local search index');
    await session.ids.add('message',event.id,event);events.push(event);
  }
  return materializeMessages(session.core.state,room,events).filter(event=>!event.deleted);
}

export async function searchPrivateMessages(session,query,signal) {
  await session.refresh();
  let rooms=session.core.state.rooms;
  if((query.scope||'current')==='current') {
    if(query.context_guild_id)rooms=rooms.filter(room=>room.space&&session.ids.get('guild',room.space)===query.context_guild_id);
    else if(query.context_channel_id)rooms=rooms.filter(room=>session.ids.get('channel',room.id)===query.context_channel_id);
  }
  if(['all_dms','open_dms'].includes(query.scope))rooms=rooms.filter(room=>!room.space);
  if(query.scope==='all_guilds')rooms=rooms.filter(room=>!!room.space);
  rooms=rooms.filter(room=>selected(query.channel_ids||query.channel_id,[session.ids.get('channel',room.id)])&&!excluded(query.exclude_channel_id,[session.ids.get('channel',room.id)]));
  const hits=[];
  for(const room of rooms)for(const event of await readConversationArchive(session,room,signal)) {
    signal?.throwIfAborted();
    const view=await session.message(room,event,false);
    view.attachments=(event.payload.files||[]).map(file=>({filename:file.name,content_type:file.type}));
    if(matchesSearch(view,query)){
      const terms=[...list(query.content),...list(query.contents),...list(query.exact_phrases)].map(lower).filter(Boolean);
      const score=terms.reduce((sum,term)=>sum+lower(view.content).split(term).length-1,0);
      hits.push({room,event,id:view.id,score});
    }
  }
  const ascending=query.sort_order==='asc';
  hits.sort((a,b)=>(query.sort_by==='relevance'&&b.score-a.score)||(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0)*(ascending?1:-1));
  const size=Math.max(1,Math.min(100,Number(query.hits_per_page)||25)),page=Math.max(1,Math.floor(Number(query.page)||1));
  const slice=hits.slice((page-1)*size,page*size);
  return {total:hits.length,hits_per_page:size,page,messages:await Promise.all(slice.map(hit=>session.message(hit.room,hit.event))),
    channels:[...new Set(slice.map(hit=>hit.room))].map(room=>channelView(session.ids,session.core.state,room))};
}
