// Probe the public reference app (https://sael.net/mearim-flood/) with Playwright.
// Collects only publicly served information: network requests, response headers,
// script URLs, WebGL context parameters and global symbols. Nothing is redistributed.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const URL = process.argv[2] ?? 'https://sael.net/mearim-flood/';
const OUT = 'analysis/reference';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript(() => {
  window.__probe = { contexts: [], shaders: [], workers: [], wasm: 0, fetches: [] };
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    window.__probe.contexts.push({ type, attrs: attrs ?? null, w: this.width, h: this.height });
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__wrapped) {
      ctx.__wrapped = true;
      const origSource = ctx.shaderSource.bind(ctx);
      ctx.shaderSource = (sh, src) => {
        if (window.__probe.shaders.length < 400) window.__probe.shaders.push(src);
        return origSource(sh, src);
      };
    }
    return ctx;
  };
  const OrigWorker = window.Worker;
  window.Worker = function (url, opts) {
    window.__probe.workers.push(String(url));
    return new OrigWorker(url, opts);
  };
  const origInst = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...a) { window.__probe.wasm++; return origInst.apply(this, a); };
  window.__probe.gpu = 'gpu' in navigator;
  if (navigator.gpu) {
    const orig = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = (...a) => { window.__probe.webgpuRequested = true; return orig(...a); };
  }
});

const requests = [];
page.on('response', async (res) => {
  const req = res.request();
  let size = null;
  try { size = (await res.body()).length; } catch {}
  requests.push({
    url: req.url(), method: req.method(), type: req.resourceType(), status: res.status(),
    contentType: res.headers()['content-type'] ?? '', size,
    server: res.headers()['server'] ?? '', cache: res.headers()['cache-control'] ?? '',
  });
});
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: `${OUT}/initial.png` });

const info = await page.evaluate(() => {
  const g = Object.keys(window).filter((k) => !/^(webkit|on)/.test(k));
  const scripts = [...document.scripts].map((s) => ({ src: s.src, type: s.type, inlineLen: s.src ? 0 : s.textContent.length }));
  const links = [...document.querySelectorAll('link')].map((l) => ({ rel: l.rel, href: l.href }));
  const metas = [...document.querySelectorAll('meta')].map((m) => ({ name: m.name || m.getAttribute('property'), content: m.content }));
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, cls: c.className, id: c.id }));
  let gl = null;
  const c = document.querySelector('canvas');
  return {
    title: document.title, globals: g, scripts, links, metas, canvases,
    threeRevision: window.__THREE__ ?? null,
    probe: { ...window.__probe, shaders: window.__probe.shaders.length },
    htmlLen: document.documentElement.outerHTML.length,
  };
});
const shaders = await page.evaluate(() => window.__probe.shaders);
fs.writeFileSync(`${OUT}/shaders.txt`, shaders.map((s, i) => `// ---- shader ${i}\n${s}`).join('\n\n'));
fs.writeFileSync(`${OUT}/dom.html`, await page.content());

// interact: slider to different values
const sliders = await page.$$('input[type=range]');
info.sliderCount = sliders.length;
info.sliders = await page.$$eval('input[type=range]', (els) => els.map((e) => ({ min: e.min, max: e.max, step: e.step, value: e.value, id: e.id, name: e.name, aria: e.getAttribute('aria-label') })));
if (sliders.length) {
  for (const v of ['4', '6', '9', '11']) {
    await sliders[0].evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/level-${v}.png` });
  }
}
info.requestsAfterSlider = requests.length;
fs.writeFileSync(`${OUT}/requests.json`, JSON.stringify(requests, null, 2));
fs.writeFileSync(`${OUT}/info.json`, JSON.stringify(info, null, 2));
fs.writeFileSync(`${OUT}/console.txt`, consoleMsgs.join('\n'));
console.log(JSON.stringify({ title: info.title, n: requests.length, canvases: info.canvases, three: info.threeRevision, probe: info.probe, sliders: info.sliders }, null, 2));
await browser.close();
