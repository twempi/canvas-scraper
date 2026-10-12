import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { mount, scopeKeys } from '../extension/script/ui.js';
import { CanvasClient, ORIGIN } from '../extension/script/canvas.js';
import { scanCourse, listCourses, coursePrevious, scanKey } from '../extension/script/scan.js';
import { destinationKey } from '../extension/script/store.js';
import { fixtures, MemoryStore, course, response } from './fixtures.js';
import { Directory } from './fake-fs.js';
const html=await fs.readFile(new URL('../extension/index.html',import.meta.url),'utf8');
async function setup(picker) {
  const {document,window}=parseHTML(html);globalThis.document=document;globalThis.window=window;
  const fake=fixtures(),store=new MemoryStore(),client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();
  const catalog=await scanCourse(client,course,store);await store.set('courses',[course,{...course,id:'2',name:'Same code, other term',term:{name:'Previous',end_at:'2020-01-01'}}]);
  await store.set(scanKey('1'),catalog);
  const ui=await mount({client,store,picker:picker||(()=>Promise.resolve(new Directory())),chromeAPI:null});
  return {...ui,document,window,catalog,fake};
}
function change(document,window,selector,checked) {
  const input=document.querySelector(selector);assert.ok(input,selector);input.checked=checked;input.dispatchEvent(new window.Event('change',{bubbles:true}));return input;
}
async function settled(ui) { for(let i=0;i<100&&ui.state.busy;i++)await new Promise(r=>setTimeout(r,2));assert.equal(ui.state.busy,false); }
test('actual checkbox handlers support course/module descendants and individual deselection',async()=>{
  const ui=await setup(),s=ui.state.selections.get('1');
  change(ui.document,ui.window,'input[data-course="1"][data-scope="course"]',true);assert.equal(s.keys.size,ui.catalog.placements.length);
  ui.state.expanded.add('1:modules');ui.state.expanded.add('1:module:2');ui.renderCourses();
  change(ui.document,ui.window,'input[data-item="File:7@module:2"]',false);
  assert.equal(ui.document.querySelector('input[data-course="1"][data-scope="course"]').indeterminate,true);
  assert.equal(ui.document.querySelector('input[data-course="1"][data-scope="module:2"]').indeterminate,true);
  assert.ok(!s.keys.has('File:7@module:2'));assert.ok(s.keys.has('File:7@module:3'));
  assert.equal(scopeKeys(ui.catalog,'files').filter(k=>k.startsWith('File:7')).length,0);
});
test('course search and previous toggle operate on course name, code, and term',async()=>{
  const ui=await setup();assert.equal(ui.document.querySelectorAll('.course-card').length,1);
  change(ui.document,ui.window,'#previous',true);assert.equal(ui.document.querySelectorAll('.course-card').length,2);
  const search=ui.document.querySelector('#search');search.value='other term';search.dispatchEvent(new ui.window.Event('input'));assert.equal(ui.document.querySelectorAll('.course-card').length,1);
  search.value='Synthetic term';search.dispatchEvent(new ui.window.Event('input'));assert.equal(ui.document.querySelectorAll('.course-card').length,1);
});
test('picker cancellation preserves the existing destination and reports cancellation',async()=>{
  const ui=await setup(async()=>{throw new DOMException('Cancelled','AbortError');});
  const original=new Directory('Original');await ui.store.set(destinationKey(ORIGIN,'1'),{handle:original,label:'My label'});ui.state.destinations.set('1',{handle:original,label:'My label'});ui.renderCourses();
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();await settled(ui);
  assert.equal(ui.state.destinations.get('1').handle,original);assert.equal((await ui.store.get(destinationKey(ORIGIN,'1'))).label,'My label');assert.ok(ui.document.querySelector('#status').textContent.includes('Cancelled'));
});
test('destination handles are scoped by origin and course ID and duplicate roots are rejected',async()=>{
  const shared=new Directory('Shared test'),ui=await setup(async()=>shared);ui.state.destinations.set('2',{handle:shared});
  ui.document.querySelector('button[data-action="choose"][data-course="1"]').click();await settled(ui);assert.ok(!ui.state.destinations.has('1'));assert.ok(ui.document.querySelector('#status').textContent.includes('another course'));
});
test('remembered handles query permissions without automatically requesting renewal',async()=>{
  const ui=await setup();const root=new Directory('Remembered');root.access='prompt';ui.state.destinations.set('1',{handle:root,granted:false});ui.renderCourses();
  assert.ok(ui.document.querySelector('[data-card="1"]').textContent.includes('Renew access'));assert.equal(root.access,'prompt');
  ui.document.querySelector('button[data-action="renew"][data-course="1"]').click();await settled(ui);assert.equal(root.access,'granted');
});
test('completed enrollments are explicitly enumerated and unavailable previous listing is reported',async()=>{
  const fake=fixtures(),fetch=fake.fetcher;
  const client=new CanvasClient({fetcher:async(url,options)=>new URL(url).searchParams.get('enrollment_state')==='completed'?response([{id:3,name:'Old course',course_code:'OLD101',term:{name:'Old term'}}],{url}):fetch(url,options),chromeAPI:null,delay:0,wait:async()=>{}});
  const courses=await listCourses(client);assert.equal(courses.length,3);assert.equal(coursePrevious(courses.find(c=>c.id==='3')),true);
  client.fetcher=async(url,options)=>new URL(url).searchParams.get('enrollment_state')==='completed'?response({}, {url,status:403}):fetch(url,options);
  assert.equal((await listCourses(client)).length,2);assert.equal(client.courseListWarnings.length,1);
});
