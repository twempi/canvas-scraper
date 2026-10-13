import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectCRX, verifyCRX, extensionId, sri } from '../scripts/crx.mjs';
const release = JSON.parse(fs.readFileSync(new URL('../packages/release.json',import.meta.url)));
const bytes = fs.readFileSync(new URL('../packages/' + release.file,import.meta.url));

test('released CRX3 has a valid independent signature, identity and pinned SRI hash',()=>{
  const inspected = inspectCRX(bytes);
  assert.equal(inspected.id,release.id); assert.equal(extensionId(inspected.publicKey),release.id);
  assert.equal(inspected.hash,release.hash); assert.equal(sri(bytes),release.hash);
  assert.equal(inspected.manifest.version,release.version); assert.equal(inspected.manifest.manifest_version,3);
  assert.notEqual(release.id,release.unpackedId); assert.equal(inspected.manifest.update_url,undefined);
});
test('packaged assets match current readable source except the intentional signing key',()=>{
  const inspected = inspectCRX(bytes), source = path.resolve('extension'); let count=0;
  function walk(directory,prefix='') {
    for(const name of fs.readdirSync(directory)) {
      const filename=path.join(directory,name),relative=prefix+name;
      if(fs.statSync(filename).isDirectory())walk(filename,relative+'/');
      else {
        count++; const expected=fs.readFileSync(filename);
        if(relative==='manifest.json') {
          const original=JSON.parse(expected),actual={...inspected.manifest,key:original.key};assert.deepEqual(actual,original);
        } else assert.ok(inspected.files.get(relative)?.equals(expected),relative);
      }
    }
  }
  walk(source);assert.equal(inspected.files.size,count);
  assert.ok([...inspected.files.keys()].every(name=>!/^\.|\.pem$|\.crx$|node_modules|reference\/|test[s]?\//.test(name)));
});
test('tampered payload/signature, truncated headers and invalid format are rejected',()=>{
  const changed=Buffer.from(bytes);changed[changed.length-30]^=1;assert.throws(()=>verifyCRX(changed),/signature/);
  const header=Buffer.from(bytes);header.writeUInt32LE(0xffffffff,8);assert.throws(()=>verifyCRX(header),/header length/);
  const format=Buffer.from(bytes);format.writeUInt32LE(2,4);assert.throws(()=>verifyCRX(format),/CRX3/);
  assert.throws(()=>verifyCRX(bytes.subarray(0,10)),/CRX3/);
});
