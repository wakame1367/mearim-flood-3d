// Unit tests on SYNTHETIC (dummy) data: grid coordinates, sampling, coarsening, building/road exposure.
import { describe, expect, it } from 'vitest';
import { riseFromStage, wseAtGauge, gaugeZeroElevation, stageFromRise } from '../../src/core/calibration';
import { arrivalConnected } from '../../src/core/flood';
import {
  cellIndexAt,
  cellX,
  cellY,
  coarsenAny,
  coarsenMean,
  coarsenMode,
  sampleBilinear,
  toGridCoords,
  type Grid,
} from '../../src/core/grid';
import { computeExposure, ImpactIndex, prepareBuildings, prepareRoads } from '../../src/core/impact';
import { valleyFixture } from './fixtures';

describe('grid coordinates', () => {
  const g: Grid = { nx: 4, ny: 2, cell: 30 };
  it('cell centres are symmetric around the origin, row 0 = north', () => {
    expect(cellX(g, 0)).toBe(-45);
    expect(cellX(g, 3)).toBe(45);
    expect(cellY(g, 0)).toBe(15);
    expect(cellY(g, 1)).toBe(-15);
  });
  it('round-trips cell index <-> local point', () => {
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        expect(cellIndexAt(g, cellX(g, i), cellY(g, j))).toBe(j * g.nx + i);
        expect(toGridCoords(g, cellX(g, i), cellY(g, j))).toEqual([i, j]);
      }
    expect(cellIndexAt(g, 61, 0)).toBe(-1);
  });
  it('bilinear sampling interpolates a plane exactly', () => {
    const a = new Float32Array(8).map((_, k) => 2 * (k % 4) + 10 * Math.floor(k / 4));
    expect(sampleBilinear(g, a, 0, 0)).toBeCloseTo(8, 5); // between columns 1,2 and rows 0,1
    expect(sampleBilinear(g, a, cellX(g, 1), cellY(g, 1))).toBeCloseTo(12, 5);
  });
});

describe('coarsening (DEM resolution study)', () => {
  const g: Grid = { nx: 5, ny: 3, cell: 30 };
  const a = Float32Array.from({ length: 15 }, (_, k) => k);
  it('block mean with partial edge blocks', () => {
    const c = coarsenMean(g, a, 2);
    expect(c.grid).toEqual({ nx: 3, ny: 2, cell: 60 });
    expect(c.data[0]).toBeCloseTo((0 + 1 + 5 + 6) / 4);
    expect(c.data[2]).toBeCloseTo((4 + 9) / 2);
    expect(c.data[5]).toBeCloseTo(14);
  });
  it('mask "any" keeps thin features; mode keeps majority', () => {
    const m = new Uint8Array(15);
    m[6] = 1;
    expect(Array.from(coarsenAny(g, m, 2))).toEqual([1, 0, 0, 0, 0, 0]);
    const t = Uint8Array.from([1, 1, 2, 2, 2, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0]);
    expect(Array.from(coarsenMode(g, t, 2))).toEqual([1, 2, 2, 0, 0, 0]);
  });
});

describe('calibration (gauge stage vs DEM elevation)', () => {
  const c = { riverZAtGauge: 22.66, stageAtDem: 2.2 };
  it('converts stage to rise and water-surface elevation without equating stage and height', () => {
    expect(riseFromStage(c, 7.45)).toBeCloseTo(5.25);
    expect(wseAtGauge(c, 7.45)).toBeCloseTo(27.91);
    expect(gaugeZeroElevation(c)).toBeCloseTo(20.46);
    expect(stageFromRise(c, riseFromStage(c, 9.81))).toBeCloseTo(9.81);
  });
});

describe('building and road exposure (synthetic valley)', () => {
  const { grid, hRel, channel } = valleyFixture(); // cell 10 m, x from -40..40, y from -25..25
  const arrival = arrivalConnected(grid, hRel, channel);
  const town = new Uint8Array(grid.nx * grid.ny).fill(1);
  for (let k = 0; k < town.length; k++) if (k % grid.nx >= 4) town[k] = 2; // east of the ridge = town 2
  const sq = (x: number, y: number) => [x - 2, y - 2, x + 2, y - 2, x + 2, y + 2, x - 2, y + 2];
  const raw = [
    { c: sq(-25, 0), s: 'G', p: 0.9, h: null }, // column 1, hRel 1
    { c: sq(-5, 0), s: 'G', p: 0.9, h: null }, // column 3, hRel 3
    { c: sq(15, 0), s: 'G', p: 0.9, h: null }, // column 5, hollow behind ridge (hRel 2)
  ];
  const b = prepareBuildings(grid, raw, town);
  const roads = prepareRoads(
    grid,
    [
      { c: [-30, 10, 30, 10], k: 'residential', n: 'A', br: 0 },
      { c: [-40, -10, -30, -10], k: 'primary', n: 'Bridge', br: 1 },
    ],
    town,
  );
  const e = computeExposure(b, roads, hRel, arrival, { building: 0.1, roadCut: 0.3 });

  it('rise needed = max(arrival, hRel + threshold)', () => {
    expect(e.buildingRise[0]).toBeCloseTo(1.1);
    expect(e.buildingRise[1]).toBeCloseTo(3.1);
    expect(e.buildingRise[2]).toBeCloseTo(5); // hollow waits for the 5 m ridge
  });

  it('assigns towns by centroid cell', () => {
    expect(Array.from(b.town)).toEqual([1, 1, 2]);
  });

  it('bridges are never cut; road segments sample one cell each', () => {
    const bridgeSegs = [...roads.bridge.keys()].filter((i) => roads.bridge[i]);
    expect(bridgeSegs.length).toBeGreaterThan(0);
    for (const i of bridgeSegs) expect(e.roadCutRise[i]).toBe(Infinity);
    for (let i = 0; i < roads.count; i++) expect(roads.length[i]).toBeLessThanOrEqual(grid.cell / 2 + 1e-6);
  });

  it('impact index counts buildings / road length below a rise', () => {
    const idx = new ImpactIndex(grid, arrival, channel, town, b, roads, e);
    expect(idx.at(1.0, 1).buildings).toBe(0);
    expect(idx.at(1.2, 1).buildings).toBe(1);
    expect(idx.at(4.0, 1).buildings).toBe(2);
    expect(idx.at(4.0, 2).buildings).toBe(0);
    expect(idx.at(5.01, 2).buildings).toBe(1);
    // road A spans x=-30..30 at y=10 (60 m); wet where arrival < rise
    const r = idx.at(2.5, 1);
    expect(r.roadsWetKm).toBeGreaterThan(0);
    expect(r.roadsCutKm).toBeLessThanOrEqual(r.roadsWetKm);
    expect(idx.total(100).roadsTotalKm).toBeCloseTo(0.07, 3);
    // flooded area: town 1 has 3 non-channel columns x 5 rows of 100 m2
    expect(idx.at(3.5, 1).floodedAreaKm2).toBeCloseTo((3 * 5 * 100) / 1e6, 8);
    expect(idx.firstRiseWithBuildings(2, 1, 0, 10, 0.01)).toBeCloseTo(5.0, 1);
  });
});
