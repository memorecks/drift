/* drift — a continuous generative broadcast.
   Every musical event is a pure function of UTC time, so all listeners
   hear the same moment of the same endless piece. */

'use strict';

/* ---------------------------------------------------------------- time -- */

const ORIGIN = Date.UTC(2026, 0, 1) / 1000;   // broadcast began 1 Jan 2026
const HOUR = 3600;
const LOOKAHEAD = 2.5;                        // seconds of audio pre-scheduled
const TICK_MS = 400;

let debugOffset = 0;                          // seconds of simulated time travel
const wallNow = () => Date.now() / 1000 - ORIGIN + debugOffset;

/* ------------------------------------------- deterministic randomness -- */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (...keys) => mulberry32(xmur3(keys.join('§'))());
const rand = (...keys) => R(...keys)();
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function wpick(r, items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let x = r() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* smooth 1-d value noise over a seeded lattice (music side, string seeds) */
function vnoise(seed, x) {
  const x0 = Math.floor(x), f = x - x0;
  const a = rand(seed, x0), b = rand(seed, x0 + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/* fast integer-hash noise for the visuals (no string hashing per frame) */
function ih(i, seed) {
  let n = (i * 374761393 + seed * 668265263) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vn(seed, x) {
  const x0 = Math.floor(x), f = x - x0;
  const u = f * f * (3 - 2 * f);
  return ih(x0, seed) + (ih(x0 + 1, seed) - ih(x0, seed)) * u;
}
function fbm(seed, x, oct = 3) {
  let s = 0, amp = 0.5, fr = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += vn(seed + i * 131, x * fr) * amp;
    norm += amp; amp *= 0.5; fr *= 2.03;
  }
  return s / norm;
}

/* ---------------------------------------------------------------- theory -- */

const MODES = {
  'dorian':          [0, 2, 3, 5, 7, 9, 10],
  'lydian':          [0, 2, 4, 6, 7, 9, 11],
  'mixolydian':      [0, 2, 4, 5, 7, 9, 10],
  'aeolian':         [0, 2, 3, 5, 7, 8, 10],
  'ionian':          [0, 2, 4, 5, 7, 9, 11],
  'phrygian':        [0, 1, 3, 5, 7, 8, 10],
  'lydian dominant': [0, 2, 4, 6, 7, 9, 10],
  'major pentatonic':[0, 2, 4, 7, 9],
  'minor pentatonic':[0, 3, 5, 7, 10],
};
const MODE_NAMES = Object.keys(MODES);
const MODE_WEIGHTS = [3, 2.2, 2.2, 2, 1.2, 1, 1.6, 0.8, 0.8];

const METERS = [
  { name: '5/4',  beats: 5 },
  { name: '7/8',  beats: 7 },
  { name: '9/8',  beats: 9 },
  { name: '11/8', beats: 11 },
  { name: '13/8', beats: 13 },
];
const METER_WEIGHTS = [2, 3, 3, 2, 0.8];

const NOTE_NAMES = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

/* euclidean rhythm: k hits spread evenly over n steps, rotated */
function euclidHit(k, n, rot, i) {
  const j = (((i - rot) % n) + n) % n;
  return (j * k) % n < k;
}

/* variable-length generations: each UTC hour is deterministically cut into
   2–5 segments of 10–30 minutes that tile it exactly, so which generation
   is sounding is still a pure function of wall time. A generation's id is
   hourIndex * GEN_SLOTS + segmentIndex — unique and monotonic. */
const GEN_SLOTS = 6;
const segCache = new Map();
function hourSegs(e) {
  if (segCache.has(e)) return segCache.get(e);
  const r = R('seg', e);
  const k = wpick(r, [2, 3, 4, 5], [1.2, 3, 3, 1]);
  const segs = [];
  let left = HOUR, t0 = e * HOUR;
  for (let i = 0; i < k; i++) {
    const m = k - 1 - i;   // segments still to place after this one
    /* feasibility-clamped draw: every segment lands in [600, 1800] s and
       the last one closes the hour exactly */
    const lo = Math.max(600, left - 1800 * m);
    const hi = Math.min(1800, left - 600 * m);
    const len = m === 0 ? left : Math.round(lo + r() * (hi - lo));
    segs.push({ g: e * GEN_SLOTS + i, start: t0, len });
    t0 += len; left -= len;
  }
  segCache.set(e, segs);
  if (segCache.size > 60) segCache.delete(segCache.keys().next().value);
  return segs;
}
function genAt(w) {
  const segs = hourSegs(Math.floor(w / HOUR));
  for (const s of segs) if (w < s.start + s.len) return s;
  return segs[segs.length - 1];
}
const genSeg = g => hourSegs(Math.floor(g / GEN_SLOTS))[g % GEN_SLOTS];
function genAfter(g) {
  const e = Math.floor(g / GEN_SLOTS), i = g % GEN_SLOTS;
  const segs = hourSegs(e);
  return i + 1 < segs.length ? segs[i + 1] : hourSegs(e + 1)[0];
}

/* one generation of broadcast = one "movement": mode, meter, tempo, textures */
const genCache = new Map();
function genParams(g) {
  if (genCache.has(g)) return genCache.get(g);
  const seg = genSeg(g);
  const start = seg.start, len = seg.len;
  const day = Math.floor(start / (24 * HOUR));
  const hod = (start % (24 * HOUR)) / HOUR;
  const r = R('gen', g);
  const rd = R('day', day);

  const dayRoot = Math.floor(rd() * 12);            // tonal centre of the day
  const rootPc = (dayRoot + wpick(r, [0, 7, 5, 2, 10, 3], [4, 3, 3, 2, 1, 1])) % 12;
  const modeName = wpick(r, MODE_NAMES, MODE_WEIGHTS);
  const mode = MODES[modeName];
  const meter = wpick(r, METERS, METER_WEIGHTS);

  const pulse = 0.36 + r() * 0.28;                  // seconds per pulse
  const chordSpan = pick(r, [2, 3, 4]);             // bars per chord
  const melK = 2 + Math.floor(r() * (meter.beats > 7 ? 4 : 3));
  const bassK = 2 + (r() < 0.4 ? 1 : 0);
  const bassRot = Math.floor(r() * meter.beats);
  const melBase = 0.32 + r() * 0.34;
  const bright = 0.3 + r() * 0.55;

  /* three overlapping tape-loop bells with mutually prime cycle lengths */
  const loops = [0, 1, 2].map(() => ({
    len: pick(r, [11, 13, 17, 19, 23, 29, 31]),
    deg: Math.floor(r() * mode.length),
    oct: 5 + (r() < 0.4 ? 1 : 0),
    phase: 0,
    gain: 0.5 + r() * 0.5,
  })).map(L => (L.phase = Math.floor(r() * L.len), L));

  /* the weather: nature layer follows UTC time of day */
  const wind = 0.4 + r() * 0.6;
  const water = r() < 0.45 ? 0.3 + r() * 0.7 : 0;
  let birds = 0, crickets = 0;
  if (hod >= 4 && hod < 10) birds = 0.55;
  else if (hod >= 10 && hod < 18) birds = 0.25;
  else if (hod >= 18 && hod < 21) birds = 0.1;
  if (hod >= 20 || hod < 5) crickets = 0.5;

  /* the pluck kit: short-attack voices to cut through the sustained wash */
  const pluckVoice = r() < 0.55 ? 'string' : 'kalimba';
  const melPluck = wpick(r, [0, 0.35, 0.8], [1, 2, 1.3]);   // plucked-melody odds
  const arpAmt = r() < 0.6 ? 0.3 + r() * 0.45 : 0;          // plucked-arp presence
  const arpK = 3 + Math.floor(r() * 3);
  const arpRot = Math.floor(r() * meter.beats);

  /* the ostinato: a small clockwork figure whose steps index into the
     sounding chord, so it re-pitches itself as the harmony moves; rests
     keep it breathing */
  const ostLen = pick(r, [3, 4, 5, 6]);
  const ostPat = [];
  for (let i = 0; i < ostLen; i++) ostPat.push({
    ci: Math.floor(r() * 3),
    oct: r() < 0.25 ? 1 : 0,
    rest: r() < 0.18,
  });
  const ostStep = r() < 0.6 ? 1 : 2;                        // pulses per step
  const ostLevel = 0.45 + r() * 0.3;
  /* the figure's instrument: the pluck kit's other half, or a bare sine or
     triangle sung with long decay and a breath of vibrato into the reverb */
  const ostVoice = wpick(r, ['pluck', 'sine', 'triangle'], [1.2, 1, 1]);

  /* per-generation tone: pre-reverb lowpass cutoff — some movements are open,
     others muffled like a worn tape (weighted toward warm, capped low so
     nothing turns glassy) */
  const toneHz = 1200 + Math.pow(r(), 1.5) * 3300;

  /* register: each movement folds its melody into its own octave window,
     so successive generations don't all sit in the same range */
  const melShift = wpick(r, [-12, -7, 0, 5, 12], [1.2, 1.6, 1.6, 1.5, 1.1]);

  /* arrangement: pad + drone open every generation; the other layers enter
     in a shuffled order, staggered across the first half, each with its own
     fade-in (the first layer often sounds from the top). Entry points and
     fades scale with the generation's length. */
  const order = ['mel', 'bells', 'bass', 'arp', 'ost'];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const firstFromTop = r() < 0.55;
  const enters = {};
  order.forEach((k, i) => {
    const at = (0.03 + i * 0.1 + r() * 0.08) * len;
    const fade = Math.min(60 + r() * 150, len * 0.15);
    enters[k] = i === 0 && firstFromTop ? { at: 0, fade: 1 } : { at, fade };
  });
  const outroDur = Math.min(120, Math.round(len * 0.15));

  /* per-generation timbre: every voice redraws its envelope, colour and
     sends each movement, so no two generations share an instrument exactly.
     Cutoffs stay deliberately low — soft sources into a long reverb. */
  const rt = R('timbre', g);
  const timbre = {
    pad:   { atk: 0.6 + rt() * 0.9, rel: 5 + rt() * 4,
             lp: 300 + rt() * 240, det: 3 + rt() * 9,
             wave: rt() < 0.6 ? 'triangle' : 'sine' },
    mel:   { atk: 0.3 + rt() * 0.5, rel: 4 + rt() * 2.5,
             lp: 1000 + rt() * 650, sub: 0.25 + rt() * 0.3,
             det: 3 + rt() * 6, wave2: rt() < 0.65 ? 'triangle' : 'sine' },
    bell:  { lp: 1300 + rt() * 800, dec: 6.5 + rt() * 3.5,
             hi: 0.35 + rt() * 0.55 },
    bass:  { lp: 230 + rt() * 90, atk: 0.03 + rt() * 0.06,
             dec: 2.5 + rt() * 1.3 },
    pluck: { damp: pick(rt, [0.9955, 0.9965, 0.9975, 0.9983]),
             lp: 850 + rt() * 900 },
    kal:   { dec: 0.75 + rt() * 0.6 },
    ostT:  { atk: 0.02 + rt() * 0.04, dec: 3 + rt() * 2.5,
             lp: 900 + rt() * 700,
             lfoHz: 2.5 + rt() * 2.5, lfoCents: 3 + rt() * 4 },
    verb:  0.75 + rt() * 0.5,        // reverb-send multiplier
    delay: { time: Math.min(0.92, pulse * pick(rt, [1, 1.5, 2])),
             fb: 0.22 + rt() * 0.2,
             amt: rt() < 0.7 ? 0.1 + rt() * 0.22 : 0 },
  };

  const P = { g, start, len, day, hod, rootPc, modeName, mode, meter, pulse,
              chordSpan, melK, bassK, bassRot, melBase, bright, loops,
              wind, water, birds, crickets,
              pluckVoice, melPluck, arpAmt, arpK, arpRot, toneHz,
              ostLen, ostPat, ostStep, ostLevel, ostVoice,
              melShift, enters, outroDur, timbre,
              barDur: meter.beats * pulse };
  genCache.set(g, P);
  if (genCache.size > 80) genCache.delete(genCache.keys().next().value);
  return P;
}

/* chords: tertian stacks with 7ths/9ths/13ths, sometimes quartal */
function chordAt(g, ci, P) {
  const r = R('chord', g, ci);
  let deg;
  if (ci % 4 === 0 && r() < 0.7) deg = 0;
  else deg = wpick(r, [0, 3, 4, 5, 1, 2, 6], [3, 3, 3, 2, 2, 1, 1]);
  deg %= P.mode.length;
  let degrees;
  if (P.mode.length >= 7 && r() < 0.22) {
    degrees = [deg, deg + 3, deg + 6, deg + 9];          // quartal voicing
  } else {
    degrees = [deg, deg + 2, deg + 4];
    if (r() < 0.8)  degrees.push(deg + 6);               // 7th
    if (r() < 0.45) degrees.push(deg + 8);               // 9th
    if (r() < 0.2)  degrees.push(deg + 12);              // 13th
  }
  return { deg, degrees };
}

function degreeToMidi(P, degree, baseOct) {
  const L = P.mode.length;
  const oct = Math.floor(degree / L);
  const step = ((degree % L) + L) % L;
  return P.rootPc + P.mode[step] + (baseOct + oct) * 12;
}

/* fold a midi note into a register by octaves */
function fold(m, lo, hi) {
  while (m > hi) m -= 12;
  while (m < lo) m += 12;
  return m;
}

/* voice a chord for the pad: spread over octaves, folded into range */
function padVoicing(P, chord) {
  const octs = [3, 4, 4, 5, 5, 6];
  const midis = [];
  chord.degrees.forEach((d, i) => {
    const m = fold(degreeToMidi(P, d, octs[Math.min(i, octs.length - 1)]), 41, 83);
    if (!midis.includes(m)) midis.push(m);
  });
  return midis;
}

/* pull a melody degree toward the sounding chord */
function snapToChord(P, deg, chord) {
  const L = P.mode.length;
  let best = deg, bestDist = Infinity;
  for (const cd of chord.degrees) {
    for (let k = -2; k <= 2; k++) {
      const cand = ((cd % L) + L) % L + k * L;
      const d = Math.abs(cand - deg);
      if (d < bestDist) { bestDist = d; best = cand; }
    }
  }
  return best;
}

/* ---------------------------------------------------------------- audio -- */

let actx = null;
let dryBus, wetBus, master, analyser;
let toneDry, toneWet;   // per-generation lowpass, pre-reverb (see genParams toneHz)
let delayBus, delayNode, delayFb;   // feedback delay, retuned per generation
let sfxDry, sfxWet;     // nature-sfx buses: skip the tone/warm lowpasses
let birdBus;            // chirps gather here so the roll can mute them
let noiseBuf;
let drone = null, wind = null, water = null;
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

/* connect a node to the dry and reverb buses at given levels */
function out(node, dryAmt, wetAmt) {
  if (dryAmt > 0) {
    const g = actx.createGain(); g.gain.value = dryAmt;
    node.connect(g); g.connect(dryBus);
  }
  if (wetAmt > 0) {
    const g = actx.createGain(); g.gain.value = wetAmt;
    node.connect(g); g.connect(wetBus);
  }
}

/* tap a voice into the feedback delay at the given send level */
function sendDelay(node, amt) {
  if (amt <= 0) return;
  const g = actx.createGain(); g.gain.value = amt;
  node.connect(g); g.connect(delayBus);
}

/* same, but onto the sfx buses (birds/crickets/wind/water): these keep their
   natural brightness on muffled hours by bypassing the tone/warm lowpasses */
function outSfx(node, dryAmt, wetAmt) {
  if (dryAmt > 0) {
    const g = actx.createGain(); g.gain.value = dryAmt;
    node.connect(g); g.connect(sfxDry);
  }
  if (wetAmt > 0) {
    const g = actx.createGain(); g.gain.value = wetAmt;
    node.connect(g); g.connect(sfxWet);
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
    out(pan, 0.7, 0.55 * P.timbre.verb);
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
  out(pan, 0.6, 0.7 * P.timbre.verb);
  sendDelay(pan, P.timbre.delay.amt);
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
  out(pan, 0.45, 0.85 * P.timbre.verb);
  sendDelay(pan, P.timbre.delay.amt * 0.5);
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
  out(g, 0.85, 0.25 * P.timbre.verb);
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

function playPluck(tc, P, midi, level = 1) {
  const T = P.timbre.pluck;
  const src = actx.createBufferSource();
  src.buffer = pluckBuf(midi, T.damp);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = T.lp + P.bright * 2000;
  const g = actx.createGain(); g.gain.value = 0.09 * level;
  const pan = panner(midi);
  src.connect(lp); lp.connect(g); g.connect(pan);
  out(pan, 0.5, 0.85 * P.timbre.verb);
  sendDelay(pan, P.timbre.delay.amt);
  startNode(src, tc, tc + 1.9);
}

/* struck tine: a few inharmonic partials, each dying fast */
function playKalimba(tc, P, midi, level = 1) {
  const K = P.timbre.kal.dec;
  const f = mtof(midi);
  const pan = panner(midi);
  out(pan, 0.55, 0.8 * P.timbre.verb);
  sendDelay(pan, P.timbre.delay.amt * 0.7);
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

function playPluckVoice(tc, P, midi, level = 1) {
  (P.pluckVoice === 'kalimba' ? playKalimba : playPluck)(tc, P, midi, level);
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
  out(pan, 0.35, 1.15 * P.timbre.verb);
  sendDelay(pan, P.timbre.delay.amt * 0.5);
  const end = tc + T.atk + T.dec + 0.3;
  startNode(o, tc, end);
  startNode(lfo, tc, end);
}

function playOst(tc, P, midi, level = 1) {
  if (P.ostVoice === 'pluck')
    /* the opposite pluck voice from the generation's melody/arp kit, so the
       figure reads as its own instrument */
    (P.pluckVoice === 'kalimba' ? playPluck : playKalimba)(tc, P, midi, level);
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
  outSfx(g, 0.5, 0.35);
  startNode(o, tc, tc + pulses * 0.06 + 0.1);
}

/* -- persistent layers -------------------------------------------------- */

function buildDrone() {
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 520;
  const g = actx.createGain(); g.gain.value = 0.05;
  lp.connect(g);
  out(g, 0.9, 0.4);
  const voices = [
    { oct: 2, interval: 0, detune: 0 },
    { oct: 3, interval: 7, detune: 0 },
    { oct: 3, interval: 0, detune: 5 },
  ].map(v => {
    const o = actx.createOscillator();
    o.type = 'sine'; o.detune.value = v.detune;
    o.frequency.value = 55;
    o.connect(lp);
    o.start();
    return { osc: o, ...v };
  });
  return { voices, gain: g };
}

function updateDrone(tc, P) {
  for (const v of drone.voices) {
    const f = mtof(P.rootPc + v.interval + v.oct * 12);
    v.osc.frequency.setTargetAtTime(f, tc, 4);
  }
}

function buildWind() {
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
  const g = actx.createGain(); g.gain.value = 0.0;
  src.connect(lp); lp.connect(g);
  outSfx(g, 0.9, 0.25);
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
  outSfx(g, 0.8, 0.3);
  /* flutter the filter, not the gain, so silent hours stay silent */
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.31;
  const lfog = actx.createGain(); lfog.gain.value = 90;
  lfo.connect(lfog); lfog.connect(bp.frequency);
  lfo.start();
  src.start();
  return { gain: g };
}

function setWeather(tc, P) {
  wind.gain.gain.setTargetAtTime(0.028 + 0.03 * P.wind, tc, 8);
  water.gain.gain.setTargetAtTime(0.014 * P.water, tc, 8);
}

function setTone(tc, P) {
  toneDry.frequency.setTargetAtTime(P.toneHz, tc, 6);
  toneWet.frequency.setTargetAtTime(P.toneHz, tc, 6);
  /* delay retunes with a short glide — a brief tape-style pitch bend on the
     repeats at the generation seam, in keeping with the worn-tape palette */
  delayNode.delayTime.setTargetAtTime(P.timbre.delay.time, tc, 0.4);
  delayFb.gain.setTargetAtTime(P.timbre.delay.fb, tc, 0.4);
}

/* -- scheduler ----------------------------------------------------------- */

let schedUntil = 0;
let ctxOff = 0;
const visQueue = [];   // note events waiting to become visual pulses

function vis(tw, kind, midi, dur) {
  visQueue.push({ w: tw, kind, midi, dur });
}

/* how present a staggered layer is at broadcast time tw: 0 before its
   entry, smoothstepping up over its fade, 1 once fully in */
function layerLevel(P, key, tw) {
  const x = (tw - P.start - P.enters[key].at) / P.enters[key].fade;
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

/* phrase gates: on top of its entry stagger, each layer breathes in and out
   on its own tide — the generation is cut into `win`-second windows and each
   window's fate is one seeded draw, so every listener hears the same
   phrasing. State changes crossfade over a few seconds, not cuts. */
function phraseGate(P, key, tw, win, onProb) {
  const t = tw - P.start;
  const i = Math.floor(t / win);
  const on = j => rand('pg' + key, P.g, Math.max(0, j)) < onProb ? 1 : 0;
  const fade = Math.min(6, win * 0.1);
  const f = t - i * win;
  if (f >= fade) return on(i);
  const u = f / fade, s = u * u * (3 - 2 * u);
  return on(i - 1) + (on(i) - on(i - 1)) * s;
}

/* the pad's gate is decided per chord start, so whole chords sit out
   (the drone holds the floor). Window 0 is always on: generations open
   sounding, and the p===0 weather/tone refresh that rides the pad still
   fires. */
function padOn(P, tw) {
  const i = Math.floor((tw - P.start) / 110);
  return i <= 0 || rand('pgpad', P.g, i) < 0.72;
}

/* every note a pulse produces, as pure data with no audio side effects —
   the scheduler plays these and the midi roll draws them, so the roll always
   shows exactly what was decided */
function pulseEvents(P, p, tw) {
  const evs = [];
  const g = P.g;
  const beats = P.meter.beats;
  const bar = Math.floor(p / beats);
  const step = p % beats;
  const chordIdx = Math.floor(bar / P.chordSpan);
  const chord = chordAt(g, chordIdx, P);
  /* the movement thins toward its close, ending on pad + drone */
  const outro = Math.min(1, (P.start + P.len - tw) / P.outroDur);

  /* chord change: pad bloom (whole chords sit out on the pad's off-windows) */
  if (step === 0 && bar % P.chordSpan === 0 && padOn(P, tw)) {
    evs.push({ kind: 'pad', tw, dur: P.chordSpan * P.barDur, chord, P });
  }

  /* euclidean bass: strictly chord tones (root-weighted), breathing on its
     own window, an octave up out of the mud */
  if (euclidHit(P.bassK, beats, P.bassRot, step)
      && rand('bs', g, p) < 0.7 * layerLevel(P, 'bass', tw)
                          * phraseGate(P, 'bass', tw, 140, 0.75)) {
    const br = rand('bsd', g, p);
    const d = br < 0.55 ? chord.degrees[0]
            : br < 0.8  ? chord.degrees[2]
            :             chord.degrees[1];
    evs.push({ kind: 'bass', tw, midi: fold(degreeToMidi(P, d, 2), 36, 52), dur: 1.8 });
  }

  /* euclidean melody, contoured by slow value-noise, drawn to chord tones,
     phrasing in and out every couple of minutes */
  const melGate = phraseGate(P, 'mel', tw, 120, 0.55);
  const rot = Math.floor(rand('mrot', g, bar) * beats);
  const density = P.melBase * (0.55 + vnoise('dn' + g, bar * 0.13))
                * layerLevel(P, 'mel', tw) * melGate * outro;
  if (euclidHit(P.melK, beats, rot, step) && rand('ml', g, p) < density) {
    let deg = Math.round(vnoise('mc' + g, p * 0.09) * (P.mode.length * 2) - 2);
    if (rand('snap', g, p) < 0.55) deg = snapToChord(P, deg, chord);
    /* shift into this generation's register (some bars step an octave up or
       down), then fold back inside absolute bounds — shift-then-fold moves
       the whole line, where a shifted fold window would only nudge the
       outliers */
    const lr = rand('moct', g, bar);
    const lift = lr < 0.12 ? 12 : lr < 0.22 ? -12 : 0;
    const midi = fold(fold(degreeToMidi(P, deg, 5), 55, 81) + P.melShift + lift, 46, 93);
    if (rand('plv', g, p) < P.melPluck) evs.push({ kind: 'mpluck', tw, midi, dur: 1.4 });
    else evs.push({ kind: 'mel', tw, midi, dur: 2.6 });
  }

  /* plucked arpeggio: chord tones scattered on their own euclidean grid;
     its gate lifts when the melody rests, so the two answer each other */
  const arpGate = Math.max(phraseGate(P, 'arp', tw, 100, 0.6),
                           (1 - melGate) * 0.75);
  if (P.arpAmt > 0 && euclidHit(P.arpK, beats, P.arpRot, step)
      && rand('ar', g, p) < P.arpAmt * layerLevel(P, 'arp', tw) * arpGate * outro) {
    const ci = Math.floor(rand('arn', g, p) * chord.degrees.length);
    const midi = fold(fold(degreeToMidi(P, chord.degrees[ci], 5), 60, 81)
                      + P.melShift, 48, 93);
    evs.push({ kind: 'arp', tw, midi, dur: 1.2,
               level: 0.55 + rand('arv', g, p) * 0.45 });
  }

  /* ostinato: the generation's clockwork figure, re-pitched to the sounding
     chord, drifting in and out on a five-minute tide */
  const ostGate = phraseGate(P, 'ost', tw, 300, 0.5)
                * layerLevel(P, 'ost', tw) * outro;
  if (ostGate > 0.03 && p % P.ostStep === 0) {
    const st = P.ostPat[(p / P.ostStep) % P.ostLen];
    if (!st.rest) {
      const d = chord.degrees[st.ci % chord.degrees.length] + st.oct * P.mode.length;
      const midi = fold(degreeToMidi(P, d, 4), 52, 69);
      evs.push({ kind: 'ost', tw, midi, dur: 1.1, level: P.ostLevel * ostGate });
    }
  }

  /* overlapping bell loops (the tape-loop layer), on a slow generous tide */
  const bellLvl = layerLevel(P, 'bells', tw) * phraseGate(P, 'bells', tw, 150, 0.7);
  if (bellLvl > 0) {
    for (const L of P.loops) {
      if (p % L.len === L.phase) {
        const midi = fold(degreeToMidi(P, L.deg, L.oct), 57, 83);
        evs.push({ kind: 'bell', tw, midi, dur: 6, level: L.gain * bellLvl });
      }
    }
  }
  return evs;
}

/* per-track listening mutes (midi roll) — local ears only, the broadcast and
   its visuals are untouched; scheduled kinds take effect within LOOKAHEAD */
const rollMute = { birds: false, bells: false, mel: false, arp: false,
                   ost: false, pad: false, bass: false, drone: false };
const KIND_TRACK = { pad: 'pad', bell: 'bells', mel: 'mel', mpluck: 'mel',
                     arp: 'arp', ost: 'ost', bass: 'bass', bird: 'birds',
                     drone: 'drone' };

function schedulePulse(P, p, tw) {
  const tc = tw + ctxOff;
  for (const e of pulseEvents(P, p, tw)) {
    const muted = rollMute[KIND_TRACK[e.kind]];
    switch (e.kind) {
      case 'pad':
        if (!muted) playPad(tc, e.dur, P, e.chord);
        vis(tw, 'pad', degreeToMidi(P, e.chord.deg, 4), Math.min(e.dur, 10));
        /* drone glide + weather refresh ride along on the chord change */
        updateDrone(tc, P);
        if (p === 0) { setWeather(tc, P); setTone(tc, P); }
        break;
      case 'bass':
        if (!muted) playBass(tc, P, e.midi);
        vis(tw, 'bass', e.midi, e.dur);
        break;
      case 'mel':
        if (!muted) playTone(tc, P, e.midi);
        vis(tw, 'mel', e.midi, e.dur);
        break;
      case 'mpluck':
        if (!muted) playPluckVoice(tc, P, e.midi);
        vis(tw, 'pluck', e.midi, e.dur);
        break;
      case 'arp':
        if (!muted) playPluckVoice(tc, P, e.midi, e.level);
        vis(tw, 'pluck', e.midi, e.dur);
        break;
      case 'ost':
        if (!muted) playOst(tc, P, e.midi, e.level);
        vis(tw, 'pluck', e.midi, e.dur);
        break;
      case 'bell':
        if (!muted) playBell(tc, P, e.midi, e.level);
        vis(tw, 'bell', e.midi, e.dur);
        break;
    }
  }
}

/* one slot of the birds/crickets lattice: the leading draws decide presence,
   so the midi roll can reproduce them; the returned r stream continues into
   the chirp itself — draw order matches the scheduler exactly */
const SLOT = 4;
function slotAt(s) {
  const P = genParams(genAt(s * SLOT).g);
  const r = R('slot', s);
  const off = r() * 3;
  const bird = P.birds > 0 && r() < P.birds;
  return { P, r, tw: s * SLOT + off, bird };
}

function scheduleRange(w0, w1) {
  /* pulse grid, anchored to each generation */
  for (let seg = genAt(w0); seg.start < w1; seg = genAfter(seg.g)) {
    const P = genParams(seg.g);
    let p = Math.max(0, Math.ceil((w0 - P.start) / P.pulse - 1e-9));
    for (;; p++) {
      const t = P.start + p * P.pulse;
      if (t >= w1 || t >= P.start + P.len) break;
      if (t < w0) continue;
      schedulePulse(P, p, t);
    }
  }
  /* birds and crickets live on their own 4-second lattice */
  const s0 = Math.ceil(w0 / SLOT), s1 = Math.floor(w1 / SLOT);
  for (let s = s0; s <= s1; s++) {
    const t = s * SLOT;
    if (t < w0 || t >= w1) continue;
    const { P, r, tw, bird } = slotAt(s);
    if (bird) {
      playChirp(tw + ctxOff, r);
      vis(tw, 'bird', 84 + Math.floor(r() * 12), 1.2);
    }
    if (P.crickets > 0 && r() < P.crickets) {
      playCricket(tw + ctxOff, r);
    }
  }
}

function tick() {
  const now = wallNow();
  ctxOff = actx.currentTime - now;
  if (schedUntil < now + 0.05) schedUntil = now + 0.05;
  const until = now + LOOKAHEAD;
  if (until > schedUntil) {
    scheduleRange(schedUntil, until);
    schedUntil = until;
  }
}

/* -- start --------------------------------------------------------------- */

function start() {
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
  /* per-generation tone filters sit before the reverb so its tail is
     filtered too; matched pair because dry/wet levels are set per voice at
     connect time */
  toneDry = actx.createBiquadFilter(); toneDry.type = 'lowpass';
  toneWet = actx.createBiquadFilter(); toneWet.type = 'lowpass';
  const verb = actx.createConvolver();
  verb.buffer = makeImpulse();
  wetBus.connect(toneWet); toneWet.connect(verb);
  dryBus.connect(toneDry); toneDry.connect(warm); verb.connect(warm);
  warm.connect(comp); comp.connect(analyser);
  analyser.connect(master); master.connect(actx.destination);

  /* feedback delay: time/feedback/send redrawn per generation (setTone).
     A lowpass inside the loop darkens every repeat, and the output feeds
     the normal dry/wet buses so echoes wear the same tone and reverb */
  delayBus = actx.createGain();
  delayNode = actx.createDelay(1.5);
  delayFb = actx.createGain(); delayFb.gain.value = 0.3;
  const dLp = actx.createBiquadFilter();
  dLp.type = 'lowpass'; dLp.frequency.value = 1400;
  delayBus.connect(delayNode); delayNode.connect(dLp);
  dLp.connect(delayFb); delayFb.connect(delayNode);
  out(dLp, 0.55, 0.4);

  /* sfx path joins at the compressor, past every lowpass; its own reverb
     (same impulse) so even the tail stays unfiltered */
  sfxDry = actx.createGain();
  sfxWet = actx.createGain(); sfxWet.gain.value = 0.9;
  const sfxVerb = actx.createConvolver();
  sfxVerb.buffer = verb.buffer;
  sfxWet.connect(sfxVerb); sfxVerb.connect(comp);
  sfxDry.connect(comp);
  birdBus = actx.createGain();
  outSfx(birdBus, 0.35, 0.65);

  noiseBuf = makeNoise();
  drone = buildDrone();
  wind = buildWind();
  water = buildWater();

  /* tune in mid-broadcast: sound the chord already in the air */
  tuneIn();
  tick();
  setInterval(tick, TICK_MS);
}

/* drop into the broadcast at the current wall time: sound the chord already
   in the air, glide the drone, set the weather, restart the scheduler */
function tuneIn() {
  const now = wallNow();
  ctxOff = actx.currentTime - now;
  const P = genParams(genAt(now).g);
  const p = Math.floor((now - P.start) / P.pulse);
  const bar = Math.floor(p / P.meter.beats);
  const chordIdx = Math.floor(bar / P.chordSpan);
  const chord = chordAt(P.g, chordIdx, P);
  const chordStart = P.start + chordIdx * P.chordSpan * P.barDur;
  const elapsed = now - chordStart;
  const remain = Math.max(2, P.chordSpan * P.barDur - elapsed);
  /* only if the broadcast's pad is actually sounding this chord */
  if (padOn(P, chordStart)) playPad(actx.currentTime + 0.15, remain, P, chord, elapsed);
  updateDrone(actx.currentTime, P);
  setWeather(actx.currentTime, P);
  /* snap, don't glide: joins and jumps should land on this generation's
     tone and delay */
  toneDry.frequency.setValueAtTime(P.toneHz, actx.currentTime);
  toneWet.frequency.setValueAtTime(P.toneHz, actx.currentTime);
  delayNode.delayTime.setValueAtTime(P.timbre.delay.time, actx.currentTime);
  delayFb.gain.setValueAtTime(P.timbre.delay.fb, actx.currentTime);
  schedUntil = now + 0.2;
}

/* after a debug time-jump: silence the old moment, enter the new one */
function retune() {
  if (!started) return;
  cutLiveNodes();
  visQueue.length = 0;
  pulses.length = 0;
  roll.w0 = roll.w1 = 0;   // stale audit — the roll rebuilds next frame
  tuneIn();
  tick();
}

/* ---------------------------------------------------------------- visual -- */

const canvas = document.getElementById('scene');
const ctx2d = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const pulses = [];       // live visual note-shapes
let lastUiSec = -1;      // throttle for syncing CSS vars to the sky palette
let bandLow = 0, bandMid = 0, bandHigh = 0;
const freqData = new Uint8Array(256);

function readBands() {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  const avg = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += freqData[i];
    return s / ((b - a) * 255);
  };
  bandLow  += (avg(1, 9)   - bandLow)  * 0.08;
  bandMid  += (avg(9, 40)  - bandMid)  * 0.08;
  bandHigh += (avg(40, 140) - bandHigh) * 0.08;
}

function mix(c1, c2, t) {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ];
}
const css = (c, a = 1) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

const PAPER_DAY   = [243, 238, 227];
const RIDGE_FAR   = [221, 212, 194];
const RIDGE_NEAR  = [116, 106, 91];
const INK         = [58, 53, 44];
const CLAY        = [168, 126, 95];
const FADED       = [141, 132, 116];

/* time-of-day palette — [utcHour, sky, sun] keyframes, smoothly
   interpolated (wrapping past midnight). UTC so every listener sees
   the same sky, matching the broadcast's shared clock. */
const SKY_STOPS = [
  [ 0.0, [ 62,  70,  92], [214, 216, 222]],  // deep night
  [ 4.5, [ 62,  70,  92], [214, 216, 222]],
  [ 6.0, [132, 128, 148], [228, 178, 150]],  // pre-dawn
  [ 7.5, [235, 208, 180], [236, 186, 130]],  // dawn
  [ 9.5, [243, 238, 227], [222, 199, 158]],  // day paper
  [16.0, [243, 238, 227], [222, 199, 158]],
  [18.0, [240, 216, 172], [232, 168, 108]],  // golden hour
  [19.5, [226, 170, 128], [226, 132,  84]],  // sunset
  [21.0, [118, 112, 134], [216, 196, 180]],  // dusk
  [22.5, [ 62,  70,  92], [214, 216, 222]],
];

function skyAt(hod) {
  const n = SKY_STOPS.length;
  for (let i = 0; i < n; i++) {
    const a = SKY_STOPS[i], b = SKY_STOPS[(i + 1) % n];
    const h2 = i + 1 < n ? b[0] : b[0] + 24;
    if (hod >= a[0] && hod < h2) {
      let u = (hod - a[0]) / (h2 - a[0]);
      u = u * u * (3 - 2 * u);
      return { sky: mix(a[1], b[1], u), sun: mix(a[2], b[2], u) };
    }
  }
  return { sky: SKY_STOPS[0][1], sun: SKY_STOPS[0][2] };
}

const lum = c => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
const DAY_L = lum(PAPER_DAY), NIGHT_L = lum(SKY_STOPS[0][1]);

/* per-frame inks, lightened as the sky darkens so shapes stay legible */
let inkNow = INK, clayNow = CLAY;
let inkTNow = 0;   // the same day↔night flip, for the midi roll's palette

function pitchX(midi) {
  const fifths = ((midi * 7) % 12) / 11;
  return W * (0.08 + 0.84 * fifths) + (ih(midi, 5) - 0.5) * 40;
}

function drawShape(kind, x, y, s, alpha, midi) {
  ctx2d.lineWidth = 1.1;
  if (kind === 'mel') {
    ctx2d.strokeStyle = css(inkNow, alpha);
    ctx2d.beginPath();
    ctx2d.moveTo(x, y - s);
    ctx2d.lineTo(x + s * 0.87, y + s * 0.5);
    ctx2d.lineTo(x - s * 0.87, y + s * 0.5);
    ctx2d.closePath();
    ctx2d.stroke();
  } else if (kind === 'bell') {
    ctx2d.strokeStyle = css(clayNow, alpha);
    ctx2d.beginPath();
    ctx2d.moveTo(x, y - s);
    ctx2d.lineTo(x + s, y);
    ctx2d.lineTo(x, y + s);
    ctx2d.lineTo(x - s, y);
    ctx2d.closePath();
    ctx2d.stroke();
  } else if (kind === 'bass') {
    ctx2d.fillStyle = css(inkNow, alpha * 0.7);
    ctx2d.fillRect(x - s / 2, y - s / 2, s, s);
  } else if (kind === 'pluck') {
    ctx2d.strokeStyle = css(inkNow, alpha * 0.85);
    ctx2d.beginPath();
    ctx2d.moveTo(x, y - s);
    ctx2d.lineTo(x, y + s);
    ctx2d.stroke();
  } else if (kind === 'bird') {
    ctx2d.fillStyle = css(inkNow, alpha * 0.8);
    ctx2d.beginPath();
    ctx2d.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx2d.fill();
  }
}

function frame() {
  requestAnimationFrame(frame);
  readBands();
  const now = wallNow();
  const t = now;
  const hod = (Math.floor(now / HOUR) % 24 + (now % HOUR) / HOUR) % 24;
  const dayness = 0.5 + 0.5 * Math.cos(((hod - 13) / 24) * Math.PI * 2);

  /* sky */
  const { sky, sun } = skyAt(hod);
  const night = Math.min(1, Math.max(0, (DAY_L - lum(sky)) / (DAY_L - NIGHT_L)));
  /* flip the ink decisively around mid-dusk — a gradual fade leaves it
     mid-grey on a mid-toned sky, unreadable both ways */
  const flip = Math.min(1, Math.max(0, (night - 0.45) / 0.35));
  const inkT = flip * flip * (3 - 2 * flip);
  inkTNow = inkT;
  inkNow  = mix(INK,  [225, 221, 208], inkT);
  clayNow = mix(CLAY, [214, 178, 148], night * 0.7);
  ctx2d.fillStyle = css(sky);
  ctx2d.fillRect(0, 0, W, H);

  /* keep the page chrome on the same palette (once a second is plenty) */
  if ((now | 0) !== lastUiSec) {
    lastUiSec = now | 0;
    const st = document.documentElement.style;
    st.setProperty('--paper', css(sky));
    st.setProperty('--ink', css(inkNow));
    st.setProperty('--faded', css(mix(FADED, [162, 166, 184], night)));
    st.setProperty('--clay', css(clayNow));
  }

  /* activate queued note pulses whose moment has arrived
     (queue is not strictly time-ordered, so scan the whole thing) */
  for (let i = visQueue.length - 1; i >= 0; i--) {
    if (visQueue[i].w <= now) {
      pulses.push({ ...visQueue[i], start: now });
      visQueue.splice(i, 1);
      if (pulses.length > 80) pulses.shift();
    }
  }

  /* sun — a breathing disc with a fractal-noise rim */
  const scx = W * 0.7;
  const scy = H * (0.18 + 0.13 * (1 - dayness));
  const r0 = Math.min(W, H) * 0.085 * (1 + bandLow * 0.25);
  ctx2d.fillStyle = css(mix(sun, sky, 0.4), 0.35);
  ctx2d.beginPath();
  ctx2d.arc(scx, scy, r0 * 1.9, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.fillStyle = css(sun, 0.85);
  ctx2d.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const rr = r0 * (1 + 0.09 * (fbm(999, a * 2.2 + t * 0.05, 3) - 0.5) * 2);
    const px = scx + Math.cos(a) * rr, py = scy + Math.sin(a) * rr;
    if (i === 0) ctx2d.moveTo(px, py); else ctx2d.lineTo(px, py);
  }
  ctx2d.closePath();
  ctx2d.fill();

  /* pad rings radiate from the sun on each chord change */
  for (const p of pulses) {
    if (p.kind !== 'pad') continue;
    const u = (now - p.start) / p.dur;
    if (u > 1) continue;
    const alpha = 0.35 * (u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9);
    ctx2d.strokeStyle = css(clayNow, alpha);
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.arc(scx, scy, r0 * (1.1 + u * 2.2), 0, Math.PI * 2);
    ctx2d.stroke();
  }

  /* ridgeline landscape, five layers of fractal noise */
  for (let i = 0; i < 5; i++) {
    const baseY = H * (0.5 + i * 0.108);
    const react = i >= 3 ? bandLow : bandMid;
    const amp = H * (0.05 + i * 0.014) * (1 + react * 0.9);
    const col = mix(RIDGE_FAR, RIDGE_NEAR, i / 4);
    const tinted = mix(col, sky, night * (0.55 - i * 0.06));
    ctx2d.fillStyle = css(tinted, 0.92);
    ctx2d.beginPath();
    ctx2d.moveTo(-4, H + 4);
    for (let x = -4; x <= W + 6; x += 6) {
      const n = fbm(i * 57 + 9,
        x * 0.004 * (0.7 + i * 0.35) + t * (0.005 + i * 0.004), 4);
      ctx2d.lineTo(x, baseY + (n - 0.5) * 2 * amp);
    }
    ctx2d.lineTo(W + 4, H + 4);
    ctx2d.closePath();
    ctx2d.fill();
  }

  /* note shapes */
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    const u = (now - p.start) / p.dur;
    if (u > 1) { pulses.splice(i, 1); continue; }
    if (p.kind === 'pad') continue;
    const alpha = u < 0.12 ? u / 0.12 : 1 - (u - 0.12) / 0.88;
    const grow = 1 + 0.35 * (1 - Math.pow(1 - Math.min(u * 2, 1), 3));
    const x = pitchX(p.midi);
    let y, s;
    if (p.kind === 'mel') {
      y = H * (0.34 - ((p.midi - 60) / 36) * 0.13);
      s = 9 * grow;
    } else if (p.kind === 'bell') {
      y = H * (0.15 - ((p.midi - 72) / 36) * 0.06) + ih(p.midi, 11) * H * 0.05;
      s = 7 * grow;
    } else if (p.kind === 'bass') {
      y = H * 0.9 + ih(p.midi, 7) * H * 0.05;
      s = 8 * grow;
    } else if (p.kind === 'pluck') {
      y = H * (0.3 - ((p.midi - 60) / 36) * 0.13) + ih(p.midi, 17) * H * 0.03;
      s = 6 * grow;
    } else { // bird
      y = H * (0.08 + ih(p.midi, 13) * 0.12);
      s = 3;
    }
    drawShape(p.kind, x, y, s, Math.max(0, alpha) * 0.9, p.midi);
  }

  if (roll.open) drawRoll(now);
}
requestAnimationFrame(frame);

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

/* ------------------------------------------------------------- midi roll -- */
/* a daw-style lane view of the broadcast: every layer named, past on the
   left of the playhead, future on the right — all re-derived from the same
   pure functions the scheduler uses, so it shows exactly what will sound */

const rollEl = document.getElementById('roll');
const rollCanvas = document.getElementById('rollcanvas');
const rctx = rollCanvas.getContext('2d');
const rollInfo = document.getElementById('rollinfo');

const roll = { open: false, win: 90, evs: [], w0: 0, w1: 0 };

/* lane order follows register, top to bottom; lo/hi are each voice's actual
   fold bounds, so vertical position within a lane is honest pitch */
const ROLL_TRACKS = [
  { key: 'birds', name: 'birds',  lo: 0,  hi: 1  },
  { key: 'bells', name: 'bells',  lo: 57, hi: 83 },
  { key: 'mel',   name: 'melody', lo: 46, hi: 93 },
  { key: 'arp',   name: 'arp',    lo: 48, hi: 93 },
  { key: 'ost',   name: 'ostinato', lo: 52, hi: 69 },
  { key: 'pad',   name: 'pad',    lo: 41, hi: 83 },
  { key: 'bass',  name: 'bass',   lo: 36, hi: 52 },
  { key: 'drone', name: 'drone',  lo: 24, hi: 55 },
];
const LANE_OF = {};
ROLL_TRACKS.forEach((t, i) => LANE_OF[t.key] = i);

/* lane palette — day ink on paper (#f3eee3), night ink on the deep-night
   sky (#3e465c); both validated for lightness band, chroma floor, CVD
   separation and contrast (night's warm slots sit in the sub-3:1 relief
   band, mitigated by the direct lane labels). drone is chrome, not a
   series — it tracks the app's faded ink */
const ROLL_INK = {
  birds: [[161, 131, 8],   [175, 144, 36]],
  bells: [[177, 98, 61],   [206, 124, 86]],
  mel:   [[80, 75, 141],   [141, 137, 215]],
  arp:   [[157, 85, 135],  [204, 114, 158]],
  ost:   [[20, 115, 117],  [74, 161, 165]],
  pad:   [[79, 128, 68],   [108, 165, 96]],
  bass:  [[24, 106, 153],  [77, 156, 208]],
  drone: [[141, 132, 116], [162, 166, 184]],
};
const laneInk = key => mix(ROLL_INK[key][0], ROLL_INK[key][1], inkTNow);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function chordLabel(chord) {
  const quartal = chord.degrees.length === 4
                && chord.degrees[1] - chord.degrees[0] === 3;
  return ROMAN[chord.deg] + (quartal ? 'q' : ['', '7', '9', '13'][chord.degrees.length - 3]);
}

/* what each lane is doing this generation, printed under its name */
function trackSub(key, P) {
  const b = P.meter.beats;
  switch (key) {
    case 'birds': return P.birds > 0 ? `chance ${Math.round(P.birds * 100)}%/4s` : 'tacet (night)';
    case 'bells': return `3 loops · ${P.loops.map(L => L.len).join('·')} pulses`;
    case 'mel':   return `euclid ${P.melK}/${b} · pluck ${Math.round(P.melPluck * 100)}%`;
    case 'arp':   return P.arpAmt > 0 ? `euclid ${P.arpK}/${b} · ${P.pluckVoice}` : 'tacet this gen';
    case 'ost':   return `${P.ostLen}-step figure · ${P.ostVoice === 'pluck'
                    ? (P.pluckVoice === 'kalimba' ? 'string' : 'kalimba')
                    : P.ostVoice}`;
    case 'pad':   return `${P.chordSpan}-bar chords`;
    case 'bass':  return `euclid ${P.bassK}/${b}`;
    case 'drone': return `${NOTE_NAMES[P.rootPc]} root + fifth`;
  }
}

/* pure re-derivation of every event in [w0, w1) — the same walk as
   scheduleRange, with nothing played */
function auditEvents(w0, w1) {
  const evs = [];
  for (let seg = genAt(w0); seg.start < w1; seg = genAfter(seg.g)) {
    const P = genParams(seg.g);
    /* drone strips: root, fifth, octave — re-tuned each generation */
    for (const iv of [24, 36, 43]) {
      evs.push({ kind: 'drone', tw: P.start, dur: P.len, midi: P.rootPc + iv });
    }
    let p = Math.max(0, Math.ceil((w0 - P.start) / P.pulse - 1e-9));
    for (;; p++) {
      const t = P.start + p * P.pulse;
      if (t >= w1 || t >= P.start + P.len) break;
      evs.push(...pulseEvents(P, p, t));
    }
  }
  for (let s = Math.ceil(w0 / SLOT); s * SLOT < w1; s++) {
    const sl = slotAt(s);
    if (sl.bird) evs.push({ kind: 'bird', tw: sl.tw, dur: 0.6, s });
  }
  return evs;
}

function ensureRollEvents(now) {
  const vw0 = now - roll.win * 0.3, vw1 = now + roll.win * 0.7;
  if (vw0 - 40 >= roll.w0 && vw1 <= roll.w1) return;
  /* 40 s of backfill catches a pad chord already sounding; the build-ahead
     margin keeps rebuilds down to one every ~20 s of playback */
  roll.w0 = vw0 - 40;
  roll.w1 = vw1 + Math.max(20, roll.win * 0.25);
  roll.evs = auditEvents(roll.w0, roll.w1);
}

const RULER = 16;   // time ruler strip at the top
const GUT = 150;    // label gutter — click a name there to mute its track

function drawRoll(now) {
  ensureRollEvents(now);
  const Wc = rollCanvas.clientWidth, Hc = rollCanvas.clientHeight;
  if (rollCanvas.width !== Math.round(Wc * DPR) ||
      rollCanvas.height !== Math.round(Hc * DPR)) {
    rollCanvas.width = Math.round(Wc * DPR);
    rollCanvas.height = Math.round(Hc * DPR);
  }
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  rctx.clearRect(0, 0, Wc, Hc);

  const vw0 = now - roll.win * 0.3;
  const pxPerSec = (Wc - GUT) / roll.win;
  const x = t => GUT + (t - vw0) * pxPerSec;
  const laneH = (Hc - RULER) / ROLL_TRACKS.length;
  const laneY = i => RULER + i * laneH;
  const PNow = genParams(genAt(now).g);

  const vline = (px, alpha, y0 = RULER) => {
    rctx.strokeStyle = css(inkNow, alpha);
    rctx.beginPath();
    rctx.moveTo(px, y0); rctx.lineTo(px, Hc);
    rctx.stroke();
  };
  rctx.lineWidth = 1;

  /* lane separators + labels */
  rctx.textAlign = 'left';
  for (let i = 0; i < ROLL_TRACKS.length; i++) {
    const trk = ROLL_TRACKS[i], y = laneY(i);
    rctx.strokeStyle = css(inkNow, 0.12);
    rctx.beginPath();
    rctx.moveTo(0, y + 0.5); rctx.lineTo(Wc, y + 0.5);
    rctx.stroke();
    const muted = rollMute[trk.key];
    rctx.fillStyle = muted ? css(inkNow, 0.35) : css(laneInk(trk.key));
    rctx.font = '11px "Times New Roman", Times, serif';
    rctx.fillText(trk.name, 8, y + 14);
    if (muted) {
      const w = rctx.measureText(trk.name).width;
      rctx.fillRect(7, y + 10.5, w + 2, 1);
    }
    rctx.fillStyle = css(inkNow, 0.45);
    rctx.font = 'italic 9px "Times New Roman", Times, serif';
    rctx.fillText(muted ? 'muted — click to restore' : trackSub(trk.key, PNow),
                  8, y + 25);
  }

  /* per-generation structure: entry shading, bar/chord gridlines, seams */
  for (let seg = genAt(vw0); seg.start < roll.w1; seg = genAfter(seg.g)) {
    const P = genParams(seg.g);
    const hs = P.start, he = P.start + P.len;
    const hx0 = Math.max(GUT, x(hs)), hx1 = Math.min(Wc, x(he));
    if (hx1 <= GUT || hx0 >= Wc) continue;

    /* a lane is dim before its layer enters, half-dim across its fade-in,
       and dim again in the outro (melody + arp thin out) */
    for (const [key, lane] of [['mel', LANE_OF.mel], ['bells', LANE_OF.bells],
                               ['bass', LANE_OF.bass], ['arp', LANE_OF.arp],
                               ['ost', LANE_OF.ost]]) {
      const y = laneY(lane) + 1;
      rctx.fillStyle = css(inkNow, 0.055);
      const en = P.enters[key];
      const ex0 = x(hs), ex1 = Math.min(x(hs + en.at), hx1);
      if (ex1 > hx0) rctx.fillRect(Math.max(hx0, ex0), y, ex1 - Math.max(hx0, ex0), laneH - 1);
      rctx.fillStyle = css(inkNow, 0.03);
      const fx1 = Math.min(x(hs + en.at + en.fade), hx1);
      if (fx1 > ex1 && fx1 > hx0) rctx.fillRect(Math.max(hx0, ex1), y, fx1 - Math.max(hx0, ex1), laneH - 1);
      if (key === 'arp' && P.arpAmt === 0) {
        rctx.fillStyle = css(inkNow, 0.055);
        rctx.fillRect(hx0, y, hx1 - hx0, laneH - 1);
      }
      if (key === 'mel' || key === 'arp' || key === 'ost') {
        const ox = Math.max(hx0, x(he - P.outroDur));
        if (ox < hx1) {
          rctx.fillStyle = css(inkNow, 0.04);
          rctx.fillRect(ox, y, hx1 - ox, laneH - 1);
        }
      }
    }
    if (P.birds === 0) {
      rctx.fillStyle = css(inkNow, 0.055);
      rctx.fillRect(hx0, laneY(LANE_OF.birds) + 1, hx1 - hx0, laneH - 1);
    }

    /* bars (only when legible), chord spans, and the generation seam */
    const barW = P.barDur * pxPerSec;
    if (barW > 14) {
      for (let b = Math.max(0, Math.ceil((vw0 - hs) / P.barDur)); ; b++) {
        const t = hs + b * P.barDur;
        if (t >= he || x(t) > Wc) break;
        if (x(t) >= GUT) vline(x(t), 0.06);
      }
    }
    if (barW * P.chordSpan > 6) {
      for (let c = Math.max(0, Math.ceil((vw0 - hs) / (P.barDur * P.chordSpan))); ; c++) {
        const t = hs + c * P.barDur * P.chordSpan;
        if (t >= he || x(t) > Wc) break;
        if (x(t) >= GUT) vline(x(t), 0.14);
      }
    }
    if (x(hs) >= GUT && x(hs) <= Wc) {
      vline(x(hs), 0.5, 2);
      rctx.fillStyle = css(inkNow, 0.7);
      rctx.font = 'italic 10px "Times New Roman", Times, serif';
      rctx.fillText(
        `${NOTE_NAMES[P.rootPc]} ${P.modeName} · ${P.meter.name} · ${Math.round(60 / (P.pulse * 2))} bpm`,
        x(hs) + 5, 11);
    }
  }

  /* the notes themselves */
  for (const e of roll.evs) {
    const key = KIND_TRACK[e.kind];
    const lane = LANE_OF[key], trk = ROLL_TRACKS[lane];
    const x0 = x(e.tw), x1 = x(e.tw + e.dur);
    if (x1 < GUT || x0 > Wc) continue;
    const alpha = (rollMute[key] ? 0.25 : 0.85)
                * (e.level !== undefined ? 0.35 + 0.65 * e.level : 1);
    const yFor = m => laneY(lane) + 3
      + (1 - (m - trk.lo) / (trk.hi - trk.lo)) * (laneH - 9);
    const cx0 = Math.max(GUT, x0);
    const w = Math.max(1.5, Math.min(Wc, x1) - cx0 - 0.5);
    if (e.kind === 'pad') {
      rctx.fillStyle = css(laneInk('pad'), alpha * 0.8);
      for (const m of padVoicing(e.P, e.chord)) rctx.fillRect(cx0, yFor(m), w, 3);
      if (x1 - x0 > 30 && x0 >= GUT - 2) {
        rctx.fillStyle = css(laneInk('pad'), alpha);
        rctx.font = '10px "Times New Roman", Times, serif';
        rctx.fillText(chordLabel(e.chord), x0 + 3, laneY(lane) + 11);
      }
    } else if (e.kind === 'bird') {
      rctx.fillStyle = css(laneInk('birds'), alpha);
      rctx.beginPath();
      rctx.arc(cx0, laneY(lane) + laneH * (0.3 + 0.45 * ih(e.s, 3)), 1.8, 0, Math.PI * 2);
      rctx.fill();
    } else if (e.kind === 'mpluck') {
      /* plucked melody notes are hollow; sustained ones are solid */
      rctx.strokeStyle = css(laneInk('mel'), alpha);
      rctx.strokeRect(cx0 + 0.5, yFor(e.midi) + 0.5, Math.max(1, w - 1), 2);
    } else {
      rctx.fillStyle = css(laneInk(key), alpha);
      rctx.fillRect(cx0, yFor(e.midi), w, 3);
    }
  }

  /* time ruler */
  const step = roll.win <= 45 ? 5 : roll.win <= 120 ? 15
             : roll.win <= 360 ? 60 : roll.win <= 1200 ? 120 : 600;
  rctx.font = '9px "Times New Roman", Times, serif';
  for (let t = Math.ceil(vw0 / step) * step; t <= vw0 + roll.win; t += step) {
    if (x(t) < GUT) continue;
    rctx.strokeStyle = css(inkNow, 0.3);
    rctx.beginPath();
    rctx.moveTo(x(t), RULER - 4); rctx.lineTo(x(t), RULER);
    rctx.stroke();
    rctx.fillStyle = css(inkNow, 0.45);
    rctx.textAlign = 'center';
    rctx.fillText(new Date((t + ORIGIN) * 1000).toISOString().slice(11, 19), x(t), 8);
  }
  rctx.textAlign = 'left';

  /* playhead */
  rctx.strokeStyle = css(clayNow, 0.9);
  rctx.beginPath();
  rctx.moveTo(x(now), 2); rctx.lineTo(x(now), Hc);
  rctx.stroke();

  if ((now | 0) !== lastRollSec) {
    lastRollSec = now | 0;
    rollInfo.textContent =
      `gen ${PNow.g} · ${Math.round(PNow.len / 60)} min` +
      ` · ${NOTE_NAMES[PNow.rootPc]} ${PNow.modeName} · ${PNow.meter.name}` +
      ` · pulse ${PNow.pulse.toFixed(2)}s · ${weatherWords(PNow)}`;
  }
}
let lastRollSec = -1;

/* mute plumbing: event tracks are gated at schedule time (audible within
   LOOKAHEAD); the persistent drone and the bird bus duck directly */
function setMute(key, m) {
  rollMute[key] = m;
  if (!started) return;
  const t = actx.currentTime;
  if (key === 'drone') drone.gain.gain.setTargetAtTime(m ? 0 : 0.05, t, 0.1);
  if (key === 'birds') birdBus.gain.setTargetAtTime(m ? 0 : 1, t, 0.05);
}

rollCanvas.addEventListener('click', e => {
  const rect = rollCanvas.getBoundingClientRect();
  if (e.clientX - rect.left >= GUT) return;
  const i = Math.floor((e.clientY - rect.top - RULER) /
                       ((rect.height - RULER) / ROLL_TRACKS.length));
  const trk = ROLL_TRACKS[i];
  if (trk) setMute(trk.key, !rollMute[trk.key]);
});

function toggleRoll(show = rollEl.hidden) {
  rollEl.hidden = !show;
  roll.open = show;
  if (show) roll.w0 = roll.w1 = 0;
}

document.getElementById('rollclose').addEventListener('click', () => toggleRoll(false));
document.getElementById('dbgroll').addEventListener('click', () => toggleRoll());
document.querySelectorAll('#rollzoom button').forEach(b =>
  b.addEventListener('click', () => {
    roll.win = parseFloat(b.dataset.win);
    roll.w0 = roll.w1 = 0;
    document.querySelectorAll('#rollzoom button')
      .forEach(o => o.classList.toggle('on', o === b));
  }));

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '`') toggleDebug();
  if (e.key === 'm') toggleRoll();
});
if (new URLSearchParams(location.search).has('debug')) toggleDebug(true);
if (new URLSearchParams(location.search).has('roll')) toggleRoll(true);

setInterval(updateInfo, 1000);
updateInfo();
