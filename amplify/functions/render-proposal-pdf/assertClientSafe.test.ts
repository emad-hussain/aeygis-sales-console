import { describe, expect, it } from 'vitest';
import {
  ClientSafetyError,
  assertClientSafe,
  assertHtmlFreeOfConfidentialWords,
  assertHtmlFreeOfLiterals,
  extractVisibleText,
} from './assertClientSafe.js';
import { toClientPayload, quote } from '@aeygis/pricing';
import { renderProposalHtml } from './template.js';
import {
  DELIVERY_COST_PER_HOUR_CAD,
  COMPETITOR_PRICING,
  indicativeMarginRange,
} from '@aeygis/pricing-internal';

/**
 * The confidentiality firewall test suite — barrier 5, plus an end-to-end check
 * that a real rendered proposal contains none of the internal figures.
 *
 * This file is the ONLY place in the repo where a test may import both
 * @aeygis/pricing-internal and the renderer. It does so precisely to prove they
 * cannot mix: it feeds confidential data at the guard and asserts it is rejected.
 *
 * `.dependency-cruiser.cjs` excludes *.test.ts from the forbidden-edge rule for
 * this reason. Production code has no such exemption.
 */

const ASSETS = { lato400: 'AA', lato700: 'AA', lato900: 'AA', logoOnDark: 'AA', logoOnLight: 'AA' };

function goldenPayload() {
  const result = quote({ providers: 10, locations: 6 });
  return toClientPayload(result, 'professional', {
    clinicName: 'Bay Street Family Health',
    contactName: 'Practice Manager',
    proposalReference: 'AEY-TEST01-v0001',
    issuedOn: '2026-08-17',
    validUntil: '2026-09-16',
    providerCount: 10,
    locationCount: 6,
    recommendedPlan: 'fullManaged',
    hosting: 'cloud',
    mfa: 'yes',
    backups: 'yes',
    incidentPlan: 'unsure',
    lastRiskAssessment: 'never',
    discoveryAnswers: JSON.stringify({ q01: 'EMR, PACS, billing system', q06: 'PostgreSQL, SQL Server' }),
    customDiscoveryQuestions: null,
    // Populated ON PURPOSE. With these null the spend, schedule and
    // responsibility pages do not render at all, and every guard assertion
    // below would be scanning a document that omits the newest content —
    // passing for the wrong reason.
    monthlyItSpend: 11_500,
    annualHardwareEmergency: 60_000,
    downtimeHoursBand: '40to90',
    downtimeCostBand: '2500to5000',
    migrationSchedule: JSON.stringify({
      estimates: { discover: '1–2 weeks', migrate: '3 weeks' },
      note: 'Assumes vendor availability.',
    }),
    responsibilityMatrix: JSON.stringify({
      excludedIds: ['r-emr'],
      added: [{ id: 'rc-1', area: 'Digital fax', aeygis: 'Hosting', clinic: 'Number porting' }],
    }),
  });
}

describe('the guard rejects confidential keys', () => {
  it.each([
    'deliveryCost',
    'grossMargin',
    'marginRange',
    'competitorPricing',
    'hourlyRate',
    'cogs',
    'internalNotes',
    'discountFloor',
    'payrollEstimate',
    'discountFactor',
  ])('rejects a key named %s', (key) => {
    expect(() => assertClientSafe({ [key]: 1 })).toThrow(ClientSafetyError);
  });

  it('rejects a forbidden key nested deep inside an otherwise clean payload', () => {
    const sneaky = {
      documentTitle: 'Proposal',
      plans: [{ planLabel: 'Full Managed', detail: { breakdown: { grossMarginCad: 41_200 } } }],
    };
    try {
      assertClientSafe(sneaky);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientSafetyError);
      // The error must say WHERE, or it is useless in a Lambda log.
      expect((error as ClientSafetyError).path).toBe('$.plans[0].detail.breakdown.grossMarginCad');
    }
  });

  it('rejects confidential text even under a harmless key name', () => {
    expect(() =>
      assertClientSafe({ note: 'CONFIDENTIAL - Internal Use Only' }),
    ).toThrow(ClientSafetyError);
    expect(() => assertClientSafe({ note: 'our cost per hour is lower' })).toThrow(ClientSafetyError);
  });

  it('rejects functions and other unexpected types', () => {
    expect(() => assertClientSafe({ render: () => 'x' })).toThrow(ClientSafetyError);
  });

  it('allows a genuine client payload', () => {
    expect(() => assertClientSafe(goldenPayload())).not.toThrow();
  });

  it('allows the client-facing money field names', () => {
    // Named deliberately so none of them contains "cost".
    expect(() =>
      assertClientSafe({
        setupTotal: 55_000,
        monthlyTotal: 18_000,
        firstYearTotal: 271_000,
        annualCheckup: 0,
      }),
    ).not.toThrow();
  });
});

describe('a rendered proposal leaks nothing', () => {
  const html = renderProposalHtml(goldenPayload(), ASSETS);

  it('renders', () => {
    expect(html).toContain('Bay Street Family Health');
    expect(html).toContain('Aeygis Health');
    expect(html.length).toBeGreaterThan(3_000);
  });

  it('contains no confidential vocabulary in VISIBLE COPY', () => {
    // Scans rendered text, not markup. Scanning raw HTML is useless here:
    // `margin` is a CSS property, so every stylesheet would trip it.
    expect(() => assertHtmlFreeOfConfidentialWords(html)).not.toThrow();
  });

  it('strips CSS and SVG before scanning, so the guard is not defeated by markup', () => {
    const text = extractVisibleText(html);
    expect(text).not.toContain('@font-face');
    expect(text).not.toContain('margin:');
    expect(text).toContain('Bay Street Family Health');
  });

  it('DECODES entities, so the scanner reads what a reader reads', () => {
    // esc() escapes every apostrophe and quote on the way in. A scanner that
    // left them encoded would be matching against text no human ever sees.
    const text = extractVisibleText(html);
    expect(text).not.toContain('&#39;');
    expect(text).not.toContain('&quot;');
    expect(text).toContain("Amazon Web Services' contractual SLA");
  });

  it('still catches a confidential phrase written with an apostrophe', () => {
    expect(() =>
      assertHtmlFreeOfConfidentialWords('<p>Our competitor&#39;s pricing is higher.</p>'),
    ).toThrow(ClientSafetyError);
  });

  it('does NOT render a technical-discovery appendix', () => {
    // Removed on request: discovery is a working record for the console, not
    // something the client needs back. Asserted three ways because a partial
    // removal — the heading gone but the answers still emitted somewhere — is
    // the failure that would matter.
    expect(html).not.toContain('Technical discovery');
    expect(html).not.toContain('What applications and systems are included in the migration scope?');
    expect(html).not.toContain('EMR, PACS, billing system');
    expect(html).not.toContain('discovery-item');
  });

  it('renders the newest sections, so the guard assertions are not scanning a document without them', () => {
    expect(html).toContain('Set against what your clinic already spends');
    expect(html).toContain('Shared responsibility, stated before you sign');
    expect(html).toContain('How long each stage is expected to take');
    expect(html).toContain('Keep your local IT provider');
    // hosting is 'cloud' in the golden payload → Track B only.
    expect(html).toContain('Track B');
    expect(html).not.toContain('Track A');
    // The unticked approved row must genuinely be absent, not merely hidden.
    expect(html).not.toContain('Application usage, charting, billing');
  });

  it('renders both uptime figures WITH their attribution, never bare', () => {
    const text = extractVisibleText(html);
    expect(text).toContain('99.99%');
    expect(text).toContain('99.9%');
    // The labelling is the whole point — a bare number would let a clinic plan
    // around the wrong one by a factor of ten.
    expect(text).toMatch(/Amazon Web Services'? contractual SLA/);
    expect(text).toContain('An Aeygis service target, not a guarantee');
    expect(text).toContain('about 53 minutes per year');
    expect(text).toContain('about 8 hours 45 minutes per year');
    // The figure with no documented source must not appear anywhere.
    expect(text).not.toContain('99.97');
  });

  it('renders the Why Aeygis page, both rows', () => {
    const text = extractVisibleText(html);
    expect(text).toContain('An Ontario partner that understands healthcare operations');
    expect(text).toContain('National cloud providers sell infrastructure');
    expect(text).toContain('One team, one number');
    expect(text).toContain('What to expect from Aeygis');
    expect(text).toContain('Ongoing ownership');
  });

  it('renders a signable acceptance page with both parties named', () => {
    const text = extractVisibleText(html);
    expect(text).toContain('Confirming this proposal');
    expect(text).toContain('Aeygis Technologies Inc.');
    expect(text).toContain('Bay Street Family Health');
    expect(text).toContain('AEY-TEST01-v0001');
    expect(text).toContain('Pricing held until');
    // Both signature blocks, each with all four lines.
    expect(text.match(/Signature/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('not the service agreement');
  });

  it('has no sources page, and still leaves no statistic unattributed', () => {
    const text = extractVisibleText(html);

    // The appendix is gone.
    expect(text).not.toContain('Every figure in this document, attributed');
    expect(text).not.toContain('Sources and references');
    // ...and so is the pointer to it that the regulatory page carried.
    expect(text).not.toContain('Full attribution for every figure above is on page');

    // The invariant the appendix used to serve survives WITHOUT it, because
    // every claim still in the document carries its attribution inline. This
    // is the assertion that matters: dropping the page would have been wrong
    // if any of these statistics were left standing on their own.
    expect(text).toContain('44%');
    expect(text).toContain('IDC');
    expect(text).toContain('$1,000,000');
    expect(text).toContain('PHIPA Decision 298');
    expect(text).toContain('45%');
    expect(text).toContain('CIRA');
    expect(text).toContain('99.99%');
    expect(text).toContain("Amazon Web Services' contractual SLA");

    // Flexera's 27%/84% was the one STATISTIC that appeared only in the
    // appendix, so claim and source left together and nothing is orphaned.
    expect(text).not.toContain('Flexera');

    // "Well-Architected" is deliberately NOT asserted absent. A PDF-text probe
    // reported it as appendix-only; that was a false negative — PyMuPDF split
    // the hyphenated term across a line break. It is still on the migration
    // track and delivery pages, where it names an AWS framework rather than
    // quoting a figure, so it needs no citation.
    expect(text).toContain('Well-Architected');
  });

  it('states the support plan on the signature page without asking the client to pick it', () => {
    const text = extractVisibleText(html);
    // The plan IS stated — removing it entirely was an over-correction.
    expect(text).toContain('Your support plan');
    expect(text).toContain('Essentials');
    expect(text).toContain('Signing below confirms the support plan selected above');
    // What went is the ASK: no imperative heading, and no tick-box markup.
    expect(text).not.toContain('Select your support plan');
    expect(html).not.toContain('class="tick"');
  });

  it('the spend page shows the client\'s own money and no Aeygis figure beyond the quoted price', () => {
    const text = extractVisibleText(html);
    expect(text).toContain('$441,750');
    expect(text).toContain('Indicative, and based entirely on figures your clinic provided');
  });

  it('never lets a staff discovery answer reach the document at all — a stronger guarantee ' +
    'than scanning one, which is what this asserted while the appendix still rendered', () => {
    const leaky = toClientPayload(quote({ providers: 10, locations: 6 }), 'professional', {
      clinicName: 'Bay Street Family Health',
      contactName: 'Practice Manager',
      proposalReference: 'AEY-TEST01-v0001',
      issuedOn: '2026-08-17',
      validUntil: '2026-09-16',
      providerCount: 10,
      locationCount: 6,
      recommendedPlan: 'fullManaged',
      hosting: null,
      mfa: null,
      backups: null,
      incidentPlan: null,
      lastRiskAssessment: null,
      discoveryAnswers: JSON.stringify({ q01: 'Our gross margin on this deal is healthy.' }),
      customDiscoveryQuestions: null,
      monthlyItSpend: null,
      annualHardwareEmergency: null,
      downtimeHoursBand: null,
      downtimeCostBand: null,
      migrationSchedule: null,
      responsibilityMatrix: null,
    });
    const leakyHtml = renderProposalHtml(leaky, ASSETS);
    // The answer is not in the document, so there is nothing for the guard to
    // catch — and the guard therefore passes. Both halves are asserted: the
    // absence is the point, and a passing guard alone would also be true of a
    // document that simply failed to render.
    expect(leakyHtml).not.toContain('gross margin on this deal');
    expect(leakyHtml).toContain('Bay Street Family Health');
    expect(() => assertHtmlFreeOfConfidentialWords(leakyHtml)).not.toThrow();
  });

  it('refuses to scan for small literals rather than reporting a false pass', () => {
    // The hourly rates (75, 100, 130) are too small to scan for: they collide
    // with page numbers, dates and percentages. The guard says so loudly instead
    // of quietly passing.
    expect(() => assertHtmlFreeOfLiterals(html, [DELIVERY_COST_PER_HOUR_CAD.standard.min])).toThrow(
      /Refusing to scan/,
    );
  });

  it('contains no computed internal margin figures', () => {
    const margin = indicativeMarginRange(18_000, 60);
    expect(() => assertHtmlFreeOfLiterals(html, [margin.low, margin.high])).not.toThrow();
  });

  it('contains no competitor names', () => {
    for (const c of COMPETITOR_PRICING) {
      expect(html).not.toContain(c.name);
    }
  });

  it('would FAIL if a margin figure were ever interpolated (guard is not vacuous)', () => {
    // Proves the scanner actually detects a leak, rather than passing because it
    // can never match anything.
    const margin = indicativeMarginRange(18_000, 60).low;
    expect(() => assertHtmlFreeOfLiterals(`<p>${margin}</p>`, [margin])).toThrow(ClientSafetyError);
  });

  it('would FAIL if confidential wording reached visible copy (guard is not vacuous)', () => {
    expect(() =>
      assertHtmlFreeOfConfidentialWords('<style>p{margin:0}</style><p>Our gross margin is healthy.</p>'),
    ).toThrow(ClientSafetyError);
  });

  it('escapes HTML in client-supplied values', () => {
    // Clinic names come from an anonymous public form. An unescaped name would
    // be script injection into a document staff open and email onward.
    const payload = {
      ...goldenPayload(),
      preparedFor: '<script>alert(1)</script>',
    };
    const out = renderProposalHtml(payload, ASSETS);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

describe('Enterprise cannot be rendered', () => {
  it('refuses to build a payload for an Enterprise engagement', () => {
    const result = quote({ providers: 20, locations: 3 });
    expect(() =>
      toClientPayload(result, 'enterprise', {
        clinicName: 'Big Network',
        contactName: null,
        proposalReference: 'AEY-X-v0001',
        issuedOn: '2026-08-17',
        validUntil: '2026-09-16',
        providerCount: 20,
        locationCount: 3,
        recommendedPlan: null,
        hosting: null,
        mfa: null,
        backups: null,
        incidentPlan: null,
        lastRiskAssessment: null,
        discoveryAnswers: null,
        customDiscoveryQuestions: null,
        monthlyItSpend: null,
        annualHardwareEmergency: null,
        downtimeHoursBand: null,
        downtimeCostBand: null,
        migrationSchedule: null,
        responsibilityMatrix: null,
      }),
    ).toThrow(/discovery call/i);
  });
});
