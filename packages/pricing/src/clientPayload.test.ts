import { describe, expect, it } from 'vitest';
import { ALL_DISCOVERY_QUESTIONS, DISCOVERY_GROUPS } from '@aeygis/domain';
import { quote } from './quote.js';
import { MAX_DISCOVERY_ANSWER_LENGTH, toClientPayload, type PayloadContext } from './clientPayload.js';

/**
 * Coverage for the "current environment" section of the client payload —
 * the structured, public-form-derived summary (hosting/MFA/backups/incident
 * plan/last risk assessment), not the staff-filled technical discovery.
 */

const BASE_CONTEXT: PayloadContext = {
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
  discoveryAnswers: null,
  customDiscoveryQuestions: null,
  monthlyItSpend: null,
  annualHardwareEmergency: null,
  downtimeHoursBand: null,
  downtimeCostBand: null,
  migrationSchedule: null,
  responsibilityMatrix: null,
};

function payloadWith(context: Partial<PayloadContext>) {
  const result = quote({ providers: 10, locations: 6 });
  return toClientPayload(result, 'professional', { ...BASE_CONTEXT, ...context });
}

describe('current-state translation', () => {
  it('translates every known raw code to its display label', () => {
    const { currentState } = payloadWith({
      hosting: 'onprem',
      mfa: 'yes',
      backups: 'no',
      incidentPlan: 'unsure',
      lastRiskAssessment: '1-2yr',
    });

    expect(currentState).toEqual({
      hosting: 'On-premises infrastructure',
      mfa: 'Yes',
      backups: 'No',
      incidentPlan: 'Not sure',
      lastRiskAssessment: '1–2 years ago',
    });
  });

  it('covers every value in each enum, not just one', () => {
    expect(payloadWith({ hosting: 'cloud' }).currentState.hosting).toBe('Already cloud-hosted');
    expect(payloadWith({ hosting: 'mixed' }).currentState.hosting).toBe('Mixed / hybrid environment');
    expect(payloadWith({ lastRiskAssessment: '1yr' }).currentState.lastRiskAssessment).toBe(
      'Within the last year',
    );
    expect(payloadWith({ lastRiskAssessment: 'never' }).currentState.lastRiskAssessment).toBe('Never');
    expect(payloadWith({ lastRiskAssessment: 'unsure' }).currentState.lastRiskAssessment).toBe('Not sure');
  });

  it('maps null (never answered) to null, not a placeholder string', () => {
    const { currentState } = payloadWith({});
    expect(currentState).toEqual({
      hosting: null,
      mfa: null,
      backups: null,
      incidentPlan: null,
      lastRiskAssessment: null,
    });
  });

  it('maps a value outside the known set to null rather than inventing a label', () => {
    // Guards against a future schema drift (a new code added to the live form
    // but not yet to this mapper) silently rendering a raw code verbatim.
    const { currentState } = payloadWith({ hosting: 'quantum-mainframe' });
    expect(currentState.hosting).toBeNull();
  });

  it('is independent per field: one unanswered field does not blank the others', () => {
    const { currentState } = payloadWith({ hosting: 'cloud', mfa: null });
    expect(currentState.hosting).toBe('Already cloud-hosted');
    expect(currentState.mfa).toBeNull();
  });
});

describe('spend comparison — shown only when it favours the proposal', () => {
  // Professional 10/6: Essentials first year $217,400, Full Managed $353,000.
  const favourable = {
    monthlyItSpend: 11_500,
    annualHardwareEmergency: 60_000,
    downtimeHoursBand: '40to90',
    downtimeCostBand: '2500to5000',
  }; // → $441,750/yr

  it('renders when the recommended plan beats what the clinic already spends', () => {
    const { spendComparison } = payloadWith({ ...favourable, recommendedPlan: 'fullManaged' });
    expect(spendComparison).not.toBeNull();
    expect(spendComparison?.annualTotal.amount).toBe(441_750);
    expect(spendComparison?.comparedPlanLabel).toBe('Full Managed');
    expect(spendComparison?.proposedFirstYear.amount).toBe(353_000);
    expect(spendComparison?.difference.amount).toBe(88_750);
  });

  it('is OMITTED when the recommended plan does not beat current spend', () => {
    // The confirmed instruction. Same clinic, but spending very little today.
    const { spendComparison } = payloadWith({
      monthlyItSpend: 200,
      annualHardwareEmergency: null,
      downtimeHoursBand: null,
      downtimeCostBand: null,
      recommendedPlan: 'fullManaged',
    });
    expect(spendComparison).toBeNull();
  });

  it('is omitted when the two are exactly equal — "favours" means strictly lower', () => {
    // $353,000 / 12 months = the monthly IT spend that ties Full Managed's
    // first year exactly. A tie is not a win and must not render.
    const { spendComparison } = payloadWith({
      monthlyItSpend: 353_000 / 12,
      annualHardwareEmergency: null,
      downtimeHoursBand: null,
      downtimeCostBand: null,
      recommendedPlan: 'fullManaged',
    });
    expect(spendComparison).toBeNull();
  });

  it('compares against the RECOMMENDED plan, not the cheapest one', () => {
    const rec = payloadWith({ ...favourable, recommendedPlan: 'fullManaged' });
    expect(rec.spendComparison?.comparedPlanLabel).toBe('Full Managed');
    const other = payloadWith({ ...favourable, recommendedPlan: 'essentials' });
    expect(other.spendComparison?.comparedPlanLabel).toBe('Essentials');
    expect(other.spendComparison?.proposedFirstYear.amount).toBe(217_400);
  });

  it('falls back to the lowest first-year total when no plan is recommended', () => {
    const { spendComparison } = payloadWith({ ...favourable, recommendedPlan: null });
    expect(spendComparison?.proposedFirstYear.amount).toBe(217_400);
  });

  it('is null when the clinic reported no spending at all', () => {
    expect(payloadWith({ recommendedPlan: 'fullManaged' }).spendComparison).toBeNull();
  });

  it('names only the components the clinic actually supplied', () => {
    const { spendComparison } = payloadWith({ ...favourable, recommendedPlan: 'fullManaged' });
    expect(spendComparison?.coversOnly).toHaveLength(3);
    const partial = payloadWith({
      monthlyItSpend: 30_000,
      annualHardwareEmergency: null,
      downtimeHoursBand: null,
      downtimeCostBand: null,
      recommendedPlan: 'fullManaged',
    });
    expect(partial.spendComparison?.coversOnly).toEqual(['reported monthly IT spend']);
    expect(partial.spendComparison?.annualHardware).toBeNull();
    expect(partial.spendComparison?.annualDowntime).toBeNull();
  });
});

describe('migration track, schedule and responsibilities', () => {
  it('derives the track from hosting, and gives "mixed" BOTH tracks', () => {
    expect(payloadWith({ hosting: 'onprem' }).migrationTracks.map((t) => t.name)).toEqual([
      expect.stringContaining('Track A'),
    ]);
    expect(payloadWith({ hosting: 'cloud' }).migrationTracks.map((t) => t.name)).toEqual([
      expect.stringContaining('Track B'),
    ]);
    expect(payloadWith({ hosting: 'mixed' }).migrationTracks).toHaveLength(2);
  });

  it('has no track at all when hosting was never answered', () => {
    expect(payloadWith({ hosting: null }).migrationTracks).toEqual([]);
    expect(payloadWith({ hosting: 'nonsense' }).migrationTracks).toEqual([]);
  });

  it('omits the schedule entirely when no estimates were entered', () => {
    expect(payloadWith({ migrationSchedule: null }).schedule).toBeNull();
    expect(payloadWith({ migrationSchedule: '{"estimates":{}}' }).schedule).toBeNull();
  });

  it('keeps phases in order and drops the ones left blank', () => {
    const { schedule } = payloadWith({
      migrationSchedule: JSON.stringify({
        estimates: { support: 'Ongoing', discover: '1 week' },
        note: 'Vendor lead time applies.',
      }),
    });
    // Declared out of order above; must render in phase order regardless.
    expect(schedule?.phases.map((p) => p.estimate)).toEqual(['1 week', 'Ongoing']);
    expect(schedule?.phases[0]?.name).toContain('Discover');
    expect(schedule?.note).toBe('Vendor lead time applies.');
  });

  it('ships all seven approved responsibility rows by default', () => {
    expect(payloadWith({}).responsibilities).toHaveLength(7);
  });

  it('excludes a row staff unticked, and appends rows they added', () => {
    const { responsibilities } = payloadWith({
      responsibilityMatrix: JSON.stringify({
        excludedIds: ['r-emr'],
        added: [{ id: 'rc-1', area: 'Digital fax', aeygis: 'Hosting', clinic: 'Numbers' }],
      }),
    });
    expect(responsibilities).toHaveLength(7);
    expect(responsibilities.some((r) => r.area.includes('EMR'))).toBe(false);
    expect(responsibilities[responsibilities.length - 1]?.area).toBe('Digital fax');
  });

  it('carries every matrix row through, however many staff add', () => {
    // The matrix page used to be a single page and silently clipped anything
    // past it — `.page` is overflow:hidden, so surplus rows were present in the
    // DOM and absent from the PDF. The renderer now packs them across pages by
    // estimated height; this pins that nothing is dropped upstream of it.
    const added = Array.from({ length: 14 }, (_, i) => ({
      id: `rc-${i}`,
      area: `Custom area ${i + 1}`,
      aeygis: 'A'.repeat(200),
      clinic: 'B'.repeat(200),
    }));
    const { responsibilities } = payloadWith({
      responsibilityMatrix: JSON.stringify({ excludedIds: [], added }),
    });
    expect(responsibilities).toHaveLength(21);
    // And over-long cells are capped rather than passed through whole.
    for (const r of responsibilities) {
      expect(r.aeygis.length).toBeLessThanOrEqual(160);
      expect(r.clinic.length).toBeLessThanOrEqual(160);
    }
  });

  it('always carries the co-existence positioning', () => {
    expect(payloadWith({}).coExistence.positioning).toContain('Keep your local IT provider');
    expect(payloadWith({}).coExistence.localProvider.length).toBeGreaterThan(0);
  });
});

describe('service levels — the uptime figures must never be bare', () => {
  it('carries BOTH figures, each naming whose commitment it is', () => {
    const { serviceLevels } = payloadWith({}).continuity;
    expect(serviceLevels).toHaveLength(2);
    const aws = serviceLevels.find((s) => s.figure === '99.99%');
    const aeygis = serviceLevels.find((s) => s.figure === '99.9%');
    expect(aws?.whoseCommitment).toMatch(/Amazon/i);
    expect(aws?.scope).toMatch(/compute/i);
    expect(aeygis?.whoseCommitment).toMatch(/target, not a guarantee/i);
  });

  it('NEVER carries 99.97% — it has no documented source', () => {
    // docs/known-issues.md #9. It appears on the live site and nowhere else,
    // and must not leak into a client document from any field.
    const json = JSON.stringify(payloadWith({}));
    expect(json).not.toContain('99.97');
  });

  it('states permitted downtime for each, since the two differ ~10x', () => {
    const { serviceLevels } = payloadWith({}).continuity;
    for (const s of serviceLevels) {
      expect(s.allowedDowntime).toMatch(/minute|hour/i);
    }
  });

  it('points at the agreement as the binding source, not at itself', () => {
    expect(payloadWith({}).continuity.serviceLevelNote).toMatch(/signed agreement/i);
  });

  it('every impact and regulatory figure has a matching citation row', () => {
    const p = payloadWith({});
    expect(p.citations.length).toBeGreaterThanOrEqual(6);
    const sources = p.citations.map((c) => c.source).join(' ');
    expect(sources).toMatch(/IDC/);
    expect(sources).toMatch(/AWS Compute Service Level Agreement/);
    expect(sources).toMatch(/Decision 298/);
    expect(sources).toMatch(/CIRA/);
    // Attribution must name the study, not just assert the number.
    expect(p.impact.attribution).toMatch(/IDC/);
    expect(p.impact.attribution).toMatch(/27 organizations/);
  });

  it('regulatory copy stops short of legal advice', () => {
    expect(payloadWith({}).regulatory.note).toMatch(/not constitute legal advice/i);
  });

  it('security section carries both the controls and the specifics behind them', () => {
    const { security } = payloadWith({});
    expect(security.controls).toHaveLength(6);
    expect(security.specifics.join(' ')).toMatch(/AES-256/);
    expect(security.specifics.join(' ')).toMatch(/ca-central-1/);
  });

  it('explains RTO and RPO in plain words, not just the acronyms', () => {
    const { objectives } = payloadWith({}).continuity;
    expect(objectives.map((o) => o.code)).toEqual(['RTO', 'RPO']);
    for (const o of objectives) expect(o.plain.length).toBeGreaterThan(30);
  });
});

describe('why Aeygis', () => {
  it('carries both rows of approved copy', () => {
    const { whyAeygis } = payloadWith({});
    expect(whyAeygis.differentiators.map((d) => d.title)).toEqual([
      'Local, in person',
      'Healthcare focus',
      'Documented, not promised',
      'One team, one number',
    ]);
    expect(whyAeygis.expectations.map((e) => e.title)).toEqual([
      'Clear scope',
      'Plain language',
      'Evidence',
      'Ongoing ownership',
    ]);
  });

  it('positions against the category without naming anyone', () => {
    // Deliberate: the client-safety guard rejects "competitor" in visible copy,
    // and naming a rival in a document a clinic may forward is its own risk.
    const { whyAeygis } = payloadWith({});
    expect(whyAeygis.positioning).toContain('National cloud providers sell infrastructure');
    expect(JSON.stringify(whyAeygis).toLowerCase()).not.toContain('competitor');
  });
});

describe('acceptance page', () => {
  it('states that it is intent to proceed, NOT the service agreement', () => {
    // The confirmed decision. A signature page carrying prices and no statement
    // of effect can be argued to be the contract itself.
    const { acceptance } = payloadWith({});
    expect(acceptance.statement).toMatch(/authorises Aeygis to issue the formal statement of work/i);
    expect(acceptance.notAgreementNote).toMatch(/not the service agreement/i);
    expect(acceptance.notAgreementNote).toMatch(/does not itself create a payment obligation/i);
    expect(acceptance.notAgreementNote).toMatch(/statement of work, which is the binding document/i);
  });

  it('signs for the registered entity, not the brand', () => {
    expect(payloadWith({}).acceptance.signatoryEntity).toBe('Aeygis Technologies Inc.');
    // The document body still carries the client-facing brand. Both are
    // deliberate; if they should ever match, change them together.
    expect(payloadWith({}).preparedBy).toBe('Aeygis Health');
  });

  it('carries a real expiry date, and the validity note names it too', () => {
    const p = payloadWith({ validUntil: '16 September 2026' });
    expect(p.acceptance.validUntil).toBe('16 September 2026');
    // The note must not fall back to a relative phrase the reader has to compute.
    expect(p.validityNote).toContain('16 September 2026');
    expect(p.validityNote).not.toMatch(/30 days/);
  });

  it('carries NO content fingerprint — that would be circular', () => {
    // contentSha256 is computed OVER this payload, so it cannot live inside it.
    // The proposal reference names one immutable version, which is what
    // identifies the signed document.
    const json = JSON.stringify(payloadWith({}));
    expect(json).not.toMatch(/sha256|fingerprint/i);
    expect(payloadWith({}).proposalReference).toMatch(/-v\d{4}$/);
  });

  it('offers every applicable plan for selection, including the Micro three', () => {
    // Three plans is the worst case for this page's layout, and it is real:
    // a Micro engagement offers Train & Walk Away as well.
    const micro = toClientPayload(quote({ providers: 1, locations: 1 }), 'micro', {
      ...BASE_CONTEXT,
      recommendedPlan: 'essentials',
    });
    expect(micro.plans).toHaveLength(3);
    expect(micro.plans.map((p) => p.planLabel)).toContain('Train & Walk Away');
    expect(micro.plans.filter((p) => p.isRecommended)).toHaveLength(1);
  });
});

describe('discovery-answers section', () => {
  it('includes all 20 questions across all 5 groups, in order, even with no answers recorded', () => {
    const { discoveryAnswers } = payloadWith({ discoveryAnswers: null });
    expect(discoveryAnswers).toHaveLength(DISCOVERY_GROUPS.length);
    expect(discoveryAnswers.map((g) => g.title)).toEqual(DISCOVERY_GROUPS.map((g) => g.title));

    const flat = discoveryAnswers.flatMap((g) => g.entries);
    expect(flat).toHaveLength(20);
    expect(flat.map((e) => e.number)).toEqual(ALL_DISCOVERY_QUESTIONS.map((q) => q.number));
    expect(flat.map((e) => e.question)).toEqual(ALL_DISCOVERY_QUESTIONS.map((q) => q.question));
  });

  it('every question is present even when unanswered — null, not skipped', () => {
    // The explicitly-chosen option: "including blanks", not "answered only".
    const { discoveryAnswers } = payloadWith({ discoveryAnswers: null });
    const flat = discoveryAnswers.flatMap((g) => g.entries);
    expect(flat.every((e) => e.answer === null)).toBe(true);
  });

  it('renders a real answer verbatim when present, trimmed of surrounding whitespace', () => {
    const { discoveryAnswers } = payloadWith({
      discoveryAnswers: JSON.stringify({ q01: '  EMR, PACS, billing.  ' }),
    });
    const q1 = discoveryAnswers.flatMap((g) => g.entries).find((e) => e.number === 1);
    expect(q1?.answer).toBe('EMR, PACS, billing.');
  });

  it('a blank/whitespace-only answer is treated the same as unanswered', () => {
    const { discoveryAnswers } = payloadWith({
      discoveryAnswers: JSON.stringify({ q01: '   ' }),
    });
    const q1 = discoveryAnswers.flatMap((g) => g.entries).find((e) => e.number === 1);
    expect(q1?.answer).toBeNull();
  });

  it('truncates an answer over the cap, visibly, rather than passing it through untouched', () => {
    const long = 'x'.repeat(MAX_DISCOVERY_ANSWER_LENGTH + 200);
    const { discoveryAnswers } = payloadWith({
      discoveryAnswers: JSON.stringify({ q01: long }),
    });
    const q1 = discoveryAnswers.flatMap((g) => g.entries).find((e) => e.number === 1);
    expect(q1?.answer).not.toBeNull();
    expect(q1?.answer?.length).toBeLessThan(long.length);
    expect(q1?.answer).toContain('truncated');
  });

  it('leaves an answer at or under the cap completely untouched', () => {
    const exact = 'y'.repeat(MAX_DISCOVERY_ANSWER_LENGTH);
    const { discoveryAnswers } = payloadWith({
      discoveryAnswers: JSON.stringify({ q01: exact }),
    });
    const q1 = discoveryAnswers.flatMap((g) => g.entries).find((e) => e.number === 1);
    expect(q1?.answer).toBe(exact);
  });

  it('tolerates malformed JSON without throwing — degrades to "no answers recorded"', () => {
    const { discoveryAnswers } = payloadWith({ discoveryAnswers: '{not valid json' });
    expect(discoveryAnswers.flatMap((g) => g.entries).every((e) => e.answer === null)).toBe(true);
  });

  it('tolerates an already-parsed object (not a JSON string), matching the field\'s actual a.json() shape', () => {
    const { discoveryAnswers } = payloadWith({ discoveryAnswers: { q02: 'AWS' } });
    const q2 = discoveryAnswers.flatMap((g) => g.entries).find((e) => e.number === 2);
    expect(q2?.answer).toBe('AWS');
  });

  it('carries this assessment\'s custom questions through to the client payload', () => {
    const { discoveryAnswers } = payloadWith({
      customDiscoveryQuestions: JSON.stringify({
        categories: [{ id: 'cc-1', title: 'Imaging & PACS' }],
        questions: [
          { id: 'cq-1', categoryId: 'scope', question: 'Extra scope question?' },
          { id: 'cq-2', categoryId: 'cc-1', question: 'Which modalities?' },
        ],
      }),
      discoveryAnswers: JSON.stringify({ 'cq-2': 'Kodak CR, two modalities.' }),
    });

    // The new category renders as its own group, after the standard five.
    const last = discoveryAnswers[discoveryAnswers.length - 1];
    expect(last?.title).toBe('Imaging & PACS');
    expect(last?.entries[0]).toEqual({
      number: 22,
      question: 'Which modalities?',
      answer: 'Kodak CR, two modalities.',
    });

    // The in-category extra lands in the standard group, and the approved 20
    // keep their numbers.
    const scope = discoveryAnswers[0];
    expect(scope?.entries).toHaveLength(4);
    expect(scope?.entries.slice(0, 3).map((e) => e.number)).toEqual([1, 2, 3]);
    expect(scope?.entries[3]).toMatchObject({ number: 21, answer: null });
  });

  it('an unanswered custom question still renders, exactly like an unanswered standard one', () => {
    const { discoveryAnswers } = payloadWith({
      customDiscoveryQuestions: JSON.stringify({
        categories: [{ id: 'cc-1', title: 'Imaging' }],
        questions: [{ id: 'cq-1', categoryId: 'cc-1', question: 'Which modalities?' }],
      }),
    });
    const last = discoveryAnswers[discoveryAnswers.length - 1];
    expect(last?.entries[0]).toMatchObject({ question: 'Which modalities?', answer: null });
  });

  it('falls back to the approved 20 when the custom schema is unusable', () => {
    const { discoveryAnswers } = payloadWith({ customDiscoveryQuestions: '{corrupt' });
    expect(discoveryAnswers.flatMap((g) => g.entries)).toHaveLength(20);
  });

  it('a custom question cannot hijack an approved question\'s answer slot', () => {
    // End-to-end proof of the domain-level collision guard: a custom question
    // calling itself q01 must not steal or overwrite question 1's answer.
    const { discoveryAnswers } = payloadWith({
      customDiscoveryQuestions: JSON.stringify({
        categories: [],
        questions: [{ id: 'q01', categoryId: 'scope', question: 'Impostor' }],
      }),
      discoveryAnswers: JSON.stringify({ q01: 'The real answer to question one.' }),
    });
    const flat = discoveryAnswers.flatMap((g) => g.entries);
    expect(flat).toHaveLength(20);
    expect(flat.find((e) => e.number === 1)?.answer).toBe('The real answer to question one.');
    expect(flat.some((e) => e.question === 'Impostor')).toBe(false);
  });

  it('one answered question does not affect any other question\'s null/verbatim state', () => {
    const { discoveryAnswers } = payloadWith({
      discoveryAnswers: JSON.stringify({ q10: 'REST APIs to the lab vendor.' }),
    });
    const flat = discoveryAnswers.flatMap((g) => g.entries);
    expect(flat.find((e) => e.number === 10)?.answer).toBe('REST APIs to the lab vendor.');
    expect(flat.filter((e) => e.number !== 10).every((e) => e.answer === null)).toBe(true);
  });
});
