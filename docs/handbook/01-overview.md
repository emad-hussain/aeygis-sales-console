# 1. Overview

← [Handbook index](README.md) · Next: [Features](02-features.md)

---

## The business this serves

Aeygis Health sells cloud migration to Canadian healthcare clinics. The pitch is
Canadian data residency — clinic data stays in Canada, in AWS `ca-central-1`, encrypted
with keys the company controls — plus the privacy and compliance work that comes with
handling patient data under PHIPA and PIPEDA.

The commercial product is a **migration engagement**: a one-time setup fee plus an
ongoing monthly support plan. There are four sizes of engagement (Micro, Starter,
Professional, Enterprise) and three support plans (Train & Walk Away, Essentials, Full
Managed). What a clinic pays depends on how many providers it has and how many
locations. The exact rules come from two approved documents — the Cloud Migration
Framework and the Rate Card — and those documents, not anyone's judgement, are the
authority.

---

## The problem this system solves

Before this system existed, the sales process looked like this:

1. A clinic filled in a cloud readiness assessment on `health.aeygis.com`.
2. That form emailed the answers to `sales@aeygis.com` through a third-party relay.
3. Somebody read the email, worked out a price by hand, wrote a proposal in a document
   editor, and emailed it.

Four things go wrong with that, and all four are the reason this project exists.

**Prices drift from the approved documents.** A hand-built proposal is a hand-typed
number. The live website's own calculator proved the point: it quoted tiers called
*Foundation / Growth / Enterprise* at $16,000 / $42,000 / $95,000 setup, while the approved
documents say *Micro / Starter / Professional / Enterprise* at $7,500 / $15,000 / $55,000
across three support plans. **Not one figure or tier name agreed.**

That went unnoticed for a long time because nothing compared the two. It was fixed on
2026-08-25, once the website became editable source, and `npm run verify:pricing` now
checks the shipped figures against the same pricing module the proposal PDF is built from —
so they cannot drift apart again without a check going red.

**Nothing records who approved what.** A discount below the floor is supposed to need
executive sign-off. Without a system, "sign-off" is a message in a chat window that
nobody can find six months later.

**Confidential cost data sits next to client-facing figures.** The Rate Card is stamped
*CONFIDENTIAL — Internal Use Only* and contains delivery cost per engineer-hour, margin
reasoning, and competitor pricing. In a document editor, that material is one
copy-paste away from a prospect's inbox.

**No lead data is kept.** The form posts to a third-party relay and to nothing else, so
there is no queue, no history, and no way to answer "what happened to that clinic that
enquired in March".

---

## What the system produces

One thing, well: **an immutable, priced, approved, branded proposal that reaches the
client with a record of every step.**

```
 clinic fills in the public assessment form
                  │
                  ▼
 ┌────────────────────────────────────────────┐
 │  Assessment record                         │   the lead, with consent recorded
 │  status: needs_confirmation                │   and the submitter's IP stored only
 └────────────────────────────────────────────┘   as a salted hash
                  │
     staff confirm exact provider and location counts,
     fill in 20 technical discovery questions
                  │
                  ▼
 ┌────────────────────────────────────────────┐
 │  ProposalVersion  v0001                    │   immutable. Priced by a pure engine
 │  + frozen JSON snapshot in S3              │   from the approved price book.
 │  + SHA-256 of those exact bytes            │
 └────────────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────┐
 │  17-page branded PDF                       │   rendered by headless Chromium from
 │  proposals/client/<id>/v0001.pdf           │   the snapshot and nothing else
 └────────────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────┐
 │  Approval                                  │   approver-only. Bound to the hash,
 │  decision: approved                        │   with the approver's groups snapshotted
 │  contentSha256: 3f9a...                    │   as they were at that moment.
 └────────────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────┐
 │  ProposalDelivery                          │   the email, PDF attached. Every
 │  status: sent | blocked | failed           │   attempt recorded, including refusals.
 └────────────────────────────────────────────┘
                  │
                  ▼
              AuditEvent trail across all of it
```

Every box in that diagram is append-only. Nothing in the chain can be edited after the
fact — a change is always a new record, never a rewrite of an old one.

---

## Who uses it

| Person | What they do | How they are identified |
|---|---|---|
| **A prospect** (anonymous) | Fills in the public assessment form. Never signs in, never sees anything else. | Cognito identity pool, unauthenticated role. Holds exactly one permission. |
| **A contributor** (staff) | Reviews leads, confirms counts, fills in technical discovery, prices, generates proposal versions, discards drafts. Cannot approve, cannot send. | Cognito user pool, `contributor` group. |
| **An approver** (staff) | Everything a contributor can do, **plus** approving or rejecting a version and emailing it to the client. | Cognito user pool, `approver` group. |

Group membership is the *only* difference between the two staff roles. Promoting someone
is a Cognito group change, not a code change.

There is no self-registration. Staff accounts are provisioned by an administrator.

---

## What it is built on

| Layer | Choice | Note |
|---|---|---|
| Infrastructure | **AWS Amplify Gen 2** | Code-first: the whole backend is TypeScript in `amplify/`, synthesized to CloudFormation via CDK. |
| Region | **`ca-central-1`** | Pinned in every npm script, asserted at build time. Canadian residency is the product promise. |
| Auth | **Cognito** user pool (staff) + identity pool (anonymous) | Two groups: `contributor`, `approver`. |
| API | **AppSync** GraphQL | Default auth mode is the user pool; the public form uses the identity pool explicitly. |
| Records | **DynamoDB**, five tables | All on one customer-managed KMS key, all with point-in-time recovery. |
| Documents | **S3**, three prefixes | Versioning on, KMS-encrypted, lifecycle rule on old versions. |
| Logic | **Lambda**, six functions | Node.js 22. |
| Email | **SES v2** | Configuration set + SNS topic for bounces. Still in the SES sandbox. |
| Console | **React 19 + Vite 8** | Runs on a developer's machine or is built as a static bundle. |
| Language | **TypeScript 5.9.3**, pinned | Not 7.x: Amplify declares no TypeScript peer dependency and `ampx` type generation is unverified against the 7.x rewrite. |

---

## The repository

```
aeygis-sales-platform/
├── amplify/                    the backend. Source of truth — nothing is created by hand.
│   ├── auth/resource.ts        Cognito: two groups
│   ├── data/resource.ts        the GraphQL schema: 5 models, 5 mutations
│   ├── storage/resource.ts     S3: three prefixes with different reach
│   ├── backend.ts              everything CDK-level: KMS, S3 hardening, IAM, SES, CloudFront
│   └── functions/              six Lambdas + shared helpers
├── packages/
│   ├── domain/                 shared vocabulary. Zero dependencies, client-safe.
│   ├── pricing/                the price book and quote engine. Pure, client-safe.
│   └── pricing-internal/       ⚠ CONFIDENTIAL cost/margin. Quarantined by CI.
├── apps/console/               the internal console (React + Vite)
├── layers/chromium/            staged Lambda layer for the PDF renderer (gitignored)
├── scripts/                    seeding and verification tooling
├── ui/                         design studies — the four console candidates and colour sets
└── docs/                       documentation, including this handbook
```

There is a second, separate repository — `aeygis-website-source-code` — which holds the
**live public websites**. This project never deploys it. It contains two small, additive
edits authored by this project and handed to the user to review and deploy themselves.

---

## What state the project is in

| | |
|---|---|
| **Phases 1–5** | Complete and deployed to the `ca-central-1` sandbox. |
| **The full pipeline** | Proven end to end against real AWS: a real assessment became a real proposal, was approved, and was emailed with the PDF attached. |
| **Verification** | 356 unit tests, 24 synth checks, 171 live-site checks, 131 browser UI checks, 53 real-UI walk checks, plus live-AWS guest/role/encryption checks. All passing. |
| **Not proven** | **Real-world email deliverability.** Sending from a Gmail address via SES fails SPF, DKIM and DMARC, so proposals land in spam. This resolves only at the SES domain cutover, which needs `aeygis.com` DNS access. |
| **Open items** | **P12** — the backend is the only path a lead has, so a failed submission loses it (a retry absorbs transient failures; the idempotency key is designed, not built). **SES production access**, blocked on DNS. **The live site is not deployed**, so nothing reaches this backend yet. |
| **Version control** | **None.** There is no git history for this repository. That is the largest self-inflicted risk in the project. |

Full detail on each: [Operations](14-operations.md) and `docs/PROJECT-STATUS.md`.
