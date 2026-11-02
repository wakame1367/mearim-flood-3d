import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest, SimScenario } from '../../src/core/dataset';

const PACK = join(__dirname, '../../public/regions/ea4');

describe('ea4 simulation region pack (manifest v2)', () => {
  const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8')) as Manifest;
  const n = manifest.nx * manifest.ny;

  it('declares a simulation scenario with consistent frame count', () => {
    const sims = manifest.scenarios?.filter((s) => s.type === 'simulation') ?? [];
    expect(sims.length).toBeGreaterThan(0);
    for (const s of sims) {
      expect(s.frames.length).toBeGreaterThan(1);
      expect(s.dtSeconds).toBeGreaterThan(0);
      expect(['mm', 'cm', 'm']).toContain(s.unit);
    }
  });

  it('has a DEM matching the grid', () => {
    const dem = readFileSync(join(PACK, manifest.dems[Object.keys(manifest.dems)[0]].file));
    expect(dem.byteLength).toBe(n * 4);
  });

  it('every depth frame is nx*ny uint16 cells', () => {
    const sim = manifest.scenarios![0] as SimScenario;
    for (const f of sim.frames) {
      expect(readFileSync(join(PACK, f)).byteLength).toBe(n * 2);
    }
  });

  it('auxiliary rasters match the grid and empty asset lists parse', () => {
    for (const f of Object.values(manifest.rasters)) {
      expect(readFileSync(join(PACK, f)).byteLength).toBe(n);
    }
    expect(JSON.parse(readFileSync(join(PACK, 'buildings.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(PACK, 'roads.json'), 'utf8'))).toEqual([]);
    expect(manifest.gauge).toBeNull();
    expect(manifest.stage).toBeNull();
  });

  it('frame depths decode to metres within the declared max', () => {
    const sim = manifest.scenarios![0] as SimScenario;
    const scale = sim.unit === 'mm' ? 0.001 : sim.unit === 'cm' ? 0.01 : 1;
    let max = 0;
    for (const f of sim.frames) {
      const u16 = new Uint16Array(readFileSync(join(PACK, f)).buffer.slice(0));
      for (const v of u16) if (v * scale > max) max = v * scale;
    }
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual((sim.maxDepth_m ?? Infinity) + 0.01);
  });
});
