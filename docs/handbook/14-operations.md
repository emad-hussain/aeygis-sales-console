# 14. Operations

← [Running in production](13-running-in-production.md) · [Index](README.md) · Next: [Verification](15-verification.md)

Running the thing day to day: what to watch, what to do when something breaks, and what
this system deliberately does not do for you.

---

## 14.1 Current operational posture, stated honestly

| | |
|---|---|
| **Monitoring** | CloudWatch log groups per Lambda. **No alarms, no metric filters, no dashboards.** |
| **On-call** | Nobody. |
| **Bounce handling** | Topic + **confirmed subscriber** (`rajaemadhussain@gmail.com`). Covers proposal delivery and internal notifications. |
| **Backups** | DynamoDB point-in-time recovery (35 days) on every table. S3 versioning with a 365-day noncurrent lifecycle. |
| **Runbook coverage** | This chapter. |
| **How a NEW LEAD is noticed** | An email from `submit-assessment` on every submission. |
| **How a FAILURE is noticed** | **A person looks.** Nothing alerts. |

Those last two rows are the honest summary, and the distinction matters. A lead arriving
now announces itself. A lead *failing to arrive* — a Lambda erroring, a bounce, a
submission that never completed — announces nothing at all, and silence looks exactly like
a quiet week.

---

## 14.2 What to add first, in order

| # | Add | Why it is first |
|---|---|---|
| 1 | **A CloudWatch alarm on `Errors > 0` for `send-proposal-email`** | It is the only function whose failure a *client* notices. |
| 2 | **An alarm on `Errors` for `submit-assessment`** | It is the only path a lead has. A failure there loses the lead outright. |
| 3 | **Alarms on `Errors` for the other four functions** | A `render-proposal-pdf` failure currently shows only as a "View PDF" button that never appears. |
| 4 | **An alarm on SES bounce and complaint rates** | AWS suspends sending on a sustained high rate. There is no warning. |
| 5 | **A metric filter on `SNAPSHOT INTEGRITY FAILURE`** | That log line means stored bytes no longer match their recorded fingerprint. It should page someone. |
| 6 | **A metric filter on `reachedLambdaDespiteApiRule`** | Reaching it means an API-level authorization rule has stopped working. |

None of these exists today. Each is a small change.

> **The bounce subscriber used to top this list and is now done** — `rajaemadhussain@gmail.com`,
> subscribed and confirmed 2026-08-23. What remains is moving it to a monitored Aeygis
> address at the domain cutover; a personal inbox is single-person coverage, not a rota.

---

## 14.3 Where to look when something goes wrong

### The console first

Most failures in this system are **recorded in the console**, deliberately, so that
answering *"why did the client not get this?"* does not require CloudWatch:

| Question | Where |
|---|---|
| Was the proposal ever sent? | The lead → Approvals → **Send history** |
| Why was it refused? | The `Outcome` pill plus the `Detail` column |
| Which exact document went out? | The `contentSha256` on the delivery row |
| Who approved it, and what were they at the time? | The **decision history** table |
| What happened to this lead overall? | The audit trail (`auditEventsBySubject`) |

### Then CloudWatch

Log groups are per function, named after the deployed function name. Useful strings to grep:

| String | Meaning |
|---|---|
| `SNAPSHOT INTEGRITY FAILURE` | **Serious.** Stored bytes no longer hash to their recorded value. Nothing should be sent until this is understood. |
| `reachedLambdaDespiteApiRule` | An authorization rule that should have refused earlier did not |
| `audit write failed` / `audit write threw` | A record was lost. The action still happened. |
| `delivery row write threw` | A send may have succeeded with no row recorded |
| `IP_HASH_SALT is not set` | Rate limiting is disabled |
| `rate limit query failed, allowing submission` | Counting failed and the submission was allowed through — by design |
| `[identity] email lookup failed` | An audit record will carry a bare UUID |
| `[encryption]` | Emitted at **synth** time, not runtime |

---

## 14.4 Runbooks

### "The client says they never received the proposal"

1. **Console → the lead → Send history.** Find the row.
2. **If there is no row at all** — it was never sent. Check whether the version is approved.
3. **If the status is `blocked`** — the system refused on purpose. The `Detail` column says
   why. While SES is in the sandbox, the most likely reason is that the clinic's address is
   not on the allowlist, which is expected.
4. **If the status is `failed`** — something broke. The reason is in `Detail`.
5. **If the status is `sent`** — SES accepted it. Copy the **SES id** from the Detail column
   (click the chip) and search CloudWatch, or use it with AWS support.
6. **Then check deliverability.** If the sender is still a `@gmail.com` address, the message
   almost certainly went to spam and that is expected. See
   [Email delivery §10.8](10-email-delivery.md#108--deliverability--the-sandbox-proves-the-pipeline-not-that-mail-arrives).

### "View PDF never appears"

The renderer is invoked fire-and-forget, so a failure is silent in the UI.

1. Check CloudWatch for `render-proposal-pdf`.
2. **`CHROMIUM_PACK_URL is not set`** → the environment variable is missing. Redeploy.
3. **A `tar-fs` or module-resolution error** → the layer is missing dependencies. Run
   `npm run build:layer` and redeploy.
4. **A browser launch failure** → the pack version does not match the installed
   `@sparticuz/chromium-min`. Compare against `layers/chromium/VERSION`.
5. **`AEYGIS_PROPOSALS_BUCKET_NAME_PARAM is not set`** → the SSM parameter or its IAM grant is
   missing.
6. **A `ClientSafetyError`** → **this is the guard working.** Something confidential reached
   the payload. Do not weaken the guard; fix the payload.

### "Every write fails, but the deploy succeeded"

This is the KMS data-source-role trap.

```bash
npm run verify:encryption
npm run verify
```

The deploy reports success and `describe-table` reports `SSEType: KMS, Status: ENABLED`
while the AppSync data-source role has no `kms:Decrypt`. See
[AWS resources §5.5](05-aws-resources.md#55-kms).

### "A new model landed on the wrong KMS key"

Expected — Amplify ignores `kmsMasterKeyId` on table **create**.

```bash
npm run verify:encryption

aws dynamodb update-table --table-name <T> --region ca-central-1 \
  --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=<cmk-arn>"

npm run verify:encryption   # confirm
```

### "The console renders a blank page"

Almost always one of two things, both already fixed but both easy to reintroduce:

1. **Two copies of React.** Check `npm ls react`. Root `overrides` pins one version;
   `dedupe` in `vite.config.ts` is the second line of defence.
2. **`generateClient()` running before `Amplify.configure()`.** Do not hoist the client to
   module scope in `client.ts`.

Run `node scripts/verify-console-renders.mjs` — it loads the app in a real browser and fails
on console errors, which is the only check that can see either fault.

### "The dev server is serving old code"

Vite's watcher on this Windows setup can keep a mid-edit transform in its cache. **Nothing
errors — the page just renders older code, and any verification you run against it is
meaningless.**

`npm run check:ui` fails loudly on this before anything else runs. Touch the files or restart
`npm run console`.

### "`ampx sandbox` will not start"

`MultipleSandboxInstancesError` means another instance holds the lock. **Do not trust
`pgrep`** — it cannot see Windows processes:

```powershell
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
       Where-Object { $_.CommandLine -like '*ampx.js*' })
Write-Output "running: $($p.Count)"
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }
```

If esbuild dies with `fatal error: runtime: cannot allocate memory`, that is orphaned
processes exhausting memory — not a code problem.

### "Emails suddenly stop being delivered"

1. **Check the account-level suppression list.** A bounce against your own test address puts
   it there, and subsequent sends fail for reasons that look nothing like the cause.
2. Check the SES sending quota (200/24h and 1/second in the sandbox).
3. Check `SES_ENABLED` — anything other than the exact string `'true'` is off.
4. Check the identity is still verified.

### "Something confidential reached a client document"

**Treat this as an incident, not a bug.**

1. The render should have **failed**, not succeeded — `assertClientSafe` throws. If a document
   was produced, barrier 5 was bypassed or weakened. Establish which.
2. `npm run lint:boundaries` — did barrier 1 break?
3. `npm run check:synth` — did barrier 4 break?
4. Check which proposals were rendered since the change, and whether any were **sent**. The
   `ProposalDelivery` table answers that exactly, with the content hash of what went out.
5. **Do not weaken the guard to make the render succeed.** Fix the payload.

---

## 14.5 Routine housekeeping

### After running verification against AWS

```bash
npm run cleanup:tests
```

The `verify-*` scripts each write real records every run — that is the point, they exercise
the live write path. Without cleanup the console fills with fake clinics and a real lead
could be missed among them.

**It only deletes records whose email is on the known test-address list**, so it can never
remove a genuine submission. A record that looks like a test but has an unrecognised address
is **reported and left alone** — refusing to guess is the whole point.

### Test Cognito users

```bash
npm run cleanup:users
```

Same principle: only usernames on its explicit list, and it reports any other user in the
pool rather than guessing.

### Currently in the system

Four test leads marked `[e2e-email]` from the Phase 5 verification walk. `npm run
cleanup:tests` clears them.

---

## 14.6 Cost

At sales volume everything is effectively free, well inside AWS free tiers, with four things
worth watching:

| Item | Why it costs | Mitigation in place |
|---|---|---|
| **KMS** | A CMK bills **per API call**, unlike the AWS-owned key | DynamoDB caches the table key for 5 minutes; S3 has `bucketKeyEnabled` |
| **`render-proposal-pdf`** | 2048 MB, billed per GB-second; the cold start is the expensive part | Async and off the request path, so no provisioned concurrency — that would be the genuinely expensive choice |
| **S3 versioning** | Retains every prior object version | Lifecycle rule: 10 newest, 365 days |
| **CloudFront** | One 66 MB object | Fetched only on Lambda cold starts; `PRICE_CLASS_100` |

**There should be no standing hourly charge in this stack.** No NAT Gateway, no VPC, no
always-on compute. **If one appears, something was created outside `amplify/`.**

---

## 14.7 Scaling limits worth knowing

| Limit | Value | Bites when |
|---|---|---|
| SES sandbox | 200 messages / 24 h, 1 / second | Never at this volume — but escaping the sandbox is per region |
| SES recipients per message | 50 | Not a constraint; noted so nobody widens BCC without knowing |
| SESv2 message size | 40 MB after base64 | A proposal is ~300 KB |
| `listAssessments` | `limit: 200`, no pagination | **At 200+ leads the queue silently truncates.** This will need paging. |
| Lambda concurrency | Account default | Not a factor at this volume |
| DynamoDB | `PAY_PER_REQUEST` | Scales itself |

**The 200-lead queue limit is the first thing that will actually bind.** It is a plain
`list`, deliberately (so a record with an unexpected status can never become invisible), and
it does not paginate.

---

## 14.8 Open items, carried forward

| Item | State | Blocked by |
|---|---|---|
| **SES production access** | Not started | `aeygis.com` DNS access. **The one with commercial consequences** — until then, proposals to real clinics land in spam. |
| **P12 — the backend is the only path** | Open | An idempotency key would remove the duplicate window a retry can cause. Designed, not built. |
| **Deploy the live site** | Open | The user. Until then nothing reaches this backend from the real site. |
| **`git init`** | Open | Nothing. The user has said they will do it. |
| **MFA on the user pool** | Not configured | Verifying the Amplify option shapes |
| **Console hosting** | Not created | A decision about who may reach it |
| **SNS bounce subscriber** | ✅ Done 2026-08-23 (`rajaemadhussain@gmail.com`, confirmed) | Remaining: re-point it to a monitored Aeygis address at the domain cutover |
| **Alarms** | None | Nothing |
| **Data-retention policy** | None | A business decision |
| **P3 — region as an enforceable control** | ⛔ **Declined by the user** (2026-08-23) | — do not re-raise unless asked |

### Two open questions for the rate-card owner

Neither blocks the build; both affect real quotes.

1. **The approved documents contradict themselves at exactly 15 providers.** The tier table
   says Enterprise is "15+ providers"; the pricing rule says *"once a client **passes** 15
   providers… stop using the Professional formula"*. Resolved as `>= 15` per the user, but
   **the Rate Card itself should be corrected.**
2. **No explicit Enterprise *location* threshold exists.** `>= 10` was extended from the
   providers answer for consistency and is **not user-stated**. It is a single named
   constant, `ENTERPRISE_LOCATION_THRESHOLD`.

---

## 14.9 Problems in the existing websites — out of scope, recorded

Full detail in [`docs/known-issues.md`](../known-issues.md). These are **real but outside
this build's scope**, recorded so they are not rediscovered from scratch and so nobody
assumes they were missed. **Nothing here has been actioned; each needs its own decision.**

| # | Issue | Severity |
|---|---|---|
| 1 | ~~The live calculator quotes prices that contradict the approved documents.~~ **✅ FIXED 2026-08-25.** The site became real source, so it was rewritten against the approved price book — correct tier names, three support plans, and no figure at all for Enterprise. Guarded by `npm run verify:pricing`, which compares the shipped figures against `packages/pricing`. | Was high |
| 2 | `privacy.html` will be inaccurate once the dual-write is live, and **already** never discloses the third-party US processor while claiming Canadian hosting | High — a PIPEDA disclosure gap today |
| 3 | The formsubmit.co endpoint may never have been activated — **historical leads may have been silently lost** | High |
| 4 | Health-site deep links return HTTP 404 with the SPA shell as the body; hash routing reads `location.hash` once with no `hashchange` listener | Medium |
| 5 | `aeygis.com`'s contact form is completely inert (`onsubmit="alert(...)"`, no `name` attributes) — **every lead through it has been discarded** | High |
| 6 | Two incompatible brand systems between the two sites; four different teals on the health site alone | Low |
| 7 | `aeygis.com` claims **HIPAA** (a US statute) while the health site claims PHIPA/PIPEDA — a positioning problem for a company selling Canadian residency | Medium |
| 8 | The Overview deck says *"no forms, no obligation"*, contradicting this pipeline's premise | Low |
| 9 | Uptime figures inconsistent across collateral: 99.99% / 99.9% / 99.97% | Low — the proposal template deliberately uses one, sourced on purpose |
| 10 | ✅ **Mitigated.** `docs/` would have published on the next live-site deploy, exposing the confidential Rate Card. Currently 404 on both hosts; a `rm -rf docs` step is authored and ships with the user's next deploy. | Was high |
