import { describe, expect, it } from 'vitest';
import { isHoneypotTripped, phone, validateSubmission } from './validate.js';

/** A minimal submission that should pass. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'manager@clinic.example.ca',
    consent: true,
    ...overrides,
  };
}

describe('consent', () => {
  it('rejects a submission with no consent field', () => {
    const result = validateSubmission({ email: 'a@b.ca' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/consent/);
  });

  it('rejects truthy-but-not-true consent values', () => {
    // Storing a prospect without recorded consent is the one thing this
    // endpoint must never do, so coercion is deliberately not allowed.
    for (const value of ['true', 1, 'yes', {}, []]) {
      const result = validateSubmission(base({ consent: value }));
      expect(result.ok, `consent=${JSON.stringify(value)} must not pass`).toBe(false);
    }
  });

  it('accepts explicit boolean true', () => {
    expect(validateSubmission(base()).ok).toBe(true);
  });
});

describe('email', () => {
  it.each([
    'no-at-sign',
    'two@@at.ca',
    'trailing@dot.',
    'no-dot@domain',
    'spaces in@email.ca',
    '@leading.ca',
  ])('rejects %s', (value) => {
    expect(validateSubmission(base({ email: value })).ok).toBe(false);
  });

  it('lowercases a valid address', () => {
    const result = validateSubmission(base({ email: 'Office@Clinic.CA' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe('office@clinic.ca');
  });
});

describe('bands and counts', () => {
  it('widens a provider band into a range and leaves counts unconfirmed', () => {
    const result = validateSubmission(base({ providers: '3-15' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerCountMin).toBe(3);
    expect(result.value.providerCountMax).toBe(15);
    expect(result.value.providerCount).toBeNull();
    expect(result.value.countsConfirmed).toBe(false);
  });

  it('warns that a tier-spanning band needs an exact count', () => {
    // "3-15" covers all of Professional AND touches Enterprise at 15, so it
    // cannot determine a tier. This warning is the reason the record is parked.
    const result = validateSubmission(base({ providers: '3-15' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.join()).toMatch(/more than one pricing tier/);
  });

  it('treats "15+" as unambiguous', () => {
    const result = validateSubmission(base({ providers: '15+' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join()).not.toMatch(/provider band/);
      expect(result.value.providerCountMax).toBeNull();
    }
  });

  it('confirms counts only when BOTH exact figures are present', () => {
    const onlyProviders = validateSubmission(base({ providerCount: 6 }));
    expect(onlyProviders.ok && onlyProviders.value.countsConfirmed).toBe(false);

    const both = validateSubmission(base({ providerCount: 6, locationCount: 2 }));
    expect(both.ok && both.value.countsConfirmed).toBe(true);
  });

  it('discards an unrecognized band with a warning rather than failing', () => {
    const result = validateSubmission(base({ providers: '4-7' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerBand).toBeNull();
      expect(result.warnings.join()).toMatch(/unrecognized provider band/);
    }
  });

  it('rejects a zero or negative provider count', () => {
    for (const value of [0, -3]) {
      const result = validateSubmission(base({ providerCount: value }));
      expect(result.ok && result.value.providerCount).toBeNull();
    }
  });
});

describe('enums', () => {
  it('keeps known values and drops unknown ones', () => {
    const good = validateSubmission(base({ hosting: 'onprem', mfa: 'unsure' }));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.hosting).toBe('onprem');
      expect(good.value.mfa).toBe('unsure');
    }

    const bad = validateSubmission(base({ hosting: 'azure', mfa: 'maybe' }));
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      expect(bad.value.hosting).toBeNull();
      expect(bad.value.mfa).toBeNull();
    }
  });

  it('accepts the live form values that are illegal GraphQL enum members', () => {
    // "1-2yr" has a hyphen and starts with a digit, so it cannot be an enum
    // member. It must still round-trip as a validated string.
    const result = validateSubmission(base({ lastRiskAssessment: '1-2yr' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lastRiskAssessment).toBe('1-2yr');
  });
});

describe('string hardening', () => {
  it('strips control and bidi-override characters', () => {
    const nasty = 'Clinic\u0000\u202eEvil\u200b Name';
    const result = validateSubmission(base({ clinicName: nasty }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clinicName).toBe('ClinicEvil Name');
      expect(result.value.clinicName).not.toMatch(/[\u0000\u202e\u200b]/);
    }
  });

  it('caps long strings', () => {
    const result = validateSubmission(base({ clinicName: 'x'.repeat(5000) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clinicName?.length).toBe(200);
  });

  it('normalizes whitespace and treats blank as absent', () => {
    const result = validateSubmission(base({ clinicName: '  Bay   Street\t\tClinic ', jobTitle: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clinicName).toBe('Bay Street Clinic');
      expect(result.value.jobTitle).toBeNull();
    }
  });
});

describe('spend', () => {
  it('accepts numeric strings from form inputs', () => {
    const result = validateSubmission(base({ monthlyItSpend: '4200' }));
    expect(result.ok && result.value.monthlyItSpend).toBe(4200);
  });

  it('drops implausible and non-finite values', () => {
    for (const value of [-1, 1e12, 'abc', Infinity, NaN]) {
      const result = validateSubmission(base({ monthlyItSpend: value }));
      expect(result.ok && result.value.monthlyItSpend).toBeNull();
    }
  });
});

describe('payload shape', () => {
  it.each([null, undefined, 'string', 42, []])('rejects non-object payload %s', (value) => {
    expect(validateSubmission(value).ok).toBe(false);
  });
});

describe('honeypot', () => {
  it('trips on any value in the trap field', () => {
    expect(isHoneypotTripped({ _websiteUrl: 'http://spam.example' })).toBe(true);
  });

  it('does not trip when blank, whitespace, or absent', () => {
    expect(isHoneypotTripped({ _websiteUrl: '' })).toBe(false);
    expect(isHoneypotTripped({ _websiteUrl: '   ' })).toBe(false);
    expect(isHoneypotTripped({})).toBe(false);
    expect(isHoneypotTripped(null)).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PHONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file had no phone test at all until 2026-08-26, which is precisely how
 * the bug survived: `phone` was declared a.phone() (AppSync's AWSPhone scalar,
 * digits with spaces or hyphens only), the validator never checked the format,
 * and every fixture in the repo happened to use "+1 416 555 0100". The suite
 * was green while the live form threw real leads away.
 *
 * So the formats below are the messy ones a person actually types. The rule
 * they all check is the same: NOTHING a visitor puts in an optional field may
 * cost us the submission.
 */
describe('phone', () => {
  const REAL_WORLD = [
    '(416) 555-1234',           // parentheses — rejected by AWSPhone
    '416.555.1234',             // dots — rejected by AWSPhone
    '416-555-1234 ext 22',      // extension — rejected by AWSPhone
    '+1 (416) 555-1234',        // country code AND parentheses
    '416 555 1234',             // the format that always worked
    '+1-416-555-1234',
    '4165551234',
    '1 (800) EXAMPLE',          // vanity number, letters and all
    '+44 20 7946 0958',         // international
    '416-555-1234 / 416-555-9999',
  ];

  it('stores every format a real person types, and warns about none of them', () => {
    for (const raw of REAL_WORLD) {
      const result = phone(raw);
      expect(result.value, `"${raw}" must be stored`).not.toBeNull();
    }
  });

  it('keeps the extension instead of tidying it away', () => {
    // A human is going to dial this. "ext 22" is the useful part.
    expect(phone('416-555-1234 ext 22').value).toBe('416-555-1234 ext 22');
  });

  it('does not reformat a number that was already fine', () => {
    expect(phone('+1 416 555 0100').value).toBe('+1 416 555 0100');
  });

  it('treats absent, blank and non-string values as simply not given', () => {
    for (const raw of [undefined, null, '', '   ', 42, {}, []]) {
      const result = phone(raw);
      expect(result.value, `${JSON.stringify(raw)} should be null`).toBeNull();
      expect(result.warning).toBeNull();
    }
  });

  it('collapses whitespace and strips control characters', () => {
    expect(phone('  416\u0000-555\t-1234  ').value).toBe('416-555 -1234');
  });

  it('caps the length so the field cannot carry a payload', () => {
    expect(phone('4'.repeat(500)).value).toHaveLength(60);
  });

  it('warns — but still stores — something that cannot be a phone number', () => {
    const result = phone('call me');
    expect(result.value).toBe('call me');
    expect(result.warning).toMatch(/does not look like/);
  });

  it('never puts the number itself in the warning', () => {
    // Warnings are logged. A phone number is personal information, and it
    // belongs in DynamoDB under a stated purpose — not scattered through
    // CloudWatch under a different retention policy. Same reasoning as the
    // hashed caller IP.
    const result = phone('12345');
    expect(result.warning).not.toBeNull();
    expect(result.warning).not.toContain('12345');
  });
});

describe('phone, end to end through validateSubmission', () => {
  it('accepts the exact submission that was lost on 2026-08-26', () => {
    // AEY-5BFZSX. This assertion is the regression guard.
    const result = validateSubmission(base({ phone: '(416) 555-1234' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.phone).toBe('(416) 555-1234');
  });

  it('surfaces a doubtful number as a warning, never as an error', () => {
    const result = validateSubmission(base({ phone: 'ring the front desk' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phone).toBe('ring the front desk');
      expect(result.warnings.join()).toMatch(/does not look like/);
    }
  });

  it('adds no warning for an ordinary number', () => {
    const result = validateSubmission(base({ phone: '(416) 555-1234' }));
    if (result.ok) expect(result.warnings.join()).not.toMatch(/phone/);
  });
});
