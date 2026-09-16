import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'aws-amplify/auth';
import type { Role } from './useRole';

interface Props {
  readonly email: string | null;
  /** The `name` claim, when the pool issues one. Usually null — see below. */
  readonly name: string | null;
  readonly role: Role;
  readonly roleLoading: boolean;
  readonly groups: readonly string[];
}

/**
 * The signed-in user: initials in the top bar, details and sign-out behind a
 * click.
 *
 * Sign out lives in here rather than beside it. It is a rare, disruptive
 * action, and a bare "Sign out" sitting permanently in the chrome is easy to
 * hit by accident next to controls people use all day.
 */
export function UserMenu({ email, name, role, roleLoading, groups }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Escape closes and hands focus back; a click anywhere else just closes.
  // Both are registered only while open, so there is no always-on listener.
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) close(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  // Focus moves into the panel on open, so a keyboard user is not left behind
  // on the trigger with the panel open in front of them.
  useEffect(() => {
    if (open) panelRef.current?.querySelector('button')?.focus();
  }, [open]);

  const initials = initialsFor(name ?? email);
  const roleLabel = roleLoading ? 'checking…' : role === 'none' ? 'no role' : role;

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="avatar"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Your account — ${email ?? 'signed in'}, ${roleLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        {initials}
      </button>

      {open && (
        <div className="user-panel" ref={panelRef} role="dialog" aria-label="Your account">
          <div className="user-id">
            <span className="avatar avatar-lg" aria-hidden="true">
              {initials}
            </span>
            <span className="user-id-text">
              <b>{displayName(name, email)}</b>
              <span className="mono">{email ?? 'unknown address'}</span>
            </span>
          </div>

          <dl className="user-facts">
            <div>
              <dt>Role</dt>
              <dd>
                <span className={`pill pill-${role}`}>{roleLabel}</span>
              </dd>
            </div>
            <div>
              <dt>Groups</dt>
              <dd className="mono">{groups.length > 0 ? groups.join(', ') : 'none'}</dd>
            </div>
          </dl>

          <button type="button" className="secondary user-signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A human-readable name.
 *
 * Prefers a real `name` claim, but this pool does not issue one — the ID
 * token carries only sub, email, email_verified and cognito:groups (checked
 * against a live token, not assumed). So the fallback title-cases the email's
 * local part: `emad.hussain@` reads "Emad Hussain".
 *
 * That is a derivation, not a fact, which is why the address itself sits
 * directly beneath it — the reader can always see what it came from. If the
 * pool later gains a name attribute, that wins with no change here.
 */
function displayName(name: string | null, email: string | null): string {
  if (name !== null && name.trim() !== '') return name.trim();
  const words = localPart(email).split(/[^a-zA-Z0-9]+/).filter((w) => w !== '');
  if (words.length === 0) return 'Signed in';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Two initials. A single word falls back to its first two letters rather than
 * one, because a lone letter in a 34px circle reads as a bullet.
 */
function initialsFor(identity: string | null): string {
  const parts = localPart(identity).split(/[^a-zA-Z0-9]+/).filter((w) => w !== '');
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

const localPart = (identity: string | null): string => (identity ?? '').split('@')[0] ?? '';
