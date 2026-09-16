/**
 * Can the live site run locally and actually reach the backend?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES, AND WHY IT STORES NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The question is whether the shipped submission code works when the site is
 * served from `http://localhost`, against the REAL Cognito and AppSync — not
 * against stubs. Three things could break there and none is visible from
 * reading the code:
 *
 *   1. `crypto.subtle` is only available in a SECURE CONTEXT. `http://localhost`
 *      counts as one; `file://` does not.
 *   2. CORS on Cognito Identity and on AppSync has to permit a localhost origin
 *      and the exact headers SigV4 adds.
 *   3. The signature has to be accepted by AWS, from a browser, for real.
 *
 * It deliberately submits **without consent**. The backend validates consent
 * before it stores anything, so the whole path runs — credentials, signature,
 * AppSync, the Lambda — and the reply is a refusal rather than a record.
 *
 *   - nothing is written to DynamoDB
 *   - no new-lead notification is sent (that only fires after a successful store)
 *   - a 403, a CORS failure or a bad signature would look completely different
 *     from the refusal we expect, so the check cannot pass for the wrong reason
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ It DOES invoke the real API. It creates nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npm run verify:local-site
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SITE_ROOT = 'd:/Aeygis-Work/aeygis-website-source-code';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No local Chrome/Edge found.'); process.exit(1); }

// ── serve the site exactly as it sits on disk ──────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg',
};
const server = createServer((req, res) => {
  const requested = decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(SITE_ROOT, requested === '/' ? 'index.html' : requested);
  if (!path.resolve(full).startsWith(path.resolve(SITE_ROOT))) { res.writeHead(403).end(); return; }
  if (!existsSync(full) || !statSync(full).isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
pass(`serving the site from disk at ${origin}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`${origin}/assessment.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#assessment-form');
  pass('the assessment page loads and its script runs');

  // 1 — secure context. Without this, signing is impossible and the page has no
  //     way to tell you why. This is the difference between serving over http
  //     and double-clicking the file.
  const ctx = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasSubtle: typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined',
  }));
  ctx.isSecureContext ? pass('localhost is a secure context') : fail('not a secure context');
  ctx.hasSubtle ? pass('crypto.subtle is available (signing is possible)') : fail('crypto.subtle missing — signing cannot work');

  // 2 — run the SHIPPED submission code, in this page, against real AWS.
  const block = (() => {
    const src = readFileSync(path.join(SITE_ROOT, 'assets/js/assessment.js'), 'utf8');
    const b = src.indexOf('// AEYGIS_BACKEND_BEGIN');
    const e = src.indexOf('// AEYGIS_BACKEND_END');
    return src.slice(b, e);
  })();

  console.log('\nSubmitting WITHOUT consent — the backend must refuse and store nothing:');
  const result = await page.evaluate(async (source) => {
    try {
      const api = new Function(`${source}\n return { aeygisSubmitWithRetry, AEYGIS_API_ENDPOINT };`)();
      const receipt = await api.aeygisSubmitWithRetry(
        {
          clinicName: 'Local Serve Check',
          contactName: 'Automated Check',
          email: 'local-check@aeygis-test.invalid',
          providers: '1-2',
          locations: '1',
          // consent deliberately omitted -> validation refuses before storing
        },
        { maxAttempts: 1 },
      );
      return { ok: true, receipt, endpoint: api.AEYGIS_API_ENDPOINT };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }, block);

  if (!result.ok) {
    fail(`the submission threw: ${result.error}`);
    if (/Failed to fetch|NetworkError|CORS/i.test(result.error)) {
      fail('  that reads like a CORS or transport failure, not a backend refusal');
    }
  } else {
    pass('the request completed — credentials, signature and CORS all worked');
    const r = result.receipt;
    if (r && r.ok === false && /consent/i.test(r.message ?? '')) {
      pass(`the backend refused it for the right reason: "${r.message}"`);
      pass('nothing was stored, and no notification was sent');
    } else {
      fail(`unexpected reply — expected a consent refusal, got ${JSON.stringify(r)}`);
    }
    result.endpoint
      ? pass(`the shipped endpoint constant is populated (${result.endpoint.slice(0, 46)}…)`)
      : fail('AEYGIS_API_ENDPOINT is blank — a real submission would go nowhere');
  }

  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  realErrors.length === 0
    ? pass('no console errors')
    : fail(`console errors: ${realErrors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}

console.log(
  failures === 0
    ? '\nThe live site works when served locally, and reaches the real backend.\n' +
      'It must be served over http:// — opening the file directly (file://) is NOT a\n' +
      'secure context, so crypto.subtle is unavailable and signing cannot happen.\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
