// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {matchesSearch} from './PrivateSearch.js';

const message={id:'200',content:'Meet <@42> at https://docs.example.org/project',author:{id:'17'},
  mentions:[{id:'42'}],mention_everyone:false,pinned:true,embeds:[],sticker_items:[],
  attachments:[{filename:'Holiday Photo.PNG',content_type:'image/png'}]};

test('private search applies content, identity, file and date filters locally',()=>{
  assert.equal(matchesSearch(message,{content:'meet',author_id:['17'],mentions:['42'],pinned:true,has:['image','link'],min_id:'199',max_id:'201',attachment_extension:['png'],link_hostname:['example.org']}),true);
  for(const query of [{content:'absent'},{exclude_author_id:['17']},{exclude_mentions:['42']},{exclude_has:['image']},
    {max_id:'200'},{min_id:'200'},{author_type:['bot']},{pinned:false},{has:['video']},
    {exclude_attachment_filename:['photo']},{link_hostname:['other.example']},{attachment_extension:['gif']}])assert.equal(matchesSearch(message,query),false,JSON.stringify(query));
});
