import { defineFunction } from '@aws-amplify/backend';

/**
 * ============================================================================
 * SES CONFIGURATION — exported, because backend.ts needs the same values
 * ============================================================================
 *
 * These are exported constants rather than literals typed into the environment
 * block below, because backend.ts builds IAM resource ARNs from two of them.
 * A sender address written out in two files drifts the first time one is
 * changed, and the failure mode is bad: the function would send from an
 * address its own IAM policy does not cover, and the error surfaces at runtime
 * as an opaque authorization refusal.
 *
 * ── WHY THESE ARE PLAIN VALUES AND NOT SECRETS ──────────────────────────────
 *
 * `secret()` would let them change without touching the repo. That sounds like
 * an advantage and is the wrong trade here.
 *
 * SES_ALLOWED_RECIPIENTS decides who this company is allowed to email. A change
 * to it should appear in a diff and be seen by a second pair of eyes. As a
 * secret it would be invisible: someone could widen it to everyone and nothing
 * in the repository would record that it happened.
 *
 * None of these values is confidential. They are configuration, and
 * configuration that gates outbound email belongs in version control.
 */

/**
 * Master off switch, independent of the allowlist.
 *
 * Separate from SES_ALLOWED_RECIPIENTS on purpose: "stop all sending right now"
 * and "change who may be emailed" are different decisions, and conflating them
 * means the emergency action is also the one that quietly rewrites policy.
 * Anything other than the exact string 'true' is off.
 *
 * ── WHY THIS IS 'true' AND NOT 'false' ──────────────────────────────────────
 *
 * It was 'false' when the function was first written, on the reasoning that a
 * first deploy should not arrive able to send. Changed on 2026-08-23, once
 * rajaemadhussain@gmail.com was verified in SES, because 'false' was the wrong
 * committed default:
 *
 *   - The REAL guard is SES_ALLOWED_RECIPIENTS, which fails closed. With it set
 *     to a single verified address, a real clinic address is refused whatever
 *     this flag says. This switch is not what protects prospects.
 *   - A committed 'false' means every future environment deploys unable to
 *     send, and the symptom — proposals silently recorded as `blocked` — reads
 *     like a bug rather than a setting.
 *
 * So this is the emergency stop, not the routine gate. Set it to anything other
 * than 'true' to halt all sending without touching who is on the allowlist.
 */
export const SES_ENABLED = 'true';

/**
 * The From address. MUST be covered by an SES-verified identity — verification
 * is required in production too, not only in the sandbox.
 *
 * ── CHANGED 2026-09-16 ─────────────────────────────────────────────────────
 * Was `rajaemadhussain@gmail.com`. That address was itself a verified identity,
 * but it could never be DMARC-aligned: SES cannot DKIM-sign for a domain we do
 * not control, so every proposal failed SPF, DKIM and DMARC and was destined for
 * spam regardless of anything else in this file.
 *
 * `aeygis.com` was verified as a DOMAIN identity on 2026-09-14 (DKIM SUCCESS),
 * and AWS granted production access on 2026-09-16. This address is covered by
 * that domain identity — there is deliberately no separate address identity for
 * it, and none is needed.
 *
 * It matters more here than it would elsewhere: aeygis.com publishes
 * `DMARC p=quarantine; pct=100`, so unaligned mail from this domain is not
 * merely likely to be filtered, it is instructed to be. Sending as
 * `aws@aeygis.com` with the domain's DKIM is what makes that policy work FOR the
 * message instead of against it.
 *
 * `aws@aeygis.com` is a real Google Workspace mailbox — confirmed with the user
 * — and is what the Overview deck and every legal page already publish, so a
 * reply reaches a person.
 *
 * Changing this REQUIRES a redeploy, not just an edit: backend.ts scopes the
 * function's ses:SendEmail permission to this identity's ARN (and, since the
 * sender now sits under a domain identity, to the domain's ARN as well).
 */
export const SES_FROM_ADDRESS = 'aws@aeygis.com';

/**
 * Internal copy of every proposal that goes out, so there is a human-readable
 * record outside the console.
 *
 * ── CHANGED 2026-09-16 ─────────────────────────────────────────────────────
 * Was `rajaemadhussain@gmail.com`. During testing that was also the recipient,
 * so a successful send arrived twice — deliberate, because it proved the BCC
 * path worked before it mattered. It did: the cutover send on 2026-09-16
 * delivered both copies.
 *
 * Leaving it there afterwards would mean **a copy of every client proposal
 * landing in a personal mailbox**. That is a different thing from a test
 * artefact: these are commercial documents naming real clinics and real prices,
 * and they belong in a company mailbox that survives one person leaving.
 *
 * `aws@aeygis.com` also receives the bounce and complaint alerts, so the record
 * of what was sent and the warning that it did not arrive land together.
 *
 * Blank disables the copy entirely. The BCC is subject to the same recipient
 * allowlist as the client address — in an environment where that list is
 * narrowed, this address has to be on it or every send is refused.
 */
export const SES_BCC_ADDRESS = 'aws@aeygis.com';

/**
 * Who may be emailed. FAILS CLOSED — see recipientPolicy.ts.
 *
 *   unset / blank  -> block everything (the safe direction)
 *   '*'            -> allow everything
 *   'a@x, b@y'     -> exactly those
 *
 * Do NOT blank this to "turn the guard off". Blank means block. Set '*'.
 *
 * ── OPENED 2026-09-16 ──────────────────────────────────────────────────────
 * Was a single test address. Opened to '*' last, deliberately, after every
 * other part of the cutover was done and checked:
 *
 *   1. AWS granted production access                       (2026-09-16)
 *   2. aeygis.com verified, DKIM SUCCESS                   (2026-09-14)
 *   3. sender moved to aws@aeygis.com and deployed         (2026-09-16)
 *   4. a real send landed in an INBOX, not spam            (confirmed by the user)
 *
 * Step 4 is the one that mattered and it is not a formality. aeygis.com
 * publishes `DMARC p=quarantine; pct=100`, so an unaligned message would have
 * been quarantined on Aeygis's own instruction. Arriving in an inbox is
 * therefore positive evidence that DKIM alignment works, not just an absence of
 * bad news. Opening this before that was known would have made the first
 * DMARC-aligned send also the first one able to reach a stranger.
 *
 * ── WHAT THIS NOW MEANS ────────────────────────────────────────────────────
 * Until today there were two independent guards: this list, and AWS's sandbox
 * refusing unverified recipients. The sandbox guard is gone and this one is now
 * open. **The remaining controls are the ones in the code** — approver-only
 * sending, approved-versions-only, the content hash re-checked immediately
 * before sending, and a recipient that can only ever come from the clinic's own
 * submitted contact details. There is no recipient field a human can type into.
 *
 * Narrowing this back to a list is a legitimate thing to do in any environment
 * that is not production.
 */
export const SES_ALLOWED_RECIPIENTS = '*';

/**
 * Configuration set name — how bounces and complaints reach an SNS topic
 * instead of vanishing. The set itself is created in backend.ts.
 *
 * A fixed string rather than a CloudFormation reference on purpose: importing
 * the construct's generated name into the function's environment would create
 * exactly the cross-stack cycle backend.ts documents at length for the
 * proposals bucket. A literal name is synthesized independently in every stack.
 */
export const SES_CONFIGURATION_SET = 'aeygis-proposal-delivery';

/**
 * Delivers an approved proposal to the client.
 *
 * The only thing in this system that reaches outside the account, and the only
 * action that cannot be undone. Everything else can be redone: a price
 * re-quoted, a draft version deleted, a rejection reversed with a new record.
 * An email cannot be unsent. The handler is written accordingly.
 *
 * Plain `defineFunction`, NOT the provider overload that render-proposal-pdf
 * needs. That function drops to CDK only because @sparticuz/chromium-min must
 * be externalized from the bundle, which Amplify's FunctionBundlingOptions
 * cannot express. Nothing here needs that, and the provider overload costs the
 * automatic SSM environment injection — which is exactly the gap that left
 * render-proposal-pdf without AEYGIS_PROPOSALS_BUCKET_NAME at runtime (see the
 * long note in backend.ts). This function relies on that injection for the
 * bucket name, so it keeps the plain form.
 *
 * Sized for what it does: read a JSON snapshot, read a ~300 KB PDF, call SES,
 * write two records. 30 seconds is generous; a slow invocation here means
 * something is wrong rather than something is large.
 */
export const sendProposalEmail = defineFunction({
  name: 'send-proposal-email',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 512,
  runtime: 22,
  environment: {
    SES_ENABLED,
    SES_FROM_ADDRESS,
    SES_BCC_ADDRESS,
    SES_ALLOWED_RECIPIENTS,
    SES_CONFIGURATION_SET,
  },
});
