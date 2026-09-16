# 17. Decision log

← [Gotchas](16-gotchas.md) · [Index](README.md) · Next: [Glossary](18-glossary.md)

Settled decisions and why. **Do not re-litigate these** unless the user asks.

Each entry says who decided and, where it matters, what was rejected.

---

## 17.1 Product and commercial

| Decision | Choice | Reasoning |
|---|---|---|
| **Pricing authority** | The Framework + Rate Card documents | The live site's calculator quotes different tier names and different figures. The user confirmed the documents are authoritative. |
| **The `providers === 15` boundary** | `>= 15` → Enterprise; Professional is 3–14 | **The documents contradict themselves here.** The tier table says "15+"; the pricing rule says "once a client *passes* 15". Resolved by the user. **The Rate Card itself should still be corrected.** |
| **The Enterprise location threshold** | `>= 10` → Enterprise | **Not user-stated.** The documents give no explicit location boundary. Extended from the providers answer for consistency. A single named constant, flagged as an open gap. |
| **"Extra" units on Professional** | Beyond the **base scope** (8 providers / 4 locations), not beyond the tier minimum (3 / 1) | Follows *"base price covers 3–8 providers, 1–4 locations"*. Confirmed with the user because it is worth ~$10,000 of setup fee at 10 providers. |
| **The Micro/Starter overlap** | **Present both, let staff choose** | The documents resolve it by human judgement, not formula. Encoding a single answer would invent a rule the business does not have. |
| **Enterprise pricing** | **Never auto-priced.** Always routes to a discovery call. | Rate Card §4, verbatim. The refusal is a separate branch of the return type with no price fields, so an Enterprise number cannot be read out even by mistake. |
| **The discount floor** | Below 90% of list flags `requiresExecutiveSignOff` | Rate Card §4. Reduce scope before discounting. |
| **The annual check-up** | **Never discounted** | It is a mandatory safety activity, not a commercial lever. |
| **Pricing above list** | **Not supported.** `priceFactor > 1` throws. | |
| **Proposal signatory** | **Aeygis Technologies Inc.** on the signature line; **Aeygis Health** in the body and footer | Brand in the copy, legal entity on the signature. Both confirmed separately. **If they should ever match, change both together.** |
| **Pricing validity** | 30 days, one constant | So the note and the computed date cannot drift. |
| **The acceptance page** | States explicitly that it is **not** the service agreement | A signature page carrying prices and no statement of effect can be argued to *be* the contract. |

---

## 17.2 Architecture

| Decision | Choice | Rejected alternative |
|---|---|---|
| **Where this lives** | A **separate project** from the live websites | Originally because editing the live site was impossible (compiled bundle, no source). Since 2026-08-25 the site is real source, but the separation still stands: different deploy cadences, different risk profiles, and the backend must not be reachable from a public build. |
| **How leads arrive** | **Direct submission to this backend, and nowhere else** (2026-08-25). It began as a parallel dual-write alongside formsubmit.co so that adding the backend could not change live behaviour; once proven, the user removed the email. | Keeping the dual-write — two destinations to keep in step, and leads sitting in an inbox the console knows nothing about |
| **Public write path** | A **custom Lambda-backed mutation** returning a receipt | `allow.guest().to(['create'])` — AppSync returns the created object, and it grants write access to every field including ones added later |
| **Public auth** | Cognito identity pool, unauthenticated role | An **API key** — a bearer credential that would ship in public JavaScript and never expire |
| **Region** | **`ca-central-1`**, pinned per command with `cross-env` | Editing the profile's default region — side effects on unrelated work, and it would disable the guard |
| **Region enforcement** | A best-effort **guard**, not a control | An SCP or `aws:RequestedRegion` deny — **⛔ reviewed and declined by the user, 2026-08-23** |
| **Immutability** | Enforced **in the schema** where possible (`disableOperations`) | Enforcing it only in authorization rules — a future rule edit could reintroduce the operation |
| **Approval binding** | Bound to a **content hash**, re-verified against the S3 object at decision time | Binding to the record alone — the S3 object is a separate thing and could be swapped |
| **Confidential cost data** | **Five independent barriers** | An authorization rule — a leak would happen inside a single Lambda's own process |
| **Function data access** | Through AppSync with `authMode: 'iam'` | The DynamoDB SDK directly — it would bypass the schema's own rules |
| **Console framework** | **React + Vite** | Matches the existing health.aeygis.com stack. Confirmed 2026-08-17. |
| **TypeScript version** | Pinned **5.9.3**, not 7.x | Amplify declares no TypeScript peer dependency and `ampx` type generation is unverified against the 7.x rewrite |
| **Database** | DynamoDB | All access patterns are key-and-range; no joins, no reporting queries, no idle cost wanted |

---

## 17.3 Data model

| Decision | Choice | Reasoning |
|---|---|---|
| **`versionKey` format** | A **zero-padded string** (`v0004`) | Amplify GSI sort keys compare as text — integer 10 would sort before 2. `versionNumber` is display only. |
| **`ProposalVersion.update`** | **Removed from the schema** | An approval binds to a hash; an editable version would make the approval refer to different content |
| **`ProposalVersion.delete`** | **Re-enabled in the schema, granted to no user** | Reversed on explicit instruction so staff can clear drafts. Bounded: the only route is the custom mutation, which refuses approved versions. |
| **`Approval` / `AuditEvent` / `ProposalDelivery`** | `update` and `delete` **removed from the schema**; `create` kept for the Lambda | Two different strengths of guarantee, and the schema says which is which |
| **`decidedByGroups`** | **Snapshotted at decision time** | Cognito membership is mutable; history must not be |
| **Actor email** | **Resolved from Cognito at write time** | Same reason. Amplify sends the access token, which carries no email. |
| **Delivery status** | **Three values**, not a boolean | `blocked` (we refused on purpose) must never read as `failed` (something broke) |
| **A second send** | A **second row**, never an edit | "We sent them two versions" is exactly the fact somebody needs later |
| **`submittedAt`** | An **explicit field**, not the implicit `createdAt` | Using a system field as a GSI sort key requires declaring it |
| **Rate-limit counting** | Reuses the IP-hash **GSI** | Avoids provisioning infrastructure whose only job is counting |
| **`pdfS3Key`** | Declared but **never written**; the console computes the path | Loosening immutability to shuttle one operational field back would be the wrong trade |

---

## 17.4 Storage and infrastructure

| Decision | Choice | Reasoning |
|---|---|---|
| **Encryption** | One **customer-managed KMS key**, rotation on, `RETAIN` | The Framework sells "KMS AES-256"; an AWS-owned key does not match that claim. RETAIN because destroying the key destroys every backup too. |
| **S3 versioning** | **On** | Regenerating writes the same key; a client may hold the previous PDF |
| **S3 Object Lock (WORM)** | **Off** — confirmed with the user | Can only be set at bucket creation, so it cannot be retrofitted without a new bucket and a migration. **Recorded as a deferred decision.** |
| **`keepOnDelete` on storage** | **True** | Proposals and their approval trail should not vanish with an ephemeral dev stack |
| **DynamoDB deletion protection** | **Off in the sandbox** | It would block `sandbox:delete`. **Turn it on for a branch environment.** |
| **Point-in-time recovery** | **On, every table** | A 35-day continuous restore window. Without it there is no undo. |
| **S3 lifecycle** | Expire noncurrent versions after 365 days, keep the newest 10 | So the trail does not grow without bound. 365 days exceeds any live sales cycle. |
| **Chromium pack hosting** | **CloudFront + OAC** in front of a private bucket | A presigned URL would work today and **silently expire later**. Making the object public would require an account-wide posture change. |
| **The pack's S3 key** | **Version-qualified** | A future bump lands at a new URL rather than overwriting under a cached CloudFront response |
| **`render-proposal-pdf` sizing** | 2048 MB / 60 s | From the `@sparticuz/chromium` docs. **More memory means more CPU, so a larger setting is often cheaper.** |
| **Provisioned concurrency** | **None** | Rendering is async and off the request path, so a cold start costs nobody anything |
| **Three custom CDK stacks** | `Encryption`, `ChromiumPack`, `EmailDelivery` | Nesting them inside a function's stack would recreate the storage↔function circular dependency |

---

## 17.5 Email

| Decision | Choice | Reasoning |
|---|---|---|
| **How the client gets the PDF** | **Attached**, not linked | A presigned link created in a Lambda expires with the role session. Two of the original plan's premises (raw MIME required, a 10 MB cap) were checked and **both were wrong**. |
| **What is lost by attaching** | The "did they open it" signal | Accepted — the link would have expired before most clients clicked it |
| **Who may send** | **Approver only** | Not because sending is a privileged judgement, but because it is the **irreversible** act |
| **When it sends** | **Manual — an explicit button** | Approving never sends. If approval fired an email there would be no gap to catch a mis-click. |
| **Send confirmation** | **Two clicks**, with the version named | One click cannot put a document in a client's inbox |
| **Recipient** | From the **clinic's own record**. The mutation takes no recipient argument. | A caller cannot redirect a proposal |
| **The allowlist** | **Fails closed** — unset means block, `*` means allow | The plan said "empty it to go live", which would have made an unset variable silently permissive |
| **`SES_ENABLED`** | A **separate** switch from the allowlist, committed as `'true'` | "Stop everything now" and "change who may be emailed" are different decisions. `'false'` as a committed default would make every new environment deploy unable to send, with a symptom that reads like a bug. |
| **Config as plain values, not secrets** | `resource.ts` constants | **A change to who this company may email should appear in a diff.** As a secret it would be invisible. |
| **The email body** | **No figures at all** | The numbers belong in the document with their context. The simplest safe rule is "this file never states money." |
| **Both text and HTML bodies** | Both | Security gateways that rewrite mail show the text part; a blank message with an attachment reads as spam |
| **The greeting** | Full name or "Hello there," — **never a guessed first name** | Splitting a full name gets it wrong for compound surnames and titles |
| **The email identity** | **Created by hand, deliberately not in CDK** | Verification needs a human click, so an "as code" identity is only ever half-declared — and verifying is an AWS action needing its own approval |
| **Bounce events published** | `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY` only | The CDK default is *all* events — noise that trains people to ignore the topic |
| **SES TLS policy** | Default (**opportunistic**), not `REQUIRE` | `REQUIRE` would silently stop delivery to a clinic on an older mail host. **A real trade-off, worth revisiting once the recipients are known.** |
| **The BCC** | Every send, to a staff address | A human-readable record outside the console |
| **`ContentTransferEncoding`** | **`BASE64`, set explicitly** | AWS documents **no default**, and the wrong one silently corrupts a binary attachment |

---

## 17.6 Console and design

| Decision | Choice | Reasoning |
|---|---|---|
| **Direction** | **"Porcelain"** | Chosen by the user from four rendered candidates in `ui/`. Supersedes "Signal"; the indigo rail is gone — it was never an Aeygis colour. |
| **Colour studies** | **Not needed** — the user declined | Six palettes exist in `ui/colors/` as a record |
| **Accent** | Teal `#0b8585` | The one **verified** brand value — the live health site's `meta theme-color` |
| **Status hues** | **Tints only**, never a saturated fill larger than a pill | So the accent keeps its monopoly on "this is the thing to click" |
| **Type** | Manrope + IBM Plex Mono | **Mono is load-bearing**: reference ids, hashes, version keys and money are machine-generated facts, so you can tell at a glance what a person typed |
| **Themes** | Light **and** dark, with a toggle | Three states, not two — "follow the system" is the default and stamps nothing |
| **Layout** | An **app frame**: no page scroll, two independently scrolling columns | Reviewing a clinic means moving between columns, not scrolling one endless page |
| **Motion** | One orchestrated entrance per surface | **No base rule sets `opacity: 0`**, which is what makes the reduced-motion kill switch safe rather than a blank screen |
| **The sign-in image** | **Bundled**, not hot-linked | An internal console must not need a third-party CDN to render its own front door |
| **Self-registration** | **Disabled** | Open sign-up on a console holding client data would be an obvious hole |
| **Hiding controls from a role** | **Never silently** — the UI explains the requirement | A missing button teaches nothing, and the API is the real boundary |
| **Reject and Delete** | **Two-click armed**, self-clearing after 4 s | Both are irreversible |
| **`DeliveryPanel` placement** | **Inside** `ApprovalPanel` | So it reads the same versions and decisions rather than issuing a second query that can land the other side of a decision |
| **An approved version's controls** | **Only View PDF** — Approve, Reject and Delete are not rendered | A version is immutable and `Approval` append-only: you mint a new version rather than re-decide an old one. A rejected version keeps its buttons, because a rejection reversed by a later approval is a legitimate sequence. **Not enforced by the backend** — it prevents the accident, not the act |
| **`View PDF` placement** | **First in the action cluster**, beside Approve / Reject / Delete | It is the only read-only control on the row and the only one every role can use, so the cluster reads left-to-right from safest to least reversible, Delete last |
| **"groups at decision" on screen** | **Removed** — still recorded, just not shown | On a row that already carries an approval it restated what the approval implies, since only an approver can produce one |
| **The two brand systems** | The PDF matches the **deck**; the console matches the **health site** | They deliberately do not look alike. The brief's "dark theme, teal accent" describes the deck's cover, not the health site. |

---

## 17.7 Lead lifecycle

| Decision | Choice | Reasoning |
|---|---|---|
| **What moves a lead to `proposed`** | **A successful proposal email**, automatically | The pipeline could otherwise email a client a full priced proposal and leave the queue reading `in_review`. The status is a claim about reality, so the event that changes reality should change it |
| **`blocked` and `failed` sends** | **Change nothing** | Neither put a proposal in anybody's inbox, so calling the lead "proposed" would be a claim the pipeline then reports on |
| **A `closed` lead** | **Never reopened by a send** | A person ended it deliberately. Re-engaging a closed lead is their visible, attributable decision, not a side effect of an unrelated click |
| **An unrecognised status** | **Left alone, not guessed at** | It belongs to somebody else's intent. A test fails if a status is added to the model without anyone deciding which side of the rule it falls on |
| **Failure of the status write** | **Logged and swallowed** | It runs after SES accepts the message, so the email is already gone. Turning it into a reported failure would tell an approver the client did not receive a proposal they are at that moment reading |

---

## 17.8 Process and working rules

| Rule | Detail |
|---|---|
| **No AWS action without explicit per-action permission** | State exactly what will be created, changed or deleted, in which account and region, and wait. **Approval for one action is not approval for the next.** Free without asking: local code, unit tests that do not call AWS, documentation, reading the repo, `tsc`/lint/build that does not deploy. |
| **Never deploy the live site** | Its two edits are authored locally and handed to the user. |
| **Never assume** | If a requirement, business rule, naming convention, pricing detail, approval logic or design decision is not explicitly stated — **stop and ask.** |
| **Never rely on trained knowledge for factual claims** | Verify against the installed source, the installed types, or an empirical test. Several entries in [Gotchas](16-gotchas.md) exist because a plausible recollection was wrong. |
| **Documentation is written as work happens** | Not batched at the end. `deployment.md` and `aws-resources.md` are living documents. **An undocumented resource is an incomplete task.** |
| **`Aeygis_Cloud_Rate_Card.pdf` is CONFIDENTIAL** | Delivery cost per hour, margins, competitor pricing and the discount floor must never reach a client document. |
| **Report outcomes faithfully** | If a test fails, say so with the output. If a step was skipped, say that. |

---

## 17.9 Decisions deliberately deferred

| Item | Why deferred | What it would take |
|---|---|---|
| **S3 Object Lock / WORM** | Cannot be retrofitted | A new bucket and a data migration |
| **MFA on the user pool** | The Amplify option shapes were not verifiable | Confirm them against the installed `.d.ts`, then configure |
| **Console hosting** | Needs a decision about who may reach it | An Amplify Hosting app, plus an access decision |
| **A branch environment** | Not needed while there is one developer | An Amplify Hosting app and `pipeline-deploy` |
| **A data-retention policy** | A business decision nobody has made | A decision, then tooling |
| **Right of access / erasure tooling** | Not needed yet | Design work — the append-only records complicate it |
| **Assessment questions** | The user will finalise them in a later round | Nothing in code — the 20 questions are stored as JSON precisely so they can change without a migration |
| **`_captcha:'false'` on the live form** | Removing it inserts a captcha interstitial into the live flow | A UX decision |
| **Open/click tracking on email** | Needs a configuration set with tracking enabled and raises its own privacy question | Not worth it for a handful of proposals a month |
| **A template system for emails** | One body, written in code, same as the PDF template | Only worth it with more than one message type |
| **Scheduled or bulk sending** | One approved version, one recipient, one click | Not a requirement |
