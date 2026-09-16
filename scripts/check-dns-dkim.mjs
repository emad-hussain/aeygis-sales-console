/**
 * Are the SES DKIM records right, have they spread, and does SES agree?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY. Public DNS lookups plus one SES read. Writes nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THREE questions, not one, and each has a different answer to "what now":
 *
 *   1. Is the record in the zone, correctly? Ask the AUTHORITATIVE nameserver.
 *      This is the only question whose answer is ever "go and fix something".
 *   2. Has it spread to public resolvers? Ask 8.8.8.8 and 1.1.1.1.
 *      If (1) is yes and (2) is no, the answer is "wait" — nothing is wrong.
 *   3. Has SES noticed? AWS polls on its own schedule, documented as up to 72
 *      hours, so this lags (2) as well.
 *
 * ── WHY THE AUTHORITATIVE CHECK EXISTS ─────────────────────────────────────
 * An earlier version of this script asked only public resolvers, and on
 * 2026-09-14 it reported one of three correctly-added records as
 * "NOT PUBLISHED — will not fix itself by waiting". Every word of that was
 * wrong: the record was in the zone, correct, and waiting was precisely the
 * remedy. The three records had simply propagated at different rates.
 *
 * That is a worse failure than not checking at all, because it sends somebody
 * to re-type a record that is already right — and re-typing it is how a correct
 * record becomes a broken one. **Absent from a resolver is not absent from the
 * zone.** Only the authoritative server can answer "did you add it".
 *
 * Run:  AWS_PROFILE=aeygis npm run check:dns
 */
import { Resolver } from 'node:dns/promises';
import { SESv2Client, GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';

const DOMAIN = 'aeygis.com';
const REGION = 'ca-central-1';

/** From `create-email-identity`, 2026-09-14. */
const TOKENS = [
  '46ztkpn637zjxmthomt65c26ixsmfk2z',
  'nahf6roeytonhbqpjtv5z2fgaz5jfmcl',
  'tpygh6cge6xc7njidendkjl4eke2rqtw',
];

let failures = 0;
let propagating = 0;
let pending = 0;
let unreachable = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const wait = (m) => { console.log(`  WAIT  ${m}`); };

const publicResolver = new Resolver({ timeout: 5000, tries: 2 });
/* Public resolvers rather than the local one: this machine's resolver refused
   the connection outright on the first run, and a local cache can hold a
   negative answer from before the records were added. */
publicResolver.setServers(['8.8.8.8', '1.1.1.1']);

const clean = (list) => list.map((a) => a.replace(/\.$/, '').toLowerCase());

console.log(`Domain: ${DOMAIN}`);
console.log(`Region: ${REGION}\n`);

// ── find the authoritative nameservers ─────────────────────────────────────
let authResolver = null;
try {
  const ns = await publicResolver.resolveNs(DOMAIN);
  const ips = [];
  for (const host of ns.slice(0, 2)) {
    try {
      ips.push(...(await publicResolver.resolve4(host)));
    } catch {
      // One unreachable nameserver is survivable; none is not.
    }
  }
  if (ips.length > 0) {
    authResolver = new Resolver({ timeout: 5000, tries: 2 });
    authResolver.setServers(ips);
    console.log(`Authoritative: ${ns.slice(0, 2).join(', ')}\n`);
  } else {
    console.log(`Authoritative: could not resolve any of ${ns.join(', ')}\n`);
  }
} catch (error) {
  console.log(`Authoritative: could not look up NS for ${DOMAIN} (${error.code ?? error.message})\n`);
}

// ── 1 + 2. the records ─────────────────────────────────────────────────────
console.log('Each record, at the source and then out in the world:\n');

for (const token of TOKENS) {
  const name = `${token}._domainkey.${DOMAIN}`;
  const expected = `${token}.dkim.amazonses.com`;
  const short = `${token.slice(0, 12)}…`;

  // ── in the zone? ──
  let inZone = null; // null = could not ask
  if (authResolver !== null) {
    try {
      inZone = clean(await authResolver.resolveCname(name)).includes(expected);
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
        inZone = false;
      } else {
        unreachable += 1;
        console.error(`  ????  ${short}  could not ask the authoritative server: ${error.code ?? error.message}`);
        continue;
      }
    }
  }

  if (inZone === false) {
    fail(`${short}  NOT IN THE ZONE — the authoritative server has no such CNAME`);

    /* The specific mistake worth naming: Hostinger appends the domain to
       whatever is typed in the Name field, so typing the full name doubles it. */
    try {
      await authResolver.resolveCname(`${name}.${DOMAIN}`);
      fail(`        FOUND IT AT ${name}.${DOMAIN}`);
      fail('        The domain was typed into the Name field AND appended by Hostinger.');
      fail(`        Fix: set the name to "${token}._domainkey", with no domain suffix.`);
    } catch {
      fail(`        Add:  CNAME  ${token}._domainkey  ->  ${expected}`);
    }
    continue;
  }

  // ── spread yet? ──
  let published = false;
  try {
    published = clean(await publicResolver.resolveCname(name)).includes(expected);
  } catch (error) {
    if (error.code !== 'ENOTFOUND' && error.code !== 'ENODATA') {
      unreachable += 1;
      console.error(`  ????  ${short}  could not ask a public resolver: ${error.code ?? error.message}`);
      continue;
    }
  }

  if (published) {
    pass(`${short}  correct, and live on public resolvers`);
  } else if (inZone === true) {
    /* NOT a failure. The zone is right; the internet has not caught up. Saying
       "missing" here is what sent somebody to re-type a correct record. */
    propagating += 1;
    wait(`${short}  correct in the zone, not yet on public resolvers — propagating`);
  } else {
    // Could not reach the authoritative server, and it is absent publicly.
    propagating += 1;
    wait(`${short}  not on public resolvers, and the zone could not be checked`);
  }
}

// ── 3. has SES noticed ─────────────────────────────────────────────────────
console.log('\nWhat SES currently thinks:\n');

try {
  const ses = new SESv2Client({ region: REGION });
  const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: DOMAIN }));
  const dkim = identity.DkimAttributes ?? {};

  identity.VerifiedForSendingStatus === true
    ? pass('the domain is VERIFIED for sending')
    : wait('not verified for sending yet');

  switch (dkim.Status) {
    case 'SUCCESS':
      pass('DKIM status: SUCCESS');
      break;
    case 'PENDING':
      pending += 1;
      wait('DKIM status: PENDING — AWS has not confirmed the records yet (up to 72 h)');
      break;
    case 'FAILED':
      fail('DKIM status: FAILED — AWS looked and could not find valid records');
      break;
    case 'TEMPORARY_FAILURE':
      pending += 1;
      wait('DKIM status: TEMPORARY_FAILURE — AWS will retry');
      break;
    default:
      fail(`DKIM status: ${dkim.Status ?? 'unknown'}`);
  }

  dkim.SigningEnabled === true
    ? pass('DKIM signing is enabled')
    : fail('DKIM signing is DISABLED — messages would go out unsigned');
} catch (error) {
  if (error.name === 'NotFoundException') {
    fail(`${DOMAIN} is not an identity in SES ${REGION} at all`);
  } else if (/credential|token/i.test(error.message ?? '')) {
    fail('no working AWS credentials — try:  AWS_PROFILE=aeygis npm run check:dns');
  } else {
    fail(`SES read failed: ${error.name ?? ''} ${error.message ?? error}`);
  }
}

// ── what to do about it ────────────────────────────────────────────────────
console.log('');
if (unreachable > 0) {
  console.log(`Could not reach a resolver for ${unreachable} lookup(s). That says nothing`);
  console.log('about the records — only that this machine could not ask.');
} else if (failures > 0) {
  console.log(`${failures} real problem(s). Waiting will NOT fix these.`);
  console.log('See docs/dns-records-to-add.md.');
} else if (propagating > 0 || pending > 0) {
  console.log('Nothing is wrong. Every record is correct in the zone; the rest is');
  console.log('other people\'s caches and AWS\'s polling schedule. Re-run later.');
} else {
  console.log('DKIM is live and SES agrees. aeygis.com can sign mail.');
  console.log('');
  console.log('Next: confirm aws@aeygis.com exists, then re-request production');
  console.log('access on case 178930966200969. Do NOT switch SES_FROM_ADDRESS');
  console.log('until production access is granted — see docs/email-setup.md.');
}
console.log('');
/* Propagation and AWS polling are not failures — exiting non-zero for them
   would make this unusable in any sequence of checks. */
process.exit(failures === 0 && unreachable === 0 ? 0 : 1);
