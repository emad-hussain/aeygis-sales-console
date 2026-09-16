import { defineFunction } from '@aws-amplify/backend';

/**
 * The approval gate. Sole writer of `Approval` and `AuditEvent`.
 *
 * Both models have create/update/delete removed from the schema entirely, so no
 * signed-in user can forge, alter, or erase a decision even by calling the API
 * directly. This function writes them via IAM.
 *
 * Small and short-lived: it reads a version, re-hashes an S3 object, and writes
 * two records. A long invocation means something is wrong, not slow.
 */
export const decideProposal = defineFunction({
  name: 'decide-proposal',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 512,
  runtime: 22,
});
