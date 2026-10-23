// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {presenceStatus,userSettingsView} from './UserSettingsView.js';

test('legacy accounts hydrate a complete UI settings snapshot without changing their presence choice',()=>{
  const state={prefs:{status:'invisible',emoji:[{name:'legacy'}]}};
  const settings=userSettingsView(state);
  assert.equal(settings.status,'invisible');
  assert.equal(settings.developer_mode,false);
  for(const key of ['restricted_guilds','bot_restricted_guilds','guild_folders','trusted_domains',
    'suppress_unprivileged_self_mentions_bypass_user_ids','staff_dm_access_user_ids'])assert.deepEqual(settings[key],[]);
  assert.equal(userSettingsView({prefs:{}}).status,'online');
  assert.equal(state.prefs.fluxer,undefined,'Projection must not overwrite encrypted legacy preferences');
});

test('partial status updates preserve settings and produce independent complete snapshots',()=>{
  const state={prefs:{status:'invisible',fluxer:{theme:'light',developer_mode:true,
    restricted_guilds:['123'],guild_folders:[{id:1,guild_ids:['123']}]}}};
  const updated=userSettingsView(state,{status:'online',status_resets_at:null,status_resets_to:null});
  assert.equal(updated.status,'online');
  assert.equal(updated.theme,'light');
  assert.equal(updated.developer_mode,true);
  assert.deepEqual(updated.restricted_guilds,['123']);
  assert.deepEqual(updated.guild_folders[0].guild_ids,['123']);
  updated.guild_folders[0].guild_ids.push('456');
  updated.restricted_guilds.push('456');
  assert.deepEqual(state.prefs.fluxer.restricted_guilds,['123']);
  assert.deepEqual(state.prefs.fluxer.guild_folders[0].guild_ids,['123']);
});

test('damaged or old partial settings cannot supply missing UI collections or make offline users visible',()=>{
  const settings=userSettingsView({prefs:{fluxer:{status:'offline',developer_mode:null,
    restricted_guilds:null,bot_restricted_guilds:{},guild_folders:[null,{guild_ids:null}],synced_preferences:null}}});
  assert.equal(settings.status,'invisible');
  assert.equal(settings.developer_mode,false);
  assert.deepEqual(settings.restricted_guilds,[]);
  assert.deepEqual(settings.bot_restricted_guilds,[]);
  assert.deepEqual(settings.guild_folders[0].guild_ids,[]);
  assert.equal(settings.synced_preferences,'');
  assert.equal(presenceStatus(undefined),'invisible');
});
