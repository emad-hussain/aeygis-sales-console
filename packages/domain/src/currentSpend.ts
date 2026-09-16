/**
 * What the clinic spends on IT today, estimated from its OWN answers.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHOSE MONEY THIS IS
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything here describes the CLIENT's spending, taken from figures the
 * client typed into the public form. None of it is Aeygis cost, margin, or
 * rate-card data, which is why it may appear in a client document at all.
 *
 * NOTE ON NAMING: the client-safety guard rejects any payload key matching
 * /cost|margin|competitor|hourly|gross|cogs|internal|floor|payroll/. That is
 * deliberate and is not to be weakened, so every field below says "spend"
 * rather than "cost" — including where "cost" would read more naturally.
 *
 * The band midpoints come from `assessment.ts`, which carried them over from
 * the live form's own constants specifically so our arithmetic cannot silently
 * disagree with the indicative figure the prospect already saw on screen.
 */

import {
  DOWNTIME_COST_MIDPOINTS,
  DOWNTIME_HOUR_MIDPOINTS,
  DOWNTIME_COST_BANDS,
  DOWNTIME_HOUR_BANDS,
  isOneOf,
} from './assessment.js';

export interface CurrentSpendInputs {
  readonly monthlyItSpend: number | null | undefined;
  readonly annualHardwareEmergency: number | null | undefined;
  readonly downtimeHoursBand: string | null | undefined;
  readonly downtimeCostBand: string | null | undefined;
}

export interface CurrentSpendEstimate {
  readonly annualIt: number;
  readonly annualHardware: number;
  readonly downtimeHours: number;
  readonly spendPerDowntimeHour: number;
  readonly annualDowntime: number;
  readonly annualTotal: number;
  /**
   * Which components the client actually supplied. A missing component
   * contributes zero, which UNDERSTATES their current spend — the safe
   * direction, since it can only make the comparison less flattering to us,
   * never more. The renderer uses these flags to say what the figure covers
   * instead of implying it covers everything.
   */
  readonly hasIt: boolean;
  readonly hasHardware: boolean;
  readonly hasDowntime: boolean;
}

const positive = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * Returns null when the client supplied nothing usable — there is no estimate
 * to make, and inventing one from defaults would be fabrication.
 */
export function estimateCurrentAnnualSpend(
  inputs: CurrentSpendInputs,
): CurrentSpendEstimate | null {
  const monthlyIt = positive(inputs.monthlyItSpend);
  const annualIt = monthlyIt * 12;
  const annualHardware = positive(inputs.annualHardwareEmergency);

  const hoursBand = isOneOf(DOWNTIME_HOUR_BANDS, inputs.downtimeHoursBand)
    ? inputs.downtimeHoursBand
    : null;
  const spendBand = isOneOf(DOWNTIME_COST_BANDS, inputs.downtimeCostBand)
    ? inputs.downtimeCostBand
    : null;

  // Both halves are required: hours alone or dollars-per-hour alone cannot
  // produce an annual figure, and assuming the missing half would be invention.
  const hasDowntime = hoursBand !== null && spendBand !== null;
  const downtimeHours = hoursBand === null ? 0 : DOWNTIME_HOUR_MIDPOINTS[hoursBand];
  const spendPerDowntimeHour = spendBand === null ? 0 : DOWNTIME_COST_MIDPOINTS[spendBand];
  const annualDowntime = hasDowntime ? downtimeHours * spendPerDowntimeHour : 0;

  const hasIt = annualIt > 0;
  const hasHardware = annualHardware > 0;
  if (!hasIt && !hasHardware && !hasDowntime) return null;

  return {
    annualIt,
    annualHardware,
    downtimeHours,
    spendPerDowntimeHour,
    annualDowntime,
    annualTotal: annualIt + annualHardware + annualDowntime,
    hasIt,
    hasHardware,
    hasDowntime,
  };
}
