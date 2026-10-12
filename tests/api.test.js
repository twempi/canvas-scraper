import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, ORIGIN, apiURL, parseAPI, friendly } from '../extension/script/canvas.js';
import { response } from './fixtures.js';
const client = fetcher => new CanvasClient({ fetcher, chromeAPI:null, delay:0, wait:async()=>{} });
test('connection requires a real authenticated API object, uses GET and ambient session',async()=>{
  let request;
  const canvas = client(async (url,options)=>{ request={url,options};return response({id:7,name:'Fixture user'},{url}); });
  await canvas.connect(); assert.equal(canvas.verified,true); assert.equal(canvas.origin,ORIGIN);
  assert.equal(request.url,ORIGIN+'/api/v1/users/self/profile'); assert.equal(request.options.method,'GET');
  assert.equal(request.options.credentials,'include'); assert.equal(request.options.redirect,'manual');
  assert.equal(request.options.headers.Authorization,undefined);
});
test('expired authentication, HTML, IdP redirects, and misleading JSON never establish Canvas',async t=>{
  for (const [name,fetcher] of [
    ['401',async()=>response({}, {status:401})],
    ['login HTML',async()=>response('<html>Canvas dashboard</html>',{raw:true})],
    ['IdP fake profile',async()=>response({id:7,name:'Canvas'},{url:'https://idp.calpoly.edu/api/v1/users/self/profile'})],
    ['misleading shape',async()=>response({title:'Canvas',current_user_id:7})],
    ['manual redirect',async()=>({status:0,type:'opaqueredirect'})]
  ]) await t.test(name,async()=>{
    const canvas=client(fetcher);await assert.rejects(canvas.connect(),error=>error.code==='auth');
    assert.equal(canvas.verified,false);assert.equal(canvas.origin,ORIGIN);
  });
});
test('same-origin session fallback checks only exact Canvas tabs and verified API responses',async()=>{
  const injected=[];
  const chromeAPI={tabs:{query:async()=>[{id:1,url:'https://idp.calpoly.edu/'},{id:2,url:ORIGIN+'/courses/1'}]},scripting:{executeScript:async args=>{
    injected.push(args); return [{result:{status:200,url:ORIGIN+'/api/v1/users/self/profile',raw:'{"id":7,"name":"Fixture"}'}}];
  }}};
  const canvas = new CanvasClient({fetcher:async()=>response({}, {status:401}),chromeAPI,delay:0,wait:async()=>{}});
  await canvas.connect(); assert.equal(canvas.verified,true); assert.equal(canvas.tabId,2);
  assert.ok(injected.every(args=>args.target.tabId===2)); assert.equal(canvas.transportName,'Same-origin API in your Canvas tab');
});
test('API scope refuses identity providers, global personal files, student data and include tricks',()=>{
  for(const path of ['https://idp.calpoly.edu/api/v1/courses','https://evil.example/api/v1/courses','/api/v1/files/7','/api/v1/users/self/files','/api/v1/courses/1/quizzes/7/questions','/api/v1/courses/1/assignments/7/submissions','/api/v1/courses/1/discussion_topics/7/view','/api/v1/courses?include[]=grades','/api/v1/courses/1/assignments?include[]=submission']) assert.throws(()=>apiURL(path));
  assert.throws(()=>apiURL('/api/v1/courses','https://idp.calpoly.edu'));
  assert.equal(apiURL('/api/v1/courses/1/files/7'),ORIGIN+'/api/v1/courses/1/files/7');
});
test('pagination reads all pages, Canvas JSON prefix, repeated and foreign next links',async()=>{
  const pages=[];
  const canvas=client(async url=>{
    pages.push(url); return url.includes('page=2') ? response([{id:2}],{url}) : response('while(1);[{"id":1}]',{raw:true,url,headers:{Link:`<${ORIGIN}/api/v1/courses?page=2>; rel="next"`}});
  });
  const list=[]; for await(const item of canvas.all('/api/v1/courses'))list.push(item.id);
  assert.deepEqual(list,[1,2]);assert.equal(pages.length,2);assert.deepEqual(parseAPI('\uFEFFwhile(1);[]'),[]);
  for(const next of ['https://evil.example/api/v1/courses',ORIGIN+'/api/v1/courses']) {
    const broken=client(async url=>response([],{url,headers:{Link:`<${next}>; rel="next"`}}));
    await assert.rejects(async()=>{for await(const item of broken.all('/api/v1/courses'))void item;});
  }
});
test('429 and server errors retry with capped Retry-After; denial is not retried',async()=>{
  let calls=0;const waits=[];
  const canvas=new CanvasClient({fetcher:async url=>{calls++;return response(calls<3?{}:{id:7},{status:calls===1?429:calls===2?502:200,url,headers:{'Retry-After':'999'}});},delay:0,chromeAPI:null,wait:async ms=>waits.push(ms)});
  assert.equal((await canvas.one('/api/v1/courses/1')).id,7);assert.equal(calls,3);assert.ok(waits.includes(30000));
  let denied=0;const restricted=client(async()=>{denied++;return response({}, {status:403});});
  await assert.rejects(restricted.one('/api/v1/courses/1'));assert.equal(denied,1);
});
test('cancellation and error reporting do not expose authentication URLs',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(client(async()=>response({})).one('/api/v1/courses/1',controller.signal),{name:'AbortError'});
  assert.ok(!friendly(new Error('https://idp.calpoly.edu/?password=secret')).includes('secret'));
});
