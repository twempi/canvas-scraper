import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { CanvasClient, ORIGIN } from '../extension/script/canvas.js';
import { fixtures, MemoryStore, course } from './fixtures.js';
import { scanCourse } from '../extension/script/scan.js';
import { bodyHTML, offlineDocument, cleanURL, reference, replacementsFor } from '../extension/script/html.js';
import { safeName, moduleFolder, fileName, documentName, pathParts, relativeLink, uniqueDocumentNames } from '../extension/script/names.js';
import { hashText, SHA256, hashFile } from '../extension/script/hash.js';
import { Selection } from '../extension/script/selection.js';
globalThis.document = parseHTML('<!doctype html><html><body></body></html>').document;
async function scanned(options) { const fake=fixtures(options),store=new MemoryStore(),client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();return {fake,store,client,catalog:await scanCourse(client,course,store)}; }
test('Python names, Unicode, spaces, reserved names, traversal, long UTF-8, collisions',()=>{
  assert.equal(safeName('../Lecture.pdf'),'_Lecture.pdf');assert.equal(safeName('CON'),'_CON');assert.equal(safeName('..'),'untitled');
  assert.equal(safeName('Résumé : notes.pdf'),'Résumé _ notes.pdf');assert.equal(safeName('😀'.repeat(150)), '😀'.repeat(130));
  assert.equal(moduleFolder({position:1,id:2,name:'Intro / theory'}),'01__2__Intro _ theory');
  assert.equal(fileName({id:'7',filename:'Lecture notes.pdf'}),'7__Lecture notes.pdf');
  assert.equal(documentName('1',{kind:'Page',id:'start',title:'Start here'}),'page_1_start__Start here.html');
  const long=documentName('123456789',{kind:'Page',id:'語'.repeat(130),title:'語'.repeat(130)});assert.ok(new TextEncoder().encode(long).length<=255);assert.ok(long.endsWith('.html'));
  for(const path of ['../note','/absolute','a/../b','a\\b','a//b','a/\0b'])assert.throws(()=>pathParts(path));
  assert.equal(relativeLink('module/page.html','module/7__Lecture notes.pdf'),'7__Lecture%20notes.pdf');
  const names=uniqueDocumentNames([{kind:'Page',id:'a:b',title:'Same',numericId:1,key:'Page:1'},{kind:'Page',id:'a?b',title:'Same',numericId:2,key:'Page:2'}],'1');assert.notEqual(names.get('Page:1'),names.get('Page:2'));
});
test('incremental SHA-256 matches independent crypto for uneven chunks and large file',async()=>{
  for(const value of ['', 'abc', 'Unicode 語 😀', 'a'.repeat(1000000)]) assert.equal(hashText(value),createHash('sha256').update(value).digest('hex'));
  const bytes=new TextEncoder().encode('0123456789'.repeat(210000)),hash=new SHA256();
  for(let i=0;i<bytes.length;i+=71)hash.update(bytes.subarray(i,i+71));assert.equal(hash.hex(),createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await hashFile(new Blob([bytes])),hash.hex());
});
test('inert HTML sanitization strips scripts, embeds, unsafe links, event handlers, styles and auth queries',()=>{
  const body='<script><a href="/files/666">bad</a></script><form><a href="/files/667">bad</a></form><a href="/files/7?verifier=fake-secret" onclick="bad()" style="display:none">PDF</a><img src="/files/8" onerror="bad()"><a href="javascript:bad()">Unsafe</a><iframe src="https://www.youtube.com/watch?v=abc&access_token=fake-secret"></iframe><svg onload="bad()"><script>bad()</script></svg>';
  const parsed=bodyHTML(body,{courseId:'1',replacements:new Map([[ORIGIN+'/files/7','7__Lecture%20notes.pdf']])});
  assert.ok(parsed.html.includes('href="7__Lecture%20notes.pdf"'));assert.ok(!/script|iframe|onclick|onerror|style=|javascript:|fake-secret|svg/.test(parsed.html));
  assert.ok(!parsed.links.some(l=>/666|667/.test(l.url)));assert.ok(parsed.html.includes('Image (open online)'));
  const html=offlineDocument('Unsafe <title>',body,'1',ORIGIN+'/courses/1/pages/start');assert.ok(html.includes('Content-Security-Policy'));assert.ok(html.includes('Unsafe &lt;title&gt;'));
  assert.equal(cleanURL(null),null);assert.equal(cleanURL('https://colab.research.google.com/drive/id?token=secret'),'https://colab.research.google.com/drive/id');
  assert.equal(reference('/courses/2/files/7','1'),null);assert.equal(reference('https://evil.example/files/7','1'),null);
});
test('broader scan paginates, breaks cycles, deduplicates IDs, preserves modules and discovers supplemental content',async()=>{
  const {catalog,fake}=await scanned();
  assert.equal(catalog.modules.length,2);assert.ok(catalog.assets['Page:123']);assert.ok(catalog.assets['Page:124']);
  const file7=catalog.placements.filter(p=>p.assetKey==='File:7');assert.equal(file7.length,2);assert.ok(file7.every(p=>p.context.startsWith('module:')));
  assert.ok(!catalog.placements.some(p=>p.assetKey==='File:7'&&p.path.startsWith('_Other-course-files')));
  assert.equal(fake.requests.filter(r=>r.path==='/api/v1/courses/1/files/7').length,1);
  assert.ok(catalog.placements.some(p=>p.assetKey==='Assignment:10'&&p.path==='_Assignments/assignment_1_10__Independent assignment.html'));
  assert.ok(catalog.placements.some(p=>p.assetKey==='File:11'&&p.path.startsWith('_Other-course-files/21__Notes _ PDFs/11__')));
  assert.ok(!catalog.placements.some(p=>p.assetKey==='Assignment:9'&&p.context==='assignments'));
  assert.ok(catalog.assets['File:99'].unavailable);assert.equal(catalog.assets['File:99'].title,'Restricted reference guide.pdf');
  assert.equal(catalog.assets['File:199'].title,'Forbidden handout');
  assert.ok(!fake.requests.some(r=>/questions|submissions|replies|grades|\/view$|\/courses\/2\/pages/.test(r.path)));
  assert.ok(catalog.external.some(r=>r.url?.includes('colab')));assert.ok(!JSON.stringify(catalog).includes('fake-secret'));
});
test('unavailable course endpoints preserve accessible discovery and report coverage',async()=>{
  for(const options of [{filesDenied:true},{assignmentsDenied:true},{modulesDenied:true}]) {
    const {catalog}=await scanned(options);assert.ok(catalog.coverage.length);assert.ok(catalog.assets['File:7']);
    if(options.filesDenied)assert.ok(catalog.coverage.some(c=>c.section.includes('Course Files')));
    if(options.modulesDenied)assert.ok(catalog.placements.some(p=>p.assetKey==='File:7'&&p.context==='assignments'));
  }
});
test('bounded recursion records deep links without fetching beyond limit',async()=>{
  const fake=fixtures();fake.routes.set('/api/v1/courses/1/modules/2/items',[{type:'Page',page_url:'depth0'}]);fake.routes.set('/api/v1/courses/1/modules/3/items',[]);
  for(let depth=0;depth<9;depth++)fake.routes.set(`/api/v1/courses/1/pages/depth${depth}`,{page_id:500+depth,url:`depth${depth}`,title:`Depth ${depth}`,body:`<a href="/courses/1/pages/depth${depth+1}">Next</a>`});
  const client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();
  const catalog=await scanCourse(client,course,new MemoryStore());assert.ok(!fake.requests.some(r=>r.path.endsWith('/depth6')));assert.ok(catalog.external.some(r=>r.reason.includes('depth limit')));
});
test('locked module items never fetch document bodies or descend into links',async()=>{
  const fake=fixtures();fake.routes.set('/api/v1/courses/1/modules/2/items',[{type:'Page',page_url:'locked-page',title:'Locked page',content_details:{locked_for_user:true}}]);fake.routes.set('/api/v1/courses/1/modules/3/items',[]);
  const client=new CanvasClient({fetcher:fake.fetcher,chromeAPI:null,delay:0,wait:async()=>{}});await client.connect();
  const catalog=await scanCourse(client,course,new MemoryStore());assert.ok(!fake.requests.some(r=>r.path.endsWith('locked-page')));assert.ok(catalog.assets['Page:locked-page'].unavailable);
});
test('parent selection can be partially deselected; unselected dependencies stay online',async()=>{
  const {catalog}=await scanned(),s=new Selection(),module=catalog.placements.filter(p=>p.context==='module:2').map(p=>p.key);
  s.group(module,true);s.set('File:7@module:2',false);assert.equal(s.state(module).indeterminate,true);assert.equal(s.state(module).checked,false);
  const page=catalog.placements.find(p=>p.assetKey==='Page:123'&&p.context==='module:2');
  const refs=replacementsFor(page,catalog,s.keys);assert.ok(refs.dependencies.some(d=>d.title==='Lecture notes.pdf'));assert.ok(!refs.replacements.has(ORIGIN+'/courses/1/files/7/download'));
  s.set('File:7@module:3',true);const elsewhere=replacementsFor(page,catalog,s.keys);assert.ok(elsewhere.replacements.get(ORIGIN+'/courses/1/files/7/download').startsWith('../02__3__Practice/'));
});
