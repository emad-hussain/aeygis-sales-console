import { useCallback, useEffect, useRef, useState } from 'react';
import { DeliveryPanel } from './DeliveryPanel';
import {
  decideProposal,
  discardProposalVersion,
  getPdfUrl,
  listApprovals,
  listProposalVersions,
  type ApprovalRecord,
  type ProposalVersionRecord,
} from './client';

interface Props {
  readonly assessmentId: string;
  readonly isApprover: boolean;
  /** Forwarded to DeliveryPanel — see its Props for why it exists. */
  readonly onLeadChanged?: () => void;
}

const cad = (n: number | null | undefined) =>
  typeof n === 'number' ? '$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 }) : '—';

const when = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-CA');
};

/**
 * Proposal versions and their approval decisions.
 *
 * Three things this UI does deliberately:
 *
 *  1. It shows the CONTENT FINGERPRINT next to each version and sends it back as
 *     `expectedContentSha256`. If a newer version was minted while the approver
 *     was reading, the backend refuses instead of approving different numbers.
 *     The approver is approving specific bytes, not "the latest".
 *
 *  2. It never hides the approve control from a contributor by pretending the
 *     feature does not exist — it explains that approval requires the approver
 *     group. Hiding a button is not a permission model; the API is the boundary.
 *
 *  3. It shows the decision history in full, including who decided and which
 *     groups they held AT THAT MOMENT. Membership changes later; the record does
 *     not.
 */
export function ApprovalPanel({ assessmentId, isApprover, onLeadChanged }: Props) {
  const [versions, setVersions] = useState<ProposalVersionRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pdfLoadingKey, setPdfLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Rejection is destructive and, per the design brief for this pass, must not
  // fire on a single click. armedReject holds the versionKey pending a second,
  // confirming click; it self-clears after a few seconds so a stale arm can't
  // be triggered by an unrelated later click in the same spot.
  const [armedReject, setArmedReject] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deletion is irreversible, so it gets the SAME two-click arming as reject —
  // and more of it: the confirm label names the version explicitly, because
  // this row is about to stop existing rather than gain a status.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmReject = useCallback(() => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedReject(null);
  }, []);

  const disarmDelete = useCallback(() => {
    if (deleteTimer.current !== null) clearTimeout(deleteTimer.current);
    deleteTimer.current = null;
    setArmedDelete(null);
  }, []);

  useEffect(() => () => disarmReject(), [disarmReject]);
  useEffect(() => () => disarmDelete(), [disarmDelete]);

  function handleRejectClick(version: ProposalVersionRecord) {
    if (armedReject === version.versionKey) {
      disarmReject();
      void decide(version, 'rejected');
      return;
    }
    setArmedReject(version.versionKey);
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmedReject(null), 4000);
  }

  function handleDeleteClick(version: ProposalVersionRecord) {
    if (armedDelete === version.versionKey) {
      disarmDelete();
      void remove(version);
      return;
    }
    setArmedDelete(version.versionKey);
    if (deleteTimer.current !== null) clearTimeout(deleteTimer.current);
    deleteTimer.current = setTimeout(() => setArmedDelete(null), 4000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const vs = await listProposalVersions(assessmentId);
      setVersions(vs);
      // Approvals are keyed by proposalId, which is shared across versions.
      const proposalId = vs[0]?.proposalId ?? null;
      setApprovals(proposalId === null ? [] : await listApprovals(proposalId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load proposals');
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(version: ProposalVersionRecord, decision: 'approved' | 'rejected') {
    disarmReject();
    setBusyKey(version.versionKey);
    setError(null);
    setNotice(null);
    try {
      const result = await decideProposal({
        proposalId: version.proposalId,
        versionKey: version.versionKey,
        decision,
        // The whole point: bind the decision to the bytes shown on screen.
        expectedContentSha256: version.contentSha256,
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      if (result?.ok) {
        setNotice(result.message ?? 'Decision recorded.');
        setReason('');
        await load();
      } else {
        setError(result?.message ?? 'The decision was not recorded.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the decision');
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Permanently deletes a version.
   *
   * The button is only rendered for versions this screen believes are not
   * approved, but that is a convenience, not the control: the backend re-reads
   * the decision history and refuses an approved version regardless of what
   * this component thought. If that refusal comes back, it is shown as-is
   * rather than translated — it explains the rule better than a generic error.
   */
  async function remove(version: ProposalVersionRecord) {
    disarmDelete();
    setBusyKey(version.versionKey);
    setError(null);
    setNotice(null);
    try {
      const result = await discardProposalVersion({
        proposalId: version.proposalId,
        versionKey: version.versionKey,
      });
      if (result?.ok) {
        setNotice(result.message ?? `Deleted ${version.versionKey}.`);
        await load();
      } else {
        setError(result?.message ?? 'The version was not deleted.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the version');
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Opens the rendered PDF in a new tab via a short-lived presigned URL.
   *
   * Always attempted, for every version — ProposalVersion.pdfS3Key is never
   * populated (see client.ts), so there is no reliable "has a PDF" flag to
   * gate this on. getPdfUrl() itself checks S3 directly and returns null if
   * rendering has not finished yet, which is shown as a notice rather than
   * a dead click.
   *
   * The URL is fetched fresh on every click rather than cached — it expires
   * in 5 minutes (see getPdfUrl in client.ts), so a URL fetched an hour ago
   * would silently 403 instead of opening. Fetch-on-click means it is always
   * fresh at the moment it is used.
   *
   * window.open() is called SYNCHRONOUSLY inside the click handler for the
   * synchronous case, but this is async — Safari/Chrome popup blockers can
   * flag a window.open() that happens after an await as not
   * user-initiated. Opening a blank tab immediately and redirecting it once
   * the URL resolves keeps the whole thing inside the original user gesture.
   *
   * NO 'noopener'/'noreferrer' here — verified in a real browser, not
   * assumed: either one makes window.open() return null UNCONDITIONALLY,
   * not just when a popup is actually blocked. The earlier version passed
   * both, so `tab` was always null, every click fell into the "popup
   * blocked" branch below, and the CURRENT tab got navigated to the PDF —
   * while the real blank tab the browser had already opened sat abandoned,
   * which is exactly the "opens in the same tab AND a blank new tab"
   * symptom this was shipped with. Dropping them is a deliberate, narrow
   * trade: the destination is always an S3-hosted PDF this app generated
   * the signed URL for, not arbitrary content, so the reverse-tabnabbing
   * risk noopener guards against does not apply here.
   */
  async function openPdf(version: ProposalVersionRecord) {
    const tab = window.open('', '_blank');
    setPdfLoadingKey(version.versionKey);
    setError(null);
    setNotice(null);
    try {
      const url = await getPdfUrl(version.proposalId, version.versionKey);
      if (url === null) {
        tab?.close();
        setNotice(`${version.versionKey} is still rendering — try again in a few seconds.`);
        return;
      }
      if (tab) {
        tab.location.href = url;
      } else {
        // Popup blocked despite the synchronous open — fall back to a
        // same-tab navigation the user can back out of, rather than a
        // silently swallowed click.
        window.location.href = url;
      }
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'Could not open the PDF');
    } finally {
      setPdfLoadingKey(null);
    }
  }

  const latestDecisionFor = (versionKey: string): ApprovalRecord | undefined =>
    approvals
      .filter((a) => a.versionKey === versionKey)
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];

  /**
   * Versions whose LATEST decision is 'approved', which is what may be sent.
   *
   * Latest rather than "has ever been approved": a decision can be reversed by
   * a later record, and an approval that was subsequently rejected must not
   * leave a version sendable. The backend re-checks this same way — the list
   * here decides what is OFFERED, not what is permitted.
   */
  const approvedVersions = versions.filter(
    (v) => latestDecisionFor(v.versionKey)?.decision === 'approved',
  );

  return (
    <>
      <div className="panel-head">
        <h2>Approvals</h2>
        <span className="note">
          {loading ? 'loading…' : `${versions.length} version${versions.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="panel-body">
      {loading && <p className="muted flush">Loading…</p>}
      {error && <div className="notice notice-block">{error}</div>}
      {notice && <div className="notice notice-info">{notice}</div>}

      {!loading && versions.length === 0 && (
        <p className="hint flush">
          No proposal versions yet. Confirm the exact provider and location counts in{' '}
          <strong>Scope</strong>, then generate a proposal from <strong>Pricing</strong> — versions
          are immutable once created.
        </p>
      )}

      {versions.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Tier / plan</th>
                <th className="num">Setup</th>
                <th className="num">Monthly</th>
                <th>Fingerprint</th>
                <th>Decision</th>
                {/* Always present now: delete is available to both roles, so
                    this column is no longer approver-only. */}
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => {
                const decided = latestDecisionFor(v.versionKey);
                /* Approved is a TERMINAL state for a version, so the row stops
                   offering ways to change it.

                   A version is immutable and Approval is append-only: you do
                   not revise an approved proposal, you mint a new version and
                   approve that instead. Re-approving would simply append a
                   second identical decision, and "rejecting" one would leave
                   two contradictory records with no way to say which governs.
                   Neither is a thing anyone means to do, so neither is offered.

                   Rejected is deliberately NOT terminal: a rejection reversed
                   by a later approval is a legitimate sequence the append-only
                   log records honestly, so those rows keep their buttons. */
                const isApproved = decided?.decision === 'approved';
                return (
                  <tr key={v.versionKey}>
                    <td className="mono">{v.versionKey}</td>
                    <td>
                      {v.tier}
                      {v.supportPlan ? <span className="tiny muted"> / {v.supportPlan}</span> : null}
                      {v.requiresExecutiveSignOff && (
                        <>
                          <br />
                          <span className="pill status-needs_confirmation">exec sign-off</span>
                        </>
                      )}
                    </td>
                    <td className="num">{cad(v.setupTotal)}</td>
                    <td className="num">{cad(v.monthlyTotal)}</td>
                    <td className="mono tiny" title={v.contentSha256 ?? ''}>
                      {(v.contentSha256 ?? '').slice(0, 12)}…
                    </td>
                    <td>
                      {decided ? (
                        <>
                          <span
                            className={`pill status-${decided.decision === 'approved' ? 'proposed' : 'closed'}`}
                          >
                            {decided.decision}
                          </span>
                          <br />
                          {/* Who and when. The groups the approver held at the
                              moment of the decision are still WRITTEN to the
                              Approval record and still in the audit trail —
                              they are just not shown here. On screen they were
                              a third line of small print restating what the
                              presence of an approval already implies, since
                              only an approver can produce one. */}
                          <span className="tiny muted">
                            {decided.decidedByEmail ?? decided.decidedBy}
                            <br />
                            {when(decided.decidedAt)}
                          </span>
                        </>
                      ) : (
                        /* A neutral pill, not plain text: "approved" and
                           "rejected" both render as pills, so an undecided
                           version reading as bare grey text made it look like
                           a different KIND of thing rather than a different
                           state. */
                        <span className="pill">pending</span>
                      )}
                    </td>
                    <td>
                      {/* Wrapping cluster: buttons in one cell used to push the
                          table into a horizontal scroll on a narrow pane. */}
                      <div className="row-actions">
                      {/* View PDF leads the cluster: it is the only read-only
                          action here, and the only one every role can use. The
                          consequential controls stay to its right with Delete
                          last, so the further right you travel the harder the
                          click is to undo.

                          Not gated on v.pdfS3Key — that field is never populated
                          (see getPdfUrl in client.ts). openPdf() checks S3
                          directly and reports "still rendering" on its own. */}
                      <button
                        type="button"
                        className="secondary"
                        disabled={pdfLoadingKey === v.versionKey}
                        onClick={() => void openPdf(v)}
                      >
                        {pdfLoadingKey === v.versionKey ? 'Checking…' : 'View PDF'}
                      </button>
                      {isApprover && !isApproved && (
                        <>
                          <button
                            disabled={busyKey !== null}
                            onClick={() => void decide(v, 'approved')}
                          >
                            {busyKey === v.versionKey ? 'Approving…' : 'Approve'}
                          </button>
                          <button
                            className={armedReject === v.versionKey ? 'danger' : 'secondary'}
                            disabled={busyKey !== null}
                            onClick={() => handleRejectClick(v)}
                            onBlur={() => armedReject === v.versionKey && disarmReject()}
                            title={
                              armedReject === v.versionKey
                                ? 'Click again to confirm — this cannot be undone'
                                : 'Reject this version'
                            }
                          >
                            {busyKey === v.versionKey
                              ? 'Rejecting…'
                              : armedReject === v.versionKey
                                ? 'Confirm reject?'
                                : 'Reject'}
                          </button>
                        </>
                      )}
                      {/* Same rule as above, and for delete the backend
                          enforces it too: it refuses to remove an approved
                          version. Not rendering the button keeps the screen
                          honest rather than offering an action that would
                          always fail. */}
                      {!isApproved && (
                        <button
                          className={armedDelete === v.versionKey ? 'danger' : 'secondary'}
                          disabled={busyKey !== null}
                          onClick={() => handleDeleteClick(v)}
                          onBlur={() => armedDelete === v.versionKey && disarmDelete()}
                          title={
                            armedDelete === v.versionKey
                              ? `Click again to permanently delete ${v.versionKey}`
                              : 'Permanently delete this version and its PDF'
                          }
                        >
                          {busyKey === v.versionKey
                            ? 'Deleting…'
                            : armedDelete === v.versionKey
                              ? `Delete ${v.versionKey}?`
                              : 'Delete'}
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {versions.length > 0 && isApprover && (
        <div className="field decision-reason">
          <label htmlFor="decision-reason">Reason (recorded with the decision)</label>
          <input
            id="decision-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional for an approval; strongly preferred for a rejection"
          />
        </div>
      )}

      {versions.length > 0 && !isApprover && (
        <div className="notice notice-warn">
          Recording a decision requires the <span className="mono">approver</span> group. This is
          enforced by the API, not by this screen — the buttons are hidden because they would fail,
          not as the permission check itself.
        </div>
      )}

      {approvals.length > 0 && (
        <details className="history">
          <summary className="tiny muted">
            Full decision history ({approvals.length})
          </summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Version</th>
                  <th>Decision</th>
                  <th>By</th>
                  <th>Fingerprint approved</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((a) => (
                  <tr key={a.id}>
                    <td className="tiny">{when(a.decidedAt)}</td>
                    <td className="mono tiny">{a.versionKey}</td>
                    <td className="tiny">{a.decision}</td>
                    <td className="tiny">{a.decidedByEmail ?? a.decidedBy}</td>
                    <td className="mono tiny">{(a.contentSha256 ?? '').slice(0, 12)}…</td>
                    <td className="tiny">{a.reason ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Delivery lives inside this panel, not beside it, so it reads from the
          SAME versions and decisions loaded above. A separate section would
          mean a second independent query that can land either side of a
          decision and show the two blocks disagreeing about what is approved. */}
      {!loading && (
        <DeliveryPanel
          proposalId={versions[0]?.proposalId ?? null}
          approvedVersions={approvedVersions}
          isApprover={isApprover}
          onLeadChanged={onLeadChanged}
        />
      )}
      </div>
    </>
  );
}
