/**
 * When does emailing a proposal move the lead to `proposed`?
 *
 * Pure and separate from handler.ts so the rule can be tested without AWS —
 * same reasoning as recipientPolicy.ts and emailBody.ts beside it.
 *
 * The rule reads as one sentence: a lead becomes `proposed` when a proposal
 * actually reaches the client, unless a person has already said otherwise.
 */

/**
 * Statuses a send will NOT move, and why each is left alone.
 *
 * `proposed` — already there. Writing it again is noise in a record people read
 *              to understand what changed and when.
 *
 * `closed`   — a person deliberately ended this lead. Sending a proposal does
 *              not silently reopen it. If somebody is genuinely re-engaging a
 *              closed lead, reopening it is a decision they can make in the
 *              console where it is visible and attributable, rather than a side
 *              effect of an unrelated click.
 *
 * Everything else — `new`, `needs_confirmation`, `in_review` — advances,
 * because every one of them describes a lead we had not yet put a number in
 * front of.
 */
export const STATUSES_A_SEND_LEAVES_ALONE: readonly string[] = ['proposed', 'closed'];

/**
 * `false` for an unknown or absent status, deliberately.
 *
 * A status we do not recognise is one this rule was never written against.
 * Advancing it would be guessing at the intent of whoever put it there, and the
 * cost of guessing wrong (overwriting a state somebody relies on) is higher
 * than the cost of doing nothing (a lead that reads slightly stale, visible to
 * anyone who opens it). So: refuse to act rather than act on an assumption.
 */
export function shouldAdvanceToProposed(current: string | null | undefined): boolean {
  if (typeof current !== 'string') return false;
  const status = current.trim().toLowerCase();
  if (status.length === 0) return false;
  if (STATUSES_A_SEND_LEAVES_ALONE.includes(status)) return false;
  return KNOWN_EARLIER_STATUSES.includes(status);
}

/**
 * The statuses that precede a proposal going out.
 *
 * Listed explicitly rather than inferred as "anything not in the leave-alone
 * list", so a status added to the model later does not start being rewritten by
 * this function before anyone has decided that it should be.
 */
export const KNOWN_EARLIER_STATUSES: readonly string[] = [
  'new',
  'needs_confirmation',
  'in_review',
];
