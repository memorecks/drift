#!/usr/bin/env node
/* record.mjs — video clips of drift, with sound.
 *
 * Same seed / size / UI / batch model as render.mjs, but instead of a still it
 * records the live scene: the canvas via captureStream(), the real Web Audio
 * master via a MediaStreamDestination tap, muxed by MediaRecorder into webm
 * (VP9 + Opus) in-page, then transcoded to mp4 with ffmpeg. Real audio from
 * the actual graph, in sync with the animation. Dev-only — it observes the
 * broadcast, it never changes it.
 *
 * Recording is real time: a 15 s clip takes 15 s to capture (plus warm-up),
 * and a batch is that per clip. A "seed" is a broadcast moment (see
 * render.mjs) — the same seed records the same stretch of the broadcast.
 *
 *   node record.mjs                         one 15 s clip, random seed, 1600x900
 *   node record.mjs -n 6                     a batch of 6 random seeds
 *   node record.mjs --seed 42 -d 30          seed 42, 30 seconds
 *   node record.mjs -w 1080 -h 1920 -d 20    a vertical clip
 *   node record.mjs --at 2026-06-21T05:30    a specific broadcast instant (UTC)
 *   node record.mjs --ui                      keep the masthead / colophon chrome
 *   node record.mjs --format webm             skip the mp4 transcode
 *
 * Run `node record.mjs --help` for the full flag list.
 */

import puppeteer from 'puppeteer-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'index.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* seeds spread over this many seconds of broadcast time (~3 years) — keep in
 * sync with render.mjs so a seed means the same instant in both tools. */
const SEED_SPAN = 3 * 365 * 24 * 3600;

/* ----------------------------------------------------------------- args -- */

function parseArgs(argv) {
  const o = {
    width: 1600, height: 900, scale: 1, count: 1,
    duration: 15, fps: 30, bitrate: 12, format: 'mp4', keepWebm: false,
    out: path.join(HERE, 'clips'),
    seed: null, at: null, ui: false,
    warmup: 1800, reactivity: null,
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
      case '-d': case '--duration':     o.duration = num(eat()); break;
      case '--fps':                     o.fps = num(eat()); break;
      case '--bitrate':                 o.bitrate = num(eat()); break;
      case '-f': case '--format':       o.format = eat(); break;
      case '--keep-webm':               o.keepWebm = true; break;
      case '-o': case '--out':          o.out = eat(); break;
      case '--seed':                    o.seed = num(eat()); break;
      case '--at': case '--time':       o.at = eat(); break;
      case '--warmup':                  o.warmup = num(eat()); break;
      case '-r': case '--reactivity':   o.reactivity = num(eat()); break;
      case '--ui':                      o.ui = true; break;
      case '--no-ui':                   o.ui = false; break;
      case '--help': case '-?':         usage(); process.exit(0);
      default: die(`unknown option: ${a}`);
    }
  }
  if (o.format !== 'mp4' && o.format !== 'webm') die(`--format must be mp4 or webm`);
  return o;
}

function usage() {
  console.log(`record.mjs — video clips of drift, with sound

  -w, --width  <px>     frame width in CSS pixels         (default 1600)
  -h, --height <px>     frame height in CSS pixels        (default 900)
  -s, --scale  <n>      device pixel ratio                 (default 1)
  -d, --duration <s>    clip length in seconds            (default 15)
      --fps    <n>      frames per second                 (default 30)
      --bitrate <mbps>  target video bitrate              (default 12)
  -n, --count  <n>      how many clips to record          (default 1)
  -f, --format <fmt>    mp4 (ffmpeg transcode) or webm    (default mp4)
      --keep-webm       keep the source webm alongside mp4
  -o, --out    <path>   output file (n=1) or directory    (default ./clips)
      --seed   <int>    record this exact seed (reproducible moment)
      --at     <iso>    record a specific UTC instant, e.g. 2026-06-21T05:30
      --ui                 keep the masthead / colophon chrome
  -r, --reactivity <n>  visual reactivity multiplier      (default: app's 1.6)
      --warmup <ms>     settle time before capture starts (default 1800)

Recording is real time: each clip takes about (warmup + duration) seconds.
The output pixel size is width*scale by height*scale; layout adapts to the
width:height ratio exactly as the live page does when you resize the window.`);
}

function die(msg) { console.error('record: ' + msg); process.exit(1); }

/* ---------------------------------------------------------------- seeds -- */

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

function transcode(webm, mp4, fps) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', webm,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
      '-r', String(fps), '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '192k', mp4];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err += d; });
    ff.on('error', e => reject(new Error('ffmpeg failed to launch: ' + e.message)));
    ff.on('close', code => code === 0 ? resolve()
      : reject(new Error('ffmpeg exited ' + code + '\n' + err.slice(-800))));
  });
}

/* ----------------------------------------------------------------- main -- */

const o = parseArgs(process.argv.slice(2));
if (!fs.existsSync(CHROME)) die(`Chrome not found at ${CHROME}`);
if (!fs.existsSync(INDEX)) die(`index.html not found at ${INDEX}`);
let wantMp4 = o.format === 'mp4';
if (wantMp4) {
  const has = await new Promise(r => { const p = spawn('ffmpeg', ['-version']); p.on('error', () => r(false)); p.on('close', c => r(c === 0)); });
  if (!has) { console.warn('record: ffmpeg not found — writing webm instead of mp4'); wantMp4 = false; }
}

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
  jobs.push({ seed, wall, iso: wallToISO(wall) });
}

const ext = wantMp4 ? 'mp4' : 'webm';
const singleFile = o.count === 1 && /\.(mp4|webm)$/i.test(o.out);
const outDir = singleFile ? path.dirname(o.out) : o.out;
fs.mkdirSync(outDir, { recursive: true });
for (const j of jobs) {
  const base = singleFile ? o.out.replace(/\.(mp4|webm)$/i, '')
    : path.join(o.out, `drift-${j.seed}-${slug(j.iso)}`);
  j.webm = base + '.webm';
  j.final = wantMp4 ? base + '.' + ext : j.webm;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
         '--hide-scrollbars', '--force-device-scale-factor=' + o.scale],
});

/* the in-page recorder streams the webm out in base64 slices as it finishes,
 * so nothing huge is returned across the bridge in one piece */
let sink = null;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: o.width, height: o.height, deviceScaleFactor: o.scale });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.exposeFunction('__driftChunk', b64 => new Promise(res => {
    if (!sink.write(Buffer.from(b64, 'base64'))) sink.once('drain', res); else res();
  }));

  await page.goto(pathToFileURL(INDEX).href, { waitUntil: 'load' });

  await page.evaluate((ui) => {
    const s = document.createElement('style');
    s.textContent = '#veil{display:none!important}' + (ui ? '' : '.frame{display:none!important}');
    document.head.appendChild(s);
  }, o.ui);

  await page.evaluate(() => { if (typeof start === 'function' && !started) start(); });
  if (o.reactivity != null) await page.evaluate(v => { visIntensity = v; }, o.reactivity);
  if (errors.length) console.warn('record: page reported errors:\n  ' + errors.join('\n  '));

  const totalMin = ((o.warmup / 1000 + o.duration) * jobs.length / 60).toFixed(1);
  console.log(`recording ${jobs.length} clip(s), ~${totalMin} min of real time…`);

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    sink = fs.createWriteStream(j.webm);
    await page.evaluate(w => jumpTo(w), j.wall);
    await new Promise(r => setTimeout(r, o.warmup));

    /* record in-page; the returned promise resolves only after every webm
     * slice has been streamed to __driftChunk and the recorder has stopped */
    await page.evaluate((durationMs, fps, bitsPerSec) => new Promise((resolve, reject) => {
      try {
        const canvas = document.getElementById('scene');
        const vstream = canvas.captureStream(fps);
        const dest = actx.createMediaStreamDestination();
        master.connect(dest);
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
          : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
        const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSec, audioBitsPerSecond: 192000 });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onerror = e => reject('MediaRecorder error: ' + String(e.error));
        rec.onstop = async () => {
          try {
            master.disconnect(dest);
            for (const t of vstream.getVideoTracks()) t.stop();
            const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
            for (let p = 0; p < buf.length; p += 0x18000) {
              const sub = buf.subarray(p, p + 0x18000);
              let bin = ''; for (let k = 0; k < sub.length; k += 0x8000) bin += String.fromCharCode.apply(null, sub.subarray(k, k + 0x8000));
              await window.__driftChunk(btoa(bin));
            }
            resolve();
          } catch (e) { reject(String(e)); }
        };
        rec.start();
        setTimeout(() => rec.stop(), durationMs);
      } catch (e) { reject(String(e)); }
    }), o.duration * 1000, o.fps, o.bitrate * 1e6);

    await new Promise(res => sink.end(res));

    if (wantMp4) {
      await transcode(j.webm, j.final, o.fps);
      if (!o.keepWebm) fs.rmSync(j.webm);
    }
    console.log(`[${i + 1}/${jobs.length}] seed ${j.seed}  ${j.iso}  ${o.duration}s  ->  ${path.relative(process.cwd(), j.final)}`);
  }
} finally {
  await browser.close();
}
