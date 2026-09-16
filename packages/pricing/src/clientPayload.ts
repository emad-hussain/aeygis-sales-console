import {
  ACCEPTANCE_NOT_AGREEMENT_NOTE,
  ACCEPTANCE_SIGNATORY_ENTITY,
  ACCEPTANCE_STATEMENT,
  CITATIONS,
  CO_EXISTENCE,
  HOSTING_MODELS,
  IMPACT_ATTRIBUTION,
  MEASURED_IMPACT,
  RECOVERY_DISCLAIMER,
  RECOVERY_OBJECTIVES,
  REGULATORY_NOTE,
  REGULATORY_POINTS,
  RESILIENCE_CYCLE,
  SECURITY_CONTROLS,
  SECURITY_NOTE,
  SECURITY_SPECIFICS,
  SERVICE_LEVELS,
  SERVICE_LEVEL_NOTE,
  WHY_AEYGIS_DIFFERENTIATORS,
  WHY_AEYGIS_EXPECTATIONS,
  WHY_AEYGIS_POSITIONING,
  POSTURE_ANSWERS,
  RISK_ASSESSMENT_AGES,
  SCHEDULE_PHASE_IDS,
  SCHEDULE_PHASE_LABELS,
  discoveryGroupsForAssessment,
  effectiveResponsibilityRows,
  estimateCurrentAnnualSpend,
  isOneOf,
  parseDiscoveryAnswers,
  parseMigrationSchedule,
  parseResponsibilityCustomisation,
  tracksForHosting,
  type HostingModel,
  type PostureAnswer,
  type RiskAssessmentAge,
} from '@aeygis/domain';
import {
  CLIENT_PAYS_SEPARATELY,
  SUPPORT_PLAN_LABELS,
  TIER_LABELS,
  type SupportPlan,
  type Tier,
} from './catalog.js';
import type { PlanQuote, QuoteResult, TierQuote } from './quote.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BARRIER 2 of 5 — the type boundary.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ClientProposalPayload` is the ONLY thing the PDF renderer ever receives.
 *
 * It is a CLOSED interface: every field is listed explicitly, there is no index
 * signature, and no `Record<string, unknown>` anywhere in it. That matters
 * because it means a field cannot arrive here by being spread in from a wider
 * object — the compiler rejects unknown properties.
 *
 * `toClientPayload()` is a hand-written whitelist mapper. It NEVER spreads
 * (`{...quote}`), because a spread is exactly how an internal field silently
 * becomes client-facing the day someone widens the source type.
 *
 * If you find yourself wanting to add a field here, ask whether a prospect
 * should read it. Cost, margin, competitor comparisons and discount floors must
 * never appear.
 */

export interface ClientMoney {
  readonly amount: number;
  readonly currency: string;
  /** Pre-formatted for display, so the renderer does no locale maths. */
  readonly display: string;
}

export interface ClientPlanLine {
  readonly planLabel: string;
  readonly monthly: ClientMoney;
  readonly annualCheckup: ClientMoney | null;
  readonly firstYearTotal: ClientMoney;
  readonly isRecommended: boolean;
  readonly customQuote: boolean;
}

/**
 * The prospect's own description of their current environment, as answered on
 * the public intake form — not staff commentary, not the 20-question technical
 * discovery. Every field is either a translated display label or null: a raw
 * code the prospect never answered (or a value outside the known set) maps to
 * null and is simply left out of the rendered section, never guessed at.
 */
export interface ClientCurrentState {
  readonly hosting: string | null;
  readonly mfa: string | null;
  readonly backups: string | null;
  readonly incidentPlan: string | null;
  readonly lastRiskAssessment: string | null;
}

/**
 * One of the 20 approved technical discovery questions, with the answer
 * staff recorded for THIS assessment — or null if it was left blank.
 *
 * `answer` is truncated (see `truncateAnswer`) rather than shown in full when
 * it exceeds a safe on-page length. It is NEVER edited, softened, or
 * curated otherwise: what staff wrote is what the client sees, verbatim,
 * including a blank one rendering as unanswered rather than being skipped.
 * That is a deliberate, explicit choice — the alternative (only showing
 * answered questions) was available and was not the one chosen.
 */
export interface ClientDiscoveryEntry {
  readonly number: number;
  readonly question: string;
  readonly answer: string | null;
}

export interface ClientDiscoveryGroup {
  readonly title: string;
  readonly entries: readonly ClientDiscoveryEntry[];
}

/**
 * The clinic's own current spending, set against the plan being recommended.
 *
 * PRESENT ONLY WHEN IT FAVOURS THE PROPOSAL — a confirmed instruction, not an
 * oversight: if the recommended plan's first-year total is not below what the
 * clinic already spends, this is null and the section does not render.
 *
 * `coversOnly` names which components the client actually supplied, so the
 * document can say what the figure includes rather than implying it is
 * complete. Missing components count as zero, which understates their current
 * spend — the direction that can only make this LESS flattering, never more.
 */
export interface ClientSpendComparison {
  readonly annualIt: ClientMoney | null;
  readonly annualHardware: ClientMoney | null;
  readonly downtimeHours: number | null;
  readonly spendPerDowntimeHour: ClientMoney | null;
  readonly annualDowntime: ClientMoney | null;
  readonly annualTotal: ClientMoney;
  readonly comparedPlanLabel: string;
  readonly proposedFirstYear: ClientMoney;
  readonly difference: ClientMoney;
  readonly coversOnly: readonly string[];
}

export interface ClientResponsibilityRow {
  readonly area: string;
  readonly aeygis: string;
  readonly clinic: string;
}

export interface ClientSchedulePhase {
  readonly name: string;
  readonly estimate: string;
}

export interface ClientMigrationSchedule {
  readonly phases: readonly ClientSchedulePhase[];
  readonly note: string | null;
}

export interface ClientMigrationTrack {
  readonly name: string;
  readonly focus: string;
  readonly methodology: string;
  readonly entryInfrastructure: string;
  readonly targetArchitecture: string;
}

export interface ClientCoExistence {
  readonly localProvider: readonly string[];
  readonly aeygis: readonly string[];
  readonly positioning: string;
}

/** A figure with its own label — never a bare number. */
export interface ClientFigure {
  readonly figure: string;
  readonly label: string;
  readonly detail: string;
}

/**
 * Uptime, ALWAYS carrying whose commitment it is.
 *
 * The AWS figure and the Aeygis figure measure different layers and differ by
 * roughly a factor of ten in permitted downtime. Presenting either as a bare
 * percentage would let a clinic plan around the wrong one, which is why every
 * field here is required and none of them is just the number.
 */
export interface ClientServiceLevel {
  readonly figure: string;
  readonly layer: string;
  readonly whoseCommitment: string;
  readonly scope: string;
  readonly allowedDowntime: string;
}

export interface ClientCitation {
  readonly claim: string;
  readonly source: string;
}

export interface ClientProposalPayload {
  readonly documentTitle: string;
  readonly preparedFor: string;
  readonly preparedForContact: string | null;
  readonly preparedBy: string;
  readonly proposalReference: string;
  readonly issuedOn: string;
  readonly validityNote: string;

  readonly tierLabel: string;
  readonly tierSummary: string;
  readonly providerCount: number;
  readonly locationCount: number;

  readonly setupTotal: ClientMoney;
  readonly setupBreakdown: readonly string[];
  readonly plans: readonly ClientPlanLine[];

  readonly currentState: ClientCurrentState;
  readonly spendComparison: ClientSpendComparison | null;
  readonly migrationTracks: readonly ClientMigrationTrack[];
  readonly schedule: ClientMigrationSchedule | null;
  readonly responsibilities: readonly ClientResponsibilityRow[];
  readonly coExistence: ClientCoExistence;

  readonly impact: {
    readonly figures: readonly ClientFigure[];
    readonly attribution: string;
  };
  readonly regulatory: {
    readonly points: readonly ClientFigure[];
    readonly note: string;
  };
  readonly security: {
    readonly controls: readonly { readonly title: string; readonly detail: string }[];
    readonly specifics: readonly string[];
    readonly note: string;
  };
  readonly continuity: {
    readonly objectives: readonly {
      readonly code: string;
      readonly name: string;
      readonly plain: string;
    }[];
    readonly cycle: readonly { readonly step: string; readonly detail: string }[];
    readonly serviceLevels: readonly ClientServiceLevel[];
    readonly serviceLevelNote: string;
    readonly disclaimer: string;
  };
  readonly whyAeygis: {
    readonly positioning: string;
    readonly differentiators: readonly { readonly title: string; readonly detail: string }[];
    readonly expectations: readonly { readonly title: string; readonly detail: string }[];
  };

  readonly citations: readonly ClientCitation[];

  /**
   * The signature page. Carries no fingerprint by design: `contentSha256` is
   * computed OVER this payload, so embedding it here would be circular. The
   * proposal reference already names one immutable version, which is what
   * identifies the signed document.
   */
  readonly acceptance: {
    readonly statement: string;
    readonly notAgreementNote: string;
    readonly signatoryEntity: string;
    readonly validUntil: string;
  };

  readonly discoveryAnswers: readonly ClientDiscoveryGroup[];

  readonly clientPaysSeparately: readonly string[];
  readonly phases: readonly { readonly name: string; readonly objective: string; readonly deliverables: string }[];
  readonly disclaimers: readonly string[];
}

const fmt = (amount: number, currency: string): ClientMoney => ({
  amount,
  currency,
  display:
    currency === 'CAD'
      ? '$' + amount.toLocaleString('en-CA', { maximumFractionDigits: 0 })
      : `${amount.toLocaleString('en-CA', { maximumFractionDigits: 0 })} ${currency}`,
});

/**
 * The five migration phases, from Framework §3. Fixed client-facing copy, kept
 * here so the renderer holds no business content of its own.
 */
const PHASES = [
  { name: '1. Discover (Assess)', objective: 'Inventory and risk audit', deliverables: 'Asset matrix, PHI flow map, risk audit report' },
  { name: '2. Plan (Design)', objective: 'Target design and statement of work', deliverables: 'Architecture blueprint, formal SOW, RTO/RPO blueprint' },
  { name: '3. Migrate (Move)', objective: 'Zero-downtime move', deliverables: 'Validated AWS environment, cutover sign-off, hypercare' },
  { name: '4. Optimize (Tune)', objective: 'Speed and cost tuning', deliverables: 'Performance summary, Well-Architected audit, PHIPA evidence' },
  { name: '5. Support (Operate)', objective: '24/7 managed operations', deliverables: 'Support portal, monthly status reports, annual review' },
] as const;

/**
 * Verbatim from the approved documents. These are legal caveats and must not be
 * softened or omitted — the Framework and Overview both carry them.
 */
const DISCLAIMERS = [
  'Aeygis Cloud is described as PHIPA-aligned. This proposal does not constitute legal advice and does not guarantee compliance with PHIPA or any other privacy, professional, or regulatory obligation. Each clinic remains responsible for its own policies, staff training, patient consent processes, and legal duties.',
  'Recovery targets (RTO/RPO) are agreed during discovery and designed into the solution based on the selected architecture and data volume. They are not universal guarantees.',
  'Final scope depends on applications, integrations, data volumes, current infrastructure, clinic priorities, and agreed service levels.',
] as const;

/**
 * Display labels for the current-state raw codes, matching the live intake
 * form's own option text so the proposal never disagrees with what the
 * prospect saw on screen.
 */
const HOSTING_LABELS: Readonly<Record<HostingModel, string>> = {
  onprem: 'On-premises infrastructure',
  cloud: 'Already cloud-hosted',
  mixed: 'Mixed / hybrid environment',
};

const POSTURE_LABELS: Readonly<Record<PostureAnswer, string>> = {
  yes: 'Yes',
  no: 'No',
  unsure: 'Not sure',
};

const RISK_ASSESSMENT_AGE_LABELS: Readonly<Record<RiskAssessmentAge, string>> = {
  '1yr': 'Within the last year',
  '1-2yr': '1–2 years ago',
  never: 'Never',
  unsure: 'Not sure',
};

/**
 * Translates a raw stored code to its display label, or null if the prospect
 * never answered (or the stored value is outside the known set). Never
 * invents a label for an unrecognized code.
 */
function currentStateLabel<T extends readonly string[]>(
  allowed: T,
  labels: Readonly<Record<T[number], string>>,
  raw: string | null | undefined,
): string | null {
  return isOneOf(allowed, raw) ? labels[raw] : null;
}

/**
 * Hard cap on a single discovery answer's length in the client document.
 *
 * Discovery answers are staff-written free text with no length limit in the
 * console, but the proposal's interior pages are a fixed physical size
 * (matching the deck this document is modelled on) with no automatic
 * pagination — an answer that ran on indefinitely would silently overflow
 * past the bottom of the page and be clipped, which is worse than a visible
 * truncation because a clipped answer looks intentional, not cut off.
 * Chosen generously (roughly two short paragraphs); verified empirically
 * against the rendered PDF with a deliberately long stress-test answer.
 */
export const MAX_DISCOVERY_ANSWER_LENGTH = 420;

function truncateAnswer(raw: string): string {
  if (raw.length <= MAX_DISCOVERY_ANSWER_LENGTH) return raw;
  return raw.slice(0, MAX_DISCOVERY_ANSWER_LENGTH).trimEnd() + '… (truncated — full answer on file)';
}

export interface PayloadContext {
  readonly clinicName: string | null;
  readonly contactName: string | null;
  readonly proposalReference: string;
  readonly issuedOn: string;
  /**
   * Formatted from the SAME Date instance as `issuedOn` (see
   * `validUntilDate`). Passed in rather than derived here, because `issuedOn`
   * is a localised display string and parsing a date back out of it to add 30
   * days would be exactly the kind of fragility that produces an off-by-one
   * on a contractual date.
   */
  readonly validUntil: string;
  readonly providerCount: number;
  readonly locationCount: number;
  /** Which plan to mark as recommended. */
  readonly recommendedPlan: SupportPlan | null;

  /**
   * Raw current-state codes as stored on Assessment (e.g. 'onprem', 'yes',
   * '1-2yr'). Translated to display labels inside toClientPayload — callers
   * pass the stored value straight through, unmodified.
   */
  readonly hosting: string | null;
  readonly mfa: string | null;
  readonly backups: string | null;
  readonly incidentPlan: string | null;
  readonly lastRiskAssessment: string | null;

  /**
   * `Assessment.discoveryAnswers` exactly as stored — an `a.json()` field,
   * which arrives as a JSON string in some paths and an already-parsed
   * object in others (the console's own code has always had to tolerate
   * both; see `parseDiscoveryAnswers`). Passed through untouched; parsed
   * defensively inside toClientPayload so a malformed value degrades to
   * "no answers recorded" rather than failing proposal generation outright.
   */
  readonly discoveryAnswers: unknown;

  /**
   * `Assessment.customDiscoveryQuestions` exactly as stored — this clinic's
   * own extra questions and categories, if any. Same defensive parsing as
   * above; a malformed value degrades to "the standard 20 only" rather than
   * failing generation.
   */
  readonly customDiscoveryQuestions: unknown;

  /** Raw spend figures as the client entered them on the public form. */
  readonly monthlyItSpend: number | null;
  readonly annualHardwareEmergency: number | null;
  readonly downtimeHoursBand: string | null;
  readonly downtimeCostBand: string | null;

  /** Staff-entered, stored as JSON on Assessment. Parsed defensively here. */
  readonly migrationSchedule: unknown;
  readonly responsibilityMatrix: unknown;
}

/**
 * Builds the client-facing payload from a chosen tier option.
 *
 * Throws on the Enterprise refusal branch rather than inventing figures — an
 * Enterprise proposal must be written by a human after a discovery call.
 */
export function toClientPayload(
  result: QuoteResult,
  chosenTier: Tier,
  context: PayloadContext,
): ClientProposalPayload {
  if (result.kind !== 'quote') {
    throw new Error(
      'Cannot build a client payload for an Enterprise engagement: it requires a discovery call and a human-authored proposal.',
    );
  }

  const option: TierQuote | undefined = result.options.find((o) => o.tier === chosenTier);
  if (option === undefined) {
    throw new Error(`Tier "${chosenTier}" is not among the quoted options`);
  }

  const currency = option.setup.quotedTotal.currency;
  const parsedDiscoveryAnswers = parseDiscoveryAnswers(context.discoveryAnswers);
  // The approved 20 PLUS this clinic's own additions. Same merge the console
  // renders from, so what staff filled in and what the client reads cannot
  // disagree about which questions exist or how they are numbered.
  const discoveryGroups = discoveryGroupsForAssessment(context.customDiscoveryQuestions);

  const setupBreakdown: string[] = [`Base ${fmt(option.setup.base.amount, currency).display}`];
  if (option.setup.extraProviders.count > 0) {
    setupBreakdown.push(
      `${option.setup.extraProviders.count} additional provider(s) at ${fmt(option.setup.extraProviders.unit.amount, currency).display} each`,
    );
  }
  if (option.setup.extraLocations.count > 0) {
    setupBreakdown.push(
      `${option.setup.extraLocations.count} additional location(s) at ${fmt(option.setup.extraLocations.unit.amount, currency).display} each`,
    );
  }

  // Explicit field-by-field mapping. Never a spread.
  const plans: ClientPlanLine[] = option.plans.map(
    (p: PlanQuote): ClientPlanLine => ({
      planLabel: p.planLabel,
      monthly: fmt(p.monthlyQuotedTotal.amount, currency),
      annualCheckup: p.annualCheckup.amount > 0 ? fmt(p.annualCheckup.amount, currency) : null,
      firstYearTotal: fmt(p.firstYearQuotedTotal.amount, currency),
      isRecommended: context.recommendedPlan === p.plan,
      customQuote: p.customQuote,
    }),
  );

  /**
   * The spend comparison, or null.
   *
   * Compared against the RECOMMENDED plan — that is the one being pitched, so
   * it is the one the client will weigh. With no recommendation, the lowest
   * first-year total is used, which is the most favourable and therefore the
   * one most likely to clear the bar below.
   *
   * Then: rendered ONLY if it favours the proposal. Confirmed instruction.
   */
  const spendComparison = ((): ClientSpendComparison | null => {
    const estimate = estimateCurrentAnnualSpend({
      monthlyItSpend: context.monthlyItSpend,
      annualHardwareEmergency: context.annualHardwareEmergency,
      downtimeHoursBand: context.downtimeHoursBand,
      downtimeCostBand: context.downtimeCostBand,
    });
    if (estimate === null) return null;

    const recommended = plans.find((p) => p.isRecommended);
    const cheapest = [...plans].sort(
      (a, b) => a.firstYearTotal.amount - b.firstYearTotal.amount,
    )[0];
    const compared = recommended ?? cheapest;
    if (compared === undefined) return null;

    // The gate. Equal is not "favours" — it has to actually be lower.
    if (compared.firstYearTotal.amount >= estimate.annualTotal) return null;

    const coversOnly: string[] = [];
    if (estimate.hasIt) coversOnly.push('reported monthly IT spend');
    if (estimate.hasHardware) coversOnly.push('emergency hardware in the last year');
    if (estimate.hasDowntime) coversOnly.push('estimated downtime hours and their hourly value');

    return {
      annualIt: estimate.hasIt ? fmt(estimate.annualIt, currency) : null,
      annualHardware: estimate.hasHardware ? fmt(estimate.annualHardware, currency) : null,
      downtimeHours: estimate.hasDowntime ? estimate.downtimeHours : null,
      spendPerDowntimeHour: estimate.hasDowntime
        ? fmt(estimate.spendPerDowntimeHour, currency)
        : null,
      annualDowntime: estimate.hasDowntime ? fmt(estimate.annualDowntime, currency) : null,
      annualTotal: fmt(estimate.annualTotal, currency),
      comparedPlanLabel: compared.planLabel,
      proposedFirstYear: compared.firstYearTotal,
      difference: fmt(estimate.annualTotal - compared.firstYearTotal.amount, currency),
      coversOnly,
    };
  })();

  const schedule = ((): ClientMigrationSchedule | null => {
    const parsed = parseMigrationSchedule(context.migrationSchedule);
    // A phase with no estimate is omitted rather than shown blank — an empty
    // row beside filled ones reads as an oversight, not as "not yet scoped".
    const phases = SCHEDULE_PHASE_IDS.flatMap((id) => {
      const estimate = parsed.estimates[id];
      return estimate === undefined
        ? []
        : [{ name: SCHEDULE_PHASE_LABELS[id], estimate }];
    });
    if (phases.length === 0) return null;
    return { phases, note: parsed.note };
  })();

  return {
    documentTitle: 'Cloud Migration Proposal',
    preparedFor: context.clinicName ?? 'Your clinic',
    preparedForContact: context.contactName,
    // Confirmed with the user: Aeygis Health signs client-facing proposals,
    // not "Aeygis Technologies Inc.".
    preparedBy: 'Aeygis Health',
    proposalReference: context.proposalReference,
    issuedOn: context.issuedOn,
    // An actual date, not "30 days from the issue date". A relative phrase
    // makes the reader do arithmetic against a date printed elsewhere, and is
    // far easier to let slide past.
    validityNote:
      `Pricing in this proposal is held until ${context.validUntil}. Scope changes are agreed in writing before work begins; base prices are not altered after the fact.`,

    tierLabel: TIER_LABELS[chosenTier],
    tierSummary:
      `${TIER_LABELS[chosenTier]} engagement — ${context.providerCount} ` +
      `provider${context.providerCount === 1 ? '' : 's'} across ${context.locationCount} ` +
      `location${context.locationCount === 1 ? '' : 's'}`,
    providerCount: context.providerCount,
    locationCount: context.locationCount,

    setupTotal: fmt(option.setup.quotedTotal.amount, currency),
    setupBreakdown,
    plans,

    currentState: {
      hosting: currentStateLabel(HOSTING_MODELS, HOSTING_LABELS, context.hosting),
      mfa: currentStateLabel(POSTURE_ANSWERS, POSTURE_LABELS, context.mfa),
      backups: currentStateLabel(POSTURE_ANSWERS, POSTURE_LABELS, context.backups),
      incidentPlan: currentStateLabel(POSTURE_ANSWERS, POSTURE_LABELS, context.incidentPlan),
      lastRiskAssessment: currentStateLabel(
        RISK_ASSESSMENT_AGES,
        RISK_ASSESSMENT_AGE_LABELS,
        context.lastRiskAssessment,
      ),
    },
    spendComparison,
    // Derived from what the prospect already told us about their hosting, so
    // the proposal names the engagement they are actually buying.
    migrationTracks: tracksForHosting(context.hosting).map((t) => ({
      name: t.name,
      focus: t.focus,
      methodology: t.methodology,
      entryInfrastructure: t.entryInfrastructure,
      targetArchitecture: t.targetArchitecture,
    })),
    schedule,
    responsibilities: effectiveResponsibilityRows(
      parseResponsibilityCustomisation(context.responsibilityMatrix),
    ).map((r) => ({ area: r.area, aeygis: r.aeygis, clinic: r.clinic })),
    coExistence: {
      localProvider: [...CO_EXISTENCE.localProvider],
      aeygis: [...CO_EXISTENCE.aeygis],
      positioning: CO_EXISTENCE.positioning,
    },
    // Approved, third-party-sourced copy. Mapped field by field like everything
    // else — never spread — and every statistic here has a matching row in
    // `citations` below.
    impact: {
      figures: MEASURED_IMPACT.map((f) => ({
        figure: f.figure,
        label: f.label,
        detail: f.detail,
      })),
      attribution: IMPACT_ATTRIBUTION,
    },
    regulatory: {
      points: REGULATORY_POINTS.map((p) => ({
        figure: p.figure,
        label: p.label,
        detail: p.detail,
      })),
      note: REGULATORY_NOTE,
    },
    security: {
      controls: SECURITY_CONTROLS.map((c) => ({ title: c.title, detail: c.detail })),
      specifics: [...SECURITY_SPECIFICS],
      note: SECURITY_NOTE,
    },
    continuity: {
      objectives: RECOVERY_OBJECTIVES.map((o) => ({
        code: o.code,
        name: o.name,
        plain: o.plain,
      })),
      cycle: RESILIENCE_CYCLE.map((c) => ({ step: c.step, detail: c.detail })),
      // Both figures, each naming whose commitment it is. Never a bare number.
      serviceLevels: SERVICE_LEVELS.map((s) => ({
        figure: s.figure,
        layer: s.layer,
        whoseCommitment: s.whoseCommitment,
        scope: s.scope,
        allowedDowntime: s.allowedDowntime,
      })),
      serviceLevelNote: SERVICE_LEVEL_NOTE,
      disclaimer: RECOVERY_DISCLAIMER,
    },
    whyAeygis: {
      positioning: WHY_AEYGIS_POSITIONING,
      differentiators: WHY_AEYGIS_DIFFERENTIATORS.map((d) => ({
        title: d.title,
        detail: d.detail,
      })),
      expectations: WHY_AEYGIS_EXPECTATIONS.map((e) => ({ title: e.title, detail: e.detail })),
    },
    citations: CITATIONS.map((c) => ({ claim: c.claim, source: c.source })),
    acceptance: {
      statement: ACCEPTANCE_STATEMENT,
      notAgreementNote: ACCEPTANCE_NOT_AGREEMENT_NOTE,
      signatoryEntity: ACCEPTANCE_SIGNATORY_ENTITY,
      validUntil: context.validUntil,
    },
    // Every question in force for this assessment, in order, every time —
    // including the ones left blank. Not filtered to "answered only": that was
    // a real option and was explicitly not the one chosen.
    discoveryAnswers: discoveryGroups.map((group) => ({
      title: group.title,
      entries: group.questions.map((q): ClientDiscoveryEntry => {
        const raw = (parsedDiscoveryAnswers[q.id] ?? '').trim();
        return { number: q.number, question: q.question, answer: raw ? truncateAnswer(raw) : null };
      }),
    })),

    clientPaysSeparately: [...CLIENT_PAYS_SEPARATELY],
    phases: PHASES.map((p) => ({ name: p.name, objective: p.objective, deliverables: p.deliverables })),
    disclaimers: [...DISCLAIMERS],
  };
}

/** Support-plan label lookup, exported for the console's recommendation UI. */
export function supportPlanLabel(plan: SupportPlan): string {
  return SUPPORT_PLAN_LABELS[plan];
}
