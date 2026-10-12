import test from 'node:test';
import assert from 'node:assert/strict';
import { Directory, put, read } from './fake-fs.js';
import { ORIGIN } from '../extension/script/canvas.js';
import { diskFile, classify, emptyIndex, loadIndex, writeStream, saveEntry, writeJSON, pythonEntries, INDEX_PATH, checkPlacement } from '../extension/script/filesystem.js';
import { hashText } from '../extension/script/hash.js';
import { destinationKey, permission, renew } from '../extension/script/store.js';
const remote={updated_at:'2026-10-01',size:7};
const asset={key:'File:7',id:'7',kind:'File'},placement={key:'File:7@module:2',path:'01__2__Intro/7__Lecture notes.pdf',assetKey:'File:7'};
test('actual destination separates unindexed, unchanged, deleted, edited and remote updated files',async()=>{
  const root=new Directory(),index=emptyIndex('1');await put(root,placement.path,'lecture');
  assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Existing—unverified');
  await saveEntry(root,index,placement,asset,remote,{size:7,sha256:hashText('lecture')});
  assert.equal((await checkPlacement(root,placement,asset,await loadIndex(root,'1'),remote)).state,'Unchanged');
  assert.equal((await checkPlacement(root,placement,asset,index,{...remote,updated_at:'new'})).state,'Remote update available');
  await put(root,placement.path,'CORRUPT');assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Locally modified/conflict');
  const folder=await root.getDirectoryHandle('01__2__Intro');folder.children.delete('7__Lecture notes.pdf');
  assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Missing');
});
test('separate real course roots, changed destinations, origin and numeric course mappings',async()=>{
  const a=new Directory('EE test'),b=new Directory('STAT test'),changed=new Directory('Changed');await put(a,placement.path,'lecture');
  const ia=emptyIndex('1');await saveEntry(a,ia,placement,asset,remote,{size:7,sha256:hashText('lecture')});
  assert.equal((await checkPlacement(b,placement,asset,emptyIndex('2'),remote)).state,'Missing');
  assert.equal((await checkPlacement(changed,placement,asset,emptyIndex('1'),remote)).state,'Missing');
  assert.notEqual(destinationKey(ORIGIN,'1'),destinationKey(ORIGIN,'2'));assert.notEqual(destinationKey(ORIGIN,'1'),destinationKey('https://other.example','1'));
  await assert.rejects(loadIndex(a,'2'),/another course/);
});
test('matching size alone and incomplete remote metadata cannot establish identity',()=>{
  const disk={size:7,sha256:hashText('lecture')};
  assert.equal(classify(disk,{localSize:7},remote).state,'Existing—unverified');
  assert.equal(classify(disk,{sha256:disk.sha256,remote:{size:7}},{size:7}).state,'Existing—unverified');
});
test('Python index reconciles course-relative paths and verifies actual disk state',async()=>{
  const input={'1/1__Synthetic/01__2__Intro/7':{path:'1__Synthetic/01__2__Intro/7__Lecture notes.pdf',size:7,updated_at:remote.updated_at,sha256:hashText('lecture')},'2/wrong/7':{path:placement.path,sha256:hashText('lecture')},'1/unsafe/8':{path:'../evil',sha256:hashText('lecture')}};
  const entries=pythonEntries(input,'1');assert.deepEqual(Object.keys(entries),[placement.path]);
  const root=new Directory();await put(root,'download-index.json',JSON.stringify(input));await put(root,placement.path,'lecture');
  const index=await loadIndex(root,'1');assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Existing—unverified');
  index.entries[placement.path].originConfirmed=true;assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Unchanged');
  await put(root,placement.path,'CORRUPT');assert.equal((await checkPlacement(root,placement,asset,index,remote)).state,'Locally modified/conflict');
});
test('interrupted stream and incorrect sizes abort writer and preserve an existing good copy',async()=>{
  const root=new Directory(),old=await put(root,placement.path,'lecture'),before=await diskFile(root,placement.path);
  const broken=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('partial'));},pull(c){c.error(new Error('Interrupted'));}});
  await assert.rejects(writeStream(root,placement.path,broken,{expectedDisk:before,expectedSize:20}));assert.equal(await read(root,placement.path),'lecture');assert.equal(old.abortCount,1);
  await assert.rejects(writeStream(root,placement.path,new Blob(['short']).stream(),{expectedDisk:before,expectedSize:7}),/size differs/);assert.equal(await read(root,placement.path),'lecture');
});
test('changed destination after review and a local edit during writing are preserved',async()=>{
  const root=new Directory();const handle=await put(root,placement.path,'lecture'),before=await diskFile(root,placement.path);
  handle.set('my notes');await assert.rejects(writeStream(root,placement.path,new Blob(['replacement']).stream(),{expectedDisk:before}),/changed after review/);assert.equal(await read(root,placement.path),'my notes');
  const edited=await diskFile(root,placement.path);root.onWrite=async file=>{if(file===handle)file.set('new notes');};
  await assert.rejects(writeStream(root,placement.path,new Blob(['replacement']).stream(),{expectedDisk:edited}),/changed after review/);assert.equal(await read(root,placement.path),'new notes');
});
test('permission revocation aborts writes; visible renewal enables later access',async()=>{
  const root=new Directory(),file=await put(root,placement.path,'lecture'),before=await diskFile(root,placement.path);root.onWrite=async()=>{root.access='denied';};
  await assert.rejects(writeStream(root,placement.path,new Blob(['updated']).stream(),{expectedDisk:before}));assert.equal(new TextDecoder().decode(file.bytes),'lecture');assert.equal(await permission(root),false);
  root.renewTo='denied';assert.equal(await renew(root),false);root.renewTo='granted';assert.equal(await renew(root),true);root.onWrite=null;assert.equal(await read(root,placement.path),'lecture');
});
test('cancelled new writes leave no completed index, only an unverified empty placeholder',async()=>{
  const root=new Directory(),controller=new AbortController();root.onWrite=()=>controller.abort();
  await assert.rejects(writeStream(root,placement.path,new Blob(['lecture']).stream(),{signal:controller.signal}),{name:'AbortError'});
  assert.equal((await diskFile(root,placement.path)).size,0);assert.deepEqual((await loadIndex(root,'1')).entries,{});
});
test('invalid/foreign index and a directory occupying a file path fail safely',async()=>{
  const root=new Directory();await put(root,INDEX_PATH,'invalid');await assert.rejects(loadIndex(root,'1'),/invalid JSON/);
  await put(root,INDEX_PATH,JSON.stringify({...emptyIndex('1'),origin:'https://other.example'}));await assert.rejects(loadIndex(root,'1'),/another course/);
  const folder=await root.getDirectoryHandle('01__2__Intro',{create:true});await folder.getDirectoryHandle('7__Lecture notes.pdf',{create:true});
  await assert.rejects(diskFile(root,placement.path),{name:'TypeMismatchError'});
});
