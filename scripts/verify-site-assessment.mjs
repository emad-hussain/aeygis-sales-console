/**
 * Walks the PUBLIC assessment form in a real browser, end to end.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `verify-site-pricing.mjs` proves the pricing MATHS is right, by executing the
 * shipped functions directly. It cannot see a report that never renders because
 * an element id was renamed, a step that will not advance, or a figure that is
 * computed correctly and then written into the wrong box.
 *
 * This project has learned that distinction expensively more than once: a
 * console that typechecked, built and served HTTP 200 while rendering a blank
 * page, and a Delete button that threw on its first click with a green test
 * suite behind it. "It parses" is not "it works".
 *
 * So this fills in all five steps by clicking and typing, submits, and reads
 * the rendered report back out of the page.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ NO EMAIL IS SENT AND NOTHING REACHES AWS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - Requests to formsubmit.co are INTERCEPTED and answered with a stub, so
 *     the sales inbox never receives a test submission.
 *   - The AppSync mirror is inert (AEYGIS_API_ENDPOINT is blank), and any
 *     request to AWS is intercepted and FAILED anyway, so a future edit that
 *     activated it could not make this script write a real record silently.
 *
 * The script asserts both interceptions actually held.
 *
 * Run:  node scripts/verify-site-assessment.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SITE_ROOT = 'd:/Aeygis-Work/aeygis-website-source-code';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const CANDIDATE_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No local Chrome/Edge found.');
  process.exit(1);
}

// ── serve the site exactly as it sits on disk ──────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const requested = decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(SITE_ROOT, requested === '/' ? 'index.html' : requested);
  // Refuse anything that escapes the site root.
  if (!path.resolve(full).startsWith(path.resolve(SITE_ROOT))) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
pass(`serving the site from disk at ${origin}`);

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

/* ── intercept every outbound request ───────────────────────────────────────
 *
 * The assessment now submits ONLY to AppSync — the formsubmit.co email was
 * removed on 2026-08-25. So the expectations here are the reverse of what they
 * were: zero formsubmit calls from this page, and a real AWS conversation that
 * must be STUBBED rather than allowed through. Nothing this script does may
 * write a record.
 *
 * `appsyncOutcome` lets each walk below choose what the backend "returns", which
 * is how the three delivery states are exercised without touching AWS. */
let formsubmitCalls = 0;
let cognitoCalls = 0;
let appsyncCalls = 0;
let appsyncOutcome = 'ok';
let flakyFirstCall = 0;

/* CORS headers matter on every stub. The real endpoints send them; a stub that
   does not makes the browser reject its own response, which surfaces as a
   console error and looks like a fault in the page. An earlier version of this
   script failed on exactly that. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = request.url();

  if (request.method() === 'OPTIONS' && !url.startsWith(origin)) {
    request.respond({ status: 204, headers: CORS });
    return;
  }

  if (url.includes('formsubmit.co')) {
    // Counted, never delivered. The assessment should not reach here at all any
    // more; contact-sales still does, but this script never opens that page.
    formsubmitCalls += 1;
    request.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '{}' });
    return;
  }

  if (url.includes('cognito-identity')) {
    cognitoCalls += 1;
    const target = request.headers()['x-amz-target'] ?? '';
    const body = target.includes('GetCredentialsForIdentity')
      ? JSON.stringify({
          Credentials: {
            AccessKeyId: 'ASIASTUBSTUBSTUBSTUB',
            SecretKey: 'stub-secret-key-for-offline-verification',
            SessionToken: 'stub-session-token',
          },
        })
      : JSON.stringify({ IdentityId: 'ca-central-1:00000000-0000-0000-0000-000000000000' });
    request.respond({ status: 200, contentType: 'application/x-amz-json-1.1', headers: CORS, body });
    return;
  }

  if (url.includes('appsync-api')) {
    appsyncCalls += 1;
    /* Fails the first attempt only, so the RETRY can be observed in the page
       rather than only in the unit-level check. */
    if (appsyncOutcome === 'flaky-once') {
      if (appsyncCalls === flakyFirstCall) {
        request.abort('connectionrefused');
        return;
      }
      request.respond({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({ data: { submitAssessment: { ok: true, referenceId: 'AEY-RETRY9', message: 'stored' } } }),
      });
      return;
    }
    if (appsyncOutcome === 'transport-error') {
      // What a 403 from a bad signature, or an outage, looks like to the page.
      request.respond({ status: 403, contentType: 'application/json', headers: CORS, body: '{"errors":[{"message":"UnauthorizedException"}]}' });
      return;
    }
    const payload = appsyncOutcome === 'refused'
      ? { data: { submitAssessment: { ok: false, referenceId: 'AEY-STUB01', message: 'a valid email is required' } } }
      : { data: { submitAssessment: { ok: true, referenceId: 'AEY-STUB01', message: 'Assessment received.' } } };
    request.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(payload) });
    return;
  }

  if (url.startsWith(origin) || url.startsWith('data:')) {
    request.continue();
    return;
  }
  /* Anything else external — Google Fonts, essentially — is answered with an
     empty 200 rather than aborted. Aborting works, but each abort raises a
     "Failed to load resource" console error, and this script also asserts the
     page produces NO console errors. Blanket-ignoring those would mean the
     check could no longer see a real one, so the requests are stubbed instead
     of the errors being filtered. Typography is irrelevant to what is being
     verified here; `check-console-ui.mjs` is where fonts are checked. */
  request.respond({
    status: 200,
    contentType: url.includes('css') ? 'text/css' : 'application/octet-stream',
    body: '',
  });
});

try {
  await page.goto(`${origin}/assessment.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#assessment-form');
  pass('assessment page loaded');

  const clickOption = async (name, value) => {
    const selector = `input[name="${name}"][value="${value}"]`;
    await page.waitForSelector(selector);
    await page.$eval(selector, (el) => el.click());
  };
  const type = async (id, text) => {
    await page.$eval(`#${id}`, (el, v) => { el.value = v; }, text);
  };
  const next = async () => {
    await page.$eval('#next-button', (el) => el.click());
    await new Promise((r) => setTimeout(r, 120));
  };

  /** Fills and submits the whole form with sensible defaults. Used by the
   *  later walks, where the point is the SUBMISSION OUTCOME rather than the
   *  answers. The first walk stays written out in full, because its specific
   *  answers are what the pricing assertions are checking. */
  const runWalk = async ({ clinicName, email, spend, providers = '1-2', locations = '1' }) => {
    await page.goto(`${origin}/assessment.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#assessment-form');
    await type('clinicName', clinicName);
    await type('contactName', 'Automated Check');
    await type('email', email);
    await type('jobTitle', 'Practice Manager');
    await type('organizationType', 'Family Health Team');
    await type('organizationSize', '9 staff');
    await type('province', 'Ontario');
    await next();
    await clickOption('providers', providers);
    await clickOption('locations', locations);
    await next();
    await clickOption('hosting', 'onprem');
    await type('monthlyItSpend', spend);
    await type('annualHardwareEmergency', '0');
    await clickOption('downtimeHoursBand', 'under10');
    await clickOption('downtimeCostBand', 'under1000');
    await next();
    await clickOption('mfa', 'no');
    await clickOption('backups', 'unsure');
    await clickOption('incidentPlan', 'no');
    await clickOption('lastRiskAssessment', 'never');
    await next();
    await page.$eval('input[name="consent"]', (el) => el.click());
    await page.$eval('#submit-button', (el) => el.click());
    await page.waitForFunction(() => !document.getElementById('report').hidden, { timeout: 8000 });
    /* Wait for a TERMINAL state, keyed on the status class rather than on the
       message text.

       An earlier version waited for the text to stop saying "Sending your
       details…", which looked equivalent and was not: the retry message is
       different text but still an in-flight state, so the walk returned in the
       middle of a retry and read a half-finished status. Keying on the state
       machine rather than on copy is both correct and immune to a reworded
       message. */
    await page.waitForFunction(
      () => {
        const cls = document.getElementById('delivery-status').className;
        return /status-(sent|rejected|failed)/.test(cls);
      },
      { timeout: 15000 },
    );
  };

  // Step 1 — contact
  await type('clinicName', 'Verification Family Practice');
  await type('contactName', 'Automated Check');
  await type('email', 'assessment-check@example.ca');
  await type('jobTitle', 'Practice Manager');
  await type('organizationType', 'Family Health Team');
  await type('organizationSize', '9 staff');
  await type('province', 'Ontario');
  await next();

  // Step 2 — scale. 1-2 providers at 1 location = Micro OR Starter.
  await clickOption('providers', '1-2');
  await clickOption('locations', '1');
  await next();

  // Step 3 — current environment. High spend so savings SHOULD appear.
  await clickOption('hosting', 'onprem');
  await type('monthlyItSpend', '9400');
  await type('annualHardwareEmergency', '0');
  await clickOption('downtimeHoursBand', 'under10');
  await clickOption('downtimeCostBand', 'under1000');
  await next();

  // Step 4 — posture
  await clickOption('mfa', 'no');
  await clickOption('backups', 'unsure');
  await clickOption('incidentPlan', 'no');
  await clickOption('lastRiskAssessment', 'never');
  await next();

  // Step 5 — preview and consent
  const preview = await page.$eval('#preview-second', (el) => el.textContent.trim());
  eq(preview, '$1,800 – $4,900 / mo', 'step 5 preview shows the indicative range, not a single price');

  await page.$eval('input[name="consent"]', (el) => el.click());
  await page.$eval('#submit-button', (el) => el.click());
  await page.waitForFunction(() => !document.getElementById('report').hidden, { timeout: 8000 });
  pass('report rendered');

  // ── read the report back ────────────────────────────────────────────────
  const report = await page.evaluate(() => {
    const text = (id) => (document.getElementById(id)?.textContent ?? '').trim();
    return {
      tierLabel: text('result-tier'),
      tierHeading: text('result-tier-label'),
      investment: text('result-investment'),
      tco: text('result-tco'),
      score: text('result-score'),
      pricing: text('pricing-detail'),
      breakdown: [...document.querySelectorAll('#cost-breakdown .result-row')].map(
        (row) => row.textContent.trim(),
      ),
      gapCount: document.querySelectorAll('#gap-list .gap-item').length,
      criticalCount: document.querySelectorAll('#gap-list .gap-item.critical').length,
    };
  });

  console.log('\nRendered report:');
  eq(report.tierLabel, 'Micro or Starter', 'both applicable tracks are named');
  eq(report.tierHeading, 'Applicable tracks', 'the label is pluralised when two apply');
  eq(report.investment, '$1,800 – $4,900 / mo', 'headline is a range');
  eq(report.tco, '$9,713', 'current monthly TCO');
  eq(report.score, '10% · High Priority', 'compliance score');
  eq(report.gapCount, 4, 'four compliance items rendered');
  eq(report.criticalCount, 3, 'three flagged critical');

  console.log('\n"What this would cost" section:');
  const wants = [
    ['Micro', /Micro/],
    ['Starter', /Starter/],
    ['Micro setup', /\$7,500/],
    ['Starter setup', /\$15,000/],
    ['Essentials range', /\$1,800/],
    ['Full Managed ceiling', /\$4,900/],
    ['mandatory check-up wording', /mandatory check-up/],
    ['indicative caveat', /Indicative only/],
    ['separately-billed list', /Billed separately/],
    ['AWS usage excluded', /AWS cloud usage fees/],
  ];
  for (const [label, pattern] of wants) {
    pattern.test(report.pricing) ? pass(label) : fail(`${label} missing from the pricing section`);
  }
  /Train & Walk Away \(support\)\s*\$0/.test(report.pricing.replace(/\s+/g, ' '))
    ? pass('Train & Walk Away is stated with its check-up, never as a bare $0')
    : fail('Train & Walk Away is not presented with its mandatory check-up');

  console.log('\nSavings (current spend is well above the range, so they should appear):');
  const joined = report.breakdown.join(' | ');
  /Potential monthly saving/.test(joined) ? pass('monthly saving shown') : fail('monthly saving missing');
  /Potential annual saving/.test(joined) ? pass('annual saving shown') : fail('annual saving missing');
  /Setup recovered within/.test(joined) ? pass('payback shown') : fail('payback missing');
  /\$4,813 – \$7,913/.test(joined)
    ? pass('saving is a range measured against the whole span')
    : fail(`saving range not as expected — rows were: ${joined}`);

  // ── the same walk, with a modest spend: savings must NOT appear ──────────
  await page.goto(`${origin}/assessment.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#assessment-form');
  await type('clinicName', 'Modest Spend Clinic');
  await type('contactName', 'Automated Check');
  await type('email', 'assessment-check-2@example.ca');
  await type('jobTitle', 'Owner');
  await type('organizationType', 'Solo practice');
  await type('organizationSize', '4 staff');
  await type('province', 'Ontario');
  await next();
  await clickOption('providers', '1-2');
  await clickOption('locations', '1');
  await next();
  await clickOption('hosting', 'onprem');
  await type('monthlyItSpend', '1200');
  await type('annualHardwareEmergency', '0');
  await clickOption('downtimeHoursBand', 'under10');
  await clickOption('downtimeCostBand', 'under1000');
  await next();
  await clickOption('mfa', 'yes');
  await clickOption('backups', 'yes');
  await clickOption('incidentPlan', 'yes');
  await clickOption('lastRiskAssessment', '1yr');
  await next();
  await page.$eval('input[name="consent"]', (el) => el.click());
  await page.$eval('#submit-button', (el) => el.click());
  await page.waitForFunction(() => !document.getElementById('report').hidden, { timeout: 8000 });

  console.log('\nModest spend — the comparison must be absent, not negative:');
  const modest = await page.evaluate(() => ({
    breakdown: [...document.querySelectorAll('#cost-breakdown .result-row')].map((r) => r.textContent.trim()).join(' | '),
    pricing: (document.getElementById('pricing-detail')?.textContent ?? '').trim(),
  }));
  /saving|increase|payback|recovered/i.test(modest.breakdown)
    ? fail(`a comparison was rendered anyway: ${modest.breakdown}`)
    : pass('no saving, increase or payback figure is shown');
  /Indicative only/.test(modest.pricing)
    ? pass('the indicative pricing itself is still shown')
    : fail('pricing section vanished along with the savings');

  // ── Enterprise: no figure at all ────────────────────────────────────────
  await page.goto(`${origin}/assessment.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#assessment-form');
  await type('clinicName', 'Northern Health Network');
  await type('contactName', 'Automated Check');
  await type('email', 'assessment-check-3@example.ca');
  await type('jobTitle', 'CIO');
  await type('organizationType', 'Regional health network');
  await type('organizationSize', '400 staff');
  await type('province', 'Ontario');
  await next();
  await clickOption('providers', '15+');
  await clickOption('locations', '15+');
  await next();
  await clickOption('hosting', 'cloud');
  await type('monthlyItSpend', '74000');
  await type('annualHardwareEmergency', '250000');
  await clickOption('downtimeHoursBand', 'over90');
  await clickOption('downtimeCostBand', 'over5000');
  await next();
  await clickOption('mfa', 'yes');
  await clickOption('backups', 'yes');
  await clickOption('incidentPlan', 'yes');
  await clickOption('lastRiskAssessment', '1yr');
  await next();
  await page.$eval('input[name="consent"]', (el) => el.click());
  await page.$eval('#submit-button', (el) => el.click());
  await page.waitForFunction(() => !document.getElementById('report').hidden, { timeout: 8000 });

  console.log('\nEnterprise — never auto-priced:');
  const enterprise = await page.evaluate(() => ({
    investment: (document.getElementById('result-investment')?.textContent ?? '').trim(),
    tier: (document.getElementById('result-tier')?.textContent ?? '').trim(),
    pricing: (document.getElementById('pricing-detail')?.textContent ?? '').trim(),
    breakdown: [...document.querySelectorAll('#cost-breakdown .result-row')].map((r) => r.textContent.trim()).join(' | '),
  }));
  eq(enterprise.tier, 'Enterprise', 'track is Enterprise');
  eq(enterprise.investment, 'Quoted individually', 'no headline figure');
  /discovery call/i.test(enterprise.pricing)
    ? pass('a discovery call is required in words')
    : fail('the discovery-call requirement is not stated');
  /\$\d/.test(enterprise.pricing)
    ? fail(`a dollar figure leaked into the Enterprise pricing section: ${enterprise.pricing}`)
    : pass('not a single dollar figure appears in the Enterprise pricing section');
  /saving|payback|recovered/i.test(enterprise.breakdown)
    ? fail('a saving was computed against an Enterprise engagement that has no price')
    : pass('no saving computed against a price that does not exist');

  // ── the submission path, and the three states it can report ─────────────
  console.log('\nSubmission path:');
  formsubmitCalls === 0
    ? pass('the assessment made NO formsubmit.co call — the email path is gone')
    : fail(`the assessment still called formsubmit.co ${formsubmitCalls} time(s)`);
  cognitoCalls > 0
    ? pass(`obtained guest credentials (${cognitoCalls} Cognito calls, all stubbed)`)
    : fail('no Cognito call was made — the form never tried to authenticate');
  appsyncCalls === 3
    ? pass(`submitted to AppSync on all ${appsyncCalls} walks (all stubbed — nothing written)`)
    : fail(`expected 3 AppSync submissions, saw ${appsyncCalls}`);

  const deliveryStatus = async () =>
    page.$eval('#delivery-status', (el) => ({ text: el.textContent.trim(), cls: el.className }));

  /* Snapshot the error count BEFORE the deliberate-failure walks below. Those
     walks make the page log a real console error, which is correct behaviour —
     asserting "no console errors" after them would either fail on working code
     or have to ignore all errors, and the second is how a check stops being
     able to see a genuine one. */
  const errorsBeforeFailureWalks = consoleErrors.length;

  const sent = await deliveryStatus();
  /reference is AEY-STUB01/.test(sent.text)
    ? pass('a successful submission shows the reference the backend returned')
    : fail(`success message did not carry the reference: ${sent.text}`);
  /status-sent/.test(sent.cls) ? pass('  and is styled as sent') : fail('  wrong status class');

  /* The two failure states matter more than the success one. As a mirror this
     code could swallow its own errors; as the only path it must not, or a
     visitor sees a finished report and assumes we have their details. */
  console.log('\nWhen the backend refuses (a fixable problem):');
  appsyncOutcome = 'refused';
  await runWalk({ clinicName: 'Refused Clinic', email: 'refused@example.ca', spend: '5000' });
  const refused = await deliveryStatus();
  /a valid email is required/.test(refused.text)
    ? pass("the backend's own message is shown, because it says what to correct")
    : fail(`refusal message not surfaced: ${refused.text}`);
  /status-rejected/.test(refused.cls) ? pass('  and is styled as rejected') : fail('  wrong status class');

  /* ── the retry, observed in the page ──────────────────────────────────────
   * The first attempt is refused at the connection, the second succeeds. This
   * is the case the retry exists for: a dropped packet on a form that has no
   * email fallback any more. */
  console.log('\nWhen the first attempt drops and the second succeeds:');
  appsyncOutcome = 'flaky-once';
  flakyFirstCall = appsyncCalls + 1;
  await runWalk({ clinicName: 'Flaky Network Clinic', email: 'flaky@example.ca', spend: '5000' });
  const recovered = await deliveryStatus();
  /reference is AEY-RETRY9/.test(recovered.text)
    ? pass('the submission recovered and the visitor sees a normal success')
    : fail(`retry did not recover: ${recovered.text}`);
  /status-sent/.test(recovered.cls)
    ? pass('  and is styled as sent, not as a failure')
    : fail('  wrong status class after recovery');
  appsyncCalls === flakyFirstCall + 1
    ? pass('  exactly one retry was made — not a loop')
    : fail(`  expected 2 attempts, saw ${appsyncCalls - flakyFirstCall + 1}`);

  console.log('\nWhen the submission fails outright:');
  appsyncOutcome = 'transport-error';
  await runWalk({ clinicName: 'Broken Backend Clinic', email: 'broken@example.ca', spend: '5000' });
  const failed = await deliveryStatus();
  /nobody at Aeygis has them yet/.test(failed.text)
    ? pass('the visitor is told plainly that nobody received their details')
    : fail(`failure message was not honest: ${failed.text}`);
  /email it to aws@aeygis.com/.test(failed.text)
    ? pass('  and is given another way to reach us')
    : fail('  no fallback contact offered');
  /status-failed/.test(failed.cls) ? pass('  and is styled as failed') : fail('  wrong status class');

  const stillRendered = await page.evaluate(() => !document.getElementById('report').hidden);
  stillRendered
    ? pass('  the report is still shown — it is computed here, so our outage is not their loss')
    : fail('  the report was withheld because our backend failed');

  errorsBeforeFailureWalks === 0
    ? pass('no console errors on any walk that was expected to succeed')
    : fail(`console errors on a successful walk: ${consoleErrors.slice(0, 3).join(' | ')}`);

  /* The failure walk SHOULD log — swallowing the cause would leave whoever
     debugs it with nothing. Asserted rather than ignored. */
  consoleErrors.slice(errorsBeforeFailureWalks).some((e) => /Assessment submission failed/.test(e))
    ? pass('the failed submission logged its cause for debugging')
    : fail('the failed submission was swallowed without a log');
} finally {
  await browser.close();
  server.close();
}

console.log(
  failures === 0
    ? '\nThe public assessment form works end to end.\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
