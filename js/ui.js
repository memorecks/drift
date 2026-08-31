/* ui — the now-playing colophon, volume, and the debug panel (time travel,
   jump-to-datetime, next-generation, the upcoming-generations table). Every
   time jump funnels through jumpTo() -> retune(). */

'use strict';

/* ------------------------------------------------------------------- ui -- */

const veil = document.getElementById('veil');
const nowplaying = document.getElementById('nowplaying');
const utcEl = document.getElementById('utc');
const vol = document.getElementById('vol');

document.getElementById('tunein').addEventListener('click', () => {
  start();
  veil.classList.add('lifted');
});

vol.addEventListener('input', () => {
  volume = parseFloat(vol.value);
  if (master) master.gain.setTargetAtTime(volume * volume * 0.9, actx.currentTime, 0.1);
});

function weatherWords(P) {
  const w = ['wind'];
  if (P.rain > 0.65) w.unshift('steady rain');
  else if (P.rain > 0) w.unshift('light rain');
  if (P.water > 0) w.push('stream');
  if (P.birds > 0.3) w.push('birdsong');
  else if (P.birds > 0) w.push('distant birds');
  if (P.crickets > 0) w.push('crickets');
  return w.join(', ');
}

function updateInfo() {
  const now = wallNow();
  const P = genParams(genAt(now).g);
  const d = new Date((now + ORIGIN) * 1000);
  utcEl.textContent = (debugOffset === 0 ? 'utc ' : 'sim ') + d.toISOString().slice(11, 19);
  utcEl.style.color = debugOffset === 0 ? '' : 'var(--clay)';
  if (!debugEl.hidden) renderDebug();
  if (!started) {
    nowplaying.textContent = 'signal quiet';
    return;
  }
  const bpm = Math.round(60 / (P.pulse * 2));
  nowplaying.innerHTML =
    `<b>day ${P.day + 1}</b> of the broadcast &nbsp;·&nbsp; ` +
    `<b>${NOTE_NAMES[P.rootPc]} ${P.modeName}</b> &nbsp;·&nbsp; ` +
    `${P.meter.name} &nbsp;·&nbsp; ${bpm} bpm &nbsp;·&nbsp; ` +
    `<i>${weatherWords(P)}</i>`;
}

/* ---------------------------------------------------------------- debug -- */

const debugEl = document.getElementById('debug');
const dbgClock = document.getElementById('dbgclock');
const dbgHours = document.querySelector('#dbghours tbody');
const dbgWhen = document.getElementById('dbgwhen');

function jumpTo(w) {
  debugOffset += w - wallNow();
  if (Math.abs(debugOffset) < 0.05) debugOffset = 0;
  retune();
  updateInfo();
  renderDebug();
}
const jumpBy = dt => jumpTo(wallNow() + dt);
const goLive = () => jumpTo(Date.now() / 1000 - ORIGIN);
/* skip to the top of the next generation (10–30 min movements) */
const nextGeneration = () => {
  const seg = genAt(wallNow());
  jumpTo(seg.start + seg.len + 0.02);
};

const pad2 = n => String(n).padStart(2, '0');

function fmtOffset(s) {
  const sign = s < 0 ? '−' : '+';
  s = Math.abs(Math.round(s));
  const d = Math.floor(s / 86400), r = s % 86400;
  return sign + (d ? d + 'd ' : '') +
    `${pad2(Math.floor(r / 3600))}:${pad2(Math.floor((r % 3600) / 60))}:${pad2(r % 60)}`;
}

function localInputValue(w) {
  const d = new Date((w + ORIGIN) * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
         `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function renderDebug() {
  const now = wallNow();
  const cur = genAt(now);
  const iso = new Date((now + ORIGIN) * 1000).toISOString();
  dbgClock.innerHTML =
    `<b>${iso.slice(0, 10)} ${iso.slice(11, 19)} utc</b> · ` +
    (debugOffset === 0 ? 'live'
      : `<span class="sim">sim ${fmtOffset(debugOffset)}</span>`) +
    `<br>day ${Math.floor(cur.start / (24 * HOUR)) + 1} · generation ${cur.g}` +
    ` · ${Math.round(cur.len / 60)} min`;

  dbgHours.textContent = '';
  let seg = cur;
  for (let i = 0; i < 8; i++) {
    const P = genParams(seg.g);
    const start = seg.start;
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'now';
    const bpm = Math.round(60 / (P.pulse * 2));
    const cells = [
      new Date((start + ORIGIN) * 1000).toISOString().slice(11, 16)
        + ` · ${Math.round(P.len / 60)}m`,
      `${NOTE_NAMES[P.rootPc]} ${P.modeName}`,
      `${P.meter.name} · ${bpm} bpm`,
      weatherWords(P),
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (ci === 0 || ci === 3) td.className = 'dim';
      tr.appendChild(td);
    });
    tr.title = i === 0 ? 'current generation — click to restart it'
                       : 'click to audition this generation';
    tr.addEventListener('click', () => jumpTo(start + 0.02));
    dbgHours.appendChild(tr);
    seg = genAfter(seg.g);
  }
}

/* mixer — one fader per track, sfx included. Faders drive setMixLevel()
   (voices.js), which scales that track's dry/wet/delay taps: local ears
   only, the broadcast is untouched. Squared for a rough audio taper. */
const dbgMix = document.getElementById('dbgmix');
['pad', 'mel', 'arp', 'ost', 'bass', 'bells', 'drone',
 'birds', 'crickets', 'wind', 'water', 'rain'].forEach(track => {
  const strip = document.createElement('div');
  strip.className = 'mixstrip';
  const f = document.createElement('input');
  f.type = 'range'; f.min = 0; f.max = 1; f.step = 0.01; f.value = 1;
  const apply = () => setMixLevel(track, parseFloat(f.value) ** 2);
  f.addEventListener('input', apply);
  f.addEventListener('dblclick', () => { f.value = 1; apply(); });
  const name = document.createElement('span');
  name.textContent = track;
  strip.append(f, name);
  dbgMix.appendChild(strip);
});

/* visual reactivity — how hard the sound drives the sun, ridgelines, and
   note field (visual.js's visIntensity). Local-only, like the mixer. */
const dbgReact = document.getElementById('dbgreact');
const dbgReactVal = document.getElementById('dbgreactval');
dbgReact.addEventListener('input', () => {
  visIntensity = parseFloat(dbgReact.value);
  dbgReactVal.textContent = visIntensity.toFixed(2).replace(/0$/, '') + '×';
});
dbgReact.addEventListener('dblclick', () => {
  dbgReact.value = 1.6;
  dbgReact.dispatchEvent(new Event('input'));
});

function toggleDebug(show = debugEl.hidden) {
  debugEl.hidden = !show;
  if (show) {
    dbgWhen.value = localInputValue(wallNow());
    renderDebug();
  }
}

document.getElementById('dbgtoggle').addEventListener('click', () => toggleDebug());
document.getElementById('dbgclose').addEventListener('click', () => toggleDebug(false));
document.getElementById('dbggen').addEventListener('click', nextGeneration);
document.getElementById('dbglive').addEventListener('click', goLive);
document.getElementById('dbggo').addEventListener('click', () => {
  const d = new Date(dbgWhen.value);
  if (!isNaN(d)) jumpTo(d.getTime() / 1000 - ORIGIN);
});
document.querySelectorAll('#debug [data-ff]').forEach(b =>
  b.addEventListener('click', () => jumpBy(parseFloat(b.dataset.ff))));
