/**
 * Task 1.13 verification — guest can WRITE, guest cannot READ.
 *
 * This is the security claim the entire public intake path rests on, so it is
 * asserted against the DEPLOYED API rather than reasoned about.
 *
 * Deliberately uses raw Cognito Identity + SigV4 rather than the aws-amplify
 * library. Two reasons:
 *   1. It reproduces exactly what an anonymous browser does — GetId,
 *      GetCredentialsForIdentity, then a SigV4-signed POST — with no library
 *      layer that might silently substitute a different auth mode.
 *   2. aws-amplify's credential caching assumes browser storage and fails in
 *      Node with "No credentials", which would make every read test appear to
 *      pass for the wrong reason.
 *
 * That second point is the important one: a denial test is only meaningful if
 * we KNOW the credentials work. So the read-denial checks are gated behind a
 * successful write — if we cannot obtain guest credentials, the reads are
 * reported INCONCLUSIVE, never as passes.
 *
 * Run:  node scripts/verify-guest-access.mjs
 * Exits non-zero if any check fails or is inconclusive.
 */
import { readFileSync } from 'node:fs';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { AwsClient } from 'aws4fetch';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const REGION = outputs.data.aws_region;
const ENDPOINT = outputs.data.url;
const IDENTITY_POOL_ID = outputs.auth.identity_pool_id;

let failures = 0;
let inconclusive = 0;
const pass = (m) => console.log(`  PASS          ${m}`);
const fail = (m) => { console.error(`  FAIL          ${m}`); failures += 1; };
const skip = (m) => { console.error(`  INCONCLUSIVE  ${m}`); inconclusive += 1; };

console.log(`\nRegion:   ${REGION}`);
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Identity pool: ${IDENTITY_POOL_ID}\n`);

REGION === 'ca-central-1'
  ? pass('deployed region is ca-central-1')
  : fail(`data region is ${REGION}, expected ca-central-1`);

// --- obtain genuine anonymous guest credentials ----------------------------
const cognito = new CognitoIdentityClient({ region: REGION });
let creds = null;
try {
  const { IdentityId } = await cognito.send(
    new GetIdCommand({ IdentityPoolId: IDENTITY_POOL_ID }),
  );
  const { Credentials } = await cognito.send(
    new GetCredentialsForIdentityCommand({ IdentityId }),
  );
  creds = Credentials;
  pass(`obtained unauthenticated guest credentials (identity ${IdentityId})`);
} catch (error) {
  fail(`could not obtain guest credentials: ${error?.message ?? error}`);
}

const aws = creds
  ? new AwsClient({
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretKey,
      sessionToken: creds.SessionToken,
      service: 'appsync',
      region: REGION,
    })
  : null;

/** POST a GraphQL operation signed as the anonymous guest. */
async function asGuest(query, variables = {}) {
  const response = await aws.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const SUBMIT = `mutation S($payload: AWSJSON!) {
  submitAssessment(payload: $payload) { ok referenceId message }
}`;

// ---------------------------------------------------------------------------
console.log('\n1. Guest CAN submit an assessment');
// ---------------------------------------------------------------------------
let writeWorks = false;
if (!aws) {
  skip('no guest credentials — cannot test');
} else {
  try {
    const { status, body } = await asGuest(SUBMIT, {
      payload: JSON.stringify({
        clinicName: 'Verification Clinic',
        contactName: 'Automated Check',
        // .invalid is reserved by RFC 2606, so the backend's isTestSubmission()
        // recognises it and skips the new-lead notification. Without that this
        // check would email the team on every run and spend SES quota that
        // proposal delivery shares.
        email: 'verify@aeygis-test.invalid',
        providers: '1-2',
        locations: '1',
        hosting: 'onprem',
        mfa: 'no',
        consent: true,
      }),
    });
    const result = body?.data?.submitAssessment;
    if (body?.errors?.length) {
      fail(`submitAssessment errored (${status}): ${JSON.stringify(body.errors)}`);
    } else if (result?.ok !== true) {
      fail(`submitAssessment did not return ok:true — ${JSON.stringify(body)}`);
    } else {
      writeWorks = true;
      pass(`submitAssessment succeeded, referenceId=${result.referenceId}`);
      const allowed = new Set(['ok', 'referenceId', 'message', '__typename']);
      const leaked = Object.keys(result).filter((k) => !allowed.has(k));
      leaked.length
        ? fail(`receipt leaked fields: ${leaked.join(', ')}`)
        : pass('receipt contains only ok/referenceId/message');
    }
  } catch (error) {
    fail(`submitAssessment threw: ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n2. Guest CANNOT read or write Assessment directly');
// ---------------------------------------------------------------------------
const denialCases = [
  ['listAssessments', `query { listAssessments { items { id email clinicName } } }`],
  ['getAssessment', `query { getAssessment(id: "any") { id email } }`],
  ['assessmentsByStatus', `query { assessmentsByStatus(status: "new") { items { id email } } }`],
  [
    'createAssessment (direct)',
    `mutation { createAssessment(input: {referenceId: "X", source: "x", status: "new", submittedAt: "2026-01-01T00:00:00Z", consent: true, countsConfirmed: false}) { id } }`,
  ],
  ['updateAssessment', `mutation { updateAssessment(input: {id: "any", status: "closed"}) { id } }`],
  ['deleteAssessment', `mutation { deleteAssessment(input: {id: "any"}) { id } }`],
];

if (!writeWorks) {
  // Without a proven-working credential, a rejection tells us nothing.
  for (const [label] of denialCases) skip(`${label} — guest write never succeeded, denial unproven`);
} else {
  for (const [label, query] of denialCases) {
    try {
      const { body } = await asGuest(query);
      const payload = body?.data?.[Object.keys(body.data ?? {})[0]];
      const denied = body?.errors?.some((e) =>
        /unauthorized|not authorized|access denied|forbidden/i.test(e.message ?? ''),
      );
      if (denied) {
        pass(`${label} denied by authorization`);
      } else if (payload) {
        fail(`${label} RETURNED DATA: ${JSON.stringify(payload).slice(0, 200)}`);
      } else if (body?.errors?.length) {
        pass(`${label} rejected: ${body.errors[0].message.slice(0, 90)}`);
      } else {
        fail(`${label} neither denied nor errored — ${JSON.stringify(body).slice(0, 200)}`);
      }
    } catch (error) {
      fail(`${label} threw unexpectedly: ${error?.message ?? error}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n3. Honeypot submission is silently dropped');
// ---------------------------------------------------------------------------
if (!writeWorks) {
  skip('guest write never succeeded');
} else {
  const { body } = await asGuest(SUBMIT, {
    payload: JSON.stringify({
      email: 'bot@example.com',
      consent: true,
      _websiteUrl: 'http://spam.example',
    }),
  });
  const result = body?.data?.submitAssessment;
  // A bot must not learn that it was caught, so this still looks like success.
  result?.ok === true
    ? pass('honeypot returns opaque success (no signal to the bot)')
    : fail(`honeypot response revealed rejection: ${JSON.stringify(body)}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. Missing consent is rejected');
// ---------------------------------------------------------------------------
if (!writeWorks) {
  skip('guest write never succeeded');
} else {
  const { body } = await asGuest(SUBMIT, {
    payload: JSON.stringify({ email: 'noconsent@example.ca' }),
  });
  const result = body?.data?.submitAssessment;
  result?.ok === false && /consent/i.test(result.message ?? '')
    ? pass('submission without consent rejected with an actionable message')
    : fail(`expected consent rejection, got ${JSON.stringify(body)}`);
}

const summary =
  failures === 0 && inconclusive === 0
    ? '\nAll guest-access checks passed.\n'
    : `\n${failures} failed, ${inconclusive} inconclusive.\n`;
console.log(summary);
process.exit(failures === 0 && inconclusive === 0 ? 0 : 1);
