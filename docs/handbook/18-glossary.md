# 18. Glossary

← [Decision log](17-decisions.md) · [Index](README.md)

Terms used throughout this handbook and in the code, in plain English.

---

## Business terms

**Assessment** — a lead. A clinic's completed cloud readiness questionnaire, plus everything
staff add to it afterwards. One `Assessment` record per prospect.

**Reference id** — the human-quotable identifier for a lead, e.g. `AEY-7F3K2Q`. The alphabet
excludes `I`, `O`, `0` and `1` so it survives being read aloud on a phone call.

**Tier** — the size of engagement: **Micro**, **Starter**, **Professional**, **Enterprise**.
Determined by provider and location counts, never by revenue or judgement.

**Support plan** — the ongoing service level: **Train & Walk Away**, **Essentials**, **Full
Managed**. Not every plan is available on every tier.

**Band** — a range the public form collects instead of a number, e.g. `"1-2"` providers.
**A band cannot determine a tier**, which is why the system refuses to price until staff
enter exact integers.

**Counts confirmed** — the flag that unlocks pricing. Set by a staff member after typing
exact provider and location counts.

**Price factor** — the quoted price as a fraction of list, e.g. `0.9` for a 10% discount.
Below `0.9` the version is flagged as needing executive sign-off. Above `1` is refused.

**Price book version** — a string stamped into every proposal snapshot (`2026-07-rate-card-v2`)
so a historical proposal stays reproducible. **Changing any figure in the catalog requires
bumping it.**

**Proposal version** — one immutable priced draft. Changing a proposal means minting a new
version, never editing an old one.

**Snapshot** — the frozen, client-safe JSON that a proposal version is built from. Stored in
S3, hashed, and the **only** input the PDF renderer ever sees.

**Content hash / fingerprint** — the SHA-256 of the snapshot bytes. An approval binds to it,
a send re-verifies it, and a delivery record stores it. It is what makes "this exact document
was approved and sent" a fact rather than a claim.

**Delivery** — one attempt to email a proposal to a client. Recorded whether it succeeded,
was refused, or broke.

**Discovery** — the 20 approved technical questions staff fill in, plus any custom questions
added for that specific clinic.

**Responsibility matrix** — the seven approved rows setting out what Aeygis owns and what the
clinic owns. Rows can be excluded or added per clinic; the **approved wording** cannot be
changed.

---

## Roles and access

**Contributor** — a staff Cognito group. Can read and edit leads, fill discovery, price,
generate proposal versions, and discard unapproved drafts. **Cannot approve or send.**

**Approver** — a staff Cognito group. Everything a contributor can do, plus approving,
rejecting, and emailing a proposal to a client. Also the only role that can read
`proposals/internal/`.

**Guest / unauthenticated** — an anonymous visitor to the public form. Holds exactly one
permission: calling `submitAssessment`.

**Cognito subject (`sub`)** — the permanent unique id for a user. It is what the request
actually carries, and what an audit record falls back to when an email cannot be resolved.

---

## Technical terms

**Amplify Gen 2** — AWS's code-first application framework. The backend is TypeScript in
`amplify/`, synthesized to CloudFormation via CDK. **It has no region configuration field**,
which is why region is pinned in every npm script.

**`ampx sandbox`** — Amplify's development command. A **persistent watcher** that deploys and
then redeploys on every file change. Not a one-shot deploy; there is no `--once` flag.

**Sandbox** — two different meanings in this project, and they are unrelated:

- **The Amplify sandbox** — a per-developer ephemeral cloud stack. What this project runs on.
- **The SES sandbox** — Amazon's restricted mode for new email accounts: only verified
  recipients, 200 messages per 24 hours, 1 per second. **Per region.**

**AppSync** — the managed GraphQL API. Where authorization is actually enforced, before any
Lambda runs.

**Resolver** — the thing that fulfils a GraphQL field. Here they are either auto-generated
(model CRUD) or Lambda-backed (the five custom mutations).

**`authMode`** — which credential a call uses. `userPool` for the console, `identityPool` for
the public form, `iam` for a Lambda calling back through the API.

**Access token vs ID token** — two Cognito tokens with different claims. The **ID token**
carries `sub`, `email` and `cognito:groups`. The **access token** carries `sub`,
`cognito:groups` and `username` — **but not `email`**. Amplify's data client sends the
**access token** for `authMode: 'userPool'`, which is why audit records have to resolve the
address from Cognito themselves.

**`disableOperations`** — removes a mutation from the generated GraphQL schema **entirely**.
Stronger than an authorization rule: the operation does not exist to be called, so no future
rule edit can reintroduce it.

**GSI (global secondary index)** — an alternative query path on a DynamoDB table. **Sort keys
compare as text**, which is why `versionKey` is a zero-padded string.

**PITR (point-in-time recovery)** — DynamoDB's continuous 35-day restore window. Enabled on
every table.

**CMK (customer-managed key)** — a KMS key this account controls, as opposed to the AWS-owned
default. Gives a key policy, rotation control, and CloudTrail records of use. **Bills per API
call.**

**Data-source role** — the IAM role AppSync uses to reach a model's DynamoDB table
(`AssessmentIAMRole` and friends). **It, not the Lambda's own role, is the principal that
touches DynamoDB** when a function calls through the API — which is why it is the one that
needs the KMS grant.

**OAC (Origin Access Control)** — how CloudFront reads from a private S3 bucket without the
bucket being public.

**Configuration set** — an SES construct that routes delivery events to a destination and
keeps reputation metrics separate. Every send passes its name.

**Suppression list** — SES's account-level list of addresses that have bounced or complained.
Sends to a suppressed address fail **for reasons that look nothing like the cause**, which is
why the bounce topic was built before the first send.

**SPF / DKIM / DMARC** — the three checks every receiving mail provider runs. Sending from a
`@gmail.com` address via SES fails all three, which is why proposals currently land in spam.
See [Email delivery §10.8](10-email-delivery.md#108--deliverability--the-sandbox-proves-the-pipeline-not-that-mail-arrives).

**`ContentTransferEncoding`** — how SES frames an attachment's bytes. **It has no documented
default**, and the wrong value silently corrupts a binary file. Set explicitly to `BASE64`.

**Presigned URL** — a temporary, credential-free link to an S3 object. **It expires when the
credentials that signed it expire** — which for a Lambda means the role session, regardless
of the expiry requested.

**Synth** — CDK's build step: turning TypeScript into CloudFormation templates.
`npm run check:synth` runs it locally and inspects the output.

---

## Project-specific vocabulary

**Barrier 1–5** — the five independent mechanisms keeping confidential cost data out of
client-facing documents. See
[Pricing engine §7.5](07-pricing-engine.md#75-the-five-barriers-in-detail).

**Client-safe** — a value that may appear in a document a prospect reads. `@aeygis/pricing`
is client-safe; `@aeygis/pricing-internal` is not.

**`blocked` vs `failed`** — a delivery outcome distinction that carries real weight.
**`blocked`** means the system deliberately refused and nothing left the building; **`failed`**
means something broke. Collapsing them would send people debugging faults that do not exist.

**Arming** — the two-click pattern on irreversible controls (reject, delete, send). The first
click arms and relabels; the second acts. The arm self-clears after four seconds.

**Opaque success** — the identical response returned for a tripped honeypot, a rate-limit
rejection, and a genuine success, so an abuser learns nothing from the difference.

**Fail closed** — an absent or unparseable setting means *deny*, never *allow*. The recipient
allowlist works this way, deliberately.

**Fail open** — the opposite, used where a failed *check* must not block legitimate work: a
rate-limit counting error allows the submission, and a failed email lookup still records the
audit event.

**Dual-write** — *historical.* The live site briefly sent each assessment to **both**
formsubmit.co and this backend. Removed on 2026-08-25: the assessment now submits here and
nowhere else. The separate contact-sales form still emails.

**P1, P2, P3, P4…** — numbered pending items carried forward in
`docs/PROJECT-STATUS.md`. **P12** (the backend is the only path a lead has) is the open one.
P1 and P2 were superseded on 2026-08-25 — they described a dual-write that no longer exists.
P3 (region as an enforceable control) was declined by the user; P4–P11 are closed.

**Gotcha 6** — shorthand for the Amplify create-time KMS key bug. So named because it is the
sixth entry in `deployment.md`'s gotcha list, and because it has now happened three times.

---

## The five confidentiality barriers, in one place

| # | Name | Mechanism |
|---|---|---|
| 1 | Package boundary | `dependency-cruiser` forbids the import, transitively |
| 2 | Type boundary | A closed payload interface and a whitelist mapper that never spreads |
| 3 | Data boundary | Cost data is not in the AppSync schema at all |
| 4 | IAM boundary | No ARN for `proposals/internal/*` on client-facing functions |
| 5 | Runtime guard | `assertClientSafe()` throws — a leak becomes a failed render |

---

## The six Lambdas, in one place

| Function | Sole writer of | Who may trigger it |
|---|---|---|
| `submit-assessment` | `Assessment` | Anyone, including guests |
| `price-proposal` | `ProposalVersion` + snapshots | contributor, approver |
| `render-proposal-pdf` | `proposals/client/*` | `price-proposal`, asynchronously |
| `decide-proposal` | `Approval` | approver |
| `delete-proposal-version` | deletions | contributor, approver |
| `send-proposal-email` | `ProposalDelivery` | approver |

---

## The five models, in one place

| Model | Mutable? | Written by |
|---|---|---|
| `Assessment` | Staff may **update** | `submit-assessment` creates it |
| `ProposalVersion` | **No update.** Delete only via the custom mutation, and never if approved. | `price-proposal` |
| `Approval` | **Append-only.** No update, no delete, at all. | `decide-proposal` |
| `AuditEvent` | **Append-only.** | Three functions |
| `ProposalDelivery` | **Append-only.** | `send-proposal-email` |
