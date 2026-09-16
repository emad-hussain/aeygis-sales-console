/**
 * Proposal delivery vocabulary.
 *
 * Lives in @aeygis/domain rather than beside the Lambda because BOTH sides need
 * it: the send function writes the status, and the console renders it. A
 * vocabulary duplicated across a backend and a frontend drifts — the console
 * ends up with a label for a status the backend stopped writing, or worse, no
 * label for one it started writing.
 *
 * Same shape as ASSESSMENT_STATUSES in assessment.js, deliberately: one list,
 * one label map, one renderer that never returns blank.
 */

import { isOneOf } from './assessment.js';

/**
 * What happened to a send attempt.
 *
 * `blocked` and `failed` are SEPARATE on purpose, and the distinction is the
 * whole point of having three values instead of a boolean:
 *
 *   sent    — SES accepted the message and returned a message id.
 *   blocked — WE refused to send it. The recipient was not on the allowlist, or
 *             sending is switched off. Nothing left the building, and nothing is
 *             broken. This is the expected outcome for a real client address
 *             while the SES account is still in the sandbox.
 *   failed  — we tried to send and something went wrong: SES rejected it, the
 *             PDF could not be read, the network died.
 *
 * Collapsing `blocked` into `failed` would send someone debugging a fault that
 * does not exist. Collapsing it into `sent` would be a lie.
 */
export const DELIVERY_STATUSES = ['sent', 'blocked', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABEL: Readonly<Record<DeliveryStatus, string>> = {
  sent: 'Sent',
  blocked: 'Blocked',
  failed: 'Failed',
};

/**
 * Renders a stored status for display.
 *
 * `status` is a plain string on the model, not a GraphQL enum, so an
 * unrecognised value is possible. It must stay READABLE rather than blank —
 * a delivery row that renders with an empty status cell looks like a UI bug
 * and hides the very thing the row exists to report.
 */
export function deliveryStatusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined || status === '') return 'Unknown';
  return isOneOf(DELIVERY_STATUSES, status)
    ? DELIVERY_STATUS_LABEL[status]
    : status.replace(/_/g, ' ');
}

/**
 * Whether a status means the client actually received something.
 *
 * A named predicate rather than `=== 'sent'` at each call site, because the
 * console asks this question in more than one place and "did it go out?" is a
 * business question, not a string comparison.
 */
export function deliveryReachedClient(status: string | null | undefined): boolean {
  return status === 'sent';
}
