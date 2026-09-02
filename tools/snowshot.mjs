import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE = '/Users/memorecks/Claude Code/proc_mus/index.html';
const OUT = '/private/tmp/claude-501/-Users-memorecks-Claude-Code-proc-mus/51b3466e-b4e7-4a38-9944-d6befef3a10f/scratchpad';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(pathToFileURL(FILE).href, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 400));
await page.click('#tunein').catch(() => {});
await new Promise(r => setTimeout(r, 600));

// find snow generations at a daytime UTC hour and a nighttime one, plus the
// biome distribution over a day, and verify no consecutive repeats
const info = await page.evaluate(() => {
  // walk real generations via genAfter (hours have 2-5 of 6 possible slots)
  const gens = [];
  let g = genAt(0).g;
  for (let n = 0; n < 400; n++) {
    const P = genParams(g);
    const hod = ((P.start / 3600) % 24 + 24) % 24;
    gens.push({ g, start: P.start, biome: P.biome, hod });
    g = genAfter(g).g;
  }
  const snow = gens.filter(x => x.biome === 'snow');
  const day = snow.find(x => x.hod >= 10 && x.hod <= 15) || null;
  const night = snow.find(x => x.hod <= 4 || x.hod >= 22) || null;
  const day2 = snow.filter(x => x.hod >= 10 && x.hod <= 15)[1] || null;
  // distribution + consecutive repeats
  const dist = {}; let repeats = 0, prev = null;
  for (const x of gens) {
    dist[x.biome] = (dist[x.biome] || 0) + 1;
    if (x.biome === prev) repeats++;
    prev = x.biome;
  }
  return { day, night, day2, dist, repeats, total: gens.length };
});
console.log('day snow gen:', JSON.stringify(info.day));
console.log('night snow gen:', JSON.stringify(info.night));
console.log('day2 snow gen:', JSON.stringify(info.day2));
console.log(`distribution (${info.total} gens):`, JSON.stringify(info.dist), 'consecutive repeats:', info.repeats);

const shoot = async (target, name) => {
  if (!target) { console.log('no gen for', name); return; }
  await page.evaluate((w) => { jumpTo(w + 30); }, target.start);
  await new Promise(r => setTimeout(r, 1400));
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
await shoot(info.day, 'snow-day');
await shoot(info.night, 'snow-night');
await shoot(info.day2, 'snow-day2');

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'ok, no errors');
await browser.close();
