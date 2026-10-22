import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auth} from './vendor/auth.js';
import {localKey} from './LocalCipher.js';

test('desktop account keys stay out of IndexedDB and login handoff stays in memory',async()=>{
  const requested=[];
  globalThis.electron={vortexDeviceKey:async purpose=>{
    requested.push(purpose);
    return Buffer.alloc(32,purpose==='account'?13:27).toString('base64');
  }};
  try {
    const pair={id:'alice',url:'https://node.example',token:'private-login-token',expires:Date.now()/1000+3600};
    const root={secret:'private-account-root'};
    await auth.remember(pair,root);
    assert.deepEqual(await auth.restoreRoot(pair),root);
    assert.deepEqual(await auth.store('get','pair'),pair);
    const key=await auth.store('get','device-key');
    assert.equal(key.extractable,false);
    assert.notEqual(await localKey(),key);
    assert.deepEqual(requested,['account','local']);
    const stored=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('VortexChat',1);
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records');
        const keys=store.getAllKeys(),values=store.getAll();
        tx.oncomplete=()=>{db.close();resolve({keys:keys.result,values:values.result});};
      };
    });
    assert.equal(stored.keys.includes('device-key'),false);
    assert.equal(stored.keys.includes('pair'),false);
    assert.equal(JSON.stringify(stored.values).includes(root.secret),false);
    assert.equal(JSON.stringify(stored.values).includes(pair.token),false);
  }finally{delete globalThis.electron;}
});
