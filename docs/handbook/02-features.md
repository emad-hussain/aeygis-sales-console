# 2. Features

← [Overview](01-overview.md) · [Index](README.md) · Next: [Architecture](03-architecture.md)

Every capability the system has, in the order a lead moves through it. For each one:
what it does, the rules it enforces, and why those rules exist.

---

## 2.1 Public assessment intake

**What it does.** An anonymous visitor on `health.aeygis.com` fills in a five-step cloud
readiness assessment. Their answers arrive here as an `Assessment` record.

**How it gets here.** The assessment form submits to this backend's AppSync API and
**nowhere else**. Until 2026-08-25 it emailed a third-party relay and mirrored the data
here; on the user's instruction the email was removed and the backend became the single
destination.

That makes the submission load-bearing rather than best-effort, so four things changed
with it: the call is **awaited**, it **retries** up to three times on a transient
failure, a failure is **shown to the visitor** with another way to reach us, and the
backend's **reference id** is displayed so they have something to quote. A new-lead
notification email now goes to an Aeygis inbox, because a lead landing in DynamoDB
announces itself to nobody.

**The retry is three attempts, pausing 400 ms then 1200 ms.** A dropped connection, a
throttle or a 5xx is retried; a refusal the backend understood (bad address, missing
consent) is **not** — the same payload fails identically three times, and the visitor is
told what to fix instead. It accepts one known trade: if an attempt stored the record and
only the response was lost, the retry writes a duplicate. A duplicate is visible and
fixable; a lost lead is neither. The idempotency key that removes that window is designed
in `PROJECT-STATUS.md` -> P12.

The separate **contact-sales** form still uses the email relay. The backend has no model
for a general enquiry — no consent field, no scale bands — so pointing it here would
either need a new model or drop bare enquiries into the assessment queue where they can
never be priced. Confirmed decision, not an oversight.

**The live site is not deployed**, so nothing reaches this backend from it yet. See
[Running in production](13-running-in-production.md).

**What is enforced on the way in:**

| Rule | Behaviour |
|---|---|
| **Consent is required** | A submission without CASL/PIPEDA consent is rejected outright. Nothing is stored. |
| **Honeypot** | A hidden field that a human never fills. If it is filled, the submission is silently dropped and the caller gets a normal-looking success receipt. |
| **Rate limiting** | Maximum 5 submissions per IP per rolling hour. Counted against a **salted SHA-256 of the IP**, never the address itself. |
| **Every field validated** | Length-capped, type-checked, normalised. Nothing is passed through raw. Spend figures above $100,000,000 are treated as a typo or an attack. |
| **Nothing is readable** | The response is a receipt (`{ok, referenceId, message}`) and never assessment content. |

**Why the honeypot and the rate limit return *success*.** A bot that gets a different
response for "blocked" than for "accepted" learns which of its tricks worked. Both
return the same shape, so it learns nothing. A real human who somehow trips one still
gets a reference number to quote.

**Why the IP is hashed with a secret salt.** IPv4 has about 4 billion addresses. An
unsalted hash is reversible by brute force in minutes, which would turn the stored value
into retained personal information rather than a privacy measure. If the salt is missing,
the function **skips rate limiting entirely** rather than hashing weakly — failing open
rather than pretending to protect something.

**The reference id.** Every submission gets one, in the form `AEY-7F3K2Q`. The alphabet
deliberately excludes `I`, `O`, `0` and `1`, so it can be read aloud on a phone call
without ambiguity.

---

## 2.2 Band widening and the refusal to guess

**The problem.** The live form collects provider and location counts as **ranges**, not
numbers:

```
providers:  "1-2" | "3-15" | "15+"
locations:  "1" | "2-5" | "5-15" | "15+"
```

Those ranges cross pricing tiers. `"1-2"` covers both Micro (1 provider) and Starter
(1–2 providers). `"3-15"` covers all of Professional *and* touches Enterprise at 15.

**What the system does.** It stores the band as provenance, widens it to an explicit
min/max range, and marks the record `needs_confirmation`. Pricing then **refuses to run**
until a staff member types in exact integers and ticks a confirmation box.

**Why it refuses instead of picking a number.** Quoting from a band is guessing at a
client's bill. The difference between Micro and Starter is $7,500 of setup fee.

**Which bands are ambiguous** is itself a rule, and it caught a bug. `"15+"` providers is
*not* ambiguous — every value in it is Enterprise, which routes to a discovery call
rather than a computed price. An early version flagged it by symmetry with the other
bands and was wrong. A cross-validation test in the pricing package caught it.

---

## 2.3 The intake queue

**What it does.** The console's left pane lists every lead, newest first, with the
clinic name, reference, contact, status, provider and location counts, and monthly IT
spend at a glance.

**Details worth knowing:**

- It uses a plain `list`, **not** the status index. A record with an unexpected status
  can therefore never become invisible — a lead that silently vanishes from the queue is
  worse than an unsorted list.
- Status filter chips are derived from the loaded rows, not a second API call, so the
  counts always agree with the list.
- The header count says **"8 leads"**, or **"3 of 8 leads"** when a filter is on. A bare
  number floating between a heading and a button reads as a stray digit.
- An account in no Cognito group sees an explicit explanation — "your account is in no
  group, an administrator must add you" — rather than a blank screen. Authentication is
  not authorization, and the console says so out loud.

---

## 2.4 Lead review and editing

**What it does.** Selecting a lead opens a detail pane with seven sections: Overview,
Scope, Pricing, Discovery, Proposal, Approvals, Notes.

**What staff can change:** exact provider / location / patient counts, the
counts-confirmed flag, lead status, internal notes, discovery answers, this clinic's own
custom questions, migration schedule estimates, and responsibility-matrix tailoring.

**What staff cannot do:** create an assessment, or delete one. The console exposes
neither, and the API grants staff only `read` and `update` on the model — a console that
could create assessments would let a rep invent a lead.

**One API quirk worth knowing.** The generated update resolver allows every field to be
*written* but no field to be set to *null*. Sending a single null fails the whole
mutation with `Unauthorized on [thatField]`, which reads like a problem with the
signed-in user and is not. The console therefore sends only the fields that actually
changed, and clears text with `''` rather than null. A **number** genuinely cannot be
cleared through this API; the console refuses that loudly rather than dropping the edit
and reporting success.

---

## 2.5 Technical discovery — 20 approved questions, plus the clinic's own

**What it does.** Staff fill in 20 approved technical discovery questions across five
categories:

| Category | Questions |
|---|---|
| Scope & inventory | 1–3 |
| Application & data architecture | 4–8 |
| Integrations & network | 9–12 |
| Identity & security | 13–15 |
| Resilience & operations | 16–20 |

**Per-clinic custom questions.** A clinic can also get its own extra questions and even
its own extra categories. These are **per assessment by design** — adding one here does
not touch the approved 20 and does not appear for any other client.

**The collision rule.** A custom question id that would shadow one of `q01`–`q20` is
**refused**, as is a custom category id that would shadow a standard group. Answers are
keyed by question id, so a collision would silently overwrite an approved answer.

**Numbering.** Custom questions are numbered after the approved 20, in render order:
extras inside an existing category first, then whole new categories. The numbering is
deterministic — the same input always produces the same numbers.

**Where they end up.** The technical discovery is **not** in the client PDF. It was
included at one point and removed on request in August 2026. It lives in the console for
internal use, and it feeds the proposal's understanding of the environment without being
reprinted verbatim.

---

## 2.6 Live pricing

**What it does.** The Pricing section shows a live quote for the lead as staff adjust it,
with a discount slider expressed as a percentage of list price.

**Three behaviours that must never be relaxed:**

1. **It refuses to price unconfirmed counts.** See 2.2.
2. **Enterprise shows no price at all.** The pricing engine returns a refusal branch with
   no price fields on it, and the panel renders that refusal. The internal guide range
   ($150k–$450k) is labelled as internal guidance, never presented as a quote. The rule
   from the Rate Card is explicit: *"Always send Enterprise clients through a discovery
   call first. Never give them a firm price before that call happens."*
3. **When Micro and Starter both apply, both are shown side by side.** The approved
   documents resolve that overlap by human judgement — *"Only offer Micro to a genuinely
   tiny, one-provider clinic"* — so the tool presents the choice rather than making it.

**Plan eligibility is data, not an if-chain.** Each tier/plan combination is either
`{offered: true, ...prices}` or `{offered: false, reason}`. An ineligible combination has
no price to read, so it cannot be quoted by accident. Professional cannot take Train &
Walk Away; Enterprise must be Full Managed.

**The discount floor.** Below 90% of list price, the resulting version is flagged
`requiresExecutiveSignOff`. The engine refuses a price factor above 1 outright — pricing
above list is not a supported operation.

**The annual check-up is never discounted.** It is a mandatory safety activity, not a
commercial lever. The sanctioned way to cut price is to reduce included scope.

---

## 2.7 Generating a proposal version

**What it does.** One click mints an immutable `ProposalVersion` and freezes a
client-safe JSON snapshot to S3.

**The sequence, and why the order matters:**

1. **Refuse on unconfirmed counts.**
2. **Price with the pure engine.** Enterprise returns a refusal with no price fields.
3. **Build the client payload through a hand-written whitelist mapper** — never a spread.
4. **Write the snapshot to S3 and hash the exact bytes uploaded.**
5. **Record the version with that hash.**
6. **Fire the PDF renderer asynchronously** so a multi-second Chromium cold start never
   blocks the person who clicked.

The hash is taken over **the bytes actually uploaded**, not over the JavaScript object
before serialisation. Hashing an object and uploading a separately-serialised string
would let the two drift apart, and everything downstream depends on that hash meaning
something.

**Version numbering.** `versionKey` is a zero-padded string — `v0004`, not `4`. Amplify's
GSI sort keys compare as text, so an integer `10` would sort before `2`. `versionNumber`
exists for display only and must never be used for ordering.

**Race safety.** The record's identity is the pair `(proposalId, versionKey)`, so DynamoDB
itself rejects a duplicate. Two reps saving at the same moment cannot both mint `v0004`.

**Who can do it.** Both staff roles. Producing a priced document is normal contributor
work; the privileged act is approving it.

---

## 2.8 The client PDF

**What it does.** Renders the frozen snapshot into a 17-page branded PDF using headless
Chromium inside a Lambda.

The document runs: cover → current environment → why now (regulatory) → measured impact →
spend comparison → your investment (pricing) → migration path → managed delivery →
indicative schedule → who does what (responsibility matrix) → working alongside your IT
provider → security and privacy → continuity and service levels → uptime → why Aeygis →
scope and terms → acceptance.

**What makes it trustworthy:**

- The renderer's **only input is an S3 key under `snapshots/`**. It never sees the live
  data model, assessment records, or internal cost figures.
- Its IAM role has **no ARN at all** for the internal S3 prefix.
- Before a single byte is rendered, the payload passes a runtime guard that rejects any
  key matching `/cost|margin|competitor|hourly|gross|cogs|internal|floor|payroll/i`, and
  the rendered HTML is scanned for confidential vocabulary. **A leak becomes a failed
  render, never a document in a prospect's inbox.**
- The spend comparison page renders **only when it favours the proposal**. Where the
  client supplied no usable figures, no estimate is invented.
- The acceptance page states plainly that accepting is not a signed agreement.

Full detail: [The proposal document](08-proposal-document.md).

---

## 2.9 Approval

**What it does.** An approver records a decision — approved or rejected — against one
specific version.

**Four ordered checks, each preventing something distinct:**

| # | Check | What it prevents |
|---|---|---|
| 1 | Caller is in `approver`, re-read from the request identity | The API rule and the recorded evidence disagreeing |
| 2 | The version exists | A decision pointing at nothing |
| 3 | The approver's expected hash matches the stored hash | Approving different numbers because a newer version appeared mid-review |
| 4 | **The stored hash matches a fresh hash of the actual S3 bytes** | A swapped snapshot being approved as though nothing changed |

Check 1 is not redundant with the API rule. It is what produces the group snapshot
written into the record, so the rule and the evidence cannot drift apart.

Check 4 is the one that makes the audit trail mean something. `ProposalVersion` is
immutable, but the S3 object it points at is a separate thing.

**Groups are snapshotted.** Cognito membership is mutable. If someone is later removed
from `approver`, the record must still show that they held that role **at the moment of
decision**. Resolving membership at read time would quietly rewrite history.

**A reversal is a new record, never an edit.** `update` and `delete` are removed from the
`Approval` model outright — not merely unauthorized, but absent from the GraphQL schema,
so no future authorization change can reintroduce them.

**What "approved" means for later steps.** The **latest** decision wins. A version that
was approved and then reversed by a newer rejection is treated as not approved — by the
delete rule, by the send rule, and by the badge the console shows. One rule, three
places, deliberately identical.

---

## 2.10 Discarding a draft version

**What it does.** Permanently deletes a proposal version that has not been approved.

**Why it exists.** Price iteration produces drafts. One test clinic reached seven
versions. Originally `delete` was removed from the schema entirely; that was reversed on
explicit instruction so staff can clear out drafts.

**How the weakening is bounded.** `delete` exists in the schema **only** so the Lambda
can call it. Staff hold `read` and nothing more, so no signed-in caller can invoke the
model's delete mutation directly. The one route available is the custom
`discardProposalVersion` mutation, which refuses anything whose latest decision is
`approved`.

**What did not change:** `update` is still gone. An approved version still cannot be
altered, so an approval still cannot come to mean something else.

**What "permanently" honestly means.** The DynamoDB row is genuinely gone. The S3
snapshot and PDF are deleted too — but the bucket has **versioning enabled**, so
`DeleteObject` writes a delete marker and the prior object versions remain until a
lifecycle rule expires them. Normal reads return 404 from that moment on. That is stated
plainly rather than described as an erase, because claiming bytes are destroyed when they
are recoverable is the kind of thing somebody later relies on.

**The audit record here is deliberately verbose.** Everywhere else an audit event
complements a row that still exists. Here it *replaces* one, so it carries the figures,
the tier, the plan and the content hash rather than just an id.

**Both roles can discard.** Clearing out drafts is ordinary drafting work. Approving
remains the privileged act, and an approved version cannot be discarded by anyone.

---

## 2.11 Emailing the proposal to the client

**What it does.** An approver clicks *Send to client*. The client receives an email with
the 17-page PDF attached, a copy goes to an internal BCC address, and **the lead moves to
`proposed`**.

That last part was added 2026-08-27. Before it, the pipeline could email a client a full
priced proposal and leave the queue still reading `in_review` until somebody remembered to
change it — the status is a claim about reality, so the event that changes reality should
change it. Only a **successful** send counts, and a `closed` lead is never reopened by one.
Full rules in [6.6](06-backend-functions.md#66-send-proposal-email).

**This is the only irreversible action in the system.** Everything else can be redone: a
price re-quoted, a draft discarded, a rejection reversed by a later record. An email
cannot be unsent. The design reflects that:

- **Approver only** — and for a different reason than approval. Approval is
  approver-only because it is the privileged *judgement*. Sending is approver-only
  because it is the irreversible *act*.
- **Never automatic.** Approving does not send. Staff may approve on Tuesday and send on
  Friday after a call — and more importantly, if approval fired an email there would be
  no gap in which to catch a mis-click.
- **Two clicks.** The console arms the button on the first click and sends on the second.
  The confirm label names the version explicitly.
- **No recipient argument.** The mutation takes none. The address comes from the clinic's
  own contact details on the assessment, so a caller cannot redirect a proposal by
  passing a different one.

**Six ordered checks before anything reaches SES:**

1. Caller is in `approver` (re-read from the request)
2. The version exists
3. Expected hash matches the stored hash
4. **The latest decision on that version is `approved`** — read from the record, not from
   what the console displayed
5. The stored hash matches a fresh hash of the actual S3 bytes
6. **Every recipient is on the allowlist** — To *and* BCC

**What gets recorded.** Checks 2–6 all write a `ProposalDelivery` row with status
`blocked`, because each is a decision this system made and somebody will ask why nothing
arrived. Check 1 does not: an unauthorized caller is an audit event, not a delivery
attempt, and writing a delivery row for one would let a rejected caller litter the
client's history.

**Three statuses, not a boolean:**

| Status | Meaning |
|---|---|
| `sent` | SES accepted the message and returned a message id. |
| `blocked` | **We refused on purpose.** Nothing left the building, nothing is broken. This is the *expected* outcome for a real client address while SES is in the sandbox. |
| `failed` | We tried and something went wrong — SES rejected it, the PDF could not be read, the network died. |

Collapsing `blocked` into `failed` would send somebody debugging a fault that does not
exist. Collapsing it into `sent` would be a lie.

**A second send is a second row**, never an edit of the first. Sending a revised proposal
is normal, and "we sent them two versions" is exactly the fact somebody needs later.

**What the email says.** No prices, no totals, no discounts, no internal language. The
numbers belong in the document where they have their context and caveats; a bare figure
in an email is quotable out of context. The date the pricing is held to and the proposal
reference are read from the **frozen snapshot** — the same bytes the PDF was rendered
from — so the email and the attachment can never state different dates.

Full detail: [Email delivery](10-email-delivery.md).

---

## 2.12 The delivery history

**What it does.** Below the approvals table, the console shows every send attempt for the
proposal: when, which version, the outcome, the recipient and BCC, who sent it, and the
detail.

**It includes refusals and failures, not only successes.** That is the point of the list:
*"why has the client not received this?"* is answered in the console rather than in
CloudWatch.

**The SES message id** on a successful row is labelled, held in full in the page, and
copies to the clipboard on click. It is the one handle that lets support trace a specific
message with AWS when a client says they never received it — and on its own it reads as a
random string, which is why it carries a label.

**Contributors can see it but cannot send.** A contributor who could not see the delivery
history would chase a client who already has the proposal.

---

## 2.13 The audit trail

**What it does.** Records every consequential act, so a sequence can be reconstructed
later: priced, rendered, approved, rejected, deleted, emailed, refused, denied.

**What each record carries:** the subject (usually the proposal reference), the event
type, the actor's Cognito subject, their **email address resolved at write time**, the
groups they held at that moment, a free-form JSON detail, and a timestamp.

**Why the email is resolved at write time.** The request does not carry it. Amplify sends
the Cognito **access token** for user-pool auth, and that token has `sub` and
`cognito:groups` but not `email`. So the three audit-writing functions look the address
up from Cognito themselves, at the moment of the act — the same reasoning that makes
`decidedByGroups` a snapshot rather than a later lookup. A user can be renamed or
removed; an audit record must say what was true when it happened.

Records written before this was fixed keep their bare UUIDs. Append-only means they
cannot be backfilled, and that is the correct outcome.

**Refusals are audited too.** A caller who somehow reaches a Lambda despite the API-level
group rule writes an audit event saying exactly that, with
`reachedLambdaDespiteApiRule: true`. Reaching it would mean the API rule had stopped
working, which is precisely the thing you want a record of.

**Nothing confidential goes in `detail`.** It is readable by every staff member,
including contributors.

---

## 2.14 Theme, accessibility and responsiveness

The console ships a **light and a dark theme** with a toggle, and it is checked in a real
browser at five widths (620, 900, 1024, 1280, 1600) in both themes — 131 automated checks
covering layout overflow, text clipping, sticky-header collisions, WCAG AA contrast on
every text node, reduced-motion behaviour, and the typeface each heading actually paints
in.

That check exists because the console once typechecked, built, and served HTTP 200 while
rendering a blank page — and later rendered 77 text nodes below WCAG AA contrast. Neither
is visible to a compiler.

The UI check deliberately **never clicks Send**. A layout check must not be able to
perform the one irreversible action in the system.
