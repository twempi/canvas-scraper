import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { mount, scopeKeys, selectableKeys, syncKey, relativeTime, assignmentFiles } from '../extension/script/ui.js';
import { CanvasClient, ORIGIN } from '../extension/script/canvas.js';
import { scanCourse, listCourses, coursePrevious, scanKey } from '../extension/script/scan.js';
import { destinationKey } from '../extension/script/store.js';
import { fixtures, MemoryStore, course, response } from './fixtures.js';
import { Directory, put, read } from './fake-fs.js';
const html=await fs.readFile(new URL('../extension/index.html',import.meta.url),'utf8');
async function setup(picker,{now,before}={}) {
  const {document,window}=parseHTML(html);globalThis.document=document;globalThis.window=window;
  const fake=fixtures(),store=new MemoryStore(),client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();
  const catalog=await scanCourse(client,course,store);await store.set('courses',[course,{...course,id:'2',name:'Same code, other term',term:{name:'Previous',end_at:'2020-01-01'}}]);
  await store.set(scanKey('1'),catalog);await before?.(store);
  const ui=await mount({client,store,picker:picker||(()=>Promise.resolve(new Directory())),chromeAPI:null,...(now?{now}:{})});
  return {...ui,document,window,catalog,fake};
}
function change(document,window,selector,checked) {
  const input=document.querySelector(selector);assert.ok(input,selector);input.checked=checked;input.dispatchEvent(new window.Event('change',{bubbles:true}));return input;
}
async function waitFor(predicate) { for(let i=0;i<500;i++){ if(predicate())return; await new Promise(r=>setTimeout(r,2)); } assert.fail('timed out waiting for UI'); }
async function settled(ui) { await new Promise(r=>setTimeout(r,2)); await waitFor(()=>!ui.state.busy); }
// Set up course 1 the way a user would: click "Set up", pick a folder, let the first sync finish.
async function setUpCourse(root=new Directory('TEST101')) {
  const ui=await setup(async()=>root);
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();
  await waitFor(()=>ui.state.sync.get('1')?.last&&!ui.state.busy);
  return {...ui,root};
}
const addUpload=(fake,id,name)=>{ const file=fake.file(id,name); fake.routes.get('/api/v1/courses/1/files').push(file); fake.routes.set(`/api/v1/courses/1/files/${id}`,file); };
// Every file path under a fake directory, excluding the archive's own index/reports.
function paths(directory,prefix=''){ return [...directory.children].flatMap(([name,child])=>name==='.canvas-archive'?[]:child.kind==='directory'?paths(child,`${prefix}${name}/`):[`${prefix}${name}`]); }
test('actual checkbox handlers support course/module descendants and individual deselection',async()=>{
  const ui=await setup(),s=ui.state.selections.get('1');ui.openCourse('1');
  change(ui.document,ui.window,'input[data-course="1"][data-scope="course"]',true);assert.equal(s.keys.size,selectableKeys(ui.catalog).length);
  assert.ok(selectableKeys(ui.catalog).length<ui.catalog.placements.length,'locked items are never selectable');
  ui.state.expanded.add('1:modules');ui.state.expanded.add('1:module:2');ui.render();
  change(ui.document,ui.window,'input[data-item="File:7@module:2"]',false);
  assert.equal(ui.document.querySelector('input[data-course="1"][data-scope="course"]').indeterminate,true);
  // Lecture notes is module 2's only downloadable file (the rest are pages or locked), so the module is now unticked.
  const module2=ui.document.querySelector('input[data-course="1"][data-scope="module:2"]');assert.equal(module2.checked,false);assert.equal(module2.indeterminate,false);
  assert.ok(!s.keys.has('File:7@module:2'));assert.ok(s.keys.has('File:7@module:3'));
  assert.equal(scopeKeys(ui.catalog,'files').filter(k=>k.startsWith('File:7')).length,0);
});
test('course search and past-course toggle operate on course name, code, and term',async()=>{
  const ui=await setup();assert.equal(ui.document.querySelectorAll('.course-row').length,1);
  change(ui.document,ui.window,'#previous',true);assert.equal(ui.document.querySelectorAll('.course-row').length,2);
  const search=ui.document.querySelector('#search');search.value='other term';search.dispatchEvent(new ui.window.Event('input'));assert.equal(ui.document.querySelectorAll('.course-row').length,1);
  search.value='Synthetic term';search.dispatchEvent(new ui.window.Event('input'));assert.equal(ui.document.querySelectorAll('.course-row').length,1);
});
test('picker cancellation preserves the existing destination and reports cancellation',async()=>{
  const ui=await setup(async()=>{throw new DOMException('Cancelled','AbortError');});
  const original=new Directory('Original');await ui.store.set(destinationKey(ORIGIN,'1'),{handle:original,label:'My label'});ui.state.destinations.set('1',{handle:original,label:'My label',granted:true});ui.openCourse('1');
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();await settled(ui);
  assert.equal(ui.state.destinations.get('1').handle,original);assert.equal((await ui.store.get(destinationKey(ORIGIN,'1'))).label,'My label');assert.ok(ui.document.querySelector('#status').textContent.includes('Cancelled'));
});
test('destination handles are scoped by origin and course ID and duplicate roots are rejected',async()=>{
  const shared=new Directory('Shared test'),ui=await setup(async()=>shared);ui.state.destinations.set('2',{handle:shared});
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();await settled(ui);assert.ok(!ui.state.destinations.has('1'));assert.ok(ui.document.querySelector('#status').textContent.includes('another course'));
  assert.equal(ui.document.querySelector('#status-card').dataset.tone,'error');
});
test('remembered handles query permissions without automatically requesting renewal',async()=>{
  const ui=await setup();const root=new Directory('Remembered');root.access='prompt';ui.state.destinations.set('1',{handle:root,granted:false});ui.render();
  assert.ok(ui.document.querySelector('[data-card="1"]').textContent.includes('Folder access needed'));assert.equal(root.access,'prompt');
  ui.document.querySelector('button[data-action="renew"][data-course="1"]').click();await settled(ui);assert.equal(root.access,'granted');
});
test('completed enrollments are explicitly enumerated and unavailable previous listing is reported',async()=>{
  const fake=fixtures(),fetch=fake.fetcher;
  const client=new CanvasClient({fetcher:async(url,options)=>new URL(url).searchParams.get('enrollment_state')==='completed'?response([{id:3,name:'Old course',course_code:'OLD101',term:{name:'Old term'}}],{url}):fetch(url,options),chromeAPI:null,delay:0,wait:async()=>{}});
  const courses=await listCourses(client);assert.equal(courses.length,3);assert.equal(coursePrevious(courses.find(c=>c.id==='3')),true);
  client.fetcher=async(url,options)=>new URL(url).searchParams.get('enrollment_state')==='completed'?response({}, {url,status:403}):fetch(url,options);
  assert.equal((await listCourses(client)).length,2);assert.equal(client.courseListWarnings.length,1);
});
test('setting up a course turns on auto-sync and downloads every available material in one click',async()=>{
  const ui=await setUpCourse(),rec=ui.state.sync.get('1'),available=selectableKeys(ui.state.catalogs.get('1')).length;
  assert.equal(rec.auto,true);assert.equal(rec.last.status,'ok');
  assert.equal(rec.last.counts.downloaded,available);assert.equal(rec.last.counts.failed,0);
  const lecture=ui.state.catalogs.get('1').placements.find(p=>p.key==='File:7@module:2');
  assert.equal(await read(ui.root,lecture.path),'lecture');
  assert.equal(ui.state.view.name,'course');assert.ok(ui.document.querySelector('#course-detail').textContent.includes('Recently downloaded'));
  assert.deepEqual((await ui.store.get(syncKey('1'))).auto,true,'auto-sync setting persists');
  assert.ok(!ui.fake.requests.some(r=>r.path==='/files/99/download'),'locked files are never fetched');
});
test('later syncs skip unchanged files and pick up new uploads automatically',async()=>{
  const ui=await setUpCourse(),before=ui.fake.requests.filter(r=>r.path.endsWith('/download')).length;
  await ui.syncAll();let last=ui.state.sync.get('1').last;
  assert.equal(last.counts.downloaded,0);assert.equal(last.counts.failed,0);assert.ok(last.counts.upToDate>0);
  assert.equal(ui.fake.requests.filter(r=>r.path.endsWith('/download')).length,before,'nothing re-downloaded');
  assert.equal(ui.document.querySelector('#status-title').textContent,'Everything is up to date');
  addUpload(ui.fake,12,'Week 9 slides.pdf');
  await ui.syncAll();last=ui.state.sync.get('1').last;
  assert.equal(last.counts.downloaded,1);assert.equal(ui.state.sync.get('1').recent[0].title,'Week 9 slides.pdf');
  assert.ok(ui.state.selections.get('1').keys.has('File:12@files'));
  assert.equal(await read(ui.root,ui.state.catalogs.get('1').placements.find(p=>p.key==='File:12@files').path),'lecture');
});
test('unticked materials stay excluded from auto-sync while new uploads are still included',async()=>{
  const ui=await setUpCourse();ui.openCourse('1');ui.state.expanded.add('1:assignments');ui.render();
  const key=ui.state.catalogs.get('1').placements.find(p=>p.assetKey==='File:8').key;
  change(ui.document,ui.window,`input[data-item="${key}"]`,false);
  assert.ok(ui.state.sync.get('1').excluded.includes(key));
  addUpload(ui.fake,13,'Exam review.pdf');await ui.syncAll();
  const s=ui.state.selections.get('1');assert.ok(!s.keys.has(key));assert.ok(s.keys.has('File:13@files'));
  assert.ok((await ui.store.get(syncKey('1'))).excluded.includes(key));
});
test('auto-sync never overwrites a file you edited',async()=>{
  const ui=await setUpCourse(),lecture=ui.state.catalogs.get('1').placements.find(p=>p.key==='File:7@module:2');
  await put(ui.root,lecture.path,'my notes');addUpload(ui.fake,14,'New handout.pdf');
  await ui.syncAll();const last=ui.state.sync.get('1').last;
  assert.equal(last.counts.kept,1);assert.ok(ui.state.sync.get('1').recent.some(i=>i.title==='New handout.pdf'));
  assert.equal(await read(ui.root,lecture.path),'my notes');
});
test('the timer syncs only after the chosen interval and the panel shows when',async()=>{
  let clock=Date.parse('2026-11-24T10:00:00Z');
  const ui=await setup(async()=>new Directory('Timed'),{now:()=>clock});
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();
  await waitFor(()=>ui.state.sync.get('1')?.last&&!ui.state.busy);
  ui.state.lastCycle=new Date(clock).toISOString();
  clock+=10*60000;ui.tick();assert.equal(ui.state.busy,false,'no sync before the interval');
  ui.showView('home');assert.ok(ui.document.querySelector('#sync-summary').textContent.includes('next check in 20 min'));
  clock+=21*60000;ui.tick();assert.equal(ui.state.busy,true,'sync starts after 30 minutes');await settled(ui);
  assert.equal(ui.state.lastCycle,new Date(clock).toISOString());
  assert.equal(relativeTime(new Date(clock-5*60000).toISOString(),clock),'5 min ago');
});
test('an expired Canvas session during sync asks you to sign in instead of failing silently',async()=>{
  const ui=await setUpCourse();ui.client.fetcher=async url=>response({}, {url,status:401});
  await ui.syncAll();
  assert.equal(ui.document.querySelector('#connect').dataset.state,'auth');
  assert.equal(ui.document.querySelector('#status-title').textContent,'Sign in to Canvas');
  assert.equal(ui.document.querySelector('#status-card').dataset.tone,'warn');
});
test('basic mode hides power tools and advanced mode reveals them; the choice persists',async()=>{
  const ui=await setUpCourse();ui.openCourse('1');
  assert.ok(!ui.document.querySelector('[data-action="review-course"]'));assert.ok(!ui.document.querySelector('[data-action="import"]'));
  ui.document.querySelector('button[data-mode="advanced"]').click();
  assert.ok(ui.document.body.classList.contains('advanced'));
  assert.ok(ui.document.querySelector('[data-action="review-course"]'));assert.ok(ui.document.querySelector('[data-action="import"]'));
  assert.equal(await ui.store.get('ui:mode'),'advanced');
  ui.document.querySelector('[data-action="review-course"]').click();await settled(ui);
  assert.equal(ui.state.view.name,'review');assert.ok(ui.document.querySelectorAll('.review-item').length>0);
  ui.document.querySelector('button[data-mode="basic"]').click();assert.equal(ui.state.view.name,'course','leaving advanced mode exits advanced-only views');
});
test('only files are downloaded: web pages and assignment descriptions never are, but their attached files are',async()=>{
  const ui=await setUpCourse(),catalog=ui.state.catalogs.get('1');
  for(const key of scopeKeys(catalog,'course'))assert.equal(catalog.assets[catalog.placements.find(p=>p.key===key).assetKey].kind,'File',key);
  const written=paths(ui.root);
  assert.ok(written.length>0);assert.deepEqual(written.filter(p=>p.endsWith('.html')),[],'no web pages written');
  // The Worksheet assignment links Lecture notes.pdf; the non-module assignment links Lab data.csv.
  assert.ok(written.includes(catalog.placements.find(p=>p.key==='File:7@module:2').path));
  assert.ok(written.includes(catalog.placements.find(p=>p.key==='File:8@assignments').path));
  assert.deepEqual(assignmentFiles(catalog).get('File:7').titles,['Worksheet']);
  assert.ok(ui.state.runs.get('1').report.items.every(i=>i.canvasType==='File'),'report lists only files');
});
test('the Assignments section lists files attached to assignments, labelled with the assignment',async()=>{
  const ui=await setup();ui.openCourse('1');ui.state.expanded.add('1:assignments');ui.render();
  const section=ui.document.querySelector('details[data-scope="assignments"]');
  const titles=[...section.querySelectorAll('.item-title')].map(n=>n.textContent);
  assert.deepEqual(titles.sort(),['Lab data.csv','Lecture notes.pdf']);
  assert.ok(section.textContent.includes('From Worksheet'));assert.ok(section.textContent.includes('From Independent assignment'));
  ui.state.expanded.add('1:modules');ui.state.expanded.add('1:module:2');ui.render();
  assert.ok(![...ui.document.querySelectorAll('.tree .item-title')].some(n=>['Getting started','Worksheet','Quiz description'].includes(n.textContent)),'pages are not listed');
});
test('selections saved by older versions drop web pages',async()=>{
  const ui=await setup(null,{before:store=>store.set(`selection:${ORIGIN}:1`,['Page:123@module:2','Assignment:9@module:2','File:7@module:2'])});
  assert.deepEqual([...ui.state.selections.get('1').keys],['File:7@module:2']);
});
