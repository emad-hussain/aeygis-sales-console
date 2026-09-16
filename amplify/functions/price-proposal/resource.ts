import { defineFunction } from '@aws-amplify/backend';

/**
 * Mints an immutable ProposalVersion and freezes a client-safe snapshot to S3.
 *
 * Sole writer of ProposalVersion. Staff have read-only access to that model, so
 * a proposal cannot be hand-edited into existence with figures that never came
 * out of the pricing engine.
 */
export const priceProposal = defineFunction({
  name: 'price-proposal',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 512,
  runtime: 22,
});
