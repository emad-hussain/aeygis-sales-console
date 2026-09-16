# Aeygis Sales Platform — Project Status

> **Read this first.** This file is the single source of truth for where this project stands.
> Update it at the end of **every** work session, not just at phase boundaries.
> The full architecture and task tracker lives at `C:\Users\Emad-Hussain\.claude\plans\0-setup-squishy-bachman.md`.
>
> **For how the system WORKS — as opposed to where it stands — read the
> [HANDBOOK](handbook/README.md).** Nineteen chapters: features, architecture, every AWS
> resource and why it exists, the data model, the pricing engine, the proposal document, the
> console, email delivery, security, running locally, running in production, operations,
> verification, gotchas, and the decision log. Written 2026-08-24 as Phase 6.

---

## ⛔ OPERATING RULES

**1. No AWS action without explicit per-action permission.** Applies to every session.

Before any AWS-touching command: stop, state exactly what will be created/changed/deleted, in which account and region, and wait for a clear go-ahead. **Approval for one AWS action is not approval for the next.**

Covered (non-exhaustive): `cdk bootstrap`, `ampx sandbox`, `ampx pipeline-deploy`, creating/modifying Cognito · AppSync · DynamoDB · S3 · Lambda · IAM, SES identity verification, sending **any** email including tests, Amplify Hosting apps/branches/domains, and any non-read-only `aws` CLI call.

**Free without asking:** local code, unit tests that don't call AWS, documentation, reading the existing repo, `tsc`/lint/build that doesn't deploy.

**2. Do not deploy to the live site.** The two Phase 1 edits to `aeygis-website-source-code` are authored locally and handed to the user to review and deploy.

**3. Documentation is written as work happens.** `deployment.md` and `aws-resources.md` are living documents updated in the same session as the change they describe. An undocumented resource is an incomplete task.

---

## STATUS BOARD

| | |
|---|---|
| **Current phase** | **Phase 6 (documentation) COMPLETE.** The full handbook is at [`docs/handbook/`](handbook/README.md) — 19 chapters, ~340 KB. Phases 1–5 all complete and verified. **P13 closed 2026-08-26**, **P14 closed 2026-08-27**. Next: the SES domain cutover when DNS access exists. |
| **Last updated** | 2026-09-16 |
| **Progress** | **Phases 1–4 complete. P4–P11 all RESOLVED and deployed.** The client proposal is now **17 pages**, ending on Acceptance: current-state summary, spend comparison (shown only when favourable), migration track, indicative schedule, shared responsibility matrix, IT-provider co-existence, service levels, scope/terms and acceptance. The technical-discovery appendix and the sources-and-references appendix were both **removed on request (2026-08-23)**. Non-approved versions can be deleted. **Phase 5 shipped 2026-08-23/24:** an approver can email an approved proposal from the console, the PDF rides as an attachment, and every attempt is recorded as an immutable `ProposalDelivery` row (`sent` / `blocked` / `failed`). A real proposal was sent and received. **Sandbox only** - exactly one verified recipient, and deliverability to real clinics is unproven until the SES domain cutover (see `email-setup.md`). Remaining: nothing in code. P13 closed 2026-08-26, P1/P2 superseded 2026-08-25, P3 declined by the user, Phase 6 complete. |
| **AWS resources provisioned** | Sandbox live in `326629581669` / `ca-central-1`, including a `ChromiumPack` stack (private S3 bucket + CloudFront/OAC) and a `delete-proposal-version` Lambda. See `aws-resources.md`. |
| **Console UI** | **Rebuilt in the "Porcelain" direction (2026-08-23)** — warm light SaaS, floating white cards, Manrope + IBM Plex Mono, teal accent, **plus a full dark theme with a toggle**. Chosen from four rendered candidates in `ui/`. Supersedes "Signal"; the indigo rail is gone. Verified by `npm run check:ui` — **131** browser checks in both themes at five widths, now including the delivery block. |
| **Verification** | **356/376 unit tests** · `depcruise` clean (105 modules, 188 dependencies) · `npm run check:synth` 24/24 (synthesizes `backend.ts` locally and inspects the CloudFormation - no AWS calls) · console build clean · `npm run check:layout` measures all 17 proposal pages for overflow · encryption verified against live AWS **2026-08-26: all 5 tables on the CMK with PITR, `ProposalDelivery` included** · **and — the one that matters — `scripts/verify-discovery-and-delete.mjs` walks the REAL UI against the deployed backend: 53 checks, all by clicking. Adds custom questions, a schedule estimate and a responsibility row, saves, RELOADS, confirms persistence, generates, fetches the PDF from the tab the browser opened and confirms the new content is in its text (and that an excluded row is genuinely absent), then deletes a version and confirms it stays gone across a reload.** |
| **Blocked on** | Nothing in code. **SES production access was DENIED 2026-09-13** (case `178930966200969`), almost certainly because the only sending identity was a personal Gmail and no Aeygis domain is verified in SES. **Correction to a long-standing claim here:** this was never blocked on "DNS access" — `aeygis.com` is live on Hostinger nameservers with managed records and Google Workspace mail. **Resolved 2026-09-14:** `aeygis.com` is verified with `DkimStatus: SUCCESS`, and a reply answering AWS's questions has been sent on the case. Now waiting on AWS. The sender stays on the test Gmail until access is granted — the domain publishes **`DMARC p=quarantine`**, so switching early would quarantine mail by Aeygis's own policy. See `email-setup.md`. |
| **Open pending items** | **P12** the backend is the ONLY path a lead has · ~~the SES cutover~~ ✅ **COMPLETE 2026-09-16** — sending as `aws@aeygis.com`, DKIM-aligned, a real send landed in an inbox, allowlist open · **the live site is not deployed — the OLD pricing is still public** · `git init` — see PENDING ITEMS. P1/P2 superseded 2026-08-25 (no dual-write exists); P3 declined 2026-08-23; P4–P11 closed. |
| **AppSync endpoint** | `https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql` |
| **Next AWS action needing approval** | None open. **In flight:** `aeygis.com` is **VERIFIED** in SES with `DkimStatus: SUCCESS` (2026-09-14). AWS's reply to case `178930966200969` was a request for information, not a refusal — answer it with [`ses-case-reply.txt`](ses-case-reply.txt). Sender stays `rajaemadhussain@gmail.com` for testing until production access is granted. Optional: a real send to confirm P14's status advance end to end — that emails the verified recipient, so it needs its own go-ahead. |

**Goal:** Turn the approved Cloud Migration Assessment + Framework documents into a working pipeline — public intake → internal console → branded proposal PDF → logged approval → emailed delivery — on Amplify Gen 2 in `ca-central-1`, without changing the live site's existing behavior.

**Definition of done:** All six phases signed off, a proposal generated from a real assessment and emailed end to end, and all documentation deliverables written.

---

## CONSOLE UI REBUILD — "Porcelain" (2026-08-23)

The console was rebuilt in the **Porcelain** direction, chosen by the user from
four rendered candidates in `ui/` (Nocturne, Porcelain, Meridian, Solstice).
Full design record in `ui/README.md`.

**Backend untouched.** This session changed `apps/console` and nothing else: no
schema change, no Lambda change, no deploy, no AWS call that was not a normal
read by the running console.

### What changed

| File | Change |
|---|---|
| `src/brand.css` | Rewritten. Porcelain tokens, motion system, Amplify Authenticator theming. |
| `src/App.tsx` | Top bar + two columns, replacing the three-pane rail. Filter chips replace the sidebar nav. Route-aware sign-in card. |
| `src/AuthBrandPanel.tsx` | Now the split sign-in's floating ink brand panel. |
| `src/Toast.tsx` | **New.** Transient save confirmations, capped at three, timers cleared on unmount. |
| `src/authTheme.ts` | Manrope, Porcelain radii. |
| `src/AssessmentDetail.tsx` | Save moved to the sticky header; inline styles replaced with classes; scroll-spy line now measured. |
| `src/PricingPanel.tsx`, `src/ApprovalPanel.tsx` | Class-level restyle; wrapping action clusters. |
| `src/useTheme.ts` | **New.** Three-state theme: follow-system (default), explicit light, explicit dark. |
| `packages/domain/src/assessment.ts` | Gained `ASSESSMENT_STATUS_LABEL` + `assessmentStatusLabel()` beside the existing `ASSESSMENT_STATUSES`, so the queue and the detail header share one vocabulary. |
| `src/ThemeToggle.tsx` | **New.** Top bar and sign-in. |
| `public/favicon.png` | **New.** Generated from the Aeygis mark; the console logged a 404 on every load without it. |
| `src/assets/auth-panel.jpg` | **New.** Bundled sign-in panel image — never hot-linked. |
| `scripts/check-console-ui.mjs` | **New.** 62 browser checks at five widths. |

### Three defects this found that nothing else could

1. **Contrast.** The mockup palette was carried over unchanged and **77 text
   nodes failed WCAG AA** — `--dim` at `#8a919c` measured **2.77:1**. The
   neutral and status hues were re-derived numerically against every ground
   they actually sit on. Separately, white on the brand teal `#0b8585` is
   **4.46:1**, so solid fills now use `--accent-fill: #0a7c7c` (5.02:1). The
   verified brand value itself is unchanged.

2. **A cascade collision of our own making.** The sign-in submit button rendered
   as a **white text field**. Amplify's submit button carries
   `amplify-field-group__control` as well as `amplify-button--primary`, so
   styling the former as an input (`0,2,0`) outranked the latter (`0,1,0`).
   Every structural probe passed while the primary action was the wrong colour
   — which is why `check:ui` now asserts brand surfaces by **computed colour**,
   not just by layout.

3. **A navigation bug introduced by a layout choice.** Overview and Scope were
   paired side by side for density. Siblings share a top edge, so the vertical
   scroll-spy could not tell them apart and "Scope" held the highlight
   permanently. The pair was reverted; a tie-break was added to the spy so the
   earlier section wins if this is ever attempted again.

### Dark theme

Three states, because "follow the system" is the default and stamps nothing on
the document: no attribute (follow `prefers-color-scheme`, live),
`data-theme="light"`, `data-theme="dark"`. Choosing the theme the OS is already
on clears the stored choice rather than pinning it, so there is no separate
"back to system" control. An explicit choice is applied by an inline script in
`index.html` before first paint, so it never flashes the other theme.

The dark palette was derived numerically before any CSS was written — every
foreground/background pair the console renders, including WCAG 1.4.11 non-text
contrast for a form field's boundary. Two structural notes:

- The palette is declared **twice** (media query + `[data-theme]` selector)
  because CSS cannot share a token list between them. `check:ui` parses
  `brand.css` and fails if the two drift — a token in one but not the other
  produces a half-dark UI in exactly one of the three states.
- `--brand-tile-bg` is white in BOTH themes and deliberately absent from the
  dark blocks. The Aeygis mark is a fixed asset in dark ink; a tile that
  follows the theme makes it vanish.

**Known deviation:** light-mode input borders do not meet WCAG 1.4.11 (3:1 for
a control boundary). Reaching it needs a visibly outlined field that is not
this design — the trade every soft light SaaS system makes. Dark mode does meet
it. Flagged, not silently ignored.

### Two more defects found after the first pass

4. **Half the console painted in Segoe UI Black.** Amplify's stylesheet sets
   `font-family` on `[data-amplify-theme]`, and `ThemeProvider` wraps the whole
   app — so every element without its own `font-family` inherited the auth
   theme's font rather than `--font-sans`. `document.fonts.check()` answered
   "Manrope: true" throughout, because availability is not usage. `check:ui`
   now asserts the **painted** face via `CSS.getPlatformFontsForNode`.

5. **The dev server served code that was not on disk — twice.** Vite's watcher
   coalesced rapid successive writes and kept a mid-edit transform cached
   (`authTheme.ts` on the old font stack; `App.tsx` with a new import but none
   of its usages). Every check still ran and passed against stale code.
   `check:ui` now refuses to start unless the served stylesheet matches disk
   byte-for-byte and every `className` literal survives into the served
   modules. See `docs/local-development.md`.

### Lead status is now editable (2026-08-23)

The status pill in the detail header is a control. Decisions taken with the
user:

| Decision | Choice |
|---|---|
| Who can change it | **Both staff roles** — same as every other editable field. The API already permitted it, so restricting it in the UI only would be theatre. |
| When it applies | **With "Save changes"** — part of the edit buffer, so a misclick is undoable. An `unsaved` marker sits beside the pill while the buffer differs from the record. |
| Transitions | **Any to any.** A sales pipeline is not a state machine; forcing a flow creates dead ends staff cannot correct. |
| `proposed` set automatically on approval | **Not now.** Would need a `decide-proposal` change and a deploy. Manual control closes the hole today; revisit once there is usage to look at. |

**No backend change and no deploy.** `Assessment` already granted
`contributor` + `approver` `['read','update']`, and the console's
`AssessmentEdits` already carried `status` — it just always sent the value
back unchanged.

Two things worth recording:

- **`proposed` was dead.** Nothing in the codebase ever set it:
  `submit-assessment` writes `new` or `needs_confirmation`, and the console
  only auto-moved `needs_confirmation -> in_review`. A lead could have an
  approved proposal and still sit in the queue as "New".
- **The auto-promotion is no longer invisible.** Confirming the counts used to
  rewrite the status inside `save()`, where nothing on screen showed it. It now
  happens in the checkbox handler, so the header pill shows what will actually
  be saved — and the staff member can override it afterwards.

### "Unauthorized on [internalNotes]" — root cause and fix (2026-08-23)

Saving a clinic whose Internal notes were empty failed with
`Unauthorized on [internalNotes]`. The message named the wrong field and
implied a permissions problem with the signed-in user. Neither was true.

**Root cause, read out of the generated resolver** (not inferred):

```
allowedFields:            [ ...every field... ]
nullAllowedFields:        []
isAuthorizedOnAllFields:  false
```

Both staff groups may WRITE every field and NULL none of them. Sending a
single null fails the whole mutation — the write is rejected outright, not
partially applied. Confirmed in a browser against the deployed API twice:
nulling `internalNotes` and nulling `patientCount` fail identically, so it is
not about any particular field. It follows from the model rule being
`.to(['read','update'])`.

The console sent its entire edit buffer on every save, so an untouched empty
notes field went as `internalNotes: null` every time. Changing only the status
on a clinic with no notes was therefore impossible.

**Fix — console only, no schema change and no deploy:**

- `updateAssessment` now takes a PARTIAL. `undefined` means "unchanged" and is
  stripped before the request; an all-undefined update re-reads instead of
  writing nothing.
- `AssessmentDetail.save()` diffs the buffer against the record.
- Clearing a string sends `''`, which the API accepts.
- Clearing a saved NUMBER has no representation other than null, so it is
  refused with a message that says what happened, rather than being coerced to
  `undefined` — which would drop the edit silently and report success while the
  old value survived. (The first attempt at this fix did exactly that; the
  browser check caught it.)

**Still open:** nulling any field remains impossible through this API. Making
it work means widening the model authorization (adding `create`, which also
lets staff create Assessment rows directly, bypassing `submitAssessment`'s
validation, honeypot and rate limiting) and a deploy. Not done — it is an auth
change, not a bug fix.

Also fixed alongside: `id="notes"` was on BOTH the section and the textarea.
The textarea is now `id="internal-notes"`; the section keeps `notes` because
the section nav resolves it by id.

### Sources appendix removed, acceptance simplified (2026-08-23) — DEPLOYED

Three PDF changes on request, plus one console change.

**Deployed 2026-08-23** to `326629581669` / `ca-central-1`, stack
`amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77`. Same three
Lambdas as the previous deploy — `RenderProposalPdf` (the change) plus
`price-proposal-lambda` and `submit-assessment-lambda`, which rebundle because
they import `@aeygis/domain`, where the acceptance copy lives. No schema, IAM
or resource change; AppSync endpoint unchanged. Watcher stopped afterwards.

Verified against the DEPLOYED renderer by `verify-discovery-and-delete.mjs`,
not just the CloudFormation result: all nine new assertions passed, matching
the local dry-run. The document is 449,652 -> 326,630 -> **308,023 bytes**
across the two changes.

**1. The sources-and-references appendix is gone**, and with it the pointer to
it that the regulatory page carried ("Full attribution for every figure above
is on page NN" — the compiler caught that dangling reference; nothing else
would have).

The appendix existed so no statistic stood unattributed, so removing it was
only safe if that invariant survived. Checked page by page against the rendered
document BEFORE removing it:

| Figure | Also appears | Inline attribution |
|---|---|---|
| IDC 44 / 62 / 94% | impact page | full IDC citation in the footnote |
| CIRA 45% | regulatory page | "CIRA, 2024." |
| $1,000,000 PHIPA maximum | regulatory page | "as amended in 2020" |
| 99.99% | service-levels page | "Amazon Web Services' contractual SLA" |
| **Flexera 27% / 84%** | **appendix only** | claim and source left together |

So nothing is orphaned. The renderer test that asserted "renders the sources
page" now asserts the invariant instead — that every one of those figures is
still present WITH its inline attribution — which is the thing that actually
mattered.

One correction worth recording: a PyMuPDF probe reported "Well-Architected" as
appendix-only. That was a false negative — PDF text extraction split the
hyphenated term across a line break. It is still on the migration-track and
delivery pages, where it names an AWS framework rather than quoting a figure.
The unit test caught the wrong assertion; the PDF-text probe did not. Treat
extracted-PDF-text absence as weak evidence.

**2. Page order.** The defect was the appendix sitting AFTER the signature
page. Removing it makes Acceptance last, which is where a signature page
belongs. The remaining sequence — context, risk, value, cost, delivery,
coverage, who we are, terms, sign — was already coherent and was not
reshuffled.

**3. The acceptance page states the plan but does not ask the client to pick
it.** The TICK-BOX is gone and the heading is no longer an instruction
("Select your support plan" -> "Your support plan"). The plan itself stays.

Corrected after review: the first pass removed the whole plan block and
reworded `ACCEPTANCE_STATEMENT`, which was an over-correction — showing the
plan and asking the client to choose it are different things, and only the
asking was wrong. Both are restored; the statement is back to its approved
wording verbatim.

`p.plans` is filtered to the plan the version was generated for (the Lambda
re-quotes with `supportPlan` set), so a real proposal states ONE plan. The
local preview shows two only because `preview-proposal.mjs` quotes without that
filter.

Also corrected: a comment claiming `.plan-pick`/`.tick` were still used by the
investment page. They were not — that page renders a table. `.tick` is now
genuinely unused and its rule was removed; `.plan-pick` is used by the
acceptance page again.

**4. Console:** "append-only, never edited" removed from the decision-history
summary.

Nine new assertions were added to `verify-discovery-and-delete.mjs` and
dry-run against the local render before proposing a deploy: the appendix and
its pointer absent, the plan picker and the old statement absent, and the four
inline attributions present.

### Technical discovery removed from the client PDF (2026-08-23)

On request: discovery stays in the console as a working record and no longer
appears in the client document. **26 pages -> 18**, all fitting, numbering
continuous (`npm run check:layout`), and PyMuPDF confirms the heading, the
question text, the staff answers and the appendix sub-line are all absent from
the rendered PDF while every other section survives.

The payload still carries `p.discoveryAnswers` — `toClientPayload` builds and
tests it as part of the closed client-safe type, and churning that
safety-critical module for a presentation change is not worth it. Nothing
renders it; restoring the appendix is a template change alone.

Worth recording: those answers are free text a staff member typed, and
rendering them was the one route by which unreviewed internal wording could
reach a client document. The confidentiality guard scanned it; not rendering
it removes the vector instead of policing it. The renderer test that proved
the guard caught a leaky answer now proves the answer never reaches the
document at all.

**DEPLOYED 2026-08-23** to `326629581669` / `ca-central-1`, stack
`amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77`.

`ampx sandbox` updated THREE Lambdas, not one:

| Function | Why |
|---|---|
| `RenderProposalPdf` | the intended change |
| `submit-assessment-lambda` | rebundled — imports `@aeygis/domain`, which gained the status labels |
| `price-proposal-lambda` | same |

No schema change, no new models, no IAM change, no new resources, AppSync
endpoint unchanged. The KMS-on-first-create trap in `deployment.md` does not
apply here because no model was added.

Verified against the DEPLOYED renderer, not just the CloudFormation result:
`scripts/verify-discovery-and-delete.mjs` generated a real proposal, fetched
the PDF the browser was handed, and asserted **no discovery question reaches
it** while every other section is still present. The document dropped from
449,652 to 326,630 bytes. The watcher was stopped afterwards so it cannot hold
the CDK lock (see gotcha 1 in `deployment.md`).

### A blank-pane bug found while verifying this

The queue pane rendered **nothing at all** — no skeleton, no message — when a
list error coincided with `role === 'none'`. The error branch was guarded on
`role !== 'none'` to avoid repeating the authorization string, but `'none'` is
also what the role reads as *before it resolves*, so every branch could miss.
Fixed: `roleIsNone` now distinguishes "definitively in no group" from "not
resolved yet", and there is a branch for every non-loading outcome.

The browser check hung for 40s on this instead of reporting it, because it
waited only for a queue item or the words "No assessments". It now waits for
any terminal state and reports the error text.

### Verification

- `npm run check:ui` — **127/127**, both themes, at 1600 / 1280 / 1024 / 900 / 620 px
- 227 unit tests (7 new, covering the status vocabulary and its labels)
- `depcruise` clean · root typecheck clean · console build clean
- Every DOM hook `verify-discovery-and-delete.mjs` depends on re-probed read-only
  and confirmed intact (`.queue-item`, `#new-category`, `#sched-discover`,
  `#row-area`, the Include checkboxes, the single `/^Sav(e|ing)/` button,
  `#proposal`, `#approvals`). **The full walk has not been re-run — it writes to
  AWS (generate + delete) and needs per-action approval.**

---

---

---

## END-OF-SESSION SUMMARY (2026-08-17)

### Deployed and working

| | |
|---|---|
| Account / region | `326629581669` / `ca-central-1` |
| Models | `Assessment`, `ProposalVersion`, `Approval`, `AuditEvent` |
| Mutations | `submitAssessment`, `generateProposal`, `decideProposal` |
| Lambdas | submit-assessment, price-proposal, render-proposal-pdf, decide-proposal |
| Storage | S3 bucket — versioned, CMK-encrypted, lifecycle rule |
| Encryption | all 5 tables + bucket on the customer-managed key, PITR on |

**The full chain works and was verified in a real browser**: sign in → open an
assessment → confirm counts → Generate → version appears → Approve.
Confirmed in AWS too, not just the UI: `AEY-CDB3XH v0001`, setup $65,000,
monthly $12,700, snapshot `snapshots/AEY-CDB3XH/v0001.json` (3,165 bytes).

### TWO CORRECTIONS TO EARLIER CLAIMS — read this

I previously reported Phase 2 and Phase 3 as "complete and verified" on the
strength of typechecks, unit tests, a successful build and an HTTP 200. **Both
were incomplete**, and only walking a user's path revealed it:

1. **The console rendered a BLANK PAGE.** Two React copies (root 18.3.1 vs app
   19.2.8) caused `Invalid hook call` and `null.useEffect`; separately,
   `generateClient()` ran at module scope before `Amplify.configure()`. Fixed with
   npm `overrides` + `resolve.dedupe`, and by making the data client lazy.

2. **`price-proposal` had NO CALLER.** The Lambda was deployed but never exposed
   as a mutation, so no `ProposalVersion` could exist and the approval panel was
   empty by construction. Found only when the user asked "how do I approve?".
   Fixed by adding the `generateProposal` mutation and a Generate control.

**Lesson, recorded deliberately:** every defect this session came from exercising a
real path — none from static checks. `scripts/verify-console-renders.mjs` now
drives Chrome, signs in, and walks generate → approve, so these cannot reopen
silently. Before declaring any future phase complete, re-walk it as a user.

### Documentation — Section 8 deliverables now COMPLETE

| Doc | Status |
|---|---|
| `architecture.md` | ✅ written this session |
| `deployment.md` | ✅ incl. 10 hard-won gotchas + deploy log |
| `local-development.md` | ✅ written this session |
| `aws-resources.md` | ✅ full inventory + the three-role KMS trap |
| `email-setup.md` | ✅ written this session (plan + cutover; Phase 5 not built) |
| `known-issues.md` | ✅ 10 findings outside scope |
| `PROJECT-STATUS.md` | ✅ this file |

### Test data currently in the system

Four seeded assessments (`npm run seed:demo`). All use `@aeygis-test.invalid`,
a reserved TLD. Remove with `npm run cleanup:tests`; test Cognito users with
`npm run cleanup:users`.

**Lakeshore Medical Group (`AEY-CDB3XH`) now has twelve proposal versions**
(`v0001`–`v0012`) and three approval decisions, from three rounds of live
console verification (initial build-out, a UI-redesign pass that exercised
Generate/Approve/Reject end to end including the arm-then-confirm reject
control, and the P4 PDF-rendering fix). `ProposalVersion` and `Approval` are
immutable by schema — `disableOperations(['update', 'delete'])` — so **these
cannot be deleted through the app**, only left as historical noise on this one
test record.

**`v0011` and `v0012` DO have real rendered PDFs in `proposals/client/AEY-CDB3XH/`**
now that P4 is resolved (`v0011` is the one verified byte-for-byte via curl —
134,996 bytes, valid `%PDF-1.4`). These are real S3 objects under
confidential-content prefixes, encrypted with the same CMK as everything
else, readable only by the `contributor`/`approver` Cognito groups — not a
data-exposure concern, just worth knowing they now exist rather than
assuming P4's fix left no trace.

---

## WHAT IS ACTUALLY PENDING — verified 2026-09-14

Checked against the live site, the live AWS account and the working tree, not
copied forward from the previous entry.

| # | Item | Owner | Blocks |
|---|---|---|---|
| 0 | **The platform runs on an Amplify SANDBOX stack, not a production deployment** | user + us | see [production-deployment.md](production-deployment.md) |
| 1 | **The live site is not deployed** | user | everything below it, and real lead capture |
| 2 | ~~SES production access~~ | — | ✅ **GRANTED 2026-09-16** (50,000/24 h, 14/s) |
| 3 | ~~Sender, SNS, allowlist~~ | — | ✅ **DONE 2026-09-16.** Only the SNS confirmation click remains |
| 4 | `git init` — **neither repo is under version control** | user | nothing, until something is lost |
| 5 | ~~Cognito MFA~~ ✅ **DEPLOYED AND PROVEN 2026-09-16** (`OPTIONAL` TOTP, enrolment in the account panel, `verify:mfa` 14/14). Deletion protection still **INACTIVE** | user: decide on deletion protection | nothing |
| 6 | ~~The `131` figure for `check:ui` is unverified~~ | — | ✅ **verified 2026-09-16: 131/131** |

### 0 was only discovered on 2026-09-16, and it reorders the rest

The CloudFormation stack is tagged `amplify:deployment-type = sandbox`. There is no
Amplify Hosting app for this project; every deploy has been `npx ampx sandbox` from
one laptop.

That is not merely untidy. Amplify **overrides safety settings** in a sandbox and
says so during the deploy — `keepOnDelete is ignored in sandbox deployments. The
bucket will be deleted.` The code asked for the proposals bucket to be retained and
was refused. Deletion protection is off on all five tables and the user pool, and
`npm run sandbox:delete` destroys the lot.

**It reorders the other items** because the migration changes the AppSync endpoint
and the Cognito identity pool id, and the public website hardcodes both. Deploying
the site first means deploying it twice.

Two resources make this a now-or-later decision rather than a whenever-one: the SES
configuration sets and the KMS alias have **fixed, account-unique names**, so a
branch deployment cannot be created alongside the sandbox. Today the `Assessment`
table is empty and the rest is verification residue, so the cheap path — delete,
then recreate — is available. Once real leads exist it is not, and the work becomes
a side-by-side migration with an environment-suffix code change.

Full procedure, blockers and rollback position: [production-deployment.md](production-deployment.md).

### 1 is bigger than "not deployed yet"

`health.aeygis.com` still serves the **old compiled bundle**
(`assets/index-QOvqVr0j.js`, 211 KB). Verified today:

- it still quotes **`retainer: 2400 / 6200 / 15500`** and
  **`migrationCost: 16e3 / 42e3 / 95e3`** — the Foundation/Growth/Enterprise
  figures that contradict the approved Rate Card
- `/assessment.html` **301s to `/assessment/` and then 404s**
- it contains no `AEYGIS_BACKEND_BEGIN`, so **no submission reaches this backend
  at all**

Everything built in Phases 1–6 is invisible to a prospect until this ships. The
corrected pricing, the backend intake, the new-lead notification, the retry — all
of it is waiting on one deploy that is not ours to do.

**Confidentiality is not at risk meanwhile:** `Aeygis_Cloud_Rate_Card.pdf` returns
404 on both hosts, checked today, and the `rm -rf docs` guard is present in the
local `amplify.yml` so it stays that way when the site does ship.

### 4 deserves more weight than it usually gets

Neither `aeygis-sales-platform` nor `aeygis-website-source-code` is a git
repository. There is no history, no diff, no way to see what changed between two
sessions, and no way back from a bad edit. Every "restored the guard that was
overwritten" incident in these docs was found by reading files, because there was
nothing to diff against.

Deferred by the user, repeatedly and deliberately. Recorded here at its real
weight rather than as a tidy-up task.

### 5 is a decision, not an oversight

`MfaConfiguration: OFF` and `DeletionProtection: INACTIVE` on the user pool, with
3 confirmed users. For a console holding client contact details and pricing, MFA
is the obvious hardening step. It has never been asked for, so it has never been
done — this is a prompt, not a recommendation being repeated.

---

## PENDING ITEMS - CARRY FORWARD UNTIL CLOSED

Three items are deliberately NOT done. None blocks Phase 2. All must be closed
before the system handles a real prospect. Do not let these disappear into
scrollback - they are recorded here because each is easy to forget and costly to
discover late.

### P15. Two-factor authentication for the console — ✅ CLOSED 2026-09-16

Chosen by the user 2026-09-16 (`OPTIONAL`, TOTP) ahead of the console being hosted
publicly. Three parts, and only the first is live:

| | State |
|---|---|
| Enrolment panel in `UserMenu` (`MfaSetup.tsx` + `mfaFlow.ts`, 20 tests) | ✅ built and asserted by `check:ui` in both themes |
| Pool setting `multifactor: OPTIONAL / totp` | ✅ **deployed** — the live pool reads `MfaConfiguration: OPTIONAL`, `SoftwareTokenMfaConfiguration.Enabled: true` |
| End-to-end proof (`npm run verify:mfa`) | ✅ **14/14** — enrol, confirmed with Cognito, challenged at sign-in, restored |

Deployed 2026-09-16. The synth diff predicted an in-place update and that is what
happened: the pool's `LastModifiedDate` moved, the three test accounts are intact.

`npm run verify:mfa` output:

```
PASS  entered a computed TOTP code — panel now reads "on"
PASS  Cognito confirms SOFTWARE_TOKEN_MFA is enabled for the user
PASS  Cognito confirms it is the PREFERRED method (so sign-in will challenge)
PASS  sign-in now stops at a TOTP challenge — the password alone is no longer enough
PASS  the computed code satisfied the challenge — signed in with password + TOTP
PASS  the "Turn off" button un-enrolled the account — confirmed with Cognito
PASS  test approver left password-only
```

**Why the panel had to exist:** with `OPTIONAL`, Cognito never prompts anyone — the
Authenticator only forces setup on a `REQUIRED` pool. Without an enrolment screen the
pool setting would be true and every account password-only. [§16.34](handbook/16-gotchas.md#1634-optional-mfa-on-the-pool-protects-nobody-by-itself).

#### Two defects the first run exposed, both now fixed

**1. A wait condition that looked equivalent and was not.** The script waited for the
status pill to show "anything but `checking…`". The pill's **first** render is
`unknown` — the reducer's initial state, before the effect dispatches `LOAD` — so the
wait resolved on the opening frame and the read landed on `checking…` a moment later.
The cleanup's `if (status === 'on')` branch therefore never ran, **Turn off was never
clicked**, and the test approver was left enrolled.

That is worse than it sounds. `check:ui`, `verify:email` and `verify:mfa` all sign in
as that account **with a password**, and Cognito now met them with a TOTP challenge
they do not answer. One bad wait condition in a cleanup path silently broke every
headless sign-in in the project. Both scripts now wait for a *settled* `on` or `off`.

**2. The restore was best-effort, and is now guaranteed.** It drove the UI and read
Cognito once. It now runs in a `finally` via `AdminSetUserMFAPreference`, so a crashed
browser or a missed click cannot leave the account enrolled, and it prints the exact
one-line CLI fix if even that fails. The UI "Turn off" is still exercised — as an
assertion about the button, not as the safety net.

#### An unrelated check that was quietly depending on leftover data

`check:ui`'s delivery block asserted *"there is a send-history table"*. A lead with no
deliveries correctly renders **"Nothing has been sent for this proposal."** and no
table at all. The assertion only ever passed because delivery rows from an earlier
`verify:email` run happened to be lying around; `cleanup:tests` removed them and it
went red. It now accepts either, which is the honest statement of what the UI does.

**Order from here:** the console may now be hosted — that was the precondition.

**The deploy is safe — confirmed by synth diff, not assumed (2026-09-16).** A fresh
synth against the last deployed template changes exactly two `UserPool` properties:

```
EnabledMfas       null  ->  ["SOFTWARE_TOKEN_MFA"]
MfaConfiguration  null  ->  "OPTIONAL"
```

Neither is among the properties CloudFormation replaces the pool for (`Schema`,
`UsernameAttributes`, `AliasAttributes`, `UsernameConfiguration`). **In-place update;
every account is kept.**

Gate: **376/376 tests, typecheck clean, 24/24 synth, depcruise clean (105 modules),
console build clean, `check:ui` 131/131, `check:actions` 8/8, `verify:mfa` 14/14.**

---

### P14. Console tidy-up + lead advances to `proposed` on send — ✅ CLOSED 2026-08-27

Requested 2026-08-27. Four changes, three of them console-only.

| Change | Where | Live when |
|---|---|---|
| **View PDF** moved into the action cluster beside Approve / Reject / Delete | `ApprovalPanel.tsx` | console restart |
| An **approved** version now offers **only View PDF** — no Approve, Reject or Delete | `ApprovalPanel.tsx` | console restart |
| "groups at decision: …" removed from the decision cell | `ApprovalPanel.tsx` | console restart |
| **A successful send moves the lead to `proposed`** | `send-proposal-email/handler.ts` + `leadStatus.ts` | ✅ **deployed 2026-08-26 19:40 UTC** |

#### Deployed 2026-08-26 19:40 UTC

```
✔ Updated AWS::Lambda::Function  function/send-proposal-email-lambda
✔ Deployment completed in 16.209 seconds
```

One resource, no schema change — only handler code moved. Confirmed independently of the
deploy log: the Lambda's `LastModified` reads `2026-08-26T19:40:28Z`.

**Not yet exercised end to end.** Proving it needs a real proposal emailed to the one
verified SES recipient, which sends actual mail and so needs its own approval.

#### What it does

Emailing a proposal now advances the lead: `new` / `needs_confirmation` / `in_review` →
`proposed`. `closed` is left alone — a person ended that lead and a send does not reopen it
— and an unrecognised status is left alone rather than guessed at. Only a **successful**
send counts; `blocked` and `failed` change nothing, because in both cases no proposal
exists in anybody's inbox.

Best effort and never fatal, like the audit write: it runs after SES has accepted the
message, so a failure here must not tell an approver the send failed when the client is
already reading it.

Full reasoning in [handbook §6.6](handbook/06-backend-functions.md#66-send-proposal-email).

#### On "approved shows only View PDF"

Worth being precise: **the backend does not enforce this.** `decide-proposal` would happily
append a second decision if the mutation were called directly — it has no
already-decided check. Hiding the buttons stops the accident, not the act. That is the same
distinction the codebase already draws elsewhere: *a UI that hides a button is not a
security boundary.*

It is a real gap, but a narrow one — the mutation is approver-only, and a second approval
would be additive rather than destructive in an append-only log. Not fixed here because
nobody asked for it and refusing a re-decision is a behaviour change with its own
questions (a rejected version being approved later is a legitimate sequence that must keep
working). Raised rather than silently closed.

#### Verification

`npm run check:actions` — new, free, no AWS and no dev server. Renders the real markup
against the real `brand.css` and asserts an approved row offers **only** View PDF, that an
undecided row still offers all four (so the absence check cannot pass vacuously), and that
the cluster adds no horizontal scroll the table did not already have. It compares against
the **old** layout, because this table already overflows ~137 px below about 600 px wide
and a check that only asked "does it overflow" would have blamed the wrong change.

`leadStatus.test.ts` — 10 tests, including one that fails if a status is added to the model
without anyone deciding whether a send should advance it.

Gate: **356/356 tests, typecheck clean, 24/24 synth, depcruise clean (101 modules), console
build clean, 8/8 action-layout checks.**

---

### P13. An ordinary phone number destroyed two leads — ✅ CLOSED 2026-08-26

**Found 2026-08-26 by the user, by submitting the form from the local site and noticing the
lead never arrived.** Not by any check in this repository.

Both submissions reached the Lambda, passed validation and minted a reference id, then died
on the write:

```
15:13  AEY-WX575A  ERROR  failed to persist assessment
15:15  AEY-5BFZSX  ERROR  failed to persist assessment
       errors: [ { message: "Variable 'phone' has an invalid value." } ]
```

`phone` was declared `a.phone()` — AppSync's `AWSPhone` scalar, which accepts digits with
spaces or hyphens and an optional `+` country code and refuses everything else. So
`(416) 555-1234` is rejected. Nothing else about either submission was wrong. **An optional
field destroyed two entire leads**, and the visitor was told to email us instead.

**Neither submission is recoverable.** The function deliberately never logs assessment
content, so the reference ids exist and point at nothing.

#### Why nothing caught it

Every fixture in the repository — `seed-demo-data.mjs`, `verify-lead-notification.mjs`,
`verify-email-delivery.mjs` — used `+1 416 555 01xx`, the one format that works, and
`validate.test.ts` had no phone test at all. **The tests were written by whoever wrote the
code, so they inherited its assumptions about what normal input looks like.**

#### What was done (all local, all verified locally)

| Change | Where |
|---|---|
| `phone` is now `a.string()`; format rules moved to where a failure is fixable | `amplify/data/resource.ts` |
| `phone()` normalises and warns, and **never** rejects | `submit-assessment/validate.ts` |
| A refused write is retried **smaller** — the offending field is dropped and the lead kept | `submit-assessment/salvage.ts` (new) |
| The new-lead email opens with `HEADS UP` naming anything that was dropped | `submit-assessment/notification.ts` |
| `check:synth` fails on `AWSPhone` / `AWSURL` / `AWSIPAddress` in `Assessment` | `scripts/check-synth.mjs` |
| 31 new tests, including the ten formats a real person types | `validate.test.ts`, `salvage.test.ts` |

Gate: **346/346 tests, typecheck clean, 24/24 synth, depcruise clean, 171 site checks.**
The new synth check was run against the **pre-fix** schema first and reported
`WOULD FAIL on: phone: AWSPhone`, so it is known to catch the real bug rather than merely
known to pass.

#### ✅ Deployed 2026-08-26 17:45 UTC

```
✔ Updated AWS::AppSync::GraphQLSchema  data/amplifyData/GraphQLAPI/TransformerSchema
✔ Updated AWS::Lambda::Function        function/submit-assessment-lambda
✔ Deployment completed in 49.837 seconds
```

Exactly the two resources predicted, no rollback. Synth 261 s, deploy 50 s.

**Confirmed against the live API, not the generated file.**
`aws appsync get-introspection-schema` now returns `phone: String`, and **`AWSPhone`
appears 0 times anywhere in the deployed schema.**

`npm run verify:encryption` was re-run in the same session: **all 5 tables on the CMK with
PITR, including `ProposalDelivery`** — so Gotcha 6 did not strike this time. That closes
the outstanding item noted below.

#### ✅ Proven end to end

`npm run verify:phone`, against the deployed schema. Every format submitted through the
real public mutation and read back **out of DynamoDB**:

```
PASS  "(416) 555-1234"       stored verbatim   ← the exact shape that lost two leads
PASS  "416.555.1234"         stored verbatim
PASS  "416-555-1234 ext 22"  stored verbatim   ← the extension survived
PASS  "+1 416 555 0100"      stored verbatim   ← regression guard
PASS  no salvage was needed — the schema itself accepted every number
```

That last line matters as much as the others. A salvaged write also stores a lead, so
without it a schema still refusing the field would have looked identical to a fixed one.

`npm run cleanup:tests` removed all four afterwards; the table is back to 0 rows.

The deploy was safe: `phone` appears **0 times** in the `Assessment` table's
CloudFormation. The table only tracks `id`, `status`, `submittedAt` and `submitterIpHash`
— its key and GSI attributes — so a scalar type change touches the AppSync schema and
resolvers only. **No table replacement, no data at risk, and Gotcha 6 does not apply
because no table is created.**

~~Also outstanding: `verify:encryption` has not been re-run since `ProposalDelivery` was
added.~~ **Done 2026-08-26 — all 5 tables on the CMK.**

---

### P1 + P2 — SUPERSEDED 2026-08-25: there is no dual-write any more
**Status:** replaced by P12 below · **Owner:** —

Both items described a **mirror** running alongside a formsubmit.co email:
P1 was "prove the mirror cannot break the live form", P2 was "the mirror is
inert until somebody pastes the endpoint in".

On the user's instruction the email path was removed and the backend became the
**only** destination for an assessment. Neither item describes reality now:

- there is no second path that the first could break, so P1's test has nothing
  to test;
- the endpoint is no longer optional — a blank one silently discards every
  lead — so `AEYGIS_API_ENDPOINT` is now **set**, and
  `verify-sigv4-offline.mjs` / `verify-browser-signing.mjs` assert it stays set.
  The old "must be blank" assertions would have passed on exactly the broken
  state, so they were inverted rather than deleted.

The risk did not disappear; it changed shape, and is carried forward as P12.

### P12. The backend is now the ONLY path for a lead
**Status:** open · **Owner:** user (deploy the live site) · **Blocks:** real data capture

`assets/js/assessment.js` submits to AppSync and nowhere else. That is the
intended design, and it has one consequence worth stating plainly: **if the
submission fails, the lead is gone.** There is no email fallback to catch it.

What is in place:

- the submission is **awaited**, and its outcome drives what the visitor sees;
- a failure shows an honest message — *"nobody at Aeygis has them yet"* — plus
  the Print/Save PDF route and an address to send it to, rather than a success
  screen for a lead nobody received;
- a **new-lead notification** email is sent from `submit-assessment`, so a lead
  arriving no longer depends on somebody opening the console. **Deployed and
  proven to send on 2026-08-26** — `npm run verify:notification` submitted one
  lead and SES returned message id
  `010d01a03e2a3563-dfd6e093-f9f6-4ce0-90cd-0bf2702bfdc6-000000`. Note that SES
  accepting a message is not delivery: the sender is still a `@gmail.com`
  address, so spam remains the expected destination until the domain cutover;
- `npm run verify:assessment` exercises all three outcomes (sent / refused /
  failed) in a real browser against stubs.

- a **retry** — three attempts with a short backoff (400 ms, 1200 ms) — added
  2026-08-26. See below for exactly what it does and does not cover.

**What is NOT in place:**

- **No idempotency key, so a retry can duplicate a lead.** See the longer-term
  design below.
- **Nothing survives the visitor closing the tab.** If all three attempts fail,
  the submission is gone from the browser too.
- **The live site is not deployed.** Until the user deploys it, health.aeygis.com
  is still running the old behaviour and nothing reaches this backend.

---

#### What the retry covers (2026-08-26)

Three attempts, pausing 400 ms then 1200 ms. Worst case adds about two seconds,
which costs the visitor nothing visible — the report is already on screen and
only the status line below it is still working.

| Failure | Retried? | Why |
|---|---|---|
| Transport — offline, DNS, connection reset, TLS | ✅ | No answer came back at all. This is what a retry is *for*, and it is also the safest case: with no response, it is very unlikely the write landed. |
| `408` timeout, `429` throttled, any `5xx` | ✅ | The server is having a moment. |
| A receipt saying `ok: false` | ❌ | The backend understood us and refused — a bad address, missing consent. The same payload fails identically three times; the visitor is told what to fix instead. Needs no code: a refusal *returns* rather than throws, so it leaves the loop on the first pass. |
| `4xx`, or a GraphQL error on a `200` | ❌ | The request was wrong, not unlucky. |

The classification is set where the cause is known, not inferred by the loop
from an error message — a retry loop that pattern-matches error text is one
library upgrade away from retrying the wrong things.

**The visitor sees nothing on the first attempt.** Saying "attempt 1 of 3" up
front invites worry about something that usually succeeds; the status line only
speaks once something has actually gone wrong.

Covered by six checks in `verify-sigv4-offline.mjs` (classification, recovery on
attempt 2 and 3, giving up, not retrying a refusal, not retrying a 4xx, progress
reporting) and one end-to-end case in `verify-site-assessment.mjs` where the
first attempt is refused at the connection and the second succeeds.

#### ⚠ The duplicate window this accepts

**If an attempt actually stored the assessment and only the RESPONSE was lost,
the retry writes a second copy.** Two rows for one clinic.

Accepted deliberately: a duplicate is visible in the console and a person can
merge or delete it, while a lost lead is invisible and unrecoverable. Given one
of the two has to happen, the recoverable failure is the right one to choose.

#### The longer-term solution

Two separate pieces, in the order they are worth doing.

**1. An idempotency key — removes the duplicate window.**

The browser generates one identifier per *submission* (not per attempt) and
sends it with every attempt. The backend treats it as a natural key:

- `Assessment` gains a `submissionKey` field and a secondary index on it.
- `submit-assessment` looks it up first. If a record already exists, it returns
  **the original receipt** — same `referenceId` — instead of writing again.
- The visitor sees one reference whether it took one attempt or three.

Notes for whoever builds it. The lookup and the write are not atomic, so two
attempts arriving at once could still both pass the check; a DynamoDB conditional
write on the key is what actually closes that, and it means the key has to reach
the table rather than only being checked in the resolver. The key must be
generated **before the first attempt** and reused, which is the whole point — a
key generated per attempt would be no better than what exists today. It needs a
schema change, a new index and a deploy, which is why it is not half-built now.

**2. An outbox in the browser — survives the tab closing.**

Retrying only helps while the page is open. If all three attempts fail, the
submission dies with the tab. An outbox stores the payload in `localStorage` and
retries on the visitor's next visit.

That buys less than it looks. It only works if they come back, on the same
device and browser, and the report page is usually a one-visit destination. It
also means holding a stranger's contact details and answers in their own browser
storage after they have left, which is a privacy question worth asking rather
than assuming — it is their own data on their own device, but it is retention
nobody has consented to.

**Do the idempotency key first.** It fixes a defect that exists today. The
outbox addresses a case that is rarer and buys less, and should follow real
evidence that submissions are being lost — which needs the CloudWatch alarms
that also do not exist yet.

### P3. Region residency is a GUARD, not a CONTROL — ⛔ DECLINED by user (2026-08-23)
**Status:** closed, won't-fix per user decision · was: open · **Owner:** —

**The user reviewed this (guard-vs-control explained with the bypass example
and the SCP/deny-policy fix) and decided not to add the account-level control.**
The env-var guard in `amplify/backend.ts` and the `cross-env
AWS_REGION=ca-central-1` npm scripts remain the only protection. Do not
re-raise unless the user asks; the original analysis below is kept for the
record.

`amplify/backend.ts` throws if `AWS_REGION` / `AWS_DEFAULT_REGION` /
`CDK_DEFAULT_REGION` resolves to anything other than `ca-central-1`. That catches
the common mistake, but it is best-effort only: it reads environment variables,
so anyone deploying with no region env var set (region coming from
`~/.aws/config`) bypasses it with a warning.

Canadian data residency is the core promise in `Aeygis_Cloud_Overview.pdf` and is
mandated by the Migration Framework. A guard that can be bypassed is not a
control.

**To close:** attach an SCP, or an `aws:RequestedRegion` deny condition on the
deploy role, restricting this workload to `ca-central-1`. That is the only
enforceable mechanism.

### P4. PDF rendering — ✅ RESOLVED
**Status:** closed 2026-08-18 · **Blocks:** nothing

Was blocked on one missing binary; fixing it exposed **two further gaps that
only a real end-to-end walk could have found** — each masked the next until
the one before it was fixed. All three are closed and the full chain is
proven working with a real file, not just a clean deploy log.

**1. `CHROMIUM_PACK_URL` was empty.** Fixed by adding a dedicated `ChromiumPack`
CDK stack (private S3 bucket + CloudFront with Origin Access Control) —
**not** a presigned URL, which this doc previously recommended. That
recommendation was wrong: `@sparticuz/chromium-min` does a plain
unauthenticated `fetch()` with no SigV4 support (read from its own source,
not guessed), so a presigned URL would work today and expire silently later.
Full rationale in `deployment.md` → P4.

**2. `AEYGIS_PROPOSALS_BUCKET_NAME` was never actually set on this function.**
Amplify's automatic SSM-env injection (driven by `allow.resource()` in
storage/resource.ts) does not reach a function defined via
`defineFunction(provider)` — confirmed by reading the deployed function's own
`AMPLIFY_SSM_ENV_CONFIG`, which shipped as an empty `{}`. The Chromium error
above always fired first, so this was invisible until fix #1 landed. Fixed
in `backend.ts`: publishes a dedicated SSM parameter and grants this
function's role read access to it via a same-account/same-region ARN
(not the bucket's own token, which would recreate the exact circular
dependency already documented in that file for this same variable).

**3. Every PDF download 403'd with `kms:Decrypt` denied — for the Cognito
`contributor`/`approver` group ROLES, not the Lambda.** The S3 storage rule
grants `GetObject`; nobody had granted the matching KMS decrypt on the CMK
encrypting that bucket, so the browser could generate a presigned URL but
never actually download the bytes. This is the exact three-role KMS trap
already documented in `aws-resources.md`, just a fourth instance of it —
S3 read access and KMS decrypt access are always two separate grants, and it
keeps costing an incident each time a new principal needs to read encrypted
data. Fixed in `backend.ts`: `dataKey.grantDecrypt()` on both group roles.

**Proven, not just deployed:** a real proposal version was generated through
the actual console UI, the Lambda log shows `bytes: 134996`, and the
presigned URL fetched via `curl` returns the identical `134996` bytes with a
valid `%PDF-1.4` header. The "View PDF" button in the Approvals panel is
wired to `getUrl()` with `validateObjectExistence: true`, so a version still
rendering shows "still rendering — try again in a few seconds" instead of a
dead click or a confusing error.

**A FOURTH gap — this one caught by the user, not by testing here, and worth
being honest about why.** "Verified via curl" above proved the URL and the
backend chain were correct, but it never exercised `window.open()` at all —
the actual reported symptom (clicking View PDF replaced the console tab with
the PDF, and left a second, blank tab open) lived entirely in browser tab
mechanics that curl cannot touch. Root cause, confirmed in a real browser
rather than assumed: the button passed `'noopener,noreferrer'` to
`window.open()`, and either flag makes it return `null`
**unconditionally** — not only when a popup is actually blocked. So `tab`
was always `null`, every click fell into the "popup was blocked" fallback,
and `window.location.href = url` navigated the CURRENT tab away from the
app, while the real blank tab the browser had already opened sat abandoned.
Fixed by dropping both flags (`apps/console/src/ApprovalPanel.tsx`) — a
deliberate, narrow trade, since the destination is always an S3-hosted PDF
this app itself generated the signed URL for, not arbitrary content, so the
reverse-tabnabbing risk `noopener` guards against does not apply here.
Re-verified with a test that tracks the ORIGINAL tab's URL and counts new
page targets, not just the eventual bytes: exactly one new tab opens, the
console tab is untouched, and the new tab's own fetched content is
`200 / 134996 bytes / %PDF-` — this time actually proving the click behaves
the way a user experiences it, not just that the backend is correct.

**One deliberate design correction along the way:** `ProposalVersion.pdfS3Key`
exists in the schema but has no write path — render-proposal-pdf is invoked
fire-and-forget and update/delete are disabled on that model outright
(immutability is a deliberate guarantee for the pricing content). Rather than
loosen that guarantee just to shuttle this one operational field back, the
console computes the same deterministic S3 key price-proposal already uses
(`proposals/client/${proposalId}/${versionKey}.pdf`) and asks S3 directly.
`pdfS3Key` itself is now unused by the console on purpose.

**`npm run preview:proposal` still renders the real 5-page document locally**
using your Chrome — useful for reviewing template/content changes without a
round trip through Lambda. (Page count is now 5, not 4 — see P5 below.)

---

### P5. Client proposal now reflects the assessment — ✅ RESOLVED
**Status:** closed 2026-08-19 · deployed and verified against real AWS · **Blocks:** nothing

User's question: the 20 staff-filled technical discovery answers are
consultant-level and unreviewed — not something to raw-dump into a
client-facing PDF. Instead, this adds a new "Your current environment" page
built from the **5 structured fields the prospect answered themselves on the
public intake form** — `hosting`, `mfa`, `backups`, `incidentPlan`,
`lastRiskAssessment` — not the discovery Q&A, and not a new staff-authored
free-text field. Their own answers, translated to display labels that match
the live form's own option text (verified from the production bundle, not
guessed), inserted as a new page 2 (cover → **current environment** →
investment → delivery → terms). A field the prospect never answered (or a
stored code outside the known set) maps to `null` and its tile is simply
omitted — never guessed at. If NONE of the five were answered, the whole page
is skipped and every later page's footer number shifts down automatically
(computed, not hardcoded).

**Changed:**
- `packages/pricing/src/clientPayload.ts` — new `ClientCurrentState` on
  `ClientProposalPayload`; `PayloadContext` takes the 5 raw codes; label maps
  (`HOSTING_LABELS`/`POSTURE_LABELS`/`RISK_ASSESSMENT_AGE_LABELS`) translate
  them, importing the enum vocabulary from `@aeygis/domain` (already the
  single source of truth for these codes) rather than hand-duplicating it.
- `amplify/functions/price-proposal/handler.ts` — passes
  `assessment.hosting/mfa/backups/incidentPlan/lastRiskAssessment` straight
  through (already in scope at the existing `toClientPayload()` call site).
- `amplify/functions/render-proposal-pdf/template.ts` — new page, matching
  the deck's own design system (same card/tile language already used for
  the migration phases).
- `scripts/preview-proposal.mjs` and both `assertClientSafe.test.ts` call
  sites updated for the new required context fields.
- New `packages/pricing/src/clientPayload.test.ts` — every enum value
  translates, unanswered maps to null, an unrecognized code maps to null
  (not a raw-code leak), fields are independent of each other.

**Verified locally:** `npm run typecheck` clean · `npm run test` 140/140
(135 + 5 new) · `npm run lint:boundaries` clean (no new forbidden edges —
`@aeygis/domain` is explicitly "zero dependencies, client-safe" and already
shared with client code) · `assertClientSafe`/`assertHtmlFreeOfConfidentialWords`
both pass on the new page (none of the 5 new field names or their labels
trip the confidentiality guard) · `npm run preview:proposal` rendered and
screenshotted page-by-page in a real Chrome: 5 pages, correct page numbers
(`02` inserted, `03`/`04`/`05` shifted), the deliberately-invalid test code
(`incidentPlan: 'not-a-real-code'`) correctly produced 4 tiles not 5, no
content clipping on any page.

**Deployed:** `ampx sandbox --once` against `326629581669` / `ca-central-1`,
same stack (`amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77`),
2026-08-19. Updated `price-proposal` and `render-proposal-pdf` Lambda code
only — no new resources, no schema change, no IAM change. Deployment
completed in 4.7s after synth.

**Verified against real AWS, not just a clean deploy log** — the same
"curl proved the chain, not the click" discipline from P4 applied here too:
a script signed in as the real `contributor` test user, called the actual
`generateProposal` mutation against `Lakeshore Medical Group` (`AEY-CDB3XH`,
whose real answers are `hosting=mixed mfa=no backups=no incidentPlan=unsure
lastRiskAssessment=never`), polled S3 the same way the console does, and
fetched the real PDF the real Lambda rendered (`AEY-CDB3XH v0016`, 144,384
bytes, `%PDF-1.4`). Extracted its actual text with PyMuPDF rather than
trusting page count alone: 5 pages, the new page's heading present, and all
5 of that clinic's real current-state answers found in the rendered text —
`Mixed / hybrid environment`, `No` (MFA), `No` (backups), `Not sure`
(incident plan), `Never` (last risk assessment). One false alarm caught and
resolved along the way: the first pass matched "Mixed / hybrid environment"
literally and missed it because the tile wraps that phrase onto two lines,
which PyMuPDF returns with a newline in place of the space — fixed by
normalizing whitespace before comparing, not by weakening what was checked.

---

### P6. Full 20-question technical discovery added to the client PDF — ⛔ SUPERSEDED 2026-08-23
**Status:** moot — the appendix it describes was REMOVED from the document on the
user's instruction the same week, and `grep` confirms no discovery appendix exists
in `packages/proposal-doc` today. **Nothing is waiting to ship.**

> The heading previously read *"✅ built locally, NOT YET DEPLOYED"*, which read as
> work queued up behind a deploy. It was not: the feature was deleted, not parked.
> Kept below for the reasoning, which still explains why the 20 answers are not
> client-facing.

The original entry, for the record:

**This reverses P5's own scoping decision, on the user's explicit instruction
after being shown the risk.** P5 deliberately used only the 5 structured
public-form fields and left the 20 staff-filled discovery answers out,
because they are unreviewed consultant-level shorthand with no curation
step. The user was told this directly and asked for it anyway — offered a
choice of "answered only" / "all 20 including blanks" / "staff-picked
subset" / other, and chose **all 20, verbatim, including blanks** ("Not yet
assessed" shown for anything staff hasn't filled in). Implemented as asked;
the confidentiality risk is unchanged from what was flagged, so it's worth
restating here in the record: nothing added here reviews or curates staff
answers before a client sees them.

**Changed:**
- `packages/domain/src/discoveryQuestions.ts` — the 20 questions moved here
  from `apps/console/src/discoveryQuestions.ts` (deleted). They were
  console-only before; the render-proposal-pdf Lambda needs the same
  question text, so duplicating it would have been a drift risk the moment
  either copy was edited. `parseDiscoveryAnswers()` (the same defensive
  null/string/object-tolerant parser `AssessmentDetail.tsx` already had,
  generalized) moved here too, and the console now imports both from
  `@aeygis/domain` instead of a local file.
- `packages/pricing/src/clientPayload.ts` — new `ClientDiscoveryGroup` /
  `ClientDiscoveryEntry` on `ClientProposalPayload`; every one of the 20
  questions is present every time, in the 5 groups' order, `answer: null`
  for a blank one (never skipped). `MAX_DISCOVERY_ANSWER_LENGTH` (420 chars)
  caps any one answer with a visible "… (truncated — full answer on file)"
  marker rather than letting free text of unbounded length silently overflow
  a fixed-height page — this document has no CSS auto-pagination (Chromium's
  print engine doesn't render `@page` margin boxes, so a header/footer can't
  repeat onto an auto-flowed page), so every page is authored explicitly and
  a bound on input length is what keeps that guarantee true.
- `amplify/functions/price-proposal/handler.ts` — passes
  `assessment.discoveryAnswers` straight through (raw `a.json()` value,
  parsed defensively inside `toClientPayload`).
- `amplify/functions/render-proposal-pdf/template.ts` — new "Technical
  discovery" appendix, one page per group of up to 4 entries; a group
  larger than 4 (two of the five are) splits across pages titled "(1 of 2)"
  / "(2 of 2)" rather than shrinking text to force a fit. Page numbers
  extend the same dynamic counter P5 already built, so the count is correct
  whichever optional sections are present.
- `scripts/preview-proposal.mjs` — sample data now includes a genuine
  worst-case stress test: every question in the largest group (5 questions,
  the one that splits into 2 pages) filled to near the length cap, one
  answer deliberately over the cap to exercise truncation, several left
  blank to exercise "Not yet assessed".
- 9 new tests in `packages/pricing/src/clientPayload.test.ts` (all 20
  present/ordered even with nothing recorded, blank vs. answered
  independence, verbatim + trimmed, truncation at/over/under the cap,
  malformed JSON tolerated, already-parsed-object tolerated) and 2 new
  tests in `assertClientSafe.test.ts` (the new page actually renders real
  question/answer text; a confidential phrase planted inside a discovery
  answer is still caught by the existing whole-document guard — proving
  that barrier extends to this content rather than assuming it does).

**Verified locally, not just "it compiles":**
- `npm run typecheck` clean · `npm run build --workspace @aeygis/console`
  clean (the root `tsc` doesn't cover `apps/console`, so this was run
  separately — it's the one that would have caught the `discoveryQuestions.ts`
  refactor breaking the console) · `npm run test` **151/151** (140 + 11 new)
  · `npm run lint:boundaries` clean.
- **Real overflow measurement, not just page-count.** `.page` uses
  `overflow: hidden`, so `scrollHeight` always silently reports as clamped
  to `clientHeight` regardless of true content — a dead end already learned
  the hard way earlier in this project. Instead, a Puppeteer script measured
  every page's actual last-content-element bottom edge against the page
  boundary and the footer's own top edge. Run against the worst-case stress
  test above: **all 12 pages fit, with 130–370px of margin to spare even on
  the two split "1 of 2" pages carrying 4 near-max-length answers.**
  Screenshotted both the worst-case page and the truncation-marker page to
  confirm visually, not just by bounding-box arithmetic.

**Not yet done:** touches the same two Lambda handlers P5 did
(`price-proposal`, `render-proposal-pdf` via `@aeygis/pricing`) — no effect
until deployed. **Will ask before running `npm run sandbox`.**

---

### P7. Version deletion + per-client custom questions — ✅ RESOLVED
**Status:** closed 2026-08-20 · deployed and **verified by clicking through the real UI** · **Blocks:** nothing

Two features, both explicitly chosen from options after the trade-offs were
put in writing.

#### (a) Hard delete of non-approved proposal versions

Chosen over soft delete/withdraw, with "pending **and** rejected" removable,
open to **both** staff roles. Price iteration accumulates drafts (one test
clinic reached seven) and there was no way to clear them.

**This reverses part of the original immutability design, deliberately and
narrowly.** `ProposalVersion` was `disableOperations(['update','delete'])`.
It is now `disableOperations(['update'])` — and the difference between those
two is the whole safety argument:

- `update` is **still gone**, so an approved version's CONTENT still cannot be
  altered and an approval still cannot come to mean something else. That was
  always the real guarantee; deleting a draft never threatened it.
- `delete` exists in the schema **only so the new Lambda can call it**. Staff
  authorization stays `.to(['read'])`, so no signed-in caller can invoke
  `deleteProposalVersion` on the model directly. This is the same shape the
  schema already uses for `Approval.create`, and it is the reason the
  operation could not simply be left disabled — disabling removes it for the
  Lambda too, a lesson this schema records under `Approval`.
- New `deleteProposalVersion` **mutation** is the sole route. It refuses any
  version whose LATEST decision is `approved` — matching how the console's
  badge already decides, so an approval later reversed by a rejection does not
  protect a draft forever.

**Accepted consequence, stated up front rather than discovered later:** a
rejected version's `Approval` record is immutable and survives the version it
decided on. The decision record outlives the draft and points at something
that no longer exists. That is inherent to hard delete and was flagged before
the choice was made.

**What "permanently" actually means:** the DynamoDB row is genuinely gone. The
S3 snapshot and PDF are deleted too — but the bucket is **versioned**, so
`DeleteObject` writes a delete marker and prior object versions remain until a
lifecycle rule expires them. Normal reads 404 from that moment. Recorded
precisely rather than described as an erase, because someone will eventually
rely on the distinction.

Order of operations is deliberate: **row first, artifacts second.** If the row
delete fails nothing has been touched; if an S3 delete fails the result is an
orphaned object (storage cost) rather than a surviving row whose "View PDF" is
permanently broken. The audit event is written last and is verbose on purpose —
it REPLACES the deleted row rather than complementing it, so it carries the
tier, the figures and the content hash, not just an id.

**`deleteProposalVersion` is deliberately NOT in `backend.ts`'s KMS grant
loop**, despite this file documenting four separate "forgot the KMS grant"
incidents. Reasoning is written at the call site: `DeleteObject` neither
encrypts nor decrypts, and the function's DynamoDB work goes through AppSync
with `authMode: 'iam'` so the data-source roles (already granted the key by
name) do the table access. Both halves are runtime claims, so they are to be
**verified by actually deleting a version against real AWS** — not assumed.
Over-granting a key to a function that provably does not need it is its own
quiet failure.

#### (b) Per-assessment custom discovery questions and categories

Staff can add extra questions to an existing category, or create a whole new
category, **for one client only**. The approved 20 are untouched for everyone
else. Chosen over a reusable shared library.

- Stored on a new `Assessment.customDiscoveryQuestions` (`a.json()`), shape
  `CustomDiscoverySchema` in `@aeygis/domain`.
- **Answers stay in ONE map.** `discoveryAnswers` is keyed by question id for
  both standard and custom questions — which is exactly why
  `parseCustomDiscoverySchema` REFUSES a custom id that would shadow `q01`–`q20`
  or a category id that would shadow a standard group. A custom question
  allowed to call itself `q07` would silently overwrite an approved answer.
  Pinned shut by tests at both the domain and payload level.
- **Approved numbering is never disturbed.** Standard questions keep 1–20 no
  matter what is inserted around them (the source document refers to them by
  number); custom ones number from 21 upward in render order — in-category
  extras first, then new categories. Deterministic and test-asserted.
- `effectiveDiscoveryGroups()` is the single merge both the console and the
  PDF renderer call, so what staff fill in and what the client reads cannot
  drift apart.
- Question text and category titles are length-capped (200 / 80) for the same
  fixed-page reason as P6's answer cap.

**Also refactored:** identity parsing moved to
`amplify/functions/shared/identity.ts` (two Lambdas now re-derive the caller
for audit records; two copies would be two places to drift). New `isStaff()`
alongside `isApprover()` so the two different bars are impossible to confuse
at a call site.

**Verified locally:**
- `npm run typecheck` clean · `npm run build --workspace @aeygis/console`
  clean · `npm run test` **175/175** (151 + 24 new) · `npm run lint:boundaries`
  clean (79 modules).
- New `packages/domain/src/discoveryQuestions.test.ts` — 20 tests, including
  the id-collision guard against **every** approved question id, not a sample.
- Real bounding-box overflow measurement again (not `scrollHeight`, which is
  meaningless under `overflow:hidden`): worst-case preview now renders **13
  pages, all fitting**, tightest clearance 124px — and that tightest page is
  the pre-existing phases page, not anything added here.
- Visually confirmed both halves: the new "Imaging & PACS" category page
  (questions 22/23, one answered, one "Not yet assessed"), and the custom
  question appended to "Identity & security" showing **13, 14, 15, 21** —
  approved numbering intact, custom appended.
- Added a `verify-console-access.mjs` check that
  `models.ProposalVersion.delete()` is DENIED to both staff roles. This is the
  load-bearing one: it is the only thing standing between a signed-in user and
  deleting an approved version directly, now that the operation exists in the
  schema.

#### A deploy-only failure worth keeping

The first `ampx sandbox` attempt FAILED, and neither `tsc` nor the 175-test
suite could have predicted it:

```
Object type extension 'Mutation' cannot redeclare field deleteProposalVersion
```

Re-enabling `delete` on the `ProposalVersion` model auto-generates
`Mutation.deleteProposalVersion` — the exact name the custom mutation had been
given. The collision exists only in the SYNTHESIZED GraphQL schema, so it is
invisible to type checking and to unit tests, and surfaces at deploy and
nowhere earlier. Fixed by renaming the custom mutation to
`discardProposalVersion`; the Lambda keeps the name
`delete-proposal-version`, which is an AWS resource name in a different
namespace and collides with nothing.

**General rule this implies:** when a model operation is re-enabled, its
auto-generated mutation name (`create|update|delete` + model name) becomes
reserved. A custom mutation must not reuse it.

**And the more important lesson, which the user made directly:** this feature
was reported as "verified" on green unit tests, and the very first real click
produced `mutations.deleteProposalVersion is not a function` — because the
backend had not been deployed at all, while the frontend changes WERE live in
the dev server. A visibly-clickable button against an API that cannot serve it
is worse than no button. Two process changes came out of it:

1. `scripts/verify-discovery-and-delete.mjs` — a real browser walk that proves
   these features by CLICKING: adds a custom question and category through the
   actual form controls, saves, **reloads the page** and re-checks (so
   persistence is proven against AWS rather than React state), generates,
   opens the PDF and fetches the bytes from the tab the browser actually
   opened, then arms and confirms a Delete and verifies the row is still gone
   after another reload.
2. Frontend and backend for a feature like this ship together, or the control
   does not render.

**Deploy contents (bigger than P5/P6):** new `delete-proposal-version` Lambda,
new `Assessment.customDiscoveryQuestions` field, new `discardProposalVersion`
mutation, `ProposalVersion` delete re-enabled at model level (users stay
read-only), S3 delete grants on two prefixes, plus P6's handler updates.

#### A SECOND orphaned-process incident

The retry then failed with `MultipleSandboxInstancesError`: an `ampx sandbox`
in WATCH mode, started 18-Aug, had been running for two days holding the CDK
lock and reacting to file saves. Same class as the duplicate Vite dev servers
found earlier in this project. Killed it, waited for CloudFormation to reach
`UPDATE_COMPLETE`, then deployed cleanly.

Worth noting how close this came to a false conclusion: the stack showed an
update completing seconds earlier, which looked like "the deploy already
worked". Checking `amplify_outputs.json` instead of trusting that showed it
was stale (dated 08-19) and still listed only the old three mutations —
nothing new was live. **Before restarting a sandbox, check for an existing
one:** `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered on
`*ampx*sandbox*`.

#### Verified by clicking, not by unit test

`node scripts/verify-discovery-and-delete.mjs` — the whole point of which is
that it can fail when the suite is green. Against the deployed backend:

- adds a custom question to an existing category and creates a new category,
  through the real form controls
- saves, **reloads the page**, and re-checks — so persistence is proven
  against AWS, not React state
- generates a proposal, clicks View PDF, fetches the bytes from the tab the
  browser actually opened, and confirms **the custom question is present in
  the rendered PDF text**
- confirms an APPROVED version (`v0003`) offers no Delete control
- arms and confirms a Delete, checks the list shrinks by exactly one, and
  confirms the row is still gone after another reload
- 4xx/5xx judged by URL (only a favicon 404, which is not an app defect)

**Two of my own verification tools were wrong before the code was.** The first
run reported four failures that were all script bugs — it looked for a button
labelled "Save" when the real label is "Save changes", and it measured the
version count before the panel had settled, producing a nonsensical "9 → 10".
Then a hand-rolled zlib PDF text extractor reported the custom questions
missing — and also reported the APPROVED questions missing, which are provably
present. A checker that finds nothing is broken, not proof; replaced with
PyMuPDF, which now SKIPS loudly if unavailable rather than passing when it
cannot run.

**The KMS decision was verified, not assumed.** CloudWatch shows
`snapshotDeleted: true, pdfDeleted: true` on a real delete with NO KMS grant on
this function — confirming `DeleteObject` needs no key access and that the
DynamoDB work goes through AppSync's data-source roles. The fifth instance of
the KMS trap did not happen, and now there is evidence rather than an argument.

Also fixed a copy inconsistency the walk surfaced: a hint said "Remember to
**Save**" while the button reads "Save changes".

---

### P8. Proposal depth — spend comparison, schedule, responsibility matrix — ✅ RESOLVED
**Status:** closed 2026-08-20 · deployed and verified through the real UI · **Blocks:** nothing

Came out of reading the approved source documents
(`Aeygis_Cloud_Migration_Framework.pdf`, `Aeygis_Cloud_Overview.pdf`) against
what the generated proposal actually said. Fourteen gaps were identified and
written up; five were selected and built. The proposal went from **6 pages to
18**.

**What shipped, and the decision behind each:**

1. **Spend comparison — "What this replaces".** The largest gap, and the
   cheapest to close: `monthlyItSpend`, `annualHardwareEmergency`,
   `downtimeHoursBand` and `downtimeCostBand` were all being collected and
   stored, `DOWNTIME_HOUR_MIDPOINTS` / `DOWNTIME_COST_MIDPOINTS` already
   existed in `@aeygis/domain` — and **nothing read any of them**. The prospect
   typed their figures into the public form, saw an indicative total on the
   website, and the proposal that followed never referred to it.

   **Confirmed instruction: render this ONLY when it favours the proposal.**
   Implemented literally — compared against the RECOMMENDED plan's first-year
   total (that is the one being pitched), falling back to the lowest when no
   plan is recommended. A tie does not count: the test suite pins that equal
   figures produce no section. The user was shown the counter-example before
   choosing (Bayview spends ~$18,550/yr, whose Essentials year one is $29,100)
   and chose this deliberately.

   Honesty guardrails kept in the copy regardless: the page states it is
   indicative and built from the client's own figures, names exactly which
   components the total covers, and says AWS usage fees are excluded from both
   columns. A missing component counts as ZERO, which understates current spend
   — the only safe direction, since it can make the comparison less flattering
   but never more.

2. **Migration schedule.** Framework §6 defines proposal delivery as "a
   fixed-price setup quote, recommended support tier, **and migration
   schedule**" — two of the three were present. No source document states phase
   durations, so rather than inventing them, staff enter a free-text estimate
   per phase ("2 weeks", "Weeks 3–5", "After EMR vendor sign-off"). A phase left
   blank is OMITTED rather than rendered empty; an empty row beside filled ones
   reads as an oversight.

3. **Shared responsibility matrix** (Framework §4, all seven rows verbatim).
   Per-client tailoring works by INCLUDE/EXCLUDE plus additions —
   **the approved wording is deliberately not editable.** Those rows state who
   carries which legal duty, and per-customer rewriting of approved text is
   exactly how one gets quietly weakened on the way to a signature. Hide a row
   or add beside it; do not rephrase it.

4. **Migration track** (Framework §2), derived from `hosting`: `onprem` → Track
   A, `cloud` → Track B, `mixed` → **both**, because a clinic split across local
   hardware and an unmanaged cloud account genuinely needs both routes.
   Previously the proposal printed the hosting label and stopped.

5. **IT-provider co-existence** (Framework §5) — the answer to "we already have
   an IT guy", already written and approved, previously absent.

**Naming constraint worth knowing:** the client-safety guard rejects any
payload key matching `/cost|margin|competitor|hourly|gross|cogs|internal|floor|payroll/`.
Every new field therefore says "spend" rather than "cost" — `annualIt`,
`spendPerDowntimeHour`, `annualTotal`. The guard was not weakened to
accommodate the feature; the feature was named around the guard. Note "margin"
is also a forbidden VISIBLE phrase, so it must not appear in new copy either.

**Verified:** typecheck clean · console build clean · **198/198 unit tests**
(+23) · `depcruise` clean (81 modules) · `npm run check:layout` — a new
permanent script — measured **all 18 pages** for overflow and footer collision,
tightest clearance 124px (the pre-existing phases page, not new content) · all
three new pages screenshotted and reviewed.

**A hole found in my own test and fixed before shipping:** the confidentiality
guard's golden payload had every new field `null`, so the spend, schedule and
responsibility pages never rendered in the document the guard scanned — it
would have passed for the wrong reason. Now populated, plus assertions that the
new sections actually appear AND that an excluded row is genuinely absent
rather than merely hidden.

**Then verified by clicking**, against the deployed backend, via the extended
`scripts/verify-discovery-and-delete.mjs`: filled a migration estimate,
unticked the EMR/PACS row, added a custom row, saved, **reloaded**, confirmed
all three persisted, generated a proposal, and confirmed in the rendered PDF
text that the estimate and custom row are present, the co-existence and
responsibility pages exist, and the excluded EMR row is **absent**. 33 checks,
all green.

---

### P9. Uptime resolved, and the claims it unblocked — ✅ RESOLVED
**Status:** closed 2026-08-20 · deployed and verified through the real UI · **Blocks:** nothing

#### The uptime question, settled

Three figures appear across the Aeygis materials and had been logged as an
inconsistency (`known-issues.md` #9). They are not one, except for a third:

- **99.99%** is AMAZON'S contractual SLA, covering multi-AZ COMPUTE only.
- **99.9%** is AEYGIS'S OWN target, across the whole managed service.
- **99.97%** has no documented basis anywhere. **Not used.** The live site still
  needs correcting — that repo has no source, so it stays in known-issues.

A managed-service target BELOW the infrastructure SLA is correct, not a
mistake: the service spans applications, databases, network paths and vendor
platforms that AWS's compute SLA does not cover. The gap is not cosmetic —
99.9% permits ~8h45m of downtime a year, 99.99% permits ~53 minutes. A bare
number would let a clinic plan around the wrong one by a factor of ten.

**Confirmed decision: show both, each labelled with whose commitment it is,
drop the third.** Implemented as its own page stating, per figure: the layer,
whose commitment it is, what it covers, and the downtime it permits — plus a
note that binding levels are set in the signed agreement, which is what Overview
p11 already says. Two tests assert `99.97` can never appear in the payload or
the rendered document.

#### Four pages that decision unblocked

- **Why now** — IPC direct penalty authority (Jan 2024), first penalties
  (Aug 2025, Decision 298), $1M maximum fine, CIRA's 45% figure. Dated and
  sourced, with "does not constitute legal advice" carried through.
- **What organizations gain** — the IDC figures (44% / 62% / 94%) with Overview
  p7's attribution and its "your clinic's results are scoped, not assumed"
  qualifier verbatim.
- **Security and privacy** — Overview p9's six controls plus Framework Phase 2's
  specifics (KMS AES-256, TLS 1.3, WAF, Client VPN + MFA, GuardDuty, CloudTrail,
  ca-central-1 with Canada West backup).
- **Sources and references** — every statistic in the document, attributed in
  one table. Mandatory once the above were added, not optional.

**Narrative reordered** so proof precedes price: environment → why now → what
you gain → what this replaces → investment. A number read before any reason to
want it is just a number. The proposal is now **24 pages**.

#### Two defects found by my own tooling, not by review

1. **A page overflowed its footer by 38px.** Continuity and uptime shared one
   page; `npm run check:layout` caught the collision and they were split — which
   the uptime labelling deserved anyway. This is exactly why that script exists:
   `.page` is `overflow:hidden`, so `scrollHeight` reports "fits" no matter what.

2. **A real gap in the confidentiality guard.** `extractVisibleText` decoded
   only four entities, so `esc()`-escaped apostrophes and quotes stayed as
   `&#39;` / `&quot;` — the scanner was not reading what a reader reads. Fixed to
   decode properly, with `&amp;` decoded LAST so a double-escaped `&amp;lt;`
   cannot become a real `<`. A test now proves the guard catches a confidential
   phrase written with an escaped apostrophe.

**And one defect in the verification script itself**, worth recording because it
is a recurring shape: the responsibility-toggle check passed on first run and
failed on every run after, because the first run had SAVED the row unticked and
the script bailed on finding it already off. A verification script that only
works against a fresh database is not a verification script. Rewritten to
normalise state, exercise the toggle in both directions, and always finish
unticked.

**Verified:** typecheck clean · console build clean · **210/210 unit tests**
(+12) · `depcruise` clean · `npm run check:layout` — all **24 pages** fit,
tightest 77px · **then the UI walk against the deployed backend: 44 checks, all
green**, including that both uptime figures reach the PDF *with* their
attribution and that `99.97` reaches it never.

**Still not built at this point:** reference-architecture diagram, "Why Aeygis",
the conditional "already in the cloud?" section. The signature block was held
here pending a signatory decision, and shipped in P10 below.

---

### P10. Acceptance page — and the silent clipping bug it exposed — ✅ RESOLVED
**Status:** closed 2026-08-20 · deployed and verified through the real UI · **Blocks:** nothing

#### The signature page

Two decisions taken before any copy was written:

- **Signing is INTENT TO PROCEED**, not the service agreement. It records the
  chosen plan and authorises the SOW; the SOW is the binding document. That is
  the Framework's own sequence (§6). The page states it explicitly, and states
  it ABOVE the signature lines — a reader should learn what they are agreeing to
  on the way to the pen, not on the way back.
- **Signed for `Aeygis Technologies Inc.`**, the registered entity. The document
  body still reads "Aeygis Health", the client-facing brand, confirmed
  separately earlier. Brand in the copy, legal entity on the signature, is
  normal; if the two should ever match, change them together.

Also carries the proposal reference (which names one immutable version), the
issue date, a tick-box per applicable plan, and **an actual expiry date**. That
replaced "valid for 30 days from the issue date" throughout: `validUntil` is
formatted from the SAME `Date` instance as `issuedOn` via `validUntilDate()`,
which adds days on the CALENDAR — a milliseconds offset lands an hour out across
a DST boundary, which in Canada can tip a contractual date onto the wrong day.

**No content fingerprint, deliberately.** `contentSha256` is computed OVER the
payload, so embedding it in the payload is circular. The version reference
identifies the signed document on its own, `ProposalVersion` being immutable.

#### The bug the walk found

The walk failed on "custom responsibility row present in PDF" — and the cause
was not the acceptance page. The responsibility matrix had grown to **fourteen
rows** through repeated test runs, and the matrix was a SINGLE page. `.page` is
`overflow: hidden`, so surplus rows were **present in the HTML and silently
absent from the PDF** — not truncated with a marker, simply gone.

`npm run check:layout` could not have caught it: the sample data carries one
custom row. Only the walk, against real accumulated data, exceeded the page.

Fixing it took three corrections to my own reasoning, each a guess replaced by a
measurement:

1. Chunked at a fixed **8 rows/page** → still collided. Row height is not fixed.
2. Dropped to **6** → still collided. I had been estimating row height at ~60px.
   Measured in the browser: **88px** for a full-length cell, against **593px** of
   usable height. The one number that mattered was the one being guessed at.
3. A fixed count cannot work at all: seven short approved rows should occupy one
   page, yet six tall ones overflow. Rows are now **packed against a height
   budget**, with chars-per-line calibrated against what the browser actually
   rendered (62, not 50 — at 50 the default seven-row matrix split across two
   pages for no reason).

Result: the default seven rows sit on one page; twenty-one rows with max-length
cells pack to 7/5/5/4, nothing clipped, no collision.

**Two related fixes in the same pass:**
- `overflow-wrap: anywhere` on matrix cells. A long unbroken token — a pasted
  URL, path or identifier — could not wrap, pushed the table past the page edge,
  and was silently amputated there.
- The walk now clears rows left by earlier runs before adding its own.
  Unbounded accumulation is what exposed the clipping bug, but a verification
  script should not grow the data every time it runs.

**One self-inflicted error worth recording:** a CSS comment used backticks
around a property name. The whole stylesheet lives inside a JS template literal,
so a backtick ends it — a constraint documented in that very file beside
`.rings`. The compiler caught it immediately.

**Verified:** typecheck clean · console build clean · **217/217 unit tests** ·
`depcruise` clean · `check:layout` — all **25 pages** fit · worst-case matrix
measured separately · **then the UI walk against the deployed backend: 50
checks, all green.**

**Then P11 added "Why Aeygis"** (Overview p12), placed as the closing argument:
the last substantive page before the commercial terms and the signature, so it
answers "why this vendor" at the point the reader is deciding rather than on the
way in. Four differentiator cards plus a "what to expect" row, both verbatim.

Its positioning line names the CATEGORY and no company — "National cloud
providers sell infrastructure." Deliberate twice over: the client-safety guard
rejects the word "competitor" in visible copy, and naming a rival in a document
a clinic may forward to that rival is its own risk. A unit test and a check in
the UI walk both assert the word never reaches the payload or the PDF.

**Still not built** (offered, not selected):
- **Reference architecture** (Overview p6). Held back on purpose: it is a
  DIAGRAM, and all that exists here is its extracted text. Building it means
  redrawing it in HTML rather than reproducing the deck's artwork, so it needs a
  look before it ships — or the original asset.
- **"Already in the cloud?"** (Overview p8), conditional on `hosting` being
  `cloud` or `mixed`. Pairs with the Track B page such a clinic already
  receives: they are currently told they are a takeover engagement, but not why
  that is worth doing.

**Verified:** **220/220 unit tests** · `depcruise` clean · `check:layout` — all
**26 pages** fit · UI walk against the deployed backend: **53 checks, all green.**

---

## WHERE WE ARE

### Done
- **Phase 0 — investigation & planning.** Complete and signed off.
- **1.1** Repo scaffolded — `package.json` (npm workspaces), `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `.dependency-cruiser.cjs`.
- **1.2** `deployment.md` + `aws-resources.md` created as living documents.
- **1.4** `amplify/backend.ts` region guard — throws on any region other than `ca-central-1`.
- **1.5** `amplify/auth/resource.ts` — groups `contributor`, `approver`.
- **1.6** `amplify/data/resource.ts` — `Assessment` model with **no guest rule**, plus the guest-authorized `submitAssessment` mutation returning a receipt type.
- **1.7** `submit-assessment` Lambda — validation, honeypot, per-IP rate limiting with a **secret** salt.
- **1.8** Enum/band mapping in `@aeygis/domain` — handles the live form's GraphQL-illegal values (`"1-2"`, `"15+"`, `"1-2yr"`).
- **1.9** Exact integer counts captured; band-only submissions are parked as `needs_confirmation`.
- **1.11** Live-repo edit #1 — dual-write in `assets/aeygis-enhancements.js`. **Authored, NOT deployed.**
- **1.12** Live-repo edit #2 — `docs/` excluded from the deploy artifact in `amplify.yml`. **Authored, NOT deployed.**

### Verified locally (no AWS)
- `npx tsc --noEmit` — clean. This validates every Amplify API shape used: `defineAuth`, `defineData`, `a.customType`, `a.mutation().handler(a.handler.function())`, `secondaryIndexes().sortKeys()`, `defineFunction`, `getAmplifyDataClientConfig`, and the generated `Schema['submitAssessment']['functionHandler']` type.
- `npx vitest run` -- **30/30 pass.** One caught a real bug: `\t` sits inside `\u0000-\u001F`, so the original control-character strip **deleted** tabs instead of collapsing them, turning "Bay Street" + tab + "Clinic" into "Bay StreetClinic". Fixed by excluding `\u0009-\u000D` from the strip class.
- `npx depcruise` — clean, 15 modules.
- `node --check assets/aeygis-enhancements.js` — parses.

### Deployed & verified (2026-08-17)
- **1.3** `cdk bootstrap` — CDKToolkit created in ca-central-1 (12 resources).
- **1.10** `ampx sandbox` — deployed in 171s. Stack `amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77`.
- **1.13** Guest access verified against the LIVE API with real anonymous SigV4 credentials — **13/13 checks pass**. The unauthenticated IAM role holds exactly ONE permission: `appsync:GraphQL` on `Mutation/fields/submitAssessment`. Nothing else.
- **1.15** Full resource inventory recorded in `aws-resources.md`.

`scripts/verify-guest-access.mjs` is re-runnable and exits non-zero on failure — run it after any auth or schema change.

### Hardening completed (all items the user asked to be addressed)
- **Customer-managed KMS key** — `alias/aeygis-sales-platform-data`, rotation enabled, RETAIN removal policy. Table now reports `SSEType: KMS` with that key. Closes the gap against the Framework's "KMS AES-256" claim. Took **4 attempts**; see `aws-resources.md` for the three-role-family trap, which is the single most important thing to know before touching encryption again.
- **Point-in-time recovery** — `ENABLED`. Continuous 35-day restore window.
- **Test records** — deleted; table is empty. `npm run cleanup:tests` makes this repeatable, deleting only known test addresses and reporting anything else rather than guessing.
- **Dual-write auth bug FIXED** — the original code sent an unsigned `fetch` with an optional `x-api-key`. The API has no API key and guest auth is `AWS_IAM`, so every request would have been rejected 401 and swallowed as a console warning: a mirror that silently captured nothing. It now performs the real guest flow (`GetId` → `GetCredentialsForIdentity` → SigV4-signed POST) via Web Crypto. Verified by `scripts/verify-browser-signing.mjs`, which reads the live site file and executes exactly what ships.

### Still open — AS AT PHASE 1 (historical)

> These were open **at the end of Phase 1**. Two are no longer meaningful: Task 1.14 and
> the blank `AEYGIS_API_ENDPOINT` both describe a dual-write that was removed on
> 2026-08-25. **The STATUS BOARD at the top of this file is the current list.**

- **Task 1.14** — "break AppSync, confirm the live form still submits" needs a real browser against the deployed site. The code is fire-and-forget, never awaited, try/catch-wrapped, and the signing path is now proven — but that is still reasoning plus a Node test, not a browser test. **Not recorded as verified.**
- **`AEYGIS_API_ENDPOINT` is still an empty string**, so the dual-write is inert. The endpoint is known (`https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql`) and `verify-browser-signing.mjs` asserts it stays blank, so activating it is a deliberate act. Pasting it in is what makes the live site begin sending real prospect data — left for the user to apply and deploy.
- **Region enforcement is a guard, not a control.** Add an SCP or `aws:RequestedRegion` deny on the deploy role before real client data lands.
- `.amplify/generated/env/submit-assessment.ts` is a hand-written stub so `tsc` can resolve `$amplify/env/*` pre-synth. Gitignored; overwritten by a real synth. On a fresh clone `tsc` reports one unresolved-module error until the first sandbox run — expected.

---

## PHASE 2 PROGRESS

### Done — pricing engine (`packages/pricing`, pure TS, zero AWS deps)

- **2.1** `catalog.ts` — the price book. Every figure sourced from the approved docs, with `PRICE_BOOK_VERSION` stamped into results so a historical proposal stays reproducible. Editing any number requires bumping the version.
- **2.2** `tiers.ts` — tier assignment. Named constants `ENTERPRISE_PROVIDER_THRESHOLD = 15`, `ENTERPRISE_LOCATION_THRESHOLD = 10`.
- **2.3** Eligibility is **data, not an if-chain**: `MONTHLY[tier][plan]` is either `{offered: true, ...prices}` or `{offered: false, reason}`. An ineligible combination has no price to read, so it cannot be quoted by accident. Professional ✗ Train & Walk Away and Enterprise = Full Managed only are both encoded this way.
- **2.4** Micro/Starter overlap returns **both** candidates ordered by patient count; staff choose. The docs do not resolve this, so the engine does not invent an answer.
- **2.5** Discount floor — `priceFactor < 0.9` sets `requiresExecutiveSignOff`. Pricing above list throws. **The mandatory annual check-up is never discounted** — it is a safety activity, not a commercial lever.
- **2.6** 81 unit tests, no AWS required.

**Enterprise cannot be auto-priced by construction:** the refusal is a separate branch of the return type with no price fields on it, so there is no Enterprise number to read out even by mistake. The $150k–$450k range is labelled `internalGuideRange` and is not a quote.

**`canQuote()`** refuses to price from band-derived counts, so a submission that arrived as "3-15 providers" cannot be quoted until staff confirm an exact figure.

### Verified worked examples

| Input | Result |
|---|---|
| 1 provider, 1 location, ~2,000 patients | **2 options** — Micro ($7,500) and Starter ($15,000) |
| same, ~6,000 patients | 2 options, **Starter listed first** (exceeds Micro's ~3,000 guide) |
| 10 providers, 6 locations | Professional, setup **$65,000** = $55,000 + 2×$2,000 + 2×$3,000 |
| 2 providers, 6 locations | Professional **$61,000** — location count governs, not providers |
| 15 providers | **REFUSED** — discovery call required |

### A bug this phase's tests caught

`locationBandIsAmbiguous('15+')` returned `true`, flagging 15+ locations as needing an exact count. It does not — every value in that band is Enterprise, which routes to a discovery call rather than a computed price. I had set it by symmetry with the provider bands without checking.

Caught by `band-consistency.test.ts`, which cross-validates `@aeygis/domain`'s hardcoded band tables against `assignTier`. That duplication exists because `@aeygis/domain` is deliberately dependency-free (shared with client code) and so cannot import the pricing thresholds. The test is what stops the two sides drifting.

### Done — internal console (`apps/console`, React 19 + Vite 8)

- **2.7** Cognito-authenticated shell via `<Authenticator hideSignUp>`. Self-registration is **off** — staff accounts are provisioned by an administrator. `useRole()` reads `cognito:groups` from the ID token; approver outranks contributor when a user holds both.
- **2.8** Assessment queue + detail. Deliberately uses `list` rather than the status index so a record with an unexpected status can never become invisible — a lead vanishing from the queue is worse than an unsorted list. The client exposes **read and update only**: no create, no delete, matching the schema grant. A console that could create assessments would let a rep invent a lead.
- **2.9** The 20 approved discovery questions, verbatim from the docx, grouped exactly as they already appear on health.aeygis.com so staff see the structure the prospect saw. Stored as JSON against stable ids (`q01`…`q20`) so the question set can be revised without a schema migration.
- Brand tokens in `brand.css` taken from the **verified** live-site values (navy `#0a1b33`, brand teal `#0b8585`, in-app accent `#0EA5A3`, Cormorant Garamond / Source Sans 3 / DM Mono). Light theme — the brief's "dark theme" description belongs to aeygis.com, a different design system.
- `depcruise` scope widened to include `apps/`, so the console is now covered by the confidentiality barrier too (41 modules, was 23). The console renders numbers a rep reads to a client, so it must never reach `@aeygis/pricing-internal`.

**Role checks in the UI are for shaping only, not security.** Hiding a button stops nothing — anyone can call the API directly. Enforcement is server-side via `allow.groups([...])` on the model, and from Phase 4 the approver check inside `decide-proposal`.

### Console verified with real Cognito sign-ins

`npm run verify:console` signs in via SRP as three users and exercises the exact
grant `allow.groups(['contributor','approver']).to(['read','update'])`:

| Role | read | update | create | delete |
|---|---|---|---|---|
| `contributor` | allowed | allowed | **denied** | **denied** |
| `approver` | allowed | allowed | **denied** | **denied** |
| **no group** | **DENIED** | — | — | — |

The no-group case is the one that matters most: a groupless account **can sign in**
but **cannot read anything**. Authentication is not authorization, and the API
enforces that — not merely the UI. Without this, holding any account would expose
every client's confidential business information.

`create` and `delete` are denied for both roles, so a rep cannot invent or destroy
a lead even by calling the API directly, bypassing the console entirely.

**Test users** (`.test-credentials.json`, gitignored) — remove with
`npm run cleanup:users`:
`test-contributor@` · `test-approver@` · `test-nogroup@` (all `@aeygis-test.invalid`,
a reserved TLD so no mail can ever be delivered).

---

---

## PHASE 3 PROGRESS

### Done (local, verified)

- **3.1 / 3.2** `amplify/storage/resource.ts` — three prefixes with deliberately different reach: `snapshots/`, `proposals/client/`, `proposals/internal/`. The renderer has **no ARN** for the internal prefix (barrier 4). Bucket versioning enabled, KMS-encrypted with the project CMK, `bucketKeyEnabled` to cut per-call KMS cost, plus a lifecycle rule expiring noncurrent versions after 365 days. Object Lock deliberately off (confirmed).
- **3.3 / 3.4** `ProposalVersion` model — `disableOperations(['update','delete'])` removes those mutations from the schema outright, composite identifier `(proposalId, versionKey)` so DynamoDB itself rejects a duplicate version, and **zero-padded** `versionKey` ('v0004') because Amplify GSI sort keys compare as strings.
- **3.5** `price-proposal` Lambda — refuses unconfirmed counts, refuses Enterprise, builds the client payload via whitelist, hashes **the bytes actually uploaded** (not a pre-serialisation object), writes the immutable version, and fires the renderer with `InvocationType: 'Event'` so Chromium's cold start never blocks the caller.
- **3.6** `@aeygis/pricing-internal` — the confidential Rate Card data, quarantined.
- **3.7** HTML template — modelled on the real deck (see below).
- **3.8** `render-proposal-pdf` Lambda — `@sparticuz/chromium-min`, 2048 MB / 60 s, reads only a frozen snapshot.
- **3.9** Confidentiality firewall suite — 25 tests.

### The brand finding that corrected me

I previously told the user the Overview deck's brand was distinct and implied the brief's "dark theme, teal accent" description was simply wrong. **I had only read the deck's text, never looked at it.** Rendering it showed:

- a **DARK navy cover** (`#0a1830`) with a **gold wordmark** (`#f9df5f` — the same yellow as aeygis.com) and teal accents
- **LIGHT interior pages** (`#f6f7fb`), near-black wordmark, teal eyebrow with a left bar, white cards with coloured top borders, navy callout bands
- typeface **Lato** 400/700/900 — not Cormorant Garamond
- page geometry 960×679pt, landscape 16:9

So for the deck the brief was closer to right than I credited. All colours and fonts were extracted with PyMuPDF, not eyeballed. The console follows the health-site system instead, which is why the two deliberately do not match.

### Verified by rendering, not by reasoning

`npm run preview:proposal` renders a real 4-page PDF with the system Chrome and runs the same client-safety guards the Lambda runs. Reviewed page by page. Arithmetic confirmed against the docs: 10 providers / 6 locations → setup **$65,000** (= $55,000 + 2×$2,000 + 2×$3,000), Full Managed **$24,000/mo**, first year **$353,000**; Train & Walk Away correctly **absent** for Professional.

Three defects found only by looking at the output:
1. **Logos had opaque black backgrounds.** The extracted PNGs had an all-opaque alpha channel because PDF transparency lives in a separate SMask. Re-extracted with the mask applied.
2. **Every coloured dot was invisible.** `.rings circle { fill: none }` beats a `fill="#e8b84a"` presentation attribute — CSS always wins over attributes. Scoped the rule to `.ring`.
3. **Dots were clipped** at the SVG edges; viewBox inset by 10.

Plus a compile error worth noting: a CSS comment I added contained **backticks**, which terminated the enclosing JS template literal.

### Deployed and verified against live AWS (2026-08-17)

| Resource | Verified |
|---|---|
| S3 `amplify-...-aeygisproposalsbucket04e-qwmr0tl5iuep` | versioning **Enabled**, CMK, `BucketKeyEnabled`, lifecycle rule |
| DynamoDB `ProposalVersion` | HASH `proposalId` / RANGE `versionKey`, GSI `proposalVersionsByAssessmentIdAndCreatedAt`, CMK, PITR |
| Lambda `price-proposal` | 512 MB / 30 s / nodejs22.x |
| Lambda `render-proposal-pdf` | 2048 MB / 60 s / nodejs22.x |

`tsc` is clean — the `AMPLIFY_DATA_DEFAULT_NAME` error cleared on synth exactly as
predicted, since that type is generated from the resource grants.

### A DEPLOY-TIME BUG WORTH READING BEFORE PHASE 4

**Amplify ignores `kmsMasterKeyId` when it CREATES a table.** `ProposalVersion`
came up encrypted under the AWS-managed `alias/aws/dynamodb` key, not the project
CMK. The CFN template correctly requested the CMK; synth logged success;
`describe-table` reported `SSEType: KMS`, `Status: ENABLED`. **Every signal short
of comparing the key ARN said it worked.**

`Assessment` was correct only because it pre-existed and got UPDATED.

This will hit `Approval` and `AuditEvent` in Phase 4. Two things now guard it:
- the synth log says **"requested"**, not "applied" — the old message was a false claim
- `npm run verify:encryption` compares actual key ARNs and is folded into `npm run verify`

Remediated with `update-table`; re-verified as CMK. That is convergence toward the
template, not drift from it.

### Blocked — P4 only
- **The Chromium path is entirely unproven.** The DOCUMENT is verified (rendered
  locally with real Chrome, reviewed page by page); the LAMBDA is not.
  `CHROMIUM_PACK_URL` is empty and the handler refuses to run rather than failing
  obscurely. Full steps in `docs/deployment.md` → P4.

---

---

## PHASE 4 COMPLETE (2026-08-17)

### Built
- **`Approval`** and **`AuditEvent`** models. `update`/`delete` removed from the schema outright; `create` retained but granted to NO user role, so the Lambda is the only writer.
- **`decide-proposal` Lambda** with four ordered checks:
  1. approver group, re-read from the request identity
  2. version exists
  3. expected hash == stored hash (refuses if a newer version appeared mid-review)
  4. **stored hash == actual S3 bytes** — re-hashes the snapshot now
- **Console `ApprovalPanel`** showing each version's fingerprint, sending it back as `expectedContentSha256`, plus full append-only decision history including groups-at-decision-time.

Check 4 is the one that makes the trail meaningful: `ProposalVersion` is immutable but its S3 snapshot is a SEPARATE object. Without re-hashing, a swapped snapshot would be approved as if nothing changed. Refusal is logged as `approval_refused_snapshot_tampered`.

### Verified against live AWS
| Role | read | Assessment.create | decideProposal | Approval/AuditEvent.create |
|---|---|---|---|---|
| contributor | allowed | denied | **DENIED by authorization** | **denied** |
| approver | allowed | denied | **passed auth, reached handler** | **denied** |
| no group | **DENIED** | — | — | — |

Neither role can forge an audit record. An audit trail a user can write is not an audit trail.

### The predicted bug happened, and the guard caught it
Both new tables landed on the **AWS-managed** key (`alias/aws/dynamodb`), not the CMK — Gotcha 6, exactly as forecast. `npm run verify:encryption` flagged both; remediated with `update-table`; all four tables now confirmed on the CMK with PITR.

**This will recur for every future model.** Always run `npm run verify:encryption` after a deploy that adds one.

### A contradiction the compiler caught
The first draft used `disableOperations(['create','update','delete'])` with a comment claiming it made the Lambda "the only writer" — self-defeating, since removing `create` removes it for the Lambda too. Now `['update','delete']` (structural) + no user grant on create (authorization). The comment states which mechanism does which, because they are not equally strong.

---

## PHASE 5 COMPLETE (2026-08-23 / 24) - email delivery

Full design and reasoning: `docs/phase-5-email-delivery.md`.
SES account setup and the production cutover: `docs/email-setup.md`.

### Built
- **`ProposalDelivery`** model. Append-only, same shape as `Approval`: `update`/`delete` removed from the schema outright, `create` retained for the Lambda, staff read-only. A second send is a SECOND ROW, never an edit - "we sent it twice" stays visible.
- **`sendProposalEmail` mutation**, approver-only. Takes **no recipient argument**: the address comes from the clinic's own contact details, so a caller cannot redirect a proposal by passing a different one.
- **`send-proposal-email` Lambda** with six ordered checks - approver (re-read from the request), version exists, expected hash == stored hash, **latest decision is `approved`** (read from the record, not from what the console rendered), stored hash == actual S3 bytes, and every recipient permitted.
- **SES configuration set + SNS topic** for bounces and complaints, built BEFORE the first send.
- **Console `DeliveryPanel`** - send control plus the full history including refused attempts. Renders INSIDE the approvals panel so it reads from the same versions and decisions, rather than issuing a second query that can land the other side of a decision.

### Three decisions worth not re-litigating
- **The PDF is ATTACHED, not linked.** The original plan said to send a presigned S3 link. Two of its premises were checked and both were wrong: attachments do not need raw MIME (SESv2 has a native `Attachments` field), and the cap is **40 MB**, not 10 MB - 10 MB is the **v1** API. Worse, a presigned URL created inside a Lambda **expires when the role session expires**, so the link would have died within the hour.
- **The allowlist FAILS CLOSED.** Unset or blank blocks everything; `*` allows everything. The plan originally said to "empty" it to go live, which would have meant an unset variable silently permitted email to anyone. Going live is now setting `*` - a visible, deliberate act rather than the absence of one.
- **Sending is manual and irreversible-by-design.** Approving never sends. The console arms the button (two clicks), and `check:ui` deliberately does NOT click it: a UI check must not be able to perform the one irreversible action in the system.

### Verified end to end against live AWS
`npm run verify:email` proves every refusal BEFORE anything is sent, so a broken guard is found while nothing has left the building:

| Guard | Result |
|---|---|
| recipient not on the allowlist | **blocked** - refused, not attempted |
| version not approved | **refused** |
| contributor attempts to send | **denied by AppSync**, before the Lambda runs |
| approved version, allowed recipient | **sent**, real SES message id, PDF attached |

Plus: the delivery row carries the fingerprint of the document actually mailed, the refused attempt is recorded too, and an `AuditEvent` completes the trail from approval to delivery.

### Three things went wrong. All were found by using it, not by reading it.

**1. The first real email arrived with a blank PDF.** Everything checkable was provably fine - the S3 object rendered, the SDK's base64 round-tripped byte-identical, the header was intact. The cause was the one field left unspecified: **`ContentTransferEncoding`**. The AWS reference lists three valid values and **documents no default**. A PDF's object structure is largely ASCII and survives a wrong encoding, so the reader opened the file and found 15 pages; the compressed content streams did not survive, so it drew 15 empty ones. Fix: one line, `ContentTransferEncoding: 'BASE64'`. **The lesson is not "set that field" - it is that an undocumented default on a binary payload is a silent-corruption risk.**

**2. Every audit record named its actor by a bare UUID.** Not a bug in `readIdentity` and not a Cognito misconfiguration: Amplify sends the **ACCESS token** for `authMode: 'userPool'` (confirmed in its installed source), and that token carries `sub` and `cognito:groups` but **not `email`** - exactly why group checks always worked while `actorEmail` was always null. The three audit-writing Lambdas now resolve the address from Cognito at WRITE time, matching how `decidedByGroups` is already snapshotted rather than resolved later. **Existing records keep their UUIDs** - append-only means they cannot be backfilled.

**3. Gotcha 6 struck a third time.** `ProposalDelivery` was created on the AWS-managed key while reporting `SSEType=KMS, Status=ENABLED`. Caught by `npm run verify:encryption`, remediated with `update-table`. Every signal short of comparing key ARNs looked like success.

### What this does NOT prove
**Deliverability.** The first real send landed in **spam**, and that is correct behaviour: sending from a `@gmail.com` address via SES fails SPF (only Google's servers are authorised for gmail.com), has no DKIM (SES signs domain identities, not address identities), and therefore fails DMARC. Gmail sees mail claiming to be from its own user, arriving from Amazon, unsigned.

**No code change fixes this.** It resolves only at the SES domain cutover, which needs `aeygis.com` DNS. Until then: the pipeline is proven, delivery to real clinics is not. Do not quote the sandbox test as evidence that proposals reach prospects.

---

## PHASE 6 COMPLETE (2026-08-24) - documentation

The complete end-to-end handbook, written in a new folder: **[`docs/handbook/`](handbook/README.md)**.
19 chapters, ~340 KB. Every claim in it was checked against the source or the recorded
inventory while writing - no AWS calls were made to produce it.

| Chapter | Covers |
|---|---|
| 01 Overview | The business problem, what the system produces, who uses it, what it is built on |
| 02 Features | Every capability end to end, with the rule behind each and why it exists |
| 03 Architecture | The whole system, the 8 decisions that shape everything, the verification philosophy |
| 04 Data model | Every model, every field, every authorization rule, every index, all 5 mutations |
| 05 AWS resources | **Every resource: what it is, what it does, why it was needed, what breaks without it** |
| 06 Backend functions | All 6 Lambdas step by step, plus the shared pure modules |
| 07 Pricing engine | The price book, tier rules, and all 5 confidentiality barriers in detail |
| 08 Proposal document | The 17 pages, the design values, the content honesty rules |
| 09 Console | Structure, roles, data layer, panels, theme, the Porcelain design system |
| 10 Email delivery | Phase 5 in full, including the blank-PDF incident and what it does NOT prove |
| 11 Security | Threat model, auth, authz, encryption, audit, and every known gap |
| 12 Running locally | Setup, the tour, every command, the gotchas that waste time |
| 13 Running in production | Region pinning, environments, the deploy loop, rollback, the live-site edits |
| 14 Operations | Runbooks, what to monitor, cost, scaling limits, open items |
| 15 Verification | All 7 check layers, what each catches and what it cannot |
| 16 Gotchas | 30 traps, each with the incident behind it |
| 17 Decision log | Every settled decision and why - do not re-litigate |
| 18 Glossary | Terms, plus one-page summaries of the barriers, functions and models |

### Also done in the same pass

- **`docs/README.md`** created - an index pointing at the handbook, with a
  "which document answers which question" table.
- **Two stale docs banner-flagged.** `architecture.md` and `local-development.md` both still
  said Phase 5 was not built and PDF rendering was blocked. Both now carry a
  **PARTLY SUPERSEDED** banner pointing at the handbook chapter that replaces them. Their
  content was left intact - the design reasoning and the gotchas in them are still accurate.

### What the handbook records that was not written down anywhere before

- **Why each AWS resource exists**, not just that it does - the reasoning was scattered across
  code comments in `backend.ts` and nowhere in the docs.
- **The full runbook set.** There were none.
- **The scaling limits.** `listAssessments` uses `limit: 200` with no pagination, so the queue
  silently truncates at 200 leads. That is the first limit that will actually bind.
- **The honest gaps in one place:** no MFA, no alarms, no SNS subscriber, no retention policy,
  no erasure tooling, and no version control.

---

## CRITICAL CONTEXT FOR A NEW SESSION

Findings that change the obvious approach. Do not re-derive these.

> ### ⚠ SUPERSEDED 2026-08-25 — the website repo is REAL SOURCE now
>
> The user rewrote the website repo as hand-written static HTML/CSS/JS
> (`assets/js/*.js`, `assets/css/*.css`; no `package.json`, no build step,
> `amplify.yml` says "Static site — no build required"). The compiled Vite
> bundle and `assets/aeygis-enhancements.js` were deleted.
>
> **Points 1 and 4 below were true and are no longer.** The live assessment UI
> **can** be edited, and its pricing **has** been corrected. They are kept for
> the record because they explain why this project is shaped the way it is.
>
> Two things the rewrite silently broke, both since fixed:
> * the Phase 1 dual-write was deleted along with the file it lived in — it is
>   re-ported into `assets/js/assessment.js` between the same `AEYGIS_BACKEND`
>   markers, and `scripts/verify-browser-signing.mjs` now points there;
> * the `rm -rf docs` step in `amplify.yml` was overwritten — restored, with a
>   guard that fails the build if `docs/` survives it.

1. ~~The website repo is compiled build output, not source.~~ Hashed Vite bundle, no `package.json`, no `src/`. **No longer true — see the note above.** It is still not a git repo.

2. **A Cloud Readiness Assessment is already live** on health.aeygis.com — a 5-step wizard with a client-side pricing calculator, already governed by all four published legal pages. This project does **not** replace it; it adds a first-party data path alongside it.

3. **The live form posts to a third-party relay** — `https://formsubmit.co/ajax/sales@aeygis.com` with `_captcha:"false"`. No first-party backend exists anywhere in the current site (zero hits for amplify/cognito/appsync/execute-api). Phase 1 adds a **parallel dual-write**, keeping the existing call intact.

4. ~~The live calculator's pricing is wrong.~~ **FIXED 2026-08-25.** It quoted Foundation/Growth/Enterprise at $16k/$42k/$95k setup, contradicting the approved docs on every tier name and every figure. Once the site became real source it was rewritten against the approved price book: Micro/Starter/Professional/Enterprise, three support plans, Enterprise never auto-priced. Because the form collects **bands**, it now shows an indicative **range** rather than inventing a single price. `npm run verify:pricing` compares the shipped figures against `packages/pricing` — the same module the proposal PDF is built from — so the two cannot drift apart again.

---

## PRICING RULES (authoritative — from the approved docs)

Source: `docs/Aeygis_Cloud_Migration_Framework.pdf`, `Aeygis_Cloud_Rate_Card.pdf`, `Aeygis_Cloud_Price_List_Compact.pdf` (in the **website** repo). All CAD.

| Tier | Scope | One-time setup | Train & Walk Away | Essentials | Full Managed |
|---|---|---|---|---|---|
| Micro | 1 provider, 1 location, ~3,000 patients | $7,500 | $0 + $2,000/yr check-up | $1,800/mo | $3,400/mo |
| Starter | 1–2 providers, 1 location, ~10,000 patients | $15,000 | $0 + $3,500/yr check-up | $2,600/mo | $4,900/mo |
| Professional | 3–8 base, 1–4 locations | $55,000 base<br>+$2,000/extra provider<br>+$3,000/extra location | **Not offered** | $9,500 base<br>+$700/provider<br>+$900/location | $18,000 base<br>+$1,300/provider<br>+$1,700/location |
| Enterprise | 15+ providers / hospital networks | Custom ($150k–$450k+ guide) | **Not offered** | **Not offered** | $125,000+/mo custom |

**Hard rules:**
- Professional clients **cannot** choose Train & Walk Away.
- Enterprise clients **must** be Full Managed — no T&WA, no Essentials.
- `providers >= 15` → Enterprise. `3–14` → Professional. Same `>=` convention for locations (`>= 10` → Enterprise).
- **Enterprise is never auto-priced.** Always routes to a discovery call.
- Train & Walk Away is never sold as "pay once, never again" — the yearly check-up is mandatory.
- Reduce included scope **before** discounting. Below 90% of list requires executive sign-off.
- Client always pays separately: AWS usage, AWS support plans, third-party auditors/HITRUST, legal/privacy advice, EMR/PACS vendor fees, penetration testing, endpoint security software.

**⚠ CONFIDENTIAL:** `Aeygis_Cloud_Rate_Card.pdf` is marked *"CONFIDENTIAL — Internal Use Only"* and contains delivery cost per hour, margin reasoning, and competitor analysis. It must be **structurally incapable** of reaching a client-facing PDF — see the five-barrier design in the plan. Never import `@aeygis/pricing-internal` from anything under `amplify/functions/render-proposal-pdf/`.

---

## KEY DECISIONS (confirmed — do not re-litigate)

| Decision | Choice |
|---|---|
| Pricing authority | Framework + Rate Card docs |
| Region | **ca-central-1**, pinned (Canadian data residency / PHIPA positioning) |
| Intake | Parallel dual-write from the live site; minified bundle untouched |
| Approvals | Cognito groups `contributor` + `approver`; Emad sole approver initially |
| Proposal signatory | **Aeygis Health** (not "Aeygis Technologies Inc.") |
| Brand | Proposal models `Aeygis_Cloud_Overview.pdf`; console follows health site light navy/teal |
| PDF generation | HTML template → headless Chromium in Lambda |
| S3 Object Lock / WORM | **Off** for now (cannot be retrofitted — needs new bucket + migration) |
| Email | Gmail test identity only; not blocked on DNS |
| TypeScript | Pinned **5.9.3**, not 7.x — Amplify declares no TS peer dep and `ampx` type generation is unverified against the TS 7 rewrite |

### Brand tokens (verified from the live health site)

```
--aeygis-navy:   #0a1b33      ink strong
--aeygis-navy-2: #132a4c      ink
--aeygis-teal:   #0b8585      official brand teal (meta theme-color, webmanifest)
in-app accent:   #0EA5A3      links, icons, focus ring
gradient:        #5B3FA6 → #7C5CD9 → #0EA5A3 → #2DD4C4
surfaces:        #F7FAFD / #E7F1FA / #D8E9F7   (LIGHT theme, not dark)
muted text:      #4C6480      faint: #93A6BC
display font:    "Cormorant Garamond", Georgia, serif
body font:       "Source Sans 3", Inter, system-ui
mono font:       "DM Mono", monospace
```
Note: the health site is a **light** theme. The dark theme with a yellow `#f9df5f` accent belongs to `aeygis.com`, a separate design system. Four different teals exist on the health site; `#0b8585` is the official brand value.

---

## OPEN GAPS — carry forward

| Gap | State | Trigger to revisit |
|---|---|---|
| `providers === 15` boundary | `>= 15` → Enterprise, per user | The approved docs contradict themselves; the Rate Card needs a correction pass |
| Locations threshold `>= 10` | Extended from the providers answer for consistency | **Not user-stated** — docs give no explicit location boundary |
| S3 Object Lock / WORM | Off | Cannot be retrofitted |
| SES domain identity | Gmail test only | When DNS access is obtained (Team Lead likely holds it) |
| Assessment questions | Using the existing set | User will finalize in a later round |
| `_captcha:'false'` on live form | Left as-is | Removing it inserts a captcha interstitial into the live flow — UX call |
| Console frontend framework | **React + Vite** (confirmed 2026-08-17) | Matches the existing health.aeygis.com stack |

### Unverified technical claims — confirm at build time, do not treat as settled
- Amplify `FunctionBundlingOptions` field shapes → fallback is `defineFunction`'s provider overload to a raw `NodejsFunction`
- Model-level `allow.resource()` → assumed **API-wide**, which is precisely why the five-barrier confidential design exists
- `defineStorage` has no versioning prop → L1 `CfnBucket` escape hatch; property name is CFN-derived
- `multifactor` / `accountRecovery` shapes on `defineAuth`
- That an Amplify app's own region governs `pipeline-deploy` → hence the fail-loud region guard

---

## KNOWN ISSUES IN THE EXISTING SITE — out of scope, documented only

Full detail in `docs/known-issues.md` (written in Phase 6). Summary:

1. Live calculator quotes wrong prices; no source exists to fix it cleanly.
2. `privacy.html` §3 will become inaccurate once data lands in DynamoDB; also never discloses the third-party US processor while claiming Canadian hosting. **User will update this themselves.**
3. formsubmit.co endpoint may never have been activated — historical leads may have been silently lost.
4. Health-site deep links return HTTP 404; hash routing reads `location.hash` once with no `hashchange` listener.
5. `aeygis.com`'s contact form is inert (`onsubmit="alert(...)"`, no `name` attributes) — every lead through it discarded.
6. Two incompatible brand systems between the two sites.
7. `aeygis.com` claims HIPAA (US); health site claims PHIPA/PIPEDA.
8. The Overview deck says *"no forms, no obligation"*, contradicting this pipeline's premise.
9. Uptime figures inconsistent across collateral: 99.99% / 99.9% / 99.97%.
