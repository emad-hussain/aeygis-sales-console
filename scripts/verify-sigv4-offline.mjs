/**
 * Proves the live site's SigV4 implementation is byte-for-byte correct —
 * WITHOUT calling AWS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ALONGSIDE verify-browser-signing.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `verify-browser-signing.mjs` is the stronger check: it signs a real request
 * and writes a real record. But it needs credentials, it needs the backend to
 * be up, and it creates a row that then has to be cleaned up — so it is not
 * something you run on every edit.
 *
 * This one is free. It signs the same request twice: once with the code that
 * actually ships to browsers, and once with `aws4fetch`, an independent
 * implementation already in this project's dependencies. If the two
 * Authorization headers differ by a single character, the shipped code is
 * wrong and this fails.
 *
 * That matters because a SigV4 bug does NOT announce itself. AWS returns a
 * generic 403, the live site's mirror swallows it as a console warning, and the
 * result is a dual-write that looks fine and captures nothing. That exact
 * failure has already happened once on this project.
 *
 * Run:  node scripts/verify-sigv4-offline.mjs
 */
import { readFileSync } from 'node:fs';
import { AwsV4Signer } from 'aws4fetch';

const SITE_SCRIPT = 'd:/Aeygis-Work/aeygis-website-source-code/assets/js/assessment.js';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

// ── extract exactly what ships ─────────────────────────────────────────────
const source = readFileSync(SITE_SCRIPT, 'utf8');
const begin = source.indexOf('// AEYGIS_BACKEND_BEGIN');
const end = source.indexOf('// AEYGIS_BACKEND_END');

if (begin === -1 || end === -1 || end < begin) {
  fail('could not find the AEYGIS_BACKEND markers in the live site script');
  process.exit(1);
}
const block = source.slice(begin, end);
pass(`extracted ${block.split('\n').length} lines of shipped browser code`);

if (/\bdocument\b|\bwindow\b|localStorage|sessionStorage/.test(block)) {
  fail('block touches DOM/browser storage — it must stay environment-neutral so this test stays honest');
} else {
  pass('block is free of DOM access (safe to execute here)');
}

const factory = new Function(`
  ${block}
  return {
    aeygisSignedFetch, aeygisBuildPayload, aeygisSubmitWithRetry, aeygisStatusIsRetryable,
    AEYGIS_REGION, AEYGIS_IDENTITY_POOL_ID, AEYGIS_MAX_ATTEMPTS
  };
`);
const api = factory();
pass('shipped block evaluates without error');

// ── capture the request instead of sending it ──────────────────────────────
const CREDENTIALS = {
  accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'FAKE/SESSION/TOKEN/for-offline-comparison-only',
};
const ENDPOINT = 'https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql';
const GRAPHQL_BODY = {
  query: 'mutation S($payload: AWSJSON!) { submitAssessment(payload: $payload) { ok } }',
  variables: { payload: JSON.stringify({ clinicName: 'Offline Check', consent: true }) },
};

const realFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, init };
  return { ok: true, status: 200, json: async () => ({ data: { submitAssessment: { ok: true } } }) };
};

try {
  await api.aeygisSignedFetch(ENDPOINT, GRAPHQL_BODY, CREDENTIALS);
} finally {
  globalThis.fetch = realFetch;
}

if (captured === null) {
  fail('the shipped code never called fetch');
  process.exit(1);
}
pass('shipped code produced a signed request');

const shippedAuth = captured.init.headers.Authorization;
const shippedDate = captured.init.headers['X-Amz-Date'];
const shippedBody = captured.init.body;

// ── sign the identical request with an independent implementation ──────────
const signer = new AwsV4Signer({
  url: ENDPOINT,
  method: 'POST',
  body: shippedBody,
  accessKeyId: CREDENTIALS.accessKeyId,
  secretAccessKey: CREDENTIALS.secretKey,
  sessionToken: CREDENTIALS.sessionToken,
  service: 'appsync',
  region: 'ca-central-1',
  // The SAME timestamp the shipped code generated, so the only variable left
  // is the signing algorithm itself.
  datetime: shippedDate,
});
const signed = await signer.sign();
const referenceAuth = signed.headers.get('Authorization');

console.log(`\n  shipped   ${shippedAuth}`);
console.log(`  aws4fetch ${referenceAuth}\n`);

shippedAuth === referenceAuth
  ? pass('Authorization header is byte-for-byte identical to aws4fetch')
  : fail('SIGNATURE MISMATCH — the shipped signing code is wrong');

// ── the details that make a mismatch diagnosable ───────────────────────────
const shippedParts = Object.fromEntries(
  shippedAuth.replace(/^AWS4-HMAC-SHA256 /, '').split(', ').map((p) => p.split('=')),
);
const referenceParts = Object.fromEntries(
  referenceAuth.replace(/^AWS4-HMAC-SHA256 /, '').split(', ').map((p) => p.split('=')),
);

for (const key of ['Credential', 'SignedHeaders', 'Signature']) {
  shippedParts[key] === referenceParts[key]
    ? pass(`${key} matches`)
    : fail(`${key} differs: shipped=${shippedParts[key]} reference=${referenceParts[key]}`);
}

// ── the constants must match the deployed backend ──────────────────────────
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));

api.AEYGIS_REGION === outputs.data.aws_region
  ? pass(`region constant matches deployment (${api.AEYGIS_REGION})`)
  : fail(`region constant is ${api.AEYGIS_REGION}, deployment is ${outputs.data.aws_region}`);

api.AEYGIS_IDENTITY_POOL_ID === outputs.auth.identity_pool_id
  ? pass('identity pool constant matches deployment')
  : fail(
      `identity pool constant is ${api.AEYGIS_IDENTITY_POOL_ID}, ` +
        `deployment is ${outputs.auth.identity_pool_id}`,
    );

// ── the payload mapper must not forward anything it was not asked to ───────
const mapped = api.aeygisBuildPayload({
  clinicName: 'Test Clinic',
  email: 'someone@example.ca',
  providers: '1-2',
  monthlyItSpend: '',
  consent: 'on',
  injectedByAnAttacker: 'should not survive',
  internalNotes: 'neither should this',
});

'injectedByAnAttacker' in mapped || 'internalNotes' in mapped
  ? fail('payload mapper forwarded an unexpected field — it must be a whitelist, never a spread')
  : pass('payload mapper drops fields it was not told about');

mapped.consent === true
  ? pass('checkbox "on" is converted to boolean true (the backend refuses anything else)')
  : fail(`consent was mapped to ${JSON.stringify(mapped.consent)}, not boolean true`);

'monthlyItSpend' in mapped
  ? fail('an empty spend field was forwarded — it would be stored as 0, which is a different claim')
  : pass('blank fields are omitted rather than sent as empty strings');

/* ── THE ENDPOINT MUST BE SET ────────────────────────────────────────────────
 *
 * This assertion used to be the exact opposite: it required AEYGIS_API_ENDPOINT
 * to stay EMPTY, because the backend call was a mirror alongside a formsubmit.co
 * email and activating it was a deliberate act to be taken separately.
 *
 * That inverted on 2026-08-25. The email was removed and the backend became the
 * only destination, so a blank endpoint no longer means "the mirror is off" — it
 * means every lead is silently discarded, with the visitor shown a report and no
 * indication that nobody received their details.
 *
 * The old assertion would now pass on exactly the broken state, which is why it
 * is replaced rather than deleted. */
const endpointLine = source.split('\n').find((l) => l.includes('const AEYGIS_API_ENDPOINT'));
const endpointMatch = /const AEYGIS_API_ENDPOINT\s*=\s*['"]([^'"]*)['"]/.exec(endpointLine ?? '');
const shippedEndpoint = endpointMatch?.[1] ?? '';

if (shippedEndpoint === '') {
  fail('AEYGIS_API_ENDPOINT is EMPTY — the form has nowhere to submit, and every lead would be lost');
} else if (shippedEndpoint !== outputs.data.url) {
  fail(`AEYGIS_API_ENDPOINT is ${shippedEndpoint}, but the deployed API is ${outputs.data.url}`);
} else {
  pass('AEYGIS_API_ENDPOINT is set and matches the deployed API');
}

/* A blank endpoint must be LOUD, not silent. While this was a mirror, returning
 * quietly was correct; as the only path it would hide the very failure it causes.
 *
 * Tested against a PATCHED COPY of the block with the endpoint blanked, rather
 * than by passing '' as the override — '' is falsy, so the override would fall
 * through to the real constant and the "test" would fire a live request at AWS.
 * (First version of this check did exactly that.) */
const blankedBlock = block.replace(
  /const AEYGIS_API_ENDPOINT\s*=\s*['"][^'"]*['"]/,
  "const AEYGIS_API_ENDPOINT = ''",
);
blankedBlock !== block
  ? pass('built a blanked copy of the block for the next check')
  : fail('could not blank the endpoint for testing — the constant did not match');

const blankedApi = new Function(`${blankedBlock}\n  return { aeygisSubmitToBackend };`)();

// Belt and braces: if the blanking silently failed, nothing should still escape.
const guardedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('the blank-endpoint check attempted a network call'); };
let blankError = null;
try {
  await blankedApi.aeygisSubmitToBackend({ clinicName: 'x', consent: true });
} catch (error) {
  blankError = error;
} finally {
  globalThis.fetch = guardedFetch;
}

blankError !== null && /AEYGIS_API_ENDPOINT is not set/.test(String(blankError.message))
  ? pass('submitting with no endpoint THROWS a clear error rather than failing silently')
  : fail(`submitting with no endpoint did not fail usefully: ${blankError?.message ?? 'it returned quietly'}`);

/* ── RETRY BEHAVIOUR ─────────────────────────────────────────────────────────
 *
 * This is the only destination a lead has, so a retry that quietly stopped
 * working would cost real leads and announce nothing. Each case below is
 * exercised against a stubbed fetch — no network, no AWS.
 *
 * The classification is what matters most: retrying a REFUSAL would send the
 * same rejected payload three times and tell the visitor nothing useful, while
 * failing to retry a dropped packet is the whole reason this exists.
 */
console.log('\nRetry classification:');
[
  [408, true, 'request timeout'],
  [429, true, 'throttled'],
  [500, true, 'server error'],
  [503, true, 'unavailable'],
  [400, false, 'bad request'],
  [401, false, 'unauthorized'],
  [403, false, 'forbidden'],
  [404, false, 'not found'],
].forEach(([status, expected, label]) => {
  api.aeygisStatusIsRetryable(status) === expected
    ? pass(`${status} ${label} → ${expected ? 'retry' : 'do not retry'}`)
    : fail(`${status} ${label} classified wrongly`);
});

console.log('\nRetry behaviour:');
const RECEIPT = { ok: true, referenceId: 'AEY-RETRY1', message: 'stored' };

/** Stubs the whole conversation. `plan` is consumed one entry per AppSync call. */
function stubFetch(plan) {
  const seen = { appsync: 0, attempts: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('cognito-identity')) {
      const target = init.headers['X-Amz-Target'] ?? '';
      const body = target.includes('GetCredentialsForIdentity')
        ? { Credentials: { AccessKeyId: 'A', SecretKey: 'S', SessionToken: 'T' } }
        : { IdentityId: 'ca-central-1:stub' };
      return { ok: true, status: 200, json: async () => body };
    }
    seen.appsync += 1;
    const step = plan[Math.min(seen.appsync - 1, plan.length - 1)];
    seen.attempts.push(step.kind);
    if (step.kind === 'network') throw new TypeError('Failed to fetch');
    if (step.kind === 'status') return { ok: false, status: step.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { submitAssessment: step.receipt } }) };
  };
  return seen;
}

const ANSWERS = { clinicName: 'Retry Clinic', email: 'retry@example.ca', consent: true };
const FAST = { endpoint: 'https://stub.example/graphql', delaysMs: [1, 1] };
const realFetchAgain = globalThis.fetch;

try {
  // 1. a dropped connection, then success
  let seen = stubFetch([{ kind: 'network' }, { kind: 'ok', receipt: RECEIPT }]);
  let result = await api.aeygisSubmitWithRetry(ANSWERS, FAST);
  result?.referenceId === 'AEY-RETRY1' && seen.appsync === 2
    ? pass('a dropped connection is retried, and the second attempt succeeds')
    : fail(`expected success on attempt 2, saw ${seen.appsync} attempt(s): ${JSON.stringify(result)}`);

  // 2. two failures, then success — uses the full budget
  seen = stubFetch([{ kind: 'status', status: 503 }, { kind: 'network' }, { kind: 'ok', receipt: RECEIPT }]);
  result = await api.aeygisSubmitWithRetry(ANSWERS, FAST);
  result?.referenceId === 'AEY-RETRY1' && seen.appsync === 3
    ? pass('two transient failures are absorbed, succeeding on the third attempt')
    : fail(`expected success on attempt 3, saw ${seen.appsync}`);

  // 3. gives up rather than looping for ever
  seen = stubFetch([{ kind: 'network' }]);
  let threw = null;
  try { await api.aeygisSubmitWithRetry(ANSWERS, FAST); } catch (e) { threw = e; }
  threw !== null && seen.appsync === api.AEYGIS_MAX_ATTEMPTS
    ? pass(`gives up after ${api.AEYGIS_MAX_ATTEMPTS} attempts and throws`)
    : fail(`expected a throw after ${api.AEYGIS_MAX_ATTEMPTS} attempts, saw ${seen.appsync} and ${threw ? 'a throw' : 'no throw'}`);

  // 4. a REFUSAL is not retried — the payload would be rejected identically
  seen = stubFetch([{ kind: 'ok', receipt: { ok: false, message: 'a valid email is required' } }]);
  result = await api.aeygisSubmitWithRetry(ANSWERS, FAST);
  seen.appsync === 1 && result?.ok === false
    ? pass('a refusal is returned immediately, never retried')
    : fail(`a refusal was retried ${seen.appsync} time(s)`);

  // 5. a 4xx is not retried either
  seen = stubFetch([{ kind: 'status', status: 400 }]);
  threw = null;
  try { await api.aeygisSubmitWithRetry(ANSWERS, FAST); } catch (e) { threw = e; }
  seen.appsync === 1 && threw !== null
    ? pass('a 400 is not retried — the same bytes would fail the same way')
    : fail(`a 400 was attempted ${seen.appsync} time(s)`);

  // 6. progress is reported per attempt, so the page can say what is happening
  seen = stubFetch([{ kind: 'network' }, { kind: 'ok', receipt: RECEIPT }]);
  const reported = [];
  await api.aeygisSubmitWithRetry(ANSWERS, {
    ...FAST,
    onAttempt: (attempt, total) => reported.push(`${attempt}/${total}`),
  });
  reported.join(' ') === `1/${api.AEYGIS_MAX_ATTEMPTS} 2/${api.AEYGIS_MAX_ATTEMPTS}`
    ? pass('each attempt is reported to the caller for display')
    : fail(`attempt reporting was ${JSON.stringify(reported)}`);
} finally {
  globalThis.fetch = realFetchAgain;
}

console.log(
  failures === 0
    ? '\nShipped signing code verified offline. Run verify-browser-signing.mjs to prove it against real AWS.\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
