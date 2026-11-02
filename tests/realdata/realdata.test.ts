// REAL-DATA verification: runs on the processed study-area layers in public/data (produced by
// scripts/preprocess.py from Copernicus GLO-30, SGB, OSM, Overture and ANA). Skipped if they are missing.
// Also writes analysis/realdata-report.json, used by docs/comparison.md.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, type Dataset } from '../../src/core/dataset';
import { cellIndexAt, sampleBilinear } from '../../src/core/grid';
import { defaultStageAtDem, Scenario, type ScenarioSettings } from '../../src/core/scenario';
import { DEFAULT_THRESHOLDS } from '../../src/core/impact';
import { calibrateToRecord, FLOOD_RECORDS, fractionFlooded } from '../../src/core/records';

const DATA = path.resolve(__dirname, '../../public/data');
const has = fs.existsSync(path.join(DATA, 'manifest.json'));
const io = {
  bin: async (n: string) => {
    const b = fs.readFileSync(path.join(DATA, n));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
  json: async <T,>(n: string) => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8')) as T,
};

describe.skipIf(!has)('real data (study area)', () => {
  let ds: Dataset;
  const report: Record<string, unknown> = {};
  const settings = (o: Partial<ScenarioSettings> = {}): ScenarioSettings => ({
    dem: 'cop30',
    ref: 'hand',
    model: 'connected',
    coarsen: 1,
    stageAtDem: defaultStageAtDem(ds, o.dem ?? 'cop30'),
    thresholds: DEFAULT_THRESHOLDS,
    ...o,
  });

  beforeAll(async () => {
    ds = await loadDataset(io);
  });

  it('loads DEMs with the declared grid and plausible elevations', () => {
    const n = ds.grid.nx * ds.grid.ny;
    expect(ds.grid.cell).toBe(30);
    for (const [k, d] of Object.entries(ds.dems)) {
      expect(d.z.length).toBe(n);
      const m = ds.manifest.dems[k];
      expect(m.zMin).toBeGreaterThan(5);
      expect(m.zMax).toBeLessThan(200);
      expect(Number.isFinite(d.zrefHand.reduce((a, b) => a + b, 0))).toBe(true);
    }
  });

  it('coordinate transform: gauge lies on the river, Pedreiras east / Trizidela west of it', () => {
    const g = ds.manifest.gauge as typeof ds.manifest.gauge & { snapDistance: number };
    // ANA publishes the latitude to 0.01 deg (~1.1 km): the raw point must be within that of the river
    expect(g.snapDistance).toBeLessThan(600);
    const k = cellIndexAt(ds.grid, g.x, g.y);
    expect(k).toBeGreaterThanOrEqual(0);
    // the gauge cell or a neighbour within 2 cells is channel
    let near = false;
    const i0 = k % ds.grid.nx;
    const j0 = Math.floor(k / ds.grid.nx);
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) near ||= ds.channel[(j0 + dj) * ds.grid.nx + i0 + di] === 1;
    expect(near).toBe(true);
    const ped = ds.pois.find((p) => p.n === 'Pedreiras' && p.k === 'town')!;
    const tri = ds.pois.find((p) => p.n === 'Trizidela do Vale' && p.k === 'town')!;
    expect(ped.x).toBeGreaterThan(tri.x);
    expect(ds.town[cellIndexAt(ds.grid, ped.x, ped.y)]).toBe(1);
    expect(ds.town[cellIndexAt(ds.grid, tri.x, tri.y)]).toBe(2);
    const zr = sampleBilinear(ds.grid, ds.dems.cop30.z, g.x, g.y);
    report.gauge = { x: g.x, y: g.y, demAtGauge: zr, riverZAtGauge: ds.manifest.dems.cop30.riverZAtGauge };
  });

  it('river channel sits at the bottom of the valley (HAND ~ 0 on channel)', () => {
    const s = new Scenario(ds, settings());
    let sum = 0;
    let c = 0;
    for (let k = 0; k < s.hRel.length; k++) if (s.channel[k]) (sum += Math.abs(s.hRel[k])), c++;
    expect(sum / c).toBeLessThan(1.5);
  });

  it('flood grows monotonically with stage; connected <= bathtub', () => {
    const conn = new Scenario(ds, settings({ model: 'connected', ref: 'flat' }));
    const bath = new Scenario(ds, settings({ model: 'bathtub', ref: 'flat' }));
    let prev = -1;
    const rows = [];
    for (let stage = 2; stage <= 12; stage += 0.5) {
      const r = conn.rise(stage);
      const a = conn.impact.total(r).floodedAreaKm2;
      const b = bath.impact.total(r).floodedAreaKm2;
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeLessThanOrEqual(b + 1e-9);
      prev = a;
      rows.push({ stage, connectedKm2: +a.toFixed(3), bathtubKm2: +b.toFixed(3) });
    }
    report.bathtubVsConnectedFlat = rows;
  });

  it('stage sweep per town for every model variant (report)', () => {
    const all: Partial<ScenarioSettings>[] = [
      { ref: 'hand', model: 'connected' },
      { ref: 'profile', model: 'connected' },
      { ref: 'flat', model: 'connected' },
      { ref: 'hand', model: 'bathtub' },
      { ref: 'hand', model: 'connected', coarsen: 2 },
      { ref: 'hand', model: 'connected', coarsen: 3 },
      { dem: 'sgb', ref: 'hand', model: 'connected' },
      { dem: 'fabdem', ref: 'hand', model: 'connected' },
      { ref: 'hand', model: 'connected', stageAtDem: 4.6 },
    ];
    const variants = all.filter((v) => !v.dem || ds.dems[v.dem]);
    const out = [];
    for (const v of variants) {
      const s = new Scenario(ds, settings(v));
      const sweep = [];
      for (let stage = 3; stage <= 11.001; stage += 0.5) {
        const r = s.rise(stage);
        const row: Record<string, number> = { stage: +stage.toFixed(2) };
        for (const t of [1, 2]) {
          const st = s.impact.at(r, t);
          row[`t${t}_bld`] = st.buildings;
          row[`t${t}_km2`] = +st.floodedAreaKm2.toFixed(3);
          row[`t${t}_cutKm`] = +st.roadsCutKm.toFixed(2);
        }
        const cmp = s.compareSusceptibility(r, 3);
        row.iouAlta = +cmp.iou.toFixed(3);
        sweep.push(row);
      }
      const first = (t: number, n: number) => {
        const r = s.impact.firstRiseWithBuildings(t, n);
        return r === null ? null : +(r + s.calibration.stageAtDem).toFixed(2);
      };
      out.push({
        settings: { ...s.settings, thresholds: undefined },
        computeMs: Math.round(s.computeMs),
        totals: { buildings: { 1: s.impact.at(100, 1).buildingsTotal, 2: s.impact.at(100, 2).buildingsTotal } },
        firstStage10Buildings: { pedreiras: first(1, 10), trizidela: first(2, 10) },
        firstStage100Buildings: { pedreiras: first(1, 100), trizidela: first(2, 100) },
        sweep,
      });
    }
    report.sweeps = out;
    fs.mkdirSync(path.resolve(__dirname, '../../analysis'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../../analysis/realdata-report.json'), JSON.stringify(report, null, 1));
    expect(out.length).toBeGreaterThan(3);
  });

  it('record-based calibration (2024 Pedreiras) and validation against 2009 Trizidela (report)', () => {
    const rows = [];
    for (const dem of Object.keys(ds.dems))
      for (const ref of ['hand', 'flat'] as const)
        for (const model of ['connected', 'bathtub'] as const) {
          const s0 = new Scenario(ds, settings({ dem, ref, model }));
          const cal = calibrateToRecord(s0, FLOOD_RECORDS[0]);
          expect(cal).not.toBeNull();
          const s = new Scenario(ds, settings({ dem, ref, model, stageAtDem: cal! }));
          const r2024 = s.rise(7.46);
          const r2009 = s.rise(9.81);
          const first = (t: number, n: number) => {
            const r = s.impact.firstRiseWithBuildings(t, n);
            return r === null ? null : +(r + cal!).toFixed(2);
          };
          rows.push({
            dem,
            ref,
            model,
            stageAtDemDefault: defaultStageAtDem(ds, dem),
            stageAtDemCalibrated: cal,
            gaugeZeroImplied: +(ds.manifest.dems[dem].riverZAtGauge - cal!).toFixed(2),
            at2024: { ped: s.impact.at(r2024, 1).buildings, tri: s.impact.at(r2024, 2).buildings },
            at2009: {
              ped: s.impact.at(r2009, 1).buildings,
              tri: s.impact.at(r2009, 2).buildings,
              triFraction: +fractionFlooded(s, 2, 9.81).toFixed(3),
              pedFraction: +fractionFlooded(s, 1, 9.81).toFixed(3),
            },
            first10: { ped: first(1, 10), tri: first(2, 10) },
            first100: { ped: first(1, 100), tri: first(2, 100) },
            iouAlta2009: +s.compareSusceptibility(r2009, 3).iou.toFixed(3),
          });
        }
    report.calibration = rows;
    fs.writeFileSync(path.resolve(__dirname, '../../analysis/realdata-report.json'), JSON.stringify(report, null, 1));
  });

  it('building / road exposure is consistent with the flood mask at a given stage', () => {
    const s = new Scenario(ds, settings());
    const rise = s.rise(8);
    const b = s.buildings;
    for (let i = 0; i < b.count; i += 97) {
      if (s.exposure.buildingRise[i] < rise) {
        // at least one sampled cell is flooded
        let any = false;
        for (let q = b.sampleOffsets[i]; q < b.sampleOffsets[i + 1]; q++) any ||= s.arrival[b.samples[q]] < rise;
        expect(any).toBe(true);
      }
    }
    const tot = s.impact.total(rise);
    expect(tot.roadsCutKm).toBeLessThanOrEqual(tot.roadsWetKm + 1e-9);
    expect(tot.buildings).toBeLessThanOrEqual(tot.buildingsTotal);
  });
});
