// Quick dev screenshot helper: node analysis/shot.mjs [stage] [view] [out]
import { chromium } from '@playwright/test';

const [stage = '7.45', view = 'overview', out = 'analysis/dev.png'] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(process.env.APP_URL || 'http://127.0.0.1:5173/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__app?.ready, null, { timeout: 120000 });
await p.evaluate(([s, v]) => { window.__app.setStage(Number(s)); window.__app.setView(v); }, [stage, view]);
await p.waitForTimeout(2500);
await p.screenshot({ path: out });
console.log(JSON.stringify(await p.evaluate(() => window.__app.stats())));
console.log(logs.join('\n'));
await b.close();
