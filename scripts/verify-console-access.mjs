/**
 * Verifies the console's data layer with REAL Cognito sign-ins.
 *
 * The console typechecks, builds and serves — none of which proves a staff user
 * can actually read or write. This signs in as a `contributor` and an `approver`
 * and exercises the exact grant declared in amplify/data/resource.ts:
 *
 *     allow.groups(['contributor','approver']).to(['read','update'])
 *
 * So `read` and `update` must succeed, and `create` and `delete` must be denied
 * for BOTH roles. The console deliberately exposes no create/delete, but the API
 * is the real boundary — a console that hides a button proves nothing.
 *
 * Uses SRP via aws-amplify because that is the only auth flow the user pool
 * client enables (ALLOW_USER_SRP_AUTH), and because it is the same library the
 * console uses, so a failure here is a failure the console would hit too.
 *
 * Requires .test-credentials.json (gitignored, created alongside the test users).
 *
 * Run:  npm run verify:console
 */
import { readFileSync, existsSync } from 'node:fs';
import { Amplify } from 'aws-amplify';
import { signIn, signOut, fetchAuthSession } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';

const credsPath = new URL('../.test-credentials.json', import.meta.url);
if (!existsSync(credsPath)) {
  console.error('Missing .test-credentials.json — create the test users first.');
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));

Amplify.configure(outputs);
const client = generateClient({ authMode: 'userPool' });

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

/** True when the error/GraphQL errors look like an authorization denial. */
const isDenial = (errors) =>
  (errors ?? []).some((e) => /unauthorized|not authorized|permission denied|forbidden/i.test(e?.message ?? ''));

async function asUser(label, { username, password, group }) {
  console.log(`\n── ${label} (${group}) ──`);

  try {
    await signOut();
  } catch {
    /* no active session */
  }

  // 1. sign in
  try {
    const { isSignedIn, nextStep } = await signIn({ username, password });
    if (!isSignedIn) {
      fail(`sign-in incomplete, nextStep=${nextStep?.signInStep}`);
      return;
    }
    pass('signed in via SRP');
  } catch (error) {
    fail(`sign-in threw: ${error?.message ?? error}`);
    return;
  }

  // 2. the group claim the console's useRole() depends on
  let groups = [];
  try {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload ?? {};
    groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [];
    groups.includes(group)
      ? pass(`ID token carries cognito:groups = [${groups.join(', ')}]`)
      : fail(`expected group "${group}" in token, got [${groups.join(', ')}]`);
  } catch (error) {
    fail(`could not read session: ${error?.message ?? error}`);
    return;
  }

  // 3. READ must succeed
  let firstId = null;
  try {
    const { data, errors } = await client.models.Assessment.list({ limit: 5 });
    if (isDenial(errors)) {
      fail(`read denied: ${errors[0].message}`);
    } else if (errors?.length) {
      fail(`read errored: ${errors[0].message}`);
    } else {
      firstId = data?.[0]?.id ?? null;
      pass(`read allowed (${data?.length ?? 0} record(s) visible)`);
    }
  } catch (error) {
    fail(`read threw: ${error?.message ?? error}`);
  }

  // 4. UPDATE must succeed — needs a record to update
  if (firstId === null) {
    console.log('  SKIP  update — no records present to update');
  } else {
    try {
      const marker = `verified by ${group} at ${new Date().toISOString()}`;
      const { data, errors } = await client.models.Assessment.update({
        id: firstId,
        internalNotes: marker,
      });
      if (isDenial(errors)) fail(`update denied: ${errors[0].message}`);
      else if (errors?.length) fail(`update errored: ${errors[0].message}`);
      else if (data?.internalNotes !== marker) fail('update did not persist');
      else pass('update allowed and persisted');
    } catch (error) {
      fail(`update threw: ${error?.message ?? error}`);
    }
  }

  // 5. CREATE must be DENIED — the schema grants only read+update
  try {
    const { data, errors } = await client.models.Assessment.create({
      referenceId: 'SHOULD-NOT-EXIST',
      source: 'console-test',
      status: 'new',
      submittedAt: new Date().toISOString(),
      consent: true,
      countsConfirmed: false,
    });
    if (isDenial(errors)) pass('create denied');
    else if (errors?.length) pass(`create rejected: ${errors[0].message.slice(0, 70)}`);
    else if (data) fail(`create SUCCEEDED — staff can invent leads (id ${data.id})`);
    else pass('create returned no record');
  } catch (error) {
    pass(`create rejected: ${String(error?.message ?? error).slice(0, 70)}`);
  }

  // 6. APPROVAL AUTHORITY — the Phase 4 boundary.
  //
  // `decideProposal` carries allow.group('approver'), so AppSync must reject a
  // contributor BEFORE the Lambda runs. This is the check that matters most in
  // Phase 4: hiding the button in the console is cosmetic, the API is the
  // boundary. A fake proposal id is fine — authorization is evaluated first, so
  // a contributor should never get far enough to be told it does not exist.
  try {
    const { data, errors } = await client.mutations.decideProposal({
      proposalId: 'DOES-NOT-EXIST',
      versionKey: 'v0001',
      decision: 'approved',
      expectedContentSha256: '0'.repeat(64),
      reason: 'authorization probe',
    });
    const denied = isDenial(errors);

    if (group === 'approver') {
      // An approver must get PAST authorization. Reaching the Lambda and being
      // told the proposal is missing is the correct outcome here.
      if (denied) {
        fail('approver was DENIED decideProposal — the approval path is broken');
      } else if (data?.ok === false && /not found/i.test(data.message ?? '')) {
        pass('approver passed authorization and reached the handler (proposal not found, as expected)');
      } else if (errors?.length) {
        pass(`approver passed authorization; handler responded: ${errors[0].message.slice(0, 60)}`);
      } else {
        pass(`approver passed authorization (response: ${JSON.stringify(data).slice(0, 80)})`);
      }
    } else {
      // A contributor must be stopped at the API.
      if (denied) {
        pass('contributor DENIED decideProposal by authorization');
      } else if (data?.ok === false && /not found/i.test(data.message ?? '')) {
        fail('contributor REACHED THE HANDLER — allow.group(approver) is not being enforced');
      } else if (errors?.length) {
        pass(`contributor rejected: ${errors[0].message.slice(0, 70)}`);
      } else {
        fail(`contributor was not denied: ${JSON.stringify(data).slice(0, 120)}`);
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    group === 'approver'
      ? fail(`approver threw on decideProposal: ${message.slice(0, 90)}`)
      : pass(`contributor rejected: ${message.slice(0, 70)}`);
  }

  // 6b. ProposalVersion.delete must be DENIED to users, for BOTH roles.
  //
  // This one is load-bearing. `delete` was re-enabled on the ProposalVersion
  // MODEL so the delete-proposal-version Lambda can call it, which means the
  // mutation now exists in the deployed schema. The only thing keeping a
  // signed-in user out is the authorization rule (`.to(['read'])`) — if that
  // ever slips, staff could delete an APPROVED version directly, bypassing the
  // refusal rule that lives in the Lambda. A fake key is fine: authorization is
  // evaluated before existence, exactly as with the decideProposal probe above.
  try {
    const { data, errors } = await client.models.ProposalVersion.delete({
      proposalId: 'DOES-NOT-EXIST',
      versionKey: 'v0001',
    });
    if (isDenial(errors)) pass('ProposalVersion.delete DENIED — the Lambda is the only deleter');
    else if (errors?.length) pass(`ProposalVersion.delete rejected: ${errors[0].message.slice(0, 60)}`);
    else if (data)
      fail('ProposalVersion.delete SUCCEEDED — a user can bypass the approved-version guard');
    else fail('ProposalVersion.delete was not denied — check the authorization rule');
  } catch (error) {
    pass(`ProposalVersion.delete rejected: ${String(error?.message ?? error).slice(0, 60)}`);
  }

  // 7. Approval + AuditEvent must be READ-ONLY for every role.
  for (const [label, op] of [
    ['Approval.create', () => client.models.Approval.create({
      proposalId: 'X', versionKey: 'v0001', decision: 'approved',
      contentSha256: '0'.repeat(64), decidedBy: 'forged',
      decidedByGroups: 'approver', decidedAt: new Date().toISOString(),
    })],
    ['AuditEvent.create', () => client.models.AuditEvent.create({
      subjectId: 'X', subjectType: 'proposal', eventType: 'forged',
      actor: 'forged', occurredAt: new Date().toISOString(),
    })],
  ]) {
    try {
      const { data, errors } = await op();
      if (isDenial(errors)) pass(`${label} denied — cannot forge an audit record`);
      else if (errors?.length) pass(`${label} rejected: ${errors[0].message.slice(0, 60)}`);
      else if (data) fail(`${label} SUCCEEDED — a user can forge audit history (id ${data.id})`);
      else pass(`${label} returned no record`);
    } catch (error) {
      pass(`${label} rejected: ${String(error?.message ?? error).slice(0, 60)}`);
    }
  }

  // 8. DELETE must be DENIED
  if (firstId !== null) {
    try {
      const { data, errors } = await client.models.Assessment.delete({ id: firstId });
      if (isDenial(errors)) pass('delete denied');
      else if (errors?.length) pass(`delete rejected: ${errors[0].message.slice(0, 70)}`);
      else if (data) fail(`delete SUCCEEDED — a lead can be destroyed from the console (${firstId})`);
      else pass('delete returned no record');
    } catch (error) {
      pass(`delete rejected: ${String(error?.message ?? error).slice(0, 70)}`);
    }
  }
}

console.log(`Region:   ${outputs.data.aws_region}`);
console.log(`Endpoint: ${outputs.data.url}`);

/**
 * The most security-relevant case: an authenticated user in NO group.
 *
 * `allow.groups(['contributor','approver'])` grants nothing to anyone outside
 * those groups, so read MUST be denied. If it is not, then merely holding an
 * account — however it was obtained — exposes every client's confidential
 * business information. The console shows such a user a read-only banner, but
 * that is cosmetic; this asserts the API itself refuses.
 */
async function asNoGroupUser({ username, password }) {
  console.log('\n── No-group user (must be denied everything) ──');

  try {
    await signOut();
  } catch {
    /* no active session */
  }

  try {
    const { isSignedIn } = await signIn({ username, password });
    if (!isSignedIn) {
      fail('sign-in incomplete');
      return;
    }
    // Signing in is expected to work — authentication is not authorization.
    pass('signed in (authentication succeeds, as designed)');
  } catch (error) {
    fail(`sign-in threw: ${error?.message ?? error}`);
    return;
  }

  try {
    const session = await fetchAuthSession();
    const groups = session.tokens?.idToken?.payload?.['cognito:groups'];
    groups === undefined || (Array.isArray(groups) && groups.length === 0)
      ? pass('ID token carries no groups')
      : fail(`expected no groups, got ${JSON.stringify(groups)}`);
  } catch (error) {
    fail(`could not read session: ${error?.message ?? error}`);
  }

  for (const [label, op] of [
    ['read', () => client.models.Assessment.list({ limit: 5 })],
    ['read one', () => client.models.Assessment.get({ id: 'any' })],
  ]) {
    try {
      const { data, errors } = await op();
      if (isDenial(errors)) {
        pass(`${label} DENIED`);
      } else if (errors?.length) {
        pass(`${label} rejected: ${errors[0].message.slice(0, 70)}`);
      } else if (Array.isArray(data) && data.length > 0) {
        fail(`${label} RETURNED ${data.length} RECORD(S) — a groupless account can read client data`);
      } else if (Array.isArray(data)) {
        fail(`${label} returned an empty list instead of denying — check the rule`);
      } else if (data) {
        fail(`${label} RETURNED DATA — a groupless account can read client data`);
      } else {
        pass(`${label} returned nothing`);
      }
    } catch (error) {
      pass(`${label} rejected: ${String(error?.message ?? error).slice(0, 70)}`);
    }
  }
}

await asUser('Contributor', creds.contributor);
await asUser('Approver', creds.approver);
if (creds.nogroup) await asNoGroupUser(creds.nogroup);

try {
  await signOut();
} catch {
  /* ignore */
}

console.log(
  failures === 0 ? '\nConsole data-layer access verified.\n' : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
