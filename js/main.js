/* main — bootstrap. Loaded last, once every other concern is defined: global
   keybindings (` debug, m roll), ?debug/?roll query params, and the
   once-a-second now-playing refresh. */

'use strict';

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '`') toggleDebug();
  if (e.key === 'm') toggleRoll();
});
if (new URLSearchParams(location.search).has('debug')) toggleDebug(true);
if (new URLSearchParams(location.search).has('roll')) toggleRoll(true);

setInterval(updateInfo, 1000);
updateInfo();
