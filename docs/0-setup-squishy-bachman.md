# Aeygis Sales Pipeline — Architecture, Build Plan & Progress Tracker

> **For future sessions:** this file is the single source of truth for where this project stands.
> Update the Status Board and Task Tracker at the end of **every** work session, not just at phase boundaries.
> A mirrored copy lives at `docs/PROJECT-STATUS.md` in the new repo (created in Phase 1, Task 1.1).

---

## ⛔ OPERATING RULES — READ BEFORE ANY WORK

**1. No AWS action without explicit per-action permission.** This is absolute and applies to every session, not just the first.

Tasks marked **`⛔AWS`** in the tracker below touch a real AWS account. For each one: stop, state exactly what will be created/changed/deleted and in which account and region, and wait for a clear go-ahead. Approval for one AWS action is **not** approval for the next.

This specifically includes — non-exhaustively:
- `cdk bootstrap`, `ampx sandbox`, `ampx pipeline-deploy`, any `amplify` deploy
- Creating or modifying Cognito pools, AppSync APIs, DynamoDB tables, S3 buckets, Lambda functions, IAM roles/policies
- SES identity verification, sending **any** email (including test sends), production-access requests
- Creating Amplify Hosting apps, branches, or domain associations
- Any `aws` CLI call that is not strictly read-only

**Free to do without asking:** writing code locally, unit tests that don't call AWS, documentation, reading the existing repo, `tsc`/lint/build that doesn't deploy.

**2. Do not deploy to the live site.** The two Phase 1 edits to `aeygis-website-source-code` are authored locally and handed over for the user to review and deploy. Do not trigger a live-site build.

**3. Documentation is written as work happens**, not batched at the end. `docs/deployment.md` and `docs/aws-resources.md` are living documents updated in the same session as the change they describe — an undocumented resource is an incomplete task.

---

## STATUS BOARD

| | |
|---|---|
| **Last updated** | 2026-08-17 |
| **Current phase** | Phase 0 — Investigation & Planning |
| **Phase 0 status** | ✅ **COMPLETE** — plan awaiting sign-off |
| **Next action** | Get plan approval, then start Phase 1 Task 1.1 |
| **Blocked on** | Nothing. DNS was the only blocker; deliberately routed around via Gmail test identity. |
| **Code written** | None yet. No repo created, no AWS resources provisioned. |

**Goal in one sentence:** Turn the approved Cloud Migration Assessment + Framework documents into a working pipeline — public intake → internal console → branded proposal PDF → logged approval → emailed delivery — built on Amplify Gen 2 in `ca-central-1`, without touching the live site's existing behavior.

**Definition of done:** All six phases signed off, a proposal generated from a real assessment and emailed end to end, and all documentation deliverables written.

---

## TASK TRACKER

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

### Phase 0 — Investigation & Planning ✅ COMPLETE
```
[x] 0.1  Confirm Context7 MCP registered                          → connected
[x] 0.2  Search for relevant skills                               → 222 plugins searched
[x] 0.3  Locate + read both source docs                           → + 4 extra pricing PDFs found
[x] 0.4  Review live sites (aeygis.com, health.aeygis.com)        → both audited
[x] 0.5  Determine repo type: source vs compiled output           → compiled only, confirmed
[x] 0.6  Verify AWS/SES/Amplify facts (no parametric claims)      → all cited
[x] 0.7  Resolve open decisions with user                         → 12 answered
[x] 0.8  Write architecture + phase plan                          → this file
[ ] 0.9  Obtain plan sign-off                                     → AWAITING
```

### Phase 1 — Public assessment intake
```
[ ] 1.1  Scaffold repo + create docs/PROJECT-STATUS.md FIRST
[ ] 1.2  Start docs/deployment.md + docs/aws-resources.md (living, from day one)
[ ] 1.3  Configure [profile aeygis-ca] region=ca-central-1        ⛔AWS (bootstrap)
[ ] 1.4  amplify/backend.ts region guard — verify it FAILS on wrong region
[ ] 1.5  auth/resource.ts — groups: contributor, approver
[ ] 1.6  data/resource.ts — Assessment model (NO guest rule) + submitAssessment mutation
[ ] 1.7  submit-assessment Lambda — validation, honeypot, per-IP rate limit
[ ] 1.8  Enum mapping layer ("1-2"/"15+"/"1-2yr" are invalid GraphQL enums)
[ ] 1.9  Capture exact integer provider/location counts (bands can't determine tier)
[ ] 1.10 First sandbox deploy                                     ⛔AWS
[ ] 1.11 LIVE REPO EDIT #1: dual-write in aeygis-enhancements.js:12-24  (author only, DO NOT deploy)
[ ] 1.12 LIVE REPO EDIT #2: exclude docs/ from amplify.yml        (author only, DO NOT deploy)
[ ] 1.13 Verify: guest can create, guest CANNOT read              ⛔AWS
[ ] 1.14 Verify: break AppSync → live form still submits via formsubmit.co
[ ] 1.15 Record every provisioned resource in docs/aws-resources.md
[ ] 1.16 Update status board → PHASE 1 SIGN-OFF GATE
```

### Phase 2 — Internal meeting console
```
[ ] 2.1  packages/pricing — pure TS, zero AWS deps
[ ] 2.2  Tier assignment + named threshold constants
[ ] 2.3  Professional formula, eligibility rules, Enterprise never auto-priced
[ ] 2.4  Micro/Starter dual-option presentation
[ ] 2.5  90% discount sign-off gate
[ ] 2.6  Unit tests — every tier × plan combination + both boundaries
[ ] 2.7  Cognito-authed console shell, contributor/approver aware
[ ] 2.8  Assessment list + detail views
[ ] 2.9  20-question technical discovery as staff-filled fields
[ ] 2.10 Update status board → PHASE 2 SIGN-OFF GATE
```

### Phase 3 — Proposal generator
```
[ ] 3.1  storage/resource.ts — snapshots/, proposals/client/, proposals/internal/
[ ] 3.2  S3 versioning via CfnBucket escape hatch (Object Lock deliberately OFF)
[ ] 3.3  ProposalVersion model + disableOperations(['update','delete'])
[ ] 3.4  Zero-padded versionKey + conditional counter for allocation
[ ] 3.5  price-proposal Lambda → immutable version + frozen snapshot + contentSha256
[ ] 3.6  packages/pricing-internal + dependency-cruiser CI barrier
[ ] 3.7  HTML template modeled on Aeygis_Cloud_Overview.pdf, signed "Aeygis Health"
[ ] 3.8  render-proposal-pdf Lambda — @sparticuz/chromium-min  ⚠ HIGHEST RISK
[ ] 3.9  Confidential-leak test suite (all 5 barriers)
[ ] 3.10 Deploy + verify PDF renders end to end               ⛔AWS
[ ] 3.11 Update deployment.md (Chromium layer/bundling) + aws-resources.md
[ ] 3.12 Update status board → PHASE 3 SIGN-OFF GATE
```

### Phase 4 — Approval workflow
```
[ ] 4.1  Approval + AuditEvent models, immutable, Lambda-only writer
[ ] 4.2  decide-proposal Lambda — approver-group check + contentSha256 binding
[ ] 4.3  Snapshot decidedByGroups at decision time
[ ] 4.4  Console approval UI showing exactly which version is approved
[ ] 4.5  Verify: contributor CANNOT approve
[ ] 4.6  Update status board → PHASE 4 SIGN-OFF GATE
```

### Phase 5 — Email delivery
```
[ ] 5.1  Verify rajaemadhussain@gmail.com as BOTH sender and recipient  ⛔AWS (SES identity)
[ ] 5.2  send-proposal-email Lambda + SES IAM grant via CDK escape hatch
[ ] 5.3  SES_ENABLED flag + verified-recipient allowlist
[ ] 5.4  Presigned S3 link delivery (NOT attachment)
[ ] 5.5  SNS bounce/complaint notifications BEFORE first send      ⛔AWS
[ ] 5.6  Send-status rows so sandbox rejections surface in console
[ ] 5.7  First real test send                                      ⛔AWS (sends email)
[ ] 5.8  Write docs/email-setup.md incl. exact domain cutover steps
[ ] 5.9  Update status board → PHASE 5 SIGN-OFF GATE
```

### Phase 6 — Docs + handoff
`deployment.md`, `aws-resources.md` and `email-setup.md` are **already written** by this point — Phase 6 reviews and completes them rather than starting from scratch.
```
[ ] 6.1  docs/architecture.md — components, data flow diagram, decisions + why
[ ] 6.2  docs/deployment.md — REVIEW/COMPLETE: per-phase deploy, environments,
         how to promote changes, rollback, the region-guard requirement
[ ] 6.3  docs/local-development.md — run frontend + backend locally, end to end
[ ] 6.4  docs/aws-resources.md — REVIEW/COMPLETE: reconcile against actual account
[ ] 6.5  docs/email-setup.md — REVIEW/COMPLETE: sandbox state + domain cutover
[ ] 6.6  docs/known-issues.md — the 9 out-of-scope findings
[ ] 6.7  Final PROJECT-STATUS.md reconciliation
```

---

## KNOWN GAPS — carry forward, do not lose

**Decided-but-worth-revisiting:**
| Gap | Current state | Trigger to revisit |
|---|---|---|
| `providers === 15` boundary | `>= 15` → Enterprise, per user | Approved docs contradict themselves here; correct the Rate Card |
| Locations threshold `>= 10` | Extended from providers answer by consistency | Docs give **no** explicit location boundary — not user-stated |
| S3 Object Lock / WORM | **OFF** | Cannot be retrofitted — needs new bucket + migration |
| SES domain identity | Gmail test only | When DNS access is obtained (Team Lead likely holds it) |
| Assessment questions | Using existing set | User will finalize in a later round |
| `_captcha:'false'` | Left as-is | Removing it adds a captcha interstitial to the live flow — UX call |

**Unverified technical claims** (flagged during design; confirm at build time):
- Amplify `FunctionBundlingOptions` field shapes — fallback is `defineFunction`'s provider overload
- Model-level `allow.resource()` — assumed API-wide, which is *why* the 5-barrier design exists
- `defineStorage` has no versioning prop → L1 escape hatch, property name is CFN-derived
- `multifactor` / `accountRecovery` shapes on `defineAuth`
- That an Amplify app's own region governs `pipeline-deploy` — hence the fail-loud guard

**Permanently out of scope** — see `docs/known-issues.md`:
1. **Live calculator quotes wrong prices** ($16k/$42k/$95k vs approved $7,500/$15,000/$55,000). No React source exists, so no clean fix. Live commercial exposure needing its own decision.
2. **Privacy policy needs updating** (user will action) — §3 email-only claim becomes untrue; third-party US processor undisclosed while claiming Canadian hosting; §4 cross-references the wrong section.
3. **formsubmit.co may never have been activated** — historical leads may have been silently lost.
4. Health-site deep links 404; hash routing reads `location.hash` once, no `hashchange` listener.
5. `aeygis.com` contact form is inert — every lead through it discarded; no contact email published.
6. Two incompatible brand systems; four different teals on the health site alone.
7. `aeygis.com` claims HIPAA (US); health site claims PHIPA/PIPEDA.
8. Overview deck says *"no forms, no obligation"* and sequences call → proposal, contradicting this pipeline.
9. Uptime figures inconsistent: 99.99% / 99.9% / 99.97%.

---

## CONTEXT (why this shape)

Aeygis sells AWS cloud migration to Ontario healthcare clinics. Investigation changed four premises:

1. **The connected repo is compiled build output.** Hashed Vite bundle, no `package.json`, no `src/`, not a git repo. User confirmed no real source exists anywhere. → New work is a **separate project**.
2. **A Cloud Readiness Assessment is already live** on health.aeygis.com — a 5-step wizard with a client-side calculator, already governed by all four published legal pages. Not greenfield.
3. **It posts to a third-party relay** — `formsubmit.co` with `_captcha:"false"`. No first-party backend exists (0 hits for amplify/cognito/appsync).
4. **Live pricing contradicts the approved docs.** Docs are authoritative; live figures cannot be corrected without source.

### Decisions (confirmed — do not re-litigate)

| Decision | Choice |
|---|---|
| Pricing authority | **Framework + Rate Card docs.** 4 tiers × 3 support plans. |
| Tier boundary | `providers >= 15` → Enterprise; `3–14` → Professional. Same `>=` for locations. |
| Micro vs Starter overlap | **Present both**, staff chooses. |
| Intake | Live site **repointed via parallel dual-write**. Minified bundle untouched. |
| Region | **ca-central-1**, pinned. Amplify, Hosting, and SES all verified available. |
| Approvals | Groups `contributor` + `approver`. Emad sole approver; any designated employee can contribute. |
| Proposal signatory | **Aeygis Health** |
| Brand | Proposal models `Aeygis_Cloud_Overview.pdf`. Console follows health site's light navy/teal. |
| PDF generation | HTML → headless Chromium. (No PDF/DOCX skill exists in the 222-plugin catalog.) |
| WORM | Off for now. |
| Email | Gmail test identity only. Not blocked on DNS. |
| Scope | Full pipeline. |

---

## ARCHITECTURE

**New repo `aeygis-sales-platform`, separate Amplify Gen 2 app, same AWS account, ca-central-1.** The existing site repo is never restructured; it receives two small additive edits in Phase 1.

```
Public form (live site, existing UI)
   └─ submitToSales()  ── formsubmit.co  (UNCHANGED, still emails sales@)
                       └─ AppSync Mutation.submitAssessment  (NEW, additive)
                                    ↓ allow.guest()
                          submit-assessment Lambda ── validates, honeypot, rate-limits
                                    ↓
                          DynamoDB: Assessment
                                    ↓
Internal console (Cognito: contributor | approver)
   ├─ fills 20-question technical discovery
   ├─ price-proposal    → @aeygis/pricing → immutable ProposalVersion + S3 snapshot
   ├─ render-proposal-pdf (Chromium) → S3 proposals/client/ (versioned)
   ├─ decide-proposal   → approver-only → Approval + AuditEvent (immutable)
   └─ send-proposal-email → SES ca-central-1 (sandbox, allowlisted)
```

```
aeygis-sales-platform/
├─ amplify/
│  ├─ backend.ts                    # region guard, S3 versioning, IAM grants
│  ├─ auth/resource.ts  data/resource.ts  storage/resource.ts
│  └─ functions/{submit-assessment,price-proposal,decide-proposal,
│                render-proposal-pdf,send-proposal-email}/
├─ packages/
│  ├─ pricing/                      # PURE TS, zero AWS deps, unit-testable
│  └─ pricing-internal/             # CONFIDENTIAL cost/margin — unreachable from renderer
├─ apps/console/
└─ docs/PROJECT-STATUS.md           # mirror of the Status Board above
```

### Key design decisions and why

**Public write via a custom mutation, not a model rule.** `Assessment` carries **no** guest authorization rule at all. Guests can only call `Mutation.submitAssessment`, which returns `{ok, referenceId}` — never model fields. Granting guests `createAssessment` directly would echo the created row back *and* let an attacker write every field on the model, including internal fields added later. Read-impossibility is structural, not rule-dependent.

**Region pinning has no config field.** Gen 2 resolves region purely from the AWS credential chain. `defineBackend` and `DataProps` have no region parameter. Hence the profile + fail-loud guard — and note the guard is best-effort; the only *enforceable* control is an SCP or `aws:RequestedRegion` deny on the deploy role.

**Confidential cost data is walled off structurally, not by policy.** `allow.resource()` grants appear API-wide, so an authorization rule cannot protect it. Five independent barriers: one-way package dependency enforced in CI; a closed `ClientProposalPayload` type with a whitelist mapper (never spread); cost data kept out of the AppSync schema entirely; renderer IAM scoped to `proposals/client/*`; and a pre-render key scan plus a golden-payload test asserting no cost literals reach the output HTML.

**Immutability is enforced by schema, not convention.** `disableOperations(['update','delete'])` removes the mutations outright. Approvals bind to a `contentSha256` of the frozen snapshot, so an approval can never silently refer to changed content. `decidedByGroups` snapshots membership at decision time, because current membership is mutable and an audit trail must not depend on it.

**Version keys are zero-padded strings** (`v0004`) — Amplify GSI sort keys concatenate as strings, so `versionNumber: 10` would sort before `2`.

**Pricing is a pure TS module** so rules are unit-testable without AWS. Enterprise-never-auto-priced is enforced at the type level. Boundary constants are named and centralized so they flip in one line.

---

## VERIFICATION

- **Pricing**: unit tests per tier × plan, every eligibility rejection, both thresholds, Micro/Starter dual-option. Pure TS, no AWS.
- **Guest write / zero guest read**: unauthenticated `submitAssessment` succeeds; `getAssessment`/`listAssessments` fail authorization.
- **Confidential firewall**: golden-payload render contains no cost literals, no `margin`/`competitor`/`cost per hour`; renderer IAM policy has no `proposals/internal/*` ARN.
- **Immutability**: `updateProposalVersion`/`deleteProposalVersion` absent from the deployed schema.
- **Region**: every resource ARN contains `ca-central-1`.
- **Dual-write safety**: with AppSync deliberately broken, the live form still submits via formsubmit.co.
- **Artifact exclusion**: a build produces no `docs/` path.
- **End to end**: live form → console → price → PDF → approve → email at the Gmail address. Contributor cannot approve.

---

## RISKS

- **Chromium in Lambda is the likeliest time sink** — ≥1600 MB, 30 s timeout, `@sparticuz/chromium` marked external. Amplify's bundling field shapes are unverified; fallback is the provider overload to a raw `NodejsFunction`. Budget half a day.
- **Cold start is several seconds** — mitigated architecturally: rendering is async, console polls for `pdfS3Key`. Not worth provisioned concurrency at sales volume.
- **Version allocation needs a conditional counter** written directly against DynamoDB. Design so a lost race retries rather than overwrites.
- **Referential integrity is not enforced** — `decide-proposal` fetches-then-validates; `contentSha256` makes tampering detectable.
- **Cross-origin** — the public form is on a different origin from the new API. Confirm it can reach the identity pool.
