import { useCallback, useEffect, useMemo, useState } from 'react';
import { Authenticator, Button, ThemeProvider, useAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { assessmentStatusLabel } from '@aeygis/domain';
import { useRole } from './useRole';
import { listAssessments, type AssessmentRecord } from './client';
import { AssessmentDetail } from './AssessmentDetail';
import { AuthBrandPanel } from './AuthBrandPanel';
import { ToastProvider } from './Toast';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import { authFormFields, consoleAuthTheme } from './authTheme';
import aeygisMark from './assets/aeygis-mark.png';

/** Slots inside the Authenticator card. Deliberately minimal — the card's
 * own heading is rendered outside the Authenticator (see SignIn), so this
 * only carries the forgot-password link. */
const authComponents = {
  SignIn: {
    Footer() {
      const { toForgotPassword } = useAuthenticator();
      return (
        <div className="auth-card-footer">
          <Button fontWeight="normal" onClick={toForgotPassword} size="small" variation="link">
            Forgot your password?
          </Button>
        </div>
      );
    },
  },
};

export default function App() {
  return (
    <ThemeProvider theme={consoleAuthTheme}>
      {/* Authenticator.Provider makes useAuthenticator available to AuthGate,
          which decides whether to mount the Authenticator UI at all — that is
          what lets the signed-out screen use Porcelain's split layout instead
          of being confined to the Authenticator's single-column shell. */}
      <Authenticator.Provider>
        <ToastProvider>
          <AuthGate />
        </ToastProvider>
      </Authenticator.Provider>
    </ThemeProvider>
  );
}

function AuthGate() {
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);

  if (authStatus === 'authenticated') {
    return <Console />;
  }

  return <SignIn />;
}

/**
 * Card copy per Authenticator route.
 *
 * The Authenticator is one component that renders many screens — sign-in,
 * forgot password, the reset-code form, an MFA challenge. The heading lives
 * in OUR card, outside its DOM, so it has to follow the route or the card
 * would cheerfully say "Sign in" above a password-reset form.
 *
 * Keyed by string rather than the AuthenticatorRoute union so a route added
 * by a future Amplify release falls back to the sign-in copy instead of
 * failing to compile. The union is confirmed in
 * @aws-amplify/ui/dist/types/helpers/authenticator/facade.d.ts.
 */
const ROUTE_COPY: Record<string, { readonly title: string; readonly sub: string }> = {
  signIn: { title: 'Sign in', sub: 'Welcome back — use your staff account.' },
  forgotPassword: {
    title: 'Reset password',
    sub: 'Enter your work email and we will send a confirmation code.',
  },
  confirmResetPassword: {
    title: 'Choose a new password',
    sub: 'Enter the code we emailed you, then set a new password.',
  },
  confirmSignIn: { title: 'Confirm sign-in', sub: 'Enter the verification code to continue.' },
  forceNewPassword: {
    title: 'Set a password',
    sub: 'This account needs a new password before it can be used.',
  },
  setupTotp: { title: 'Set up authenticator', sub: 'Scan the code with your authenticator app.' },
  setupEmail: { title: 'Confirm your email', sub: 'Verify this address before continuing.' },
  selectMfaType: {
    title: 'Choose a method',
    sub: 'Pick how you would like to verify this sign-in.',
  },
  signInSelectAuthFactor: { title: 'Choose a method', sub: 'Pick how you would like to sign in.' },
  passkeyPrompt: { title: 'Use your passkey', sub: 'Confirm with the passkey on this device.' },
  verifyUser: { title: 'Verify your account', sub: 'Choose where to send a verification code.' },
  confirmVerifyUser: { title: 'Enter the code', sub: 'Check your inbox for the verification code.' },
};

function SignIn() {
  const { route } = useAuthenticator((context) => [context.route]);
  const copy = ROUTE_COPY[route] ?? ROUTE_COPY.signIn;

  return (
    <div className="auth-shell">
      <AuthBrandPanel />

      <main className="auth-formside">
        <div className="auth-toggle">
          <ThemeToggle />
        </div>
        <div>
          <div className="auth-card">
            <h2>{copy.title}</h2>
            <p className="sub">{copy.sub}</p>
            {/* Sign-up is disabled: staff accounts are provisioned by an
                administrator and placed in a Cognito group. Open
                self-registration on an internal console holding confidential
                client data would be an obvious hole. */}
            <Authenticator hideSignUp formFields={authFormFields} components={authComponents} />
          </div>
          <p className="auth-footnote">Confidential &middot; Aeygis Health internal systems</p>
        </div>
      </main>
    </div>
  );
}

function Console() {
  const { user } = useAuthenticator((context) => [context.user]);
  const { loading: roleLoading, role, groups, email, name } = useRole();

  const [assessments, setAssessments] = useState<AssessmentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canEdit = role === 'contributor' || role === 'approver';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listAssessments();
      setAssessments(rows);
      setSelectedId((current) => current ?? rows[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load assessments');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = useCallback((updated: AssessmentRecord) => {
    setAssessments((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  /* Filters are derived from the loaded rows, not a second API call — the
     counts are real and always agree with the list because they come from
     one source. */
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assessments) {
      const key = a.status ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [assessments]);

  const visible = useMemo(
    () =>
      statusFilter === 'all' ? assessments : assessments.filter((a) => a.status === statusFilter),
    [assessments, statusFilter],
  );

  const selected = assessments.find((a) => a.id === selectedId) ?? null;

  /* Definitively in no group — as opposed to "the role has not resolved yet",
     which also reads as 'none'. The distinction matters below: treating the
     unresolved state as a real answer suppressed the queue's error message
     during the window before the role arrived. */
  const roleIsNone = !roleLoading && role === 'none';

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="brand">
          <span className="brand-tile">
            <img src={aeygisMark} alt="" width="19" height="19" />
          </span>
          <span className="brand-word">
            Aeygis Health
            <span>Sales console</span>
          </span>
        </div>

        <div className="topbar-spacer" />

        {/* An account in no Cognito group is a broken state, not a label —
            it stays visible rather than waiting to be found inside the menu. */}
        {roleIsNone && <span className="pill pill-none">no role</span>}
        <ThemeToggle />
        {/* Identity, role, groups and Sign out all live behind the initials. */}
        <UserMenu
          email={email ?? user?.username ?? null}
          name={name}
          role={role}
          roleLoading={roleLoading}
          groups={groups}
        />
      </header>

      <div className="layout">
        <section className="queue-pane" aria-label="Intake queue">
          <header className="pane-head">
            <h1>Intake queue</h1>
            {/* Says what it counts. A bare "8" floated between a heading and a
                button reads as a stray number rather than a total — and when a
                filter is on it becomes "3 of 8", which needs the noun even
                more. `title` carries the same thing for screen readers. */}
            <span
              className="count"
              title={
                statusFilter === 'all'
                  ? `${visible.length} lead${visible.length === 1 ? '' : 's'} in the queue`
                  : `${visible.length} of ${assessments.length} leads match this filter`
              }
            >
              {loading
                ? '—'
                : `${visible.length}${statusFilter === 'all' ? '' : ` of ${assessments.length}`}`}
              <span className="count-label">
                {' '}
                lead{visible.length === 1 && statusFilter === 'all' ? '' : 's'}
              </span>
            </span>
            {/* No class — the default accent, matching Save changes, which is
                the other "this pane's main action" button. It was `ghost`,
                whose entire effect is to strip the background, border and
                shadow, so the one control in this header rendered as plain
                text rather than as something clickable. */}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              title="Reload the queue"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </header>

          {assessments.length > 0 && (
            <div className="filter-chips" role="group" aria-label="Filter by status">
              <button
                type="button"
                className="chip"
                aria-current={statusFilter === 'all'}
                onClick={() => setStatusFilter('all')}
              >
                All
                <span className="chip-n">{assessments.length}</span>
              </button>
              {[...statusCounts.entries()].map(([status, count]) => (
                <button
                  key={status}
                  type="button"
                  className="chip"
                  aria-current={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                >
                  <span className={`nav-dot status-${status}`} />
                  {assessmentStatusLabel(status)}
                  <span className="chip-n">{count}</span>
                </button>
              ))}
            </div>
          )}

          {loading && <QueueSkeleton />}

          {/* Every non-loading outcome has to render SOMETHING. It used not
              to: an error while the role was 'none' matched none of the
              branches below, so the queue pane went completely blank — no
              skeleton, no message, nothing to act on. The raw AppSync
              authorization string is still withheld when the account is
              genuinely in no group, because the detail pane explains that
              properly; but the pane says so rather than showing nothing. */}
          {error && !loading && !roleIsNone && (
            <div className="empty-state">
              <div className="notice notice-block">{error}</div>
            </div>
          )}

          {error && !loading && roleIsNone && (
            <div className="empty-state">
              <p>Nothing to show.</p>
              <p className="hint">
                Your account is in no Cognito group, so the API refuses to list assessments. The
                panel on the right explains what an administrator needs to do.
              </p>
            </div>
          )}

          {!loading && !error && assessments.length === 0 && (
            /* KEEP THIS GENERIC.
             *
             * It once read: "The dual-write on health.aeygis.com is currently
             * inert - AEYGIS_API_ENDPOINT is an empty string... See pending item
             * P2." Four claims, all of them false by the time anyone read it,
             * and one of them a reference to an internal tracker item.
             *
             * The fix is not to keep that copy accurate. It is to not state
             * things here that can go out of date: no project status, no
             * environment detail, no terminal commands, no pending-item
             * numbers. This is a product screen read by sales staff, not a
             * README, and anything specific enough to be useful for one week is
             * specific enough to be wrong the next.
             *
             * Where a lead comes from and why one has not arrived belong in the
             * documentation, which is versioned and reviewed. */
            <div className="empty-state">
              <p>No assessments yet.</p>
              <p className="hint">
                New submissions appear here automatically. Use <strong>Refresh</strong> to check
                for the latest.
              </p>
            </div>
          )}

          {!loading && visible.length > 0 && (
            <ul className="queue-list">
              {visible.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="queue-item"
                    aria-current={a.id === selectedId}
                    onClick={() => setSelectedId(a.id)}
                  >
                    <span className="qi-top">
                      <span className="qi-head">
                        <span className="qi-name">{a.clinicName ?? '—'}</span>
                        <span className="qi-ref">
                          {a.referenceId} &middot; {shortDate(a.submittedAt)}
                        </span>
                        {a.contactName ? <span className="qi-contact">{a.contactName}</span> : null}
                      </span>
                      <span className={`pill status-${a.status}`}>
                        {assessmentStatusLabel(a.status)}
                      </span>
                    </span>

                    <span className="qi-stats">
                      <span className="qi-stat">
                        <b>{a.providerCount ?? a.providerBand ?? '—'}</b>
                        <span>providers</span>
                      </span>
                      <span className="qi-stat">
                        <b>{a.locationCount ?? a.locationBand ?? '—'}</b>
                        <span>locations</span>
                      </span>
                      <span className="qi-stat">
                        <b>{compactMoney(a.monthlyItSpend)}</b>
                        <span>IT / mo</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!loading && assessments.length > 0 && visible.length === 0 && (
            <div className="empty-state">
              No assessments with status “{assessmentStatusLabel(statusFilter)}”.
            </div>
          )}
        </section>

        <main className="detail-pane" data-scroll-pane>
          {roleIsNone ? (
            <div className="detail-body">
              <div className="panel">
                <div className="panel-body">
                  <div className="notice notice-block">
                    Your account is in no Cognito group
                    {groups.length > 0 ? ` (groups: ${groups.join(', ')})` : ''}, so everything is
                    read-only. An administrator must add you to{' '}
                    <span className="mono">contributor</span> or{' '}
                    <span className="mono">approver</span>.
                  </div>
                </div>
              </div>
            </div>
          ) : selected ? (
            <AssessmentDetail
              key={selected.id}
              assessment={selected}
              canEdit={canEdit}
              isApprover={role === 'approver'}
              onSaved={onSaved}
            />
          ) : (
            <div className="detail-body">
              <div className="panel">
                <div className="panel-body">
                  <p className="muted">Select an assessment from the queue to review it.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/** Placeholder cards shaped like real queue items. The shape of what is
 * coming is itself information, and it holds the layout still instead of a
 * jump when the rows arrive. */
function QueueSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div className="skeleton-item" key={i}>
          <span className="skeleton-bar" style={{ width: '62%' }} />
          <span className="skeleton-bar skeleton-bar-sm" style={{ width: '44%' }} />
          <span className="skeleton-bar skeleton-bar-sm" style={{ width: '100%' }} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Money for a 3-across stat tile, where the full figure would not fit.
 *
 * Rounds toward readability, not precision — the exact spend is on the
 * detail pane. 11500 reads "$11.5k", 74000 reads "$74k": the decimal is
 * dropped once it stops carrying information at this size.
 */
function compactMoney(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `$${m >= 100 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (v >= 1000) {
    const k = v / 1000;
    return `$${k >= 100 || Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `$${v.toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;
}

/** "18 Aug" — the queue card has no room for a full timestamp, and the
 *  detail head shows the exact one anyway. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short' });
}
