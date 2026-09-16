/**
 * Band <-> count mapping for assessment intake.
 *
 * WHY THIS FILE EXISTS
 *
 * The live assessment form on health.aeygis.com collects provider and location
 * counts as *bands*, not numbers:
 *
 *   providers: "1-2" | "3-15" | "15+"
 *   locations: "1" | "2-5" | "5-15" | "15+"
 *
 * Those bands cannot determine a pricing tier:
 *
 *   - Micro (1 provider) and Starter (1-2 providers) BOTH fall inside "1-2".
 *   - "3-15" spans the whole of Professional AND touches Enterprise at 15.
 *
 * So the band is not sufficient input for a quote. Two consequences:
 *
 *   1. `Assessment` stores exact integers (`providerCount`, `locationCount`)
 *      as the authoritative values, and the raw band as provenance.
 *   2. When a submission arrives with only a band, we widen it to a range and
 *      mark it `needsConfirmation`. Staff enter the exact figure in the console
 *      before a proposal can be priced. We never silently pick a number.
 *
 * Two GraphQL constraints also apply: enum values cannot contain `-` or begin
 * with a digit, so "1-2" and "15+" cannot be enum members. They are stored as
 * strings validated against these tables instead.
 */

export const PROVIDER_BANDS = ['1-2', '3-15', '15+'] as const;
export const LOCATION_BANDS = ['1', '2-5', '5-15', '15+'] as const;

export type ProviderBand = (typeof PROVIDER_BANDS)[number];
export type LocationBand = (typeof LOCATION_BANDS)[number];

/** An inclusive count range. `max: null` means unbounded. */
export interface CountRange {
  readonly min: number;
  readonly max: number | null;
}

const PROVIDER_RANGES: Readonly<Record<ProviderBand, CountRange>> = {
  '1-2': { min: 1, max: 2 },
  '3-15': { min: 3, max: 15 },
  '15+': { min: 15, max: null },
};

const LOCATION_RANGES: Readonly<Record<LocationBand, CountRange>> = {
  '1': { min: 1, max: 1 },
  '2-5': { min: 2, max: 5 },
  '5-15': { min: 5, max: 15 },
  '15+': { min: 15, max: null },
};

export function isProviderBand(value: unknown): value is ProviderBand {
  return typeof value === 'string' && (PROVIDER_BANDS as readonly string[]).includes(value);
}

export function isLocationBand(value: unknown): value is LocationBand {
  return typeof value === 'string' && (LOCATION_BANDS as readonly string[]).includes(value);
}

export function providerBandToRange(band: ProviderBand): CountRange {
  return PROVIDER_RANGES[band];
}

export function locationBandToRange(band: LocationBand): CountRange {
  return LOCATION_RANGES[band];
}

/**
 * True when a band spans more than one pricing tier, meaning the exact count
 * must be confirmed by staff before the proposal can be priced.
 *
 * Boundaries come from the approved docs and are defined in @aeygis/pricing.
 * They are duplicated as literals here ONLY to keep this package dependency-free;
 * `assertBandBoundariesMatchPricing` in @aeygis/pricing tests that they agree.
 */
export function providerBandIsAmbiguous(band: ProviderBand): boolean {
  // "1-2" straddles Micro (1) and Starter (1-2).
  // "3-15" straddles Professional (3-14) and Enterprise (>=15).
  // "15+" is unambiguously Enterprise.
  return band === '1-2' || band === '3-15';
}

export function locationBandIsAmbiguous(band: LocationBand): boolean {
  // Only "5-15" straddles a tier boundary (the >=10 Enterprise threshold).
  //
  // "15+" is NOT ambiguous: every value in it is Enterprise, which routes to a
  // discovery call rather than a computed price. An earlier version flagged it
  // by symmetry with the provider bands and was wrong — caught by the
  // cross-validation test in @aeygis/pricing.
  return band === '5-15';
}
