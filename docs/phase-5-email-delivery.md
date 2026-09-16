# Phase 5 — Email delivery

**Status:** ✅ **BUILT, DEPLOYED AND VERIFIED END TO END** — 2026-08-23.
A real proposal was emailed, with the PDF attached, and the delivery recorded.
**Sandbox only:** mail can reach exactly one verified address, and deliverability
to real clinics is unproven until the domain cutover — see
[the deliverability note](email-setup.md#-deliverability-the-sandbox-proves-the-pipeline-not-that-mail-arrives).
**Written:** 2026-08-23.
**Companion documents:** [`email-setup.md`](email-setup.md) covers the SES account
setup and the production cutover. This document covers how the feature works inside
the project.

---

## 1. What problem this solves

Right now the sales pipeline runs all the way to a finished, approved PDF — and then
stops.

```
lead comes in  →  staff fill in details  →  price it  →  PDF is generated  →  approved
                                                                                  │
                                                                                  ▼
                                                                          ...and nothing
```

Someone has to open the console, download the PDF, switch to their email client, write
a message, attach the file, and send it. Four problems with that:

1. **No record.** The system does not know the proposal was ever sent, so the console
   cannot show it and nothing can be audited later.
2. **The wrong file can go out.** Nothing checks that the PDF being attached is the one
   that was actually approved.
3. **It can be sent before approval.** Nothing stops it.
4. **It is manual work** on every single deal.

Phase 5 adds one button — *Send to client* — that does the whole thing and writes down
what happened.

---

## 2. The one-paragraph version

An approver opens an approved proposal version and clicks *Send to client*. A new
Lambda function checks the version is genuinely approved, checks the stored document
still matches its approved fingerprint, looks up the clinic's contact email, checks
that address is allowed to be emailed, pulls the PDF out of S3, and sends it through
Amazon SES as an attachment with a copy BCC'd to Aeygis. It then writes a delivery
record and an audit record. The console shows the result.

Everything below is the detail behind that paragraph.

---

## 3. Background: what SES is, and why the sandbox matters

**Amazon SES** (Simple Email Service) is AWS's service for sending email. You call an
API, it delivers the message. It is already available in `ca-central-1`, so email does
not have to leave Canada — which matters, because Canadian data residency is the
central promise in the Aeygis Cloud Overview.

Every AWS account starts SES in the **sandbox**. Checked live on 2026-08-23 for this
account (`326629581669`, `ca-central-1`):

```
ProductionAccessEnabled : false          ← we are in the sandbox
Max24HourSend           : 200            ← 200 emails per day
MaxSendRate             : 1              ← 1 email per second
EmailIdentities         : []             ← nothing verified yet
```

Three sandbox rules matter for this design:

| Rule | What it means here |
|---|---|
| You may only send **to verified addresses** | We cannot email a real prospect. Not "should not" — SES will reject it. |
| You may only send **from verified addresses** | This is true in production too. It is not a sandbox-only rule. |
| 200/day, 1/second | Irrelevant at our volume, but worth knowing. |

"Verified" means someone proved they control the address by clicking a link AWS emailed
them. **A human has to do this.** It cannot be scripted.

### What this means in practice

There is no Aeygis mailbox available yet — no access to `aeygis.com` DNS and no company
inbox set up. So for testing, one personal address does both jobs:

- **Sender:** `rajaemadhussain@gmail.com`
- **Recipient:** `rajaemadhussain@gmail.com`

That is enough to exercise the entire feature end to end. Once there is a real mailbox
and DNS access, both become configuration changes — see section 8.

---

## 4. Who sends and who receives — now versus later

This is the part people usually get confused about, so it is spelled out.

**Neither address is written into the code.** Both are settings.

| | Now (sandbox, testing) | Later (production) |
|---|---|---|
| **Sender** | `rajaemadhussain@gmail.com` | A real Aeygis address. `aws@aeygis.com` is the natural pick — it is what the Overview deck and every legal page already publish. |
| **Recipient** | `rajaemadhussain@gmail.com` | **The clinic's own email**, taken from the contact details they filled in on the assessment form. |
| **BCC (internal copy)** | `rajaemadhussain@gmail.com` | A staff mailbox. |
| **Allowlist** | `rajaemadhussain@gmail.com` | Set to `*` — which switches the guard off and lets real client addresses through. |

The important point:

> **The code always reads the recipient from the clinic's contact details.**
> The allowlist sits in front of that as a gate. It does not replace it.

So going live is a settings change, not a rewrite. And until then, a real client
address is **refused**, not quietly emailed.

### The allowlist fails closed

Note the production value is `*`, **not blank**. This was corrected while writing the
code, and the reason matters:

If a blank setting meant "no restriction", then an *unset* environment variable would
silently mean "email anyone". Unset happens by accident all the time — a typo in a
deploy, a new environment nobody finished wiring, a variable dropped during a refactor.
An absent setting must never be the permissive one.

So the three states are:

| `SES_ALLOWED_RECIPIENTS` | Meaning |
|---|---|
| unset, blank, or unparseable | **Block everything.** The safe direction. |
| `*` | Allow everything. Explicit, deliberate, greppable. |
| `a@x.com, b@y.com` | Allow exactly those. |

Turning the guard off is therefore a visible act, not the absence of one.

Two practical consequences:

- To run a real end-to-end test, use a test lead whose contact email **is** the verified
  Gmail. The existing `scripts/seed-demo-data.mjs` can create one.
- In the sandbox, SES requires **every** recipient to be verified — To, CC and BCC
  alike. So the BCC address has to be the same Gmail for now. That means each successful
  test send arrives twice in the same inbox: once as the client copy, once as the BCC.
  That is deliberate — it proves the BCC path works before it matters.

---

## 5. The decisions, and why

Six decisions were made before designing this. Each one had a real alternative.

### 5.1 Attach the PDF, do not send a link

**Decided: attach it.**

The earlier plan in `email-setup.md` said to email a link to the PDF in S3 rather than
the file itself. Two facts checked while planning this phase overturned that:

- **SESv2 allows a 40 MB message.** The 10 MB figure quoted in the old plan is the
  limit for the **v1** API, which we are not using. Our proposal PDF is about **300 KB**.
- **A download link signed inside a Lambda expires when the Lambda's credentials
  expire.** AWS states this plainly: *"IAM role credentials — the presigned URL expires
  when the role session expires, even if you specify a longer expiration time."* In
  practice that can be an hour. A client who opens the email the next morning would get
  an error page.

Making the link work properly would need extra machinery — a CloudFront signed URL, or
a small redirect endpoint. That is real work to produce a worse experience than simply
attaching a 300 KB file.

**What we give up:** with a link, every download is a logged S3 request, so you can tell
whether the client opened it. Attaching loses that signal. Accepted — the link would
have expired before most clients clicked it anyway.

### 5.2 Only an approver may send

**Decided: approver only.**

This matches how the rest of the system already works. A contributor does the drafting —
fills in the discovery answers, sets the price, generates versions. An approver takes
the outward-facing action.

Sending a proposal to a client cannot be undone, so it sits with the same person who
approved it. In code, the mutation carries `allow.group('approver')`, which means AppSync
rejects a contributor before the Lambda even runs.

### 5.3 Sending is a separate, manual step

**Decided: an explicit button, not automatic on approval.**

Approving and sending stay two different acts. You might approve a proposal on Tuesday
and send it on Friday after a phone call. More importantly, if approval automatically
fired an email, a mis-click would put a document in front of a client with no gap to
catch it.

The existing code already assumes this — `decide-proposal` tells the approver:
*"Approved. Delivery is a separate, explicit step."*

### 5.4 BCC a copy to Aeygis

**Decided: yes.**

Every proposal that goes to a client also lands in a staff inbox. The console's delivery
log is the system of record, but a human-readable copy outside the system is worth
having — it is how anyone answers "what exactly did we send them?" without logging in.

### 5.5 In the sandbox, block unverified addresses — do not redirect

**Decided: block, and say why.**

Two options existed. **Redirect** would still send the email but reroute it to the test
address with a banner saying who it was really for — convenient, because you could test
on any lead. **Block** refuses outright and records why.

Block was chosen because it fails safe. With redirect, the only thing standing between a
real prospect and an unexpected email is the redirect logic being correct. With block,
nothing is sent at all unless the address is explicitly on the list.

This matches how the rest of the project is built: make the bad outcome structurally
impossible rather than merely unlikely.

### 5.6 One email body, no template system

**Decided: keep it simple.**

The message text lives in the code, the same way the PDF template does. No template
editor, no per-client wording. If that is needed later it can be added; building it now
would be inventing a requirement.

---

## 6. How it works, step by step

### The overall shape

```
Approver opens an assessment  →  Approvals tab
        │
        │  version v0003 shows "approved"
        ▼
  [ Send to client ]                          ← new button, approver only
        │
        ▼
  sendProposalEmail(proposalId, versionKey)   ← new GraphQL mutation
        │
        ▼
  send-proposal-email Lambda                  ← new function
        │
        ├─  1. Who is asking?              re-read their groups from the request
        ├─  2. Does the version exist?
        ├─  3. Is it actually approved?    read the approval history
        ├─  4. Do the bytes still match?   re-hash the stored document
        ├─  5. Who is the recipient?       the clinic's contact email
        ├─  6. Is that address allowed?    allowlist check — To and BCC
        ├─  7. Is sending switched on?     the SES_ENABLED flag
        ├─  8. Fetch the PDF from S3
        ├─  9. Send it through SES         attachment + BCC
        ├─ 10. Write a delivery record     sent | blocked | failed
        └─ 11. Write an audit record
        │
        ▼
  Console shows the delivery row and its status
```

### Why each check exists

Every one of these prevents a specific thing going wrong. They are not ceremony.

**1. Who is asking.** The caller's group membership is read from the request itself, not
trusted from what the browser claims. AppSync has already enforced `approver` before the
Lambda runs, so this is a second line of defence — but more importantly, it is what gets
written into the audit record. The rule and the evidence cannot disagree if they come
from the same place.

**2. Does the version exist.** A send must point at something real.

**3. Is it actually approved.** The console will only show the button on approved
versions. That is a convenience, not a control — a UI that hides a button is not a
security boundary. The Lambda reads the approval history itself and refuses anything
whose latest decision is not `approved`. This is exactly how `delete-proposal-version`
already protects approved versions from deletion.

**4. Do the bytes still match.** This is the most important check.

When a proposal is approved, the approval binds to a **fingerprint** (a SHA-256 hash) of
the exact document. Before mailing anything to a client, the Lambda re-reads the stored
document, re-computes its fingerprint, and compares. If they differ, it refuses.

Without this, a file that had been swapped or corrupted could be mailed out under the
cover of an old approval — and the approver would appear to have signed off on something
they never saw. `decide-proposal` already performs this same check at approval time
(`amplify/functions/decide-proposal/handler.ts`, lines 151–184); doing it again at send
time closes the gap between the two moments.

**5. Who is the recipient.** Read from `Assessment.email` — the address the clinic
themselves entered on the intake form.

**6. Is that address allowed.** The sandbox guard. `SES_ALLOWED_RECIPIENTS` is a list of
addresses that may be written to. If the recipient is not on it, the send is **refused
and recorded as `blocked`** — not attempted and failed.

That distinction matters when someone reads the console later:

- `blocked` — the system stopped this on purpose. Nothing left the building.
- `failed` — we tried to send and something went wrong.

Reading "failed" when the real answer was "we deliberately refused" sends people
debugging a problem that does not exist.

**7. Is sending switched on.** `SES_ENABLED` is a plain off switch, separate from the
allowlist. Useful for turning the whole feature off without touching addresses.

**8–9. Fetch and send.** The PDF is read from `proposals/client/{proposalId}/{versionKey}.pdf`
and attached. Note the PDF is encrypted in S3 with the project's own KMS key, so the
function needs permission for both S3 **and** the key — see section 7.

**10–11. Write it down.** Whatever happened — sent, blocked or failed — a record is
written. An email that silently fails is worse than one that never sends, because
nobody finds out.

---

## 7. What gets built

### New pieces

| Piece | What it is |
|---|---|
| **`ProposalDelivery` model** | A database record, one row per send attempt. |
| **`sendProposalEmail` mutation** | The API the console calls. Approver-only. |
| **`send-proposal-email` Lambda** | The function that does the work. |
| **`DeliveryPanel` in the console** | The Send button and the delivery history table. |
| **SES configuration set + SNS topic** | Bounce and complaint handling. |

### The delivery record

`ProposalDelivery` is **append-only**, built the same way `Approval` already is:

- `update` and `delete` are removed from the API schema entirely — not blocked by a
  permission rule, but absent, so nothing can call them.
- `create` stays, because the Lambda has to write the row.
- Staff can read, and nothing more.

A second send is a **second row**, never an edit of the first. So "we sent it twice"
stays visible instead of being tidied away.

What each row holds:

| Field | Why |
|---|---|
| `proposalId`, `versionKey`, `assessmentId` | What was sent |
| `status` | `sent` \| `blocked` \| `failed` |
| `recipient`, `bcc` | Who it went to — or would have |
| `subject` | What they saw in their inbox |
| `messageId` | SES's own id, so a message can be traced in AWS |
| `failureReason` | Why, in plain words, when it did not go |
| `contentSha256` | The fingerprint of what was actually mailed |
| `sentBy`, `sentByEmail`, `sentAt` | Who pressed the button, and when |

### Bounces and complaints — set up *before* the first send

A **configuration set** is an SES setting that says "tell me what happens to messages
sent under this name". It is attached to an SNS topic, so bounces and complaints arrive
as notifications instead of vanishing.

This is built before the first email is sent, for two reasons:

1. When you eventually ask AWS for production access, they ask how you handle bounces
   and complaints. Having it already working strengthens the request.
2. In the sandbox, a bounce against your own test address puts that address on the
   **account-level suppression list** — after which sends fail for reasons that look
   nothing like the actual cause. That is a whole morning lost to a confusing symptom.

### Confidentiality

The `Aeygis_Cloud_Rate_Card.pdf` is marked confidential. Delivery cost per hour, margin
reasoning, competitor pricing and the discount floor must never reach a client.

The project already enforces this with a dependency rule that stops the PDF renderer
importing the internal pricing package, even indirectly. **The same rule is added for
this function**, because it also produces something a client reads. A test also checks
the email body itself for cost and margin wording.

### Files

**New:**

```
docs/phase-5-email-delivery.md                            ← this document
amplify/functions/send-proposal-email/resource.ts         function definition + settings
amplify/functions/send-proposal-email/handler.ts          the 11 steps
amplify/functions/send-proposal-email/emailBody.ts        builds subject and body (pure)
amplify/functions/send-proposal-email/emailBody.test.ts
amplify/functions/send-proposal-email/recipientPolicy.ts  allowlist logic (pure)
amplify/functions/send-proposal-email/recipientPolicy.test.ts
apps/console/src/DeliveryPanel.tsx                        Send button + history
packages/domain/src/delivery.ts                           status names and labels
scripts/verify-email-delivery.mjs                         end-to-end check
```

`emailBody` and `recipientPolicy` are deliberately separate, self-contained files with
no AWS imports. Handlers connect to AWS the moment they load, so anything inside one
cannot be tested without credentials — and a safety check that cannot be tested is a
safety check that does not get tested. The same reasoning already produced
`amplify/functions/shared/identity.ts`.

**Changed:**

```
amplify/data/resource.ts          the model, the mutation, the result type
amplify/storage/resource.ts       read access to proposals/client/*
amplify/backend.ts                IAM, KMS, configuration set, SNS topic
apps/console/src/client.ts        sendProposalEmail() and listDeliveries()
apps/console/src/ApprovalPanel.tsx  render the delivery panel
apps/console/src/brand.css        delivery row styles
package.json                      add @aws-sdk/client-sesv2
docs/email-setup.md               correct the two out-of-date facts
docs/aws-resources.md             record the new AWS resources
docs/PROJECT-STATUS.md            phase tracker
```

### Reused rather than rebuilt

- `amplify/functions/shared/identity.ts` — reading the caller and checking they are an
  approver. Already written, already tested.
- The audit-writing helper shape from `decide-proposal/handler.ts`.
- `ApprovalPanel.tsx`'s click-twice-to-confirm button, because sending is irreversible
  in the same way rejecting is.
- The PDF's S3 path convention from `apps/console/src/client.ts`.

---

## 8. Going live later

None of this is part of Phase 5. It is recorded here so the path is clear. Full detail
is in [`email-setup.md`](email-setup.md).

1. Get access to `aeygis.com` DNS.
2. Verify the **domain** with SES and add the DNS records it returns, including the
   three DKIM entries.
3. Publish SPF and DMARC records. Not strictly required, but proposals sent from an
   unauthenticated domain land in spam — which is indistinguishable from not sending
   them.
4. Change `SES_FROM_ADDRESS` to the real Aeygis address.
5. Ask AWS for production access. Response usually within 24 hours.
6. Set `SES_ALLOWED_RECIPIENTS` to `*`. Real client addresses now work.
   **Do not blank it** — blank means "block everything", by design. See
   [The allowlist fails closed](#the-allowlist-fails-closed).

Steps 4 and 6 are settings changes. No code changes.

---

## 9. How it will be checked

**Locally, without touching AWS:**

- Unit tests for the email body and the allowlist logic — including that an address not
  on the list is blocked, and that an empty list blocks everything.
- A leak test on the email body: no pricing, cost or margin wording.
- Type checking.
- The dependency rule, proving this function cannot reach internal pricing data.
- The browser UI checks, extended: the Send button is hidden from a contributor, hidden
  on a version that is not approved, and the delivery rows render correctly in both
  light and dark mode.

**Against real AWS, only with permission:**

`scripts/verify-email-delivery.mjs` walks the whole path and asserts:

| Check | Expected |
|---|---|
| Send an approved version | a `sent` row with a real SES message id |
| An audit record is written | trail runs approval → delivery |
| Send to an address not on the allowlist | recorded `blocked`, nothing leaves |
| Send a version that is not approved | refused |
| A contributor calls the mutation | rejected by AppSync before the Lambda runs |

Plus two things only a human can confirm: the email arrives with the PDF attached and
the attachment opens, and the BCC copy arrives.

---

## 10. AWS actions that need permission ⛔

Per the project's standing rule, nothing below happens without a specific go-ahead, and
approval for one is not approval for the next.

| | Action | Notes |
|---|---|---|
| 1 | Verify `rajaemadhussain@gmail.com` as an SES identity in `ca-central-1` | AWS emails a confirmation link. **A human must click it.** Worth starting early — nothing can be tested until it is done. |
| 2 | Deploy the backend (`npm run sandbox`) | Creates the Lambda, the configuration set, the SNS topic and the IAM grants. |
| 3 | Subscribe an address to the SNS bounce/complaint topic and confirm it | done 2026-08-23 - `rajaemadhussain@gmail.com` |
| 4 | Send the first real test email | To the verified Gmail. |
| 5 | Request production access | Separate, later. Not part of this phase. |

---

## 11. Two things that went wrong, and what they cost

Both were found by sending real mail, not by reading code. Recorded because the
next person will otherwise hit them again.

### The attachment arrived blank

The first real send produced a PDF that **downloaded at the right size, opened as
a valid 15-page document, and showed nothing on any page.**

What made it hard to place: everything checkable on our side was provably fine.

- the object in S3 rendered correctly when rasterised
- the SDK's base64 round-tripped **byte-identical** to the source file
- the `%PDF-` header was intact, the size exact

The cause was the one thing we had not specified: **`ContentTransferEncoding`**.
The AWS API reference lists `BASE64`, `QUOTED_PRINTABLE` and `SEVEN_BIT` as valid
values and **documents no default**. We left it unset and inherited whatever SES
chose.

Why the symptom looked the way it did: a PDF's object structure is largely ASCII
and survives a wrong transfer encoding, so the reader parses the file and finds
its pages. The page *content* lives in compressed binary streams, and those do
not survive. The reader then draws fifteen empty pages.

**Fix:** one line — `ContentTransferEncoding: 'BASE64'` on the attachment.

**The lesson is not "set that field".** It is that an undocumented default on a
binary payload is a silent-corruption risk, and "the SDK handles encoding for
you" (which the docs do say, and which was true) covers the wire format only —
not how the service then frames the bytes into MIME.

### The verification script died on an invented constant

The first run of `verify:email` failed three steps in with
`Unknown support plan "standard"`. There is no such plan; the catalog has
`trainAndWalkAway`, `essentials`, `fullManaged`. The string was guessed rather
than read.

Cheap in itself, but the failure message read like a backend fault rather than a
bad test fixture. The script now imports `SUPPORT_PLANS` and `TIERS` from
`@aeygis/pricing` and checks its constants up front, so a wrong or renamed value
fails immediately and says exactly that.

---

## 12. What this phase does *not* include

- No email templates or per-client wording.
- No scheduled or bulk sending. One approved version, one recipient, one click.
- No open or click tracking. It would need extra SES configuration and raises its own
  privacy question, which is not worth it for a handful of proposals a month.
- No production access request.
- No automatic reminder or follow-up emails.
