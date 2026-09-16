# Known issues

Findings that are **real but outside this build's scope**. Recorded so they are
not rediscovered from scratch, and so nobody assumes they were missed.

Nothing here has been actioned. Each needs its own decision.

---

## 1. The live calculator quotes prices that contradict the approved docs — ⚠ FIXED IN SOURCE, STILL WRONG IN PUBLIC

> ### ⚠ Re-checked 2026-09-14: THE OLD PRICES ARE STILL LIVE
>
> The heading below used to read "✅ FIXED 2026-08-25". That was true of the
> repository and false of the internet, which is the half that matters to a
> prospect. `health.aeygis.com` is **still serving the old compiled bundle**:
>
> ```
> $ curl -s https://health.aeygis.com/assets/index-QOvqVr0j.js | grep -o 'retainer:[0-9]*'
> retainer:2400
> retainer:6200
> retainer:15500
> ```
>
> Those are the wrong figures, verbatim, being quoted to real visitors today.
> `/assessment.html` also 301s to `/assessment/` and then **404s**.
>
> The fix is real and complete — it is simply **not deployed**. Nothing changes
> for a prospect until the site ships (see P12).
>
> **The lesson is about the word "fixed".** For anything a customer can see,
> "fixed" has to mean *deployed*, not *merged*. A status that tracks the repo
> instead of the public surface will read green while the problem is live.

**Was: high — prospects were receiving wrong numbers.**

> **Resolved.** The user rewrote the website as real source, which removed the
> blocker ("no React source exists"). The calculator in
> `assets/js/assessment.js` now carries the approved price book: Micro /
> Starter / Professional / Enterprise, three support plans, per-unit scaling on
> Professional, and **no figure at all for Enterprise** — the Rate Card forbids
> quoting one before a discovery call. The homepage track cards were renamed to
> match, and the unsubstantiated "Most popular" badge was dropped.
>
> Because the form collects **bands**, the page shows an indicative **range**
> across the tiers and plans those bands actually allow, rather than inventing a
> single price. Savings appear only when the clinic's current spend exceeds the
> **top** of that range, so every saving quoted holds for every option in it.
>
> `npm run verify:pricing` compares the shipped figures, figure by figure,
> against `packages/pricing` — the module the proposal PDF is built from — and
> `npm run verify:assessment` walks the form in a real browser. The two cannot
> drift apart again without a check going red.

The original finding, kept for the record:

`health.aeygis.com` runs a client-side pricing calculator with figures hardcoded in
the deployed bundle (`assets/index-QOvqVr0j.js`, offset ~178999 — that file was deleted in
the 2026-08-25 rewrite, so this is quoted from the record rather than linked):

```js
af={foundation:{retainer:2400,perProviderUsage:220,addOns:300,migrationCost:16e3},
    growth:{retainer:6200,perProviderUsage:260,addOns:900,migrationCost:42e3},
    enterprise:{retainer:15500,perProviderUsage:300,addOns:2200,migrationCost:95e3}}
```

| | Approved docs | Live site |
|---|---|---|
| Tiers | Micro / Starter / Professional / Enterprise | **Foundation / Growth / Enterprise** |
| Setup | $7,500 / $15,000 / $55,000+ / custom | **$16,000 / $42,000 / $95,000** |
| Monthly | $1,800–$18,000 across **3 support plans** | $2,400 / $6,200 / $15,500 |
| Support plans | Train & Walk Away / Essentials / Full Managed | **none exist** |

Neither the tier names nor any price agrees, and "Growth" is flagged *Most
Popular*. The user confirmed the **docs are authoritative**.

**Why it is not fixed here:** no React source exists — only the compiled bundle.
Options are a rebuild, or a DOM-patch in the hand-written enhancement layer.
Both need their own decision.

---

## 2. The privacy policy will be inaccurate once data lands in DynamoDB

[`privacy.html`](../../aeygis-website-source-code/privacy.html) §3 states:

> "Submissions from this Site are delivered by email to our sales team."

**That is already wrong for the assessment form**, which now submits to the Aeygis backend
and is stored in DynamoDB rather than emailed. It only stays invisible because the live site
has not been deployed yet.

Two further points, both present **today**:

- It never discloses the **third-party US processor**. Submissions currently POST
  to `https://formsubmit.co/ajax/sales@aeygis.com` while the policy claims
  *"Canadian AWS-region hosting"*. That is arguably a PIPEDA disclosure gap now,
  independent of anything this project changes.
- §4 cross-references "Section 8" for contact details, but contact is §10.

**The user said they will update this themselves.**

---

## 3. The formsubmit.co endpoint may never have been activated

A shipped comment and a `window.testAeygisFormSubmit()` console helper suggest
activation was still being debugged when the site was deployed:

> *"If this endpoint is not yet activated, check that inbox for a new activation
> email."*

If so, **live assessment submissions have been silently failing** — the code logs a
warning and shows a fallback message, but nothing reaches sales. Worth confirming
someone actually receives them, and whether historical leads were lost.

This is now moot for the **assessment** form, which no longer uses formsubmit.co at all.
It still applies to **contact-sales.html**.

> **Updated 2026-08-25 (twice).**
>
> The rewritten site posts to `https://formsubmit.co/ajax/aws@aeygis.com` — a
> **different address** from the `sales@aeygis.com` the old bundle used.
> formsubmit.co requires each destination to be activated by clicking a link it
> emails, so **this is a new, unactivated endpoint unless somebody has already
> confirmed it**.
>
> **The scope of that risk then shrank.** The assessment form no longer uses
> formsubmit.co at all — it submits to the backend, and an internal notification
> email now comes from `submit-assessment` instead. Only **contact-sales.html**
> still depends on the relay.
>
> **Still worth checking before the site is deployed:** submit the contact form
> once and confirm the message lands in `aws@aeygis.com`. If it does not, every
> general enquiry is being discarded — the same failure this issue was opened
> about, just on a smaller surface.

---

## 4. Health-site deep links return HTTP 404

Every path on `health.aeygis.com` returns **404 with the SPA shell as the body**
(`X-Cache: Miss from cloudfront`, `Server: AmazonS3`). The React router still
renders client-side, so a visitor sees content — but the status code is 404, so
deep links are not indexable and not reliably shareable, despite
`<meta name="robots" content="index, follow">`.

Compounding it, hash routing read `location.hash` **once** in a `useState`
initialiser and never listened for `hashchange` — documented in-file as a known bug
in the old `aeygis-enhancements.js`.

Consequence: an assessment link could not be shared reliably.

> **Partly resolved 2026-08-25.** The rewrite replaced the single-page app with
> **real multi-page HTML** — `index.html`, `assessment.html`, `contact-sales.html`
> and the legal pages are separate documents, and `_redirects` maps the clean
> paths to them:
>
> ```
> /contact-sales /contact-sales.html 200
> /assessment    /assessment.html    200
> ```
>
> **The hash-routing bug is gone entirely** — there is no client-side router left.
>
> **Whether the 404 status persists is unverified.** That was a hosting behaviour
> (S3 + CloudFront returning 404 with the shell as the body), not a code one, and
> confirming it needs a request to the live host after the next deploy. Re-check
> then rather than assuming the rewrite fixed it.

---

## 5. aeygis.com's contact form is completely inert

```html
<form class="contact-form"
      onsubmit="event.preventDefault(); alert('Thank you! We will be in touch soon.');">
```

No `name` attributes on any input, no endpoint, no fetch. **Every lead submitted
through aeygis.com has been silently discarded**, while the user is told they will
be contacted. The site also publishes no contact email at all.

Separate property from health.aeygis.com, but the same organisation.

---

## 6. Two incompatible brand systems

| | aeygis.com | health.aeygis.com |
|---|---|---|
| Theme | dark `#0a0a0a` | light `#f7fafd` |
| Accent | **yellow `#f9df5f`** | **teal `#0b8585`** |
| Fonts | Inter / JetBrains Mono | Cormorant Garamond / Source Sans 3 |
| Logo | flame/leaf glyph | shield motif |

No shared tokens. Four different teals exist on the health site alone (`#0b8585`
brand, `#0EA5A3` in-app, `#2DD4C4`, `#14B8A6`). The general site also contains no
link to the health vertical at all.

---

## 7. Conflicting compliance claims between the two sites

- **aeygis.com**: *"compliance for **HIPAA**, SOC 2, and PCI-DSS"* — HIPAA is the
  **US** statute, and the site carries no Canadian positioning whatsoever.
- **health.aeygis.com**: PHIPA / PIPEDA, ca-central-1, Canadian residency.

For a company selling Canadian healthcare data residency, the general site naming
a US statute is a positioning problem, not just a copy inconsistency.

---

## 8. The client Overview deck contradicts this pipeline's premise

`Aeygis_Cloud_Overview.pdf` closes with:

> *"Reply to the email or contact us directly — **no forms, no obligation**."*

and sequences **discovery call → then** written proposal. This pipeline has the
prospect complete a questionnaire **first**. Both can be true if the form is
positioned as an optional accelerator, but the deck's copy and the product
currently disagree.

---

## 9. Uptime figures are inconsistent across collateral

| Figure | Where | Meaning |
|---|---|---|
| **99.99%** | Framework, deck | AWS multi-AZ compute SLA |
| **99.9%** | Overview deck p.11 | Aeygis service baseline |
| **99.97%** | health.aeygis.com | unattributed |

Three different numbers for adjacent concepts. Easy to conflate in a generated
proposal, so the template deliberately uses **one**, sourced on purpose.

---

## 10. `docs/` would publish on the next live-site deploy ✅ MITIGATED

`amplify.yml` publishes `'**/*'` from the repo root, and `docs/` contains
`Aeygis_Cloud_Rate_Card.pdf` — stamped *CONFIDENTIAL — Internal Use Only*, with
delivery cost per hour, margin reasoning and competitor analysis.

**Verified 2026-08-17:** these currently return **404** on both hosts, so nothing
is exposed today. A `rm -rf docs` step was added to the live repo's `amplify.yml`
build phase so it stays that way. **That edit is authored but NOT deployed** — it
ships when the user next deploys the live site.

> ### ⚠ This protection was LOST and has been restored (2026-08-25)
>
> The website rewrite overwrote `amplify.yml`, and the `rm -rf docs` step went
> with it. The file was back to publishing `'**/*'` with the Rate Card still in
> the repository — so the next deploy would have put it on the public internet.
>
> Restored, and hardened: the build now **fails loudly** if `docs/` somehow
> survives the delete, rather than publishing it.
>
> ```yaml
> - rm -rf docs
> - test ! -e docs || (echo "FATAL - docs/ still present, refusing to publish" && exit 1)
> ```
>
> **The lesson is about the shape of this risk, not the line.** The protection
> lives in a file the site owner edits for unrelated reasons, it leaves no trace
> when removed, and nothing fails until the confidential document is already
> public. Worth checking `amplify.yml` after any site change, and worth moving
> the Rate Card out of the deployed repository entirely when there is somewhere
> else to put it.

---

## Open questions for the rate-card owner

Neither blocks the build; both affect real quotes.

1. **The docs contradict themselves at exactly 15 providers.** The tier table says
   Enterprise is "15+ providers"; the pricing rule says *"once a client **passes**
   15 providers… stop using the Professional formula"*. Resolved as `>= 15` →
   Enterprise per the user, but the Rate Card itself should be corrected.

2. **No explicit Enterprise *location* threshold exists.** `>= 10` was extended
   from the providers answer for consistency and is **not user-stated**. It is a
   single named constant (`ENTERPRISE_LOCATION_THRESHOLD`).
