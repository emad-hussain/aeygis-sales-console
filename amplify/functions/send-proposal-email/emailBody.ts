/**
 * The message a client receives with their proposal.
 *
 * ============================================================================
 * EVERY VALUE HERE COMES FROM THE FROZEN SNAPSHOT
 * ============================================================================
 *
 * The caller sources clinicName, contactName, validUntil and the reference from
 * the SAME S3 snapshot the PDF was rendered from — the object whose hash the
 * approval is bound to. Nothing is recomputed.
 *
 * That is deliberate. If the email worked out its own "pricing held until" date
 * it would eventually state a different one from the document attached to it,
 * and the client would be looking at two dates from the same company. Reading
 * both from one immutable source makes disagreement impossible rather than
 * unlikely.
 *
 * ============================================================================
 * NO FIGURES IN THE BODY
 * ============================================================================
 *
 * The email carries no prices, no totals, no discounts and no internal
 * language. Partly because the numbers belong in the document where they have
 * their context and caveats — a bare figure in an email is quotable out of
 * context. Mostly because Aeygis_Cloud_Rate_Card.pdf is confidential, and the
 * least error-prone rule is "this file never states money at all". The test
 * beside this one enforces it.
 *
 * PURE ON PURPOSE — no AWS imports, so it can be tested without credentials.
 */

/** Longest clinic slug allowed in a filename, so a long name cannot push it past SES's 255. */
const MAX_SLUG_LENGTH = 60;

export interface ProposalEmailInput {
  /** From the snapshot. May be absent — an assessment can arrive without one. */
  readonly clinicName: string | null | undefined;
  /** From the snapshot. May be absent. */
  readonly contactName: string | null | undefined;
  /** e.g. 'v0003'. Used to keep saved attachments distinguishable. */
  readonly versionKey: string;
  /** From the snapshot: `${proposalId}-${versionKey}`. Quoted back in support conversations. */
  readonly proposalReference: string;
  /** From the snapshot, already formatted. NEVER recomputed here. */
  readonly validUntil: string;
  /**
   * Whether a proposal for this client has gone out before.
   *
   * Derived from the delivery history, NOT from the version number. Staff often
   * iterate through several versions internally and send only the last, so
   * `versionNumber > 1` does not mean the client ever saw an earlier one —
   * calling that "updated" would be telling them about a document they never
   * received.
   */
  readonly previouslySent: boolean;
}

export interface ProposalEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachmentFileName: string;
}

/**
 * Escapes text for inclusion in HTML.
 *
 * Not optional politeness: a clinic name is free text a stranger typed into a
 * public form. "Smith & Sons Family Health" would break the markup, and a name
 * containing a tag would be worse than broken.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trims, and returns null for anything blank, so callers get one "absent" value. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Flattens a value to one line before it is used in a mail HEADER.
 *
 * The subject line carries the clinic name, which is free text typed into a
 * public form. A carriage return or newline inside a header value is the
 * classic header-injection shape: everything after it can be read as a new
 * header, which is how an attacker adds their own Bcc.
 *
 * SESv2 builds the MIME itself from structured input, so it is not relied upon
 * to be exploitable — but "the SDK probably handles it" is not a reason to pass
 * a newline into a header. Control characters are replaced rather than
 * stripped, so words either side of one do not silently run together.
 */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Turns a clinic name into something safe to use as a filename.
 *
 * Accents, slashes, colons and quotes all appear in real clinic names and all
 * cause trouble somewhere between SES, a mail client and a Windows desktop. The
 * result is deliberately plain ASCII with single hyphens.
 */
export function fileNameSlug(value: string | null | undefined): string {
  const raw = present(value);
  if (raw === null) return '';
  return raw
    .normalize('NFKD')
    // Strip combining accents, so "Clinique Santé" becomes "Clinique Sante"
    // rather than "Clinique Sant-". NFKD splits "é" into "e" + a combining
    // mark; removing the mark leaves the letter. Written as an explicit
    // codepoint range (U+0300–U+036F) rather than pasted combining characters,
    // which are invisible in an editor and easy to mangle in a diff.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * The attachment's filename, as the client sees it in their mail client.
 *
 * Carries the clinic name and the version so that a client who saves two
 * revisions ends up with two files rather than one overwriting the other.
 */
export function attachmentFileName(
  clinicName: string | null | undefined,
  versionKey: string,
): string {
  const slug = fileNameSlug(clinicName);
  const version = fileNameSlug(versionKey);
  const parts = ['Aeygis-Cloud-Proposal', slug, version].filter((part) => part !== '');
  return `${parts.join('-')}.pdf`;
}

/**
 * Builds the subject, both bodies, and the attachment name.
 *
 * A plain-text body is sent alongside the HTML one, not instead of it. Some
 * clients (and most security gateways that rewrite mail) show the text part,
 * and a proposal that arrives as a blank message with an attachment reads as
 * spam.
 */
export function buildProposalEmail(input: ProposalEmailInput): ProposalEmail {
  const clinic = present(input.clinicName);
  const contact = present(input.contactName);

  // singleLine, because this becomes a mail HEADER and `clinic` is free text
  // from a public form. See the note on singleLine.
  const subject = singleLine(
    [
      input.previouslySent
        ? 'Your updated Aeygis cloud migration proposal'
        : 'Your Aeygis cloud migration proposal',
      clinic === null ? null : `— ${clinic}`,
    ]
      .filter((part) => part !== null)
      .join(' '),
  );

  // "Hello there," rather than a guessed first name. Splitting a full name to
  // find one gets it wrong for compound surnames and for anyone who entered a
  // title, and getting somebody's name wrong in the first line of a sales
  // email is worse than being slightly formal.
  const greeting = contact === null ? 'Hello,' : `Hello ${contact},`;

  const opening = input.previouslySent
    ? 'An updated version of your cloud migration proposal is attached. It replaces the one we sent previously.'
    : 'Thank you for completing the Aeygis cloud readiness assessment. Your cloud migration proposal is attached.';

  const contents =
    'It sets out where your practice stands today, the migration approach we recommend, ' +
    'an indicative schedule, the service levels you would be covered by, and what Aeygis ' +
    'and your clinic are each responsible for.';

  const validity = `The pricing in the proposal is held until ${input.validUntil}.`;

  const closing =
    'If anything needs clarifying, or you would like to walk through it together, ' +
    'reply to this email and we will arrange a time.';

  const reference = `Reference: ${input.proposalReference}`;

  const text = [
    greeting,
    '',
    opening,
    '',
    contents,
    '',
    validity,
    '',
    closing,
    '',
    'Aeygis',
    '',
    reference,
    '',
  ].join('\n');

  // Inline styles only. Mail clients routinely strip <style> blocks, and the
  // artifact CSP-style rules of email are stricter still: no external anything.
  const p = 'margin:0 0 16px;';
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;`,
    `font-size:15px;line-height:1.6;color:#1c1f24;max-width:34em;">`,
    `<p style="${p}">${escapeHtml(greeting)}</p>`,
    `<p style="${p}">${escapeHtml(opening)}</p>`,
    `<p style="${p}">${escapeHtml(contents)}</p>`,
    `<p style="${p}">${escapeHtml(validity)}</p>`,
    `<p style="${p}">${escapeHtml(closing)}</p>`,
    `<p style="${p}">Aeygis</p>`,
    `<p style="margin:24px 0 0;font-size:12px;color:#636870;">`,
    `${escapeHtml(reference)}</p>`,
    `</div>`,
  ].join('');

  return {
    subject,
    text,
    html,
    attachmentFileName: attachmentFileName(clinic, input.versionKey),
  };
}
