# Documentation

## Start here

**[📘 The Handbook](handbook/README.md)** — the complete end-to-end documentation. Features,
architecture, every AWS resource and why it exists, the data model, the pricing engine, the
console, email delivery, security, running locally, running in production, operations,
verification, gotchas, and the decision log.

**[PROJECT-STATUS.md](PROJECT-STATUS.md)** — the live tracker. Where the project stands right
now, updated every work session. Read this for "what changed this week".

---

## The rest

| File | Covers | Status |
|---|---|---|
| [handbook/](handbook/README.md) | Everything, in 18 chapters plus an index | ✅ Verified against the code and the live account 2026-08-26 |
| [PROJECT-STATUS.md](PROJECT-STATUS.md) | Session-by-session status, pending items, operating rules | ✅ Living document |
| [deployment.md](deployment.md) | Deploy procedure, the gotcha list, the deploy log | ✅ Current |
| [aws-resources.md](aws-resources.md) | The provisioned resource inventory, verified against the account | ✅ Current |
| [email-setup.md](email-setup.md) | SES account setup and the production cutover procedure | ✅ Current |
| [phase-5-email-delivery.md](phase-5-email-delivery.md) | The Phase 5 design record | ✅ Current |
| [known-issues.md](known-issues.md) | Problems in the **existing websites** — out of scope, recorded | ✅ Current |
| [architecture.md](architecture.md) | The original architecture note | ✅ Corrected 2026-08-26. Superseded by [handbook/03](handbook/03-architecture.md), which is fuller. |
| [local-development.md](local-development.md) | The original local-setup note | ✅ Corrected 2026-08-26. Superseded by [handbook/12](handbook/12-running-locally.md), which is fuller. |
| [0-setup-squishy-bachman.md](0-setup-squishy-bachman.md) | The Phase 0 architecture plan, kept for the record | 📄 Historical |

---

## Which document answers which question

| Question | Go to |
|---|---|
| What does this system do? | [handbook/01 Overview](handbook/01-overview.md) |
| How do I run it? | [handbook/12 Running locally](handbook/12-running-locally.md) |
| What is in our AWS account, and why? | [handbook/05 AWS resources](handbook/05-aws-resources.md) |
| Why is the code shaped like this? | [handbook/17 Decision log](handbook/17-decisions.md) |
| Something is broken — what do I check? | [handbook/14 Operations](handbook/14-operations.md) |
| I am about to touch encryption / SES / the renderer | [handbook/16 Gotchas](handbook/16-gotchas.md) **first** |
| What is left to do? | [PROJECT-STATUS.md](PROJECT-STATUS.md) and [handbook/14.8](handbook/14-operations.md#148-open-items-carried-forward) |
| Why do proposals land in spam? | [handbook/10.8](handbook/10-email-delivery.md#108--deliverability--the-sandbox-proves-the-pipeline-not-that-mail-arrives) |
