import { describe, expect, it } from 'vitest';
import { emailFromAttributes, subFilter } from './callerEmail.js';

describe('emailFromAttributes', () => {
  it('finds the email among other attributes', () => {
    expect(
      emailFromAttributes([
        { Name: 'sub', Value: '0c9d1538-3001-7086-cc74-647707c16b4b' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'email', Value: 'test-approver@aeygis-test.invalid' },
      ]),
    ).toBe('test-approver@aeygis-test.invalid');
  });

  it('trims surrounding whitespace', () => {
    expect(emailFromAttributes([{ Name: 'email', Value: '  a@b.com ' }])).toBe('a@b.com');
  });

  /**
   * Both fields are optional in the SDK types, and a blank value is not an
   * address. Returning '' would put an empty string in an audit record, which
   * reads as "we know it was nobody" rather than "we could not find out".
   */
  it('returns null rather than an empty string for anything unusable', () => {
    expect(emailFromAttributes(undefined)).toBeNull();
    expect(emailFromAttributes([])).toBeNull();
    expect(emailFromAttributes([{ Name: 'sub', Value: 'x' }])).toBeNull();
    expect(emailFromAttributes([{ Name: 'email' }])).toBeNull();
    expect(emailFromAttributes([{ Name: 'email', Value: '' }])).toBeNull();
    expect(emailFromAttributes([{ Name: 'email', Value: '   ' }])).toBeNull();
    expect(emailFromAttributes([{ Value: 'orphan@example.com' }])).toBeNull();
  });

  it('does not confuse a similarly named attribute for the email', () => {
    expect(
      emailFromAttributes([
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:email_alt', Value: 'wrong@example.com' },
      ]),
    ).toBeNull();
  });
});

describe('subFilter', () => {
  it('builds the Cognito filter expression', () => {
    expect(subFilter('0c9d1538-3001-7086-cc74-647707c16b4b')).toBe(
      'sub = "0c9d1538-3001-7086-cc74-647707c16b4b"',
    );
  });

  /**
   * A malformed filter does NOT error at Cognito — it returns no users, which
   * is indistinguishable from "this user is gone". That would silently restore
   * the null-email behaviour this module exists to fix, so a subject that could
   * break the expression is refused loudly instead.
   */
  it('refuses a subject that would break the expression', () => {
    expect(() => subFilter('abc" or sub = "def')).toThrow(/refusing/i);
    expect(() => subFilter('back\\slash')).toThrow(/refusing/i);
  });

  it('accepts an ordinary UUID subject', () => {
    expect(() => subFilter('11111111-2222-3333-4444-555555555555')).not.toThrow();
  });
});
