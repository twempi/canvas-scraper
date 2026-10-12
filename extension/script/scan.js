import { ORIGIN, ArchiveError, checkAbort, friendly } from './canvas.js';
import { bodyHTML, cleanURL } from './html.js';
import { moduleFolder, fileName, uniqueDocumentNames, component } from './names.js';
import { hashText } from './hash.js';
export const bodyKey = (courseId, assetKey) => `body:${ORIGIN}:${courseId}:${assetKey}`;
export const scanKey = courseId => `scan:${ORIGIN}:${courseId}`;
export function restricted(meta) {
  return !!(meta.locked_for_user || meta.hidden_for_user || meta.hidden || meta.locked || meta.published === false || meta.content_details?.locked_for_user);
}
export function fileVersion(meta) {
  const updated = meta.updated_at || meta.modified_at || null;
  return { updated_at: updated, size: Number.isSafeInteger(meta.size) && meta.size >= 0 ? meta.size : null };
}
export function coursePrevious(course, now = Date.now()) {
  const end = course.end_at || course.term?.end_at;
  return !!course.previousEnrollment || course.workflow_state === 'completed' || (course.enrollments?.length && course.enrollments.every(e => ['completed', 'inactive'].includes(e.enrollment_state))) || !!(end && Date.parse(end) < now);
}
export async function listCourses(client, signal) {
  const courses = new Map();
  client.courseListWarnings = [];
  for (const state of [null, 'completed']) {
    try {
      const query = '/api/v1/courses?per_page=100&enrollment_type=student&include[]=term' + (state ? '&enrollment_state=completed' : '');
      for await (const c of client.all(query, signal)) {
        if (!c.id || !c.name || courses.has(String(c.id))) continue;
        courses.set(String(c.id), { id: String(c.id), name: c.name, code: c.course_code || c.code || '', term: c.term ? { name: c.term.name || '', end_at: c.term.end_at || null } : null, end_at: c.end_at || null, previousEnrollment: state === 'completed', workflow_state: c.workflow_state, enrollments: (c.enrollments || []).map(e => ({ enrollment_state: e.enrollment_state })) });
      }
    } catch (error) {
      if (!state || error.code === 'auth' || error.name === 'AbortError') throw error;
      client.courseListWarnings.push('Previous courses could not be enumerated: ' + friendly(error));
    }
  }
  return [...courses.values()].sort((a,b) => a.name.localeCompare(b.name));
}
export async function scanCourse(client, course, store, { signal, progress = () => {}, maxDepth = 5, maxAssets = 20000 } = {}) {
  if (!client.verified || client.origin !== ORIGIN) throw new ArchiveError('Connect to the authenticated Canvas API before scanning.', 'auth');
  const id = String(course.id), prefix = `/api/v1/courses/${id}`;
  const catalog = { origin: ORIGIN, course, modules: [], assets: {}, aliases: {}, placements: [], external: [], coverage: [], scannedAt: new Date().toISOString() };
  const rawCache = new Map(), folders = new Map(), externals = new Set();
  let assetCount = 0;
  function coverage(section, error, context = null) {
    if (error.code === 'auth' || error.name === 'AbortError') throw error;
    catalog.coverage.push({ section, context, reason: friendly(error) });
  }
  function external(title, url, context, reason) {
    const clean = cleanURL(url), key = `${context}:${clean}:${reason}`;
    if (externals.has(key)) return;
    externals.add(key); catalog.external.push({ title: title || 'Resource', url: clean, context, reason });
  }
  async function assetFor(ref, hint, label) {
    const rawKey = `${ref.kind}:${ref.id}`;
    if (rawCache.has(rawKey)) return rawCache.get(rawKey);
    if (assetCount >= maxAssets) throw new ArchiveError('Scan reached the 20,000-item course limit. Narrow the course or retry later.', 'limit');
    const endpoint = { File: 'files', Page: 'pages', Assignment: 'assignments', Discussion: 'discussion_topics', Quiz: 'quizzes' }[ref.kind];
    let meta, issue;
    try { meta = hint || await client.one(`${prefix}/${endpoint}/${encodeURIComponent(ref.id)}`, signal); }
    catch (error) {
      if (error.code === 'auth' || error.name === 'AbortError') throw error;
      issue = friendly(error); meta = {};
    }
    // Page IDs deduplicate aliases; filenames retain Canvas's page slug, as in Python.
    const canonicalId = ref.kind === 'Page' ? meta.page_id || ref.id : meta.id || ref.id;
    const key = `${ref.kind}:${canonicalId}`;
    catalog.aliases[rawKey] = key;
    if (catalog.assets[key]) { rawCache.set(rawKey, catalog.assets[key]); return catalog.assets[key]; }
    const title = meta.filename || meta.display_name || meta.title || meta.name || label || `${ref.kind} ${ref.id}`;
    const asset = {
      key, kind: ref.kind, id: String(ref.kind === 'Page' ? meta.url || ref.id : canonicalId), numericId: meta.page_id || meta.id || null,
      title, filename: meta.filename || meta.display_name || null,
      size: ref.kind === 'File' && Number.isSafeInteger(meta.size) ? meta.size : null,
      contentType: meta['content-type'] || meta.content_type || null, folderId: meta.folder_id == null ? null : String(meta.folder_id),
      remote: ref.kind === 'File' ? fileVersion(meta) : null, contexts: [], links: [],
      sourceURL: cleanURL(meta.html_url || (ref.kind === 'File' ? `${ORIGIN}/courses/${id}/files/${ref.id}` : `${ORIGIN}/courses/${id}/${endpoint}/${encodeURIComponent(meta.url || ref.id)}`)),
      unavailable: issue || (restricted(meta) ? 'Locked, hidden, or unpublished for this account.' : null)
    };
    if (ref.kind === 'File' && !asset.unavailable && !meta.url) asset.unavailable = 'Canvas did not provide a download URL.';
    catalog.assets[key] = asset; rawCache.set(rawKey, asset); assetCount++;
    if (ref.kind !== 'File' && !asset.unavailable) {
      const body = ref.kind === 'Page' ? meta.body : ref.kind === 'Discussion' ? meta.message : meta.description;
      const parsed = bodyHTML(body || '', { courseId: id });
      asset.links = parsed.links;
      asset.remote = { bodyHash: hashText(JSON.stringify([asset.title, parsed.html])), updated_at: meta.updated_at || null };
      await store.set(bodyKey(id, key), parsed.html);
    }
    progress({ courseId: id, discovered: assetCount, title });
    return asset;
  }
  async function walk(roots, context) {
    const visited = new Map(), queue = roots.map(root => ({ ...root, depth: 0 }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      checkAbort(signal);
      const item = queue[cursor];
      if (item.depth > maxDepth) { external(item.label || item.ref.key, item.url, context, 'Linked-content depth limit reached (5).'); continue; }
      const rawKey = `${item.ref.kind}:${item.ref.id}`;
      const previous = visited.get(rawKey);
      if (previous != null && previous <= item.depth) continue;
      visited.set(rawKey, item.depth);
      const asset = await assetFor(item.ref, item.blocked && item.ref.kind !== 'File' ? { id: item.ref.id, title: item.label, locked_for_user: true } : item.hint, item.label);
      if (!asset.contexts.includes(context)) asset.contexts.push(context);
      if (item.blocked) {
        // Keep the restriction on this module association, even if another is accessible.
        (asset.blockedContexts ||= []).push(context);
        continue;
      }
      if (asset.unavailable) continue;
      for (const link of asset.links) {
        if (link.ref) queue.push({ ref: link.ref, depth: item.depth + 1, url: link.url });
        else external(asset.title, link.url, context, new URL(link.url).origin === ORIGIN ? 'Unsupported or out-of-scope Canvas link' : 'External resource; open online');
      }
      if (queue.length > maxAssets * 10) throw new ArchiveError('Linked-content queue limit reached.', 'limit');
    }
  }
  try {
    const seen = new Set();
    for await (const module of client.all(`${prefix}/modules?per_page=100`, signal)) {
      if (seen.has(String(module.id))) continue;
      seen.add(String(module.id));
      const m = { id: String(module.id), name: module.name || `Module ${module.id}`, position: module.position || 0, unavailable: restricted(module) ? 'Module is locked, hidden, or unpublished.' : null };
      catalog.modules.push(m);
      if (m.unavailable) { catalog.coverage.push({ section: 'Modules', context: `module:${m.id}`, reason: m.unavailable }); continue; }
      const roots = [], context = `module:${m.id}`;
      try {
        for await (const item of client.all(`${prefix}/modules/${m.id}/items?per_page=100&include[]=content_details`, signal)) {
          if (item.type === 'SubHeader') continue;
          if (['ExternalUrl','ExternalTool'].includes(item.type)) { external(item.title, item.external_url || item.html_url, context, item.type); continue; }
          const contentId = item.type === 'Page' ? item.page_url : item.content_id;
          if (!['File','Page','Assignment','Discussion','Quiz'].includes(item.type) || contentId == null) {
            external(item.title, item.html_url, context, 'Unsupported module item; open online'); continue;
          }
          roots.push({ ref: { kind: item.type, id: String(contentId) }, label: item.title, blocked: restricted(item) });
        }
        await walk(roots, context);
      } catch (error) { coverage('Module items', error, context); }
    }
  } catch (error) { coverage('Modules', error); }
  try {
    for await (const assignment of client.all(`${prefix}/assignments?per_page=100`, signal)) {
      await walk([{ ref: { kind: 'Assignment', id: String(assignment.id) }, hint: assignment }], 'assignments');
    }
  } catch (error) { coverage('Assignments', error); }
  try {
    for await (const file of client.all(`${prefix}/files?per_page=100`, signal)) {
      const asset = await assetFor({ kind: 'File', id: String(file.id) }, file);
      if (!asset.contexts.includes('files')) asset.contexts.push('files');
    }
  } catch (error) { coverage('Course Files (modules still scanned)', error); }
  try {
    for await (const folder of client.all(`${prefix}/folders?per_page=100`, signal)) {
      folders.set(String(folder.id), { id: String(folder.id), name: folder.name || folder.id, parentId: folder.parent_folder_id == null ? null : String(folder.parent_folder_id), restricted: restricted(folder) });
    }
  } catch (error) { coverage('Course file subfolders (supplemental files use a flat layout)', error); }
  function folderPath(asset) {
    const parts = [], seen = new Set(); let folder = folders.get(asset.folderId);
    while (folder?.parentId && parts.length < 20) {
      if (seen.has(folder.id)) { catalog.coverage.push({ section: 'Folders', reason: 'Folder cycle; supplemental path truncated.' }); break; }
      seen.add(folder.id);
      if (folder.restricted) asset.unavailable ||= 'The containing Canvas file folder is restricted.';
      parts.unshift(`${folder.id}__${component(folder.name)}`);
      folder = folders.get(folder.parentId);
    }
    if (folder?.restricted) asset.unavailable ||= 'The containing Canvas file folder is restricted.';
    return parts;
  }
  const docNames = uniqueDocumentNames(Object.values(catalog.assets).filter(a => a.kind !== 'File'), id);
  for (const asset of Object.values(catalog.assets)) {
    const subfolders = asset.kind === 'File' ? folderPath(asset) : [];
    const modules = asset.contexts.filter(c => c.startsWith('module:'));
    const contexts = modules.length ? modules : [asset.contexts.includes('assignments') ? 'assignments' : 'files'];
    const name = asset.kind === 'File' ? fileName(asset) : docNames.get(asset.key);
    for (const context of contexts) {
      const module = catalog.modules.find(m => `module:${m.id}` === context);
      const parent = module ? [moduleFolder(module)] : [context === 'assignments' ? '_Assignments' : '_Other-course-files', ...subfolders];
      catalog.placements.push({ key: `${asset.key}@${context}`, assetKey: asset.key, context, path: [...parent, name].join('/'), unavailable: asset.blockedContexts?.includes(context) ? 'This module item is locked, hidden, or unpublished.' : null });
    }
    for (const link of asset.links) if (link.ref) link.ref.key = catalog.aliases[link.ref.key] || link.ref.key;
  }
  catalog.modules.sort((a,b) => a.position - b.position);
  await store.set(scanKey(id), catalog);
  return catalog;
}
