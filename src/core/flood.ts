import type { Grid } from './grid';

/**
 * Static ("level-pool") inundation model.
 *
 * Notation
 *   z      ground (DEM) elevation of a cell
 *   zref   reference river-surface elevation assigned to the cell, i.e. the river level *at the time
 *          the DEM was acquired* (flat, along-river profile, or HAND drainage outlet; see docs/flood-model.md)
 *   hRel   = z - zref : height of the cell above that reference surface
 *   rise   = river rise above the DEM-time level, derived from the gauge reading (calibration.ts)
 *   WSE    = zref + rise : water-surface elevation over the cell
 *   depth  = WSE - z = rise - hRel  (only where the cell is flooded)
 *
 * Models
 *   bathtub   : flooded  <=> hRel < rise                      (every low cell, even if isolated)
 *   connected : flooded  <=> hRel < rise AND an 8-connected path of such cells reaches the river channel
 *
 * The "arrival rise" of a cell is the smallest rise at which it floods. For the connected model it is the
 * minimax path height (priority-flood), so one O(n log n) pass answers every rise at once; floodBFS() is the
 * direct per-rise definition and is used in the tests to validate it.
 */

export type FloodModel = 'bathtub' | 'connected';
export const CHANNEL_ARRIVAL = -1e9;

export const N8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
export const N4: ReadonlyArray<readonly [number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]];

export function relativeHeight(z: ArrayLike<number>, zref: ArrayLike<number>): Float32Array {
  const h = new Float32Array(z.length);
  for (let k = 0; k < z.length; k++) h[k] = z[k] - zref[k];
  return h;
}

export function arrivalBathtub(hRel: Float32Array, channel: Uint8Array): Float32Array {
  const a = new Float32Array(hRel.length);
  for (let k = 0; k < a.length; k++) a[k] = channel[k] ? CHANNEL_ARRIVAL : hRel[k];
  return a;
}

/** Minimal binary heap keyed by float priority (min-heap) over cell indices. */
class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2);
      const v2 = new Int32Array(this.size * 2);
      k2.set(this.keys);
      v2.set(this.vals);
      this.keys = k2;
      this.vals = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  /** Pops the minimum; returns its value, and its key in `lastKey`. */
  lastKey = 0;
  pop(): number {
    const top = this.vals[0];
    this.lastKey = this.keys[0];
    const key = this.keys[--this.size];
    const val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }
}

/**
 * Connected-model arrival rise via priority-flood (minimax path) from all channel cells.
 * arrival[k] = min over paths river->k of max(hRel) along the path (channel cells excluded).
 * Cells not reachable at all (impossible on a single grid) stay +Infinity.
 */
export function arrivalConnected(grid: Grid, hRel: Float32Array, channel: Uint8Array, neighbours = N8): Float32Array {
  const { nx, ny } = grid;
  const n = nx * ny;
  const arr = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, n >> 2));
  for (let k = 0; k < n; k++)
    if (channel[k]) {
      arr[k] = CHANNEL_ARRIVAL;
      done[k] = 1;
      heap.push(CHANNEL_ARRIVAL, k);
    }
  while (heap.size) {
    const k = heap.pop();
    const lv = heap.lastKey;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of neighbours) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const kk = jj * nx + ii;
      if (done[kk]) continue;
      done[kk] = 1;
      const v = Math.max(hRel[kk], lv);
      arr[kk] = v;
      heap.push(v, kk);
    }
  }
  return arr;
}

export function computeArrival(model: FloodModel, grid: Grid, hRel: Float32Array, channel: Uint8Array): Float32Array {
  return model === 'bathtub' ? arrivalBathtub(hRel, channel) : arrivalConnected(grid, hRel, channel);
}

/** Direct definition of the connected model for one rise (BFS from the channel). Reference implementation. */
export function floodBFS(grid: Grid, hRel: Float32Array, channel: Uint8Array, rise: number, neighbours = N8): Uint8Array {
  const { nx, ny } = grid;
  const n = nx * ny;
  const wet = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < n; k++)
    if (channel[k]) {
      wet[k] = 1;
      queue[tail++] = k;
    }
  while (head < tail) {
    const k = queue[head++];
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of neighbours) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const kk = jj * nx + ii;
      if (wet[kk] || !(hRel[kk] < rise)) continue;
      wet[kk] = 1;
      queue[tail++] = kk;
    }
  }
  return wet;
}

/** Flood mask from arrival: flooded <=> arrival < rise. */
export function floodedMask(arrival: Float32Array, rise: number, out = new Uint8Array(arrival.length)): Uint8Array {
  for (let k = 0; k < arrival.length; k++) out[k] = arrival[k] < rise ? 1 : 0;
  return out;
}

/** Water depth (m); 0 where dry. Channel cells get max(rise - hRel, 0). */
export function depthGrid(hRel: Float32Array, arrival: Float32Array, rise: number, out = new Float32Array(hRel.length)) {
  for (let k = 0; k < hRel.length; k++) out[k] = arrival[k] < rise ? Math.max(rise - hRel[k], 0) : 0;
  return out;
}
