// SPDX-License-Identifier: AGPL-3.0-or-later
// Fluxer captures and removes browser storage globals during production startup.
// Keep the captured factory private to the account and encryption modules.
let factory;
const nativeKeys=new Map();
export function setVortexIndexedDB(value) {factory=value;}
export function getVortexIndexedDB() {
  const value=factory===undefined?globalThis.indexedDB:factory;
  if(!value)throw new Error('Private device storage is unavailable. Allow browser storage for this Node.');
  return value;
}
export function getVortexDeviceKey(purpose) {
  if(!nativeKeys.has(purpose)) {
    const pending=(async()=>{
      const encoded=await globalThis.electron.vortexDeviceKey(purpose);
      const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
      if(bytes.length!==32)throw new Error('Invalid desktop wrapping key');
      try{return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
      finally{bytes.fill(0);}
    })();
    nativeKeys.set(purpose,pending);pending.catch(()=>nativeKeys.delete(purpose));
  }
  return nativeKeys.get(purpose);
}
