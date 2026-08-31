/* visual — the canvas render loop: paper sky tinted by UTC hour, a breathing
   fractal sun, five analyser-driven ridgelines, and note shapes placed by
   circle-of-fifths pitch. Reads visQueue (from the scheduler) and the
   analyser; drives the page's CSS palette vars. */

'use strict';

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
/* how hard the sound drives the visuals — user-set via the debug panel's
   "reactivity" fader; 1 is the reference tuning, 0 freezes the motion */
let visIntensity = 1.6;
const freqData = new Uint8Array(256);

function readBands() {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  const avg = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += freqData[i];
    return s / ((b - a) * 255);
  };
  bandLow  += (avg(1, 9)    - bandLow)  * 0.08;
  bandMid  += (avg(9, 40)   - bandMid)  * 0.08;
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

/* rain: eased locally so clouds and drops fade across generation seams,
   roughly tracking the audio layer's own slow ramp */
let rainVis = 0;

/* low drifting cloud bank — fbm-wobbled blobs with flattened bases, drawn
   in front of the sun so a rainy sky reads properly overcast */
function drawClouds(t, sky) {
  const col = mix(sky, [148, 150, 158], 0.35);
  ctx2d.fillStyle = css(col, 0.55 * rainVis);
  for (let c = 0; c < 5; c++) {
    const cw = W * (0.13 + ih(c, 21) * 0.1);
    const ch = cw * (0.3 + ih(c, 25) * 0.15);
    const drift = 0.003 + ih(c, 23) * 0.004;
    const cx = -cw + ((ih(c, 22) + t * drift) % 1) * (W + 2 * cw);
    const cy = H * (0.07 + ih(c, 24) * 0.15);
    ctx2d.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const wob = 1 + 0.6 * (fbm(700 + c * 31, a * 1.4 + t * 0.01, 3) - 0.5);
      const px = cx + Math.cos(a) * cw * wob;
      const py = cy + Math.min(Math.sin(a) * ch * wob, ch * 0.45);
      if (i === 0) ctx2d.moveTo(px, py); else ctx2d.lineTo(px, py);
    }
    ctx2d.closePath();
    ctx2d.fill();
  }
}

/* falling drops: each streak is a pure function of time and its index */
function drawRain(t) {
  const n = Math.round(80 * rainVis);
  const len = H * 0.022;
  ctx2d.strokeStyle = css(inkNow, 0.25 * rainVis);
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  for (let i = 0; i < n; i++) {
    const spd = 0.55 + ih(i, 31) * 0.35;   // screen-heights per second
    const y = ((ih(i, 32) + t * spd) % 1) * (H + 2 * len) - len;
    const x = W * ((ih(i, 33) + t * 0.012) % 1);
    ctx2d.moveTo(x + 2.5, y - len);
    ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

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
  let { sky, sun } = skyAt(hod);
  /* overcast: rain greys and flattens the sky (applied before the night/ink
     flip reads it, so shape colors adapt with it) */
  rainVis += ((genParams(genAt(now).g).rain || 0) - rainVis) * 0.003;
  if (rainVis > 0.01) sky = mix(sky, [148, 150, 152], 0.22 * rainVis);
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
  const r0 = Math.min(W, H) * 0.085 * (1 + bandLow * 0.25 * visIntensity);
  ctx2d.fillStyle = css(mix(sun, sky, 0.4), 0.35);
  ctx2d.beginPath();
  ctx2d.arc(scx, scy, r0 * 1.9, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.fillStyle = css(sun, 0.85 * (1 - 0.45 * rainVis));
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

  if (rainVis > 0.01) drawClouds(t, sky);

  /* ridgeline landscape, five layers of fractal noise */
  for (let i = 0; i < 5; i++) {
    const baseY = H * (0.5 + i * 0.108);
    const react = i >= 3 ? bandLow : bandMid;
    const amp = H * (0.05 + i * 0.014) * (1 + react * 0.9 * visIntensity);
    const col = mix(RIDGE_FAR, RIDGE_NEAR, i / 4);
    const tinted = mix(col, sky, night * (0.55 - i * 0.06));
    /* opaque so the sun's glow is fully occluded rather than bleeding
       through the ridge; layers still read via their differing tint */
    ctx2d.fillStyle = css(tinted);
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

  if (rainVis > 0.01) drawRain(t);

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
