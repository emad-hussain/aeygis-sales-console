import { useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

/**
 * Reads the signed-in user's Cognito groups.
 *
 * IMPORTANT — this is for UI shaping ONLY. Hiding a button is not a security
 * control: anyone can call the API directly. Authorisation is enforced server
 * side by `allow.groups([...])` on the data model and, from Phase 4, by the
 * approver check inside `decide-proposal`.
 *
 * Groups come from the ID token's `cognito:groups` claim, so they reflect
 * membership at sign-in. A user added to `approver` mid-session must sign out
 * and back in — which is also why `Approval` records snapshot the approver's
 * groups at decision time rather than resolving them later.
 */

export type Role = 'approver' | 'contributor' | 'none';

export interface RoleState {
  readonly loading: boolean;
  readonly role: Role;
  readonly groups: readonly string[];
  readonly email: string | null;
  /**
   * The `name` claim, or null.
   *
   * This pool does not currently issue one — a live ID token carries only
   * sub, email, email_verified, cognito:groups and the cognito:* role claims.
   * Read anyway so that adding the attribute later needs no code change; the
   * UI falls back to deriving a name from the address.
   */
  readonly name: string | null;
  readonly userId: string | null;
}

export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>({
    loading: true,
    role: 'none',
    groups: [],
    email: null,
    name: null,
    userId: null,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await fetchAuthSession();
        const payload = session.tokens?.idToken?.payload ?? {};
        const raw = payload['cognito:groups'];
        const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];
        const email = typeof payload['email'] === 'string' ? payload['email'] : null;
        const userId = typeof payload['sub'] === 'string' ? payload['sub'] : null;

        // `name`, or given + family if the pool is configured that way.
        // NOT cognito:username — on this pool that claim is the sub UUID, not
        // anything a person would recognise.
        const given = typeof payload['given_name'] === 'string' ? payload['given_name'] : '';
        const family = typeof payload['family_name'] === 'string' ? payload['family_name'] : '';
        const joined = `${given} ${family}`.trim();
        const name =
          typeof payload['name'] === 'string' && payload['name'].trim() !== ''
            ? payload['name']
            : joined !== ''
              ? joined
              : null;

        // Approver outranks contributor when a user holds both.
        const role: Role = groups.includes('approver')
          ? 'approver'
          : groups.includes('contributor')
            ? 'contributor'
            : 'none';

        if (!cancelled) setState({ loading: false, role, groups, email, name, userId });
      } catch {
        if (!cancelled) {
          setState({ loading: false, role: 'none', groups: [], email: null, name: null, userId: null });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
