import { mount } from './ui.js';
import { syncTheme } from './theme.js';
// Follow the Stylix palette from the native helper; recheck whenever the panel is shown again.
syncTheme().catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncTheme().catch(() => {}); });
// Opening the panel connects to Canvas, then syncs every auto-sync course.
mount().then(ui => ui.start(), () => {
  document.querySelector('#status-title').textContent = 'Local browser storage could not be opened';
  document.querySelector('#status-detail').textContent = 'Check extension permissions and free disk space, then reopen the panel.';
  document.querySelector('#status-card').dataset.tone = 'error';
});
