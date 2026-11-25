import { CanvasClient, ORIGIN, ArchiveError, friendly, checkAbort } from './canvas.js';
import { Store, destinationKey, permission, renew } from './store.js';
import { listCourses, scanCourse, scanKey, coursePrevious } from './scan.js';
import { Selection } from './selection.js';
import { escapeHTML as e } from './html.js';
import { prepareReview, summary, runJob, runKey, verifyExisting, preserveState } from './jobs.js';
import { requiredOrigins, grantOrigins, downloadURL } from './download.js';
import { loadIndex, pythonEntries, writeJSON, INDEX_PATH, diskFile } from './filesystem.js';
import { convertible } from './names.js';
export const formatBytes = bytes => bytes == null ? 'Size unknown' : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
// Only files are downloaded. Pages and assignment/discussion/quiz descriptions stay on Canvas;
// they are still scanned so the files they link to (e.g. a homework PDF) are found and placed beside them.
const attachments = new WeakMap();
// File asset key → titles of the assignments that link to it, and the contexts those assignments live in.
export function assignmentFiles(catalog) {
  if (!catalog) return new Map();
  if (attachments.has(catalog)) return attachments.get(catalog);
  const map = new Map();
  for (const asset of Object.values(catalog.assets)) {
    if (asset.kind !== 'Assignment') continue;
    for (const link of asset.links || []) {
      if (link.ref?.kind !== 'File' || !catalog.assets[link.ref.key]) continue;
      const entry = map.get(link.ref.key) || { titles: [], contexts: new Set() };
      if (!entry.titles.includes(asset.title)) entry.titles.push(asset.title);
      asset.contexts.forEach(context => entry.contexts.add(context));
      map.set(link.ref.key, entry);
    }
  }
  attachments.set(catalog, map);
  return map;
}
export function scopeKeys(catalog, scope) {
  const attached = assignmentFiles(catalog);
  return (catalog?.placements || []).filter(p => catalog.assets[p.assetKey]?.kind === 'File' && (scope === 'course' || scope === 'modules' && p.context.startsWith('module:') || scope === 'assignments' && (p.context === 'assignments' || !!attached.get(p.assetKey)?.contexts.has(p.context)) || scope === 'files' && p.context === 'files' || p.context === scope)).map(p => p.key);
}
// Placements that can actually be downloaded; locked/hidden items are never auto-selected.
export function selectableKeys(catalog, scope = 'course') {
  if (!catalog) return [];
  const keys = new Set(scopeKeys(catalog, scope));
  return catalog.placements.filter(p => keys.has(p.key) && !p.unavailable && !catalog.assets[p.assetKey].unavailable).map(p => p.key);
}
export const syncKey = courseId => `sync:${ORIGIN}:${courseId}`;
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const needsTransfer = row => row.state === 'Missing' || row.state === 'Remote update available' || preserveState(row.state) && row.policy === 'replace';
const OPEN_CANVAS = `<a class="button small" href="${ORIGIN}/" target="_blank" rel="noreferrer">Open Canvas ↗</a>`;
const STATE_TONE = { Unchanged: 'ok', Missing: 'info', 'Remote update available': 'info', 'Existing—unverified': 'warn', 'Locally modified/conflict': 'warn', Unavailable: 'error' };
const STATE_LABEL = { Unchanged: 'Up to date', Missing: 'Not downloaded', 'Remote update available': 'Update available', 'Existing—unverified': 'Kept (unverified)', 'Locally modified/conflict': 'Kept (edited)', Unavailable: 'Unavailable' };

export async function mount({ client = new CanvasClient(), store = new Store(), picker = options => showDirectoryPicker(options), openPicker = options => showOpenFilePicker(options), chromeAPI = globalThis.chrome, now = () => Date.now() } = {}) {
  const $ = selector => document.querySelector(selector);
  const stored = async (key, fallback) => (await store.get(key)) ?? fallback;
  const state = {
    courses: await stored('courses', []), catalogs: new Map(), destinations: new Map(), selections: new Map(), checks: new Map(), runs: new Map(), sync: new Map(),
    expanded: new Set(), limits: new Map(), policies: new Map(), reviews: [], busy: false, syncing: null,
    view: { name: 'home' }, mode: await stored('ui:mode', 'basic'), interval: Number(await stored('ui:interval', 30)), lastCycle: await stored('sync:last-cycle', null),
    activity: await stored('activity', []), connection: client.verified ? 'ok' : 'idle'
  };
  let controller, timer, reconnectTimer;
  const advanced = () => state.mode === 'advanced';
  const course = id => state.courses.find(c => c.id === id);
  const name = c => c?.code || c?.name || 'this course';
  const selection = id => { if (!state.selections.has(id)) state.selections.set(id, new Selection()); return state.selections.get(id); };
  const record = id => { if (!state.sync.has(id)) state.sync.set(id, { auto: false, excluded: [], last: null, recent: [] }); return state.sync.get(id); };
  const saveRecord = id => store.set(syncKey(id), record(id));
  const autoCourses = () => state.courses.filter(c => record(c.id).auto && state.destinations.has(c.id)).map(c => c.id);
  const needsAccess = () => [...state.destinations].filter(([id, d]) => !d.granted && course(id)).map(([id]) => id);

  // ---- Status card, activity log, connection pill ----
  function setStatus(tone, title, detail = '', { progress = null, action = '' } = {}) {
    $('#status-card').dataset.tone = tone;
    $('#status-title').textContent = title; $('#status-detail').textContent = detail;
    const bar = $('#status-progress');
    bar.hidden = progress == null;
    if (progress === true) bar.removeAttribute('value');
    else if (progress) { bar.max = progress.max || 1; bar.value = Math.min(progress.value, progress.max || 1); }
    $('#status-action').innerHTML = action;
    applyBusy();
  }
  function log(tone, text) {
    state.activity = [{ at: new Date(now()).toISOString(), tone, text }, ...state.activity].slice(0, 100);
    store.set('activity', state.activity).catch(() => {});
    if (state.view.name === 'tools') renderTools();
  }
  function setConnection(value) {
    state.connection = value;
    $('#connection').textContent = { idle: 'Not connected', connecting: 'Connecting…', ok: 'Connected to Canvas', auth: 'Sign in needed', error: 'Connection problem' }[value];
    $('#connect').dataset.state = value;
  }
  function restingStatus() {
    if (state.connection === 'auth') return setStatus('warn', 'Sign in to Canvas', 'Open Canvas in this browser and finish the Cal Poly login. Syncing resumes automatically.', { action: OPEN_CANVAS });
    if (!client.verified) return setStatus('info', 'Not connected', 'Open Canvas and sign in, then click “Not connected” above to retry.', { action: OPEN_CANVAS });
    const pending = needsAccess();
    if (pending.length) return setStatus('warn', `${plural(pending.length, 'course')} need${pending.length === 1 ? 's' : ''} folder access`, 'The browser asks again after a restart. Allow access to keep syncing.', { action: '<button class="small" data-action="renew-all">Allow access</button>' });
    const auto = autoCourses().length;
    setStatus('ok', 'Connected to Canvas', `${plural(state.courses.length, 'course')} · ${auto ? `auto-sync on for ${auto}` : 'no courses syncing yet'}`);
  }
  function applyBusy() {
    document.querySelectorAll('button[data-action]:not([data-nav]), #start, #grant-host, #connect, select[data-policy], button[data-verify], input[data-auto], #sync-interval').forEach(element => {
      element.disabled = state.busy || element.dataset.unavailable === 'true';
    });
  }
  function busy(value) {
    state.busy = value; document.body.classList.toggle('is-busy', value);
    $('#cancel').hidden = !value; applyBusy();
  }
  function failure(error) {
    if (error?.name === 'AbortError') { setStatus('info', 'Cancelled', 'Anything that finished downloading was kept. Sync again to pick up the rest.'); log('info', 'Cancelled'); return; }
    if (error?.code === 'auth') {
      client.verified = false; setConnection('auth');
      setStatus('warn', 'Sign in to Canvas', 'Open Canvas in this browser and finish the Cal Poly login. Syncing resumes automatically.', { action: OPEN_CANVAS });
      log('warn', 'Canvas sign-in needed'); return;
    }
    setStatus('error', 'Something went wrong', friendly(error)); log('error', friendly(error));
  }
  async function perform(label, callback, detail = '') {
    if (state.busy) return false;
    controller = new AbortController(); busy(true); setStatus('busy', label, detail, { progress: true });
    try { await callback(controller.signal); return true; }
    catch (error) { failure(error); return false; }
    finally {
      busy(false); state.syncing = null;
      if ($('#status-card').dataset.tone === 'busy') restingStatus();
      render();
    }
  }
  async function withLock(callback) {
    const locks = globalThis.navigator?.locks;
    if (!locks) return callback();
    return locks.request('canvas-local-archive-job', { ifAvailable: true }, async lock => {
      if (!lock) throw new ArchiveError('Another archive panel is already syncing. Wait for it to finish, or close it.');
      return callback();
    });
  }

  // ---- Persistence ----
  async function persistSelection(id) { await store.set(`selection:${ORIGIN}:${id}`, [...selection(id).keys]); }
  function applySelection(id) {
    const catalog = state.catalogs.get(id), rec = record(id), s = selection(id);
    if (!catalog) return;
    if (rec.auto) { const excluded = new Set(rec.excluded); s.keys = new Set(selectableKeys(catalog).filter(key => !excluded.has(key))); }
    else s.reconcile(new Set(scopeKeys(catalog, 'course')));
  }
  function updateExcluded(id) {
    const rec = record(id);
    if (!rec.auto) return;
    const s = selection(id);
    rec.excluded = selectableKeys(state.catalogs.get(id)).filter(key => !s.keys.has(key));
    saveRecord(id).catch(() => {});
  }
  async function hydrate() {
    for (const c of state.courses) {
      const [catalog, destination, run, rec, keys] = await Promise.all([store.get(scanKey(c.id)), store.get(destinationKey(ORIGIN, c.id)), store.get(runKey(c.id)), store.get(syncKey(c.id)), store.get(`selection:${ORIGIN}:${c.id}`)]);
      if (catalog) state.catalogs.set(c.id, catalog);
      if (destination) { destination.granted = await permission(destination.handle).catch(() => false); state.destinations.set(c.id, destination); }
      if (run) state.runs.set(c.id, run);
      if (rec) state.sync.set(c.id, { auto: !!rec.auto, excluded: rec.excluded || [], last: rec.last || null, recent: rec.recent || [] });
      state.selections.set(c.id, new Selection(keys || [])); applySelection(c.id);
    }
  }

  // ---- Connecting ----
  async function connect(signal) {
    setConnection('connecting');
    try { await client.connect(signal); }
    catch (error) { setConnection(error.code === 'auth' ? 'auth' : 'error'); throw error; }
    state.courses = await listCourses(client, signal); await store.set('courses', state.courses); await hydrate(); setConnection('ok');
    const warnings = (client.courseListWarnings || []).join(' ');
    setStatus('ok', 'Connected to Canvas', `${plural(state.courses.length, 'course')} found.${warnings ? ` ${warnings}` : ''}`);
    log('ok', `Connected (${client.transportName})`);
  }

  // ---- Sync engine ----
  // One sync = rescan → include everything (minus exclusions) → compare with the folder → download
  // only what is missing or changed. Local edits/unverified files are always preserved.
  function reviewResult(review) {
    const rows = review.rows, unavailable = rows.filter(r => r.state === 'Unavailable');
    return {
      status: unavailable.length ? 'partial' : 'ok', newItems: [],
      counts: { downloaded: 0, upToDate: rows.filter(r => r.state === 'Unchanged').length, kept: rows.filter(r => preserveState(r.state) && r.policy !== 'replace').length, failed: unavailable.length },
      failures: unavailable.slice(0, 20).map(r => ({ title: review.catalog.assets[r.assetKey].title, reason: r.reason }))
    };
  }
  function runResult(journal, review) {
    const items = journal.report.items, kept = review.rows.filter(r => preserveState(r.state) && r.policy !== 'replace').length;
    const failed = items.filter(i => i.outcome === 'failed' || i.outcome === 'cancelled'), downloaded = items.filter(i => i.outcome === 'downloaded');
    const updated = new Set(review.rows.filter(r => r.state === 'Remote update available').map(r => r.key));
    return {
      status: journal.report.status === 'cancelled' ? 'cancelled' : failed.length ? 'partial' : 'ok',
      counts: { downloaded: downloaded.length, upToDate: Math.max(0, items.filter(i => i.outcome === 'skipped').length - kept), kept, failed: failed.length },
      newItems: downloaded.slice(0, 25).map(i => ({ title: i.title, path: i.relativePath, where: i.module?.name || (i.context === 'assignments' ? 'Assignments' : 'Course files'), updated: updated.has(i.selectionKey) })),
      failures: failed.slice(0, 20).map(i => ({ title: i.title, reason: i.reason }))
    };
  }
  function describe(last) {
    if (!last) return 'Not synced yet';
    if (last.status === 'error') return last.message;
    if (last.status === 'cancelled') return 'Cancelled';
    const { downloaded = 0, failed = 0 } = last.counts || {};
    if (downloaded) return `${downloaded} new${failed ? ` · ${failed} failed` : ''}`;
    if (failed) return `${failed} couldn’t download`;
    return last.message || 'Up to date';
  }
  async function saveLast(id, result) {
    const rec = record(id), at = new Date(now()).toISOString();
    const { newItems = [], ...rest } = result;
    rec.last = { at, ...rest };
    if (newItems.length) rec.recent = [...newItems.map(item => ({ ...item, at })), ...(rec.recent || [])].slice(0, 25);
    await saveRecord(id);
    log(result.status === 'error' ? 'error' : result.status === 'partial' ? 'warn' : 'ok', `${name(course(id))}: ${describe(rec.last)}`);
    return { id, ...rec.last };
  }
  async function syncCourse(id, signal) {
    const c = course(id), label = name(c), destination = state.destinations.get(id);
    if (!destination) throw new ArchiveError(`Choose a folder for ${label} first.`, 'setup');
    destination.granted = await permission(destination.handle).catch(() => false);
    if (!destination.granted) throw new ArchiveError(`Folder access for ${label} needs to be allowed again.`, 'permission');
    setStatus('busy', `Syncing ${label}`, 'Looking for materials on Canvas…', { progress: true });
    const catalog = await scanCourse(client, c, store, { signal, progress: p => setStatus('busy', `Syncing ${label}`, `Looking for materials on Canvas · ${p.discovered} found`, { progress: true }) });
    state.catalogs.set(id, catalog); applySelection(id); await persistSelection(id);
    const keys = new Set(selection(id).keys);
    if (!keys.size) return saveLast(id, { status: 'ok', message: 'Nothing selected to sync', counts: { downloaded: 0, upToDate: 0, kept: 0, failed: 0 } });
    const review = await prepareReview(client, catalog, destination.handle, keys, store, { signal, policies: state.policies, progress: p => setStatus('busy', `Syncing ${label}`, `Comparing with your folder · ${p.checked} of ${keys.size}`, { progress: { value: p.checked, max: keys.size } }) });
    state.checks.set(id, new Map(review.rows.map(r => [r.key, r])));
    const work = review.rows.filter(needsTransfer);
    if (!work.length) return saveLast(id, reviewResult(review));
    const sources = new Map(work.map(r => [r.assetKey, review.sources.get(r.assetKey)]).filter(([, source]) => source));
    const origins = requiredOrigins(sources);
    if (origins.length && chromeAPI?.permissions?.contains && !await chromeAPI.permissions.contains({ origins })) {
      const error = new ArchiveError(`${label} has files on another server. Click “Allow downloads” to fetch them.`, 'hosts');
      error.origins = origins; throw error;
    }
    const journal = await runJob(client, review, store, { signal, progress: p => {
      const counts = p.report.counts, done = counts.downloaded + counts.skipped + counts.failed + counts.cancelled;
      setStatus('busy', `Syncing ${label}`, p.title ? `Downloading ${p.title}${p.bytes ? ` · ${formatBytes(p.bytes)}` : ''}` : `${counts.downloaded} downloaded · ${done} of ${p.total} done`, { progress: { value: done, max: p.total } });
    } });
    state.runs.set(id, journal); state.checks.delete(id);
    checkAbort(signal); // A cancelled run is recorded as cancelled, not as failures.
    return saveLast(id, runResult(journal, review));
  }
  async function syncCourseSafe(id, signal) {
    state.syncing = { id }; renderList();
    try { return await syncCourse(id, signal); }
    catch (error) {
      if (error.name === 'AbortError') { await saveLast(id, { status: 'cancelled' }); throw error; }
      if (error.code === 'auth') throw error;
      if (error.code === 'permission' && state.destinations.get(id)) state.destinations.get(id).granted = false;
      return saveLast(id, { status: 'error', code: error.code, message: friendly(error), origins: error.origins || null });
    } finally { state.syncing = null; renderList(); }
  }
  function cycleStatus(results) {
    const total = key => results.reduce((sum, r) => sum + (r.counts?.[key] || 0), 0);
    const downloaded = total('downloaded'), failed = total('failed'), problems = results.filter(r => r.status === 'error');
    const when = `Checked ${plural(results.length, 'course')} just now`;
    if (problems.length) {
      const action = problems.some(p => p.code === 'permission') ? '<button class="small" data-action="renew-all">Allow access</button>' : '';
      setStatus('warn', `${plural(problems.length, 'course')} need${problems.length === 1 ? 's' : ''} attention`, problems.map(p => `${name(course(p.id))}: ${p.message}`).join(' '), { action });
    } else if (failed) setStatus('warn', downloaded ? `${plural(downloaded, 'file')} downloaded, ${failed} failed` : `${plural(failed, 'item')} couldn’t be downloaded`, 'Open the course to see what failed and why.');
    else setStatus('ok', downloaded ? `${plural(downloaded, 'new file')} downloaded` : 'Everything is up to date', when);
  }
  function syncAll(reason = 'manual') {
    const ids = autoCourses();
    if (!ids.length) {
      if (reason === 'manual') setStatus('info', 'No courses are set to auto-sync yet', 'Open a course and choose its folder to start.');
      return Promise.resolve(false);
    }
    return perform(reason === 'manual' ? 'Syncing your courses…' : 'Checking for new materials…', signal => withLock(async () => {
      if (!client.verified) await connect(signal);
      const results = [];
      for (const id of ids) { checkAbort(signal); results.push(await syncCourseSafe(id, signal)); }
      state.lastCycle = new Date(now()).toISOString(); await store.set('sync:last-cycle', state.lastCycle);
      cycleStatus(results);
    }));
  }
  function syncOne(id) {
    return perform(`Syncing ${name(course(id))}…`, signal => withLock(async () => {
      if (!client.verified) await connect(signal);
      cycleStatus([await syncCourseSafe(id, signal)]);
    }));
  }
  function tick() {
    if (state.view.name === 'home') renderHome();
    if (!state.interval || state.busy || state.connection === 'auth' || !autoCourses().length) return;
    if (state.lastCycle && now() - Date.parse(state.lastCycle) < state.interval * 60000) return;
    syncAll('timer');
  }
  // Reconnect automatically once you finish signing in to Canvas in any tab.
  function watchCanvas() {
    chromeAPI?.tabs?.onUpdated?.addListener?.((tabId, info, tab) => {
      if (info.status !== 'complete' || client.verified || state.busy) return;
      try { if (new URL(tab?.url || '').origin !== ORIGIN) return; } catch { return; }
      clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => start(false), 1500);
    });
  }
  async function start(first = true) {
    if (first) { watchCanvas(); clearInterval(timer); timer = setInterval(tick, 60000); }
    const connected = await perform('Connecting to Canvas…', connect);
    if (connected && autoCourses().length) await syncAll('open');
    else if (connected) restingStatus();
  }

  // ---- Reviews (advanced) ----
  async function reviewSelection(signal, ids = state.courses.map(c => c.id)) {
    state.reviews = [];
    for (const id of ids) {
      const c = course(id), selected = new Set(selection(id).keys);
      if (!c || !selected.size) continue;
      const destination = state.destinations.get(id);
      if (!destination) throw new ArchiveError(`Choose a folder for ${name(c)} first.`);
      if (!await permission(destination.handle)) throw new ArchiveError(`Allow folder access for ${name(c)}, then try again.`, 'permission');
      const review = await prepareReview(client, state.catalogs.get(id), destination.handle, selected, store, { signal, policies: state.policies, progress: p => setStatus('busy', `Checking ${name(c)}`, `${p.checked} of ${selected.size} · ${p.title}`, { progress: { value: p.checked, max: selected.size } }) });
      state.reviews.push(review); state.checks.set(id, new Map(review.rows.map(r => [r.key, r])));
    }
    if (!state.reviews.length) throw new ArchiveError('Select at least one material first.');
    const rows = state.reviews.flatMap(r => r.rows);
    setStatus('info', 'Review ready', `${plural(rows.filter(needsTransfer).length, 'item')} will be downloaded. Nothing has been written yet.`);
    showView('review', { id: ids.length === 1 ? ids[0] : null });
    $('#review-title').focus?.();
  }
  function renderReview() {
    const rows = state.reviews.flatMap(r => r.rows), totals = summary(rows);
    let bytes = 0, unknown = 0, transfers = 0;
    for (const review of state.reviews) for (const row of review.rows) if (needsTransfer(row)) {
      transfers++; const size = review.catalog.assets[row.assetKey].size; size == null ? unknown++ : bytes += size;
    }
    const stat = (n, label, tone = '') => `<div class="stat ${tone}"><b>${n}</b><span>${label}</span></div>`;
    $('#review-summary').innerHTML = stat(totals.new, 'new', 'ok') + stat(totals.updates, 'updates', 'ok') + stat(totals.unchanged, 'up to date') + stat(totals.conflicts, 'kept as-is', totals.conflicts ? 'warn' : '') + stat(totals.unavailable, 'unavailable', totals.unavailable ? 'error' : '');
    // Show what needs attention first: downloads, then kept files, unavailable, and finally up-to-date items.
    const rank = row => needsTransfer(row) ? 0 : preserveState(row.state) ? 1 : row.state === 'Unavailable' ? 2 : 3;
    $('#review-rows').innerHTML = state.reviews.map(review => [...review.rows].sort((a, b) => rank(a) - rank(b)).map(row => {
      const asset = review.catalog.assets[row.assetKey], courseId = review.catalog.course.id;
      const module = review.catalog.modules.find(m => row.context === `module:${m.id}`);
      const action = preserveState(row.state)
        ? `<div class="actions"><select data-policy="${e(row.key)}" data-course="${e(courseId)}" aria-label="${e(`What to do with ${asset.title}`)}"><option value="preserve" ${row.policy === 'preserve' ? 'selected' : ''}>Keep my file</option><option value="replace" ${row.policy === 'replace' ? 'selected' : ''}>Replace with Canvas version</option></select><button class="small" data-verify="${e(row.key)}" data-course="${e(courseId)}">Verify</button></div>`
        : '';
      const deps = row.dependencies.length ? `<details class="dependencies"><summary>${plural(row.dependencies.length, 'linked file')} stay online</summary><ul>${row.dependencies.map(d => `<li>${e(d.title)} — ${e(d.reason)} <a href="${e(d.url)}" target="_blank" rel="noreferrer">Open ↗</a></li>`).join('')}</ul></details>` : '';
      return `<article class="review-item"><div class="review-head"><strong>${e(asset.title)}</strong><span class="badge ${STATE_TONE[row.state] || ''}" title="${e(row.state)}">${e(needsTransfer(row) ? (row.state === 'Missing' ? 'Will download' : row.state === 'Remote update available' ? 'Will update' : 'Will replace') : STATE_LABEL[row.state] || row.state)}</span></div>
        <p class="muted">${e(name(review.catalog.course))} · ${e(module?.name || (row.context === 'assignments' ? 'Assignments' : 'Course files'))}</p><code>${e(row.path)}</code><p>${e(row.reason)}</p>${action}${deps}</article>`;
    }).join('')).join('');
    $('#start').textContent = transfers ? `Download ${plural(transfers, 'item')}${bytes || unknown ? ` · ${formatBytes(bytes)}${unknown ? '+' : ''}` : ''}` : 'Nothing to download — record results';
  }

  // ---- Rendering ----
  function render() {
    document.body.classList.toggle('advanced', advanced());
    document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
    for (const view of ['home', 'course', 'review', 'tools']) $(`#${view}-view`).hidden = state.view.name !== view;
    if (state.view.name === 'home') renderHome();
    else if (state.view.name === 'course') renderCourse(state.view.id);
    else if (state.view.name === 'review') renderReview();
    else if (state.view.name === 'tools') renderTools();
    applyBusy(); updateSelection();
  }
  function renderList() { if (state.view.name === 'home') renderHome(); else if (state.view.name === 'course') renderCourse(state.view.id); applyBusy(); updateSelection(); }
  function showView(viewName, extra = {}) {
    state.view = { name: viewName, ...extra }; render();
    globalThis.scrollTo?.(0, 0);
  }
  function courseState(id) {
    const destination = state.destinations.get(id), rec = record(id);
    if (state.syncing?.id === id) return { tone: 'info', html: '<span class="spinner"></span>Syncing…' };
    if (!destination) return { tone: 'muted', html: 'Not set up' };
    if (!destination.granted) return { tone: 'warn', html: 'Folder access needed', action: `<button class="small warn" data-action="renew" data-course="${e(id)}">Allow access</button>` };
    const last = rec.last, when = last ? ` · ${relativeTime(last.at, now())}` : '';
    if (last?.code === 'hosts') return { tone: 'warn', html: 'Needs download permission', action: `<button class="small warn" data-action="allow-hosts" data-course="${e(id)}">Allow downloads</button>` };
    if (!last) return { tone: 'muted', html: rec.auto ? 'Waiting for first sync' : 'Manual sync' };
    const tone = last.status === 'error' ? 'error' : last.status === 'partial' || last.status === 'cancelled' ? 'warn' : 'ok';
    const icon = tone === 'ok' ? '✓ ' : '! ';
    return { tone, html: `${icon}${e(describe(last))}${e(when)}` };
  }
  function courseRow(c) {
    const s = courseState(c.id), rec = record(c.id), destination = state.destinations.get(c.id);
    const action = s.action || (!destination ? `<button class="small" data-action="choose" data-course="${e(c.id)}">Set up</button>` : '<span class="chev" aria-hidden="true">›</span>');
    return `<article class="course-row" data-card="${e(c.id)}">
      <button class="course-open" data-action="open-course" data-course="${e(c.id)}" data-nav aria-label="${e(`Open ${c.name}`)}">
        <span class="course-title">${e(c.name)}${rec.auto && destination ? '<span class="tag">AUTO</span>' : ''}</span>
        <span class="course-sub">${e([c.code, c.term?.name].filter(Boolean).join(' · ') || 'No course code')}</span>
        <span class="course-state tone-${s.tone}">${s.html}</span>
      </button>${action}</article>`;
  }
  function renderHome() {
    const auto = autoCourses(), query = $('#search').value.trim().toLowerCase(), past = $('#previous').checked;
    const matches = c => !query || `${c.name} ${c.code} ${c.term?.name || ''}`.toLowerCase().includes(query);
    const synced = state.courses.filter(c => state.destinations.has(c.id) && matches(c));
    const current = state.courses.filter(c => !state.destinations.has(c.id) && !coursePrevious(c) && matches(c));
    const previous = past ? state.courses.filter(c => !state.destinations.has(c.id) && coursePrevious(c) && matches(c)) : [];
    const next = state.interval && state.lastCycle ? Math.max(0, Math.ceil((Date.parse(state.lastCycle) + state.interval * 60000 - now()) / 60000)) : null;
    $('#sync-summary').innerHTML = state.courses.length ? `<section class="card sync-summary">
        <div><h2>${auto.length ? `Auto-sync on for ${plural(auto.length, 'course')}` : 'Auto-sync is off'}</h2>
        <p>${auto.length ? `${state.lastCycle ? `Last synced ${relativeTime(state.lastCycle, now())}` : 'Not synced yet'}${next != null ? ` · next check in ${next} min` : ''}` : 'Open a course below and choose a folder to start.'}</p></div>
        ${auto.length ? '<button class="primary" data-action="sync-all">Sync now</button>' : ''}</section>` : '';
    const groupHTML = (title, list, extra = '') => list.length ? `<h3 class="group-title"><span>${title}</span><span>${list.length}</span></h3>${extra}<div class="course-list">${list.map(courseRow).join('')}</div>` : '';
    const html = groupHTML('Syncing', synced) + groupHTML(synced.length ? 'Not set up' : 'Your courses', current) + groupHTML('Past courses', previous);
    $('#course-list').innerHTML = html || (state.courses.length
      ? `<div class="card empty"><h2>No matching courses</h2><p>${past ? 'Try a different search.' : 'Try a different search, or turn on “Past” to include older courses.'}</p></div>`
      : `<div class="card empty"><h2>Connect to Canvas</h2><p>Sign in to Canvas in this browser. Your courses appear here automatically.</p><div class="actions">${OPEN_CANVAS}<button class="small" data-action="connect">Try again</button></div></div>`);
  }
  function checkState(id, key) { return state.checks.get(id)?.get(key)?.state || null; }
  function checkbox(id, key, scope, title, disabled = false) {
    const s = selection(id), checked = scope ? s.state(selectableKeys(state.catalogs.get(id), scope)).checked : s.keys.has(key);
    return `<input type="checkbox" data-course="${e(id)}" ${scope ? `data-scope="${e(scope)}"` : `data-item="${e(key)}"`} aria-label="${e(title)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`;
  }
  function materialRows(id, scope) {
    const catalog = state.catalogs.get(id), keys = new Set(scopeKeys(catalog, scope)), limitKey = `${id}:${scope}`, limit = state.limits.get(limitKey) || 100;
    const placements = catalog.placements.filter(p => keys.has(p.key)), attached = assignmentFiles(catalog);
    const rows = placements.slice(0, limit).map(p => {
      const asset = catalog.assets[p.assetKey], unavailable = p.unavailable || asset.unavailable, status = unavailable ? 'Unavailable' : checkState(id, p.key);
      const module = catalog.modules.find(m => p.context === `module:${m.id}`);
      const from = attached.get(asset.key)?.titles;
      const meta = [from ? `From ${from.slice(0, 2).join(', ')}${from.length > 2 ? ` +${from.length - 2}` : ''}` : '', convertible(asset.filename) ? 'Saved as PDF' : '', advanced() ? formatBytes(asset.size) : '', advanced() ? `Canvas ${asset.id}` : '', scope === 'assignments' && module ? module.name : ''].filter(Boolean).join(' · ');
      const badge = status && (advanced() || unavailable) ? `<span class="badge ${STATE_TONE[status] || ''}" title="${e(state.checks.get(id)?.get(p.key)?.reason || unavailable || '')}">${e(STATE_LABEL[status] || status)}</span>` : '';
      return `<div class="item${unavailable ? ' is-unavailable' : ''}"><label class="item-main">${checkbox(id, p.key, null, `Include ${asset.title}${module ? ` in ${module.name}` : ''}`, !!unavailable)}<span class="item-text"><span class="item-title">${e(asset.title)}</span><span class="item-meta">${e(meta)}</span></span></label>${badge}<a class="item-link" href="${e(asset.sourceURL)}" target="_blank" rel="noreferrer" title="Open in Canvas" aria-label="${e(`Open ${asset.title} in Canvas`)}">↗</a></div>`;
    }).join('');
    return rows + (placements.length > limit ? `<button class="small more" data-action="more" data-nav data-course="${e(id)}" data-scope="${e(scope)}">Show ${Math.min(100, placements.length - limit)} more of ${placements.length}</button>` : '') + (!placements.length ? '<p class="muted small">Nothing found in this section.</p>' : '');
  }
  function group(id, scope, title) {
    const key = `${id}:${scope}`, open = state.expanded.has(key), selectable = selectableKeys(state.catalogs.get(id), scope);
    const count = scopeKeys(state.catalogs.get(id), scope).length, chosen = selection(id).state(selectable).count;
    return `<details class="content-section" data-expand="${e(key)}" data-course="${e(id)}" data-scope="${e(scope)}" ${open ? 'open' : ''}><summary><span>${e(title)}</span><span class="count" data-count="${e(scope)}">${chosen}/${count}</span></summary><div class="section-body">${open ? sectionBody(id, scope) : ''}</div></details>`;
  }
  function sectionBody(id, scope) {
    const catalog = state.catalogs.get(id), selectable = selectableKeys(catalog, scope);
    // Modules that only hold pages/assignments without files have nothing to download, so they're hidden.
    const modules = catalog.modules.filter(m => scopeKeys(catalog, `module:${m.id}`).length);
    let content = scope === 'modules' ? modules.map(m => group(id, `module:${m.id}`, `${String(m.position).padStart(2, '0')} · ${m.name}`)).join('') : materialRows(id, scope);
    if (scope === 'modules' && !modules.length) content = '<p class="muted small">No files in modules.</p>';
    return `<div class="section-actions"><label class="check-label">${checkbox(id, null, scope, `Include all ${selectable.length} items in this section`, !selectable.length)}Include all</label></div>` + content;
  }
  function materialsCard(id) {
    const catalog = state.catalogs.get(id), rec = record(id);
    if (!catalog) return `<section class="card"><h3>Files</h3><p class="muted small">${state.destinations.has(id) ? 'Files appear here after the first sync.' : 'Choose a folder to see and sync this course’s files.'}</p>${advanced() ? `<div class="actions"><button class="small" data-action="scan" data-course="${e(id)}">Scan without downloading</button></div>` : ''}</section>`;
    const all = selectableKeys(catalog), chosen = selection(id).state(all).count;
    return `<section class="card materials">
      <div class="card-row"><div><h3>Files</h3><p class="muted small" id="included-count">${chosen} of ${all.length} included${rec.auto ? ' · new uploads are added automatically' : ''}</p></div>
        <label class="check-label">${checkbox(id, null, 'course', 'Include all materials', !all.length)}All</label></div>
      ${advanced() ? `<div class="materials-toolbar"><span>Scanned ${e(relativeTime(catalog.scannedAt, now()))}</span><button class="small" data-action="scan" data-course="${e(id)}">Rescan</button>${state.destinations.has(id) ? `<button class="small" data-action="check" data-course="${e(id)}">Check folder</button><button class="small" data-action="review-course" data-course="${e(id)}">Review before downloading</button>` : ''}</div>` : ''}
      <div class="tree">${group(id, 'modules', 'Modules')}${group(id, 'assignments', 'Assignments')}${group(id, 'files', 'Other course files')}</div>
    </section>`;
  }
  function renderCourse(id) {
    const c = course(id);
    if (!c) { state.view = { name: 'home' }; return render(); }
    if (document.activeElement?.dataset?.label) return; // Don't steal focus while the label is being edited.
    const destination = state.destinations.get(id), rec = record(id), catalog = state.catalogs.get(id), run = state.runs.get(id);
    const header = `<div class="view-header"><button class="back" data-action="back" data-nav>← All courses</button></div>
      <div class="hero"><h2 id="course-title" tabindex="-1">${e(c.name)}</h2><p>${e([c.code, c.term?.name, coursePrevious(c) ? 'Past course' : '', advanced() ? `Canvas ${id}` : ''].filter(Boolean).join(' · '))}</p></div>`;
    const external = catalog?.external.length ? `<details class="card disclosure"><summary><span>${plural(catalog.external.length, 'online-only link')} <span class="muted small">videos, Colab, external tools</span></span></summary><ul class="list">${catalog.external.map(v => `<li><span>${e(v.title)}<span class="item-meta">${e(v.reason)}</span></span>${v.url ? `<a href="${e(v.url)}" target="_blank" rel="noreferrer">Open ↗</a>` : ''}</li>`).join('')}</ul></details>` : '';
    if (!destination) {
      $('#course-detail').innerHTML = header + `<section class="card"><h3>Sync this course to a folder</h3><p class="muted">Pick the folder on your computer for this course. Everything in it downloads there, and new uploads are added automatically. Files you edit are never overwritten.</p><div class="actions"><button class="primary block" data-action="choose" data-course="${e(id)}">Choose folder…</button></div></section>` + (advanced() || catalog ? materialsCard(id) : '') + external;
      return;
    }
    const s = courseState(id), last = rec.last, counts = last?.counts;
    const stat = (n, label, tone = '') => `<div class="stat ${tone}"><b>${n}</b><span>${label}</span></div>`;
    const syncCard = `<section class="card">
      <div class="card-row"><div><h3>Auto-sync</h3><p class="muted small">${rec.auto ? `Downloads new and changed materials when this panel opens${state.interval ? ` and every ${state.interval < 60 ? `${state.interval} min` : `${state.interval / 60} h`}` : ''}.` : 'Off — this course only syncs when you click Sync now.'}</p></div>
        <span class="switch"><input type="checkbox" data-auto="${e(id)}" ${rec.auto ? 'checked' : ''} aria-label="${e(`Auto-sync ${c.name}`)}"><span class="track" aria-hidden="true"></span></span></div>
      <div class="sync-state tone-${s.tone}">${s.html}</div>
      ${counts ? `<div class="stats">${stat(counts.downloaded, 'downloaded', counts.downloaded ? 'ok' : '')}${stat(counts.upToDate, 'up to date')}${counts.kept ? stat(counts.kept, 'kept as-is', 'warn') : ''}${counts.failed ? stat(counts.failed, 'failed', 'error') : ''}</div>` : ''}
      ${counts?.kept ? `<p class="hint" style="margin-top:8px">“Kept as-is” files were edited by you or already existed, so they aren’t overwritten.${advanced() ? ' Use Review before downloading to compare or replace them.' : ''}</p>` : ''}
      ${last?.failures?.length ? `<details class="dependencies"><summary>Why ${plural(last.failures.length, 'item')} failed</summary><ul>${last.failures.map(f => `<li><strong>${e(f.title)}</strong> — ${e(f.reason)}</li>`).join('')}</ul></details>` : ''}
      <div class="actions"><button class="primary" data-action="sync-course" data-course="${e(id)}">Sync now</button>${s.action || ''}${advanced() && run && !rec.auto && run.report.items.some(i => ['failed', 'cancelled'].includes(i.outcome)) ? `<button data-action="retry" data-course="${e(id)}">Retry failed</button>` : ''}</div>
    </section>`;
    const folderCard = `<section class="card"><h3>Folder</h3>
      <div class="folder"><span class="folder-icon" aria-hidden="true">📁</span><div><strong>${e(destination.handle.name)}</strong>${destination.label ? `<span class="item-meta">${e(destination.label)}</span>` : ''}</div><span class="badge ${destination.granted ? 'ok' : 'warn'}">${destination.granted ? 'Access allowed' : 'Needs access'}</span></div>
      <div class="actions">${destination.granted ? '' : `<button class="primary" data-action="renew" data-course="${e(id)}">Allow access</button>`}<button data-action="choose" data-course="${e(id)}">Change folder</button></div>
      ${advanced() ? `<label class="field label-input">Label (only for you — browsers hide the full path)<input data-label="${e(id)}" value="${e(destination.label || '')}" placeholder="e.g. Documents/school/EE2328"></label>` : ''}
    </section>`;
    const recent = rec.recent?.length ? `<section class="card"><h3>Recently downloaded</h3><ul class="list">${rec.recent.slice(0, advanced() ? 25 : 8).map(item => `<li><span>${e(item.title)}${item.updated ? ' <span class="badge info">updated</span>' : ''}<span class="item-meta">${e(advanced() ? item.path : item.where || '')}</span></span><span class="meta">${e(relativeTime(item.at, now()))}</span></li>`).join('')}</ul></section>` : '';
    const coverage = advanced() && catalog?.coverage.length ? `<details class="card disclosure warn"><summary>${plural(catalog.coverage.length, 'scan limitation')}</summary><ul class="list">${catalog.coverage.map(v => `<li><span><strong>${e(v.section)}</strong><span class="item-meta">${e(v.reason)}</span></span></li>`).join('')}</ul></details>` : '';
    const reports = advanced() ? `<details class="card disclosure"><summary>Reports and Python index</summary>
      ${run ? `<div class="actions"><button class="small" data-action="report" data-nav data-course="${e(id)}">View latest report</button>${rec.auto ? '' : `<button class="small" data-action="recover" data-course="${e(id)}">Restore last selection and recheck</button>`}${run.reportSaveError ? `<button class="small" data-action="save-report" data-course="${e(id)}">Save report again</button>` : ''}</div>
        ${run.reportSaveError ? `<p class="hint">The report is kept in the browser, but couldn’t be saved to the folder: ${e(run.reportSaveError)}</p>` : ''}${run.report.status === 'running' ? '<p class="hint">The previous run was interrupted. Sync again to finish it.</p>' : ''}` : '<p class="muted small">No runs yet.</p>'}
      <p class="hint" style="margin-top:12px">The old Python script keeps its index above the course folder. Import it to reuse its checksums.</p>
      <label class="check-label" style="margin-top:8px"><input data-python-origin="${e(id)}" type="checkbox">This index came from canvas.calpoly.edu</label>
      <div class="actions"><button class="small" data-action="import" data-course="${e(id)}">Import Python index</button></div></details>` : '';
    $('#course-detail').innerHTML = header + syncCard + folderCard + recent + materialsCard(id) + external + coverage + reports;
  }
  function renderTools() {
    $('#sync-interval').value = String(state.interval);
    $('#connection-detail').textContent = client.verified ? `Connected using: ${client.transportName}. ${plural(state.courses.length, 'course')} listed.` : 'Not connected. Sign in to Canvas in this browser.';
    $('#version').textContent = chromeAPI?.runtime?.getManifest ? `v${chromeAPI.runtime.getManifest().version}` : '';
    $('#theme-detail').textContent = document.documentElement.dataset.theme === 'stylix'
      ? 'Using your Stylix colours and fonts. After running theme-switch, reopen this panel to pick up the new scheme.'
      : 'Using the built-in palette. To follow Stylix, pass your Stylix colours to the Canvas Archive native helper in your Nix config (see README → Stylix theme).';
    renderActivity();
  }
  function renderActivity() {
    const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('#activity').innerHTML = state.activity.length ? state.activity.slice(0, 50).map(a => `<li><time datetime="${e(a.at)}">${e(time(a.at))}</time><span class="tone-${e(a.tone)}">${e(a.text)}</span></li>`).join('') : '<li class="muted">Nothing yet.</li>';
  }
  function updateSelection() {
    document.querySelectorAll('input[data-scope]').forEach(input => {
      const group = selection(input.dataset.course).state(selectableKeys(state.catalogs.get(input.dataset.course), input.dataset.scope));
      input.checked = group.checked; input.indeterminate = group.indeterminate;
    });
    document.querySelectorAll('input[data-item]').forEach(input => { input.checked = selection(input.dataset.course).keys.has(input.dataset.item); });
    document.querySelectorAll('[data-count]').forEach(span => {
      const details = span.closest('[data-course]'), id = details?.dataset.course, catalog = state.catalogs.get(id);
      if (catalog) span.textContent = `${selection(id).state(selectableKeys(catalog, span.dataset.count)).count}/${scopeKeys(catalog, span.dataset.count).length}`;
    });
    const included = $('#included-count');
    if (included && state.view.name === 'course') {
      const id = state.view.id, all = selectableKeys(state.catalogs.get(id));
      included.textContent = `${selection(id).state(all).count} of ${all.length} included${record(id).auto ? ' · new uploads are added automatically' : ''}`;
    }
  }

  // ---- Events ----
  $('#connect').onclick = () => start(false);
  $('#search').oninput = renderHome; $('#previous').onchange = renderHome;
  $('#cancel').onclick = () => { controller?.abort(); setStatus('busy', 'Cancelling…', 'Finished files are kept.', { progress: true }); };
  $('#sync-interval').onchange = event => { state.interval = Number(event.target.value); store.set('ui:interval', state.interval).catch(() => {}); log('info', state.interval ? `Sync schedule: every ${state.interval} min` : 'Sync schedule: only when opened'); };
  $('#start').onclick = () => {
    const originals = new Map(); state.reviews.forEach(r => r.sources.forEach((source, key) => originals.set(`${r.catalog.course.id}:${key}`, source)));
    const permissionRequest = grantOrigins(requiredOrigins(originals), chromeAPI); // Must run inside the click.
    const back = state.view.id;
    perform('Downloading…', async signal => {
      if (!await permissionRequest) throw new ArchiveError('Download access to the file host wasn’t granted. Your selection is unchanged.');
      if (!state.reviews.length) throw new ArchiveError('Review your selection again before downloading.');
      await withLock(async () => {
        const results = [];
        for (const review of state.reviews) {
          const id = review.catalog.course.id;
          state.syncing = { id };
          const journal = await runJob(client, review, store, { signal, progress: p => {
            const counts = p.report.counts, done = counts.downloaded + counts.skipped + counts.failed + counts.cancelled;
            setStatus('busy', `Downloading ${name(review.catalog.course)}`, p.title ? `${p.title}${p.bytes ? ` · ${formatBytes(p.bytes)}` : ''}` : `${done} of ${p.total} done`, { progress: { value: done, max: p.total } });
          } });
          state.runs.set(id, journal); state.checks.delete(id);
          results.push(await saveLast(id, runResult(journal, review)));
        }
        state.reviews = [];
        if (!client.verified) setConnection('auth');
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        cycleStatus(results);
      });
      state.view = back ? { name: 'course', id: back } : { name: 'home' };
    });
  };
  $('#grant-host').onclick = () => {
    let url;
    try { url = downloadURL($('#host-origin').value); if (url.pathname !== '/' || url.search || url.hash) throw new Error(); }
    catch { setStatus('warn', 'Enter just the host', 'Use an HTTPS origin like https://files.example.edu, without a path or query.'); return; }
    const request = grantOrigins([`${url.origin}/*`], chromeAPI);
    perform('Requesting download host access…', async () => {
      if (await request) { setStatus('ok', `Downloads from ${url.hostname} allowed`, 'Sync again to retry the affected files.'); log('ok', `Allowed host ${url.hostname}`); }
      else setStatus('warn', 'Host access was not granted');
    });
  };
  document.addEventListener('change', event => {
    const input = event.target, id = input.dataset?.course;
    if (input.type === 'checkbox' && (input.dataset.item || input.dataset.scope)) {
      if (input.dataset.item) selection(id).set(input.dataset.item, input.checked);
      else selection(id).group(selectableKeys(state.catalogs.get(id), input.dataset.scope), input.checked);
      state.reviews = []; updateExcluded(id); updateSelection();
      persistSelection(id).catch(() => setStatus('error', 'Selection couldn’t be saved', 'Keep this panel open and try again.'));
    }
    if (input.dataset.auto) {
      const courseId = input.dataset.auto, rec = record(courseId);
      if (input.checked && !state.destinations.has(courseId)) { input.checked = false; setStatus('info', 'Choose a folder first'); return; }
      rec.auto = input.checked;
      if (rec.auto) rec.excluded = [];
      applySelection(courseId);
      Promise.all([saveRecord(courseId), persistSelection(courseId)]).catch(() => {});
      log('info', `${name(course(courseId))}: auto-sync ${rec.auto ? 'on' : 'off'}`);
      render();
      if (rec.auto) syncOne(courseId);
    }
    if (input.dataset.label) {
      const destination = state.destinations.get(input.dataset.label); destination.label = input.value.slice(0, 500);
      store.set(destinationKey(ORIGIN, input.dataset.label), { handle: destination.handle, label: destination.label }).catch(() => setStatus('error', 'Label couldn’t be saved'));
    }
    if (input.dataset.policy) {
      state.policies.set(input.dataset.policy, input.value);
      const row = state.reviews.find(r => r.catalog.course.id === id)?.rows.find(r => r.key === input.dataset.policy);
      if (row) { row.policy = input.value; renderReview(); }
    }
  });
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.dataset?.expand) return;
    details.open ? state.expanded.add(details.dataset.expand) : state.expanded.delete(details.dataset.expand);
    if (details.open) { details.querySelector(':scope > .section-body').innerHTML = sectionBody(details.dataset.course, details.dataset.scope); applyBusy(); }
    updateSelection();
  }, true);
  document.addEventListener('click', event => {
    const modeButton = event.target.closest('button[data-mode]');
    if (modeButton) {
      state.mode = modeButton.dataset.mode; store.set('ui:mode', state.mode).catch(() => {});
      if (!advanced() && ['tools', 'review'].includes(state.view.name)) state.view = state.view.id ? { name: 'course', id: state.view.id } : { name: 'home' };
      render(); return;
    }
    const button = event.target.closest('button[data-action], button[data-verify]');
    if (!button || button.disabled || state.busy && !button.hasAttribute('data-nav')) return;
    const id = button.dataset.course, c = course(id), destination = state.destinations.get(id), action = button.dataset.action;
    if (action === 'open-course') showView('course', { id });
    else if (action === 'back') showView(state.view.name === 'review' && state.view.id ? 'course' : 'home', state.view.name === 'review' && state.view.id ? { id: state.view.id } : {});
    else if (action === 'tools') showView('tools');
    else if (action === 'connect') start(false);
    else if (action === 'sync-all') syncAll('manual');
    else if (action === 'sync-course') syncOne(id);
    else if (action === 'choose') {
      // The picker must open before any other asynchronous work to keep the click's user activation.
      const pick = picker({ mode: 'readwrite', id: `course-${id}`.slice(0, 32) }), isNew = !destination;
      perform('Choosing a folder…', async () => {
        const handle = await pick;
        for (const [otherId, d] of state.destinations) if (otherId !== id && await handle.isSameEntry(d.handle)) throw new ArchiveError('This folder is already used by another course. Choose a separate folder.');
        await loadIndex(handle, id); // Rejects a folder holding another course's index.
        const value = { handle, label: destination?.label || '' }; await store.set(destinationKey(ORIGIN, id), value);
        value.granted = await permission(handle); state.destinations.set(id, value); state.checks.delete(id); state.reviews = [];
        if (isNew) { const rec = record(id); rec.auto = true; rec.excluded = []; await saveRecord(id); applySelection(id); }
        setStatus('ok', `${name(c)} → ${handle.name}`, isNew ? 'Auto-sync is on. Downloading everything now…' : 'Folder changed. The next sync fills it in.');
        log('ok', `${name(c)}: folder set to ${handle.name}`);
        state.view = { name: 'course', id };
      }).then(ok => { if (ok && isNew) syncOne(id); });
    } else if (action === 'renew') {
      const request = renew(destination.handle);
      perform('Allowing folder access…', async () => {
        destination.granted = await request; state.reviews = [];
        if (destination.granted) setStatus('ok', 'Folder access allowed', record(id).auto ? 'Syncing now…' : ''); else setStatus('warn', 'Folder access was not allowed', 'You can try again or choose another folder.');
      }).then(ok => { if (ok && destination.granted && record(id).auto) syncOne(id); });
    } else if (action === 'renew-all') {
      const pending = needsAccess().map(courseId => [courseId, state.destinations.get(courseId)]);
      const first = pending[0] ? renew(pending[0][1].handle) : null; // First prompt inside the click.
      perform('Allowing folder access…', async () => {
        for (let i = 0; i < pending.length; i++) {
          const d = pending[i][1];
          try { d.granted = await (i === 0 ? first : renew(d.handle)); } catch { d.granted = false; }
        }
        const left = pending.filter(([, d]) => !d.granted).length;
        if (left) setStatus('warn', `${plural(left, 'folder')} still need${left === 1 ? 's' : ''} access`, 'Click Allow access again, or open the course to allow it there.', { action: '<button class="small" data-action="renew-all">Allow access</button>' });
      }).then(ok => { if (ok && autoCourses().length && !needsAccess().length) syncAll('access'); });
    } else if (action === 'allow-hosts') {
      const origins = record(id).last?.origins || [];
      const request = grantOrigins(origins, chromeAPI);
      perform('Allowing downloads…', async () => { if (!await request) throw new ArchiveError('Download access wasn’t granted.'); }).then(ok => { if (ok) syncOne(id); });
    } else if (action === 'scan') perform(`Scanning ${name(c)}…`, async signal => {
      state.reviews = [];
      const catalog = await scanCourse(client, c, store, { signal, progress: p => setStatus('busy', `Scanning ${name(c)}`, `${p.discovered} found · ${p.title}`, { progress: true }) });
      state.catalogs.set(id, catalog); applySelection(id); state.checks.delete(id); await persistSelection(id);
      setStatus('ok', 'Scan finished', `${plural(catalog.placements.length, 'item')}, ${plural(catalog.external.length, 'online link')}. Nothing was downloaded.`);
    });
    else if (action === 'check') perform('Checking folder…', async signal => {
      const catalog = state.catalogs.get(id); if (!catalog) throw new ArchiveError('Scan this course first.');
      const keys = new Set(scopeKeys(catalog, 'course'));
      const review = await prepareReview(client, catalog, destination.handle, keys, store, { signal, progress: p => setStatus('busy', 'Checking folder', `${p.checked} of ${keys.size} · ${p.title}`, { progress: { value: p.checked, max: keys.size } }) });
      state.checks.set(id, new Map(review.rows.map(r => [r.key, r])));
      const totals = summary(review.rows);
      setStatus('ok', 'Folder checked', `${totals.unchanged} up to date · ${totals.new} missing · ${totals.updates} updates · ${totals.conflicts} kept as-is. Expand Files to see each one.`);
    });
    else if (action === 'review-course') perform('Checking selected items…', signal => reviewSelection(signal, [id]));
    else if (action === 'retry') perform('Restoring failed items…', async signal => {
      const run = state.runs.get(id);
      selection(id).keys = new Set(run.report.items.filter(i => ['failed', 'cancelled'].includes(i.outcome)).map(i => i.selectionKey));
      selection(id).reconcile(new Set(scopeKeys(state.catalogs.get(id), 'course'))); // Older runs may list web pages.
      await persistSelection(id); await reviewSelection(signal, [id]);
    });
    else if (action === 'recover') perform('Restoring last selection…', async signal => {
      selection(id).keys = new Set(state.runs.get(id).selected); selection(id).reconcile(new Set(scopeKeys(state.catalogs.get(id), 'course')));
      await persistSelection(id); await reviewSelection(signal, [id]);
    });
    else if (action === 'more') {
      const key = `${id}:${button.dataset.scope}`; state.limits.set(key, (state.limits.get(key) || 100) + 100);
      button.closest('.section-body').innerHTML = sectionBody(id, button.dataset.scope); applyBusy(); updateSelection();
    } else if (action === 'report') { $('#report-content').textContent = JSON.stringify(state.runs.get(id).report, null, 2); $('#report-dialog').showModal(); }
    else if (action === 'save-report') perform('Saving report…', async () => {
      const run = state.runs.get(id); await writeJSON(destination.handle, run.reportPath, run.report); delete run.reportSaveError; await store.set(runKey(id), run);
      setStatus('ok', 'Report saved to the course folder');
    });
    else if (action === 'import') {
      const confirmed = document.querySelector(`input[data-python-origin="${id}"]`)?.checked;
      const pick = openPicker({ multiple: false, types: [{ description: 'Python download index', accept: { 'application/json': ['.json'] } }] });
      perform('Importing Python index…', async signal => {
        if (!destination) throw new ArchiveError('Choose the course folder first.');
        const [handle] = await pick, file = await handle.getFile(); if (file.size > 16 * 1024 * 1024) throw new ArchiveError('Python index exceeds the 16 MiB limit.');
        let data; try { data = JSON.parse(await file.text()); } catch { throw new ArchiveError('Python index is invalid JSON.'); }
        const imported = pythonEntries(data, id), index = await loadIndex(destination.handle, id); let checked = 0;
        for (const [path, entry] of Object.entries(imported)) { entry.originConfirmed = confirmed; await diskFile(destination.handle, path, signal); checked++; }
        if (!checked) throw new ArchiveError('No safe index entries match this course ID and folder layout.');
        index.entries = { ...index.entries, ...imported }; await writeJSON(destination.handle, INDEX_PATH, index); state.reviews = []; state.checks.delete(id);
        setStatus('ok', `Imported ${plural(checked, 'entry', 'entries')}`, 'Sync or check the folder to see which files are up to date.');
      });
    } else if (button.dataset.verify) {
      const review = state.reviews.find(r => r.catalog.course.id === id), row = review?.rows.find(r => r.key === button.dataset.verify);
      if (!row) return;
      const request = grantOrigins(requiredOrigins(review.sources), chromeAPI);
      perform('Comparing with Canvas…', async signal => {
        if (!await request) throw new ArchiveError('File hosting access was not granted.');
        const matched = await verifyExisting(client, review, row, store, signal);
        matched ? setStatus('ok', 'Contents match Canvas', 'Your file was kept and is now tracked.') : setStatus('warn', 'Contents differ from Canvas', row.reason);
      });
    }
  });
  $('#close-report').onclick = () => $('#report-dialog').close();
  window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
  if (typeof globalThis.showDirectoryPicker !== 'function' && picker.toString().includes('showDirectoryPicker')) {
    $('#capability').hidden = false; $('#capability').textContent = 'This browser can’t give the extension access to real folders, so nothing can be saved. Run the capability check under Advanced → Tools.';
  }
  await hydrate(); setConnection(state.connection); render(); restingStatus();
  const openCourse = id => showView('course', { id });
  return { state, client, store, start, tick, syncAll, syncOne, syncCourse, reviewSelection, openCourse, showView, render, renderCourses: render, stop: () => clearInterval(timer) };
}
