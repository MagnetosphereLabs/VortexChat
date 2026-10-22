// SPDX-License-Identifier: AGPL-3.0-or-later
const files=new Map();
export function registerAttachment(session,file) {
  const url=new URL('/vortex/local-file/'+crypto.randomUUID(),globalThis.location?.origin||session.pair.url).href;
  files.set(url,{session,file});return url;
}
export function registerAttachmentAlias(url,reference) {const item=files.get(reference);if(item)files.set(url,item);}
export function unregisterAttachments(session) {for(const [url,item]of files)if(item.session===session)files.delete(url);}
export function isVortexAttachment(url) {return files.has(url);}
function anchorDownload(url,name) {
  const a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';a.dataset.routerIgnore='true';document.body.append(a);a.click();a.remove();
}
async function browserStream(item,name) {
  if(!('serviceWorker' in navigator))throw new Error('This browser cannot stream encrypted downloads. Use the desktop app.');
  const registration=await navigator.serviceWorker.ready;
  const worker=registration.active;if(!worker)throw new Error('Reload the app to enable downloads');
  const channel=new MessageChannel(),ticket=crypto.randomUUID(),abort=new AbortController();
  const iterator=item.session.core.downloadChunks(item.file,abort.signal);
  let busy=false,closed=false;
  const close=()=>{if(closed)return;closed=true;abort.abort();channel.port1.close();void iterator.return();};
  const timeout=setTimeout(close,60000);
  channel.port1.onmessage=async event=>{
    clearTimeout(timeout);
    if(event.data?.type==='ready') {anchorDownload(new URL('/vortex/local-download/'+ticket,location.origin).href,name);return;}
    if(event.data?.type==='cancel') {close();return;}
    if(event.data?.type!=='pull'||busy||closed)return;
    busy=true;
    try {
      const part=await iterator.next();
      channel.port1.postMessage({type:'chunk',done:part.done,value:part.value},part.value?[part.value.buffer]:[]);
      if(part.done)close();
    } catch {channel.port1.postMessage({type:'error'});close();}
    finally {busy=false;}
  };
  worker.postMessage({type:'VORTEX_DOWNLOAD',ticket,name,size:item.file.size},[channel.port2]);
}
export async function downloadVortexAttachment(url,name) {
  const item=files.get(url);if(!item)return false;
  const safeName=(name||item.file.name||'download').replace(/[\\/\u0000-\u001f]/gu,'_').slice(0,200);
  const native=globalThis.electron;
  if(native?.vortexDownloadStart) {
    const id=await native.vortexDownloadStart(safeName,item.file.size);if(!id)return true;
    try {for await(const chunk of item.session.core.downloadChunks(item.file))await native.vortexDownloadChunk(id,chunk);await native.vortexDownloadFinish(id);}
    catch(error){await native.vortexDownloadAbort(id);throw error;}
  } else if(typeof window.showSaveFilePicker==='function') {
    let writable;
    try {
      const handle=await window.showSaveFilePicker({suggestedName:safeName});writable=await handle.createWritable();
      for await(const chunk of item.session.core.downloadChunks(item.file))await writable.write(chunk);
      await writable.close();
    } catch(error) {await writable?.abort().catch(()=>{});if(error.name!=='AbortError')throw error;}
  } else await browserStream(item,safeName);
  return true;
}
