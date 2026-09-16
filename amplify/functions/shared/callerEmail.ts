import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CallerIdentity } from './identity.js';

/**
 * ============================================================================
 * Fills in the caller's email address, which the request does not carry.
 * ============================================================================
 *
 * WHY THIS IS NECESSARY AT ALL
 *
 * Amplify's data client sends the COGNITO ACCESS TOKEN for `authMode:
 * 'userPool'`. Verified in the installed source —
 * @aws-amplify/api-graphql/dist/esm/internals/graphqlAuth.mjs:
 *
 *     case 'oidc':
 *     case 'userPool': {
 *         token = (await amplify.Auth.fetchAuthSession()).tokens?.accessToken...
 *
 * and confirmed by decoding both tokens for a real signed-in user:
 *
 *     ID token      -> sub, email, cognito:groups
 *     ACCESS token  -> sub, cognito:groups, username   (NO email)
 *
 * That is exactly the split observed in the data: group checks work, and every
 * audit record's actorEmail is null. It is not a bug in readIdentity and not a
 * Cognito misconfiguration — the address is simply never sent.
 *
 * Sending the ID token instead is not an option worth taking: the switch above
 * hard-codes the access token for this auth mode, and the paths that honour a
 * custom token are different auth modes, which changes how AppSync validates
 * the request. That is fighting the framework to obtain something a single
 * lookup provides.
 *
 * WHY RESOLVE IT AT WRITE TIME RATHER THAN AT READ TIME
 *
 * The same reason `Approval.decidedByGroups` is snapshotted rather than
 * resolved when someone opens the screen: an audit record must say what was
 * true AT THE MOMENT OF THE ACT. A user can be renamed or deleted; resolving
 * their address later would quietly rewrite history, or lose it.
 *
 * WHY IT IS A SEPARATE FILE FROM identity.ts
 *
 * `identity.ts` is PURE on purpose — importing a handler would require AWS
 * credentials, and a security check that cannot be tested is a security check
 * that does not get tested. This file makes an AWS call, so it stays out of
 * there. Everything in here that CAN be pure is, and is tested.
 *
 * FAILURE IS NEVER FATAL. If the lookup fails the caller is returned unchanged,
 * with a null email. Losing a convenience field must not block an approval or
 * abandon an email that was already sent.
 */

const cognito = new CognitoIdentityProviderClient({});

/**
 * Pulls `email` out of Cognito's attribute list shape.
 *
 * Pure, so the parsing is tested without credentials. Cognito returns
 * attributes as [{Name, Value}], and both fields are optional in the SDK types
 * — hence the defensive read rather than a find-and-index.
 */
export function emailFromAttributes(
  attributes: readonly { readonly Name?: string | undefined; readonly Value?: string | undefined }[] | undefined,
): string | null {
  if (attributes === undefined) return null;
  for (const attribute of attributes) {
    if (attribute.Name === 'email') {
      const value = attribute.Value;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

/**
 * The Cognito filter that finds a user by their subject.
 *
 * Pure and separately tested because a malformed filter does not error — it
 * returns NO USERS, which is indistinguishable from "this user is gone" and
 * would silently reinstate the null-email behaviour this file exists to fix.
 *
 * `sub` is used rather than AdminGetUser-by-username deliberately. On this pool
 * the username happens to equal the sub, so AdminGetUser would work today; but
 * that is a property of how these users were created, not a guarantee, and a
 * user made another way would break it. The sub is the only identifier the
 * request actually carries.
 */
export function subFilter(sub: string): string {
  // Cognito filter values are double-quoted; a quote inside would break the
  // expression. A sub is a UUID, so this cannot legitimately happen — refusing
  // is safer than emitting a filter that means something else.
  if (sub.includes('"') || sub.includes('\\')) {
    throw new Error('Refusing to build a Cognito filter from a subject containing quotes');
  }
  return `sub = "${sub}"`;
}

/**
 * Returns the caller with `email` populated where it can be found.
 *
 * Never throws. Returns the input unchanged when the address cannot be
 * resolved, so the audit record still carries the subject — which identifies
 * the actor uniquely and permanently, just not readably.
 */
export async function withCallerEmail(
  caller: CallerIdentity,
  userPoolId: string | undefined,
): Promise<CallerIdentity> {
  // Already present. Costs nothing today, and means this silently stops making
  // a call at all if Amplify ever starts sending the ID token.
  if (caller.email !== null) return caller;

  if (userPoolId === undefined || userPoolId.trim() === '') {
    console.warn('[identity] AEYGIS_USER_POOL_ID is not set; audit records will carry no email');
    return caller;
  }

  try {
    const result = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: subFilter(caller.sub),
        Limit: 1,
      }),
    );

    const email = emailFromAttributes(result.Users?.[0]?.Attributes);
    if (email === null) {
      console.warn('[identity] no email found for subject', { sub: caller.sub });
      return caller;
    }
    return { ...caller, email };
  } catch (error) {
    console.error('[identity] email lookup failed; recording the subject only', {
      sub: caller.sub,
      error: error instanceof Error ? error.message : String(error),
    });
    return caller;
  }
}
