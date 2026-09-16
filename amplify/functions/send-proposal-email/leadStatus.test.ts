import { describe, expect, it } from 'vitest';
import { ASSESSMENT_STATUSES } from '@aeygis/domain';
import {
  KNOWN_EARLIER_STATUSES,
  STATUSES_A_SEND_LEAVES_ALONE,
  shouldAdvanceToProposed,
} from './leadStatus.js';

describe('shouldAdvanceToProposed', () => {
  it('advances every status that precedes a proposal going out', () => {
    for (const status of ['new', 'needs_confirmation', 'in_review']) {
      expect(shouldAdvanceToProposed(status), `${status} should advance`).toBe(true);
    }
  });

  it('leaves a lead that is already proposed alone', () => {
    // Not harmful, just noise in a record people read to see what changed.
    expect(shouldAdvanceToProposed('proposed')).toBe(false);
  });

  it('will not reopen a closed lead', () => {
    // Somebody decided this lead was over. Sending a proposal is not a way to
    // reverse that without anyone noticing.
    expect(shouldAdvanceToProposed('closed')).toBe(false);
  });

  it('does nothing for an absent or empty status', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(shouldAdvanceToProposed(value), `${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('does nothing for a non-string', () => {
    for (const value of [42, {}, [], true]) {
      expect(shouldAdvanceToProposed(value as unknown as string)).toBe(false);
    }
  });

  it('refuses an unrecognised status rather than guessing', () => {
    // The important half of the rule. A status this was never written against
    // belongs to somebody else's intent, and overwriting it is worse than
    // leaving a lead reading slightly stale.
    for (const status of ['on_hold', 'qualified', 'archived', 'PROPOSED_LATER']) {
      expect(shouldAdvanceToProposed(status), `${status} must not advance`).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(shouldAdvanceToProposed('  In_Review ')).toBe(true);
    expect(shouldAdvanceToProposed('CLOSED')).toBe(false);
  });
});

describe('the two lists together', () => {
  it('cover every status the model actually defines', () => {
    // If a status is added to the domain and nobody decides which side it falls
    // on, this fails rather than letting the function quietly do nothing for it.
    const covered = new Set([...KNOWN_EARLIER_STATUSES, ...STATUSES_A_SEND_LEAVES_ALONE]);
    const uncovered = ASSESSMENT_STATUSES.filter((s) => !covered.has(s));
    expect(uncovered, `undecided status(es): ${uncovered.join(', ')}`).toEqual([]);
  });

  it('do not overlap — a status cannot both advance and be left alone', () => {
    const both = KNOWN_EARLIER_STATUSES.filter((s) => STATUSES_A_SEND_LEAVES_ALONE.includes(s));
    expect(both).toEqual([]);
  });

  it('never advances to a status that is not itself valid', () => {
    // The function exists to set 'proposed'. If that stopped being a real
    // status, every advance would be writing a value the model rejects.
    expect(ASSESSMENT_STATUSES).toContain('proposed');
  });
});
