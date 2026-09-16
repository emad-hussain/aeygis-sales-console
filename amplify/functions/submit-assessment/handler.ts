import { createHash, randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.js';
import { env } from '$amplify/env/submit-assessment';
import { isHoneypotTripped, validateSubmission, type ValidatedAssessment } from './validate.js';
import { buildAssessmentNotification, isTestSubmission } from './notification.js';
import { salvageRecord } from './salvage.js';

/**
 * The one thing we say when a submission cannot be stored. Defined once
 * because it is returned from three places and they must not drift — a visitor
 * comparing two failures should not be able to infer anything from a wording
 * difference.
 */
const SAVE_FAILED_MESSAGE = 'We could not save your assessment. Please email aws@aeygis.com.';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();
const ses = new SESv2Client({});

/**
 * Public assessment intake.
 *
 * This is the only writer of `Assessment`, and the only part of the system an
 * anonymous caller can reach. Design rules, in priority order:
 *
 *   1. Never leak. The response is a receipt — never assessment content, never
 *      an internal error message, never a stack trace.
 *   2. Never store without consent. Enforced in validate.ts as a hard failure.
 *   3. Give abuse no signal. A tripped honeypot and a rate-limit rejection both
 *      return the same shape as success, so a bot cannot tell what stopped it.
 */

const RATE_LIMIT_MAX = Number(env.RATE_LIMIT_MAX ?? '5');
const RATE_LIMIT_WINDOW_SECONDS = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? '3600');

/** Human-quotable reference, e.g. AEY-7F3K2Q. */
function newReferenceId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = randomUUID().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    const slice = bytes.slice(i * 2, i * 2 + 2);
    out += alphabet[Number.parseInt(slice, 16) % alphabet.length];
  }
  return `AEY-${out}`;
}

/**
 * Hash the caller IP with a per-deployment salt. We rate-limit on this and
 * never store the address itself — a raw IP would be personal information we
 * have no stated purpose for retaining.
 */
function hashIp(ip: string | undefined): string | null {
  if (ip === undefined || ip.trim().length === 0) return null;
  const salt = env.IP_HASH_SALT;
  if (salt === undefined || salt.length === 0) {
    // Refuse to fall back to an unsalted or hardcoded salt. A weak salt is
    // worse than no rate limiting: it turns this column into recoverable
    // personal information while looking like it protects something.
    console.error('IP_HASH_SALT is not set; skipping rate limiting rather than weakly hashing');
    return null;
  }
  return createHash('sha256').update(`${salt}:${ip.trim()}`).digest('hex');
}

/**
 * Best-effort source IP extraction. AppSync surfaces this on identity for IAM
 * and Cognito requests, but the shape is not guaranteed across auth modes, so
 * every access is defensive. A missing IP means rate limiting is skipped rather
 * than the submission being rejected — dropping a real lead is the worse error.
 */
function extractSourceIp(identity: unknown): string | undefined {
  if (typeof identity !== 'object' || identity === null) return undefined;
  const ips = (identity as { sourceIp?: unknown }).sourceIp;
  if (Array.isArray(ips) && ips.length > 0 && typeof ips[0] === 'string') return ips[0];
  if (typeof ips === 'string') return ips;
  return undefined;
}

/**
 * Tells an Aeygis inbox that a lead arrived.
 *
 * ============================================================================
 * BEST EFFORT, ALWAYS. NEVER FATAL.
 * ============================================================================
 *
 * Called only AFTER the assessment has been written, and its outcome is never
 * read by the caller. Same shape as the audit writes in decide-proposal: the
 * thing that matters has already happened, and a failure here must not turn a
 * stored lead into a reported failure — the visitor would be told to email us a
 * submission we already have.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 * The public form used to email sales through a third-party relay. That was
 * removed on 2026-08-25 and this backend became the only destination, which
 * means a lead now lands in DynamoDB and nothing announces it. Without this,
 * finding out depends on somebody opening the console.
 *
 * ── ONE THING TO KNOW ABOUT THE QUOTA ──────────────────────────────────────
 * SES sending quota is per ACCOUNT and region, and it is shared with proposal
 * delivery. In the sandbox that is 200 messages / 24h. Submissions are rate
 * limited to 5 per IP per hour, so ordinary traffic is nowhere near it — but a
 * determined flood across many addresses could consume the quota and starve the
 * thing that actually matters commercially, which is sending a proposal to a
 * client. Recorded in docs rather than engineered around: production access
 * raises the quota substantially, and the send here is already the expendable
 * one of the two.
 */
async function notifyNewAssessment(fields: {
  referenceId: string;
  status: string;
  submittedAt: string;
  value: ValidatedAssessment;
  droppedFields?: string[] | null;
}): Promise<void> {
  if (env.NOTIFY_ENABLED?.trim() !== 'true') return;

  /* Verification runs submit through the real public mutation on purpose. They
     should not email the team, and — more importantly — should not spend SES
     quota that proposal delivery shares. See isTestSubmission. */
  if (isTestSubmission(fields.value.email)) {
    console.info('new-lead notification skipped for a test submission', {
      referenceId: fields.referenceId,
    });
    return;
  }

  const to = env.NOTIFY_TO_ADDRESS?.trim();
  const from = env.NOTIFY_FROM_ADDRESS?.trim();
  if (!to || !from) {
    console.warn('new-lead notification skipped: NOTIFY_TO_ADDRESS or NOTIFY_FROM_ADDRESS is not set');
    return;
  }

  try {
    const message = buildAssessmentNotification({
      referenceId: fields.referenceId,
      status: fields.status,
      submittedAt: fields.submittedAt,
      clinicName: fields.value.clinicName,
      contactName: fields.value.contactName,
      email: fields.value.email,
      phone: fields.value.phone,
      jobTitle: fields.value.jobTitle,
      organizationType: fields.value.organizationType,
      organizationSize: fields.value.organizationSize,
      province: fields.value.province,
      providerBand: fields.value.providerBand,
      locationBand: fields.value.locationBand,
      providerCount: fields.value.providerCount,
      locationCount: fields.value.locationCount,
      countsConfirmed: fields.value.countsConfirmed,
      hosting: fields.value.hosting,
      monthlyItSpend: fields.value.monthlyItSpend,
      annualHardwareEmergency: fields.value.annualHardwareEmergency,
      downtimeHoursBand: fields.value.downtimeHoursBand,
      downtimeCostBand: fields.value.downtimeCostBand,
      mfa: fields.value.mfa,
      backups: fields.value.backups,
      incidentPlan: fields.value.incidentPlan,
      lastRiskAssessment: fields.value.lastRiskAssessment,
      droppedFields: fields.droppedFields ?? null,
    });

    const response = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        // A reply goes to the prospect, not to the robot. The whole point of
        // the notification is that somebody follows up, and this removes a
        // copy-paste step from that. Falls back to the sender when the
        // submission carried no usable address.
        ReplyToAddresses: [fields.value.email ?? from],
        ...(env.NOTIFY_CONFIGURATION_SET
          ? { ConfigurationSetName: env.NOTIFY_CONFIGURATION_SET }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            // Text only. This is an internal heads-up read by two people, not a
            // client-facing document, so HTML would be effort with no reader.
            Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    console.info('new-lead notification sent', {
      referenceId: fields.referenceId,
      messageId: response.MessageId,
    });
  } catch (error) {
    // Logged loudly and swallowed. The lead is already stored.
    console.error('new-lead notification failed; the assessment WAS saved', {
      referenceId: fields.referenceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function isRateLimited(ipHash: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();
  try {
    const { data, errors } = await client.models.Assessment.assessmentsBySubmitterIpHash(
      { submitterIpHash: ipHash, submittedAt: { ge: since } },
      { selectionSet: ['id'], limit: RATE_LIMIT_MAX + 1, authMode: 'iam' },
    );
    if (errors !== undefined && errors.length > 0) {
      // Fail open. A counting failure must not block a genuine submission.
      console.warn('rate limit query failed, allowing submission', { errors });
      return false;
    }
    return (data?.length ?? 0) >= RATE_LIMIT_MAX;
  } catch (error) {
    console.warn('rate limit query threw, allowing submission', { error });
    return false;
  }
}

export const handler: Schema['submitAssessment']['functionHandler'] = async (event) => {
  const referenceId = newReferenceId();

  // Uniform response for every rejected-but-not-explained case. A bot learns
  // nothing; a human who somehow trips it still gets a reference to quote.
  const opaqueSuccess = {
    ok: true,
    referenceId,
    message: 'Assessment received. Our team will be in touch.',
  };

  try {
    const payload = event.arguments.payload;

    if (isHoneypotTripped(payload)) {
      console.info('honeypot tripped, dropping submission', { referenceId });
      return opaqueSuccess;
    }

    const result = validateSubmission(payload);
    if (!result.ok) {
      // Validation errors ARE returned — these are the submitter's own input
      // mistakes (bad email, missing consent) and they need to be fixable.
      console.info('validation rejected submission', {
        referenceId,
        errors: result.errors,
      });
      return {
        ok: false,
        referenceId,
        message: result.errors.join('; '),
      };
    }

    const ipHash = hashIp(extractSourceIp(event.identity));
    if (ipHash !== null && (await isRateLimited(ipHash))) {
      console.warn('rate limit exceeded, dropping submission', { referenceId });
      return opaqueSuccess;
    }

    if (result.warnings.length > 0) {
      console.info('submission accepted with warnings', {
        referenceId,
        warnings: result.warnings,
      });
    }

    const now = new Date().toISOString();
    // Band-derived counts cannot determine a tier, so anything unconfirmed is
    // parked for staff to complete before it can be priced.
    const status = result.value.countsConfirmed ? 'new' : 'needs_confirmation';

    const record = {
      ...result.value,
      referenceId,
      source: 'health_site_live_form',
      status,
      submittedAt: now,
      submitterIpHash: ipHash,
      consentedAt: now,
    };

    /* ── STORE, AND IF THAT FAILS, STORE LESS ────────────────────────────────
     *
     * A rejected field must not be able to destroy a lead. It has happened:
     * see salvage.ts. So a refusal is answered with a genuinely smaller
     * record rather than a repeat of the same one — a rejected variable is
     * rejected deterministically, so an identical retry only fails twice.
     *
     * The visitor is told the same thing either way. They typed what they
     * typed; whether we could keep all of it is our problem, not theirs. */
    let droppedFields: string[] | null = null;

    const first = await client.models.Assessment.create(record, { authMode: 'iam' });

    if (first.errors !== undefined && first.errors.length > 0) {
      // Log the detail, return none of it.
      console.error('failed to persist assessment', { referenceId, errors: first.errors });

      const salvaged = salvageRecord(record, first.errors);
      if (salvaged === null) {
        // Every field the API refused is one a lead cannot do without, so a
        // smaller record would be a worthless record.
        console.error('nothing could be dropped safely; the lead is LOST', { referenceId });
        return { ok: false, referenceId, message: SAVE_FAILED_MESSAGE };
      }

      console.warn('retrying without the refused fields', {
        referenceId,
        dropped: salvaged.dropped,
        // false means we could not parse a field name and fell back to
        // dropping everything optional. A run of these means the error format
        // has moved and fieldsNamedInErrors needs revisiting.
        targeted: salvaged.targeted,
      });

      const second = await client.models.Assessment.create(
        /* Cast, and deliberately so. Salvage removes fields by NAME at runtime,
           so the compiler cannot see that every required one survived. That
           guarantee lives in ESSENTIAL_FIELDS instead, and salvage.test.ts
           asserts it against the schema's own required list — which is the
           only place it could be checked, since the two are only related by
           intent. If a field is ever made required without being added there,
           that test fails rather than this line. */
        salvaged.record as Parameters<typeof client.models.Assessment.create>[0],
        { authMode: 'iam' },
      );
      if (second.errors !== undefined && second.errors.length > 0) {
        console.error('salvage retry also failed; the lead is LOST', {
          referenceId,
          errors: second.errors,
        });
        return { ok: false, referenceId, message: SAVE_FAILED_MESSAGE };
      }

      droppedFields = salvaged.dropped;
    }

    if (droppedFields === null) {
      console.info('assessment stored', { referenceId, status });
    } else {
      // WARN, not INFO. The lead is safe, but something in the schema refused
      // ordinary input and a person needs to find out which.
      console.warn('assessment stored WITH FIELDS DROPPED', {
        referenceId,
        status,
        dropped: droppedFields,
      });
    }

    /* AWAITED, but its outcome is never read.
     *
     * Awaited because a Lambda stops executing the moment it returns, so a
     * fire-and-forget send would frequently be killed mid-flight — the classic
     * way a "best effort" call becomes a "never happens" call.
     *
     * Outcome ignored because the lead is already stored: notifyNewAssessment
     * swallows and logs its own failures, and there is deliberately no path by
     * which a notification problem changes what the submitter is told. */
    await notifyNewAssessment({
      referenceId,
      status,
      submittedAt: now,
      value: result.value,
      // The email carries what they SUBMITTED; the console shows what we
      // STORED. When salvage makes those differ, say so, so nobody hunts the
      // console for a phone number that is only in the email.
      droppedFields,
    });

    return opaqueSuccess;
  } catch (error) {
    console.error('unhandled error in submit-assessment', { referenceId, error });
    return { ok: false, referenceId, message: SAVE_FAILED_MESSAGE };
  }
};
