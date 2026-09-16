import { describe, expect, it } from 'vitest';
import { estimateCurrentAnnualSpend } from './currentSpend.js';
import { DOWNTIME_COST_MIDPOINTS, DOWNTIME_HOUR_MIDPOINTS } from './assessment.js';

/**
 * The client's own reported spending. Arithmetic only — whether it is SHOWN is
 * decided in the payload mapper, and is tested there.
 */

const NOTHING = {
  monthlyItSpend: null,
  annualHardwareEmergency: null,
  downtimeHoursBand: null,
  downtimeCostBand: null,
};

describe('estimateCurrentAnnualSpend', () => {
  it('returns null when the client supplied nothing usable', () => {
    expect(estimateCurrentAnnualSpend(NOTHING)).toBeNull();
  });

  it('adds IT spend, emergency hardware and downtime into one annual figure', () => {
    // Real figures from a seeded clinic, so this pins the actual arithmetic
    // rather than a round number that would hide an ordering mistake.
    const e = estimateCurrentAnnualSpend({
      monthlyItSpend: 11_500,
      annualHardwareEmergency: 60_000,
      downtimeHoursBand: '40to90',
      downtimeCostBand: '2500to5000',
    });
    expect(e).not.toBeNull();
    expect(e?.annualIt).toBe(138_000);
    expect(e?.annualHardware).toBe(60_000);
    expect(e?.downtimeHours).toBe(65);
    expect(e?.spendPerDowntimeHour).toBe(3_750);
    expect(e?.annualDowntime).toBe(243_750);
    expect(e?.annualTotal).toBe(441_750);
  });

  it('uses the SAME midpoints the public form used, not its own numbers', () => {
    const e = estimateCurrentAnnualSpend({
      ...NOTHING,
      downtimeHoursBand: 'over90',
      downtimeCostBand: 'over5000',
    });
    expect(e?.downtimeHours).toBe(DOWNTIME_HOUR_MIDPOINTS.over90);
    expect(e?.spendPerDowntimeHour).toBe(DOWNTIME_COST_MIDPOINTS.over5000);
  });

  it('needs BOTH downtime bands — one alone cannot produce an annual figure', () => {
    const hoursOnly = estimateCurrentAnnualSpend({
      ...NOTHING,
      monthlyItSpend: 100,
      downtimeHoursBand: '40to90',
    });
    expect(hoursOnly?.hasDowntime).toBe(false);
    expect(hoursOnly?.annualDowntime).toBe(0);

    const spendOnly = estimateCurrentAnnualSpend({
      ...NOTHING,
      monthlyItSpend: 100,
      downtimeCostBand: '2500to5000',
    });
    expect(spendOnly?.hasDowntime).toBe(false);
    expect(spendOnly?.annualDowntime).toBe(0);
  });

  it('a missing component counts as zero, which UNDERSTATES current spend', () => {
    // The safe direction: it can only make the comparison less flattering to
    // us, never more. Asserted so a future "helpful" default cannot invert it.
    const partial = estimateCurrentAnnualSpend({ ...NOTHING, monthlyItSpend: 1_000 });
    expect(partial?.annualTotal).toBe(12_000);
    expect(partial?.hasHardware).toBe(false);
    expect(partial?.hasDowntime).toBe(false);
  });

  it('ignores zero, negative and non-finite figures rather than trusting them', () => {
    expect(estimateCurrentAnnualSpend({ ...NOTHING, monthlyItSpend: 0 })).toBeNull();
    expect(estimateCurrentAnnualSpend({ ...NOTHING, monthlyItSpend: -500 })).toBeNull();
    expect(estimateCurrentAnnualSpend({ ...NOTHING, monthlyItSpend: Number.NaN })).toBeNull();
  });

  it('ignores an unrecognised band instead of guessing a midpoint', () => {
    const e = estimateCurrentAnnualSpend({
      ...NOTHING,
      monthlyItSpend: 1_000,
      downtimeHoursBand: 'made-up',
      downtimeCostBand: '2500to5000',
    });
    expect(e?.hasDowntime).toBe(false);
  });
});
