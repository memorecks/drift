/* voices — the Web Audio graph plumbing (buses, sends, reverb/delay wiring
   helpers) and every instrument: pad, tone, bell, bass, pluck/kalimba,
   ostinato, chirp, cricket, plus the persistent drone/wind/water/rain layers and
   the per-generation tone/weather setters. These are the *sounds*; when and
   what to play is decided elsewhere (see melody/scheduler). */

'use strict';

/* ---------------------------------------------------------------- audio -- */

let actx = null;
let dryBus, wetBus, master, analyser;
let toneDry, toneWet;   // per-generation lowpass, pre-reverb (see genParams toneHz)
let delayBus, delayNode, delayFb;   // feedback delay, retuned per generation
let sfxDry, sfxWet;     // nature-sfx buses: skip the tone/warm lowpasses
let birdBus;            // chirps gather here so the roll can mute them
let noiseBuf;
let drone = null, wind = null, water = null, rainLayer = null;
let started = false;
let volume = 0.8;

function makeNoise(seconds = 2) {
  const rate = actx.sampleRate;
  const buf = actx.createBuffer(2, seconds * rate, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function makeImpulse(seconds = 4.2, decay = 2.6) {
  const rate = actx.sampleRate;
  const len = Math.floor(seconds * rate);
  const buf = actx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* mixer: one local fader per track (debug panel). A tap is a shared gain
   sitting between a track's per-note send gains and the bus it feeds, so one
   fader scales that track's dry, wet and delay sends alike. Listening-side
   only, like rollMute — the broadcast itself is untouched. */
const mixLevel = { pad: 1, mel: 1, arp: 1, ost: 1, bass: 1, bells: 1,
                   drone: 1, birds: 1, crickets: 1, wind: 1, water: 1, rain: 1 };
const mixTaps = new Map();   // 'track|leg' -> GainNode
function mixTap(track, leg, bus) {
  const k = track + '|' + leg;
  let g = mixTaps.get(k);
  if (!g) {
    g = actx.createGain(); g.gain.value = mixLevel[track];
    g.connect(bus);
    mixTaps.set(k, g);
  }
  return g;
}
function setMixLevel(track, v) {
  mixLevel[track] = v;
  if (!actx) return;
  for (const [k, g] of mixTaps)
    if (k.startsWith(track + '|')) g.gain.setTargetAtTime(v, actx.currentTime, 0.05);
}

/* connect a node to the dry and reverb buses at given levels */
function out(node, dryAmt, wetAmt, track) {
  if (dryAmt > 0) {
    const g = actx.createGain(); g.gain.value = dryAmt;
    node.connect(g); g.connect(track ? mixTap(track, 'dry', dryBus) : dryBus);
  }
  if (wetAmt > 0) {
    const g = actx.createGain(); g.gain.value = wetAmt;
    node.connect(g); g.connect(track ? mixTap(track, 'wet', wetBus) : wetBus);
  }
}

/* tap a voice into the feedback delay at the given send level */
function sendDelay(node, amt, track) {
  if (amt <= 0) return;
  const g = actx.createGain(); g.gain.value = amt;
  node.connect(g); g.connect(track ? mixTap(track, 'dly', delayBus) : delayBus);
}

/* same, but onto the sfx buses (birds/crickets/wind/water): these keep their
   natural brightness on muffled hours by bypassing the tone/warm lowpasses */
function outSfx(node, dryAmt, wetAmt, track) {
  if (dryAmt > 0) {
    const g = actx.createGain(); g.gain.value = dryAmt;
    node.connect(g); g.connect(track ? mixTap(track, 'sdry', sfxDry) : sfxDry);
  }
  if (wetAmt > 0) {
    const g = actx.createGain(); g.gain.value = wetAmt;
    node.connect(g); g.connect(track ? mixTap(track, 'swet', sfxWet) : sfxWet);
  }
}

/* start a one-shot source and remember it, so a debug time-jump can cut
   everything already in flight */
const liveNodes = new Set();
function startNode(o, t0, t1) {
  o.start(t0); o.stop(t1);
  liveNodes.add(o);
  o.onended = () => liveNodes.delete(o);
}
function cutLiveNodes() {
  const t = actx.currentTime;
  /* quick master dip hides the truncation click; the reverb tail carries over */
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0.0001, t + 0.06);
  master.gain.setValueAtTime(volume * volume * 0.9, t + 0.14);
  for (const n of liveNodes) { try { n.stop(t + 0.08); } catch (e) {} }
  liveNodes.clear();
}

function panner(midi) {
  const p = actx.createStereoPanner();
  p.pan.value = ((midi % 12) / 12 - 0.5) * 0.8;
  return p;
}

/* -- voices ------------------------------------------------------------- */

function playPad(tc, dur, P, chord, elapsed = 0) {
  const T = P.timbre.pad;
  const A = (elapsed > 0 ? 2.5 : Math.min(7, dur * 0.3)) * T.atk;
  const R_ = T.rel;
  padVoicing(P, chord).forEach(midi => {
    const f = mtof(midi);
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = T.lp + P.bright * 950;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, tc);
    g.gain.linearRampToValueAtTime(0.042, tc + A);
    g.gain.setValueAtTime(0.042, tc + Math.max(A, dur));
    g.gain.linearRampToValueAtTime(0.0001, tc + dur + R_);
    const pan = panner(midi);
    lp.connect(g); g.connect(pan);
    out(pan, 0.7, 0.55 * P.timbre.verb, 'pad');
    [[T.wave, 0], ['sine', T.det]].forEach(([type, cents]) => {
      const o = actx.createOscillator();
      o.type = type; o.frequency.value = f; o.detune.value = cents;
      o.connect(lp);
      startNode(o, tc, tc + dur + R_ + 0.5);
    });
  });
}

function playTone(tc, P, midi) {
  const T = P.timbre.mel;
  const f = mtof(midi);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp + P.bright * 900;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, tc);
  g.gain.linearRampToValueAtTime(0.08, tc + T.atk);
  g.gain.exponentialRampToValueAtTime(0.0001, tc + T.atk + T.rel);
  const pan = panner(midi);
  lp.connect(g); g.connect(pan);
  out(pan, 0.6, 0.7 * P.timbre.verb, 'mel');
  sendDelay(pan, P.timbre.delay.amt, 'mel');
  [['sine', 0, 1], [T.wave2, T.det, T.sub]].forEach(([type, cents, amt]) => {
    const o = actx.createOscillator();
    o.type = type; o.frequency.value = f; o.detune.value = cents;
    const og = actx.createGain(); og.gain.value = amt;
    o.connect(og); og.connect(lp);
    startNode(o, tc, tc + T.atk + T.rel + 0.5);
  });
}

function playBell(tc, P, midi, level) {
  const T = P.timbre.bell;
  const f = mtof(midi);
  /* bells through a dedicated lowpass: the upper partials otherwise reach
     past 5 kHz and read as glassy — filter them hard, and drop outright any
     partial that would still land above 3 kHz */
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp;
  const pan = panner(midi);
  lp.connect(pan);
  out(pan, 0.45, 0.85 * P.timbre.verb, 'bells');
  sendDelay(pan, P.timbre.delay.amt * 0.5, 'bells');
  [[1, 1], [2.756, 0.22 * T.hi], [5.404, 0.06 * T.hi]].forEach(([ratio, amt]) => {
    if (f * ratio > 3000) return;
    const dec = ratio === 1 ? T.dec : T.dec * 0.55;
    const o = actx.createOscillator();
    o.type = 'sine'; o.frequency.value = f * ratio;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, tc);
    g.gain.linearRampToValueAtTime(0.055 * level * amt, tc + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, tc + dec);
    o.connect(g); g.connect(lp);
    startNode(o, tc, tc + dec + 0.5);
  });
}

function playBass(tc, P, midi) {
  const T = P.timbre.bass;
  const f = mtof(midi);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, tc);
  g.gain.linearRampToValueAtTime(0.12, tc + T.atk);
  g.gain.exponentialRampToValueAtTime(0.0001, tc + T.atk + T.dec);
  lp.connect(g);
  out(g, 0.85, 0.25 * P.timbre.verb, 'bass');
  const o = actx.createOscillator();
  o.type = 'sine'; o.frequency.value = f;
  o.connect(lp);
  startNode(o, tc, tc + T.atk + T.dec + 0.3);
}

/* karplus-strong plucked string, rendered once per pitch and cached
   (offline render — no live feedback loops to leak on an endless broadcast) */
const pluckCache = new Map();
function pluckBuf(midi, damp) {
  const key = midi + '|' + damp;
  if (pluckCache.has(key)) return pluckCache.get(key);
  const rate = actx.sampleRate;
  const N = Math.max(2, Math.round(rate / mtof(midi)));
  const len = Math.floor(rate * 1.8);
  const buf = actx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i <= N; i++) d[i] = Math.random() * 2 - 1;
  for (let i = N + 1; i < len; i++) d[i] = damp * 0.5 * (d[i - N] + d[i - N - 1]);
  const fade = Math.floor(rate * 0.3);
  for (let i = len - fade; i < len; i++) d[i] *= (len - i) / fade;
  pluckCache.set(key, buf);
  if (pluckCache.size > 64) pluckCache.delete(pluckCache.keys().next().value);
  return buf;
}

function playPluck(tc, P, midi, level = 1, track = 'arp') {
  const T = P.timbre.pluck;
  const src = actx.createBufferSource();
  src.buffer = pluckBuf(midi, T.damp);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp + P.bright * 2000;
  const g = actx.createGain(); g.gain.value = 0.09 * level;
  const pan = panner(midi);
  src.connect(lp); lp.connect(g); g.connect(pan);
  out(pan, 0.5, 0.85 * P.timbre.verb, track);
  sendDelay(pan, P.timbre.delay.amt, track);
  startNode(src, tc, tc + 1.9);
}

/* struck tine: a few inharmonic partials, each dying fast */
function playKalimba(tc, P, midi, level = 1, track = 'arp') {
  const K = P.timbre.kal.dec;
  const f = mtof(midi);
  const pan = panner(midi);
  out(pan, 0.55, 0.8 * P.timbre.verb, track);
  sendDelay(pan, P.timbre.delay.amt * 0.7, track);
  [[1, 1, 0.9], [2.02, 0.4, 0.18], [5.43, 0.15, 0.06]].forEach(([ratio, amt, dec]) => {
    if (f * ratio > 3200) return;
    const o = actx.createOscillator();
    o.type = 'sine'; o.frequency.value = f * ratio;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, tc);
    g.gain.linearRampToValueAtTime(0.08 * level * amt, tc + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, tc + dec * K);
    o.connect(g); g.connect(pan);
    startNode(o, tc, tc + dec * K + 0.1);
  });
}

function playPluckVoice(tc, P, midi, level = 1, track = 'arp') {
  (P.pluckVoice === 'kalimba' ? playKalimba : playPluck)(tc, P, midi, level, track);
}

/* sung ostinato tone: one bare oscillator (sine or triangle) with a soft
   attack, a long dying tail, and a whisper of vibrato, leaning hard on the
   reverb so the figure hangs in the air instead of ticking */
function playOstTone(tc, P, midi, level = 1) {
  const T = P.timbre.ostT;
  const f = mtof(midi);
  const o = actx.createOscillator();
  o.type = P.ostVoice; o.frequency.value = f;
  const lfo = actx.createOscillator();
  lfo.frequency.value = T.lfoHz;
  const lfoG = actx.createGain(); lfoG.gain.value = T.lfoCents;
  lfo.connect(lfoG); lfoG.connect(o.detune);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, tc);
  g.gain.linearRampToValueAtTime(0.06 * level, tc + T.atk);
  g.gain.exponentialRampToValueAtTime(0.0001, tc + T.atk + T.dec);
  const pan = panner(midi);
  o.connect(lp); lp.connect(g); g.connect(pan);
  out(pan, 0.35, 1.15 * P.timbre.verb, 'ost');
  sendDelay(pan, P.timbre.delay.amt * 0.5, 'ost');
  const end = tc + T.atk + T.dec + 0.3;
  startNode(o, tc, end);
  startNode(lfo, tc, end);
}

function playOst(tc, P, midi, level = 1) {
  if (P.ostVoice === 'pluck')
    /* the opposite pluck voice from the generation's melody/arp kit, so the
       figure reads as its own instrument */
    (P.pluckVoice === 'kalimba' ? playPluck : playKalimba)(tc, P, midi, level, 'ost');
  else playOstTone(tc, P, midi, level);
}

function playChirp(tc, r) {
  const syllables = 1 + Math.floor(r() * 3);
  for (let s = 0; s < syllables; s++) {
    const t0 = tc + s * (0.12 + r() * 0.18);
    const f0 = 2300 + r() * 1400;
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.linearRampToValueAtTime(f0 * (0.75 + r() * 0.6), t0 + 0.05 + r() * 0.1);
    o.frequency.linearRampToValueAtTime(f0 * (0.85 + r() * 0.4), t0 + 0.16 + r() * 0.1);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.016, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    o.connect(g); g.connect(birdBus);
    startNode(o, t0, t0 + 0.35);
  }
}

function playCricket(tc, r) {
  const f = 4100 + r() * 500;
  const o = actx.createOscillator();
  o.type = 'sine'; o.frequency.value = f;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, tc);
  const pulses = 3 + Math.floor(r() * 3);
  for (let i = 0; i < pulses; i++) {
    const t0 = tc + i * 0.055;
    g.gain.linearRampToValueAtTime(0.005, t0 + 0.012);
    g.gain.linearRampToValueAtTime(0.0001, t0 + 0.045);
  }
  o.connect(g);
  outSfx(g, 0.5, 0.35, 'crickets');
  startNode(o, tc, tc + pulses * 0.06 + 0.1);
}

/* -- persistent layers -------------------------------------------------- */

function buildDrone() {
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 520;
  const g = actx.createGain(); g.gain.value = 0.05;
  lp.connect(g);
  out(g, 0.9, 0.4, 'drone');
  const voices = [
    { oct: 2, interval: 0, detune: 0 },
    { oct: 3, interval: 7, detune: 0, optional: true },
    { oct: 3, interval: 0, detune: 5 },
  ].map(v => {
    const o = actx.createOscillator();
    o.type = 'sine'; o.detune.value = v.detune;
    o.frequency.value = 55;
    /* optional partials (the fifth) route through their own gain so a
       generation can drop them; the root always sounds */
    if (v.optional) {
      const vg = actx.createGain(); vg.gain.value = 0;
      o.connect(vg); vg.connect(lp);
      v.gain = vg;
    } else {
      o.connect(lp);
    }
    o.start();
    return { osc: o, ...v };
  });
  return { voices, gain: g };
}

function updateDrone(tc, P) {
  for (const v of drone.voices) {
    const f = mtof(P.rootPc + v.interval + v.oct * 12);
    v.osc.frequency.setTargetAtTime(f, tc, 4);
    /* the fifth is present in ~half of generations; fade it across the glide */
    if (v.gain) v.gain.gain.setTargetAtTime(P.droneFifth ? 1 : 0, tc, 4);
  }
}

function buildWind() {
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
  const g = actx.createGain(); g.gain.value = 0.0;
  src.connect(lp); lp.connect(g);
  outSfx(g, 0.9, 0.25, 'wind');
  const lfo1 = actx.createOscillator(); lfo1.frequency.value = 0.05;
  const lfo1g = actx.createGain(); lfo1g.gain.value = 140;
  lfo1.connect(lfo1g); lfo1g.connect(lp.frequency);
  const lfo2 = actx.createOscillator(); lfo2.frequency.value = 0.017;
  const lfo2g = actx.createGain(); lfo2g.gain.value = 0.012;
  lfo2.connect(lfo2g); lfo2g.connect(g.gain);
  lfo1.start(); lfo2.start();
  src.start();
  return { gain: g };
}

function buildWater() {
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  src.playbackRate.value = 0.9;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1050; bp.Q.value = 0.9;
  const g = actx.createGain(); g.gain.value = 0.0;
  src.connect(bp); bp.connect(g);
  outSfx(g, 0.8, 0.3, 'water');
  /* flutter the filter, not the gain, so silent hours stay silent */
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.31;
  const lfog = actx.createGain(); lfog.gain.value = 90;
  lfo.connect(lfog); lfog.connect(bp.frequency);
  lfo.start();
  src.start();
  return { gain: g };
}

/* rain — three strands under one master gain: the band-limited hiss bed
   (distant wash), two droplet loops (sparse close drops / dense patter)
   crossfaded by intensity in setWeather, and two slow incommensurate swell
   LFOs so a downpour arrives in waves instead of holding one level. */

/* offline-render a seamless stereo loop of individual raindrops: each drop is
   a damped sine (bright tick on a leaf / duller plip on stone) with a couple
   of ms of noise splash at the onset. Placement/pitch come from the seeded
   PRNG and playback phase is aligned to wall time below, so every listener
   hears the same drops (drifts only after a debug time-jump — it's rain). */
function makeDropLoop(seed, seconds, perSec, amp) {
  const rate = actx.sampleRate;
  const len = Math.floor(seconds * rate);
  const buf = actx.createBuffer(2, len, rate);
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const r = R('rain-drops', seed);
  const n = Math.floor(seconds * perSec);
  for (let d = 0; d < n; d++) {
    const t0 = Math.floor(r() * len);
    const a = amp * (0.2 + 0.8 * Math.pow(r(), 1.7));   // heavy tail: most far, few close
    const pan = 0.15 + 0.7 * r();
    const bright = r() < 0.72;
    const f0 = bright ? 1300 + r() * 1700 : 430 + r() * 650;
    /* some mid drops get the classic rising "plink" */
    const chirp = !bright && r() < 0.6 ? f0 * (6 + r() * 10) : 0;
    const tau = (bright ? 0.004 + r() * 0.009 : 0.009 + r() * 0.018) * rate;
    const dur = Math.floor(tau * 6);
    const splash = a * 0.5, splashTau = 0.0012 * rate;
    for (let i = 0; i < dur; i++) {
      const t = i / rate;
      let s = a * Math.exp(-i / tau) *
              Math.sin(2 * Math.PI * (f0 * t + 0.5 * chirp * t * t));
      if (i < splashTau * 5) s += (r() * 2 - 1) * splash * Math.exp(-i / splashTau);
      const j = (t0 + i) % len;   // wrap so the loop stays seamless
      ch[0][j] += s * (1 - pan);
      ch[1][j] += s * pan;
    }
  }
  return buf;
}

function buildRain() {
  const g = actx.createGain(); g.gain.value = 0.0;
  outSfx(g, 0.85, 0.2, 'rain');
  /* slow swell: two incommensurate sines breathe the whole layer ±~0.3 */
  const swell = actx.createGain(); swell.gain.value = 1;
  swell.connect(g);
  for (const [hz, depth] of [[1 / 43, 0.17], [1 / 137, 0.13]]) {
    const lfo = actx.createOscillator(); lfo.frequency.value = hz;
    const lg = actx.createGain(); lg.gain.value = depth;
    lfo.connect(lg); lg.connect(swell.gain);
    lfo.start();
  }
  /* hiss bed */
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = 1.1;
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 900;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 4200; lp.Q.value = 0.4;
  const patter = actx.createGain(); patter.gain.value = 1;
  const hiss = actx.createGain(); hiss.gain.value = 1;
  src.connect(hp); hp.connect(lp); lp.connect(patter); patter.connect(hiss);
  hiss.connect(swell);
  /* noise → deep lowpass → the patter gain: random ±~0.3 level flutter
     (occasional negative excursions just invert noise phase — inaudible) */
  const mod = actx.createBufferSource();
  mod.buffer = noiseBuf; mod.loop = true; mod.playbackRate.value = 0.7;
  const mlp = actx.createBiquadFilter();
  mlp.type = 'lowpass'; mlp.frequency.value = 12;
  const mg = actx.createGain(); mg.gain.value = 10;
  mod.connect(mlp); mlp.connect(mg); mg.connect(patter.gain);
  mod.start();
  src.start();
  /* droplet loops: prime-ish incommensurate lengths so the combined pattern
     takes ~20 min to repeat; phase-locked to wall time for all listeners */
  const dropA = actx.createGain(); dropA.gain.value = 1;   // sparse, close drops
  const dropB = actx.createGain(); dropB.gain.value = 1;   // dense patter
  const loops = [[1, 9.7, 6, 1.5, dropA], [2, 12.4, 26, 0.7, dropB]];
  for (const [seed, secs, perSec, amp, gain] of loops) {
    const ds = actx.createBufferSource();
    ds.buffer = makeDropLoop(seed, secs, perSec, amp); ds.loop = true;
    ds.connect(gain); gain.connect(swell);
    ds.start(actx.currentTime, ((wallNow() % secs) + secs) % secs);
  }
  return { gain: g, swell, hiss, dropA, dropB };
}

function setWeather(tc, P) {
  wind.gain.gain.setTargetAtTime(0.05 + 0.05 * P.wind, tc, 8);
  water.gain.gain.setTargetAtTime(0.04 * P.water, tc, 8);
  /* master level scales with intensity; inside it the strands rebalance —
     light rain is mostly distinct drops, heavy rain a wall of hiss+patter */
  const rn = P.rain;
  rainLayer.gain.gain.setTargetAtTime(0.055 * rn, tc, 8);
  rainLayer.hiss.gain.setTargetAtTime(0.25 + 0.55 * rn * rn, tc, 8);
  rainLayer.dropA.gain.setTargetAtTime(1.2 - 0.5 * rn, tc, 8);
  rainLayer.dropB.gain.setTargetAtTime(0.4 + 1.3 * rn, tc, 8);
}

function setTone(tc, P) {
  toneDry.frequency.setTargetAtTime(P.toneHz, tc, 6);
  toneWet.frequency.setTargetAtTime(P.toneHz, tc, 6);
  /* delay retunes with a short glide — a brief tape-style pitch bend on the
     repeats at the generation seam, in keeping with the worn-tape palette */
  delayNode.delayTime.setTargetAtTime(P.timbre.delay.time, tc, 0.4);
  delayFb.gain.setTargetAtTime(P.timbre.delay.fb, tc, 0.4);
}

