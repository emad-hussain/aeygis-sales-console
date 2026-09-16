# 7. The pricing engine and the confidentiality barriers

← [Backend functions](06-backend-functions.md) · [Index](README.md) · Next: [The proposal document](08-proposal-document.md)

Three packages, and the boundary between them is the most security-sensitive thing in the
repository.

| Package | Contains | Client-safe? |
|---|---|---|
| `@aeygis/domain` | Shared vocabulary, band mapping, discovery questions, approved proposal copy | ✅ yes, zero dependencies |
| `@aeygis/pricing` | The price book, tier assignment, the quote engine, the client payload mapper | ✅ yes — **every figure here may appear in a client proposal** |
| `@aeygis/pricing-internal` | Delivery cost per engineer-hour, margin reasoning, competitor analysis, negotiation guidance | ⛔ **CONFIDENTIAL — never client-facing** |

---

## 7.1 The price book

[`packages/pricing/src/catalog.ts`](../../packages/pricing/src/catalog.ts)

**Every figure in this file is a list price that may appear in a client-facing proposal.
Nothing in it is confidential.**

### Sources

All in the `aeygis-website-source-code` repository. They agree with each other; the Rate
Card is the most detailed.

- `Aeygis_Cloud_Migration_Framework.pdf` §5 — Pricing Structure, Tiers & Excluded Costs
- `Aeygis_Cloud_Rate_Card.pdf` §2 (price levels), §3 (monthly support plans)
- `Aeygis_Cloud_Price_List_Compact.pdf`
- `Aeygis_Cloud_Setup_Fees_Only.pdf`

### `PRICE_BOOK_VERSION = '2026-07-rate-card-v2'`

Stamped into every proposal snapshot. **Changing any number in the catalog requires
bumping it**, because a historical proposal must always be reproducible from the version
it was quoted under. Never edit a figure without bumping.

### The tiers

All amounts CAD.

| Tier | Scope | One-time setup | Train & Walk Away | Essentials | Full Managed |
|---|---|---|---|---|---|
| **Micro** | 1 provider, 1 location, ~3,000 patients | $7,500 | $0/mo + **$2,000/yr check-up** | $1,800/mo | $3,400/mo |
| **Starter** | 1–2 providers, 1 location, ~10,000 patients | $15,000 | $0/mo + **$3,500/yr check-up** | $2,600/mo | $4,900/mo |
| **Professional** | 3–14 providers; base covers 3–8 providers and 1–4 locations | $55,000 base<br>+$2,000 per extra provider<br>+$3,000 per extra location | **Not offered** | $9,500 base<br>+$700/provider<br>+$900/location | $18,000 base<br>+$1,300/provider<br>+$1,700/location |
| **Enterprise** | 15+ providers / hospital networks | **Custom** (internal guide $150k–$450k) | **Not offered** | **Not offered** | $125,000+/mo, custom quote |

### The tier boundaries, and the contradiction behind them

```ts
ENTERPRISE_PROVIDER_THRESHOLD = 15
ENTERPRISE_LOCATION_THRESHOLD = 10
```

**The approved documents contradict themselves at exactly 15 providers.** The tier table
reads *"15+ providers = Enterprise"*, while the pricing rule reads *"once a client
**passes** 15 providers… stop using the Professional formula"*.

**Resolved by the user:** `>= 15` providers is Enterprise. Professional is 3–14.

**The location threshold is NOT user-stated.** The documents give no explicit Enterprise
location boundary. `>= 10` was extended from the providers answer for consistency
(*"up to 15 providers or 10 locations"*). It is flagged as an open gap, and both values
are single named constants so either can be changed in one line.

### What "extra" units means — a $10,000 question

The Rate Card says *"Base price covers 3–8 providers, 1–4 locations."* So a Professional
client's extras are those beyond **8 providers / 4 locations**, not beyond the tier's lower
bound of 3/1.

**Confirmed with the user (2026-08-17).** At 10 providers that is 2 extra = $55,000 +
$4,000, not 7 extra = $55,000 + $14,000. It was raised rather than assumed precisely
because it is worth about $10,000 of setup fee.

### Plan eligibility — data, not an if-chain

```ts
MONTHLY[tier][plan] = { offered: true,  monthlyBase, perExtraProviderMonthly, ... }
                    | { offered: false, reason }
```

An ineligible combination has **no price to read**, so it cannot be quoted by accident.

| Rule | Source |
|---|---|
| Professional clients cannot choose Train & Walk Away — *"a multi-provider practice cannot realistically go hands-off with its cloud systems"* | Framework §5 / Rate Card §3 |
| Enterprise clients require Full Managed only — no Train & Walk Away, no Essentials | Framework §5 / Rate Card §3 |

### Commercial rules

```ts
DISCOUNT_FLOOR_WITHOUT_SIGNOFF = 0.9
ENTERPRISE_REQUIRES_DISCOVERY_CALL = true
```

- **Below 90% of list price requires executive sign-off.** Rate Card §4: *"Never quote
  below 90% of the listed price without sign-off from leadership."*
- **Enterprise is never auto-priced.** Framework §6 / Rate Card §4: *"Always send
  Enterprise clients through a discovery call first. Never give them a firm price before
  that call happens."*
- **Reduce included scope before discounting.** Drop a support plan, limit included hours,
  or have the client pay auditors directly.
- **Train & Walk Away is never sold as "pay once and never pay again."** The annual
  check-up is mandatory.

### What the client always pays separately

Reproduced verbatim in every proposal so the client cannot mistake these for included
costs (Framework §5, Rate Card §4):

1. AWS cloud usage fees (compute, storage, data transfer)
2. AWS support plan fees (Developer/Business)
3. Third-party auditor and certifier fees (HITRUST, SOC 2, ISO)
4. Specialist legal and privacy advice
5. EMR / PACS vendor licensing or migration fees
6. Penetration testing by third-party security firms
7. Endpoint detection and response (EDR) software on local devices

---

## 7.2 Tier assignment

[`packages/pricing/src/tiers.ts`](../../packages/pricing/src/tiers.ts)

**The key design point: `assignTier()` returns a LIST of candidate tiers, not one tier.**

The approved documents do not resolve every input to a single answer. Micro is *"1
provider, 1 location, up to about 3,000 patients"* and Starter is *"1–2 providers, 1
location, up to about 10,000 patients"* — so a single-provider, single-location clinic
legitimately matches **both**, and the Rate Card resolves it by human judgement, not by
formula:

> *"Only offer Micro to a genuinely tiny, one-provider clinic. It exists to win the deal —
> don't try to upsell them into Starter right away."*

**Confirmed with the user: present both and let staff choose.** Encoding a single answer
would be inventing a rule the business does not have.

### How the tier is decided

```
byProviders = f(providers)
byLocations = f(locations)
base        = the HIGHER of the two
```

**Scale is set by whichever dimension is larger.** A 2-provider clinic across 6 sites is a
Professional engagement, not a Starter one. Micro and Starter are both single-location, so
more than one location pushes a clinic into Professional regardless of how few providers it
has.

### The Micro/Starter overlap

When `providers == 1 && locations == 1`, both apply. Patient count only orders them:

| Condition | Result |
|---|---|
| patients > 3,000 (the Micro guide) | `['starter', 'micro']` — Starter listed first |
| patients within the guide | `['micro', 'starter']` |
| patient count not supplied | `['micro', 'starter']`, with the rationale saying staff must choose |

Either way both are returned, along with a plain-English `rationale` array that is safe to
show staff (and never the client).

### Enterprise

Returns `{ candidates: ['enterprise'], requiresDiscoveryCall: true }` and the quote engine
converts that into a refusal branch with no price fields on it at all.

### Input validation

`providers` and `locations` must be positive integers. Anything else throws a `RangeError`
immediately rather than producing a plausible wrong number.

---

## 7.3 The quote engine

[`packages/pricing/src/quote.ts`](../../packages/pricing/src/quote.ts)

### Two refusals that must never be softened into a number

```ts
type QuoteResult =
  | { kind: 'quote'; priceBookVersion; options; discount; rationale; clientPaysSeparately }
  | { kind: 'requires-discovery-call'; priceBookVersion; tier: 'enterprise';
      reason; internalGuideRange; rationale }
```

**1. Enterprise.** The refusal branch has **no price fields**, so an Enterprise price
cannot be read out of it even by mistake. `internalGuideRange` is explicitly labelled
internal guidance and is never rendered as a quote.

**2. Unconfirmed counts.** `canQuote()` is a separate, explicit gate:

```ts
canQuote({ providerCount, locationCount, countsConfirmed })
  → { ok: true }
  | { ok: false, reason: 'Provider and location counts are not confirmed. ...' }
```

Separated from `quote()` so the refusal is explicit **at the call site** rather than an
exception thrown from somewhere deep.

### Price factor

```ts
priceFactor must be > 0 and <= 1
```

Anything above 1 throws: *"Pricing above list is not a supported operation."* Below
`DISCOUNT_FLOOR_WITHOUT_SIGNOFF` (0.9), the result carries
`requiresExecutiveSignOff: true` plus a note recommending scope reduction first.

### The annual check-up is never discounted

```ts
firstYearQuotedTotal = setupQuoted + (monthlyQuoted × 12) + annualCheckup
                                                            ^^^^^^^^^^^^^ not multiplied
                                                                          by priceFactor
```

It is a mandatory safety activity, not a commercial lever.

### Rounding

Every computed figure passes through `round()` (to whole cents) so repeated arithmetic
does not drift.

---

## 7.4 The client payload mapper

[`packages/pricing/src/clientPayload.ts`](../../packages/pricing/src/clientPayload.ts)

**This is confidentiality barrier 2, and the largest single file in the pricing package —
678 lines, 48 tests.**

`toClientPayload()` turns a `QuoteResult` plus assessment data into
`ClientProposalPayload`, which is **the only thing the PDF renderer ever receives**.

### Why it is a closed interface

```ts
export interface ClientProposalPayload {
  // every field listed explicitly
  // NO index signature
  // NO Record<string, unknown> anywhere
}
```

That matters because it means **a field cannot arrive here by being spread in from a wider
object** — the compiler rejects unknown properties.

### Why it never spreads

`toClientPayload()` is a hand-written whitelist mapper. It never writes `{...quote}`,
because a spread is exactly how an internal field silently becomes client-facing the day
somebody widens the source type.

> If you find yourself wanting to add a field here, ask whether a prospect should read it.
> Cost, margin, competitor comparisons and discount floors must never appear.

### What it assembles

| Section | Source | Note |
|---|---|---|
| Clinic name, contact, reference, dates | The assessment + `price-proposal` | Formatted once, never recomputed downstream |
| Current state | The prospect's **own** intake answers | Every field is either a translated display label or `null`. A code the prospect never answered maps to null and the section simply leaves it out — never guessed at. |
| Spend comparison | The client's own reported figures | See below |
| Pricing | The quote | Pre-formatted money (`{amount, currency, display}`) so the renderer does no locale arithmetic |
| Migration tracks | Derived from `hosting` | |
| Schedule | Staff-authored, free text | |
| Responsibility matrix | Approved rows minus exclusions, plus clinic additions | The approved **wording** is not editable |
| Service levels, security, regulatory, why-Aeygis, scope, acceptance | Approved copy in `@aeygis/domain` | Verbatim from the Framework |

### The spend comparison, and its honesty rules

[`packages/domain/src/currentSpend.ts`](../../packages/domain/src/currentSpend.ts)

Estimates what the clinic spends on IT today from **figures the client typed into the
public form**. None of it is Aeygis cost, margin, or rate-card data, which is why it may
appear in a client document at all.

Three rules keep it honest:

1. **A missing component contributes zero**, which *understates* their current spend. That
   is the safe direction: it can only make the comparison **less** flattering to us, never
   more. The payload carries `hasIt` / `hasHardware` / `hasDowntime` flags so the renderer
   states what the figure covers rather than implying it covers everything.
2. **Downtime needs both halves.** Hours alone or dollars-per-hour alone cannot produce an
   annual figure, and assuming the missing half would be invention.
3. **If the client supplied nothing usable, it returns `null`** and the page is omitted.
   Inventing an estimate from defaults would be fabrication.

The band midpoints come from the live form's own constants, carried over deliberately so
this arithmetic cannot silently disagree with the indicative figure the prospect already
saw on screen.

**One naming rule worth knowing.** The client-safety guard rejects any payload key matching
`/cost|margin|.../`, so every field in this module says **"spend"** rather than "cost" —
including where "cost" would read more naturally. That is deliberate and is not to be
weakened.

---

## 7.5 The five barriers, in detail

`@aeygis/pricing-internal` holds delivery cost per engineer-hour, margin reasoning, and
competitor analysis, sourced from a Rate Card stamped **CONFIDENTIAL — Internal Use Only**.

**A prospect who saw it would know Aeygis' cost base and negotiate against it.**

An authorization rule cannot protect it, because a leak would happen inside a single
Lambda's own process. So there are five independent barriers.

### Barrier 1 — the package boundary

[`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs), checked **transitively**
(`tsPreCompilationDeps: true`), all rules `severity: error`.

| Rule | Forbids |
|---|---|
| `no-internal-pricing-in-renderer` | `render-proposal-pdf` → `pricing-internal` |
| `no-internal-pricing-in-email-sender` | `send-proposal-email` → `pricing-internal` |
| `no-internal-pricing-in-console` | `apps/console` → `pricing-internal` |
| `no-internal-pricing-in-client-packages` | `packages/pricing` → `pricing-internal` — the direction is one-way |
| `no-aws-deps-in-pricing` | `packages/pricing` → any AWS SDK or Amplify package |
| `no-aws-deps-in-domain` | `packages/domain` → any AWS SDK or Amplify package |
| `no-circular` | Any circular import — they would make every rule above unenforceable |

The email-sender rule was added with Phase 5, because **the proposal email is
client-facing in two ways at once**: the body it composes and the PDF it attaches both land
in a prospect's inbox.

Current state: **105 modules, 188 dependencies, zero violations.**

> **A failure here is a confidentiality incident, not a lint nit.** Do not add an
> exception.

### Barrier 2 — the type boundary

`ClientProposalPayload` is closed, and `toClientPayload()` never spreads. Covered in §7.4.

### Barrier 3 — the data boundary

Confidential cost data **is not in the AppSync schema at all**. No query can reach it, no
resolver returns it, and no authorization rule needs to protect it.

This is the barrier that makes the schema-level `allow.resource()` assumption safe: because
function data access is assumed API-wide, the correct response is to keep the data out of
the API entirely rather than to protect it with a rule.

### Barrier 4 — the IAM boundary

`render-proposal-pdf` and `send-proposal-email` have **no ARN whatsoever** for
`proposals/internal/*`. Not a deny statement — an absence.

`npm run check:synth` asserts this against the synthesized CloudFormation on every run, so
a deploy that added such an ARN would be caught before it left the machine.

### Barrier 5 — the runtime guard

[`amplify/functions/render-proposal-pdf/assertClientSafe.ts`](../../amplify/functions/render-proposal-pdf/assertClientSafe.ts) —
36 tests.

The other four barriers are **static**: a forbidden dependency edge, a closed type, data
kept out of a schema, IAM scoping. All four can be defeated by a determined edit. **This
one runs on every render and throws**, so a leak becomes a failed render rather than a
document in a prospect's inbox.

**It rejects on key NAMES rather than trying to detect confidential values**, deliberately.
A key called `grossMarginCad` is a reliable signal; the number `41200` is not.

```ts
FORBIDDEN_KEY = /cost|margin|competitor|hourly|gross|cogs|internal|floor|payroll|discountFactor/i
```

**"cost" is included even though it is broad.** Client-facing money fields are named
`setupTotal`, `monthlyTotal`, `firstYearTotal` and `annualCheckup`, none of which contain
it. **If a new client-facing field genuinely needs "cost" in its name, rename the field
rather than weakening this pattern.**

There is also a value scan, for the case where a whole document string was interpolated:

```ts
FORBIDDEN_VALUE = /confidential\s*[-–—]\s*internal use only|cost per hour|per engineer-hour|gross margin/i
```

The scan is recursive over objects and arrays, reports the exact path of a violation
(`$.pricing.plans[0].grossMargin`), and **throws on any unexpected value type** — a
function, symbol or bigint reaching the payload is itself a problem.

### The HTML scan, and why it works on visible text

```ts
assertHtmlFreeOfConfidentialWords(html)
```

Scans the **rendered copy** for confidential vocabulary: *cost per hour, per
engineer-hour, gross margin, internal use only, competitor, payroll, cogs, margin*.

**This is not cosmetic.** Scanning raw HTML for that list is useless: `margin` is a CSS
property, so every stylesheet trips it, and the check either always fails or gets deleted
by whoever is tired of it.

`extractVisibleText()` therefore:

1. Removes `<style>`, `<script>` and `<svg>` blocks **entirely** — not just their tags
2. Strips all remaining tags and attributes
3. **Decodes HTML entities** — `esc()` turns every apostrophe into `&#39;` on the way in,
   so a scanner that leaves them encoded is not reading what a reader reads
4. Decodes `&amp;` **last**, so a double-escaped entity such as `&amp;lt;` does not become
   a real `<` and reintroduce something that looks like markup

### The numeric literal scan, and its deliberate floor

```ts
MIN_SCANNABLE_LITERAL = 1_000
```

`assertHtmlFreeOfLiterals()` can scan for specific confidential figures — but it
**throws a plain `Error`** (not a `ClientSafetyError`) if handed a literal below 1,000.

Below that, collisions with ordinary layout and copy are near-certain: a rate of 75 matches
"75" in a date, a percentage, a page number. Scanning them would produce false positives
that erode trust in the guard. Throwing means a caller cannot accidentally write a vacuous
test that passes because nothing could ever match.

Small confidential figures are covered by the **vocabulary** scan instead — the phrase
"cost per hour" is what makes 75 meaningful, and that phrase is caught.

The literal pattern allows an optional thousands separator and requires word boundaries, so
`41200` does not match inside `141200`.

**Note the renderer never imports the internal package to get these values** — they are
passed in as an argument.

---

## 7.6 What is in `pricing-internal`, described without reproducing it

Listed so the boundary is understandable without restating the confidential figures.

| Export | Category |
|---|---|
| `DELIVERY_COST_PER_HOUR_CAD` | Estimated delivery cost ranges, by coverage type |
| `DELIVERY_COST_RATIO_VS_CANADIAN_COMPETITOR` | A ratio against Canadian-staffed competitors |
| `COMPETITOR_PRICING` | Five named competitors' published pricing |
| `APPROX_STAFF_PER_TIER` | Headcount assumptions used only for an internal per-person comparison |
| `indicativeMarginRange()` | Returns a **range, never a point estimate** — the cost inputs are ranges and provisional, and a single number would imply precision the source data does not have |
| `NEGOTIATION_GUIDANCE` | Internal sales script: what to lead with, how to position Micro, when to route to a discovery call, and the discount order |

**One thing worth knowing even at this level of abstraction.** The Rate Card itself states
plainly that the cost figures are estimates from public salary and outsourcing data, **not
actual payroll**, and says: *"Before treating this as final, check it against the real
hours logged on 2–3 finished projects."* So they are provisional, and no margin computed
from them should justify a discount decision on its own.

---

## 7.7 Cross-package consistency, tested

[`packages/pricing/src/band-consistency.test.ts`](../../packages/pricing/src/band-consistency.test.ts) —
17 tests.

`@aeygis/domain` must stay dependency-free, so the tier boundaries are duplicated there as
literals for the band-ambiguity logic. This test suite asserts the two agree.

**It caught a real bug.** An early version flagged the `15+` provider band as ambiguous by
symmetry with the others. It is not: every value in it is Enterprise, which routes to a
discovery call rather than a computed price. Only `1-2` and `3-15` straddle a boundary that
matters, and for locations only `5-15` does.
