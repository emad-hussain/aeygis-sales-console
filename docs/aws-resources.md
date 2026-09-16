# AWS Resource Inventory

> **Living document.** Every provisioned resource is recorded here in the same session it is created.
> An undocumented resource is an incomplete task.

---

## Current state

| Account | Region | Bootstrapped | Notes |
|---|---|---|---|
| `326629581669` (IAM user `emad`) | `ca-central-1` | ✅ Yes — 2026-08-17 | Phase 1 sandbox deployed |

Deployed via `npm run sandbox` (sandbox identifier `Emad-Hussain`). Everything
below was verified against the live account, not inferred from the template.

**Root stack:** `amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77` — `CREATE_COMPLETE`, deployed in 171s.

---

## Provisioned resources — Phase 1

| Service | Name / ID | Purpose | Verified |
|---|---|---|---|
| CloudFormation | `CDKToolkit` | CDK bootstrap: staging bucket, ECR repo, 5 IAM roles, SSM version param | ✅ |
| CloudFormation | `amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77` | Root backend stack | ✅ `CREATE_COMPLETE` |
| Cognito User Pool | `ca-central-1_RxZghEUxq` | Staff auth | ✅ |
| Cognito Groups | `contributor` (precedence 0), `approver` (precedence 1) | RBAC | ✅ both exist |
| Cognito Identity Pool | `ca-central-1:b8b32869-dce2-4f64-b98c-de40483d886b` | Guest identity for public form | ✅ unauth enabled |
| IAM role (unauth) | `amplify-aeygissalesplatfo-amplifyAuthunauthenticate-0V6xlHSZ3NhD` | Anonymous submitter | ✅ see below |
| IAM role (auth) | `amplify-aeygissalesplatfo-amplifyAuthauthenticatedU-8cwSXVU07Z5Z` | Signed-in staff | ✅ |
| AppSync API | `fuufxnavzfgshfme7635fq5obq` (`amplifyData`) | GraphQL data API | ✅ |
| AppSync endpoint | `https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql` | — | ✅ |
| DynamoDB | `Assessment-fuufxnavzfgshfme7635fq5obq-NONE` | Assessment submissions. PAY_PER_REQUEST. | ✅ |
| DynamoDB GSI | `assessmentsByStatusAndSubmittedAt` | Console list-by-status | ✅ |
| DynamoDB GSI | `assessmentsBySubmitterIpHashAndSubmittedAt` | Per-IP rate limiting | ✅ |
| Lambda | `amplify-aeygissalesplatfo-submitassessmentlambda55-UhgcngGmpz5U` | Sole writer of `Assessment`; also sends the new-lead notification | ✅ nodejs22.x, 256MB, **30s** (was 15s until 2026-08-26 — see the notification section below) |
| SSM SecureString | `IP_HASH_SALT` (version 1) | Salt for submitter-IP hashing | ✅ 32 random bytes |
| KMS key | `alias/aeygis-sales-platform-data` · `53354d9a-...` | Customer-managed key for data at rest | ✅ CUSTOMER, rotation on |

### The unauthenticated role's complete permission set

This is the security control the public path depends on, so it is recorded verbatim:

```json
{
  "Action": "appsync:GraphQL",
  "Resource": "arn:aws:appsync:ca-central-1:326629581669:apis/fuufxnavzfgshfme7635fq5obq/types/Mutation/fields/submitAssessment",
  "Effect": "Allow"
}
```

One ARN. No `Assessment` type ARNs, no `getAssessment`, no `listAssessments`, no
`createAssessment`. A guest cannot read assessment data because the IAM policy
contains no ARN that would permit it — not because an authorization rule says no.

**If this policy ever grows beyond that single statement, treat it as a security regression.**

### Verified behaviour (`node scripts/verify-guest-access.mjs`)

Run with genuine anonymous credentials obtained via `GetId` +
`GetCredentialsForIdentity`, then SigV4-signed — i.e. exactly what a browser
guest does. All 13 checks pass:

- Guest **can** call `submitAssessment`; the receipt carries only `ok`/`referenceId`/`message`
- Guest is **denied** on `listAssessments`, `getAssessment`, `assessmentsByStatus`, `createAssessment`, `updateAssessment`, `deleteAssessment` — all "Permission denied"
- Honeypot submission returns opaque success and is **not** stored
- Submission without consent is rejected
- DynamoDB scan confirms exactly **1** stored record (the legitimate one), with
  `status: needs_confirmation`, band widened to `1–2`, and the IP present only
  as a salted hash

---

## Encryption at rest — customer-managed KMS key ✅

| Item | Value |
|---|---|
| Key ARN | `arn:aws:kms:ca-central-1:326629581669:key/53354d9a-0b47-41e3-b55f-63b4f886562a` |
| Alias | `alias/aeygis-sales-platform-data` |
| Manager | `CUSTOMER` · rotation **enabled** · removal policy **RETAIN** |
| Table SSE | `Status: ENABLED`, `SSEType: KMS`, pointing at the key above |
| PITR | `ENABLED` — continuous 35-day restore window |

Verified against the live table with `describe-table` / `describe-continuous-backups`, not from the deploy log.

### The trap this contains — read before touching encryption

**This has now cost a real incident FOUR times**, each a different principal
that turned out to need KMS access nobody had granted it. The pattern is
always the same: an S3/DynamoDB-level permission (bucket policy, table grant,
`allow.groups().to(['read'])`) is necessary but not sufficient when the data
is KMS-encrypted — decrypt is a **separate** grant, and every one of these
failed silently at the configuration level and only broke at runtime:

| # | Principal | If the grant is missing |
|---|---|---|
| 1 | `AmplifyManagedTable(OnEvent\|IsComplete)Role` | Deploy **rolls back** on `kms:DescribeKey`. Loud — the only one of the four that fails loud. |
| 2 | `<Model>IAMRole` (e.g. `AssessmentIAMRole`) | Deploy **succeeds**, `SSEDescription` reports `ENABLED`, admin writes work — **and every application write fails at runtime.** |
| 3 | `priceProposal` / `renderProposalPdf` / `decideProposal` Lambda roles | Deploy succeeds; the first S3 read/write from that Lambda throws `AccessDenied`. |
| 4 | Cognito `contributor` / `approver` group roles (identity pool, used by the browser directly) | **The one that took longest to notice.** The console's "View PDF" button generated a presigned URL successfully — `getUrl()` has no way to know decrypt will fail — and the download 403'd with the real reason buried in the S3 XML error body (`kms:Decrypt ... not authorized`), not in the HTTP status code. Found 2026-08-18 fixing P4; see `PROJECT-STATUS.md`. |

Lambda execution roles that reach data ONLY through AppSync (`authMode:
'iam'`) do NOT need this — the *data-source* role (row 2) is the principal
that actually touches DynamoDB there. Rows 3 and 4 are different: those
principals talk to S3 **directly**, so they need the grant themselves.

Two further facts, both established by inspecting deployed policy rather than assumed:
- A key policy naming the **account root does not grant access** — it only delegates to IAM, so each principal still needs an identity-based policy. Hence explicit per-role grants.
- CDK's `grantEncryptDecrypt` produces exactly `kms:Decrypt`, `kms:Encrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*`. It does **not** include `DescribeKey` or `CreateGrant`, both of which DynamoDB requires. They are granted explicitly.

`backend.ts` matches rows 1–2 by pattern so Phase 3–4 models are covered automatically, and **throws at synth** if the data-source family is not found. Rows 3–4 are granted explicitly by name (`backend.auth.resources.groups[name].role`, confirmed against `@aws-amplify/plugin-types`, not guessed) since there is no equivalent pattern-matching surface for Lambda or Cognito group roles.

**The lesson generalizes:** whenever a NEW principal gets S3 or DynamoDB read/write on KMS-encrypted data — a Lambda, a Cognito group, anything — grant `kms:Decrypt` (and `kms:Encrypt`+`GenerateDataKey*` if it writes) to that principal explicitly, in the same change. Do not assume the bucket/table grant carries it.

---

## Known gaps in the deployed stack

| Gap | State | Why it matters |
|---|---|---|
| **Region enforcement** | Guard only (env-var check in `backend.ts`) | Not enforceable. Add an SCP or `aws:RequestedRegion` deny on the deploy role before this holds real client data. |
| **Deletion protection** | Off | Deliberate — it would block `npm run sandbox:delete`. Enable on the branch environment. |
| **KMS cost** | CMK bills per API call | Unlike the AWS-owned key. DynamoDB caches the table key for 5 minutes, so volume is low, but it is no longer free. |
| **Test records** | Cleaned; table is empty | `npm run verify` writes real records each run. Follow with `npm run cleanup:tests`, which deletes only known test addresses and reports anything else rather than guessing. |

---

## Planned resources

All created via Amplify Gen 2 code-first definitions in `amplify/` — **never** by hand in the console. The `amplify/` directory is the source of truth; anything provisioned outside it is drift and should be removed or codified.

### Phase 1 — intake
| Service | Purpose | Defined in |
|---|---|---|
| Cognito User Pool | Staff auth; groups `contributor`, `approver` | `amplify/auth/resource.ts` |
| Cognito Identity Pool | Unauthenticated identity for the public form's guest write | created implicitly by `defineAuth` |
| AppSync GraphQL API | Data API; hosts the guest-authorized `submitAssessment` mutation | `amplify/data/resource.ts` |
| DynamoDB — `Assessment` | Public assessment submissions | `amplify/data/resource.ts` |
| Lambda — `submit-assessment` | Sole writer of `Assessment`; validation, honeypot, rate limiting | `amplify/functions/submit-assessment/` |
| IAM roles | Auth/unauth identity roles, group roles, Lambda execution roles | generated |
| CloudWatch log groups | Lambda logs | generated |

### Phase 3 — proposals
| Service | Purpose | Defined in |
|---|---|---|
| S3 bucket | `snapshots/`, `proposals/client/`, `proposals/internal/`. **Versioning enabled.** Object Lock deliberately **off**. | `amplify/storage/resource.ts` |
| DynamoDB — `ProposalVersion` | Immutable priced proposal versions | `amplify/data/resource.ts` |
| Lambda — `price-proposal` | Writes immutable versions + frozen snapshots | `amplify/functions/price-proposal/` |
| Lambda — `render-proposal-pdf` | HTML → PDF via headless Chromium. ≥1600 MB, 30 s timeout. | `amplify/functions/render-proposal-pdf/` |
| S3 bucket + CloudFront | `ChromiumPack` stack — hosts the ~66 MB browser pack `render-proposal-pdf` fetches at cold start | `amplify/backend.ts` (dedicated `backend.createStack('ChromiumPack')`) |

**`ChromiumPack` resources, deployed and verified 2026-08-18** (closing P4):

| Resource | Value |
|---|---|
| S3 bucket | `amplify-aeygissalesplatfo-chromiumpackbucketf471e0-hnuzb4xinhse` — private, `BlockPublicAccess.BLOCK_ALL`, SSE-S3 |
| CloudFront distribution | `dhediy6ipw02c.cloudfront.net`, Origin Access Control, `PRICE_CLASS_100` |
| Object | `chromium/chromium-v149.0.0-pack.x64.tar` — 69,642,240 bytes, matches `@sparticuz/chromium-min@149.0.0` exactly |
| `CHROMIUM_PACK_URL` | Derived from `distribution.distributionDomainName` at synth time — never hand-typed |

Deliberately **not** a public S3 object: this account has S3 Block Public
Access enabled at the **account level**, all four settings
(`aws s3control get-public-access-block`, checked before deciding this) —
loosening that would be an account-wide posture change to solve a one-object
problem. CloudFront + OAC gets a plain, credential-free HTTPS URL (which
`@sparticuz/chromium-min`'s unauthenticated `fetch()` requires — verified
from its source, not the docs) without touching that setting at all.

### Phase 4 — approvals
| Service | Purpose | Defined in |
|---|---|---|
| DynamoDB — `Approval` | Immutable approval decisions bound to `contentSha256` | `amplify/data/resource.ts` |
| DynamoDB — `AuditEvent` | Immutable audit trail | `amplify/data/resource.ts` |
| Lambda — `decide-proposal` | Approver-only decision writer | `amplify/functions/decide-proposal/` |

### Phase 5 — email ✅ DEPLOYED 2026-08-23

| Service | Identifier | Notes |
|---|---|---|
| SES identity | `rajaemadhussain@gmail.com` | `VerificationStatus: SUCCESS`. Both sender and recipient while in the sandbox. Created by hand, **deliberately not in CDK** — verification needs a human to click a link, so an "as code" identity is only ever half-declared. See the note in `backend.ts`. |
| SES configuration set | `aeygis-proposal-delivery` | Reputation metrics on. Name is pinned to the constant the function sends with; a CloudFormation-generated name would never match. |
| SES event destination | → SNS topic | Publishes `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY` only. Not `SEND`/`DELIVERY`/`OPEN` — a notification per successful send is noise that trains people to ignore the topic. |
| SNS topic | `ProposalEmailEvents` | Topic policy allows only `ses.amazonaws.com`, conditioned on `AWS:SourceAccount` and the configuration-set ARN. Written by the CDK construct itself, not by hand. **Subscribed: rajaemadhussain@gmail.com** — see the subscription section below. |
| Lambda — `send-proposal-email` | `amplify-aeygissalesplatfo-sendproposalemaillambda2-ogWruCB8JRjz` | 30s / 512 MB. **Attaches the PDF** — SESv2 caps a message at 40 MB and a proposal is ~300 KB. (The earlier plan said a presigned link; that was reversed — a link signed inside a Lambda expires with the role session.) |
| DynamoDB — `ProposalDelivery` | `ProposalDelivery-fuufxnavzfgshfme7635fq5obq-NONE` | Append-only: `update`/`delete` removed from the schema. On the CMK with PITR — **after** an `update-table` remediation, see below. |

**IAM granted to `send-proposal-email`:**

| Action | Resource | Why scoped this way |
|---|---|---|
| `ses:SendEmail` | `identity/rajaemadhussain@gmail.com` **and** `configuration-set/aeygis-proposal-delivery` | `identity` is the required resource type; the set is optional in general but this function always passes `ConfigurationSetName`, so omitting it would deny the call. Not `identity/*` — that would be an account-wide send permission on a Lambda. |
| `kms:Decrypt`, `kms:DescribeKey` | project CMK | **Decrypt only.** It reads the snapshot and the PDF and writes neither. `DescribeKey` is separate because `grantDecrypt` does not include it. |
| `s3:GetObject` | `snapshots/*`, `proposals/client/*` | No access to `proposals/internal/*` — barrier 4 of 5, asserted by `npm run check:synth`. |

**Environment (verified on the deployed function):**

```
SES_ENABLED            = true
SES_FROM_ADDRESS       = rajaemadhussain@gmail.com
SES_BCC_ADDRESS        = rajaemadhussain@gmail.com
SES_ALLOWED_RECIPIENTS = rajaemadhussain@gmail.com
SES_CONFIGURATION_SET  = aeygis-proposal-delivery
```

`SES_ALLOWED_RECIPIENTS` **fails closed**: blank or unset blocks everything; `*`
allows everything. Do not blank it to "turn the guard off" — set `*`. See
`recipientPolicy.ts`.

> ⚠ **Gotcha 6 struck a third time.** `ProposalDelivery` was created on the
> AWS-managed key while reporting `SSEType=KMS, Status=ENABLED` — which looks
> correct from every angle except comparing key ARNs. Remediated with
> `update-table`; re-verified as CMK. This is why `npm run verify:encryption` is
> mandatory after any deploy that adds a model, not optional.

---

## New-lead notification ✅ DEPLOYED 2026-08-26

**Why it exists.** The public assessment form stopped emailing sales through
`formsubmit.co` and this backend became the **only** destination for a lead.
That closed a real gap — leads were not being kept — and opened another: a lead
lands in DynamoDB and nothing announces it. So `submit-assessment` now sends an
internal heads-up.

**Verified against the live account after deploying**, not read from the deploy log.

> ✅ **Proven to send, 2026-08-26.** `npm run verify:notification` submitted one lead
> through the real public path and the Lambda logged:
>
> ```
> new-lead notification sent {
>   referenceId: 'AEY-LX3SD7',
>   messageId: '010d01a03e2a3563-dfd6e093-f9f6-4ce0-90cd-0bf2702bfdc6-000000'
> }
> ```
>
> **SES accepting a message is not delivery.** The sender is still a `@gmail.com`
> address, so it fails SPF, has no DKIM, and fails DMARC — spam is the expected
> destination until the domain cutover. See `email-setup.md`.

| Service | Identifier | Notes |
|---|---|---|
| SES configuration set | `aeygis-internal-notifications` | **A second set, deliberately.** Internal notifications are kept out of `aeygis-proposal-delivery` so a bounce on our own inbox does not land in the reputation metrics that describe whether **proposals reach clinics**. |
| SES event destination | `InternalNotificationProblemsD3FAC9AE-QOvojo6PLvmH` → the **existing** SNS topic | `BOUNCE`, `COMPLAINT`, `DELIVERY_DELAY`, `REJECT`. Same four as proposal delivery, same topic — a bounce is a bounce, and two places to look would be worse. |
| SNS topic | `ProposalEmailEvents` (unchanged) | No new topic. Notifications share the proposal topic, and its existing subscriber receives bounces from both. |
| Lambda | `amplify-aeygissalesplatfo-submitassessmentlambda55-UhgcngGmpz5U` | Timeout **15 s → 30 s**. A 15-second budget shared between a rate-limit query, a DynamoDB write and an SES call leaves no room for a slow one, and a timeout would fail a submission that had already been stored. |

**IAM granted to `submit-assessment`** (role
`amplify-aeygissalesplatfo-submitassessmentlambdaSer-6apmCPAG1Fu1`):

```json
{
  "Action": "ses:SendEmail",
  "Resource": [
    "arn:aws:ses:ca-central-1:326629581669:identity/rajaemadhussain@gmail.com",
    "arn:aws:ses:ca-central-1:326629581669:configuration-set/aeygis-internal-notifications"
  ],
  "Effect": "Allow"
}
```

Scoped the same way as `send-proposal-email`: `identity` is the required resource
type, and the configuration set is needed because the function always passes
`ConfigurationSetName`. **Not `identity/*`** — that would be an account-wide send
permission on a Lambda.

**Environment (verified on the deployed function):**

```
NOTIFY_ENABLED           = true
NOTIFY_FROM_ADDRESS      = rajaemadhussain@gmail.com
NOTIFY_TO_ADDRESS        = rajaemadhussain@gmail.com
NOTIFY_CONFIGURATION_SET = aeygis-internal-notifications
```

`NOTIFY_TO_ADDRESS` is the verified test address because SES will not deliver
anywhere else while the account is in the sandbox. It becomes a real Aeygis
inbox at the domain cutover — the same change that switches `SES_FROM_ADDRESS`.

### Two properties worth knowing

**It is best effort and never fatal.** The notification is attempted only after
the assessment has been written, and its outcome is never read. If it fails the
lead is still stored and the visitor still gets their receipt. A notification
problem must never turn a stored lead into a reported failure.

**Test submissions are skipped.** `npm run verify` and `npm run seed:demo`
submit through the real public mutation on purpose, so without this every
verification run would email the team about clinics that do not exist. Anything
whose contact address ends in `.invalid` — reserved by RFC 2606, so it can never
be a real domain — is skipped. The verify scripts were moved onto `.invalid`
addresses in the same change for exactly this reason.

> ⚠ **The SES sending quota is per ACCOUNT and region, and it is SHARED with
> proposal delivery** — 200 messages per 24 hours in the sandbox. Submissions are
> rate limited to 5 per IP per hour, so ordinary traffic is nowhere near it, but a
> flood across many addresses could consume the quota and starve the thing that
> matters commercially: sending a proposal to a client. Not engineered around —
> production access raises the quota substantially, and of the two sends this is
> the expendable one.

Both configuration sets publish to `ProposalEmailEvents`, which has a **confirmed
subscriber** — so a bounce or complaint from either the proposal path or the
notification path reaches a person. See the subscription section below.

---

## Region and residency

Everything is pinned to **`ca-central-1`**.

Verified availability (checked 2026-08-17 against AWS documentation, not from memory):
- **Amplify + Amplify Hosting** — available in ca-central-1
- **SES** — full support: API (`email.ca-central-1.amazonaws.com`), SMTP, inbound, DKIM (uses the default `dkim.amazonses.com`), tracking, and feedback endpoints
- **Cognito, AppSync, DynamoDB, S3, Lambda** — all standard in ca-central-1

**SES sandbox limits are per-region:** 200 messages/24h, 1 message/second, and sending is restricted to *verified* recipient addresses. Sender identity verification is required in sandbox **and** production — it is not a sandbox-only rule. AWS gives an initial response to a production-access request within 24 hours.

---

## Cost notes

All Phase 1–4 services are effectively free at sales volume (well inside free tiers) with two exceptions worth watching:

- **`render-proposal-pdf`** runs at ≥1600 MB. Cost is per GB-second, so a slow cold start is the expensive part. Rendering is async and off the request path, so no provisioned concurrency — that would be the genuinely expensive choice.
- **S3 versioning** retains every prior object version. Add a lifecycle rule for noncurrent versions before this holds many proposals.

No NAT Gateway, no VPC, no always-on compute. There should be no standing hourly charge in this stack — if one appears, something was created outside `amplify/`.
