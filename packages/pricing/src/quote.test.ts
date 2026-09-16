import { describe, expect, it } from 'vitest';
import {
  DISCOUNT_FLOOR_WITHOUT_SIGNOFF,
  ENTERPRISE_LOCATION_THRESHOLD,
  ENTERPRISE_PROVIDER_THRESHOLD,
  PRICE_BOOK_VERSION,
  assignTier,
  canQuote,
  quote,
  type QuoteResult,
  type TierQuote,
} from './index.js';

/** Narrow to the priced branch, failing loudly if it is the refusal branch. */
function priced(result: QuoteResult): Extract<QuoteResult, { kind: 'quote' }> {
  if (result.kind !== 'quote') {
    throw new Error(`expected a quote, got ${result.kind}`);
  }
  return result;
}

function optionFor(result: QuoteResult, tier: string): TierQuote {
  const option = priced(result).options.find((o) => o.tier === tier);
  if (!option) throw new Error(`no option for tier ${tier}`);
  return option;
}

const plan = (option: TierQuote, name: string) => {
  const found = option.plans.find((p) => p.plan === name);
  if (!found) throw new Error(`plan ${name} not present on ${option.tier}`);
  return found;
};

// ═══════════════════════════════════════════════════════════════════════════
describe('tier assignment', () => {
  it('offers BOTH Micro and Starter for a single-provider, single-location clinic', () => {
    // The docs genuinely do not resolve this; the Rate Card settles it by
    // judgment. Encoding one answer would invent a rule the business lacks.
    const { candidates, requiresDiscoveryCall } = assignTier({ providers: 1, locations: 1 });
    expect(candidates).toEqual(['micro', 'starter']);
    expect(requiresDiscoveryCall).toBe(false);
  });

  it('lists Starter first when patient count exceeds the Micro guide', () => {
    const { candidates, rationale } = assignTier({ providers: 1, locations: 1, patients: 6_000 });
    expect(candidates).toEqual(['starter', 'micro']);
    expect(rationale.join(' ')).toMatch(/exceeds the Micro guide/);
  });

  it('keeps Micro first when patient count is within its guide', () => {
    expect(assignTier({ providers: 1, locations: 1, patients: 2_000 }).candidates).toEqual([
      'micro',
      'starter',
    ]);
  });

  it('assigns Starter for exactly 2 providers', () => {
    expect(assignTier({ providers: 2, locations: 1 }).candidates).toEqual(['starter']);
  });

  it('assigns Professional from 3 providers', () => {
    expect(assignTier({ providers: 3, locations: 1 }).candidates).toEqual(['professional']);
  });

  it('escalates on LOCATION count even when providers are few', () => {
    // A 2-provider practice across 6 sites is a Professional engagement.
    const { candidates, rationale } = assignTier({ providers: 2, locations: 6 });
    expect(candidates).toEqual(['professional']);
    expect(rationale.join(' ')).toMatch(/location count governs/);
  });

  it('rejects non-positive or fractional counts', () => {
    expect(() => assignTier({ providers: 0, locations: 1 })).toThrow(RangeError);
    expect(() => assignTier({ providers: 1, locations: 0 })).toThrow(RangeError);
    expect(() => assignTier({ providers: 2.5, locations: 1 })).toThrow(RangeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the Enterprise boundary at exactly 15 providers', () => {
  // The approved docs contradict themselves here: the tier table says "15+ =
  // Enterprise" while the pricing rule says "once a client PASSES 15". The user
  // resolved it as >= 15. These tests pin that decision so a future edit to the
  // constant is a deliberate, visible change.
  it('treats 14 providers as Professional', () => {
    expect(assignTier({ providers: 14, locations: 1 }).candidates).toEqual(['professional']);
  });

  it('treats exactly 15 providers as Enterprise', () => {
    expect(ENTERPRISE_PROVIDER_THRESHOLD).toBe(15);
    const { candidates, requiresDiscoveryCall } = assignTier({ providers: 15, locations: 1 });
    expect(candidates).toEqual(['enterprise']);
    expect(requiresDiscoveryCall).toBe(true);
  });

  it('treats exactly 10 locations as Enterprise', () => {
    expect(ENTERPRISE_LOCATION_THRESHOLD).toBe(10);
    expect(assignTier({ providers: 4, locations: 10 }).candidates).toEqual(['enterprise']);
  });

  it('treats 9 locations as Professional', () => {
    expect(assignTier({ providers: 4, locations: 9 }).candidates).toEqual(['professional']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Enterprise is never auto-priced', () => {
  it('refuses to quote and returns no price fields at all', () => {
    const result = quote({ providers: 20, locations: 3 });
    expect(result.kind).toBe('requires-discovery-call');
    if (result.kind !== 'requires-discovery-call') return;

    expect(result.reason).toMatch(/discovery call/i);
    // The refusal branch must not carry anything quotable to a client.
    expect(result).not.toHaveProperty('options');
    // The guide range is explicitly internal, not a quote.
    expect(result.internalGuideRange?.min.amount).toBe(150_000);
    expect(result.internalGuideRange?.max.amount).toBe(450_000);
  });

  it('refuses even when a support plan is requested explicitly', () => {
    expect(quote({ providers: 30, locations: 12, supportPlan: 'fullManaged' }).kind).toBe(
      'requires-discovery-call',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('setup pricing', () => {
  it('prices Micro and Starter at their flat figures', () => {
    const result = quote({ providers: 1, locations: 1 });
    expect(optionFor(result, 'micro').setup.listTotal.amount).toBe(7_500);
    expect(optionFor(result, 'starter').setup.listTotal.amount).toBe(15_000);
  });

  it('charges no extras inside the Professional base scope (8 providers, 4 locations)', () => {
    const option = optionFor(quote({ providers: 8, locations: 4 }), 'professional');
    expect(option.setup.extraProviders.count).toBe(0);
    expect(option.setup.extraLocations.count).toBe(0);
    expect(option.setup.listTotal.amount).toBe(55_000);
  });

  it('applies the Professional per-unit formula beyond base scope', () => {
    // 10 providers = 2 extra; 6 locations = 2 extra
    // 55,000 + 2*2,000 + 2*3,000 = 65,000
    const option = optionFor(quote({ providers: 10, locations: 6 }), 'professional');
    expect(option.setup.extraProviders.count).toBe(2);
    expect(option.setup.extraLocations.count).toBe(2);
    expect(option.setup.listTotal.amount).toBe(65_000);
  });

  it('prices the top of the Professional range (14 providers, 9 locations)', () => {
    // 55,000 + 6*2,000 + 5*3,000 = 82,000
    const option = optionFor(quote({ providers: 14, locations: 9 }), 'professional');
    expect(option.setup.listTotal.amount).toBe(82_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('support plan eligibility', () => {
  it('offers all three plans on Micro, with the mandatory check-up on T&WA', () => {
    const option = optionFor(quote({ providers: 1, locations: 1 }), 'micro');
    expect(option.plans.map((p) => p.plan).sort()).toEqual([
      'essentials',
      'fullManaged',
      'trainAndWalkAway',
    ]);
    expect(option.ineligiblePlans).toHaveLength(0);

    const twa = plan(option, 'trainAndWalkAway');
    expect(twa.monthlyListTotal.amount).toBe(0);
    // "Never sold as pay once and never pay again."
    expect(twa.annualCheckup.amount).toBe(2_000);
    expect(plan(option, 'essentials').monthlyListTotal.amount).toBe(1_800);
    expect(plan(option, 'fullManaged').monthlyListTotal.amount).toBe(3_400);
  });

  it('uses the higher Starter check-up', () => {
    const option = optionFor(quote({ providers: 2, locations: 1 }), 'starter');
    expect(plan(option, 'trainAndWalkAway').annualCheckup.amount).toBe(3_500);
    expect(plan(option, 'fullManaged').monthlyListTotal.amount).toBe(4_900);
  });

  it('REFUSES Train & Walk Away on Professional, with a reason', () => {
    const option = optionFor(quote({ providers: 5, locations: 2 }), 'professional');
    expect(option.plans.some((p) => p.plan === 'trainAndWalkAway')).toBe(false);
    const refused = option.ineligiblePlans.find((p) => p.plan === 'trainAndWalkAway');
    expect(refused?.reason).toMatch(/cannot choose Train & Walk Away/i);
  });

  it('applies per-unit monthly scaling on Professional', () => {
    // 10 providers (2 extra), 6 locations (2 extra)
    // Essentials:   9,500 + 2*700  + 2*900  = 12,700
    // FullManaged: 18,000 + 2*1300 + 2*1700 = 24,000
    const option = optionFor(quote({ providers: 10, locations: 6 }), 'professional');
    expect(plan(option, 'essentials').monthlyListTotal.amount).toBe(12_700);
    expect(plan(option, 'fullManaged').monthlyListTotal.amount).toBe(24_000);
  });

  it('never returns a priceable plan for a tier that does not offer it', () => {
    // Exhaustive sweep: every offered plan must be genuinely offered, and every
    // refusal must carry a reason. Guards against a catalog edit that makes an
    // ineligible combination quotable.
    for (const [providers, locations] of [
      [1, 1],
      [2, 1],
      [5, 2],
      [14, 9],
    ] as const) {
      const result = priced(quote({ providers, locations }));
      for (const option of result.options) {
        for (const refusal of option.ineligiblePlans) {
          expect(refusal.reason.length).toBeGreaterThan(10);
          expect(option.plans.some((p) => p.plan === refusal.plan)).toBe(false);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('discount floor', () => {
  it('does not require sign-off at list price', () => {
    const result = priced(quote({ providers: 5, locations: 2 }));
    expect(result.discount.priceFactor).toBe(1);
    expect(result.discount.requiresExecutiveSignOff).toBe(false);
  });

  it('does not require sign-off exactly at the 90% floor', () => {
    const result = priced(quote({ providers: 5, locations: 2, priceFactor: 0.9 }));
    expect(DISCOUNT_FLOOR_WITHOUT_SIGNOFF).toBe(0.9);
    expect(result.discount.requiresExecutiveSignOff).toBe(false);
  });

  it('REQUIRES sign-off just below the floor', () => {
    const result = priced(quote({ providers: 5, locations: 2, priceFactor: 0.899 }));
    expect(result.discount.requiresExecutiveSignOff).toBe(true);
    expect(result.discount.note).toMatch(/reducing included scope/i);
  });

  it('applies the factor to setup and monthly figures', () => {
    const option = optionFor(quote({ providers: 5, locations: 2, priceFactor: 0.9 }), 'professional');
    expect(option.setup.listTotal.amount).toBe(55_000);
    expect(option.setup.quotedTotal.amount).toBe(49_500);
    expect(plan(option, 'fullManaged').monthlyQuotedTotal.amount).toBe(16_200);
  });

  it('does NOT discount the mandatory annual check-up', () => {
    // The check-up is a safety activity, not a commercial lever.
    const option = optionFor(quote({ providers: 1, locations: 1, priceFactor: 0.5 }), 'micro');
    expect(plan(option, 'trainAndWalkAway').annualCheckup.amount).toBe(2_000);
  });

  it('rejects pricing above list, and zero or negative factors', () => {
    for (const priceFactor of [1.1, 0, -0.5]) {
      expect(() => quote({ providers: 5, locations: 2, priceFactor })).toThrow(RangeError);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('first-year total', () => {
  it('sums quoted setup, twelve months, and the check-up', () => {
    const option = optionFor(quote({ providers: 1, locations: 1 }), 'micro');
    const twa = plan(option, 'trainAndWalkAway');
    // 7,500 setup + 0 monthly + 2,000 check-up
    expect(twa.firstYearQuotedTotal.amount).toBe(9_500);

    const managed = plan(option, 'fullManaged');
    // 7,500 + 3,400*12 = 48,300
    expect(managed.firstYearQuotedTotal.amount).toBe(48_300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('canQuote refuses band-derived counts', () => {
  it('refuses when counts are unconfirmed', () => {
    const result = canQuote({ providerCount: 5, locationCount: 2, countsConfirmed: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/band spans more than one pricing tier/);
  });

  it('refuses when an exact count is missing', () => {
    expect(canQuote({ providerCount: null, locationCount: 2, countsConfirmed: true }).ok).toBe(false);
  });

  it('allows when both counts are confirmed', () => {
    expect(canQuote({ providerCount: 5, locationCount: 2, countsConfirmed: true }).ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('provenance', () => {
  it('stamps the price book version on both result shapes', () => {
    expect(priced(quote({ providers: 1, locations: 1 })).priceBookVersion).toBe(PRICE_BOOK_VERSION);
    expect(quote({ providers: 20, locations: 1 }).priceBookVersion).toBe(PRICE_BOOK_VERSION);
  });

  it('lists the costs the client always pays separately', () => {
    const result = priced(quote({ providers: 1, locations: 1 }));
    expect(result.clientPaysSeparately.join(' ')).toMatch(/AWS cloud usage fees/);
    expect(result.clientPaysSeparately.length).toBeGreaterThanOrEqual(7);
  });
});
