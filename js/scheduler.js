/* scheduler — the transport. Pre-schedules LOOKAHEAD seconds of audio each
   tick by walking the pulse grid per generation, playing the events melody.js
   decides and stamping the visuals queue. Also owns start()/tuneIn()/retune():
   building the graph, joining the broadcast mid-chord, and re-entering after a
   debug time-jump. */

'use strict';

let schedUntil = 0;
let ctxOff = 0;
const visQueue = [];   // note events waiting to become visual pulses

function vis(tw, kind, midi, dur) {
  visQueue.push({ w: tw, kind, midi, dur });
}

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
        if (!muted) playPluckVoice(tc, P, e.midi, 1, 'mel');
        vis(tw, 'pluck', e.midi, e.dur);
        break;
      case 'arp':
        if (!muted) playPluckVoice(tc, P, e.midi, e.level, 'arp');
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
  outSfx(birdBus, 0.35, 0.65, 'birds');

  noiseBuf = makeNoise();
  drone = buildDrone();
  wind = buildWind();
  water = buildWater();
  rainLayer = buildRain();

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
