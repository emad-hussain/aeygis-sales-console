/**
 * Validation and normalization for public assessment submissions.
 *
 * Kept separate from handler.ts so it can be unit-tested without AWS. Every
 * function here is pure.
 *
 * Posture: this is an anonymous, internet-facing write path. Treat every field
 * as hostile. Nothing is passed through unvalidated, nothing is spread, and
 * every string is length-capped so a submission cannot be used to inflate
 * storage or smuggle a payload into a later-rendered PDF.
 */

import {
  DOWNTIME_COST_BANDS,
  DOWNTIME_HOUR_BANDS,
  HOSTING_MODELS,
  POSTURE_ANSWERS,
  RISK_ASSESSMENT_AGES,
  isLocationBand,
  isOneOf,
  isProviderBand,
  locationBandIsAmbiguous,
  locationBandToRange,
  providerBandIsAmbiguous,
  providerBandToRange,
} from '@aeygis/domain';

/** Field length caps. Generous for humans, hostile to payloads. */
const MAX_SHORT = 200;
const MAX_NOTE = 4000;

/**
 * Phone is capped shorter than a name but longer than a bare number, so an
 * extension or a "call after 5" note survives instead of being truncated.
 */
const MAX_PHONE = 60;

/**
 * The shortest thing that could be a real number: a 7-digit NANP local. Below
 * this we still STORE what was typed, we just flag it.
 */
const PHONE_MIN_DIGITS = 7;

/** Spend figures above this are treated as a typo or an attack, not a clinic. */
const MAX_SPEND_CAD = 100_000_000;

export interface ValidatedAssessment {
  clinicName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  organizationType: string | null;
  organizationSize: string | null;
  province: string | null;

  providerBand: string | null;
  locationBand: string | null;
  providerCountMin: number | null;
  providerCountMax: number | null;
  locationCountMin: number | null;
  locationCountMax: number | null;
  providerCount: number | null;
  locationCount: number | null;
  patientCount: number | null;
  countsConfirmed: boolean;

  hosting: string | null;
  monthlyItSpend: number | null;
  annualHardwareEmergency: number | null;
  downtimeHoursBand: string | null;
  downtimeCostBand: string | null;

  mfa: string | null;
  backups: string | null;
  incidentPlan: string | null;
  lastRiskAssessment: string | null;

  consent: boolean;
}

export type ValidationResult =
  | { ok: true; value: ValidatedAssessment; warnings: string[] }
  | { ok: false; errors: string[] };

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

/**
 * Characters removed outright: C0/C1 controls, DEL, zero-width characters, and
 * the bidi override range that lets text lie about its own direction when it is
 * later rendered into a PDF.
 *
 * Deliberately EXCLUDES \u0009-\u000D (tab, LF, VT, FF, CR). Those are real
 * whitespace and must COLLAPSE to a single space rather than vanish. Deleting
 * them silently joins words together -- "Bay Street" + tab + "Clinic" becoming
 * "Bay StreetClinic" -- which is how a pasted multi-line address gets mangled.
 * A unit test covers exactly this.
 */
const STRIP_CHARS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

function str(raw: unknown, max = MAX_SHORT): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(STRIP_CHARS, '')
    // Tabs/newlines survive the strip above so they collapse here.
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, max);
}

/**
 * Deliberately permissive: a rejected real lead costs more than a malformed
 * stored string. Format is checked, deliverability is not asserted.
 */
function email(raw: unknown): string | null {
  const value = str(raw, 320);
  if (value === null) return null;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return null;
  const domain = value.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  if (/\s/.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Phone is optional free text, and it is NEVER rejected.
 *
 * ── WHY THIS RETURNS A WARNING INSTEAD OF AN ERROR ─────────────────────────
 * The form labels this field "(optional)". Blocking a submission on it would
 * break that promise, and every lead lost to a formatting quibble is a lead
 * lost for nothing. So a number that looks wrong is stored anyway and flagged
 * for whoever picks the lead up.
 *
 * ── WHY IT BARELY TOUCHES THE VALUE ────────────────────────────────────────
 * str() has already done the part that matters for safety: control characters
 * stripped, whitespace collapsed, length capped. Beyond that, rewriting is
 * actively harmful — a human is going to dial this, and "416-555-1234 ext 22"
 * carries information that any tidy-up into a canonical format would throw
 * away. We are not storing a machine-dialable number; we are storing what the
 * person told us to call.
 *
 * ── WHY THE WARNING DOES NOT QUOTE THE NUMBER ──────────────────────────────
 * Warnings are logged. A phone number is personal information, and the same
 * reasoning that made us hash the caller IP applies here: it should live in
 * DynamoDB under a stated purpose, not scattered through CloudWatch under a
 * different retention policy. The warning says the shape is odd, not what it
 * was.
 */
export function phone(raw: unknown): { value: string | null; warning: string | null } {
  const value = str(raw, MAX_PHONE);
  if (value === null) return { value: null, warning: null };

  const digits = (value.match(/[0-9]/g) ?? []).length;
  if (digits < PHONE_MIN_DIGITS) {
    return {
      value,
      warning: 'phone does not look like a phone number — stored as given, check before dialling',
    };
  }

  return { value, warning: null };
}

function num(raw: unknown, opts: { min: number; max: number }): number | null {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return null;
  if (parsed < opts.min || parsed > opts.max) return null;
  return parsed;
}

function intOrNull(raw: unknown, opts: { min: number; max: number }): number | null {
  const parsed = num(raw, opts);
  if (parsed === null) return null;
  return Math.round(parsed);
}

function enumOrNull<T extends readonly string[]>(allowed: T, raw: unknown): string | null {
  const value = str(raw);
  if (value === null) return null;
  return isOneOf(allowed, value) ? value : null;
}

/**
 * Consent must be an explicit boolean true. A missing, truthy-but-not-true, or
 * string value is treated as absent — CASL consent should not be inferred from
 * a loose coercion.
 */
function explicitTrue(raw: unknown): boolean {
  return raw === true;
}

export function validateSubmission(input: unknown): ValidationResult {
  const record = asRecord(input);
  if (record === null) {
    return { ok: false, errors: ['payload must be an object'] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  const consent = explicitTrue(record['consent']);
  if (!consent) {
    // Hard fail. Storing a prospect's details without recorded consent is the
    // one thing this endpoint must never do.
    errors.push('consent is required and must be boolean true');
  }

  const contactEmail = email(record['email']);
  if (contactEmail === null) {
    errors.push('a valid email is required');
  }

  // Note the deliberate asymmetry with email directly above: a bad email is an
  // ERROR the submitter is told to fix, a bad phone is a WARNING staff are told
  // about. Email is how we reply, so a wrong one makes the lead worthless.
  // Phone is a convenience, so a wrong one costs almost nothing -- and must
  // never be allowed to cost us the whole submission.
  const contactPhone = phone(record['phone']);
  if (contactPhone.warning !== null) {
    warnings.push(contactPhone.warning);
  }

  // ---- scale ------------------------------------------------------------
  const rawProviderBand = str(record['providers']);
  const rawLocationBand = str(record['locations']);

  const providerBand = isProviderBand(rawProviderBand) ? rawProviderBand : null;
  const locationBand = isLocationBand(rawLocationBand) ? rawLocationBand : null;

  if (rawProviderBand !== null && providerBand === null) {
    warnings.push(`unrecognized provider band "${rawProviderBand}" — discarded`);
  }
  if (rawLocationBand !== null && locationBand === null) {
    warnings.push(`unrecognized location band "${rawLocationBand}" — discarded`);
  }

  // Exact counts win if supplied. The live form does not supply them today,
  // but a future form (or console entry) will.
  const providerCount = intOrNull(record['providerCount'], { min: 1, max: 10_000 });
  const locationCount = intOrNull(record['locationCount'], { min: 1, max: 10_000 });
  const patientCount = intOrNull(record['patientCount'], { min: 0, max: 100_000_000 });

  const providerRange = providerBand === null ? null : providerBandToRange(providerBand);
  const locationRange = locationBand === null ? null : locationBandToRange(locationBand);

  // Counts are "confirmed" only when we have exact integers for both. Anything
  // band-derived stays unconfirmed so pricing refuses to run on a guess.
  const countsConfirmed = providerCount !== null && locationCount !== null;

  if (!countsConfirmed) {
    if (providerBand !== null && providerBandIsAmbiguous(providerBand)) {
      warnings.push(
        `provider band "${providerBand}" spans more than one pricing tier — exact count required before pricing`,
      );
    }
    if (locationBand !== null && locationBandIsAmbiguous(locationBand)) {
      warnings.push(
        `location band "${locationBand}" spans more than one pricing tier — exact count required before pricing`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    warnings,
    value: {
      clinicName: str(record['clinicName']),
      contactName: str(record['contactName']),
      email: contactEmail,
      phone: contactPhone.value,
      jobTitle: str(record['jobTitle']),
      organizationType: str(record['organizationType']),
      organizationSize: str(record['organizationSize']),
      province: str(record['province']),

      providerBand,
      locationBand,
      providerCountMin: providerRange?.min ?? null,
      providerCountMax: providerRange?.max ?? null,
      locationCountMin: locationRange?.min ?? null,
      locationCountMax: locationRange?.max ?? null,
      providerCount,
      locationCount,
      patientCount,
      countsConfirmed,

      hosting: enumOrNull(HOSTING_MODELS, record['hosting']),
      monthlyItSpend: num(record['monthlyItSpend'], { min: 0, max: MAX_SPEND_CAD }),
      annualHardwareEmergency: num(record['annualHardwareEmergency'], {
        min: 0,
        max: MAX_SPEND_CAD,
      }),
      downtimeHoursBand: enumOrNull(DOWNTIME_HOUR_BANDS, record['downtimeHoursBand']),
      downtimeCostBand: enumOrNull(DOWNTIME_COST_BANDS, record['downtimeCostBand']),

      mfa: enumOrNull(POSTURE_ANSWERS, record['mfa']),
      backups: enumOrNull(POSTURE_ANSWERS, record['backups']),
      incidentPlan: enumOrNull(POSTURE_ANSWERS, record['incidentPlan']),
      lastRiskAssessment: enumOrNull(RISK_ASSESSMENT_AGES, record['lastRiskAssessment']),

      consent,
    },
  };
}

/**
 * Honeypot check.
 *
 * The live form will carry a field that is visually hidden and left blank by
 * humans. Any value at all means a bot filled every input it could find.
 *
 * Returns true when the submission should be silently accepted-and-dropped —
 * we return success to the caller so a bot gets no signal about why it failed.
 */
export function isHoneypotTripped(input: unknown): boolean {
  const record = asRecord(input);
  if (record === null) return false;
  const trap = record['_websiteUrl'];
  return typeof trap === 'string' && trap.trim().length > 0;
}

export const LIMITS = { MAX_SHORT, MAX_NOTE, MAX_SPEND_CAD } as const;
