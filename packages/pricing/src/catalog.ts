/**
 * THE PRICE BOOK — client-safe.
 *
 * Every figure here is a LIST price that may appear in a client-facing proposal.
 * Nothing in this file is confidential.
 *
 * Internal delivery cost, margin reasoning, and competitor analysis live in
 * `@aeygis/pricing-internal` and must NEVER be imported into this package.
 * `.dependency-cruiser.cjs` enforces that in CI.
 *
 * SOURCES (all agree; the Rate Card is the most detailed):
 *   docs/Aeygis_Cloud_Migration_Framework.pdf  §5 Pricing Structure, Tiers & Excluded Costs
 *   docs/Aeygis_Cloud_Rate_Card.pdf            §2 Price levels, §3 Monthly support plans
 *   docs/Aeygis_Cloud_Price_List_Compact.pdf
 *   docs/Aeygis_Cloud_Setup_Fees_Only.pdf
 * (in the aeygis-website-source-code repo)
 *
 * All amounts are CAD.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRICE_BOOK_VERSION is stamped into every proposal snapshot. Changing any
 * number below REQUIRES bumping it, because a historical proposal must always
 * be reproducible from the version it was quoted under. Never edit a figure
 * without bumping.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PRICE_BOOK_VERSION = '2026-07-rate-card-v2';

export const CURRENCY = 'CAD' as const;

export const TIERS = ['micro', 'starter', 'professional', 'enterprise'] as const;
export type Tier = (typeof TIERS)[number];

export const SUPPORT_PLANS = ['trainAndWalkAway', 'essentials', 'fullManaged'] as const;
export type SupportPlan = (typeof SUPPORT_PLANS)[number];

export const TIER_LABELS: Readonly<Record<Tier, string>> = {
  micro: 'Micro',
  starter: 'Starter',
  professional: 'Professional',
  enterprise: 'Enterprise',
};

export const SUPPORT_PLAN_LABELS: Readonly<Record<SupportPlan, string>> = {
  trainAndWalkAway: 'Train & Walk Away',
  essentials: 'Essentials',
  fullManaged: 'Full Managed',
};

/* ───────────────────────────── tier boundaries ─────────────────────────────
 * The approved docs contradict themselves at exactly 15 providers: the tier
 * table reads "15+ providers = Enterprise" while the pricing rule reads "once a
 * client PASSES 15 providers... stop using the Professional formula".
 *
 * Resolved by the user: >= 15 providers is Enterprise. Professional is 3-14.
 *
 * The location threshold below is NOT user-stated — the docs give no explicit
 * Enterprise location boundary. It is extended from the providers answer for
 * consistency ("up to 15 providers or 10 locations"). Flagged as an open gap in
 * docs/PROJECT-STATUS.md. Both are single constants so either can be flipped in
 * one line.
 * ------------------------------------------------------------------------- */

export const ENTERPRISE_PROVIDER_THRESHOLD = 15;
export const ENTERPRISE_LOCATION_THRESHOLD = 10;

/**
 * What each tier's BASE price covers. Counts beyond these incur per-unit
 * charges on the Professional tier.
 *
 * Rate Card: "Base price covers 3-8 providers, 1-4 locations." So a Professional
 * client's "extra" units are those beyond 8 providers / 4 locations — NOT beyond
 * the tier's lower bound of 3/1.
 *
 * ✅ CONFIRMED with the user (2026-08-17): extras are counted beyond the BASE
 * SCOPE (8 providers / 4 locations), not beyond the tier minimum (3 / 1).
 * So 10 providers = 2 extra = $55,000 + $4,000, not 7 extra = $55,000 + $14,000.
 *
 * Worth ~$10,000 of setup at 10 providers, which is why it was raised rather
 * than assumed. The source documents never define "extra" explicitly; this
 * reading follows "base price covers 3-8 providers, 1-4 locations".
 */
export const TIER_SCOPE: Readonly<
  Record<Tier, { minProviders: number; maxProviders: number | null; baseProviders: number; baseLocations: number; guidePatients: number | null }>
> = {
  micro: { minProviders: 1, maxProviders: 1, baseProviders: 1, baseLocations: 1, guidePatients: 3_000 },
  starter: { minProviders: 1, maxProviders: 2, baseProviders: 2, baseLocations: 1, guidePatients: 10_000 },
  professional: { minProviders: 3, maxProviders: 14, baseProviders: 8, baseLocations: 4, guidePatients: null },
  enterprise: { minProviders: ENTERPRISE_PROVIDER_THRESHOLD, maxProviders: null, baseProviders: 0, baseLocations: 0, guidePatients: null },
};

/* ───────────────────────────── one-time setup ───────────────────────────── */

export interface SetupPricing {
  /** Fixed base. `null` means custom-quoted only (Enterprise). */
  readonly base: number | null;
  readonly perExtraProvider: number;
  readonly perExtraLocation: number;
  /** Indicative range for custom quotes, for internal guidance only. */
  readonly guideRange?: { readonly min: number; readonly max: number };
}

export const SETUP: Readonly<Record<Tier, SetupPricing>> = {
  micro: { base: 7_500, perExtraProvider: 0, perExtraLocation: 0 },
  starter: { base: 15_000, perExtraProvider: 0, perExtraLocation: 0 },
  professional: { base: 55_000, perExtraProvider: 2_000, perExtraLocation: 3_000 },
  enterprise: { base: null, perExtraProvider: 0, perExtraLocation: 0, guideRange: { min: 150_000, max: 450_000 } },
};

/* ─────────────────────────── monthly support plans ───────────────────────── */

/** A plan a tier does not offer. Modelled explicitly so eligibility is data, not an if-chain. */
export interface PlanNotOffered {
  readonly offered: false;
  readonly reason: string;
}

export interface PlanOffered {
  readonly offered: true;
  readonly monthlyBase: number;
  readonly perExtraProviderMonthly: number;
  readonly perExtraLocationMonthly: number;
  /** Mandatory annual check-up. Train & Walk Away only. */
  readonly annualCheckup: number;
  /** True when the monthly figure is a starting point, not a firm price. */
  readonly customQuote: boolean;
}

export type PlanPricing = PlanOffered | PlanNotOffered;

/**
 * Eligibility is encoded here rather than checked at call time, so an ineligible
 * combination cannot be priced by accident.
 *
 * Framework §5 + Rate Card §3:
 *   "Professional clients cannot choose Train & Walk Away. Enterprise clients
 *    cannot choose Train & Walk Away OR Essentials — Enterprise clients require
 *    Full Managed service only."
 */
export const MONTHLY: Readonly<Record<Tier, Readonly<Record<SupportPlan, PlanPricing>>>> = {
  micro: {
    // "Never sold as pay once and never pay again." The check-up is mandatory.
    trainAndWalkAway: { offered: true, monthlyBase: 0, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 2_000, customQuote: false },
    essentials: { offered: true, monthlyBase: 1_800, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 0, customQuote: false },
    fullManaged: { offered: true, monthlyBase: 3_400, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 0, customQuote: false },
  },
  starter: {
    trainAndWalkAway: { offered: true, monthlyBase: 0, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 3_500, customQuote: false },
    essentials: { offered: true, monthlyBase: 2_600, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 0, customQuote: false },
    fullManaged: { offered: true, monthlyBase: 4_900, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 0, customQuote: false },
  },
  professional: {
    trainAndWalkAway: {
      offered: false,
      reason:
        'Professional clients cannot choose Train & Walk Away. A multi-provider practice cannot realistically go hands-off with its cloud systems.',
    },
    essentials: { offered: true, monthlyBase: 9_500, perExtraProviderMonthly: 700, perExtraLocationMonthly: 900, annualCheckup: 0, customQuote: false },
    fullManaged: { offered: true, monthlyBase: 18_000, perExtraProviderMonthly: 1_300, perExtraLocationMonthly: 1_700, annualCheckup: 0, customQuote: false },
  },
  enterprise: {
    trainAndWalkAway: {
      offered: false,
      reason: 'Enterprise clients require Full Managed service only.',
    },
    essentials: {
      offered: false,
      reason: 'Enterprise clients require Full Managed service only.',
    },
    fullManaged: { offered: true, monthlyBase: 125_000, perExtraProviderMonthly: 0, perExtraLocationMonthly: 0, annualCheckup: 0, customQuote: true },
  },
};

/* ──────────────────────────── commercial rules ───────────────────────────── */

/**
 * Rate Card §4: "Never quote below 90% of the listed price without sign-off from
 * leadership." Expressed as a floor on the fraction of list price.
 */
export const DISCOUNT_FLOOR_WITHOUT_SIGNOFF = 0.9;

/**
 * Framework §6 / Rate Card §4: "Always send Enterprise clients through a
 * discovery call first. Never give them a firm price before that call happens."
 */
export const ENTERPRISE_REQUIRES_DISCOVERY_CALL = true;

/**
 * Framework §5, Rate Card §4. Reproduced verbatim in proposals so the client
 * cannot mistake these for included costs.
 */
export const CLIENT_PAYS_SEPARATELY: readonly string[] = [
  'AWS cloud usage fees (compute, storage, data transfer)',
  'AWS support plan fees (Developer/Business)',
  'Third-party auditor and certifier fees (HITRUST, SOC 2, ISO)',
  'Specialist legal and privacy advice',
  'EMR / PACS vendor licensing or migration fees',
  'Penetration testing by third-party security firms',
  'Endpoint detection and response (EDR) software on local devices',
];
