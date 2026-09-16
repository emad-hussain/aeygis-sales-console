import { useEffect, useReducer, useRef, useState } from 'react';
import {
  fetchMFAPreference,
  setUpTOTP,
  updateMFAPreference,
  verifyTOTPSetup,
} from 'aws-amplify/auth';
import { toDataURL } from 'qrcode';
import { initialStep, isCodeShape, mfaReduce, normaliseCode, type MfaStep } from './mfaFlow';

/** Shown in the authenticator app as the account label, beside the email. */
const ISSUER = 'Aeygis Sales Console';

/** Big enough to scan from a laptop screen with a phone, small enough to fit the panel. */
const QR_PX = 168;

interface Props {
  /** The signed-in address. Becomes the account name inside the authenticator app. */
  readonly email: string | null;
}

/**
 * Two-factor enrolment, inside the account panel.
 *
 * The decisions live in mfaFlow.ts and are tested there. This component does
 * three things and tries to do nothing else: call Amplify, dispatch what came
 * back, and render the current step.
 *
 * ── THE TWO CALLS THAT BOTH HAVE TO HAPPEN ─────────────────────────────────
 * verifyTOTPSetup() proves the person captured the secret. It does NOT make
 * Cognito challenge them at sign-in — that needs updateMFAPreference() as
 * well, and without it the account is "verified" and still password-only.
 * Both are awaited before VERIFIED is dispatched, so the on-screen "on" is
 * only ever shown once it is true.
 *
 * ── WHY THE SECRET IS SHOWN AS TEXT TOO ────────────────────────────────────
 * The QR is a convenience. Every authenticator app also accepts the key typed
 * by hand, and the QR renderer is a canvas call that can fail (no canvas in
 * some webviews, a blocked data: URL). If it does, the text key is the whole
 * flow rather than a dead end.
 */
export function MfaSetup({ email }: Props) {
  const [step, dispatch] = useReducer(mfaReduce, initialStep);
  const codeRef = useRef<HTMLInputElement | null>(null);

  /* What does the pool say about this account right now?
   *
   * Gated on `email`, which comes from the ID token — so its presence means the
   * session has tokens. Without the gate, opening the panel in the first
   * moments after sign-in (before useRole has resolved) fired this against an
   * empty session; it rejected locally in ~5 ms with no request ever sent, and
   * the row settled on "unknown" with no way back short of closing and
   * reopening. Found by a headless check that clicked the avatar the instant
   * it rendered, which is a thing a fast human does too. */
  useEffect(() => {
    dispatch({ type: 'LOAD' });
    if (email === null) return undefined;
    let cancelled = false;
    fetchMFAPreference()
      .then((pref) => {
        if (!cancelled) dispatch({ type: 'STATUS_LOADED', enabled: pref.enabled ?? [] });
      })
      .catch((e: unknown) => {
        if (!cancelled) dispatch({ type: 'STATUS_FAILED', message: describe(e, 'read your two-factor status') });
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  // The code field takes focus as soon as there is a QR to scan — the next
  // keystroke after scanning is the code.
  useEffect(() => {
    if (step.kind === 'scan' && !step.verifying) codeRef.current?.focus();
  }, [step.kind, step.kind === 'scan' ? step.verifying : false]);

  async function start() {
    dispatch({ type: 'START' });
    try {
      const details = await setUpTOTP();
      dispatch({
        type: 'SETUP_READY',
        secret: details.sharedSecret,
        uri: details.getSetupUri(ISSUER, email ?? undefined).toString(),
      });
    } catch (e: unknown) {
      dispatch({ type: 'SETUP_FAILED', message: describe(e, 'start two-factor setup') });
    }
  }

  async function verify(current: Extract<MfaStep, { kind: 'scan' }>) {
    dispatch({ type: 'VERIFY' });
    if (!isCodeShape(current.code)) return; // the reducer has already set the message
    try {
      await verifyTOTPSetup({ code: normaliseCode(current.code) });
      await updateMFAPreference({ totp: 'PREFERRED' });
      dispatch({ type: 'VERIFIED' });
    } catch (e: unknown) {
      dispatch({ type: 'VERIFY_FAILED', errorName: errorNameOf(e) });
    }
  }

  async function disable() {
    dispatch({ type: 'DISABLE' });
    try {
      await updateMFAPreference({ totp: 'DISABLED' });
      dispatch({ type: 'DISABLED' });
    } catch (e: unknown) {
      dispatch({ type: 'DISABLE_FAILED', message: describe(e, 'turn off two-factor authentication') });
    }
  }

  // ── scanning ──────────────────────────────────────────────────────────────
  if (step.kind === 'scan') {
    return (
      <div className="mfa mfa-scan" aria-live="polite">
        <p className="mfa-lead">
          Scan this with an authenticator app, then enter the six-digit code it shows.
        </p>

        <QrImage uri={step.uri} />

        <p className="mfa-key-label">Or type this key into the app:</p>
        <code className="mfa-key mono">{groupKey(step.secret)}</code>

        <form
          className="mfa-verify"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(step);
          }}
        >
          <label htmlFor="mfa-code" className="visually-hidden">
            Six-digit code
          </label>
          <input
            ref={codeRef}
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="123 456"
            value={step.code}
            disabled={step.verifying}
            onChange={(e) => dispatch({ type: 'CODE_CHANGED', code: e.target.value })}
            aria-invalid={step.error !== null}
            aria-describedby={step.error !== null ? 'mfa-error' : undefined}
          />
          {step.error !== null && (
            <p id="mfa-error" className="notice notice-warn mfa-notice" role="alert">
              {step.error}
            </p>
          )}
          <div className="row-actions">
            <button type="button" className="secondary" disabled={step.verifying} onClick={() => dispatch({ type: 'CANCEL' })}>
              Cancel
            </button>
            <button type="submit" disabled={step.verifying || !isCodeShape(step.code)}>
              {step.verifying ? 'Checking…' : 'Turn on'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ── everything else is a status row with one action ───────────────────────
  const busy = step.kind === 'loading' || step.kind === 'starting' || step.kind === 'disabling';
  const status = step.kind === 'idle' ? step.status : 'unknown';
  const notice = step.kind === 'idle' ? step.notice : null;

  return (
    <div className="mfa">
      <div className="mfa-row">
        <span className={`pill mfa-pill-${status}`}>
          {step.kind === 'loading'
            ? 'checking…'
            : step.kind === 'starting'
              ? 'starting…'
              : step.kind === 'disabling'
                ? 'turning off…'
                : status === 'on'
                  ? 'on'
                  : status === 'off'
                    ? 'off'
                    : 'unknown'}
        </span>

        {status === 'off' && (
          <button type="button" className="secondary mfa-action" disabled={busy} onClick={() => void start()}>
            Set up
          </button>
        )}
        {status === 'on' && (
          <button type="button" className="secondary mfa-action" disabled={busy} onClick={() => void disable()}>
            Turn off
          </button>
        )}
      </div>

      {notice !== null && (
        <p className={`notice ${status === 'on' ? 'notice-info' : 'notice-warn'} mfa-notice`} aria-live="polite">
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * The QR, rendered to a data: URL. Falls back to nothing — the text key
 * beneath it is always present, so a failed render loses convenience, not
 * the ability to enrol.
 */
function QrImage({ uri }: { readonly uri: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    toDataURL(uri, { width: QR_PX, margin: 1 })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (src === null) return null;
  return <img className="mfa-qr" src={src} width={QR_PX} height={QR_PX} alt="QR code for your authenticator app" />;
}

/** "ABCDEFGHIJKLMNOP" → "ABCD EFGH IJKL MNOP". Easier to type from a screen. */
function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Cognito errors carry their exception name in `name`. Anything else is a
 * transport or programming error, and the reducer's default branch handles an
 * unfamiliar name honestly rather than pretending it was a wrong code.
 */
function errorNameOf(e: unknown): string {
  return e instanceof Error && e.name !== '' ? e.name : 'UnknownError';
}

function describe(e: unknown, what: string): string {
  const detail = e instanceof Error && e.message !== '' ? ` (${e.message})` : '';
  return `Could not ${what}${detail}.`;
}
