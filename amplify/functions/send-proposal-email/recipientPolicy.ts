/**
 * Who this system is allowed to email.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * This guard was written while the SES account was in the sandbox, where AWS
 * only delivered to addresses a human had verified — so a send aimed at a real
 * prospect would have failed anyway.
 *
 * The original note said: "it would fail anyway" is not a safety property. It
 * stops being true the moment production access is granted, and at that point
 * every previously-safe mistake becomes a real email to a real clinic.
 *
 * ── THAT MOMENT ARRIVED ON 2026-09-16 ──────────────────────────────────────
 * Production access was granted. AWS's sandbox is no longer a second,
 * independent guard sitting behind this one. **This list is now the only thing
 * between a mistake and a real clinic's inbox**, which is exactly the situation
 * the file was written for — and the reason it lives in code rather than in the
 * accident of which account tier we happen to be on.
 *
 * The refusal message no longer mentions the sandbox. It used to explain a
 * refusal by citing an AWS account state, and that explanation became false the
 * day access was granted while still being shown to staff. Product copy must not
 * state anything that can go stale — see gotcha §16.30.
 *
 * PURE ON PURPOSE. A handler that imports the Amplify data client connects to
 * AWS the moment it loads, so anything defined inside one cannot be unit-tested
 * without credentials — and a safety check that cannot be tested is a safety
 * check that does not get tested. Same reasoning as functions/shared/identity.ts.
 *
 * ============================================================================
 * FAIL CLOSED — the correction that produced this shape
 * ============================================================================
 *
 * The Phase 5 plan originally said the allowlist would be "emptied" to go live.
 * Writing this file showed that to be wrong, and quietly dangerous:
 *
 *   If EMPTY meant "no restriction", then an unset environment variable — a
 *   typo in a deploy, a new environment nobody finished wiring, a variable
 *   dropped during a refactor — would silently mean "email anyone".
 *
 * An absent setting must never be the permissive one. So:
 *
 *   nothing configured  -> block everything          (the safe direction)
 *   '*'                 -> allow everything          (explicit, deliberate)
 *   'a@x.com,b@y.com'   -> allow exactly those two
 *
 * Going live is therefore setting SES_ALLOWED_RECIPIENTS to '*', which is a
 * visible, greppable, obviously-intentional act — not the absence of one.
 */

/** The one value that turns the guard off. Deliberately not '' and not 'all'. */
export const ALLOW_ALL = '*';

export type Allowlist =
  /** Nothing configured. Block everything — see the fail-closed note above. */
  | { readonly kind: 'none' }
  /** Explicitly unrestricted. Production, after SES production access. */
  | { readonly kind: 'all' }
  /** Exactly these addresses, compared case-insensitively. */
  | { readonly kind: 'list'; readonly addresses: readonly string[] };

export interface RecipientVerdict {
  readonly allowed: boolean;
  /** Plain-English reason, written to ProposalDelivery.failureReason. Null when allowed. */
  readonly reason: string | null;
  /** Which addresses caused the refusal. Never includes an address that passed. */
  readonly blocked: readonly string[];
}

/**
 * Lowercases and trims an address FOR COMPARISON ONLY.
 *
 * The original spelling is what gets sent — a clinic that typed
 * `Reception@Clinic.ca` should see their own capitalisation in the To field.
 * Only the matching is case-insensitive.
 *
 * (Strictly, RFC 5321 makes the local part case-sensitive. No mail provider in
 * practice treats it that way, and SES identity verification is itself
 * case-insensitive, so matching case-sensitively here would block addresses
 * that SES would happily accept.)
 */
export function normaliseAddress(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * A deliberately conservative sanity check, NOT an RFC 5322 validator.
 *
 * Full email validation is a well-known rabbit hole and gets no safer the more
 * of it you write. All this needs to do is refuse the things that would make an
 * SES call fail or, worse, make an allowlist comparison meaningless: empty
 * values, missing or repeated `@`, nothing either side of it, embedded
 * whitespace.
 *
 * Anything that fails is treated as BLOCKED rather than passed through — we do
 * not send to an address we cannot even parse.
 */
export function looksLikeAnAddress(raw: string | null | undefined): boolean {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return false;
  if (/\s/.test(value)) return false;

  const parts = value.split('@');
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  if (local === undefined || domain === undefined) return false;
  if (local === '' || domain === '') return false;
  // A domain with no dot is not reachable from the public internet. Rejecting
  // it catches the common paste error (`someone@gmail` with the .com lost).
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;

  return true;
}

/**
 * Reads the SES_ALLOWED_RECIPIENTS setting.
 *
 * Accepts commas, semicolons, or whitespace as separators, because a value
 * typed by a human into a deploy config will eventually use all three.
 */
export function parseAllowlist(raw: string | null | undefined): Allowlist {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { kind: 'none' };
  if (value === ALLOW_ALL) return { kind: 'all' };

  const addresses = value
    .split(/[,;\s]+/)
    .map((entry) => normaliseAddress(entry))
    .filter((entry) => entry !== '');

  // A value that was set but parsed to nothing (e.g. ',,,') is a misconfiguration,
  // not permission. Fall back to the safe direction rather than the convenient one.
  if (addresses.length === 0) return { kind: 'none' };

  return { kind: 'list', addresses };
}

/**
 * Decides whether every recipient of a message may be emailed.
 *
 * ALL recipients are checked, not just the client. In the SES sandbox a single
 * unverified address anywhere in To, CC or BCC causes AWS to reject the whole
 * message, so checking only the primary recipient would produce a failure whose
 * cause is invisible in the console.
 *
 * The verdict is all-or-nothing by design: there is no partial send. Emailing
 * the internal BCC copy of a proposal the client never received would put a
 * misleading record in a staff inbox.
 */
export function checkRecipients(
  addresses: readonly (string | null | undefined)[],
  allowlist: Allowlist,
): RecipientVerdict {
  const present = addresses.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );

  if (present.length === 0) {
    return {
      allowed: false,
      reason: 'No recipient address is recorded for this clinic.',
      blocked: [],
    };
  }

  const malformed = present.filter((entry) => !looksLikeAnAddress(entry));
  if (malformed.length > 0) {
    return {
      allowed: false,
      reason: `Not a usable email address: ${malformed.join(', ')}.`,
      blocked: malformed,
    };
  }

  if (allowlist.kind === 'none') {
    return {
      allowed: false,
      reason:
        'Sending is restricted to an approved list of addresses, and no list is configured. ' +
        'Set SES_ALLOWED_RECIPIENTS to the addresses that may be emailed, or to * once SES ' +
        'production access has been granted.',
      blocked: present,
    };
  }

  if (allowlist.kind === 'all') {
    return { allowed: true, reason: null, blocked: [] };
  }

  const blocked = present.filter(
    (entry) => !allowlist.addresses.includes(normaliseAddress(entry)),
  );

  if (blocked.length > 0) {
    return {
      allowed: false,
      reason:
        `Not on the approved recipient list: ${blocked.join(', ')}. ` +
        'Nothing was sent. This was refused on purpose, not attempted and failed — ' +
        'add the address to the approved list if it should be reachable.',
      blocked,
    };
  }

  return { allowed: true, reason: null, blocked: [] };
}
