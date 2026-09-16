/**
 * Re-sends ONE already-approved proposal version. ⛔ Sends a real email.
 *
 * Exists so a delivery problem can be re-tested without running the whole
 * verify:email walk, which creates two more leads and two more proposals every
 * time. Re-sending is a supported operation — every attempt is its own
 * `ProposalDelivery` row, so the history stays honest about how many went out.
 *
 * Usage:
 *   npm run resend -- <proposalId> <versionKey>
 *   npm run resend                      # picks the newest approved version
 */
import { readFileSync, existsSync } from 'node:fs';
import { Amplify } from 'aws-amplify';
import { signIn, signOut } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';

const credsPath = new URL('../.test-credentials.json', import.meta.url);
if (!existsSync(credsPath)) {
  console.error('Missing .test-credentials.json — create the test users first.');
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
Amplify.configure(outputs);

const unwrap = (r, what) => {
  if (r.errors?.length) throw new Error(`${what}: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.data;
};

await signIn({ username: creds.approver.username, password: creds.approver.password });
const client = generateClient({ authMode: 'userPool' });

let [proposalId, versionKey] = process.argv.slice(2);

if (!proposalId || !versionKey) {
  // Find the newest version whose LATEST decision is 'approved'. Latest, not
  // "ever approved" — a decision can be reversed by a later record.
  console.log('No version given; looking for the newest approved one…');
  const versions = unwrap(await client.models.ProposalVersion.list({ limit: 200 }), 'list versions') ?? [];
  const sorted = [...versions].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  for (const v of sorted) {
    const approvals =
      unwrap(
        await client.models.Approval.approvalsByProposal({ proposalId: v.proposalId }),
        'approvals',
      ) ?? [];
    const latest = approvals
      .filter((a) => a.versionKey === v.versionKey)
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];
    if (latest?.decision === 'approved') {
      proposalId = v.proposalId;
      versionKey = v.versionKey;
      break;
    }
  }
}

if (!proposalId || !versionKey) {
  console.error('No approved version found. Run `npm run verify:email` first.');
  process.exit(1);
}

const version = unwrap(
  await client.models.ProposalVersion.get({ proposalId, versionKey }),
  'get version',
);
if (version === null) {
  console.error(`${proposalId} ${versionKey} not found.`);
  process.exit(1);
}

console.log(`\nRe-sending ${proposalId} ${versionKey}`);
console.log(`  fingerprint: ${version.contentSha256.slice(0, 16)}…`);

const result = unwrap(
  await client.mutations.sendProposalEmail({
    proposalId,
    versionKey,
    expectedContentSha256: version.contentSha256,
  }),
  'sendProposalEmail',
);

console.log(`\n  ok      : ${result?.ok}`);
console.log(`  status  : ${result?.status}`);
console.log(`  message : ${result?.message}`);

await signOut();
process.exit(result?.ok ? 0 : 1);
