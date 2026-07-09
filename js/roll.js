/* roll — the daw-style audit panel: one lane per layer, playhead, gridlines,
   chord numerals, pre-entry/outro shading. Re-derives events via auditEvents
   (the same walk as the scheduler, nothing played) so it can draw future as
   well as past. Lane mutes are local-listening only; the broadcast is never
   altered. */

'use strict';

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
    case 'drone': return `${NOTE_NAMES[P.rootPc]} root${P.droneFifth ? ' + fifth' : ''}`;
  }
}

/* pure re-derivation of every event in [w0, w1) — the same walk as
   scheduleRange, with nothing played */
function auditEvents(w0, w1) {
  const evs = [];
  for (let seg = genAt(w0); seg.start < w1; seg = genAfter(seg.g)) {
    const P = genParams(seg.g);
    /* drone strips: root + octave always; the fifth only ~half the time */
    for (const iv of P.droneFifth ? [24, 36, 43] : [24, 36]) {
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

