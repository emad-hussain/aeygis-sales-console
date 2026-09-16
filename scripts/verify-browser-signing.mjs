/**
 * Proves the LIVE SITE's submission code actually authenticates.
 *
 * Why this exists: the first version of that code sent an unsigned fetch with an
 * optional `x-api-key`. The API has no API key and its guest auth mode is
 * AWS_IAM, so every request would have been rejected 401 — and the error
 * handling would have swallowed it as a console warning. A silently broken
 * path that looks fine. Reading the code did not catch that; only signing a
 * real request does.
 *
 * That matters more now than it did then: this WAS a mirror alongside a
 * formsubmit.co email, so a silent failure only lost the copy. Since 2026-08-25
 * it is the only destination, and a silent failure loses the lead.
 *
 * This script does NOT reimplement the signing. It reads the live site script,
 * extracts the source between the AEYGIS_BACKEND_BEGIN and AEYGIS_BACKEND_END
 * markers, and executes exactly what ships to browsers. If that block is
 * edited and breaks, this test breaks with it.
 *
 * Node 22+ provides fetch, crypto.subtle, TextEncoder and URL, which is the
 * entire browser surface the block depends on — that is why the block is kept
 * free of DOM access.
 *
 * ── THE FILE MOVED (2026-08-25) ───────────────────────────────────────────
 * The live site was rewritten from a compiled React bundle into hand-written
 * static source, which deleted assets/aeygis-enhancements.js — the file this
 * script used to read, and the file the submission code lived in. It was ported
 * into the assessment page's own script and the path updated here.
 *
 * Worth knowing because of HOW that would have failed otherwise: the old file
 * stayed on disk for a while after nothing loaded it any more, so this script
 * kept passing against code no browser was running. A green check on dead code
 * is worse than a red one.
 *
 * ── PREFER THE OFFLINE CHECK WHILE ITERATING ──────────────────────────────
 * `verify-sigv4-offline.mjs` compares the same shipped block against aws4fetch
 * byte-for-byte, needs no credentials, and writes nothing. Run that on every
 * edit; run THIS one to prove the whole path against real AWS.
 *
 * ⛔ Writes a real Assessment record. Follow with `npm run cleanup:tests`.
 *
 * Run:  node scripts/verify-browser-signing.mjs
 */
import { readFileSync } from 'node:fs';

const SITE_SCRIPT =
  'd:/Aeygis-Work/aeygis-website-source-code/assets/js/assessment.js';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

// --- extract the shipped block ---------------------------------------------
const source = readFileSync(SITE_SCRIPT, 'utf8');
const begin = source.indexOf('// AEYGIS_BACKEND_BEGIN');
const end = source.indexOf('// AEYGIS_BACKEND_END');
if (begin === -1 || end === -1 || end < begin) {
  fail('could not find AEYGIS_BACKEND markers in the live site script');
  process.exit(1);
}
const block = source.slice(begin, end);
pass(`extracted ${block.split('\n').length} lines of shipped browser code`);

if (/\bdocument\b|\bwindow\b|localStorage|sessionStorage/.test(block)) {
  fail('block touches DOM/browser storage — it must stay environment-neutral so this test stays honest');
} else {
  pass('block is free of DOM access (safe to execute here)');
}

// Execute the real source and grab its functions.
const factory = new Function(`
  ${block}
  return { aeygisSubmitToBackend, aeygisGetGuestCredentials, aeygisSignedFetch, AEYGIS_REGION, AEYGIS_IDENTITY_POOL_ID };
`);
const api = factory();
pass('shipped block evaluates without error');

// --- sanity-check the constants against the deployed backend ---------------
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const ENDPOINT = outputs.data.url;

api.AEYGIS_REGION === outputs.data.aws_region
  ? pass(`region constant matches deployment (${api.AEYGIS_REGION})`)
  : fail(`region constant is ${api.AEYGIS_REGION}, deployment is ${outputs.data.aws_region}`);

api.AEYGIS_IDENTITY_POOL_ID === outputs.auth.identity_pool_id
  ? pass('identity pool constant matches deployment')
  : fail(
      `identity pool constant is ${api.AEYGIS_IDENTITY_POOL_ID}, ` +
        `deployment is ${outputs.auth.identity_pool_id}`,
    );

// --- the real test: does the shipped code get an authenticated write? ------
console.log('\nSigning a real request with the shipped code:');
try {
  const result = await api.aeygisSubmitToBackend(
    {
      clinicName: 'Browser Signing Check',
      contactName: 'Automated Check',
      // .invalid, so the new-lead notification is skipped — see the note in
      // verify-guest-access.mjs.
      email: 'browser-signing@aeygis-test.invalid',
      providers: '1-2',
      locations: '1',
      consent: true,
    },
    // Passed explicitly so this test is pinned to the deployed API rather than
    // to whatever the shipped constant happens to say. They must agree, and
    // that agreement is asserted separately below.
    ENDPOINT,
  );
  if (result?.ok === true) {
    pass(`SigV4-signed guest write accepted — referenceId=${result.referenceId}`);
  } else {
    fail(`mutation returned unexpected result: ${JSON.stringify(result)}`);
  }
} catch (error) {
  fail(`shipped signing code failed: ${error?.message ?? error}`);
}

/* --- the endpoint must be SET -----------------------------------------------
 *
 * This asserted the OPPOSITE until 2026-08-25: the endpoint had to stay empty,
 * because the backend call was a mirror alongside a formsubmit.co email and
 * switching it on was a separate, deliberate act.
 *
 * The email was then removed and the backend became the only destination. A
 * blank endpoint no longer means "the mirror is off"; it means every lead is
 * silently discarded while the visitor is shown a finished report. The old
 * assertion would pass on precisely that broken state.
 */
console.log('\nThe form has somewhere to submit:');
const endpointLine = source
  .split('\n')
  .find((l) => l.includes('const AEYGIS_API_ENDPOINT'));
const shipped = /const AEYGIS_API_ENDPOINT\s*=\s*['"]([^'"]*)['"]/.exec(endpointLine ?? '')?.[1] ?? '';

if (shipped === '') {
  fail('AEYGIS_API_ENDPOINT is EMPTY — the live form would discard every lead');
} else if (shipped !== ENDPOINT) {
  fail(`AEYGIS_API_ENDPOINT is ${shipped}, but the deployed API is ${ENDPOINT}`);
} else {
  pass('AEYGIS_API_ENDPOINT is set and matches the deployed API');
}

console.log(
  failures === 0 ? '\nShipped browser code verified.\n' : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
