import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { CanvasClient, ORIGIN } from '../extension/script/canvas.js';
import { scanCourse } from '../extension/script/scan.js';
import { prepareReview, runJob, runKey, verifyExisting } from '../extension/script/jobs.js';
import { emptyIndex, loadIndex, saveEntry, diskFile } from '../extension/script/filesystem.js';
import { hashText } from '../extension/script/hash.js';
import { fixtures, MemoryStore, course, response } from './fixtures.js';
import { Directory, put, read } from './fake-fs.js';
globalThis.document=parseHTML('<!doctype html><html><body></body></html>').document;
async function setup(keys=['File:7@module:2','Page:123@module:2']) {
  const fake=fixtures(),store=new MemoryStore(),root=new Directory();
  const client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();
  const catalog=await scanCourse(client,course,store),selected=new Set(keys);
  return {fake,store,root,client,catalog,selected,review:()=>prepareReview(client,catalog,root,selected,store)};
}
test('final selection only, original bytes, offline HTML, reports and real index reconciliation',async()=>{
  const s=await setup(),review=await s.review(),journal=await runJob(s.client,review,s.store);
  assert.equal(journal.report.counts.downloaded,2);assert.equal(journal.report.counts.failed,0);
  assert.equal(await read(s.root,review.rows.find(r=>r.assetKey==='File:7').path),'lecture');
  const html=await read(s.root,review.rows.find(r=>r.assetKey==='Page:123').path);
  assert.ok(html.includes('href="7__Lecture%20notes.pdf"'));assert.ok(html.includes('Open original in Canvas'));
  assert.ok(!s.fake.requests.some(r=>r.path==='/files/8/download'));assert.ok(!JSON.stringify(journal).includes('fake-secret'));
  assert.ok(journal.report.items.every(i=>i.title&&i.module?.name&&i.canvasId&&i.relativePath&&i.reason));
  assert.equal(JSON.parse(await read(s.root,journal.reportPath)).items.length,2);
  const second=await runJob(s.client,await s.review(),s.store);assert.equal(second.report.counts.downloaded,0);assert.equal(second.report.counts.skipped,2);
  const index=await loadIndex(s.root,'1');assert.equal(Object.keys(index.entries).length,2);
});
test('deselected attachment is never fetched and selected document keeps a clean online link',async()=>{
  const s=await setup(['Page:123@module:2']),review=await s.review();
  assert.ok(review.rows[0].dependencies.some(d=>d.title==='Lecture notes.pdf'));
  await runJob(s.client,review,s.store);const html=await read(s.root,review.rows[0].path);
  assert.ok(html.includes(ORIGIN+'/courses/1/files/7/download'));assert.ok(!html.includes('verifier'));
  assert.ok(!s.fake.requests.some(r=>r.path.endsWith('/download')));
});
test('unindexed and edited files are preserved; explicit content verification indexes an identical file',async()=>{
  const s=await setup(),file=s.catalog.placements.find(p=>p.key==='File:7@module:2');await put(s.root,file.path,'lecture');
  const review=await s.review();assert.equal(review.rows.find(r=>r.key===file.key).state,'Existing—unverified');
  const first=await runJob(s.client,review,s.store);assert.equal(first.report.counts.skipped,1);
  const html=await read(s.root,review.rows.find(r=>r.assetKey==='Page:123').path);assert.ok(html.includes(ORIGIN+'/courses/1/files/7/download'));
  const verify=await s.review(),row=verify.rows.find(r=>r.key===file.key);assert.equal(await verifyExisting(s.client,verify,row,s.store),true);assert.equal(row.state,'Unchanged');
  await put(s.root,file.path,'CORRUPT');const changed=await s.review();assert.equal(changed.rows.find(r=>r.key===file.key).state,'Locally modified/conflict');
  await runJob(s.client,changed,s.store);assert.equal(await read(s.root,file.path),'CORRUPT');
});
test('explicit replacement and intact remote updates work without silent conflict overwrite',async()=>{
  const s=await setup(['File:7@module:2']),path=s.catalog.placements.find(p=>p.key=== [...s.selected][0]).path;await put(s.root,path,'notes!!');
  const review=await s.review();review.rows[0].policy='replace';await runJob(s.client,review,s.store);assert.equal(await read(s.root,path),'lecture');
  const remote=s.fake.routes.get('/api/v1/courses/1/files/7');remote.updated_at='2026-10-02';s.fake.binary.set('/files/7/download','updated');
  const update=await s.review();assert.equal(update.rows[0].state,'Remote update available');await runJob(s.client,update,s.store);assert.equal(await read(s.root,path),'updated');
});
test('deleted indexed files are redownloaded; unrelated notes are retained',async()=>{
  const s=await setup(['File:7@module:2']);await runJob(s.client,await s.review(),s.store);
  await put(s.root,'My notes.txt','keep me');const path=s.catalog.placements.find(p=>p.key==='File:7@module:2').path;
  const parts=path.split('/');(await s.root.getDirectoryHandle(parts[0])).children.delete(parts[1]);
  const missing=await s.review();assert.equal(missing.rows[0].state,'Missing');await runJob(s.client,missing,s.store);
  assert.equal(await read(s.root,path),'lecture');assert.equal(await read(s.root,'My notes.txt'),'keep me');
});
test('failed original download preserves previous copy and document falls back to online attachment',async()=>{
  const s=await setup();await runJob(s.client,await s.review(),s.store);
  s.fake.routes.get('/api/v1/courses/1/files/7').updated_at='new';const review=await s.review();
  const fetch=s.client.fetcher;s.client.fetcher=async(url,options)=>new URL(url).pathname==='/files/7/download'?response('<html>Sign in</html>',{raw:true,url,headers:{'Content-Type':'text/html'}}):fetch(url,options);
  const result=await runJob(s.client,review,s.store);assert.equal(result.report.counts.failed,1);
  const file=review.rows.find(r=>r.assetKey==='File:7'),page=review.rows.find(r=>r.assetKey==='Page:123');
  assert.equal(await read(s.root,file.path),'lecture');assert.ok((await read(s.root,page.path)).includes(ORIGIN+'/courses/1/files/7/download'));
  assert.ok(result.report.items.find(i=>i.assetKey==='File:7').reason.includes('HTML'));
});
test('unavailable selected files have useful titles; external links do not count as failed downloads',async()=>{
  const s=await setup(['File:99@module:2','File:199@module:3']);const report=(await runJob(s.client,await s.review(),s.store)).report;
  assert.equal(report.counts.failed,2);assert.ok(report.items.some(i=>i.title==='Restricted reference guide.pdf'));assert.ok(report.items.some(i=>i.title==='Forbidden handout'));
  assert.ok(report.externalLinks.length);assert.equal(report.items.length,2);
});
test('cancellation retains good bytes and old index; a new instance can recover with a disk recheck',async()=>{
  const s=await setup(['File:7@module:2']);await runJob(s.client,await s.review(),s.store);
  const oldIndex=await loadIndex(s.root,'1');s.fake.routes.get('/api/v1/courses/1/files/7').updated_at='new';
  const review=await s.review(),controller=new AbortController();s.root.onWrite=file=>{if(file.name.endsWith('.pdf'))controller.abort();};
  const cancelled=await runJob(s.client,review,s.store,{signal:controller.signal});assert.equal(cancelled.report.status,'cancelled');assert.equal(cancelled.report.counts.cancelled,1);
  assert.equal(await read(s.root,review.rows[0].path),'lecture');assert.equal((await loadIndex(s.root,'1')).entries[review.rows[0].path].sha256,oldIndex.entries[review.rows[0].path].sha256);
  assert.deepEqual((await s.store.get(runKey('1'))).selected,[...s.selected]);s.root.onWrite=null;
  assert.equal((await s.review()).rows[0].state,'Remote update available');await runJob(s.client,await s.review(),s.store);
});
test('a remote revision changing after review is reported before even an unchanged skip',async()=>{
  const s=await setup(['File:7@module:2']);await runJob(s.client,await s.review(),s.store);const review=await s.review();
  s.fake.routes.get('/api/v1/courses/1/files/7').updated_at='changed-after-review';
  const report=(await runJob(s.client,review,s.store)).report;assert.equal(report.counts.failed,1);assert.ok(report.items[0].reason.includes('after review'));
});
test('new files without revision timestamps download but cannot later be assumed unchanged',async()=>{
  const s=await setup(['File:7@module:2']);s.fake.routes.get('/api/v1/courses/1/files/7').updated_at=null;
  const result=await runJob(s.client,await s.review(),s.store);assert.equal(result.report.counts.downloaded,1);
  assert.equal((await s.review()).rows[0].state,'Existing—unverified');
});
test('permission loss retains the report in local browser storage for later saving',async()=>{
  const s=await setup(['File:7@module:2']);const review=await s.review();s.root.access='denied';
  const journal=await runJob(s.client,review,s.store);assert.equal(journal.report.counts.failed,1);assert.ok(journal.reportSaveError);assert.ok(await s.store.get(runKey('1')));
});
test('cyclic document links reconcile to online links if a selected target fails',async()=>{
  const s=await setup(['Page:123@module:2','Page:124@module:2']),review=await s.review();
  const original=s.client.fetcher;s.client.fetcher=async(url,options)=>new URL(url).pathname.endsWith('/pages/other')?response({}, {status:403,url}):original(url,options);
  const journal=await runJob(s.client,review,s.store);assert.equal(journal.report.counts.failed,1);
  const start=review.rows.find(r=>r.assetKey==='Page:123');assert.ok((await read(s.root,start.path)).includes(ORIGIN+'/courses/1/pages/other'));
  assert.ok(journal.report.items.find(i=>i.assetKey==='Page:123').onlineDependencies.some(d=>d.title==='More notes'));
});
test('original downloads use at most two simultaneous streams',async()=>{
  const s=await setup(['File:7@module:2','File:8@module:2','File:11@module:2']);
  s.fake.routes.set('/api/v1/courses/1/modules/2/items',[7,8,11].map(id=>({type:'File',content_id:id})));
  s.fake.routes.set('/api/v1/courses/1/modules/3/items',[]);
  s.catalog=await scanCourse(s.client,course,s.store);let active=0,max=0;const original=s.client.fetcher;
  s.client.fetcher=async(url,options)=>{
    if(!new URL(url).pathname.endsWith('/download'))return original(url,options);
    active++;max=Math.max(max,active);let emitted=false,finished=false;
    const stream=new ReadableStream({async pull(c){await new Promise(r=>setTimeout(r,2));if(!emitted){emitted=true;c.enqueue(new TextEncoder().encode('lecture'));}else{finished=true;active--;c.close();}},cancel(){if(!finished){finished=true;active--;}}});
    return response(stream,{raw:true,url,headers:{'Content-Type':'application/pdf'}});
  };
  const review=await prepareReview(s.client,s.catalog,s.root,s.selected,s.store);const report=(await runJob(s.client,review,s.store)).report;
  assert.equal(report.counts.downloaded,3);assert.ok(max<=2);assert.equal(active,0);
});
