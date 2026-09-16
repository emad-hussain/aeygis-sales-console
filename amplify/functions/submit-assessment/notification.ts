/**
 * The internal email that says a new lead has arrived.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Until 2026-08-25 the public form emailed sales through a third-party relay
 * and mirrored the data here. That email was removed and the backend became the
 * only destination — which closed a real gap (leads were not being kept) and
 * opened a different one: a lead now lands in DynamoDB and **nothing announces
 * it**. Somebody has to open the console and look.
 *
 * This closes that. It is a notification, not a system of record: the
 * `Assessment` row is the record, and this is best-effort on top of it. If it
 * fails, the lead is still safely stored and the visitor still gets their
 * receipt — see the call site in handler.ts.
 *
 * ============================================================================
 * IT IS INTERNAL, WHICH CHANGES WHAT BELONGS IN IT — BUT NOT THE CARE
 * ============================================================================
 *
 * This goes to an Aeygis inbox, never to the prospect, so it may carry the full
 * submission. Two things still matter:
 *
 *   1. EVERY VALUE IS ATTACKER-CONTROLLED. It is composed from text a stranger
 *      typed into a public form. The subject line is a mail HEADER, so a
 *      newline in it is the classic header-injection shape.
 *
 *   2. IT MUST NOT OVERSTATE WHAT IS KNOWN. The form collects bands, so most
 *      leads arrive unpriceable until someone confirms exact counts. The
 *      notification says which state the record is in rather than leaving the
 *      reader to work it out.
 *
 * PURE ON PURPOSE — no AWS imports, so it can be tested without credentials.
 * Same reasoning as functions/shared/identity.ts.
 */

/** Longest a single free-text value may be in the body, so one pasted essay cannot bury the rest. */
const MAX_VALUE_LENGTH = 300;

/**
 * Whether this submission is a verification artifact rather than a real lead.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * `npm run verify`, `npm run seed:demo` and the guest-access check all submit
 * through the REAL public mutation — deliberately, because that is what makes
 * them prove anything. Without this, every verification run would email the
 * team about clinics that do not exist.
 *
 * That is not merely annoying. The SES sending quota is per ACCOUNT and region
 * and is SHARED with proposal delivery: in the sandbox, 200 messages per 24
 * hours. Test notifications competing for that quota against a real proposal
 * going to a real clinic is the wrong trade.
 *
 * ── WHY `.invalid` AND NOTHING ELSE ────────────────────────────────────────
 * `.invalid` is reserved by RFC 2606 precisely so it can never be a real
 * domain, which is why the seed data uses it. Matching on it cannot suppress a
 * genuine prospect, because a genuine prospect cannot have one.
 *
 * Deliberately NOT matching on a name pattern, a marker in the clinic name, or
 * a list of specific addresses. Each of those could match something real, and
 * the failure would be silent: a lead arrives, nobody is told, and nothing
 * anywhere says why.
 */
export function isTestSubmission(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith('.invalid');
}

export interface AssessmentNotificationInput {
  readonly referenceId: string;
  /** 'new' when exact counts were supplied, 'needs_confirmation' otherwise. */
  readonly status: string;
  readonly clinicName: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly jobTitle: string | null;
  readonly organizationType: string | null;
  readonly organizationSize: string | null;
  readonly province: string | null;
  readonly providerBand: string | null;
  readonly locationBand: string | null;
  readonly providerCount: number | null;
  readonly locationCount: number | null;
  readonly countsConfirmed: boolean;
  readonly hosting: string | null;
  readonly monthlyItSpend: number | null;
  readonly annualHardwareEmergency: number | null;
  readonly downtimeHoursBand: string | null;
  readonly downtimeCostBand: string | null;
  readonly mfa: string | null;
  readonly backups: string | null;
  readonly incidentPlan: string | null;
  readonly lastRiskAssessment: string | null;
  /**
   * Fields that could not be stored, if any. See salvage.ts.
   *
   * Present so this email never quietly disagrees with the console: it lists
   * what the visitor SUBMITTED, the console shows what we KEPT, and when the
   * two differ a salesperson should be told rather than left to notice.
   */
  readonly droppedFields?: readonly string[] | null;
  readonly submittedAt: string;
}

export interface AssessmentNotification {
  readonly subject: string;
  readonly text: string;
}

/**
 * Flattens a value to one line before it goes in a mail HEADER.
 *
 * A carriage return or newline inside a header value lets everything after it
 * be read as a new header, which is how an attacker adds their own Bcc. SESv2
 * builds the MIME itself from structured input so this is not relied upon to be
 * exploitable — but "the SDK probably handles it" is not a reason to pass a
 * newline into a header.
 *
 * Control characters are REPLACED with a space rather than stripped, so words
 * either side of one do not silently run together.
 */
export function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Renders a value for the body, or a dash. Never throws on an odd type. */
export function present(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'number' ? String(value) : value;
  const cleaned = singleLine(text);
  if (cleaned === '') return '—';
  return cleaned.length > MAX_VALUE_LENGTH ? `${cleaned.slice(0, MAX_VALUE_LENGTH)}…` : cleaned;
}

/** CAD, whole dollars. Plain text, so no currency symbol games. */
export function money(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `CAD ${Math.round(value).toLocaleString('en-CA')}`;
}

/**
 * How the scale reads, and — more usefully — whether it can be priced yet.
 *
 * This is the single most actionable line in the message. The public form sends
 * bands, and a band spans more than one tier, so most leads arrive unpriceable.
 * Saying so here is what stops somebody opening the console expecting a quote.
 */
export function describeScale(input: AssessmentNotificationInput): string {
  if (input.countsConfirmed && input.providerCount !== null && input.locationCount !== null) {
    return (
      `${input.providerCount} provider(s), ${input.locationCount} location(s) — ` +
      'exact counts supplied, so this can be priced now.'
    );
  }
  const providers = present(input.providerBand);
  const locations = present(input.locationBand);
  return (
    `${providers} provider(s), ${locations} location(s) — BANDS ONLY. ` +
    'Confirm exact counts in the console before this can be priced.'
  );
}

export function buildAssessmentNotification(
  input: AssessmentNotificationInput,
): AssessmentNotification {
  const clinic = present(input.clinicName);

  // singleLine, because this becomes a mail header and `clinic` is free text
  // from a public form. See the note on singleLine.
  const subject = singleLine(
    `New assessment — ${clinic === '—' ? 'unnamed organization' : clinic} (${input.referenceId})`,
  );

  const lines = [
    `A new cloud readiness assessment was submitted at ${present(input.submittedAt)}.`,
    '',
    `Reference       ${present(input.referenceId)}`,
    `Status          ${present(input.status)}`,
    '',
    'SCALE',
    `  ${describeScale(input)}`,
    '',
    'CONTACT',
    `  Organization  ${clinic}`,
    `  Name          ${present(input.contactName)}`,
    `  Role          ${present(input.jobTitle)}`,
    `  Email         ${present(input.email)}`,
    `  Phone         ${present(input.phone)}`,
    `  Type          ${present(input.organizationType)}`,
    `  Size          ${present(input.organizationSize)}`,
    `  Province      ${present(input.province)}`,
    '',
    'CURRENT ENVIRONMENT',
    `  Hosting       ${present(input.hosting)}`,
    `  IT spend      ${money(input.monthlyItSpend)} / month`,
    `  Hardware      ${money(input.annualHardwareEmergency)} / year`,
    `  Downtime      ${present(input.downtimeHoursBand)} hours, ${present(input.downtimeCostBand)} per hour`,
    '',
    'SECURITY POSTURE',
    `  MFA                 ${present(input.mfa)}`,
    `  Backups tested      ${present(input.backups)}`,
    `  Incident plan       ${present(input.incidentPlan)}`,
    `  Last risk review    ${present(input.lastRiskAssessment)}`,
    '',
    'Open the sales console to review, confirm the counts, and price it.',
    '',
    'This is an automated notification. The assessment itself is stored in the',
    'console — this message is a heads-up, not the record.',
    '',
  ];

  /* Put this at the TOP, not the bottom. It is the one line in the message
     that changes what the reader has to DO, and a note about missing data is
     worthless if it sits below forty lines of data. */
  if (input.droppedFields !== undefined && input.droppedFields !== null && input.droppedFields.length > 0) {
    lines.unshift(
      'HEADS UP: some fields could not be saved and are NOT in the console:',
      `  ${input.droppedFields.join(', ')}`,
      'Their values appear below, in this email only. Copy anything you need',
      'into the lead before replying.',
      '',
    );
  }

  return { subject, text: lines.join('\n') };
}
