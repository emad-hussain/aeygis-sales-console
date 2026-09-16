import { describe, expect, it } from 'vitest';
import {
  LOCATION_BANDS,
  PROVIDER_BANDS,
  locationBandIsAmbiguous,
  locationBandToRange,
  providerBandIsAmbiguous,
  providerBandToRange,
} from '@aeygis/domain';
import { assignTier } from './tiers.js';

/**
 * Cross-validates @aeygis/domain's band tables against the real tier boundaries.
 *
 * WHY THIS EXISTS: `@aeygis/domain` is deliberately dependency-free so it can be
 * shared with client code, which means it cannot import the pricing thresholds
 * and instead hardcodes which bands are "ambiguous". That duplication is a drift
 * risk — if someone moves ENTERPRISE_PROVIDER_THRESHOLD, the band table would
 * silently disagree and the intake handler would stop flagging submissions that
 * genuinely need confirmation.
 *
 * These tests derive ambiguity from `assignTier` and assert the hardcoded tables
 * match. They fail if either side moves without the other.
 */

/**
 * A band needs an exact count when its endpoints do not yield the SAME tier
 * candidates — because a different candidate set means a different price.
 *
 * Note the definition deliberately compares the candidate sets verbatim. An
 * earlier version normalised Micro and Starter together, reasoning that their
 * overlap was "not a real tier span". That was wrong and hid the most important
 * case: at 1 provider the candidates are [micro, starter], at 2 they are
 * [starter] alone — a genuine difference, and one worth $7,500 of setup.
 */
function bandNeedsExactCount(
  range: { min: number; max: number | null },
  axis: 'providers' | 'locations',
): boolean {
  const at = (n: number) =>
    (axis === 'providers'
      ? assignTier({ providers: n, locations: 1 }).candidates
      : assignTier({ providers: 1, locations: n }).candidates
    )
      .slice()
      .sort()
      .join(',');

  // An open-ended band is sampled well past every threshold.
  return at(range.min) !== at(range.max ?? 1_000);
}

describe('provider band tables agree with the pricing thresholds', () => {
  it.each(PROVIDER_BANDS)('band %s ambiguity flag matches assignTier', (band) => {
    const spans = bandNeedsExactCount(providerBandToRange(band), 'providers');
    expect(
      providerBandIsAmbiguous(band),
      `band "${band}" needs an exact count = ${spans}, but providerBandIsAmbiguous says ${providerBandIsAmbiguous(band)}. ` +
        'The band table in @aeygis/domain has drifted from the pricing thresholds.',
    ).toBe(spans);
  });

  it('flags "1-2" because 1 provider offers Micro OR Starter while 2 offers only Starter', () => {
    // Worth $7,500 of setup, so the exact count matters.
    expect(providerBandIsAmbiguous('1-2')).toBe(true);
  });

  it('agrees that "3-15" needs confirmation and "15+" does not', () => {
    expect(providerBandIsAmbiguous('3-15')).toBe(true);
    expect(providerBandIsAmbiguous('15+')).toBe(false);
  });
});

describe('location band tables agree with the pricing thresholds', () => {
  it.each(LOCATION_BANDS)('band %s is internally consistent', (band) => {
    const range = locationBandToRange(band);
    expect(range.min).toBeGreaterThanOrEqual(1);
    if (range.max !== null) expect(range.max).toBeGreaterThanOrEqual(range.min);
    // The flag must be a boolean decision, never undefined.
    expect(typeof locationBandIsAmbiguous(band)).toBe('boolean');
  });

  it('flags the band straddling the 10-location Enterprise threshold', () => {
    expect(locationBandIsAmbiguous('5-15')).toBe(true);
  });

  it.each(LOCATION_BANDS)('band %s flag matches assignTier', (band) => {
    const needs = bandNeedsExactCount(locationBandToRange(band), 'locations');
    expect(
      locationBandIsAmbiguous(band),
      `location band "${band}" needs an exact count = ${needs}, but the table says ` +
        `${locationBandIsAmbiguous(band)}.`,
    ).toBe(needs);
  });

  it('does not flag a single location', () => {
    expect(locationBandIsAmbiguous('1')).toBe(false);
  });
});

describe('every band maps to a usable range', () => {
  it('provider bands are ordered and non-overlapping at their lower bounds', () => {
    const mins = PROVIDER_BANDS.map((b) => providerBandToRange(b).min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
  });

  it('the open-ended provider band has no upper bound', () => {
    expect(providerBandToRange('15+').max).toBeNull();
  });
});
