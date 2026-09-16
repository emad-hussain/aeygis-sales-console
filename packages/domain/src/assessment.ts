/**
 * Assessment intake field vocabulary.
 *
 * These values mirror the live health.aeygis.com form exactly, so a submission
 * from the existing UI validates without translation. Where the live form uses
 * a value that is illegal as a GraphQL enum member (leading digit, or a `-`),
 * the value is stored as a validated string instead — see bands.ts.
 */

export const HOSTING_MODELS = ['onprem', 'cloud', 'mixed'] as const;
export type HostingModel = (typeof HOSTING_MODELS)[number];

/** Yes / no / unsure posture answers. */
export const POSTURE_ANSWERS = ['yes', 'no', 'unsure'] as const;
export type PostureAnswer = (typeof POSTURE_ANSWERS)[number];

/**
 * Live form values are "1yr" | "1-2yr" | "never" | "unsure" — both of the first
 * two are illegal GraphQL enum members (leading digit). Stored as strings.
 */
export const RISK_ASSESSMENT_AGES = ['1yr', '1-2yr', 'never', 'unsure'] as const;
export type RiskAssessmentAge = (typeof RISK_ASSESSMENT_AGES)[number];

export const DOWNTIME_HOUR_BANDS = ['under10', '10to40', '40to90', 'over90'] as const;
export type DowntimeHourBand = (typeof DOWNTIME_HOUR_BANDS)[number];

export const DOWNTIME_COST_BANDS = [
  'under1000',
  '1000to2500',
  '2500to5000',
  'over5000',
] as const;
export type DowntimeCostBand = (typeof DOWNTIME_COST_BANDS)[number];

/**
 * Midpoints used for the indicative TCO figure, carried over from the live
 * form's own constants so our numbers do not silently disagree with what the
 * prospect already saw on screen.
 */
export const DOWNTIME_HOUR_MIDPOINTS: Readonly<Record<DowntimeHourBand, number>> = {
  under10: 5,
  '10to40': 25,
  '40to90': 65,
  over90: 110,
};

export const DOWNTIME_COST_MIDPOINTS: Readonly<Record<DowntimeCostBand, number>> = {
  under1000: 750,
  '1000to2500': 1750,
  '2500to5000': 3750,
  over5000: 6000,
};

/** Where a submission came from, so intake sources stay distinguishable. */
export const SUBMISSION_SOURCES = [
  'health_site_live_form',
  'internal_console',
  'manual_entry',
] as const;
export type SubmissionSource = (typeof SUBMISSION_SOURCES)[number];

export const ASSESSMENT_STATUSES = [
  'new',
  'needs_confirmation',
  'in_review',
  'proposed',
  'closed',
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/**
 * Display labels for the stored status values.
 *
 * Here rather than in the console because two screens already needed them —
 * the queue and the detail header — and a vocabulary duplicated across files
 * drifts. `status` is a plain string on the model, not a GraphQL enum, so
 * anything could in principle be stored; `assessmentStatusLabel` renders an
 * unrecognised value readably instead of blanking it, which is why an
 * unexpected status can never make a lead invisible in the queue.
 */
export const ASSESSMENT_STATUS_LABEL: Readonly<Record<AssessmentStatus, string>> = {
  new: 'New',
  needs_confirmation: 'Needs confirmation',
  in_review: 'In review',
  proposed: 'Proposed',
  closed: 'Closed',
};

export function assessmentStatusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined || status === '') return 'Unknown';
  return isOneOf(ASSESSMENT_STATUSES, status)
    ? ASSESSMENT_STATUS_LABEL[status]
    : status.replace(/_/g, ' ');
}

export function isOneOf<T extends readonly string[]>(
  allowed: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
