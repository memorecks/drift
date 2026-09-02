#!/usr/bin/env node
/* render.mjs — still-image capture of drift's visuals.
 *
 * Drives index.html in headless Chrome (system Chrome via puppeteer-core, no
 * download), lets the scene settle, and screenshots the canvas. Dev-only —
 * it observes the broadcast, it never changes it.
 *
 * drift's visuals are a pure function of UTC wall-clock time, so a "seed"
 * here is just a broadcast moment: each seed maps deterministically to an
 * instant, so the same seed always returns to the same scene — its
 * generation, mode, weather, sky and note field. (The frame is not
 * byte-identical run to run: the scene is a live animation, so the sun rim,
 * ridgelines and reactive motion sit at a slightly different phase each
 * capture.) A batch picks random seeds and prints them, so any scene you
 * like can be re-rendered by passing its seed back.
 *
 *   node render.mjs                         one frame, random seed, 1600x900
 *   node render.mjs -n 12                   a batch of 12 random seeds
 *   node render.mjs --seed 42               reproduce seed 42
 *   node render.mjs -w 2560 -h 1440 -n 6    2560x1440 batch
 *   node render.mjs --at 2026-06-21T05:30   a specific broadcast instant (UTC)
 *   node render.mjs --ui                     keep the masthead / colophon chrome
 *   node render.mjs --no-audio               static scene (no reactive motion)
 *
 * Run `node render.mjs --help` for the full flag list.
 */

import puppeteer from 'puppeteer-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'index.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* seeds spread over this many seconds of broadcast time (~3 years from the
 * 2026 epoch) so a random seed lands on a varied generation, time of day,
 * and weather — not just a varied movement at a fixed hour. */
const SEED_SPAN = 3 * 365 * 24 * 3600;

/* ----------------------------------------------------------------- args -- */

function parseArgs(argv) {
  const o = {
    width: 1600, height: 900, scale: 2, count: 1,
    out: path.join(HERE, 'renders'),
    seed: null, at: null, ui: false, audio: true,
    warmup: 3500, reactivity: null,
  };
  const eat = () => argv.shift();
  const num = v => { const n = Number(v); if (!Number.isFinite(n)) die(`not a number: ${v}`); return n; };
  while (argv.length) {
    const a = eat();
    switch (a) {
      case '-w': case '--width':        o.width = num(eat()); break;
      case '-h': case '--height':       o.height = num(eat()); break;
      case '-s': case '--scale':        o.scale = num(eat()); break;
      case '-n': case '--count':        o.count = num(eat()); break;
      case '-o': case '--out':          o.out = eat(); break;
      case '--seed':                    o.seed = num(eat()); break;
      case '--at': case '--time':       o.at = eat(); break;
      case '--warmup':                  o.warmup = num(eat()); break;
      case '-r': case '--reactivity':   o.reactivity = num(eat()); break;
      case '--ui':                      o.ui = true; break;
      case '--no-ui':                   o.ui = false; break;
      case '--no-audio':                o.audio = false; break;
      case '--audio':                   o.audio = true; break;
      case '--help': case '-?':         usage(); process.exit(0);
      default: die(`unknown option: ${a}`);
    }
  }
  return o;
}

function usage() {
  console.log(`render.mjs — still-image capture of drift's visuals

  -w, --width  <px>     image width in CSS pixels        (default 1600)
  -h, --height <px>     image height in CSS pixels        (default 900)
  -s, --scale  <n>      device pixel ratio; 2 = retina    (default 2)
  -n, --count  <n>      how many frames to render         (default 1)
  -o, --out    <path>   output file (n=1) or directory    (default ./renders)
      --seed   <int>    render this exact seed (reproducible)
      --at     <iso>    render a specific UTC instant, e.g. 2026-06-21T05:30
      --ui                 keep the masthead / colophon / any open panels
      --no-audio           static scene — no audio, no reactive motion
  -r, --reactivity <n>  visual reactivity multiplier      (default: app's 1.6)
      --warmup <ms>     settle time before capture        (default 3500)

The output pixel size is width*scale by height*scale. Layout adapts to the
width:height ratio exactly as the live page does when you resize the window.`);
}

function die(msg) { console.error('render: ' + msg); process.exit(1); }

/* ---------------------------------------------------------------- seeds -- */

/* deterministic seed -> broadcast-time (seconds since ORIGIN). A 32-bit
 * integer hash spreads nearby seeds across the whole span. */
function seedToWall(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * SEED_SPAN;
}

const ORIGIN_MS = Date.UTC(2026, 0, 1);
const wallToISO = w => new Date(ORIGIN_MS + w * 1000).toISOString().slice(0, 19) + 'Z';
const isoToWall = iso => {
  const ms = Date.parse(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  if (Number.isNaN(ms)) die(`could not parse --at time: ${iso}`);
  return (ms - ORIGIN_MS) / 1000;
};

const slug = iso => iso.replace(/[:T]/g, '-').replace(/Z$/, '');

/* ----------------------------------------------------------------- main -- */

const o = parseArgs(process.argv.slice(2));
if (!fs.existsSync(CHROME)) die(`Chrome not found at ${CHROME}`);
if (!fs.existsSync(INDEX)) die(`index.html not found at ${INDEX}`);

/* Build the render list: {seed, wall, iso, label}. --at pins the instant for
 * every frame (seed still labels it); otherwise each frame gets a seed (the
 * given one, or a fresh random one) that resolves to its instant. */
const jobs = [];
for (let i = 0; i < o.count; i++) {
  let seed, wall;
  if (o.at != null) {
    wall = isoToWall(o.at);
    seed = o.seed != null ? o.seed : i;
  } else {
    seed = o.seed != null ? o.seed : Math.floor(Math.random() * 1e9);
    wall = seedToWall(seed);
  }
  const iso = wallToISO(wall);
  jobs.push({ seed, wall, iso });
}

/* Resolve output paths. n=1 with a file-like --out writes exactly there;
 * otherwise --out is a directory of drift-<seed>-<instant>.png. */
const singleFile = o.count === 1 && /\.png$/i.test(o.out);
if (!singleFile) fs.mkdirSync(o.out, { recursive: true });
for (const j of jobs) {
  j.path = singleFile ? o.out
    : path.join(o.out, `drift-${j.seed}-${slug(j.iso)}.png`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
         '--hide-scrollbars', '--force-device-scale-factor=' + o.scale],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: o.width, height: o.height, deviceScaleFactor: o.scale });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(pathToFileURL(INDEX).href, { waitUntil: 'load' });

  /* Hide the "tune in" veil always (it's the splash, never wanted in a
   * render); hide the rest of the chrome unless --ui was asked for. */
  await page.evaluate((ui) => {
    const s = document.createElement('style');
    s.textContent = '#veil{display:none!important}' +
      (ui ? '' : '.frame{display:none!important}');
    document.head.appendChild(s);
  }, o.ui);

  /* Start the audio graph so the analyser drives the sun / ridgelines and
   * note shapes appear. Muted at the OS level; the Web Audio graph still
   * runs. Skipped for a static scene. */
  if (o.audio) {
    await page.evaluate(() => { if (typeof start === 'function' && !started) start(); });
  }
  if (o.reactivity != null) {
    await page.evaluate(v => { visIntensity = v; }, o.reactivity);
  }

  if (errors.length) console.warn('render: page reported errors:\n  ' + errors.join('\n  '));

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    /* jump to this frame's broadcast instant (retunes the whole graph) */
    await page.evaluate(w => jumpTo(w), j.wall);
    /* let bands ramp, notes populate, LFOs settle */
    await new Promise(r => setTimeout(r, o.warmup));
    await page.screenshot({ path: j.path });
    console.log(`[${i + 1}/${jobs.length}] seed ${j.seed}  ${j.iso}  ->  ${path.relative(process.cwd(), j.path)}`);
  }
} finally {
  await browser.close();
}
