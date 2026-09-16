import { defineStorage } from '@aws-amplify/backend';
import { priceProposal } from '../functions/price-proposal/resource.js';
import { renderProposalPdf } from '../functions/render-proposal-pdf/resource.js';
import { decideProposal } from '../functions/decide-proposal/resource.js';
import { deleteProposalVersion } from '../functions/delete-proposal-version/resource.js';
import { sendProposalEmail } from '../functions/send-proposal-email/resource.js';

/**
 * Proposal artifact storage.
 *
 * Three prefixes with deliberately different reach. The split is the fourth of
 * the five confidentiality barriers: the PDF renderer's IAM role simply has no
 * ARN for the internal prefix, so it cannot read internal material even if a
 * future code change tried to.
 *
 *   snapshots/          Frozen, client-safe JSON. The ONLY input to the renderer.
 *                       Immutable once written — a proposal is approved against a
 *                       specific snapshot hash, so rewriting one would silently
 *                       change what was approved.
 *
 *   proposals/client/   Client-facing PDFs. Versioning is enabled on the bucket,
 *                       so a regenerated proposal never destroys its predecessor.
 *
 *   proposals/internal/ Internal-only material (margin working, cost notes).
 *                       renderProposalPdf is ABSENT here on purpose. Approvers
 *                       only — a contributor negotiating a discount should not
 *                       see the margin floor.
 *
 * NOTE on API shape: in `defineStorage`, `allow.guest` and `allow.authenticated`
 * are PROPERTIES (`allow.guest.to([...])`), whereas in `defineData` they are
 * FUNCTION CALLS (`allow.guest().to([...])`). Mixing them up produces a
 * confusing type error.
 *
 * There is no `allow.guest` anywhere below. Public users get zero S3 access.
 */
export const storage = defineStorage({
  name: 'aeygisProposals',
  isDefault: true,
  // Survives `ampx sandbox delete` on purpose: generated proposals and their
  // approval trail should not vanish with an ephemeral dev stack.
  keepOnDelete: true,
  access: (allow) => ({
    'snapshots/*': [
      allow.groups(['contributor', 'approver']).to(['read']),
      allow.resource(priceProposal).to(['read', 'write']),
      allow.resource(renderProposalPdf).to(['read']),
      // decide-proposal RE-HASHES the stored snapshot at approval time, so it
      // needs read. It never writes: an approval must not be able to alter the
      // thing being approved.
      allow.resource(decideProposal).to(['read']),
      // DELETE ONLY — deliberately not 'write'. This function removes the
      // artifacts of a discarded draft; it has no business rewriting a
      // snapshot, which is the object an approval's hash is bound to.
      allow.resource(deleteProposalVersion).to(['delete']),
      // send-proposal-email re-hashes the snapshot before mailing anything, for
      // the same reason decide-proposal does at approval time — the version
      // record is immutable but the S3 object it points at is a separate thing.
      // It also reads the frozen validity date out of it so the email cannot
      // state a different one from the PDF. Read only: sending must not be able
      // to alter what was approved.
      allow.resource(sendProposalEmail).to(['read']),
    ],
    'proposals/client/*': [
      allow.groups(['contributor', 'approver']).to(['read']),
      allow.resource(renderProposalPdf).to(['read', 'write']),
      allow.resource(deleteProposalVersion).to(['delete']),
      // Reads the rendered PDF to attach it. Read only — it never produces or
      // replaces a document, only delivers one.
      allow.resource(sendProposalEmail).to(['read']),
    ],
    'proposals/internal/*': [
      // Approvers only, and the renderer is deliberately not listed.
      allow.groups(['approver']).to(['read']),
      allow.resource(priceProposal).to(['read', 'write']),
      // send-proposal-email is ABSENT here on purpose, exactly as the renderer
      // is. It composes a client-facing message and attaches a client-facing
      // document; giving it an ARN for internal margin working would undo the
      // fourth confidentiality barrier for the sake of an access it never uses.
    ],
  }),
});
