// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';

// Exercise the real UI consumer, not just the adapter's REST return values.
export async function verifyPresenceChanges(page,origin) {
  for(const [label,status]of [['Invisible','invisible'],['Online','online']]) {
    // Focus/popout wrappers replace data-flx attributes on their trigger child.
    // The accessible button names survive those wrappers.
    await page.getByRole('button',{name:/^Open user menu for /}).click();
    await page.getByRole('button',{name:/^(Online|Idle|Do Not Disturb|Invisible)$/}).hover();
    const choice=page.getByRole('button',{name:new RegExp('^'+label)});
    await Promise.all([
      page.waitForResponse(response=>{
        if(response.url()!==origin+'/chat/action'||response.status()!==200)return false;
        try{const body=response.request().postDataJSON();return body.action==='status'&&body.status===status;}catch{return false;}
      },{timeout:30000}),
      choice.click(),
    ]);
    await page.locator('[data-flx="app.user-area.user-area-inner.default-state"]').filter({hasText:label}).waitFor({timeout:10000});
  }
  assert.equal(await page.getByText('Lost connection',{exact:false}).count(),0,'Presence changes must leave the client connected');
}
