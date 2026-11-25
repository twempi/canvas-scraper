import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { themeVariables, requestTheme, syncTheme, applyVariables, THEME_CACHE, contrast } from '../extension/script/theme.js';
import { HOST } from '../extension/script/convert.js';
// Synthetic base16 palettes (Rosé Pine and a light scheme), as the native helper reports them.
const rosePine = { colors: { base00: '191724', base01: '1f1d2e', base02: '26233a', base03: '6e6a86', base04: '908caa', base05: 'e0def4', base06: 'e0def4', base07: '524f67', base08: 'eb6f92', base09: 'f6c177', base0A: 'ebbcba', base0B: '31748f', base0C: '9ccfd8', base0D: 'c4a7e7', base0E: 'f6c177', base0F: '524f67' }, fonts: { sansSerif: 'Iosevka', monospace: 'Iosevka' }, polarity: 'dark' };
const light = { colors: Object.fromEntries(Object.entries(rosePine.colors).map(([k], i) => [k, i < 2 ? 'f4f1e8' : '30343a'])) };
function fakeChrome(reply, { missing = false } = {}) {
  const sent = [];
  const runtime = { lastError: null, connectNative(name) {
    assert.equal(name, HOST);
    const listeners = { message: [], disconnect: [] };
    const port = { onMessage: { addListener: f => listeners.message.push(f) }, onDisconnect: { addListener: f => listeners.disconnect.push(f) }, disconnect() {},
      postMessage(message) { sent.push(message); if (reply !== undefined) setTimeout(() => listeners.message.forEach(f => f(reply))); } };
    if (missing) setTimeout(() => { runtime.lastError = { message: 'Specified native messaging host not found.' }; listeners.disconnect.forEach(f => f()); });
    return port;
  } };
  return { runtime, sent };
}
class MemoryStorage { constructor() { this.data = new Map(); } getItem(k) { return this.data.get(k) ?? null; } setItem(k, v) { this.data.set(k, String(v)); } removeItem(k) { this.data.delete(k); } }
test('a base16 palette maps onto every UI colour role and Stylix fonts', () => {
  const vars = themeVariables(rosePine);
  assert.equal(vars['--bg'], '#191724'); assert.equal(vars['--surface'], '#1f1d2e'); assert.equal(vars['--text'], '#e0def4');
  assert.equal(vars['--accent'], '#c4a7e7'); assert.equal(vars['--accent-text'], '#191724');
  assert.equal(vars['--warn'], '#ebbcba', 'already-readable colours are used as-is');
  // Rosé Pine's base0B is a dark teal; it is lifted toward the text colour until it is readable.
  assert.notEqual(vars['--ok'], '#31748f');
  for (const [name, slot] of [['ok', '31748f'], ['info', 'c4a7e7'], ['warn', 'ebbcba'], ['error', 'eb6f92']]) {
    const tinted = '#' + [0, 2, 4].map(i => Math.round(parseInt('1f1d2e'.slice(i, i + 2), 16) * 0.84 + parseInt(slot.slice(i, i + 2), 16) * 0.16).toString(16).padStart(2, '0')).join('');
    assert.ok(contrast(vars[`--${name}`], tinted) >= 4.5, `${name} is readable on its tinted card`);
  }
  assert.equal(vars['color-scheme'], 'dark'); assert.match(vars['--font'], /^"Iosevka", /);
  // Every variable the stylesheet's built-in palette defines is themed.
  const css = fs.readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8');
  const defined = new Set([...css.split('@media (prefers-color-scheme: dark)')[1].split('}')[0].matchAll(/(--[\w-]+):/g)].map(m => m[1]));
  for (const name of defined) assert.ok(name in vars, `${name} is themed`);
  assert.equal(themeVariables(light)['color-scheme'], 'light', 'polarity falls back to background luminance');
  // Everforest's base16 port keeps grey in base05 and the real foreground in base07.
  const everforest = { colors: { ...rosePine.colors, base00: '2d353b', base01: '343f44', base02: '3d484d', base03: '475258', base04: '7a8478', base05: '859289', base06: '9da9a0', base07: 'd3c6aa', base0B: 'a7c080' } };
  const ev = themeVariables(everforest);
  assert.equal(ev['--text'], '#d3c6aa'); assert.ok(contrast(ev['--muted'], '#3d484d') >= 4.5); assert.ok(contrast(ev['--ok'], '#343f44') >= 4.5);
});
test('malformed palettes and font names are rejected instead of injected into CSS', () => {
  assert.equal(themeVariables(null), null);
  assert.equal(themeVariables({ colors: { ...rosePine.colors, base08: 'red; background:url(x)' } }), null);
  assert.equal(themeVariables({ colors: { base00: '191724' } }), null);
  const vars = themeVariables({ ...rosePine, fonts: { sansSerif: 'x"; } body { display:none', monospace: 'Iosevka Term' } });
  assert.equal(vars['--font'], undefined); assert.match(vars['--mono'], /^"Iosevka Term", /);
});
test('the theme is requested from the native helper and applied with a cache for the next open', async () => {
  const chrome = fakeChrome({ theme: rosePine }), storage = new MemoryStorage(), { document } = parseHTML('<!doctype html><html><body></body></html>');
  assert.deepEqual(await requestTheme(chrome), rosePine); assert.deepEqual(chrome.sent, [{ theme: true }]);
  assert.equal(await syncTheme({ chromeAPI: chrome, storage, root: document.documentElement }), true);
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '#191724'); assert.equal(document.documentElement.dataset.theme, 'stylix');
  assert.equal(JSON.parse(storage.getItem(THEME_CACHE))['--accent'], '#c4a7e7');
  // The helper is installed without Stylix colours: fall back to the built-in palette and drop the cache.
  assert.equal(await syncTheme({ chromeAPI: fakeChrome({ theme: null }), storage, root: document.documentElement }), false);
  assert.equal(storage.getItem(THEME_CACHE), null); assert.ok(!document.documentElement.style.getPropertyValue('--bg'));
});
test('a missing or silent helper never blocks the UI', async () => {
  assert.equal(await requestTheme(fakeChrome(undefined, { missing: true })), null);
  assert.equal(await requestTheme(fakeChrome(undefined), 20), null);
  assert.equal(await requestTheme(null), null);
  const { document } = parseHTML('<!doctype html><html><body></body></html>'); applyVariables(null, document.documentElement);
  assert.equal(document.documentElement.dataset.theme, undefined);
});
