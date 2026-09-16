/**
 * Last-ditch rescue for a lead the API refused to store.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-26 two submissions were lost because one OPTIONAL field held a
 * value AppSync would not accept. Everything else about them was perfect. The
 * visitor was told "we could not save your assessment", and the only trace was
 * a reference id pointing at nothing.
 *
 * The specific cause was fixed at its source (see the `phone` comment in
 * data/resource.ts). This module exists because the SHAPE of that bug will
 * recur: a schema type is tightened, a new field is added, a scalar behaves
 * differently from how it reads — and a whole lead dies for one bad value.
 *
 * So the rule is now explicit: a submission that cannot be stored intact gets
 * stored REDUCED. A lead missing its job title is worth enormously more than
 * no lead at all, and the visitor is not made to retype anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not retry the same record hoping for a different answer. A rejected
 * variable is rejected deterministically, so a plain retry is a wasted second
 * and a second failure. Only a genuinely SMALLER record is worth sending.
 *
 * It never drops an essential field. If the offending value turns out to be
 * one of those, salvage returns null and the caller reports the failure
 * honestly — a lead with no email cannot be followed up, so pretending to have
 * saved it would be worse than admitting we did not.
 *
 * Pure and AWS-free so it can be tested exhaustively. Same reasoning as
 * validate.ts and notification.ts.
 */

/**
 * Fields a lead is worthless without, so never dropped.
 *
 * Two different reasons sit in this list and it is worth keeping them straight:
 *
 *   - STRUCTURAL: referenceId, source, status, submittedAt, countsConfirmed
 *     and consent are `.required()` in the schema. Dropping one guarantees the
 *     retry fails too.
 *   - COMMERCIAL: email, clinicName and contactName are what make the record a
 *     lead rather than a row. A submission without them is not worth storing.
 *
 * consentedAt is here because consent without its timestamp is a weaker record
 * than we want to hold under CASL.
 */
export const ESSENTIAL_FIELDS: readonly string[] = [
  'referenceId',
  'source',
  'status',
  'submittedAt',
  'countsConfirmed',
  'consent',
  'consentedAt',
  'email',
  'clinicName',
  'contactName',
];

const ESSENTIAL = new Set(ESSENTIAL_FIELDS);

/**
 * Pull field names out of an API validation error.
 *
 * AppSync reports a refused variable as:
 *   "Variable 'phone' has an invalid value."
 *
 * Parsing an error string is ordinarily a bad idea, so this is built to be
 * wrong safely: a name we fail to extract costs us precision, never
 * correctness, because salvageRecord falls back to dropping everything
 * optional. If AWS rewords the message tomorrow, this returns nothing and the
 * fallback still saves the lead.
 */
export function fieldsNamedInErrors(errors: readonly unknown[]): string[] {
  const names = new Set<string>();

  for (const entry of errors) {
    const message =
      typeof entry === 'object' && entry !== null && 'message' in entry
        ? String((entry as { message?: unknown }).message ?? '')
        : String(entry ?? '');

    // Global: one error can name more than one variable.
    for (const match of message.matchAll(/Variable '([A-Za-z0-9_]+)'/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }

  return [...names];
}

export interface SalvageResult {
  /** The reduced record to attempt instead. */
  record: Record<string, unknown>;
  /** Field names removed, for the log line. Never empty. */
  dropped: string[];
  /**
   * True when the error named the offending fields and we removed exactly
   * those; false when we could not tell and removed everything optional.
   * Worth logging — it is the difference between a precise rescue and a blunt
   * one, and a run of blunt ones means the error format has moved.
   */
  targeted: boolean;
}

/**
 * Build a smaller record that has a real chance of being accepted.
 *
 * Returns null when there is nothing useful left to try — either every field
 * the error blamed is essential, or the record carries no optional fields at
 * all. A null means "report the failure", not "try again".
 */
export function salvageRecord(
  record: Readonly<Record<string, unknown>>,
  errors: readonly unknown[],
): SalvageResult | null {
  const blamed = fieldsNamedInErrors(errors).filter((name) => name in record);

  // Precise path: the error told us which fields it hated. Drop only those, so
  // the salvaged lead keeps everything else the visitor typed.
  if (blamed.length > 0) {
    const droppable = blamed.filter((name) => !ESSENTIAL.has(name));
    // Every blamed field is essential — a smaller record cannot help.
    if (droppable.length === 0) return null;

    const reduced: Record<string, unknown> = { ...record };
    for (const name of droppable) delete reduced[name];
    return { record: reduced, dropped: droppable.sort(), targeted: true };
  }

  // Blunt path: we could not tell what was wrong, so keep only what a lead
  // genuinely needs. Loses detail, keeps the prospect.
  const dropped: string[] = [];
  const reduced: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (ESSENTIAL.has(name)) {
      reduced[name] = value;
    } else {
      dropped.push(name);
    }
  }

  if (dropped.length === 0) return null;
  return { record: reduced, dropped: dropped.sort(), targeted: false };
}
