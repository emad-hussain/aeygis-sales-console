import { useCallback, useEffect, useRef, useState } from 'react';
import { deliveryStatusLabel } from '@aeygis/domain';
import {
  listDeliveries,
  sendProposalEmail,
  type ProposalDeliveryRecord,
  type ProposalVersionRecord,
} from './client';

interface Props {
  readonly proposalId: string | null;
  /**
   * Already filtered to APPROVED versions by the caller.
   *
   * Passed in rather than re-queried so this block and the approvals table
   * above it cannot disagree about what is approved — two independent reads of
   * the same records can land either side of a decision and offer a Send button
   * for something the table above still shows as pending.
   */
  readonly approvedVersions: readonly ProposalVersionRecord[];
  readonly isApprover: boolean;
  /**
   * Called after a send that actually reached the client.
   *
   * Sending moves the lead's status to `proposed` on the BACKEND, so without
   * this the pill at the top of the page would keep saying "In review" until
   * the next reload — the one moment a person is most certain something just
   * happened is the worst moment to show them stale state.
   *
   * Only fired on `ok`. A blocked or failed attempt changes no status, so
   * telling the parent to re-read would be a request that finds nothing new.
   */
  readonly onLeadChanged?: () => void;
}

const when = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-CA');
};

/** Maps a stored status onto the pill palette. An unknown value gets the neutral pill. */
const pillClass = (status: string | null | undefined) =>
  status === 'sent' || status === 'blocked' || status === 'failed'
    ? `pill status-${status}`
    : 'pill';

/**
 * Sending an approved proposal to the client, and the record of every attempt.
 *
 * Renders INSIDE the approvals panel rather than as a panel of its own. That is
 * deliberate: it needs the same versions and the same decision history the
 * table above it already loaded, and giving it its own section would mean a
 * second independent read of those records — which can land either side of a
 * decision and show the two blocks disagreeing.
 *
 * Three other deliberate choices:
 *
 *  1. SENDING IS ARMED, NOT INSTANT. One click cannot put a document in a
 *     client's inbox. Same two-click pattern the table above uses for reject
 *     and delete, for the same reason: it cannot be undone. This is the only
 *     action in the system that reaches outside the company.
 *
 *  2. A REFUSAL IS NOT AN ERROR. While SES is in the sandbox, `blocked` is the
 *     EXPECTED outcome for a real client address, so it is shown as a warning
 *     with an explanation rather than a red failure. Reading "failed" when the
 *     true answer was "we deliberately refused" sends people debugging a fault
 *     that does not exist.
 *
 *  3. THE FINGERPRINT GOES BACK WITH THE SEND. Same guard the approvals table
 *     uses: the sender is mailing specific bytes, not "whatever is latest". If
 *     a newer version was minted while this screen sat open, the backend
 *     refuses rather than mailing different numbers.
 */
export function DeliveryPanel({ proposalId, approvedVersions, isApprover, onLeadChanged }: Props) {
  const [deliveries, setDeliveries] = useState<ProposalDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  // Two-click arming, matching ApprovalPanel. Self-clears so a stale arm cannot
  // be triggered by an unrelated later click in the same place.
  const [armedSend, setArmedSend] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Which message id was just copied, so the chip can confirm it.
   *
   * The id is the one thing that lets support trace a specific message with
   * AWS, and it is far too long to show in a table column — so it was
   * truncated, which made it unreadable AND unselectable. Displaying it in
   * full would push the column to three wrapped lines. Copying is what anyone
   * actually wants to do with it.
   */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copyMessageId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
    } catch {
      // Clipboard access can be refused — permissions, or a page served over
      // plain HTTP. Select the id instead so it can still be copied by hand.
      // This works precisely because the element holds the WHOLE id and is
      // shortened by CSS: selecting it yields every character, not the
      // fourteen that happen to be visible.
      setCopiedId(null);
      const node = document.querySelector(`[data-message-id="${id}"] .msg-id-value`);
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    }
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1800);
  }

  const disarm = useCallback(() => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedSend(null);
  }, []);

  useEffect(() => () => disarm(), [disarm]);

  const load = useCallback(async () => {
    if (proposalId === null) {
      setDeliveries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDeliveries(await listDeliveries(proposalId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the send history');
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(version: ProposalVersionRecord) {
    disarm();
    setBusyKey(version.versionKey);
    setError(null);
    setNotice(null);
    setRefused(null);
    try {
      const result = await sendProposalEmail({
        proposalId: version.proposalId,
        versionKey: version.versionKey,
        expectedContentSha256: version.contentSha256,
      });

      if (result?.ok) {
        setNotice(result.message ?? 'Sent.');
        onLeadChanged?.();
      } else if (result?.status === 'blocked') {
        setRefused(result.message ?? 'This send was refused.');
      } else {
        setError(result?.message ?? 'The proposal was not sent.');
      }
      // Reloaded either way: blocked and failed attempts are both recorded, and
      // the point of the history is that they are visible.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the proposal');
    } finally {
      setBusyKey(null);
    }
  }

  function handleSendClick(version: ProposalVersionRecord) {
    if (armedSend === version.versionKey) {
      disarm();
      void send(version);
      return;
    }
    setArmedSend(version.versionKey);
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmedSend(null), 4000);
  }

  const hasSent = deliveries.some((d) => d.status === 'sent');

  return (
    <div className="delivery-block">
      <h3 className="sub-head" id="h-delivery">
        Send to client
      </h3>

      {error !== null && <div className="notice notice-block">{error}</div>}
      {refused !== null && <div className="notice notice-warn">{refused}</div>}
      {notice !== null && <div className="notice notice-info">{notice}</div>}

      {approvedVersions.length === 0 ? (
        <p className="hint flush">
          Nothing to send yet. A version has to be <strong>approved</strong> before it can go to
          the client.
        </p>
      ) : !isApprover ? (
        /* Same principle as the approvals table above: explain the requirement
           rather than hide the feature. A missing button teaches nothing, and
           the API is the real boundary regardless of what is rendered. */
        <p className="hint flush">
          Sending requires the <span className="mono">approver</span> group. An approver can send{' '}
          {approvedVersions.length === 1 ? 'this version' : 'one of these versions'} from here.
        </p>
      ) : (
        <>
          <p className="hint flush">
            {hasSent
              ? 'This client has already received a proposal. Sending again delivers the version you pick and is recorded as a separate send.'
              : 'The PDF is attached to the email, which goes to the contact address on this lead.'}
          </p>
          <ul className="send-list">
            {approvedVersions.map((v) => (
              <li key={v.versionKey}>
                <span className="send-version">
                  <span className="mono">{v.versionKey}</span>
                  <span className="tiny muted">
                    {v.tier}
                    {v.supportPlan ? ` / ${v.supportPlan}` : ''}
                    {' · '}
                    <span className="mono" title={v.contentSha256 ?? ''}>
                      {(v.contentSha256 ?? '').slice(0, 12)}…
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className={armedSend === v.versionKey ? 'danger' : ''}
                  disabled={busyKey !== null}
                  onClick={() => handleSendClick(v)}
                  onBlur={() => armedSend === v.versionKey && disarm()}
                  title={
                    armedSend === v.versionKey
                      ? 'Click again to email this to the client — it cannot be unsent'
                      : 'Email this version to the client'
                  }
                >
                  {busyKey === v.versionKey
                    ? 'Sending…'
                    : armedSend === v.versionKey
                      ? `Send ${v.versionKey} to the client?`
                      : 'Send to client'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="sub-head">Send history</h4>
      {loading ? (
        <p className="muted flush">Loading…</p>
      ) : deliveries.length === 0 ? (
        <p className="hint flush">Nothing has been sent for this proposal.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Version</th>
                <th>Outcome</th>
                <th>To</th>
                <th>By</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={`${d.versionKey}-${d.sentAt}`}>
                  <td>{when(d.sentAt)}</td>
                  <td className="mono">{d.versionKey}</td>
                  <td>
                    <span className={pillClass(d.status)}>{deliveryStatusLabel(d.status)}</span>
                  </td>
                  <td>
                    {d.recipient ?? '—'}
                    {d.bcc ? (
                      <>
                        <br />
                        <span className="tiny muted">bcc {d.bcc}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="tiny">{d.sentByEmail ?? d.sentBy}</td>
                  <td className="tiny">
                    {/* A refused row carries the reason; a sent row carries the
                        id AWS assigns to the message.

                        The id is LABELLED rather than shown bare. On its own it
                        reads as a random string and gets ignored — but it is the
                        one thing that lets support trace a specific message with
                        AWS when a client says they never received it. Hover for
                        the full value; the visible part is only a handle. */}
                    {d.failureReason ? (
                      <span className="muted">{d.failureReason}</span>
                    ) : d.messageId ? (
                      <button
                        type="button"
                        className="ghost msg-id"
                        data-message-id={d.messageId}
                        onClick={() => void copyMessageId(d.messageId as string)}
                        title={`Click to copy\n${d.messageId}`}
                      >
                        <span className="msg-id-label">
                          {copiedId === d.messageId ? 'copied' : 'SES id'}
                        </span>
                        {/* The FULL id is in the DOM and shortened by CSS, not
                            by slicing the string. Slicing made it unreadable
                            and unselectable at once — you could not even drag
                            over it to copy the part that was hidden. With
                            text-overflow the ellipsis is presentation only, so
                            a selection still picks up every character. */}
                        <span className="mono msg-id-value">{d.messageId}</span>
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
