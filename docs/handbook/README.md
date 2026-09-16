# Aeygis Sales Platform — Complete Handbook

> **What this is.** The full, end-to-end documentation of this system: what it does, how
> it is built, what runs in AWS and why, how to run it on your machine, and how to run
> it in production.
>
> **Written:** 2026-08-24. **Last verified against the code and the live account:**
> 2026-08-26.
>
> **Accurate as of:** Phase 6 complete. Since it was first written the public site was
> rewritten as real source, its pricing was corrected against the approved price book, the
> assessment form became backend-only with a retry, and a new-lead notification was added
> and proven.
>
> Everything here was checked against the source and the deployed account while writing.
> Where something is unproven, it says so.

---

## Read this in order if you are new

| # | Document | What you get from it |
|---|---|---|
| 1 | [Overview](01-overview.md) | What the business problem is and what the system produces. Start here. |
| 2 | [Features](02-features.md) | Every capability, from public intake to emailing a client. |
| 3 | [Architecture](03-architecture.md) | How the pieces fit, and the eight decisions that shape everything else. |
| 4 | [Data model](04-data-model.md) | Every table, every field, every authorization rule. |
| 5 | [AWS resources](05-aws-resources.md) | Every resource in the account: what it is, what it does, why it exists, what breaks without it. |
| 6 | [Backend functions](06-backend-functions.md) | The six Lambdas, step by step. |
| 7 | [Pricing engine](07-pricing-engine.md) | The price book, tier rules, and the five confidentiality barriers. |
| 8 | [The proposal document](08-proposal-document.md) | The 17-page client PDF and how it is rendered. |
| 9 | [The console](09-console.md) | The internal app staff actually use. |
| 10 | [Email delivery](10-email-delivery.md) | Phase 5 in full, including what it does *not* prove. |
| 11 | [Security](11-security.md) | Authentication, authorization, encryption, audit, confidentiality. |
| 12 | [Running locally](12-running-locally.md) | Get it working on your machine. |
| 13 | [Running in production](13-running-in-production.md) | Deploying, environments, and the SES cutover. |
| 14 | [Operations](14-operations.md) | Runbooks, monitoring, cost, and what to do when something breaks. |
| 15 | [Verification](15-verification.md) | Every test and check, and what each one actually catches. |
| 16 | [Gotchas](16-gotchas.md) | The traps this project has already hit, each with the incident behind it. |
| 17 | [Decision log](17-decisions.md) | Every decision that is settled, and why. Do not re-litigate these. |
| 18 | [Glossary](18-glossary.md) | Terms used throughout. |

---

## If you only have five minutes

**What it is.** A sales pipeline for Aeygis Health. A clinic fills in a cloud readiness
assessment on the public website. Staff review it in an internal console, confirm the
exact size of the practice, and price it. The system produces an immutable, priced
proposal version and renders it as a 17-page branded PDF. An approver signs it off,
bound to a fingerprint of the exact bytes. Then the approver emails it to the clinic,
with the PDF attached, and every attempt is recorded permanently.

**Where it runs.** AWS account `326629581669`, region `ca-central-1` — Canada, and only
Canada. Canadian data residency is the product's core promise, so region is pinned in
every command and asserted at build time.

**How it is built.** AWS Amplify Gen 2 (TypeScript, code-first infrastructure). Cognito
for staff sign-in, AppSync for the GraphQL API, DynamoDB for records, S3 for documents,
six Lambda functions for the logic, SES for email, one customer-managed KMS key for
everything at rest. The internal console is React 19 + Vite.

**The rule that shapes the most code.** Anything a client could see must be structurally
incapable of containing confidential cost and margin data. That is enforced five separate
ways, not one. See [Pricing engine](07-pricing-engine.md).

**What is not finished.** Real email deliverability. Proposals sent today land in spam,
because the sender is a Gmail address rather than a verified `aeygis.com` domain. That is
blocked on DNS access, not on code. See [Email delivery](10-email-delivery.md).

---

## How this handbook relates to the older docs

The files in `docs/` above this folder were written phase by phase, as the work happened.
All of them were re-checked on 2026-08-26 and corrected where they had gone stale, so none
of them asserts anything untrue. Two are superseded by fuller handbook chapters.

| Older doc | Status |
|---|---|
| `docs/PROJECT-STATUS.md` | **Still the live tracker.** Updated every session. Read it for "where are we right now". |
| `docs/deployment.md` | Accurate on gotchas and the deploy log. Its P4 section is now closed. |
| `docs/aws-resources.md` | Accurate. [AWS resources](05-aws-resources.md) here supersedes it with the reasoning attached. |
| `docs/email-setup.md` | Accurate. The SES account procedure lives there and is not duplicated here. |
| `docs/phase-5-email-delivery.md` | Accurate. The design record for Phase 5. |
| `docs/local-development.md` | Corrected 2026-08-26. Superseded by [Running locally](12-running-locally.md), which is fuller. |
| `docs/architecture.md` | Corrected 2026-08-26. Superseded by [Architecture](03-architecture.md), which is fuller. |
| `docs/known-issues.md` | Accurate. Problems in the *existing websites*, outside this build. |

This handbook does not replace `PROJECT-STATUS.md`. That file answers "what changed this
week". This one answers "how does the whole thing work".

---

## Two rules that apply to anyone working on this

**1. No AWS action without explicit permission.** Every command that creates, changes, or
deletes anything in AWS needs a specific go-ahead first. Approval for one action is not
approval for the next. Reading is free; writing is not.

**2. The `amplify/` directory is the source of truth.** Nothing is created by hand in the
AWS console. Anything that exists in the account but not in `amplify/` is drift, and
should be removed or written into code. The two deliberate exceptions — the SES email
identity and the SNS subscription — are documented in
[AWS resources](05-aws-resources.md) with the reason they cannot be code.
