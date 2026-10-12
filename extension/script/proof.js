import { Store, permission, renew } from './store.js';
import { CanvasClient } from './canvas.js';
const store = new Store();
let handle = await store.get('proof-handle');
const result = document.querySelector('#result');
const events = [];
function show(event) {
  events.push(event);
  result.textContent = JSON.stringify({
    secureContext: isSecureContext, pickerAvailable: typeof showDirectoryPicker === 'function',
    restoredHandle: handle?.name || null, events
  }, null, 2);
}
show({ operation: 'restore', restored: !!handle, permission: handle ? await handle.queryPermission({ mode: 'readwrite' }) : 'none' });
async function action(callback) {
  try { await callback(); } catch (error) { show({ error: error.name, detail: error.userMessage || String(error.message).replace(/https?:\/\/\S+/g, '[URL removed]') }); }
}
document.querySelector('#choose').onclick = () => action(async () => {
  const selected = await showDirectoryPicker({ mode: 'readwrite', id: 'canvas-proof' });
  await store.set('proof-handle', selected);
  handle = selected;
  show({ operation: 'choose', folder: handle.name, permission: await handle.queryPermission({ mode: 'readwrite' }) });
});
document.querySelector('#renew').onclick = () => action(async () => {
  if (!handle) return show({ operation: 'renew', detail: 'Choose a test folder first.' });
  show({ operation: 'renew', granted: await renew(handle) });
});
document.querySelector('#check').onclick = () => action(async () => {
  if (!await permission(handle)) return show({ operation: 'check', detail: 'Choose a folder or renew access first.' });
  let existing;
  try {
    const file = await (await handle.getFileHandle('existing.txt')).getFile();
    existing = { name: file.name, size: file.size, content: file.size < 1024 ? await file.text() : '(too large for proof preview)' };
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    existing = { detail: 'existing.txt is missing. Add a small fixture to prove reading an existing file.' };
  }
  const name = `canvas-capability-${crypto.randomUUID()}.txt`;
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writer = await fileHandle.createWritable({ mode: 'exclusive' });
  await writer.write('Canvas Local Archive folder access test\n');
  await writer.close();
  const text = await (await fileHandle.getFile()).text();
  show({ operation: 'check', existing, created: name, readBack: text, passed: text === 'Canvas Local Archive folder access test\n' });
});
document.querySelector('#connect').onclick = () => action(async () => {
  const client = new CanvasClient();
  await client.connect();
  show({ operation: 'session', passed: true, origin: client.origin, transport: client.transportName });
});
document.querySelector('#forget').onclick = () => action(async () => {
  await store.delete('proof-handle'); handle = null; show({ operation: 'forget' });
});
