import { cellIndexAt, type Grid } from './grid';

/**
 * Exposure of buildings and roads to the static flood. All quantities are approximate: they depend on
 * footprint coverage (Google Open Buildings via Overture, OSM roads) and on the 30 m DEM sampling.
 *
 * For each asset we precompute the river rise at which it becomes affected, so stats for any rise
 * (and whole stage-impact curves) are binary searches over sorted arrays.
 */

export interface RawBuilding {
  c: number[]; // x,y pairs (local metres), open ring
  s: string; // source: G = Google Open Buildings, O = OSM, X = other
  p: number | null; // source confidence
  h: number | null; // height (m) if known
}
export interface RawRoad {
  c: number[];
  k: string; // OSM highway class
  n: string | null;
  br: number; // 1 = bridge
}

export interface BuildingSet {
  count: number;
  coords: Float32Array; // x,y pairs of all rings
  offsets: Int32Array; // start (in points) of ring b; offsets[count] = total points
  cx: Float32Array;
  cy: Float32Array;
  town: Uint8Array;
  samples: Int32Array; // cell indices sampled for each building (centroid + vertices, unique)
  sampleOffsets: Int32Array;
  heights: Float32Array; // NaN if unknown
}

export function prepareBuildings(grid: Grid, raw: RawBuilding[], townRaster: Uint8Array): BuildingSet {
  const count = raw.length;
  const offsets = new Int32Array(count + 1);
  for (let b = 0; b < count; b++) offsets[b + 1] = offsets[b] + raw[b].c.length / 2;
  const coords = new Float32Array(offsets[count] * 2);
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const town = new Uint8Array(count);
  const heights = new Float32Array(count);
  const samples: number[] = [];
  const sampleOffsets = new Int32Array(count + 1);
  for (let b = 0; b < count; b++) {
    const c = raw[b].c;
    coords.set(c, offsets[b] * 2);
    let sx = 0;
    let sy = 0;
    const m = c.length / 2;
    for (let p = 0; p < m; p++) {
      sx += c[2 * p];
      sy += c[2 * p + 1];
    }
    cx[b] = sx / m;
    cy[b] = sy / m;
    heights[b] = raw[b].h ?? NaN;
    const set = new Set<number>();
    const kc = cellIndexAt(grid, cx[b], cy[b]);
    if (kc >= 0) set.add(kc);
    for (let p = 0; p < m; p++) {
      const k = cellIndexAt(grid, c[2 * p], c[2 * p + 1]);
      if (k >= 0) set.add(k);
    }
    town[b] = kc >= 0 ? townRaster[kc] : 0;
    for (const k of set) samples.push(k);
    sampleOffsets[b + 1] = samples.length;
  }
  return { count, coords, offsets, cx, cy, town, samples: Int32Array.from(samples), sampleOffsets, heights };
}

export interface RoadSegments {
  count: number;
  xy: Float32Array; // x0,y0,x1,y1 per segment
  length: Float32Array;
  cell: Int32Array; // cell under the segment midpoint
  town: Uint8Array;
  bridge: Uint8Array;
  road: Int32Array; // index of the source road
}

/** Split roads into segments of at most `maxLen` metres so each one samples a single DEM cell. */
export function prepareRoads(grid: Grid, raw: RawRoad[], townRaster: Uint8Array, maxLen = grid.cell / 2): RoadSegments {
  const xy: number[] = [];
  const len: number[] = [];
  const cell: number[] = [];
  const town: number[] = [];
  const bridge: number[] = [];
  const road: number[] = [];
  raw.forEach((r, ri) => {
    const c = r.c;
    for (let p = 0; p + 3 < c.length; p += 2) {
      const [x0, y0, x1, y1] = [c[p], c[p + 1], c[p + 2], c[p + 3]];
      const d = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(d / maxLen));
      for (let s = 0; s < n; s++) {
        const ax = x0 + ((x1 - x0) * s) / n;
        const ay = y0 + ((y1 - y0) * s) / n;
        const bx = x0 + ((x1 - x0) * (s + 1)) / n;
        const by = y0 + ((y1 - y0) * (s + 1)) / n;
        const k = cellIndexAt(grid, (ax + bx) / 2, (ay + by) / 2);
        if (k < 0) continue;
        xy.push(ax, ay, bx, by);
        len.push(d / n);
        cell.push(k);
        town.push(townRaster[k]);
        bridge.push(r.br);
        road.push(ri);
      }
    }
  });
  return {
    count: len.length,
    xy: Float32Array.from(xy),
    length: Float32Array.from(len),
    cell: Int32Array.from(cell),
    town: Uint8Array.from(town),
    bridge: Uint8Array.from(bridge),
    road: Int32Array.from(road),
  };
}

export interface Thresholds {
  building: number; // m of water at the building to count it as flooded
  roadCut: number; // m of water that makes a road impassable
}
export const DEFAULT_THRESHOLDS: Thresholds = { building: 0.1, roadCut: 0.3 };

/**
 * Rise at which an asset is affected: the cell must be flooded (arrival < rise) and the depth
 * rise - hRel must reach the threshold  ->  rise_needed = max(arrival, hRel + threshold).
 */
const needed = (arrival: number, hRel: number, thr: number) => Math.max(arrival, hRel + thr);

export interface Exposure {
  buildingRise: Float32Array; // rise needed to flood each building (>= threshold depth)
  buildingHMin: Float32Array; // lowest hRel among its sample cells (for depth colouring)
  roadWetRise: Float32Array; // rise at which any water reaches the segment
  roadCutRise: Float32Array; // rise at which the segment is impassable (Infinity for bridges)
  segHRel: Float32Array;
}

export function computeExposure(
  b: BuildingSet,
  r: RoadSegments,
  hRel: Float32Array,
  arrival: Float32Array,
  thr: Thresholds = DEFAULT_THRESHOLDS,
): Exposure {
  const buildingRise = new Float32Array(b.count);
  const buildingHMin = new Float32Array(b.count);
  for (let i = 0; i < b.count; i++) {
    let best = Infinity;
    let hmin = Infinity;
    for (let s = b.sampleOffsets[i]; s < b.sampleOffsets[i + 1]; s++) {
      const k = b.samples[s];
      best = Math.min(best, needed(arrival[k], hRel[k], thr.building));
      hmin = Math.min(hmin, hRel[k]);
    }
    buildingRise[i] = best;
    buildingHMin[i] = hmin;
  }
  const roadWetRise = new Float32Array(r.count);
  const roadCutRise = new Float32Array(r.count);
  const segHRel = new Float32Array(r.count);
  for (let i = 0; i < r.count; i++) {
    const k = r.cell[i];
    segHRel[i] = hRel[k];
    if (r.bridge[i]) {
      roadWetRise[i] = roadCutRise[i] = Infinity; // assume the deck stays above the modelled water
      continue;
    }
    roadWetRise[i] = needed(arrival[k], hRel[k], 0);
    roadCutRise[i] = needed(arrival[k], hRel[k], thr.roadCut);
  }
  return { buildingRise, buildingHMin, roadWetRise, roadCutRise, segHRel };
}

export interface TownStats {
  floodedAreaKm2: number; // flooded land, permanent channel excluded
  buildings: number;
  buildingsTotal: number;
  roadsWetKm: number;
  roadsCutKm: number;
  roadsTotalKm: number;
}

/** Sorted "rise thresholds" per town (+ weights) for O(log n) queries at any rise. */
class SortedCounter {
  private keys: Float32Array;
  private cum: Float64Array;
  constructor(values: number[], weights?: number[]) {
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    this.keys = Float32Array.from(idx.map((i) => values[i]));
    this.cum = new Float64Array(idx.length + 1);
    idx.forEach((i, n) => (this.cum[n + 1] = this.cum[n] + (weights ? weights[i] : 1)));
  }
  /** total weight of entries with key < x */
  below(x: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.keys[m] < x) lo = m + 1;
      else hi = m;
    }
    return this.cum[lo];
  }
  get total() {
    return this.cum[this.cum.length - 1];
  }
}

export class ImpactIndex {
  private area = new Map<number, SortedCounter>();
  private bld = new Map<number, SortedCounter>();
  private wet = new Map<number, SortedCounter>();
  private cut = new Map<number, SortedCounter>();
  readonly towns: number[];

  constructor(
    grid: Grid,
    arrival: Float32Array,
    channel: Uint8Array,
    townRaster: Uint8Array,
    b: BuildingSet,
    r: RoadSegments,
    e: Exposure,
    towns = [1, 2],
  ) {
    this.towns = towns;
    const cellKm2 = (grid.cell * grid.cell) / 1e6;
    const group = <T>(n: number, townOf: (i: number) => number, val: (i: number) => T, keep: (i: number) => boolean = () => true) => {
      const m = new Map<number, T[]>();
      for (const t of [0, ...towns]) m.set(t, []);
      for (let i = 0; i < n; i++) if (keep(i)) m.get(townOf(i))?.push(val(i));
      return m;
    };
    const areaG = group(arrival.length, (k) => townRaster[k], (k) => arrival[k], (k) => !channel[k]);
    for (const [t, v] of areaG) this.area.set(t, new SortedCounter(v, v.map(() => cellKm2)));
    const bG = group(b.count, (i) => b.town[i], (i) => e.buildingRise[i]);
    for (const [t, v] of bG) this.bld.set(t, new SortedCounter(v));
    const rG = group(r.count, (i) => r.town[i], (i) => i);
    for (const [t, ids] of rG) {
      const w = ids.map((i) => r.length[i] / 1000);
      this.wet.set(t, new SortedCounter(ids.map((i) => e.roadWetRise[i]), w));
      this.cut.set(t, new SortedCounter(ids.map((i) => e.roadCutRise[i]), w));
    }
  }

  at(rise: number, town: number): TownStats {
    return {
      floodedAreaKm2: this.area.get(town)!.below(rise),
      buildings: this.bld.get(town)!.below(rise),
      buildingsTotal: this.bld.get(town)!.total,
      roadsWetKm: this.wet.get(town)!.below(rise),
      roadsCutKm: this.cut.get(town)!.below(rise),
      roadsTotalKm: this.wet.get(town)!.total,
    };
  }

  total(rise: number): TownStats {
    const parts = [0, ...this.towns].map((t) => this.at(rise, t));
    const sum = (f: keyof TownStats) => parts.reduce((s, p) => s + p[f], 0);
    return {
      floodedAreaKm2: sum('floodedAreaKm2'),
      buildings: sum('buildings'),
      buildingsTotal: sum('buildingsTotal'),
      roadsWetKm: sum('roadsWetKm'),
      roadsCutKm: sum('roadsCutKm'),
      roadsTotalKm: sum('roadsTotalKm'),
    };
  }

  /** Lowest rise (within [lo, hi], step) at which `town` reaches `n` flooded buildings; null if never. */
  firstRiseWithBuildings(town: number, n: number, lo = -5, hi = 15, step = 0.01): number | null {
    for (let r = lo; r <= hi; r += step) if (this.bld.get(town)!.below(r) >= n) return r;
    return null;
  }
}
