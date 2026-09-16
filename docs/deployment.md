# Deployment

> **Living document.** Updated in the same session as any change it describes.
>
> **Status (2026-08-26): Phases 1–6 complete.** All six Lambdas, five models and the
> SES pipeline are deployed to the `ca-central-1` sandbox. PDF rendering works (P4 is
> closed). The public assessment form submits to this backend and nothing else, and a
> new-lead notification email is sent and proven.
>
> **The P4 section below is kept as a record of how the Chromium hosting problem was
> solved**, not as an open task.

---

## ⛔ Before you deploy anything

Every command on this page that touches AWS requires **explicit per-action permission** from the user. Approval for one action is not approval for the next. See `PROJECT-STATUS.md` → Operating Rules.

Also: **never deploy the live site** (`aeygis-website-source-code`). Its two Phase 1 edits are authored locally and handed to the user.

---

## The one thing most likely to go wrong: region

**Amplify Gen 2 has no region configuration field.** There is no `region:` property on `defineBackend`, and `DataProps` has none either. Region is resolved *entirely* from the AWS credential chain:

```
AWS_REGION  →  AWS_DEFAULT_REGION  →  profile's `region`  →  instance metadata
```

This project **must** deploy to `ca-central-1` — Canadian data residency is the core value proposition sold in `Aeygis_Cloud_Overview.pdf` and mandated by the Migration Framework. A silent deploy to `us-east-1` would put Ontario clinic data in Virginia while marketing claims otherwise.

### How region is set here - and why not via the profile

**Account:** `326629581669` (IAM user `emad`), using the **`default`** AWS profile.
That profile's region is `us-east-1` and is **deliberately left unchanged.**

Region is pinned per-command via `AWS_REGION=ca-central-1`, wired into every npm
script with `cross-env` so it behaves identically on Windows and Unix:

```json
"sandbox":   "cross-env AWS_REGION=ca-central-1 ampx sandbox",
"bootstrap": "cross-env AWS_REGION=ca-central-1 cdk bootstrap aws://326629581669/ca-central-1"
```

Two reasons this beats editing `[default] region`:

1. **No side effects.** The `default` profile is used for unrelated work in this
   account - there are already two other Amplify apps in ca-central-1 and a
   bootstrapped us-east-1. Repointing the global default would silently change
   the target region for every other tool and script on this machine.

2. **It makes the safety net actually work.** The guard in `amplify/backend.ts`
   reads `AWS_REGION` / `AWS_DEFAULT_REGION` / `CDK_DEFAULT_REGION`. If the region
   came from `~/.aws/config` instead, all three would be `undefined`, the guard
   would fall through to a warning, and a mis-regioned deploy would proceed.
   Setting the env var explicitly is what upgrades the guard from "warns" to
   "throws".

Always invoke through the npm scripts. A bare `npx ampx sandbox` would inherit
`us-east-1` from the profile.

### The region guard

`amplify/backend.ts` asserts the resolved region at synth time and **throws** on
mismatch, so a mis-regioned deploy fails loudly instead of silently succeeding.

**The guard is best-effort, not a control.** It reads env vars only. The single
enforceable control is an SCP or an `aws:RequestedRegion` deny condition on the
deploy role - add one before this handles real client data. Tracked as an open
gap in `PROJECT-STATUS.md`.
---

## Environments

| Environment | How it deploys | Region | Purpose |
|---|---|---|---|
| **Local sandbox** | `npm run sandbox` | ca-central-1 | Per-developer ephemeral stack. Safe to delete and recreate. |
| **Branch (future)** | `ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID` | ca-central-1 | Not yet created. Requires an Amplify Hosting app — needs approval. |

The sandbox is the only environment that exists today.

### Prerequisites

- Node `>=22` (verified locally: v24.18.0)
- The `default` AWS profile authenticated to account `326629581669`
- `ca-central-1` CDK-bootstrapped in the target account (Task 1.3, **needs approval**)

### First-time setup

```bash
npm install                                    # local, no approval needed  ✅ DONE
npm run bootstrap                              # ⛔ NEEDS APPROVAL
npm run secret:salt                            # ⛔ NEEDS APPROVAL
npm run sandbox                                # ⛔ NEEDS APPROVAL — creates real resources
```

**`IP_HASH_SALT` must be set before the sandbox is useful.** Submitter IPs are
stored only as a salted SHA-256. IPv4 space is ~4 billion addresses, so a
missing or publicly-known salt makes those hashes reversible by brute force,
which would turn `submitterIpHash` into retained personal information. The
handler therefore refuses to hash without the secret and skips rate limiting
instead — failing open rather than pretending to protect something.

Use a long random value, e.g. `openssl rand -base64 32`.

### After the first deploy — wire up the live site

`ampx sandbox` writes `amplify_outputs.json` containing the AppSync URL. It belongs in
`AEYGIS_API_ENDPOINT` in the website repo, at `assets/js/assessment.js`.

**That constant is now SET.** It used to be blank on purpose, because the backend call
was a mirror alongside a formsubmit.co email and activating it was a separate, deliberate
act. On 2026-08-25 the email was removed and the backend became the **only** destination
for an assessment - so a blank endpoint would no longer switch a mirror off, it would
silently discard every lead. `verify-sigv4-offline.mjs` and `verify-browser-signing.mjs`
now assert it stays set and matches the deployed API.

The file moved too: the website was rewritten from a compiled bundle into hand-written
source on 2026-08-25, which deleted `assets/aeygis-enhancements.js`.

**The live site is deployed by the user, not by this project.**

`ampx sandbox` watches for changes and redeploys on save. It generates `amplify_outputs.json`, which is **gitignored** — it contains environment-specific IDs and must never be committed.

### Tearing down

```bash
npm run sandbox:delete    # ⛔ NEEDS APPROVAL — destroys resources
```

Note `keepOnDelete: true` on storage means the S3 bucket **survives** a sandbox delete, deliberately, so generated proposals are not lost. Buckets must be cleaned up manually if genuinely unwanted.

---

## Promoting changes

Not yet applicable — no branch environment exists. When one is created, the intended flow is:

1. Develop against the local sandbox.
2. `npm run typecheck && npm test && npm run lint:boundaries` must all pass.
   `lint:boundaries` enforces that `@aeygis/pricing-internal` never becomes reachable from the PDF renderer — treat a failure as a confidentiality incident, not a lint nit.
3. Merge to the tracked branch; Amplify Hosting builds and runs `pipeline-deploy`.
4. Verify post-deploy: every resource ARN contains `ca-central-1`.

---

## Rollback

| What | How |
|---|---|
| Backend resources | CloudFormation retains the prior template; roll back the stack, or revert the commit and redeploy. |
| Generated proposal PDFs | S3 versioning is **enabled** — restore a prior object version. |
| `ProposalVersion` records | **Immutable by design.** `update`/`delete` mutations do not exist in the schema. Roll forward with a new version; never mutate history. |
| Approvals / audit events | **Immutable.** Never rolled back. A reversal is a new event, not an edit. |

---

> **Open pending items before real client data** (full detail in `PROJECT-STATUS.md`):
> **P12** the backend is the ONLY path a lead has — a failed submission loses it. A retry
> absorbs transient failures; the idempotency key that would remove the duplicate window
> is designed but not built ·
> **SES production access** — **requested 2026-08-28, DENIED** (case `178930966200969`).
> Needs `aeygis.com` verified in SES first; the domain's own DMARC policy is
> `p=quarantine`, so sending from it before DKIM exists is worse than not sending.
> See `email-setup.md` ·
> **The live site is not deployed**, so nothing reaches this backend yet.
>
> Closed: **P1** and **P2** (superseded — there is no dual-write any more), **P3**
> (declined by the user), **P4–P11**.

---

## P4 — Enabling PDF rendering (discrete task)

### Status: resolved — CloudFront + private bucket, not a presigned URL

**Correction to this doc's own earlier advice.** This section previously said to
prefer a presigned URL over a public object. That was wrong, caught by reading
`@sparticuz/chromium-min`'s actual source
(`node_modules/@sparticuz/chromium-min/build/helper.js`) rather than guessing:

```js
const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
```

That is a **plain, unauthenticated fetch — no SigV4 signing, no headers**. An S3
URL the function's IAM role can read is therefore NOT sufficient on its own; the
URL must be fetchable with zero credentials. A presigned URL would satisfy that
today and then **silently expire later** — chromium-min only refetches on a cold
start, so this would work for days or weeks and then start failing with no code
change and no warning. Wrong shape for a value living in a Lambda env var
indefinitely.

**The resolution: CloudFront with Origin Access Control in front of a fully
private bucket.** The bucket keeps `BlockPublicAccess.BLOCK_ALL`, identical to
every other bucket in this account — only the CloudFront distribution (via OAC)
can read it. This gives chromium-min a plain HTTPS URL it can fetch with no
credentials, without touching the account's S3 Block Public Access settings at
all (confirmed ON, all four flags, via `aws s3control get-public-access-block`
before deciding this).

Implemented as its own CDK stack in `amplify/backend.ts`
(`backend.createStack('ChromiumPack')`, same pattern as `encryptionStack` — a
dedicated stack, not nested inside `render-proposal-pdf`'s own function stack,
for the same circular-dependency reason documented just above it in that file).
The bucket holds only this one build artifact, never client data, and is
deliberately separate from the proposals bucket in `storage/resource.ts`.

`CHROMIUM_PACK_URL` is derived automatically from
`chromiumPackDistribution.distributionDomainName` — never hand-typed.

Everything else was already verified before this — proven by invoking the
deployed function (`FunctionError: null`, the designed refusal returned), and
because `@sparticuz/chromium-min` and `TEMPLATE_ASSETS` are both **top-level
imports**, a clean load proves the whole module graph resolves:

| Verified | How |
|---|---|
| esbuild bundle loads under ESM | invocation returned without an unhandled error |
| `chromium-min` is EXTERNAL, not inlined | `from"@sparticuz/chromium-min"` in the package; library's "must externalize" guard text absent |
| layer resolves | earlier failure path was `/opt/nodejs/node_modules/@sparticuz/chromium-min/...` |
| all 18 transitive deps resolve | the `tar-fs` error is gone |
| fonts + logos inlined | base64 `wOF2` signature present in the bundle; no ENOENT |
| content-hashed layer id works | deployed as `ChromiumLayerbbd3e323` |

### Steps

1. Confirm the pack version matches the installed `@sparticuz/chromium-min`
   exactly — a mismatch produces an obscure launch failure, not a clear error.
   Pinned today at `149.0.0` (`layers/chromium/VERSION`).

   ```bash
   grep '"version"' node_modules/@sparticuz/chromium-min/package.json
   ```

2. Download the matching **x64** pack — the release asset is architecture-
   qualified (`chromium-v<version>-pack.x64.tar` / `...arm64.tar`), and
   `NodejsFunction` defaults to x64 unless `architecture` is set explicitly.

   ```bash
   curl -L -o chromium-v149.0.0-pack.x64.tar \
     https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar
   ```

3. Deploy (`npm run sandbox`) to create the `ChromiumPack` stack (bucket +
   CloudFront distribution). **Expect 5–15 minutes** for CloudFront to
   propagate — slower than a normal Amplify deploy.

4. Upload the pack to the new bucket, under the same key
   `chromium/chromium-v149.0.0-pack.x64.tar` that `backend.ts` references:

   ```bash
   aws s3 cp chromium-v149.0.0-pack.x64.tar \
     s3://<ChromiumPackBucket name>/chromium/chromium-v149.0.0-pack.x64.tar \
     --region ca-central-1
   ```

5. Verify end to end — do **not** infer success from the deploy:

   ```bash
   npm run preview:proposal   # proves the DOCUMENT is right (local Chrome)
   # then walk the console: sign in, Generate a proposal, confirm a PDF
   # lands in proposals/client/ with non-trivial size, and that it opens
   # via the "View PDF" button (getUrl(), a presigned link, 5 min expiry)
   ```

### Expect to spend time on bundling

`@sparticuz/chromium-min` must be treated as **external** by esbuild, or the
relative paths it uses to locate the binary get rewritten. If Amplify's bundling
options cannot express that, the documented fallback is `defineFunction(provider)`
with a hand-configured `NodejsFunction`. Budget half a day; this is the single
most likely thing in the project to consume unplanned time.

## Gotchas that have already cost time here

Recorded because each was discovered the hard way, not read in advance.

**1. `ampx sandbox` is a persistent watcher, not a one-shot deploy.** There is no
`--once` flag. A second instance fails with `MultipleSandboxInstancesError` /
`ConcurrentReadLock` over `.amplify/artifacts/cdk.out`. Any iterate-and-redeploy
loop must stop the prior instance first - or better, leave one watcher running and
let it pick up file changes, which is what it is designed for. This cost two
wasted deploy cycles.

**2. Never pipe the watcher through `tail`/`head`.** `npm run sandbox | tail -25`
produces **no output at all**, because the pipe never flushes for a process that
does not exit. Redirect to a file and read that instead.

**3. Amplify's DynamoDB tables are a custom resource, not `AWS::DynamoDB::Table`.**
`table.node.defaultChild` is `undefined`, so the normal CDK L1 escape hatch fails
at synth with "Cannot set properties of undefined". Overrides go through
`backend.data.resources.cfnResources.amplifyDynamoDbTables[modelName]`.

**4. `SSEType` is exported by `@aws-amplify/graphql-api-construct`**, not by
`aws-cdk-lib/aws-dynamodb`.

**5. A successful encryption deploy does not mean the app works.** See the
three-role-family trap in `aws-resources.md`: a missing grant on the AppSync
data-source role lets the deploy succeed and reports encryption ENABLED while
every write fails at runtime. Always finish with `npm run verify`.

**6. Amplify IGNORES `kmsMasterKeyId` when it CREATES a table.** The most
deceptive failure found so far. A newly created model comes up KMS-encrypted but
under the AWS-managed `alias/aws/dynamodb` key; the CMK is only honoured on a
later UPDATE. Meanwhile the CFN template correctly requests the CMK, synth logs
success, and `describe-table` reports `SSEType: KMS`, `Status: ENABLED`. Every
signal short of comparing the key ARN says it worked.

`ProposalVersion` landed on the wrong key exactly this way. `Assessment` was fine
only because it pre-existed and got updated.

**This affects every new model on its first deploy**, including `Approval` and
`AuditEvent` in Phase 4. After any deploy that adds a model:

```bash
npm run verify:encryption      # compares the actual key ARN, not the template
# remediate if it fails:
aws dynamodb update-table --table-name <T> --region ca-central-1   --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=<cmk-arn>"
```

---

## Verification commands

```bash
npm run typecheck        # local
npm test                 # 315 unit tests, no AWS
npm run lint:boundaries  # confidentiality barrier
npm run check:synth      # 24 checks on the synthesized CloudFormation, no AWS
npm run verify:site      # 171 checks on the live-site code, no AWS
npm run verify           # against the DEPLOYED API (writes real records)
npm run cleanup:tests    # removes those records
```

`npm run verify` catches runtime breakage that a configuration check cannot. Run
it after every backend change, not only auth changes.

**7. `pgrep` / `pkill` CANNOT SEE Windows processes. Do not trust them.**

Git Bash cannot read Windows process command lines, so `pgrep -f 'ampx sandbox'`
returns **zero matches even while a sandbox is running** — and `pkill -f` kills
nothing. Verified directly by starting a sandbox and testing the patterns.

This silently accumulated **28 orphaned processes** across one session (nine of
them `ampx sandbox`), which exhausted memory and made esbuild die with
`fatal error: runtime: cannot allocate memory` — a failure that looks like a code
problem and is not. Every "confirmed no process running" based on `pgrep` was
false.

Use PowerShell, and note the `@(...)` — a single object has no `.Count`:

```powershell
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
       Where-Object { $_.CommandLine -like '*ampx.js*' })
Write-Output "running: $($p.Count)"
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }
```

**8. A LayerVersion cannot be updated in a sandbox stack.**

`AWS::Lambda::LayerVersion` is immutable, so changed content is a REPLACEMENT
update, and the sandbox deploys with `--disable-rollback`:

```
Replacement type updates not supported on stack with disable-rollback.
```

Fixed structurally: the layer's construct id embeds an 8-char content hash
(`ChromiumLayer<hash>`), so new content becomes a new logical resource and
CloudFormation does create-then-delete instead of replace-in-place. Hand-renaming
the construct works once and is then forgotten.

Note `--disable-rollback` also leaves failed stacks in `UPDATE_FAILED` rather than
rolling back. That is intended: you fix forward and deploy again.

**9. Never pass a bucket NAME to a function via `addEnvironment`.**

```
CloudformationStackCircularDependencyError: circular dependency found
between nested stacks [storage, data, function]
```

`storage` already depends on `function` because `allow.resource(fn)` grants bucket
access. Referencing `bucket.bucketName` from the function stack closes the loop.
Amplify injects such values through an **SSM parameter indirection** precisely to
avoid this — the resource grant supplies `AEYGIS_PROPOSALS_BUCKET_NAME` on its own,
so adding it by hand is not merely redundant, it breaks the deploy.

**10. A layer needs its dependencies, and a directory copy will not give you them.**

The first layer was a `cp -r` of `node_modules/@sparticuz/chromium-min`. It
deployed, and the module resolved from `/opt/nodejs/...`, and the function then
died at runtime:

```
Cannot find package 'tar-fs' imported from
/opt/nodejs/node_modules/@sparticuz/chromium-min/build/helper.js
```

chromium-min pulls in **18 packages**; the hand-copy shipped 1. `npm run build:layer`
now runs `npm install --omit=dev` into the layer and **asserts** `tar-fs` is present
before finishing, because a layer that resolves the entry point but not its
dependencies fails at runtime, not at deploy.

---

## Deploy log

Append an entry for every deploy. Keep newest last.

| Date | Environment | Region | What changed | Approved by |
|---|---|---|---|---|
| 2026-08-17 | bootstrap | ca-central-1 | `CDKToolkit` (12 resources) | user |
| 2026-08-17 | sandbox | ca-central-1 | Phase 1: auth, data, `Assessment`, `submit-assessment` | user |
| 2026-08-17 | sandbox | ca-central-1 | Customer-managed KMS key + PITR (4 attempts - see Gotchas) | user |
| 2026-08-17 | sandbox | ca-central-1 | Phase 3: S3 bucket (versioned, CMK, lifecycle), `ProposalVersion` table, `price-proposal` + `render-proposal-pdf` Lambdas | user |
| 2026-08-17 | manual | ca-central-1 | `update-table` to move `ProposalVersion` onto the CMK - Amplify's create path ignored it (see Gotcha 6) | user |
| 2026-08-23 | manual | ca-central-1 | `create-email-identity` for `rajaemadhussain@gmail.com` (SES). Verified by the user clicking the emailed link; `VerificationStatus: SUCCESS`. Deliberately NOT declared in CDK - see the note in `backend.ts` | user |
| 2026-08-23 | sandbox | ca-central-1 | **Phase 5**: `send-proposal-email` Lambda, `ProposalDelivery` table + resolvers, `sendProposalEmail` mutation, SES configuration set `aeygis-proposal-delivery`, SNS bounce/complaint topic, `ses:SendEmail` + `kms:Decrypt` grants. 184s, no rollback | user |
| 2026-08-23 | manual | ca-central-1 | `update-table` to move `ProposalDelivery` onto the CMK - **Gotcha 6 again**, third occurrence. Caught by `npm run verify:encryption`, which is why that step is mandatory after any deploy that adds a model | user |
| 2026-08-26 | sandbox | ca-central-1 | **New-lead notification.** `submit-assessment` now sends an internal SES email after a successful write (timeout 15s -> 30s, four `NOTIFY_*` env vars, `ses:SendEmail` scoped to the identity + a NEW configuration set `aeygis-internal-notifications` wired to the existing SNS topic). Needed because the public form stopped emailing sales and the backend became the only destination for a lead. 119s, no rollback. **No new model, so `verify:encryption` was not required.** | user |

> **Note on completeness:** deploys between 2026-08-17 and 2026-08-23 (the proposal
> content work, P4-P11, the PDF page changes) were made but not recorded here at the
> time. They are described in `PROJECT-STATUS.md`. This table is not a complete
> history before 2026-08-23; it is from here on.
