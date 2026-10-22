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
  await auth.login({url:origin,username:'browser.owner',password});
  let failures=0;
  for(const name of (process.env.VORTEX_BROWSERS||'chromium,firefox,webkit').split(',')) {
    const browser=await playwright[name].launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
    const page=await context.newPage();const errors=[];
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
      console.log(name+': sign-in and encrypted session restore passed');
    } catch(error) {
      failures++;console.error(name+': '+String(error));
      await page.screenshot({path:join(artifacts,name+'-failure.png'),fullPage:true}).catch(()=>{});
      await writeFile(join(artifacts,name+'-failure.txt'),(await page.locator('body').innerText())+'\n\n'+errors.join('\n'));
      console.error((await page.locator('body').innerText()).slice(0,10000));console.error(errors.join('\n').slice(0,20000));
    } finally {await browser.close();}
  }
  assert.equal(failures,0,'Browser sign-in must pass on every tested engine');
} finally {
  server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));await rm(dir,{recursive:true,force:true});
}
