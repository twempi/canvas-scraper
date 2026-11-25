// Stylix theme: the native helper (installed by Nix) reports the base16 palette and
// fonts; this maps them onto the UI's CSS variables. Without the helper the built-in
// light/dark palette is used. The last palette is cached so pages paint themed at once.
export const THEME_CACHE = 'canvas-archive:stylix-theme';
const HOST = 'edu.calpoly.canvas_archive_pdf';
const HEX = /^#?([0-9a-f]{6})$/i;
const FONT = /^[\p{L}\p{N} ._+-]{1,64}$/u;
const luminance = hex => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [x, y] = [luminance(a.slice(1)), luminance(b.slice(1))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const blend = (a, b, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
// Some schemes use dark "greens" or pale "yellows"; nudge a colour toward the text colour until it reads on the panel.
export function readable(color, background, text, minimum = 4.5) {
  for (let t = 0; t <= 1; t += 0.1) { const candidate = blend(color, text, t); if (contrast(candidate, background) >= minimum) return candidate; }
  return text;
}
// Returns CSS custom properties for a base16 palette, or null if it is malformed.
export function themeVariables(theme) {
  const c = {};
  for (const digit of '0123456789ABCDEF') {
    const match = HEX.exec(theme?.colors?.[`base0${digit}`] ?? '');
    if (!match) return null;
    c[digit] = `#${match[1].toLowerCase()}`;
  }
  const dark = theme.polarity === 'light' ? false : theme.polarity === 'dark' ? true : luminance(c[0].slice(1)) < 0.4;
  const mix = (color, amount, base = c[1]) => `color-mix(in srgb, ${color} ${amount}%, ${base})`;
  // base16 says base05 is body text, but some ports (e.g. Everforest) put grey there and the real
  // foreground in base06/07. Use the first that reads on the panel, else the best of them.
  const text = [c[5], c[6], c[7]].find(color => contrast(color, c[1]) >= 4.5) || [c[5], c[6], c[7]].sort((a, b) => contrast(b, c[1]) - contrast(a, c[1]))[0];
  c[5] = text;
  // Tone text sits on its own tinted background, so check against that worst case.
  const tone = (name, color) => { const ink = readable(color, blend(c[1], color, dark ? 0.16 : 0.2), c[5]); return { [`--${name}`]: ink, [`--${name}-bg`]: mix(color, dark ? 16 : 20), [`--${name}-border`]: mix(color, 45) }; };
  const accent = readable(c.D, c[1], c[5], 3), accentText = contrast(c[0], accent) >= contrast(c[5], accent) ? c[0] : c[5];
  const vars = {
    'color-scheme': dark ? 'dark' : 'light',
    '--bg': c[0], '--surface': c[1], '--surface-2': mix(c[2], 60), '--hover': c[2],
    '--text': c[5], '--muted': readable(c[4], c[2], c[5]), '--border': mix(c[3], 35, c[2]), '--border-strong': c[3],
    '--accent': accent, '--accent-hover': mix(accent, 85, c[5]), '--accent-text': accentText, '--accent-soft': mix(c.D, 18),
    '--focus': readable(c.E, c[0], c[5], 3), '--shadow': 'none',
    ...tone('ok', c.B), ...tone('info', c.D), ...tone('warn', c.A), ...tone('error', c[8])
  };
  const font = name => typeof name === 'string' && FONT.test(name) ? `"${name}", ` : '';
  const sans = font(theme.fonts?.sansSerif), mono = font(theme.fonts?.monospace);
  if (sans) vars['--font'] = `${sans}"Noto Sans", "DejaVu Sans", sans-serif`;
  if (mono) vars['--mono'] = `${mono}"DejaVu Sans Mono", monospace`;
  return vars;
}
export function applyVariables(vars, root = document.documentElement) {
  if (!vars) return;
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = 'stylix';
}
export function clearVariables(root = document.documentElement) {
  root.removeAttribute('style'); // The root element's inline style only ever holds theme variables.
  delete root.dataset.theme;
}
// Ask the native helper for the palette. Resolves to null if it isn't installed or has no theme.
export function requestTheme(chromeAPI = globalThis.chrome, timeout = 3000) {
  return new Promise(resolve => {
    if (!chromeAPI?.runtime?.connectNative) return resolve(null);
    let port, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); try { port?.disconnect(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish(null), timeout);
    try { port = chromeAPI.runtime.connectNative(HOST); } catch { return finish(null); }
    port.onMessage.addListener(message => finish(message && 'theme' in message ? message.theme : null));
    port.onDisconnect.addListener(() => { void chromeAPI.runtime.lastError; finish(null); });
    port.postMessage({ theme: true });
  });
}
// Fetches the current palette, applies it and refreshes the cache. Returns true if themed.
export async function syncTheme({ chromeAPI = globalThis.chrome, storage = globalThis.localStorage, root = document.documentElement } = {}) {
  const vars = themeVariables(await requestTheme(chromeAPI));
  if (vars) { applyVariables(vars, root); storage?.setItem(THEME_CACHE, JSON.stringify(vars)); return true; }
  if (chromeAPI?.runtime?.connectNative) { clearVariables(root); storage?.removeItem(THEME_CACHE); }
  return false;
}
