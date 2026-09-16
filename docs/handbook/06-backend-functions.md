# 6. Backend functions

← [AWS resources](05-aws-resources.md) · [Index](README.md) · Next: [Pricing engine](07-pricing-engine.md)

Six Lambdas. Each one is the **sole writer** of something, which is what makes the
authorization model work: staff hold `read` on the models and the function does the
writing, so a rule cannot be bypassed by calling the API directly.

| Function | Sole writer of | Invoked by | Who may invoke |
|---|---|---|---|
| `submit-assessment` | `Assessment` | `Mutation.submitAssessment` | anyone, including guests |
| `price-proposal` | `ProposalVersion` + snapshots | `Mutation.generateProposal` | contributor, approver |
| `render-proposal-pdf` | `proposals/client/*` | `price-proposal`, async | nothing else |
| `decide-proposal` | `Approval` | `Mutation.decideProposal` | approver |
| `delete-proposal-version` | deletions | `Mutation.discardProposalVersion` | contributor, approver |
| `send-proposal-email` | `ProposalDelivery` | `Mutation.sendProposalEmail` | approver |

Three of them also write `AuditEvent`: `decide-proposal`, `delete-proposal-version`,
`send-proposal-email`.

---

## 6.1 `submit-assessment`

[`amplify/functions/submit-assessment/`](../../amplify/functions/submit-assessment/) ·
15 s · 256 MB

**The only writer of `Assessment`, and the only part of the system an anonymous caller can
reach.**

> **Changed 2026-08-25.** The public form used to email sales through a third-party relay
> and mirror the data here. The email was removed and this became the only destination for
> a lead, which meant a lead could arrive with nobody told. So after a successful write
> this function now sends an internal **new-lead notification** by SES — best effort, never
> fatal, and skipped entirely for `.invalid` test addresses so verification runs neither
> spam the inbox nor spend SES quota that proposal delivery shares.
>
> Its timeout went from 15 s to 30 s at the same time: a 15-second budget shared between a
> rate-limit query, a DynamoDB write and an SES call leaves no room for a slow one, and a
> timeout here would fail a submission that had already been stored.

### Design rules, in priority order

1. **Never leak.** The response is a receipt — never assessment content, never an internal
   error message, never a stack trace.
2. **Never store without consent.** Enforced in `validate.ts` as a hard failure.
3. **Give abuse no signal.** A tripped honeypot and a rate-limit rejection both return the
   same shape as success, so a bot cannot tell what stopped it.

### Flow

```
payload
  │
  ├─ honeypot tripped? ────────────▶ return opaqueSuccess, store nothing
  │
  ├─ validate ─────────── invalid ─▶ return the errors  ← the submitter's own mistakes,
  │                                                        so they need to be fixable
  ├─ hash the source IP (salted)
  │     no salt? ──▶ log an error, skip rate limiting entirely
  │
  ├─ rate limited? ────────────────▶ return opaqueSuccess, store nothing
  │
  └─ create the Assessment record
        status = countsConfirmed ? 'new' : 'needs_confirmation'
        source = 'health_site_live_form'
        consentedAt = now
        │
        └─ refused? ──▶ SALVAGE: drop the offending field, store what is left
                          still refused? ──▶ report the failure honestly
```

> **Added 2026-08-26 — the salvage retry.**
>
> Two real leads were lost the day before this was written. Both were complete and valid;
> both died because `phone` held `(416) 555-1234` and the field was declared `a.phone()`,
> a scalar that refuses parentheses. An **optional** field destroyed entire submissions.
> Full account in [Gotchas §16.32](16-gotchas.md#1632-a-scalar-that-validates-at-write-time-can-only-destroy-a-submission).
>
> The specific cause was fixed at its source. `salvage.ts` exists because the *shape* of
> that bug will recur — a type tightened, a field added, a scalar that behaves differently
> from how it reads — and the cost is always a whole lead for one bad value.
>
> On a refusal it parses the offending field names out of the error
> (`"Variable 'phone' has an invalid value."`), drops those that are not essential, and
> writes again. If it cannot identify a field, it falls back to keeping only
> `ESSENTIAL_FIELDS` — the six the schema marks required, plus `email`, `clinicName`,
> `contactName` and `consentedAt`.
>
> Three things it deliberately does **not** do:
>
> - **It never retries the same record.** A rejected variable is rejected deterministically,
>   so an identical retry is a wasted second and a second failure. Only a genuinely smaller
>   record is worth sending.
> - **It never drops an essential field.** If the offending value is `email`, salvage
>   returns null and the function reports the failure. A lead nobody can reply to is not
>   worth pretending to have saved.
> - **It never hides what happened.** A salvaged write logs at **WARN** naming the dropped
>   fields, and the new-lead email opens with a `HEADS UP` line listing them — so the email
>   and the console cannot quietly disagree about what exists.

### Details that matter

**Validation errors ARE returned.** Unlike the honeypot and the rate limit, these are the
submitter's own input mistakes — a malformed email, missing consent — and they need to be
fixable. Everything else returns the opaque success.

**The reference id.** `AEY-` plus six characters from an alphabet that excludes `I`, `O`,
`0` and `1`, so it survives being read aloud on a phone call.

**Source IP extraction is defensive.** AppSync surfaces `sourceIp` on the identity for IAM
and Cognito requests, but the shape is not guaranteed across auth modes, so every access is
probed. **A missing IP means rate limiting is skipped rather than the submission being
rejected** — dropping a real lead is the worse error.

**Rate limiting fails open.** If the counting query errors or throws, the submission is
allowed. A counting failure must not block a genuine lead.

**Persistence failure returns a generic message** pointing at `aws@aeygis.com`. The detail
goes to CloudWatch and nowhere near the caller.

### Validation rules (`validate.ts`, pure and unit-tested — 30 tests)

Posture: this is an anonymous, internet-facing write path. **Treat every field as
hostile.** Nothing is passed through unvalidated, nothing is spread, and every string is
length-capped so a submission cannot inflate storage or smuggle a payload into a
later-rendered PDF.

| Cap | Value |
|---|---|
| Short fields | 200 characters |
| Notes | 4,000 characters |
| Spend figures | $100,000,000 — above this is a typo or an attack, not a clinic |

Bands are validated against the known vocabularies and widened to explicit ranges.
Anything outside a known set becomes null rather than being stored raw.

**A bug the tests caught.** `\t` sits inside the range `U+0000-U+001F`, so the original
control-character strip **deleted** tabs instead of collapsing them — turning
"Bay Street + tab + Clinic" into "Bay StreetClinic". Fixed by excluding `U+0009-U+000D` from the strip class.

---

## 6.2 `price-proposal`

[`amplify/functions/price-proposal/`](../../amplify/functions/price-proposal/) ·
30 s · 512 MB

**Mints an immutable `ProposalVersion` and freezes a client-safe snapshot.**

### The sequence, and why the order matters

| # | Step | Why here |
|---|---|---|
| 1 | Refuse if counts are unconfirmed | A band cannot determine a tier, so quoting from one would be guessing at the client's bill |
| 2 | Price with `@aeygis/pricing` | Enterprise returns a refusal branch with no price fields, so it cannot become a proposal here |
| 3 | Build the client payload via `toClientPayload` | A hand-written whitelist mapper, **never a spread** — barrier 2 of 5 |
| 4 | Write the snapshot to S3 and hash **the exact bytes** | Hashing an object and uploading a separately-serialised string would let the two drift |
| 5 | Record the version with that hash | An approval binds to it, so altered content is detectable afterwards |
| 6 | Fire the renderer with `InvocationType: 'Event'` | So a multi-second Chromium cold start never blocks the caller |

### Argument validation

Tier and support plan arrive as **strings, not GraphQL enums** (the vocabularies are shared
with `@aeygis/pricing`), so GraphQL cannot enforce them. The handler validates both against
the real lists before doing anything else:

```
Unknown tier "..."           →  refused
Unknown support plan "..."   →  refused
```

This caught a real mistake during verification: a script passed `"standard"` as a support
plan, which does not exist. The real values are `trainAndWalkAway`, `essentials`,
`fullManaged`.

### Version allocation

Reads existing versions, takes `max(versionNumber) + 1`, formats it zero-padded. A lost
race **retries rather than overwriting**: the composite identifier
`(proposalId, versionKey)` makes a duplicate a DynamoDB-level rejection, so two reps cannot
both mint `v0004`.

### One `Date` instance for both dates

```ts
const issuedAt = new Date();
const issuedOn  = formatDate(issuedAt);
const validUntil = formatDate(validUntilDate(issuedAt));
```

Formatting the issue date and then **parsing that display string back** to compute the
expiry is how a contractual date ends up a day out. `validUntilDate` adds days on the
calendar, so a daylight-saving boundary cannot shift it either.

### `createdBy`

Taken from the **request identity**, never from an argument. A client-supplied author is
not evidence of anything.

---

## 6.3 `render-proposal-pdf`

[`amplify/functions/render-proposal-pdf/`](../../amplify/functions/render-proposal-pdf/) ·
60 s · 2048 MB · Chromium layer

**Renders a frozen snapshot into a client-facing PDF.**

### Its input is an S3 key and nothing else

```ts
interface RenderEvent {
  snapshotS3Key: string;
  outputS3Key: string;
  proposalId: string;
  versionKey: string;
}
```

The handler never receives assessment data, pricing inputs, or anything else directly. It
reads the frozen, already-client-safe JSON that `price-proposal` wrote. **That is
confidentiality barrier 3: there is no path from here to the live data model or to internal
cost figures.**

Its IAM role can read `snapshots/` and write `proposals/client/`. It has **no ARN at all**
for `proposals/internal/` — barrier 4.

### Flow

```
CHROMIUM_PACK_URL set?  ── no ─▶ refuse loudly with an explicit message
        │
resolve the bucket name from SSM (cached per cold start)
        │
read the snapshot from S3
        │
assertClientSafe(payload)          ← BARRIER 5, before a single byte is rendered
        │
renderProposalHtml(payload, TEMPLATE_ASSETS)
        │
assertHtmlFreeOfConfidentialWords(html)
        │
launch Chromium ─▶ setContent ─▶ await document.fonts.ready ─▶ page.pdf()
        │
write to proposals/client/{proposalId}/{versionKey}.pdf
   with metadata: proposalid, versionkey, snapshotkey
        │
always: browser.close()
```

### Details that matter

**A missing browser binary refuses loudly.** If `CHROMIUM_PACK_URL` is empty the function
returns an explicit error naming the variable and the doc that explains it. A missing
binary must not look like a rendering failure of the *document*, or somebody spends a day
debugging the template.

**`await page.evaluate('document.fonts.ready')`.** Fonts are embedded as data URIs, but the
engine still applies them asynchronously; without this the first page can rasterise in a
fallback typeface. It is passed as a **string rather than a closure** on purpose — the code
runs in the browser context, so a closure would require DOM lib types in a Node tsconfig,
which would then wrongly hand every other handler DOM globals.

**Page geometry comes from the template's own `@page` rule** (`preferCSSPageSize: true`),
so there is one source of truth. Puppeteer also rejects `pt` units for explicit
width/height, which is a second reason not to duplicate them.

**S3 metadata records provenance** — which snapshot produced this object — so a PDF can
always be traced back to the approved content hash.

**It reads `process.env` directly rather than the generated `$amplify/env/*` module**,
because the provider overload means Amplify does not manage this function's environment and
the typed module is not reliably produced. `requireEnv()` throws with a clear message
naming the variable. That is a deliberate trade of a little type safety for not depending
on unverified code generation.

---

## 6.4 `decide-proposal`

[`amplify/functions/decide-proposal/`](../../amplify/functions/decide-proposal/) ·
30 s · 512 MB

**Records an approval or rejection. Sole writer of `Approval`.**

### Four checks, in order

| # | Check | Prevents | On failure |
|---|---|---|---|
| 1 | Caller is in `approver`, re-read from the request identity | The API rule and the recorded evidence disagreeing | Audit event `approval_denied_not_approver`, carrying `reachedLambdaDespiteApiRule: true` |
| 2 | The version exists | A decision pointing at nothing | Plain refusal |
| 3 | `expectedContentSha256` matches the stored hash | Approving different numbers because a newer version appeared mid-review | Audit event `approval_refused_stale_hash` |
| 4 | **The stored hash matches a fresh hash of the S3 object** | A swapped snapshot being approved as though nothing changed | Audit event `approval_refused_snapshot_tampered` + a loud `console.error` |

Check 1 should be unreachable — AppSync enforces `allow.group('approver')` first. It is
recorded as an audit event **precisely because reaching it would mean the API-level rule
had stopped working.**

Check 4 is the one that makes the audit trail mean something.

### What it writes

An `Approval` record and an `AuditEvent`. Both append-only. A reversal is a **new record**,
never an edit.

`decidedByGroups` is snapshotted at decision time; `decidedByEmail` is resolved from
Cognito at write time (see [Data model §4.8](04-data-model.md#48-the-actor-email-problem-and-how-it-was-fixed)).

### The success message

```
Approved AEY-XXXXXX v0003. Delivery is a separate, explicit step.
```

That sentence is a promise the system keeps: approving never sends an email.

### Error handling

The caller gets a deliberately generic *"Could not record the decision. Please try
again."* The detail is in CloudWatch. Audit writes are best-effort and wrapped so a failed
audit write never masks the original outcome.

---

## 6.5 `delete-proposal-version`

[`amplify/functions/delete-proposal-version/`](../../amplify/functions/delete-proposal-version/) ·
30 s · 512 MB

**The sole route to deleting a proposal version.**

### The refusal rule

An **approved** version is never deletable, by either role. "Approved" means the **latest**
decision on that version is `approved` — a version that was approved and later reversed by
a newer rejection *is* deletable, matching exactly how the console decides which badge to
show. Anything else (never decided, or rejected) may go.

### Order of operations, and why

| # | Step | Why in this order |
|---|---|---|
| 1 | Identify the caller | Needed for the audit record on every path |
| 2 | Check the version exists | |
| 3 | Check the latest decision | The refusal must happen before anything is touched |
| 4 | **Capture everything about the version** | The row is where these are recorded, and it is about to go |
| 5 | **Delete the DynamoDB row first** | The authoritative step. If it fails, nothing else has been touched, so the version is left completely intact rather than half-deleted |
| 6 | Delete the S3 objects, **best effort** | An orphaned S3 object costs storage; a surviving row whose objects were deleted would show staff a version whose "View PDF" is permanently broken. Given one has to fail first, the harmless one is chosen |
| 7 | Write the audit record | Now the only surviving record of what was removed |

### The audit record is deliberately verbose

Everywhere else in this system an audit event *complements* a row that still exists. Here
it **replaces** one. So it carries the tier, plan, all four figures, the currency, the
price book version, the content hash, the snapshot key, who created it and when, the prior
decision, and whether each S3 delete succeeded.

### What "permanently" honestly means

The DynamoDB row is genuinely gone — the version disappears from the API, not just from a
list. The S3 objects are deleted too, **but the bucket has versioning enabled**, so
`DeleteObject` writes a delete marker and the prior object versions remain until the
lifecycle rule expires them. Normal reads return 404 from that moment on.

Stated plainly rather than described as an erase, because claiming bytes are destroyed
when they are recoverable is the kind of thing somebody later relies on.

### A deliberate, accepted consequence

A rejected version leaves its `Approval` record behind — `Approval` has update and delete
removed from the schema outright, so the decision record survives the thing it decided on,
pointing at a version that no longer exists. **The evidence that a decision was made
outlives the draft.**

---

## 6.6 `send-proposal-email`

[`amplify/functions/send-proposal-email/`](../../amplify/functions/send-proposal-email/) ·
30 s · 512 MB

**The only irreversible action in this system, and the only thing that reaches outside the
account.**

> **Added 2026-08-27 — a successful send moves the lead to `proposed`.**
>
> Until now the pipeline could email a client a full priced proposal and leave the lead
> reading `in_review`, so the queue disagreed with reality and somebody had to remember to
> change it by hand. The rule now lives in code:
>
> | Lead status before the send | After |
> |---|---|
> | `new`, `needs_confirmation`, `in_review` | **`proposed`** |
> | `proposed` | unchanged — already there |
> | `closed` | **unchanged** — a person ended this lead; a send does not reopen it |
> | anything unrecognised | **unchanged** — see below |
>
> Three things about how it is built:
>
> - **Only on `sent`.** `blocked` means the system deliberately refused and nothing left
>   the building; `failed` means something broke. In both cases no proposal exists in
>   anyone's inbox, so calling the lead "proposed" would be a claim the pipeline then
>   reports on.
> - **Best effort, never fatal.** It runs after SES has accepted the message, so the email
>   is already gone and cannot be recalled. Nothing here may turn a successful send into a
>   reported failure — the approver would be told the client did not receive a proposal
>   they are at that moment reading. Failures are logged loudly and swallowed, exactly like
>   the audit write.
> - **It re-reads the lead first**, rather than trusting the copy fetched earlier in the
>   same request. That copy is a few hundred milliseconds old by then and a staff member
>   could have closed the lead in between — which is precisely the case this must not
>   trample.
>
> The decision itself is a pure function in
> [`leadStatus.ts`](../../amplify/functions/send-proposal-email/leadStatus.ts), tested
> separately. It **refuses an unrecognised status rather than guessing**: a status the rule
> was never written against belongs to somebody else's intent, and overwriting it is worse
> than a lead that reads slightly stale. A test fails if a status is ever added to the model
> without someone deciding which side of the rule it falls on.
>
> The console picks the change up without a reload: `DeliveryPanel` reports a successful
> send upward and `AssessmentDetail` re-reads the lead, because the moment a person is most
> certain something just happened is the worst moment to show them stale state.

### Six checks, in order

Ordered so the cheapest refusals happen before any work, and so nothing reaches SES until
every question has been answered.

| # | Check | Prevents | Recorded as |
|---|---|---|---|
| 1 | Caller is in `approver` | The rule and the evidence disagreeing | **Audit only** — see below |
| 2 | The version exists | A send pointing at nothing | Plain refusal |
| 3 | Expected hash matches the stored hash | Mailing different numbers than were on screen | `blocked` |
| 4 | **Latest decision is `approved`** — read from the record | Sending something the console *displayed* as approved | `blocked` |
| 5 | Stored hash matches a fresh hash of the S3 object | Mailing a swapped snapshot under cover of an old approval | `blocked` |
| 6 | Every recipient is on the allowlist (To **and** BCC) | Emailing a real prospect while in the sandbox | `blocked` |

Then, before sending: the assessment must be readable, the snapshot must carry a validity
date, and the PDF must exist. Each of those failures is recorded as `failed` — they mean
something went wrong, not that the system refused.

**Why check 1 does not write a delivery row.** An unauthorized caller is an audit event,
not a delivery attempt. Writing a delivery row for one would let a rejected caller litter
the client's delivery history.

### Composing the message

```
validUntil          ← from the FROZEN SNAPSHOT (acceptance.validUntil)
proposalReference   ← from the FROZEN SNAPSHOT
clinicName          ← from the ASSESSMENT record
contactName         ← from the ASSESSMENT record
previouslySent      ← from the DELIVERY HISTORY, not the version number
```

**Why the contractual facts come from the snapshot.** They are the same bytes the PDF was
rendered from, so the email and the attachment can never state different dates. If the
email worked out its own "pricing held until" date, it would eventually disagree with the
document attached to it, and the client would be looking at two dates from one company.

**Why the names come from the assessment instead.** They are cosmetic — a greeting and a
subject line — and the snapshot substitutes the placeholder "Your clinic" when a clinic
name is absent, which reads fine inside a document and badly in a subject line.

**Why `previouslySent` comes from the delivery history.** Staff iterate through versions
internally and send only some of them, so `versionNumber > 1` does not mean the client ever
saw an earlier one. Calling a proposal "updated" when they never received the first would
be telling them about a document that does not exist for them.

**If the snapshot has no `acceptance.validUntil`**, the send is recorded as `failed` with
*"the stored proposal is missing the date its pricing is held to"* and the operator is told
to regenerate the version. It does not invent a date.

### The SES call

```ts
FromEmailAddress: env.SES_FROM_ADDRESS
Destination: { ToAddresses: [recipient], BccAddresses: [bcc] }
ReplyToAddresses: [env.SES_FROM_ADDRESS]
ConfigurationSetName: env.SES_CONFIGURATION_SET
Content.Simple:
  Subject / Body.Text / Body.Html   (all UTF-8)
  Attachments: [{
    FileName: 'Aeygis-Cloud-Proposal-<clinic>-v0003.pdf',
    RawContent: pdfBytes,
    ContentType: 'application/pdf',
    ContentDisposition: 'ATTACHMENT',
    ContentTransferEncoding: 'BASE64',    // ← see below
  }]
```

**`ReplyToAddresses` is stated explicitly** rather than left to SES's default, so a future
change to the From address cannot silently strand client replies.

**`ContentTransferEncoding: 'BASE64'` is the single most important line in this function.**

The first real proposal email arrived with a **blank PDF**. Everything checkable was
provably fine: the S3 object rendered, the SDK's base64 round-tripped byte-identical, the
PDF header was intact. The cause was the one field left unspecified.

The AWS API reference lists `BASE64`, `QUOTED_PRINTABLE` and `SEVEN_BIT` as valid values
and **documents no default** — checked; it simply is not stated. A PDF is binary: `SEVEN_BIT`
strips the high bit, `QUOTED_PRINTABLE` rewrites bytes it considers unprintable. Either
produces a file that arrives the right size and opens blank or broken. A PDF's object
structure is largely ASCII and survives, which is why the reader found 15 pages — and the
compressed content streams did not, which is why it drew 15 empty ones.

**The lesson is not "set that field". It is that an undocumented default on a binary
payload is a silent-corruption risk.**

### Recording

Every outcome after the authorization check goes through one `record()` helper, so no path
can quietly skip the record. It writes a `ProposalDelivery` row and a matching `AuditEvent`,
then shapes the caller's reply.

**A failed record must never turn a successful send into a reported failure** — the client
already has the email. A write failure there is logged loudly and the send is still reported
as sent.

**The outermost catch writes no delivery row at all.** That path means we do not reliably
know what happened, and inventing a status would be worse than the gap.

### Configuration

Exported constants in `resource.ts`, so `backend.ts` builds IAM ARNs from the same values —
an address written in two files drifts the first time one changes, and the failure mode is
bad: the function would send from an address its own IAM policy does not cover.

| Constant | Current value | Meaning |
|---|---|---|
| `SES_ENABLED` | `'true'` | Master off switch. **Anything other than the exact string `'true'` is off.** |
| `SES_FROM_ADDRESS` | `rajaemadhussain@gmail.com` | Must be an SES-verified identity. Changing it **requires a redeploy** — the IAM policy is scoped to its ARN. |
| `SES_BCC_ADDRESS` | `rajaemadhussain@gmail.com` | Internal copy. Blank disables it. |
| `SES_ALLOWED_RECIPIENTS` | `rajaemadhussain@gmail.com` | Who may be emailed. **Fails closed.** |
| `SES_CONFIGURATION_SET` | `aeygis-proposal-delivery` | A fixed literal, not a CloudFormation reference — importing the construct's generated name would create a cross-stack cycle. |

**Why these are plain values and not secrets.** `secret()` would let them change without
touching the repository. That sounds like an advantage and is the wrong trade:
`SES_ALLOWED_RECIPIENTS` decides who this company is allowed to email, and a change to it
should appear in a diff and be seen by a second pair of eyes. As a secret it would be
invisible — someone could widen it to everyone and nothing in the repository would record
that it happened. None of these values is confidential; they are configuration that gates
outbound email, and that belongs in version control.

**Why `SES_ENABLED` is committed as `'true'`.** It was `'false'` when the function was
first written, on the reasoning that a first deploy should not arrive able to send. That
was changed once the identity was verified, because `'false'` was the wrong committed
default: the **real** guard is the allowlist, which fails closed, and a committed `'false'`
means every future environment deploys unable to send with a symptom — proposals silently
recorded as `blocked` — that reads like a bug rather than a setting.

So it is the **emergency stop**, not the routine gate.

---

## 6.7 Shared modules

### `functions/shared/identity.ts` — pure

Reads the caller from an AppSync Lambda-resolver event.

**Defensive by design.** Only `event.arguments` is documented for Lambda resolvers;
`event.identity`'s shape is not, and it differs between Cognito user pool, IAM and OIDC
auth modes. So every field is probed rather than assumed, and **a missing subject throws
instead of defaulting.**

Refusing to guess matters here: this identity is written into an immutable audit record. An
empty or invented actor would make the trail worthless precisely when someone needs to rely
on it.

Groups are read from either `identity.groups` (which AppSync surfaces) or
`claims['cognito:groups']`, deduplicated, never merged silently beyond that.

Three named predicates, deliberately separate so the two different bars are impossible to
confuse at a call site:

```ts
isDecision(value)   // exactly 'approved' | 'rejected'
isApprover(caller)  // approver only        — decide, send
isStaff(caller)     // either staff role    — discard
```

**Why this file is pure.** A handler calls `getAmplifyDataClientConfig` at module load, so
importing one in a test would require AWS credentials — and **a security check that cannot
be tested without credentials is a security check that does not get tested.** 29 tests.

### `functions/shared/callerEmail.ts` — makes one AWS call

Fills in the caller's email address, which the request does not carry. Kept in a **separate
file** from `identity.ts` precisely so that file stays pure. Everything in here that can be
pure is, and is tested (7 tests).

Full explanation: [Data model §4.8](04-data-model.md#48-the-actor-email-problem-and-how-it-was-fixed).

### `send-proposal-email/recipientPolicy.ts` — pure

The allowlist. 20 tests.

```
nothing configured   →  { kind: 'none' }   block everything
'*'                  →  { kind: 'all' }    allow everything
'a@x.com,b@y.com'    →  { kind: 'list' }   allow exactly those
```

**The fail-closed correction.** The Phase 5 plan originally said the allowlist would be
"emptied" to go live. Writing this file showed that to be wrong, and quietly dangerous: if
empty meant "no restriction", then an unset environment variable — a typo in a deploy, a new
environment nobody finished wiring, a variable dropped in a refactor — would silently mean
"email anyone".

**An absent setting must never be the permissive one.** Going live is now setting `*`, which
is a visible, greppable, obviously intentional act rather than the absence of one.

Other behaviour:

- Separators may be commas, semicolons or whitespace, because a value typed by a human into
  a deploy config will eventually use all three.
- A value that was set but parsed to nothing (`,,,`) falls back to **block**, not allow.
- Matching is case-insensitive, but **the original spelling is what gets sent** — a clinic
  that typed `Reception@Clinic.ca` should see their own capitalisation in the To field.
- `looksLikeAnAddress` is a deliberately conservative sanity check, **not** an RFC 5322
  validator. Full email validation is a well-known rabbit hole that gets no safer the more
  of it you write. Anything unparseable is treated as **blocked**, never passed through.
- **All recipients are checked, not just the client.** In the SES sandbox a single
  unverified address anywhere in To, CC or BCC causes AWS to reject the whole message, so
  checking only the primary recipient would produce a failure whose cause is invisible in
  the console.
- The verdict is **all-or-nothing**. There is no partial send: emailing the internal BCC
  copy of a proposal the client never received would put a misleading record in a staff
  inbox.

### `send-proposal-email/emailBody.ts` — pure

Builds the subject, both bodies, and the attachment filename. 31 tests, including a leak
test.

**No figures anywhere.** No prices, no totals, no discounts, no internal language. Partly
because the numbers belong in the document where they have their context and caveats — a
bare figure in an email is quotable out of context. Mostly because the Rate Card is
confidential and **the least error-prone rule is "this file never states money at all"**.
The test beside it enforces that.

**Header injection is handled.** The subject carries the clinic name, which is free text a
stranger typed into a public form. A carriage return or newline inside a header value is the
classic header-injection shape: everything after it can be read as a new header, which is
how an attacker adds their own Bcc. `singleLine()` replaces control characters with a space
(rather than stripping them, so words either side do not run together) and collapses runs of
whitespace. SESv2 builds the MIME itself from structured input so this is not relied upon to
be exploitable — but *"the SDK probably handles it"* is not a reason to pass a newline into a
header.

**HTML is escaped.** `Smith & Sons Family Health` would break the markup, and a name
containing a tag would be worse than broken.

**Filenames are slugged.** Accents, slashes, colons and quotes all appear in real clinic
names and all cause trouble somewhere between SES, a mail client and a Windows desktop. The
slug normalises to NFKD, strips combining marks in the explicit range `U+0300–U+036F` (so
*Clinique Santé* becomes *Clinique Sante* rather than *Clinique Sant-*), reduces everything
else to hyphens, and caps at 60 characters so a long name cannot push the filename past SES's
limit.

The version is in the filename so a client who saves two revisions ends up with two files
rather than one overwriting the other.

**A plain-text body is sent alongside the HTML one, not instead of it.** Some clients — and
most security gateways that rewrite mail — show the text part, and a proposal that arrives as
a blank message with an attachment reads as spam.

**The greeting is "Hello there," or "Hello <full name>,", never a guessed first name.**
Splitting a full name to find one gets it wrong for compound surnames and for anyone who
entered a title, and getting somebody's name wrong in the first line of a sales email is
worse than being slightly formal.

**Inline styles only.** Mail clients routinely strip `<style>` blocks.

### `render-proposal-pdf/assertClientSafe.ts` — pure

Confidentiality barrier 5. 36 tests. Covered in
[Pricing engine §7.5](07-pricing-engine.md#75-the-five-barriers-in-detail).

---

## 6.8 How the functions reach data

Every function that touches a model calls **back through AppSync** with
`authMode: 'iam'`, not the DynamoDB SDK directly:

```ts
const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>();

await data.models.ProposalVersion.get({ proposalId, versionKey }, { authMode: 'iam' });
```

**Why that matters:**

- The **AppSync data-source role** is the principal that touches DynamoDB, not the Lambda's
  own role. That is why Lambda roles do not need KMS grants for model data, and why the
  data-source roles do.
- The schema's authorization rules still apply, so a function cannot accidentally reach
  something the schema does not expose.
- Type safety comes from the same generated `Schema` type the console uses.

S3 and SES are different: those functions **do** call the AWS SDK directly, which is exactly
why they need explicit KMS and SES grants on their own execution roles.
