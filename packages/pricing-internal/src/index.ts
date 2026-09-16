/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  CONFIDENTIAL — INTERNAL USE ONLY                                         ║
 * ║                                                                           ║
 * ║  Sourced from docs/Aeygis_Cloud_Rate_Card.pdf, which is stamped           ║
 * ║  "CONFIDENTIAL - Internal Use Only" on every page.                        ║
 * ║                                                                           ║
 * ║  NOTHING IN THIS FILE MAY REACH A CLIENT-FACING DOCUMENT.                 ║
 * ║                                                                           ║
 * ║  It contains delivery cost per hour, margin reasoning, and competitor      ║
 * ║  analysis. A prospect who saw this would know Aeygis' cost base and       ║
 * ║  negotiate against it.                                                    ║
 * ║                                                                           ║
 * ║  Five independent barriers keep it contained. See                         ║
 * ║  docs/architecture.md. The two that matter most here:                     ║
 * ║                                                                           ║
 * ║   1. `.dependency-cruiser.cjs` FORBIDS any import of this package from    ║
 * ║      amplify/functions/render-proposal-pdf/** or apps/console/**.         ║
 * ║      CI fails on violation. Do not add an exception.                      ║
 * ║   2. `assertClientSafe()` in the renderer rejects any payload whose keys   ║
 * ║      match /cost|margin|competitor|hourly|internal|floor/i.               ║
 * ║                                                                           ║
 * ║  If you need a number from here in a proposal, you do not. Derive the      ║
 * ║  client-facing figure in @aeygis/pricing instead.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { type Tier } from '@aeygis/pricing';

/**
 * Delivery cost to Aeygis, CAD per engineer-hour.
 *
 * Rate Card §1 states plainly that these are estimates from public salary and
 * outsourcing data, NOT actual payroll, and says: "Before treating this as
 * final, check it against the real hours logged on 2-3 finished projects."
 *
 * So these are provisional. Do not treat any margin computed from them as
 * accurate enough to justify a discount decision on its own.
 */
export const DELIVERY_COST_PER_HOUR_CAD = {
  /** Normal project work. */
  standard: { min: 75, max: 100 },
  /** Canadian business-hours coverage or any round-the-clock on-call. */
  canadianHoursOrOnCall: { min: 100, max: 130 },
} as const;

/** Rate Card §1: roughly one third of a Canadian-staffed competitor's cost. */
export const DELIVERY_COST_RATIO_VS_CANADIAN_COMPETITOR = 1 / 3;

/**
 * Published competitor pricing, per person per month, CAD unless noted.
 * Rate Card §5. Present for internal comparison only.
 */
export const COMPETITOR_PRICING = [
  { name: 'Fusion Computing', type: 'Canadian IT, healthcare privacy focus', perPersonMonthly: { shared: 130, managed: 180, fullSecurity: 230 } },
  { name: 'Medicus IT', type: 'US healthcare IT', perPersonMonthly: { allIn: 175 } },
  { name: 'CloudQuad', type: 'Canadian IT, healthcare privacy focus', hourly: 30 },
  { name: 'Aptible', type: 'Compliance hosting platform', flatMonthly: 499 },
  { name: 'MedStack', type: 'Compliance hosting platform', pctOfHostingCost: 20 },
] as const;

/**
 * Approximate headcount per tier, used only for the internal per-person
 * comparison in Rate Card §5. Not a client-facing figure and not a licence count.
 */
export const APPROX_STAFF_PER_TIER: Readonly<Partial<Record<Tier, number>>> = {
  micro: 6,
  starter: 9,
  professional: 25,
};

/**
 * Indicative gross margin on a monthly figure, given assumed engineer hours.
 *
 * Deliberately returns a RANGE, not a point estimate, because the cost inputs
 * are ranges and provisional. A single number here would imply precision the
 * source data does not have.
 */
export function indicativeMarginRange(
  monthlyRevenueCad: number,
  engineerHoursPerMonth: number,
  coverage: keyof typeof DELIVERY_COST_PER_HOUR_CAD = 'standard',
): { low: number; high: number } {
  const rate = DELIVERY_COST_PER_HOUR_CAD[coverage];
  const costHigh = engineerHoursPerMonth * rate.max;
  const costLow = engineerHoursPerMonth * rate.min;
  return {
    low: monthlyRevenueCad - costHigh,
    high: monthlyRevenueCad - costLow,
  };
}

/**
 * Rate Card §4 negotiation guidance. Internal script, not client copy.
 */
export const NEGOTIATION_GUIDANCE = {
  leadWith:
    'For a real 1-2 provider clinic, lead with Starter Full Managed. Offer Essentials as the lighter option, not the first pitch.',
  microPositioning:
    'Only offer Micro to a genuinely tiny, one-provider clinic. It exists to win the deal; do not upsell immediately.',
  enterprise: 'Always send Enterprise clients through a discovery call first. Never give a firm price before that call.',
  discountOrder:
    'Cut what is included before cutting price: drop a support plan, limit included hours, or have the client pay auditors directly.',
  versusPerPersonQuotes:
    'Do not fight a per-person IT quote on price. Point out what it omits: cloud engineering, resilience, and privacy evidence.',
} as const;
