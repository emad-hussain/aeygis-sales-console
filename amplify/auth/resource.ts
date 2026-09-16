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
 * Deliberately omitted for now: `multifactor` and `accountRecovery`. Their
 * option shapes were not verifiable against current docs, and guessing them
 * would trade a real MFA policy for a plausible-looking one. Add them once the
 * shapes are confirmed against the installed .d.ts — tracked in
 * docs/PROJECT-STATUS.md under unverified claims.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['contributor', 'approver'],
});
