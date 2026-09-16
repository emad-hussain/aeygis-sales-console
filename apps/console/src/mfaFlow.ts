/**
 * The two-factor enrolment flow, as a pure state machine.
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL
 * ============================================================================
 *
 * The user pool has MFA set to OPTIONAL. With OPTIONAL, Cognito never prompts
 * anyone to enrol — the Authenticator only forces TOTP setup when the pool is
 * REQUIRED. Opting in happens AFTER sign-in, through setUpTOTP() and
 * updateMFAPreference(), and those need a screen to be called from. Without
 * one, "MFA is enabled on the pool" is a true statement that protects nobody.
 *
 * This file is that screen's logic, with the screen itself in MfaSetup.tsx.
 *
 * ============================================================================
 * PURE ON PURPOSE
 * ============================================================================
 *
 * Every Amplify call happens in the component. This module only decides what
 * state follows from what event, so the whole flow — including every error
 * path — is unit-tested without a browser or a Cognito pool. The component is
 * kept thin enough that there is very little left in it to be wrong.
 *
 * Same reasoning as amplify/functions/submit-assessment/salvage.ts: the
 * decisions live where they can be tested, the I/O lives where it must.
 */

/** Whether TOTP is currently active on the signed-in account. */
export type MfaStatus = 'unknown' | 'off' | 'on';

export type MfaStep =
  /** Nothing in progress. `status` is what the pool reports for this user. */
  | { readonly kind: 'idle'; readonly status: MfaStatus; readonly notice: string | null }
  /** fetchMFAPreference() in flight. */
  | { readonly kind: 'loading' }
  /** setUpTOTP() in flight — Cognito is minting a secret. */
  | { readonly kind: 'starting' }
  /**
   * The secret exists on Cognito's side and is shown to the person. They
   * have not proven they captured it yet. Cancelling here is harmless: an
   * unverified TOTP association does nothing and is replaced by the next
   * setUpTOTP() call.
   */
  | {
      readonly kind: 'scan';
      readonly secret: string;
      readonly uri: string;
      readonly code: string;
      readonly error: string | null;
      readonly verifying: boolean;
    }
  /** updateMFAPreference({ totp: 'DISABLED' }) in flight. */
  | { readonly kind: 'disabling' };

export type MfaEvent =
  | { readonly type: 'LOAD' }
  | { readonly type: 'STATUS_LOADED'; readonly enabled: readonly string[] }
  | { readonly type: 'STATUS_FAILED'; readonly message: string }
  | { readonly type: 'START' }
  | { readonly type: 'SETUP_READY'; readonly secret: string; readonly uri: string }
  | { readonly type: 'SETUP_FAILED'; readonly message: string }
  | { readonly type: 'CODE_CHANGED'; readonly code: string }
  | { readonly type: 'VERIFY' }
  | { readonly type: 'VERIFIED' }
  | { readonly type: 'VERIFY_FAILED'; readonly errorName: string }
  | { readonly type: 'CANCEL' }
  | { readonly type: 'DISABLE' }
  | { readonly type: 'DISABLED' }
  | { readonly type: 'DISABLE_FAILED'; readonly message: string };

export const initialStep: MfaStep = { kind: 'idle', status: 'unknown', notice: null };

/**
 * A TOTP code is six digits. Spaces are tolerated because authenticator apps
 * display codes as "123 456" and people copy them that way.
 *
 * This is a SHAPE check, not verification — it stops an obviously incomplete
 * entry making a round trip to Cognito. The server remains the only authority
 * on whether the code is right.
 */
export function normaliseCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function isCodeShape(raw: string): boolean {
  return /^[0-9]{6}$/.test(normaliseCode(raw));
}

/** What fetchMFAPreference()'s `enabled` list says about TOTP. */
export function statusFrom(enabled: readonly string[]): MfaStatus {
  return enabled.includes('TOTP') ? 'on' : 'off';
}

/**
 * Cognito's exception name for a failed verification, as a sentence a person
 * can act on.
 *
 * The names are Cognito's own — see VerifySoftwareTokenException in the
 * installed @aws-amplify/auth types. Two of them mean "wrong code": Cognito
 * reports a bad code during setup as EnableSoftwareTokenMFAException rather
 * than CodeMismatchException, and a screen that only handled one of the two
 * would show a raw exception name to half the people who mistype.
 *
 * Returns whether the setup is still usable, because that decides where the
 * flow goes next: a mistyped code keeps the QR on screen for another try; an
 * expired setup cannot be retried and has to start over.
 */
export function describeVerifyError(errorName: string): {
  readonly message: string;
  readonly setupStillValid: boolean;
} {
  switch (errorName) {
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return {
        message:
          "That code didn't match. Codes change every 30 seconds — enter the one showing now.",
        setupStillValid: true,
      };
    case 'TooManyRequestsException':
      return {
        message: 'Too many attempts. Wait a minute, then try the current code.',
        setupStillValid: true,
      };
    case 'SoftwareTokenMFANotFoundException':
      return {
        message: 'That setup expired before it was confirmed. Start again to get a new code.',
        setupStillValid: false,
      };
    case 'NotAuthorizedException':
      return {
        message: 'Your session has expired. Sign out, sign back in, and try again.',
        setupStillValid: false,
      };
    default:
      return {
        message: `Could not confirm the code (${errorName}). Try again, or start over.`,
        setupStillValid: true,
      };
  }
}

/**
 * The transition table. Unknown (step, event) pairs return the step unchanged
 * rather than throwing — a late-arriving response from a step the person has
 * already left must not crash the panel.
 */
export function mfaReduce(step: MfaStep, event: MfaEvent): MfaStep {
  switch (event.type) {
    case 'LOAD':
      return { kind: 'loading' };

    case 'STATUS_LOADED':
      return { kind: 'idle', status: statusFrom(event.enabled), notice: null };

    case 'STATUS_FAILED':
      // Unknown, not "off". Showing "off" here would invite someone to set it
      // up when it may already be on.
      return { kind: 'idle', status: 'unknown', notice: event.message };

    case 'START':
      return step.kind === 'idle' ? { kind: 'starting' } : step;

    case 'SETUP_READY':
      return step.kind === 'starting'
        ? { kind: 'scan', secret: event.secret, uri: event.uri, code: '', error: null, verifying: false }
        : step;

    case 'SETUP_FAILED':
      return step.kind === 'starting' ? { kind: 'idle', status: 'off', notice: event.message } : step;

    case 'CODE_CHANGED':
      // Typing clears a stale error — the previous message was about a
      // previous code.
      return step.kind === 'scan' ? { ...step, code: event.code, error: null } : step;

    case 'VERIFY':
      if (step.kind !== 'scan' || step.verifying) return step;
      if (!isCodeShape(step.code)) {
        return { ...step, error: 'Enter the six-digit code from your authenticator app.' };
      }
      return { ...step, verifying: true, error: null };

    case 'VERIFIED':
      return step.kind === 'scan'
        ? { kind: 'idle', status: 'on', notice: 'Two-factor authentication is on for your account.' }
        : step;

    case 'VERIFY_FAILED': {
      if (step.kind !== 'scan') return step;
      const { message, setupStillValid } = describeVerifyError(event.errorName);
      return setupStillValid
        ? { ...step, verifying: false, error: message, code: '' }
        : { kind: 'idle', status: 'off', notice: message };
    }

    case 'CANCEL':
      // Only from `scan`. An unverified TOTP association is inert.
      return step.kind === 'scan' ? { kind: 'idle', status: 'off', notice: null } : step;

    case 'DISABLE':
      return step.kind === 'idle' && step.status === 'on' ? { kind: 'disabling' } : step;

    case 'DISABLED':
      return step.kind === 'disabling'
        ? { kind: 'idle', status: 'off', notice: 'Two-factor authentication is off.' }
        : step;

    case 'DISABLE_FAILED':
      return step.kind === 'disabling' ? { kind: 'idle', status: 'on', notice: event.message } : step;
  }
}
