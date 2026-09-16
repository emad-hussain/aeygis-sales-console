import { defineFunction, secret } from '@aws-amplify/backend';
import { SES_FROM_ADDRESS } from '../send-proposal-email/resource.js';

/**
 * ============================================================================
 * NEW-LEAD NOTIFICATION
 * ============================================================================
 *
 * Added 2026-08-25, when the public form stopped emailing sales through a
 * third-party relay and this backend became the only destination. That closed a
 * real gap — leads were not being kept anywhere — and opened another: a lead now
 * lands in DynamoDB and nothing announces it.
 *
 * Exported constants rather than inline literals, for the same reason
 * send-proposal-email exports its own: `backend.ts` builds the IAM resource ARNs
 * from them, and an address written out in two files drifts the first time one
 * is changed. The failure mode of that drift is bad — the function would send
 * from an address its own policy does not cover, surfacing at runtime as an
 * opaque authorization refusal.
 *
 * ── THE SENDER IS IMPORTED, NOT REDECLARED ─────────────────────────────────
 * `SES_FROM_ADDRESS` comes from send-proposal-email/resource.ts, which is
 * already the canonical place for it — that file exports it precisely so
 * backend.ts can scope IAM to the same identity the code sends from. Copying
 * the address here would create a second thing to keep in step, and the two
 * functions genuinely do send from the same verified identity.
 */

/**
 * Master off switch, independent of everything else. Anything other than the
 * exact string 'true' is off.
 *
 * Turning this off loses the heads-up, NOT the lead. The assessment is written
 * before the notification is attempted, and a failed notification never changes
 * what the visitor is told — see the call site in handler.ts.
 */
export const NOTIFY_ENABLED = 'true';

/**
 * Where the heads-up goes.
 *
 * The verified test address, because while SES is in the sandbox it will not
 * deliver anywhere else. This becomes a real Aeygis inbox at the domain
 * cutover — the same change that switches SES_FROM_ADDRESS. See
 * docs/email-setup.md.
 */
export const NOTIFY_TO_ADDRESS = 'rajaemadhussain@gmail.com';

/**
 * A SECOND configuration set, deliberately not the proposal one.
 *
 * The proposal set exists so client-facing delivery reputation can be judged on
 * its own. Routing internal notifications through it would mix the two: a bounce
 * on our own inbox would land in the same reputation metrics as a proposal that
 * failed to reach a clinic. Separating them costs one more resource and keeps
 * the number that matters commercially clean.
 *
 * A fixed literal, not a CloudFormation reference — importing the construct's
 * generated name into this function's environment would create exactly the
 * cross-stack cycle backend.ts documents at length for the proposals bucket.
 */
export const NOTIFY_CONFIGURATION_SET = 'aeygis-internal-notifications';

/** Re-exported so backend.ts can scope the send permission without a second import path. */
export const NOTIFY_FROM_ADDRESS = SES_FROM_ADDRESS;

/**
 * The only writer of `Assessment`.
 *
 * Fronting the model with a Lambda rather than granting guests `createAssessment`
 * is what makes the public path safe — see the security note in
 * amplify/data/resource.ts.
 *
 * ── SIZING, AND WHY IT CHANGED ─────────────────────────────────────────────
 * This was a validate-and-put with no external calls, sized at 15 seconds on the
 * reasoning that a long invocation meant something was wrong. It now also makes
 * an SES call, so the timeout is 30 seconds: SES is fast, but a 15-second budget
 * shared with a DynamoDB write and a rate-limit query leaves no room for a slow
 * one, and a timeout here would fail a submission that had already been stored.
 */
export const submitAssessment = defineFunction({
  name: 'submit-assessment',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  runtime: 22,
  environment: {
    // Max submissions per IP per rolling window. Low, because a real clinic
    // submits once; anything repeating is abuse or a retry storm.
    RATE_LIMIT_MAX: '5',
    RATE_LIMIT_WINDOW_SECONDS: '3600',

    // Salt for hashing submitter IPs. This MUST be a real secret: IPv4 space is
    // only ~4 billion addresses, so an unsalted or publicly-known-salt hash is
    // reversible by brute force in minutes. That would make `submitterIpHash`
    // stored personal information rather than the privacy measure it is meant
    // to be.
    //
    // Set before first deploy:
    //   npx ampx sandbox secret set IP_HASH_SALT
    IP_HASH_SALT: secret('IP_HASH_SALT'),

    NOTIFY_ENABLED,
    NOTIFY_FROM_ADDRESS,
    NOTIFY_TO_ADDRESS,
    NOTIFY_CONFIGURATION_SET,
  },
});
