import { defineAuth } from '@aws-amplify/backend';

/**
 * Staff authentication for the internal console.
 *
 * Two groups, per the approved plan:
 *   contributor — fills in assessment gaps and finalizes solution/timeline/pricing
 *   approver    — may approve a proposal for delivery. Emad only, initially.
 *
 * Group membership is deliberately the *only* thing separating the two roles, so
 * adding an approver later is a Cognito group change rather than a code change.
 *
 * Note: group membership is mutable, which is why `Approval` snapshots the
 * approver's groups at decision time instead of resolving them at read time.
 * An audit trail must not depend on current state.
 *
 * `defineAuth` also provisions a Cognito identity pool with an unauthenticated
 * role. That role is what makes `allow.guest()` resolvable for the public
 * assessment submission — see amplify/data/resource.ts.
 *
 * `accountRecovery` is still omitted — its option shape has not been checked, and
 * guessing it would trade a real policy for a plausible-looking one.
 *
 * `multifactor` WAS omitted for the same reason. The shape has now been confirmed
 * against the installed type definitions and it is set below.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },

  /**
   * ==========================================================================
   * MULTI-FACTOR AUTHENTICATION
   * ==========================================================================
   *
   * Shape verified against the INSTALLED declaration rather than recalled —
   * `@aws-amplify/auth-construct/lib/types.d.ts`:
   *
   *   type MFA = { mode: 'OFF' } | ({ mode: 'OPTIONAL' | 'REQUIRED' } & MFASettings)
   *   type MFATotpSettings = boolean
   *
   * `MFASettings` is a union requiring at least one of totp / sms / email to be
   * present, which is why `totp` is set explicitly rather than left to default.
   *
   * ── WHY OPTIONAL, NOT REQUIRED ────────────────────────────────────────────
   * Chosen by the user. OPTIONAL lets staff enrol at their own pace; REQUIRED
   * locks out anyone who has not enrolled, including on first sign-in, which
   * would strand the existing accounts. Tightening to REQUIRED later is a
   * one-word change once everyone has enrolled.
   *
   * ── WHY TOTP AND NOT SMS ──────────────────────────────────────────────────
   * TOTP is an authenticator app: no phone numbers to collect, no SNS role to
   * provision, no per-message cost, and it works for someone abroad or with no
   * signal. SMS MFA would need all of that and is the weaker factor.
   *
   * ── WHAT THIS DOES NOT PROTECT ────────────────────────────────────────────
   * This is the CONSOLE sign-in — the Cognito user pool. It has nothing to do
   * with the AWS account itself: the `emad` IAM user's access keys are a
   * separate credential and a separate decision. Enabling this does not make
   * the AWS account safer, only the sales console.
   *
   * ── WHY IT IS BEING SET NOW ───────────────────────────────────────────────
   * The console is about to be published on the internet as part of the move to
   * a branch deployment. Until now it ran on localhost and a password was the
   * whole story. A public URL holding client contact details and pricing should
   * not be one leaked password away from a stranger.
   */
  multifactor: {
    mode: 'OPTIONAL',
    totp: true,
    sms: false,
  },

  groups: ['contributor', 'approver'],
});
