import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, ORIGIN } from '../extension/script/canvas.js';
import { downloadURL, requiredOrigins, openFileStream, grantOrigins, tabFile } from '../extension/script/download.js';
import { response } from './fixtures.js';
test('download URLs reject credentials, insecure URLs and identity providers',()=>{
  for(const url of ['http://files.example/file','https://user:pass@example.org/file','https://idp.calpoly.edu/login','javascript:alert(1)'])assert.throws(()=>downloadURL(url));
  assert.equal(downloadURL('https://cdn.example/files/7?signature=fake').origin,'https://cdn.example');
  assert.deepEqual(requiredOrigins(new Map([['a',{url:ORIGIN+'/files/7/download'}],['b',{url:'https://cdn.example/files/7?signature=fake'}],['c',{url:'https://cdn.example/files/8'}]])),['https://cdn.example/*']);
});
test('separate file hosting gets specific user-initiated permissions and omits ambient credentials',async()=>{
  let granted,options;
  assert.equal(await grantOrigins(['https://cdn.example/*'],{permissions:{request:async request=>{granted=request;return true;}}}),true);assert.deepEqual(granted,{origins:['https://cdn.example/*']});
  const client=new CanvasClient({fetcher:async(url,args)=>{options=args;return response('lecture',{raw:true,url,headers:{'Content-Type':'application/pdf'}});},chromeAPI:null});
  const stream=await openFileStream(client,{url:'https://cdn.example/file',contentType:'application/pdf'});assert.equal(await new Response(stream).text(),'lecture');assert.equal(options.credentials,'omit');
});
test('HTML login bodies and insecure/IdP final redirects are rejected before saving',async()=>{
  for(const result of [response('<html>Login</html>',{raw:true,url:ORIGIN+'/login',headers:{'Content-Type':'text/html'}}),response('data',{raw:true,url:'http://cdn.example/file'}),response('data',{raw:true,url:'https://idp.calpoly.edu/login'})]) {
    const client=new CanvasClient({fetcher:async()=>result,chromeAPI:null});await assert.rejects(openFileStream(client,{url:ORIGIN+'/files/7/download',contentType:'application/pdf'}));
  }
});
test('Canvas tab binary fallback streams bounded chunks and cancels the reader',async()=>{
  const calls=[],payload=new Uint8Array(200000).fill(17);
  const client=new CanvasClient({chromeAPI:{scripting:{executeScript:async args=>{
    const [operation]=args.args;calls.push(operation);
    return [{result:operation==='open'?{status:200,contentType:'application/pdf'}:operation==='read'?{bytes:Array.from(payload.subarray(0,128*1024))}:{done:true}}];
  }}}});client.tabId=2;
  const stream=await openFileStream(client,{url:ORIGIN+'/files/7/download',contentType:'application/pdf'});const reader=stream.getReader();const chunk=await reader.read();assert.equal(chunk.value.length,128*1024);await reader.cancel();assert.ok(calls.includes('cancel'));
});
test('actual injected tab file routine uses the page session and enforces chunk bounds',async()=>{
  const originalLocation=globalThis.location,originalFetch=globalThis.fetch;
  globalThis.location={origin:ORIGIN};let credentials;
  globalThis.fetch=async(url,args)=>{credentials=args.credentials;return response(new Uint8Array(400000).fill(23),{raw:true,url,headers:{'Content-Type':'application/pdf'}});};
  try {
    assert.equal((await tabFile('open','fixture-stream',ORIGIN+'/files/7/download')).status,200);assert.equal(credentials,'same-origin');
    let size=0;while(true){const chunk=await tabFile('read','fixture-stream');if(chunk.done)break;assert.ok(chunk.bytes.length<=128*1024);size+=chunk.bytes.length;}assert.equal(size,400000);
    globalThis.location={origin:'https://idp.calpoly.edu'};assert.equal((await tabFile('open','wrong',ORIGIN+'/files/7/download')).auth,true);
  } finally {globalThis.location=originalLocation;globalThis.fetch=originalFetch;delete globalThis.__canvasArchiveStreams;}
});
