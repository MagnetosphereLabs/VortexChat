// SPDX-License-Identifier: AGPL-3.0-or-later

// The UI consumes complete settings snapshots, including on gateway updates.
// Older Vortex accounts have only legacy preferences, or a partial Fluxer object.
const defaults={
  flags:0,status:'online',status_resets_at:null,status_resets_to:null,
  theme:'dark',locale:'en-US',time_format:0,
  default_guilds_restricted:false,bot_default_guilds_restricted:false,
  inline_attachment_media:true,inline_embed_media:true,gif_auto_play:true,
  render_embeds:true,render_reactions:true,animate_emoji:true,animate_stickers:0,
  render_spoilers:1,message_display_compact:false,developer_mode:false,
  friend_source_flags:7,incoming_call_flags:8,group_dm_add_permission_flags:4,
  profile_privacy:0,default_share_voice_activity:true,privacy_setup_version:0,
  privacy_setup_completed_at:null,custom_status:null,afk_timeout:600,
  default_hide_muted_channels:false,sensitive_content_friend_dm_filter:0,
  sensitive_content_non_friend_dm_filter:0,sensitive_content_guild_filter:0,
  suppress_unprivileged_self_mentions:false,synced_preferences:'',
};
const arrayFields=['restricted_guilds','bot_restricted_guilds','trusted_domains',
  'suppress_unprivileged_self_mentions_bypass_user_ids','staff_dm_access_user_ids'];
const statuses=new Set(['online','idle','dnd','invisible']);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const strings=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):[];

// Unknown or legacy offline values must not accidentally make someone visible.
export function presenceStatus(value){return statuses.has(value)?value:'invisible';}

export function userSettingsView(state,patch={}) {
  const prefs=record(state.prefs),stored=record(prefs.fluxer);
  const values={...stored,...record(patch)},result={...defaults};
  for(const [field,fallback]of Object.entries(defaults)) {
    const value=values[field];
    if(fallback===null)result[field]=value??null;
    else if(typeof value===typeof fallback&&(typeof value!=='number'||Number.isSafeInteger(value)))result[field]=value;
  }
  for(const key of ['friend_source_flags','incoming_call_flags','group_dm_add_permission_flags'])if(Number.isSafeInteger(state.me?.privacy?.[key]))result[key]=state.me.privacy[key];
  result.status=presenceStatus(values.status??prefs.status??'online');
  result.status_resets_to=values.status_resets_to==null?null:presenceStatus(values.status_resets_to);
  for(const field of arrayFields)result[field]=strings(values[field]);
  result.guild_folders=(Array.isArray(values.guild_folders)?values.guild_folders:[])
    .filter(folder=>folder&&typeof folder==='object'&&!Array.isArray(folder))
    .map(folder=>({...folder,guild_ids:strings(folder.guild_ids),flags:Number.isSafeInteger(folder.flags)?folder.flags:0,icon:typeof folder.icon==='string'?folder.icon:'folder'}));
  return result;
}
