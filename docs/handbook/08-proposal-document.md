# 8. The proposal document

← [Pricing engine](07-pricing-engine.md) · [Index](README.md) · Next: [The console](09-console.md)

The one thing a client actually receives. 17 pages, landscape, branded to match the deck
they have already seen.

---

## 8.1 How a PDF comes into existence

```
staff click Generate
        │
price-proposal
   ├─ prices with @aeygis/pricing
   ├─ builds ClientProposalPayload via toClientPayload()   ← whitelist, never a spread
   ├─ writes snapshots/{proposalId}/{versionKey}.json      ← the FROZEN snapshot
   ├─ hashes those exact bytes → contentSha256
   ├─ writes the ProposalVersion record
   └─ invokes render-proposal-pdf with InvocationType 'Event'   (fire and forget)
                    │
render-proposal-pdf │
   ├─ reads the snapshot — and NOTHING else
   ├─ assertClientSafe(payload)                            ← barrier 5, before any render
   ├─ renderProposalHtml(payload, TEMPLATE_ASSETS)
   ├─ assertHtmlFreeOfConfidentialWords(html)              ← barrier 5, on visible text
   ├─ launches Chromium, waits for document.fonts.ready
   ├─ page.pdf({ printBackground: true, preferCSSPageSize: true })
   └─ writes proposals/client/{proposalId}/{versionKey}.pdf
                    │
console polls S3 for that deterministic key → "View PDF" appears
```

**Rendering is asynchronous on purpose.** A Chromium cold start takes several seconds; the
person who clicked Generate should not wait for it. The console does not need a callback:
`proposalId` and `versionKey` are known the moment a version exists, so it computes the same
deterministic path and asks S3 whether the object is there yet.

---

## 8.2 The 17 pages

| # | Eyebrow | Heading | What it shows |
|---|---|---|---|
| 1 | — | **Cover** | Clinic name, prepared-by, reference, issue date, on the deck's dark ground |
| 2 | Where you're starting from | A snapshot of your current environment | The prospect's **own** intake answers — hosting, MFA, backups, incident plan, last risk assessment. Only fields they actually answered appear. |
| 3 | Why now | Enforcement is active, not theoretical | Regulatory context (PHIPA / PIPEDA), with citations |
| 4 | What organizations gain | Independently measured — not vendor promises | Measured impact figures, with attribution |
| 5 | What this replaces | Set against what your clinic already spends | The spend comparison — **rendered only when it favours the proposal** |
| 6 | Your investment | *(tier)* — scoped to your clinic | Setup, per-plan monthly, annual check-up, first-year total. What the client pays separately. |
| 7 | Your migration path | The track(s) your environment follows | Track A / Track B, derived from the hosting answer |
| 8 | Managed delivery | From assessment to ongoing support in five managed steps | The five-phase delivery model |
| 9 | Indicative schedule | How long each stage is expected to take | **Staff-authored free text.** No approved document states phase durations, so the system does not imply a precision it does not have. |
| 10 | Who does what | *(responsibility matrix)* | Seven approved rows, minus exclusions, plus clinic-specific additions |
| 11 | Working alongside your IT provider | This does not replace your local IT support | Co-existence with an incumbent provider |
| 12 | Security and privacy | Controls built into the foundation | Security controls and specifics |
| 13 | Continuity and service levels | Recovery should be measurable before an outage | Recovery objectives, the resilience cycle, and the recovery disclaimer |
| 14 | Uptime | Two commitments, and they are not the same thing | The AWS infrastructure SLA and the Aeygis service baseline, kept distinct |
| 15 | Why Aeygis | An Ontario partner that understands healthcare operations | Positioning, differentiators, and what to expect |
| 16 | Scope and terms | Clear scope, transparent assumptions | Scope, assumptions, exclusions |
| 17 | Acceptance | Confirming this proposal | Signature block, plus an explicit statement of what this is not |

Two sections were built and then **removed on request (2026-08-23)**: a technical-discovery
appendix reproducing all 20 questions, and a sources-and-references appendix.

---

## 8.3 Design values, extracted rather than invented

The document is modelled on `Aeygis_Cloud_Overview.pdf` — the artefact clients have already
seen. Colours and fonts were read **out of that PDF programmatically** with PyMuPDF (fill
colours by area, font/size/colour per text span), not eyeballed.

```
page background   #f6f7fb        dark cover / bands   #0a1830
card              #ffffff        rules / borders      #e7e9ef
teal accent       #15b8a7        heading ink          #141f2e
body text         #4b5563        muted                #9aa7bc
purple            #7564e8        gold                 #e8b84a
blue              #4b9ff5        highlight            #fff6db / #f3e3a8
typeface          Lato 400 / 700 / 900
page size         960 × 679 pt, landscape — the deck's own geometry
```

**The deck is a dark cover with light interior pages**, and its wordmark is gold on dark /
near-black on light. That is a **different system** from `health.aeygis.com` (light navy and
teal, Cormorant Garamond), which is why the console and this document deliberately do not
look alike. See [Architecture §3.5](03-architecture.md#35-two-brand-systems-deliberately).

**Fonts and logos are inlined as data URIs.** Chromium in Lambda has no system fonts and no
reliable network, so anything not embedded would render as fallback glyphs or blank boxes.
The assets live in `template-assets.generated.ts`; regenerate with `npm run gen:assets`.

---

## 8.4 Content honesty rules

These are the rules that stop the document from over-claiming. Each exists because the
alternative would have been easy and wrong.

### Only answered questions appear

The current-state page renders tiles only for fields the prospect actually answered, or that
matched a known code. **A code they never answered maps to null and is left out, never
guessed at.** If none were answered, the whole page is omitted — a page with nothing on it
would look like a rendering bug, not a clean skip.

### The spend comparison appears only when it favours the proposal

If the client's own reported figures do not make the comparison favourable, the page is not
rendered. And where components are missing, the estimate **understates** their current
spend — the safe direction, since it can only make the comparison less flattering to us.

The page states what the figure covers rather than implying it covers everything.

### The schedule is free text, deliberately

No approved document states phase durations. Rather than inventing plausible ones, the
system asks staff to write estimates per phase, in their own words, with a note field.

### Uptime figures are kept distinct, because the collateral conflicts

Three different uptime numbers exist across Aeygis material — 99.99% (AWS multi-AZ compute
SLA), 99.9% (the Aeygis service baseline in the Overview deck), and 99.97% (unattributed, on
the health site). They describe adjacent but different things and are easy to conflate.

Page 14 is titled *"Two commitments, and they are not the same thing"* and states them
separately, each sourced on purpose.

### The acceptance page says what it is not

A signature page carrying prices and no statement of effect **can be argued to be the
contract itself**. Saying plainly what it is not is the cheapest way to keep that argument
from ever starting:

> *"This acceptance is a confirmation of intent to proceed. It is not the service agreement
> and does not itself create a payment obligation. Scope, service levels, and commercial
> terms are set out in the statement of work, which is the binding document and is issued
> after this proposal is accepted."*

That sequence is the Framework's own (§6: *"SOW & Proposal Delivery … for clinic
approval"*).

### Brand in the copy, legal entity on the signature

| | |
|---|---|
| Document body and footer | **Aeygis Health** — the client-facing brand |
| Signature line | **Aeygis Technologies Inc.** — the registered entity |

Both were confirmed separately. Brand in the copy and legal entity on the signature is
normal; **if they should ever match, change both together rather than one.**

### Pricing validity is one constant

```ts
PRICING_VALIDITY_DAYS = 30
```

One constant, so the note in the document and the computed date cannot drift.

`validUntilDate()` adds days **on the calendar**, not by adding milliseconds — a
`30 × 24 × 60 × 60 × 1000` offset lands an hour out across a daylight-saving boundary,
which in Canada can tip the answer onto the wrong day.

Callers pass **the same `Date` instance** they format `issuedOn` from, so the two can never
describe different days. And the email reads the finished string from the frozen snapshot,
so the email and the PDF can never state different dates either.

---

## 8.5 The responsibility matrix

Seven approved rows, verbatim from Framework §4:

| Area | Aeygis | Clinic |
|---|---|---|
| AWS Cloud Infrastructure | Owner: VPC, EC2, RDS, Gateways, AWS Security | Consumer: connects via approved secure endpoints |
| Data Encryption & KMS | Owner: key creation, rotation, encryption policies | Owner: ensuring sensitive data is placed in encrypted stores |
| Backups & Disaster Recovery | Owner: backup execution, cross-region sync, restore testing | Owner: defining clinic business downtime tolerances |
| System Security & Patching | Owner: OS and cloud infrastructure patching, WAF rules | Owner: antivirus/EDR on local clinic laptops and desktops |
| Identity & Access Management | Owner: cloud IAM, VPN MFA, RBAC group structures | Owner: staff onboarding, offboarding requests, role approvals |
| EMR / PACS Application | Support: infrastructure hosting, database uptime | Owner: application usage, charting, billing, vendor licence |
| Privacy Governance | Support: technical safeguards and audit trail logs | Owner: clinic privacy policies, patient consent, legal duties |

**Note how many rows put the CLINIC as owner. That is the point of showing it** — a client
who never sees this assumes anything technical is Aeygis's problem, and discovers otherwise
during an incident.

**What staff can customise per clinic:**

- **Exclude** an approved row that does not apply
- **Add** a clinic-specific row (area, Aeygis responsibility, clinic responsibility — each
  capped at 160 characters)

**What staff cannot change: the approved wording of the seven rows.** They are approved
statements about legal responsibility. Rewording them here would silently fork them from
the document the client may also have been sent.

---

## 8.6 Approved copy lives in `@aeygis/domain`

[`packages/domain/src/proposalContent.ts`](../../packages/domain/src/proposalContent.ts) —
642 lines.

Everything verbatim in that file comes from `Aeygis_Cloud_Migration_Framework.pdf`
(AEYGIS-MIG-FRAMEWORK-V3). **It is not paraphrased**, because these are approved statements
about legal responsibility and delivery methodology.

It lives in `@aeygis/domain` rather than beside the renderer so the console and the PDF read
the **same** definitions. Two copies would be two places to drift apart.

What it holds:

| Export | Content |
|---|---|
| `RESPONSIBILITY_ROWS` | The seven approved matrix rows |
| `TRACK_A` / `TRACK_B`, `tracksForHosting()` | Migration tracks, selected by the hosting answer |
| `CO_EXISTENCE` | How Aeygis works alongside an incumbent IT provider |
| `SERVICE_LEVELS`, `SERVICE_LEVEL_NOTE` | Service level commitments |
| `RECOVERY_OBJECTIVES`, `RESILIENCE_CYCLE`, `RECOVERY_DISCLAIMER` | Continuity |
| `MEASURED_IMPACT`, `IMPACT_ATTRIBUTION` | Outcome figures **with their attribution attached** |
| `REGULATORY_POINTS`, `REGULATORY_NOTE` | PHIPA / PIPEDA context |
| `SECURITY_CONTROLS`, `SECURITY_SPECIFICS`, `SECURITY_NOTE` | Security posture |
| `CITATIONS` | Claim → source pairs |
| `WHY_AEYGIS_*` | Positioning, differentiators, expectations |
| `ACCEPTANCE_*` | The acceptance page's statement, disclaimer and signatory |
| `SCHEDULE_PHASE_IDS` / `_LABELS` | The five phases staff estimate |
| Parsers | `parseResponsibilityCustomisation`, `parseMigrationSchedule`, `parseDiscoveryAnswers`, `parseCustomDiscoverySchema` — all tolerant of malformed JSON, returning a safe empty value rather than throwing |

---

## 8.7 Every interpolated value is escaped

```ts
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

Clinic names, contact names, discovery answers and custom matrix rows are all **free text a
stranger typed into a form or a console field**. `Smith & Sons Family Health` would break
the markup unescaped, and a name containing a tag would be worse than broken.

This is also why the confidential-word scan **decodes entities** before matching — `esc()`
turns every apostrophe into `&#39;` on the way in, and a scanner that leaves them encoded is
not reading what a reader reads.

---

## 8.8 Checking the document

### `npm run preview:proposal`

Renders a sample proposal to PDF **locally, using your installed Chrome**. It exercises the
same template, the same client payload, and the same client-safety guards the Lambda runs —
so a layout or font problem surfaces here rather than after a Chromium-in-Lambda deploy.

Writes `proposal-preview.pdf` and `proposal-preview.html` at the repository root.

**This does not prove the Lambda path works.** The binary, the layer and the bundling are
different problems. It proves the **document** is right.

### `npm run check:layout`

Measures whether any page overflows or collides with its footer, in a real browser.

**Why not `scrollHeight`.** `.page` is `overflow: hidden`, so `scrollHeight` is **always**
clamped to `clientHeight` and reports "fits" no matter how far content runs past the bottom.
It is a check that cannot fail, which is worse than no check.

This measures the real bottom edge of the last flowed child against the page box **and**
against the footer's own top edge — the two ways content actually goes wrong on a
fixed-height page with no auto-pagination.

Run `npm run preview:proposal` first; this reads the HTML it writes.

---

## 8.9 Regenerating the embedded assets

```bash
npm run gen:assets
```

Regenerates `template-assets.generated.ts` from the files in
`amplify/functions/render-proposal-pdf/assets/`: three Lato weights (400, 700, 900) and two
logo variants (dark-on-light, light-on-dark), all as base64 constants.

**Why they are baked in rather than read from disk.** The handler originally did
`readFileSync(join(dirname, 'assets', ...))`. Inspecting the **actually deployed** Lambda
package showed it contained exactly two files — `index.mjs` and `index.mjs.map`. Amplify's
bundler does not copy sibling asset directories, so every font and logo was simply absent
and the first render would have thrown `ENOENT`.

Baking them into the module means esbuild inlines them, so they cannot be left behind. A
deliberate trade: about 130 kB of base64 in the bundle in exchange for the assets being
impossible to lose.

**Run this after changing any font or logo**, or the change will not reach the Lambda.
