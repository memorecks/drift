/* visual — the canvas render loop. A generation's biome (P.biome, chosen
   deterministically in structure.js) selects one of several environments —
   hills, ocean, forest, coast, snow — each a scene sharing the same day/night
   sky, breathing fractal sun, and analyser-driven motion. Note shapes, pad
   rings, and weather (clouds/rain) are shared overlays. Reads visQueue (from
   the scheduler) and the analyser; drives the page's CSS palette vars. */

'use strict';

/* ---------------------------------------------------------------- visual -- */

const canvas = document.getElementById('scene');
const ctx2d = canvas.getContext('2d');
/* offscreen twin used to dissolve between biomes at a generation seam */
const xcanvas = document.createElement('canvas');
const xctx = xcanvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
/* scene-vertical scale — the reference used to *size* scenery (tree/cliff/stack
   heights, ridgeline spikes) as opposed to *position* it. In a landscape or
   square frame it's just H, so those scenes are untouched; in a tall (portrait,
   e.g. 9:16) frame it's capped near the width so trees, cliffs and sea-stacks
   keep natural proportions instead of stretching into needles and giant walls.
   Positions stay on H (scenery still fills the frame); only heights shrink. */
let SV = 0;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  SV = Math.min(H, W * 1.15);
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
  xcanvas.width = W * DPR; xcanvas.height = H * DPR;
  xctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const pulses = [];       // live visual note-shapes
let lastUiSec = -1;      // throttle for syncing CSS vars to the sky palette
let bandLow = 0, bandMid = 0, bandHigh = 0;
let frameNow = 0;        // wall time of the current frame (shared by helpers)
/* how hard the sound drives the visuals — user-set via the debug panel's
   "reactivity" fader; 1 is the reference tuning, 0 freezes the motion */
let visIntensity = 1.6;
const freqData = new Uint8Array(256);
const XFADE = 8;         // seconds to dissolve into a new generation's biome

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
const WATER_FAR   = [178, 186, 188];   // ocean: near the horizon, borrows sky
const WATER_NEAR  = [104, 122, 128];   // ocean: close water, deeper and cooler
const CANOPY_FAR  = [196, 200, 180];   // forest: pale sage at the back
const CANOPY_NEAR = [ 54,  64,  50];   // forest: deep pine up close
const ROCK_DARK   = [ 74,  66,  68];   // coast: near basalt cliff
const ROCK_MID    = [ 92,  84,  86];   // coast: side cliff
const ROCK_HAZE   = [168, 166, 172];   // coast: distant sea stack
const HEADLAND    = [ 78,  92,  84];   // coast: distant cape, hazed toward sky
const GRASS_LO    = [ 52,  74,  44];   // coast: shaded coastal scrub
const GRASS_HI    = [108, 134,  70];   // coast: sunlit grass
const LILY        = [216, 120,  44];   // coast: orange coastal lily
const WINTER_SKY  = [206, 216, 230];   // snow: crisp cold cast over the paper
const SNOW_FAR    = [236, 239, 243];   // snow: pale bright far drift
const SNOW_NEAR   = [198, 209, 222];   // snow: cooler, shadowed near drift
const TREE_BARE   = [ 48,  50,  58];   // snow: dark bare sapling against snow
const CLOUD_LIT   = [248, 244, 236];   // sky: sunlit cumulus top
const CLOUD_SHADE = [166, 168, 182];   // sky: cool shaded cloud underside

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

/* ------------------------------------------------------- shared scenery -- */

/* a breathing disc with a fractal-noise rim — every biome's sun (and, once
   the sky keyframes pale it out, its moon) */
function drawSun(c, t, scx, scy, r0, sun, sky, rainless) {
  c.fillStyle = css(mix(sun, sky, 0.4), 0.35);
  c.beginPath();
  c.arc(scx, scy, r0 * 1.9, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = css(sun, 0.85 * rainless);
  c.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const rr = r0 * (1 + 0.09 * (fbm(999, a * 2.2 + t * 0.05, 3) - 0.5) * 2);
    const px = scx + Math.cos(a) * rr, py = scy + Math.sin(a) * rr;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

/* pad rings radiate from the sun on each chord change (drawn behind the
   landscape, so a ridge or canopy partly occludes them) */
function drawPadRings(c, scx, scy, r0) {
  for (const p of pulses) {
    if (p.kind !== 'pad') continue;
    const u = (frameNow - p.start) / p.dur;
    if (u > 1) continue;
    const alpha = 0.35 * (u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9);
    c.strokeStyle = css(clayNow, alpha);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(scx, scy, r0 * (1.1 + u * 2.2), 0, Math.PI * 2);
    c.stroke();
  }
}

/* ------------------------------------------------------- biome: hills ----
   five layers of fractal-noise ridgeline — drift's original landscape. */
function biomeHills(c, t, sky, sun, night, dayness) {
  c.fillStyle = css(sky);
  c.fillRect(0, 0, W, H);
  const scx = W * 0.7;
  const scy = H * (0.18 + 0.13 * (1 - dayness));
  const r0 = Math.min(W, H) * 0.085 * (1 + bandLow * 0.25 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, sky, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);
  for (let i = 0; i < 5; i++) {
    const baseY = H * (0.5 + i * 0.108);
    const react = i >= 3 ? bandLow : bandMid;
    const amp = H * (0.05 + i * 0.014) * (1 + react * 0.9 * visIntensity);
    const col = mix(RIDGE_FAR, RIDGE_NEAR, i / 4);
    const tinted = mix(col, sky, night * (0.55 - i * 0.06));
    /* opaque so the sun's glow is fully occluded rather than bleeding
       through the ridge; layers still read via their differing tint */
    c.fillStyle = css(tinted);
    c.beginPath();
    c.moveTo(-4, H + 4);
    for (let x = -4; x <= W + 6; x += 6) {
      const n = fbm(i * 57 + 9,
        x * 0.004 * (0.7 + i * 0.35) + t * (0.005 + i * 0.004), 4);
      c.lineTo(x, baseY + (n - 0.5) * 2 * amp);
    }
    c.lineTo(W + 4, H + 4);
    c.closePath();
    c.fill();
  }
}

/* ------------------------------------------------------- biome: ocean ----
   a low sun over open water, its light scattered into a shimmering column
   of glitter; fbm wave banding calms at the horizon and grows underfoot.
   Reactivity: sun breathes on the lows, glitter sparkles on the highs,
   swell rises on the mids. */
function biomeOcean(c, t, sky, sun, night) {
  c.fillStyle = css(sky);
  c.fillRect(0, 0, W, H);
  const horizon = H * 0.46;
  const scx = W * 0.68, scy = horizon - Math.min(W, H) * 0.14;
  const r0 = Math.min(W, H) * 0.078 * (1 + bandLow * 0.25 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, sky, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);

  const farW  = mix(mix(WATER_FAR, sky, 0.35 + night * 0.3), sky, night * 0.35);
  const nearW = mix(WATER_NEAR, sky, night * 0.45);
  c.fillStyle = css(nearW);
  c.fillRect(0, horizon, W, H - horizon);

  /* sun glitter — short horizontal strokes flickering by noise, widening and
     fading with depth; the highs make the water sparkle */
  const glint = mix(sun, [255, 252, 245], 0.25);
  const sparkle = 0.4 + bandHigh * visIntensity * 0.9;
  const rows = 46;
  for (let i = 0; i < rows; i++) {
    const u = i / (rows - 1);                       // 0 horizon → 1 bottom
    const y = horizon + u * (H - horizon);
    const spread = (0.02 + u * 0.16) * W;
    const amp = (0.5 + fbm(3, t * 0.8 + i * 0.6, 3)) * 0.5;
    const alpha = (1 - u) * 0.5 * (0.4 + 0.6 * amp) * (1 - night * 0.4) * sparkle;
    if (alpha < 0.02) continue;
    const dashes = 2 + (i % 3);
    c.strokeStyle = css(glint, Math.min(0.6, alpha));
    c.lineWidth = 1 + u * 1.6;
    for (let d = 0; d < dashes; d++) {
      const jx = (fbm(5 + d * 7, t * 1.2 + i * 1.3, 2) - 0.5) * spread * 1.4;
      const w = spread * (0.18 + 0.5 * ih(i * 5 + d, 9));
      const cx = scx + jx;
      c.beginPath();
      c.moveTo(cx - w / 2, y);
      c.lineTo(cx + w / 2, y);
      c.stroke();
    }
  }

  /* wave banding — fbm strokes, calmer at the horizon, swelling with the mids */
  const swell = 1 + bandMid * visIntensity * 0.5;
  const lines = 22;
  for (let i = 0; i < lines; i++) {
    const u = i / (lines - 1);
    const y = horizon + Math.pow(u, 1.5) * (H - horizon);
    const band = mix(farW, nearW, u);
    const ink = mix(band, [0, 0, 0], 0.06 + u * 0.05);
    c.strokeStyle = css(ink, 0.35 + u * 0.25);
    c.lineWidth = 0.8 + u * 1.4;
    const amp = (2 + u * u * 22) * swell;
    const wob = 0.006 + u * 0.01;
    c.beginPath();
    for (let x = -4; x <= W + 6; x += 7) {
      const n = fbm(40 + i * 13, x * wob + t * (0.05 + u * 0.12), 3);
      const yy = y + (n - 0.5) * amp
               + Math.sin(x * 0.01 + t * 0.4 + i) * amp * 0.25;
      x === -4 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
}

/* ------------------------------------------------------- biome: forest ---
   layered conifer canopies receding into haze, framed by a few near trunks
   with seeded foliage. Reactivity: sun breathes on the lows, treetops and
   the foliage sway on the mids. */
function biomeForest(c, t, sky, sun, night) {
  c.fillStyle = css(sky);
  c.fillRect(0, 0, W, H);
  const scx = W * 0.72, scy = H * 0.19;
  const r0 = Math.min(W, H) * 0.058 * (1 + bandLow * 0.2 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, sky, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);

  const LAYERS = 6;
  for (let i = 0; i < LAYERS; i++) {
    const u = i / (LAYERS - 1);                     // 0 far → 1 near
    const baseY = H * (0.30 + u * 0.42);            // canopy tops descend
    const sway = t * (0.02 + u * 0.05);
    const canopy = SV * (0.05 + u * 0.05);          // rolling height variation
    const tips = SV * (0.035 + u * 0.075) * (1 + bandMid * 0.5 * visIntensity);
    const col = mix(CANOPY_FAR, CANOPY_NEAR, u);
    const tinted = mix(col, sky, night * (0.5 - u * 0.05));

    if (i > 0) {                                     // haze band at each base
      const g = c.createLinearGradient(0, baseY - canopy * 2.4, 0, baseY + canopy);
      g.addColorStop(0, css(sky, 0));
      g.addColorStop(1, css(sky, 0.5 * (1 - u) + 0.12));
      c.fillStyle = g;
      c.fillRect(0, baseY - canopy * 2.4, W, canopy * 3.4);
    }

    c.fillStyle = css(tinted);
    c.beginPath();
    c.moveTo(-4, H + 4);
    for (let x = -4; x <= W + 6; x += 5) {
      const roll = fbm(i * 71 + 3, x * 0.0016 * (0.6 + u) + sway, 4) - 0.5;
      const tip = Math.pow(vn(i * 23 + 11, x * 0.055 * (0.5 + u) + sway * 2), 3);
      c.lineTo(x, baseY - roll * 2 * canopy - tip * tips);
    }
    c.lineTo(W + 4, H + 4);
    c.closePath();
    c.fill();
  }

  /* foreground trunks — thin, near-black, softly wobbled; each carries seeded
     foliage so the stand varies tree to tree yet stays deterministic */
  const TRUNK = mix(CANOPY_NEAR, [20, 22, 18], 0.6);
  const trunkCol = mix(TRUNK, sky, night * 0.35);
  const n = 7;
  for (let k = 0; k < n; k++) {
    const tx = W * ((k + 0.5) / n + (ih(k, 3) - 0.5) * 0.08);
    const w = W * 0.004 * (0.6 + ih(k, 4) * 1.1);
    /* bare snags (no foliage — see drawFoliage) are broken stumps, so keep
       them low; a full-height snag reads as a stray line in a tall frame */
    const snag = ih(k, 20) < 0.16;
    const trunkH = SV * (0.86 - ih(k, 5) * 0.34) * (snag ? 0.34 + ih(k, 9) * 0.22 : 1);
    const topY = H - trunkH;                        // ground-anchored height
    const lean = (ih(k, 6) - 0.5) * W * 0.02;
    const alpha = 0.5 + ih(k, 8) * 0.4;
    c.fillStyle = css(trunkCol, alpha);
    c.beginPath();
    for (let side = 0; side < 2; side++) {
      const dir = side === 0 ? 1 : -1;
      const y0 = side === 0 ? topY : H + 6;
      const y1 = side === 0 ? H + 6 : topY;
      for (let y = y0; dir > 0 ? y <= y1 : y >= y1; y += dir * 8) {
        const v = (y - topY) / (H - topY);
        const wob = (fbm(k * 17 + 5, y * 0.01, 3) - 0.5) * w * 3;
        const half = w * (0.4 + v * 0.9);           // taper: thin at top
        const cx = tx + lean * (1 - v) + wob;
        const px = cx + dir * half;
        (side === 0 && y === y0) ? c.moveTo(px, y) : c.lineTo(px, y);
      }
    }
    c.closePath();
    c.fill();
    drawFoliage(c, k, tx, topY, lean, sky, night, t);
  }
}

/* per-tree foliage, seeded off the trunk index via the ih hash drift already
   uses for visuals — each tree gets a stable species / size / fullness /
   green, so the stand varies but is fully deterministic. ~1 in 6 stays a bare
   snag for silhouette variety. Sways on the mids. */
function drawFoliage(c, k, tx, topY, lean, sky, night, t) {
  const species = ih(k, 20);
  if (species < 0.16) return;                       // bare standing snag

  const base = mix([44, 56, 40], [92, 98, 60], ih(k, 29));
  const col = mix(base, sky, night * 0.45);
  const shade = mix(base, [16, 20, 14], 0.5);
  const shadeCol = mix(shade, sky, night * 0.45);

  const trunkLen = H - topY;
  /* girth scales with the tree's own height, so a fir keeps a natural width
     in a tall (portrait) frame instead of stretching into a skinny needle */
  const fbw = trunkLen * (0.07 + ih(k, 23) * 0.05); // base half-width
  const sway = Math.sin(t * 0.5 + k * 1.7) * (2 + bandMid * visIntensity * 7);
  const cxAt = y => {                                // hug the (leaning) trunk
    const vT = (y - topY) / (H - topY);
    return tx + lean * (1 - vT) + sway * (1 - vT);
  };

  if (species < 0.78) {
    /* fir — a scalloped evergreen silhouette running most of the trunk;
       foliage reaches well down so little bare stalk is left showing */
    const fh = trunkLen * (0.68 + ih(k, 22) * 0.24);
    const tiers = 3 + Math.floor(ih(k, 24) * 4);
    const halfAt = v => {
      const scallop = 0.68 + 0.32 * Math.abs(Math.sin(v * tiers * Math.PI));
      const wob = (fbm(k * 13 + 30, v * 6 + t * 0.08, 3) - 0.5) * fbw * 0.3;
      return fbw * Math.pow(v, 0.82) * scallop + wob;
    };
    c.fillStyle = css(col, 0.94);
    c.beginPath();
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const y = topY + v * fh, cx = cxAt(y);
      v === 0 ? c.moveTo(cx, y) : c.lineTo(cx + halfAt(v), y);
    }
    for (let v = 1; v >= 0; v -= 0.05) {
      const y = topY + v * fh;
      c.lineTo(cxAt(y) - halfAt(v), y);
    }
    c.closePath();
    c.fill();
    /* a soft shadow gusset down the left of each bough for depth */
    c.fillStyle = css(shadeCol, 0.22);
    c.beginPath();
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const y = topY + v * fh, cx = cxAt(y);
      v === 0 ? c.moveTo(cx, y) : c.lineTo(cx - halfAt(v) * 0.55, y);
    }
    for (let v = 1; v >= 0; v -= 0.05) {
      const y = topY + v * fh;
      c.lineTo(cxAt(y) - halfAt(v), y);
    }
    c.closePath();
    c.fill();
  } else {
    /* broadleaf — a rounded crown of overlapping fbm-wobbled blobs atop a
       visible trunk, a mixed-forest accent among the firs */
    const crown = trunkLen * (0.42 + ih(k, 22) * 0.26);
    const cr = fbw * 1.7;
    const nb = 5 + Math.floor(ih(k, 25) * 4);
    for (let b = 0; b < nb; b++) {
      const bx = cxAt(topY + crown * 0.4) + (ih(k * 7 + b, 26) - 0.5) * cr * 1.4;
      const by = topY + crown * (0.15 + ih(k * 7 + b, 27) * 0.7);
      const br = cr * (0.4 + ih(k * 7 + b, 28) * 0.5);
      c.fillStyle = css(b % 2 ? shadeCol : col, 0.9);
      c.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        const rr = br * (1 + 0.28 * (fbm(k * 9 + b * 5, a * 1.6 + t * 0.05, 3) - 0.5) * 2);
        const px = bx + Math.cos(a) * rr, py = by + Math.sin(a) * rr;
        i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
    }
  }
}

/* ------------------------------------------------------- biome: coast ----
   a high coastal overlook: a broad calm sea under a low sun, distant capes
   receding into haze on the horizon, and a grassy sea-cliff in the near
   foreground — its rock face plunging to the water — planted with windswept
   pines, scrub and orange lilies. Reactivity: sun breathes on the lows, the
   sea's sun-glitter sparkles on the highs, and grass, trees and lilies sway
   on the mids. Rock and the landforms stay still — they're stone and earth. */

/* a distant cape sitting on the horizon: a soft land hump anchored at one end
   that slopes down to the waterline (seaY) at its seaward tip. Filled only to
   the waterline, so the sea shows in front of and between the capes. col is
   pre-hazed by the caller (mixed toward sky) so farther capes read paler. */
function drawHeadland(c, x0, x1, anchorLeft, crestY, seaY, seed, col) {
  const steps = 44, rise = seaY - crestY;
  c.fillStyle = css(col);
  c.beginPath();
  c.moveTo(x0, seaY + 1);
  for (let i = 0; i <= steps; i++) {
    const u = i / steps, x = x0 + (x1 - x0) * u;
    const d = anchorLeft ? u : 1 - u;               // 0 at the anchored crest
    const shape = Math.pow(1 - d, 0.75);            // plateau, then dip to sea
    const roll = (fbm(seed, u * 5, 3) - 0.5) * rise * 0.4 * shape;
    c.lineTo(x, seaY - rise * shape + roll);
  }
  c.lineTo(x1, seaY + 1);
  c.closePath();
  c.fill();
}

/* the hero: a near sea-cliff anchored at the left edge, its grassy top sloping
   down to meet the water at xTip with a rock face on the seaward flank. Fills
   to the bottom of the frame (it's foreground). Returns the top-profile
   function topAt(x) so trees and scrub can be rooted exactly on the grass. */
function drawSeaCliff(c, xTip, yAnchor, yTip, seed, night, sky, t) {
  const x0 = -6, span = xTip - x0;
  const topAt = x => {
    const u = Math.max(0, Math.min(1, (x - x0) / span));
    const ease = u * u * (0.7 + 0.3 * u);           // gentle top, steep near tip
    const roll = (fbm(seed, u * 4, 3) - 0.5) * SV * 0.03 * (1 - u * 0.7);
    return yAnchor + (yTip - yAnchor) * ease + roll;
  };
  const rock = mix(mix(ROCK_DARK, sky, night * 0.4), sky, 0.05);
  /* the seaward face — not a ruler-straight wall but an eroded edge that
     wanders around xTip, the wander widening toward the waterline */
  const faceTopY = topAt(xTip);
  const edgeX = y => {
    const v = (y - faceTopY) / (H + 6 - faceTopY);
    return xTip + (fbm(seed + 5, v * 5, 3) - 0.5) * SV * 0.05 * (0.3 + v * 0.7);
  };
  /* rock body, shaded darker toward the waterline for a sense of height */
  const rg = c.createLinearGradient(0, yAnchor, 0, H);
  rg.addColorStop(0, css(mix(rock, [255, 255, 255], 0.06)));
  rg.addColorStop(1, css(mix(rock, [10, 8, 10], 0.35 * (1 - night * 0.5))));
  c.fillStyle = rg;
  c.beginPath();
  c.moveTo(x0, H + 6);
  for (let x = x0; x <= xTip; x += 5) c.lineTo(x, topAt(x));
  for (let y = faceTopY; y <= H + 6; y += 8) c.lineTo(edgeX(y), y);
  c.closePath();
  c.fill();
  /* a few faint vertical cracks down the face, clipped to the silhouette */
  c.save();
  c.clip();
  c.strokeStyle = css(mix(rock, [8, 6, 10], 0.6), 0.16 * (1 - night * 0.4));
  c.lineWidth = 1.2;
  for (let s = 0; s < 3; s++) {
    let cx = xTip - SV * (0.02 + ih(s, seed + 8) * 0.12);
    let cy = faceTopY + SV * 0.02 + ih(s, seed + 9) * SV * 0.1;
    c.beginPath();
    c.moveTo(cx, cy);
    for (let j = 0; j < 6; j++) {
      cx += (ih(s * 6 + j, seed + 10) - 0.5) * SV * 0.03;
      cy += SV * 0.06 * (0.6 + ih(s * 6 + j, seed + 11) * 0.8);
      c.lineTo(cx, cy);
    }
    c.stroke();
  }
  c.restore();
  /* a faint sunlit line along the seaward top edge */
  c.strokeStyle = css(mix(rock, [230, 224, 214], 0.4), 0.25 * (1 - night * 0.5));
  c.lineWidth = 1.5;
  c.beginPath();
  for (let x = x0; x <= xTip; x += 5) x === x0 ? c.moveTo(x, topAt(x)) : c.lineTo(x, topAt(x));
  c.stroke();
  /* grass cap hugging the top — thick where the top is gentle, thinning to
     nothing where the face steepens into bare rock near the tip */
  const grass = scrubCol(mix(GRASS_LO, GRASS_HI, 0.4), night, sky);
  c.fillStyle = css(grass, 0.97);
  c.beginPath();
  for (let x = x0; x <= xTip; x += 5) x === x0 ? c.moveTo(x, topAt(x)) : c.lineTo(x, topAt(x));
  for (let x = xTip; x >= x0; x -= 5) {
    const u = (x - x0) / span;
    const thick = SV * 0.05 * Math.max(0, 1 - Math.pow(u, 1.5));
    c.lineTo(x, topAt(x) + thick);
  }
  c.closePath();
  c.fill();
  return topAt;
}

/* a windswept coastal pine, rooted at (tx, groundY): a leaning tapered trunk
   under a flat-topped crown that streams downwind (wind > 0 leans right).
   Sways on the mids. */
function drawCoastTree(c, tx, groundY, h, wind, seed, night, sky, t) {
  const sway = Math.sin(t * 0.5 + seed * 1.6) * (2 + bandMid * visIntensity * 6);
  const lean = wind * h + sway * 0.5;
  const topX = tx + lean, topY = groundY - h;
  const trunkCol = mix(mix([56, 46, 42], [28, 24, 22], 0.3), sky, night * 0.4);
  c.strokeStyle = css(trunkCol, 0.9);
  c.lineCap = 'round';
  c.lineWidth = Math.max(1.5, h * 0.05);
  c.beginPath();
  c.moveTo(tx, groundY);
  c.quadraticCurveTo(tx + lean * 0.4, groundY - h * 0.55, topX, topY);
  c.stroke();
  /* windswept crown — overlapping blobs streaming downwind off the trunk top */
  const dir = wind >= 0 ? 1 : -1;
  const green = mix(GRASS_LO, GRASS_HI, 0.3 + ih(seed, 2) * 0.35);
  const col = scrubCol(green, night, sky);
  const shade = scrubCol(mix(green, [16, 24, 14], 0.5), night, sky);
  const cw = h * (0.4 + ih(seed, 3) * 0.22);
  const nb = 5 + Math.floor(ih(seed, 4) * 3);
  for (let b = 0; b < nb; b++) {
    const f = nb > 1 ? b / (nb - 1) : 0;            // 0 over trunk → 1 downwind
    const bx = topX + dir * cw * f * 1.4 + (ih(seed * 5 + b, 6) - 0.5) * cw * 0.4
             + sway * (0.3 + f * 0.5);
    const by = topY - cw * 0.12 + (ih(seed * 5 + b, 7) - 0.5) * cw * 0.5 + f * cw * 0.18;
    const br = cw * (0.6 - f * 0.32) * (0.8 + ih(seed * 5 + b, 8) * 0.4);
    c.fillStyle = css(b % 2 ? shade : col, 0.94);
    c.beginPath();
    for (let i = 0; i <= 34; i++) {
      const a = (i / 34) * Math.PI * 2;
      const rr = br * (1 + 0.3 * (fbm(seed * 9 + b * 5, a * 1.6 + t * 0.05, 3) - 0.5) * 2);
      const px = bx + Math.cos(a) * rr, py = by + Math.sin(a) * rr;
      i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.closePath();
    c.fill();
  }
  c.lineCap = 'butt';
}

/* the scrub's colour, pulled toward a cool moonlit blue-grey after dark
   (green foliage desaturates and cools at night) then a touch toward the sky */
const NIGHT_COOL = [72, 86, 96];
function scrubCol(green, night, sky) {
  return mix(mix(green, NIGHT_COOL, night * 0.55), sky, night * 0.28);
}

/* a coastal-scrub mound — an fbm blob with a flattened base */
function drawBush(c, cx, cy, r, seed, night, sky, t) {
  const col = scrubCol(mix(GRASS_LO, GRASS_HI, ih(seed, 1)), night, sky);
  const sway = Math.sin(t * 0.6 + seed) * (1.5 + bandMid * visIntensity * 4);
  c.fillStyle = css(col, 0.96);
  c.beginPath();
  for (let i = 0; i <= 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    const rr = r * (1 + 0.32 * (fbm(seed * 3 + 7, a * 1.7 + t * 0.05, 3) - 0.5) * 2);
    const px = cx + Math.cos(a) * rr + sway * Math.max(0, Math.sin(a - Math.PI / 2));
    const py = cy + Math.min(Math.sin(a) * rr, r * 0.5);
    i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

/* blades of grass — thin quadratic strokes leaning on the mids */
function grassTuft(c, cx, cy, h, n, seed, night, sky, t) {
  const col = scrubCol(mix(GRASS_LO, GRASS_HI, 0.7), night, sky);
  c.strokeStyle = css(col, 0.85);
  c.lineWidth = 1.2;
  for (let i = 0; i < n; i++) {
    const bx = cx + (ih(i, seed) - 0.5) * h * 0.9;
    const bh = h * (0.55 + ih(i, seed + 8) * 0.7);
    const lean = (ih(i, seed + 4) - 0.5) * h * 0.5
               + Math.sin(t * 0.8 + i + seed) * (2 + bandMid * visIntensity * 5);
    c.beginPath();
    c.moveTo(bx, cy);
    c.quadraticCurveTo(bx + lean * 0.5, cy - bh * 0.6, bx + lean, cy - bh);
    c.stroke();
  }
}

/* an orange lily — petals radiating from a stem tip, swaying on the mids */
function drawLily(c, cx, cy, s, seed, night, sky, t) {
  const col = mix(LILY, sky, night * 0.45);
  const sway = Math.sin(t * 0.7 + seed * 1.3) * (2 + bandMid * visIntensity * 5);
  const cxp = cx + sway, petals = 6;
  /* a short stem down to the foliage */
  c.strokeStyle = css(mix(GRASS_LO, sky, night * 0.4), 0.8);
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(cx, cy + s * 2.4);
  c.quadraticCurveTo(cx + sway * 0.5, cy + s, cxp, cy);
  c.stroke();
  c.fillStyle = css(col, 0.95);
  for (let i = 0; i < petals; i++) {
    /* petals fan upward and out — a recurved trumpet lily, not a flat star */
    const a = -Math.PI / 2 + (i - (petals - 1) / 2) * 0.62 + ih(seed, i) * 0.12;
    const len = s * (0.85 + ih(seed + 1, i) * 0.3);
    const px = cxp + Math.cos(a) * len, py = cy + Math.sin(a) * len;
    const mx = cxp + Math.cos(a) * len * 0.5, my = cy + Math.sin(a) * len * 0.5;
    const w = s * 0.32;
    c.beginPath();
    c.moveTo(cxp, cy);
    c.quadraticCurveTo(mx - Math.sin(a) * w, my + Math.cos(a) * w, px, py);
    c.quadraticCurveTo(mx + Math.sin(a) * w, my - Math.cos(a) * w, cxp, cy);
    c.closePath();
    c.fill();
  }
  c.fillStyle = css(mix(col, [120, 48, 8], 0.55), 0.9);
  c.beginPath();
  c.arc(cxp, cy, s * 0.15, 0, Math.PI * 2);
  c.fill();
}

function biomeCoast(c, t, sky, sun, night, dayness, g) {
  g = g | 0;
  const rr = k => ih(g, 700 + k);                 // per-generation layout draws
  const gk = (Math.imul(g, 2654435761) >>> 0) % 90000;  // per-gen seed offset
  const mirror = rr(0) < 0.5;                      // flip which side the cliff sits

  c.fillStyle = css(sky);
  c.fillRect(0, 0, W, H);

  /* canonical composition: the hero sea-cliff anchors the left, open sea and
     sun to the right. Mirroring flips the whole scene for the other handedness
     (note-shapes are drawn later, unmirrored). */
  c.save();
  if (mirror) { c.translate(W, 0); c.scale(-1, 1); }

  /* a low sun over the open sea, seeded per generation */
  const scx = W * (0.6 + rr(1) * 0.28), scy = H * (0.12 + rr(2) * 0.12);
  const r0 = Math.min(W, H) * 0.07 * (1 + bandLow * 0.22 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, sky, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);

  /* the sea — a broad calm band from a high horizon to the frame foot */
  const horizon = H * (0.32 + rr(3) * 0.06);
  const seaFar  = mix(mix(WATER_FAR, sky, 0.3 + night * 0.3), sky, night * 0.3);
  const seaNear = mix(WATER_NEAR, sky, night * 0.4);
  const seaG = c.createLinearGradient(0, horizon, 0, H);
  seaG.addColorStop(0, css(seaFar));
  seaG.addColorStop(1, css(seaNear));
  c.fillStyle = seaG;
  c.fillRect(0, horizon, W, H - horizon);

  /* a shimmering sun-glitter column under the sun, sparkling on the highs */
  const glit = 0.3 + bandHigh * visIntensity * 0.9;
  for (let i = 0; i < 26; i++) {
    const gy = horizon + (i / 26) * (H - horizon);
    const spread = (0.02 + (i / 26) * 0.08) * W;
    const gx = scx + (fbm(60 + i, i * 0.5 + t * 0.6, 2) - 0.5) * spread * 2;
    const a = 0.5 * glit * (1 - night * 0.5) * (1 - i / 26);
    c.fillStyle = css([245, 240, 224], a);
    c.fillRect(gx - spread * 0.4, gy, spread * 0.8, 1.6);
  }
  /* surf shimmer lines drifting across the water */
  c.strokeStyle = css([228, 232, 232], 0.28 * (1 - night * 0.5));
  c.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = horizon + (0.12 + i * 0.2) * (H - horizon);
    c.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const yy = y + (fbm(90 + i * 5, x * 0.008 + t * 0.25, 2) - 0.5) * 5;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }

  /* distant capes on the horizon, receding to the right into haze */
  const capes = 2 + (rr(10) < 0.5 ? 1 : 0);
  for (let i = 0; i < capes; i++) {
    const u = capes > 1 ? i / (capes - 1) : 0;      // 0 nearest → 1 farthest
    const haze = 0.4 + u * 0.4;
    const col = mix(mix(HEADLAND, sky, haze), sky, night * 0.3);
    const crestY = horizon - SV * (0.09 - u * 0.05) * (0.8 + ih(i, gk + 40) * 0.5);
    const ax = W * (0.42 + u * 0.12 + ih(i, gk + 41) * 0.06);
    drawHeadland(c, ax, W + 8, false, crestY, horizon, 71 + (gk % 83) + i * 7, col);
  }

  /* the hero sea-cliff on the left, its grassy top sloping into the water */
  const xTip = W * (0.34 + rr(4) * 0.12);
  const yAnchor = H * (0.34 + rr(5) * 0.08);
  const yTip = horizon + (H - horizon) * (0.5 + rr(6) * 0.18);
  const topAt = drawSeaCliff(c, xTip, yAnchor, yTip, 27 + (gk % 89), night, sky, t);

  /* windswept pines rooted on the cliff's grassy top, leaning out to sea;
     shorter toward the tip where the grass narrows to rock */
  const nTree = 2 + Math.floor(rr(7) * 3);
  for (let k = 0; k < nTree; k++) {
    const u = 0.08 + ih(k, gk + 50) * 0.66;
    const tx = -6 + (xTip + 6) * u;
    const gy = topAt(tx) + 1;
    const th = SV * (0.14 + ih(k, gk + 51) * 0.12) * (1 - u * 0.4);
    drawCoastTree(c, tx, gy, th, 0.12 + ih(k, gk + 52) * 0.12, gk + 60 + k, night, sky, t);
  }

  /* scrub mounds and grass tufts tucked along the grassy top */
  const nBush = 3 + Math.floor(rr(8) * 3);
  for (let k = 0; k < nBush; k++) {
    const u = 0.1 + ih(k, gk + 55) * 0.62;
    const bx = -6 + (xTip + 6) * u;
    const by = topAt(bx) + SV * 0.02;
    drawBush(c, bx, by, W * (0.045 + ih(k, gk + 56) * 0.04), gk + 70 + k, night, sky, t);
    grassTuft(c, bx, by - W * 0.015, SV * 0.05, 5, gk + 80 + k, night, sky, t);
  }

  /* a low grassy mound framing the near foreground on the seaward side */
  const mx = W * (0.62 + rr(11) * 0.2);
  const my = H * 1.02;
  drawBush(c, mx, my, W * (0.14 + rr(12) * 0.06), gk + 90, night, sky, t);
  drawBush(c, mx - W * 0.12, my + H * 0.02, W * (0.1 + rr(13) * 0.05), gk + 91, night, sky, t);
  grassTuft(c, mx, my - W * 0.05, SV * 0.07, 7, gk + 92, night, sky, t);

  /* orange lilies — a cluster on the cliff grass, a few on the near mound */
  const nLily = 3 + Math.floor(rr(9) * 4);
  for (let i = 0; i < nLily; i++) {
    let lx, ly;
    if (i < Math.ceil(nLily * 0.6)) {
      const u = 0.12 + ih(i, gk + 72) * 0.6;
      lx = -6 + (xTip + 6) * u;
      ly = topAt(lx) + SV * (0.015 + ih(i, gk + 73) * 0.02);
    } else {
      lx = mx + (ih(i, gk + 74) - 0.5) * W * 0.22;
      ly = my - H * (0.02 + ih(i, gk + 75) * 0.05);
    }
    drawLily(c, lx, ly, 11 + ih(i, gk + 76) * 5, gk + i, night, sky, t);
  }

  c.restore();
}

/* ------------------------------------------------------- biome: snow -----
   a spare winter field: a crisp cold sky, a pale low sun, a few soft snow
   drifts, and a sparse stand of bare saplings, under quietly drifting flakes.
   The most minimal of the biomes — near-monochrome, low contrast, lots of air.
   Reactivity: sun breathes on the lows, drifts and the snowfall stir on the
   mids, and the far snow glints faintly on the highs. */

/* a leafless sapling — a tapered trunk with a few forking bare branches,
   swaying gently on the mids. Dark against the snow, lifting a touch at night
   so it doesn't vanish into the deep sky. */
function drawBareTree(c, tx, groundY, h, seed, night, sky, t) {
  const col = mix(mix(TREE_BARE, sky, night * 0.4), sky, 0.08);
  const sway = Math.sin(t * 0.5 + seed * 1.7) * (2 + bandMid * visIntensity * 5);
  c.strokeStyle = css(col, 0.85);
  c.lineCap = 'round';
  /* recurse a couple of levels: shrinking, forking twigs off each limb */
  const limb = (x0, y0, ang, len, w, depth) => {
    const drift = sway * (1 - y0 / groundY);            // more sway up high
    const x1 = x0 + Math.cos(ang) * len + drift * 0.3;
    const y1 = y0 - Math.sin(ang) * len;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    if (depth <= 0 || len < h * 0.06) return;
    const forks = 2 + Math.floor(ih(seed + depth, x0 | 0) * 2);
    for (let i = 0; i < forks; i++) {
      const spread = (ih(seed * 3 + i, depth * 7) - 0.5) * 1.1;
      limb(x1, y1, ang + spread, len * (0.55 + ih(seed + i, depth) * 0.2),
           w * 0.62, depth - 1);
    }
  };
  limb(tx, groundY, Math.PI / 2, h * 0.34, h * 0.03, 3);
  c.lineCap = 'butt';
}

function biomeSnow(c, t, sky, sun, night, dayness, g) {
  g = g | 0;
  const rr = k => ih(g, 800 + k);                  // per-generation layout draws
  const gk = (Math.imul(g, 40503) >>> 0) % 90000;  // per-gen seed offset

  /* crisp cold sky — cool the warm paper toward pale blue by day; the deep
     night sky is already cold, so ease the tint out after dark */
  const cold = mix(sky, WINTER_SKY, 0.3 * dayness);
  c.fillStyle = css(cold);
  c.fillRect(0, 0, W, H);

  /* a pale, low winter sun, its position seeded per generation */
  const scx = W * (0.24 + rr(1) * 0.5), scy = H * (0.16 + rr(2) * 0.1);
  const r0 = Math.min(W, H) * 0.075 * (1 + bandLow * 0.22 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, cold, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);

  /* snow drifts — a few soft, low-contrast ridges of pale snow, the near
     ones cooler and darker so the field reads with depth. Drawn far → near;
     the saplings are planted between the mid and near banks so the front
     snow tucks over their trunk feet and they read as rooted, not floating. */
  const LAYERS = 4;
  const crest = H * (0.5 + rr(3) * 0.08);
  const drift = i => {
    const u = i / (LAYERS - 1);                     // 0 far → 1 near
    const baseY = crest + u * H * 0.17;
    const amp = H * (0.018 + u * 0.03) * (1 + bandMid * 0.45 * visIntensity);
    const snow = mix(SNOW_FAR, SNOW_NEAR, u);
    c.fillStyle = css(mix(snow, cold, night * 0.5));
    c.beginPath();
    c.moveTo(-4, H + 4);
    for (let x = -4; x <= W + 6; x += 6) {
      const n = fbm(i * 47 + 5 + (gk % 61),
        x * 0.0026 * (0.7 + i * 0.3) + t * 0.004, 4);
      c.lineTo(x, baseY + (n - 0.5) * 2 * amp);
    }
    c.lineTo(W + 4, H + 4);
    c.closePath();
    c.fill();
    /* the far drift catches a faint sparkle of wind-blown snow on the highs */
    if (i === 0) {
      const glint = 0.25 + bandHigh * visIntensity * 0.7;
      c.fillStyle = css([255, 255, 255], 0.5 * glint * (1 - night * 0.4));
      for (let s = 0; s < 40; s++) {
        const gx = W * ih(s, gk + 10);
        const gy = baseY + (fbm(gk + s, s * 0.7 + t * 0.6, 2) - 0.5) * amp * 1.2;
        if ((s * 7 + Math.floor(t * 3)) % 5) continue;   // twinkle on/off
        c.fillRect(gx, gy, 1.4, 1.4);
      }
    }
  };
  const PLANT = LAYERS - 2;                          // banks in front of trees
  for (let i = 0; i < PLANT; i++) drift(i);

  /* a sparse stand of bare saplings, seeded per generation — kept few, for
     the minimal winter feel; planted on the mid drift line */
  const groundY = crest + (PLANT - 1) / (LAYERS - 1) * H * 0.17;
  const nTrees = 2 + Math.floor(rr(4) * 3);
  for (let k = 0; k < nTrees; k++) {
    const tx = W * (0.12 + ih(k, gk + 20) * 0.76);
    const gy = groundY + H * (0.02 + ih(k, gk + 21) * 0.06);
    const th = H * (0.16 + ih(k, gk + 22) * 0.16);
    drawBareTree(c, tx, gy, th, gk + 30 + k, night, sky, t);
  }

  for (let i = PLANT; i < LAYERS; i++) drift(i);     // near banks, over the feet

  /* drifting snowfall — each flake a pure function of time and its index, so
     every listener sees the same fall; denser and quicker on the mids */
  const fall = 0.5 + bandMid * visIntensity * 0.6;
  const flakes = Math.round(70 * fall);
  c.fillStyle = css(mix([255, 255, 255], cold, night * 0.2), 0.8);
  for (let i = 0; i < flakes; i++) {
    const spd = (0.05 + ih(i, 41) * 0.09) * fall;    // screen-heights / second
    const y = ((ih(i, 42) + t * spd) % 1) * (H + 12) - 6;
    const drift = Math.sin(t * (0.3 + ih(i, 43) * 0.4) + i) * W * 0.02;
    const x = ((ih(i, 44) + t * 0.006) % 1) * W + drift;
    const r = 0.8 + ih(i, 45) * 1.6;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
}

/* ------------------------------------------------------- biome: sky ------
   the most weightless biome — no land at all, just an open cloudscape with a
   high centred sun and a few layers of soft cumulus drifting past on parallax.
   Birds ride in for free via the shared note overlays. Reactivity: the sun
   breathes on the lows, the clouds stir and drift quicker on the mids, and
   their sunlit crowns catch a faint highlight on the highs. */

/* a single soft cumulus: a cluster of overlapping puffs — a flattish base
   ellipse plus a row of rounded lobes bulging fuller in the middle — traced
   into one path and filled once, so the overlaps union cleanly at a uniform
   alpha (no seams, no double-darkening). Flat-filled to match the biomes'
   painterly colour fields; depth comes from the per-layer tint, not shading. */
function drawCumulus(c, cx, cy, w, h, seed, col, alpha, t) {
  c.fillStyle = css(col, alpha);
  const baseY = cy + h * 0.32;
  const breathe = 1 + bandMid * visIntensity * 0.05;
  const lobes = 5 + Math.floor(ih(seed, 7) * 4);
  c.beginPath();
  /* soft, slightly flattened base so the cloud sits rather than floats */
  c.moveTo(cx + w, baseY - h * 0.15);
  c.ellipse(cx, baseY - h * 0.15, w, h * 0.4, 0, 0, Math.PI * 2);
  /* rounded lobes across the top, fuller toward the centre, gently astir */
  for (let i = 0; i < lobes; i++) {
    const a = i / (lobes - 1);                         // 0..1 across
    const mid = 1 - Math.abs(a - 0.5);                 // 0 edges → 0.5 centre
    const lx = cx + (a - 0.5) * 1.7 * w;
    const r = h * (0.28 + 0.5 * mid) * (0.7 + 0.5 * ih(seed, i + 3)) * breathe;
    const ly = baseY - h * 0.2 - mid * h * 0.28
             - (fbm(seed + i, t * 0.05, 2) - 0.5) * h * 0.1;
    c.moveTo(lx + r, ly);
    c.arc(lx, ly, r, 0, Math.PI * 2);
  }
  c.fill();
}

function biomeSky(c, t, sky, sun, night, dayness, g) {
  g = g | 0;
  const rr = k => ih(g, 900 + k);                     // per-generation layout
  const gk = (Math.imul(g, 52711) >>> 0) % 90000;     // per-gen seed offset

  /* a soft vertical wash — the crown a touch deeper than the horizon so the
     open sky has some body behind the clouds */
  const grad = c.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, css(mix(sky, [0, 0, 0], 0.07 + night * 0.04)));
  grad.addColorStop(1, css(sky));
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);

  /* centred sun, riding high; breathes on the lows */
  const scx = W * 0.5, scy = H * (0.34 + 0.06 * (1 - dayness));
  const r0 = Math.min(W, H) * 0.09 * (1 + bandLow * 0.25 * visIntensity);
  drawSun(c, t, scx, scy, r0, sun, sky, 1 - 0.45 * rainVis);
  drawPadRings(c, scx, scy, r0);

  /* clouds in a few parallax layers: far/high/faint → near/low/defined, with
     lots of open sky between. Kept sparse for the minimal, weightless feel. */
  const LAYERS = 4;
  /* a single flat cloud tone: pale body cooled toward the sky, the near layers
     deeper than the far so the stack reads with depth */
  const body = mix(CLOUD_LIT, CLOUD_SHADE, 0.35);
  for (let L = 0; L < LAYERS; L++) {
    const u = L / (LAYERS - 1);                       // 0 far → 1 near
    const n = 2 + Math.floor(rr(L * 3 + 1) * 2);      // 2–3 clouds per layer
    const yBand = H * (0.14 + u * 0.62);
    const scale = 0.5 + u;
    /* constant gentle drift — must NOT be audio-scaled: spd is multiplied by
       the absolute wall-time t, so any per-frame wobble here would fling the
       cloud thousands of px. Reactivity lives in the lobe breathe instead. */
    const spd = 0.002 + u * 0.004;
    const col = mix(mix(body, CLOUD_SHADE, u * 0.4), sky, night * 0.45 + (1 - u) * 0.3);
    const alpha = 0.5 + u * 0.4;
    for (let k = 0; k < n; k++) {
      const seed = gk + L * 17 + k * 5;
      const w = W * (0.13 + ih(seed, 1) * 0.13) * scale;
      const h = w * (0.4 + ih(seed, 2) * 0.16);
      const phase = ih(seed, 3) + t * spd;
      const cx = -w + (((phase % 1) + 1) % 1) * (W + 2 * w);
      const cy = yBand + (ih(seed, 4) - 0.5) * H * 0.08;
      drawCumulus(c, cx, cy, w, h, seed, col, alpha, t);
    }
  }
}

/* id → renderer; genParams(g).biome selects one per generation */
const BIOME_RENDER = {
  hills: biomeHills, ocean: biomeOcean, forest: biomeForest,
  coast: biomeCoast, snow: biomeSnow, sky: biomeSky,
};

/* ------------------------------------------------------- note overlays --- */

function pitchX(midi) {
  const fifths = ((midi * 7) % 12) / 11;
  return W * (0.08 + 0.84 * fifths) + (ih(midi, 5) - 0.5) * 40;
}

/* where a note-shape sits, per biome. Horizontal is always pitch (pitchX);
   the vertical band is tuned so shapes land where they read against that
   biome's scenery — higher pitch → higher on screen. Returns {y, s} (base
   size; the caller applies the pop-in growth to everything but birds).
   - hills:  drift's original — melody in the sky, bass at the ridge foot.
   - ocean:  melodics ride the sky above the horizon; bass sinks into the
             deep water; birds skim the sky.
   - forest: everything lifts into the pale sky/haze above the dark canopy
             (dark ink shapes vanish inside the trees), bass resting on the
             treeline. */
function noteLayout(biome, kind, midi) {
  const p60 = (midi - 60) / 36, p72 = (midi - 72) / 36;
  if (biome === 'ocean') {
    switch (kind) {
      case 'mel':   return { y: H * (0.30 - p60 * 0.12), s: 9 };
      case 'bell':  return { y: H * (0.14 - p72 * 0.06) + ih(midi, 11) * H * 0.05, s: 7 };
      case 'bass':  return { y: H * 0.86 + ih(midi, 7) * H * 0.06, s: 8 };
      case 'pluck': return { y: H * (0.26 - p60 * 0.11) + ih(midi, 17) * H * 0.03, s: 6 };
      default:      return { y: H * (0.05 + ih(midi, 13) * 0.12), s: 3 };
    }
  }
  if (biome === 'forest') {
    switch (kind) {
      case 'mel':   return { y: H * (0.22 - p60 * 0.10), s: 8 };
      case 'bell':  return { y: H * (0.11 - p72 * 0.05) + ih(midi, 11) * H * 0.04, s: 7 };
      case 'bass':  return { y: H * (0.31 - p60 * 0.03) + ih(midi, 7) * H * 0.03, s: 7 };
      case 'pluck': return { y: H * (0.18 - p60 * 0.09) + ih(midi, 17) * H * 0.03, s: 6 };
      default:      return { y: H * (0.04 + ih(midi, 13) * 0.11), s: 3 };
    }
  }
  if (biome === 'snow') {                           // pale sky over the field
    switch (kind) {
      case 'mel':   return { y: H * (0.30 - p60 * 0.12), s: 9 };
      case 'bell':  return { y: H * (0.13 - p72 * 0.06) + ih(midi, 11) * H * 0.05, s: 7 };
      case 'bass':  return { y: H * 0.86 + ih(midi, 7) * H * 0.05, s: 8 };
      case 'pluck': return { y: H * (0.26 - p60 * 0.12) + ih(midi, 17) * H * 0.03, s: 6 };
      default:      return { y: H * (0.06 + ih(midi, 13) * 0.12), s: 3 };
    }
  }
  if (biome === 'coast') {                          // sky over the sea gap
    switch (kind) {
      case 'mel':   return { y: H * (0.26 - p60 * 0.12), s: 9 };
      case 'bell':  return { y: H * (0.13 - p72 * 0.06) + ih(midi, 11) * H * 0.04, s: 7 };
      case 'bass':  return { y: H * 0.7 + ih(midi, 7) * H * 0.05, s: 8 };
      case 'pluck': return { y: H * (0.22 - p60 * 0.11) + ih(midi, 17) * H * 0.03, s: 6 };
      default:      return { y: H * (0.05 + ih(midi, 13) * 0.12), s: 3 };
    }
  }
  switch (kind) {                                 // hills (default)
    case 'mel':   return { y: H * (0.34 - p60 * 0.13), s: 9 };
    case 'bell':  return { y: H * (0.15 - p72 * 0.06) + ih(midi, 11) * H * 0.05, s: 7 };
    case 'bass':  return { y: H * 0.9 + ih(midi, 7) * H * 0.05, s: 8 };
    case 'pluck': return { y: H * (0.3 - p60 * 0.13) + ih(midi, 17) * H * 0.03, s: 6 };
    default:      return { y: H * (0.08 + ih(midi, 13) * 0.12), s: 3 };
  }
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
  frameNow = now;
  const t = now;
  const hod = (Math.floor(now / HOUR) % 24 + (now % HOUR) / HOUR) % 24;
  const dayness = 0.5 + 0.5 * Math.cos(((hod - 13) / 24) * Math.PI * 2);
  const P = genParams(genAt(now).g);

  /* sky */
  let { sky, sun } = skyAt(hod);
  /* overcast: rain greys and flattens the sky (applied before the night/ink
     flip reads it, so shape colors adapt with it) */
  rainVis += ((P.rain || 0) - rainVis) * 0.003;
  if (rainVis > 0.01) sky = mix(sky, [148, 150, 152], 0.22 * rainVis);
  const night = Math.min(1, Math.max(0, (DAY_L - lum(sky)) / (DAY_L - NIGHT_L)));
  /* flip the ink decisively around mid-dusk — a gradual fade leaves it
     mid-grey on a mid-toned sky, unreadable both ways */
  const flip = Math.min(1, Math.max(0, (night - 0.45) / 0.35));
  const inkT = flip * flip * (3 - 2 * flip);
  inkTNow = inkT;
  inkNow  = mix(INK,  [225, 221, 208], inkT);
  clayNow = mix(CLAY, [214, 178, 148], night * 0.7);

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
      /* stamp the biome the note is born into so its placement stays put
         even while a seam dissolve is showing the next biome */
      pulses.push({ ...visQueue[i], start: now, biome: P.biome });
      visQueue.splice(i, 1);
      if (pulses.length > 80) pulses.shift();
    }
  }

  /* the biome for this generation, and a short dissolve from the previous
     one at the seam (synchronized — it's keyed off the generation's start) */
  const render = BIOME_RENDER[P.biome] || biomeHills;
  render(ctx2d, t, sky, sun, night, dayness, P.g);

  const age = now - P.start;
  if (age < XFADE) {
    const pg = genPrev(P.g);
    if (pg !== null) {
      const prev = genParams(pg);
      if (prev.biome !== P.biome) {
        (BIOME_RENDER[prev.biome] || biomeHills)(xctx, t, sky, sun, night, dayness, pg);
        ctx2d.save();
        ctx2d.globalAlpha = 1 - age / XFADE;
        ctx2d.drawImage(xcanvas, 0, 0, W, H);
        ctx2d.restore();
      }
    }
  }

  /* shared weather overlays (upper sky, above any landscape silhouette) */
  if (rainVis > 0.01) drawClouds(t, sky);
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
    const { y, s: baseS } = noteLayout(p.biome, p.kind, p.midi);
    const s = p.kind === 'bird' ? baseS : baseS * grow;
    drawShape(p.kind, x, y, s, Math.max(0, alpha) * 0.9, p.midi);
  }

  if (roll.open) drawRoll(now);
}
requestAnimationFrame(frame);
