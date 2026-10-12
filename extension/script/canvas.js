export const ORIGIN = 'https://canvas.calpoly.edu';
export class ArchiveError extends Error {
  constructor(message, code = 'unavailable', status = 0) {
    super(message); this.name = 'ArchiveError'; this.userMessage = message; this.code = code; this.status = status;
  }
}
export const abortError = () => new DOMException('Cancelled', 'AbortError');
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function friendly(error) {
  if (error?.userMessage) return error.userMessage;
  if (error?.name === 'AbortError') return 'Cancelled or interrupted; recheck the folder before retrying.';
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'Folder or site permission was revoked. Use Renew access or reconnect.';
  if (error?.name === 'NotFoundError') return 'The folder or file is no longer accessible. Choose the destination again.';
  if (error?.name === 'QuotaExceededError') return 'Storage is full. Free space and retry.';
  if (error?.name === 'TypeMismatchError') return 'A file path is occupied by a directory, or a parent directory path by a file. Preserve it and resolve the path collision.';
  if (error?.name === 'NoModificationAllowedError') return 'The browser could not acquire a filesystem writer lock. Close other writers and recheck.';
  if (error?.name === 'NotReadableError') return 'The browser could not read this local file. It may have changed or become inaccessible; recheck the destination.';
  if (error?.name === 'UnknownError') return 'The browser filesystem operation failed (UnknownError). Check destination availability and disk space, then recheck.';
  return 'The browser/runtime operation failed. Check connectivity, folder access, and available disk space, then retry.';
}
export function apiURL(path, origin = ORIGIN) {
  if (origin !== ORIGIN) throw new ArchiveError('Only the configured Canvas origin may supply API data.', 'auth');
  const url = new URL(path, origin);
  const allowed = /^\/api\/v1\/(?:users\/self\/profile|courses|courses\/\d+(?:\/(?:modules(?:\/\d+\/items)?|files(?:\/\d+)?|folders|assignments(?:\/\d+)?|pages\/[^/]+|discussion_topics\/\d+|quizzes\/\d+))?)\/?$/;
  if (url.origin !== origin || url.username || url.password || !allowed.test(url.pathname)) {
    throw new ArchiveError('Refused an API endpoint outside the read-only course scope.');
  }
  // Never request user submissions, question data, or grade data via include parameters.
  for (const [key, value] of url.searchParams) {
    if (!['per_page', 'page', 'enrollment_type', 'enrollment_state', 'include[]', 'recursive'].includes(key)
        || (key === 'include[]' && !['term', 'content_details'].includes(value))) {
      throw new ArchiveError('Refused an unsupported API parameter.');
    }
  }
  return url.href;
}
export function parseAPI(raw) {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '').replace(/^\s*while\s*\(1\)\s*;\s*/, '')); }
  catch { throw new ArchiveError('Canvas returned a login page or invalid API data. Open Canvas / Sign in, then reconnect.', 'auth'); }
}
export function nextLink(header) {
  return /<([^>]+)>\s*;\s*rel=["']?next["']?(?:[,;\s]|$)/i.exec(header || '')?.[1] || null;
}
export async function sleep(ms, signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function boundedText(response, max = 16 * 1024 * 1024) {
  if (!response.body) throw new ArchiveError('Empty Canvas API response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new ArchiveError('Canvas API response exceeded the 16 MiB safety limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

// Executed in an isolated world of an already-open Canvas tab, never an IdP tab.
// This reads the same-origin API using the browser's session; it reads no cookies or DOM.
export async function tabAPI(url, requestId) {
  const origin = 'https://canvas.calpoly.edu';
  if (location.origin !== origin || new URL(url).origin !== origin || !new URL(url).pathname.startsWith('/api/v1/')) return { auth: true };
  const controllers = globalThis.__canvasArchiveRequests ||= new Map();
  const controller = new AbortController(); controllers.set(requestId, controller);
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) return { auth: true };
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    let raw = '', size = 0;
    if (!reader) return { network: true };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) return { oversized: true };
        raw += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { status: response.status, raw: raw + decoder.decode(), url: response.url, link: response.headers.get('Link'), retryAfter: response.headers.get('Retry-After') };
  } catch { return { network: true }; }
  finally { clearTimeout(timeout); controllers.delete(requestId); }
}
export class CanvasClient {
  constructor({ fetcher = globalThis.fetch, chromeAPI = globalThis.chrome, delay = 250, wait = sleep } = {}) {
    this.origin = ORIGIN; this.fetcher = fetcher; this.chrome = chromeAPI; this.delay = delay; this.wait = wait;
    this.transportName = 'Extension fetch'; this.verified = false; this.lastRequest = 0;
  }
  async direct(url, signal) {
    const response = await this.fetcher(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(45000)]), headers: { Accept: 'application/json' } });
    if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) return { auth: true };
    return { status: response.status, raw: await boundedText(response), url: response.url || url, link: response.headers.get('Link'), retryAfter: response.headers.get('Retry-After') };
  }
  async inTab(url, signal) {
    const id = crypto.randomUUID();
    const cancel = () => {
      this.chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: requestId => globalThis.__canvasArchiveRequests?.get(requestId)?.abort(), args: [id] }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const results = await this.chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: tabAPI, args: [url, id] });
      checkAbort(signal);
      return results[0]?.result || { network: true };
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async request(path, signal) {
    const url = apiURL(path, this.origin);
    for (let attempt = 0; attempt < 4; attempt++) {
      checkAbort(signal);
      await this.wait(Math.max(0, this.delay - (Date.now() - this.lastRequest)), signal);
      this.lastRequest = Date.now();
      let result;
      try { result = this.tabId != null ? await this.inTab(url, signal) : await this.direct(url, signal); }
      catch (error) {
        checkAbort(signal);
        if (error instanceof ArchiveError) throw error;
        result = { network: true };
      }
      if (result.auth || result.status === 401 || result.url && new URL(result.url).origin !== this.origin) {
        this.verified = false;
        throw new ArchiveError('Canvas session expired or redirected to sign-in. Open Canvas / Sign in, then reconnect.', 'auth', 401);
      }
      if (result.oversized) throw new ArchiveError('Canvas API response exceeded the 16 MiB safety limit.');
      if (result.network || result.status === 429 || result.status >= 500) {
        if (attempt < 3) {
          const after = /^\d+$/.test(result.retryAfter || '') ? Number(result.retryAfter) * 1000 : Date.parse(result.retryAfter || '') - Date.now();
          await this.wait(Math.min(30000, Math.max(0, Number.isFinite(after) ? after : 1000 * 2 ** attempt)), signal);
          continue;
        }
        throw new ArchiveError(result.status ? `Canvas HTTP ${result.status} after four attempts; retry later.` : 'Canvas network or site permission failed after four attempts. Open Canvas and reconnect.', 'network', result.status);
      }
      if (result.status < 200 || result.status >= 300) throw new ArchiveError(`Canvas HTTP ${result.status}; this endpoint or item is restricted or unavailable.`, 'restricted', result.status);
      let data;
      try { data = parseAPI(result.raw); }
      catch (error) { if (error.code === 'auth') this.verified = false; throw error; }
      if (data?.errors) throw new ArchiveError('Canvas API reported that this item is unavailable.');
      return { data, next: nextLink(result.link) };
    }
  }
  async one(path, signal) {
    const { data } = await this.request(path, signal);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ArchiveError('Canvas did not return an item.');
    return data;
  }
  async *all(path, signal) {
    const seen = new Set(); let pages = 0;
    while (path) {
      const url = apiURL(path, this.origin);
      if (seen.has(url) || ++pages > 2000) throw new ArchiveError('Canvas pagination repeated or exceeded 2,000 pages.');
      seen.add(url);
      const { data, next } = await this.request(url, signal);
      if (!Array.isArray(data)) throw new ArchiveError('Canvas did not return a list of items.');
      yield* data; path = next;
    }
  }
  async connect(signal) {
    this.verified = false; this.tabId = null; this.transportName = 'Extension fetch';
    let first;
    try { await this.verify(signal); return; } catch (error) { checkAbort(signal); first = error; }
    if (this.chrome?.tabs && this.chrome?.scripting) {
      const tabs = await this.chrome.tabs.query({ url: `${this.origin}/*` });
      for (const tab of tabs) {
        if (!tab.url || new URL(tab.url).origin !== this.origin) continue;
        this.tabId = tab.id;
        try { await this.verify(signal); this.transportName = 'Same-origin API in your Canvas tab'; return; }
        catch (error) { checkAbort(signal); first = error; }
      }
    }
    this.tabId = null;
    throw first || new ArchiveError('Open Canvas / Sign in and reconnect.', 'auth');
  }
  async verify(signal) {
    let profile;
    try { profile = await this.one('/api/v1/users/self/profile', signal); }
    catch (error) {
      if (error.status === 403) throw new ArchiveError('Canvas did not permit session API access. Open Canvas / Sign in and reconnect; if this persists, the school or browser may restrict this endpoint.', 'auth', 403);
      throw error;
    }
    if (!Number.isSafeInteger(Number(profile.id)) || Number(profile.id) <= 0 || !('name' in profile || 'short_name' in profile)) {
      throw new ArchiveError('Canvas did not return an authenticated user profile. Open Canvas / Sign in and reconnect.', 'auth');
    }
    this.verified = true; // Do not persist or log personal profile data.
  }
}
