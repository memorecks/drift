/* audit — standalone voice-audit bench (audit.html only; index.html never
   loads this). Reuses core/theory/structure/voices untouched: builds the same
   audio graph the scheduler's start() builds, then exposes every instrument
   as a DAW-style track — record-arm + fader per track, notes from Web MIDI,
   the computer keys, or the on-screen keyboard. Purely a local listening
   tool: it plays voices on demand and never schedules the broadcast. */

'use strict';

/* ------------------------------------------------------------- state -- */

let curG, curP;
let padHold = 6;            // seconds a pad note sustains before its release
let octBase = 60;           // computer-key anchor (C4)
let droneRoot = 0, droneFifthOn = false;
const weather = { wind: 0, water: 0, rain: 0 };

const $ = id => document.getElementById(id);
const f2 = x => Math.round(x * 100) / 100;
const hzf = x => Math.round(x) + ' Hz';
const sf = x => f2(x) + ' s';

/* ----------------------------------------------------- note triggers -- */

/* pad: no per-note pitch argument exists, so clone P with rootPc chosen so a
   single-degree chord lands on the pressed key (mode[0] is always 0, so
   degreeToMidi gives rootPc + 36 at the pad's base octave). padVoicing still
   folds into the broadcast's F2–B5 pad register. */
function playPadNote(tc, midi, voice) {
  const p = { ...curP, rootPc: midi - 36,
              timbre: { ...curP.timbre, pad: { ...curP.timbre.pad, voice } } };
  playPad(tc, padHold, p, { deg: 0, degrees: [0] });
}

const ostP = voice => ({ ...curP, ostVoice: voice });

/* ------------------------------------------------------------ tracks -- */

/* mode 'bus'  — the voice has no level argument; the fader drives that
                 track's mixer tap (setMixLevel), velocity is ignored.
   mode 'level' — fader × velocity is passed straight into the voice. */

const ostBase = () => { const T = curP.timbre.ostT;
  return `atk ${sf(T.atk)} · dec ${sf(T.dec)} · lp ${hzf(T.lp)}`; };
const ostVib = () => { const T = curP.timbre.ostT;
  return `vib ${f2(T.lfoHz)} Hz ±${f2(T.lfoCents)}¢`; };

const TRACKS = [
  /* pads — playPad archetypes */
  { sec: 'pads', name: 'pad · duo', mode: 'bus', bus: 'pad',
    play: (tc, m) => playPadNote(tc, m, 'duo'),
    pick: () => curP.timbre.pad.voice === 'duo',
    info: () => { const T = curP.timbre.pad;
      return `${T.wave} + sine ${f2(T.det)}¢ · atk ×${f2(T.atk)} · rel ${sf(T.rel)} · lp ${hzf(T.lp + curP.bright * 950)}`; } },
  { sec: 'pads', name: 'pad · saw ensemble', mode: 'bus', bus: 'pad',
    play: (tc, m) => playPadNote(tc, m, 'saw'),
    pick: () => curP.timbre.pad.voice === 'saw',
    info: () => { const T = curP.timbre.pad;
      return `3 saws ±${f2(T.spread)}¢ · cutoff blooms ×1.4 then settles · rel ${sf(T.rel)}`; } },
  { sec: 'pads', name: 'pad · pitch wobble', mode: 'bus', bus: 'pad',
    play: (tc, m) => playPadNote(tc, m, 'wobble'),
    pick: () => curP.timbre.pad.voice === 'wobble',
    info: () => { const T = curP.timbre.pad;
      return `pitch lfo ${f2(T.lfoHz)} Hz ±${f2(T.lfoAmt)}¢ (rate spread per chord tone)`; } },
  { sec: 'pads', name: 'pad · breathing filter', mode: 'bus', bus: 'pad',
    play: (tc, m) => playPadNote(tc, m, 'breathe'),
    pick: () => curP.timbre.pad.voice === 'breathe',
    info: () => { const T = curP.timbre.pad;
      return `filter lfo ${f2(T.lfoHz)} Hz · sweep ±×${f2(T.sweep)} of cutoff`; } },
  { sec: 'pads', name: 'pad · organ stack', mode: 'bus', bus: 'pad',
    play: (tc, m) => playPadNote(tc, m, 'organ'),
    pick: () => curP.timbre.pad.voice === 'organ',
    info: () => { const T = curP.timbre.pad;
      return `drawbars ${T.draw.map(f2).join(' / ')} (f · 2f · 3f) · lp ×1.8`; } },

  /* melodic voices */
  { sec: 'melodic', name: 'melody tone', mode: 'bus', bus: 'mel',
    play: (tc, m) => playTone(tc, curP, m),
    info: () => { const T = curP.timbre.mel;
      return `sine + ${T.wave2} ×${f2(T.sub)} @${f2(T.det)}¢ · atk ${sf(T.atk)} · rel ${sf(T.rel)} · lp ${hzf(T.lp + curP.bright * 900)}`; } },
  { sec: 'melodic', name: 'pluck · string', mode: 'level',
    play: (tc, m, lvl) => playPluck(tc, curP, m, lvl, 'arp'),
    pick: () => curP.pluckVoice === 'string',
    info: () => { const T = curP.timbre.pluck;
      return `karplus-strong · damp ${curP.timbre.pluck.damp} · lp ${hzf(T.lp + curP.bright * 2000)}`; } },
  { sec: 'melodic', name: 'pluck · kalimba', mode: 'level',
    play: (tc, m, lvl) => playKalimba(tc, curP, m, lvl, 'arp'),
    pick: () => curP.pluckVoice === 'kalimba',
    info: () => `3 inharmonic partials (1 / 2.02 / 5.43) · dec ×${f2(curP.timbre.kal.dec)}` },
  { sec: 'melodic', name: 'bell', mode: 'level',
    play: (tc, m, lvl) => playBell(tc, curP, m, lvl),
    info: () => { const T = curP.timbre.bell;
      return `partials 1 / 2.76 / 5.4 (cut >3 kHz) · dec ${sf(T.dec)} · hi ×${f2(T.hi)} · lp ${hzf(T.lp)}`; } },
  { sec: 'melodic', name: 'bass', mode: 'bus', bus: 'bass',
    play: (tc, m) => playBass(tc, curP, m),
    info: () => { const T = curP.timbre.bass;
      return `sine · atk ${sf(T.atk)} · dec ${sf(T.dec)} · lp ${hzf(T.lp)}`; } },

  /* ostinato — playOstTone archetypes */
  { sec: 'ostinato', name: 'ost · sine', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('sine'), m, lvl),
    pick: () => curP.ostVoice === 'sine',
    info: () => `bare sine · ${ostBase()} · ${ostVib()}` },
  { sec: 'ostinato', name: 'ost · triangle', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('triangle'), m, lvl),
    pick: () => curP.ostVoice === 'triangle',
    info: () => `triangle · ${ostBase()} · ${ostVib()}` },
  { sec: 'ostinato', name: 'ost · hollow square', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('square'), m, lvl),
    pick: () => curP.ostVoice === 'square',
    info: () => `lowpassed square · ${ostBase()} · ${ostVib()}` },
  { sec: 'ostinato', name: 'ost · fm e-piano', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('fm'), m, lvl),
    pick: () => curP.ostVoice === 'fm',
    info: () => { const T = curP.timbre.ostT;
      return `2-op fm · ratio ${T.fmRatio} · idx ${f2(T.fmIdx)}→0.05 · dec ${sf(T.dec)} · lp ${hzf(T.lp)}`; } },
  { sec: 'ostinato', name: 'ost · marimba', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('marimba'), m, lvl),
    pick: () => curP.ostVoice === 'marimba',
    info: () => { const T = curP.timbre.ostT;
      return `strike 8 ms + fast 4th partial · dec ${sf(T.dec * 0.55)} · lp ${hzf(T.lp)}`; } },
  { sec: 'ostinato', name: 'ost · breath', mode: 'level',
    play: (tc, m, lvl) => playOstTone(tc, ostP('breath'), m, lvl),
    pick: () => curP.ostVoice === 'breath',
    info: () => { const T = curP.timbre.ostT;
      return `sine + bandpassed noise ×${f2(T.breath)} @2f · slow atk ${sf(T.atk * 4 + 0.05)} · ${ostVib()}`; } },

  /* nature one-shots */
  { sec: 'nature', name: 'bird chirp', mode: 'bus', bus: 'birds',
    play: (tc, m) => playChirp(tc, R('audit bird', m)),
    info: () => '1–3 syllables · seeded per key — the same key repeats the same bird' },
  { sec: 'nature', name: 'cricket', mode: 'bus', bus: 'crickets',
    play: (tc, m) => playCricket(tc, R('audit cricket', m)),
    info: () => '3–5 pulse trill ~4.1–4.6 kHz · seeded per key' },
];

/* persistent layers — faders drive mixer taps; wind/water/rain get an
   intensity slider (the P.wind/P.water/P.rain the broadcast would draw) */
const LAYERS = [
  { id: 'drone', name: 'drone', armable: true,
    info: () => `sine root (oct 2) + detuned octave · fifth ${droneFifthOn ? 'on' : 'off'} · root ${NOTE_NAMES[droneRoot]} — armed keys retune` },
  { id: 'wind', name: 'wind', wx: true,
    info: () => 'noise → lp 320 Hz · slow filter + gain lfos' },
  { id: 'water', name: 'water', wx: true,
    info: () => 'noise → bp 1050 Hz · filter flutter (silent at 0)' },
  { id: 'rain', name: 'rain', wx: true,
    info: () => 'hiss bed + 2 seeded droplet loops · intensity rebalances drops ↔ hiss' },
];

/* the drone always sounds once built — keep its fader down until asked for */
mixLevel.drone = 0;

/* -------------------------------------------------------- audio graph -- */

/* same graph the broadcast's start() builds (scheduler.js), minus the
   transport: no tuneIn, no tick — notes only happen when a key does */
function powerOn() {
  if (started) return;
  started = true;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();

  master = actx.createGain();
  master.gain.value = volume * volume * 0.9;
  analyser = actx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.85;
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.ratio.value = 3;
  comp.attack.value = 0.03; comp.release.value = 0.4;
  const warm = actx.createBiquadFilter();
  warm.type = 'lowpass'; warm.frequency.value = 5600;

  dryBus = actx.createGain();
  wetBus = actx.createGain(); wetBus.gain.value = 0.9;
  toneDry = actx.createBiquadFilter(); toneDry.type = 'lowpass';
  toneWet = actx.createBiquadFilter(); toneWet.type = 'lowpass';
  const verb = actx.createConvolver();
  verb.buffer = makeImpulse();
  wetBus.connect(toneWet); toneWet.connect(verb);
  dryBus.connect(toneDry); toneDry.connect(warm); verb.connect(warm);
  warm.connect(comp); comp.connect(analyser);
  analyser.connect(master); master.connect(actx.destination);

  delayBus = actx.createGain();
  delayNode = actx.createDelay(1.5);
  delayFb = actx.createGain(); delayFb.gain.value = 0.3;
  const dLp = actx.createBiquadFilter();
  dLp.type = 'lowpass'; dLp.frequency.value = 1400;
  delayBus.connect(delayNode); delayNode.connect(dLp);
  dLp.connect(delayFb); delayFb.connect(delayNode);
  out(dLp, 0.55, 0.4);

  sfxDry = actx.createGain();
  sfxWet = actx.createGain(); sfxWet.gain.value = 0.9;
  const sfxVerb = actx.createConvolver();
  sfxVerb.buffer = verb.buffer;
  sfxWet.connect(sfxVerb); sfxVerb.connect(comp);
  sfxDry.connect(comp);
  birdBus = actx.createGain();
  outSfx(birdBus, 0.35, 0.65, 'birds');

  noiseBuf = makeNoise();
  drone = buildDrone();
  wind = buildWind();
  water = buildWater();
  rainLayer = buildRain();

  applyGen(curG);
  setWeatherAudit();
  droneRetune(true);
  meterLoop();
  initMidi();
}

/* setWeather's 8 s time constants are broadcast pacing — too slow for a
   bench, so drive the same gains with the same formulas but snappy ramps */
function setWeatherAudit() {
  if (!started) return;
  const t = actx.currentTime;
  wind.gain.gain.setTargetAtTime(0.10 * weather.wind, t, 0.25);
  water.gain.gain.setTargetAtTime(0.04 * weather.water, t, 0.25);
  const rn = weather.rain;
  rainLayer.gain.gain.setTargetAtTime(0.055 * rn, t, 0.25);
  rainLayer.hiss.gain.setTargetAtTime(0.25 + 0.55 * rn * rn, t, 0.25);
  rainLayer.dropA.gain.setTargetAtTime(1.2 - 0.5 * rn, t, 0.25);
  rainLayer.dropB.gain.setTargetAtTime(0.4 + 1.3 * rn, t, 0.25);
}

/* updateDrone's 4 s glide, tightened for the bench */
function droneRetune(snap) {
  if (!started) return;
  const t = actx.currentTime;
  for (const v of drone.voices) {
    const f = mtof(droneRoot + v.interval + v.oct * 12);
    if (snap) v.osc.frequency.setValueAtTime(f, t);
    else v.osc.frequency.setTargetAtTime(f, t, 0.5);
    if (v.gain) v.gain.gain.setTargetAtTime(droneFifthOn ? 1 : 0, t, 0.5);
  }
}

/* -------------------------------------------------------- generations -- */

function applyGen(g) {
  g = Math.max(0, Math.round(g || 0));
  const e = Math.floor(g / GEN_SLOTS);
  const segs = hourSegs(e);
  const i = Math.min(g % GEN_SLOTS, segs.length - 1);
  curG = e * GEN_SLOTS + i;
  curP = genParams(curG);
  droneRoot = curP.rootPc;
  droneFifthOn = curP.droneFifth;
  if (started) {
    const t = actx.currentTime;
    toneDry.frequency.setValueAtTime(curP.toneHz, t);
    toneWet.frequency.setValueAtTime(curP.toneHz, t);
    delayNode.delayTime.setValueAtTime(curP.timbre.delay.time, t);
    delayFb.gain.setValueAtTime(curP.timbre.delay.fb, t);
    droneRetune();
  }
  refreshInfo();
}

function genBefore(g) {
  const e = Math.floor(g / GEN_SLOTS), i = g % GEN_SLOTS;
  if (i > 0) return g - 1;
  if (e <= 0) return g;
  const s = hourSegs(e - 1);
  return s[s.length - 1].g;
}

function refreshInfo() {
  $('gen').value = curG;
  const d = new Date((ORIGIN + curP.start) * 1000);
  const del = curP.timbre.delay;
  $('gensum').textContent =
    `g ${curG} · ${d.toISOString().slice(0, 16).replace('T', ' ')}Z · ` +
    `${Math.round(curP.len / 60)} min · ` +
    `${NOTE_NAMES[curP.rootPc]} ${curP.modeName} · ${curP.meter.name} @ ` +
    `${f2(curP.pulse)} s pulse · tone ${Math.round(curP.toneHz)} Hz · ` +
    `verb ×${f2(curP.timbre.verb)} · ` +
    (del.amt > 0
      ? `delay ${Math.round(del.time * 1000)} ms · fb ${f2(del.fb)} · send ${f2(del.amt)}`
      : 'delay off this gen');
  for (const t of TRACKS) {
    const s = t.info();
    t.infoEl.textContent = s;
    t.infoEl.title = s;
    t.pickEl.hidden = !(t.pick && t.pick());
  }
  for (const L of LAYERS) {
    const s = L.info();
    L.infoEl.textContent = s;
    L.infoEl.title = s;
  }
  if (LAYERS[0].fifthEl) LAYERS[0].fifthEl.checked = droneFifthOn;
}

/* --------------------------------------------------------------- notes -- */

function noteOn(midi, vel) {
  litKey(midi);
  if (!started) return;
  const tc = actx.currentTime + 0.02;
  for (const t of TRACKS) {
    if (!t.arm) continue;
    if (t.mode === 'bus') setMixLevel(t.bus, t.fader);
    t.play(tc, midi, Math.min(1, Math.max(0.05, vel * t.fader)));
    blink(t.led);
  }
  const dr = LAYERS[0];
  if (dr.arm) {
    droneRoot = midi % 12;
    droneRetune();
    blink(dr.led);
    refreshInfo();
  }
}

function blink(el) {
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 160);
}

/* ------------------------------------------------------------ console -- */

function trackRow(t, color) {
  const row = document.createElement('div');
  row.className = 'track';
  row.innerHTML = `
    <span class="swatch" style="background:${color}"></span>
    <button class="arm" title="record-arm — armed tracks receive notes"></button>
    <span class="led"></span>
    <span class="name">${t.name} <span class="pick" hidden>gen pick</span></span>
    <input class="fader" type="range" min="0" max="1" step="0.01" value="0.8"
           title="track volume">
    <span class="val">0.80</span>
    <span class="extra"></span>
    <span class="info"></span>`;
  t.fader = 0.8;
  t.arm = false;
  t.led = row.querySelector('.led');
  t.pickEl = row.querySelector('.pick');
  t.infoEl = row.querySelector('.info');
  const armEl = row.querySelector('.arm');
  armEl.addEventListener('click', () => {
    t.arm = !t.arm;
    armEl.classList.toggle('on', t.arm);
  });
  const val = row.querySelector('.val');
  row.querySelector('.fader').addEventListener('input', e => {
    t.fader = +e.target.value;
    val.textContent = t.fader.toFixed(2);
    if (t.mode === 'bus') setMixLevel(t.bus, t.fader);
  });
  return row;
}

function layerRow(L) {
  const row = document.createElement('div');
  row.className = 'track';
  const fd = L.id === 'drone' ? 0 : 1;
  row.innerHTML = `
    <span class="swatch" style="background:var(--lay)"></span>
    ${L.armable
      ? '<button class="arm" title="arm — keys retune the drone root"></button>'
      : '<span class="noarm"></span>'}
    <span class="led"></span>
    <span class="name">${L.name}</span>
    <input class="fader" type="range" min="0" max="1" step="0.01" value="${fd}"
           title="track volume">
    <span class="val">${fd.toFixed(2)}</span>
    <span class="extra"></span>
    <span class="info"></span>`;
  L.fader = fd;
  L.led = row.querySelector('.led');
  L.infoEl = row.querySelector('.info');
  const val = row.querySelector('.val');
  row.querySelector('.fader').addEventListener('input', e => {
    L.fader = +e.target.value;
    val.textContent = L.fader.toFixed(2);
    setMixLevel(L.id, L.fader);
  });
  const extra = row.querySelector('.extra');
  if (L.armable) {
    const armEl = row.querySelector('.arm');
    armEl.addEventListener('click', () => {
      L.arm = !L.arm;
      armEl.classList.toggle('on', L.arm);
    });
    extra.innerHTML = '<label>fifth <input type="checkbox"></label>';
    L.fifthEl = extra.querySelector('input');
    L.fifthEl.addEventListener('change', () => {
      droneFifthOn = L.fifthEl.checked;
      droneRetune();
      refreshInfo();
    });
  }
  if (L.wx) {
    extra.innerHTML = '<label>int</label>' +
      '<input type="range" min="0" max="1" step="0.01" value="0" title="intensity">';
    extra.querySelector('input[type=range]').addEventListener('input', e => {
      weather[L.id] = +e.target.value;
      setWeatherAudit();
    });
  }
  return row;
}

function buildConsole() {
  const host = $('console');
  const secs = [
    ['pads', 'pads — playPad archetypes · register folds to F2–B5 · fixed hold', 'var(--pad)'],
    ['melodic', 'melodic voices', 'var(--melc)'],
    ['ostinato', 'ostinato — playOstTone archetypes (the "pluck" variant reuses the pluck kit above)', 'var(--ost)'],
    ['nature', 'nature one-shots — unpitched, any key triggers', 'var(--nat)'],
  ];
  for (const [id, label, color] of secs) {
    const h = document.createElement('h3');
    h.textContent = label;
    host.appendChild(h);
    for (const t of TRACKS) if (t.sec === id) host.appendChild(trackRow(t, color));
  }
  const h = document.createElement('h3');
  h.textContent = 'persistent layers — always running, faders gate them locally';
  host.appendChild(h);
  for (const L of LAYERS) host.appendChild(layerRow(L));
}

/* ----------------------------------------------------------- keyboard -- */

const KEY_LO = 24, KEY_HI = 96, WHITE_W = 18;
const keyEls = new Map();
const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
const CODE_SEMI = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5,
                    KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
                    KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const CODE_CHAR = { KeyA: 'a', KeyW: 'w', KeyS: 's', KeyE: 'e', KeyD: 'd',
                    KeyF: 'f', KeyT: 't', KeyG: 'g', KeyY: 'y', KeyH: 'h',
                    KeyU: 'u', KeyJ: 'j', KeyK: 'k', KeyO: 'o', KeyL: 'l',
                    KeyP: 'p', Semicolon: ';' };

function buildKeys() {
  const bed = $('keybed');
  let wx = 0;
  for (let m = KEY_LO; m <= KEY_HI; m++) {
    const el = document.createElement('div');
    if (isBlack(m)) {
      el.className = 'bkey';
      el.style.left = (wx - 5) + 'px';
    } else {
      el.className = 'wkey';
      el.style.left = wx + 'px';
      wx += WHITE_W;
    }
    el.appendChild(document.createElement('span'));
    el.addEventListener('pointerdown', ev => { ev.preventDefault(); noteOn(m, 0.8); });
    el.addEventListener('pointerenter', ev => { if (ev.buttons & 1) noteOn(m, 0.8); });
    bed.appendChild(el);
    keyEls.set(m, el);
  }
  bed.style.width = wx + 'px';
  refreshKeyHints();
}

function refreshKeyHints() {
  for (const [m, el] of keyEls) {
    const code = Object.keys(CODE_SEMI).find(c => CODE_SEMI[c] === m - octBase);
    el.firstChild.textContent =
      code ? CODE_CHAR[code] : (m % 12 === 0 ? 'C' + (m / 12 - 1) : '');
  }
  $('octlab').textContent = 'keys at C' + (octBase / 12 - 1);
}

function litKey(m) {
  const el = keyEls.get(m);
  if (!el) return;
  el.classList.add('lit');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('lit'), 180);
}

document.addEventListener('keydown', e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
  if (e.code === 'KeyZ') { octBase = Math.max(24, octBase - 12); refreshKeyHints(); return; }
  if (e.code === 'KeyX') { octBase = Math.min(84, octBase + 12); refreshKeyHints(); return; }
  const s = CODE_SEMI[e.code];
  if (s !== undefined) noteOn(octBase + s, 0.8);
});

/* ---------------------------------------------------------------- midi -- */

function midiStatus(s) { $('midistat').textContent = 'midi: ' + s; }

function initMidi() {
  if (!navigator.requestMIDIAccess) {
    midiStatus('unavailable — use keys / screen keyboard');
    return;
  }
  navigator.requestMIDIAccess({ sysex: false }).then(acc => {
    const hook = () => {
      const names = [];
      for (const inp of acc.inputs.values()) {
        inp.onmidimessage = onMidiMsg;
        names.push(inp.name);
      }
      midiStatus(names.length ? names.join(', ') : 'no inputs connected');
    };
    acc.onstatechange = hook;
    hook();
  }, () => midiStatus('access denied'));
}

function onMidiMsg(e) {
  const [st, d1, d2] = e.data;
  if ((st & 0xf0) === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
  /* note-offs ignored: every voice is a fixed envelope, as on the broadcast */
}

/* --------------------------------------------------------------- meter -- */

function meterLoop() {
  const cv = $('meter'), cx = cv.getContext('2d');
  const buf = new Uint8Array(analyser.fftSize);
  let peak = 0;
  (function loop() {
    requestAnimationFrame(loop);
    analyser.getByteTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i] - 128) / 128);
    peak = Math.max(p, peak * 0.94);
    cx.fillStyle = '#2c2d33';
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = peak > 0.85 ? '#e5484d' : '#6fcf8f';
    cx.fillRect(0, 0, Math.min(cv.width, peak * cv.width), cv.height);
  })();
}

/* ---------------------------------------------------------------- boot -- */

buildConsole();
buildKeys();
applyGen(genAt(Math.max(0, wallNow())).g);

$('tunein').addEventListener('click', () => {
  $('veil').classList.add('off');
  powerOn();
});
$('panic').addEventListener('click', () => { if (started) cutLiveNodes(); });
$('hold').addEventListener('change', e => { padHold = +e.target.value; });
$('mvol').addEventListener('input', e => {
  volume = +e.target.value;
  if (started) master.gain.setTargetAtTime(volume * volume * 0.9, actx.currentTime, 0.05);
});
$('gen').addEventListener('change', e => applyGen(+e.target.value));
$('gprev').addEventListener('click', () => applyGen(genBefore(curG)));
$('gnext').addEventListener('click', () => applyGen(genAfter(curG).g));
$('gnow').addEventListener('click', () => applyGen(genAt(Math.max(0, wallNow())).g));
$('grand').addEventListener('click', () => {
  /* bench navigation only, nothing broadcast-audible — Math.random is fine */
  const maxE = Math.floor(Math.max(HOUR, wallNow()) / HOUR) + 8760;
  const segs = hourSegs(Math.floor(Math.random() * maxE));
  applyGen(segs[Math.floor(Math.random() * segs.length)].g);
});
$('octdn').addEventListener('click', () => {
  octBase = Math.max(24, octBase - 12); refreshKeyHints();
});
$('octup').addEventListener('click', () => {
  octBase = Math.min(84, octBase + 12); refreshKeyHints();
});
