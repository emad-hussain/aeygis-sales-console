import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PricingPanel } from './PricingPanel';
import { ApprovalPanel } from './ApprovalPanel';
import {
  ASSESSMENT_STATUSES,
  assessmentStatusLabel,
  CUSTOM_CATEGORY_ID_PREFIX,
  CUSTOM_QUESTION_ID_PREFIX,
  CUSTOM_RESPONSIBILITY_ID_PREFIX,
  MAX_CUSTOM_CATEGORY_TITLE_LENGTH,
  MAX_CUSTOM_QUESTION_LENGTH,
  MAX_RESPONSIBILITY_TEXT_LENGTH,
  MAX_SCHEDULE_ESTIMATE_LENGTH,
  MAX_SCHEDULE_NOTE_LENGTH,
  RESPONSIBILITY_ROWS,
  SCHEDULE_PHASE_IDS,
  SCHEDULE_PHASE_LABELS,
  countAnsweredIn,
  effectiveDiscoveryGroups,
  parseCustomDiscoverySchema,
  parseDiscoveryAnswers,
  parseMigrationSchedule,
  parseResponsibilityCustomisation,
  type CustomDiscoverySchema,
  type DiscoveryAnswers,
  type MigrationSchedule,
  type ResponsibilityCustomisation,
  type SchedulePhaseId,
} from '@aeygis/domain';
import type { AssessmentRecord } from './client';
import { getAssessment, updateAssessment } from './client';
import { useToast } from './Toast';

interface Props {
  readonly assessment: AssessmentRecord;
  readonly canEdit: boolean;
  readonly isApprover: boolean;
  readonly onSaved: (updated: AssessmentRecord) => void;
}

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** Offered in the picker, in pipeline order. */
const STATUS_CHOICES: readonly string[] = ASSESSMENT_STATUSES;

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'scope', label: 'Scope' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'discovery', label: 'Discovery' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'notes', label: 'Notes' },
] as const;

export function AssessmentDetail({ assessment, canEdit, isApprover, onSaved }: Props) {
  // Local edit buffer. Exact counts are the fields that unlock pricing.
  const [providerCount, setProviderCount] = useState<string>('');
  const [locationCount, setLocationCount] = useState<string>('');
  const [patientCount, setPatientCount] = useState<string>('');
  const [countsConfirmed, setCountsConfirmed] = useState(false);
  // Part of the edit buffer, not an immediate write: a status change commits
  // with Save changes like every other field, so a misclick is undoable.
  const [status, setStatus] = useState<string>('');
  const [answers, setAnswers] = useState<DiscoveryAnswers>({});
  const [custom, setCustom] = useState<CustomDiscoverySchema>({ categories: [], questions: [] });
  // Draft text for the "add" controls, keyed by the category being added to
  // ('' is the new-category box). Kept out of `custom` so a half-typed
  // question is never saved.
  const [draftQuestion, setDraftQuestion] = useState<Record<string, string>>({});
  const [draftCategory, setDraftCategory] = useState('');
  const [schedule, setSchedule] = useState<MigrationSchedule>({ estimates: {}, note: null });
  const [responsibility, setResponsibility] = useState<ResponsibilityCustomisation>({
    excludedIds: [],
    added: [],
  });
  const [draftRow, setDraftRow] = useState({ area: '', aeygis: '', clinic: '' });
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Bumped after a proposal is generated; remounts the approval panel so the
  // new version appears without a manual refresh.
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const { active: activeSection, goTo } = useSectionNav(rootRef);
  const toast = useToast();

  // Reset the buffer whenever a different assessment is selected, otherwise one
  // clinic's figures would leak into another's form.
  useEffect(() => {
    setProviderCount(assessment.providerCount?.toString() ?? '');
    setLocationCount(assessment.locationCount?.toString() ?? '');
    setPatientCount(assessment.patientCount?.toString() ?? '');
    setCountsConfirmed(assessment.countsConfirmed === true);
    setStatus(assessment.status ?? '');
    setNotes(assessment.internalNotes ?? '');
    setAnswers(parseDiscoveryAnswers(assessment.discoveryAnswers));
    setCustom(parseCustomDiscoverySchema(assessment.customDiscoveryQuestions));
    setSchedule(parseMigrationSchedule(assessment.migrationSchedule));
    setResponsibility(parseResponsibilityCustomisation(assessment.responsibilityMatrix));
    setDraftQuestion({});
    setDraftCategory('');
    setDraftRow({ area: '', aeygis: '', clinic: '' });
    setError(null);
    setSavedNote(null);
  }, [assessment.id]);

  /**
   * Re-read the lead after the backend changed it behind our back.
   *
   * Emailing a proposal moves the status to `proposed` server-side, and nothing
   * on this page would otherwise notice: the buffer above is keyed on
   * `assessment.id`, so a fresh record for the SAME lead deliberately does not
   * re-run it — that is what stops a refresh wiping someone's unsaved edits.
   * The flip side is that `status` has to be set explicitly here, or the pill
   * keeps saying "In review" immediately after the send that changed it.
   *
   * Only `status` is touched, not the whole buffer, for exactly that reason.
   *
   * The value is READ back rather than assumed to be 'proposed': the backend
   * leaves a `closed` lead alone, so hardcoding the outcome here would show a
   * status the record does not have.
   *
   * Failure is swallowed. The email has already gone; a stale pill is not worth
   * an error banner, and the next reload fixes it.
   */
  const refreshLead = useCallback(async () => {
    try {
      const fresh = await getAssessment(assessment.id);
      setStatus(fresh.status ?? '');
      onSaved(fresh);
    } catch (e) {
      console.warn('could not re-read the lead after sending', e);
    }
  }, [assessment.id, onSaved]);

  const providers = toPositiveInt(providerCount);
  const locations = toPositiveInt(locationCount);
  const patients = toPositiveInt(patientCount);

  // Confirming counts requires actual numbers to confirm.
  const canConfirm = providers !== null && locations !== null;
  const effectiveConfirmed = countsConfirmed && canConfirm;

  // The question set actually in force here: the approved 20 plus this
  // clinic's own additions. Same merge the PDF renderer uses, so the console
  // and the client document cannot disagree about which questions exist.
  const groups = useMemo(() => effectiveDiscoveryGroups(custom), [custom]);
  const { answered, total: totalQuestions } = useMemo(
    () => countAnsweredIn(groups, answers),
    [groups, answers],
  );

  function addCustomQuestion(categoryId: string) {
    const text = (draftQuestion[categoryId] ?? '').trim();
    if (text === '') return;
    setCustom((prev) => ({
      ...prev,
      questions: [
        ...prev.questions,
        {
          id: `${CUSTOM_QUESTION_ID_PREFIX}${crypto.randomUUID()}`,
          categoryId,
          question: text.slice(0, MAX_CUSTOM_QUESTION_LENGTH),
        },
      ],
    }));
    setDraftQuestion((prev) => ({ ...prev, [categoryId]: '' }));
  }

  function addCustomCategory() {
    const title = draftCategory.trim();
    if (title === '') return;
    setCustom((prev) => ({
      ...prev,
      categories: [
        ...prev.categories,
        {
          id: `${CUSTOM_CATEGORY_ID_PREFIX}${crypto.randomUUID()}`,
          title: title.slice(0, MAX_CUSTOM_CATEGORY_TITLE_LENGTH),
        },
      ],
    }));
    setDraftCategory('');
  }

  /** Also drops the answer, so a removed question leaves nothing behind. */
  function removeCustomQuestion(questionId: string) {
    setCustom((prev) => ({ ...prev, questions: prev.questions.filter((q) => q.id !== questionId) }));
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }

  function setEstimate(phase: SchedulePhaseId, value: string) {
    setSchedule((prev) => {
      const estimates = { ...prev.estimates };
      if (value.trim() === '') delete estimates[phase];
      else estimates[phase] = value.slice(0, MAX_SCHEDULE_ESTIMATE_LENGTH);
      return { ...prev, estimates };
    });
  }

  function toggleApprovedRow(id: string) {
    setResponsibility((prev) => ({
      ...prev,
      excludedIds: prev.excludedIds.includes(id)
        ? prev.excludedIds.filter((x) => x !== id)
        : [...prev.excludedIds, id],
    }));
  }

  function addResponsibilityRow() {
    const area = draftRow.area.trim();
    if (area === '') return;
    setResponsibility((prev) => ({
      ...prev,
      added: [
        ...prev.added,
        {
          id: `${CUSTOM_RESPONSIBILITY_ID_PREFIX}${crypto.randomUUID()}`,
          area: area.slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
          aeygis: draftRow.aeygis.trim().slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
          clinic: draftRow.clinic.trim().slice(0, MAX_RESPONSIBILITY_TEXT_LENGTH),
        },
      ],
    }));
    setDraftRow({ area: '', aeygis: '', clinic: '' });
  }

  function removeResponsibilityRow(id: string) {
    setResponsibility((prev) => ({ ...prev, added: prev.added.filter((r) => r.id !== id) }));
  }

  /**
   * Removing a category takes its questions with it. Leaving them behind would
   * strand them: `effectiveDiscoveryGroups` has nowhere to render a question
   * whose category is gone, so they would silently vanish from the UI while
   * still occupying the stored JSON.
   */
  function removeCustomCategory(categoryId: string) {
    const doomed = custom.questions.filter((q) => q.categoryId === categoryId).map((q) => q.id);
    setCustom((prev) => ({
      categories: prev.categories.filter((c) => c.id !== categoryId),
      questions: prev.questions.filter((q) => q.categoryId !== categoryId),
    }));
    setAnswers((prev) => {
      const next = { ...prev };
      for (const id of doomed) delete next[id];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      /*
       * Send ONLY what changed.
       *
       * The whole buffer used to go every time, which meant an untouched
       * empty Internal notes field was sent as `internalNotes: null` on every
       * save — and the API refuses any null (see updateAssessment). Changing
       * the status on a clinic with no notes therefore failed with
       * "Unauthorized on [internalNotes]", which named the wrong field and
       * the wrong cause.
       *
       * `undefined` means "not changed" and is dropped before the request.
       */
      const same = <T,>(a: T, b: T) => a === b;
      const trimmedNotes = notes.trim();

      const updated = await updateAssessment(assessment.id, {
        // Unchanged -> undefined (dropped). Changed -> sent as-is, INCLUDING
        // null: emptying a saved number has no other representation, and
        // updateAssessment turns that into a readable refusal rather than
        // pretending the save worked.
        providerCount: same(providers, assessment.providerCount ?? null) ? undefined : providers,
        locationCount: same(locations, assessment.locationCount ?? null) ? undefined : locations,
        patientCount: same(patients, assessment.patientCount ?? null) ? undefined : patients,
        countsConfirmed: same(effectiveConfirmed, assessment.countsConfirmed === true)
          ? undefined
          : effectiveConfirmed,
        // '' clears it. A null would be refused, and dropping the key would
        // silently keep the old text after the staff member deleted it.
        internalNotes: same(trimmedNotes, (assessment.internalNotes ?? '').trim())
          ? undefined
          : trimmedNotes,
        discoveryAnswers: JSON.stringify(answers),
        customDiscoveryQuestions: JSON.stringify(custom),
        migrationSchedule: JSON.stringify(schedule),
        responsibilityMatrix: JSON.stringify(responsibility),
        status: same(status, assessment.status ?? '') ? undefined : status,
      });
      onSaved(updated);
      setSavedNote('Changes saved.');
      // The toast is the confirmation the eye catches. The inline note
      // stays too: Save now lives in the sticky header, so whoever pressed
      // it may be looking at the bottom of a long form when it lands.
      toast('ok', `Changes saved — discovery ${answered}/${totalQuestions}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed';
      setError(message);
      toast('bad', message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={rootRef}>
      <header className="detail-head">
        <p className="meta">
          {assessment.referenceId} &middot; submitted {formatDate(assessment.submittedAt)}
        </p>
        <div className="title-row">
          <h1>{dash(assessment.clinicName)}</h1>
          {canEdit ? (
            <>
              {/* A real <select>, styled as the pill it replaces. Keyboard and
                  screen-reader behaviour come for free, and the native option
                  list follows the theme because color-scheme is set per theme. */}
              <label className="visually-hidden" htmlFor="lead-status">
                Lead status
              </label>
              <select
                id="lead-status"
                className={`pill-select status-${status}`}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUS_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {assessmentStatusLabel(s)}
                  </option>
                ))}
                {/* `status` is a plain string on the model. If a record somehow
                    holds a value outside the vocabulary, it is offered here too
                    rather than being silently rewritten by the first save. */}
                {!STATUS_CHOICES.includes(status) && (
                  <option value={status}>{assessmentStatusLabel(status)}</option>
                )}
              </select>
              {status !== (assessment.status ?? '') && (
                <span className="pending-change">unsaved</span>
              )}
            </>
          ) : (
            <span className={`pill status-${status}`}>{assessmentStatusLabel(status)}</span>
          )}
          {/* Save lives here, not at the foot of Notes. It commits every
              section of this form, and the header is the only part of the
              pane visible from all of them. */}
          {canEdit && (
            <div className="head-actions">
              <button type="button" onClick={() => void save()} disabled={saving}>
                {saving ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  'Save changes'
                )}
              </button>
            </div>
          )}
        </div>
        <nav className="section-nav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={activeSection === s.id}
              onClick={() => goTo(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="detail-body">
        {/* Every section is full width and stacked. Overview and Scope were
            briefly paired side by side for density, which broke the section
            nav outright: siblings share a top edge, so a vertical scroll-spy
            cannot tell them apart and "Scope" won every time. Navigation
            correctness beats a denser first screen. */}
        {/* ---------------- overview ---------------- */}
        <section className="panel" id="overview" aria-labelledby="h-overview">
          <div className="panel-head">
            <h2 id="h-overview">Overview</h2>
            <span className="note">as submitted</span>
          </div>
          <div className="panel-body">
            <dl className="def-grid">
              <div>
                <dt>Contact</dt>
                <dd>
                  {dash(assessment.contactName)}
                  {assessment.jobTitle ? `, ${assessment.jobTitle}` : ''}
                  <br />
                  <span className="mono tiny">{dash(assessment.email)}</span>
                  {assessment.phone ? (
                    <>
                      <br />
                      <span className="mono tiny">{assessment.phone}</span>
                    </>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Organisation</dt>
                <dd>
                  {dash(assessment.organizationType)}
                  <br />
                  {dash(assessment.organizationSize)}
                  <br />
                  {dash(assessment.province)}
                </dd>
              </div>
              <div>
                <dt>Current state</dt>
                <dd>
                  <span className="k">Hosting</span> {dash(assessment.hosting)}
                  <br />
                  <span className="k">IT spend/mo</span> <span className="mono">{money(assessment.monthlyItSpend)}</span>
                  <br />
                  <span className="k">Hardware/yr</span>{' '}
                  <span className="mono">{money(assessment.annualHardwareEmergency)}</span>
                </dd>
              </div>
              <div>
                <dt>Security posture</dt>
                <dd>
                  <span className="k">MFA</span> {dash(assessment.mfa)}
                  <br />
                  <span className="k">Backups</span> {dash(assessment.backups)}
                  <br />
                  <span className="k">IR plan</span> {dash(assessment.incidentPlan)}
                  <br />
                  <span className="k">Last risk assessment</span> {dash(assessment.lastRiskAssessment)}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* ---------------- scope ---------------- */}
        <section className="panel" id="scope" aria-labelledby="h-scope">
          <div className="panel-head">
            <h2 id="h-scope">Scope</h2>
            <span className="note">required before pricing</span>
          </div>
          <div className="panel-body">
            {(assessment.providerBand || assessment.locationBand) && (
              <div className="notice notice-warn">
                The prospect submitted <strong>ranges</strong>, not numbers:{' '}
                <span className="mono">
                  providers {dash(assessment.providerBand)}, locations {dash(assessment.locationBand)}
                </span>
                . A range cannot determine a tier — “3&ndash;15 providers” covers both Professional
                and Enterprise. Confirm the exact figures with the client on the call.
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label htmlFor="pc">Providers (physicians/clinicians)</label>
                <input
                  id="pc"
                  type="number"
                  min={1}
                  value={providerCount}
                  disabled={!canEdit}
                  onChange={(e) => setProviderCount(e.target.value)}
                />
                {assessment.providerCountMin !== null && (
                  <p className="hint">
                    Band suggests {assessment.providerCountMin}
                    {assessment.providerCountMax === null ? '+' : `–${assessment.providerCountMax}`}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="lc">Physical locations</label>
                <input
                  id="lc"
                  type="number"
                  min={1}
                  value={locationCount}
                  disabled={!canEdit}
                  onChange={(e) => setLocationCount(e.target.value)}
                />
                {assessment.locationCountMin !== null && (
                  <p className="hint">
                    Band suggests {assessment.locationCountMin}
                    {assessment.locationCountMax === null ? '+' : `–${assessment.locationCountMax}`}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="pt">Approx. patients</label>
                <input
                  id="pt"
                  type="number"
                  min={0}
                  value={patientCount}
                  disabled={!canEdit}
                  onChange={(e) => setPatientCount(e.target.value)}
                />
                <p className="hint">Distinguishes Micro (~3,000) from Starter (~10,000)</p>
              </div>
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={countsConfirmed}
                disabled={!canEdit || !canConfirm}
                onChange={(e) => {
                  setCountsConfirmed(e.target.checked);
                  // Confirming the counts is what moves a lead off
                  // "needs confirmation". This used to be a hidden transform at
                  // save time; doing it here means the pill in the header shows
                  // what will actually be saved, and the staff member can still
                  // override it afterwards.
                  if (e.target.checked && status === 'needs_confirmation') {
                    setStatus('in_review');
                  }
                }}
              />
              <span>
                Counts confirmed with the client
                {!canConfirm && <span className="muted tiny"> — enter both counts first</span>}
              </span>
            </label>
          </div>
        </section>

        {/* ---------------- pricing ---------------- */}
        <section className="panel" id="pricing" aria-labelledby="h-pricing">
          <PricingPanel
            assessmentId={assessment.id}
            providerCount={providers}
            locationCount={locations}
            patientCount={patients}
            countsConfirmed={effectiveConfirmed}
            canGenerate={canEdit}
            onProposalGenerated={() => setApprovalRefresh((n) => n + 1)}
          />
        </section>

        {/* ---------------- discovery ---------------- */}
        <section className="panel" id="discovery" aria-labelledby="h-discovery">
          <div className="panel-head">
            <h2 id="h-discovery">Technical discovery</h2>
            <span className="note">
              {answered}/{totalQuestions} answered
            </span>
          </div>
          <div className="panel-body">
            {groups.map((group) => (
              <details className="disco-group" key={group.id}>
                <summary>
                  {group.title}
                  {group.isCustom && <span className="pill status-in_review">added</span>}
                  <span className="disco-count">
                    {group.questions.filter((q) => (answers[q.id] ?? '').trim() !== '').length}/
                    {group.questions.length}
                  </span>
                </summary>

                <div className="disco-body">

                {group.questions.map((q) => (
                  <div className="field" key={q.id}>
                    <label className="q-label" htmlFor={q.id}>
                      <span>
                        {q.number}. {q.question}
                      </span>
                      {q.isCustom && canEdit && (
                        <button
                          type="button"
                          className="secondary tiny"
                          onClick={() => removeCustomQuestion(q.id)}
                          title="Remove this question and its answer from this assessment"
                        >
                          remove
                        </button>
                      )}
                    </label>
                    <textarea
                      id={q.id}
                      value={answers[q.id] ?? ''}
                      disabled={!canEdit}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  </div>
                ))}

                {canEdit && (
                  <div className="field">
                    <div className="inline-add">
                      <input
                        aria-label={`Add a question to ${group.title}`}
                        placeholder="Add a question to this category…"
                        maxLength={MAX_CUSTOM_QUESTION_LENGTH}
                        value={draftQuestion[group.id] ?? ''}
                        onChange={(e) =>
                          setDraftQuestion((prev) => ({ ...prev, [group.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCustomQuestion(group.id);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="secondary"
                        disabled={(draftQuestion[group.id] ?? '').trim() === ''}
                        onClick={() => addCustomQuestion(group.id)}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                )}

                {group.isCustom && canEdit && (
                  <button
                    type="button"
                    className="secondary tiny"
                    onClick={() => removeCustomCategory(group.id)}
                    title="Remove this category and every question in it"
                  >
                    Remove “{group.title}” and its {group.questions.length} question
                    {group.questions.length === 1 ? '' : 's'}
                  </button>
                )}
                </div>
              </details>
            ))}

            {canEdit && (
              <div className="field">
                <label htmlFor="new-category">New category for this client</label>
                <div className="inline-add">
                  <input
                    id="new-category"
                    placeholder="e.g. Imaging &amp; PACS"
                    maxLength={MAX_CUSTOM_CATEGORY_TITLE_LENGTH}
                    value={draftCategory}
                    onChange={(e) => setDraftCategory(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomCategory();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={draftCategory.trim() === ''}
                    onClick={addCustomCategory}
                  >
                    Add category
                  </button>
                </div>
                <p className="hint">
                  Remember to <strong>Save changes</strong>.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ---------------- proposal content ---------------- */}
        <section className="panel" id="proposal" aria-labelledby="h-proposal">
          <div className="panel-head">
            <h2 id="h-proposal">Proposal content</h2>
            <span className="note">applies to the next version</span>
          </div>
          <div className="panel-body">
            <h3 className="sub-head">Migration schedule</h3>
            {SCHEDULE_PHASE_IDS.map((id, i) => (
              <div className="field" key={id}>
                <label htmlFor={`sched-${id}`}>
                  {i + 1}. {SCHEDULE_PHASE_LABELS[id]}
                </label>
                <input
                  id={`sched-${id}`}
                  value={schedule.estimates[id] ?? ''}
                  disabled={!canEdit}
                  maxLength={MAX_SCHEDULE_ESTIMATE_LENGTH}
                  placeholder="e.g. 2–3 weeks"
                  onChange={(e) => setEstimate(id, e.target.value)}
                />
              </div>
            ))}
            <div className="field">
              <label htmlFor="sched-note">Scheduling notes (optional)</label>
              <textarea
                id="sched-note"
                value={schedule.note ?? ''}
                disabled={!canEdit}
                maxLength={MAX_SCHEDULE_NOTE_LENGTH}
                placeholder="Dependencies, blackout periods, vendor lead times…"
                onChange={(e) =>
                  setSchedule((prev) => ({
                    ...prev,
                    note: e.target.value.trim() === '' ? null : e.target.value,
                  }))
                }
              />
            </div>

            <h3 className="sub-head">Shared responsibility matrix</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }}>Show</th>
                    <th>Area</th>
                    <th>Aeygis</th>
                    <th>Clinic</th>
                  </tr>
                </thead>
                <tbody>
                  {RESPONSIBILITY_ROWS.map((r) => {
                    const shown = !responsibility.excludedIds.includes(r.id);
                    return (
                      <tr key={r.id} className={shown ? undefined : 'row-off'}>
                        <td>
                          <input
                            type="checkbox"
                            checked={shown}
                            disabled={!canEdit}
                            aria-label={`Include "${r.area}" in the proposal`}
                            onChange={() => toggleApprovedRow(r.id)}
                          />
                        </td>
                        <td className="tiny">
                          <strong>{r.area}</strong>
                        </td>
                        <td className="tiny">{r.aeygis}</td>
                        <td className="tiny">{r.clinic}</td>
                      </tr>
                    );
                  })}
                  {responsibility.added.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {canEdit && (
                          <button
                            type="button"
                            className="secondary tiny"
                            onClick={() => removeResponsibilityRow(r.id)}
                            title="Remove this added row"
                          >
                            ×
                          </button>
                        )}
                      </td>
                      <td className="tiny">
                        <strong>{r.area}</strong>{' '}
                        <span className="pill status-in_review">added</span>
                      </td>
                      <td className="tiny">{r.aeygis}</td>
                      <td className="tiny">{r.clinic}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canEdit && (
              <div className="field">
                <label htmlFor="row-area">Add a row for this client</label>
                <div className="inline-add">
                  <input
                    id="row-area"
                    placeholder="Area"
                    maxLength={MAX_RESPONSIBILITY_TEXT_LENGTH}
                    value={draftRow.area}
                    onChange={(e) => setDraftRow((p) => ({ ...p, area: e.target.value }))}
                  />
                  <input
                    aria-label="Aeygis responsibility"
                    placeholder="Aeygis responsibility"
                    maxLength={MAX_RESPONSIBILITY_TEXT_LENGTH}
                    value={draftRow.aeygis}
                    onChange={(e) => setDraftRow((p) => ({ ...p, aeygis: e.target.value }))}
                  />
                  <input
                    aria-label="Clinic responsibility"
                    placeholder="Clinic responsibility"
                    maxLength={MAX_RESPONSIBILITY_TEXT_LENGTH}
                    value={draftRow.clinic}
                    onChange={(e) => setDraftRow((p) => ({ ...p, clinic: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={draftRow.area.trim() === ''}
                    onClick={addResponsibilityRow}
                  >
                    Add row
                  </button>
                </div>
                <p className="hint">
                  Remember to <strong>Save changes</strong>.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ---------------- approvals ---------------- */}
        <section className="panel" id="approvals" aria-labelledby="h-approvals">
          <ApprovalPanel
            key={approvalRefresh}
            assessmentId={assessment.id}
            isApprover={isApprover}
            onLeadChanged={() => void refreshLead()}
          />
        </section>

        {/* ---------------- notes ---------------- */}
        <section className="panel" id="notes" aria-labelledby="h-notes">
          <div className="panel-head">
            <h2 id="h-notes">Internal notes</h2>
          </div>
          <div className="panel-body">
            <div className="field">
              <textarea
                id="internal-notes"
                aria-label="Internal notes"
                value={notes}
                disabled={!canEdit}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && <div className="notice notice-block">{error}</div>}
            {savedNote && <div className="notice notice-info">{savedNote}</div>}

            {/* No Save button here — it lives in the sticky header now,
                so it is reachable from every section rather than only the
                end of the longest one. */}
            {!canEdit && (
              <div className="notice notice-warn">
                You are not in the <span className="mono">contributor</span> or{' '}
                <span className="mono">approver</span> group, so this record is read-only. Ask an
                administrator to add you to a Cognito group.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Section nav state: which section is highlighted, and how to jump to one.
 *
 * Three things here are deliberate, each fixing a real failure observed in
 * the browser rather than a hypothetical:
 *
 *  1. Clicking a nav item sets the active state IMMEDIATELY and locks the
 *     scroll-spy for the duration of the smooth scroll. Without the lock the
 *     indicator lands on whatever section the threshold happened to pick
 *     mid-animation — clicking "Approvals" lit up "Discovery".
 *  2. When the pane is scrolled to the bottom, the LAST section wins
 *     outright. The final sections can never reach the top of the viewport,
 *     so a pure threshold test can never select them.
 *  3. Scroll is observed with capture:true, because the scroll container is
 *     the detail pane on desktop but the window below 1024px (where the
 *     fixed app frame becomes a normal stacked document). Scroll events do
 *     not bubble, but they are observable during the capture phase.
 */
function useSectionNav(rootRef: React.RefObject<HTMLElement | null>): {
  active: string;
  goTo: (id: string) => void;
} {
  // Plain string, not the SECTIONS literal union — `as const` narrows
  // SECTIONS[0].id to just "overview", which would reject every later id.
  const [active, setActive] = useState<string>(SECTIONS[0].id as string);
  const lockUntil = useRef(0);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const root = rootRef.current;
      if (root === null) return;
      if (performance.now() < lockUntil.current) return;

      const pane = root.closest('[data-scroll-pane]');
      const scroller =
        pane !== null && pane.scrollHeight > pane.clientHeight + 1 ? pane : document.scrollingElement;

      if (
        scroller !== null &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
      ) {
        setActive(SECTIONS[SECTIONS.length - 1].id);
        return;
      }

      // Anything whose top has passed this line counts as the current
      // section. The line has to sit just BELOW the sticky header card,
      // which is MEASURED rather than guessed: its height changes when a
      // long clinic name wraps, and below 900px it is not sticky at all
      // (it scrolls away, giving a negative bottom — hence the floor).
      const head = root.querySelector('.detail-head');
      const line = Math.max(150, (head?.getBoundingClientRect().bottom ?? 0) + 16);
      let current: string = SECTIONS[0].id;
      // `bestTop` breaks ties: if two sections start at the same y (they
      // would, side by side), the EARLIER one in document order wins rather
      // than the later one silently taking over.
      let bestTop = Number.NEGATIVE_INFINITY;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el === null) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= line && top > bestTop + 2) {
          current = s.id;
          bestTop = top;
        }
      }
      setActive(current);
    };

    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [rootRef]);

  const goTo = (id: string) => {
    lockUntil.current = performance.now() + 900;
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return { active, goTo };
}

function toPositiveInt(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function money(v: number | null | undefined): string {
  return typeof v === 'number' ? '$' + v.toLocaleString('en-CA', { maximumFractionDigits: 0 }) : '—';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-CA');
}

