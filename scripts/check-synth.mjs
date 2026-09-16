/**
 * Synthesizes the backend locally and asserts the things that only exist in the
 * generated CloudFormation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `amplify/backend.ts` had NO local verification at all. `tsc` proves it
 * compiles, which says nothing about what it produces — and the failures this
 * project has actually hit there were all synth-time or deploy-time:
 *
 *   - a circular dependency between the storage and function stacks, caused by
 *     passing a bucket name through addEnvironment
 *   - a custom mutation colliding with an auto-generated one
 *     ("Object type extension 'Mutation' cannot redeclare field
 *     deleteProposalVersion"), which tsc and the unit suite both passed
 *   - IAM grants that looked right and reached the wrong principal
 *
 * Every one of those is visible in the synthesized templates. None is visible
 * before running the synth. Until now the only way to find out was to deploy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Synth proves the templates are well-formed and say what we think they say. It
 * does NOT prove the deploy succeeds or that runtime behaviour is correct —
 * CloudFormation still rejects things at deploy time, and an IAM policy that
 * synthesizes perfectly can still deny at runtime. This file already records
 * several such cases. Use it as a gate before deploying, never as a substitute.
 *
 * READ-ONLY. It writes a temporary output directory and touches no AWS account.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
let checks = 0;
const pass = (m) => {
  checks += 1;
  console.log(`  PASS  ${m}`);
};
const fail = (m, detail) => {
  checks += 1;
  failures += 1;
  console.error(`  FAIL  ${m}`);
  if (detail) for (const d of detail.slice(0, 8)) console.error(`          ${d}`);
  if (detail && detail.length > 8) console.error(`          …and ${detail.length - 8} more`);
};

const outDir = mkdtempSync(path.join(tmpdir(), 'aeygis-synth-'));

/**
 * Amplify resolves these from the sandbox session. Without them `defineBackend`
 * throws "No context value present for amplify-backend-namespace key" before it
 * builds anything. The values only name the synthetic stack, so any consistent
 * string works — nothing here is deployed.
 */
const context = {
  'amplify-backend-namespace': 'synthcheck',
  'amplify-backend-name': 'synthcheck',
  'amplify-backend-type': 'sandbox',
};

console.log('synthesizing backend (no AWS calls)…\n');

// One command STRING rather than (command, args[]) with shell:true. Node
// deprecates the latter because an args array is concatenated rather than
// escaped, which is a real hazard when any argument comes from outside — none
// does here, but the deprecation warning is noise in every run, and the fix is
// to stop mixing the two forms. `shell` stays because `npx` needs it on Windows.
const result = spawnSync('npx tsx amplify/backend.ts', {
  encoding: 'utf8',
  shell: true,
  env: {
    ...process.env,
    // The residency guard in backend.ts throws on a wrong region and warns when
    // no region is set at all. Setting it keeps the synth on the same path a
    // real deploy takes.
    AWS_REGION: 'ca-central-1',
    CDK_OUTDIR: outDir,
    CDK_CONTEXT_JSON: JSON.stringify(context),
  },
});

if (result.status !== 0) {
  console.error(result.stdout ?? '');
  console.error(result.stderr ?? '');
  console.error('\nSYNTH FAILED — the backend does not build. Nothing else was checked.');
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

// ── load every template ────────────────────────────────────────────────────
const templates = readdirSync(outDir)
  .filter((f) => f.endsWith('.template.json'))
  .map((f) => ({ file: f, body: JSON.parse(readFileSync(path.join(outDir, f), 'utf8')) }));

if (templates.length === 0) {
  console.error('SYNTH produced no templates — nothing to check.');
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const allResources = templates.flatMap(({ file, body }) =>
  Object.entries(body.Resources ?? {}).map(([id, res]) => ({ file, id, ...res })),
);

const resourcesOfType = (type) => allResources.filter((r) => r.Type === type);
const policies = allResources.filter(
  (r) => r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy',
);

/** Every statement across every policy, tagged with the policy it came from. */
const statements = policies.flatMap((p) =>
  (p.Properties?.PolicyDocument?.Statement ?? []).map((st) => ({ policyId: p.id, st })),
);

const actionsOf = (st) => {
  const a = st.Action ?? st.action ?? [];
  return Array.isArray(a) ? a : [a];
};

console.log(`synthesized ${templates.length} templates, ${allResources.length} resources\n`);

// ───────────────────────────────────────────────────────────────────────────
console.log('GraphQL schema');
// ───────────────────────────────────────────────────────────────────────────
{
  const schemaFile = readdirSync(outDir).find((f) => f.endsWith('.graphql'));
  if (schemaFile === undefined) {
    fail('a GraphQL schema was emitted');
  } else {
    const schema = readFileSync(path.join(outDir, schemaFile), 'utf8');

    /**
     * `[^{]*` before the brace is load-bearing: the generated schema writes
     * `type Mutation @aws_iam {`, with directives between the name and the
     * brace. A pattern requiring `type Mutation {` matches nothing — which is
     * how the first version of this check reported every mutation as missing
     * while the schema was perfectly fine.
     */
    const block = (typeName) => {
      const m = schema.match(new RegExp(`^type ${typeName}\\b[^{]*\\{([\\s\\S]*?)^\\}`, 'm'));
      return m === null ? [] : [...m[1].matchAll(/^\s{2}(\w+)/gm)].map((x) => x[1]);
    };

    const mutations = block('Mutation');

    /**
     * GUARD AGAINST VACUOUS PASSES.
     *
     * Every assertion below is of the form "X is absent". On an empty list they
     * ALL pass, so a parsing bug would report a clean bill of health for a
     * schema this script never actually read. That is a worse failure than a
     * false alarm, because nobody investigates a pass.
     */
    if (mutations.length === 0) {
      fail('parsed the Mutation type (found no fields — the checks below would be vacuous)');
    } else {
      pass(`parsed ${mutations.length} mutation fields`);
    }

    // The collision that tsc and the unit suite both passed, and that only
    // surfaced at `ampx sandbox`.
    const dupes = mutations.filter((n, i) => mutations.indexOf(n) !== i);
    if (dupes.length === 0) pass('no duplicate mutation names');
    else fail('duplicate mutation names', [...new Set(dupes)]);

    /**
     * Immutability is structural in this schema: the operations are removed
     * rather than merely denied, so no future edit to an authorization rule can
     * reintroduce them. If one reappears here, an approval could start
     * referring to content that changed under it.
     */
    const mustNotExist = [
      'updateProposalVersion',
      'updateApproval',
      'deleteApproval',
      'updateAuditEvent',
      'deleteAuditEvent',
      'updateProposalDelivery',
      'deleteProposalDelivery',
    ];
    const present = mustNotExist.filter((n) => mutations.includes(n));
    if (present.length === 0) pass('append-only models expose no update/delete mutations');
    else fail('an immutable model gained a mutation', present);

    // The Lambdas are the only writers of these, so create must remain.
    const mustExist = ['createApproval', 'createAuditEvent', 'createProposalDelivery'];
    const missing = mustExist.filter((n) => !mutations.includes(n));
    if (missing.length === 0) pass('Lambda-written models still expose create');
    else fail('a Lambda lost its only write path', missing);

    const custom = ['submitAssessment', 'generateProposal', 'decideProposal', 'sendProposalEmail'];
    const absent = custom.filter((n) => !mutations.includes(n));
    if (absent.length === 0) pass('every custom mutation is in the schema');
    else fail('a custom mutation is missing', absent);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NO SCALAR THAT REFUSES ORDINARY HUMAN INPUT ON A PUBLIC FORM FIELD
     * ═══════════════════════════════════════════════════════════════════════
     *
     * On 2026-08-26 two real leads were destroyed by `phone: a.phone()`. The
     * visitor typed a normal number, AppSync refused the variable, the whole
     * write failed, and the form told them to email us instead. Nothing in the
     * repo went red: every fixture used the one format AWSPhone accepts.
     *
     * The lesson is about WHERE validation sits, not about phone numbers.
     * These scalars validate at WRITE time, inside the Lambda, after the
     * visitor has gone. At that point a refusal cannot help anyone correct
     * anything — it can only destroy a submission. Format rules belong in
     * validate.ts, where a failure is a sentence the submitter can act on.
     *
     * AWSEmail is deliberately NOT listed: `email` is required, and validate.ts
     * already rejects a bad one with a fixable message before the write. The
     * datetime fields are not listed either — we generate those ourselves.
     */
    const REFUSING_SCALARS = {
      AWSPhone: 'refuses parentheses, dots and extensions, i.e. how people write phone numbers',
      AWSURL: 'refuses a bare "clinic.ca" typed without a scheme',
      AWSIPAddress: 'refuses anything a human plausibly mistypes',
    };

    /** Field name and type for one type block, e.g. ['phone', 'String']. */
    const fieldsWithTypes = (typeName) => {
      const m = schema.match(
        new RegExp(String.raw`^type ${typeName}\b[^{]*\{([\s\S]*?)^\}`, 'm'),
      );
      if (m === null) return [];
      return [...m[1].matchAll(/^\s{2}(\w+)(?:\([^)]*\))?:\s*([^\n]+)/gm)].map((x) => [
        x[1],
        x[2].replace(/[!\[\]\s]/g, '').replace(/@.*$/, ''),
      ]);
    };

    const assessmentFields = fieldsWithTypes('Assessment');
    // Same vacuous-pass guard as the mutations above: "no offender" is trivially
    // true of a list this script failed to parse.
    if (assessmentFields.length === 0) {
      fail('parsed the Assessment type (the scalar check below would be vacuous)');
    } else {
      const offenders = assessmentFields.filter(([, type]) => REFUSING_SCALARS[type] !== undefined);
      if (offenders.length === 0) {
        pass(`no Assessment field refuses ordinary input (${assessmentFields.length} fields checked)`);
      } else {
        fail(
          'a public form field uses a scalar that rejects input at write time',
          offenders.map(([name, type]) => `${name}: ${type} — ${REFUSING_SCALARS[type]}`),
        );
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEncryption at rest');
// ───────────────────────────────────────────────────────────────────────────
{
  const tables = resourcesOfType('Custom::AmplifyDynamoDBTable');
  if (tables.length === 0) {
    fail('found the generated DynamoDB tables (Amplify may have renamed the type)');
  } else {
    const unencrypted = tables.filter(
      (t) => t.Properties?.sseSpecification?.sseType !== 'KMS',
    );
    if (unencrypted.length === 0) pass(`all ${tables.length} tables request the CMK`);
    else fail('a table is not KMS-encrypted', unencrypted.map((t) => t.id));

    /**
     * NESTED, not flat. backend.ts assigns `table.pointInTimeRecoveryEnabled`
     * on Amplify's typed wrapper, but the wrapper emits
     * `pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled }`.
     * Reading the flat property finds undefined and reports every table as
     * unprotected — which is what the first version of this check did.
     */
    const noPitr = tables.filter(
      (t) => t.Properties?.pointInTimeRecoverySpecification?.pointInTimeRecoveryEnabled !== true,
    );
    if (noPitr.length === 0) pass(`all ${tables.length} tables have point-in-time recovery`);
    else fail('a table has no PITR', noPitr.map((t) => t.id));
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nConfidentiality barrier (internal pricing)');
// ───────────────────────────────────────────────────────────────────────────
{
  /**
   * Barrier 4 of 5: the client-facing functions have no ARN for the internal
   * prefix, so they cannot read margin working even if a future code change
   * tried to. dependency-cruiser stops them IMPORTING the data; this stops the
   * IAM policy handing it to them.
   */
  const clientFacing = ['renderproposalpdf', 'sendproposalemail'];
  const leaks = [];
  for (const { policyId, st } of statements) {
    const blob = JSON.stringify(st);
    if (!blob.includes('proposals/internal/')) continue;
    const id = policyId.toLowerCase();
    for (const fn of clientFacing) {
      if (id.includes(fn)) leaks.push(`${policyId} grants ${actionsOf(st).join(',')}`);
    }
  }
  if (leaks.length === 0) {
    pass('no client-facing function can reach proposals/internal/*');
  } else {
    fail('CONFIDENTIALITY BARRIER BROKEN — internal prefix reachable', leaks);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nPublic (unauthenticated) access');
// ───────────────────────────────────────────────────────────────────────────
{
  /**
   * The central security claim of this system: a guest can WRITE via
   * Mutation.submitAssessment and can never READ an assessment. That is
   * structural — `Assessment` carries no guest rule, so the unauth role's
   * policy should contain no Assessment ARNs whatsoever.
   */
  const unauthPolicies = policies.filter((p) => {
    const roles = JSON.stringify(p.Properties?.Roles ?? p.Properties?.Users ?? '');
    return /unauth/i.test(roles) || /unauth/i.test(p.id);
  });

  const readable = [];
  for (const p of unauthPolicies) {
    for (const st of p.Properties?.PolicyDocument?.Statement ?? []) {
      const blob = JSON.stringify(st.Resource ?? '');
      // AppSync field ARNs look like .../types/Query/fields/getAssessment
      if (/types\/Query\/fields\/(get|list)Assessment/.test(blob)) {
        readable.push(`${p.id}: ${blob.slice(0, 120)}`);
      }
    }
  }
  if (readable.length === 0) pass('the unauthenticated role can read no Assessment fields');
  else fail('GUESTS CAN READ ASSESSMENTS', readable);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEmail delivery');
// ───────────────────────────────────────────────────────────────────────────
{
  /**
   * WHO MAY SEND EMAIL — an allowlist, not a count.
   *
   * This asserted "exactly one principal" while send-proposal-email was the only
   * sender. submit-assessment became the second on 2026-08-25, when the public
   * form stopped emailing sales through a third-party relay and needed to raise
   * an internal heads-up instead.
   *
   * Relaxing this to "one or more" would have been the easy fix and the wrong
   * one — the value of the check is that a principal nobody intended cannot
   * quietly gain the ability to send mail from an Aeygis address. So it is now
   * an explicit list, and a third sender still fails until somebody adds it here
   * deliberately.
   */
  const ALLOWED_SENDERS = [
    { match: 'sendproposalemail', why: 'delivers an approved proposal to a client' },
    { match: 'submitassessment', why: 'raises the internal new-lead notification' },
  ];

  const sendStatements = statements.filter((s) => actionsOf(s.st).includes('ses:SendEmail'));

  if (sendStatements.length === 0) {
    fail('a ses:SendEmail grant exists');
  } else {
    const unexpected = sendStatements.filter(
      (s) => !ALLOWED_SENDERS.some((a) => s.policyId.toLowerCase().includes(a.match)),
    );
    if (unexpected.length > 0) {
      fail('ses:SendEmail is granted to an unexpected principal', unexpected.map((s) => s.policyId));
    } else {
      pass(`only the ${sendStatements.length} expected principal(s) may call ses:SendEmail`);
    }

    for (const allowed of ALLOWED_SENDERS) {
      sendStatements.some((s) => s.policyId.toLowerCase().includes(allowed.match))
        ? pass(`  ${allowed.match} can send — ${allowed.why}`)
        : fail(`  ${allowed.match} has NO send grant, but is expected to ${allowed.why}`);
    }

    // Every grant is checked, not just the first. A wildcard on the second one
    // would be exactly as dangerous and exactly as invisible.
    for (const { policyId, st } of sendStatements) {
      const arns = JSON.stringify(st.Resource ?? '');

      // A wildcard here would be an account-wide send permission on a Lambda,
      // which is a far larger thing than it looks.
      if (/identity\/\*/.test(arns) || arns.includes('"*"')) {
        fail(`ses:SendEmail is granted on a wildcard identity (${policyId})`);
      } else {
        pass(`  scoped to a named identity, not a wildcard (${policyId.slice(0, 28)}…)`);
      }

      if (arns.includes(':configuration-set/')) {
        pass(`  covers the configuration set it sends with (${policyId.slice(0, 28)}…)`);
      } else {
        // Both functions always pass ConfigurationSetName; a policy omitting it
        // would refuse the call at runtime.
        fail(`ses:SendEmail does not cover the configuration set — sends would be denied (${policyId})`);
      }
    }
  }

  /**
   * Both sets must be NAMED, not CloudFormation-generated: the functions send
   * with fixed strings, and a generated name would never match one.
   *
   * Two sets on purpose — client-facing proposal delivery and internal
   * notifications are kept apart so a bounce on our own inbox does not land in
   * the reputation metrics that describe whether proposals reach clinics.
   */
  const EXPECTED_SETS = ['aeygis-proposal-delivery', 'aeygis-internal-notifications'];
  const sets = resourcesOfType('AWS::SES::ConfigurationSet');
  const setNames = sets.map((s) => s.Properties?.Name).filter((n) => typeof n === 'string');

  if (setNames.length !== sets.length) {
    fail('every configuration set has an explicit Name', sets.map((s) => s.id));
  } else {
    pass(`all ${sets.length} configuration sets have fixed names`);
  }
  for (const expected of EXPECTED_SETS) {
    setNames.includes(expected)
      ? pass(`  configuration set "${expected}" exists`)
      : fail(`configuration set "${expected}" is missing — sends naming it would fail`);
  }
  const strayNames = setNames.filter((n) => !EXPECTED_SETS.includes(n));
  if (strayNames.length > 0) {
    fail('an unexpected configuration set was created', strayNames);
  }

  // Bounces and complaints must have somewhere to go BEFORE the first send —
  // in the sandbox a bounce lands the address on the account suppression list.
  const dests = resourcesOfType('AWS::SES::ConfigurationSetEventDestination');
  const events = dests[0]?.Properties?.EventDestination?.MatchingEventTypes ?? [];
  for (const needed of ['bounce', 'complaint']) {
    if (events.includes(needed)) pass(`${needed} events are published`);
    else fail(`${needed} events are published`, [`got: ${events.join(', ') || 'none'}`]);
  }

  // Only ses.amazonaws.com may publish, and only for our configuration set.
  const topicPolicies = resourcesOfType('AWS::SNS::TopicPolicy');
  const openTopic = topicPolicies.filter((p) =>
    (p.Properties?.PolicyDocument?.Statement ?? []).some(
      (st) => st.Principal === '*' || st.Principal?.AWS === '*',
    ),
  );
  if (topicPolicies.length > 0 && openTopic.length === 0) {
    pass('the bounce topic is not publishable by anyone');
  } else if (topicPolicies.length === 0) {
    fail('the bounce topic has a resource policy');
  } else {
    fail('the bounce topic is world-publishable', openTopic.map((p) => p.id));
  }

  /**
   * send-proposal-email reads two KMS-encrypted objects and writes neither.
   * Encrypt would be a permission with no call site, on the one function whose
   * output leaves the building.
   */
  const sendKms = statements.filter(
    (s) =>
      s.policyId.toLowerCase().includes('sendproposalemail') &&
      actionsOf(s.st).some((a) => typeof a === 'string' && a.startsWith('kms:')),
  );
  const kmsActions = [...new Set(sendKms.flatMap((s) => actionsOf(s.st)))];
  if (kmsActions.includes('kms:Decrypt') && !kmsActions.some((a) => /kms:(Encrypt|GenerateDataKey)/.test(a))) {
    pass('send-proposal-email holds kms:Decrypt and no encrypt permission');
  } else {
    fail('send-proposal-email KMS grant is wrong', kmsActions);
  }
}

// ───────────────────────────────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED — do not deploy until these are understood.`);
  process.exit(1);
}
console.log('Synth is clean. This does NOT guarantee the deploy succeeds.');
