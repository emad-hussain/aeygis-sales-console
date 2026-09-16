import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.js';
import { env } from '$amplify/env/delete-proposal-version';
import { isStaff, readIdentity } from '../shared/identity.js';
import { withCallerEmail } from '../shared/callerEmail.js';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>();
const s3 = new S3Client({});

/**
 * Permanently deletes a proposal version that has not been approved.
 *
 * ── WHAT "PERMANENTLY" ACTUALLY MEANS HERE ─────────────────────────────────
 * The DynamoDB row is genuinely gone: the version disappears from the API, not
 * just from a list. The S3 snapshot and PDF are deleted too — but the bucket
 * has VERSIONING ENABLED, so `DeleteObject` writes a delete marker and the
 * prior object versions remain in S3 until a lifecycle rule expires them.
 * Normal reads return 404 from that moment on. This is stated plainly rather
 * than described as an erase, because claiming bytes are destroyed when they
 * are recoverable would be the kind of thing someone later relies on.
 *
 * ── THE REFUSAL RULE ───────────────────────────────────────────────────────
 * An APPROVED version is never deletable, by either role. "Approved" means the
 * LATEST decision on that version is 'approved' — a version that was approved
 * and later reversed by a newer rejection is deletable, matching exactly how
 * the console decides what badge to show. Anything else (never decided, or
 * rejected) may go.
 *
 * A rejected version leaves its `Approval` record behind. `Approval` has
 * update and delete removed from the schema outright, so the decision record
 * survives the thing it decided on, pointing at a version that no longer
 * exists. That is the accepted, deliberate consequence of hard delete: the
 * evidence that a decision was made outlives the draft.
 *
 * ── WHY THE AUDIT DETAIL IS VERBOSE ────────────────────────────────────────
 * Everywhere else in this system the audit record complements a row that still
 * exists. Here it REPLACES one. Once the delete succeeds, this event is the
 * only surviving record of what was removed, so it carries the figures and the
 * content hash rather than just an id.
 */

export interface DeleteEvent {
  readonly arguments: {
    readonly proposalId: string;
    readonly versionKey: string;
  };
  readonly identity?: unknown;
}

export interface DeleteResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Same formula price-proposal writes with, and the console reads with. */
function clientPdfKey(proposalId: string, versionKey: string): string {
  return `proposals/client/${proposalId}/${versionKey}.pdf`;
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

/**
 * Deletes an object, treating "already gone" as success.
 *
 * Best-effort ON PURPOSE, and only ever called AFTER the row is gone. An
 * orphaned S3 object costs storage; a surviving row whose objects were deleted
 * would show staff a version whose "View PDF" is permanently broken. Given one
 * of the two has to fail first, the harmless one is chosen.
 */
async function deleteObjectBestEffort(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    console.error('S3 delete failed; object is now orphaned', { bucket, key, error });
    return false;
  }
}

export const handler = async (event: DeleteEvent): Promise<DeleteResult> => {
  const { proposalId, versionKey } = event.arguments;

  try {
    // ---- (1) who is asking? ----------------------------------------------
    // The request carries NO email: Amplify sends the Cognito access token,
    // which has sub and groups but not email. Resolved here so a deletion
    // record names the person readably. Never throws — falls back to the
    // subject alone. See functions/shared/callerEmail.ts.
    const caller = await withCallerEmail(readIdentity(event.identity), env.AEYGIS_USER_POOL_ID);

    if (!isStaff(caller)) {
      // Should be unreachable: AppSync enforces the group rule on the mutation
      // first. Audited precisely because reaching it would mean that rule had
      // stopped working.
      await recordAudit({
        subjectId: proposalId,
        subjectType: 'proposal',
        eventType: 'version_delete_denied_not_staff',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: { versionKey, reachedLambdaDespiteApiRule: true },
      });
      return { ok: false, message: 'Only staff may delete a proposal version.' };
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

    // ---- (3) has it been approved? ---------------------------------------
    // Latest decision wins, so an approval later reversed by a rejection does
    // not protect the version forever. Same rule the console's badge uses.
    const approvalsResult = await data.models.Approval.approvalsByProposal(
      { proposalId },
      { authMode: 'iam' },
    );
    if (approvalsResult.errors?.length) {
      throw new Error(approvalsResult.errors.map((e) => e.message).join('; '));
    }
    const latestDecision = (approvalsResult.data ?? [])
      .filter((a) => a.versionKey === versionKey)
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];

    if (latestDecision?.decision === 'approved') {
      await recordAudit({
        subjectId: proposalId,
        subjectType: 'proposal',
        eventType: 'version_delete_refused_approved',
        actor: caller.sub,
        actorEmail: caller.email,
        actorGroups: caller.groups,
        detail: {
          versionKey,
          approvedAt: latestDecision.decidedAt,
          approvedBy: latestDecision.decidedBy,
        },
      });
      return {
        ok: false,
        message:
          `${versionKey} has been approved and cannot be deleted. ` +
          'An approved proposal is part of the record. To supersede it, generate a new version.',
      };
    }

    // Captured BEFORE the row goes, since the row is where they are recorded.
    const snapshotKey = version.snapshotS3Key;
    const pdfKey = clientPdfKey(proposalId, versionKey);
    const removed = {
      versionKey,
      versionNumber: version.versionNumber,
      tier: version.tier,
      supportPlan: version.supportPlan,
      setupTotal: version.setupTotal,
      monthlyTotal: version.monthlyTotal,
      firstYearTotal: version.firstYearTotal,
      currency: version.currency,
      priceBookVersion: version.priceBookVersion,
      contentSha256: version.contentSha256,
      snapshotS3Key: snapshotKey,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
      priorDecision: latestDecision?.decision ?? null,
    };

    // ---- (4) delete the row FIRST ----------------------------------------
    // Authoritative step. If this fails nothing else has been touched, so the
    // version is left completely intact rather than half-deleted.
    const deleted = await data.models.ProposalVersion.delete(
      { proposalId, versionKey },
      { authMode: 'iam' },
    );
    if (deleted.errors?.length) {
      throw new Error(deleted.errors.map((e) => e.message).join('; '));
    }

    // ---- (5) then the artifacts, best effort -----------------------------
    const bucket = env.AEYGIS_PROPOSALS_BUCKET_NAME;
    const snapshotDeleted = await deleteObjectBestEffort(bucket, snapshotKey);
    const pdfDeleted = await deleteObjectBestEffort(bucket, pdfKey);

    await recordAudit({
      subjectId: proposalId,
      subjectType: 'proposal',
      eventType: 'proposal_version_deleted',
      actor: caller.sub,
      actorEmail: caller.email,
      actorGroups: caller.groups,
      // This event is now the ONLY record of what was removed.
      detail: { ...removed, snapshotDeleted, pdfDeleted },
    });

    console.info('proposal version deleted', {
      proposalId,
      versionKey,
      by: caller.sub,
      snapshotDeleted,
      pdfDeleted,
    });

    return { ok: true, message: `Deleted ${versionKey}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('delete-proposal-version failed', { proposalId, versionKey, message });
    return { ok: false, message: 'Could not delete the version. Please try again.' };
  }
};
