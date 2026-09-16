# Architecture

> **SUPERSEDED, BUT CORRECTED.** This note predates Phase 5. The claims that were wrong
> were fixed on 2026-08-26, so nothing here is untrue — but
> [`handbook/03-architecture.md`](handbook/03-architecture.md) is fuller and is the one to
> read. This is kept for the design reasoning it records.

> Companion docs: `PROJECT-STATUS.md` (what is done / pending), `deployment.md`
> (how it ships + hard-won gotchas), `local-development.md` (how to run it),
> `aws-resources.md` (what exists in AWS), `known-issues.md` (defects outside
> this build).

---

## What this system is for

Turn the approved **Cloud Migration Assessment** and **Cloud Migration Framework**
documents into a working pipeline:

```
prospect submits assessment
        ↓
staff confirm scope + fill technical discovery      (internal console)
        ↓
generate an immutable, priced proposal version      (price-proposal)
        ↓
render a branded client-facing PDF                  (render-proposal-pdf)
        ↓
approver signs off, bound to a content hash         (decide-proposal)
        ↓
email the client                                    (Phase 5 — SHIPPED 2026-08-23)
```

---

## Component map

```
┌── PUBLIC (live site, separate repo, hand-written source) ────────────┐
│  health.aeygis.com                                                   │
│    assessment form  → AppSync submitAssessment   (ONLY path)         │
│    contact form     → formsubmit.co → aws@aeygis.com                 │
└──────────────────────────────────────────────────────────────────────┘
                                  │  allow.guest(), SigV4-signed
                                  ▼
┌── BACKEND (this repo, Amplify Gen 2, ca-central-1) ──────────────────┐
│  AppSync GraphQL API                                                │
│    mutations: submitAssessment · generateProposal · decideProposal   │
│    models:    Assessment · ProposalVersion · Approval · AuditEvent   │
│                                                                     │
│  Lambdas                                                            │
│    submit-assessment    sole writer of Assessment                   │
│    price-proposal       mints ProposalVersion + frozen S3 snapshot  │
│    render-proposal-pdf  snapshot → PDF (Chromium; blocked on P4)     │
│    decide-proposal      sole writer of Approval + AuditEvent        │
│                                                                     │
│  S3   snapshots/ · proposals/client/ · proposals/internal/          │
│  KMS  one customer-managed key, all data at rest                    │
└─────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  Cognito user pool, authMode userPool
┌── INTERNAL CONSOLE (apps/console, React 19 + Vite) ──────────────────┐
│  groups: contributor (draft) · approver (sign off)                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The decisions that shape everything

### 1. Separate project, not an edit to the live site

The connected repo is **compiled build output** — hashed Vite bundle, no
`package.json`, no `src/`, not a git repo. The user confirmed no React source
exists anywhere. So the assessment UI cannot be modified; the backend is a new
project and the live site gets one small additive change.

### 2. Public writes go through a custom mutation, never a model rule

`Assessment` carries **no guest authorization rule at all**. Anonymous callers can
only invoke `Mutation.submitAssessment`, which returns a receipt
(`{ok, referenceId, message}`) and never model fields.

The tempting alternative, `allow.guest().to(['create'])`, is worse in two ways:
AppSync returns the created object from a create mutation (so the caller reads
back their own row), and it grants the unauthenticated role write access to
*every* field on the model — including any internal field added later. Read
impossibility is therefore **structural**, not rule-dependent: the unauth role's
IAM policy contains exactly one ARN.

**Verified:** the deployed unauthenticated role has a single statement,
`appsync:GraphQL` on `Mutation/fields/submitAssessment`.

### 3. A band cannot determine a price

The live form collects ranges (`"1-2"`, `"3-15"`), not numbers. Those ranges span
tiers: `"1-2"` covers Micro *and* Starter, `"3-15"` covers all of Professional and
touches Enterprise. So the system:

- stores the band for provenance, widens it to a range, and marks the record
  `needs_confirmation`
- **refuses to price** until staff enter exact integers (`canQuote()`)

Quoting from a band would be guessing at a client's bill.

### 4. Pricing is a pure module, and refusal is a type

`@aeygis/pricing` has zero AWS dependencies, so every tier and eligibility rule is
unit-testable without credentials. Two design choices matter:

- **Eligibility is data, not an if-chain.** `MONTHLY[tier][plan]` is either
  `{offered: true, …prices}` or `{offered: false, reason}`. An ineligible
  combination has no price to read.
- **Enterprise refusal is a separate branch of the return type** with no price
  fields on it. There is no Enterprise number to read out, even by mistake.

### 5. Immutability is enforced by the schema where it can be

| Model | update / delete | create |
|---|---|---|
| `ProposalVersion` | **removed from the schema** | Lambda only |
| `Approval` | **removed from the schema** | Lambda only (no user grant) |
| `AuditEvent` | **removed from the schema** | Lambda only (no user grant) |

`disableOperations(['update','delete'])` removes those mutations outright — no
future authorization edit can reintroduce them. `create` must remain, or the
Lambda itself could not write; users are excluded by granting them `read` only.

Those are **different strengths of guarantee** and the code says so explicitly.

### 6. Approval binds to bytes, not to a record

`ProposalVersion` is immutable, but the S3 snapshot it points at is a *separate
object*. So `decide-proposal` runs four ordered checks:

1. caller is in `approver` — re-read from the request identity
2. the version exists
3. the approver's expected hash matches the stored hash *(refuses if a newer
   version appeared mid-review)*
4. **the stored hash matches a fresh hash of the actual S3 bytes**

Without check 4, a swapped snapshot would be approved as though nothing changed.
`decidedByGroups` is snapshotted at decision time because Cognito membership is
mutable and history must not be.

### 7. Confidential cost data is contained structurally, five ways

`@aeygis/pricing-internal` holds delivery cost per hour, margin reasoning and
competitor analysis from a Rate Card stamped *CONFIDENTIAL — Internal Use Only*.
An authorization rule cannot protect it, because a leak would happen inside a
single Lambda's own process. So:

1. **Package boundary** — `dependency-cruiser` forbids the renderer and the
   console from importing it, transitively included. CI fails on violation.
2. **Type boundary** — `ClientProposalPayload` is closed, with no index signature,
   produced only by a hand-written whitelist mapper that never spreads.
3. **Data boundary** — cost data is not in the AppSync schema at all.
4. **IAM boundary** — the renderer has no ARN for `proposals/internal/`.
5. **Runtime guard** — `assertClientSafe()` deep-scans for forbidden key names and
   `assertHtmlFreeOfConfidentialWords()` scans rendered copy. A leak becomes a
   failed render, never a document in an inbox.

The word-scan operates on **visible text, not markup** — `margin` is a CSS
property, so scanning raw HTML would fail on every stylesheet and get deleted.

### 8. Canadian data residency

Everything is in `ca-central-1`. Amplify Gen 2 has **no region config field** —
region comes only from the AWS credential chain — so the npm scripts pin
`AWS_REGION` via `cross-env` and `backend.ts` throws on a mismatch.

⚠ That guard reads environment variables, so it is **best-effort, not a control**.
The only enforceable mechanism is an SCP or an `aws:RequestedRegion` deny on the
deploy role. Tracked as **P3**.

---

## Data flow, end to end

| Step | Actor | Guarantee |
|---|---|---|
| Submit | anonymous | Consent required; honeypot; per-IP rate limit on a **salted** hash (never a raw IP) |
| Confirm scope | contributor | Pricing refuses until exact counts exist |
| Generate | contributor | Version is immutable; snapshot frozen and hashed |
| Render | system | Only a client-safe snapshot is readable; five barriers |
| Approve | **approver only** | Bound to a content hash; groups snapshotted |
| Email | **approver only** | Six ordered checks; PDF attached; every attempt recorded as an immutable `ProposalDelivery` row. Shipped 2026-08-23. |

---

## Repository layout

```
amplify/                 backend — the source of truth, no console edits
  auth/ data/ storage/
  functions/             submit-assessment · price-proposal
                         render-proposal-pdf · decide-proposal
packages/
  domain/                shared vocabulary + band↔count mapping, zero deps
  pricing/               CLIENT-SAFE engine, pure TS
  pricing-internal/      ⚠ CONFIDENTIAL — quarantined by CI
apps/console/            internal console
layers/chromium/         staged Lambda layer (gitignored)
scripts/                 seed + verification tooling
```

### Two brand systems, deliberately

| Surface | Look | Why |
|---|---|---|
| Proposal PDF | **dark cover + light interiors**, gold wordmark, teal accents, **Lato**, 960×679pt | Matches `Aeygis_Cloud_Overview.pdf`, the artefact clients already receive. Colours and fonts extracted from the PDF with PyMuPDF, not eyeballed. |
| Console | light navy/teal, Cormorant Garamond | Matches health.aeygis.com, so internal tooling feels like the product |

They intentionally differ. The brief described the brand as "dark theme, teal
accent" — accurate for the deck's cover, not for the health site.

---

## Verification strategy

The strongest lesson of this build: **static checks prove almost nothing about
whether the system works.** Every defect found came from exercising a real path.

| Layer | Command | Catches |
|---|---|---|
| Unit | `npm test` (135) | pricing rules, validation, identity parsing |
| Boundary | `npm run lint:boundaries` | confidential imports |
| Deployed API | `npm run verify` | guest access, role permissions, encryption |
| **Browser** | `node scripts/verify-console-renders.mjs` | **the app actually running** |

The browser check exists because the console typechecked, built, and served
HTTP 200 while rendering a **blank page**. It now signs in and walks
generate → approve.

Run `npm run verify:encryption` after **any** deploy that adds a model: Amplify
ignores `kmsMasterKeyId` on table *create*, so a new table lands on the AWS-managed
key while the template, the synth log and `describe-table` all report success.
