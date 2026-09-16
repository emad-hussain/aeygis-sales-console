/**
 * Caller identity parsing for the Lambda-backed mutations.
 *
 * Extracted from handler.ts so it can be unit-tested. A handler calls
 * `getAmplifyDataClientConfig` at module load, so importing one in a test would
 * require AWS credentials — and a security check that cannot be tested without
 * credentials is a security check that does not get tested.
 *
 * SHARED rather than living beside one handler: both decide-proposal and
 * delete-proposal-version re-derive the caller from the request identity in
 * order to write an audit record. Two copies of identity parsing means two
 * places for the rule and the recorded evidence to drift apart.
 *
 * Everything here is pure.
 */

export const DECISIONS = ['approved', 'rejected'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface CallerIdentity {
  readonly sub: string;
  readonly email: string | null;
  readonly groups: readonly string[];
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * Reads the caller from an AppSync Lambda-resolver event.
 *
 * DEFENSIVE BY DESIGN. Only `event.arguments` is documented for Lambda
 * resolvers; `event.identity` shape is not, and it differs between Cognito user
 * pool, IAM and OIDC auth modes. So every field is probed rather than assumed,
 * and a missing subject THROWS instead of defaulting.
 *
 * Refusing to guess matters here: this identity is written into an immutable
 * audit record. An empty or invented actor would make the trail worthless
 * precisely when someone needs to rely on it.
 */
export function readIdentity(identity: unknown): CallerIdentity {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw new IdentityError('No caller identity on the request; refusing to record a decision');
  }

  const record = identity as Record<string, unknown>;
  const rawClaims = record['claims'];
  const claims: Record<string, unknown> =
    typeof rawClaims === 'object' && rawClaims !== null && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)
      : {};

  const firstString = (...candidates: unknown[]): string | null => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() !== '') return c;
    }
    return null;
  };

  const sub = firstString(record['sub'], claims['sub'], record['username'], claims['username']);
  if (sub === null) {
    throw new IdentityError('Caller identity carries no subject; refusing to record a decision');
  }

  const email = firstString(claims['email'], record['email']);

  // Cognito exposes groups as `cognito:groups` in the claims, and AppSync also
  // surfaces a top-level `groups` array. Accept either; never merge silently
  // beyond deduplication.
  const rawGroups = record['groups'] ?? claims['cognito:groups'];
  const groups = Array.isArray(rawGroups)
    ? [...new Set(rawGroups.filter((g): g is string => typeof g === 'string' && g.trim() !== ''))]
    : [];

  return { sub, email, groups };
}

/** True only for an exact, known decision value. */
export function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

/**
 * Whether the caller may decide a proposal.
 *
 * Kept separate from `readIdentity` so the group requirement is one obvious line
 * rather than a condition buried in a handler.
 */
export function isApprover(caller: CallerIdentity): boolean {
  return caller.groups.includes('approver');
}

/**
 * Whether the caller holds either staff role.
 *
 * Used by delete-proposal-version, which is open to contributors as well —
 * clearing out draft versions is drafting work. Kept as its own named predicate
 * rather than an inline `.some(...)` so the two different bars (any staff vs.
 * approver only) are impossible to confuse at a call site.
 */
export function isStaff(caller: CallerIdentity): boolean {
  return caller.groups.includes('contributor') || caller.groups.includes('approver');
}
