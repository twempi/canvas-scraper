import { ORIGIN, ArchiveError, checkAbort } from './canvas.js';
import { pathParts } from './names.js';
import { SHA256, hashFile } from './hash.js';
import { permission } from './store.js';
export const INDEX_PATH = '.canvas-archive/index.json';
export async function resolveFile(root, path, create = false) {
  const parts = pathParts(path); let directory = root;
  for (const part of parts.slice(0,-1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1), { create });
}
export async function diskFile(root, path, signal, checksum = true) {
  checkAbort(signal);
  try {
    const handle = await resolveFile(root, path), file = await handle.getFile();
    const sha256 = checksum ? await hashFile(file, signal) : null;
    const after = await handle.getFile();
    if (file.size !== after.size || file.lastModified !== after.lastModified) throw new ArchiveError('The local file changed while it was being checked. Recheck before continuing.', 'conflict');
    return { handle, size: file.size, lastModified: file.lastModified, sha256 };
  } catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
export function sameVersion(old, current) {
  if (!old || !current) return false;
  if (current.bodyHash) return old.bodyHash === current.bodyHash;
  return !!current.updated_at && old.updated_at === current.updated_at && old.size === current.size;
}
export function classify(disk, entry, remote, unavailable) {
  if (unavailable) return { state: 'Unavailable', reason: unavailable };
  if (!disk) return { state: 'Missing', reason: 'Expected file is absent from this course destination.' };
  if (!entry?.sha256 || !disk.sha256) return { state: 'Existing—unverified', reason: 'This file exists on disk, but has no reliable checksum index. Preserved unless you verify or explicitly replace it.' };
  if (entry.sha256 !== disk.sha256 || entry.localSize != null && entry.localSize !== disk.size) return { state: 'Locally modified/conflict', reason: 'Local contents differ from the recorded checksum. Preserved unless you explicitly replace them.' };
  if (entry.source === 'python-import' && !entry.originConfirmed) return { state: 'Existing—unverified', reason: 'Python checksum matches locally, but its index has no Canvas origin. Verify contents or confirm the origin when importing.' };
  if (!remote?.updated_at && !remote?.bodyHash) return { state: 'Existing—unverified', reason: 'Local checksum matches, but Canvas supplied no reliable remote revision. Verify or explicitly replace.' };
  if (sameVersion(entry.remote, remote)) return { state: 'Unchanged', reason: 'Remote revision and local SHA-256 match the completed index.' };
  return { state: 'Remote update available', reason: 'Local copy is intact and Canvas or the selected offline links have changed.' };
}
export function emptyIndex(courseId) { return { version: 1, origin: ORIGIN, courseId: String(courseId), entries: {} }; }
export async function readJSON(root, path) {
  let handle;
  try { handle = await resolveFile(root, path); }
  catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
  const file = await handle.getFile();
  if (file.size > 16 * 1024 * 1024) throw new ArchiveError('Local index exceeds the 16 MiB limit. Preserve it and use a different destination.');
  try { return JSON.parse(await file.text()); }
  catch { throw new ArchiveError('Local index is invalid JSON. Preserve it and repair or rename the index before retrying.'); }
}
export function pythonEntries(data, courseId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ArchiveError('This is not a Python download index.');
  const entries = {};
  for (const [key, value] of Object.entries(data)) {
    const keyParts = key.split('/'), fileId = keyParts.at(-1);
    if (keyParts[0] !== String(courseId) || !/^\d+$/.test(fileId) || !value || !/^[a-f0-9]{64}$/i.test(value.sha256 || '') || typeof value.path !== 'string') continue;
    let parts;
    try { parts = pathParts(value.path); } catch { continue; }
    if (parts[0].startsWith(`${courseId}__`)) parts.shift();
    if (!parts.length || !parts.at(-1).startsWith(`${fileId}__`)) continue;
    const path = parts.join('/');
    entries[path] = { assetKey: `File:${fileId}`, path, remote: { updated_at: value.updated_at || null, size: value.size ?? null }, localSize: value.size ?? null, sha256: value.sha256.toLowerCase(), source: 'python-import' };
  }
  return entries;
}
export async function loadIndex(root, courseId) {
  const data = await readJSON(root, INDEX_PATH);
  if (data) {
    if (data.version !== 1 || data.origin !== ORIGIN || data.courseId !== String(courseId) || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new ArchiveError('This folder contains an index for another course or an unsupported index. Choose a separate course folder.');
    for (const [path, entry] of Object.entries(data.entries)) {
      try { pathParts(path); } catch { throw new ArchiveError('Index contains an unsafe relative path. Preserve the index and repair it.'); }
      if (entry.path !== path || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) throw new ArchiveError('Index contains an invalid checksum entry. Preserve the index and repair it.');
    }
    return data;
  }
  const index = emptyIndex(courseId);
  // Python normally keeps this one level above the course root. No parent access is assumed.
  const python = await readJSON(root, 'download-index.json');
  if (python) index.entries = pythonEntries(python, courseId);
  return index;
}
export async function ensurePermission(root) {
  if (!await permission(root)) throw new ArchiveError('Folder access is required. Click Renew access, then recheck.', 'permission');
}
export async function checkPlacement(root, placement, asset, index, remote, signal) {
  await ensurePermission(root);
  if (asset.unavailable || placement.unavailable) return { ...classify(null, null, remote, placement.unavailable || asset.unavailable), disk: null };
  const disk = await diskFile(root, placement.path, signal);
  const entry = index.entries[placement.path];
  const matched = entry?.assetKey === asset.key ? entry : null;
  return { ...classify(disk, matched, remote), disk: disk ? { size: disk.size, lastModified: disk.lastModified, sha256: disk.sha256 } : null };
}
async function unchangedSince(root, path, expected, signal) {
  const actual = await diskFile(root, path, signal);
  // An empty newly-created handle may exist before close; it is never treated as a download.
  if (!expected) {
    if (actual && actual.size !== 0) throw new ArchiveError('A local file appeared during download; preserved. Recheck before retrying.', 'conflict');
  } else if (!actual || actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
    throw new ArchiveError('The destination changed after review; preserved. Recheck before retrying.', 'conflict');
  }
}
export async function writeStream(root, path, stream, { signal, expectedSize = null, expectedDisk = null, progress = () => {} } = {}) {
  await ensurePermission(root); checkAbort(signal);
  const before = await diskFile(root, path, signal);
  if (expectedDisk ? !before || before.sha256 !== expectedDisk.sha256 || before.size !== expectedDisk.size : !!before) {
    throw new ArchiveError('The destination changed after review; preserved. Recheck before retrying.', 'conflict');
  }
  const handle = before?.handle || await resolveFile(root, path, true);
  let writer, reader, closed = false, size = 0; const hash = new SHA256();
  try {
    writer = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
    reader = stream.getReader();
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value);
      size += bytes.byteLength;
      if (expectedSize != null && size > expectedSize) throw new ArchiveError('Downloaded size exceeds Canvas metadata. Existing file preserved.');
      hash.update(bytes); await writer.write(bytes); progress(size);
    }
    checkAbort(signal);
    if (expectedSize != null && size !== expectedSize) throw new ArchiveError('Downloaded size differs from Canvas metadata. Existing file preserved.');
    const sha256 = hash.hex();
    await unchangedSince(root, path, expectedDisk, signal);
    await ensurePermission(root); checkAbort(signal);
    await writer.close(); closed = true;
    const committed = await diskFile(root, path, signal);
    if (!committed || committed.size !== size || committed.sha256 !== sha256) throw new ArchiveError('Saved file failed read-back integrity verification. No completed index entry was recorded.');
    return { sha256, size };
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    if (writer && !closed) await writer.abort().catch(() => {});
    // A newly-created empty file can remain after interruption. Never delete a file
    // that another program could have edited. Recheck and explicitly replace it.
  }
}
export async function writeJSON(root, path, value) {
  const disk = await diskFile(root, path);
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
  return writeStream(root, path, blob.stream(), { expectedSize: blob.size, expectedDisk: disk });
}
export async function saveEntry(root, index, placement, asset, remote, saved) {
  const next = { ...index, entries: { ...index.entries, [placement.path]: { assetKey: asset.key, canvasId: asset.id, path: placement.path, remote, localSize: saved.size, sha256: saved.sha256, completedAt: new Date().toISOString(), source: 'extension' } } };
  await writeJSON(root, INDEX_PATH, next);
  index.entries = next.entries;
}
