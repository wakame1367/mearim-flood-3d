import type { Grid } from './grid';
import type { RawBuilding, RawRoad } from './impact';

export interface DemMeta {
  file: string;
  zrefProfile: string;
  zrefHand: string;
  zMin: number;
  zMax: number;
  riverZAtGauge: number;
  riverDrop: number;
  riverLength: number;
  profile: { chain: number[]; raw: number[]; z: number[]; x: number[]; y: number[]; gaugeChain: number };
  handPercentiles: Record<string, number>;
}

export interface StageWindow {
  median: number;
  p10: number;
  p90: number;
  n: number;
}

/** Precomputed 2D-model depth frames (manifest v2). */
export interface SimScenario {
  id: string;
  type: 'simulation' | 'replay' | 'envelope';
  name: string;
  solver?: string;
  dtSeconds: number;
  timeBase: 'relative' | 'absolute';
  unit: 'mm' | 'cm' | 'm';
  maxDepth_m?: number;
  frames: string[];
  note?: string;
}

export interface Manifest {
  version: number;
  region?: string;
  name?: string;
  scenarios?: SimScenario[];
  crs: string;
  cell: number;
  nx: number;
  ny: number;
  originUTM: { x0: number; y1: number };
  centerUTM: { x: number; y: number };
  bboxLL: { west: number; south: number; east: number; north: number };
  dems: Record<string, DemMeta>;
  demLabels: Record<string, string>;
  rasters: { channel: string; drainage: string; town: string; susc: string };
  towns: { id: number; name: string }[];
  gauge: {
    code: string;
    name: string;
    lat: number;
    lon: number;
    x: number; // snapped to the river centre line
    y: number;
    xAna: number; // as published by ANA (0.01 deg precision)
    yAna: number;
    snapDistance: number;
    anaInventoryAltitude: number;
  } | null;
  stage: {
    period: [string, string];
    all: { median: number; p95: number; max: number };
    tandemx_2011_2014: StageWindow | null;
    srtm_feb2000: StageWindow | null;
    annual_max: Record<string, { stage_m: number; date: string; consistency: string }>;
    events: Record<string, [string, number][]>;
  } | null;
  sources: Record<string, unknown>;
}

export interface WaterLayer {
  river: { outer: number[][]; inner: number[][] }[];
  lakes: { outer: number[][]; inner: number[][] }[];
  streams: number[][];
  centerline: number[];
}

export interface Poi {
  k: string;
  n: string | null;
  x: number;
  y: number;
}

export interface DemLayers {
  z: Float32Array;
  zrefProfile: Float32Array;
  zrefHand: Float32Array;
}

export interface Dataset {
  manifest: Manifest;
  grid: Grid;
  dems: Record<string, DemLayers>;
  channel: Uint8Array;
  drainage: Uint8Array;
  town: Uint8Array;
  susc: Uint8Array;
  buildings: RawBuilding[];
  roads: RawRoad[];
  water: WaterLayer;
  pois: Poi[];
}

export interface DataIO {
  bin(name: string): Promise<ArrayBuffer>;
  json<T>(name: string): Promise<T>;
}

export async function loadDataset(io: DataIO): Promise<Dataset> {
  const manifest = await io.json<Manifest>('manifest.json');
  const grid: Grid = { nx: manifest.nx, ny: manifest.ny, cell: manifest.cell };
  const n = grid.nx * grid.ny;
  const f32 = async (name: string) => {
    const a = new Float32Array(await io.bin(name));
    if (a.length !== n) throw new Error(`${name}: expected ${n} cells, got ${a.length}`);
    return a;
  };
  const u8 = async (name: string) => {
    const a = new Uint8Array(await io.bin(name));
    if (a.length !== n) throw new Error(`${name}: expected ${n} cells, got ${a.length}`);
    return a;
  };
  const dems: Record<string, DemLayers> = {};
  await Promise.all(
    Object.entries(manifest.dems).map(async ([k, m]) => {
      const [z, zrefProfile, zrefHand] = await Promise.all([f32(m.file), f32(m.zrefProfile), f32(m.zrefHand)]);
      dems[k] = { z, zrefProfile, zrefHand };
    }),
  );
  const [channel, drainage, town, susc, buildings, roads, water, pois] = await Promise.all([
    u8(manifest.rasters.channel),
    u8(manifest.rasters.drainage),
    u8(manifest.rasters.town),
    u8(manifest.rasters.susc),
    io.json<RawBuilding[]>('buildings.json'),
    io.json<RawRoad[]>('roads.json'),
    io.json<WaterLayer>('water.json'),
    io.json<Poi[]>('pois.json'),
  ]);
  return { manifest, grid, dems, channel, drainage, town, susc, buildings, roads, water, pois };
}

/** Browser loader (Vite serves public/data at /data). */
export const fetchIO = (base = `${import.meta.env?.BASE_URL ?? '/'}data/`): DataIO => ({
  async bin(name) {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.arrayBuffer();
  },
  async json(name) {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  },
});
