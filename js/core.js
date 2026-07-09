/* drift — a continuous generative broadcast.
   Every musical event is a pure function of UTC time, so all listeners
   hear the same moment of the same endless piece.

   The source is split by concern across several classic <script>s (loaded
   in dependency order from index.html); they share one global scope, so no
   imports — a top-level const/function in one file is visible in the next.

   core — time model + deterministic randomness. All audible randomness must
   flow through these seeded helpers (never Math.random) so the broadcast
   stays identical for every listener. */

'use strict';

/* ---------------------------------------------------------------- time -- */

const ORIGIN = Date.UTC(2026, 0, 1) / 1000;   // broadcast began 1 Jan 2026
const HOUR = 3600;
const LOOKAHEAD = 2.5;                        // seconds of audio pre-scheduled
const TICK_MS = 400;

let debugOffset = 0;                          // seconds of simulated time travel
const wallNow = () => Date.now() / 1000 - ORIGIN + debugOffset;

/* ------------------------------------------- deterministic randomness -- */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (...keys) => mulberry32(xmur3(keys.join('§'))());
const rand = (...keys) => R(...keys)();
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function wpick(r, items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let x = r() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* smooth 1-d value noise over a seeded lattice (music side, string seeds) */
function vnoise(seed, x) {
  const x0 = Math.floor(x), f = x - x0;
  const a = rand(seed, x0), b = rand(seed, x0 + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/* fast integer-hash noise for the visuals (no string hashing per frame) */
function ih(i, seed) {
  let n = (i * 374761393 + seed * 668265263) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vn(seed, x) {
  const x0 = Math.floor(x), f = x - x0;
  const u = f * f * (3 - 2 * f);
  return ih(x0, seed) + (ih(x0 + 1, seed) - ih(x0, seed)) * u;
}
function fbm(seed, x, oct = 3) {
  let s = 0, amp = 0.5, fr = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += vn(seed + i * 131, x * fr) * amp;
    norm += amp; amp *= 0.5; fr *= 2.03;
  }
  return s / norm;
}

