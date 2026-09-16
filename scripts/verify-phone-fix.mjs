/**
 * Proves an ordinary phone number no longer destroys a lead.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ THIS WRITES TO AWS. It creates up to 4 assessments.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Do not run it without permission. Follow with `npm run cleanup:tests`.
 * No email is sent: the contact address ends in `.invalid`, which
 * `isTestSubmission` skips, so no SES quota is spent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-26 two real leads were destroyed because `phone` was declared
 * `a.phone()` — AppSync's AWSPhone scalar, which refuses parentheses, dots and
 * extensions. The whole write failed and the visitor was told to email us.
 *
 * The unit tests around that fix prove the CODE passes the value through. They
 * cannot prove the WRITE succeeds, because the rejection happened in AppSync,
 * above our code, against the deployed schema. Only a real submission through
 * the real endpoint closes that gap.
 *
 * That distinction is not academic — it is exactly how the original bug hid.
 * 346 unit tests were green while the live form was throwing leads away,
 * because every fixture in the repository used the one format AWSPhone accepts.
 * A test that never sends the input a real person types is not testing the
 * thing that breaks.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONLY FOUR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Submissions are rate limited to RATE_LIMIT_MAX (5) per IP hash per hour, and
 * a rate-limited submission returns `opaqueSuccess` — indistinguishable from a
 * real one by design, so an abuser learns nothing. Every submission here comes
 * from one machine and therefore one IP hash, so a fifth and sixth would be
 * silently dropped while still reporting ok. Four leaves headroom.
 *
 * Run:  npm run verify:phone
 */
import { readFileSync } from 'node:fs';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { DynamoDBClient, ScanCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { AwsClient } from 'aws4fetch';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const REGION = outputs.data.aws_region;
const ENDPOINT = outputs.data.url;
const POOL = outputs.auth.identity_pool_id;

/** `.invalid` is RFC 2606 reserved and IS matched by isTestSubmission, so no email fires. */
const CONTACT = 'phone-check@aeygis-test.invalid';

/**
 * The formats a real person types. Three of these were fatal before the fix.
 *
 * `expectVerbatim` is the point of the whole exercise: the stored value must be
 * character-for-character what was submitted. A normaliser that "helpfully"
 * rewrote `(416) 555-1234` into `416-555-1234` would pass a weaker check while
 * throwing away the extension in the third case — which is the part a human
 * needs in order to actually place the call.
 */
const CASES = [
  { phone: '(416) 555-1234', why: 'parentheses — THE EXACT SHAPE THAT LOST TWO LEADS' },
  { phone: '416.555.1234', why: 'dots' },
  { phone: '416-555-1234 ext 22', why: 'an extension, which must survive intact' },
  { phone: '+1 416 555 0100', why: 'the format that always worked — regression guard' },
];

const MUTATION = `mutation S($payload: AWSJSON!) {
  submitAssessment(payload: $payload) { ok referenceId message }
}`;

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Region:   ${REGION}`);
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Contact:  ${CONTACT}  (RFC 2606 reserved — no email can be sent)\n`);
console.log('⛔ This creates up to 4 assessments. Run `npm run cleanup:tests` afterwards.\n');

const startedAt = Date.now() - 5_000;

// ── submit through the REAL public path, as a guest ────────────────────────
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

console.log('\nSubmitting the formats a real person types:');
const submitted = [];

for (const testCase of CASES) {
  const payload = {
    clinicName: 'Phone Format Check',
    contactName: 'Automated Check',
    email: CONTACT,
    phone: testCase.phone,
    providers: '3-15',
    locations: '2-5',
    consent: true,
  };

  const response = await aws.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MUTATION, variables: { payload: JSON.stringify(payload) } }),
  });
  const body = await response.json().catch(() => ({}));
  const receipt = body?.data?.submitAssessment;

  if (receipt?.ok === true) {
    pass(`"${testCase.phone}" accepted — ${testCase.why}`);
    submitted.push({ ...testCase, referenceId: receipt.referenceId });
  } else {
    // This is the original bug, still live.
    fail(`"${testCase.phone}" REFUSED — ${receipt?.message ?? JSON.stringify(body)}`);
    if (/could not save/i.test(receipt?.message ?? '')) {
      fail('  that is the original failure — the schema change is not deployed');
    }
  }
}

if (submitted.length === 0) {
  console.error('\nNothing was accepted. Nothing further can be checked.\n');
  process.exit(1);
}

// ── did the value survive the trip, exactly? ───────────────────────────────
/* Read from DynamoDB rather than trusting the receipt. The mutation returning
   ok proves the Lambda thought it succeeded; only the stored row proves what is
   actually there — and whether salvage quietly dropped the field to get it. */
console.log('\nReading the stored rows back:');
const ddb = new DynamoDBClient({ region: REGION });
const { TableNames = [] } = await ddb.send(new ListTablesCommand({}));
const tableName = TableNames.find((n) => n.startsWith('Assessment-'));

if (tableName === undefined) {
  fail('could not find the Assessment table');
} else {
  // Consistency lag is possible; a short wait costs nothing.
  await sleep(2000);
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: tableName }));
  const byRef = new Map(
    Items.filter((i) => i.referenceId?.S !== undefined).map((i) => [i.referenceId.S, i]),
  );

  for (const entry of submitted) {
    const row = byRef.get(entry.referenceId);
    if (row === undefined) {
      // The likeliest cause is the rate limiter: opaqueSuccess is deliberately
      // identical to a real success, so a dropped submission looks fine here.
      fail(`${entry.referenceId} was reported stored but is NOT in the table (rate limited?)`);
      continue;
    }
    const stored = row.phone?.S;
    if (stored === entry.phone) {
      pass(`${entry.referenceId}  phone stored verbatim: "${stored}"`);
    } else if (stored === undefined) {
      fail(`${entry.referenceId}  phone is MISSING — salvage dropped it to save the lead`);
    } else {
      fail(`${entry.referenceId}  phone was altered: sent "${entry.phone}", stored "${stored}"`);
    }
  }
}

// ── did the schema fix do the work, or did the safety net? ─────────────────
/* Both outcomes store a lead, so the table alone cannot tell them apart. It
   matters: a salvaged write means the scalar is STILL rejecting the field and
   only the retry is saving us — the bug would be masked, not fixed. */
console.log('\nChecking whether the salvage retry had to step in:');
const logs = new CloudWatchLogsClient({ region: REGION });

/* ── FIND THE LOG GROUP, DO NOT HARDCODE IT ───────────────────────────────
 *
 * The assertion below is "no FIELDS DROPPED line exists", and an assertion of
 * that shape passes on an empty result — including the empty result you get
 * from querying a log group that does not exist. A hardcoded name that drifted
 * (the Lambda replaced, the stack renamed) would report a clean bill of health
 * for a check that never ran. That is gotcha §16.21, and it is worse than a
 * false alarm because nobody investigates a pass.
 *
 * So the group is discovered, and anything other than exactly one match is a
 * hard failure rather than a quiet skip. */
const { logGroups = [] } = await logs.send(
  new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/lambda/amplify-' }),
);
const candidates = logGroups
  .map((g) => g.logGroupName ?? '')
  .filter((n) => /submitassessment/i.test(n));

let logGroupName = null;
if (candidates.length === 1) {
  logGroupName = candidates[0];
  pass(`found the submit-assessment log group (${logGroupName.slice(-28)})`);
} else if (candidates.length === 0) {
  fail('no submit-assessment log group found — the salvage check below cannot run');
} else {
  fail(`${candidates.length} log groups match "submitassessment" — cannot tell which is current`);
}

if (logGroupName !== null) {
  let droppedLines = [];
  /* Positive control: prove the query actually reaches this group before
     trusting an empty result from it. Every submission logs "assessment
     stored", so if THAT is missing too, the absence of FIELDS DROPPED means
     nothing. */
  let storedLines = [];

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await sleep(3000);
    const { events = [] } = await logs.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: startedAt,
        filterPattern: '"assessment stored"',
      }),
    );
    const mine = events.filter((e) =>
      submitted.some((s) => (e.message ?? '').includes(s.referenceId)),
    );
    storedLines = mine;
    droppedLines = mine.filter((e) => (e.message ?? '').includes('FIELDS DROPPED'));
    if (storedLines.length >= submitted.length) break;
    process.stdout.write(`  attempt ${attempt}/8…\r`);
  }
  console.log('');

  if (storedLines.length === 0) {
    fail('no "assessment stored" lines found for our submissions — the log query proved nothing');
  } else if (droppedLines.length === 0) {
    pass(`no salvage was needed — the schema itself accepted every number (${storedLines.length} lines read)`);
  } else {
    fail(`salvage had to rescue ${droppedLines.length} submission(s) — the scalar is still refusing`);
    for (const line of droppedLines.slice(0, 3)) console.error(`        ${line.message.trim()}`);
  }
}

console.log(
  failures === 0
    ? '\nAn ordinary phone number no longer costs us the lead.\n' +
      'Every format stored verbatim, and the salvage retry was never needed.\n\n' +
      'NOTE: this proves the write path. It does not prove the SALVAGE path, which\n' +
      'cannot be triggered from the public form any more now that phone is a string\n' +
      '— that one is covered by salvage.test.ts alone.\n\n' +
      '⛔ Run `npm run cleanup:tests` to remove the records this created.\n'
    : `\n${failures} CHECK(S) FAILED.\n\n` +
      '⛔ Run `npm run cleanup:tests` to remove anything this created.\n',
);
process.exit(failures === 0 ? 0 : 1);
