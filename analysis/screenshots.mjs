// Capture app screenshots across stages/views/models and collect console errors.
// Usage: node analysis/screenshots.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
p.on('console', (m) => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await p.goto(process.env.APP_URL || 'http://127.0.0.1:5173/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__app?.ready, null, { timeout: 120000 });

const set = (id, v) => p.evaluate(([i, val]) => {
  const el = document.getElementById(i);
  el.value = String(val);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v]);

async function shot(name, fn, settleMs = 1800) {
  if (fn) { await fn(); await p.waitForTimeout(settleMs); }
  await p.screenshot({ path: `${OUT}/${name}.png` });
  const s = await p.evaluate(() => window.__app.stats());
  console.log(`${name}: stage→rise=${s.rise.toFixed(2)} ped=${s.t1.buildings} tri=${s.t2.buildings}`);
}

const stage = (v) => p.evaluate((s) => window.__app.setStage(s), v);
const view = (v) => p.evaluate((s) => window.__app.setView(s), v);

// --- water-level sweep, overview (default state: cop30 / hand / connected / record-cal)
for (const [name, st] of [
  ['stage-2.44-median', 2.44],
  ['stage-6.00-alert', 6.0],
  ['stage-7.46-crest2024', 7.46],
  ['stage-9.81-crest2009', 9.81],
  ['stage-10.10-crest1985', 10.1],
]) await shot(name, () => stage(st));

// --- town views at 2024 crest
await shot('view-pedreiras-7.46', async () => { await stage(7.46); await view('pedreiras'); });
await shot('view-trizidela-7.46', () => view('trizidela'));
await shot('view-profile-7.46', () => view('profile'), 1200);
await shot('view-overview-7.46', () => view('overview'), 1200);

// --- model comparison at same stage: bathtub vs connected
await shot('model-bathtub-7.46', () => set('model', 'bathtub'), 2500);
await shot('model-connected-7.46', () => set('model', 'connected'), 2500);

// --- reference surface comparison: flat vs hand
await shot('ref-flat-7.46', () => set('ref', 'flat'), 2500);
await shot('ref-hand-7.46', () => set('ref', 'hand'), 2500);

// --- color modes
await shot('color-hand', () => set('colorMode', 'hand'), 800);
await shot('color-arrival', () => set('colorMode', 'arrival'), 800);
await shot('color-susceptibility', () => set('colorMode', 'susceptibility'), 800);
await shot('color-elevation', () => set('colorMode', 'elevation'), 800);

// --- alternative DEMs (rebuild, wait longer)
await shot('dem-fabdem-7.46', () => set('dem', 'fabdem'), 3500);
await shot('dem-sgb-7.46', () => set('dem', 'sgb'), 3500);
await shot('dem-cop30-7.46', () => set('dem', 'cop30'), 3500);

// --- no-water terrain-only view
await shot('layers-terrain-only', async () => {
  await p.evaluate(() => { document.getElementById('showWater').click(); });
}, 800);

// fps + info sanity
const perf = await p.evaluate(() => ({ fps: window.__app.fps, rebuilds: window.__app.rebuilds }));
console.log('perf:', JSON.stringify(perf));
console.log('--- console messages ---');
console.log(logs.length ? logs.join('\n') : '(none)');
await b.close();
