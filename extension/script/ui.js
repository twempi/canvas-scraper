import { CanvasClient, ORIGIN, ArchiveError, friendly } from './canvas.js';
import { Store, destinationKey, permission, renew } from './store.js';
import { listCourses, scanCourse, scanKey, coursePrevious } from './scan.js';
import { Selection } from './selection.js';
import { escapeHTML as e } from './html.js';
import { prepareReview, summary, runJob, runKey, verifyExisting, preserveState } from './jobs.js';
import { requiredOrigins, grantOrigins, downloadURL } from './download.js';
import { loadIndex, pythonEntries, writeJSON, INDEX_PATH, diskFile } from './filesystem.js';
export const formatBytes = bytes => bytes == null ? 'Size unknown' : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
export function scopeKeys(catalog, scope) {
  return (catalog?.placements || []).filter(p => scope === 'course' || scope === 'modules' && p.context.startsWith('module:') || scope === 'assignments' && (p.context === 'assignments' || catalog.assets[p.assetKey].kind === 'Assignment') || scope === 'files' && p.context === 'files' || p.context === scope).map(p => p.key);
}
export async function mount({ client = new CanvasClient(), store = new Store(), picker = options => showDirectoryPicker(options), openPicker = options => showOpenFilePicker(options), chromeAPI = globalThis.chrome } = {}) {
  const $ = selector => document.querySelector(selector);
  const state = { courses: await store.get('courses') || [], catalogs: new Map(), destinations: new Map(), selections: new Map(), checks: new Map(), runs: new Map(), expanded: new Set(), limits: new Map(), policies: new Map(), reviews: [], busy: false };
  let controller;
  const selection = id => state.selections.get(id) || new Selection();
  const say = message => { $('#status').textContent = message; };
  function busy(value) {
    state.busy = value;
    document.querySelectorAll('button, input, select').forEach(element => {
      if (!['cancel','close-report'].includes(element.id)) element.disabled = value || element.dataset.unavailable === 'true';
    });
    $('#cancel').hidden = !value;
  }
  async function perform(label, callback) {
    if (state.busy) return;
    controller = new AbortController(); busy(true); say(label);
    try { await callback(controller.signal); }
    catch (error) {
      if (error.code === 'auth') { client.verified = false; $('#connection').textContent = 'Sign in required'; $('#connection').classList.remove('connected'); }
      say(friendly(error));
    } finally { busy(false); updateSelection(); }
  }
  function invalidate() { state.reviews = []; $('#review-panel').hidden = true; }
  function checkState(id, key) { return state.checks.get(id)?.get(key)?.state || 'Not checked'; }
  function checkbox(id, key, scope, title) {
    const checked = scope ? selection(id).state(scopeKeys(state.catalogs.get(id), scope)).checked : selection(id).keys.has(key);
    return `<input type="checkbox" data-course="${e(id)}" ${scope ? `data-scope="${e(scope)}"` : `data-item="${e(key)}"`} aria-label="${e(title)}" ${checked ? 'checked' : ''}>`;
  }
  function materialRows(id, scope) {
    const catalog = state.catalogs.get(id), keys = scopeKeys(catalog, scope), limitKey = `${id}:${scope}`, limit = state.limits.get(limitKey) || 100;
    const placements = catalog.placements.filter(p => keys.includes(p.key));
    const rows = placements.slice(0, limit).map(p => {
      const asset = catalog.assets[p.assetKey], status = p.unavailable || asset.unavailable ? 'Unavailable' : checkState(id,p.key);
      const module = catalog.modules.find(m => p.context === `module:${m.id}`);
      return `<div class="material-row"><label class="material-label">${checkbox(id,p.key,null,`Select ${asset.title} in ${module?.name || p.context}`)}<span><span class="material-title">${e(asset.title)}</span><span class="muted small">${e(asset.kind === 'File' ? 'Original file' : asset.kind + ' · offline HTML')} · Canvas ${e(asset.id)}${scope === 'assignments' && module ? ' · ' + e(module.name) : ''}</span></span></label><span class="size">${formatBytes(asset.size)}</span><span class="badge ${status === 'Unavailable' ? 'warn' : ''}" title="${e(state.checks.get(id)?.get(p.key)?.reason || p.unavailable || asset.unavailable || 'Recheck to inspect the actual selected folder.')}">${e(status)}</span><a href="${e(asset.sourceURL)}" target="_blank" rel="noreferrer" aria-label="${e('Open ' + asset.title + ' in Canvas')}">↗</a></div>`;
    }).join('');
    return rows + (placements.length > limit ? `<button data-action="more" data-course="${e(id)}" data-scope="${e(scope)}">Show next ${Math.min(100,placements.length-limit)} of ${placements.length} items</button>` : '') + (!placements.length ? '<p class="muted">No materials discovered in this section.</p>' : '');
  }
  function group(id, scope, title, contents) {
    const key = `${id}:${scope}`, open = state.expanded.has(key), count = scopeKeys(state.catalogs.get(id),scope).length;
    return `<details class="content-section" data-expand="${e(key)}" data-course="${e(id)}" data-scope="${e(scope)}" ${open ? 'open' : ''}><summary><span>${e(title)}</span><span class="muted small">${count} items</span></summary><div class="section-body">${open ? sectionBody(id, scope, contents) : ''}</div></details>`;
  }
  function sectionBody(id, scope) {
    const catalog = state.catalogs.get(id), keys = scopeKeys(catalog,scope);
    let content = scope === 'modules' ? catalog.modules.map(m => group(id,`module:${m.id}`,`${String(m.position).padStart(2,'0')} · ${m.name}`)).join('') : materialRows(id,scope);
    if (scope === 'modules' && !catalog.modules.length) content = '<p class="muted">No accessible modules discovered.</p>';
    return `<div class="section-actions"><label class="check-label">${checkbox(id,null,scope,`Select all ${keys.length} items in ${scope}`)}Select all ${keys.length}</label><button data-action="clear-section" data-course="${e(id)}" data-scope="${e(scope)}">Clear section</button></div>` + content;
  }
  function renderCourses() {
    const query = $('#search').value.toLowerCase();
    const courses = state.courses.filter(c => ($('#previous').checked || !coursePrevious(c)) && `${c.name} ${c.code} ${c.term?.name}`.toLowerCase().includes(query));
    $('#courses').innerHTML = courses.map(c => {
      const id = c.id, catalog = state.catalogs.get(id), destination = state.destinations.get(id), run = state.runs.get(id);
      const keys = scopeKeys(catalog,'course');
      const coverage = catalog?.coverage.length ? `
        <div class="notice"><strong>Coverage limitations</strong><ul>
          ${catalog.coverage.map(v=>`<li>${e(v.section)}: ${e(v.reason)}</li>`).join('')}
        </ul></div>` : '';
      const external = catalog?.external.length ? `
        <details class="external"><summary>${catalog.external.length} online resources and unsupported links</summary><ul>
          ${catalog.external.map(v=>`<li>${e(v.title)} — ${e(v.reason)} ${v.url ? `<a href="${e(v.url)}" target="_blank" rel="noreferrer">Open online ↗</a>` : ''}</li>`).join('')}
        </ul></details>` : '';
      const report = run ? `
        <button data-action="report" data-course="${e(id)}">View latest report</button>
        <button data-action="recover" data-course="${e(id)}">Restore last selection and recheck</button>
        ${run.reportSaveError ? `<button data-action="save-report" data-course="${e(id)}">Save report again</button><p class="notice">Report is retained locally, but could not be saved to the course folder: ${e(run.reportSaveError)}</p>` : ''}
        ${run.report.status === 'running' ? '<p class="notice">Previous job was interrupted. Recheck the last selection before retrying.</p>' : ''}` : '';
      return `<article class="course-card" data-card="${e(id)}">
        <div class="course-heading">
          <div class="course-name">
            <input type="checkbox" data-course="${e(id)}" data-scope="course" aria-label="${e('Select course ' + c.name)}" ${!catalog ? 'disabled data-unavailable="true"' : ''}>
            <div><h2>${e(c.name)}</h2><p class="muted">${e(c.code || 'No course code')} · ${e(c.term?.name || 'Term unavailable')} · Course ${e(id)}${coursePrevious(c) ? ' · Previous course' : ''}</p></div>
          </div>
          <button data-action="scan" data-course="${e(id)}">${catalog ? 'Rescan course' : 'Scan materials'}</button>
        </div>
        <div class="destination">
          <div><span class="eyebrow">COURSE DESTINATION</span><p>
            ${destination ? `<strong>${e(destination.handle.name)}</strong>${destination.label ? ' · ' + e(destination.label) : ''} <span class="badge">${destination.granted ? 'Access granted' : 'Renew access'}</span>` : 'Choose a real folder for this course.'}
          </p></div>
          <div class="actions">
            <button data-action="choose" data-course="${e(id)}">${destination ? 'Change folder' : 'Choose folder'}</button>
            ${destination ? `<button data-action="renew" data-course="${e(id)}">Renew access</button><button data-action="check" data-course="${e(id)}">Check destination</button>` : ''}
          </div>
        </div>
        ${destination ? `<label class="destination-label">Optional destination label<input data-label="${e(id)}" value="${e(destination.label || '')}" placeholder="Your label; the browser only reveals the folder name"></label>` : ''}
        <div class="course-meta">${catalog ? `${keys.length} destinations discovered · Scanned ${e(new Date(catalog.scannedAt).toLocaleString())} · ${selection(id).keys.size} selected` : 'Scanning discovers materials. It does not download them.'}</div>
        ${catalog ? group(id,'modules','Modules') + group(id,'assignments','Assignments') + group(id,'files','Other course files') + coverage + external : ''}
        <details class="course-tools"><summary>Python index and reports</summary>
          <p class="muted">Python normally keeps its index above the course folder. Import that JSON file explicitly; all paths are reconciled against this destination. Its missing origin information requires verification unless you confirm its Canvas origin.</p>
          <label class="check-label"><input data-python-origin="${e(id)}" type="checkbox">This Python index came from canvas.calpoly.edu</label>
          <button data-action="import" data-course="${e(id)}">Import Python index</button>${report}
        </details>
      </article>`;
    }).join('') || `<div class="empty"><h2>${state.courses.length ? 'No matching courses' : 'Start with your Canvas session'}</h2><p>${state.courses.length ? 'Try another search or show previous courses.' : 'Open Canvas, complete your normal Cal Poly login, then click Connect / Refresh.'}</p></div>`;
    updateSelection();
  }
  function updateSelection() {
    let count = 0; state.selections.forEach(s => { count += s.keys.size; });
    $('#selected-count').textContent = `${count} item${count === 1 ? '' : 's'} selected`;
    document.querySelectorAll('input[data-scope]').forEach(input => {
      const group = selection(input.dataset.course).state(scopeKeys(state.catalogs.get(input.dataset.course),input.dataset.scope));
      input.checked = group.checked; input.indeterminate = group.indeterminate;
    });
    document.querySelectorAll('input[data-item]').forEach(input => { input.checked = selection(input.dataset.course).keys.has(input.dataset.item); });
    $('#review').disabled = state.busy || !count;
  }
  async function persistSelection(id) { await store.set(`selection:${ORIGIN}:${id}`, [...selection(id).keys]); }
  async function hydrate() {
    for (const c of state.courses) {
      const catalog = await store.get(scanKey(c.id)), destination = await store.get(destinationKey(ORIGIN,c.id)), run = await store.get(runKey(c.id));
      if (catalog) state.catalogs.set(c.id,catalog);
      if (destination) { destination.granted = await permission(destination.handle).catch(()=>false); state.destinations.set(c.id,destination); }
      if (run) state.runs.set(c.id,run);
      const s = new Selection(await store.get(`selection:${ORIGIN}:${c.id}`) || []);
      s.reconcile(new Set(scopeKeys(catalog,'course'))); state.selections.set(c.id,s);
    }
  }
  async function reviewSelection(signal) {
    state.reviews = [];
    for (const c of state.courses) {
      const selected = selection(c.id).keys;
      if (!selected.size) continue;
      const destination = state.destinations.get(c.id);
      if (!destination) throw new ArchiveError(`Choose a destination folder for ${c.code || c.name} first.`);
      if (!await permission(destination.handle)) throw new ArchiveError(`Renew folder access for ${c.code || c.name}, then recheck.`, 'permission');
      const catalog = state.catalogs.get(c.id);
      const review = await prepareReview(client,catalog,destination.handle,selected,store,{ signal, policies: state.policies, progress: p=>say(`Checking ${c.code || c.name}: ${p.checked} items · ${p.title}`) });
      state.reviews.push(review); state.checks.set(c.id,new Map(review.rows.map(r=>[r.key,r])));
    }
    if (!state.reviews.length) throw new ArchiveError('Select at least one discovered material first.');
    renderReview(); renderCourses(); say('Review ready. Only the displayed selected items will be processed.');
    $('#review-title').focus(); $('#review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderReview() {
    const rows = state.reviews.flatMap(r=>r.rows), totals = summary(rows);
    let bytes = 0, unknown = 0;
    for (const review of state.reviews) for (const row of review.rows) if (row.state === 'Missing' || row.state === 'Remote update available' || row.policy === 'replace' && preserveState(row.state)) {
      const size = review.catalog.assets[row.assetKey].size; size == null ? unknown++ : bytes += size;
    }
    $('#review-summary').textContent = `${rows.length} items across ${state.reviews.length} course(s): ${totals.new} new · ${totals.unchanged} unchanged · ${totals.updates} updates · ${totals.conflicts} unverified/conflicts · ${totals.unavailable} unavailable. Estimated transfers: ${formatBytes(bytes)}${unknown ? ` plus ${unknown} unknown sizes` : ''}.`;
    $('#review-rows').innerHTML = state.reviews.map(review => review.rows.map(row => {
      const asset = review.catalog.assets[row.assetKey], courseId = review.catalog.course.id;
      const module = review.catalog.modules.find(m=>row.context === `module:${m.id}`);
      return `<tr><td><strong>${e(asset.title)}</strong><span class="muted small">${e(review.catalog.course.code || review.catalog.course.name)} · ${e(module?.name || row.context)} · Canvas ${e(asset.id)}</span><code>${e(row.path)}</code>${row.dependencies.length ? `<details class="dependencies"><summary>${row.dependencies.length} dependencies stay online</summary><ul>${row.dependencies.map(d=>`<li>${e(d.title)} — ${e(d.reason)} <a href="${e(d.url)}" target="_blank" rel="noreferrer">Open ↗</a></li>`).join('')}</ul></details>` : ''}</td><td><span class="badge">${e(row.state)}</span><p class="small">${e(row.reason)}</p></td><td>${preserveState(row.state) ? `<label>Existing file action<select data-policy="${e(row.key)}" data-course="${e(courseId)}"><option value="preserve" ${row.policy === 'preserve' ? 'selected' : ''}>Preserve — skip</option><option value="replace" ${row.policy === 'replace' ? 'selected' : ''}>Replace this file</option></select></label><button data-verify="${e(row.key)}" data-course="${e(courseId)}">Verify contents</button>` : e(row.state === 'Unchanged' ? 'Skip unchanged' : row.state === 'Unavailable' ? 'Report unavailable' : 'Download')}</td></tr>`;
    }).join('')).join('');
    $('#review-panel').hidden = false;
  }
  $('#connect').onclick = () => perform('Checking authenticated Canvas API…',async signal=>{
    invalidate(); await client.connect(signal); state.courses = await listCourses(client,signal); await store.set('courses',state.courses); await hydrate();
    $('#connection').textContent = 'Connected to Canvas'; $('#connection').classList.add('connected'); renderCourses(); say(`Connected · ${client.transportName}. ${state.courses.length} courses available. ${(client.courseListWarnings || []).join(' ')}`);
  });
  $('#search').oninput = renderCourses; $('#previous').onchange = renderCourses;
  $('#clear').onclick = async () => { for (const [id,s] of state.selections) { s.keys.clear(); await persistSelection(id); } invalidate(); updateSelection(); };
  $('#review').onclick = () => perform('Checking selected destinations…',reviewSelection);
  $('#cancel').onclick = () => { controller?.abort(); say('Cancelling… Completed files are retained; recheck before retrying.'); };
  $('#close-review').onclick = () => { $('#review-panel').hidden = true; };
  $('#start').onclick = () => {
    const originals = new Map(); state.reviews.forEach(r=>r.sources.forEach((source,key)=>originals.set(`${r.catalog.course.id}:${key}`,source)));
    const permissionRequest = grantOrigins(requiredOrigins(originals),chromeAPI);
    perform('Starting reviewed downloads…',async signal=>{
      if (!await permissionRequest) throw new ArchiveError('Download hosting access was not granted. Selection is retained.');
      if (!state.reviews.length) throw new ArchiveError('Recheck your selection before starting.');
      if (!navigator.locks) throw new ArchiveError('This browser lacks the job-lock API. Capability verification is required.');
      await navigator.locks.request('canvas-local-archive-job',{ ifAvailable: true },async lock=>{
        if (!lock) throw new ArchiveError('Another extension tab is processing a job. Finish or cancel it first.');
        $('#progress-panel').hidden = false; $('#job-results').textContent = '';
        for (const review of state.reviews) {
          const id = review.catalog.course.id;
          const journal = await runJob(client,review,store,{ signal, progress: p=>{
            const counts = p.report.counts, completed = Object.values(counts).reduce((a,b)=>a+b,0);
            $('#job-progress').max = p.total || 1; $('#job-progress').value = completed;
            $('#job-counts').textContent = `${review.catalog.course.code || review.catalog.course.name}: ${counts.downloaded} downloaded · ${counts.skipped} skipped · ${counts.failed} failed · ${counts.cancelled} cancelled${p.title ? ` · ${p.title}: ${formatBytes(p.bytes)}` : ''}`;
          } });
          state.runs.set(id,journal);
          state.checks.delete(id);
          const result = document.createElement('p'); result.textContent = `${review.catalog.course.code || review.catalog.course.name}: ${journal.report.status}. Report: ${journal.reportPath}${journal.reportSaveError ? ' (retained in browser storage; folder save failed)' : ''}`; $('#job-results').append(result);
        }
      });
      if (!client.verified) { $('#connection').textContent = 'Sign in required'; $('#connection').classList.remove('connected'); }
      renderCourses(); invalidate(); say(signal.aborted ? 'Cancelled. Restore the last selection and recheck to recover.' : 'Job finished. Review per-course reports for skipped items and coverage limitations.');
    });
  };
  $('#retry').onclick = () => perform('Restoring failed selections…',async signal=>{
    for (const [id,run] of state.runs) {
      selection(id).keys.clear(); run.report.items.filter(i=>['failed','cancelled'].includes(i.outcome)).forEach(i=>selection(id).set(i.selectionKey,true)); await persistSelection(id);
    }
    await reviewSelection(signal);
  });
  $('#grant-host').onclick = () => {
    let url;
    try { url = downloadURL($('#host-origin').value); if (url.pathname !== '/' || url.search || url.hash) throw new Error(); }
    catch { say('Enter an HTTPS hosting origin without a path or query.'); return; }
    const request = grantOrigins([`${url.origin}/*`],chromeAPI);
    perform('Requesting download host access…',async()=>say(await request ? `Access granted for ${url.hostname}. Recheck and retry the selected file.` : 'Host access was not granted.'));
  };
  document.addEventListener('change',event=>{
    const input = event.target, id = input.dataset.course;
    if (input.dataset.item || input.dataset.scope && input.type === 'checkbox') {
      if (input.dataset.item) selection(id).set(input.dataset.item,input.checked);
      else selection(id).group(scopeKeys(state.catalogs.get(id),input.dataset.scope),input.checked);
      invalidate(); updateSelection(); persistSelection(id).catch(()=>say('Selection could not be saved locally. Keep this tab open.'));
    }
    if (input.dataset.label) {
      const destination = state.destinations.get(input.dataset.label); destination.label = input.value.slice(0,500);
      store.set(destinationKey(ORIGIN,input.dataset.label),{ handle: destination.handle, label: destination.label }).catch(()=>say('Destination label could not be saved.'));
    }
    if (input.dataset.policy) {
      state.policies.set(input.dataset.policy,input.value);
      const row = state.reviews.find(r=>r.catalog.course.id === id)?.rows.find(r=>r.key === input.dataset.policy);
      if (row) { row.policy = input.value; renderReview(); }
    }
  });
  document.addEventListener('toggle',event=>{
    const details = event.target;
    if (!details.dataset.expand) return;
    details.open ? state.expanded.add(details.dataset.expand) : state.expanded.delete(details.dataset.expand);
    if (details.open) details.querySelector(':scope > .section-body').innerHTML = sectionBody(details.dataset.course,details.dataset.scope);
    updateSelection();
  },true);
  document.addEventListener('click',event=>{
    const button = event.target.closest('button[data-action], button[data-verify]'); if (!button || state.busy) return;
    const id = button.dataset.course, course = state.courses.find(c=>c.id === id), destination = state.destinations.get(id), action = button.dataset.action;
    if (action === 'choose') {
      // Picker must happen before asynchronous work to preserve user activation.
      const pick = picker({ mode: 'readwrite', id: `course-${id}`.slice(0,32) });
      perform('Choosing course folder…',async()=>{
        const handle = await pick;
        for (const [otherId,d] of state.destinations) if (otherId !== id && await handle.isSameEntry(d.handle)) throw new ArchiveError('This folder is already associated with another course. Choose a separate folder.');
        await loadIndex(handle,id); // Reject a folder containing a different course's index.
        const value = { handle, label: '' }; await store.set(destinationKey(ORIGIN,id),value);
        value.granted = await permission(handle); state.destinations.set(id,value); state.checks.delete(id); invalidate(); renderCourses(); say(`Chosen ${handle.name} as the root for ${course.code || course.name}. No extra course directory will be created.`);
      });
    } else if (action === 'renew') {
      const request = renew(destination.handle);
      perform('Renewing folder access…',async()=>{ destination.granted = await request; invalidate(); renderCourses(); say(destination.granted ? 'Folder access renewed. Recheck before downloading.' : 'Folder access was not granted. You can choose another folder.'); });
    } else if (action === 'scan') perform(`Scanning ${course.name}…`,async signal=>{
      invalidate(); const catalog = await scanCourse(client,course,store,{ signal, progress:p=>say(`${course.code || course.name}: ${p.discovered} materials discovered · ${p.title}`) });
      state.catalogs.set(id,catalog); selection(id).reconcile(new Set(scopeKeys(catalog,'course'))); state.checks.delete(id); await persistSelection(id); renderCourses(); say(`Scan finished: ${catalog.placements.length} destinations, ${catalog.external.length} online resources, ${catalog.coverage.length} coverage limitations. Select the materials you want.`);
    });
    else if (action === 'check') perform('Inspecting course destination…',async signal=>{
      const catalog = state.catalogs.get(id); if (!catalog) throw new ArchiveError('Scan this course before checking destinations.');
      const review = await prepareReview(client,catalog,destination.handle,new Set(scopeKeys(catalog,'course')),store,{ signal, progress:p=>say(`Checking destination: ${p.checked} · ${p.title}`) });
      state.checks.set(id,new Map(review.rows.map(r=>[r.key,r]))); renderCourses(); say('Disk statuses refreshed. Selection was preserved.');
    });
    else if (action === 'clear-section') { selection(id).group(scopeKeys(state.catalogs.get(id),button.dataset.scope),false); invalidate(); updateSelection(); persistSelection(id); }
    else if (action === 'more') { const key = `${id}:${button.dataset.scope}`; state.limits.set(key,(state.limits.get(key) || 100) + 100); button.closest('.section-body').innerHTML = sectionBody(id,button.dataset.scope); updateSelection(); }
    else if (action === 'report') { $('#report-content').textContent = JSON.stringify(state.runs.get(id).report,null,2); $('#report-dialog').showModal(); }
    else if (action === 'recover') perform('Restoring interrupted selection…',async signal=>{
      selection(id).keys = new Set(state.runs.get(id).selected); selection(id).reconcile(new Set(scopeKeys(state.catalogs.get(id),'course'))); await persistSelection(id); await reviewSelection(signal);
    });
    else if (action === 'save-report') perform('Saving course report…',async()=>{ const run = state.runs.get(id); await writeJSON(destination.handle,run.reportPath,run.report); delete run.reportSaveError; await store.set(runKey(id),run); renderCourses(); say('Report saved to the course folder.'); });
    else if (action === 'import') {
      const confirmed = document.querySelector(`input[data-python-origin="${id}"]`).checked;
      const pick = openPicker({ multiple: false, types: [{ description: 'Python download index', accept: { 'application/json': ['.json'] } }] });
      perform('Reconciling Python index…',async signal=>{
        if (!destination) throw new ArchiveError('Choose the course destination first.');
        const [handle] = await pick, file = await handle.getFile(); if (file.size > 16 * 1024 * 1024) throw new ArchiveError('Python index exceeds the 16 MiB limit.');
        let data; try { data = JSON.parse(await file.text()); } catch { throw new ArchiveError('Python index is invalid JSON.'); }
        const imported = pythonEntries(data,id), index = await loadIndex(destination.handle,id); let checked = 0;
        for (const [path,entry] of Object.entries(imported)) { entry.originConfirmed = confirmed; await diskFile(destination.handle,path,signal); checked++; }
        if (!checked) throw new ArchiveError('No safe index entries match this course ID and relative layout.');
        index.entries = { ...index.entries, ...imported }; await writeJSON(destination.handle,INDEX_PATH,index); invalidate(); state.checks.delete(id); renderCourses(); say(`Imported ${checked} entries and checked their files in this destination. Recheck to see unchanged, missing, or conflict states.`);
      });
    } else if (button.dataset.verify) {
      const review = state.reviews.find(r=>r.catalog.course.id === id), row = review?.rows.find(r=>r.key === button.dataset.verify);
      if (!row) return;
      const request = grantOrigins(requiredOrigins(review.sources),chromeAPI);
      perform('Verifying local and current remote contents…',async signal=>{
        if (!await request) throw new ArchiveError('File hosting access was not granted.');
        const matched = await verifyExisting(client,review,row,store,signal); renderReview(); say(matched ? 'Contents match the remote material. The local file was preserved and indexed.' : row.reason);
      });
    }
  });
  $('#close-report').onclick = () => $('#report-dialog').close();
  window.addEventListener('beforeunload',event=>{ if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
  if (typeof globalThis.showDirectoryPicker !== 'function' && picker.toString().includes('showDirectoryPicker')) {
    $('#capability').hidden = false; $('#capability').textContent = 'Real folder access is unavailable in this browser. Run the capability check. Downloads cannot proceed here; an optional native messaging helper would be the smallest alternative (not included).';
  }
  await hydrate(); renderCourses();
  return { state, client, store, reviewSelection, renderCourses };
}
