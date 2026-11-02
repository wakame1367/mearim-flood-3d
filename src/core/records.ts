import type { Scenario } from './scenario';

/**
 * Public flood records used for calibration / validation (see docs/data-sources.md for citations).
 * Stage = Pedreiras gauge reading (m). Impact figures are as reported by the press / Defesa Civil and are
 * not directly "flooded buildings": displaced families != flooded houses, and municipal totals include
 * areas outside the model window. Use them as order-of-magnitude checks only.
 */
export interface FloodRecord {
  id: string;
  date: string;
  stage: number;
  town: 1 | 2;
  households?: number; // reported affected households
  fractionFlooded?: number; // reported share of the town's houses under water
  note: string;
  source: string;
}

export const FLOOD_RECORDS: FloodRecord[] = [
  {
    id: '2024-pedreiras',
    date: '2024-04-20',
    stage: 7.46,
    town: 1,
    households: 190,
    note: 'Pedreiras: 190 families without home (105 in 18 shelters + 85 with relatives); 636 people displaced',
    source: 'G1 Maranhão 2024-04-22; O Imparcial 2024-04-23 (Defesa Civil de Pedreiras)',
  },
  {
    id: '2009-trizidela',
    date: '2009-05-07',
    stage: 9.81,
    town: 2,
    fractionFlooded: 0.8,
    note: 'Trizidela do Vale: ~80% of houses under water, 8,153 displaced of 18.3k inhabitants',
    source: 'Folha de S.Paulo 2009-05-11; BBC Brasil 2009-05-14 (ANA crest 9.81 m on 2009-05-07)',
  },
];

/**
 * Find the calibration constant stageAtDem such that the modelled number of flooded buildings in
 * `record.town` at `record.stage` equals `record.households`. Arrival/exposure do not depend on the
 * calibration, so this is a 1-D search over the rise (bisection on a monotone count).
 */
export function calibrateToRecord(s: Scenario, record: FloodRecord): number | null {
  if (!record.households) return null;
  const count = (rise: number) => s.impact.at(rise, record.town).buildings;
  let lo = -5;
  let hi = 20;
  if (count(hi) < record.households) return null;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (count(mid) >= record.households) hi = mid;
    else lo = mid;
  }
  return +(record.stage - hi).toFixed(2);
}

/** Share of a town's buildings flooded at a stage (for fractionFlooded records). */
export function fractionFlooded(s: Scenario, town: number, stage: number) {
  const st = s.impact.at(s.rise(stage), town);
  return st.buildings / Math.max(1, st.buildingsTotal);
}
