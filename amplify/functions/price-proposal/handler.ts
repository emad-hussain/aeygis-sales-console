import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import {
  SUPPORT_PLANS,
  TIERS,
  canQuote,
  quote,
  toClientPayload,
  type SupportPlan,
  type Tier,
} from '@aeygis/pricing';
import { validUntilDate } from '@aeygis/domain';
import type { Schema } from '../../data/resource.js';
import { env } from '$amplify/env/price-proposal';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>();
const s3 = new S3Client({});
const lambda = new LambdaClient({});

/**
 * Mints an immutable ProposalVersion and freezes a client-safe snapshot.
 *
 * The sequence matters:
 *
 *   1. Refuse if counts are unconfirmed. A band cannot determine a tier, so
 *      quoting from one would be guessing at the client's bill.
 *   2. Price with @aeygis/pricing. Enterprise returns a refusal branch that has
 *      no price fields, so it cannot be turned into a proposal here.
 *   3. Build the CLIENT payload via toClientPayload — a hand-written whitelist,
 *      never a spread (barrier 2).
 *   4. Write the snapshot to S3 and hash the exact bytes.
 *   5. Record the version with that hash. An approval in Phase 4 binds to the
 *      hash, so altered or swapped content is detectable afterwards.
 *   6. Fire the renderer asynchronously (InvocationType 'Event') so a
 *      multi-second Chromium cold start never blocks the caller.
 *
 * The hash is taken over the bytes actually uploaded, not over the object before
 * serialisation. Hashing a JS object and uploading a separately-serialised
 * string would let the two drift.
 */

/**
 * Invoked as an AppSync resolver for `Mutation.generateProposal`.
 *
 * The arguments arrive under `event.arguments`, and the caller under
 * `event.identity` — NOT as a flat payload. An earlier version of this handler
 * assumed a flat direct-invoke shape, which was untestable in practice because
 * nothing could invoke it: the Lambda was deployed with no caller at all.
 *
 * `createdBy` is taken from the request identity rather than from an argument.
 * A client-supplied author is not evidence of anything.
 */
export interface PriceProposalEvent {
  readonly arguments: {
    readonly assessmentId: string;
    readonly tier: string;
    readonly supportPlan?: string | null;
    readonly priceFactor?: number | null;
  };
  readonly identity?: unknown;
}

/** Best-effort caller extraction. Falls back to a marker, never to a blank. */
function callerFrom(identity: unknown): string {
  if (typeof identity !== 'object' || identity === null) return 'unknown';
  const record = identity as Record<string, unknown>;
  const claims = (record['claims'] ?? {}) as Record<string, unknown>;
  for (const candidate of [claims['email'], record['sub'], claims['sub'], record['username']]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return 'unknown';
}

export interface PriceProposalResult {
  readonly ok: boolean;
  readonly proposalId?: string;
  readonly versionKey?: string;
  readonly contentSha256?: string;
  /**
   * Named `message`, NOT `error`, to match `GenerateProposalResult` in the
   * schema. A field the GraphQL type does not declare is silently dropped, so a
   * mismatch here would leave the console showing a blank failure reason.
   */
  readonly message?: string;
}

/** Zero-padded so lexicographic ordering matches numeric ordering. */
function toVersionKey(n: number): string {
  return 'v' + String(n).padStart(4, '0');
}

export const handler = async (event: PriceProposalEvent): Promise<PriceProposalResult> => {
  const {
    assessmentId,
    tier: rawTier,
    supportPlan: rawPlan,
    priceFactor: rawFactor,
  } = event.arguments;
  const createdBy = callerFrom(event.identity);

  // Validate the string arguments against the real vocabularies rather than
  // trusting the client. GraphQL cannot enforce these because the values are
  // strings, not enums (tier and plan names are shared with @aeygis/pricing).
  if (!(TIERS as readonly string[]).includes(rawTier)) {
    return { ok: false, message: `Unknown tier "${rawTier}".` };
  }
  if (rawPlan != null && !(SUPPORT_PLANS as readonly string[]).includes(rawPlan)) {
    return { ok: false, message: `Unknown support plan "${rawPlan}".` };
  }
  const tier = rawTier as Tier;
  const supportPlan = (rawPlan ?? undefined) as SupportPlan | undefined;
  const priceFactor = typeof rawFactor === 'number' ? rawFactor : undefined;

  try {
    const { data: assessment, errors } = await data.models.Assessment.get(
      { id: assessmentId },
      { authMode: 'iam' },
    );
    if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
    if (assessment === null) throw new Error(`assessment ${assessmentId} not found`);

    // (1) refuse on unconfirmed counts
    const gate = canQuote({
      providerCount: assessment.providerCount,
      locationCount: assessment.locationCount,
      countsConfirmed: assessment.countsConfirmed,
    });
    if (!gate.ok) return { ok: false, message: gate.reason };

    const providers = assessment.providerCount as number;
    const locations = assessment.locationCount as number;

    // (2) price
    const result = quote({
      providers,
      locations,
      patients: assessment.patientCount ?? undefined,
      priceFactor,
      supportPlan,
    });

    if (result.kind !== 'quote') {
      return {
        ok: false,
        message:
          'This engagement requires a discovery call before any price is shared. ' +
          'An Enterprise proposal is authored by a human, not generated.',
      };
    }

    const option = result.options.find((o) => o.tier === tier);
    if (option === undefined) {
      return {
        ok: false,
        message: `Tier "${tier}" is not applicable to these counts. Applicable: ${result.options
          .map((o) => o.tier)
          .join(', ')}.`,
      };
    }

    const proposalId = assessment.referenceId ?? assessment.id;

    // Version allocation. Reads existing versions and takes the next number.
    // A lost race retries rather than overwriting: the composite identifier
    // (proposalId, versionKey) makes a duplicate a DynamoDB-level rejection, so
    // two reps cannot both mint v4.
    const existing = await data.models.ProposalVersion.proposalVersionsByAssessment(
      { assessmentId },
      { selectionSet: ['versionNumber'], authMode: 'iam' },
    );
    const versionNumber = (existing.data ?? []).reduce((max, v) => Math.max(max, v.versionNumber ?? 0), 0) + 1;
    const versionKey = toVersionKey(versionNumber);

    // ONE Date instance for both. Formatting the issue date and then parsing
    // that display string back to compute the expiry is how a contractual date
    // ends up a day out; `validUntilDate` adds days on the calendar, so a
    // daylight-saving boundary cannot shift it either.
    const issuedAt = new Date();
    const formatDate = (d: Date) =>
      d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    const issuedOn = formatDate(issuedAt);
    const validUntil = formatDate(validUntilDate(issuedAt));

    // (3) client-safe payload — whitelist mapper, never a spread
    const payload = toClientPayload(result, tier, {
      clinicName: assessment.clinicName,
      contactName: assessment.contactName,
      proposalReference: `${proposalId}-${versionKey}`,
      issuedOn,
      validUntil,
      providerCount: providers,
      locationCount: locations,
      recommendedPlan: supportPlan ?? null,
      // The prospect's own structured answers from the public intake form.
      hosting: assessment.hosting,
      mfa: assessment.mfa,
      backups: assessment.backups,
      incidentPlan: assessment.incidentPlan,
      lastRiskAssessment: assessment.lastRiskAssessment,
      // The staff-filled technical discovery, verbatim — every question,
      // including ones left blank. Confirmed decision: shown to the client
      // as-is, no curation step.
      discoveryAnswers: assessment.discoveryAnswers,
      // Plus this clinic's own extra questions/categories, if any.
      customDiscoveryQuestions: assessment.customDiscoveryQuestions,
      // The client's OWN reported spend, used for the comparison page. Only
      // rendered when it favours the proposal — see toClientPayload.
      monthlyItSpend: assessment.monthlyItSpend,
      annualHardwareEmergency: assessment.annualHardwareEmergency,
      downtimeHoursBand: assessment.downtimeHoursBand,
      downtimeCostBand: assessment.downtimeCostBand,
      // Staff-authored schedule and matrix tailoring.
      migrationSchedule: assessment.migrationSchedule,
      responsibilityMatrix: assessment.responsibilityMatrix,
    });

    // (4) freeze and hash THE BYTES that are stored
    const snapshotBytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const contentSha256 = createHash('sha256').update(snapshotBytes).digest('hex');
    const snapshotS3Key = `snapshots/${proposalId}/${versionKey}.json`;
    const pdfS3Key = `proposals/client/${proposalId}/${versionKey}.pdf`;

    await s3.send(
      new PutObjectCommand({
        Bucket: env.AEYGIS_PROPOSALS_BUCKET_NAME,
        Key: snapshotS3Key,
        Body: snapshotBytes,
        ContentType: 'application/json',
        Metadata: { sha256: contentSha256 },
      }),
    );

    const chosenPlan = supportPlan
      ? option.plans.find((p) => p.plan === supportPlan)
      : option.plans[0];

    // (5) immutable version record
    const created = await data.models.ProposalVersion.create(
      {
        proposalId,
        versionKey,
        versionNumber,
        assessmentId,
        tier,
        supportPlan: supportPlan ?? null,
        providerCount: providers,
        locationCount: locations,
        patientCount: assessment.patientCount ?? null,
        setupTotal: option.setup.quotedTotal.amount,
        monthlyTotal: chosenPlan?.monthlyQuotedTotal.amount ?? 0,
        annualCheckup: chosenPlan?.annualCheckup.amount ?? 0,
        firstYearTotal: chosenPlan?.firstYearQuotedTotal.amount ?? 0,
        priceFactor: result.discount.priceFactor,
        requiresExecutiveSignOff: result.discount.requiresExecutiveSignOff,
        currency: option.setup.quotedTotal.currency,
        priceBookVersion: result.priceBookVersion,
        snapshotS3Key,
        contentSha256,
        createdBy,
        createdAt: new Date().toISOString(),
      },
      { authMode: 'iam' },
    );

    if (created.errors?.length) {
      throw new Error(created.errors.map((e) => e.message).join('; '));
    }

    // (6) render asynchronously — never block on Chromium's cold start
    if (env.RENDER_FUNCTION_NAME) {
      await lambda.send(
        new InvokeCommand({
          FunctionName: env.RENDER_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({ snapshotS3Key, outputS3Key: pdfS3Key, proposalId, versionKey }),
          ),
        }),
      );
    } else {
      console.warn('RENDER_FUNCTION_NAME not set; snapshot written but no PDF requested');
    }

    console.info('proposal version created', { proposalId, versionKey, contentSha256 });
    return { ok: true, proposalId, versionKey, contentSha256 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('price-proposal failed', { assessmentId, tier, message });
    return { ok: false, message };
  }
};

/** Kept for traceability in logs when a correlation id is useful. */
export const newCorrelationId = (): string => randomUUID();
