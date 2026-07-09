/* melody — the compositional decisions, as pure data. layerLevel/phraseGate/
   padOn shape how each layer breathes; pulseEvents(P, p, tw) returns the note
   events one pulse produces (pad/bass/mel/mpluck/arp/ost/bell) with no audio
   side effects, so the scheduler can play them and the midi roll can redraw
   them from the same source of truth. Any new or changed voice must go
   through here (plus KIND_TRACK) or the roll stops matching the audio. */

'use strict';

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
    /* shift into this generation's register (melShift is in scale degrees —
       a diatonic move, so the line stays in the mode; some bars step an
       octave up or down), then fold back inside absolute bounds —
       shift-then-fold moves the whole line, where a shifted fold window
       would only nudge the outliers */
    const lr = rand('moct', g, bar);
    const lift = lr < 0.12 ? 12 : lr < 0.22 ? -12 : 0;
    const midi = fold(fold(degreeToMidi(P, deg, 5), 55, 81)
                      + degShiftSemis(P, deg, P.melShift) + lift, 46, 93);
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
    const ad = chord.degrees[ci];
    const midi = fold(fold(degreeToMidi(P, ad, 5), 60, 81)
                      + degShiftSemis(P, ad, P.melShift), 48, 93);
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
