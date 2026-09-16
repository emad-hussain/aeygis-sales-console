import { describe, expect, it } from 'vitest';
import { IdentityError, isApprover, isDecision, readIdentity } from './identity.js';

/**
 * The approval gate's identity parsing.
 *
 * This decides who is recorded as having approved a client-facing price, in an
 * immutable audit record. A wrong or empty actor here makes the trail worthless
 * exactly when someone needs to rely on it — so the tests lean on the refusal
 * cases rather than the happy path.
 */

describe('readIdentity refuses rather than guessing', () => {
  it.each([null, undefined, 'a-string', 42, [], {}])('throws on %s', (value) => {
    expect(() => readIdentity(value)).toThrow(IdentityError);
  });

  it('throws when a subject is absent, even if other fields look fine', () => {
    expect(() => readIdentity({ claims: { email: 'someone@aeygis.com' }, groups: ['approver'] })).toThrow(
      /no subject/i,
    );
  });

  it('treats a blank or whitespace subject as absent', () => {
    expect(() => readIdentity({ sub: '' })).toThrow(IdentityError);
    expect(() => readIdentity({ sub: '   ' })).toThrow(IdentityError);
  });
});

describe('readIdentity accepts the shapes AppSync actually sends', () => {
  it('reads a top-level sub', () => {
    expect(readIdentity({ sub: 'abc' }).sub).toBe('abc');
  });

  it('reads a sub from claims (Cognito user pool shape)', () => {
    const caller = readIdentity({
      claims: { sub: 'xyz', email: 'emad@aeygis.com', 'cognito:groups': ['approver'] },
    });
    expect(caller.sub).toBe('xyz');
    expect(caller.email).toBe('emad@aeygis.com');
    expect(caller.groups).toEqual(['approver']);
  });

  it('falls back to username when no sub is present', () => {
    expect(readIdentity({ username: 'emad' }).sub).toBe('emad');
  });

  it('reads groups from a top-level array as well as from claims', () => {
    expect(readIdentity({ sub: 'a', groups: ['approver', 'contributor'] }).groups).toEqual([
      'approver',
      'contributor',
    ]);
  });

  it('deduplicates groups and drops non-strings and blanks', () => {
    const caller = readIdentity({ sub: 'a', groups: ['approver', 'approver', '', 7, null, ' '] });
    expect(caller.groups).toEqual(['approver']);
  });

  it('returns an empty group list rather than throwing when groups are absent', () => {
    // A groupless caller is a legitimate state — they are simply not an approver.
    expect(readIdentity({ sub: 'a' }).groups).toEqual([]);
  });

  it('ignores a malformed claims value instead of crashing', () => {
    expect(readIdentity({ sub: 'a', claims: 'not-an-object' }).email).toBeNull();
    expect(readIdentity({ sub: 'a', claims: ['nope'] }).groups).toEqual([]);
  });

  it('returns null email rather than an empty string', () => {
    expect(readIdentity({ sub: 'a', claims: { email: '' } }).email).toBeNull();
  });
});

describe('isApprover', () => {
  it('is true only for the approver group', () => {
    expect(isApprover({ sub: 'a', email: null, groups: ['approver'] })).toBe(true);
    expect(isApprover({ sub: 'a', email: null, groups: ['approver', 'contributor'] })).toBe(true);
  });

  it('is false for a contributor and for no groups', () => {
    expect(isApprover({ sub: 'a', email: null, groups: ['contributor'] })).toBe(false);
    expect(isApprover({ sub: 'a', email: null, groups: [] })).toBe(false);
  });

  it('is not fooled by a similar group name', () => {
    // Guards against a substring or prefix check creeping in later.
    for (const g of ['approvers', 'Approver', 'approver-readonly', 'super-approver']) {
      expect(isApprover({ sub: 'a', email: null, groups: [g] }), g).toBe(false);
    }
  });
});

describe('isDecision', () => {
  it('accepts exactly the two known decisions', () => {
    expect(isDecision('approved')).toBe(true);
    expect(isDecision('rejected')).toBe(true);
  });

  it.each(['Approved', 'APPROVED', 'approve', 'yes', '', null, undefined, 1, true])(
    'rejects %s',
    (value) => {
      expect(isDecision(value)).toBe(false);
    },
  );
});
