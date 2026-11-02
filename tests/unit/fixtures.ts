import type { Grid } from '../../src/core/grid';

/**
 * SYNTHETIC test fixtures (dummy data, not the study area).
 * A small valley: river channel in column 0, ground rising to the east, with an enclosed
 * hollow behind a ridge that must stay dry in the connected model until the ridge is overtopped.
 *
 *   hRel (m above the river reference), 8 x 5 grid, channel = column 0:
 *     0 | 1 2 3 5 2 2 5
 *     0 | 1 2 3 5 2 2 5
 *     0 | 1 2 3 5 2 2 5     <- ridge (5 m) at column 4, hollow (2 m) at columns 5-6
 *     0 | 1 2 3 5 2 2 5
 *     0 | 1 2 3 5 2 2 5
 */
export function valleyFixture() {
  const grid: Grid = { nx: 8, ny: 5, cell: 10 };
  const row = [0, 1, 2, 3, 5, 2, 2, 5];
  const hRel = new Float32Array(grid.nx * grid.ny);
  const channel = new Uint8Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++)
    for (let i = 0; i < grid.nx; i++) {
      hRel[j * grid.nx + i] = row[i];
      channel[j * grid.nx + i] = i === 0 ? 1 : 0;
    }
  return { grid, hRel, channel };
}

/** Deterministic pseudo-random terrain (dummy) for property tests. */
export function randomTerrain(nx: number, ny: number, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const grid: Grid = { nx, ny, cell: 30 };
  const hRel = new Float32Array(nx * ny);
  const channel = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const river = Math.abs(i - nx / 2 - 3 * Math.sin(j / 4)) < 1;
      channel[k] = river ? 1 : 0;
      hRel[k] = river ? 0 : Math.abs(i - nx / 2) * 0.4 + rnd() * 3 - 1;
    }
  return { grid, hRel, channel };
}
