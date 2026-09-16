# 10. Email delivery

← [The console](09-console.md) · [Index](README.md) · Next: [Security](11-security.md)

Phase 5. Shipped 2026-08-23/24 and verified end to end against real AWS.

> **Design record:** [`docs/phase-5-email-delivery.md`](../phase-5-email-delivery.md)
> **SES account setup and the production cutover:** [`docs/email-setup.md`](../email-setup.md)
>
> This chapter covers how it works and what it does — and does not — prove.

---

## 10.1 Why this was more than "call SES and hope"

Two things shaped every decision.

**1. The account is in the SES sandbox.** Checked live on 2026-08-23: SES in `ca-central-1`
had zero verified identities, `ProductionAccessEnabled: false`, 200 emails per 24 hours, 1
per second. In the sandbox SES only delivers to addresses that have been **verified by a
human clicking a link**. So a real prospect cannot be emailed yet — and the code must make
that **impossible rather than merely unlikely.**

**2. Sending is irreversible.** Everything else in this system can be redone: a price
re-quoted, a version discarded, a rejection reversed with a new record. An email cannot be
unsent. So the send path got the same care the approval path got.

---

## 10.2 Facts checked before designing, not recalled

| Fact | Source | Why it mattered |
|---|---|---|
| SESv2 max message size is **40 MB** (after base64). The 10 MB figure is the **v1** API. | AWS SES service quotas | `email-setup.md` said 10 MB and rejected attachments on that basis. That reasoning was out of date. |
| SESv2's `Message` type has a native **`Attachments`** field | the installed `@aws-sdk/client-sesv2` types | Attaching a PDF needs no hand-built MIME. |
| `Attachment.ContentTransferEncoding` has **no documented default** | AWS API reference | See §10.7. This one cost a real incident. |
| A presigned S3 URL **expires when the credentials that signed it expire** | AWS S3 documentation | A link signed inside a Lambda dies with the role session, regardless of the expiry requested. |
| The generated proposal PDF is **~300 KB** | measured on disk | Comfortably inside 40 MB. Attaching is not a squeeze. |
| Max 50 recipients per message | AWS SES quotas | Not a constraint here; noted so nobody widens BCC later without knowing. |
| Sender identity verification is required in **sandbox AND production** | AWS SES docs | It is *not* a sandbox-only rule. The sandbox-specific rule is **recipient** verification. The project brief had this the other way round. |
| Sandbox status is **per region** | AWS SES docs | Escaping it in `us-east-1` does nothing for `ca-central-1`. |

---

## 10.3 The decisions

| Decision | Choice | Consequence |
|---|---|---|
| How the client gets the PDF | **Attached** | No expiring links. Loses the "who downloaded it" signal — accepted. |
| Who may send | **Approver only** | Same bar as approving, for a different reason: this is the irreversible one. |
| When it sends | **Manual — an explicit Send button** | Approving never triggers an email. Matches what `decide-proposal` already tells the approver: *"Delivery is a separate, explicit step."* |
| Internal copy | **BCC a staff address on every send** | A human-readable record exists outside the console. |
| An unverified client address | **Blocked and explained** | Nothing can reach a real prospect by accident. Recorded as `blocked` with the reason shown in the console. |
| BCC while in sandbox | **The same verified address** | Two copies arrive per successful test send. Noisy on purpose — it proves the BCC path works before production. |

### The link-vs-attachment reversal

The original plan said to email a **presigned S3 link** rather than an attachment, on the
grounds that attaching needed raw MIME and hit a 10 MB cap. Both halves were checked while
building and **neither holds** — see the table in §10.2.

And the link plan had a defect neither reason covered: **a presigned URL created inside a
Lambda expires when the Lambda's role session expires**, regardless of the expiry requested.
A client opening the email the next morning would have got an error page.

**What is genuinely lost by attaching:** every download would have been an auditable
`GetObject`, so *"did they open it"* would have been a fact rather than a guess. Accepted —
the link would have expired before most clients clicked it.

---

## 10.4 Who sends, who receives — now versus later

**Neither address is hardcoded. Both are configuration.**

| | Now (sandbox) | Later (production) |
|---|---|---|
| **Sender** (`SES_FROM_ADDRESS`) | `rajaemadhussain@gmail.com` — the only verified identity | A real Aeygis address once the domain is verified. `aws@aeygis.com` is the natural choice — it is what the Overview deck and every legal page already publish. |
| **Recipient** | Also that Gmail, because SES will not deliver anywhere else | **`Assessment.email`** — the contact address the clinic gave on the intake form |
| **BCC** (`SES_BCC_ADDRESS`) | The same Gmail | A staff mailbox |
| **Allowlist** (`SES_ALLOWED_RECIPIENTS`) | That one address | **`*`** once production access is granted |

**The important point: the code always reads the recipient from the clinic's own contact
details.** The allowlist sits in front of that as a gate, not as a replacement. Going live
is a configuration change, not a rewrite — and until then, a real client address is
**refused** rather than silently mailed.

Two consequences worth knowing:

- To do a real end-to-end test, use a test lead whose **contact email is the verified
  address**. `npm run seed:demo` can create one.
- In the sandbox SES requires **every** recipient to be verified — To, CC and BCC alike. So
  the BCC address must be the same verified address for now.

---

## 10.5 The allowlist fails closed

[`amplify/functions/send-proposal-email/recipientPolicy.ts`](../../amplify/functions/send-proposal-email/recipientPolicy.ts)

```
unset / blank / unparseable  →  block everything      (the safe direction)
'*'                          →  allow everything      (explicit, deliberate)
'a@x.com, b@y.com'           →  allow exactly those
```

**This corrected the approved plan.** The plan said the allowlist would be *"emptied"* to go
live. Writing the file showed that to be wrong, and quietly dangerous:

> If empty meant "no restriction", then an unset environment variable — a typo in a deploy,
> a new environment nobody finished wiring, a variable dropped during a refactor — would
> silently mean **"email anyone"**.

**An absent setting must never be the permissive one.**

Going live is therefore setting `SES_ALLOWED_RECIPIENTS` to `*`, which is a visible,
greppable, obviously intentional act — not the absence of one.

> ⛔ **Do not blank it to "turn the guard off". Blank means block. Set `*`.**

Other behaviour, all unit-tested (20 tests):

- Separators may be commas, semicolons or whitespace — a value typed by a human into a
  deploy config will eventually use all three.
- A value that was set but parsed to nothing (`,,,`) falls back to **block**, not allow.
- Matching is case-insensitive, but **the original spelling is what gets sent**. A clinic
  that typed `Reception@Clinic.ca` should see their own capitalisation in the To field.
- `looksLikeAnAddress` is a conservative sanity check, **not** an RFC 5322 validator.
  Anything unparseable is treated as **blocked**, never passed through.
- **All recipients are checked, To and BCC.** In the sandbox a single unverified address
  anywhere causes AWS to reject the whole message, so checking only the client would produce
  a failure whose cause is invisible in the console.
- **The verdict is all-or-nothing.** There is no partial send: emailing the internal BCC copy
  of a proposal the client never received would put a misleading record in a staff inbox.

### `SES_ENABLED` is a separate switch

*"Stop all sending right now"* and *"change who may be emailed"* are different decisions, and
conflating them means the emergency action is also the one that quietly rewrites policy.

Anything other than the exact string `'true'` is off. Checked **before** the allowlist, so
the message says the useful thing: an operator who has turned sending off wants to be told
that, not told about a recipient list.

---

## 10.6 What the client receives

### Subject

```
Your Aeygis cloud migration proposal — Riverside Family Practice
Your updated Aeygis cloud migration proposal — Riverside Family Practice
```

"Updated" comes from the **delivery history**, not the version number. Staff iterate through
versions internally and send only some of them, so `versionNumber > 1` does not mean the
client ever saw an earlier one.

### Body

Plain text **and** HTML, not one or the other. Some clients — and most security gateways
that rewrite mail — show the text part, and a proposal that arrives as a blank message with
an attachment reads as spam.

```
Hello Dr Chen,

Thank you for completing the Aeygis cloud readiness assessment.
Your cloud migration proposal is attached.

It sets out where your practice stands today, the migration approach we
recommend, an indicative schedule, the service levels you would be covered
by, and what Aeygis and your clinic are each responsible for.

The pricing in the proposal is held until September 23, 2026.

If anything needs clarifying, or you would like to walk through it together,
reply to this email and we will arrange a time.

Aeygis

Reference: AEY-7F3K2Q-v0003
```

**No figures anywhere.** No prices, no totals, no discounts, no internal language. Partly
because the numbers belong in the document where they have their context and caveats — a
bare figure in an email is quotable out of context. Mostly because the Rate Card is
confidential and **the least error-prone rule is "this file never states money at all"**. A
test enforces it, scanning the *visible text* rather than the raw markup.

**The greeting is "Hello there," or the full name, never a guessed first name.** Splitting a
full name to find one gets it wrong for compound surnames and for anyone who entered a
title, and getting somebody's name wrong in the first line of a sales email is worse than
being slightly formal.

### Attachment

```
Aeygis-Cloud-Proposal-Riverside-Family-Practice-v0003.pdf
```

The clinic name and version are both in the filename so a client who saves two revisions
ends up with two files rather than one overwriting the other.

The slug normalises accents (*Clinique Santé* → *Clinique-Sante*, not *Clinique-Sant-*),
reduces everything else to hyphens, and caps at 60 characters.

---

## 10.7 The blank-PDF incident

**The first real proposal email arrived with a blank PDF.** Fifteen pages, all empty.

Everything checkable was provably fine:

- The S3 object rendered correctly when opened directly.
- The SDK's base64 encoding round-tripped **byte-identical**.
- The PDF header was intact and the file was the right size.

The cause was the one field left unspecified: **`ContentTransferEncoding`**.

The AWS API reference lists `BASE64`, `QUOTED_PRINTABLE` and `SEVEN_BIT` as valid values and
**documents no default** — checked; it simply is not stated. A PDF is binary: `SEVEN_BIT`
strips the high bit, `QUOTED_PRINTABLE` rewrites bytes it considers unprintable.

A PDF's object structure is largely ASCII and **survives** a wrong encoding, which is why
the reader found 15 pages. The compressed content streams did not survive, which is why it
drew 15 empty ones.

**The fix was one line.** `ContentTransferEncoding: 'BASE64'`.

> **The lesson is not "set that field". It is that an undocumented default on a binary
> payload is a silent-corruption risk.**

---

## 10.8 ⚠ Deliverability — the sandbox proves the pipeline, NOT that mail arrives

**Observed 2026-08-23: the first real proposal email landed in the Gmail spam folder.**

**That is correct behaviour, not a fault**, and it is worth understanding before anyone reads
"email delivery verified" and assumes proposals will reach clinics.

Every receiving provider runs three checks. Sending from a `@gmail.com` address via SES fails
**all three** — measured, not assumed:

| Check | What it asks | Reality here |
|---|---|---|
| **SPF** | Is this server allowed to send for this domain? | `gmail.com` publishes `v=spf1 redirect=_spf.google.com`. Only Google's servers qualify; AWS is not among them. **Fails.** |
| **DKIM** | Is the message cryptographically signed? | Our identity reports `DkimSigning: False`, `DkimStatus: NOT_STARTED`. **Unsigned.** |
| **DMARC** | Do SPF or DKIM align with the From address? | `gmail.com` publishes `p=none; sp=quarantine`. Nothing aligns. **Fails.** |

So Gmail sees a message claiming to come from one of its own users, arriving from Amazon's
servers, carrying no signature. **That is the exact shape of a phishing attempt.** Filing it
as spam is Gmail working correctly.

### Why DKIM cannot simply be switched on

**SES supports DKIM signing for *domain* identities only.** We verified an **email address**
identity, because there is no access to `aeygis.com` DNS. An address identity cannot be
signed. This is a consequence of what was verifiable, not a setting anyone forgot.

### What this does and does not tell us

- ✅ **The pipeline works.** Approval → PDF → SES → delivery record → audit trail, proven end
  to end with a real message.
- ❌ **Nothing about real-world deliverability.** That cannot be judged until the domain
  cutover.

**No code change improves this.** It resolves at the SES domain cutover and only there.

> **Do not quote the sandbox test as evidence that proposals reach clinics.**

For continued testing in the meantime, mark the messages "Not spam" in Gmail — that trains
your own filter and nothing more.

---

## 10.9 Bounces and complaints

Built **before** the first send, not after. Two reasons:

1. The SES production-access request asks whether you handle bounces and complaints. Having
   it already working strengthens the request.
2. **In the sandbox, a bounce against your own test address lands that address on the
   account-level suppression list**, after which sends fail for reasons that look nothing like
   the cause. That is a classic lost morning.

```
send-proposal-email
   │  ConfigurationSetName: 'aeygis-proposal-delivery'
   ▼
SES configuration set  ──▶  event destination  ──▶  SNS topic ProposalEmailEvents
                            BOUNCE
                            COMPLAINT
                            REJECT
                            DELIVERY_DELAY
```

**Only the events that mean something went wrong.** The CDK default is *all* event types,
which would publish a notification for every successful send and open — noise that trains
people to ignore the topic, which is worse than not having one.

**`DELIVERY_DELAY` is included** because a delayed message is a problem that has not finished
happening yet: it is the signal that arrives *before* a bounce.

**The topic has a confirmed subscriber:** `rajaemadhussain@gmail.com`, added by hand on
2026-08-23 and re-verified as still confirmed on 2026-08-26. It cannot be code —
subscribing sends a confirmation email a human must click, so CDK could create the
resource and never finish it.

Both configuration sets publish here, so that one subscriber hears bounces from proposal
delivery **and** from internal notifications.

**It moves at the domain cutover**, along with the sender address.

---

## 10.10 Verification

`npm run verify:email` walks the full path against real AWS.

**⛔ It writes to AWS and sends a real email. Do not run it without permission.**

**The order is deliberate: every refusal is proved BEFORE anything is sent**, so a broken
guard is found while nothing has left the building.

| # | Scenario | Required result |
|---|---|---|
| 1 | Recipient not on the allowlist | **blocked** — refused, not attempted |
| 2 | Version not approved | **refused** |
| 3 | A contributor attempts to send | **denied by AppSync**, before the Lambda runs |
| 4 | Approved version, allowed recipient | **sent**, with a real SES message id and the PDF attached |

Plus: the delivery row carries the fingerprint of the document actually mailed, the refused
attempt is recorded too, and an `AuditEvent` completes the trail from approval to delivery.

### `npm run resend -- <proposalId> <versionKey>`

**⛔ Sends a real email.**

Re-sends one already-approved version, so a delivery problem can be re-tested without
running the whole `verify:email` walk (which creates two more leads and two more proposals
every time). Re-sending is a **supported operation** — every attempt is its own
`ProposalDelivery` row, so the history stays honest about how many went out.

With no arguments it picks the newest approved version.

### What `check:ui` deliberately does not do

The console UI check exercises the delivery block — it asserts the gap, the divider, how many
send controls are present, and that **none is armed**.

**It never clicks Send.** A layout check must not be able to perform the one irreversible
action in the system.

---

## 10.11 Going to production

Full procedure in [`docs/email-setup.md`](../email-setup.md) → Step 4. Summarised:

**Nothing below is possible without control of `aeygis.com` DNS.**

| # | Step | Blocked by |
|---|---|---|
| 1 | Verify the **domain** identity (not just an address) and add the three DKIM CNAMEs AWS returns | DNS access |
| 2 | Publish SPF and DMARC records | DNS access |
| 3 | Switch `SES_FROM_ADDRESS` to a real Aeygis address and **redeploy** (the IAM policy is scoped to the identity ARN) | step 1 |
| 4 | Request production access — describe the use case honestly as **transactional**, and mention the bounce/complaint process. Initial response within 24 hours. ⚠ Once submitted, account details **cannot be edited** until review completes. | step 1 |
| 5 | Raise the sending quota if needed | production access |
| 6 | Set `SES_ALLOWED_RECIPIENTS` to `*` — **and only after production access is confirmed** | production access |

**Consider keeping a real allowlist in non-production environments** so a test run can never
email a real prospect.

**Until step 1 is done, proposals sent to real clinics will be unsigned, unaligned, and land
in spam.** This is not optional polish.
