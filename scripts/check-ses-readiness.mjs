/**
 * Is this account ready to email real clinics, and if not, what is left?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY. Reads SES, SNS and the deployed Lambda config. Writes nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Answering "are we live yet" used to mean six separate CLI calls and knowing
 * which flags mattered. Worse, the six answers interact: production access with
 * a Gmail sender still lands in spam, and a verified domain with a closed
 * allowlist still reaches nobody. This puts the whole posture in one place and
 * says what the NEXT step is rather than leaving it to be inferred.
 *
 * ── WHY IT READS THE DEPLOYED LAMBDA, NOT resource.ts ──────────────────────
 * The source is what we intend; the function environment is what is running.
 * Those differ for as long as a change sits undeployed, and "I changed the
 * sender" followed by "why is it still sending from the old address" is exactly
 * the confusion this avoids. Where the two disagree, the deployed value is the
 * truth and this says so.
 *
 * Run:  AWS_PROFILE=aeygis npm run check:ses
 */
import {
  SESv2Client,
  GetAccountCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  ListSuppressedDestinationsCommand,
} from '@aws-sdk/client-sesv2';
import { execFileSync } from 'node:child_process';
import { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

const REGION = 'ca-central-1';
const DOMAIN = 'aeygis.com';

const ses = new SESv2Client({ region: REGION });
/* SNS is read through the AWS CLI rather than the SDK, deliberately.
   @aws-sdk/client-sns is the one client this repo does not already declare, and
   adding a dependency for two calls in a status script is not worth it. The CLI
   is a hard requirement for this project anyway. */
const awsCli = (args) =>
  JSON.parse(
    execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      env: process.env,
    }),
  );
const lambda = new LambdaClient({ region: REGION });

let blockers = 0;
let notes = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const blocked = (m) => { console.log(`  TODO  ${m}`); blockers += 1; };
const note = (m) => { console.log(`  NOTE  ${m}`); notes += 1; };
const bad = (m) => { console.error(`  FAIL  ${m}`); blockers += 1; };

console.log(`Region: ${REGION}\n`);

// ── 1. account ─────────────────────────────────────────────────────────────
console.log('SES account\n');
let productionAccess = false;
try {
  const acct = await ses.send(new GetAccountCommand({}));
  productionAccess = acct.ProductionAccessEnabled === true;
  const review = acct.Details?.ReviewDetails ?? {};

  if (productionAccess) {
    ok(`production access GRANTED — ${acct.SendQuota?.Max24HourSend} / 24 h, ${acct.SendQuota?.MaxSendRate} / s`);
  } else {
    /* ReviewStatus reflects the last COMPLETED review, so it keeps reading
       DENIED while a reply to the same case is being considered. The field that
       actually matters is ProductionAccessEnabled. */
    blocked(
      `production access NOT granted (sandbox: ${acct.SendQuota?.Max24HourSend} / 24 h). ` +
        `Last review: ${review.Status ?? 'unknown'}${review.CaseId ? `, case ${review.CaseId}` : ''}`,
    );
  }

  /* Deliberately not phrased as a clean bill of health. This is ACCOUNT-wide —
     it covers every tenant in 326629581669, not just Aeygis — and it is a
     LAGGING signal: by the time it stops reading HEALTHY, AWS has already
     acted. The leading indicators are the two rates checked further down. */
  acct.EnforcementStatus === 'HEALTHY'
    ? ok('account not under review (lagging signal — see the rates below)')
    : bad(`account enforcement status is ${acct.EnforcementStatus} — sending is at risk`);
} catch (error) {
  if (/credential|token/i.test(error.message ?? '')) {
    bad('no working AWS credentials — try:  AWS_PROFILE=aeygis npm run check:ses');
    process.exit(1);
  }
  bad(`could not read the SES account: ${error.message}`);
}

// ── 2. identities ──────────────────────────────────────────────────────────
console.log('\nIdentities\n');
let domainVerified = false;
try {
  const { EmailIdentities = [] } = await ses.send(new ListEmailIdentitiesCommand({ PageSize: 50 }));
  const domain = await ses
    .send(new GetEmailIdentityCommand({ EmailIdentity: DOMAIN }))
    .catch(() => null);

  if (domain?.VerifiedForSendingStatus === true && domain?.DkimAttributes?.Status === 'SUCCESS') {
    domainVerified = true;
    ok(`${DOMAIN} verified, DKIM SUCCESS, signing ${domain.DkimAttributes.SigningEnabled ? 'on' : 'OFF'}`);
  } else if (domain !== null) {
    blocked(`${DOMAIN} exists but DKIM is ${domain.DkimAttributes?.Status ?? 'unknown'}`);
  } else {
    blocked(`${DOMAIN} is not an identity in this region`);
  }

  const others = EmailIdentities.filter((i) => i.IdentityName !== DOMAIN).map((i) => i.IdentityName);
  if (others.length > 0) note(`also verified: ${others.join(', ')}`);
} catch (error) {
  bad(`could not list identities: ${error.message}`);
}

// ── 3. what is actually deployed ───────────────────────────────────────────
console.log('\nDeployed configuration (the running functions, not the source)\n');
let fromAddress = null;
let allowlist = null;
try {
  const { Functions = [] } = await lambda.send(new ListFunctionsCommand({ MaxItems: 200 }));
  const find = (needle) => Functions.find((f) => (f.FunctionName ?? '').toLowerCase().includes(needle));

  const sender = find('sendproposalemail');
  if (sender === undefined) {
    bad('send-proposal-email is not deployed');
  } else {
    const cfg = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: sender.FunctionName }),
    );
    const env = cfg.Environment?.Variables ?? {};
    fromAddress = env.SES_FROM_ADDRESS ?? null;
    allowlist = env.SES_ALLOWED_RECIPIENTS ?? null;

    env.SES_ENABLED === 'true' ? ok('SES_ENABLED = true') : blocked(`SES_ENABLED = ${env.SES_ENABLED}`);

    if (fromAddress === null) {
      bad('SES_FROM_ADDRESS is not set — nothing can send');
    } else if (fromAddress.endsWith(`@${DOMAIN}`)) {
      ok(`sender is ${fromAddress} — aligned with the verified domain`);
    } else {
      /* Not a failure: keeping a test sender is a deliberate choice while
         setting up. But it IS why mail lands in spam, and saying so here stops
         that being mistaken for a configuration fault later. */
      blocked(
        `sender is still ${fromAddress} — not on ${DOMAIN}, so mail fails DMARC and is quarantined`,
      );
    }

    if (allowlist === null || allowlist.trim() === '') {
      note('recipient allowlist is EMPTY — fails closed, so nothing can be emailed at all');
    } else if (allowlist.trim() === '*') {
      productionAccess
        ? ok('recipient allowlist is open (*)')
        : bad('allowlist is OPEN while still in the sandbox — real prospects could be attempted');
    } else {
      blocked(`recipient allowlist is restricted to: ${allowlist}`);
    }
  }
} catch (error) {
  bad(`could not read the deployed configuration: ${error.message}`);
}

// ── 4. reputation — the leading indicators ─────────────────────────────────
/**
 * Bounce and complaint RATES, against the thresholds AWS actually enforces.
 *
 * ── WHY THIS IS NOT JUST MORE STATUS ───────────────────────────────────────
 * EnforcementStatus above is a lagging signal: it changes after AWS has acted.
 * These two rates are what AWS watches to decide whether to act, so they are
 * the only part of this script that can warn rather than report.
 *
 * Thresholds are AWS's published ones, not invented here:
 *   bounce    >= 5%    account placed under review
 *   bounce    >= 10%   sending may be paused
 *   complaint >= 0.1%  account placed under review
 *   complaint >  0.5%  sending may be paused
 * https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html
 *
 * The 0.1% complaint line is tighter than it looks. At low volume a handful of
 * complaints crosses it, so it is the one most likely to bite first.
 *
 * ── ACCOUNT-WIDE, AND THAT IS THE POINT ────────────────────────────────────
 * These cover every sender in the account, not only Aeygis. This account also
 * hosts app-cadence.com and an Amazon Connect instance, and SES reputation is
 * tracked per ACCOUNT. A different application sending badly can put Aeygis
 * proposals under review, and nothing in the Aeygis code could prevent or
 * detect that. This is the only place it becomes visible.
 *
 * SES Tenants would isolate reputation TRACKING per tenant, though AWS is clear
 * that combined sending still affects the account:
 * https://docs.aws.amazon.com/ses/latest/dg/tenants.html
 */
console.log('');
console.log('Reputation — ACCOUNT-WIDE, covers every sender in this account');
console.log('');

/* First line of a message, without writing a newline escape — this file is
   edited through shell heredocs that collapse doubled backslashes. */
const firstLine = (text) => String(text ?? '').split(String.fromCharCode(10))[0];

const REPUTATION = [
  { metric: 'Reputation.BounceRate', label: 'bounce rate', review: 0.05, pause: 0.10 },
  { metric: 'Reputation.ComplaintRate', label: 'complaint rate', review: 0.001, pause: 0.005 },
];

const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const until = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

for (const { metric, label, review, pause } of REPUTATION) {
  try {
    const { Datapoints = [] } = awsCli([
      'cloudwatch', 'get-metric-statistics',
      '--namespace', 'AWS/SES',
      '--metric-name', metric,
      '--start-time', since,
      '--end-time', until,
      '--period', '86400',
      '--statistics', 'Maximum',
    ]);

    if (Datapoints.length === 0) {
      /* NOT "0%, all good". No datapoints means SES published no reputation
         data in the window — usually because nothing was sent. Reporting that
         as a healthy zero would be a check that passes precisely when it has
         learned nothing. */
      note(`${label}: no data in the last 14 days (nothing sent, or metrics not yet published)`);
      continue;
    }

    const latest = Datapoints.sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp)).at(-1);
    const rate = latest.Maximum ?? 0;
    const pct = (rate * 100).toFixed(2);
    const limits = `AWS reviews at ${review * 100}%, pauses at ${pause * 100}%`;

    if (rate >= pause) {
      bad(`${label} ${pct}% — AT OR ABOVE THE PAUSE THRESHOLD (${limits})`);
    } else if (rate >= review) {
      bad(`${label} ${pct}% — at or above the review threshold (${limits})`);
    } else if (rate >= review / 2) {
      note(`${label} ${pct}% — over half way to review (${limits})`);
    } else {
      ok(`${label} ${pct}% (${limits})`);
    }
  } catch (error) {
    note(`${label}: could not read the metric (${firstLine(error.message)})`);
  }
}

// ── 5. bounce handling ─────────────────────────────────────────────────────
console.log('\nBounce and complaint handling\n');
try {
  const { Topics = [] } = awsCli(['sns', 'list-topics']);
  const topic = Topics.map((t) => t.TopicArn).find((a) => (a ?? '').includes('ProposalEmailEvents'));

  if (topic === undefined) {
    bad('no ProposalEmailEvents SNS topic found');
  } else {
    const { Subscriptions = [] } = awsCli([
      'sns', 'list-subscriptions-by-topic', '--topic-arn', topic,
    ]);
    /* A SubscriptionArn of the literal string "PendingConfirmation" means the
       confirmation link was never clicked — the subscription exists and
       receives nothing, which looks identical to working. */
    const confirmed = Subscriptions.filter((s) => s.SubscriptionArn !== 'PendingConfirmation');
    const pendingSubs = Subscriptions.length - confirmed.length;

    confirmed.length > 0
      ? ok(`bounce topic has ${confirmed.length} confirmed subscriber(s): ${confirmed.map((s) => s.Endpoint).join(', ')}`)
      : bad('bounce topic has NO confirmed subscriber — bounces reach nobody');
    if (pendingSubs > 0) note(`${pendingSubs} subscription(s) still awaiting a click on the confirmation link`);
  }
} catch (error) {
  bad(`could not read the SNS topic: ${error.message}`);
}

try {
  const { SuppressedDestinationSummaries = [] } = await ses.send(
    new ListSuppressedDestinationsCommand({ PageSize: 20 }),
  );
  SuppressedDestinationSummaries.length === 0
    ? ok('suppression list is empty')
    : note(
        `${SuppressedDestinationSummaries.length} suppressed address(es): ` +
          SuppressedDestinationSummaries.map((d) => `${d.EmailAddress} (${d.Reason})`).join(', '),
      );
} catch (error) {
  note(`could not read the suppression list: ${error.message}`);
}

// ── what is left ───────────────────────────────────────────────────────────
console.log('');
if (blockers === 0) {
  console.log('Ready. Proposals sent from here will be DKIM-signed, aligned with the');
  console.log('published DMARC policy, and delivered to real recipients.');
} else {
  console.log(`${blockers} thing(s) still between here and emailing a real clinic.`);
  console.log('');
  console.log('The order matters — see docs/email-setup.md:');
  console.log(`  1. production access granted        ${productionAccess ? 'DONE' : 'waiting on AWS'}`);
  console.log(`  2. ${DOMAIN} verified + DKIM        ${domainVerified ? 'DONE' : 'not yet'}`);
  console.log(`  3. sender moved to @${DOMAIN}      ${fromAddress?.endsWith(`@${DOMAIN}`) ? 'DONE' : 'not yet — needs a redeploy'}`);
  console.log('  4. SNS bounce subscription re-pointed to a monitored mailbox');
  console.log(`  5. allowlist opened to *            ${allowlist === '*' ? 'DONE' : 'not yet — do this LAST'}`);
}
console.log('');
/* Deliberately exits 0 when the only findings are steps not yet taken. "Not
   finished" is not "broken", and a non-zero exit here would make this unusable
   as a routine status check. */
process.exit(0);
