/**
 * Renders a sample proposal to PDF locally, using the system Chrome.
 *
 * Purpose: see the document before deploying. It exercises the same template,
 * the same client payload, and the same client-safety guards the Lambda uses, so
 * a layout or font problem surfaces here rather than after a Chromium-in-Lambda
 * deploy.
 *
 * This does NOT prove the Lambda path works — the binary, layer and bundling are
 * different problems. It proves the DOCUMENT is right.
 *
 * Usage:
 *   node scripts/preview-proposal.mjs [outputPath]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { quote, toClientPayload } from '@aeygis/pricing';
import { renderProposalHtml } from '../amplify/functions/render-proposal-pdf/template.ts';
// Same inlined bytes the Lambda uses, so the preview cannot drift from production.
import { TEMPLATE_ASSETS } from '../amplify/functions/render-proposal-pdf/template-assets.generated.ts';
import {
  assertClientSafe,
  assertHtmlFreeOfConfidentialWords,
} from '../amplify/functions/render-proposal-pdf/assertClientSafe.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No local Chrome/Edge found. Tried:\n  ' + CANDIDATE_BROWSERS.join('\n  '));
  process.exit(1);
}

/**
 * Deliberately near/at MAX_DISCOVERY_ANSWER_LENGTH so the preview is the
 * genuine overflow stress-test, not the happy path — a worst-case answer on
 * EVERY question of the largest group (app-data, which splits into two
 * discovery pages) proves the split-page layout doesn't clip, not just that
 * a short answer fits.
 */
const LONG_ANSWER =
  'This spans several current systems, integrations and dependencies that would need to be fully ' +
  'documented during the discovery call before a migration plan can be finalized, including legacy ' +
  'components, vendor-managed services, and internal tooling that has accumulated undocumented ' +
  'configuration drift over several years of operation without a formal change-management process.';

const discoveryAnswers = JSON.stringify({
  // scope (3) — realistic short answers.
  q01: 'EMR (ClinicOS), patient billing, appointment scheduling.',
  q02: 'On a rack server in the clinic’s back office, with a secondary drive for nightly backups.',
  q03: '2 physical servers, 3 VMs.',
  // app-data (5) — every one at the stress-test length; this group splits
  // into two discovery pages (4 + 1), so this is the actual overflow proof.
  q04: LONG_ANSWER,
  q05: LONG_ANSWER,
  q06: LONG_ANSWER,
  q07: LONG_ANSWER,
  q08: LONG_ANSWER,
  // integrations (4) — q09 deliberately OVER the truncation cap (tests the
  // "… (truncated — full answer on file)" marker); the rest left blank.
  q09: LONG_ANSWER + ' ' + LONG_ANSWER,
  // identity-security (3) — mixed.
  q13: 'Local Active Directory, no SSO.',
  // resilience-ops (5) — mixed, including one deliberately unrecognized-shape value.
  q17: 'Nightly local backup only, never tested restoring from it.',
  q20: '',
  // Custom questions share the SAME answers map, keyed by their own ids.
  'cq-preview-1': LONG_ANSWER,
  'cq-preview-2': 'Kodak CR, two modalities, DICOM over the clinic LAN.',
  // 'cq-preview-3' deliberately unanswered.
});

/**
 * Per-assessment additions: one extra question inside an EXISTING approved
 * category, plus a whole new category. Exercises both halves of the feature
 * and the 21+ numbering that must not disturb the approved 1-20.
 */
const customDiscoveryQuestions = JSON.stringify({
  categories: [{ id: 'cc-preview-imaging', title: 'Imaging & PACS' }],
  questions: [
    {
      id: 'cq-preview-1',
      categoryId: 'identity-security',
      question: 'Which staff roles can export patient records in bulk, and is that logged?',
    },
    {
      id: 'cq-preview-2',
      categoryId: 'cc-preview-imaging',
      question: 'What imaging modalities and PACS software are in use?',
    },
    {
      id: 'cq-preview-3',
      categoryId: 'cc-preview-imaging',
      // At the length cap, to stress the widest a custom question can render.
      question:
        'What are the retention requirements for diagnostic imaging studies, including any ' +
        'provincial or college obligations that dictate how long studies must remain retrievable?',
    },
  ],
});

// A representative Professional engagement with per-unit scaling, so the
// breakdown lines and the ineligible-plan handling both appear.
const result = quote({ providers: 10, locations: 6 });
const payload = toClientPayload(result, 'professional', {
  clinicName: 'Bay Street Family Health',
  contactName: 'Dana Whitfield, Practice Manager',
  proposalReference: 'AEY-PREVIEW-v0001',
  issuedOn: '17 August 2026',
  validUntil: '16 September 2026',
  providerCount: 10,
  locationCount: 6,
  recommendedPlan: 'fullManaged',
  // A deliberate mix of raw codes — including one outside the known set —
  // so the preview also demonstrates the "unanswered/unrecognized => omitted
  // tile" behaviour, not just the happy path.
  hosting: 'onprem',
  mfa: 'no',
  backups: 'unsure',
  incidentPlan: 'not-a-real-code',
  lastRiskAssessment: '1-2yr',
  discoveryAnswers,
  customDiscoveryQuestions,
  // Real figures from a seeded clinic, so the comparison page exercises the
  // actual arithmetic rather than round numbers that hide rounding problems.
  monthlyItSpend: 11_500,
  annualHardwareEmergency: 60_000,
  downtimeHoursBand: '40to90',
  downtimeCostBand: '2500to5000',
  migrationSchedule: JSON.stringify({
    estimates: {
      discover: '1–2 weeks',
      plan: '2 weeks',
      migrate: '3–4 weeks, cutover on a weekend',
      optimize: '2 weeks post-launch',
      support: 'Ongoing from go-live',
    },
    note: 'Assumes EMR vendor availability for the dependency review in week 2, and a maintenance window on a non-clinical weekend for final cutover.',
  }),
  responsibilityMatrix: JSON.stringify({
    // Exercises both halves: one approved row hidden, one custom row added.
    excludedIds: ['r-emr'],
    added: [
      {
        id: 'rc-preview-1',
        area: 'Digital fax platform',
        aeygis: 'Owner: hosting, routing configuration, delivery monitoring',
        clinic: 'Owner: number porting, cover-sheet content, recipient verification',
      },
    ],
  }),
});

// Same guards the Lambda runs. A preview that skipped them would be misleading.
assertClientSafe(payload);
const html = renderProposalHtml(payload, TEMPLATE_ASSETS);
assertHtmlFreeOfConfidentialWords(html);
console.log('client-safety guards passed');

const outPath = process.argv[2] ?? path.join(here, '..', 'proposal-preview.pdf');

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  // Fonts are embedded as data URIs, but give the engine a beat to apply them —
  // otherwise the first page can rasterise in a fallback face.
  await page.evaluate(() => document.fonts.ready);
  // No width/height here: puppeteer rejects `pt` units, and the page size is
  // already declared once in the template's `@page { size: 960pt 679pt }`.
  // preferCSSPageSize makes that declaration authoritative, so the geometry has
  // a single source of truth instead of two that can drift.
  await page.pdf({
    path: outPath,
    printBackground: true,
    preferCSSPageSize: true,
  });
  const size = readFileSync(outPath).length;
  console.log(`wrote ${outPath} (${(size / 1024).toFixed(0)} kB)`);
} finally {
  await browser.close();
}

writeFileSync(outPath.replace(/\.pdf$/, '.html'), html);
console.log('also wrote the HTML alongside it for inspection');
