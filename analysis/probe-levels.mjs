// Records the reference app's public UI read-outs at preset levels (keys 4/5/6) and in the dam scenario.
// Used only to compare behaviour; screenshots stay in analysis/reference (git-ignored).
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = 'analysis/reference';
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://sael.net/mearim-flood/', { waitUntil: 'networkidle' });
await p.waitForTimeout(12000);
const readout = () => p.evaluate(() => {
  const t = document.body.innerText;
  const g = (re) => (t.match(re) || [])[1];
  return { level: g(/MEARIM\s*\n?\s*([\d.]+)\s*m/i), inWater: g(/IN WATER\s*\n?\s*([\d,]+)/i), streetsCut: g(/STREETS CUT\s*\n?\s*([\d.]+)/i), summary: (t.match(/At [\d.]+ m[^\n]*/) || [])[0] };
});
const fps = () => p.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n / 3); }; requestAnimationFrame(f); }));
const rows = [];
rows.push({ key: 'initial', ...(await readout()), fps: await fps() });
await p.mouse.click(720, 880);
for (const k of ['4', '5', '6']) {
  await p.keyboard.press(k);
  await p.waitForTimeout(4000);
  rows.push({ key: k, ...(await readout()) });
  await p.screenshot({ path: `${OUT}/preset-${k}.png` });
}
for (let i = 0; i < 25; i++) await p.keyboard.press('BracketLeft');
await p.waitForTimeout(3000);
rows.push({ key: '[x25', ...(await readout()) });
await p.screenshot({ path: `${OUT}/low.png` });
await p.keyboard.press('2');
await p.waitForTimeout(2500);
await p.screenshot({ path: `${OUT}/risk-layer.png` });
await p.keyboard.press('0');
await p.waitForTimeout(2500);
await p.keyboard.press('Space');
await p.waitForTimeout(12000);
rows.push({ key: 'dam+space', ...(await readout()), text: (await p.evaluate(() => document.body.innerText)).slice(0, 1500) });
await p.screenshot({ path: `${OUT}/dam.png` });
fs.writeFileSync(`${OUT}/levels.json`, JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
await b.close();
