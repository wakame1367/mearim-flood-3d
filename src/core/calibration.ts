/**
 * Gauge reading  <->  water-surface elevation.
 *
 * ANA stage ("cota", m) at Pedreiras II (33281000) is measured from the gauge's own zero, not from a
 * vertical datum. The DEM shows the river surface at whatever level it had when the DEM was acquired.
 * We therefore never compare stage with DEM height directly; instead we model
 *
 *     rise         = stage - stageAtDem         (river rise above the DEM-time river surface)
 *     WSE(gauge)   = riverZAtGauge + rise       (in the DEM's vertical datum)
 *     gauge zero   = riverZAtGauge - stageAtDem (implied elevation of the gauge zero, DEM datum)
 *
 * `stageAtDem` is the calibration constant: the gauge reading that corresponds to the DEM's river surface.
 * Defaults are derived from ANA data during the DEM acquisition windows (see manifest.stage), and the user
 * can override it. Its uncertainty (metres) dominates every result; see docs/flood-model.md.
 */
export interface Calibration {
  riverZAtGauge: number; // DEM river-surface elevation at the gauge (m, DEM datum)
  stageAtDem: number; // gauge reading (m) equivalent to the DEM river surface
}

export const riseFromStage = (c: Calibration, stage: number) => stage - c.stageAtDem;
export const stageFromRise = (c: Calibration, rise: number) => rise + c.stageAtDem;
export const wseAtGauge = (c: Calibration, stage: number) => c.riverZAtGauge + riseFromStage(c, stage);
export const gaugeZeroElevation = (c: Calibration) => c.riverZAtGauge - c.stageAtDem;
