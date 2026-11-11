import test from 'node:test';
import assert from 'node:assert/strict';
import { toPDF, HOST } from '../extension/script/convert.js';
import { fileName, convertible } from '../extension/script/names.js';
// Fake native port: replies with "PDF:" + received bytes, or disconnects like a missing host.
function fakeChrome({ missing = false } = {}) {
  const runtime = { lastError: null, connectNative(name) {
    assert.equal(name, HOST);
    const listeners = { message: [], disconnect: [] }, received = [];
    const port = {
      onMessage: { addListener: f => listeners.message.push(f) }, onDisconnect: { addListener: f => listeners.disconnect.push(f) },
      disconnect() {}, postMessage(message) {
        if (missing) throw new Error('Attempting to use a disconnected port object');
        if (message.data) received.push(...Buffer.from(message.data, 'base64'));
        if (message.end) {
          const pdf = Buffer.concat([Buffer.from('PDF:'), Buffer.from(received)]);
          setTimeout(() => { for (const part of [pdf.subarray(0, 3), pdf.subarray(3)]) listeners.message.forEach(f => f({ data: part.toString('base64') })); listeners.message.forEach(f => f({ done: true })); });
        }
      }
    };
    if (missing) setTimeout(() => { runtime.lastError = { message: 'Specified native messaging host not found.' }; listeners.disconnect.forEach(f => f()); });
    return port;
  } };
  return { runtime };
}
test('office files map to PDF destinations; other files keep their names', () => {
  assert.equal(fileName({ id: '7', filename: 'Week 1.pptx' }), '7__Week 1.pdf');
  assert.equal(fileName({ id: '8', filename: 'Lab.DOCX' }), '8__Lab.pdf');
  assert.equal(fileName({ id: '9', filename: 'data.csv' }), '9__data.csv');
  assert.ok(convertible('Notes.odt ')); assert.ok(!convertible('Notes.pdf'));
});
test('toPDF streams the original to the helper and returns its PDF bytes', async () => {
  const pdf = await toPDF(new Blob(['slides']).stream(), 'Week 1.pptx', null, fakeChrome());
  assert.equal(await new Response(pdf).text(), 'PDF:slides');
});
test('a missing helper fails with install guidance', async () => {
  await assert.rejects(toPDF(new Blob(['slides']).stream(), 'Week 1.pptx', null, fakeChrome({ missing: true })), /not installed/);
  await assert.rejects(toPDF(new Blob(['x']).stream(), 'a.docx', null, null), /not installed/);
});
