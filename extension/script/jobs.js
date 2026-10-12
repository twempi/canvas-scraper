import { ArchiveError, ORIGIN, checkAbort, friendly } from './canvas.js';
import { bodyKey, restricted, fileVersion } from './scan.js';
import { bodyHTML, offlineDocument, replacementsFor } from './html.js';
import { hashText, SHA256 } from './hash.js';
import { fileName } from './names.js';
import { loadIndex, checkPlacement, diskFile, saveEntry, writeStream, writeJSON, sameVersion, classify } from './filesystem.js';
import { fileSource, openFileStream } from './download.js';
export const runKey = courseId => `latest-run:${ORIGIN}:${courseId}`;
export const preserveState = state => ['Existing—unverified','Locally modified/conflict'].includes(state);
const eligible = row => !['Unavailable'].includes(row.state) && (!preserveState(row.state) || row.policy === 'replace');
async function refreshDocument(client, catalog, asset, store, signal) {
  const endpoint = { Page: 'pages', Assignment: 'assignments', Discussion: 'discussion_topics', Quiz: 'quizzes' }[asset.kind];
  const meta = await client.one(`/api/v1/courses/${catalog.course.id}/${endpoint}/${encodeURIComponent(asset.id)}`, signal);
  const title = meta.title || meta.name || asset.title;
  if (restricted(meta)) throw new ArchiveError('This document is locked, hidden, or unpublished for your account.', 'restricted');
  if (title !== asset.title) throw new ArchiveError('Document title changed since scanning. Rescan to resolve its new filename.');
  const parsed = bodyHTML(asset.kind === 'Page' ? meta.body : asset.kind === 'Discussion' ? meta.message : meta.description, { courseId: catalog.course.id });
  asset.links = parsed.links;
  for (const link of asset.links) if (link.ref) link.ref.key = catalog.aliases[link.ref.key] || link.ref.key;
  asset.remote = { bodyHash: hashText(JSON.stringify([title, parsed.html])), updated_at: meta.updated_at || null };
  await store.set(bodyKey(catalog.course.id, asset.key), parsed.html);
}
export async function documentPayload(catalog, placement, selected, available, store) {
  const asset = catalog.assets[placement.assetKey], body = await store.get(bodyKey(catalog.course.id, asset.key));
  if (typeof body !== 'string') throw new ArchiveError('Saved scan body is missing. Rescan the course before downloading.');
  const { replacements, dependencies } = replacementsFor(placement, catalog, selected, available);
  const html = offlineDocument(asset.title, body, catalog.course.id, asset.sourceURL, replacements);
  const blob = new Blob([html], { type: 'text/html' });
  return { blob, remote: { bodyHash: hashText(html), updated_at: asset.remote?.updated_at || null }, dependencies };
}
export async function prepareReview(client, catalog, root, selected, store, { signal, progress = () => {}, policies = new Map() } = {}) {
  if (!client.verified) throw new ArchiveError('Connect to Canvas before reviewing current remote versions.', 'auth');
  const index = await loadIndex(root, catalog.course.id), sources = new Map(), rows = [];
  const refreshed = new Set();
  for (const placement of catalog.placements.filter(p => selected.has(p.key))) {
    checkAbort(signal);
    const asset = catalog.assets[placement.assetKey]; let state;
    try {
      if (!asset.unavailable && !placement.unavailable && !refreshed.has(asset.key)) {
        if (asset.kind === 'File') {
          const source = await fileSource(client, catalog.course.id, asset, signal);
          if (fileName({ ...asset, filename: source.filename }) !== placement.path.split('/').at(-1)) throw new ArchiveError('Canvas filename changed since scanning. Rescan to resolve its new destination.');
          sources.set(asset.key, source); asset.remote = source.remote; asset.size = source.remote.size;
        } else await refreshDocument(client, catalog, asset, store, signal);
        refreshed.add(asset.key);
      }
      state = await checkPlacement(root, placement, asset, index, asset.remote, signal);
    } catch (error) {
      if (error.code === 'auth' || error.name === 'AbortError') throw error;
      state = { state: 'Unavailable', reason: friendly(error), disk: null };
    }
    const row = { ...placement, ...state, policy: policies.get(placement.key) || 'preserve', remote: asset.remote, dependencies: [] };
    rows.push(row); progress({ checked: rows.length, title: asset.title });
  }
  const available = new Set(rows.filter(eligible).map(row => row.key));
  for (const row of rows.filter(r => catalog.assets[r.assetKey].kind !== 'File' && r.state !== 'Unavailable')) {
    const payload = await documentPayload(catalog, row, selected, available, store);
    row.remote = payload.remote; row.dependencies = payload.dependencies;
    Object.assign(row, classify(row.disk, index.entries[row.path]?.assetKey === row.assetKey ? index.entries[row.path] : null, payload.remote));
  }
  return { catalog, root, selected: new Set(selected), index, sources, rows };
}
export function summary(rows) {
  const result = { new: 0, unchanged: 0, updates: 0, conflicts: 0, unavailable: 0, bytes: 0, unknownSizes: 0 };
  for (const row of rows) {
    if (row.state === 'Missing') result.new++;
    else if (row.state === 'Unchanged') result.unchanged++;
    else if (row.state === 'Remote update available') result.updates++;
    else if (preserveState(row.state)) result.conflicts++;
    else result.unavailable++;
  }
  return result;
}
export async function verifyExisting(client, review, row, store, signal) {
  if (!row.disk) throw new ArchiveError('There is no existing file to verify.');
  const { root, catalog, index, selected } = review, asset = catalog.assets[row.assetKey];
  const current = await diskFile(root, row.path, signal);
  if (!current || current.sha256 !== row.disk.sha256) throw new ArchiveError('Local file changed after review. Recheck first.', 'conflict');
  let stream, expectedSize;
  if (asset.kind === 'File') {
    const source = await fileSource(client, catalog.course.id, asset, signal);
    if (JSON.stringify(source.remote) !== JSON.stringify(row.remote)) throw new ArchiveError('Remote revision changed after review. Recheck first.');
    stream = await openFileStream(client, source, signal); expectedSize = source.remote.size;
  } else {
    const payload = await documentPayload(catalog, row, selected, new Set(review.rows.filter(eligible).map(r => r.key)), store);
    stream = payload.blob.stream(); expectedSize = payload.blob.size;
  }
  const reader = stream.getReader(), hash = new SHA256(); let size = 0;
  try {
    while (true) {
      checkAbort(signal); const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value); size += chunk.value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  checkAbort(signal);
  if (expectedSize != null && size !== expectedSize) throw new ArchiveError('Remote size validation failed during verification.');
  const after = await diskFile(root, row.path, signal);
  if (!after || after.sha256 !== current.sha256) throw new ArchiveError('Local contents changed while verifying. Recheck first.', 'conflict');
  if (hash.hex() !== after.sha256) {
    row.state = 'Locally modified/conflict'; row.reason = 'Verified comparison: local and current remote contents differ. Local file preserved.';
    return false;
  }
  await saveEntry(root, index, row, asset, row.remote, { sha256: after.sha256, size: after.size });
  row.state = 'Unchanged'; row.reason = 'Explicit verification: local SHA-256 matches current remote content.';
  return true;
}
export async function runJob(client, review, store, { signal, progress = () => {} } = {}) {
  const { catalog, root, index, selected } = review, courseId = catalog.course.id;
  const report = { version: 1, origin: ORIGIN, course: catalog.course, id: `${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`, startedAt: new Date().toISOString(), status: 'running', counts: { downloaded: 0, skipped: 0, failed: 0, cancelled: 0 }, coverage: catalog.coverage, externalLinks: catalog.external, items: [] };
  const reportPath = `.canvas-archive/reports/${report.id}.json`;
  // Recovery metadata contains only selected IDs and relative paths, never signed URLs.
  const journal = { report, selected: [...selected], reportPath };
  await store.set(runKey(courseId), journal);
  const available = new Set(), pending = [];
  let journalWrites = Promise.resolve();
  const publish = () => {
    const snapshot = structuredClone(journal);
    journalWrites = journalWrites.then(() => store.set(runKey(courseId), snapshot));
    progress({ report, total: review.rows.length });
  };
  function record(row, outcome, reason, extras = {}) {
    const asset = catalog.assets[row.assetKey], module = catalog.modules.find(m => row.context === `module:${m.id}`);
    report.items.push({ title: asset.title, filename: row.path.split('/').at(-1), courseId, courseName: catalog.course.name, module: module ? { id: module.id, name: module.name, position: module.position } : null, context: row.context, canvasType: asset.kind, canvasId: asset.id, assetKey: asset.key, selectionKey: row.key, relativePath: row.path, outcome, reason, ...extras });
    report.counts[outcome]++; publish();
  }
  for (const row of review.rows) {
    if (row.state === 'Unavailable') record(row, 'failed', row.reason);
    else if (preserveState(row.state) && row.policy !== 'replace') record(row, 'skipped', row.reason + ' Preserve was selected.');
    else pending.push(row);
  }
  // Verify unchanged items again immediately before accepting them as local links.
  for (const row of pending.filter(r => r.state === 'Unchanged' && catalog.assets[r.assetKey].kind === 'File')) {
    try {
      checkAbort(signal);
      const checked = await diskFile(root, row.path, signal);
      if (!checked || checked.sha256 !== row.disk?.sha256) throw new ArchiveError('Local file changed after review. Recheck before retrying.', 'conflict');
      const source = await fileSource(client, courseId, catalog.assets[row.assetKey], signal);
      if (JSON.stringify(source.remote) !== JSON.stringify(row.remote)) throw new ArchiveError('Canvas file changed after review. Recheck before retrying.');
      available.add(row.key); record(row, 'skipped', row.reason);
    } catch (error) { record(row, signal?.aborted ? 'cancelled' : 'failed', friendly(error)); }
  }
  const files = pending.filter(r => r.state !== 'Unchanged' && catalog.assets[r.assetKey].kind === 'File');
  let cursor = 0;
  async function fileWorker() {
    while (cursor < files.length) {
      const row = files[cursor++], asset = catalog.assets[row.assetKey];
      if (signal?.aborted) { record(row, 'cancelled', 'Cancelled before downloading.'); continue; }
      try {
        const source = await fileSource(client, courseId, asset, signal);
        if (JSON.stringify(source.remote) !== JSON.stringify(row.remote)) throw new ArchiveError('Canvas file changed after review. Recheck before retrying.');
        if (fileName({ ...asset, filename: source.filename }) !== row.path.split('/').at(-1)) throw new ArchiveError('Canvas filename changed after review. Rescan before retrying.');
        const stream = await openFileStream(client, source, signal);
        let saved;
        try { saved = await writeStream(root, row.path, stream, { signal, expectedSize: source.remote.size, expectedDisk: row.disk, progress: bytes => progress({ report, title: asset.title, bytes, total: review.rows.length }) }); }
        finally { if (!stream.locked) await stream.cancel().catch(() => {}); }
        // Serialize index commits when two file writers finish together.
        await commit(row, asset, source.remote, saved);
        available.add(row.key); record(row, 'downloaded', 'Original bytes saved and local SHA-256 verified.', { bytes: saved.size, sha256: saved.sha256 });
      } catch (error) { if (error.code === 'auth') client.verified = false; record(row, signal?.aborted ? 'cancelled' : 'failed', friendly(error)); }
    }
  }
  let indexWrites = Promise.resolve();
  function commit(row, asset, remote, saved) {
    const operation = indexWrites.catch(() => {}).then(() => saveEntry(root, index, row, asset, remote, saved));
    indexWrites = operation; return operation;
  }
  await Promise.all([fileWorker(), fileWorker()]);
  const documents = pending.filter(r => catalog.assets[r.assetKey].kind !== 'File');
  // Reserve selected document destinations to preserve cyclic page links. If one fails,
  // remove it and refresh any already-written dependents below with online links.
  documents.filter(r => !signal?.aborted).forEach(r => available.add(r.key));
  const savedDocuments = [];
  for (const row of documents) {
    const asset = catalog.assets[row.assetKey];
    try {
      checkAbort(signal);
      // Detect instructions changed since review without extending the selected set.
      const previous = asset.remote?.bodyHash;
      await refreshDocument(client, catalog, asset, store, signal);
      if (asset.remote.bodyHash !== previous) throw new ArchiveError('Canvas instructions changed after review. Recheck before retrying.');
      const payload = await documentPayload(catalog, row, selected, available, store);
      const checked = await diskFile(root, row.path, signal);
      if (row.disk ? !checked || checked.sha256 !== row.disk.sha256 : !!checked) throw new ArchiveError('Local document changed after review. Recheck before retrying.', 'conflict');
      if (checked && sameVersion(index.entries[row.path]?.remote, payload.remote) && checked.sha256 === index.entries[row.path]?.sha256) {
        savedDocuments.push({ row, saved: { size: checked.size, sha256: checked.sha256 }, remote: payload.remote });
        record(row, 'skipped', 'Remote instructions, selected links, and local SHA-256 are unchanged.');
        continue;
      }
      const saved = await writeStream(root, row.path, payload.blob.stream(), { signal, expectedSize: payload.blob.size, expectedDisk: row.disk });
      await commit(row, asset, payload.remote, saved);
      savedDocuments.push({ row, saved, remote: payload.remote });
      record(row, 'downloaded', 'Readable offline HTML saved; deselected or failed attachments retain online links.', { bytes: saved.size, sha256: saved.sha256, onlineDependencies: payload.dependencies });
    } catch (error) { if (error.code === 'auth') client.verified = false; available.delete(row.key); record(row, signal?.aborted ? 'cancelled' : 'failed', friendly(error)); }
  }
  // Repair links to selected documents that failed later in a cycle, only in our
  // freshly-written, checksum-confirmed HTML. Never rewrite unrelated/local edits.
  if (!signal?.aborted) for (const { row, saved, remote } of savedDocuments) {
    try {
      const payload = await documentPayload(catalog, row, selected, available, store);
      if (payload.remote.bodyHash === remote.bodyHash) continue;
      const updated = await writeStream(root, row.path, payload.blob.stream(), { signal, expectedSize: payload.blob.size, expectedDisk: { sha256: saved.sha256, size: saved.size } });
      await commit(row, catalog.assets[row.assetKey], payload.remote, updated);
      const item = report.items.find(i => i.selectionKey === row.key);
      if (item.outcome === 'skipped') { item.outcome = 'downloaded'; report.counts.skipped--; report.counts.downloaded++; item.reason = 'Offline HTML refreshed to keep failed dependencies online.'; }
      item.onlineDependencies = payload.dependencies; item.sha256 = updated.sha256; item.bytes = updated.size;
    } catch (error) {
      report.coverage.push({ section: 'Offline link repair', context: row.context, reason: friendly(error) });
    }
  }
  if (signal?.aborted && savedDocuments.length) report.coverage.push({ section: 'Interrupted document links', reason: 'Cancellation can leave links to later documents that were not saved. Retry the last selected set to reconcile offline links.' });
  report.status = signal?.aborted ? 'cancelled' : report.counts.failed || report.coverage.length ? 'partial' : 'complete';
  report.finishedAt = new Date().toISOString();
  publish(); await journalWrites;
  try { await writeJSON(root, reportPath, report); }
  catch (error) { journal.reportSaveError = friendly(error); await store.set(runKey(courseId), journal); }
  return journal;
}
