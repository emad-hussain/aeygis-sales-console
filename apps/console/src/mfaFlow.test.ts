import { describe, expect, it } from 'vitest';
import {
  describeVerifyError,
  initialStep,
  isCodeShape,
  mfaReduce,
  normaliseCode,
  statusFrom,
  type MfaStep,
} from './mfaFlow';

/** Drive the reducer through a sequence and return the final step. */
const run = (events: Parameters<typeof mfaReduce>[1][], from: MfaStep = initialStep) =>
  events.reduce(mfaReduce, from);

/** A `scan` step with a known secret, for tests that start mid-flow. */
const scanning = (): MfaStep =>
  run([{ type: 'START' }, { type: 'SETUP_READY', secret: 'ABC123', uri: 'otpauth://totp/x' }], {
    kind: 'idle',
    status: 'off',
    notice: null,
  });

describe('code shape', () => {
  it('accepts six digits, with or without the space authenticator apps show', () => {
    for (const ok of ['123456', '123 456', ' 123456 ']) {
      expect(isCodeShape(ok), ok).toBe(true);
    }
  });

  it('rejects anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', '12345a', '12-34-56']) {
      expect(isCodeShape(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('normalises by stripping whitespace only', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456');
  });
});

describe('status from the pool', () => {
  it('is on only when TOTP is in the enabled list', () => {
    expect(statusFrom(['TOTP'])).toBe('on');
    expect(statusFrom(['SMS'])).toBe('off');
    expect(statusFrom([])).toBe('off');
  });
});

describe('the happy path', () => {
  it('goes idle → starting → scan → idle(on)', () => {
    const s1 = mfaReduce({ kind: 'idle', status: 'off', notice: null }, { type: 'START' });
    expect(s1.kind).toBe('starting');

    const s2 = mfaReduce(s1, { type: 'SETUP_READY', secret: 'S', uri: 'otpauth://x' });
    expect(s2).toMatchObject({ kind: 'scan', secret: 'S', uri: 'otpauth://x', code: '', verifying: false });

    const s3 = mfaReduce(s2, { type: 'CODE_CHANGED', code: '123456' });
    const s4 = mfaReduce(s3, { type: 'VERIFY' });
    expect(s4).toMatchObject({ kind: 'scan', verifying: true, error: null });

    const s5 = mfaReduce(s4, { type: 'VERIFIED' });
    expect(s5).toMatchObject({ kind: 'idle', status: 'on' });
    expect((s5 as { notice: string }).notice).toMatch(/is on/);
  });
});

describe('the shape check before a round trip', () => {
  it('refuses to verify an incomplete code and says so, without leaving scan', () => {
    const s = mfaReduce(
      mfaReduce(scanning(), { type: 'CODE_CHANGED', code: '12' }),
      { type: 'VERIFY' },
    );
    expect(s.kind).toBe('scan');
    if (s.kind === 'scan') {
      expect(s.verifying).toBe(false);
      expect(s.error).toMatch(/six-digit/);
    }
  });

  it('clears the error as soon as the person types again', () => {
    const errored = mfaReduce(scanning(), { type: 'VERIFY' });
    const typed = mfaReduce(errored, { type: 'CODE_CHANGED', code: '1' });
    if (typed.kind === 'scan') expect(typed.error).toBeNull();
    else throw new Error('left scan');
  });

  it('ignores a second VERIFY while one is in flight', () => {
    const inFlight = mfaReduce(
      mfaReduce(scanning(), { type: 'CODE_CHANGED', code: '123456' }),
      { type: 'VERIFY' },
    );
    expect(mfaReduce(inFlight, { type: 'VERIFY' })).toBe(inFlight);
  });
});

describe('verification failures', () => {
  it('keeps the QR on screen for a mistyped code, and clears the code field', () => {
    const inFlight = mfaReduce(
      mfaReduce(scanning(), { type: 'CODE_CHANGED', code: '000000' }),
      { type: 'VERIFY' },
    );
    for (const name of ['CodeMismatchException', 'EnableSoftwareTokenMFAException']) {
      const s = mfaReduce(inFlight, { type: 'VERIFY_FAILED', errorName: name });
      expect(s.kind, name).toBe('scan');
      if (s.kind === 'scan') {
        expect(s.secret, name).toBe('ABC123'); // same setup — no rescan needed
        expect(s.verifying).toBe(false);
        expect(s.code).toBe('');
        expect(s.error).toMatch(/didn't match/);
      }
    }
  });

  it('goes back to idle(off) when the setup itself is gone', () => {
    const inFlight = mfaReduce(
      mfaReduce(scanning(), { type: 'CODE_CHANGED', code: '000000' }),
      { type: 'VERIFY' },
    );
    for (const name of ['SoftwareTokenMFANotFoundException', 'NotAuthorizedException']) {
      const s = mfaReduce(inFlight, { type: 'VERIFY_FAILED', errorName: name });
      expect(s).toMatchObject({ kind: 'idle', status: 'off' });
      expect((s as { notice: string }).notice).not.toBe('');
    }
  });

  it('never shows a bare exception name for the two "wrong code" cases', () => {
    // Cognito reports a bad code during SETUP as EnableSoftwareTokenMFAException,
    // not CodeMismatchException. Handling only one would show the raw name to
    // half the people who mistype.
    for (const name of ['CodeMismatchException', 'EnableSoftwareTokenMFAException']) {
      expect(describeVerifyError(name).message).not.toContain('Exception');
    }
  });

  it('still produces a usable sentence for an exception it has never heard of', () => {
    const d = describeVerifyError('SomethingNewException');
    expect(d.message).toMatch(/SomethingNewException/);
    expect(d.setupStillValid).toBe(true);
  });
});

describe('cancelling and disabling', () => {
  it('cancel from scan returns to idle(off) with no notice', () => {
    expect(mfaReduce(scanning(), { type: 'CANCEL' })).toEqual({
      kind: 'idle',
      status: 'off',
      notice: null,
    });
  });

  it('cancel anywhere else is a no-op', () => {
    const idle: MfaStep = { kind: 'idle', status: 'on', notice: null };
    expect(mfaReduce(idle, { type: 'CANCEL' })).toBe(idle);
  });

  it('can only disable when currently on', () => {
    expect(mfaReduce({ kind: 'idle', status: 'on', notice: null }, { type: 'DISABLE' }).kind).toBe(
      'disabling',
    );
    const off: MfaStep = { kind: 'idle', status: 'off', notice: null };
    expect(mfaReduce(off, { type: 'DISABLE' })).toBe(off);
  });

  it('a failed disable stays ON — the pool was not changed', () => {
    const s = mfaReduce({ kind: 'disabling' }, { type: 'DISABLE_FAILED', message: 'nope' });
    expect(s).toMatchObject({ kind: 'idle', status: 'on', notice: 'nope' });
  });
});

describe('status loading', () => {
  it('a failed status read is UNKNOWN, not off', () => {
    // "off" would invite someone to set up MFA that may already be on.
    const s = mfaReduce({ kind: 'loading' }, { type: 'STATUS_FAILED', message: 'network' });
    expect(s).toMatchObject({ kind: 'idle', status: 'unknown', notice: 'network' });
  });

  it('START is refused while status is unknown or loading', () => {
    // The button is hidden in that state, but the reducer must not rely on it.
    expect(mfaReduce({ kind: 'loading' }, { type: 'START' }).kind).toBe('loading');
  });
});

describe('late responses', () => {
  it('a response for a step the person already left is ignored, not applied', () => {
    // Person cancels while setUpTOTP() is still in flight; the response then
    // arrives. It must not drag them back into `scan`.
    const cancelled = mfaReduce(scanning(), { type: 'CANCEL' });
    const late = mfaReduce(cancelled, { type: 'SETUP_READY', secret: 'late', uri: 'x' });
    expect(late).toBe(cancelled);
  });

  it('never throws on any (step, event) pair', () => {
    const steps: MfaStep[] = [
      initialStep,
      { kind: 'loading' },
      { kind: 'starting' },
      scanning(),
      { kind: 'disabling' },
      { kind: 'idle', status: 'on', notice: null },
    ];
    const events: Parameters<typeof mfaReduce>[1][] = [
      { type: 'LOAD' },
      { type: 'STATUS_LOADED', enabled: [] },
      { type: 'STATUS_FAILED', message: 'm' },
      { type: 'START' },
      { type: 'SETUP_READY', secret: 's', uri: 'u' },
      { type: 'SETUP_FAILED', message: 'm' },
      { type: 'CODE_CHANGED', code: '1' },
      { type: 'VERIFY' },
      { type: 'VERIFIED' },
      { type: 'VERIFY_FAILED', errorName: 'X' },
      { type: 'CANCEL' },
      { type: 'DISABLE' },
      { type: 'DISABLED' },
      { type: 'DISABLE_FAILED', message: 'm' },
    ];
    for (const s of steps) for (const e of events) expect(() => mfaReduce(s, e)).not.toThrow();
  });
});
