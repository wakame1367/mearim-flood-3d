// Unit tests on SYNTHETIC (dummy) grids — they validate the algorithms, not the real study area.
import { describe, expect, it } from 'vitest';
import {
  arrivalBathtub,
  arrivalConnected,
  CHANNEL_ARRIVAL,
  depthGrid,
  floodBFS,
  floodedMask,
  relativeHeight,
} from '../../src/core/flood';
import { randomTerrain, valleyFixture } from './fixtures';

const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

describe('relativeHeight / depth', () => {
  it('computes hRel = z - zref', () => {
    const h = relativeHeight(new Float32Array([25, 30, 21]), new Float32Array([22, 22, 22]));
    expect(Array.from(h)).toEqual([3, 8, -1]);
  });

  it('depth = rise - hRel on flooded cells, 0 elsewhere', () => {
    const { grid, hRel, channel } = valleyFixture();
    const arr = arrivalConnected(grid, hRel, channel);
    const d = depthGrid(hRel, arr, 2.5);
    // row 0: channel 2.5, col1 1.5, col2 0.5, col3 (3 m) dry, ridge dry, hollow dry (behind ridge)
    expect(Array.from(d.slice(0, 8))).toEqual([2.5, 1.5, 0.5, 0, 0, 0, 0, 0]);
  });
});

describe('bathtub vs connected', () => {
  const { grid, hRel, channel } = valleyFixture();

  it('bathtub floods the isolated hollow, connected does not', () => {
    const rise = 2.5;
    const bath = floodedMask(arrivalBathtub(hRel, channel), rise);
    const conn = floodedMask(arrivalConnected(grid, hRel, channel), rise);
    expect(bath[5]).toBe(1); // hollow (hRel 2) < 2.5
    expect(conn[5]).toBe(0); // behind 5 m ridge
    expect(count(bath)).toBeGreaterThan(count(conn));
  });

  it('hollow floods once the ridge is overtopped (arrival = ridge height)', () => {
    const arr = arrivalConnected(grid, hRel, channel);
    expect(arr[5]).toBe(5);
    expect(arr[6]).toBe(5);
    expect(floodedMask(arr, 5.01)[5]).toBe(1);
    expect(floodedMask(arr, 4.99)[5]).toBe(0);
  });

  it('channel cells are always wet', () => {
    const arr = arrivalConnected(grid, hRel, channel);
    expect(arr[0]).toBe(CHANNEL_ARRIVAL);
    expect(floodedMask(arr, -10)[0]).toBe(1);
  });

  it('connected flood is always a subset of the bathtub flood', () => {
    const t = randomTerrain(60, 50, 7);
    const ab = arrivalBathtub(t.hRel, t.channel);
    const ac = arrivalConnected(t.grid, t.hRel, t.channel);
    for (const rise of [0.5, 1, 2, 4, 8]) {
      const b = floodedMask(ab, rise);
      const c = floodedMask(ac, rise);
      for (let k = 0; k < b.length; k++) expect(c[k] <= b[k]).toBe(true);
    }
  });
});

describe('priority-flood arrival equals per-rise BFS', () => {
  it.each([1, 2, 3, 4])('random terrain seed %i', (seed) => {
    const t = randomTerrain(70, 60, seed);
    const arr = arrivalConnected(t.grid, t.hRel, t.channel);
    for (const rise of [-0.5, 0.3, 1.1, 2.7, 5, 9]) {
      const bfs = floodBFS(t.grid, t.hRel, t.channel, rise);
      const fast = floodedMask(arr, rise);
      expect(Array.from(fast)).toEqual(Array.from(bfs));
    }
  });
});

describe('monotonicity in water level', () => {
  it('flooded area never decreases as the river rises', () => {
    const t = randomTerrain(80, 80, 11);
    const arr = arrivalConnected(t.grid, t.hRel, t.channel);
    let prev = 0;
    for (let rise = -1; rise <= 20; rise += 0.25) {
      const n = count(floodedMask(arr, rise));
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(80 * 80); // everything wet at a very high level
  });
});
