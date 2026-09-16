/**
 * Client-facing proposal content that is APPROVED COPY, plus the per-assessment
 * customisation staff can apply to it.
 *
 * Everything verbatim in this file comes from
 * `Aeygis_Cloud_Migration_Framework.pdf` (AEYGIS-MIG-FRAMEWORK-V3). It is not
 * paraphrased, because these are approved statements about legal responsibility
 * and delivery methodology — rewording them here would silently fork them from
 * the document the client may also have been sent.
 *
 * Lives in @aeygis/domain so the console and the PDF renderer read the SAME
 * definitions. Two copies would be two places to drift apart.
 */

import { isOneOf, type HostingModel } from './assessment.js';

/* ════════════════════ shared responsibility matrix ════════════════════ */

export interface ResponsibilityRow {
  readonly id: string;
  readonly area: string;
  readonly aeygis: string;
  readonly clinic: string;
}

/**
 * Framework §4, "Aeygis vs. Clinic Responsibility Matrix" — all seven rows,
 * verbatim.
 *
 * Note how many rows put the CLINIC as owner. That is the point of showing it:
 * a client who never sees this assumes anything technical is Aeygis's problem,
 * and discovers otherwise during an incident.
 */
export const RESPONSIBILITY_ROWS: readonly ResponsibilityRow[] = [
  {
    id: 'r-infra',
    area: 'AWS Cloud Infrastructure',
    aeygis: 'Owner: VPC, EC2, RDS, Gateways, AWS Security',
    clinic: 'Consumer: Connects via approved secure endpoints',
  },
  {
    id: 'r-encryption',
    area: 'Data Encryption & KMS',
    aeygis: 'Owner: Key creation, rotation, encryption policies',
    clinic: 'Owner: Ensuring sensitive data is placed in encrypted stores',
  },
  {
    id: 'r-backups',
    area: 'Backups & Disaster Recovery',
    aeygis: 'Owner: Backup execution, cross-region sync, restore testing',
    clinic: 'Owner: Defining clinic business downtime tolerances',
  },
  {
    id: 'r-patching',
    area: 'System Security & Patching',
    aeygis: 'Owner: OS & cloud infrastructure patching, WAF rules',
    clinic: 'Owner: Antivirus/EDR on local clinic laptops/desktops',
  },
  {
    id: 'r-identity',
    area: 'Identity & Access Management',
    aeygis: 'Owner: Cloud IAM, VPN MFA, RBAC group structures',
    clinic: 'Owner: Staff onboarding, offboarding requests, role approvals',
  },
  {
    id: 'r-emr',
    area: 'EMR / PACS Application',
    aeygis: 'Support: Infrastructure hosting, database uptime',
    clinic: 'Owner: Application usage, charting, billing, vendor license',
  },
  {
    id: 'r-privacy',
    area: 'Privacy Governance',
    aeygis: 'Support: Technical safeguards & audit trail logs',
    clinic: 'Owner: Clinic privacy policies, patient consent, legal duties',
  },
];

const RESPONSIBILITY_ROW_IDS: ReadonlySet<string> = new Set(RESPONSIBILITY_ROWS.map((r) => r.id));

export const MAX_RESPONSIBILITY_TEXT_LENGTH = 160;
export const CUSTOM_RESPONSIBILITY_ID_PREFIX = 'rc-';

/**
 * Per-assessment tailoring of the matrix.
 *
 * `excludedIds` HIDES an approved row that does not apply (a clinic with no
 * imaging has no use for the EMR/PACS row). `added` appends clinic-specific
 * rows.
 *
 * DELIBERATELY NOT AN EDIT of the approved wording. Those seven rows state who
 * carries which legal duty; letting them be rewritten per customer is exactly
 * how one gets quietly weakened on the way to a signature. Hide it or add
 * beside it — do not rephrase it.
 */
export interface ResponsibilityCustomisation {
  readonly excludedIds: readonly string[];
  readonly added: readonly ResponsibilityRow[];
}

export const EMPTY_RESPONSIBILITY_CUSTOMISATION: ResponsibilityCustomisation = Object.freeze({
  excludedIds: Object.freeze([]) as readonly string[],
  added: Object.freeze([]) as readonly ResponsibilityRow[],
});

export function parseResponsibilityCustomisation(raw: unknown): ResponsibilityCustomisation {
  if (raw === null || raw === undefined) return EMPTY_RESPONSIBILITY_CUSTOMISATION;
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_RESPONSIBILITY_CUSTOMISATION;
  }
  const record = value as Record<string, unknown>;

  const excludedIds = Array.isArray(record['excludedIds'])
    ? [
        ...new Set(
          record['excludedIds'].filter(
            (id): id is string => typeof id === 'string' && RESPONSIBILITY_ROW_IDS.has(id),
          ),
        ),
      ]
    : [];

  const added: ResponsibilityRow[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record['added'])) {
    for (const entry of record['added']) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
      const id = str('id');
      const area = str('area');
      // A custom row must not reuse an approved row's id: the merge keys on id,
      // so a collision would silently replace an approved responsibility.
      if (id === '' || area === '' || seen.has(id) || RESPONSIBILITY_ROW_IDS.has(id)) continue;
      seen.add(id);
      added.push({
        id,
        area: area.slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
        aeygis: str('aeygis').slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
        clinic: str('clinic').slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
      });
    }
  }

  return { excludedIds, added };
}

/** The matrix actually in force for one assessment: approved rows kept, then additions. */
export function effectiveResponsibilityRows(
  custom: ResponsibilityCustomisation,
): readonly ResponsibilityRow[] {
  const excluded = new Set(custom.excludedIds);
  return [...RESPONSIBILITY_ROWS.filter((r) => !excluded.has(r.id)), ...custom.added];
}

/* ════════════════════════ migration schedule ════════════════════════ */

/** The five phases, keyed so an estimate can be stored against each. */
export const SCHEDULE_PHASE_IDS = ['discover', 'plan', 'migrate', 'optimize', 'support'] as const;
export type SchedulePhaseId = (typeof SCHEDULE_PHASE_IDS)[number];

export const SCHEDULE_PHASE_LABELS: Readonly<Record<SchedulePhaseId, string>> = {
  discover: 'Discover (Assess)',
  plan: 'Plan (Design)',
  migrate: 'Migrate (Move)',
  optimize: 'Optimize (Tune)',
  support: 'Support (Operate)',
};

export const MAX_SCHEDULE_ESTIMATE_LENGTH = 60;
export const MAX_SCHEDULE_NOTE_LENGTH = 400;

/**
 * Staff-entered timing estimates.
 *
 * FREE TEXT, not dates, and deliberately so: no source document states phase
 * durations, so the system must not imply a precision it does not have. Staff
 * write "2 weeks", "Weeks 3-5", or "After EMR vendor sign-off" as the
 * engagement actually warrants.
 *
 * A phase with no estimate is simply omitted from the schedule rather than
 * shown as blank — an empty row next to a filled one reads as an oversight.
 */
export interface MigrationSchedule {
  readonly estimates: Readonly<Partial<Record<SchedulePhaseId, string>>>;
  readonly note: string | null;
}

export const EMPTY_MIGRATION_SCHEDULE: MigrationSchedule = Object.freeze({
  estimates: Object.freeze({}),
  note: null,
});

export function parseMigrationSchedule(raw: unknown): MigrationSchedule {
  if (raw === null || raw === undefined) return EMPTY_MIGRATION_SCHEDULE;
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_MIGRATION_SCHEDULE;
  }
  const record = value as Record<string, unknown>;

  const estimates: Partial<Record<SchedulePhaseId, string>> = {};
  const rawEstimates = record['estimates'];
  if (typeof rawEstimates === 'object' && rawEstimates !== null && !Array.isArray(rawEstimates)) {
    for (const id of SCHEDULE_PHASE_IDS) {
      const v = (rawEstimates as Record<string, unknown>)[id];
      if (typeof v === 'string' && v.trim() !== '') {
        estimates[id] = v.trim().slice(0, MAX_SCHEDULE_ESTIMATE_LENGTH);
      }
    }
  }

  const rawNote = record['note'];
  const note =
    typeof rawNote === 'string' && rawNote.trim() !== ''
      ? rawNote.trim().slice(0, MAX_SCHEDULE_NOTE_LENGTH)
      : null;

  return { estimates, note };
}

/** True when there is anything worth rendering. */
export function hasSchedule(schedule: MigrationSchedule): boolean {
  return Object.keys(schedule.estimates).length > 0;
}

/* ═══════════════════════ migration track ═══════════════════════ */

export interface MigrationTrack {
  readonly name: string;
  readonly focus: string;
  readonly methodology: string;
  readonly entryInfrastructure: string;
  readonly targetArchitecture: string;
}

/** Framework §2, both tracks, verbatim. */
export const TRACK_A: MigrationTrack = {
  name: 'Track A — Legacy On-Premises to AWS Migration',
  focus:
    'Moving physical and virtual servers (Windows Server, Linux), SQL databases, local EMR stores, PACS imaging arrays, and digital fax servers into AWS.',
  methodology:
    'Lift-and-Shift (Rehost) via AWS Application Migration Service (MGN), or database replatforming to managed AWS RDS.',
  entryInfrastructure: 'Physical/virtual servers, local tape or NAS backups, direct EMR hardware',
  targetArchitecture: 'AWS ca-central-1, KMS AES-256 encryption, Multi-AZ backups',
};

export const TRACK_B: MigrationTrack = {
  name: 'Track B — Cloud-to-Cloud Migration & Managed Takeover',
  focus:
    'Auditing existing cloud accounts, fixing misconfigurations, establishing PHIPA compliance documentation, and transitioning environment ownership to Aeygis.',
  methodology:
    'AWS Well-Architected Framework review, IAM identity restructuring, security hardening, spend optimization, and transition to Aeygis Managed Operations.',
  entryInfrastructure: 'Unmanaged AWS, Azure, GCP, or legacy single-account setups',
  targetArchitecture: 'Managed AWS Landing Zone, IAM RBAC/MFA, GuardDuty & CloudTrail',
};

/**
 * Which track applies, derived from what the prospect already told you.
 *
 * `mixed` genuinely gets BOTH — a clinic running some servers locally and some
 * workloads in an unmanaged cloud account needs both the lift-and-shift and the
 * takeover. Returning one and hiding the other would misdescribe the engagement.
 *
 * An unanswered or unrecognised `hosting` returns an empty list, and the
 * section is skipped rather than guessed at.
 */
export function tracksForHosting(hosting: string | null | undefined): readonly MigrationTrack[] {
  if (!isOneOf(['onprem', 'cloud', 'mixed'] as const, hosting)) return [];
  const model = hosting as HostingModel;
  if (model === 'onprem') return [TRACK_A];
  if (model === 'cloud') return [TRACK_B];
  return [TRACK_A, TRACK_B];
}

/* ═════════════════════ IT provider co-existence ═════════════════════ */

/** Framework §5, "Co-Existence Model with Clinic's Existing Local IT Provider". */
export const CO_EXISTENCE = {
  localProvider: [
    'Onsite desktop & laptop support',
    'Office printers, Wi-Fi & cabling',
    'Microsoft 365 / email administration',
    'Local help-desk & hardware break/fix',
  ],
  aeygis: [
    'AWS cloud infrastructure & engineering',
    'Cloud EMR & PACS database hosting',
    'Multi-AZ backup & recovery systems',
    'PHIPA technical safeguards & audit logs',
  ],
  positioning:
    'Keep your local IT provider for laptops, printers, and email. Bring Aeygis in to migrate your core systems to AWS, manage disaster recovery, and provide PHIPA-aligned cloud infrastructure.',
} as const;

/* ═══════════════════════ service levels & uptime ═══════════════════════ */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UPTIME NUMBERS ARE LABELLED, NEVER BARE. READ THIS BEFORE EDITING.
 * ═══════════════════════════════════════════════════════════════════════════
 * Three different uptime figures appear across the Aeygis materials — 99.99%
 * (Framework §1), 99.9% (Overview p11), and 99.97% (the live site). They were
 * long treated as an inconsistency. They are not, except for one:
 *
 *   99.99% is AMAZON'S contractual SLA, for multi-AZ COMPUTE only.
 *   99.9%  is AEYGIS'S OWN service target, across the whole managed service.
 *   99.97% has no documented basis anywhere and is NOT used. See
 *          docs/known-issues.md #9 — the live site still needs correcting.
 *
 * A managed-service target BELOW the underlying infrastructure SLA is correct,
 * not a mistake: the service spans the application, database, network and
 * vendor platforms, none of which AWS's compute SLA covers.
 *
 * The gap is not cosmetic — 99.9% permits ~8h46m of downtime a year, 99.99%
 * permits ~53 minutes. Publishing a bare number invites a clinic to plan
 * around the wrong one by a factor of ten. So each figure below carries whose
 * commitment it is, and the managed figure is explicitly a TARGET whose
 * binding form lives in the signed agreement — which is what Overview p11
 * already says ("Service levels are defined in the agreement").
 *
 * Confirmed decision: show both, labelled. Drop the third.
 */
export interface ServiceLevel {
  readonly figure: string;
  readonly layer: string;
  readonly whoseCommitment: string;
  readonly scope: string;
  readonly allowedDowntime: string;
}

export const SERVICE_LEVELS: readonly ServiceLevel[] = [
  {
    figure: '99.99%',
    layer: 'Underlying infrastructure',
    whoseCommitment: "Amazon Web Services' contractual SLA",
    scope: 'AWS compute, for multi-availability-zone deployments',
    allowedDowntime: 'about 53 minutes per year',
  },
  {
    figure: '99.9%',
    layer: 'Aeygis managed service',
    whoseCommitment: 'An Aeygis service target, not a guarantee',
    scope: 'The managed environment overall, including support and operations',
    allowedDowntime: 'about 8 hours 45 minutes per year',
  },
];

export const SERVICE_LEVEL_NOTE =
  'These measure different things and are not interchangeable. The AWS figure is a contractual commitment from Amazon covering compute infrastructure only. The Aeygis figure is our operating target across the whole managed service, which also spans your applications, databases, network paths and third-party platforms. Binding service levels for your clinic are set in the signed agreement, not in this proposal.';

/* ═══════════════════════ recovery objectives ═══════════════════════ */

export const RECOVERY_OBJECTIVES = [
  {
    code: 'RTO',
    name: 'Recovery Time Objective',
    plain: 'How quickly an approved system must be back up after a disruption.',
  },
  {
    code: 'RPO',
    name: 'Recovery Point Objective',
    plain: 'How much recent data the clinic can afford to lose, measured in time.',
  },
] as const;

/** Overview p10's protect / detect / recover / review cycle. */
export const RESILIENCE_CYCLE = [
  { step: 'Protect', detail: 'Encryption, access control, and backup design.' },
  { step: 'Detect', detail: 'Monitoring and alerting surface issues quickly.' },
  { step: 'Recover', detail: 'Documented actions restore approved services.' },
  { step: 'Review', detail: 'Evidence supports improvement after an incident.' },
] as const;

export const RECOVERY_DISCLAIMER =
  'Recovery targets are agreed during discovery and designed into the solution based on the selected architecture and data volume. They are design goals for your engagement, not universal guarantees. Actual recovery time depends on application dependencies, data volume, and the service levels agreed with the clinic.';

/* ═══════════════════════ measured impact ═══════════════════════ */

/**
 * Framework §1 and Overview p7. Published, citable figures only.
 *
 * ATTRIBUTION IS NOT OPTIONAL. These are third-party research findings about
 * other organisations, not Aeygis performance claims, and a clinic may well
 * hand this document to its lawyer. Overview p7 already models the right
 * treatment and its qualifier is carried across verbatim below.
 */
export const MEASURED_IMPACT = [
  {
    figure: '44%',
    label: 'lower cost of operations',
    detail: 'Compared with on-premises infrastructure',
  },
  {
    figure: '62%',
    label: 'more efficient IT staff',
    detail: 'Time freed from server maintenance and firefighting',
  },
  {
    figure: '94%',
    label: 'less unplanned downtime',
    detail: 'Versus previous on-premises infrastructure',
  },
] as const;

export const IMPACT_ATTRIBUTION =
  'IDC, "Fostering Business and Organizational Transformation to Generate Business Value with AWS" (February 2018), across 27 organizations. Measured across real migrations — your clinic\'s results are scoped, not assumed. Individual results depend on workloads, architecture, and agreed service levels.';

/* ═══════════════════════ regulatory context ═══════════════════════ */

/** Framework §1 and Overview p3. Dated, sourced, and deliberately unembellished. */
export const REGULATORY_POINTS = [
  {
    figure: 'January 2024',
    label: 'IPC gained direct penalty authority',
    detail:
      'The Ontario Information and Privacy Commissioner can issue administrative penalties under PHIPA without going through a prosecution.',
  },
  {
    figure: 'August 2025',
    label: 'First penalties issued',
    detail:
      'PHIPA Decision 298 — the IPC issued its first administrative penalties, confirming enforcement is active rather than theoretical.',
  },
  {
    figure: '$1,000,000',
    label: 'Maximum corporate fine, per offence',
    detail: 'Under Ontario PHIPA as amended in 2020, which doubled the previous maximum.',
  },
  {
    figure: '45%',
    label: 'of Canadian organizations reported a cyberattack',
    detail: 'CIRA, 2024.',
  },
] as const;

export const REGULATORY_NOTE =
  'This proposal does not constitute legal advice. Specific obligations should be reviewed with qualified counsel.';

/* ═══════════════════════ security controls ═══════════════════════ */

/** Overview p9 — the six baseline controls. */
export const SECURITY_CONTROLS = [
  {
    title: 'Encryption by default',
    detail: 'Data protected at rest and in transit across approved services.',
  },
  {
    title: 'Identity & least privilege',
    detail: 'MFA and role-based access limit who can reach sensitive systems.',
  },
  {
    title: 'Auditability',
    detail: 'Centralized logging creates evidence for review and incident response.',
  },
  {
    title: 'Protected backups',
    detail: 'Automated backup design with retention and Canadian redundancy.',
  },
  {
    title: 'Canadian residency',
    detail: 'Workloads are designed for AWS Canadian-region hosting.',
  },
  {
    title: 'Governed change',
    detail: 'Security, recovery and access changes follow documented approval paths.',
  },
] as const;

/** Framework Phase 2 — the specifics behind the six controls above. */
export const SECURITY_SPECIFICS: readonly string[] = [
  'KMS AES-256 encryption at rest',
  'TLS 1.3 in transit',
  'AWS WAF and private subnets',
  'AWS Client VPN with MFA',
  'IAM role-based access control',
  'GuardDuty threat detection',
  'CloudTrail and AWS Config audit logging',
  'Multi-account landing zone in AWS Montreal (ca-central-1), with a Canada West backup site',
];

export const SECURITY_NOTE =
  'This baseline applies across every managed environment; the controls that apply to your clinic are documented in the final statement of work. Aeygis provides the technical controls, operating procedures and evidence defined in the engagement. Each clinic remains responsible for its own policies, training, legal duties and appropriate system use.';

/* ═══════════════════════════ citations ═══════════════════════════ */

/**
 * Every external claim made anywhere in the proposal, attributed.
 *
 * Both source documents carry a citations section; a client-facing proposal
 * that repeats their statistics without one is the weakest link in the chain.
 * If a figure is added above, it is added here too.
 */
export const CITATIONS: readonly { readonly claim: string; readonly source: string }[] = [
  {
    claim: '44% lower operating cost, 62% staff efficiency, 94% less unplanned downtime',
    source:
      'IDC, "Fostering Business and Organizational Transformation to Generate Business Value with AWS", February 2018, across 27 organizations.',
  },
  {
    claim: '99.99% uptime commitment for multi-AZ compute',
    source: 'AWS Compute Service Level Agreement, region-level commitment for multi-AZ deployments.',
  },
  {
    claim: 'IPC direct administrative penalty authority, January 2024',
    source: 'Ontario Information and Privacy Commissioner, under PHIPA as amended.',
  },
  {
    claim: 'First administrative penalties issued, August 2025',
    source: 'Ontario IPC, PHIPA Decision 298.',
  },
  {
    claim: 'Corporate fines up to $1,000,000 per offence',
    source: 'Ontario Personal Health Information Protection Act, as amended 2020.',
  },
  {
    claim: '45% of Canadian organizations reported a cyberattack in 2024',
    source: 'Canadian Internet Registration Authority (CIRA), 2024 Cybersecurity Survey.',
  },
  {
    claim: '27% of cloud spend wasted; 84% cite spend management as a top challenge',
    source: 'Flexera, 2025 State of the Cloud Report.',
  },
  {
    claim: 'AWS Well-Architected Framework pillars',
    source:
      'Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Sustainability.',
  },
];

/* ═══════════════════════════ why Aeygis ═══════════════════════════ */

/**
 * Overview p12, verbatim.
 *
 * Note the framing is comparative but names nobody: "national cloud providers
 * sell infrastructure". That is deliberate and must stay that way — the
 * client-safety guard rejects the word "competitor" in visible copy, and naming
 * a rival in a document a clinic may forward is a different kind of risk again.
 */
export const WHY_AEYGIS_POSITIONING =
  'National cloud providers sell infrastructure. Aeygis combines cloud engineering with local accountability and clinic-focused delivery.';

export const WHY_AEYGIS_DIFFERENTIATORS = [
  {
    title: 'Local, in person',
    detail:
      'Ontario-based support with the ability to walk through the migration and operating model with your team.',
  },
  {
    title: 'Healthcare focus',
    detail:
      'The service is designed around clinic privacy, resilience, workflow, and accountability requirements.',
  },
  {
    title: 'Documented, not promised',
    detail:
      'Safeguards, responsibilities, recovery objectives, and deliverables are written into the engagement.',
  },
  {
    title: 'One team, one number',
    detail:
      'Migration, security, and ongoing support come from one accountable team — not multiple vendor hand-offs.',
  },
] as const;

export const WHY_AEYGIS_EXPECTATIONS = [
  {
    title: 'Clear scope',
    detail: 'A defined statement of work, assumptions, dependencies, and exclusions.',
  },
  {
    title: 'Plain language',
    detail: 'Business outcomes explained without unnecessary cloud jargon.',
  },
  {
    title: 'Evidence',
    detail: 'Configuration, access, backup, and change records where included.',
  },
  {
    title: 'Ongoing ownership',
    detail: 'The relationship continues after the migration is complete.',
  },
] as const;

/* ═══════════════════════════ acceptance ═══════════════════════════ */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT SIGNING THIS DOES — AND DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 * Confirmed decision: acceptance is INTENT TO PROCEED. It records the plan the
 * clinic chose and authorises Aeygis to issue the statement of work. The SOW is
 * the binding agreement; this page is not.
 *
 * That sequence is the Framework's own (§6: "SOW & Proposal Delivery ... for
 * clinic approval"), and the disclaimer below is not decorative. A signature
 * page carrying prices and no statement of effect can be argued to be the
 * contract itself. Saying plainly what it is not is the cheapest way to keep
 * that argument from ever starting.
 *
 * SIGNATORY: `Aeygis Technologies Inc.` — the registered entity, confirmed for
 * the signature line specifically. Note the document body still reads
 * "Aeygis Health", which is the client-facing brand and was confirmed
 * separately. Brand in the copy, legal entity on the signature, is normal; if
 * they should ever match, change both together rather than one.
 */
export const ACCEPTANCE_SIGNATORY_ENTITY = 'Aeygis Technologies Inc.';

/* Restored to the approved wording. It was briefly changed when the plan
   block was removed from the acceptance page; the plan is back, so the
   sentence points at something again. */
export const ACCEPTANCE_STATEMENT =
  'Signing below confirms the support plan selected above and authorises Aeygis to issue the formal statement of work for this engagement.';

export const ACCEPTANCE_NOT_AGREEMENT_NOTE =
  'This acceptance is a confirmation of intent to proceed. It is not the service agreement and does not itself create a payment obligation. Scope, service levels, and commercial terms are set out in the statement of work, which is the binding document and is issued after this proposal is accepted.';

/** Days the quoted pricing is held. One constant, so the note and the computed date cannot drift. */
export const PRICING_VALIDITY_DAYS = 30;

/**
 * The date pricing is held until, calculated on the CALENDAR, not by adding
 * milliseconds — a 30 × 24 × 60 × 60 × 1000 offset lands an hour out across a
 * daylight-saving boundary, which in Canada can tip the answer onto the wrong
 * day. Callers pass the same Date instance they format `issuedOn` from, so the
 * two can never describe different days.
 */
export function validUntilDate(issuedAt: Date, days: number = PRICING_VALIDITY_DAYS): Date {
  const d = new Date(issuedAt.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
