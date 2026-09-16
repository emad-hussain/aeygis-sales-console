# 15. Verification

← [Operations](14-operations.md) · [Index](README.md) · Next: [Gotchas](16-gotchas.md)

Every test and check in the project, what it catches, and — as importantly — what it
cannot.

---

## 15.1 The principle

> **Static checks prove almost nothing about whether the system works. Every defect found in
> this project came from exercising a real path.**

That is not a slogan. Here are things that passed **every** static check:

| It passed | It was |
|---|---|
| typecheck, build, HTTP 200 | A **blank page** — two React copies, plus `generateClient()` running before `Amplify.configure()` |
| a green test suite | A Delete button throwing `is not a function`, because the *deployed* AppSync schema had no such mutation |
| deploy success, `describe-table` reporting `SSEType: KMS, Status: ENABLED` | A table on the **wrong KMS key** |
| a valid PDF in S3, base64 round-tripping byte-identical | A **blank 15-page attachment** in the client's inbox |
| a complete, well-formed design | 77 text nodes below **WCAG AA contrast** |
| CloudFormation synthesizing cleanly | An IAM policy that **denied at runtime** |

So the layers below are ordered by how much reality each one touches.

---

## 15.2 Layer 1 — unit tests (free, no AWS)

```bash
npm test          # 356 tests across 16 files, ~2 seconds
```

**Only pure, AWS-free tests run here.** Anything needing a deployed backend is a manual
verification step, not a unit test — **a test suite that silently requires credentials is a
trap.**

| File | Tests | Covers |
|---|---|---|
| `packages/pricing/src/clientPayload.test.ts` | 48 | The client payload mapper — barrier 2 |
| `render-proposal-pdf/assertClientSafe.test.ts` | 36 | The runtime confidentiality guard — barrier 5 |
| `packages/pricing/src/quote.test.ts` | 34 | Tier pricing, plan eligibility, discount rules, the Enterprise refusal |
| `send-proposal-email/emailBody.test.ts` | 31 | Subject, bodies, filenames, the money-leak test, header injection |
| `submit-assessment/validate.test.ts` | 30 | Public intake validation |
| `functions/shared/identity.test.ts` | 29 | Caller parsing, group predicates |
| `packages/domain/src/discoveryQuestions.test.ts` | 20 | Custom question merging, id-collision refusal, numbering |
| `send-proposal-email/recipientPolicy.test.ts` | 20 | The fail-closed allowlist |
| `packages/pricing/src/band-consistency.test.ts` | 17 | Cross-package agreement between `domain` and `pricing` |
| `packages/domain/src/delivery.test.ts` | 7 | Delivery status vocabulary |
| `packages/domain/src/currentSpend.test.ts` | 7 | The spend estimate, including "returns null rather than inventing" |
| `packages/domain/src/assessment.test.ts` | 7 | Status labels, `isOneOf` |
| `functions/shared/callerEmail.test.ts` | 7 | Cognito attribute parsing, filter safety |
| `submit-assessment/notification.test.ts` | 22 | The new-lead notification: header injection, the priceable-or-not line, the `.invalid` skip, and that it never states a price |

### Why the pure/impure split is load-bearing

A handler calls `getAmplifyDataClientConfig` at module load, so importing one in a test would
require AWS credentials. Hence `identity.ts`, `recipientPolicy.ts`, `emailBody.ts`,
`validate.ts` and `assertClientSafe.ts` are all separate, pure files.

> **A security check that cannot be tested without credentials is a security check that does
> not get tested.**

### Bugs this layer has caught

- **A tab-eating strip.** `\t` sits inside `U+0000–U+001F`, so the control-character strip
  **deleted** tabs instead of collapsing them, turning "Bay Street⟨tab⟩Clinic" into
  "Bay StreetClinic".
- **A band wrongly flagged ambiguous.** `15+` providers is not ambiguous — every value in it
  is Enterprise. Caught by the cross-package consistency suite.
- **A vacuous HTML-escape test.** It asserted the clinic name was escaped in the email body —
  but the clinic name never reaches the HTML body at all, so the test passed on nothing. It
  was rewritten against a field that does appear, and a second test was added documenting the
  clinic name's absence.
- **A wrong assertion about escaping.** `not.toContain('onerror=')` was incorrect: escaping
  works, and the word appearing as *text* is harmless. It now asserts only that `div` and `p`
  tags exist.

---

## 15.3 Layer 2 — the confidentiality boundary (free)

```bash
npm run lint:boundaries
# ✔ no dependency violations found (101 modules, 183 dependencies cruised)
```

Seven rules, all `severity: error`, checked **transitively**
(`tsPreCompilationDeps: true`). Full list in
[Architecture §3.4](03-architecture.md#34-repository-layout-and-package-boundaries).

> **A failure here is a confidentiality incident, not a lint nit.** Do not add an exception.

---

## 15.4 Layer 3 — the synth check (free)

```bash
npm run check:synth      # 24 checks
```

**Run this before every deploy.** It synthesizes `amplify/backend.ts` locally and inspects
the generated CloudFormation. **No AWS calls, nothing deployed.**

### How it works

Sets `CDK_CONTEXT_JSON` with a fake sandbox identity and `CDK_OUTDIR` to a temporary
directory, runs `npx tsx amplify/backend.ts`, then reads every emitted template and the
GraphQL schema.

### What it asserts

| Group | Assertions |
|---|---|
| **GraphQL schema** | Append-only models expose no `update`/`delete` mutations; no mutation name collides with an auto-generated one; **no `Assessment` field uses a scalar that refuses ordinary human input** |
| **Encryption at rest** | Every table requests the customer-managed key and point-in-time recovery |
| **Confidentiality (barrier 4)** | **No client-facing function has any ARN for `proposals/internal/*`** |
| **Public access** | The unauthenticated role can read no `Assessment` fields |
| **Email delivery** | `ses:SendEmail` exists and is granted only to an explicit **allowlist** of principals; every grant is scoped to a **named identity** and not a wildcard, and **covers the configuration set it sends with**; both configuration sets have fixed names and no unexpected set exists; the bounce topic is not world-publishable |

> **That email row used to say "exactly one principal".** `submit-assessment` became the
> second sender when the new-lead notification was added, and the check failed — correctly.
> Relaxing it to "one or more" would have been the easy fix and the wrong one: the value of
> the check is that a principal nobody intended cannot quietly gain the ability to send mail
> from an Aeygis address. It is now an explicit list, and a **third** sender still fails
> until somebody adds it deliberately.

> **The scalar check was added 2026-08-26, after `phone: a.phone()` destroyed two real
> leads.** `AWSPhone`, `AWSURL` and `AWSIPAddress` all validate at **write** time — inside
> the Lambda, after the visitor has gone — so a refusal cannot prompt anybody to correct
> anything. It can only lose the submission. The check fails if any of the three appears on
> `Assessment`. `AWSEmail` is deliberately allowed: `email` is required and `validate.ts`
> already rejects a bad one with a fixable message before the write.
>
> **It was written against the pre-fix schema first.** Run on the synth output from before
> the change it reported `WOULD FAIL on: phone: AWSPhone` — so it is known to catch the
> real bug, rather than merely known to pass. A check that has only ever been seen passing
> has not been tested; it has been assumed. See §15.4's lesson below, which is the same
> point from the other direction.

### The lesson from writing it — read this before adding any check

Nearly every assertion here is of the form ***"X is absent"***, and those **all pass on an
empty list.**

The first version's schema regex was `^type Mutation \{`, which did not allow for the
`@aws_iam` directive the real schema carries. It matched **nothing**, so three checks
reported a clean bill of health for a file they had never read.

It now **fails loudly if it parses zero mutations**, and fails if it cannot find the table
resources at all.

> **A check that cannot tell "nothing is wrong" from "I looked at nothing" is worse than no
> check**, because nobody investigates a pass.

### What it is not

**A gate, not a guarantee.** CloudFormation still rejects things at deploy time, and a policy
that synthesizes perfectly can still deny at runtime — this project has hit that more than
once. **Passing means "worth deploying", not "will work".** The script says so itself when it
finishes.

---

> **The 131 is verified — 2026-09-16, 131/131.** It had been carried in six
> documents without anyone having run it, which is how a figure becomes folklore.
>
> **Two things that run revealed.** The total is **not fixed**: a first run
> reported `130/132`, because the runtime-error check contributes extra entries
> when it finds something. A count that moves with the result cannot be quoted as
> a constant — "131" means *131 when everything passes*.
>
> The thing it found was a transient `400` from
> `cognito-identity.ca-central-1.amazonaws.com` on first load, most likely a
> stale cached identity being rejected and then refreshed. It did **not**
> reproduce on an immediate second run. Recorded rather than chased: a
> one-in-two-runs error that clears itself is worth knowing about if it ever
> comes back, and not worth a hunt today.

### `check-actions-layout.mjs` — free, standalone, no dev server

```bash
npm run check:actions
```

Renders the approvals table's action cluster against the real `brand.css` in a headless
browser at six widths, and asserts the buttons stay on one line on a normal pane, wrap
rather than overflow on a narrow one, and keep **View PDF first**.

It exists because `.row-actions` was created after three buttons in one cell pushed the
table into horizontal scroll. Moving **View PDF** out of the fingerprint column on
2026-08-27 made it four, so the claim "flex-wrap handles it" needed testing.

**It measures the OLD layout as a baseline and compares.** That distinction is the
point: this table already overflows by 137 px at 520 px because of the decision column's
email address and timestamp. A check that only asked "does it overflow" would have blamed
a change that was not responsible and blocked it. The bar is *no worse than before*, and
the run prints both numbers:

```
PASS   520px  still overflows 137px, but it did before too (137px) — not caused by this
PASS  1100px  no horizontal scroll · cluster on 1 line(s) — all four in a row
```

Unlike `check:ui` this needs no AWS records and no running dev server, so it can run in
the same breath as `npm test`.

> **Known, and predates the button move:** the approvals table overflows its wrapper by
> ~137 px below about 600 px wide. It scrolls inside `.table-wrap` rather than breaking
> the page, so it is a nuisance rather than a fault. The cause is the decision column
> holding a full email address, a timestamp and a groups list on three lines. Not fixed
> here because it is unrelated to the change that found it.

---

## 15.5 Layer 4 — the browser UI check (free, needs the dev server)

```bash
npm run seed:demo        # only if the queue is empty - AWS write, needs approval
npm run console          # in one terminal
npm run check:ui         # in another
```
> **⚠ This one is not self-contained.** It signs into the real console and measures real
> rows, so it needs the deployed `Assessment` table to have records. `npm run cleanup:tests`
> empties it, and the two are easy not to connect — run `npm run seed:demo` first if the
> queue is empty. Every other check in this list is free and standalone; this one depends
> on AWS state even though it makes no AWS write itself.


**Why it exists.** `verify-console-renders.mjs` proves the app *mounts*. It cannot see a card
that overflows its column, text clipped without an ellipsis, a sticky header covering the
thing it was asked to scroll to, grey-on-grey text nobody can read, or a heading silently
painting in the wrong typeface. **Every one of those compiles, serves, and mounts perfectly.**

### What it checks

- **Freshness first.** Before anything else, it compares the stylesheet the dev server sends
  against the file on disk, and checks that every `className` literal in each `.tsx` survives
  into the served module. This catches Vite serving stale code — see
  [Running locally §12.9](12-running-locally.md#vites-dev-server-can-serve-code-that-is-not-on-disk).
- **The two dark-theme blocks in `brand.css` agree.** A real hazard with a token list that
  long.
- **Layout at five widths** — 620, 900, 1024, 1280, 1600 — in **both themes**: overflow,
  clipping, sticky-header collisions.
- **WCAG AA contrast on every text node.**
- **The typeface each heading actually paints in** (not what the CSS asks for).
- **`prefers-reduced-motion`** — nothing stays invisible when animations are cancelled.
- **The user menu**, the topbar, the queue head, the delivery block.

### It deliberately never clicks Send

The delivery check asserts how many send controls exist and that **none is armed**. It does
not click.

> **A UI check must not be able to perform the one irreversible action in the system.**

### Defects it has caught that nothing else could

1. **77 text nodes below WCAG AA.** The mockup palette was carried over unchanged and `--dim`
   measured 2.77:1 on the chip ground.
2. **The Refresh button clipped at the top of the queue pane.** `.queue-pane` had
   `padding: 0 4px 1.15rem` — zero top — so anything with a shadow at the pane top was cut
   off.
3. **A delivery divider invisible in light mode.** It used `--surface-line`, which is
   `transparent` in light mode. `--line` is the visible token.

---

## 15.6 Layer 5 — the deployed API (⛔ needs AWS)

```bash
npm run verify           # runs all four below in sequence
```

### `verify-guest-access.mjs` — 13 checks

**The security claim the entire public path rests on**, asserted against the deployed API
rather than reasoned about.

**Deliberately uses raw Cognito Identity + SigV4 rather than `aws-amplify`.** Two reasons:

1. It reproduces exactly what an anonymous browser does — `GetId`,
   `GetCredentialsForIdentity`, then a SigV4-signed POST — with **no library layer that might
   silently substitute a different auth mode**.
2. `aws-amplify`'s credential caching assumes browser storage and fails in Node with "No
   credentials", **which would make every read test appear to pass for the wrong reason**.

That second point is the important one. **A denial test is only meaningful if you know the
credentials work**, so the read-denial checks are gated behind a successful write.

### `verify-browser-signing.mjs`

**Proves the LIVE SITE's dual-write code actually authenticates.**

It does **not** reimplement the signing. It reads `assets/js/assessment.js`, extracts the
source between marker comments, and **executes exactly what ships to browsers**. If that block
is edited and breaks, this test breaks with it.

Node 22+ provides `fetch`, `crypto.subtle`, `TextEncoder` and `URL` — the entire browser
surface the block depends on, which is why the block is kept free of DOM access.

**Why it exists.** The first version of that code sent an **unsigned** fetch with an optional
`x-api-key`. The API has no API key and guest auth is `AWS_IAM`, so **every request would have
been rejected 401** and swallowed as a console warning: a silently broken mirror that looks
fine. Reading the code did not catch it; signing a real request did.

It also asserts `AEYGIS_API_ENDPOINT` is **set and matches the deployed API**.

> **That assertion used to be the exact opposite** — the endpoint had to stay *blank*,
> because the backend call was a mirror and switching it on was a separate deliberate act.
> On 2026-08-25 the email path was removed and the backend became the only destination, at
> which point a blank endpoint stopped meaning "the mirror is off" and started meaning
> "every lead is silently discarded". The old assertion would have passed on precisely that
> broken state, which is why it was inverted rather than deleted.

### The live site's own checks — free, and they run without AWS

Added 2026-08-25, when the website became real source and two protections turned out to
have been silently lost in the rewrite.

```bash
npm run verify:site        # all three below
npm run verify:signing     # SigV4 vs aws4fetch, byte for byte
npm run verify:pricing     # shipped figures vs @aeygis/pricing
npm run verify:assessment  # the form, in a real browser
```

**`verify-sigv4-offline.mjs`** signs the same request twice — once with the code that
ships to browsers, once with `aws4fetch`, an independent implementation already in this
project's dependencies — and fails if the Authorization headers differ by a character.

That matters because **a SigV4 bug does not announce itself**: AWS returns a generic 403,
the mirror swallows it as a console warning, and the dual-write looks fine while capturing
nothing. Exactly that failure has already happened once here.

**`verify-site-pricing.mjs`** extracts the price book that actually ships and compares it,
figure by figure, against `packages/pricing` — the module the proposal PDF is built from.
It also asserts the rules that keep a banded form honest: Enterprise is never auto-priced,
Professional cannot take Train & Walk Away, savings appear only when they hold across the
whole range, and the internal Enterprise guide range never reaches a public page.

**`verify-site-assessment.mjs`** fills all five steps in a real browser and reads the
rendered report back. It exercises all four submission outcomes — sent, refused, failed,
and **recovered after a retry** (the first attempt refused at the connection, the second
succeeding).

> One trap it already hit: the walk originally waited for the status text to stop saying
> "Sending your details…", which looked equivalent to waiting for completion and was not.
> The retry message is different text but still an in-flight state, so the walk read a
> half-finished status and the retry check failed against working code. It now waits on
> the status **class** — the state machine — which is both correct and immune to a
> reworded message. Requests to formsubmit.co are intercepted (so no test email reaches
sales) and any request to AWS is failed and counted (so a future edit that activated the
mirror could not make this script write a real record silently). Both interceptions are
asserted, not assumed.

### `verify-lead-notification.mjs` — ⛔ sends one real email

```bash
npm run verify:notification
```

Every other check submits with a `.invalid` contact address, which the backend
deliberately **skips** for notification — otherwise each `npm run verify` run would email
the team about clinics that do not exist and spend SES quota that proposal delivery
shares.

That skip is correct and it leaves a hole: nothing exercises the send. **A notification
that silently never fired would look exactly like "no leads came in"** — the precise
failure it exists to prevent. So this closes the hole on demand, one email at a time.

It submits with `notification-check@aeygis-test.example`. `.example` is reserved by
RFC 2606 just like `.invalid`, so it can never be a real domain — but it is **not** what
the skip matches on. A provably fake address that still exercises the real path.

It then polls CloudWatch for the send, because the mutation returning proves the *write*,
not the *send*: the notification is awaited but its outcome is deliberately never
surfaced to the caller, so that a mail problem cannot fail a stored lead.

**What it proves:** the lead stored, the Lambda attempted the send, SES accepted it and
returned a message id.

**What it does not prove: delivery.** SES accepting a message is not an inbox — the same
distinction that caught the first proposal send, which SES accepted and Gmail filed as
spam. The script says so on success rather than letting green imply an inbox.

Follow with `npm run cleanup:tests`.

### `verify-console-access.mjs`

Signs in as a **real contributor** and a **real approver** via SRP — the same library the
console uses, so a failure here is a failure the console would hit too — and exercises the
exact grant:

```
allow.groups(['contributor','approver']).to(['read','update'])
```

So `read` and `update` must **succeed**, and `create` and `delete` must be **denied** for
both roles. The console exposes no create or delete, but **the API is the real boundary — a
console that hides a button proves nothing.**

### `verify-encryption.mjs`

**Compares actual KMS key ARNs**, on every table and the bucket.

It exists because **Amplify's table provider ignores `kmsMasterKeyId` when it creates a
table**, and the result is maximally deceptive: the template requests the CMK, the synth log
says success, and `describe-table` reports `SSEType: KMS, Status: ENABLED` — **and the key is
the wrong one.**

**Run it after any deploy that adds a model.** Not optional.

---

### `verify-phone-fix.mjs` — ⛔ creates up to 4 assessments

```bash
npm run verify:phone
npm run cleanup:tests    # afterwards, always
```

Submits the four phone formats a real person types — `(416) 555-1234`, `416.555.1234`,
`416-555-1234 ext 22`, `+1 416 555 0100` — through the real public mutation, then reads
the rows back out of DynamoDB and asserts each number was stored **character for
character**.

**Why it cannot be a unit test.** The bug it guards against
([§16.32](16-gotchas.md#1632-a-scalar-that-validates-at-write-time-can-only-destroy-a-submission))
lived in AppSync's schema validation — *above* our code, against the deployed schema. Our
unit tests prove `validate.ts` passes the value through; they cannot prove the write
succeeds. 346 of them were green while the live form was throwing leads away.

Three details that stop it passing for the wrong reason:

- **It reads DynamoDB, not the receipt.** The mutation returning `ok` proves the Lambda
  thought it succeeded. Only the stored row proves what is actually there.
- **It checks CloudWatch for `FIELDS DROPPED`.** A salvaged write also stores a lead, so
  the table alone cannot tell a fixed schema from a masked one. If salvage had to step in,
  the scalar is *still* refusing and the check fails.
- **That log check has a positive control, and discovers its own log group.** "No
  `FIELDS DROPPED` line exists" passes on an empty result — *including* the empty result
  from querying a log group that does not exist. So the group is found by prefix rather
  than hardcoded (anything but exactly one match is a hard failure), and the script first
  confirms it can see the `assessment stored` line for every submission. If it cannot, it
  says the query proved nothing rather than reporting a pass. Same trap as
  [§16.21](16-gotchas.md#1621-x-is-absent-assertions-all-pass-on-an-empty-list).
- **It submits only four.** Rate limiting is 5 per IP hash per hour and a rate-limited
  submission returns `opaqueSuccess` — deliberately identical to a real one. A fifth and
  sixth would be dropped while still reporting success.

The contact address ends in `.invalid`, so `isTestSubmission` skips the notification and no
SES quota is spent.

**It does not exercise the salvage path.** That cannot be triggered from the public form
any more now that `phone` is a string, which is the point — salvage is covered by
`salvage.test.ts` alone, and that limit is stated rather than papered over.

---

## 15.7 Layer 6 — the real-UI walk (⛔ needs AWS + a browser)

```bash
node scripts/verify-console-renders.mjs
node scripts/verify-discovery-and-delete.mjs      # 53 checks
```

### `verify-console-renders.mjs`

Loads the console in a real browser and fails on console errors.

**Why it exists.** The console typechecked, built, and served HTTP 200 — and rendered a
**blank page**. Three faults, none of which any other check could see:

1. Two React copies (root 18.3.1 vs app 19.2.8) → *"Invalid hook call"*
2. `generateClient()` at module scope running before `Amplify.configure()`, because ES
   imports evaluate before the importing module's body
3. Both surfaced **only in a browser, at runtime**

> **"It compiles" and "it serves" are not "it works."**

**One trap it documents.** Waiting on text that renders synchronously (like "Intake queue")
proves nothing — it is there before any data loads. Wait on something that only exists after
a real fetch, such as `.queue-item` count > 0.

### `verify-discovery-and-delete.mjs` — 53 checks

**Walks the actual UI, by clicking**, against the deployed backend.

**Why it exists.** Both features shipped with green unit tests and a clean typecheck, and the
first thing that happened when someone clicked the button was:

```
getClient(...).mutations.deleteProposalVersion is not a function
```

**Nothing in the test suite could have caught that.** Vitest exercises pure functions against
imported TypeScript types; the failure was that the **deployed AppSync schema** did not
contain the mutation, which is a property of AWS, not of the code.

> **A green suite and a broken button are entirely compatible states.**

What it does: adds custom questions, a schedule estimate and a responsibility row; saves;
**reloads**; confirms persistence; generates a proposal; fetches the PDF from the tab the
browser opened; confirms the new content is in its text **and that an excluded row is
genuinely absent**; then deletes a version and confirms it stays gone across a reload.

---

## 15.8 Layer 7 — the real send (⛔ sends a real email)

```bash
npm run verify:email
```

**The order is deliberate: every refusal is proved BEFORE anything is sent**, so a broken
guard is found while nothing has left the building.

| # | Scenario | Required result |
|---|---|---|
| 1 | Recipient not on the allowlist | **blocked** — refused, not attempted |
| 2 | Version not approved | **refused** |
| 3 | A contributor attempts to send | **denied by AppSync**, before the Lambda runs |
| 4 | Approved version, allowed recipient | **sent**, real SES message id, PDF attached |

Plus: the delivery row carries the fingerprint of the document actually mailed, the refused
attempt is recorded too, and an `AuditEvent` completes the trail.

**It imports `SUPPORT_PLANS` and `TIERS` from `@aeygis/pricing`** and guards against an
unknown value up front — added after a run passed `"standard"`, a support plan that does not
exist.

### `resend-proposal.mjs`

```bash
npm run resend -- <proposalId> <versionKey>     # ⛔ sends a real email
npm run resend                                   # picks the newest approved version
```

Re-sends one already-approved version, so a delivery problem can be re-tested without running
the whole walk (which creates two more leads and two more proposals every time).

---

## 15.9 Document checks (free)

```bash
npm run preview:proposal   # renders a real PDF with your local Chrome
npm run check:layout       # measures every page for overflow, in a browser
```

**`check:layout` does not use `scrollHeight`.** `.page` is `overflow: hidden`, so
`scrollHeight` is **always** clamped to `clientHeight` and reports "fits" no matter how far
content runs past the bottom. **It is a check that cannot fail, which is worse than no
check.**

It measures the real bottom edge of the last flowed child against the page box **and**
against the footer's own top edge — the two ways content actually goes wrong on a
fixed-height page with no auto-pagination.

---

## 15.9a What no check covers: the words on the screen

No automated check reads the product's own copy for truth. `check:ui` measures contrast,
overflow and typeface; nothing asks whether an empty state describes a system that still
exists.

That gap cost something real — see
[Gotchas §16.30](16-gotchas.md#1630-do-not-put-facts-that-can-go-stale-into-product-copy).

**The durable fix is not a check, it is a rule:** product copy should not state anything
that can go out of date. No deployment status, no environment detail, no terminal commands,
no internal tracker references. Copy written that way needs no audit, because there is
nothing in it to fall out of step.

Where copy must be specific, include user-visible strings in any documentation review and
re-read them whenever the thing they describe changes.

---

## 15.10 The complete gate

Before a deploy:

```bash
npm run typecheck
npm test                 # 356
npm run lint:boundaries  # 101 modules, 0 violations
npm run check:synth      # 24
npm run check:actions    # row-action layout, no AWS and no dev server
npm run check:ui         # 131  (needs npm run console running + rows in the table)
```

After a deploy (⛔ needs approval):

```bash
npm run verify:encryption     # if the deploy added a model — MANDATORY
npm run verify                # after any backend change
npm run cleanup:tests         # remove the records verify just wrote
```

**Current state: all passing.**

---

## 15.11 What is still unverified

Recorded so nobody assumes otherwise.

| Claim | Status |
|---|---|
| **A submission survives a real network failure** | **Partly verified.** The retry is exercised in a real browser against stubs, and `verify:local-site` proves the whole signed path works from localhost against real Cognito and AppSync. What is *not* exercised is a genuine mid-flight failure on the deployed site. |
| **Proposals reach real clinics** | **Unverified, and currently false.** See [Email delivery §10.8](10-email-delivery.md#108--deliverability--the-sandbox-proves-the-pipeline-not-that-mail-arrives). |
| Amplify `FunctionBundlingOptions` field shapes | Confirmed as `{ minify?: boolean }` in the installed types — the provider overload is the documented fallback and is what this project uses |
| Model-level `allow.resource()` scope | **Assumed API-wide.** That assumption is precisely why the five-barrier confidential design exists. |
| `defineStorage` has no versioning property | Confirmed by the L1 escape hatch being necessary; the property name is CFN-derived |
| `multifactor` / `accountRecovery` shapes on `defineAuth` | **Unverified — that is why MFA is not configured.** |
| That an Amplify app's own region governs `pipeline-deploy` | Unverified — hence the fail-loud region guard |
