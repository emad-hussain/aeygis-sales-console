import {
  ENTERPRISE_LOCATION_THRESHOLD,
  ENTERPRISE_PROVIDER_THRESHOLD,
  TIER_SCOPE,
  type Tier,
} from './catalog.js';

/**
 * Tier assignment from exact provider and location counts.
 *
 * KEY DESIGN POINT: this returns a LIST of candidate tiers, not a single tier.
 *
 * The approved docs do not resolve every input to one tier. Micro is "1 provider,
 * 1 location, up to about 3,000 patients" and Starter is "1-2 providers, 1
 * location, up to about 10,000 patients" — so a single-provider, single-location
 * clinic legitimately matches both, and the Rate Card resolves it by human
 * judgment, not formula:
 *
 *   "Only offer Micro to a genuinely tiny, one-provider clinic. It exists to win
 *    the deal — don't try to upsell them into Starter right away."
 *
 * Confirmed with the user: present both and let staff choose. Encoding a single
 * answer would be inventing a rule the business does not have.
 */

export interface TierInput {
  readonly providers: number;
  readonly locations: number;
  /** Optional. Used only to hint which of Micro/Starter fits better. */
  readonly patients?: number | undefined;
}

export interface TierAssignment {
  /** Candidate tiers, most-likely first. Length > 1 means staff must choose. */
  readonly candidates: readonly Tier[];
  /** True when the counts force a custom Enterprise quote. */
  readonly requiresDiscoveryCall: boolean;
  /** Human-readable justification, safe to show staff (not the client). */
  readonly rationale: readonly string[];
}

function tierFromProviders(providers: number): Tier {
  if (providers >= ENTERPRISE_PROVIDER_THRESHOLD) return 'enterprise';
  if (providers >= TIER_SCOPE.professional.minProviders) return 'professional';
  if (providers === 2) return 'starter';
  return 'micro';
}

function tierFromLocations(locations: number): Tier {
  if (locations >= ENTERPRISE_LOCATION_THRESHOLD) return 'enterprise';
  // Micro and Starter are both single-location. More than one location pushes a
  // clinic into Professional regardless of how few providers it has.
  if (locations > TIER_SCOPE.starter.baseLocations) return 'professional';
  return 'micro';
}

const TIER_RANK: Readonly<Record<Tier, number>> = {
  micro: 0,
  starter: 1,
  professional: 2,
  enterprise: 3,
};

function higher(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function assignTier(input: TierInput): TierAssignment {
  const { providers, locations, patients } = input;
  const rationale: string[] = [];

  if (!Number.isInteger(providers) || providers < 1) {
    throw new RangeError(`providers must be a positive integer, received ${providers}`);
  }
  if (!Number.isInteger(locations) || locations < 1) {
    throw new RangeError(`locations must be a positive integer, received ${locations}`);
  }

  const byProviders = tierFromProviders(providers);
  const byLocations = tierFromLocations(locations);
  // Scale is set by whichever dimension is larger — a 2-provider clinic across
  // 6 sites is a Professional engagement, not a Starter one.
  const base = higher(byProviders, byLocations);

  rationale.push(`${providers} provider(s) indicates ${byProviders}`);
  rationale.push(`${locations} location(s) indicates ${byLocations}`);
  if (base !== byProviders) {
    rationale.push(`location count governs: escalated to ${base}`);
  }

  if (base === 'enterprise') {
    const trigger =
      providers >= ENTERPRISE_PROVIDER_THRESHOLD
        ? `${providers} providers reaches the ${ENTERPRISE_PROVIDER_THRESHOLD}-provider Enterprise threshold`
        : `${locations} locations reaches the ${ENTERPRISE_LOCATION_THRESHOLD}-location Enterprise threshold`;
    rationale.push(trigger);
    rationale.push('Enterprise is never auto-priced — a discovery call is required first');
    return { candidates: ['enterprise'], requiresDiscoveryCall: true, rationale };
  }

  // The Micro/Starter overlap: one provider at one location matches both.
  if (base === 'micro' && providers === 1 && locations === 1) {
    const microGuide = TIER_SCOPE.micro.guidePatients ?? 0;

    if (patients !== undefined && patients > microGuide) {
      rationale.push(
        `~${patients.toLocaleString('en-CA')} patients exceeds the Micro guide of ` +
          `~${microGuide.toLocaleString('en-CA')} — Starter listed first`,
      );
      return { candidates: ['starter', 'micro'], requiresDiscoveryCall: false, rationale };
    }

    rationale.push(
      patients === undefined
        ? 'Patient count not supplied — both Micro and Starter are viable; staff must choose'
        : `~${patients.toLocaleString('en-CA')} patients is within the Micro guide`,
    );
    rationale.push(
      'Rate Card: only offer Micro to a genuinely tiny, one-provider clinic. ' +
        'Lead with Starter for a real 1-2 provider clinic.',
    );
    return { candidates: ['micro', 'starter'], requiresDiscoveryCall: false, rationale };
  }

  return { candidates: [base], requiresDiscoveryCall: false, rationale };
}

/** Units beyond what a tier's base price covers. Never negative. */
export function extraUnits(tier: Tier, input: TierInput): { providers: number; locations: number } {
  const scope = TIER_SCOPE[tier];
  return {
    providers: Math.max(0, input.providers - scope.baseProviders),
    locations: Math.max(0, input.locations - scope.baseLocations),
  };
}
