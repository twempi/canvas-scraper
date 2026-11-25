// Classic (blocking) script in <head>: paints the cached Stylix palette before first render.
// script/theme.js refreshes it from the native helper once the page loads.
try {
  const vars = JSON.parse(localStorage.getItem('canvas-archive:stylix-theme') || 'null');
  if (vars && typeof vars === 'object') {
    for (const [key, value] of Object.entries(vars)) {
      if ((key.startsWith('--') || key === 'color-scheme') && typeof value === 'string') document.documentElement.style.setProperty(key, value);
    }
    document.documentElement.dataset.theme = 'stylix';
  }
} catch { /* No cache yet: the default palette is used until the helper answers. */ }
