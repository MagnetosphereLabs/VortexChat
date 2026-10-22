// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import 'fake-indexeddb/auto';
import {auth} from '../src/vortex/vendor/auth.js';
const playwright=await import(pathToFileURL(resolve(process.env.VORTEX_PLAYWRIGHT_MODULE)));
const binary=resolve(process.env.VORTEX_NODE_BINARY);
const dir=await mkdtemp(join(tmpdir(),'vortex-browser-'));
const artifacts=resolve(process.env.VORTEX_TEST_ARTIFACTS||'browser-results');await mkdir(artifacts,{recursive:true});
const origin='http://127.0.0.1:18747';
const password='browser-test-only-password-2026';
const setup=spawnSync(binary,['setup','--data',dir,'--stdin-user','browser.owner'],{input:password+'\n',encoding:'utf8'});
assert.equal(setup.status,0,setup.stderr);
const config=join(dir,'config.json');
await writeFile(config,JSON.stringify({listen:'127.0.0.1:18747',public_url:origin,data_dir:dir,vault_html:join(dir,'unused.html'),node_id:auth.b64(auth.random()),bridge:auth.b64(auth.random()),reserve_bytes:0,vault_enabled:false,chat_web_dir:resolve(process.env.VORTEX_WEB_DIST||'fluxer_app/dist')}));
const server=spawn(binary,['serve','--config',config],{env:{...process.env,VORTEX_TEST:'1'},stdio:['ignore','pipe','pipe']});
let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
try {
  for(let i=0;i<200;i++){try{if((await fetch(origin+'/health')).ok)break;}catch{}await delay(50);}
  assert.equal((await fetch(origin+'/health')).status,200,stderr);
  const owner=await auth.login({url:origin,username:'browser.owner',password});
  await auth.api(origin,'policy',{title:'Browser test',signupUntil:0,createSpaces:'everyone',chatQuota:0,maxUpload:10485760},owner.token);
  let failures=0;
  for(const name of (process.env.VORTEX_BROWSERS||'chromium,firefox,webkit').split(',')) {
    const browser=await playwright[name].launch({headless:true,...name==='chromium'&&process.env.VORTEX_CHROME_CHANNEL?{channel:process.env.VORTEX_CHROME_CHANNEL}: {}});
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
    const page=await context.newPage();const errors=[],outbound=[];
    page.on('request',request=>{if(request.method()==='POST')outbound.push(request.postData()||'');});
    page.on('crash',()=>errors.push('Renderer process crashed'));
    page.on('pageerror',error=>errors.push(String(error)));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    page.on('requestfailed',request=>errors.push('Request failed: '+request.url()));
    try {
      await page.goto(origin+'/login',{waitUntil:'domcontentloaded',timeout:60000});
      const passwordInput=page.locator('input[type="password"]');
      if(!await passwordInput.isVisible())await page.locator('[data-flx="auth.flow.auth-login-core.auth-login-method-picker.button.email"]').click({timeout:60000});
      await page.locator('input[autocomplete="username"]').fill('browser.owner');
      await passwordInput.fill(password);
      await page.locator('form[name="login"] button[type="submit"]').click();
      await page.waitForURL('**/channels/@me',{timeout:60000});
      await page.getByText('Friends',{exact:true}).first().waitFor({timeout:30000});
      await page.screenshot({path:join(artifacts,name+'.png'),fullPage:true});
      await page.reload({waitUntil:'domcontentloaded'});
      await page.getByText('Friends',{exact:true}).first().waitFor({timeout:60000});
      await page.locator('[data-flx="app.sidebar-nav.add-guild-button.button.add-guild"]').click();
      await page.locator('[data-flx="guild.add-guild-modal.action-button.action-button.click"]').first().click();
      await page.locator('input[name="name"]').fill('Private '+name+' Space');
      await page.locator('[data-flx="guild.add-guild-modal.guild-create-form.button.submit"]').click();
      const editor=page.locator('[data-channel-textarea][contenteditable="true"]').first();
      await editor.waitFor({timeout:60000});
      const message='Private browser message '+name+' '+crypto.randomUUID();
      await editor.fill(message);
      // The first visible bubble is optimistic. Reload only after the Node has
      // acknowledged the ciphertext, so this checks durable delivery.
      await Promise.all([
        page.waitForResponse(response=>{
          if(response.url()!==origin+'/chat/action'||response.status()!==200)return false;
          try{const body=response.request().postDataJSON();return body.action==='event'&&body.kind==='message';}catch{return false;}
        },{timeout:30000}),
        editor.press('Enter'),
      ]);
      await page.getByText(message,{exact:true}).first().waitFor({timeout:30000});
      await page.reload({waitUntil:'domcontentloaded'});
      await page.getByText(message,{exact:true}).first().waitFor({timeout:60000});
      assert.equal(outbound.some(body=>body.includes(message)),false,'Decrypted message escaped into a network request');
      const persisted=await context.storageState();
      for(const savedOrigin of persisted.origins)for(const entry of savedOrigin.localStorage){
        assert.equal(entry.value.includes(message),false,'Message leaked to plaintext local storage');
        assert.equal(['token','userId','AccountManager','Drafts','MessageEdit'].includes(entry.name)||entry.name.startsWith('fluxer:app-storage-mirror:'),false,'Private startup mirror persisted');
      }
      await page.screenshot({path:join(artifacts,name+'-conversation.png'),fullPage:true});
      console.log(name+': sign-in, encrypted session restore, Space creation and encrypted messaging passed');
    } catch(error) {
      failures++;console.error(name+': '+String(error));
      await page.screenshot({path:join(artifacts,name+'-failure.png'),fullPage:true}).catch(()=>{});
      const body=await page.locator('body').innerText({timeout:1000}).catch(()=>'(renderer unavailable)');
      await writeFile(join(artifacts,name+'-failure.txt'),body+'\n\n'+errors.join('\n'));
      console.error(body.slice(0,10000));console.error(errors.join('\n').slice(0,20000));
    } finally {await browser.close();}
  }
  assert.equal(failures,0,'Browser sign-in must pass on every tested engine');
} finally {
  if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');const deadline=setTimeout(()=>server.kill('SIGKILL'),2000);await exited;clearTimeout(deadline);}
  await rm(dir,{recursive:true,force:true});
}
