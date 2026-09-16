/**
 * Proves the PUBLIC CALCULATOR quotes the same prices as the approved price
 * book — without calling AWS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The live site's calculator used to quote tiers called Foundation / Growth /
 * Enterprise at $16,000 / $42,000 / $95,000 setup, while the approved documents
 * say Micro / Starter / Professional / Enterprise at $7,500 / $15,000 / $55,000
 * across three support plans. Not one tier name or figure agreed. Prospects
 * were reading one set of numbers on the website and a different set in the
 * proposal that followed.
 *
 * That went unnoticed for a long time because nothing compared the two. This
 * does. It extracts the price book that actually ships to browsers and checks
 * it, figure by figure, against `packages/pricing` — the same module the
 * generated proposal PDF is built from.
 *
 * It also exercises the calculator's behaviour, because the figures being right
 * is not enough on its own: the form collects BANDS, and a band spans more than
 * one tier. The rules that keep that honest — Enterprise is never auto-priced,
 * Professional cannot take Train & Walk Away, savings only appear when they
 * hold across the whole range — are all asserted here.
 *
 * No AWS calls. No credentials. Safe to run on every edit.
 *
 * Run:  node scripts/verify-site-pricing.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE_SCRIPT = 'd:/Aeygis-Work/aeygis-website-source-code/assets/js/assessment.js';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — site has ${actual}, expected ${expected}`);

// ── extract the price book that actually ships ─────────────────────────────
const source = readFileSync(SITE_SCRIPT, 'utf8');
const begin = source.indexOf('// AEYGIS_PRICING_BEGIN');
const end = source.indexOf('// AEYGIS_PRICING_END');

if (begin === -1 || end === -1 || end < begin) {
  fail('could not find the AEYGIS_PRICING markers in the live site script');
  process.exit(1);
}
const block = source.slice(begin, end);
pass(`extracted ${block.split('\n').length} lines of shipped pricing code`);

/* Deliberately stricter than the signing check's `\bdocument\b`. The compliance
   copy in this block legitimately contains the words "documented incident
   response plan" and "approved documents", so a bare word match would fail on
   prose. What actually matters is DOM ACCESS, which always has a dot. */
if (/document\.|window\.|localStorage|sessionStorage/.test(block)) {
  fail('pricing block reaches the DOM — it must stay pure so this test can execute it');
} else {
  pass('pricing block is pure (no DOM access)');
}

const site = new Function(`
  ${block}
  return {
    TIERS, PRICE_BOOK_VERSION, calculate, candidateTiers,
    ENTERPRISE_PROVIDER_THRESHOLD, ENTERPRISE_LOCATION_THRESHOLD
  };
`)();
pass('shipped pricing block evaluates without error');

// ── the approved price book, from the module the PROPOSAL is built from ────
/* Written to a temp file rather than passed with `tsx -e`. On Windows the shell
   mangles a multi-line inline script and esbuild fails with a bewildering
   "Unexpected end of file" that has nothing to do with the code being checked. */
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'aeygis-pricebook-'));
const dumpFile = path.join(scratch, 'dump.ts');
let book;
try {
  writeFileSync(
    dumpFile,
    "import { SETUP, MONTHLY, TIER_SCOPE, PRICE_BOOK_VERSION, ENTERPRISE_PROVIDER_THRESHOLD, ENTERPRISE_LOCATION_THRESHOLD } from " +
      `${JSON.stringify(path.join(repoRoot, 'packages/pricing/src/index.ts').replace(/\\/g, '/'))};\n` +
      'console.log(JSON.stringify({ SETUP, MONTHLY, TIER_SCOPE, PRICE_BOOK_VERSION, ENTERPRISE_PROVIDER_THRESHOLD, ENTERPRISE_LOCATION_THRESHOLD }));\n',
    'utf8',
  );
  const dumped = execFileSync('npx', ['tsx', dumpFile], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
  });
  book = JSON.parse(dumped.trim().split('\n').pop());
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
pass('loaded the approved price book from @aeygis/pricing');

console.log('\nPrice book agreement (site vs @aeygis/pricing):');

eq(site.PRICE_BOOK_VERSION, book.PRICE_BOOK_VERSION, 'price book version');
eq(site.ENTERPRISE_PROVIDER_THRESHOLD, book.ENTERPRISE_PROVIDER_THRESHOLD, 'Enterprise provider threshold');
eq(site.ENTERPRISE_LOCATION_THRESHOLD, book.ENTERPRISE_LOCATION_THRESHOLD, 'Enterprise location threshold');

for (const key of ['micro', 'starter', 'professional']) {
  const siteTier = site.TIERS[key];
  eq(siteTier.setup, book.SETUP[key].base, `${key}: setup`);
  eq(siteTier.setupPerExtraProvider || 0, book.SETUP[key].perExtraProvider, `${key}: setup per extra provider`);
  eq(siteTier.setupPerExtraLocation || 0, book.SETUP[key].perExtraLocation, `${key}: setup per extra location`);
  eq(siteTier.baseProviders, book.TIER_SCOPE[key].baseProviders, `${key}: base provider scope`);
  eq(siteTier.baseLocations, book.TIER_SCOPE[key].baseLocations, `${key}: base location scope`);

  for (const planKey of ['trainAndWalkAway', 'essentials', 'fullManaged']) {
    const reference = book.MONTHLY[key][planKey];
    const shipped = siteTier.plans.find((p) => p.key === planKey);

    if (!reference.offered) {
      shipped === undefined
        ? pass(`${key}: ${planKey} is correctly NOT offered`)
        : fail(`${key}: ${planKey} is offered on the site but not in the price book`);
      continue;
    }
    if (shipped === undefined) {
      fail(`${key}: ${planKey} is missing from the site but IS offered in the price book`);
      continue;
    }
    eq(shipped.monthly, reference.monthlyBase, `${key}/${planKey}: monthly base`);
    eq(shipped.perProvider || 0, reference.perExtraProviderMonthly, `${key}/${planKey}: per extra provider`);
    eq(shipped.perLocation || 0, reference.perExtraLocationMonthly, `${key}/${planKey}: per extra location`);
    eq(shipped.annualCheckup || 0, reference.annualCheckup, `${key}/${planKey}: annual check-up`);
  }
}

site.TIERS.enterprise.custom === true && site.TIERS.enterprise.setup === undefined
  ? pass('Enterprise carries no price on the site — a discovery call is required')
  : fail('Enterprise has a price on the site; the Rate Card forbids quoting one before a discovery call');

/* The $150k-$450k Enterprise band is marked INTERNAL GUIDANCE in the pricing
   engine and is not a quotable figure. It must not have leaked onto a page a
   prospect can read. */
const guide = book.SETUP.enterprise.guideRange;
source.includes(String(guide.min)) || source.includes(String(guide.max))
  ? fail(`the internal Enterprise guide range (${guide.min}-${guide.max}) appears in the shipped site script`)
  : pass('the internal Enterprise guide range does not appear on the public site');

// ── the old, wrong figures must be gone for good ───────────────────────────
console.log('\nThe superseded figures are gone:');
const banned = [
  ['Foundation', /\bFoundation\b/],
  ['Growth tier', /track-name">Growth</],
  ['$16,000 setup', /\b16000\b|\b16,000\b/],
  ['$42,000 setup', /\b42000\b|\b42,000\b/],
  ['$95,000 setup', /\b95000\b|\b95,000\b/],
  ['perProviderUsage', /perProviderUsage/],
];
const siteFiles = {
  'assets/js/assessment.js': source,
  'index.html': readFileSync('d:/Aeygis-Work/aeygis-website-source-code/index.html', 'utf8'),
  'assessment.html': readFileSync('d:/Aeygis-Work/aeygis-website-source-code/assessment.html', 'utf8'),
};
for (const [label, pattern] of banned) {
  const found = Object.entries(siteFiles).filter(([, text]) => pattern.test(text)).map(([f]) => f);
  found.length === 0
    ? pass(`"${label}" no longer appears anywhere on the site`)
    : fail(`"${label}" still present in: ${found.join(', ')}`);
}

// ── behaviour: a band spans tiers, and the page must say so ────────────────
console.log('\nCalculator behaviour:');

/* Downtime bands are left unset so `currentMonthlyTco` equals `monthlyItSpend`
   exactly, which keeps the savings arithmetic below readable. The downtime
   contribution is asserted separately just after — an earlier version of this
   file folded it in and every savings expectation was silently 312.50 out. */
const baseAnswers = {
  monthlyItSpend: '0', annualHardwareEmergency: '0',
  downtimeHoursBand: '', downtimeCostBand: '',
  mfa: 'yes', backups: 'yes', incidentPlan: 'yes', lastRiskAssessment: '1yr',
};
const run = (providers, locations, extra = {}) =>
  site.calculate({ ...baseAnswers, providers, locations, ...extra });

{
  const r = run('1-2', '1');
  eq(r.tierLabel, 'Micro or Starter', '1-2 providers / 1 location offers BOTH Micro and Starter');
  eq(r.setupMin, 7500, '  setup floor is Micro');
  eq(r.setupMax, 15000, '  setup ceiling is Starter');
  eq(r.monthlyMin, 1800, '  monthly floor is Micro Essentials');
  eq(r.monthlyMax, 4900, '  monthly ceiling is Starter Full Managed');
  r.includesEnterprise === false ? pass('  Enterprise is not implicated') : fail('  Enterprise wrongly implicated');
}

{
  const r = run('1-2', '2-5');
  eq(r.tierLabel, 'Professional', '2 providers across several sites is Professional, not Starter');
  eq(r.setupMin, 55000, '  setup floor');
  eq(r.setupMax, 58000, '  setup ceiling includes one location beyond the base scope of 4');
  eq(r.monthlyMin, 9500, '  monthly floor is Professional Essentials');
  eq(r.monthlyMax, 19700, '  monthly ceiling is Full Managed plus one extra location');
  const professional = r.priced.find((p) => p.name === 'Professional');
  professional.plans.some((p) => p.key === 'trainAndWalkAway')
    ? fail('  Professional is offering Train & Walk Away, which the Framework forbids')
    : pass('  Professional does not offer Train & Walk Away');
}

{
  const r = run('3-15', '2-5');
  r.includesEnterprise === true
    ? pass('3-15 providers correctly reaches Enterprise at 15')
    : fail('3-15 providers should include Enterprise at exactly 15');
  r.isCustomOnly === false ? pass('  but Professional is still priced') : fail('  Professional pricing was dropped');
  eq(r.setupMax, 70000, '  setup ceiling = 55,000 + 6 extra providers + 1 extra location');
  eq(r.monthlyMax, 27500, '  monthly ceiling = 18,000 + 6x1,300 + 1x1,700');
}

{
  const r = run('15+', '1');
  r.isCustomOnly === true ? pass('15+ providers is Enterprise only') : fail('15+ providers should be Enterprise only');
  r.hasPricing === false ? pass('  no figure is produced') : fail('  a figure was produced for Enterprise');
}

{
  const r = run('1-2', '15+');
  r.isCustomOnly === true
    ? pass('15+ locations is Enterprise only, whatever the provider count')
    : fail('15+ locations should force Enterprise');
}

{
  const r = run('1-2', '5-15');
  r.includesEnterprise === true
    ? pass('5-15 locations straddles the 10-location Enterprise threshold')
    : fail('5-15 locations should reach Enterprise at 10');
}

// ── the clinic's own current spend ────────────────────────────────────────
console.log('\nCurrent-spend estimate:');
{
  const r = run('1-2', '1', {
    monthlyItSpend: '4000',
    annualHardwareEmergency: '12000',
    downtimeHoursBand: 'under10',      // 5 hours a year
    downtimeCostBand: 'under1000',     // $750 an hour
  });
  eq(r.currentMonthlyItCost, 4000 + 12000 / 12, 'monthly IT spend includes annual hardware, spread over 12 months');
  eq(r.monthlyDowntimeRisk, (5 * 750) / 12, 'downtime risk uses the band midpoints, spread over 12 months');
  eq(r.currentMonthlyTco, 5000 + 312.5, 'TCO is the sum of both');
}

// ── savings only when they hold across the WHOLE range ────────────────────
console.log('\nSavings rule:');
{
  // Micro/Starter ceiling is 4,900/mo.
  const generous = run('1-2', '1', { monthlyItSpend: '9400' });
  generous.showSavings === true ? pass('shown when current spend exceeds the ceiling') : fail('should be shown');
  eq(generous.savingMin, 9400 - 4900, '  smallest saving is measured against the ceiling');
  eq(generous.savingMax, 9400 - 1800, '  largest saving is measured against the floor');

  const marginal = run('1-2', '1', { monthlyItSpend: '4900' });
  marginal.showSavings === false
    ? pass('NOT shown when current spend merely equals the ceiling')
    : fail('a saving of zero was advertised');

  const modest = run('1-2', '1', { monthlyItSpend: '2100' });
  modest.showSavings === false
    ? pass('NOT shown when the move would cost more')
    : fail('savings shown when there are none');
  modest.savingMin === 0 && modest.savingMax === 0
    ? pass('  and no saving figure is computed at all')
    : fail('  a saving figure was computed anyway');
}

console.log(
  failures === 0
    ? '\nThe public calculator agrees with the approved price book.\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
