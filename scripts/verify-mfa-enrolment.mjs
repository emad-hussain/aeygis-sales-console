/**
 * Proves two-factor enrolment works END TO END — no phone required.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ WRITES TO AWS: changes the test approver's MFA state, then restores it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Needs `npm run console` running, `.test-credentials.json`, and AWS
 * credentials that can read the user pool (`AWS_PROFILE=aeygis`). It touches
 * ONLY the test approver account named in .test-credentials.json.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The pool is OPTIONAL TOTP, and the console has an enrolment panel because
 * with OPTIONAL nothing else offers one. Two halves have to work and neither
 * is provable by reading the code:
 *
 *   1. ENROLMENT — the panel's Set up → scan → code → "on". Verified against
 *      Cognito itself afterwards, not the panel's word for it.
 *   2. THE CHALLENGE — sign out, sign in, and the Authenticator must now ask
 *      for a code. This half is Amplify's, not ours, and it only exists once
 *      updateMFAPreference() has run. Enrolment that never produces a
 *      challenge is decoration.
 *
 * ── HOW IT ENTERS A CODE WITHOUT A PHONE ───────────────────────────────────
 * The panel shows the TOTP secret as text (so people can type it into an app
 * by hand). This script reads that text and computes the code the app would
 * show — RFC 6238: base32-decode the secret, HMAC-SHA1 over the 30-second
 * time step, dynamic truncation, six digits. A real authenticator does exactly
 * the same arithmetic. Cognito refuses a code reused within its time step, so
 * the second entry waits for the step to roll over.
 *
 * ── PRECONDITION IT CHECKS FIRST ───────────────────────────────────────────
 * The pool must actually have MFA enabled. auth/resource.ts can say OPTIONAL
 * while the deployed pool still says OFF; updateMFAPreference() then fails in
 * a way that reads like a bug in the panel. So the deployed pool is read
 * first, and the script refuses with the real reason if it is OFF.
 *
 * Run:  AWS_PROFILE=aeygis npm run verify:mfa
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  DescribeUserPoolCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const URL_TO_CHECK = process.argv[2] ?? 'http://localhost:5173/';
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const REGION = outputs.auth.aws_region;
const POOL_ID = outputs.auth.user_pool_id;
const creds = JSON.parse(readFileSync(new URL('../.test-credentials.json', import.meta.url)));
const who = creds.approver;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No local Chrome/Edge found.'); process.exit(1); }

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RFC 6238, in 25 lines ──────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
const STEP_SECONDS = 30;
const stepNow = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);
function totp(secretB32, step = stepNow()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// ── the pool must actually have MFA on ─────────────────────────────────────
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: POOL_ID }));
const mode = pool.UserPool?.MfaConfiguration ?? 'unknown';
console.log(`Pool: ${POOL_ID}  MFA: ${mode}\n`);
if (mode === 'OFF') {
  fail('the DEPLOYED pool has MfaConfiguration OFF — auth/resource.ts may say OPTIONAL, but that is not deployed');
  fail('  run `npm run sandbox` (with approval) first; updateMFAPreference() cannot succeed against an OFF pool');
  process.exitCode = 1;
  process.exit();
}
pass(`deployed pool has MFA ${mode}`);

/** The Cognito username (a sub) behind the test approver's email. Resolved once. */
let cognitoUsername = null;
async function resolveUsername() {
  if (cognitoUsername !== null) return cognitoUsername;
  const { Users = [] } = await cognito.send(
    new ListUsersCommand({ UserPoolId: POOL_ID, Filter: `email = "${who.username}"`, Limit: 1 }),
  );
  cognitoUsername = Users[0]?.Username ?? null;
  if (cognitoUsername === null) throw new Error(`no Cognito user with email ${who.username}`);
  return cognitoUsername;
}

/**
 * What Cognito itself says about this user's MFA — the check the panel cannot
 * fake.
 *
 * Polls rather than reading once. The first version read immediately after the
 * panel flipped to "off", and a single lagging read was enough to report a
 * restore as failed. Reporting a false failure here is worse than waiting a
 * second: it sends someone to fix an account that is already fine.
 */
async function serverSideMfa({ waitUntilOff = false } = {}) {
  const username = await resolveUsername();
  for (let attempt = 0; ; attempt += 1) {
    const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: username }));
    const state = { list: u.UserMFASettingList ?? [], preferred: u.PreferredMfaSetting ?? null };
    if (!waitUntilOff || state.preferred !== 'SOFTWARE_TOKEN_MFA' || attempt >= 5) return state;
    await settle(1000);
  }
}

/**
 * Put the account back, whatever the browser did.
 *
 * ── WHY THIS IS NOT LEFT TO THE UI ─────────────────────────────────────────
 * The first run of this script enrolled the test approver and then failed to
 * un-enrol it, because the only restore path was clicking "Turn off" and
 * reading Cognito once. The account was left with SOFTWARE_TOKEN_MFA preferred
 * — which breaks every other headless script, since check:ui, verify:email and
 * this one all sign in as it with a password and would now be met by a TOTP
 * challenge they do not answer. One failed cleanup quietly broke the suite.
 *
 * So the UI disable still runs above (it is part of what is being proved), but
 * the account's final state is guaranteed here with the admin API, from a
 * `finally`, so a crashed browser or a missed click cannot leave it enrolled.
 */
async function forceRestore() {
  const before = await serverSideMfa();
  if (before.preferred !== 'SOFTWARE_TOKEN_MFA' && before.list.length === 0) return 'was already clean';
  await cognito.send(
    new AdminSetUserMFAPreferenceCommand({
      UserPoolId: POOL_ID,
      Username: await resolveUsername(),
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    }),
  );
  const after = await serverSideMfa({ waitUntilOff: true });
  return after.preferred === 'SOFTWARE_TOKEN_MFA' ? 'STILL ENROLLED' : 'restored';
}

// ── browser helpers ────────────────────────────────────────────────────────
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function signInPassword() {
  await page.waitForSelector('input[name="username"]', { timeout: 30_000 });
  await page.type('input[name="username"]', who.username, { delay: 8 });
  await page.type('input[name="password"]', who.password, { delay: 8 });
  await page.click('button[type="submit"]');
}
async function waitForSessionResolved() {
  await page.waitForSelector('button.avatar', { timeout: 40_000 });
  await page.waitForFunction(
    () => /@/.test(document.querySelector('button.avatar')?.getAttribute('aria-label') ?? ''),
    { timeout: 30_000 },
  );
}
/**
 * Open the account panel and wait for the 2-factor status to SETTLE.
 *
 * "Settled" means the pill reads exactly `on` or `off` — the two terminal
 * states. Waiting for "anything but checking…" looked equivalent and was not:
 * the pill's FIRST render is `unknown`, from the reducer's initial state,
 * before the effect dispatches LOAD. That condition therefore resolved on the
 * opening frame, and the read that followed landed on `checking…` a moment
 * later. The whole cleanup then skipped its `s2 === 'on'` branch, never
 * clicked Turn off, and left the test approver enrolled — which is how one bad
 * wait condition quietly broke every other headless script.
 */
async function openPanelAndWaitForStatus() {
  await page.click('button.avatar');
  await page.waitForFunction(
    () => {
      const p = document.querySelector('.mfa-row .pill');
      return p !== null && ['on', 'off'].includes((p.textContent ?? '').trim());
    },
    { timeout: 20_000 },
  );
  return page.$eval('.mfa-row .pill', (p) => p.textContent.trim());
}
const clickButton = (re) =>
  page.$$eval('.user-panel button, form.mfa-verify button', (bs, src) => {
    const b = bs.find((x) => new RegExp(src, 'i').test(x.textContent ?? ''));
    if (!b) return false;
    b.click();
    return true;
  }, re);
const waitForPill = (want) =>
  page.waitForFunction(
    (w) => (document.querySelector('.mfa-row .pill')?.textContent ?? '').trim() === w,
    { timeout: 20_000 },
    want,
  );

try {
  await page.goto(URL_TO_CHECK, { waitUntil: 'networkidle2', timeout: 60_000 });
  await signInPassword();
  await waitForSessionResolved();
  pass(`signed in as ${who.username} with password only`);

  // ── clean start: if a previous run left it on, turn it off first ───────────
  let status = await openPanelAndWaitForStatus();
  if (status === 'on') {
    await clickButton('^turn off$');
    await waitForPill('off');
    status = 'off';
    pass('a previous run had left MFA on — turned it off for a clean start');
  }
  if (status !== 'off') { fail(`expected status "off" to begin, got "${status}"`); throw new Error('bad start'); }
  pass('2-factor reads "off" before enrolment');

  // ── 1. ENROLMENT ────────────────────────────────────────────────────────────
  await clickButton('^set up$');
  await page.waitForSelector('.mfa-key', { timeout: 20_000 });
  const secret = await page.$eval('.mfa-key', (el) => el.textContent.replace(/\s+/g, ''));
  secret.length >= 16 ? pass(`setUpTOTP() produced a secret (${secret.length} chars)`) : fail(`secret looks wrong: "${secret}"`);
  const qr = await page.$('.mfa-qr');
  qr ? pass('QR code rendered') : fail('no QR image (the text key still works, but the render failed)');

  const enrolStep = stepNow();
  const code = totp(secret, enrolStep);
  await page.type('#mfa-code', code, { delay: 20 });
  await page.click('form.mfa-verify button[type="submit"]');
  await waitForPill('on');
  pass('entered a computed TOTP code — panel now reads "on"');

  const after = await serverSideMfa();
  after.list.includes('SOFTWARE_TOKEN_MFA')
    ? pass('Cognito confirms SOFTWARE_TOKEN_MFA is enabled for the user')
    : fail(`Cognito does NOT list SOFTWARE_TOKEN_MFA — got [${after.list.join(', ')}]`);
  after.preferred === 'SOFTWARE_TOKEN_MFA'
    ? pass('Cognito confirms it is the PREFERRED method (so sign-in will challenge)')
    : fail(`preferred method is "${after.preferred}", not SOFTWARE_TOKEN_MFA — sign-in would NOT challenge`);

  // ── 2. THE CHALLENGE ───────────────────────────────────────────────────────
  await page.keyboard.press('Escape');
  await settle(300);
  await page.click('button.avatar');
  await settle(300);
  await clickButton('^sign out$');
  await page.waitForSelector('input[name="username"]', { timeout: 30_000 });
  pass('signed out');

  await signInPassword();
  // Cognito must now ask for a code instead of letting the password through.
  const challengeField = 'input[name="confirmation_code"], input[autocomplete="one-time-code"]';
  const challenged = await Promise.race([
    page.waitForSelector(challengeField, { timeout: 30_000 }).then(() => 'challenge'),
    page.waitForSelector('button.avatar', { timeout: 30_000 }).then(() => 'straight-in'),
  ]).catch(() => 'neither');
  if (challenged === 'challenge') {
    pass('sign-in now stops at a TOTP challenge — the password alone is no longer enough');
  } else if (challenged === 'straight-in') {
    fail('password alone still signs in — enrolment did NOT produce a challenge');
  } else {
    fail('after entering the password, neither a challenge nor the app appeared');
  }

  if (challenged === 'challenge') {
    // A code is single-use within its time step. Wait for the step to change.
    while (stepNow() === enrolStep) await settle(1000);
    await page.type(challengeField, totp(secret), { delay: 20 });
    await page.click('button[type="submit"]');
    await waitForSessionResolved();
    pass('the computed code satisfied the challenge — signed in with password + TOTP');
  }

  // ── does the "Turn off" button work? ───────────────────────────────────────
  // An assertion, not the safety net. The account is restored unconditionally
  // in the finally below, so a failure here is reported without consequence.
  if (challenged === 'challenge') {
    const s2 = await openPanelAndWaitForStatus();
    if (s2 === 'on') {
      const clicked = await clickButton('^turn off$');
      if (!clicked) fail('no "Turn off" button in the panel while MFA was on');
      else await waitForPill('off').catch(() => fail('the panel never returned to "off" after Turn off'));
    } else {
      fail(`expected the panel to read "on" after enrolling, got "${s2}"`);
    }
    const afterUi = await serverSideMfa({ waitUntilOff: true });
    afterUi.preferred !== 'SOFTWARE_TOKEN_MFA'
      ? pass('the "Turn off" button un-enrolled the account — confirmed with Cognito')
      : fail('"Turn off" did not un-enrol the account (the finally below will restore it)');
  }

  const real = errors.filter((e) => !/favicon/i.test(e));
  real.length === 0 ? pass('no page errors') : fail(`page errors: ${real.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();

  /* Guaranteed restore. Runs even if the browser crashed or an assertion threw,
     because an account left enrolled breaks every other headless script. */
  try {
    const outcome = await forceRestore();
    if (outcome === 'STILL ENROLLED') {
      fail('COULD NOT RESTORE the test approver — it is left ENROLLED');
      fail('  fix by hand:');
      fail(`  aws cognito-idp admin-set-user-mfa-preference --profile aeygis --region ${REGION} \\`);
      fail(`    --user-pool-id ${POOL_ID} --username ${cognitoUsername} \\`);
      fail('    --software-token-mfa-settings \'{"Enabled":false,"PreferredMfa":false}\'');
    } else {
      pass(`test approver left password-only (${outcome})`);
    }
  } catch (e) {
    fail(`restore threw: ${e.message}`);
  }
}

console.log('');
console.log(failures === 0
  ? 'Two-factor works end to end: enrolment is recorded by Cognito, and sign-in is challenged.'
  : `${failures} CHECK(S) FAILED.`);
console.log('');
process.exitCode = failures === 0 ? 0 : 1;
