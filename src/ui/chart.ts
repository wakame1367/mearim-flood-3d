import type { Scenario } from '../core/scenario';

const COLORS = { 1: '#ffb454', 2: '#ff6b8a' } as Record<number, string>;

/**
 * Stage-impact curves: flooded buildings vs gauge stage for each town (2D canvas).
 * Curves come from the precomputed ImpactIndex (binary searches), so redrawing is cheap.
 */
export function drawImpactChart(
  canvas: HTMLCanvasElement,
  s: Scenario,
  stage: number,
  marks: { stage: number; label: string }[],
  stageMin = 2,
  stageMax = 12,
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 360;
  const cssH = Math.round(cssW * 0.47);
  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 40, r: 8, t: 14, b: 22 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;
  const steps = 200;
  const series: Record<number, number[]> = { 1: [], 2: [] };
  let yMax = 10;
  for (let q = 0; q <= steps; q++) {
    const st = stageMin + ((stageMax - stageMin) * q) / steps;
    for (const t of [1, 2]) {
      const v = s.impact.at(s.rise(st), t).buildings;
      series[t].push(v);
      yMax = Math.max(yMax, v);
    }
  }
  yMax = Math.ceil(yMax / 500) * 500;
  const X = (st: number) => pad.l + ((st - stageMin) / (stageMax - stageMin)) * W;
  const Y = (v: number) => pad.t + H - (v / yMax) * H;
  ctx.font = '10px system-ui';
  ctx.strokeStyle = '#2a3a50';
  ctx.fillStyle = '#8fa0b3';
  ctx.lineWidth = 1;
  for (let st = Math.ceil(stageMin); st <= stageMax; st++) {
    ctx.beginPath();
    ctx.moveTo(X(st), pad.t);
    ctx.lineTo(X(st), pad.t + H);
    ctx.stroke();
    ctx.fillText(`${st}`, X(st) - 3, cssH - 8);
  }
  for (let v = 0; v <= yMax; v += yMax / 4) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(v));
    ctx.lineTo(pad.l + W, Y(v));
    ctx.stroke();
    ctx.fillText(`${Math.round(v)}`, 4, Y(v) + 3);
  }
  ctx.fillText('浸水建物数 (棟) vs 観測所水位 (m)', pad.l + 4, 10);
  for (const m of marks) {
    ctx.strokeStyle = '#5cc8ff55';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(m.stage), pad.t);
    ctx.lineTo(X(m.stage), pad.t + H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#5cc8ff';
    ctx.fillText(m.label, X(m.stage) + 2, pad.t + 9);
  }
  for (const t of [1, 2]) {
    ctx.strokeStyle = COLORS[t];
    ctx.lineWidth = 2;
    ctx.beginPath();
    series[t].forEach((v, q) => {
      const x = X(stageMin + ((stageMax - stageMin) * q) / steps);
      if (q) ctx.lineTo(x, Y(v));
      else ctx.moveTo(x, Y(v));
    });
    ctx.stroke();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(stage), pad.t);
  ctx.lineTo(X(stage), pad.t + H);
  ctx.stroke();
}
