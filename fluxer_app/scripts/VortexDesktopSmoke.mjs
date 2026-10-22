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
const dir=await mkdtemp(join(tmpdir(),'vortex-desktop-'));
const artifacts=resolve('desktop-results');await mkdir(artifacts,{recursive:true});
const origin='http://127.0.0.1:18747',password='desktop-test-only-password-2026';
const binary=resolve(process.env.VORTEX_NODE_BINARY);
const setup=spawnSync(binary,['setup','--data',dir,'--stdin-user','desktop.owner'],{input:password+'\n',encoding:'utf8'});
assert.equal(setup.status,0,setup.stderr);
const config=join(dir,'config.json');
await writeFile(config,JSON.stringify({listen:'127.0.0.1:18747',public_url:origin,data_dir:dir,vault_html:join(dir,'unused.html'),node_id:auth.b64(auth.random()),bridge:auth.b64(auth.random()),reserve_bytes:0,vault_enabled:false}));
const server=spawn(binary,['serve','--config',config],{env:{...process.env,VORTEX_TEST:'1'},stdio:['ignore','pipe','pipe']});
let desktop,browser,page,output='',errors=[];
const record=chunk=>{output=(output+chunk).slice(-250000);};
server.stderr.on('data',record);
async function stop(child) {
  if(!child||child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  await exited;clearTimeout(timer);
}
try {
  for(let i=0;i<200;i++){try{if((await fetch(origin+'/health')).ok)break;}catch{}await delay(50);}
  assert.equal((await fetch(origin+'/health')).status,200);
  const owner=await auth.login({url:origin,username:'desktop.owner',password});
  await auth.api(origin,'policy',{title:'Desktop test',signupUntil:0,createSpaces:'everyone',chatQuota:0,maxUpload:10485760},owner.token);
  desktop=spawn(resolve(process.env.VORTEX_DESKTOP_BINARY),['--remote-debugging-port=19342','--user-data-dir='+join(dir,'client'),'--password-store=gnome-libsecret'],
    {env:{...process.env,ELECTRON_ENABLE_LOGGING:'1',NODE_OPTIONS:'',XDG_CONFIG_HOME:join(dir,'client')},stdio:['ignore','pipe','pipe']});
  desktop.stdout.on('data',record);desktop.stderr.on('data',record);
  for(let i=0;i<120;i++){
    if(desktop.exitCode!==null)throw new Error('Desktop exited before opening: '+desktop.exitCode);
    try{const response=await fetch('http://127.0.0.1:19342/json/version');if(response.ok)break;}catch{}
    await delay(500);
  }
  browser=await playwright.chromium.connectOverCDP('http://127.0.0.1:19342');
  const context=browser.contexts()[0];
  for(let i=0;i<120;i++){page=context.pages().find(candidate=>candidate.url().startsWith('fluxer-app:'));if(page)break;await delay(500);}
  assert.ok(page,'The bundled desktop renderer must open');
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('requestfailed',request=>errors.push('Request failed: '+request.url()));
  page.on('crash',()=>errors.push('Renderer crashed'));
  await page.locator('[data-flx="auth.flow.client-intro.auth-client-welcome-step.button.continue"]').click({timeout:60000});
  await page.locator('[data-flx="auth.flow.client-intro.auth-client-preferences-step.button.continue"]').click({timeout:30000});
  await page.locator('[data-flx="auth.flow.instance-selector.instance-picker-rows.button.add-instance"]').click({timeout:60000});
  await page.locator('[data-flx="auth.flow.instance-selector.form.submit"] input').fill(origin);
  await page.locator('[data-flx="auth.flow.instance-selector.button.continue"]').click();
  const passwordInput=page.locator('input[type="password"]');
  if(!await passwordInput.isVisible())await page.locator('[data-flx="auth.flow.auth-login-core.auth-login-method-picker.button.email"]').click({timeout:60000});
  await page.locator('input[autocomplete="username"]').fill('desktop.owner');
  await passwordInput.fill(password);
  await page.locator('form[name="login"] button[type="submit"]').click();
  await page.waitForURL('**/channels/@me',{timeout:60000});
  await page.getByText('Friends',{exact:true}).first().waitFor({timeout:30000});
  assert.equal(await page.evaluate(async()=>typeof await window.electron.vortexDeviceKey('account')),'string');
  await page.locator('[data-flx="app.sidebar-nav.add-guild-button.button.add-guild"]').click();
  await page.locator('[data-flx="guild.add-guild-modal.action-button.action-button.click"]').first().click();
  await page.locator('input[name="name"]').fill('Private desktop Space');
  await page.locator('[data-flx="guild.add-guild-modal.guild-create-form.button.submit"]').click();
  const editor=page.locator('[data-channel-textarea][contenteditable="true"]').first();
  await editor.waitFor({timeout:60000});
      await page.locator('[data-flx="channel.member-list-item.name"]').filter({hasText: 'desktop.owner'}).first().waitFor({timeout:30000});
  const message='Encrypted desktop message '+crypto.randomUUID();
  await editor.click();
      await editor.pressSequentially(message, {delay: 8});
      assert.equal(await editor.innerText(), message);
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
  await page.screenshot({path:join(artifacts,'desktop-conversation.png'),fullPage:true});
  console.log('Packaged Linux desktop: Node selection, keyring, sign-in, encrypted messaging and restore passed');
}catch(error){
  await page?.screenshot({path:join(artifacts,'desktop-failure.png'),fullPage:true}).catch(()=>{});
  const body=await page?.locator('body').innerText({timeout:1000}).catch(()=>'(renderer unavailable)');
  console.error(body||'No renderer');console.error(errors.join('\n'));console.error(output);
  throw error;
}finally{
  await writeFile(join(artifacts,'desktop-log.txt'),output+'\n'+errors.join('\n'));
  await browser?.close().catch(()=>{});await stop(desktop);await stop(server);
  await rm(dir,{recursive:true,force:true});
}

