import { mount } from './ui.js';
mount().catch(() => {
  document.querySelector('#status').textContent = 'Local browser storage could not be opened. Check extension permissions and free disk space, then reopen the tab.';
});
