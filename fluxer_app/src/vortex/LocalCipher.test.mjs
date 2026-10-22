import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localKey,sealLocal,openLocal} from './LocalCipher.js';
test('device storage authenticates its scope and never writes plaintext',async()=>{
  const key=await localKey();assert.equal(key.extractable,false);
  const secret='A private unsent draft';
  const encrypted=await sealLocal('account:alice','draft:room',secret);
  assert.equal(encrypted.includes(secret),false);
  assert.equal(await openLocal('account:alice','draft:room',encrypted),secret);
  await assert.rejects(openLocal('account:bob','draft:room',encrypted));
  await assert.rejects(openLocal('account:alice','draft:other',encrypted));
  await assert.rejects(openLocal('account:alice','draft:room',JSON.stringify({value:secret})));
  const altered=JSON.parse(encrypted);altered.ciphertext='A'+altered.ciphertext.slice(1);
  if(altered.ciphertext!==JSON.parse(encrypted).ciphertext)await assert.rejects(openLocal('account:alice','draft:room',JSON.stringify(altered)));
});
