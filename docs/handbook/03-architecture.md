# 3. Architecture

← [Features](02-features.md) · [Index](README.md) · Next: [Data model](04-data-model.md)

---

## 3.1 The whole system on one page

```
╔══ PUBLIC ═══════════════════════════════════════════════════════════════════╗
║  health.aeygis.com  — a separate repo, hand-written static source           ║
║                                                                             ║
║   assessment form  ────▶ AppSync Mutation.submitAssessment  (ONLY path)     ║
║   contact form     ────▶ formsubmit.co ──▶ aws@aeygis.com                   ║
╚═════════════════════════════════════════════════════════════════════════════╝
                                   │
              Cognito identity pool, unauthenticated role
              GetId → GetCredentialsForIdentity → SigV4-signed POST
                                   │
                                   ▼
╔══ BACKEND — this repo, Amplify Gen 2, ca-central-1 ═════════════════════════╗
║                                                                             ║
║  AppSync GraphQL API                                                        ║
║    mutations   submitAssessment      guest + authenticated                  ║
║                generateProposal      contributor | approver                 ║
║                decideProposal        approver only                          ║
║                discardProposalVersion contributor | approver                ║
║                sendProposalEmail     approver only                          ║
║    models      Assessment · ProposalVersion · Approval                      ║
║                AuditEvent · ProposalDelivery                                ║
║                                                                             ║
║  Lambda                                                                     ║
║    submit-assessment        sole writer of Assessment                       ║
║    price-proposal           mints ProposalVersion + frozen S3 snapshot      ║
║    render-proposal-pdf      snapshot → 17-page PDF (headless Chromium)      ║
║    decide-proposal          sole writer of Approval                         ║
║    delete-proposal-version  sole route to deleting a draft                  ║
║    send-proposal-email      sole writer of ProposalDelivery; the only        ║
║                             thing that reaches outside the account          ║
║                                                                             ║
║  DynamoDB   5 tables, one customer-managed KMS key, PITR on all             ║
║  S3         snapshots/ · proposals/client/ · proposals/internal/            ║
║             versioned, KMS-encrypted, lifecycle on old versions            ║
║  SES        configuration set → SNS topic (bounces, complaints)            ║
║  CloudFront private S3 bucket holding the Chromium browser pack            ║
╚═════════════════════════════════════════════════════════════════════════════╝
                                   ▲
              Cognito user pool, authMode 'userPool'
                                   │
╔══ INTERNAL CONSOLE — apps/console, React 19 + Vite 8 ═══════════════════════╗
║  groups:  contributor (draft, price, discard)                              ║
║           approver    (+ approve, reject, send)                            ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

---

## 3.2 The eight decisions that shape everything else

### Decision 1 — a separate project, not an edit to the live site

**This decision was made when the website repository was compiled build output** — a
hashed Vite bundle with no `package.json`, no `src/` and no git repository, so the live
assessment UI could not be modified at all.

**That changed on 2026-08-25**, when the user rewrote the site as hand-written static
HTML/CSS/JS. The live UI can now be edited, and its pricing has been corrected in place.
The decision to keep the backend as a separate project still stands on its own merits —
the two have different deploy cadences, different risk profiles, and the backend must not
be reachable from a public build — but the original reason no longer applies.

The live site receives two edits from this project, authored here and handed to the user
to deploy. **This project never deploys the live site.**

1. The assessment form's submission path, in `assets/js/assessment.js` between the
   `AEYGIS_BACKEND` markers. It began as a mirror alongside a formsubmit.co email;
   the email was removed on the user's instruction and this is now the **only**
   destination for a lead. The separate contact-sales form still emails, because the
   backend has no model for a general enquiry.
2. A `rm -rf docs` step in the live repo's `amplify.yml` build phase, so the confidential
   Rate Card cannot be published by a future deploy.

### Decision 2 — public writes go through a custom mutation, never a model rule

`Assessment` carries **no guest authorization rule at all**. Anonymous callers can invoke
exactly one thing: `Mutation.submitAssessment`, which returns a receipt and never model
fields.

The obvious alternative, `allow.guest().to(['create'])`, is worse in two ways:

- AppSync returns the created object from a create mutation, so the caller reads back
  their own row including server-generated fields.
- It grants the unauthenticated role write access to **every field on the model** —
  including any internal field added later (`assignedTo`, `internalNotes`). That is a
  privilege-escalation surface that grows silently as the model grows.

Because no `Assessment` field carries a guest rule, the unauthenticated IAM role's policy
contains **no `Assessment` ARNs whatsoever**. Read-impossibility is structural, not
rule-dependent.

**Verified against the deployed account.** The unauthenticated role holds exactly one
statement:

```json
{
  "Action": "appsync:GraphQL",
  "Resource": "arn:aws:appsync:ca-central-1:326629581669:apis/fuufxnavzfgshfme7635fq5obq/types/Mutation/fields/submitAssessment",
  "Effect": "Allow"
}
```

**If that policy ever grows beyond one statement, treat it as a security regression.**

### Decision 3 — a band cannot determine a price

Covered in [Features §2.2](02-features.md#22-band-widening-and-the-refusal-to-guess).
Architecturally the point is that the *refusal* is a first-class return type, not an
exception thrown from somewhere deep. `canQuote()` is a separate, explicit gate so the
call site has to handle it.

### Decision 4 — pricing is a pure module, and refusal is a type

`@aeygis/pricing` has **zero AWS dependencies**, enforced by a dependency-cruiser rule.
Every tier and eligibility rule is unit-testable without credentials, which is why 99 of
the 356 tests cover pricing behaviour.

Two design choices matter more than the purity:

- **Eligibility is data, not an if-chain.** `MONTHLY[tier][plan]` is either
  `{offered: true, ...prices}` or `{offered: false, reason}`. An ineligible combination
  has no price to read.
- **The Enterprise refusal is a separate branch of the return type**, with no price fields
  on it. There is no Enterprise number to read out, even by mistake.

### Decision 5 — immutability is enforced by the schema where it can be

| Model | `update` / `delete` | `create` |
|---|---|---|
| `ProposalVersion` | `update` **removed from the schema**; `delete` present for the Lambda only | Lambda only |
| `Approval` | **both removed from the schema** | Lambda only, no user grant |
| `AuditEvent` | **both removed from the schema** | Lambda only, no user grant |
| `ProposalDelivery` | **both removed from the schema** | Lambda only, no user grant |

`disableOperations(['update','delete'])` removes those mutations **outright** — no future
authorization edit can reintroduce them. `create` has to remain, or the Lambda itself
could not write; users are excluded by granting them `read` only.

Those are two different strengths of guarantee, and the code says which is which. An
earlier revision disabled `create` as well on `Approval`, which was self-defeating —
removing it from the schema removes it for the Lambda too. The compiler caught it.

### Decision 6 — approval binds to bytes, not to a record

`ProposalVersion` is immutable, but the S3 snapshot it points at is a **separate object**.
So both `decide-proposal` and `send-proposal-email` re-hash the stored snapshot at the
moment of the act and refuse on mismatch.

Without that check, a swapped snapshot would be approved — and later mailed — as though
nothing had changed.

### Decision 7 — confidential cost data is contained structurally, five ways

`@aeygis/pricing-internal` holds delivery cost per engineer-hour, margin reasoning, and
competitor analysis, sourced from a Rate Card stamped *CONFIDENTIAL — Internal Use Only*.

An authorization rule cannot protect it, because a leak would happen inside a single
Lambda's own process. So:

| # | Barrier | Mechanism | Defeated by |
|---|---|---|---|
| 1 | **Package** | `dependency-cruiser` forbids the renderer, the email sender, the console and `@aeygis/pricing` from importing it, transitively. CI fails. | Someone adding an exception |
| 2 | **Type** | `ClientProposalPayload` is a closed interface — no index signature, no `Record<string, unknown>` — produced only by a hand-written whitelist mapper that never spreads. | Someone widening the interface |
| 3 | **Data** | Cost data is not in the AppSync schema at all, so no query can reach it. | Someone adding a field |
| 4 | **IAM** | The renderer and the email sender have **no ARN** for `proposals/internal/*`. Asserted by `npm run check:synth`. | A deploy that adds one |
| 5 | **Runtime** | `assertClientSafe()` deep-scans the payload for forbidden key names; `assertHtmlFreeOfConfidentialWords()` scans the rendered copy. Throws. | Nothing static — it runs every time |

Barrier 5 is the one that runs on every render, which is why the other four being static
is acceptable.

**One subtlety worth preserving:** the word scan operates on **visible text, not markup**.
`margin` is a CSS property, so scanning raw HTML would fail on every stylesheet and the
check would get deleted by whoever got tired of it. The scanner strips `<style>`,
`<script>` and `<svg>` blocks entirely, removes all tags, and **decodes HTML entities**
before matching — because `esc()` turns every apostrophe into `&#39;` on the way in, and
a scanner that leaves them encoded is not reading what a reader reads.

### Decision 8 — Canadian data residency

Everything is in `ca-central-1`.

**Amplify Gen 2 has no region configuration field.** There is no `region:` property on
`defineBackend`, and none on `defineData`. Region is resolved entirely from the AWS
credential chain:

```
AWS_REGION → AWS_DEFAULT_REGION → profile's region → instance metadata
```

So every npm script pins `AWS_REGION=ca-central-1` with `cross-env`, and `backend.ts`
throws at synth time if the resolved region is anything else.

**⚠ That guard is best-effort, not a control.** It reads environment variables. Anyone
deploying with no region env var set — region coming from `~/.aws/config` — bypasses it
with a warning. The only enforceable mechanism is an SCP or an `aws:RequestedRegion` deny
condition on the deploy role.

This was raised with the user, explained with the bypass example, and **declined**
(2026-08-23). It is recorded here as a known limitation, not an outstanding task.

---

## 3.3 Data flow, end to end, with the guarantee at each step

| Step | Actor | What is guaranteed |
|---|---|---|
| Submit | anonymous | Consent required; honeypot; per-IP rate limit on a **salted** hash, never a raw IP; response is a receipt, never data |
| Land in queue | system | Band widened, record marked `needs_confirmation`, nothing guessed |
| Confirm scope | contributor | Pricing refuses until exact integers exist |
| Fill discovery | contributor | Custom question ids cannot shadow the approved 20 |
| Price | contributor | Enterprise refuses; ineligible plans have no price to read; below 90% flags executive sign-off |
| Generate | contributor | Version is immutable; snapshot frozen; hash taken over the uploaded bytes |
| Render | system | Only a client-safe snapshot is readable; five barriers; a leak fails the render |
| Approve | **approver only** | Bound to a content hash; S3 re-hashed; groups snapshotted at decision time |
| Discard | either staff role | Approved versions refused; audit record carries everything that was removed |
| Send | **approver only** | Six checks; recipient comes from the clinic's record, not from the caller; every attempt recorded |

---

## 3.4 Repository layout and package boundaries

```
packages/domain            zero dependencies. Shared vocabulary, band mapping,
                           discovery questions, approved proposal copy.
                             ▲                        ▲
                             │                        │
packages/pricing ────────────┘            apps/console┘
  the price book, tier assignment,          React 19 + Vite
  quote engine, client payload mapper
      ▲
      │  (one-way only — enforced)
      │
packages/pricing-internal   ⚠ CONFIDENTIAL. May import pricing.
                              Nothing client-facing may import IT.
```

**The dependency-cruiser rules, in full:**

| Rule | Forbids |
|---|---|
| `no-internal-pricing-in-renderer` | `render-proposal-pdf` → `pricing-internal` |
| `no-internal-pricing-in-email-sender` | `send-proposal-email` → `pricing-internal` |
| `no-internal-pricing-in-console` | `apps/console` → `pricing-internal` |
| `no-internal-pricing-in-client-packages` | `packages/pricing` → `pricing-internal` (direction is one-way) |
| `no-aws-deps-in-pricing` | `packages/pricing` → any AWS SDK or Amplify package |
| `no-aws-deps-in-domain` | `packages/domain` → any AWS SDK or Amplify package |
| `no-circular` | any circular import — they would make the rules above unenforceable |

All rules are `severity: error` and are checked transitively
(`tsPreCompilationDeps: true`). Current state: **101 modules, 183 dependencies, zero
violations.**

**A failure here is a confidentiality incident, not a lint nit.**

---

## 3.5 Two brand systems, deliberately

| Surface | Look | Why |
|---|---|---|
| **Proposal PDF** | Dark cover, light interiors, gold wordmark, teal accents, **Lato**, 960×679pt landscape | Matches `Aeygis_Cloud_Overview.pdf`, the artefact clients already receive. Colours and fonts were extracted from that PDF programmatically, not eyeballed. |
| **Console** | "Porcelain" — warm light SaaS, floating white cards, **Manrope + IBM Plex Mono**, teal accent, plus a full dark theme | Chosen by the user from four rendered candidates in `ui/`. |

They intentionally differ. The original brief described the brand as "dark theme, teal
accent", which is accurate for the deck's cover and not for the health site — the health
site is a **light** theme, and the dark/yellow system belongs to `aeygis.com`, a separate
property.

---

## 3.6 The verification philosophy

The strongest lesson of this build, stated plainly:

> **Static checks prove almost nothing about whether the system works. Every defect
> found in this project came from exercising a real path.**

Examples, each of which passed every static check:

- The console typechecked, built, and served HTTP 200 while rendering a **blank page**
  (two React copies, plus `generateClient()` running before `Amplify.configure()`).
- The `deleteProposalVersion` button threw `is not a function` at the first click,
  because the *deployed* AppSync schema did not contain the mutation. A green test suite
  and a broken button are entirely compatible states.
- The first real proposal email arrived with a **blank PDF**, while the S3 object rendered
  perfectly and the base64 round-tripped byte-identical.
- 77 console text nodes sat below WCAG AA contrast.
- A new DynamoDB table landed on the wrong KMS key while `describe-table` reported
  success.

So the check layers are ordered by how much reality they touch:

| Layer | Command | What it can see |
|---|---|---|
| Unit | `npm test` (293) | Pure logic: pricing, validation, identity parsing, email composition |
| Boundary | `npm run lint:boundaries` | Confidential imports, transitively |
| Synth | `npm run check:synth` (17) | What `backend.ts` actually *produces* — IAM, schema, encryption |
| Deployed API | `npm run verify` | Guest access, role permissions, encryption key ARNs |
| **Browser** | `npm run check:ui` (131) · `verify-discovery-and-delete.mjs` (53) | **The app actually running and being clicked** |
| **Real send** | `npm run verify:email` | The whole pipeline including a real email |

One lesson from writing `check:synth` is worth repeating for any check anyone adds:
nearly every assertion is of the form *"X is absent"*, and those **all pass on an empty
list**. The first version's schema regex matched nothing, so three checks reported a clean
bill of health for a file they had never read. It now fails loudly if it parses zero
mutations.

**A check that cannot tell "nothing is wrong" from "I looked at nothing" is worse than no
check**, because nobody investigates a pass.
