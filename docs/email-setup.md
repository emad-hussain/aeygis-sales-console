# Email setup (SES)

> **Status: BUILT AND DEPLOYED** (2026-08-23). `rajaemadhussain@gmail.com` is a
> verified SES identity in `ca-central-1` and the send function is live in the
> sandbox.
>
> **Still in the SES sandbox**, so delivery is limited to that one verified
> address — a real clinic address is refused, by design, not by accident.
>
> **Steps 1–3 are done**: identity verified, bounce topic with a confirmed
> subscriber, and the send function deployed. A **new-lead notification** was added
> 2026-08-26 and proven to send.
>
> ⛔ **Production access was REQUESTED 2026-08-28 and DENIED** (case
> `178930966200969`). See [the denial section](#-the-request-was-denied--2026-09-13).
>
> **The blocker is not "no DNS access".** `aeygis.com` is live on Hostinger
> nameservers with managed records, Google Workspace mail, and — the part that
> matters — a **`p=quarantine` DMARC policy already published**. Adding SES to that
> domain is a handful of DNS records; doing it in the wrong order actively sends
> proposals to spam. See [what the DNS revealed](#what-checking-the-dns-actually-revealed--2026-09-13).
>
> For how the feature works, see [`phase-5-email-delivery.md`](phase-5-email-delivery.md).
> This document covers the SES account setup and the cutover procedure.

---

## Verified facts (checked against AWS docs, not recalled)

Confirmed 2026-08-17 against the [SES endpoints and quotas][ep] and
[production access][prod] documentation:

- **SES is fully available in `ca-central-1`** — API (`email.ca-central-1.amazonaws.com`),
  SMTP, inbound, DKIM, tracking and feedback endpoints all present. No need to
  leave the region for email, which matters given the Canadian-residency posture.
- **Sandbox restrictions**, per region:
  - send only **to verified addresses** (or the SES mailbox simulator)
  - **200 messages / 24 hours**
  - **1 message / second**
- **Sender identity verification is required in sandbox AND production.** It is
  *not* a sandbox-only rule. The sandbox-specific rule is *recipient* verification.
  (The project brief described this the other way round.)
- **Sandbox status is per-Region.** Escaping it in `us-east-1` does nothing for
  `ca-central-1`.
- AWS gives an **initial response within 24 hours** of a production-access request.
- Verifying the **domain first** is a documented best practice that speeds approval.

[ep]: https://docs.aws.amazon.com/general/latest/gr/ses.html
[prod]: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html

---

## Current constraint

There is no access to the `aeygis.com` mailbox or DNS, so domain verification is
impossible right now. The agreed plan is to stay in the **sandbox** and use a
single verified Gmail address as both sender and recipient, which exercises the
entire flow — including the approval → send trigger — without needing domain
access.

**Do not send proposal email to a real prospect until production access is
granted.** In sandbox it would silently fail anyway: unverified recipients are
rejected.

---

## Step 1 — verify the test identity ⚠ NEEDS A HUMAN

```bash
aws sesv2 create-email-identity \
  --email-identity rajaemadhussain@gmail.com \
  --region ca-central-1
```

AWS emails a confirmation link to that inbox. **Someone must click it** — this
cannot be automated, which is why it is worth starting before the code is written.

Verify:

```bash
aws sesv2 get-email-identity --email-identity rajaemadhussain@gmail.com \
  --region ca-central-1 --query 'VerifiedForSendingStatus'
```

The same address serves as **both** sender and recipient while in sandbox.

---

## Step 2 — bounce and complaint handling, BEFORE the first send

Create an SNS topic and subscribe SES bounce/complaint notifications to it.

Two reasons this comes first:

1. A production-access request asks you to confirm you have a process for
   bounces and complaints. Having it already configured strengthens the request.
2. In sandbox, a bounce against your own test address lands you on the
   **account-level suppression list**, after which sends fail for reasons that
   look nothing like the cause. That is a classic lost morning.

---

## Step 3 — the send function ✅ BUILT AND DEPLOYED 2026-08-23

`amplify/functions/send-proposal-email/`, triggered **manually** by an approver —
not automatically on approval. Full design in
[`phase-5-email-delivery.md`](phase-5-email-delivery.md).

### ⚠ Two facts in the original plan turned out to be wrong

This section previously said to email a **presigned S3 link instead of an
attachment**, on the grounds that attaching needed raw MIME and hit a 10 MB cap.
Both halves were checked while building Phase 5 and neither holds:

| Claimed here originally | Actually true | Source |
|---|---|---|
| attaching needs raw MIME (`SendRawEmail`) | SESv2's `Message` type has a native `Attachments` field — no hand-built MIME | the installed `@aws-sdk/client-sesv2` types |
| **10 MB** message cap | **40 MB** for SESv2. 10 MB is the **v1** API, which this project does not use | AWS SES service quotas |

And the link plan had a defect neither reason covered: **a presigned URL created
inside a Lambda expires when the Lambda's role session expires**, regardless of the
expiry you request. AWS states this plainly. A client opening the email the next
morning would have got an error page.

A proposal PDF is around 300 KB. **The decision is now: attach it.**

What is genuinely lost by attaching: every download would have been an auditable
`GetObject`, so "did they open it" would have been a fact rather than a guess.
Accepted — the link would have expired before most clients clicked it.

### Design decisions in force

**Gate sending on config, not on hope.** `SES_ENABLED` plus `SES_ALLOWED_RECIPIENTS`,
both plain environment values in `resource.ts` — **not** secrets. A change to who may
be emailed should appear in a diff and be seen by a second pair of eyes; as a secret
it would be invisible.

The allowlist **fails closed**: unset or blank blocks everything, `*` allows
everything. Do not blank it to turn the guard off.

**Record every send as a row with status.** `ProposalDelivery`, append-only. Three
statuses, and the middle one matters: `blocked` means the system refused on purpose
and is the *expected* outcome for a real client address while in the sandbox.
Collapsing it into `failed` would send people debugging a fault that does not exist.

**Log the send as an `AuditEvent`**, so the trail runs approval → delivery.

### IAM (as deployed)

`ses:SendEmail`, scoped to the identity ARN **and** the configuration-set ARN — the
identity is the required resource type, and the set is needed because the function
always passes `ConfigurationSetName`. Not `identity/*`.

Plus `kms:Decrypt` (the PDF is KMS-encrypted) — decrypt only, since the function
reads and never writes.

The Phase 3 lesson still stands: a grant that looks right at deploy time can still
fail at runtime if the wrong principal was granted. Verify by sending, not by
reading the policy.

---

## ⚠ Deliverability: the sandbox proves the pipeline, NOT that mail arrives

**Observed 2026-08-23: the first real proposal email landed in the Gmail spam
folder.** That is the correct behaviour, not a fault, and it is worth
understanding before anyone reads "email delivery verified" and assumes
proposals will reach clinics.

Every receiving provider runs three checks. Sending **from a `@gmail.com`
address via SES fails all three** — measured, not assumed:

| Check | What it asks | Reality here |
|---|---|---|
| **SPF** | Is this server allowed to send for this domain? | `gmail.com` publishes `v=spf1 redirect=_spf.google.com`. Only Google's servers qualify; AWS is not among them. **Fails.** |
| **DKIM** | Is the message cryptographically signed? | Our identity reports `DkimSigning: False`, `DkimStatus: NOT_STARTED`. **Unsigned.** |
| **DMARC** | Do SPF/DKIM align with the From address? | `gmail.com` publishes `p=none; sp=quarantine`. Nothing aligns. **Fails.** |

So Gmail sees a message claiming to come from one of its own users, arriving
from Amazon's servers, carrying no signature. That is the exact shape of a
phishing attempt. Filing it as spam is Gmail working correctly.

### Why DKIM cannot simply be switched on

SES supports DKIM signing for **domain** identities only. We verified an **email
address** identity, because there is no access to `aeygis.com` DNS. An address
identity cannot be signed. This is a consequence of what was verifiable, not a
setting anyone forgot.

### What this does and does not tell us

- ✅ The pipeline works: approval → PDF → SES → delivery record → audit trail.
- ❌ Nothing about real-world deliverability. **That cannot be judged until the
  domain cutover below.** Do not quote the sandbox test as evidence that
  proposals reach clinics.

No code change improves this. It resolves at Step 4 and only at Step 4.

For continued testing in the meantime, mark the messages "Not spam" in Gmail —
that trains your own filter and nothing more.

---

## Watching reputation — added 2026-09-16

`AWS_PROFILE=aeygis npm run check:ses` now reports the two rates AWS actually
enforces on, not just whether it has already acted.

```
Reputation — ACCOUNT-WIDE, covers every sender in this account

  OK    bounce rate 0.00% (AWS reviews at 5%, pauses at 10%)
  OK    complaint rate 0.00% (AWS reviews at 0.1%, pauses at 0.5%)
```

### Why this was worth adding

`EnforcementStatus` was the only reputation signal here, and it is a **lagging**
one — it changes *after* AWS has placed the account under review. The bounce and
complaint rates are what AWS watches to decide whether to act, so they are the
only part of this script that can warn rather than report. Its wording changed
too: it used to read *"enforcement status HEALTHY"*, which invited being read as
a clean bill of health for Aeygis. It now says *"account not under review
(lagging signal — see the rates below)"*.

Thresholds are AWS's published ones
([enforcement FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)):

| Metric | Review at | Sending paused at |
|---|---|---|
| Bounce rate | 5% | 10% |
| Complaint rate | **0.1%** | 0.5% |

**The 0.1% complaint line is tighter than it looks.** At the volumes this system
sends, a handful of complaints crosses it. It is the one most likely to bite
first, and it is not intuitive.

### ⚠ These are ACCOUNT-wide, and that is the point

Account `326629581669` also hosts **`app-cadence.com`** (a separate production
app of the user's, with its own `app-cadence-production` configuration set) and an
Amazon Connect instance. SES tracks reputation **per account**.

So a different application sending badly can put Aeygis proposals under review or
pause them, and nothing in the Aeygis codebase could prevent or detect it. This
check is the only place that becomes visible — which is why it names the other
tenants rather than reporting a bare percentage.

[SES Tenants](https://docs.aws.amazon.com/ses/latest/dg/tenants.html) would
isolate reputation *tracking* per tenant. AWS is explicit that combined sending
still affects the account, so it narrows the blast radius rather than removing
it. Not worth doing at current volume; the right answer if `app-cadence.com` ever
sends at scale, and far cheaper than splitting AWS accounts.

### No data is not zero

A window with no sending returns no datapoints. Reporting that as `0.00%` would
be a check that passes precisely when it has learned nothing, so an empty result
is reported as **NOTE: no data**, never as a healthy zero. Verified against a
window from a year ago, which returns `0` datapoints.

---

## ✅ CUTOVER COMPLETE — 2026-09-16

Read from the deployed function, not from source:

```
From     aws@aeygis.com
Bcc      aws@aeygis.com
Allowed  *
Enabled  true
```

```
OK  production access GRANTED — 50000 / 24 h, 14 / s
OK  aeygis.com verified, DKIM SUCCESS, signing on
OK  sender is aws@aeygis.com — aligned with the verified domain
OK  recipient allowlist is open (*)
OK  bounce topic has 1 confirmed subscriber
OK  suppression list is empty
```

**This system can now email real clinics, and the mail arrives.**

### The result that justified the whole sequence

A real send landed in an **inbox**, not spam — confirmed by a person opening the
mailbox, which is the only way that question can be answered.

That is worth stating precisely, because it is stronger than "the email arrived".
`aeygis.com` publishes `DMARC p=quarantine; pct=100`. An unaligned message would
have been quarantined **on Aeygis's own instruction**. Arriving in an inbox is
therefore positive evidence that DKIM alignment works, not merely an absence of
bad news.

Every previous send in this project's history was guaranteed-spam by
construction: the sender was a `@gmail.com` address SES could not sign for. This
is the first message the system has ever produced that could pass.

### What the cutover changed, in order

| # | Step | Result |
|---|---|---|
| 1 | Sender → `aws@aeygis.com` | deployed in 108 s — an IAM change, so a real stack update |
| 2 | Test send, DMARC-aligned | **inbox, not spam** |
| 3 | Bounce topic → `aws@aeygis.com` | subscribed; ⏳ awaiting a human click |
| 4 | Allowlist → `*` | opened last, after 2 was answered |
| + | BCC → `aws@aeygis.com` | a copy of every proposal now lands in a company mailbox, not a personal one |

### Three defects the cutover exposed

**1. `ses:SendEmail` was scoped to the wrong kind of ARN.** `backend.ts` used
`identity/<sender address>`, which worked only because the old sender *was* a
verified address identity. `aws@aeygis.com` has no address identity — it is
covered by the `aeygis.com` **domain** identity. Both ARNs are now granted, for
both sending functions. The failure avoided is the nasty kind: clean deploy,
correct-looking policy, every send `AccessDenied` at runtime.

**2. A refusal message that had become false.** Blocked recipients were told
*"While the SES account is in the sandbox…"*. `recipientPolicy.ts` had predicted
its own obsolescence in a header comment — *"it would fail anyway is not a safety
property; it stops being true the moment production access is granted"* — and
that is exactly what happened. It now states what occurred without citing an
environment, and the test that **required** the word "sandbox" now **forbids** it.

**3. P14 had never actually been exercised.** The lead-status advance was
deployed 2026-08-27 and recorded as unproven. The cutover send proved both halves
of the rule at once: the sent lead logged
`lead advanced to proposed { from: 'needs_confirmation' }`, and the **blocked**
lead correctly stayed at `needs_confirmation`.

### ⚠ The guard that is gone

Until today there were **two** independent guards on who could be emailed: this
system's allowlist, and AWS's sandbox refusing unverified recipients. Both are now
open.

What remains is entirely in code, and is worth knowing by name:

- only an **approver** may send
- only an **approved** version may be sent
- the content hash is **re-verified immediately before sending**, so the document
  mailed is provably the one approved
- the recipient can only ever come from the clinic's **own submitted contact
  details** — there is no recipient field a human can type into

Narrowing `SES_ALLOWED_RECIPIENTS` back to a list is a legitimate thing to do in
any environment that is not production.

### Still open

- **The SNS confirmation link** in `aws@aeygis.com` has not been clicked. The
  Gmail subscription stays until it is, so bounces reach somebody either way.
  Remove the Gmail only after the new one confirms.

---

## Cutover progress — 2026-09-16

| # | Step | State |
|---|---|---|
| 1 | Sender → `aws@aeygis.com` | ✅ **deployed** (108 s; an IAM change, so a real stack update, not a hotswap) |
| 2 | Test send, DMARC-aligned for the first time | ✅ **sent** — inbox-vs-spam **awaiting the user**, see below |
| 3 | SNS bounce topic → `aws@aeygis.com` | ⏳ subscribed, **pending a human clicking the confirmation link** |
| 4 | Allowlist → `*` | ⛔ **held** — see why below |

### An IAM fix step 1 needed that nobody had noticed

`backend.ts` scoped `ses:SendEmail` to `identity/<sender address>`. That worked
while the sender **was** a verified address identity — the Gmail was. It is not
how `aws@aeygis.com` works: there is no address identity for it, only the
`aeygis.com` **domain** identity.

The AWS docs confirm both ARN forms are valid but do not say whether an address
ARN authorises a send when only the domain is verified. Rather than guess, both
ARNs are now granted, for both sending functions. Still two named identities, not
`identity/*`.

The failure avoided is the nasty kind: the deploy succeeds, the policy reads
correctly, and every send fails with `AccessDenied` at runtime.

### The test send

`npm run verify:email`. Every guard proved **before** anything left the building:

```
PASS  refused, and reported as `blocked` rather than `failed`
PASS  an unapproved version is refused (v0002)
PASS  AppSync rejects a contributor before the Lambda runs
PASS  sent to rajaemadhussain@gmail.com
PASS  carries a real SES message id (010d01a0a8e0becf-16b…)
PASS  an AuditEvent records the send — the trail runs approval → delivery
```

**SES accepting a message is not delivery.** Whether it reached an inbox or a
spam folder is the question this step exists to answer, and it can only be
answered by a person opening the mailbox.

### A stale message the test run exposed

The blocked-recipient refusal said:

> *"While the SES account is in the sandbox, Amazon only delivers to verified
> addresses, so this was refused rather than attempted."*

False as of today, and still being shown to staff. `recipientPolicy.ts` had
predicted its own obsolescence in a header comment — *"it would fail anyway is
not a safety property; it stops being true the moment production access is
granted"* — and that is precisely what happened.

Now reads: *"Nothing was sent. This was refused on purpose, not attempted and
failed — add the address to the approved list if it should be reachable."* No
environment claim, so nothing to go stale. The test that used to require the word
"sandbox" now **forbids** it.

### Why step 4 is held rather than done

Step 2 was run to answer a question. Opening the allowlist before that answer is
known would make the first DMARC-aligned send also the first one that can reach a
stranger — which is the exact sequencing the plan was written to avoid.

Two things gate it:

1. **Confirmation the test mail reached an inbox, not spam.** If it was
   foldered, sending real proposals is worse than not sending: it burns the first
   impression and the domain's reputation together.
2. **The SNS confirmation link being clicked**, so bounce and complaint alerts
   reach `aws@aeygis.com` before any message can reach a real clinic.

The `recipientPolicy.ts` wording fix is authored but **not deployed** — it is
batched with step 4 so the cutover costs one deploy rather than two.

---

## ✅ PRODUCTION ACCESS GRANTED — 2026-09-16

```
ProductionAccessEnabled : True
ReviewDetails           : {"Status": "GRANTED", "CaseId": "178930966200969"}
Max24HourSend           : 50000      (was 200)
MaxSendRate             : 14 / sec   (was 1)
EnforcementStatus       : HEALTHY
```

Granted on the third pass, after **two** denials. What changed between the last
denial and this: nothing in this repository. The case was appealed and approved.

**Worth recording honestly: the gaps identified on 2026-09-15 were never closed.**
`/assessment` still 404s on the live site, the published privacy policy still says
*"Submissions from this Site are delivered by email to our sales team"*, and
`app-cadence.com` is still an unexplained identity in this account. Those were
plausible reasons for the denials and they remain real problems — they are simply
no longer blocking SES. See [known-issues.md](known-issues.md) items 2 and 3.

The lesson is not "those did not matter". It is that AWS never said what mattered,
so nothing was learned about the cause either way, and the problems that were found
while looking are worth fixing on their own merits.

### What production access does and does not change

| | |
|---|---|
| ✅ May now email **any** address, not only verified ones | |
| ✅ Quota 200 → 50,000 / 24 h, 1 → 14 per second | |
| ❌ Nothing about deliverability yet | the sender is still `rajaemadhussain@gmail.com`, which fails DMARC |
| ❌ Nothing can reach a real prospect yet | `SES_ALLOWED_RECIPIENTS` still names one address, and it fails closed |

**The allowlist is now the only thing standing between this system and a real
clinic's inbox.** Until today AWS's sandbox was a second, independent guard. That
guard is gone, which makes the order of the remaining steps matter more than it
did yesterday, not less.

---

## Where this stands — 2026-09-14

Reply sent on case `178930966200969`, answering AWS's four questions. Awaiting
their response; they quote 24 hours for an initial reply.

```bash
AWS_PROFILE=aeygis npm run check:ses
```

One command for the whole posture — production access, identities, what the
**deployed** functions are actually configured with, and bounce handling. Current
output:

```
TODO  production access NOT granted (sandbox: 200 / 24 h)
OK    aeygis.com verified, DKIM SUCCESS, signing on
OK    SES_ENABLED = true
TODO  sender is still rajaemadhussain@gmail.com — fails DMARC, quarantined
TODO  recipient allowlist is restricted to: rajaemadhussain@gmail.com
OK    bounce topic has 1 confirmed subscriber
OK    suppression list is empty
```

**The last two TODOs are deliberate, not defects.** The sender stays on the test
Gmail and the allowlist stays closed until production access is granted — see the
order below. The script says so rather than implying something is broken.

It reads the **deployed Lambda environment**, not `resource.ts`. Those differ for
as long as a change sits undeployed, and "I changed the sender, why is it still
using the old one" is exactly the confusion that avoids.

It also exits `0` when the only findings are steps not yet taken. *Not finished*
is not *broken*.

### The order, and why each step waits on the one before

| # | Step | Waiting on |
|---|---|---|
| 1 | Production access granted | AWS |
| 2 | `aeygis.com` verified + DKIM | ✅ done 2026-09-14 |
| 3 | Sender → `aws@aeygis.com` **+ redeploy** | step 1 |
| 4 | SNS bounce subscription re-pointed | step 3 |
| 5 | Allowlist → `*` | step 4 |

Step 3 waits on step 1 because until then the extra reach is worthless, and
switching early gains nothing. Step 5 is last because it is the only one that
lets a message reach a real prospect — every other guard is still in place until
it moves.

**Step 3 needs a deploy, not just an edit.** `backend.ts` scopes `ses:SendEmail`
to the sending identity's ARN, so changing the address without deploying leaves
the function unable to send at all.

---

## ✅ `aeygis.com` VERIFIED — 2026-09-14

```
VerifiedForSendingStatus  true
DkimStatus                SUCCESS
SigningEnabled            true
```

All three DKIM CNAMEs published at Hostinger and resolving. Check any time with
`AWS_PROFILE=aeygis npm run check:dns`.

This is exactly what AWS asked for in their reply to the denied case:

> *"We ask that you have a verified identity prior to being granted production
> access... For the best results, we recommend that you start with a verified
> domain identity."*

**The denial was a request for information, not a refusal.** The case remains open
and is answered by replying to it — see
[`ses-case-reply.txt`](ses-case-reply.txt), which answers each of AWS's four
questions. Every factual claim in that file was checked against the live account or
the source before it was written, because it goes to AWS:

| Claim | Checked against |
|---|---|
| Reply-to reaches a person | `ReplyToAddresses` in `send-proposal-email/handler.ts` |
| Content hash re-verified before sending | the `createHash` comparison in the same file |
| No open or click tracking | `TrackingOptions` is `null` on both configuration sets |
| Bounce/complaint events published | both sets' event destinations, live |
| SNS topic has a confirmed subscriber | a real subscription ARN, not `PendingConfirmation` |
| 5 submissions per IP per hour | the deployed Lambda's environment, not the source default |
| PDF ≈ 300 KB | 307,484 bytes on disk |

The two example emails in it were **generated by the real builders**, not written
by hand, so AWS is not told something the code does not do.

---

## ⛔ THE REQUEST WAS DENIED — 2026-09-13

```
ReviewDetails.Status  DENIED
ReviewDetails.CaseId  178930966200969
ProductionAccessEnabled  false
```

Submitted 2026-08-28 as TRANSACTIONAL for `https://health.aeygis.com`. The account
is otherwise clean: `EnforcementStatus` is `HEALTHY` and the suppression list is
empty, so nothing about sending behaviour caused this.

**The likely reason is the one flagged before it was sent:** the only sending
identity was a personal `@gmail.com` address, and neither `aeygis.com` nor
`health.aeygis.com` was verified in SES. AWS could not connect the stated use case
to a domain this account demonstrably controls. **That is a guess about AWS's
reasoning** — the actual reason is in the case correspondence, which is in the
Gmail inbox and the Support Center, not in any API.

---

## What checking the DNS actually revealed — 2026-09-13

**Several things this document previously assumed are wrong.** All of the below was
read from public DNS, not recalled.

### DNS access is NOT the blocker

`aeygis.com` resolves to `82.197.80.1` on nameservers `aster.dns-parking.com` and
`helios.dns-parking.com` — Hostinger. The zone carries live, deliberately managed
records, so somebody can add to it. Every "blocked on `aeygis.com` DNS access" note
in these docs was **overstated**: the blocker is access to that Hostinger account,
not the absence of DNS anywhere.

### The domain already runs real email, on Google Workspace

```
MX     ASPMX.L.GOOGLE.com (+4 ALT)
SPF    v=spf1 include:_spf.google.com ~all
DMARC  v=DMARC1; p=quarantine; pct=100; rua=mailto:coo@aeygis.com
```

So `aws@aeygis.com` can be a real mailbox rather than an alias invented for SES, and
`coo@aeygis.com` already exists.

### ⚠ The DMARC policy is the trap

**`p=quarantine; pct=100`.** Aeygis has already told the world to quarantine any mail
from `aeygis.com` that is not SPF- or DKIM-aligned.

That inverts the usual advice. Normally an unaligned send *might* land in spam
depending on the receiver. Here **it is instructed to**, by Aeygis's own policy, at
100%. So switching `SES_FROM_ADDRESS` to `aws@aeygis.com` **before** the SES DKIM
records exist would be worse than the current Gmail sender, not better.

The current SPF has one include (`_spf.google.com`) and does **not** list Amazon SES.

### SES has the wrong domain verified

```
app-cadence.com            DOMAIN          verified, DKIM SUCCESS, MAIL FROM bounce.app-cadence.com
rajaemadhussain@gmail.com  EMAIL_ADDRESS   verified
```

`app-cadence.com` is fully and properly set up — DKIM signing on, custom MAIL FROM.
**It is not an Aeygis domain**, and no part of this project references it.
⚠ **Unresolved: why it is in this account.** Asked, not assumed. It may belong to an
unrelated project sharing account `326629581669`. Nothing here should be built on it
until that is answered.

---

## Step 3a — requesting production access NOW, before the domain exists

**You can do this today.** Production access and DNS are independent, the review
takes about 24 hours, and approval persists — so running it in parallel with the
domain work costs nothing and saves a day later.

**Account state, checked 2026-08-28:**

| | |
|---|---|
| `ProductionAccessEnabled` | **false** |
| Quota | 200 / 24 h, 1 per second |
| `EnforcementStatus` | `HEALTHY` — no reputation problems to explain |
| Identities | one: `rajaemadhussain@gmail.com` (email address, verified) |
| Domain identity | **none** |

### ⚠ What production access does and does not do

It removes the sandbox's two restrictions: you may email **any** address rather
than only verified ones, and the quota rises well above 200/24 h.

**It does nothing for deliverability.** A message sent from a `@gmail.com` address
through SES still fails SPF, DKIM and DMARC, because SES cannot sign for a domain
we do not control. Approved or not, those messages land in spam. See
[the deliverability section](#-deliverability-the-sandbox-proves-the-pipeline-not-that-mail-arrives).

Put plainly: **production access removes AWS's restriction on who we may email.
Domain verification is what makes the email arrive.** Both are needed; only one of
them is blocked on DNS.

### The request

The reviewed content is the use-case description. It is kept in
[`ses-production-use-case.txt`](ses-production-use-case.txt) rather than pasted
inline here, so it can be read and corrected before it is sent — every claim in it
was checked against the live account, not recalled.

```bash
aws sesv2 put-account-details   --region ca-central-1   --production-access-enabled   --mail-type TRANSACTIONAL   --website-url https://health.aeygis.com   --contact-language EN   --additional-contact-email-addresses rajaemadhussain@gmail.com   --use-case-description file://docs/ses-production-use-case.txt
```

`--mail-type` and `--website-url` are required; the rest are optional.
`--use-case-description` caps at 5000 characters. The console equivalent is
*Account dashboard → Request production access*.

⚠ **Once submitted, account details cannot be edited until the review completes.**
Read the description first. Getting it right matters more than sending it quickly.

### Why this request is likely to be approved

Reviewers look for a real use case, real consent, and evidence that bounces are
handled. All three are already true and verifiable:

- **Transactional, not marketing** — one email per proposal, sent by a person.
- **Consent recorded** — `consent` is a required boolean on every stored
  assessment, with `consentedAt`. A submission without it is refused outright.
- **Bounce and complaint handling built before the first send** — both
  configuration sets publish `BOUNCE`, `COMPLAINT`, `DELIVERY_DELAY` and `REJECT`
  to an SNS topic with a **confirmed** subscriber. Verified 2026-08-28.
- **Low volume, rate limited** — the public form allows 5 submissions per IP per
  hour (`RATE_LIMIT_MAX=5`, `RATE_LIMIT_WINDOW_SECONDS=3600`, confirmed on the
  deployed function).

The one weak point is that the sender is a personal Gmail address. The request
form does not ask for it, but be ready to answer if AWS does — the honest answer
is that the domain is being verified and the sender moves to `aws@aeygis.com` as
soon as DNS access exists.

### After approval

1. **Confirm it actually took.** Do not assume the email means it is live:

   ```bash
   aws sesv2 get-account --region ca-central-1      --query "{Production:ProductionAccessEnabled,Max24Hour:SendQuota.Max24HourSend}"
   ```

2. **Do NOT open the recipient allowlist yet** if the sender is still a Gmail
   address. Opening it lets real prospects be emailed, and until the domain is
   verified those emails land in spam — which is worse than not sending, because
   it burns the first impression and the sender reputation at once. Open it as
   part of Step 4, not on its own.

---

## Step 4 — production cutover (when DNS access exists)

**This is not optional polish.** Until it is done, proposals sent to real
clinics will be unsigned, unaligned, and land in spam — see the section above.

Nothing below is possible without control of `aeygis.com` DNS.

1. **Verify the domain** (not just an address):

   ```bash
   aws sesv2 create-email-identity --email-identity aeygis.com --region ca-central-1
   ```

   Add the DNS records AWS returns, **including the three DKIM CNAMEs**. Domain
   verification before requesting production access is the documented fast path.

2. **Publish SPF and DMARC.** Not strictly required by SES, but proposals sent
   from an unauthenticated domain land in spam, which for this use case is
   indistinguishable from not sending them.

3. **Switch the sender** to a real address. `aws@aeygis.com` is the natural
   choice — it is what the Overview deck and every legal page already publish.
   (`aws@aeygis.com` is the current formsubmit.co destination for the contact-sales form.
   The assessment form no longer uses formsubmit.co at all.)

4. **Request production access** — console *Account dashboard → Request production
   access*, or:

   ```bash
   aws sesv2 put-account-details \
     --production-access-enabled \
     --mail-type TRANSACTIONAL \
     --website-url https://health.aeygis.com \
     --additional-contact-email-addresses aws@aeygis.com \
     --contact-language EN \
     --region ca-central-1
   ```

   Describe the use case honestly: **transactional** — assessment confirmations and
   proposal delivery to prospects who submitted a form and gave CASL consent —
   plus the bounce/complaint process from Step 2. Initial response within 24 hours.

   ⚠ Once submitted, account details **cannot be edited** until the review
   completes.

5. **Raise the sending quota** if needed. Production defaults are higher than
   sandbox but still finite; proposal volume is low, so this is unlikely to bind.

6. **Open the recipient allowlist** — set `SES_ALLOWED_RECIPIENTS` to `*`, and only
   after production access is confirmed. **Do not blank it**: blank means block
   everything, by design. Consider keeping a real list in non-production
   environments so a test run can never email a real prospect.

7. **Move the internal addresses off the personal Gmail.** Three settings point at
   `rajaemadhussain@gmail.com` today, and they are **independent** — changing one
   does not change the others.

   | What | Where | Becomes |
   |---|---|---|
   | Sender | `SES_FROM_ADDRESS` in `send-proposal-email/resource.ts` | e.g. `aws@aeygis.com`. **Requires a redeploy** — `backend.ts` scopes `ses:SendEmail` to this identity's ARN. |
   | BCC on every proposal | `SES_BCC_ADDRESS`, same file | A monitored staff mailbox |
   | New-lead notification recipient | `NOTIFY_TO_ADDRESS` in `submit-assessment/resource.ts` | A monitored staff mailbox. `NOTIFY_FROM_ADDRESS` follows `SES_FROM_ADDRESS` automatically — it is imported, not copied. |

8. **Re-point the SNS bounce subscription.** ⚠ **Not a config change — it is done by
   hand, and it is easy to forget precisely because nothing in the repository
   references it.**

   The topic `ProposalEmailEvents` has one confirmed subscriber,
   `rajaemadhussain@gmail.com`, added by hand on 2026-08-23. **Both** configuration
   sets publish to it, so that single address receives bounces and complaints from
   client-facing proposal delivery *and* from internal new-lead notifications.

   A personal Gmail is the right answer while the sender is also a personal Gmail.
   Once `aeygis.com` exists it is single-person coverage for the early warning that
   an address has landed on the account suppression list — and if that person is
   away, nobody sees it.

   ```bash
   TOPIC=$(aws sns list-topics --region ca-central-1 \
     --query "Topics[?contains(TopicArn,'ProposalEmailEvents')].TopicArn" --output text)

   # Add the new one FIRST and confirm it, before removing the old one —
   # otherwise there is a window with no subscriber at all.
   aws sns subscribe --region ca-central-1 --topic-arn "$TOPIC" \
     --protocol email --notification-endpoint aws@aeygis.com
   # AWS emails a confirmation link. A HUMAN MUST CLICK IT. Until they do, the
   # subscription sits in PendingConfirmation and receives nothing.

   # Confirm it actually took. A SubscriptionArn of the literal string
   # "PendingConfirmation" means it did not.
   aws sns list-subscriptions-by-topic --region ca-central-1 --topic-arn "$TOPIC" \
     --query "Subscriptions[].{Endpoint:Endpoint,Arn:SubscriptionArn}" --output table

   # Only then remove the personal address.
   aws sns unsubscribe --region ca-central-1 --subscription-arn "<the old ARN>"
   ```

   **Why this is not in CDK.** `aws-cdk-lib/aws-sns-subscriptions` can declare an
   email subscription. It is left out for the same reason the SES identity is:
   CloudFormation can create the resource but cannot click the confirmation link, so
   an "as code" subscription is only ever half-declared — it exists and receives
   nothing until somebody acts out of band. Folding it into a deploy would also send
   a confirmation email as a side effect of approving something else.

   Hand-created resources are recorded in `aws-resources.md` instead.

---

## Checklist

| | Step | Blocked by |
|---|---|---|
| ☑ | Verify `rajaemadhussain@gmail.com` | done 2026-08-23 — `VerificationStatus: SUCCESS` |
| ☑ | Build `send-proposal-email` | done 2026-08-23, deployed to sandbox |
| ☑ | SES configuration set + SNS bounce/complaint topic | done 2026-08-23 |
| ☑ | **Subscribe an address to the SNS topic** | done 2026-08-23 — `rajaemadhussain@gmail.com`, confirmed (`PendingConfirmation: false`) |
| ☑ | End-to-end test in sandbox | done 2026-08-23/24 — real proposal sent and received, PDF opens |
| ☑ | New-lead notification built, deployed and proven to send | done 2026-08-26 — `npm run verify:notification`, SES message id returned |
| ☐ | Verify `aeygis.com` domain + DKIM | **DNS access** |
| ☐ | SPF + DMARC | DNS access |
| ☐ | Switch sender to a real Aeygis address (`SES_FROM_ADDRESS`) | domain verified |
| ☐ | Switch `SES_BCC_ADDRESS` and `NOTIFY_TO_ADDRESS` | domain verified — **separate settings, easy to miss** |
| ☐ | **Re-point the SNS bounce subscription** off the personal Gmail | domain verified — **done by hand, nothing in the repo references it** |
| ☐ | Request production access | domain verified |
| ☐ | Open the recipient allowlist to `*` | production access granted |

### What "still in the sandbox" means in practice

The system will refuse to email any address other than
`rajaemadhussain@gmail.com`, and record the attempt as `blocked` with the reason
visible in the console. That is the guard working, not a fault. To run a real
end-to-end test, use a lead whose **contact email is that Gmail address** —
`npm run seed:demo` can create one.
