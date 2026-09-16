import { defineFunction } from '@aws-amplify/backend';

/**
 * Permanently deletes a proposal version that has not been approved.
 *
 * THE SOLE ROUTE TO A DELETE. `deleteProposalVersion` exists on the
 * ProposalVersion model only so this function can call it — staff hold
 * `.to(['read'])` and nothing more, so the refusal rule implemented here
 * cannot be bypassed by calling the model mutation directly from the console.
 *
 * Small and short-lived: read a version, read its decisions, delete two S3
 * objects and one row, write one audit record.
 */
export const deleteProposalVersion = defineFunction({
  name: 'delete-proposal-version',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 512,
  runtime: 22,
});
