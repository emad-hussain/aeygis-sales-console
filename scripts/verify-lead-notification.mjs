/**
 * Proves the new-lead notification actually sends.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ THIS WRITES TO AWS AND SENDS ONE REAL EMAIL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Do not run it without permission. Follow with `npm run cleanup:tests`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT NEEDS ITS OWN SCRIPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other verification submits with a `.invalid` contact address, and the
 * backend deliberately SKIPS the notification for those — otherwise each
 * `npm run verify` run would email the team about clinics that do not exist and
 * spend SES quota that proposal delivery shares.
 *
 * That skip is correct, and it leaves a hole: nothing exercises the send. A
 * notification that silently never fires would leave leads unnoticed, which is
 * the exact problem the notification was built to solve — the failure would look
 * identical to "no leads came in". So this script exists to close that hole, on
 * demand, one email at a time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Proves: the mutation stored a lead, the Lambda attempted the send, and SES
 * ACCEPTED it and returned a message id.
 *
 * Does NOT prove the mail arrived. SES accepting a message is not delivery —
 * the same distinction `email-setup.md` documents for proposals, where the first
 * real send was accepted by SES and landed in spam. The script says so at the
 * end rather than letting a green run imply an inbox.
 *
 * Run:  npm run verify:notification
 */
import { readFileSync } from 'node:fs';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsClient } from 'aws4fetch';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const REGION = outputs.data.aws_region;
const ENDPOINT = outputs.data.url;
const POOL = outputs.auth.identity_pool_id;

const LOG_GROUP = '/aws/lambda/amplify-aeygissalesplatfo-submitassessmentlambda55-UhgcngGmpz5U';

/**
 * The contact address on the test lead.
 *
 * `.example` is reserved by RFC 2606 exactly like `.invalid`, so it can never
 * be a real domain and nothing can ever be delivered to it — but it is NOT what
 * `isTestSubmission` matches on, so the notification fires. That is the whole
 * trick: a provably fake address that still exercises the real path.
 *
 * It is on the cleanup list, so `npm run cleanup:tests` removes the record.
 */
const CONTACT = 'notification-check@aeygis-test.example';

const MUTATION = `mutation S($payload: AWSJSON!) {
  submitAssessment(payload: $payload) { ok referenceId message }
}`;

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Region:   ${REGION}`);
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Contact:  ${CONTACT}  (RFC 2606 reserved — undeliverable, and not skipped)\n`);
console.log('⛔ This sends ONE real email to the configured NOTIFY_TO_ADDRESS.\n');

// Recorded before the submission so the log query cannot pick up an older run.
const startedAt = Date.now() - 5_000;

// ── submit through the REAL public path ────────────────────────────────────
const cognito = new CognitoIdentityClient({ region: REGION });
const { IdentityId } = await cognito.send(new GetIdCommand({ IdentityPoolId: POOL }));
const { Credentials } = await cognito.send(new GetCredentialsForIdentityCommand({ IdentityId }));
pass('obtained anonymous guest credentials');

const aws = new AwsClient({
  accessKeyId: Credentials.AccessKeyId,
  secretAccessKey: Credentials.SecretKey,
  sessionToken: Credentials.SessionToken,
  service: 'appsync',
  region: REGION,
});

const payload = {
  clinicName: 'Notification Check Clinic',
  contactName: 'Automated Check',
  jobTitle: 'Practice Manager',
  email: CONTACT,
  phone: '+1 416 555 0100',
  organizationType: 'Family Health Team',
  organizationSize: '9 staff',
  province: 'Ontario',
  // Bands, so the notification should say BANDS ONLY and not claim it is priceable.
  providers: '3-15',
  locations: '2-5',
  hosting: 'onprem',
  monthlyItSpend: 4200,
  annualHardwareEmergency: 18000,
  downtimeHoursBand: '10to40',
  downtimeCostBand: '1000to2500',
  mfa: 'no',
  backups: 'unsure',
  incidentPlan: 'no',
  lastRiskAssessment: 'never',
  consent: true,
};

const response = await aws.fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: MUTATION, variables: { payload: JSON.stringify(payload) } }),
});
const body = await response.json().catch(() => ({}));
const receipt = body?.data?.submitAssessment;

if (receipt?.ok !== true) {
  fail(`the submission was not accepted: ${JSON.stringify(body)}`);
  process.exit(1);
}
pass(`assessment stored — referenceId=${receipt.referenceId}`);

// ── did the Lambda actually send? ──────────────────────────────────────────
/* CloudWatch ingestion lags a few seconds, so this polls rather than reading
   once. Polling for a LOG LINE is the honest check here: the mutation returning
   proves the write, not the send — the notification is awaited but its outcome
   is deliberately never surfaced to the caller, precisely so a mail problem
   cannot fail a stored lead. */
const logs = new CloudWatchLogsClient({ region: REGION });
let sentLine = null;
let skippedLine = null;
let failedLine = null;

console.log('\nLooking for the send in CloudWatch (ingestion lags a few seconds)…');
for (let attempt = 1; attempt <= 10; attempt += 1) {
  await sleep(3000);
  const { events = [] } = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: LOG_GROUP,
      startTime: startedAt,
      filterPattern: '"new-lead notification"',
    }),
  );
  const mine = events.filter((e) => (e.message ?? '').includes(receipt.referenceId));
  sentLine = mine.find((e) => e.message.includes('notification sent')) ?? null;
  skippedLine = mine.find((e) => e.message.includes('skipped')) ?? null;
  failedLine = mine.find((e) => e.message.includes('failed')) ?? null;
  if (sentLine || skippedLine || failedLine) break;
  process.stdout.write(`  attempt ${attempt}/10…\r`);
}
console.log('');

if (skippedLine) {
  fail('the notification was SKIPPED — the contact address was treated as a test address');
} else if (failedLine) {
  fail(`the notification FAILED: ${failedLine.message.trim()}`);
} else if (!sentLine) {
  fail('no notification log line appeared at all — the send may never have been attempted');
} else {
  pass('the Lambda logged a successful send');
  const messageId = /"messageId":"([^"]+)"/.exec(sentLine.message)?.[1]
    ?? /messageId['":\s]+([0-9a-z-]{20,})/i.exec(sentLine.message)?.[1];
  messageId
    ? pass(`SES accepted it and returned a message id: ${messageId}`)
    : fail(`the log line carried no SES message id: ${sentLine.message.trim()}`);
}

console.log(
  failures === 0
    ? '\nThe new-lead notification sends.\n' +
      'NOTE: SES accepting a message is not delivery. Check the inbox — and remember\n' +
      'the sender is still a @gmail.com address, so spam is the expected destination\n' +
      'until the domain cutover (see docs/email-setup.md).\n' +
      '\nClean up with:  npm run cleanup:tests\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
