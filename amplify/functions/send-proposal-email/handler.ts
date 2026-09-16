import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.js';
import { env } from '$amplify/env/send-proposal-email';
import { isApprover, readIdentity } from '../shared/identity.js';
import { withCallerEmail } from '../shared/callerEmail.js';
import { buildProposalEmail } from './emailBody.js';
import { shouldAdvanceToProposed } from './leadStatus.js';
import { checkRecipients, parseAllowlist } from './recipientPolicy.js';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>();
const s3 = new S3Client({});
const ses = new SESv2Client({});

/**
 * ============================================================================
 * Emails an approved proposal to the client.
 * ============================================================================
 *
 * THE ONLY IRREVERSIBLE ACTION IN THIS SYSTEM. Everything else can be redone:
 * a price re-quoted, a draft discarded, a rejection reversed by a later record.
 * An email cannot be unsent. The checks below are ordered so that the cheapest
 * refusals happen before any work, and so that nothing reaches SES until every
 * question has been answered.
 *
 * SIX CHECKS, each preventing something specific:
 *
 *  1. APPROVER — re-read from the request identity, not trusted from the caller.
 *     AppSync already enforces `allow.group('approver')`; this is what produces
 *     the group snapshot in the audit record, so the rule and the evidence
 *     cannot disagree.
 *
 *  2. VERSION EXISTS — a send must point at something real.
 *
 *  3. EXPECTED HASH MATCHES STORED HASH — the sender states which bytes they
 *     believe they are mailing. If a newer version was minted while they were
 *     looking at the screen, this refuses rather than silently mailing
 *     different numbers.
 *
 *  4. THE VERSION IS ACTUALLY APPROVED — read from the approval history, not
 *     from what the console displayed. The button is only rendered on approved
 *     versions, but a hidden button is a convenience, not a control.
 *
 *  5. STORED HASH MATCHES THE ACTUAL S3 OBJECT — re-hashes the snapshot now.
 *     `ProposalVersion` is immutable but the S3 object it points at is a
 *     separate thing; without this, a swapped snapshot would be mailed to a
 *     client under the cover of an old approval.
 *
 *  6. EVERY RECIPIENT IS PERMITTED — see recipientPolicy.ts. Fails closed.
 *
 * WHAT GETS RECORDED. Steps 2–6 all write a `ProposalDelivery` row with status
 * `blocked`, because each is a decision this system made and somebody will ask
 * why nothing arrived. Step 1 does NOT: an unauthorized caller is an audit
 * event, not a delivery attempt, and writing a delivery row for one would let a
 * rejected caller litter the client's delivery history.
 */

export interface SendEvent {
  readonly arguments: {
    readonly proposalId: string;
    readonly versionKey: string;
    readonly expectedContentSha256: string;
  };
  readonly identity?: unknown;
}

export interface SendResult {
  readonly ok: boolean;
  readonly status?: string;
  readonly recipient?: string;
  readonly message?: string;
}

/**
 * Moves the lead to `proposed`, because a proposal has now reached the client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BEST EFFORT, ALWAYS. NEVER FATAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called only after SES has accepted the message. By then the email is gone and
 * cannot be recalled, so nothing here may turn a successful send into a
 * reported failure — the approver would be told the client did not receive a
 * proposal they are, at that moment, reading. Same rule as the audit write and
 * the new-lead notification: log loudly, swallow, carry on.
 *
 * ── WHY ONLY ON A SUCCESSFUL SEND ──────────────────────────────────────────
 * `blocked` means the system deliberately refused and nothing left the
 * building; `failed` means something broke. In both cases no proposal exists in
 * anybody's inbox, so calling the lead "proposed" would be a lie the pipeline
 * then reports on.
 *
 * ── THE TWO STATUSES IT WILL NOT OVERWRITE ─────────────────────────────────
 * `proposed` — already there, so the write would be noise.
 * `closed`   — a person deliberately ended this lead. A send does not silently
 *              reopen it. If somebody genuinely is re-engaging a closed lead,
 *              reopening it is their decision to make in the console, where it
 *              is visible, rather than a side effect they never asked for.
 *
 * Everything else (`new`, `needs_confirmation`, `in_review`) advances, because
 * all of them precede "we have put a number in front of them".
 */
async function advanceLeadToProposed(assessmentId: string): Promise<void> {
  try {
    /* Re-read rather than trusting the copy fetched earlier in the request. It
       is a few hundred milliseconds old by now and a staff member could have
       closed the lead in between — which is exactly the case this must not
       trample. */
    const current = await data.models.Assessment.get({ id: assessmentId }, { authMode: 'iam' });
    const from = current.data?.status ?? null;

    if (from === null) {
      console.warn('lead status not advanced: the assessment could not be read', { assessmentId });
      return;
    }

    /* The rule itself lives in leadStatus.ts, pure and tested, including a test
       that fails if a status is added to the model without anyone deciding
       which side of this it falls on. */
    if (!shouldAdvanceToProposed(from)) {
      console.info('lead status left as it was; a send does not override it', {
        assessmentId,
        status: from,
      });
      return;
    }

    const { errors } = await data.models.Assessment.update(
      { id: assessmentId, status: 'proposed' },
      { authMode: 'iam' },
    );
    if (errors !== undefined && errors.length > 0) {
      console.error('lead status update FAILED; the email WAS sent', { assessmentId, errors });
      return;
    }
    console.info('lead advanced to proposed', { assessmentId, from });
  } catch (error) {
    console.error('lead status update THREW; the email WAS sent', { assessmentId, error });
  }
}

/** Best-effort audit write. Never masks the original outcome. */
async function recordAudit(fields: {
  subjectId: string;
  eventType: string;
  actor: string;
  actorEmail: string | null;
  actorGroups: readonly string[];
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    const { errors } = await data.models.AuditEvent.create(
      {
        subjectId: fields.subjectId,
        subjectType: 'proposal',
        eventType: fields.eventType,
        actor: fields.actor,
        actorEmail: fields.actorEmail,
        actorGroups: fields.actorGroups.join(','),
        detail: JSON.stringify(fields.detail),
        occurredAt: new Date().toISOString(),
      },
      { authMode: 'iam' },
    );
    if (errors?.length) console.error('audit write failed', { errors });
  } catch (error) {
    console.error('audit write threw', { error });
  }
}

/**
 * Reads an S3 object as raw bytes.
 *
 * Shared by the snapshot re-hash and the PDF fetch so there is one place where
 * an empty body is treated as an error rather than as zero-length content —
 * silently attaching an empty PDF would be worse than failing.
 */
async function readObject(bucket: string, key: string): Promise<Uint8Array> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (bytes === undefined || bytes.length === 0) {
    throw new Error(`S3 object ${key} is empty`);
  }
  return bytes;
}

/** Narrow a JSON value to a string, or null. Snapshot fields are read defensively. */
function readString(source: unknown, ...path: string[]): string | null {
  let current: unknown = source;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.trim() !== '' ? current : null;
}

export const handler = async (event: SendEvent): Promise<SendResult> => {
  const { proposalId, versionKey, expectedContentSha256 } = event.arguments;

  // Resolved as soon as identity is known, so every exit path can record.
  let caller: { sub: string; email: string | null; groups: readonly string[] };

  try {
    // The request carries NO email: Amplify sends the Cognito access token,
    // which has sub and groups but not email. Resolved here so a delivery row
    // names the sender readably rather than by a bare UUID. Never throws —
    // falls back to the subject alone. See functions/shared/callerEmail.ts.
    caller = await withCallerEmail(readIdentity(event.identity), env.AEYGIS_USER_POOL_ID);
  } catch (error) {
    console.error('send refused: no usable caller identity', { proposalId, versionKey, error });
    return { ok: false, message: 'Could not identify the caller. Sign in again and retry.' };
  }

  /**
   * Writes the delivery row and the matching audit event, then shapes the
   * caller's reply. Every outcome after the authorization check goes through
   * here, so no path can quietly skip the record.
   */
  const record = async (
    status: 'sent' | 'blocked' | 'failed',
    fields: {
      assessmentId: string;
      recipient: string | null;
      bcc: string | null;
      subject: string | null;
      messageId: string | null;
      failureReason: string | null;
      contentSha256: string | null;
      message: string;
    },
  ): Promise<SendResult> => {
    try {
      const { errors } = await data.models.ProposalDelivery.create(
        {
          proposalId,
          versionKey,
          assessmentId: fields.assessmentId,
          status,
          recipient: fields.recipient,
          bcc: fields.bcc,
          subject: fields.subject,
          messageId: fields.messageId,
          failureReason: fields.failureReason,
          contentSha256: fields.contentSha256,
          sentBy: caller.sub,
          sentByEmail: caller.email,
          sentAt: new Date().toISOString(),
        },
        { authMode: 'iam' },
      );
      if (errors?.length) console.error('delivery row write failed', { errors });
    } catch (error) {
      // A failed record must never turn a SUCCESSFUL send into a reported
      // failure — the client already has the email. Logged loudly instead.
      console.error('delivery row write threw', { error, status, proposalId, versionKey });
    }

    /* The lead has now been proposed to, so say so on the lead itself.
       Inside this funnel rather than at the call site: every outcome passes
       through here, so a future success path cannot forget to advance the
       status the way it could if this lived next to one `record('sent', ...)`
       call. Gated on the outcome, never fatal — see advanceLeadToProposed. */
    if (status === 'sent') {
      await advanceLeadToProposed(fields.assessmentId);
    }

    await recordAudit({
      subjectId: proposalId,
      eventType: `proposal_email_${status}`,
      actor: caller.sub,
      actorEmail: caller.email,
      actorGroups: caller.groups,
      detail: {
        versionKey,
        recipient: fields.recipient,
        bcc: fields.bcc,
        messageId: fields.messageId,
        failureReason: fields.failureReason,
      },
    });

    return {
      ok: status === 'sent',
      status,
      ...(fields.recipient === null ? {} : { recipient: fields.recipient }),
      message: fields.message,
    };
  };

  try {
    // ---- (1) may this caller send at all? --------------------------------
    if (!isApprover(caller)) {
      // Should be unreachable: AppSync enforces allow.group('approver') first.
      // Audited precisely because reaching it would mean that rule had stopped
      // working. Deliberately NOT recorded as a delivery.
      await recordAudit({
        subjectId: proposalId,
        eventType: 'proposal_email_denied_not_approver',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: { versionKey, reachedLambdaDespiteApiRule: true },
      });
      return {
        ok: false,
        message: 'Only members of the approver group may send a proposal to a client.',
      };
    }

    // ---- (2) does the version exist? -------------------------------------
    const { data: version, errors } = await data.models.ProposalVersion.get(
      { proposalId, versionKey },
      { authMode: 'iam' },
    );
    if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
    if (version === null) {
      return {
        ok: false,
        message: `Proposal ${proposalId} ${versionKey} not found.`,
      };
    }

    const assessmentId = version.assessmentId;

    // ---- (3) is the sender mailing the bytes they think they are? --------
    if (version.contentSha256 !== expectedContentSha256) {
      return record('blocked', {
        assessmentId,
        recipient: null,
        bcc: null,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: 'Content fingerprint did not match the version on screen.',
        message:
          'This proposal changed since you opened it. Reload and review the current version ' +
          'before sending — the content you were shown is not what is stored.',
      });
    }

    // ---- (4) has it actually been approved? ------------------------------
    // Read from the record, not from what the console rendered.
    const approvals = await data.models.Approval.approvalsByProposal(
      { proposalId },
      { authMode: 'iam' },
    );
    const latestForVersion = (approvals.data ?? [])
      .filter((a) => a.versionKey === versionKey)
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];

    if (latestForVersion?.decision !== 'approved') {
      return record('blocked', {
        assessmentId,
        recipient: null,
        bcc: null,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason:
          latestForVersion === undefined
            ? 'Version has no approval decision.'
            : `Latest decision is "${latestForVersion.decision}", not "approved".`,
        message:
          'Only an approved version can be sent to a client. Approve this version first.',
      });
    }

    // ---- (5) do the stored bytes still hash to the approved value? -------
    const bucket = env.AEYGIS_PROPOSALS_BUCKET_NAME;
    const snapshotBytes = await readObject(bucket, version.snapshotS3Key);
    const actualHash = createHash('sha256').update(snapshotBytes).digest('hex');

    if (actualHash !== version.contentSha256) {
      console.error('SNAPSHOT INTEGRITY FAILURE', {
        proposalId,
        versionKey,
        recorded: version.contentSha256,
        actual: actualHash,
      });
      return record('blocked', {
        assessmentId,
        recipient: null,
        bcc: null,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: `Stored snapshot hashes to ${actualHash}, not ${version.contentSha256}.`,
        message:
          'The stored proposal document does not match its approved fingerprint. ' +
          'Sending refused. This needs investigation before anything goes to a client.',
      });
    }

    // ---- who is this going to? -------------------------------------------
    // The recipient comes from the clinic's OWN contact details. There is no
    // recipient argument on the mutation, so a caller cannot redirect a
    // proposal by passing a different address.
    const assessmentResult = await data.models.Assessment.get(
      { id: assessmentId },
      { authMode: 'iam' },
    );
    const assessment = assessmentResult.data;
    if (assessment === null) {
      return record('failed', {
        assessmentId,
        recipient: null,
        bcc: null,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: `Assessment ${assessmentId} not found.`,
        message: 'The lead this proposal belongs to could not be read. Nothing was sent.',
      });
    }

    const recipient = assessment.email ?? null;
    const bccRaw = env.SES_BCC_ADDRESS.trim();
    const bcc = bccRaw === '' ? null : bccRaw;

    // ---- (6a) is sending switched on at all? -----------------------------
    // Checked before the allowlist so the message says the useful thing: an
    // operator who has turned sending off wants to be told that, not told
    // about a recipient list.
    if (env.SES_ENABLED.trim() !== 'true') {
      return record('blocked', {
        assessmentId,
        recipient,
        bcc,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: 'SES_ENABLED is not "true".',
        message:
          'Email sending is switched off for this environment. Nothing was sent. ' +
          'Set SES_ENABLED to "true" once the SES identity is verified.',
      });
    }

    // ---- (6b) is every recipient permitted? ------------------------------
    // BOTH addresses, because SES rejects the whole message if any recipient
    // is unverified — checking only the client would produce a failure whose
    // cause was invisible.
    const verdict = checkRecipients([recipient, bcc], parseAllowlist(env.SES_ALLOWED_RECIPIENTS));
    if (!verdict.allowed) {
      return record('blocked', {
        assessmentId,
        recipient,
        bcc,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: verdict.reason,
        message: verdict.reason ?? 'This recipient may not be emailed.',
      });
    }

    // ---- compose ---------------------------------------------------------
    // The contractual facts — the date pricing is held to, and the reference —
    // are read from the FROZEN SNAPSHOT, the same bytes the PDF was rendered
    // from, so the email and the attachment can never state different ones.
    //
    // The names are read from the assessment record instead. They are cosmetic
    // (a greeting and a subject line), and the snapshot substitutes the
    // placeholder "Your clinic" when a clinic name is absent — which reads
    // fine inside a document and badly in a subject line.
    const snapshot: unknown = JSON.parse(Buffer.from(snapshotBytes).toString('utf8'));
    const validUntil = readString(snapshot, 'acceptance', 'validUntil');
    const proposalReference =
      readString(snapshot, 'proposalReference') ?? `${proposalId}-${versionKey}`;

    if (validUntil === null) {
      return record('failed', {
        assessmentId,
        recipient,
        bcc,
        subject: null,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: 'Snapshot carries no acceptance.validUntil.',
        message:
          'The stored proposal is missing the date its pricing is held to, so the email ' +
          'could not be written. Regenerate this version.',
      });
    }

    // Has this client already had a proposal? Read from the delivery history,
    // NOT from the version number — staff iterate through versions internally
    // and send only some of them, so a high version number does not mean the
    // client ever saw an earlier one.
    const priorDeliveries = await data.models.ProposalDelivery.deliveriesByProposal(
      { proposalId },
      { authMode: 'iam' },
    );
    const previouslySent = (priorDeliveries.data ?? []).some((d) => d.status === 'sent');

    const email = buildProposalEmail({
      clinicName: assessment.clinicName,
      contactName: assessment.contactName,
      versionKey,
      proposalReference,
      validUntil,
      previouslySent,
    });

    // ---- attach and send -------------------------------------------------
    const pdfKey = `proposals/client/${proposalId}/${versionKey}.pdf`;
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await readObject(bucket, pdfKey);
    } catch (error) {
      // The renderer runs asynchronously after a version is created, so "not
      // there yet" is a real and recoverable state, not a fault.
      console.error('proposal PDF unavailable', { pdfKey, error });
      return record('failed', {
        assessmentId,
        recipient,
        bcc,
        subject: email.subject,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: `Could not read ${pdfKey}.`,
        message:
          'The proposal PDF is not available yet. If it was just generated, give the ' +
          'renderer a moment and try again.',
      });
    }

    let messageId: string | null = null;
    try {
      const response = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: env.SES_FROM_ADDRESS,
          Destination: {
            ToAddresses: [recipient as string],
            ...(bcc === null ? {} : { BccAddresses: [bcc] }),
          },
          // Replies go to the sender identity, which in production is a
          // monitored Aeygis mailbox. Stated explicitly rather than left to
          // SES's default so a future From change cannot silently strand
          // client replies.
          ReplyToAddresses: [env.SES_FROM_ADDRESS],
          ConfigurationSetName: env.SES_CONFIGURATION_SET,
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: email.text, Charset: 'UTF-8' },
                Html: { Data: email.html, Charset: 'UTF-8' },
              },
              // SESv2 takes attachments directly — no hand-built MIME. The
              // SDK base64-encodes RawContent. The v2 message cap is 40 MB;
              // a proposal is around 300 KB.
              Attachments: [
                {
                  FileName: email.attachmentFileName,
                  RawContent: pdfBytes,
                  ContentType: 'application/pdf',
                  ContentDisposition: 'ATTACHMENT',
                  /**
                   * SET EXPLICITLY. The AWS API reference lists BASE64,
                   * QUOTED_PRINTABLE and SEVEN_BIT as valid values and states
                   * NO default — checked, it simply is not documented. A PDF is
                   * binary, so the other two would mangle it: SEVEN_BIT strips
                   * the high bit, QUOTED_PRINTABLE rewrites bytes it considers
                   * unprintable. Either produces a file that arrives the right
                   * size and opens blank or broken.
                   *
                   * Added after the first real send arrived unreadable. The
                   * bytes we hand the SDK were verified correct (base64
                   * round-trips byte-identical, and the object in S3 renders),
                   * so how SES frames them was the only remaining variable.
                   * Relying on an undocumented default was the mistake either
                   * way.
                   */
                  ContentTransferEncoding: 'BASE64',
                },
              ],
            },
          },
        }),
      );
      messageId = response.MessageId ?? null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('SES send failed', { proposalId, versionKey, detail });
      return record('failed', {
        assessmentId,
        recipient,
        bcc,
        subject: email.subject,
        messageId: null,
        contentSha256: version.contentSha256,
        failureReason: detail,
        message: `The email could not be sent: ${detail}`,
      });
    }

    console.info('proposal emailed', { proposalId, versionKey, messageId, by: caller.sub });

    return record('sent', {
      assessmentId,
      recipient,
      bcc,
      subject: email.subject,
      messageId,
      contentSha256: version.contentSha256,
      failureReason: null,
      message:
        bcc === null
          ? `Sent to ${recipient}.`
          : `Sent to ${recipient}, copied to ${bcc}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('send-proposal-email failed', { proposalId, versionKey, message });
    // Deliberately generic to the caller; the detail is in CloudWatch. No
    // delivery row here: this path means we do not reliably know what happened,
    // and inventing a status would be worse than the gap.
    return { ok: false, message: 'Could not send the proposal. Please try again.' };
  }
};
