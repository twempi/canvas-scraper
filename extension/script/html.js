import { ORIGIN } from './canvas.js';
import { relativeLink } from './names.js';
export const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cleanURL(value, base = ORIGIN) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Retain useful public resource identifiers, remove signed/auth/tracking parameters.
    const keep = new Set(url.origin === ORIGIN ? [] : ['id', 'v', 'list', 't', 'start']);
    for (const key of [...url.searchParams.keys()]) if (!keep.has(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
export function reference(value, courseId, base = ORIGIN) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== base || url.username || url.password) return null;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  let match = /^\/(?:api\/v1\/)?(?:courses\/(\d+)\/)?files\/(\d+)(?:\/(?:download|preview))?\/?$/.exec(path);
  if (match) return !match[1] || match[1] === String(courseId) ? { kind: 'File', id: match[2], key: `File:${match[2]}` } : null;
  match = /^\/(?:api\/v1\/)?courses\/(\d+)\/(pages|assignments|discussion_topics|quizzes)\/([^/]+)\/?$/.exec(path);
  if (!match || match[1] !== String(courseId)) return null;
  const kind = { pages: 'Page', assignments: 'Assignment', discussion_topics: 'Discussion', quizzes: 'Quiz' }[match[2]];
  if (kind !== 'Page' && !/^\d+$/.test(match[3])) return null;
  return { kind, id: match[3], key: `${kind}:${match[3]}` };
}
const allowed = new Set('p div span h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th a img strong em b i u br hr pre code blockquote sup sub dl dt dd figure figcaption caption section article'.split(' '));
const blocked = new Set(['script','style','iframe','object','embed','form','svg','math','template','noscript']);
const voids = new Set(['img','br','hr']);
export function bodyHTML(body, { courseId, replacements = new Map() } = {}) {
  // Template content is inert, including images. Never insert Canvas HTML into the UI.
  const template = document.createElement('template'); template.innerHTML = body || '';
  const links = new Map();
  const link = raw => {
    const clean = cleanURL(raw);
    if (clean) links.set(clean, { url: clean, ref: reference(raw, courseId) });
    return clean;
  };
  function visit(node) {
    if (node.nodeType === 3) return escapeHTML(node.textContent);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (blocked.has(tag)) {
      if (['iframe','object','embed'].includes(tag)) {
        const target = link(node.getAttribute('src') || node.getAttribute('data'));
        return target ? `<p><a href="${escapeHTML(target)}">Embedded resource (open online)</a></p>` : '';
      }
      return '';
    }
    const content = [...node.childNodes].map(visit).join('');
    if (!allowed.has(tag)) {
      const target = link(node.getAttribute('src') || node.getAttribute('href'));
      return content + (target ? `<p><a href="${escapeHTML(target)}">${escapeHTML(tag)} resource (open online)</a></p>` : '');
    }
    const attributes = [];
    for (const attribute of [...node.attributes]) {
      const { name, value } = attribute;
      if (name === 'href' || name === 'src') {
        const target = link(value);
        if (!target) continue;
        const replacement = replacements.get(target);
        if (tag === 'img' && name === 'src' && !replacement) return `<a href="${escapeHTML(target)}">${escapeHTML(node.getAttribute('alt') || 'Image')} (open online)</a>`;
        attributes.push(`${name}="${escapeHTML(replacement || target)}"`);
      } else if (['alt','title'].includes(name)) attributes.push(`${name}="${escapeHTML(value)}"`);
      else if (['colspan','rowspan','width','height'].includes(name) && /^\d{1,4}$/.test(value)) attributes.push(`${name}="${value}"`);
    }
    return `<${tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>${voids.has(tag) ? '' : content + `</${tag}>`}`;
  }
  const html = [...template.content.childNodes].map(visit).join('');
  return { html, links: [...links.values()] };
}
export function offlineDocument(title, body, courseId, sourceURL, replacements) {
  const { html } = bodyHTML(body, { courseId, replacements });
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src file: data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
    + `<title>${escapeHTML(title)}</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:17px/1.6 system-ui;color:#192d29}img{max-width:100%}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #aaa}pre{white-space:pre-wrap}a{overflow-wrap:anywhere}</style></head><body>`
    + `<h1>${escapeHTML(title)}</h1><p><a href="${escapeHTML(cleanURL(sourceURL))}">Open original in Canvas</a></p>` + html + '</body></html>';
}
export function replacementsFor(placement, catalog, selected, available = selected) {
  const replacements = new Map(), dependencies = [];
  const asset = catalog.assets[placement.assetKey];
  for (const dependency of asset.links || []) {
    if (!dependency.ref) continue;
    const candidates = catalog.placements.filter(p => p.assetKey === dependency.ref.key);
    const local = candidates.find(p => p.context === placement.context && selected.has(p.key) && available.has(p.key))
      || candidates.find(p => selected.has(p.key) && available.has(p.key));
    if (local) replacements.set(dependency.url, relativeLink(placement.path, local.path));
    else dependencies.push({ title: catalog.assets[dependency.ref.key]?.title || dependency.ref.key, url: dependency.url, reason: candidates.some(p => selected.has(p.key)) ? 'Selected dependency is unavailable; kept online.' : 'Dependency is not selected; kept online.' });
  }
  return { replacements, dependencies };
}
