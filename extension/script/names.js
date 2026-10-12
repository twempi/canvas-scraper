// Match reference/python/canvas_download.py: safe_name uses Unicode code points.
export function safeName(value) {
  let name = String(value).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  name = [...name].slice(0, 130).join('').replace(/[ .]+$/g, '') || 'untitled';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
// Linux commonly limits a component to 255 UTF-8 bytes. Keep IDs and trim the title.
// For ordinary names this exactly matches Python; long Unicode names get a stable hash.
export function component(value) {
  const name = safeName(value), encoder = new TextEncoder();
  if (encoder.encode(name).length <= 210) return name;
  let hash = 2166136261;
  for (const byte of encoder.encode(name)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  let result = '';
  for (const char of name) {
    if (encoder.encode(result + char).length > 195) break;
    result += char;
  }
  return `${result}~${hash.toString(16).padStart(8, '0')}`;
}
export const moduleFolder = module => `${String(Number.isFinite(Number(module.position)) ? Math.trunc(Number(module.position)) : 0).padStart(2, '0')}__${module.id}__${component(module.name || module.id)}`;
export const fileName = asset => {
  const original = safeName(asset.filename || asset.id);
  const extension = /\.[a-z0-9]{1,10}$/i.exec(original)?.[0] || '';
  const name = new TextEncoder().encode(original).length > 210 && extension ? component(original.slice(0,-extension.length)) + extension : component(original);
  return `${asset.id}__${name}`;
};
function fitFilename(name, extension = '') {
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= 255) return name;
  let hash = 2166136261;
  for (const byte of encoder.encode(name)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  const suffix = `~${hash.toString(16).padStart(8, '0')}${extension}`;
  let prefix = '';
  for (const char of name) {
    if (encoder.encode(prefix + char + suffix).length > 255) break;
    prefix += char;
  }
  return prefix + suffix;
}
export const documentName = (courseId, asset) => fitFilename(`${asset.kind.toLowerCase()}_${courseId}_${component(asset.id)}__${component(asset.title || asset.id)}.html`, '.html');
export function pathParts(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid relative path');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || new TextEncoder().encode(p).length > 255)) throw new Error('Invalid relative path component');
  return parts;
}
export function relativeLink(fromPath, toPath) {
  const from = pathParts(fromPath).slice(0, -1), to = pathParts(toPath);
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to.map(encodeURIComponent)].join('/');
}
export function uniqueDocumentNames(assets, courseId) {
  const used = new Map(), names = new Map();
  for (const asset of [...assets].sort((a, b) => a.key.localeCompare(b.key))) {
    let name = documentName(courseId, asset);
    const folded = value => value.normalize('NFC').toLocaleLowerCase('en-US');
    if (used.has(folded(name)) && used.get(folded(name)) !== asset.key) name = fitFilename(name.replace(/\.html$/, `__${asset.numericId || component(encodeURIComponent(asset.id))}.html`), '.html');
    if (used.has(folded(name)) && used.get(folded(name)) !== asset.key) throw new Error('Unresolvable document filename collision');
    used.set(folded(name), asset.key); names.set(asset.key, name);
  }
  return names;
}
