import { describe, expect, it } from 'vitest';
import { ESSENTIAL_FIELDS, fieldsNamedInErrors, salvageRecord } from './salvage.js';

/**
 * These tests exist because the real thing already happened. On 2026-08-26 an
 * ordinary phone number destroyed two leads, and every test in the suite stayed
 * green because every fixture used a phone format the schema happened to like.
 *
 * So the first test below is the exact AppSync error string from that incident,
 * copied out of CloudWatch rather than written from memory.
 */

/** A record shaped like the one handler.ts builds. */
const record = () => ({
  referenceId: 'AEY-5BFZSX',
  source: 'health_site_live_form',
  status: 'needs_confirmation',
  submittedAt: '2026-08-26T15:15:00.000Z',
  consentedAt: '2026-08-26T15:15:00.000Z',
  consent: true,
  countsConfirmed: false,
  email: 'chief@clinic.example',
  clinicName: 'Riverside Family Health',
  contactName: 'Dana Okafor',
  phone: '(416) 555-1234 ext 22',
  jobTitle: 'Practice Manager',
  province: 'ON',
  submitterIpHash: 'abc123',
});

/** The literal error CloudWatch recorded for AEY-5BFZSX. */
const REAL_ERROR = [{ path: null, locations: [], message: "Variable 'phone' has an invalid value." }];

describe('fieldsNamedInErrors', () => {
  it('extracts the field from the error that actually lost us two leads', () => {
    expect(fieldsNamedInErrors(REAL_ERROR)).toEqual(['phone']);
  });

  it('finds every variable named across several errors, without duplicates', () => {
    const names = fieldsNamedInErrors([
      { message: "Variable 'phone' has an invalid value." },
      { message: "Variable 'email' has an invalid value." },
      { message: "Variable 'phone' has an invalid value." },
    ]);
    expect(names.sort()).toEqual(['email', 'phone']);
  });

  it('finds two variables named in a single message', () => {
    expect(
      fieldsNamedInErrors([
        { message: "Variable 'phone' has an invalid value. Variable 'jobTitle' has an invalid value." },
      ]).sort(),
    ).toEqual(['jobTitle', 'phone']);
  });

  it('returns nothing rather than guessing when the wording is unfamiliar', () => {
    // The fallback path depends on this being EMPTY, not on it being clever.
    expect(fieldsNamedInErrors([{ message: 'DynamoDB:ConditionalCheckFailedException' }])).toEqual([]);
  });

  it('survives errors that are not objects, or have no message at all', () => {
    expect(fieldsNamedInErrors(['a string', null, undefined, 42, {}])).toEqual([]);
  });
});

describe('salvageRecord — the targeted path', () => {
  it('drops only the offending field and keeps the rest of the lead', () => {
    const result = salvageRecord(record(), REAL_ERROR);

    expect(result).not.toBeNull();
    expect(result?.dropped).toEqual(['phone']);
    expect(result?.targeted).toBe(true);
    expect(result?.record).not.toHaveProperty('phone');

    // The point of the targeted path: everything else survives untouched.
    expect(result?.record.clinicName).toBe('Riverside Family Health');
    expect(result?.record.jobTitle).toBe('Practice Manager');
    expect(result?.record.province).toBe('ON');
  });

  it('never mutates the record it was given', () => {
    const original = record();
    salvageRecord(original, REAL_ERROR);
    expect(original.phone).toBe('(416) 555-1234 ext 22');
  });

  it('refuses to salvage when the only blamed field is essential', () => {
    // A lead with no email cannot be followed up, so storing one would be
    // pretending to have saved something we did not.
    const result = salvageRecord(record(), [{ message: "Variable 'email' has an invalid value." }]);
    expect(result).toBeNull();
  });

  it('drops the optional field and keeps the essential one when both are blamed', () => {
    const result = salvageRecord(record(), [
      { message: "Variable 'email' has an invalid value." },
      { message: "Variable 'phone' has an invalid value." },
    ]);
    // email stays: dropping it cannot help, and losing it makes the lead dead.
    expect(result?.dropped).toEqual(['phone']);
    expect(result?.record).toHaveProperty('email');
  });

  it('ignores a named field the record does not even have', () => {
    const result = salvageRecord(record(), [{ message: "Variable 'nonsense' has an invalid value." }]);
    // Nothing real was blamed, so it falls through to the blunt path.
    expect(result?.targeted).toBe(false);
  });
});

describe('salvageRecord — the blunt fallback', () => {
  it('keeps exactly the essential fields when no field could be identified', () => {
    const result = salvageRecord(record(), [{ message: 'something entirely unfamiliar' }]);

    expect(result).not.toBeNull();
    expect(result?.targeted).toBe(false);

    const kept = Object.keys(result?.record ?? {}).sort();
    const expected = ESSENTIAL_FIELDS.filter((f) => f in record()).sort();
    expect(kept).toEqual([...expected]);
  });

  it('reports every field it threw away, so the log names them', () => {
    const result = salvageRecord(record(), [{ message: 'unfamiliar' }]);
    expect(result?.dropped).toEqual(['jobTitle', 'phone', 'province', 'submitterIpHash']);
  });

  it('still keeps consent and its timestamp — the record is worthless without them', () => {
    const result = salvageRecord(record(), [{ message: 'unfamiliar' }]);
    expect(result?.record.consent).toBe(true);
    expect(result?.record.consentedAt).toBe('2026-08-26T15:15:00.000Z');
  });

  it('gives up when there is nothing optional left to drop', () => {
    // A second failure on an already-minimal record must not loop.
    const minimal = Object.fromEntries(ESSENTIAL_FIELDS.map((f) => [f, 'x']));
    expect(salvageRecord(minimal, [{ message: 'unfamiliar' }])).toBeNull();
  });
});

describe('the essential list itself', () => {
  it('contains every field the schema marks required', () => {
    // If one of these is ever dropped, the salvage retry is guaranteed to fail
    // too — the whole mechanism would be dead weight.
    for (const required of ['referenceId', 'source', 'status', 'submittedAt', 'countsConfirmed', 'consent']) {
      expect(ESSENTIAL_FIELDS).toContain(required);
    }
  });

  it('contains the fields that make a row worth calling a lead', () => {
    for (const commercial of ['email', 'clinicName', 'contactName']) {
      expect(ESSENTIAL_FIELDS).toContain(commercial);
    }
  });

  it('does NOT protect phone — the field this whole module was built for', () => {
    expect(ESSENTIAL_FIELDS).not.toContain('phone');
  });
});
