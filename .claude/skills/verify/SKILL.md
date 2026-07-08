---
name: verify
description: Drive drift headlessly to verify audio/visual changes at the real surface.
---

# Verifying drift

No build step. The surface is the browser: open `index.html`, click `#tunein`
(audio needs a gesture), watch/listen. `?debug` opens the time-travel panel.

## Headless drive (what worked)

Use system Chrome via `puppeteer-core` (install it in the scratchpad, ESM
`import`, not `require`):

- launch: `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`,
  `headless: 'new'`, args `--autoplay-policy=no-user-gesture-required --mute-audio`
  (muted audio still processes the Web Audio graph; analyser bands go nonzero)
- `page.goto('file:///…/index.html?debug')` — `file://` works, no server needed
- `page.evaluate(() => document.getElementById('tunein').click())` — with
  `?debug`/`?roll` panels open they can cover the button, so a coordinate
  click may silently miss; wait ~3 s, then `page.evaluate` reads top-level
  bindings directly (`started`, `actx`, `liveNodes`, `visQueue`, `genParams`,
  `genAt`) — app.js is a classic script, so its globals are reachable
- collect `page.on('console')` errors and `page.on('pageerror')` — the pass/fail
  backbone

## Driving specific musical situations

- Every note scheduled also calls `vis(tw, kind, midi, dur)` — wrap the global
  `vis` binding in `page.evaluate` to count scheduled events by kind without
  touching audio
- To audition a generation with a particular character, iterate
  `genAt`/`genAfter` and scan `genParams(g)` for the params you need (the
  theory section is pure JS — slice app.js up to the `audio -- */` banner and
  `new Function(head + 'return {genParams, genAt, genAfter}')()` in node),
  then `page.evaluate(s => jumpTo(s + 0.02), P.start)` and wait a few seconds
  of real time
- Good probes: rapid back-to-back `jumpTo` calls (exercises `cutLiveNodes`),
  checking `liveNodes.size` stays bounded, screenshotting for note shapes
