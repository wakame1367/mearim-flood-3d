import { chromium } from "@playwright/test";
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH, args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage();
await p.goto("https://sael.net/mearim-flood/", { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
const r = await p.evaluate(() => {
  const d = window.MF_DATA;
  const desc = (v, depth=0) => {
    if (v == null) return String(v);
    if (typeof v === "string") return "string(" + v.length + ")" + (v.length < 80 ? " " + JSON.stringify(v) : "");
    if (typeof v === "number" || typeof v === "boolean") return typeof v + " " + v;
    if (Array.isArray(v)) return "array(" + v.length + ")" + (depth < 3 && v.length ? " [0]=" + desc(v[0], depth+1) : "");
    if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + v.length + ")";
    if (depth > 3) return "object";
    return "{" + Object.keys(v).map(k => k + ": " + desc(v[k], depth+1)).join(", ") + "}";
  };
  const lab = typeof window.__lab;
  return { data: desc(d), lab, dbg: typeof window.__dbg, step: typeof window.__step };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
