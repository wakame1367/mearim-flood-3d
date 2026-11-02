import { riseFromStage, type Calibration } from './calibration';
import type { Dataset } from './dataset';
import { computeArrival, relativeHeight, type FloodModel } from './flood';
import { coarsenAny, coarsenMean, coarsenMode, type Grid } from './grid';
import {
  computeExposure,
  DEFAULT_THRESHOLDS,
  ImpactIndex,
  prepareBuildings,
  prepareRoads,
  type BuildingSet,
  type Exposure,
  type RoadSegments,
  type Thresholds,
} from './impact';

/**
 * Reference river surface used to turn a single gauge rise into a water surface over every cell:
 *   flat    : one elevation everywhere (= DEM river surface at the gauge) -> classic "bathtub plane"
 *   profile : along-river DEM water-surface profile, each cell takes the value at the nearest centre-line point
 *   hand    : river level at the outlet of the cell's drainage path (priority-flood tree), i.e. HAND
 */
export type RefSurface = 'flat' | 'profile' | 'hand';

export interface ScenarioSettings {
  dem: string;
  ref: RefSurface;
  model: FloodModel;
  coarsen: number; // 1 = native 30 m, 2 = 60 m, ...
  stageAtDem: number;
  thresholds: Thresholds;
}

export function defaultStageAtDem(ds: Dataset, dem: string): number {
  const s = ds.manifest.stage;
  if (dem === 'sgb') return s?.srtm_feb2000?.median ?? 2.5; // SRTM flew 11-22 Feb 2000
  return s?.tandemx_2011_2014?.median ?? s?.all.median ?? 2.5; // cop30 / fabdem: TanDEM-X epoch
}

export class Scenario {
  readonly grid: Grid;
  readonly z: Float32Array;
  readonly zref: Float32Array;
  readonly hRel: Float32Array;
  readonly channel: Uint8Array;
  readonly town: Uint8Array;
  readonly susc: Uint8Array;
  readonly arrival: Float32Array;
  readonly buildings: BuildingSet;
  readonly roads: RoadSegments;
  readonly exposure: Exposure;
  readonly impact: ImpactIndex;
  readonly calibration: Calibration;
  readonly computeMs: number;

  constructor(
    readonly ds: Dataset,
    readonly settings: ScenarioSettings,
  ) {
    const t0 = performance.now();
    const layers = ds.dems[settings.dem];
    if (!layers) throw new Error(`unknown DEM ${settings.dem}`);
    const riverZAtGauge = ds.manifest.dems[settings.dem].riverZAtGauge;
    const flat = new Float32Array(layers.z.length).fill(riverZAtGauge);
    const zref0 = settings.ref === 'flat' ? flat : settings.ref === 'profile' ? layers.zrefProfile : layers.zrefHand;
    const f = Math.max(1, Math.round(settings.coarsen));
    if (f === 1) {
      this.grid = ds.grid;
      this.z = layers.z;
      this.zref = zref0;
      this.channel = ds.channel;
      this.town = ds.town;
      this.susc = ds.susc;
    } else {
      const zc = coarsenMean(ds.grid, layers.z, f);
      this.grid = zc.grid;
      this.z = zc.data;
      this.zref = coarsenMean(ds.grid, zref0, f).data;
      this.channel = coarsenAny(ds.grid, ds.channel, f);
      this.town = coarsenMode(ds.grid, ds.town, f);
      this.susc = coarsenMode(ds.grid, ds.susc, f);
    }
    this.calibration = { riverZAtGauge, stageAtDem: settings.stageAtDem };
    this.hRel = relativeHeight(this.z, this.zref);
    this.arrival = computeArrival(settings.model, this.grid, this.hRel, this.channel);
    this.buildings = prepareBuildings(this.grid, ds.buildings, this.town);
    this.roads = prepareRoads(this.grid, ds.roads, this.town);
    this.exposure = computeExposure(this.buildings, this.roads, this.hRel, this.arrival, settings.thresholds ?? DEFAULT_THRESHOLDS);
    this.impact = new ImpactIndex(this.grid, this.arrival, this.channel, this.town, this.buildings, this.roads, this.exposure);
    this.computeMs = performance.now() - t0;
  }

  rise(stage: number) {
    return riseFromStage(this.calibration, stage);
  }

  /** Agreement of the modelled flood with SGB susceptibility classes >= minClass (mapped, non-channel cells). */
  compareSusceptibility(rise: number, minClass = 3) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let k = 0; k < this.arrival.length; k++) {
      const s = this.susc[k];
      if (s === 255 || this.channel[k]) continue;
      const model = this.arrival[k] < rise;
      const ref = s >= minClass;
      if (model && ref) tp++;
      else if (model) fp++;
      else if (ref) fn++;
    }
    return { iou: tp / Math.max(1, tp + fp + fn), precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), tp, fp, fn };
  }
}
