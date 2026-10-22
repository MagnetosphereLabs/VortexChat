// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receiveDownload,fetchDownload} from './DownloadWorker.ts';

test('browser downloads stream bounded chunks, reject cross-client access, and cannot be replayed', {timeout:5000}, async () => {
  const origin='https://node.example',ticket=crypto.randomUUID(),channel=new MessageChannel();
  const chunks=[new Uint8Array(1048576).fill(18),new Uint8Array(37).fill(93)];let pulls=0;
  channel.port1.onmessage=event=>{
    if(event.data.type==='pull') {const part=chunks[pulls++];channel.port1.postMessage({type:'chunk',done:!part,value:part},part?[part.buffer]:[]);}
  };
  assert.equal(receiveDownload({data:{type:'VORTEX_DOWNLOAD',ticket,name:'private.bin',size:1048613},ports:[channel.port2],source:{id:'client-one',url:origin+'/channels/@me'}},origin),true);
  const url=origin+'/vortex/local-download/'+ticket;let response,finished;
  const request=clientId=>({request:new Request(url),clientId,respondWith:value=>{response=value;},waitUntil:value=>{finished=value;}});
  assert.equal(fetchDownload(request('other-client'),origin),true);assert.equal(response.status,404);
  assert.equal(fetchDownload(request('client-one'),origin),true);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const result=new Uint8Array(await response.arrayBuffer());
  assert.equal(result.length,1048613);assert.equal(result[0],18);assert.equal(result.at(-1),93);await finished;
  assert.equal(fetchDownload(request('client-one'),origin),true);assert.equal(response.status,404);channel.port1.close();
});

test('a truncated browser download fails instead of reporting a complete file', {timeout:5000}, async () => {
  const origin='https://node.example',ticket=crypto.randomUUID(),channel=new MessageChannel();
  channel.port1.onmessage=event=>{if(event.data.type==='pull')channel.port1.postMessage({type:'chunk',done:true});};
  receiveDownload({data:{type:'VORTEX_DOWNLOAD',ticket,name:'private.bin',size:100},ports:[channel.port2],source:{id:'one',url:origin}},origin);
  let response,finished;
  fetchDownload({request:new Request(origin+'/vortex/local-download/'+ticket),clientId:'one',respondWith:value=>{response=value;},waitUntil:value=>{finished=value;}},origin);
  await assert.rejects(response.arrayBuffer());await finished;channel.port1.close();
});
