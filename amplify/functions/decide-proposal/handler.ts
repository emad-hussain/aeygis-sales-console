import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.js';
import { env } from '$amplify/env/decide-proposal';
import { isApprover, isDecision, readIdentity, type CallerIdentity } from '../shared/identity.js';
import { withCallerEmail } from '../shared/callerEmail.js';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>();
const s3 = new S3Client({});

/**
 * Records an approval or rejection against a specific proposal version.
 *
 * FOUR CHECKS, IN ORDER. Each exists because of a distinct failure it prevents:
 *
 *  1. APPROVER GROUP — re-read from the request identity, not trusted from the
 *     caller. AppSync already enforces `allow.group('approver')`, so this is
 *     defence in depth; more importantly it is what produces the group snapshot
 *     written to the record, so the rule and the evidence cannot disagree.
 *
 *  2. VERSION EXISTS — a decision must point at something real.
 *
 *  3. EXPECTED HASH MATCHES THE STORED HASH — the approver states which bytes
 *     they are approving. If a newer version was minted while they were reading,
 *     this refuses rather than silently approving different numbers.
 *
 *  4. STORED HASH MATCHES THE ACTUAL S3 OBJECT — re-hashes the snapshot bytes
 *     now. `ProposalVersion` is immutable, but the S3 object it points at is a
 *     separate thing; without this, a swapped snapshot would be approved as
 *     though nothing had changed. This is the check that makes the audit trail
 *     mean something.
 *
 * Only then are `Approval` and `AuditEvent` written. Both are append-only:
 * a reversal is a NEW record, never an edit.
 */

export interface DecideEvent {
  readonly arguments: {
    readonly proposalId: string;
    readonly versionKey: string;
    readonly decision: string;
    readonly expectedContentSha256: string;
    readonly reason?: string | null;
  };
  readonly identity?: unknown;
}

export interface DecideResult {
  readonly ok: boolean;
  readonly decision?: string;
  readonly message?: string;
}

async function sha256OfS3Object(bucket: string, key: string): Promise<string> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (bytes === undefined) throw new Error(`snapshot ${key} is empty`);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Best-effort audit write. Never masks the original outcome. */
async function recordAudit(fields: {
  subjectId: string;
  subjectType: string;
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
        subjectType: fields.subjectType,
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

export const handler = async (event: DecideEvent): Promise<DecideResult> => {
  const { proposalId, versionKey, decision, expectedContentSha256, reason } = event.arguments;

  try {
    // ---- (1) who is asking, and what were they at this moment? ------------
    // The request carries NO email: Amplify sends the Cognito access token,
    // which has sub and groups but not email. Resolved here so the record names
    // the decider readably rather than by a bare UUID. Never throws — falls
    // back to the subject alone. See functions/shared/callerEmail.ts.
    const caller = await withCallerEmail(readIdentity(event.identity), env.AEYGIS_USER_POOL_ID);

    if (!isApprover(caller)) {
      // Should be unreachable: AppSync enforces allow.group('approver') first.
      // Recorded as an audit event precisely because reaching it would mean the
      // API-level rule had stopped working.
      await recordAudit({
        subjectId: proposalId,
        subjectType: 'proposal',
        eventType: 'approval_denied_not_approver',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: { versionKey, reachedLambdaDespiteApiRule: true },
      });
      return { ok: false, message: 'Only members of the approver group may decide a proposal.' };
    }

    if (!isDecision(decision)) {
      return { ok: false, message: "decision must be 'approved' or 'rejected'" };
    }

    // ---- (2) does the version exist? -------------------------------------
    const { data: version, errors } = await data.models.ProposalVersion.get(
      { proposalId, versionKey },
      { authMode: 'iam' },
    );
    if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
    if (version === null) {
      return { ok: false, message: `Proposal ${proposalId} ${versionKey} not found.` };
    }

    // ---- (3) is the approver deciding on the bytes they think they are? ---
    if (version.contentSha256 !== expectedContentSha256) {
      await recordAudit({
        subjectId: proposalId,
        subjectType: 'proposal',
        eventType: 'approval_refused_stale_hash',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: { versionKey, expected: expectedContentSha256, actual: version.contentSha256 },
      });
      return {
        ok: false,
        message:
          'This proposal changed since you opened it. Reload and review the current version ' +
          'before deciding — the content you were shown is not what is stored.',
      };
    }

    // ---- (4) do the STORED bytes still hash to the recorded value? --------
    // ProposalVersion is immutable, but its S3 snapshot is a separate object.
    const actualHash = await sha256OfS3Object(
      env.AEYGIS_PROPOSALS_BUCKET_NAME,
      version.snapshotS3Key,
    );
    if (actualHash !== version.contentSha256) {
      await recordAudit({
        subjectId: proposalId,
        subjectType: 'proposal',
        eventType: 'approval_refused_snapshot_tampered',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: {
          versionKey,
          snapshotS3Key: version.snapshotS3Key,
          recorded: version.contentSha256,
          actual: actualHash,
        },
      });
      console.error('SNAPSHOT INTEGRITY FAILURE', {
        proposalId,
        versionKey,
        recorded: version.contentSha256,
        actual: actualHash,
      });
      return {
        ok: false,
        message:
          'The stored proposal document does not match its recorded fingerprint. ' +
          'Approval refused. This needs investigation before anything is sent.',
      };
    }

    // ---- record the decision --------------------------------------------
    const decidedAt = new Date().toISOString();
    const created = await data.models.Approval.create(
      {
        proposalId,
        versionKey,
        decision,
        reason: reason ?? null,
        contentSha256: version.contentSha256,
        decidedBy: caller.sub,
        decidedByEmail: caller.email,
        // Snapshotted: group membership is mutable, and this record must show
        // what the decider held at decision time, not what they hold now.
        decidedByGroups: caller.groups.join(','),
        decidedAt,
      },
      { authMode: 'iam' },
    );
    if (created.errors?.length) {
      throw new Error(created.errors.map((e: { message: string }) => e.message).join('; '));
    }

    await recordAudit({
      subjectId: proposalId,
      subjectType: 'proposal',
      eventType: decision === 'approved' ? 'proposal_approved' : 'proposal_rejected',
      actor: caller.sub,
      actorEmail: caller.email,
      actorGroups: caller.groups,
      detail: { versionKey, contentSha256: version.contentSha256, reason: reason ?? null },
    });

    console.info('decision recorded', { proposalId, versionKey, decision, by: caller.sub });

    return {
      ok: true,
      decision,
      message:
        decision === 'approved'
          ? `Approved ${proposalId} ${versionKey}. Delivery is a separate, explicit step.`
          : `Rejected ${proposalId} ${versionKey}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('decide-proposal failed', { proposalId, versionKey, message });
    // Deliberately generic to the caller; the detail is in CloudWatch.
    return { ok: false, message: 'Could not record the decision. Please try again.' };
  }
};
