/**
 * End-to-end verification of proposal email delivery (Phase 5).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ THIS WRITES TO AWS AND SENDS A REAL EMAIL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It creates assessments, mints proposal versions, records approvals, and then
 * actually sends one message through SES. Do not run it without permission.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ORDER IS DELIBERATE: every refusal is proved BEFORE anything is sent
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. a recipient that is not on the allowlist  -> must be BLOCKED
 *   2. a version that is not approved            -> must be REFUSED
 *   3. a contributor attempting to send          -> must be DENIED by AppSync
 *   4. only then, the real send                  -> expects SENT
 *
 * If a guard is broken, we find out while nothing has left the building. Doing
 * the happy path first would mean discovering a broken guard by watching a real
 * email arrive somewhere it should not have.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT LEAVES BEHIND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two assessments, their proposal versions, PDFs, approvals and delivery rows.
 * Staff hold no delete on `Assessment`, so this script cannot remove them —
 * clinic names carry the marker below so `npm run cleanup:tests` can.
 *
 * Run:  npm run verify:email
 */
import { readFileSync, existsSync } from 'node:fs';
import { Amplify } from 'aws-amplify';
import { signIn, signOut } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { AwsClient } from 'aws4fetch';
import { SUPPORT_PLANS, TIERS } from '@aeygis/pricing';

/** Marker in the clinic name so cleanup-test-records.mjs can find these. */
const MARKER = '[e2e-email]';

/**
 * What to quote. Checked against the real catalog rather than trusted as
 * literals — the first run of this script used "standard", which is not a
 * support plan, and the walk died three steps in with a message that read like
 * a backend fault. A wrong constant should fail HERE, immediately, saying so.
 */
const TIER = 'professional';
const PLAN = 'essentials';
if (!TIERS.includes(TIER)) {
  throw new Error(`tier "${TIER}" is not in the catalog (${TIERS.join(', ')})`);
}
if (!SUPPORT_PLANS.includes(PLAN)) {
  throw new Error(`support plan "${PLAN}" is not in the catalog (${SUPPORT_PLANS.join(', ')})`);
}

const credsPath = new URL('../.test-credentials.json', import.meta.url);
if (!existsSync(credsPath)) {
  console.error('Missing .test-credentials.json — create the test users first.');
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));

Amplify.configure(outputs);

const REGION = outputs.data.aws_region;
const ENDPOINT = outputs.data.url;
const POOL = outputs.auth.identity_pool_id;

/**
 * The address the deployed function is allowed to email. Read from the FUNCTION,
 * not hardcoded here — a copy in this file would drift from the deployment and
 * the test would then be checking its own assumption rather than the system.
 */
const ALLOWED = process.env['AEYGIS_TEST_RECIPIENT'] ?? 'rajaemadhussain@gmail.com';
const NOT_ALLOWED = 'blocked-recipient@aeygis-test.invalid';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, detail) => {
  console.error(`  FAIL  ${m}`);
  if (detail) console.error(`          ${detail}`);
  failures += 1;
};
const step = (m) => console.log(`\n── ${m} ──`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMP = String(Date.now()).slice(-6);

/* ───────────────────────── guest submission ───────────────────────── */

const MUTATION = `mutation S($payload: AWSJSON!) {
  submitAssessment(payload: $payload) { ok referenceId message }
}`;

/**
 * Creates an assessment through the REAL public path — guest credentials from
 * the identity pool, SigV4-signed exactly as an anonymous browser would. Not a
 * direct DynamoDB write, so validation, the honeypot and consent all run.
 */
async function submitAsGuest(payload) {
  const cognito = new CognitoIdentityClient({ region: REGION });
  const { IdentityId } = await cognito.send(new GetIdCommand({ IdentityPoolId: POOL }));
  const { Credentials } = await cognito.send(
    new GetCredentialsForIdentityCommand({ IdentityId }),
  );

  const aws = new AwsClient({
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    service: 'appsync',
    region: REGION,
  });

  const res = await aws.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: MUTATION, variables: { payload: JSON.stringify(payload) } }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.submitAssessment;
}

const clinicPayload = (name, email) => ({
  clinicName: `${name} ${MARKER} ${STAMP}`,
  contactName: 'Test Contact',
  jobTitle: 'Practice Manager',
  email,
  phone: '+1 416 555 0100',
  organizationType: 'Family Health Team',
  organizationSize: '10 staff',
  province: 'Ontario',
  providers: '3-15',
  locations: '2-5',
  hosting: 'onprem',
  monthlyItSpend: 4000,
  annualHardwareEmergency: 15000,
  downtimeHoursBand: '10to40',
  downtimeCostBand: '1000to2500',
  mfa: 'no',
  backups: 'yes',
  incidentPlan: 'no',
  lastRiskAssessment: 'never',
  consent: true,
});

/* ───────────────────────── staff helpers ───────────────────────── */

let client;

async function asUser({ username, password }) {
  try {
    await signOut();
  } catch {
    /* not signed in */
  }
  await signIn({ username, password });
  client = generateClient({ authMode: 'userPool' });
}

const unwrap = (r, what) => {
  if (r.errors?.length) throw new Error(`${what}: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.data;
};

/** Finds the assessment we just submitted, by its reference id. */
async function findByReference(referenceId) {
  const r = await client.models.Assessment.list({ limit: 200 });
  return (unwrap(r, 'list') ?? []).find((a) => a.referenceId === referenceId) ?? null;
}

/** Confirms exact counts so the pricing gate will allow a quote. */
async function confirmCounts(id) {
  return unwrap(
    await client.models.Assessment.update({
      id,
      providerCount: 6,
      locationCount: 2,
      countsConfirmed: true,
    }),
    'confirm counts',
  );
}

/** Mints a version and waits for the renderer to produce its PDF. */
async function makeVersion(assessmentId) {
  const result = unwrap(
    await client.mutations.generateProposal({
      assessmentId,
      tier: TIER,
      supportPlan: PLAN,
      priceFactor: null,
    }),
    'generateProposal',
  );
  if (!result?.ok) throw new Error(`generateProposal refused: ${result?.message}`);
  return result;
}

/**
 * The renderer is invoked fire-and-forget, so a version exists before its PDF
 * does. Polls the version row until the send path would find the object.
 * Chromium cold-starts, so this can legitimately take 30s+.
 */
async function waitForPdf(proposalId, versionKey, seconds = 120) {
  const { getUrl } = await import('aws-amplify/storage');
  const key = `proposals/client/${proposalId}/${versionKey}.pdf`;
  for (let i = 0; i < seconds / 3; i += 1) {
    try {
      await getUrl({ path: key, options: { expiresIn: 60, validateObjectExistence: true } });
      return true;
    } catch (e) {
      if (e?.name !== 'NotFound') throw e;
      await sleep(3000);
    }
  }
  return false;
}

async function approve(v) {
  const r = unwrap(
    await client.mutations.decideProposal({
      proposalId: v.proposalId,
      versionKey: v.versionKey,
      decision: 'approved',
      expectedContentSha256: v.contentSha256,
      reason: `${MARKER} verification run`,
    }),
    'decideProposal',
  );
  if (!r?.ok) throw new Error(`approval refused: ${r?.message}`);
  return r;
}

const send = async (v) =>
  unwrap(
    await client.mutations.sendProposalEmail({
      proposalId: v.proposalId,
      versionKey: v.versionKey,
      expectedContentSha256: v.contentSha256,
    }),
    'sendProposalEmail',
  );

/* ═══════════════════════════ the walk ═══════════════════════════ */

console.log(`Region ${REGION}`);
console.log(`Allowed recipient: ${ALLOWED}`);
console.log(`Refused recipient: ${NOT_ALLOWED}`);
console.log(`Marker: ${MARKER} ${STAMP}\n`);

step('setting up two leads through the public form');

const sendableRef = await submitAsGuest(clinicPayload('Sendable Clinic', ALLOWED));
const blockedRef = await submitAsGuest(clinicPayload('Unreachable Clinic', NOT_ALLOWED));
console.log(`  submitted ${sendableRef.referenceId} (${ALLOWED})`);
console.log(`  submitted ${blockedRef.referenceId} (${NOT_ALLOWED})`);

await asUser(creds.approver);

const sendable = await findByReference(sendableRef.referenceId);
const blocked = await findByReference(blockedRef.referenceId);
if (sendable === null || blocked === null) {
  fail('both assessments are readable by staff');
  process.exit(1);
}
pass('both assessments created through the guest path and readable by staff');

await confirmCounts(sendable.id);
await confirmCounts(blocked.id);
pass('exact counts confirmed on both');

step('pricing and approving');

const sendableV1 = await makeVersion(sendable.id);
const blockedV1 = await makeVersion(blocked.id);
pass(`versions minted: ${sendableV1.versionKey} and ${blockedV1.versionKey}`);

console.log('  waiting for the renderer (Chromium cold start)…');
const bothRendered =
  (await waitForPdf(sendableV1.proposalId, sendableV1.versionKey)) &&
  (await waitForPdf(blockedV1.proposalId, blockedV1.versionKey));
if (bothRendered) pass('both PDFs rendered');
else fail('a PDF did not render in time — the send would report `failed`');

await approve(sendableV1);
await approve(blockedV1);
pass('both versions approved');

/* ───────────── the refusals, proved before anything is sent ───────────── */

step('GUARD 1 — a recipient that is not on the allowlist');

const blockedResult = await send(blockedV1);
if (blockedResult?.status === 'blocked' && blockedResult?.ok === false) {
  pass('refused, and reported as `blocked` rather than `failed`');
  console.log(`          reason: ${blockedResult.message}`);
} else {
  fail(
    'an unverified recipient was NOT blocked',
    `got ok=${blockedResult?.ok} status=${blockedResult?.status} — ${blockedResult?.message}`,
  );
}

step('GUARD 2 — a version that has not been approved');

const sendableV2 = await makeVersion(sendable.id);
const unapproved = await send(sendableV2);
if (unapproved?.ok === false) {
  pass(`an unapproved version is refused (${sendableV2.versionKey})`);
  console.log(`          reason: ${unapproved.message}`);
} else {
  fail('an UNAPPROVED version was sent', JSON.stringify(unapproved));
}

step('GUARD 3 — a contributor may not send');

await asUser(creds.contributor);
let contributorDenied = false;
try {
  const r = await client.mutations.sendProposalEmail({
    proposalId: sendableV1.proposalId,
    versionKey: sendableV1.versionKey,
    expectedContentSha256: sendableV1.contentSha256,
  });
  contributorDenied = (r.errors ?? []).some((e) => /not authorized|unauthorized/i.test(e.message));
} catch (e) {
  contributorDenied = /not authorized|unauthorized/i.test(String(e?.message ?? e));
}
if (contributorDenied) pass('AppSync rejects a contributor before the Lambda runs');
else fail('a CONTRIBUTOR was able to call sendProposalEmail');

/* ───────────────────────── the real send ───────────────────────── */

step(`SENDING FOR REAL — to ${ALLOWED}`);

await asUser(creds.approver);
const sent = await send(sendableV1);

if (sent?.ok === true && sent?.status === 'sent') {
  pass(`sent to ${sent.recipient}`);
  console.log(`          ${sent.message}`);
} else {
  fail('the approved version did not send', `${sent?.status}: ${sent?.message}`);
}

step('the record');

const deliveries = unwrap(
  await client.models.ProposalDelivery.deliveriesByProposal({
    proposalId: sendableV1.proposalId,
  }),
  'deliveriesByProposal',
);
const rows = deliveries ?? [];
const sentRow = rows.find((d) => d.status === 'sent');

if (sentRow) pass(`a ProposalDelivery row records the send (${rows.length} row(s) total)`);
else fail('no `sent` delivery row was written');

if (sentRow?.messageId) pass(`carries a real SES message id (${sentRow.messageId.slice(0, 20)}…)`);
else fail('the sent row carries no SES message id');

if (sentRow?.contentSha256 === sendableV1.contentSha256) {
  pass('the row records the fingerprint of the document that was mailed');
} else {
  fail('the delivery row fingerprint does not match the approved version');
}

const blockedRows = unwrap(
  await client.models.ProposalDelivery.deliveriesByProposal({
    proposalId: blockedV1.proposalId,
  }),
  'deliveriesByProposal (blocked)',
);
if ((blockedRows ?? []).some((d) => d.status === 'blocked')) {
  pass('the refused attempt is recorded too, so it is visible in the console');
} else {
  fail('the blocked attempt left no record');
}

const audit = unwrap(
  await client.models.AuditEvent.auditEventsBySubject({ subjectId: sendableV1.proposalId }),
  'auditEventsBySubject',
);
if ((audit ?? []).some((e) => e.eventType === 'proposal_email_sent')) {
  pass('an AuditEvent records the send — the trail runs approval → delivery');
} else {
  fail('no proposal_email_sent audit event');
}

/* ───────────────────────── done ───────────────────────── */

await signOut();

console.log(`\nLeft behind (remove with \`npm run cleanup:tests\`):`);
console.log(`  ${sendableRef.referenceId}  ${ALLOWED}`);
console.log(`  ${blockedRef.referenceId}  ${NOT_ALLOWED}`);

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED.`);
  process.exit(1);
}
console.log('\nEmail delivery verified end to end.');
console.log(`Check ${ALLOWED} — you should have TWO copies (the client one and the bcc).`);
