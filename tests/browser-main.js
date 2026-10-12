// Copied into an ignored extension clone by test:browser:prepare. Never shipped
// in the production extension. Real Helium UI/storage/filesystem; mocked API.
import { CanvasClient, ORIGIN } from './canvas.js';
import { Store, destinationKey } from './store.js';
import { listCourses, scanCourse } from './scan.js';
import { mount } from './ui.js';
import { diskFile, writeStream, writeJSON } from './filesystem.js';
import { fixtures } from '../test/fixtures.js';
const fake = fixtures(), store = new Store('canvas-archive-fixture-browser');
const client = new CanvasClient({ fetcher: fake.fetcher, chromeAPI: null, delay: 0, wait: async()=>{} });
await client.connect();
const courses = await listCourses(client);
await store.set('courses',courses);
await scanCourse(client,courses[0],store);
const proof = await new Store().get('proof-handle');
if (proof) await store.set(destinationKey(ORIGIN,'1'),{ handle: proof, label:'Synthetic test folder' });
const ui = await mount({ client, store });
document.querySelector('h1').textContent = '[FIXTURE TEST] Canvas Local Archive';
const panel = document.createElement('div'); panel.className = 'notice';
panel.innerHTML = '<strong>Fixture browser test — no real Canvas session</strong><p>Choose or renew access to an empty test folder for TEST101. This workflow writes synthetic files only. API/authentication responses are mocked; folder handles, IndexedDB, UI, writers, and job locks are real Helium APIs.</p><button id="fixture-run">Run fixture workflow checks</button><pre id="fixture-result"></pre>';
document.querySelector('main').prepend(panel);
const result = document.querySelector('#fixture-result');
const assertions = [];
function check(label, condition) { assertions.push({ label, passed:!!condition }); if (!condition) throw new Error(label); }
async function waitFor(predicate) {
  for(let i=0;i<2000;i++) { if(predicate())return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Fixture workflow timed out');
}
document.querySelector('#fixture-run').onclick = async()=>{
  assertions.length=0;
  try {
    const root=ui.state.destinations.get('1')?.handle;
    check('real folder handle and granted read/write access',root && await root.queryPermission({mode:'readwrite'})==='granted');
    const contexts=await chrome.runtime.getContexts({contextTypes:['TAB']});check('runtime.getContexts works in Helium',contexts.some(c=>c.documentUrl===location.href));
    ui.state.expanded.add('1:modules');ui.state.expanded.add('1:module:2');ui.renderCourses();
    const parent=document.querySelector('input[data-course="1"][data-scope="course"]');parent.click();
    check('course checkbox selects discovered descendants',ui.state.selections.get('1').keys.size===ui.state.catalogs.get('1').placements.length);
    document.querySelector('input[data-item="File:7@module:2"]').click();
    check('individual deselection leaves course and module mixed',parent.indeterminate && document.querySelector('input[data-course="1"][data-scope="module:2"]').indeterminate);
    document.querySelector('#clear').click();await waitFor(()=>ui.state.selections.get('1').keys.size===0);
    document.querySelector('input[data-item="File:7@module:2"]').click();document.querySelector('input[data-item="Page:123@module:2"]').click();
    await ui.reviewSelection();document.querySelector('#start').click();await waitFor(()=>ui.state.runs.get('1')?.report.status==='complete'&&!ui.state.busy);
    const first=ui.state.runs.get('1').report;
    check('full-tab job saves selected original and offline HTML',first.counts.downloaded===2 && first.counts.failed===0);
    const filePath=first.items.find(i=>i.canvasType==='File').relativePath;
    const file=await (await (await root.getDirectoryHandle(filePath.split('/')[0])).getFileHandle(filePath.split('/')[1])).getFile();
    check('original file read-back uses real filesystem and exact bytes',await file.text()==='lecture');
    await ui.reviewSelection();document.querySelector('#start').click();
    const previousRun=first.id;await waitFor(()=>ui.state.runs.get('1')?.report.id!==previousRun&&!ui.state.busy);
    check('second run checks disk and skips verified unchanged files',ui.state.runs.get('1').report.counts.skipped===2);
    check('only selected original file was fetched',fake.requests.filter(r=>r.path.endsWith('/download')).length===1);
    const id=crypto.randomUUID(), path=`native-contract/${id}.txt`;
    await writeStream(root,path,new Blob(['good']).stream(),{expectedSize:4});
    const before=await diskFile(root,path);
    const broken=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('bad'));},pull(c){c.error(new Error('Synthetic interruption'));}});
    let interrupted=false;
    try { await writeStream(root,path,broken,{expectedDisk:before}); } catch { interrupted=true; }
    check('native createWritable abort preserves an existing good copy',interrupted && (await diskFile(root,path)).sha256===before.sha256);
    const saved=await store.get(destinationKey(ORIGIN,'1'));
    check('native IndexedDB round-trips a real directory handle',await saved.handle.isSameEntry(root));
    const record={scope:'Real Helium UI, IndexedDB, folder writes, checksums, and locking; synthetic API/session responses',userAgent:navigator.userAgent,assertions};
    await writeJSON(root,`native-contract/${id}-results.json`,record);
    result.textContent=JSON.stringify(record,null,2);
  } catch(error) { result.textContent=JSON.stringify({assertions,failed:String(error.message)},null,2); }
};
