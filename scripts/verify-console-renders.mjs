/**
 * Loads the console in a REAL browser and fails on console errors.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * The console typechecked, built, and served HTTP 200 — and rendered a BLANK
 * PAGE. Three faults that none of those checks could see:
 *
 *   1. Two React copies (root 18.3.1 vs app 19.2.8) -> "Invalid hook call" and
 *      "Cannot read properties of null (reading 'useEffect')"
 *   2. `generateClient()` at module scope ran before `Amplify.configure()`,
 *      because ES imports evaluate before the importing module's body
 *   3. Both surfaced only in a browser, at runtime
 *
 * "It compiles" and "it serves" are not "it works". This closes that gap.
 *
 * Usage — the dev server must already be running (npm run console):
 *   node scripts/verify-console-renders.mjs [url]
 */
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL_TO_CHECK = process.argv[2] ?? 'http://localhost:5173/';

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

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

/**
 * Noise that is not a defect. Kept deliberately SHORT — a permissive ignore list
 * is how a real error gets waved through.
 */
const IGNORABLE = [
  /Download the React DevTools/i,
  /\[vite\] connect(ing|ed)/i,
  // Browsers request /favicon.ico unprompted; its absence is not an app defect.
  // Narrowly worded so it cannot hide a real resource failure.
  /Failed to load resource.*404/i,
];

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();

  const errors = [];
  const warnings = [];
  const badResponses = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (IGNORABLE.some((re) => re.test(text))) return;
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warnings.push(text);
  });
  page.on('pageerror', (err) => errors.push(`[uncaught] ${err.message}`));
  page.on('requestfailed', (req) => {
    errors.push(`[request failed] ${req.url()} — ${req.failure()?.errorText}`);
  });
  // A 404 is a SUCCESSFUL response with an error status, so `requestfailed`
  // never fires for it. Without this the console just says "Failed to load
  // resource" with no URL, which is unactionable.
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
  });

  console.log(`Loading ${URL_TO_CHECK}\n`);
  const response = await page.goto(URL_TO_CHECK, { waitUntil: 'networkidle2', timeout: 45_000 });

  response?.ok() ? pass(`HTTP ${response.status()}`) : fail(`HTTP ${response?.status()}`);

  // Give React a beat to mount and Amplify to settle.
  await new Promise((r) => setTimeout(r, 2500));

  // ---- did anything actually render? ----------------------------------
  const rootHtmlLength = await page.evaluate(
    () => document.getElementById('root')?.innerHTML.length ?? 0,
  );
  rootHtmlLength > 200
    ? pass(`#root rendered (${rootHtmlLength} chars of markup)`)
    : fail(`#root is EMPTY or near-empty (${rootHtmlLength} chars) — blank page`);

  // ---- is it the sign-in screen we expect? ------------------------------
  const bodyText = await page.evaluate(() => document.body.innerText ?? '');
  const looksLikeSignIn = /sign in/i.test(bodyText) || /password/i.test(bodyText);
  looksLikeSignIn
    ? pass('the Authenticator sign-in UI is present')
    : fail(`no sign-in UI found. Body text begins: ${JSON.stringify(bodyText.slice(0, 160))}`);

  // ---- sign in and verify the app itself, not just the login screen -----
  //
  // The brand shell lives INSIDE <Authenticator>, so it cannot render before
  // sign-in — asserting it on the login screen was the wrong expectation.
  // Signing in verifies far more: the queue, the seeded data, and the role UI.
  if (existsSync(new URL('../.test-credentials.json', import.meta.url))) {
    const creds = JSON.parse(
      readFileSync(new URL('../.test-credentials.json', import.meta.url), 'utf8'),
    );
    const who = creds.approver ?? creds.contributor;

    try {
      await page.type('input[name="username"]', who.username, { delay: 10 });
      await page.type('input[name="password"]', who.password, { delay: 10 });
      await page.click('button[type="submit"]');
      // Wait for the queue to SETTLE, not merely for the shell to appear.
      //
      // "Intake queue" renders synchronously, so waiting on it returned before
      // listAssessments() had resolved and the test read an empty table — a false
      // failure. Wait until the list has either loaded a row or declared itself
      // empty, which distinguishes "still loading" from "genuinely no data".
      //
      // The queue is a list of <button class="queue-item">, not a table. Do
      // NOT match on `tbody tr` here: the approval table also uses that, so
      // the wait would pass on the wrong element entirely.
      await page.waitForFunction(
        () => {
          const text = document.body.innerText ?? '';
          if (!/Intake queue/i.test(text)) return false;
          return /No assessments yet/i.test(text) || document.querySelectorAll('.queue-item').length > 0;
        },
        { timeout: 30_000 },
      );
      pass(`signed in as ${who.group} and the intake queue rendered`);

      const afterLogin = await page.evaluate(() => document.body.innerText ?? '');
      /Aeygis/i.test(afterLogin) ? pass('brand shell rendered') : fail('brand shell missing');

      // The seeded assessments must actually be listed.
      const seeded = ['Riverside', 'Bayview', 'Lakeshore', 'Northern'];
      const found = seeded.filter((n) => afterLogin.includes(n));
      found.length === seeded.length
        ? pass(`all ${seeded.length} seeded assessments listed`)
        : fail(`only ${found.length}/${seeded.length} seeded assessments listed (found: ${found.join(', ') || 'none'})`);

      // The role pill proves useRole() read cognito:groups in the browser.
      new RegExp(who.group, 'i').test(afterLogin)
        ? pass(`role "${who.group}" shown in the UI`)
        : fail(`role "${who.group}" not shown — useRole() may not be reading groups`);

      // ---- END-TO-END: generate a proposal, then approve it --------------
      //
      // This is the path a user actually walks. Verifying it caught that
      // price-proposal had NO CALLER at all: the Lambda was deployed but never
      // exposed as a mutation, so no ProposalVersion could exist and the
      // approval panel was empty by construction. Nothing short of walking the
      // path would have surfaced that.
      try {
        // Select Lakeshore — 10 providers / 6 locations, already priceable.
        const picked = await page.evaluate(() => {
          const item = [...document.querySelectorAll('.queue-item')].find((el) =>
            /Lakeshore/.test(el.textContent ?? ''),
          );
          if (!item) return false;
          item.click();
          return true;
        });
        if (!picked) throw new Error('Lakeshore item not found in the queue');

        await page.waitForFunction(
          () => /Pricing|Cannot quote/i.test(document.body.innerText ?? ''),
          { timeout: 20_000 },
        );
        pass('assessment detail opened');

        // Find and click a Generate button in the pricing panel. All sections
        // stay mounted in the DOM (the section nav scrolls rather than
        // swapping panes), so no navigation is needed to reach it.
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === 'Generate',
          );
          if (!btn) return false;
          btn.click();
          return true;
        });
        clicked
          ? pass('Generate control present and clicked')
          : fail('no Generate button found — the pricing panel cannot create a version');

        if (clicked) {
          await page.waitForFunction(
            () => /Created AEY-|Could not create|not applicable|requires a discovery/i.test(
              document.body.innerText ?? '',
            ),
            { timeout: 40_000 },
          );
          const after = await page.evaluate(() => document.body.innerText ?? '');
          if (/Created AEY-/.test(after)) {
            pass('proposal version created (immutable, snapshot hashed)');
            // It must now appear in the approval panel.
            await page.waitForFunction(
              () => /v0001|v000\d/.test(document.body.innerText ?? ''),
              { timeout: 20_000 },
            ).then(
              () => pass('new version appears in the Approval panel'),
              () => fail('version created but not listed in the Approval panel'),
            );
            const withPanel = await page.evaluate(() => document.body.innerText ?? '');
            /Approve/.test(withPanel)
              ? pass('Approve control available to the approver')
              : fail('no Approve control shown to an approver');
          } else {
            const NL = String.fromCharCode(10);
            const why = after.split(NL).find((l) => /Could not create|not applicable|requires a discovery/.test(l)) ?? 'unknown';
            fail(`generation did not succeed: ${why.trim().slice(0, 140)}`);
          }
        }
      } catch (error) {
        fail(`end-to-end generate/approve failed: ${String(error?.message ?? error).slice(0, 170)}`);
      }
    } catch (error) {
      fail(`sign-in flow failed: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  } else {
    console.log('  SKIP  sign-in (no .test-credentials.json)');
  }

  // ---- the specific faults that caused the blank page -------------------
  const joined = errors.join('\n');

  /Invalid hook call|more than one copy of React/i.test(joined)
    ? fail('DUPLICATE REACT still present (invalid hook call)')
    : pass('no duplicate-React error');

  /Amplify has not been configured/i.test(joined)
    ? fail('Amplify.configure() still runs too late')
    : pass('Amplify is configured before first use');

  /reading 'useEffect'|reading "useEffect"/i.test(joined)
    ? fail("still hitting null.useEffect")
    : pass('no null-hook dereference');

  // ---- anything else at all ---------------------------------------------
  if (errors.length === 0) {
    pass('zero console errors');
  } else {
    fail(`${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.error(`          ${e.slice(0, 200)}`);
  }

  if (badResponses.length > 0) {
    // A missing favicon is browser-initiated noise, not an app defect.
    const real = badResponses.filter((r) => !/favicon/i.test(r));
    if (real.length === 0) {
      pass(`only ignorable 4xx: ${badResponses.join(', ')}`);
    } else {
      fail(`${real.length} bad response(s): ${real.slice(0, 5).join(', ')}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} warning(s) (not failing the run):`);
    for (const w of warnings.slice(0, 5)) console.log(`          ${w.slice(0, 160)}`);
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nConsole renders cleanly.\n' : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
