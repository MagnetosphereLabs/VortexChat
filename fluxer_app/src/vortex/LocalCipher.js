// SPDX-License-Identifier: AGPL-3.0-or-later
// A device-local wrapping key. Conversation keys remain protected by the account root.
import {getVortexIndexedDB,getVortexDeviceKey} from './BrowserStorage.js';
const encoder=new TextEncoder(),decoder=new TextDecoder();
let pendingKey;
function encode(bytes){let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);}
function decode(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
export function localKey() {
  pendingKey??=(async()=>{
    if(globalThis.electron?.vortexDeviceKey)return getVortexDeviceKey('local');
    const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    return new Promise((resolve,reject)=>{
      const request=getVortexIndexedDB().open('VortexDeviceKeys',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('keys');
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Close other Vortex windows to unlock device storage'));
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('keys','readwrite'),store=tx.objectStore('keys');let key;
        const read=store.get('local-v1');
        read.onsuccess=()=>{key=read.result||candidate;if(!read.result)store.add(candidate,'local-v1');};
        tx.oncomplete=()=>{db.close();resolve(key);};
        tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||new Error('Device storage could not be unlocked'));};
      };
    });
  })();
  return pendingKey;
}
export async function sealLocal(scope,key,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad=encoder.encode(JSON.stringify(['vortex-local-v1',scope,key]));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await localKey(),encoder.encode(value));
  return JSON.stringify({v:1,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))});
}
export async function openLocal(scope,key,value) {
  const envelope=JSON.parse(value);
  if(envelope?.v!==1||typeof envelope.iv!=='string'||typeof envelope.ciphertext!=='string')throw new Error('Unencrypted local record rejected');
  const iv=decode(envelope.iv);if(iv.length!==12)throw new Error('Invalid local storage nonce');
  const aad=encoder.encode(JSON.stringify(['vortex-local-v1',scope,key]));
  return decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},await localKey(),decode(envelope.ciphertext)));
}
