import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { submitAssessment } from '../functions/submit-assessment/resource.js';
import { priceProposal } from '../functions/price-proposal/resource.js';
import { decideProposal } from '../functions/decide-proposal/resource.js';
import { deleteProposalVersion } from '../functions/delete-proposal-version/resource.js';
import { sendProposalEmail } from '../functions/send-proposal-email/resource.js';

/**
 * ============================================================================
 * SECURITY MODEL — read before editing
 * ============================================================================
 *
 * The public assessment form must be able to WRITE but must never be able to
 * READ. That is achieved structurally, not with an authorization rule:
 *
 *   `Assessment` carries NO guest rule at all.
 *
 * Guests can only call `Mutation.submitAssessment`, which returns a small
 * receipt type (`SubmitAssessmentResult`) — never `Assessment` fields. Because
 * no `Assessment` field carries a guest rule, the unauthenticated IAM role's
 * policy contains no `Assessment` ARNs whatsoever. Read-impossibility does not
 * depend on getting a rule right.
 *
 * Do NOT be tempted to replace this with `allow.guest().to(['create'])` on the
 * model. That looks equivalent and is not, for two reasons:
 *
 *   1. AppSync returns the created object from a create mutation, so the caller
 *      reads back their own row including server-generated fields.
 *   2. It grants the unauth role write access to EVERY field on the model —
 *      including any internal field added later (assignedTo, qualificationScore,
 *      internalNotes). That is a latent privilege-escalation surface that grows
 *      silently as the model grows.
 *
 * The Lambda is therefore the only writer of `Assessment`. It validates,
 * normalizes, rate-limits, and sets all server-owned fields.
 * ============================================================================
 */

const schema = a
  .schema({
    /**
     * Receipt returned to an anonymous submitter. Deliberately minimal: enough
     * to reference the submission in a support conversation, and nothing more.
     * Never widen this to include assessment content.
     */
    SubmitAssessmentResult: a.customType({
      ok: a.boolean().required(),
      referenceId: a.string().required(),
      message: a.string(),
    }),

    /**
     * A prospect's cloud readiness assessment.
     *
     * Written only by the submit-assessment Lambda. Readable and updatable by
     * staff, who fill gaps and correct band-derived estimates in the console.
     */
    Assessment: a
      .model({
        // ---- reference & provenance -------------------------------------
        referenceId: a.string().required(),
        source: a.string().required(),
        status: a.string().required(),

        // Explicit timestamp rather than the implicit `createdAt`. Using a
        // system field as a GSI sort key requires declaring it, so we own this
        // one outright. ISO-8601 sorts correctly lexicographically, which is
        // what makes it safe as a sort key (an integer would NOT be).
        submittedAt: a.datetime().required(),

        // SHA-256 of (client IP + a server-side salt), never the raw IP.
        // Enough to rate-limit a repeat submitter; not a stored identifier.
        submitterIpHash: a.string(),

        // ---- contact ----------------------------------------------------
        clinicName: a.string(),
        contactName: a.string(),
        email: a.email(),

        // Deliberately a STRING, not a.phone().
        //
        // a.phone() is AppSync's AWSPhone scalar, which accepts digits with
        // spaces or hyphens and an optional "+" country code -- and nothing
        // else. On 2026-08-26 two real submissions were destroyed by it: the
        // visitor typed an ordinary number, AppSync refused the variable, the
        // whole write failed, and the form said "we could not save your
        // assessment". An OPTIONAL field took the entire lead down with it.
        //
        // The deeper problem is WHERE that validation sits. A scalar rejects
        // at write time, inside the Lambda, long after the visitor has gone --
        // so it can only ever destroy a submission, never help anyone correct
        // one. Compare `email`, checked in validate.ts, which comes back as a
        // fixable message. Format rules belong there, where a failure is a
        // sentence the submitter can act on.
        //
        // And this value is read by a human dialling it, so "416-555-1234 ext
        // 22" is MORE useful than a number normalised into something AWSPhone
        // would accept. Storing what they actually typed is the point.
        phone: a.string(),
        jobTitle: a.string(),
        organizationType: a.string(),
        organizationSize: a.string(),
        province: a.string(),

        // ---- scale: exact counts are authoritative ----------------------
        // The live form only supplies bands, which cannot determine a tier
        // (see packages/domain/src/bands.ts). We store the band for
        // provenance, a widened range, and the exact figures once staff
        // confirm them. Pricing reads ONLY the exact counts.
        providerBand: a.string(),
        locationBand: a.string(),
        providerCountMin: a.integer(),
        providerCountMax: a.integer(),
        locationCountMin: a.integer(),
        locationCountMax: a.integer(),
        providerCount: a.integer(),
        locationCount: a.integer(),
        patientCount: a.integer(),
        countsConfirmed: a.boolean().required(),

        // ---- current infrastructure & spend -----------------------------
        hosting: a.string(),
        monthlyItSpend: a.float(),
        annualHardwareEmergency: a.float(),
        downtimeHoursBand: a.string(),
        downtimeCostBand: a.string(),

        // ---- security & compliance posture ------------------------------
        mfa: a.string(),
        backups: a.string(),
        incidentPlan: a.string(),
        lastRiskAssessment: a.string(),

        // ---- consent (CASL / PIPEDA) ------------------------------------
        consent: a.boolean().required(),
        consentedAt: a.datetime(),

        // ---- technical discovery (staff-filled, Phase 2) ----------------
        // The 20 approved questions. Stored as JSON so the question set can be
        // revised without a schema migration — the user has said the questions
        // will be finalized in a later round.
        //
        // Keyed by question id for BOTH standard and custom questions, which is
        // why parseCustomDiscoverySchema refuses a custom id that would shadow
        // q01-q20: a collision here silently overwrites an approved answer.
        discoveryAnswers: a.json(),

        // This clinic's OWN extra questions and categories, if any. Per
        // assessment by design: adding one here does not touch the approved
        // 20 and does not appear for any other client. Shape is
        // `CustomDiscoverySchema` in @aeygis/domain.
        customDiscoveryQuestions: a.json(),

        // ---- staff-authored proposal content (Phase "proposal depth") ----
        // Timing estimates per migration phase. Free text, because no approved
        // document states phase durations and the system must not imply a
        // precision it does not have. Shape: `MigrationSchedule`.
        migrationSchedule: a.json(),

        // Per-client tailoring of the shared responsibility matrix: which
        // approved rows to exclude, plus clinic-specific rows to add. The
        // approved wording itself is NOT editable — see the note in
        // @aeygis/domain/proposalContent.ts. Shape:
        // `ResponsibilityCustomisation`.
        responsibilityMatrix: a.json(),

        // ---- internal ---------------------------------------------------
        internalNotes: a.string(),
        assignedTo: a.string(),
      })
      .secondaryIndexes((index) => [
        index('status').sortKeys(['submittedAt']).queryField('assessmentsByStatus'),
        // Backs per-IP rate limiting without a separate throttle table: the
        // Lambda counts recent submissions sharing an IP hash. Reusing this
        // index avoids provisioning infrastructure whose only job is counting.
        index('submitterIpHash')
          .sortKeys(['submittedAt'])
          .queryField('assessmentsBySubmitterIpHash'),
      ])
      .authorization((allow) => [
        // NO allow.guest() — see the security model note above.
        allow.groups(['contributor', 'approver']).to(['read', 'update']),
      ]),

    /**
     * ========================================================================
     * An immutable priced proposal version.
     * ========================================================================
     *
     * CONTENT IMMUTABILITY IS STRUCTURAL, NOT CONVENTIONAL.
     *
     * `disableOperations(['update'])` removes updateProposalVersion from the
     * GraphQL schema entirely. It does not exist to be called, so no future edit
     * to an authorization rule can reintroduce it by accident.
     *
     * Why it matters: Phase 4 records an approval against a specific version and
     * its `contentSha256`. If a version could be EDITED after approval, the
     * approval would silently start referring to different content — an approver
     * would appear to have signed off on numbers they never saw.
     *
     * To change a proposal, mint a new version. Content is never rewritten.
     *
     * ── WHY `delete` IS NO LONGER DISABLED ──────────────────────────────────
     * It was, originally. Reversed on explicit instruction so staff can clear
     * out draft versions that accumulate during price iteration (one test
     * clinic reached seven). The weakening is bounded on purpose:
     *
     *   `delete` is present in the schema ONLY so the delete-proposal-version
     *   Lambda can call it. Staff authorization below stays `.to(['read'])`,
     *   so no signed-in caller can invoke deleteProposalVersion directly — the
     *   ONLY route is the mutation, which refuses anything whose latest
     *   decision is 'approved'.
     *
     * This is the same shape as `Approval` below, where `create` stays in the
     * schema for the Lambda while every user role holds read only. Disabling
     * the operation outright would have removed it for the Lambda too — a
     * lesson this schema already learned once and records under `Approval`.
     *
     * Note what did NOT change: `update` is still gone, so an APPROVED version
     * still cannot be altered, and an approval still cannot come to mean
     * something else. Deleting an approved version is refused in the Lambda.
     *
     * KEY DESIGN: `versionKey` is a ZERO-PADDED STRING ('v0004'), not an integer.
     * Amplify GSI sort keys are compared as strings, so an integer 10 would sort
     * before 2. `versionNumber` is kept for display only and must never be used
     * for ordering.
     */
    ProposalVersion: a
      .model({
        // Composite identity: (proposalId, versionKey). DynamoDB itself then
        // rejects a duplicate version, so two reps saving at the same moment
        // cannot both mint v4.
        proposalId: a.string().required(),
        versionKey: a.string().required(),
        versionNumber: a.integer().required(),

        assessmentId: a.string().required(),

        // ---- what was quoted -------------------------------------------
        tier: a.string().required(),
        supportPlan: a.string(),
        providerCount: a.integer().required(),
        locationCount: a.integer().required(),
        patientCount: a.integer(),

        setupTotal: a.float().required(),
        monthlyTotal: a.float().required(),
        annualCheckup: a.float().required(),
        firstYearTotal: a.float().required(),
        priceFactor: a.float().required(),
        requiresExecutiveSignOff: a.boolean().required(),

        currency: a.string().required(),
        priceBookVersion: a.string().required(),

        // ---- provenance ------------------------------------------------
        // S3 key of the frozen client-safe snapshot. The renderer reads this
        // and nothing else.
        snapshotS3Key: a.string().required(),
        // SHA-256 of the snapshot bytes. An approval binds to this, so altered
        // or swapped content is detectable after the fact.
        contentSha256: a.string().required(),
        // Populated asynchronously once Chromium finishes. The console polls it.
        pdfS3Key: a.string(),
        pdfRenderedAt: a.datetime(),
        pdfRenderError: a.string(),

        createdBy: a.string().required(),
        createdAt: a.datetime().required(),
      })
      .identifier(['proposalId', 'versionKey'])
      .disableOperations(['update'])
      .secondaryIndexes((index) => [
        index('assessmentId').sortKeys(['createdAt']).queryField('proposalVersionsByAssessment'),
      ])
      .authorization((allow) => [
        // Read-only for staff. The Lambdas are the only writers — and note this
        // deliberately does NOT include 'delete', even though the operation now
        // exists in the schema. See the note above.
        allow.groups(['contributor', 'approver']).to(['read']),
      ]),

    /**
     * ========================================================================
     * An approval decision. IMMUTABLE and append-only.
     * ========================================================================
     *
     * APPEND-ONLY, enforced two different ways — and it is worth being precise
     * about which is which:
     *
     *   `disableOperations(['update','delete'])` removes those mutations from the
     *   schema ENTIRELY. Nothing can alter or erase an approval: not a user, not a
     *   Lambda, not a future edit to an authorization rule.
     *
     *   `create` REMAINS in the schema, because the decide-proposal Lambda has to
     *   write the record. Users are kept out by authorization instead: staff hold
     *   `.to(['read'])` only, so no signed-in caller can forge a decision.
     *
     * An earlier revision disabled create as well, which was self-defeating —
     * removing it from the schema removes it for the Lambda too, leaving nothing
     * able to write. Caught by the compiler.
     *
     * WHY IT BINDS A HASH: `contentSha256` records exactly which bytes were
     * approved. `ProposalVersion` is already immutable, but the S3 snapshot it
     * points at is a separate object; binding the hash means a swapped or edited
     * snapshot is detectable afterwards. An approver must never appear to have
     * signed off on numbers they did not see.
     *
     * WHY IT SNAPSHOTS GROUPS: Cognito group membership is mutable. If someone is
     * later removed from `approver`, this record must still show they held that
     * role AT THE MOMENT OF DECISION. Resolving membership at read time would
     * quietly rewrite history.
     *
     * A reversal is a NEW record, never an edit.
     */
    Approval: a
      .model({
        proposalId: a.string().required(),
        versionKey: a.string().required(),

        decision: a.string().required(), // 'approved' | 'rejected'
        reason: a.string(),

        // The exact bytes approved.
        contentSha256: a.string().required(),

        // Who, when, and what they were at that moment.
        decidedBy: a.string().required(),
        decidedByEmail: a.string(),
        decidedByGroups: a.string().required(), // comma-joined, snapshotted
        decidedAt: a.datetime().required(),
      })
      .disableOperations(['update', 'delete'])
      .secondaryIndexes((index) => [
        index('proposalId').sortKeys(['decidedAt']).queryField('approvalsByProposal'),
      ])
      .authorization((allow) => [
        // READ ONLY for every staff role. Deliberately no create: the Lambda
        // writes via IAM, so a rep cannot manufacture an approval.
        allow.groups(['contributor', 'approver']).to(['read']),
      ]),

    /**
     * ========================================================================
     * Append-only audit trail. IMMUTABLE.
     * ========================================================================
     *
     * Broader than `Approval`: records every consequential act (priced, rendered,
     * approved, rejected, emailed) so the sequence can be reconstructed later.
     *
     * Same write model as `Approval`: update and delete are removed from the
     * schema outright, create remains but is granted to no user role, so the
     * Lambda is the only writer. `actorGroups` is snapshotted for the same reason
     * as above — membership is mutable, history must not be.
     */
    AuditEvent: a
      .model({
        // Groups related events. Usually the proposal reference.
        subjectId: a.string().required(),
        subjectType: a.string().required(), // 'assessment' | 'proposal'
        eventType: a.string().required(),

        actor: a.string().required(),
        actorEmail: a.string(),
        actorGroups: a.string(),

        // Free-form JSON detail. Never confidential data — this is readable by
        // every staff member, including contributors.
        detail: a.json(),

        occurredAt: a.datetime().required(),
      })
      .disableOperations(['update', 'delete'])
      .secondaryIndexes((index) => [
        index('subjectId').sortKeys(['occurredAt']).queryField('auditEventsBySubject'),
      ])
      .authorization((allow) => [
        allow.groups(['contributor', 'approver']).to(['read']),
      ]),

    /**
     * ========================================================================
     * A record of one attempt to email a proposal to a client. IMMUTABLE.
     * ========================================================================
     *
     * Same write model as `Approval` and `AuditEvent`, for the same reason:
     * `update` and `delete` are removed from the schema outright, `create`
     * remains for the Lambda, and every user role holds read only. Nobody can
     * edit away the record of what was sent.
     *
     * A SECOND SEND IS A SECOND ROW, never an edit of the first. Sending a
     * revised proposal is a normal thing to do, and "we sent them two versions"
     * is exactly the fact somebody will need later. Overwriting would tidy that
     * away.
     *
     * WHY `status` HAS THREE VALUES AND NOT A BOOLEAN — see the note in
     * @aeygis/domain/delivery.ts. Briefly: `blocked` (we deliberately refused,
     * nothing left the building) must never read as `failed` (we tried and
     * something broke). While the SES account is in the sandbox, `blocked` is
     * the EXPECTED outcome for a real client address, so collapsing it into
     * `failed` would make normal operation look like a fault.
     *
     * WHY IT STORES `contentSha256`: the fingerprint of the document actually
     * attached. `ProposalVersion` is immutable and the approval binds to the
     * same hash, so recording it here closes the loop — the row proves which
     * exact bytes the client received, not merely which version was named.
     */
    ProposalDelivery: a
      .model({
        proposalId: a.string().required(),
        versionKey: a.string().required(),
        // Carried so the console can list every delivery for a lead without
        // first resolving which proposals belong to it.
        assessmentId: a.string().required(),

        // 'sent' | 'blocked' | 'failed'. Plain string, not a GraphQL enum, to
        // match how `Assessment.status` is stored — and because the label
        // helper in @aeygis/domain renders an unrecognised value readably
        // rather than blanking the cell.
        status: a.string().required(),

        // The address this was aimed at. Populated even when `blocked`, since
        // "who would this have gone to" is the first question anyone asks.
        recipient: a.string(),
        bcc: a.string(),
        subject: a.string(),

        // SES's own id, present only on success. The handle for tracing a
        // specific message in CloudWatch or a bounce notification.
        messageId: a.string(),

        // Why it did not go, in words a human reads in the console. Never a
        // raw exception string.
        failureReason: a.string(),

        // Fingerprint of the document that was attached.
        contentSha256: a.string(),

        sentBy: a.string().required(),
        sentByEmail: a.string(),
        sentAt: a.datetime().required(),
      })
      .disableOperations(['update', 'delete'])
      .secondaryIndexes((index) => [
        index('proposalId').sortKeys(['sentAt']).queryField('deliveriesByProposal'),
      ])
      .authorization((allow) => [
        // READ ONLY for both staff roles. A contributor cannot send, but must
        // be able to see whether a proposal has gone out — otherwise they would
        // chase a client who already has it.
        allow.groups(['contributor', 'approver']).to(['read']),
      ]),

    /** Receipt from an approval decision. Carries no proposal content. */
    DecideProposalResult: a.customType({
      ok: a.boolean().required(),
      decision: a.string(),
      message: a.string(),
    }),

    /** Receipt from discarding a proposal version. Carries no proposal content. */
    DiscardProposalVersionResult: a.customType({
      ok: a.boolean().required(),
      message: a.string(),
    }),

    /**
     * Receipt from a send attempt.
     *
     * `ok: false` covers BOTH "we refused" and "it broke", which is why
     * `status` is here too — the console needs to say "blocked, and here is
     * why" rather than showing a generic failure for something the system did
     * on purpose. `message` is written for a human to read on screen.
     */
    SendProposalEmailResult: a.customType({
      ok: a.boolean().required(),
      status: a.string(),
      recipient: a.string(),
      message: a.string(),
    }),

    /** Receipt from generating a proposal version. */
    GenerateProposalResult: a.customType({
      ok: a.boolean().required(),
      proposalId: a.string(),
      versionKey: a.string(),
      contentSha256: a.string(),
      message: a.string(),
    }),

    /**
     * The single public entry point. Guest-authorized, Lambda-backed.
     * Returns a receipt, never model data.
     */
    submitAssessment: a
      .mutation()
      .arguments({
        payload: a.json().required(),
      })
      .returns(a.ref('SubmitAssessmentResult'))
      .authorization((allow) => [allow.guest(), allow.authenticated()])
      .handler(a.handler.function(submitAssessment)),

    /**
     * Generate an immutable priced proposal version from an assessment.
     *
     * WITHOUT THIS THE PIPELINE HAD NO MIDDLE. The price-proposal Lambda existed
     * and was deployed, but nothing could invoke it, so no ProposalVersion could
     * ever be created and the approval panel was permanently empty. Found by
     * asking the plain question "how do I approve something?" and tracing the
     * path rather than trusting that the pieces connected.
     *
     * Authorized to BOTH staff roles: producing a priced document is normal
     * contributor work. The privileged act is approving it, not drafting it.
     *
     * The Lambda still refuses to price unconfirmed counts and refuses Enterprise
     * outright, so exposing this widens who can draft, not what may be quoted.
     */
    generateProposal: a
      .mutation()
      .arguments({
        assessmentId: a.string().required(),
        tier: a.string().required(),
        supportPlan: a.string(),
        // Fraction of list price, e.g. 0.9. Below the 90% floor the resulting
        // version is flagged `requiresExecutiveSignOff`.
        priceFactor: a.float(),
      })
      .returns(a.ref('GenerateProposalResult'))
      .authorization((allow) => [allow.groups(['contributor', 'approver'])])
      .handler(a.handler.function(priceProposal)),

    /**
     * Approve or reject a specific proposal version.
     *
     * AUTHORIZATION IS ENFORCED TWICE, deliberately:
     *   1. HERE, by `allow.group('approver')` — AppSync rejects a contributor
     *      before the Lambda is ever invoked.
     *   2. AGAIN inside the Lambda, which re-reads the caller's groups from the
     *      request identity.
     *
     * The second check is not redundant. It is what produces the snapshot written
     * to `Approval.decidedByGroups`, and it means the rule and the recorded
     * evidence cannot disagree.
     */
    decideProposal: a
      .mutation()
      .arguments({
        proposalId: a.string().required(),
        versionKey: a.string().required(),
        decision: a.string().required(),
        // Must match the version's stored hash. A mismatch is refused, so an
        // approver cannot approve content that changed under them.
        expectedContentSha256: a.string().required(),
        reason: a.string(),
      })
      .returns(a.ref('DecideProposalResult'))
      .authorization((allow) => [allow.group('approver')])
      .handler(a.handler.function(decideProposal)),

    /**
     * Permanently delete a proposal version that has not been approved.
     *
     * ── WHY THIS IS NOT CALLED `deleteProposalVersion` ──────────────────────
     * Because that name is already taken, by the model itself. Re-enabling
     * `delete` on ProposalVersion auto-generates `Mutation.deleteProposalVersion`,
     * and declaring a custom mutation of the same name fails the deploy outright:
     *
     *   Object type extension 'Mutation' cannot redeclare field deleteProposalVersion
     *
     * Worth recording because nothing catches it earlier: `tsc` and the unit
     * suite both pass, since the collision only exists in the SYNTHESIZED
     * GraphQL schema. It surfaces at `ampx sandbox` and nowhere before.
     *
     * The Lambda keeps its own name (delete-proposal-version) — that is an AWS
     * resource name in a different namespace and collides with nothing.
     *
     * ── THE ONLY ROUTE A USER HAS ──────────────────────────────────────────
     * The auto-generated `deleteProposalVersion` exists for this Lambda's
     * benefit, but no user role is granted it, so THIS mutation is the sole
     * entry point available to the console — and its refusal rule cannot be
     * bypassed by calling the model mutation directly.
     *
     * Authorized to BOTH staff roles, matching who can CREATE a version:
     * clearing out drafts from price iteration is ordinary drafting work. The
     * privileged act remains approving, and an approved version cannot be
     * discarded by anyone, of either role.
     *
     * The Lambda re-checks the caller's groups from the request identity for
     * the same reason decideProposal does — the rule and the audit record it
     * writes must not be able to disagree.
     */
    discardProposalVersion: a
      .mutation()
      .arguments({
        proposalId: a.string().required(),
        versionKey: a.string().required(),
      })
      .returns(a.ref('DiscardProposalVersionResult'))
      .authorization((allow) => [allow.groups(['contributor', 'approver'])])
      .handler(a.handler.function(deleteProposalVersion)),

    /**
     * Email an APPROVED proposal version to the client.
     *
     * ── APPROVER ONLY, and not for the same reason as decideProposal ────────
     * `decideProposal` is approver-only because approving is the privileged
     * judgement. This is approver-only because it is the IRREVERSIBLE one.
     * Every other action in this schema can be undone or superseded: a version
     * can be discarded, a decision reversed by a later record, a price
     * re-quoted. Once a document is in a client's inbox it is there. That belongs
     * with the same person who approved it.
     *
     * Deliberately NOT open to contributors, unlike `generateProposal` and
     * `discardProposalVersion` — drafting is contributor work, putting a
     * document in front of a client is not.
     *
     * ── WHY THIS IS NOT AUTOMATIC ON APPROVAL ───────────────────────────────
     * Approving and sending stay separate acts. Staff may approve on Tuesday
     * and send on Friday after a call. More importantly, if approval fired an
     * email there would be no gap in which to catch a mis-click. This is what
     * decide-proposal's own success message already promises the approver:
     * "Delivery is a separate, explicit step."
     *
     * ── WHAT THE LAMBDA STILL CHECKS ────────────────────────────────────────
     * AppSync enforces the group before the function runs, and the function
     * re-reads it anyway — same pattern as decideProposal, so the rule and the
     * audit record it writes cannot disagree. It also re-reads the approval
     * history and re-hashes the stored snapshot. The console only offers this
     * on an approved version, but a hidden button is a convenience, not a
     * control.
     *
     * Deliberately takes no recipient argument. The address comes from the
     * clinic's own contact details on the assessment, so a caller cannot
     * redirect a proposal by passing a different one.
     */
    sendProposalEmail: a
      .mutation()
      .arguments({
        proposalId: a.string().required(),
        versionKey: a.string().required(),
        // Must match the version's stored hash, exactly as decideProposal
        // requires. Stops a send racing a newly-minted version: the sender
        // states which bytes they believe they are mailing.
        expectedContentSha256: a.string().required(),
      })
      .returns(a.ref('SendProposalEmailResult'))
      .authorization((allow) => [allow.group('approver')])
      .handler(a.handler.function(sendProposalEmail)),
  })
  // Schema-level function access. Every verified example places allow.resource()
  // at schema level rather than per-model, so function data access is assumed
  // API-wide. That assumption is exactly why confidential cost data is kept
  // OUT of this schema entirely rather than protected by a rule — see
  // packages/pricing-internal.
  .authorization((allow) => [
    allow.resource(submitAssessment),
    allow.resource(priceProposal),
    allow.resource(decideProposal),
    allow.resource(deleteProposalVersion),
    allow.resource(sendProposalEmail),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Staff console is the primary consumer, so userPool is the default.
    // The public form passes authMode: 'identityPool' explicitly per call.
    defaultAuthorizationMode: 'userPool',
    // No apiKeyAuthorizationMode: an API key is a bearer credential that would
    // have to ship in the public site's JavaScript. The identity pool's
    // unauthenticated role is the documented production choice for public
    // access and issues short-lived, scoped credentials instead.
  },
});
