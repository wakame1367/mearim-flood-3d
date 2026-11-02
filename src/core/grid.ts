/**
 * Regular raster grid in local metres. Row 0 is the northern edge, column 0 the western edge.
 * Cell (i, j) centre: x = -width/2 + (i + 0.5) * cell, y = height/2 - (j + 0.5) * cell
 * (x = east, y = north, origin at the grid centre).
 */
export interface Grid {
  nx: number;
  ny: number;
  cell: number;
}

export const cellX = (g: Grid, i: number) => -g.nx * g.cell * 0.5 + (i + 0.5) * g.cell;
export const cellY = (g: Grid, j: number) => g.ny * g.cell * 0.5 - (j + 0.5) * g.cell;

/** Continuous grid coordinates (fractional column/row of cell centres) for a local point. */
export function toGridCoords(g: Grid, x: number, y: number): [number, number] {
  return [(x + g.nx * g.cell * 0.5) / g.cell - 0.5, (g.ny * g.cell * 0.5 - y) / g.cell - 0.5];
}

/** Index of the cell containing the local point, or -1 outside the grid. */
export function cellIndexAt(g: Grid, x: number, y: number): number {
  const i = Math.floor((x + g.nx * g.cell * 0.5) / g.cell);
  const j = Math.floor((g.ny * g.cell * 0.5 - y) / g.cell);
  return i < 0 || j < 0 || i >= g.nx || j >= g.ny ? -1 : j * g.nx + i;
}

/** Bilinear sample at a local point (clamped to the grid). */
export function sampleBilinear(g: Grid, a: ArrayLike<number>, x: number, y: number): number {
  const [fx, fy] = toGridCoords(g, x, y);
  const i0 = Math.min(Math.max(Math.floor(fx), 0), g.nx - 2);
  const j0 = Math.min(Math.max(Math.floor(fy), 0), g.ny - 2);
  const tx = Math.min(Math.max(fx - i0, 0), 1);
  const ty = Math.min(Math.max(fy - j0, 0), 1);
  const k = j0 * g.nx + i0;
  return (
    a[k] * (1 - tx) * (1 - ty) + a[k + 1] * tx * (1 - ty) + a[k + g.nx] * (1 - tx) * ty + a[k + g.nx + 1] * tx * ty
  );
}

/**
 * Coarsen a grid by an integer factor (block mean). Used to study DEM-resolution sensitivity:
 * 30 m -> 60 m / 90 m / 120 m. Partial blocks at the edges are averaged over the cells they contain.
 */
export function coarsenMean(g: Grid, a: ArrayLike<number>, f: number): { grid: Grid; data: Float32Array } {
  const nx = Math.ceil(g.nx / f);
  const ny = Math.ceil(g.ny / f);
  const out = new Float32Array(nx * ny);
  const cnt = new Uint16Array(nx * ny);
  for (let j = 0; j < g.ny; j++) {
    const jj = Math.floor(j / f);
    for (let i = 0; i < g.nx; i++) {
      const k = jj * nx + Math.floor(i / f);
      out[k] += a[j * g.nx + i];
      cnt[k]++;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] /= cnt[k];
  return { grid: { nx, ny, cell: g.cell * f }, data: out };
}

/** Coarsen a mask: a coarse cell is set if any fine cell equals `value` (keeps thin rivers connected). */
export function coarsenAny(g: Grid, a: ArrayLike<number>, f: number, value = 1): Uint8Array {
  const nx = Math.ceil(g.nx / f);
  const ny = Math.ceil(g.ny / f);
  const out = new Uint8Array(nx * ny);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) if (a[j * g.nx + i] === value) out[Math.floor(j / f) * nx + Math.floor(i / f)] = 1;
  return out;
}

/** Coarsen a categorical raster by majority vote (ties -> lower code). */
export function coarsenMode(g: Grid, a: ArrayLike<number>, f: number): Uint8Array {
  const nx = Math.ceil(g.nx / f);
  const ny = Math.ceil(g.ny / f);
  const out = new Uint8Array(nx * ny);
  const hist = new Map<number, number>();
  for (let jj = 0; jj < ny; jj++)
    for (let ii = 0; ii < nx; ii++) {
      hist.clear();
      for (let j = jj * f; j < Math.min(g.ny, (jj + 1) * f); j++)
        for (let i = ii * f; i < Math.min(g.nx, (ii + 1) * f); i++) {
          const v = a[j * g.nx + i];
          hist.set(v, (hist.get(v) ?? 0) + 1);
        }
      let best = 0;
      let bc = -1;
      for (const [v, c] of hist) if (c > bc || (c === bc && v < best)) [best, bc] = [v, c];
      out[jj * nx + ii] = best;
    }
  return out;
}
