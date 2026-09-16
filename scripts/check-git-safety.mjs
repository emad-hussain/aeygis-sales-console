/**
 * Would pushing this repo expose something it should not?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY. Reads git config and asks GitHub whether the remote is public.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-09-16 this repository was pushed to a PUBLIC GitHub repo. No
 * credentials went with it — the .gitignore did its job on those — but
 * `packages/pricing-internal/src/index.ts` did, and that file holds delivery
 * cost per hour, the cost ratio against Canadian competitors, competitor
 * pricing and the negotiation playbook. It was readable by anyone, no login,
 * for about an hour.
 *
 * ── WHY IT DOES NOT JUST GITIGNORE THAT PACKAGE ────────────────────────────
 * Because the file is not wrong to be in the repository. A private repo holding
 * a company's own cost model is ordinary. And it cannot be removed anyway:
 * `render-proposal-pdf/assertClientSafe.test.ts` imports it ON PURPOSE, to
 * prove the leak guard catches REAL internal values rather than invented
 * lookalikes. Ignore the package and `npm test` fails on every fresh clone,
 * while package-lock.json still references it as a workspace.
 *
 * So the thing that went wrong was not "this file is committed". It was "this
 * repository is public". That is what is checked here.
 *
 * ── THE OTHER HALF ─────────────────────────────────────────────────────────
 * Some files should never be committed to ANY repository, public or private —
 * live credentials, generated config carrying resource ids, confidential PDFs.
 * Those are checked separately and fail regardless of visibility.
 *
 * Run:  npm run check:git
 * Or install it as a pre-push hook:  npm run hook:install
 */
import { execFileSync } from 'node:child_process';

/* Read before anything uses it. An earlier version parsed this at the END,
   after failures had already been counted, so the flag printed a reassuring
   line and changed nothing — an override that did not override. */
const SKIP_VISIBILITY = process.argv.includes('--skip-visibility');

let failures = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };
const note = (m) => console.log(`  NOTE  ${m}`);
/* Visibility problems are the only ones --skip-visibility may waive. A tracked
   credential is never waivable, so it uses bad() and never this. */
const badVisibility = (m) => {
  if (SKIP_VISIBILITY) { note(`(waived) ${m}`); return; }
  console.error(`  FAIL  ${m}`);
  failures += 1;
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

console.log('Git safety\n');

// ── is this even a repo yet? ───────────────────────────────────────────────
try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  console.log('  Not a git repository — nothing to check.\n');
  process.exit(0);
}

// ── 1. files that must never be committed, public or private ───────────────
/**
 * Matched against TRACKED paths, not the working tree. A file present on disk
 * but correctly ignored is not a problem; a file git knows about is.
 */
const NEVER_COMMIT = [
  { pattern: /(^|\/)\.test-credentials\.json$/, why: 'live Cognito usernames and passwords' },
  { pattern: /(^|\/)amplify_outputs.*\.json$/, why: 'generated config carrying real resource ids' },
  { pattern: /(^|\/)amplifyconfiguration.*\.json$/, why: 'generated config carrying real resource ids' },
  { pattern: /(^|\/)\.env(\.|$)/, why: 'environment secrets' },
  { pattern: /Rate_Card.*\.pdf$/i, why: 'CONFIDENTIAL — cost per hour, margins, competitor analysis' },
  { pattern: /Price_List.*\.pdf$/i, why: 'internal price list' },
  { pattern: /Setup_Fees.*\.pdf$/i, why: 'internal fee schedule' },
  { pattern: /\.pem$|\.p12$|\.pfx$|(^|\/)id_rsa/, why: 'private key material' },
];

let tracked = [];
try {
  tracked = git(['ls-files']).split('\n').filter(Boolean);
} catch {
  bad('could not list tracked files');
}

if (tracked.length === 0) {
  /* Guards the guard. Every check below is "X is absent", and those all pass
     on an empty list — a repo this script failed to read would get a clean
     bill of health. See gotcha §16.21. */
  bad('no tracked files found — the checks below would be vacuous');
} else {
  const offenders = [];
  for (const { pattern, why } of NEVER_COMMIT) {
    for (const file of tracked.filter((f) => pattern.test(f))) offenders.push({ file, why });
  }

  if (offenders.length === 0) {
    ok(`no forbidden file is tracked (${tracked.length} files checked)`);
  } else {
    for (const { file, why } of offenders) bad(`TRACKED: ${file} — ${why}`);
  }
}

// ── 2. is the remote public? ───────────────────────────────────────────────
/**
 * The check that would have caught 2026-09-16.
 *
 * Only GitHub HTTPS/SSH remotes can be resolved this way. Anything else is
 * reported as unknown rather than assumed safe — an unrecognised host is not
 * evidence of privacy.
 */
let remote = null;
try {
  remote = git(['remote', 'get-url', 'origin']);
} catch {
  note('no "origin" remote — nothing to push to yet');
}

if (remote !== null) {
  const gh = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (gh === null) {
    note(`remote is not GitHub (${remote}) — visibility cannot be checked here`);
  } else {
    const [, owner, repo] = gh;
    try {
      /* Unauthenticated on purpose. If an anonymous request can read the repo
         metadata, an anonymous request can read the repo. That is exactly the
         question, and asking with a token would answer a different one. */
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { 'user-agent': 'aeygis-check-git-safety' },
      });

      if (res.status === 404) {
        /* Cancel the body. An unread response keeps undici's socket open, and a
           live handle at exit crashes Node on Windows with a libuv assertion —
           which made this script exit 127 instead of 1. A pre-push hook reads
           that code, so it has to be right. */
        await res.body?.cancel().catch(() => {});
        ok(`${owner}/${repo} is PRIVATE (anonymous request is refused)`);
      } else if (res.ok) {
        const body = await res.json();
        badVisibility(`${owner}/${repo} is ${String(body.visibility ?? 'PUBLIC').toUpperCase()}`);
        badVisibility('  packages/pricing-internal holds delivery cost, margins and competitor pricing.');
        badVisibility('  Make the repository private before pushing.');
        if ((body.forks_count ?? 0) > 0) {
          badVisibility(`  ${body.forks_count} fork(s) exist — going private does NOT remove those.`);
        }
      } else {
        await res.body?.cancel().catch(() => {});
        /* Fails CLOSED. An unanswered question about whether secrets are
           public must not read as "no problem" — that is the assumption this
           script exists to stop anyone making. */
        badVisibility(`could not determine visibility (HTTP ${res.status}) — treating as unsafe`);
        note('  override with: npm run check:git -- --skip-visibility');
      }
    } catch (error) {
      badVisibility(`could not reach GitHub to check visibility (${error.message})`);
      note('  override with: npm run check:git -- --skip-visibility');
    }
  }
}

// ── result ─────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('Safe to push.');
} else {
  console.log(`${failures} problem(s). See docs/email-setup.md and known-issues.md.`);
}
console.log('');

/* process.exitCode, NOT process.exit(). Calling exit() while a fetch socket is
   still open crashes Node on Windows with a libuv assertion, and the crash
   reported exit code 127 rather than 1 — a code a pre-push hook cannot trust.
   Setting the code and letting Node drain its own handles exits cleanly.
   The early process.exit(0) above is fine: it runs before any fetch. */
process.exitCode = failures === 0 ? 0 : 1;
