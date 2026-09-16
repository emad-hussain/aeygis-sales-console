/**
 * Screenshots the "Send to client" block in both themes.
 *
 * Exists because the delivery UI was written and styled while the backend did
 * not yet have a ProposalDelivery model, so it could not be looked at. The
 * first thing a human noticed once it was live was a large empty gap above the
 * heading — three stacked margins and a divider using a token that is
 * `transparent` in light mode. Neither is visible to typecheck, the unit suite,
 * or a build.
 *
 * READ ONLY. Signs in, opens a lead that has proposals, captures the block.
 *
 * Usage — the dev server must already be running (npm run console):
 *   node scripts/shot-delivery-panel.mjs [reference] [url]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REFERENCE = process.argv[2] ?? 'AEY-2UZG4Z';
const URL_TO_CHECK = process.argv[3] ?? 'http://localhost:5173/';
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '.artifacts');

const CANDIDATE_BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found.');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(new URL('../.test-credentials.json', import.meta.url), 'utf8'));
const who = creds.approver;

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
await page.goto(URL_TO_CHECK, { waitUntil: 'networkidle2', timeout: 45_000 });

await page.type('input[name="username"]', who.username, { delay: 10 });
await page.type('input[name="password"]', who.password, { delay: 10 });
await page.click('button[type="submit"]');

/**
 * Wait for the queue to have ROWS, not merely for its heading.
 *
 * "Intake queue" renders synchronously, so waiting on that text returns before
 * listAssessments() has resolved and the page still has zero items — which is
 * exactly how the first run of this script reported "could not find the lead"
 * against a queue that was simply still loading. verify-console-renders.mjs
 * already documents this trap; it was worth reading before repeating it.
 */
await page.waitForFunction(
  () => document.querySelectorAll('.queue-item').length > 0,
  { timeout: 45_000, polling: 250 },
);
console.log('signed in, queue loaded');

// Open the lead that actually has proposals — an empty one would render the
// "nothing to send yet" branch and show none of the spacing being checked.
const opened = await page.evaluate((ref) => {
  const items = [...document.querySelectorAll('.queue-item')];
  const match = items.find((el) => (el.innerText ?? '').includes(ref));
  if (!match) return items.map((el) => (el.innerText ?? '').split('\n')[0]);
  match.click();
  return true;
}, REFERENCE);

if (opened !== true) {
  console.error(`Could not find ${REFERENCE} in the queue. Saw:`);
  for (const line of opened ?? []) console.error(`  ${line}`);
  await browser.close();
  process.exit(1);
}

await page.waitForFunction(() => document.querySelector('.delivery-block') !== null, {
  timeout: 30_000,
});
console.log('delivery block rendered');

// Let the approvals table and delivery history finish loading, and any
// transition settle, before measuring or capturing.
await new Promise((r) => setTimeout(r, 2500));

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await new Promise((r) => setTimeout(r, 500));

  const el = await page.$('.delivery-block');
  await el.scrollIntoView();
  await new Promise((r) => setTimeout(r, 300));

  const out = path.join(outDir, `delivery-block-${theme}.png`);
  await el.screenshot({ path: out });
  console.log(`wrote ${path.basename(out)}`);
}

/* The measurement that matters: how much dead space sits above the heading,
   and whether the divider is actually visible. */
const metrics = await page.evaluate(() => {
  const block = document.querySelector('.delivery-block');
  const head = block?.querySelector('.sub-head');
  if (!block || !head) return null;
  const cs = getComputedStyle(block);
  const hs = getComputedStyle(head);
  return {
    blockMarginTop: cs.marginTop,
    blockPaddingTop: cs.paddingTop,
    headMarginTop: hs.marginTop,
    borderTopWidth: cs.borderTopWidth,
    borderTopColor: cs.borderTopColor,
    gapAboveHeading:
      Math.round(head.getBoundingClientRect().top - block.getBoundingClientRect().top) + 'px',
  };
});
console.log('\nspacing:');
for (const [k, v] of Object.entries(metrics ?? {})) console.log(`  ${k.padEnd(18)} ${v}`);

await browser.close();
