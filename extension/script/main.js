import { mount } from './ui.js';
mount().then(() => document.querySelector('#connect').click(), () => {
  document.querySelector('#status').textContent = 'Local browser storage could not be opened. Check extension permissions and free disk space, then reopen the panel.';
});
