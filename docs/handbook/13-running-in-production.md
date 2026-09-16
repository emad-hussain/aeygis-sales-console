# 13. Running in production

← [Running locally](12-running-locally.md) · [Index](README.md) · Next: [Operations](14-operations.md)

> **Honest starting position.** There is no production environment today. What exists is a
> single Amplify **sandbox** — a per-developer ephemeral stack — running in
> `ca-central-1`, holding real infrastructure and test data.
>
> This chapter covers how deployment works today, and everything that has to happen before
> this handles a real client.

---

## 13.1 ⛔ Before you deploy anything

**Every command on this page that touches AWS requires explicit per-action permission.
Approval for one action is not approval for the next.**

**Never deploy the live site** (`aeygis-website-source-code`). Its two edits are authored
locally and handed to the user.

---

## 13.2 The one thing most likely to go wrong: region

**Amplify Gen 2 has no region configuration field.** There is no `region:` property on
`defineBackend`, and `DataProps` has none either. Region is resolved *entirely* from the AWS
credential chain:

```
AWS_REGION  →  AWS_DEFAULT_REGION  →  profile's region  →  instance metadata
```

This project **must** deploy to `ca-central-1`. A silent deploy to `us-east-1` would put
Ontario clinic data in Virginia while the marketing claims otherwise — and it would not
announce itself.

### How region is pinned here, and why not via the profile

**Account** `326629581669`, using the **`default`** AWS profile. That profile's region is
`us-east-1` and is **deliberately left unchanged.**

Region is pinned per command with `cross-env`, so it behaves identically on Windows and Unix:

```json
"sandbox":   "cross-env AWS_REGION=ca-central-1 ampx sandbox",
"bootstrap": "cross-env AWS_REGION=ca-central-1 cdk bootstrap aws://326629581669/ca-central-1"
```

Two reasons this beats editing `[default] region`:

1. **No side effects.** The `default` profile is used for unrelated work in this account —
   there are already two other Amplify apps in `ca-central-1` and a bootstrapped `us-east-1`.
   Repointing the global default would silently change the target region for every other tool
   on the machine.
2. **It makes the safety net actually work.** The guard in `backend.ts` reads `AWS_REGION` /
   `AWS_DEFAULT_REGION` / `CDK_DEFAULT_REGION`. If region came from `~/.aws/config` instead,
   all three would be `undefined`, the guard would fall through to a warning, and a
   mis-regioned deploy would proceed. **Setting the env var explicitly is what upgrades the
   guard from "warns" to "throws".**

> **Always invoke through the npm scripts.** A bare `npx ampx sandbox` would inherit
> `us-east-1` from the profile.

**The guard is best-effort, not a control.** The only enforceable mechanism is an SCP or an
`aws:RequestedRegion` deny condition on the deploy role. **The user reviewed this and
declined it (2026-08-23).**

---

## 13.3 Environments

| Environment | How it deploys | Region | Status |
|---|---|---|---|
| **Local sandbox** | `npm run sandbox` | ca-central-1 | ✅ **The only environment that exists** |
| **Branch (future)** | `ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID` | ca-central-1 | Not created. Requires an Amplify Hosting app — needs approval. |

### What has to change for a branch environment

| Item | Change |
|---|---|
| **DynamoDB deletion protection** | Turn it **on**. It is off in the sandbox because it would block `sandbox:delete`. |
| **`SES_ALLOWED_RECIPIENTS`** | Keep a **real list** in non-production so a test run can never email a real prospect. Only production gets `*`. |
| **`IP_HASH_SALT`** | A **different** salt per environment. |
| **The SES identity** | Must be verified in that account/region — verification is per region. |
| **MFA on the user pool** | Configure it before the console is reachable from the internet. |
| **Alarms** | None exist. See [Operations](14-operations.md). |

---

## 13.4 First-time setup, in order

```bash
npm install            # local, no approval needed
npm run bootstrap      # ⛔ NEEDS APPROVAL — creates CDKToolkit
npm run secret:salt    # ⛔ NEEDS APPROVAL — sets IP_HASH_SALT
npm run build:layer    # local — stages the Chromium layer
npm run check:synth    # local — synthesizes and inspects, no AWS calls
npm run sandbox        # ⛔ NEEDS APPROVAL — creates real resources
```

**`IP_HASH_SALT` must be set before the sandbox is useful.** Use a long random value, e.g.
`openssl rand -base64 32`. See [Security §11.4](11-security.md#114-the-public-write-path)
for why it must be a real secret.

### The Chromium pack — a manual step that cannot be automated away

1. **Confirm the pack version matches the installed package exactly.** A mismatch produces an
   obscure launch failure, not a clear error. Pinned at `149.0.0` in
   `layers/chromium/VERSION`.

   ```bash
   grep '"version"' node_modules/@sparticuz/chromium-min/package.json
   ```

2. **Download the matching x64 pack.** The release asset is architecture-qualified, and
   `NodejsFunction` defaults to x64 unless `architecture` is set explicitly.

   ```bash
   curl -L -o chromium-v149.0.0-pack.x64.tar \
     https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar
   ```

3. **Deploy** to create the `ChromiumPack` stack. **Expect 5–15 minutes** for CloudFront to
   propagate — noticeably slower than the rest of an Amplify deploy.

4. **Upload the pack** under the same key `backend.ts` references:

   ```bash
   aws s3 cp chromium-v149.0.0-pack.x64.tar \
     s3://<ChromiumPackBucket>/chromium/chromium-v149.0.0-pack.x64.tar \
     --region ca-central-1
   ```

5. **Verify end to end — do not infer success from the deploy.** Generate a proposal in the
   console and confirm a PDF lands in `proposals/client/` with non-trivial size and opens via
   "View PDF".

### The SES identity — a manual step, deliberately

```bash
aws sesv2 create-email-identity --email-identity <address> --region ca-central-1
```

**AWS emails a confirmation link and a human must click it.** This cannot be automated, which
is why it is worth starting before the code is written.

It is **deliberately not in CDK**. See
[AWS resources §5.10](05-aws-resources.md#510-ses) for both reasons.

Check it:

```bash
aws sesv2 get-email-identity --email-identity <address> \
  --region ca-central-1 --query 'VerifiedForSendingStatus'
```

### The SNS subscription — also manual

Subscribing an address to `ProposalEmailEvents` sends a confirmation email a human must
click, which is why it is not in CDK. **Done on 2026-08-23** — `rajaemadhussain@gmail.com`,
confirmed. Re-point it to a monitored Aeygis address at the domain cutover.

---

## 13.5 The deploy loop

```bash
npm run sandbox
```

**It is a watcher, not a one-shot.** It deploys, then stays running and redeploys on every
save under `amplify/`. There is no `--once` flag.

**Never pipe it through `tail` or `head`** — the pipe never flushes for a process that does
not exit, so you get no output at all. Redirect to a file.

**Only one instance at a time.** A second fails with `MultipleSandboxInstancesError`. Verify
with PowerShell, not `pgrep` (see [Running locally §12.9](12-running-locally.md#pgrep-and-pkill-cannot-see-windows-processes)).

**It deploys with `--disable-rollback`.** Two consequences:

1. A failed stack stays in `UPDATE_FAILED` rather than rolling back. **That is intended: you
   fix forward and deploy again.**
2. **Replacement-type updates are refused outright**, which is why the Chromium layer's
   construct id embeds a content hash. See
   [AWS resources §5.8](05-aws-resources.md#58-lambda).

### After every deploy that adds a model

```bash
npm run verify:encryption      # MANDATORY — compares the actual key ARN, not the template
```

**Amplify ignores `kmsMasterKeyId` when it CREATES a table.** The new table lands on the
AWS-managed key while the template, the synth log, and `describe-table` all report success.
Remediate with:

```bash
aws dynamodb update-table --table-name <T> --region ca-central-1 \
  --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=<cmk-arn>"
```

**This has happened three times.** It is not a hypothetical.

### After every backend change

```bash
npm run verify        # 4 scripts against the DEPLOYED API — writes real records
npm run cleanup:tests # removes them
```

`npm run verify` catches runtime breakage that a configuration check cannot. **Run it after
every backend change, not only auth changes** — a missing KMS grant on the data-source role
let a deploy succeed, reported encryption as `ENABLED`, and broke every write at runtime.

---

## 13.6 The pre-deploy checklist

```bash
npm run typecheck        # local
npm test                 # 315 unit tests, no AWS
npm run lint:boundaries  # confidentiality barrier — a failure is an incident
npm run check:synth      # 24 checks on the synthesized CloudFormation
npm run verify:site      # 171 checks on the live-site code, no AWS
npm run check:ui         # 131 browser checks, both themes, five widths
```

All five must pass. Then, with permission:

```bash
npm run sandbox
npm run verify:encryption     # if the deploy added a model
npm run verify                # after any backend change
```

---

## 13.7 Tearing down

```bash
npm run sandbox:delete   # ⛔ NEEDS APPROVAL — destroys resources
```

**What survives, deliberately:**

| Resource | Why |
|---|---|
| The proposals S3 bucket | `keepOnDelete: true` — generated proposals and their approval trail should not vanish with an ephemeral dev stack |
| The KMS key | `RemovalPolicy.RETAIN` — destroying it would make every encrypted item permanently unreadable, including backups |
| The Chromium pack bucket | `RemovalPolicy.RETAIN` |
| The SES identity | Never was CDK-managed |

Those must be cleaned up manually if genuinely unwanted.

---

## 13.8 Rollback

| What | How |
|---|---|
| Backend resources | CloudFormation retains the prior template. Roll back the stack, or revert the change and redeploy. |
| Generated proposal PDFs | S3 versioning is **enabled** — restore a prior object version. |
| DynamoDB data | **Point-in-time recovery**, 35-day continuous window, on every table. |
| `ProposalVersion` records | **Immutable by design.** `update` does not exist in the schema. Roll forward with a new version; never mutate history. |
| Approvals, audit events, deliveries | **Immutable.** Never rolled back. A reversal is a new record, not an edit. |

**There is no code rollback**, because there is no version control. See §13.12.

---

## 13.9 The live site's two edits

Authored by this project, **handed to the user to review and deploy.** This project never
deploys the live site.

### Edit 1 — the assessment submission (`assets/js/assessment.js`)

> **This is no longer a dual-write.** It began as a mirror alongside a formsubmit.co email;
> on 2026-08-25 the email was removed and this became the **only** destination for a lead.
> `AEYGIS_API_ENDPOINT` is therefore now **set**, and the verification scripts assert it
> stays set — a blank one would silently discard every submission.
>
> The separate contact-sales form still emails, because the backend has no model for a
> general enquiry.

Mirrors every assessment submission to this backend, alongside the existing formsubmit.co
call, which is untouched.

```js
const AEYGIS_API_ENDPOINT = '';   // AppSync GraphQL URL — set this to activate
```

**The endpoint is now set**, and the assessment form has no other destination — the
formsubmit.co email was removed on 2026-08-25. A blank endpoint would no longer mean "the
mirror is off"; it would silently discard every lead, which is why two verification scripts
assert it stays populated.

The endpoint to paste in:

```
https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql
```

**`scripts/verify-browser-signing.mjs` asserts the constant stays blank**, so activating it is
a deliberate act rather than something that drifts in. **That assertion will start failing
once it is set — update the test in the same change.**

**A bug worth knowing about, already fixed.** The first version of that code sent an unsigned
`fetch` with an optional `x-api-key`. The API has no API key and its guest auth mode is
`AWS_IAM`, so **every request would have been rejected 401** and the error handling would have
swallowed it as a console warning: a silently broken mirror that looks fine. Reading the code
did not catch it; only signing a real request did.

It now performs the real guest flow — `GetId` → `GetCredentialsForIdentity` → SigV4-signed
POST — via Web Crypto. `verify-browser-signing.mjs` **executes exactly what ships to
browsers**, by extracting the source between marker comments rather than reimplementing it.

### Edit 2 — `rm -rf docs` in the live repo's `amplify.yml`

The live repository's build publishes `'**/*'` from the root, and its `docs/` folder contains
`Aeygis_Cloud_Rate_Card.pdf` — stamped **CONFIDENTIAL — Internal Use Only**, with delivery
cost per hour, margin reasoning and competitor analysis.

**Verified 2026-08-17: those paths currently return 404 on both hosts, so nothing is exposed
today.** The edit keeps it that way.

**Authored but NOT deployed.** It ships when the user next deploys the live site.

### Sequencing

**P1 before P2.** Confirm in a real browser that the live form still submits successfully
when the AppSync endpoint is broken or unreachable, *then* activate the endpoint. Pasting it
in is what makes the live site begin transmitting real prospect data.

---

## 13.10 Deploy log

Recorded in [`docs/deployment.md`](../deployment.md), newest last. Append an entry for every
deploy.

| Date | Environment | What changed |
|---|---|---|
| 2026-08-17 | bootstrap | `CDKToolkit` (12 resources) |
| 2026-08-17 | sandbox | Phase 1: auth, data, `Assessment`, `submit-assessment` |
| 2026-08-17 | sandbox | Customer-managed KMS key + PITR (four attempts — see the gotchas) |
| 2026-08-17 | sandbox | Phase 3: S3 bucket, `ProposalVersion`, `price-proposal`, `render-proposal-pdf` |
| 2026-08-17 | manual | `update-table` to move `ProposalVersion` onto the CMK |
| 2026-08-23 | manual | `create-email-identity` for the SES test address |
| 2026-08-23 | sandbox | **Phase 5** — `send-proposal-email`, `ProposalDelivery`, SES configuration set, SNS topic, IAM grants. 184 s, no rollback |
| 2026-08-23 | manual | `update-table` to move `ProposalDelivery` onto the CMK — Gotcha 6, third occurrence |
| 2026-08-23 | sandbox | `ContentTransferEncoding: 'BASE64'` fix. 36 s |
| 2026-08-24 | sandbox | Actor email lookup on the three audit-writing functions. 100 s |

> **Note on completeness.** Deploys between 2026-08-17 and 2026-08-23 (the proposal content
> work, P4–P11, the PDF page changes) were made but not recorded at the time. They are
> described in `PROJECT-STATUS.md`. **The table is complete from 2026-08-23 onward, not
> before.**

---

## 13.11 What must happen before this handles a real client

In rough priority order.

| # | Item | Blocked by | Consequence if skipped |
|---|---|---|---|
| 1 | **SES domain verification + DKIM + SPF + DMARC** | `aeygis.com` DNS access | **Proposals land in spam.** Indistinguishable from not sending them. |
| 2 | **SES production access** | Domain verification | Cannot email any real clinic at all |
| 3 | **Set up version control** | Nothing | No undo, no blame, no review trail on any of the safety code |
| 4 | **Deploy the live site** | The user | Until then no lead reaches this system at all. The code is ready and verified locally. |
| 5 | **An idempotency key on submission** (P12) | A schema change and a deploy | A retry can currently write a duplicate lead if a response is lost |
| 6 | **Configure MFA on the user pool** | Verifying the option shapes | An internal console holding client data, protected by a password alone |
| 7 | **Decide how the console is hosted and who can reach it** | A decision | It should not sit on a public URL |
| 8 | ~~Subscribe an address to the bounce topic~~ **DONE 2026-08-23** | — | Now a cutover task: re-point it to a monitored Aeygis address |
| 9 | **Alarms on Lambda errors and SES bounce rate** | Nothing | Silent failure |
| 10 | **A data-retention decision** | A business decision | Assessments and proposals accumulate forever with no policy |
| 11 | Turn on DynamoDB deletion protection in the branch environment | A branch environment | An accidental stack delete takes the tables |
| 12 | Update `privacy.html` — it will be inaccurate once the dual-write is live | The user said they will do this | A PIPEDA disclosure gap |

---

## 13.12 ⚠ There is no version control

**No git history exists for this repository.**

Every safety property described in this handbook — the immutability rules, the five
confidentiality barriers, the fail-closed allowlist, the hash checks — is enforced in code
that has **no undo, no blame, and no review trail.**

A mistaken edit to `.dependency-cruiser.cjs` or to `assertClientSafe.ts` would be
unrecoverable and unattributable.

**This is the largest self-inflicted risk in the project.** `git init` costs nothing.
