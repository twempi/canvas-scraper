import { ORIGIN, ArchiveError, checkAbort, sleep } from './canvas.js';
import { fileRestricted, fileVersion } from './scan.js';
export function downloadURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new ArchiveError('Canvas supplied an invalid download URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || ['idp.calpoly.edu','login.microsoftonline.com'].includes(url.hostname)) throw new ArchiveError('Refused an insecure or identity-provider download URL.');
  return url;
}
export async function fileSource(client, courseId, asset, signal) {
  const meta = await client.one(`/api/v1/courses/${courseId}/files/${asset.id}`, signal);
  // Retrieve permitted metadata before reporting a restriction; keep useful names.
  asset.title = meta.filename || meta.display_name || asset.title;
  if (fileRestricted(meta)) throw new ArchiveError('This file is locked for your account.', 'restricted');
  if (!meta.url) throw new ArchiveError('Canvas supplied no download URL for this file.');
  const url = downloadURL(meta.url);
  return { url: url.href, filename: meta.filename || meta.display_name || asset.filename || asset.id, remote: fileVersion(meta), contentType: meta['content-type'] || meta.content_type || asset.contentType };
}
export function requiredOrigins(sources) {
  return [...new Set([...sources.values()].map(source => downloadURL(source.url).origin).filter(origin => origin !== ORIGIN))].map(origin => `${origin}/*`);
}
export async function grantOrigins(origins, chromeAPI = globalThis.chrome) {
  // Invoke immediately inside the Start or Verify button gesture.
  if (!origins.length || !chromeAPI?.permissions) return true;
  return chromeAPI.permissions.request({ origins });
}
function validateResponse(response, source) {
  const final = downloadURL(response.url || source.url);
  if (final.origin === ORIGIN && /\/(?:login|signin)(?:\/|$)/i.test(final.pathname)) throw new ArchiveError('File request returned a Canvas sign-in page. Open Canvas and reconnect.', 'auth');
  const type = (response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  if ((type === 'text/html' || type === 'application/xhtml+xml') && !['text/html','application/xhtml+xml'].includes((source.contentType || '').split(';')[0].toLowerCase())) throw new ArchiveError('File request returned HTML instead of the original file; session or download access may have expired.', 'auth');
}
// The same-origin fallback streams from your already-open Canvas tab in bounded chunks.
// No browser automation, cookie reads, tokens, DOM access, or persistent background job.
export async function tabFile(operation, requestId, url) {
  const origin = 'https://canvas.calpoly.edu';
  if (location.origin !== origin) return { auth: true };
  const streams = globalThis.__canvasArchiveStreams ||= new Map();
  try {
    if (operation === 'open') {
      const target = new URL(url);
      if (target.origin !== origin || !/^\/(?:courses\/\d+\/)?files\/\d+\/(?:download|preview)\/?$/.test(target.pathname)) return { error: 'Unsupported same-origin file URL.' };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
      streams.set(requestId, { controller });
      let response;
      try { response = await fetch(url, { credentials: 'same-origin', redirect: 'follow', cache: 'no-store', signal: controller.signal }); }
      finally { clearTimeout(timer); }
      const final = new URL(response.url);
      if (final.protocol !== 'https:' || ['idp.calpoly.edu','login.microsoftonline.com'].includes(final.hostname)) { controller.abort(); streams.delete(requestId); return { auth: true }; }
      if (!response.ok || !response.body) { controller.abort(); streams.delete(requestId); return { status: response.status, retryAfter: response.headers.get('Retry-After') }; }
      streams.set(requestId, { controller, reader: response.body.getReader(), pending: null });
      return { status: response.status, contentType: response.headers.get('Content-Type') };
    }
    const state = streams.get(requestId);
    if (!state) return { error: 'File stream was interrupted; recheck and retry.' };
    if (operation === 'cancel') {
      state.controller.abort(); await state.reader?.cancel().catch(() => {}); streams.delete(requestId); return { done: true };
    }
    let bytes = state.pending;
    if (!bytes) {
      const timer = setTimeout(() => state.controller.abort(), 60000);
      let chunk;
      try { chunk = await state.reader.read(); } finally { clearTimeout(timer); }
      if (chunk.done) { streams.delete(requestId); return { done: true }; }
      bytes = chunk.value;
    }
    state.pending = bytes.length > 128 * 1024 ? bytes.subarray(128 * 1024) : null;
    return { bytes: Array.from(bytes.subarray(0, 128 * 1024)) };
  } catch {
    const state = streams.get(requestId); state?.controller.abort(); streams.delete(requestId);
    return { error: 'Same-origin file stream failed; access or CORS may be unavailable.' };
  }
}
async function openTabFile(client, source, signal) {
  const id = crypto.randomUUID();
  const call = async operation => {
    const result = await client.chrome.scripting.executeScript({ target: { tabId: client.tabId }, func: tabFile, args: [operation, id, operation === 'open' ? source.url : null] });
    return result[0]?.result;
  };
  const cancel = () => call('cancel').catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await call('open'); checkAbort(signal);
    if (result?.auth || result?.status === 401) throw new ArchiveError('Canvas file access requires sign-in. Open Canvas and reconnect.', 'auth');
    if (!result || result.error || result.status < 200 || result.status >= 300) {
      const error = new ArchiveError(result?.error || `Canvas file HTTP ${result?.status || 0}; access unavailable.`, result?.error || !result ? 'network' : 'restricted', result?.status);
      error.retryAfter = result?.retryAfter; throw error;
    }
    validateResponse({ url: source.url, headers: new Headers({ 'Content-Type': result.contentType || '' }) }, source);
    return new ReadableStream({
      async pull(controller) {
        try {
          checkAbort(signal); const chunk = await call('read'); checkAbort(signal);
          if (!chunk || chunk.error || chunk.auth) throw new ArchiveError(chunk?.error || 'Canvas tab closed or signed out during file download.');
          if (chunk.done) { signal?.removeEventListener('abort', cancel); controller.close(); }
          else controller.enqueue(new Uint8Array(chunk.bytes));
        } catch (error) { signal?.removeEventListener('abort', cancel); await cancel(); controller.error(error); }
      },
      async cancel() { signal?.removeEventListener('abort', cancel); await cancel(); }
    }, { highWaterMark: 1 });
  } catch (error) { signal?.removeEventListener('abort', cancel); await cancel(); throw error; }
}
export async function openFileStream(client, source, signal) {
  const url = downloadURL(source.url);
  // If Connect used the Canvas tab because cookies are blocked, use that same session.
  if (client.tabId != null && url.origin === ORIGIN) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await openTabFile(client, source, signal); }
      catch (error) {
        checkAbort(signal);
        if (attempt === 3 || !(error.code === 'network' || error.status === 429 || error.status >= 500)) throw error;
        await sleep(Math.min(30000, /^\d+$/.test(error.retryAfter || '') ? Number(error.retryAfter) * 1000 : 1000 * 2 ** attempt), signal);
      }
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    checkAbort(signal);
    let response;
    try {
      response = await client.fetcher(url.href, { method: 'GET', credentials: url.origin === ORIGIN ? 'include' : 'omit', redirect: 'follow', cache: 'no-store', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10 * 60 * 1000)]) });
      if (response.status === 429 || response.status >= 500) {
        const raw = response.headers.get('Retry-After');
        await response.body?.cancel();
        if (attempt < 3) { await sleep(Math.min(30000, /^\d+$/.test(raw || '') ? Number(raw) * 1000 : 1000 * 2 ** attempt), signal); continue; }
      }
      if (response.status === 401) throw new ArchiveError('Canvas file session expired. Open Canvas and reconnect.', 'auth');
      if (!response.ok || !response.body) throw new ArchiveError(`File HTTP ${response.status}; content is restricted or unavailable.`);
      validateResponse(response, source);
      return response.body;
    } catch (error) {
      await response?.body?.cancel().catch(() => {}); checkAbort(signal);
      if (error instanceof ArchiveError) throw error;
      if (attempt < 3) { await sleep(1000 * 2 ** attempt, signal); continue; }
      throw new ArchiveError('File fetch failed after retries. The signed download URL, hosting permission, or CORS may be unavailable. Reconnect and rescan; see download-host troubleshooting.');
    }
  }
}
