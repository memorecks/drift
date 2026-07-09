/* structure — the broadcast's form: each UTC hour is cut into variable
   generations (hourSegs/genAt/genAfter), and genParams turns one generation
   into a whole "movement" — mode, meter, tempo, arrangement, timbre. This is
   where a stretch of time acquires its character. */

'use strict';

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
  const water = r() < 0.7 ? 0.3 + r() * 0.7 : 0;
  /* ~1 in 5 generations it rains (audio layer + clouds/drops in the visuals);
     the birds and crickets mostly shelter from it */
  const rain = r() < 0.22 ? 0.35 + r() * 0.65 : 0;
  let birds = 0, crickets = 0;
  if (hod >= 4 && hod < 10) birds = 0.55;
  else if (hod >= 10 && hod < 18) birds = 0.25;
  else if (hod >= 18 && hod < 21) birds = 0.1;
  if (hod >= 20 || hod < 5) crickets = 0.5;
  if (rain > 0) { birds *= 0.3; crickets *= 0.35; }

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

  /* register: each movement shifts its melody into its own window — measured
     in scale degrees (an octave, or roughly a fifth down / fourth up) so the
     moved line stays inside the mode */
  const melShift = wpick(r, [-mode.length, -Math.round(mode.length * 7 / 12), 0,
                             Math.round(mode.length * 5 / 12), mode.length],
                         [1.2, 1.6, 1.6, 1.5, 1.1]);

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
    bell:  { lp: 500 + rt() * 2500, dec: 6.5 + rt() * 3.5,
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

  /* pad voice archetype — which instrument carries the harmony this
     movement. Own seed stream so the rt() draws above keep their order. */
  const rp = R('padv', g);
  timbre.pad.voice  = wpick(rp, ['duo', 'saw', 'wobble', 'breathe', 'organ'],
                            [30, 20, 18, 17, 15]);
  timbre.pad.spread = 6 + rp() * 8;               // saw ensemble detune, cents
  timbre.pad.lfoHz  = 0.06 + rp() * 0.2;          // wobble / breathe rate
  timbre.pad.lfoAmt = 3 + rp() * 5;               // wobble depth, cents
  timbre.pad.sweep  = 0.3 + rp() * 0.25;          // breathe cutoff swing
  timbre.pad.draw   = [1, 0.3 + rp() * 0.2, 0.1 + rp() * 0.12]; // organ bars

  const P = { g, start, len, day, hod, rootPc, modeName, mode, meter, pulse,
              droneFifth: rand('dr5', g) < 0.5,
              chordSpan, melK, bassK, bassRot, melBase, bright, loops,
              wind, water, rain, birds, crickets,
              pluckVoice, melPluck, arpAmt, arpK, arpRot, toneHz,
              ostLen, ostPat, ostStep, ostLevel, ostVoice,
              melShift, enters, outroDur, timbre,
              barDur: meter.beats * pulse };
  genCache.set(g, P);
  if (genCache.size > 80) genCache.delete(genCache.keys().next().value);
  return P;
}
