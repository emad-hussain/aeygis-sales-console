import {
  CLIENT_PAYS_SEPARATELY,
  CURRENCY,
  DISCOUNT_FLOOR_WITHOUT_SIGNOFF,
  MONTHLY,
  PRICE_BOOK_VERSION,
  SETUP,
  SUPPORT_PLANS,
  SUPPORT_PLAN_LABELS,
  TIER_LABELS,
  type SupportPlan,
  type Tier,
} from './catalog.js';
import { assignTier, extraUnits, type TierInput } from './tiers.js';

/**
 * Produces a quote from exact counts, or refuses.
 *
 * Two refusals are deliberate and must never be softened into a number:
 *
 *   1. ENTERPRISE. "Always send Enterprise clients through a discovery call
 *      first. Never give them a firm price before that call happens."
 *      (Rate Card §4.) The return type has no price fields on that branch, so
 *      an Enterprise price cannot be read out of it even by mistake.
 *
 *   2. UNCONFIRMED COUNTS. The live form supplies bands, and a band cannot
 *      determine a tier. Quoting from a widened range would be guessing at the
 *      client's bill.
 */

export interface QuoteInput extends TierInput {
  /** Restrict output to one plan. Omit to price every eligible plan. */
  readonly supportPlan?: SupportPlan | undefined;
  /**
   * Proposed price as a fraction of list, e.g. 0.85 for a 15% discount.
   * Defaults to 1 (list price).
   */
  readonly priceFactor?: number | undefined;
}

export interface Money {
  readonly amount: number;
  readonly currency: typeof CURRENCY;
}

export interface SetupQuote {
  readonly base: Money;
  readonly extraProviders: { readonly count: number; readonly unit: Money; readonly total: Money };
  readonly extraLocations: { readonly count: number; readonly unit: Money; readonly total: Money };
  readonly listTotal: Money;
  readonly quotedTotal: Money;
}

export interface PlanQuote {
  readonly plan: SupportPlan;
  readonly planLabel: string;
  readonly monthlyListTotal: Money;
  readonly monthlyQuotedTotal: Money;
  /** Mandatory yearly check-up. Train & Walk Away only; 0 elsewhere. */
  readonly annualCheckup: Money;
  /** True when the figure is a starting point requiring a custom quote. */
  readonly customQuote: boolean;
  /** First-year total: setup + 12 months + any check-up. */
  readonly firstYearQuotedTotal: Money;
}

export interface TierQuote {
  readonly tier: Tier;
  readonly tierLabel: string;
  readonly setup: SetupQuote;
  readonly plans: readonly PlanQuote[];
  readonly ineligiblePlans: readonly { readonly plan: SupportPlan; readonly planLabel: string; readonly reason: string }[];
}

export interface DiscountApproval {
  readonly priceFactor: number;
  readonly requiresExecutiveSignOff: boolean;
  readonly floor: number;
  readonly note: string;
}

export type QuoteResult =
  | {
      readonly kind: 'quote';
      readonly priceBookVersion: string;
      /** More than one entry means staff must choose (Micro/Starter overlap). */
      readonly options: readonly TierQuote[];
      readonly discount: DiscountApproval;
      readonly rationale: readonly string[];
      readonly clientPaysSeparately: readonly string[];
    }
  | {
      readonly kind: 'requires-discovery-call';
      readonly priceBookVersion: string;
      readonly tier: 'enterprise';
      readonly reason: string;
      /** Internal guidance only — NOT a quotable figure. */
      readonly internalGuideRange: { readonly min: Money; readonly max: Money } | null;
      readonly rationale: readonly string[];
    };

const money = (amount: number): Money => ({ amount, currency: CURRENCY });

/** Round to whole cents to keep repeated arithmetic from drifting. */
const round = (n: number): number => Math.round(n * 100) / 100;

function priceSetup(tier: Tier, input: TierInput, priceFactor: number): SetupQuote {
  const pricing = SETUP[tier];
  if (pricing.base === null) {
    throw new Error(`setup for ${tier} is custom-quoted and must not be computed`);
  }

  const extras = extraUnits(tier, input);
  const extraProviderTotal = extras.providers * pricing.perExtraProvider;
  const extraLocationTotal = extras.locations * pricing.perExtraLocation;
  const listTotal = pricing.base + extraProviderTotal + extraLocationTotal;

  return {
    base: money(pricing.base),
    extraProviders: {
      count: extras.providers,
      unit: money(pricing.perExtraProvider),
      total: money(extraProviderTotal),
    },
    extraLocations: {
      count: extras.locations,
      unit: money(pricing.perExtraLocation),
      total: money(extraLocationTotal),
    },
    listTotal: money(listTotal),
    quotedTotal: money(round(listTotal * priceFactor)),
  };
}

function pricePlans(
  tier: Tier,
  input: TierInput,
  priceFactor: number,
  setupQuoted: number,
  only: SupportPlan | undefined,
): Pick<TierQuote, 'plans' | 'ineligiblePlans'> {
  const extras = extraUnits(tier, input);
  const plans: PlanQuote[] = [];
  const ineligiblePlans: { plan: SupportPlan; planLabel: string; reason: string }[] = [];

  for (const plan of SUPPORT_PLANS) {
    if (only !== undefined && plan !== only) continue;

    const pricing = MONTHLY[tier][plan];

    if (!pricing.offered) {
      ineligiblePlans.push({ plan, planLabel: SUPPORT_PLAN_LABELS[plan], reason: pricing.reason });
      continue;
    }

    const monthlyList =
      pricing.monthlyBase +
      extras.providers * pricing.perExtraProviderMonthly +
      extras.locations * pricing.perExtraLocationMonthly;

    const monthlyQuoted = round(monthlyList * priceFactor);

    plans.push({
      plan,
      planLabel: SUPPORT_PLAN_LABELS[plan],
      monthlyListTotal: money(monthlyList),
      monthlyQuotedTotal: money(monthlyQuoted),
      annualCheckup: money(pricing.annualCheckup),
      customQuote: pricing.customQuote,
      // The check-up is NOT discounted — it is a mandatory safety activity, not
      // a commercial lever. Reducing scope is the sanctioned way to cut price.
      firstYearQuotedTotal: money(round(setupQuoted + monthlyQuoted * 12 + pricing.annualCheckup)),
    });
  }

  return { plans, ineligiblePlans };
}

export function quote(input: QuoteInput): QuoteResult {
  const priceFactor = input.priceFactor ?? 1;

  if (!(priceFactor > 0) || priceFactor > 1) {
    throw new RangeError(
      `priceFactor must be greater than 0 and at most 1 (list price); received ${priceFactor}. ` +
        'Pricing above list is not a supported operation.',
    );
  }

  const assignment = assignTier(input);

  if (assignment.requiresDiscoveryCall) {
    const guide = SETUP.enterprise.guideRange;
    return {
      kind: 'requires-discovery-call',
      priceBookVersion: PRICE_BOOK_VERSION,
      tier: 'enterprise',
      reason:
        'Enterprise engagements are never auto-priced. A discovery call must happen before any ' +
        'figure is shared with the client (Rate Card §4).',
      internalGuideRange: guide ? { min: money(guide.min), max: money(guide.max) } : null,
      rationale: assignment.rationale,
    };
  }

  const discount: DiscountApproval = {
    priceFactor,
    requiresExecutiveSignOff: priceFactor < DISCOUNT_FLOOR_WITHOUT_SIGNOFF,
    floor: DISCOUNT_FLOOR_WITHOUT_SIGNOFF,
    note:
      priceFactor < DISCOUNT_FLOOR_WITHOUT_SIGNOFF
        ? `Quoted at ${(priceFactor * 100).toFixed(1)}% of list, below the ` +
          `${DISCOUNT_FLOOR_WITHOUT_SIGNOFF * 100}% floor. Executive sign-off required. ` +
          'Prefer reducing included scope or dropping a support plan before discounting.'
        : 'Within the standard discount floor; no executive sign-off required.',
  };

  const options = assignment.candidates.map<TierQuote>((tier) => {
    const setup = priceSetup(tier, input, priceFactor);
    const { plans, ineligiblePlans } = pricePlans(
      tier,
      input,
      priceFactor,
      setup.quotedTotal.amount,
      input.supportPlan,
    );
    return { tier, tierLabel: TIER_LABELS[tier], setup, plans, ineligiblePlans };
  });

  return {
    kind: 'quote',
    priceBookVersion: PRICE_BOOK_VERSION,
    options,
    discount,
    rationale: assignment.rationale,
    clientPaysSeparately: CLIENT_PAYS_SEPARATELY,
  };
}

/**
 * Guard for the console: refuses to quote from band-derived counts.
 *
 * The live form supplies bands ("1-2", "3-15"), which cannot determine a tier.
 * Callers must confirm exact integers first. Separated from `quote` so the
 * refusal is explicit at the call site rather than an exception deep inside.
 */
export function canQuote(assessment: {
  providerCount?: number | null;
  locationCount?: number | null;
  countsConfirmed?: boolean | null;
}): { ok: true } | { ok: false; reason: string } {
  if (assessment.countsConfirmed !== true) {
    return {
      ok: false,
      reason:
        'Provider and location counts are not confirmed. The public form collects bands, and a ' +
        'band spans more than one pricing tier. Confirm exact counts before pricing.',
    };
  }
  if (typeof assessment.providerCount !== 'number' || typeof assessment.locationCount !== 'number') {
    return { ok: false, reason: 'Exact providerCount and locationCount are required to price.' };
  }
  return { ok: true };
}
