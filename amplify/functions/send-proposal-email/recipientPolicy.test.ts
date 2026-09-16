import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL,
  checkRecipients,
  looksLikeAnAddress,
  normaliseAddress,
  parseAllowlist,
} from './recipientPolicy.js';

const LIST = parseAllowlist('rajaemadhussain@gmail.com');

describe('parseAllowlist', () => {
  /**
   * The single most important test in this file.
   *
   * If an unset or blank setting ever came back as "allow everything", a typo in
   * a deploy would silently permit email to real clinics. Every one of these
   * inputs must land on `none`.
   */
  it('treats anything absent, blank or meaningless as BLOCK EVERYTHING', () => {
    for (const raw of [undefined, null, '', '   ', '\t\n', ',', ',,,', ' ; , ']) {
      expect(parseAllowlist(raw)).toEqual({ kind: 'none' });
    }
  });

  it('treats * as explicitly unrestricted', () => {
    expect(parseAllowlist(ALLOW_ALL)).toEqual({ kind: 'all' });
    expect(parseAllowlist(' * ')).toEqual({ kind: 'all' });
  });

  it('does not accept lookalikes for the unrestricted switch', () => {
    // '*' is the only value that turns the guard off. Anything else that a
    // person might *mean* as "all" must not silently work.
    for (const raw of ['all', 'ALL', 'any', 'true', '**', '*.com']) {
      expect(parseAllowlist(raw).kind).not.toBe('all');
    }
  });

  it('reads a single address', () => {
    expect(parseAllowlist('rajaemadhussain@gmail.com')).toEqual({
      kind: 'list',
      addresses: ['rajaemadhussain@gmail.com'],
    });
  });

  it('accepts commas, semicolons and whitespace as separators', () => {
    const expected = { kind: 'list', addresses: ['a@x.com', 'b@y.com', 'c@z.com'] };
    expect(parseAllowlist('a@x.com,b@y.com,c@z.com')).toEqual(expected);
    expect(parseAllowlist('a@x.com; b@y.com ;c@z.com')).toEqual(expected);
    expect(parseAllowlist('a@x.com b@y.com  c@z.com')).toEqual(expected);
    expect(parseAllowlist(' a@x.com , b@y.com \n c@z.com ')).toEqual(expected);
  });

  it('lowercases stored entries so matching is case-insensitive', () => {
    expect(parseAllowlist('Raja.Emad@Gmail.COM')).toEqual({
      kind: 'list',
      addresses: ['raja.emad@gmail.com'],
    });
  });
});

describe('normaliseAddress', () => {
  it('trims and lowercases', () => {
    expect(normaliseAddress('  Reception@Clinic.CA ')).toBe('reception@clinic.ca');
  });

  it('returns an empty string for anything that is not a string', () => {
    expect(normaliseAddress(null)).toBe('');
    expect(normaliseAddress(undefined)).toBe('');
    expect(normaliseAddress('')).toBe('');
  });
});

describe('looksLikeAnAddress', () => {
  it('accepts ordinary addresses', () => {
    for (const raw of [
      'rajaemadhussain@gmail.com',
      'reception@clinic.ca',
      'first.last+tag@sub.domain.co.uk',
      '  padded@example.com  ',
    ]) {
      expect(looksLikeAnAddress(raw)).toBe(true);
    }
  });

  it('rejects the things that would break a send or a comparison', () => {
    for (const raw of [
      null,
      undefined,
      '',
      '   ',
      'no-at-sign.com',
      '@nolocal.com',
      'nodomain@',
      'two@at@signs.com',
      'has space@example.com',
      'trailing@space.com ex',
      'nodot@localhost', // unreachable from the public internet
      'dot@.leading.com',
      'dot@trailing.',
    ]) {
      expect(looksLikeAnAddress(raw), String(raw)).toBe(false);
    }
  });
});

describe('checkRecipients', () => {
  it('allows an address that is on the list', () => {
    const verdict = checkRecipients(['rajaemadhussain@gmail.com'], LIST);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.blocked).toEqual([]);
  });

  it('matches regardless of case or surrounding whitespace', () => {
    expect(checkRecipients([' RajaEmadHussain@Gmail.com '], LIST).allowed).toBe(true);
  });

  it('blocks an address that is not on the list, and says which', () => {
    const verdict = checkRecipients(['reception@realclinic.ca'], LIST);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocked).toEqual(['reception@realclinic.ca']);
    expect(verdict.reason).toContain('reception@realclinic.ca');
    // The reason is read by a human in the console. It must explain, not just refuse.
    expect(verdict.reason).toMatch(/refused on purpose/i);
    expect(verdict.reason).toMatch(/nothing was sent/i);
    /* And it must NOT explain the refusal by citing an AWS account state. This
       assertion used to require the word "sandbox"; production access was
       granted on 2026-09-16 and that sentence became false while still being
       shown to staff. A message that pins itself to an environment is a message
       that will eventually lie. */
    expect(verdict.reason).not.toMatch(/sandbox/i);
  });

  /**
   * The sandbox rejects a whole message if ANY recipient is unverified, so a
   * check that only looked at the client address would produce a failure whose
   * cause was invisible.
   */
  it('checks every recipient, not just the first', () => {
    const verdict = checkRecipients(
      ['rajaemadhussain@gmail.com', 'someone.else@elsewhere.com'],
      LIST,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocked).toEqual(['someone.else@elsewhere.com']);
  });

  it('never reports an address that passed as blocked', () => {
    const verdict = checkRecipients(
      ['rajaemadhussain@gmail.com', 'someone.else@elsewhere.com'],
      LIST,
    );
    expect(verdict.blocked).not.toContain('rajaemadhussain@gmail.com');
  });

  it('blocks everything when no list is configured', () => {
    const verdict = checkRecipients(['rajaemadhussain@gmail.com'], parseAllowlist(''));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('SES_ALLOWED_RECIPIENTS');
  });

  it('allows anything once the list is explicitly *', () => {
    const verdict = checkRecipients(
      ['reception@realclinic.ca', 'sales@aeygis.com'],
      parseAllowlist(ALLOW_ALL),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.blocked).toEqual([]);
  });

  it('still refuses a malformed address even when the list is *', () => {
    // '*' turns off WHO may be emailed. It does not turn off whether the value
    // is an address at all — SES would reject it and the failure would read as
    // a service problem rather than a bad record.
    const verdict = checkRecipients(['not-an-address'], parseAllowlist(ALLOW_ALL));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocked).toEqual(['not-an-address']);
  });

  it('refuses when the clinic has no email on record', () => {
    for (const addresses of [[], [null], [undefined], ['   ']]) {
      const verdict = checkRecipients(addresses, LIST);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/no recipient/i);
    }
  });

  it('ignores absent optional recipients rather than treating them as blocked', () => {
    // BCC is optional. An unset BCC must not block a legitimate client send.
    const verdict = checkRecipients(['rajaemadhussain@gmail.com', null], LIST);
    expect(verdict.allowed).toBe(true);
  });
});
