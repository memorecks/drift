/* theory — timeless music primitives: modes, odd meters, euclidean rhythm,
   and the chord/degree math (chordAt, degreeToMidi, fold, voicings, snap).
   Pure functions over a generation's params; no audio, no time, no DOM. */

'use strict';

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
