import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';
import type { Schema } from '../../../amplify/data/resource';

/**
 * Data access for the console.
 *
 * Always `authMode: 'userPool'` — staff are signed in, and the model's
 * authorization rule is `allow.groups(['contributor','approver']).to(['read','update'])`.
 * There is no guest path here at all.
 *
 * Note what is absent: no create and no delete. The schema grants staff only
 * read and update, and `Assessment` is written solely by the submit-assessment
 * Lambda. A console that could create assessments would let a rep invent a lead.
 */
/**
 * LAZY on purpose. Do not hoist this back to module scope.
 *
 * `generateClient()` requires Amplify to already be configured. At module scope it
 * runs during IMPORT EVALUATION, which happens BEFORE the importing module's body
 * — so `main.tsx`'s `Amplify.configure(outputs)` had not run yet and the console
 * failed at startup with:
 *
 *   "Amplify has not been configured. Please call Amplify.configure() before
 *    using this service."  (client.ts:15)
 *
 * Creating it on first use makes correctness independent of import order, which is
 * not something a reader should have to reason about.
 */
type DataClient = ReturnType<typeof generateClient<Schema>>;
let cachedClient: DataClient | null = null;

function getClient(): DataClient {
  cachedClient ??= generateClient<Schema>({ authMode: 'userPool' });
  return cachedClient;
}

export type AssessmentRecord = Schema['Assessment']['type'];
export type ProposalVersionRecord = Schema['ProposalVersion']['type'];
export type ApprovalRecord = Schema['Approval']['type'];
export type AuditEventRecord = Schema['AuditEvent']['type'];
export type ProposalDeliveryRecord = Schema['ProposalDelivery']['type'];

/** Fields the console is permitted to change. */
/**
 * A PARTIAL update. Only the fields that actually changed are sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY PARTIAL, AND WHY NO NULLS
 * ═══════════════════════════════════════════════════════════════════════════
 * The generated `updateAssessment` resolver carries, for both staff groups:
 *
 *   allowedFields:     [ ...every field... ]
 *   nullAllowedFields: []
 *   isAuthorizedOnAllFields: false
 *
 * Every field may be WRITTEN, but none may be set to NULL. Sending one null
 * fails the whole mutation with `Unauthorized on [thatField]` — the write is
 * rejected outright, not partially applied. Verified in a browser against the
 * deployed API: nulling `internalNotes` and nulling `patientCount` both fail
 * the same way, so it is not about any particular field.
 *
 * That is a consequence of the model rule being `.to(['read','update'])`.
 * Widening it is a backend change and a deploy, so the console works within
 * it instead: send only what changed, and clear a string with '' rather than
 * null. A number genuinely cannot be cleared through this API — that case is
 * refused loudly below rather than silently dropped.
 */
export interface AssessmentEdits {
  /* `null` is ACCEPTED by the type but REFUSED at runtime, deliberately.
     A cleared number has no other representation, and the alternative —
     coercing it to `undefined` — drops the edit silently and reports the save
     as successful while the old value survives. Better to let it reach the
     one place that knows the rule and says so. */
  providerCount?: number | null;
  locationCount?: number | null;
  patientCount?: number | null;
  countsConfirmed?: boolean;
  /** '' clears it. Never null — see the note above. */
  internalNotes?: string;
  discoveryAnswers?: string;
  /** Serialized CustomDiscoverySchema — this clinic's own extra questions. */
  customDiscoveryQuestions?: string;
  /** Serialized MigrationSchedule — staff timing estimates per phase. */
  migrationSchedule?: string;
  /** Serialized ResponsibilityCustomisation — excluded + added matrix rows. */
  responsibilityMatrix?: string;
  status?: string;
}

function unwrap<T>(result: { data: T; errors?: { message: string }[] }): T {
  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join('; '));
  }
  return result.data;
}

/**
 * Newest first. Uses `list` rather than the status index so a record with an
 * unexpected status can never become invisible — a lead that silently vanishes
 * from the queue is worse than an unsorted list.
 */
export async function listAssessments(): Promise<AssessmentRecord[]> {
  const result = await getClient().models.Assessment.list({ limit: 200 });
  const items = unwrap(result) ?? [];
  return [...items].sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
}

/**
 * One lead, re-read from the server.
 *
 * Exists so a caller can pick up a change the BACKEND made on its own — the
 * status moving to `proposed` when a proposal is emailed, for instance. Reading
 * it back is deliberate rather than assuming the new value: the backend leaves a
 * `closed` lead alone, so "we sent an email, therefore it is proposed now" is
 * not always true, and hardcoding that rule in the UI would put a second copy of
 * it somewhere it can drift.
 */
export async function getAssessment(id: string): Promise<AssessmentRecord> {
  const record = unwrap(await getClient().models.Assessment.get({ id }));
  if (record === null) throw new Error('Assessment not found');
  return record;
}

export async function updateAssessment(
  id: string,
  edits: AssessmentEdits,
): Promise<AssessmentRecord> {
  // Caught here rather than at the API, because AppSync's own message
  // ("Unauthorized on [patientCount]") reads like a permissions problem with
  // the signed-in user, which it is not — nobody can null a field on this
  // model. Say what actually happened instead.
  const nulled = Object.entries(edits)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (nulled.length > 0) {
    throw new Error(
      `Cannot clear ${nulled.join(', ')}: this API accepts no empty values on those fields. ` +
        'Enter a value, or ask for the backend authorization rule to be widened.',
    );
  }

  // Only keys the caller actually set. Spreading an object with undefined
  // values would put those keys in the GraphQL input as nulls.
  const changed = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined));
  if (Object.keys(changed).length === 0) {
    // Nothing to write. Re-read so the caller still gets a current record.
    const current = unwrap(await getClient().models.Assessment.get({ id }));
    if (current === null) throw new Error('Assessment not found');
    return current;
  }

  const result = await getClient().models.Assessment.update({ id, ...changed });
  const updated = unwrap(result);
  if (updated === null) throw new Error('Update returned no record');
  return updated;
}

/* ────────────────────────── proposals & approvals ────────────────────────── */

/**
 * Versions for an assessment, newest first.
 *
 * Sorted on `versionKey`, which is a ZERO-PADDED string ('v0004'). That is why it
 * sorts correctly as text — `versionNumber` is an integer and must never be used
 * for ordering.
 */
export async function listProposalVersions(assessmentId: string): Promise<ProposalVersionRecord[]> {
  const result = await getClient().models.ProposalVersion.proposalVersionsByAssessment({ assessmentId });
  const items = unwrap(result) ?? [];
  return [...items].sort((a, b) => (b.versionKey ?? '').localeCompare(a.versionKey ?? ''));
}

/** Decision history for a proposal, newest first. Append-only server-side. */
export async function listApprovals(proposalId: string): Promise<ApprovalRecord[]> {
  const result = await getClient().models.Approval.approvalsByProposal({ proposalId });
  const items = unwrap(result) ?? [];
  return [...items].sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
}

/**
 * Send history for a proposal, newest first. Append-only server-side.
 *
 * Includes attempts that were refused (`blocked`) and attempts that broke
 * (`failed`), not only successful sends. That is the point of the list: "why
 * has the client not received this?" is answered here, in the console, rather
 * than in CloudWatch.
 */
export async function listDeliveries(proposalId: string): Promise<ProposalDeliveryRecord[]> {
  const result = await getClient().models.ProposalDelivery.deliveriesByProposal({ proposalId });
  const items = unwrap(result) ?? [];
  return [...items].sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
}

/**
 * Builds the client PDF's S3 key the SAME way price-proposal's handler does
 * (amplify/functions/price-proposal/handler.ts: `proposals/client/${proposalId}/${versionKey}.pdf`).
 *
 * Deliberately NOT read from ProposalVersion.pdfS3Key. That field exists in
 * the schema but has no write path: render-proposal-pdf is invoked
 * fire-and-forget (InvocationType 'Event', so Chromium's cold start never
 * blocks Generate), its return value goes nowhere, and update/delete are
 * disabled on ProposalVersion outright — immutability is a deliberate,
 * explicitly-documented guarantee for the PRICING content, not something to
 * loosen just to shuttle this one operational field back. The S3 key needs
 * no round trip at all: proposalId and versionKey are known the moment a
 * version exists, so the console computes the same deterministic path
 * price-proposal already uses and asks S3 directly whether that object is
 * there yet.
 */
function clientPdfKey(proposalId: string, versionKey: string): string {
  return `proposals/client/${proposalId}/${versionKey}.pdf`;
}

/**
 * A short-lived, presigned download link for a rendered proposal PDF, or
 * null if it has not finished rendering yet.
 *
 * The console never reads proposals/client/* directly with a raw S3 call —
 * getUrl() goes through the SAME Cognito Identity Pool credentials the rest
 * of the app already uses, so it is bound by the existing storage rule
 * (allow.groups(['contributor','approver']).to(['read'])). No new IAM grant
 * is needed; this only exposes what staff could already reach.
 *
 * validateObjectExistence is what makes "not rendered yet" distinguishable
 * from "rendering is broken" — without it, getUrl() happily signs a URL for
 * an object that may not exist, and the failure only shows up later as a
 * confusing 403 in a new tab instead of a clear state in the panel.
 *
 * expiresIn is short (5 minutes) on purpose: the link is generated the
 * moment someone clicks "View PDF", used immediately, and not meant to be
 * copied around or bookmarked — the proposal itself is confidential client
 * business information.
 */
export async function getPdfUrl(proposalId: string, versionKey: string): Promise<string | null> {
  try {
    const { url } = await getUrl({
      path: clientPdfKey(proposalId, versionKey),
      options: { expiresIn: 300, validateObjectExistence: true },
    });
    return url.toString();
  } catch (e) {
    // validateObjectExistence throws a StorageError (name: 'NotFound') when
    // the object genuinely does not exist — the expected "still rendering"
    // case, not a failure. Anything else (auth, network) is rethrown so it
    // surfaces as a real error instead of being silently swallowed here.
    if (e instanceof Error && e.name === 'NotFound') return null;
    throw e;
  }
}

/**
 * Record an approval or rejection.
 *
 * `expectedContentSha256` is the fingerprint the approver was actually shown. The
 * backend refuses if it no longer matches the stored version, so a proposal that
 * changed mid-review cannot be approved by accident.
 *
 * A contributor calling this is rejected by AppSync before the Lambda runs —
 * `allow.group('approver')` on the mutation is the real boundary.
 */
export async function decideProposal(input: {
  proposalId: string;
  versionKey: string;
  decision: 'approved' | 'rejected';
  expectedContentSha256: string;
  reason: string | null;
}) {
  const result = await getClient().mutations.decideProposal(input);
  return unwrap(result);
}

/**
 * Permanently delete a proposal version that has not been approved.
 *
 * Calls `discardProposalVersion`, NOT `models.ProposalVersion.delete()`. Two
 * separate reasons, both load-bearing:
 *
 *  1. Staff hold read-only on ProposalVersion, so the model's own delete is
 *     refused by AppSync outright. The mutation's Lambda is the only principal
 *     that can delete, and it refuses anything whose latest decision is
 *     'approved' — the rule lives behind the API, not in this file.
 *  2. The names differ on purpose. `deleteProposalVersion` is the model's
 *     AUTO-GENERATED mutation; a custom mutation cannot reuse that name (the
 *     deploy rejects it as a redeclaration), which is why ours is `discard`.
 */
export async function discardProposalVersion(input: {
  proposalId: string;
  versionKey: string;
}) {
  const result = await getClient().mutations.discardProposalVersion(input);
  return unwrap(result);
}

/**
 * Create an immutable priced proposal version from an assessment.
 *
 * Available to BOTH staff roles: drafting a priced document is normal
 * contributor work. The privileged act is APPROVING it.
 *
 * The backend still refuses to price unconfirmed counts and refuses Enterprise
 * outright, so this widens who can draft, not what may be quoted.
 */
export async function generateProposal(input: {
  assessmentId: string;
  tier: string;
  supportPlan: string | null;
  priceFactor: number | null;
}) {
  const result = await getClient().mutations.generateProposal(input);
  return unwrap(result);
}

/**
 * Email an approved proposal version to the client.
 *
 * TAKES NO RECIPIENT. The address is read server-side from the clinic's own
 * contact details on the assessment, so nothing the console sends can redirect
 * a proposal to a different inbox.
 *
 * `expectedContentSha256` is the fingerprint the sender was actually shown, the
 * same guard `decideProposal` uses. If a newer version was minted while the
 * screen was open, the backend refuses rather than mailing different numbers.
 *
 * A contributor calling this is rejected by AppSync before the Lambda runs —
 * `allow.group('approver')` on the mutation is the real boundary, not the
 * button being hidden.
 *
 * Note this resolves NORMALLY for a refusal. `ok: false` with a `status` of
 * 'blocked' is an ordinary outcome (an unverified recipient while SES is in the
 * sandbox), not an exception — the caller reads `status` and `message`.
 */
export async function sendProposalEmail(input: {
  proposalId: string;
  versionKey: string;
  expectedContentSha256: string;
}) {
  const result = await getClient().mutations.sendProposalEmail(input);
  return unwrap(result);
}
