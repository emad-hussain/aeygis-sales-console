# 11. Security

← [Email delivery](10-email-delivery.md) · [Index](README.md) · Next: [Running locally](12-running-locally.md)

Everything about who can do what, what is encrypted, what is recorded, and what is
deliberately not protected.

---

## 11.1 The threat model, stated plainly

| Threat | What stops it |
|---|---|
| An anonymous visitor reads other clinics' assessments | The unauthenticated IAM role holds **one ARN**, for one mutation. No `Assessment` ARNs exist in it. |
| A bot floods the intake form | Honeypot + per-IP rate limit, both returning an opaque success so the bot learns nothing |
| A rep forges an approval | `Approval.create` is granted to no user role. The Lambda is the only writer, and it re-checks the caller's group. |
| A rep edits a proposal after it was approved | `update` is **removed from the schema** on `ProposalVersion`. It does not exist to be called. |
| Someone swaps the stored document after approval | Both `decide-proposal` and `send-proposal-email` **re-hash the S3 object** and refuse on mismatch |
| A contributor emails a proposal to a client | `allow.group('approver')` on the mutation, enforced by AppSync before the Lambda runs, and re-checked inside it |
| A proposal reaches the wrong inbox | The mutation takes **no recipient argument**. The address comes from the clinic's own record. |
| A real prospect is emailed while in the SES sandbox | A fail-closed allowlist, checked against **every** recipient |
| Confidential cost or margin data reaches a client document | **Five independent barriers** — see §11.6 |
| Someone deletes evidence | `update`/`delete` removed from the schema on `Approval`, `AuditEvent` and `ProposalDelivery` |
| Data leaves Canada | Region pinned in every script and asserted at synth — **best-effort, see §11.8** |
| A stored IP is used to identify a submitter | Only a salted SHA-256 is stored. Without the salt the function skips rate limiting rather than hashing weakly. |

---

## 11.2 Authentication

### Staff — Cognito user pool `ca-central-1_RxZghEUxq`

Email-based sign-in, SRP flow (`ALLOW_USER_SRP_AUTH` is the only flow the client enables).

**No self-registration.** `<Authenticator hideSignUp>`, and accounts are provisioned by an
administrator.

**MFA is not configured.** `multifactor` and `accountRecovery` were deliberately omitted
because their option shapes were not verifiable against current documentation, and guessing
them would trade a real MFA policy for a plausible-looking one. **This is a known gap**, and
it should be closed before the console is hosted anywhere reachable from the internet.

### Anonymous — Cognito identity pool

Provides short-lived, scoped AWS credentials to the public form:

```
GetId  →  GetCredentialsForIdentity  →  SigV4-signed POST to AppSync
```

**Deliberately not an API key.** An API key is a bearer credential that would ship in the
public site's JavaScript, where anyone can read it and it never expires.

---

## 11.3 Authorization

### Two Cognito groups, and nothing else

| | contributor | approver |
|---|---|---|
| Read leads | ✅ | ✅ |
| Edit leads, discovery, schedule, matrix | ✅ | ✅ |
| Generate a proposal version | ✅ | ✅ |
| Discard an **unapproved** version | ✅ | ✅ |
| View a proposal PDF | ✅ | ✅ |
| Read approvals and delivery history | ✅ | ✅ |
| **Approve / reject** | ❌ | ✅ |
| **Email a proposal to a client** | ❌ | ✅ |
| Read `proposals/internal/*` | ❌ | ✅ |
| Create or delete an assessment | ❌ | ❌ |
| Edit or delete an approval, audit event, or delivery record | ❌ | ❌ |

**Group membership is the only thing separating the roles.** Promoting someone is a Cognito
group change, not a code change.

### Enforced in three places, and the UI is not one of them

| Layer | Mechanism | Is it a control? |
|---|---|---|
| **AppSync** | `allow.group('approver')` on the mutation | ✅ **Yes.** Rejects before the Lambda runs. |
| **Lambda** | `isApprover(caller)` re-read from the request identity | ✅ **Yes** — and it is what produces the group snapshot |
| **Console** | Hiding or disabling a button | ❌ **No.** A convenience only. |

The Lambda check is not redundant with the AppSync rule. Two reasons:

1. It produces the snapshot written into `Approval.decidedByGroups` and
   `AuditEvent.actorGroups`, so **the rule and the recorded evidence cannot disagree**.
2. If it is ever reached, it writes an audit event carrying
   `reachedLambdaDespiteApiRule: true` — which is exactly the record you want if the
   API-level rule stops working.

**The console never hides a feature by pretending it does not exist.** It explains that
approval requires the approver group. A missing button teaches nothing, and the API is the
real boundary regardless of what is rendered.

---

## 11.4 The public write path

This is the only route into the system from the internet, so it gets its own section.

### Read-impossibility is structural, not rule-dependent

`Assessment` carries **no guest authorization rule at all**. Because no field carries one,
the unauthenticated IAM role's policy contains **no `Assessment` ARNs whatsoever**.

The complete policy, recorded verbatim:

```json
{
  "Action": "appsync:GraphQL",
  "Resource": "arn:aws:appsync:ca-central-1:326629581669:apis/fuufxnavzfgshfme7635fq5obq/types/Mutation/fields/submitAssessment",
  "Effect": "Allow"
}
```

**One ARN. If this policy ever grows beyond that single statement, treat it as a security
regression.**

### Why not `allow.guest().to(['create'])`

It looks equivalent and is not, for two reasons:

1. **AppSync returns the created object from a create mutation**, so the caller reads back
   their own row including server-generated fields.
2. **It grants the unauth role write access to every field on the model** — including any
   internal field added later (`assignedTo`, `internalNotes`, `qualificationScore`). That is
   a latent privilege-escalation surface that grows silently as the model grows.

### Verified against the deployed API

`node scripts/verify-guest-access.mjs` — **13 checks**, using genuine anonymous credentials
obtained the same way a browser gets them, then SigV4-signed. It deliberately does *not* use
`aws-amplify`, for two reasons:

1. It reproduces exactly what an anonymous browser does, with no library layer that might
   silently substitute a different auth mode.
2. `aws-amplify`'s credential caching assumes browser storage and fails in Node with "No
   credentials" — which would make every read test appear to pass **for the wrong reason**.

That second point is the important one: **a denial test is only meaningful if you know the
credentials work.** So the read-denial checks are gated behind a successful write.

What it asserts:

- A guest **can** call `submitAssessment`; the receipt carries only `ok`, `referenceId`,
  `message`
- A guest is **denied** on `listAssessments`, `getAssessment`, `assessmentsByStatus`,
  `createAssessment`, `updateAssessment`, `deleteAssessment`
- A honeypot submission returns opaque success and is **not** stored
- A submission without consent is rejected
- A DynamoDB scan confirms exactly the expected records, with the band widened and the IP
  present **only as a salted hash**

### Abuse handling gives no signal

A tripped honeypot and a rate-limit rejection both return the **same shape as success**, so
a bot cannot tell what stopped it. A human who somehow trips one still gets a reference to
quote.

Validation errors *are* returned — those are the submitter's own input mistakes and need to
be fixable.

### The IP hash

```
SHA-256( salt + ":" + ip )
```

**The salt must be a real secret.** IPv4 space is only about 4 billion addresses, so an
unsalted or publicly-known-salt hash is reversible by brute force in minutes — which would
turn `submitterIpHash` into stored personal information rather than the privacy measure it
is meant to be.

**If the salt is missing, the function refuses to hash and skips rate limiting**, logging an
error. Failing open rather than pretending to protect something.

---

## 11.5 Encryption

### At rest

| What | How |
|---|---|
| All five DynamoDB tables | Customer-managed KMS key `alias/aeygis-sales-platform-data`, rotation enabled |
| The proposals S3 bucket | `aws:kms` with the same key, `bucketKeyEnabled: true` |
| The Chromium pack bucket | SSE-S3 — it holds a build artifact, never client data |
| `IP_HASH_SALT` | SSM SecureString |

**Why a customer-managed key rather than the AWS-owned default.** The default is real
encryption, and it gives no key policy, no rotation control, and no CloudTrail record of
encrypt/decrypt calls. The Migration Framework sells *"KMS AES-256 encryption"* to clients —
with an AWS-owned key that claim and the configuration do not match. A CMK closes the gap
and makes the claim auditable.

**Removal policy is RETAIN.** Destroying the key would make every encrypted item permanently
unreadable, including anything restored from a backup.

### In transit

TLS everywhere by default. The Chromium bucket sets `enforceSSL: true` explicitly.

**One deliberate exception worth knowing.** The SES configuration set leaves TLS policy at
the default (**opportunistic**) rather than `REQUIRE`. `REQUIRE` refuses to deliver to a mail
server that will not negotiate TLS, and a clinic on an older mail host would **silently stop
receiving proposals**. That is a real trade-off rather than an oversight — worth revisiting
once the recipients are known.

### ⚠ The KMS grant trap — the single most expensive lesson in this project

**Four separate incidents, four different principals.** Full detail in
[AWS resources §5.5](05-aws-resources.md#55-kms). The pattern in one sentence:

> **An S3 or DynamoDB permission is necessary but not sufficient when the data is
> KMS-encrypted. Decrypt is a separate grant.**

Three of the four failed **silently at configuration time** and only broke at runtime.

**The lesson generalises:** whenever a new principal gets S3 or DynamoDB read/write on
KMS-encrypted data — a Lambda, a Cognito group, anything — grant `kms:Decrypt` (and
`kms:Encrypt` + `GenerateDataKey*` if it writes) to that principal **explicitly, in the same
change**. Do not assume the bucket or table grant carries it.

---

## 11.6 Confidentiality — the five barriers

`@aeygis/pricing-internal` holds delivery cost per engineer-hour, margin reasoning, and
competitor analysis from a Rate Card stamped **CONFIDENTIAL — Internal Use Only**. A prospect
who saw it would know Aeygis' cost base and negotiate against it.

**An authorization rule cannot protect it**, because a leak would happen inside a single
Lambda's own process. Hence five independent barriers:

| # | Barrier | Where | Static or runtime |
|---|---|---|---|
| 1 | Package boundary | `.dependency-cruiser.cjs` — 7 rules, transitive, `severity: error` | static, CI |
| 2 | Type boundary | `ClientProposalPayload` is closed; the mapper never spreads | static, compiler |
| 3 | Data boundary | Cost data is not in the AppSync schema at all | static, by absence |
| 4 | IAM boundary | The renderer and email sender have **no ARN** for `proposals/internal/*` | static, asserted by `check:synth` |
| 5 | Runtime guard | `assertClientSafe()` + `assertHtmlFreeOfConfidentialWords()` throw | **runtime, every render** |

Full detail in [Pricing engine §7.5](07-pricing-engine.md#75-the-five-barriers-in-detail).

**Barrier 5 is the one that runs every time**, which is what makes the other four being
static acceptable. A leak becomes a **failed render**, never a document in a prospect's
inbox.

### The email sender is inside the same boundary

Added with Phase 5: **the proposal email is client-facing in two ways at once** — the body it
composes and the PDF it attaches both land in a prospect's inbox. So
`send-proposal-email` gets the same dependency-cruiser rule as the renderer, has no ARN for
the internal prefix, and its body-builder is tested for money leakage against the *visible
text* of the rendered HTML.

---

## 11.7 The audit trail

Five things make it worth relying on.

**1. It is append-only in the schema, not by convention.** `update` and `delete` are removed
from `AuditEvent` outright. No user, no Lambda, and no future authorization edit can alter or
erase a record.

**2. Groups are snapshotted, not resolved later.** Cognito membership is mutable. An audit
record must say what was true **at the moment of the act**.

**3. The actor's email is resolved at write time**, for the same reason — a user can be
renamed or removed. See
[Data model §4.8](04-data-model.md#48-the-actor-email-problem-and-how-it-was-fixed).

**4. Refusals are recorded, not just successes.** A stale hash, a tampered snapshot, an
unauthorized caller, a blocked send — each writes an event.

**5. Audit writes never mask the outcome.** They are wrapped in try/catch and logged on
failure. A failed audit write must not turn a successful approval into a reported failure —
and it must not turn a **sent email** into one either, because the client already has it.

### Its limits, stated honestly

- **Records written before 2026-08-24 carry a bare UUID** for the actor. Append-only means
  they cannot be backfilled.
- **`detail` is readable by every staff member**, contributors included, so nothing
  confidential goes in it.
- **There is no tamper-evidence beyond DynamoDB itself.** Someone with direct AWS console
  access and the right IAM permissions can delete a table row; the schema stops the
  *application* path, not an account administrator. Point-in-time recovery would show the
  gap, but nothing signs the chain.

---

## 11.8 Known gaps

Recorded so nobody assumes they were missed.

### Region residency is a guard, not a control — ⛔ user declined the fix

`backend.ts` throws if `AWS_REGION` / `AWS_DEFAULT_REGION` / `CDK_DEFAULT_REGION` resolves to
anything other than `ca-central-1`. That catches the common mistake.

**It reads environment variables**, so anyone deploying with no region env var set — region
coming from `~/.aws/config` — bypasses it with a warning.

The only enforceable mechanism is an **SCP** or an `aws:RequestedRegion` deny condition on
the deploy role.

**This was raised with the user, explained with the bypass example and the fix, and declined
(2026-08-23).** Do not re-raise unless asked.

### MFA is not configured on the user pool

See §11.2. Close this before the console is hosted anywhere internet-reachable.

### The console is not hosted, and hosting it needs a decision

It holds confidential client business information and can send documents to clients. It
should not sit on a public URL protected only by a password form. Options — an internal-only
distribution, IP allowlisting, or SSO — need a decision before an Amplify Hosting app is
created.

### There is no version control

**No git history exists for this repository.** Every safety property described in this
handbook is enforced in code that has no undo, no blame, and no review trail. This is the
largest self-inflicted risk in the project.

### No alarms, no monitoring

CloudWatch log groups exist. There are no alarms, no metric filters, and no dashboards. A
silent failure — a Lambda erroring on every invocation, a bounce rate climbing — would be
noticed by a person, not by the system. See [Operations](14-operations.md).

### The bounce subscriber is a personal address

Not a gap in coverage — `rajaemadhussain@gmail.com` is subscribed and confirmed, and it
receives bounces from both proposal delivery and internal notifications.

It is a gap in **continuity**. Bounce and complaint notices are the early warning that an
address has landed on the account suppression list, and they currently reach one personal
inbox belonging to one person. If that person is away, nobody sees them.

Move it to a monitored Aeygis address at the domain cutover — the same change that moves
the sender. Until `aeygis.com` exists there is nowhere better for it to go.

### S3 Object Lock is off

Deliberate, and confirmed with the user. It can only be set at bucket creation, so turning it
on later requires a new bucket and a data migration. Recorded as a deferred decision.

### Deletion protection is off on DynamoDB

Deliberate — it would block `npm run sandbox:delete`, and a sandbox is meant to be
disposable. **Turn it on for the branch environment when one is created.**

### Test credentials live in a gitignored file

`.test-credentials.json` holds three test users' passwords in plain text at the repository
root. It is gitignored, and there is no git repository anyway. Real staff credentials must
never go in it.

---

## 11.9 Privacy and compliance posture

| | |
|---|---|
| **Consent** | Required. A submission without it is rejected and nothing is stored. `consentedAt` is set server-side. |
| **Data minimisation** | The raw IP is never stored — only a salted hash, and only to rate-limit. |
| **Residency** | All data in `ca-central-1`. |
| **Encryption** | Customer-managed key, rotation enabled, on every table and the document bucket. |
| **Retention** | No automatic deletion of assessments or proposals. S3 noncurrent object versions expire after 365 days (10 newest kept). **There is no data-retention policy for the records themselves** — that is a business decision nobody has made yet. |
| **Right of access / erasure** | No tooling exists. Erasing a lead would need manual DynamoDB and S3 work, and the append-only audit records would survive it. Worth thinking about before real client data accumulates. |

### One known inaccuracy outside this project

`privacy.html` on the live site says *"Submissions from this Site are delivered by email to
our sales team."* **That is already wrong for the assessment form**, which now submits to
this backend and stores the answers in DynamoDB rather than emailing them. It stops being
visible to anyone only because the live site has not been deployed yet.

It also never discloses that submissions currently POST to a **third-party US processor**
(`formsubmit.co`) while the policy claims Canadian AWS-region hosting — arguably a PIPEDA
disclosure gap **today**, independent of anything this project changes.

**The user has said they will update the privacy policy themselves.** Recorded in
[`docs/known-issues.md`](../known-issues.md).
