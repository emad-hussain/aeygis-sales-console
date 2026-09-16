import { describe, expect, it } from 'vitest';
import {
  buildAssessmentNotification,
  describeScale,
  isTestSubmission,
  money,
  present,
  singleLine,
  type AssessmentNotificationInput,
} from './notification.js';

/**
 * The notification is internal, so it may carry the whole submission. What it
 * must still get right is the two things that bite: a mail header built from
 * free text, and an honest statement of whether the lead can be priced yet.
 */

const base: AssessmentNotificationInput = {
  referenceId: 'AEY-7F3K2Q',
  status: 'needs_confirmation',
  clinicName: 'Riverside Family Practice',
  contactName: 'Alison Kerr',
  email: 'alison@example.ca',
  phone: '+1 416 555 0142',
  jobTitle: 'Practice Manager',
  organizationType: 'Family Health Team',
  organizationSize: '12 staff',
  province: 'Ontario',
  providerBand: '3-15',
  locationBand: '2-5',
  providerCount: null,
  locationCount: null,
  countsConfirmed: false,
  hosting: 'onprem',
  monthlyItSpend: 4200,
  annualHardwareEmergency: 18000,
  downtimeHoursBand: '10to40',
  downtimeCostBand: '1000to2500',
  mfa: 'no',
  backups: 'unsure',
  incidentPlan: 'no',
  lastRiskAssessment: 'never',
  submittedAt: '2026-08-25T14:03:00.000Z',
};

const withInput = (overrides: Partial<AssessmentNotificationInput>) =>
  buildAssessmentNotification({ ...base, ...overrides });

describe('isTestSubmission', () => {
  it('recognises the reserved TLD the seed and verify scripts use', () => {
    expect(isTestSubmission('riverside@aeygis-test.invalid')).toBe(true);
    expect(isTestSubmission('guest-check@example.invalid')).toBe(true);
    expect(isTestSubmission('  MIXED@Aeygis-Test.INVALID  ')).toBe(true);
  });

  it('does NOT suppress a real address', () => {
    // The whole risk of this function is a false positive: a real lead arrives,
    // nobody is told, and nothing says why.
    expect(isTestSubmission('alison@riverside.ca')).toBe(false);
    expect(isTestSubmission('someone@invalid-clinic.ca')).toBe(false);
    expect(isTestSubmission('invalid@example.com')).toBe(false);
    expect(isTestSubmission('test@aeygis-test.com')).toBe(false);
  });

  it('treats a missing address as real, so a notification is sent rather than dropped', () => {
    expect(isTestSubmission(null)).toBe(false);
    expect(isTestSubmission(undefined)).toBe(false);
    expect(isTestSubmission('')).toBe(false);
  });
});

describe('singleLine', () => {
  it('replaces control characters with a space rather than deleting them', () => {
    // Deleting would join the words: "Bay StreetClinic".
    expect(singleLine('Bay Street\tClinic')).toBe('Bay Street Clinic');
    expect(singleLine('Bay Street\nClinic')).toBe('Bay Street Clinic');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(singleLine('  Riverside     Family  ')).toBe('Riverside Family');
  });

  it('strips a carriage return, which is the header-injection shape', () => {
    expect(singleLine('Clinic\r\nBcc: attacker@example.com')).not.toContain('\r');
    expect(singleLine('Clinic\r\nBcc: attacker@example.com')).not.toContain('\n');
  });
});

describe('present', () => {
  it('renders a dash for anything absent', () => {
    expect(present(null)).toBe('—');
    expect(present(undefined)).toBe('—');
    expect(present('')).toBe('—');
    expect(present('   ')).toBe('—');
  });

  it('renders numbers', () => {
    expect(present(0)).toBe('0');
    expect(present(12)).toBe('12');
  });

  it('truncates a very long value so one pasted essay cannot bury the rest', () => {
    const long = 'x'.repeat(500);
    const rendered = present(long);
    expect(rendered.length).toBeLessThan(long.length);
    expect(rendered.endsWith('…')).toBe(true);
  });
});

describe('money', () => {
  it('formats CAD in whole dollars', () => {
    expect(money(4200)).toBe('CAD 4,200');
    expect(money(4200.7)).toBe('CAD 4,201');
  });

  it('renders a dash rather than NaN or zero for a missing figure', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(Number.NaN)).toBe('—');
  });
});

describe('describeScale', () => {
  it('says BANDS ONLY and what to do when counts are not confirmed', () => {
    const line = describeScale(base);
    expect(line).toContain('BANDS ONLY');
    expect(line).toContain('Confirm exact counts');
    expect(line).toContain('3-15');
    expect(line).toContain('2-5');
  });

  it('says it can be priced when exact counts were supplied', () => {
    const line = describeScale({
      ...base,
      countsConfirmed: true,
      providerCount: 6,
      locationCount: 3,
    });
    expect(line).toContain('6 provider(s)');
    expect(line).toContain('3 location(s)');
    expect(line).toContain('can be priced now');
    expect(line).not.toContain('BANDS ONLY');
  });

  it('does NOT claim priceable when the flag is set but a count is missing', () => {
    // countsConfirmed is derived server-side, but this module must not trust it
    // blindly — claiming a lead is priceable when it is not sends someone to a
    // console screen that refuses.
    const line = describeScale({ ...base, countsConfirmed: true, providerCount: 6, locationCount: null });
    expect(line).toContain('BANDS ONLY');
  });
});

describe('buildAssessmentNotification', () => {
  it('puts the organization and the reference in the subject', () => {
    const { subject } = withInput({});
    expect(subject).toContain('Riverside Family Practice');
    expect(subject).toContain('AEY-7F3K2Q');
  });

  it('keeps the subject on ONE line even when the clinic name carries newlines', () => {
    const { subject } = withInput({ clinicName: 'Evil\r\nBcc: attacker@example.com' });
    expect(subject).not.toContain('\n');
    expect(subject).not.toContain('\r');
  });

  it('falls back to a readable subject when no organization was given', () => {
    const { subject } = withInput({ clinicName: null });
    expect(subject).toContain('unnamed organization');
    expect(subject).toContain('AEY-7F3K2Q');
  });

  it('carries every contact field, because this is internal', () => {
    const { text } = withInput({});
    for (const value of [
      'AEY-7F3K2Q',
      'Alison Kerr',
      'alison@example.ca',
      '+1 416 555 0142',
      'Practice Manager',
      'Family Health Team',
      'Ontario',
    ]) {
      expect(text).toContain(value);
    }
  });

  it('states the status and the scale caveat in the body', () => {
    const { text } = withInput({});
    expect(text).toContain('needs_confirmation');
    expect(text).toContain('BANDS ONLY');
  });

  it('renders missing values as dashes rather than "null" or "undefined"', () => {
    const { text } = withInput({
      phone: null,
      jobTitle: null,
      province: null,
      monthlyItSpend: null,
      annualHardwareEmergency: null,
    });
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(text).toContain('—');
  });

  it('says plainly that it is a notification and not the record', () => {
    // So nobody treats a forwarded email as the lead and works from a stale copy.
    const { text } = withInput({});
    expect(text.toLowerCase()).toContain('not the record');
  });

  it('never states a price', () => {
    /* The notification exists to say a lead arrived, not to quote it. Pricing
       needs confirmed counts and a support plan, neither of which exists at
       submission time. A figure here would be a guess that then gets repeated. */
    const { text } = withInput({});
    expect(text).not.toMatch(/\$\s?\d/);
    for (const word of ['setup fee', 'per month', 'quote', 'Micro', 'Starter', 'Professional']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('dropped fields notice', () => {
  it('says nothing at all when everything was stored', () => {
    // The overwhelmingly common case. An alarming line that appears on every
    // notification is a line nobody reads on the one that matters.
    expect(buildAssessmentNotification(base).text).not.toMatch(/HEADS UP/);
    expect(buildAssessmentNotification({ ...base, droppedFields: [] }).text).not.toMatch(/HEADS UP/);
    expect(buildAssessmentNotification({ ...base, droppedFields: null }).text).not.toMatch(/HEADS UP/);
  });

  it('names the fields that did not make it into the console', () => {
    const { text } = buildAssessmentNotification({ ...base, droppedFields: ['jobTitle', 'phone'] });
    expect(text).toMatch(/HEADS UP/);
    expect(text).toContain('jobTitle, phone');
  });

  it('puts the notice first, where it cannot be skimmed past', () => {
    const { text } = buildAssessmentNotification({ ...base, droppedFields: ['phone'] });
    // Below forty lines of data, a warning about missing data is decoration.
    expect(text.split('\n')[0]).toMatch(/HEADS UP/);
  });
});
