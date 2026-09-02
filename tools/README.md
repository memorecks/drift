# tools — dev utilities

Not part of the broadcast. These observe `index.html`; they never change what
plays. `node_modules/` and `renders/` are gitignored.

## render.mjs — still images of the visuals

Drives `index.html` in headless Chrome (system Chrome via `puppeteer-core`,
no download) and screenshots the canvas.

drift's visuals are a pure function of UTC wall-clock time, so a **seed** here
is just a broadcast moment. Each seed maps to an instant, so the same seed
always returns to the same scene (generation, mode, weather, sky, note field).
A batch picks random seeds and **prints them**, so any scene you like can be
re-rendered by passing its seed back with `--seed`.

```bash
cd tools
node render.mjs                        # one frame, random seed, 1600x900
node render.mjs -n 12                  # a batch of 12 random seeds
node render.mjs --seed 42              # reproduce seed 42
node render.mjs -w 2560 -h 1440 -n 6   # 2560x1440 batch
node render.mjs --at 2026-06-21T05:30  # a specific UTC instant
node render.mjs --ui                   # keep the masthead / colophon chrome
node render.mjs --no-audio             # static scene (no reactive motion)
node render.mjs --help                 # full flag list
```

### Flags

| flag | | default |
|---|---|---|
| `-w, --width <px>` | image width (CSS px) | 1600 |
| `-h, --height <px>` | image height (CSS px) | 900 |
| `-s, --scale <n>` | device pixel ratio; 2 = retina-crisp | 2 |
| `-n, --count <n>` | frames to render | 1 |
| `-o, --out <path>` | file (when `n=1`) or output directory | `./renders` |
| `--seed <int>` | render this exact seed (reproducible) | random |
| `--at <iso>` | render a specific UTC instant | — |
| `--ui` | keep masthead / colophon / open panels | hidden |
| `--no-audio` | static scene, no analyser-driven motion | audio on |
| `-r, --reactivity <n>` | visual reactivity multiplier | app's 1.6 |
| `--warmup <ms>` | settle time before capture | 3500 |

### Notes

- **Size / resizing.** Output is `width*scale × height*scale` pixels. Layout
  adapts to the width:height ratio exactly as the live page does when you
  resize the window (sun at 70% width, ridgelines by height fractions), so a
  square or ultrawide canvas recomposes rather than stretching.
- **Hiding chrome.** The "tune in" veil is always removed. Everything else
  (masthead, colophon, debug/roll panels) is hidden unless `--ui` is passed.
- **Audio on by default.** Muted at the OS level, but the Web Audio graph
  still runs so the analyser drives the sun and ridgelines and note shapes
  appear. `--no-audio` renders a calm, static landscape faster.
- **Reproducibility.** A seed returns to the same *scene*, but frames are not
  byte-identical: the render loop is a live animation, so the sun rim,
  ridgelines and reactive motion sit at a slightly different phase each
  capture.
- **Filenames.** In batch/directory mode: `drift-<seed>-<instant>.png`.

## record.mjs — video clips, with sound

Same seed / size / UI / batch model as `render.mjs`, but records the live
scene instead of a still: the canvas via `captureStream()`, the real Web Audio
`master` via a `MediaStreamDestination` tap, muxed by `MediaRecorder` into webm
(VP9 + Opus) in-page, then transcoded to mp4 (H.264 + AAC) with ffmpeg. Real
audio from the actual graph, in sync with the animation.

**Recording is real time** — a 15 s clip takes ~15 s to capture (plus warm-up),
and a batch is that per clip.

```bash
cd tools
node record.mjs                        # one 15s clip, random seed, 1600x900
node record.mjs -n 6                    # a batch of 6 random seeds
node record.mjs --seed 42 -d 30         # seed 42, 30 seconds
node record.mjs -w 1080 -h 1920 -d 20   # a vertical clip
node record.mjs --at 2026-06-21T05:30   # a specific UTC instant
node record.mjs --ui                    # keep the masthead / colophon chrome
node record.mjs --format webm           # skip the mp4 transcode
node record.mjs --help                  # full flag list
```

### Flags

| flag | | default |
|---|---|---|
| `-w, --width <px>` | frame width (CSS px) | 1600 |
| `-h, --height <px>` | frame height (CSS px) | 900 |
| `-s, --scale <n>` | device pixel ratio | 1 |
| `-d, --duration <s>` | clip length in seconds | 15 |
| `--fps <n>` | frames per second | 30 |
| `--bitrate <mbps>` | target video bitrate | 12 |
| `-n, --count <n>` | clips to record | 1 |
| `-f, --format <fmt>` | `mp4` (ffmpeg) or `webm` | mp4 |
| `--keep-webm` | keep the source webm beside the mp4 | off |
| `-o, --out <path>` | file (when `n=1`) or directory | `./clips` |
| `--seed <int>` | record this exact broadcast moment | random |
| `--at <iso>` | record a specific UTC instant | — |
| `--ui` | keep masthead / colophon | hidden |
| `-r, --reactivity <n>` | visual reactivity multiplier | app's 1.6 |
| `--warmup <ms>` | settle time before capture starts | 1800 |

### Notes

- **Sound.** Audio is captured from the graph's `master` node, so it's exactly
  what a listener at the current volume hears. `--mute-audio` only silences the
  OS device, not the recording tap, so nothing plays out of your speakers while
  it records.
- **mp4 vs webm.** `mp4` (H.264 + AAC) plays everywhere; it needs ffmpeg on the
  `PATH` (falls back to webm with a warning if missing). `--format webm` keeps
  the raw VP9 + Opus recording and skips the transcode.
- **Filenames.** In batch/directory mode: `drift-<seed>-<instant>.mp4`.
- Everything else (seeds, sizing/resizing, hidden UI, reactivity) works exactly
  as in `render.mjs` above.
```
