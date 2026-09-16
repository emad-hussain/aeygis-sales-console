# 9. The internal console

← [The proposal document](08-proposal-document.md) · [Index](README.md) · Next: [Email delivery](10-email-delivery.md)

[`apps/console/`](../../apps/console/) — React 19, Vite 8, Amplify UI Authenticator.

The app staff actually use. It runs on a developer's machine today
(`npm run console` → `http://localhost:5173`); it has not been hosted yet.

---

## 9.1 Structure

```
main.tsx           Amplify.configure(outputs) — must run before anything else
  └─ App.tsx       ThemeProvider → Authenticator.Provider → AuthGate
       ├─ SignIn                       (signed out)
       │    ├─ AuthBrandPanel          the ink card carrying the brand
       │    └─ Authenticator           hideSignUp — no self-registration
       └─ Console                      (signed in)
            ├─ topbar   brand · ThemeToggle · UserMenu
            ├─ queue-pane               left column, independently scrolling
            │    ├─ count + Refresh
            │    ├─ filter chips (derived from loaded rows)
            │    └─ queue items
            └─ detail-pane              right column, independently scrolling
                 └─ AssessmentDetail
                      ├─ Overview · Scope · Notes
                      ├─ PricingPanel        live quote + Generate
                      ├─ Discovery           20 questions + custom ones
                      ├─ Proposal            schedule + responsibility matrix
                      └─ ApprovalPanel       versions, decisions, View PDF
                           └─ DeliveryPanel  send + full history
```

**It is an app frame, not a document.** `100dvh`, no page scroll, two independently
scrolling columns. Reviewing a clinic means moving between columns, not scrolling one
endless page.

---

## 9.2 Authentication and roles

### Sign-in

`<Authenticator hideSignUp>` — **there is no self-registration.** Staff accounts are
provisioned by an administrator and placed in a Cognito group. Open sign-up on an internal
console holding confidential client data would be an obvious hole.

The sign-in screen renders **outside** the Authenticator's own single-column shell, so it
can use the split composition. The heading follows the Authenticator's route (sign-in,
forgot password, reset code, MFA challenge), because otherwise the card would cheerfully
say "Sign in" above a password-reset form. Routes are keyed **by string**, not by the
`AuthenticatorRoute` union, so a route added by a future Amplify release falls back to the
sign-in copy instead of failing to compile.

The brand image is bundled at `src/assets/auth-panel.jpg` rather than hot-linked: **an
internal console must not need a third-party CDN to render its own front door.** The ink
gradient under it is a real fallback, not decoration.

### `useRole()`

Reads `cognito:groups` from the **ID token**.

```ts
role = groups.includes('approver')    ? 'approver'
     : groups.includes('contributor') ? 'contributor'
     : 'none'
```

Approver outranks contributor when a user holds both.

**This is for UI shaping ONLY.** Hiding a button is not a security control — anyone can
call the API directly. Authorization is enforced server side by `allow.groups([...])` on
the models and by the group check inside each Lambda.

**Groups reflect membership at sign-in.** A user added to `approver` mid-session must sign
out and back in. That is also why `Approval` records snapshot the approver's groups at
decision time rather than resolving them later.

### What a user in no group sees

Not a blank screen. The top bar shows a `no role` pill, the queue explains that the API
refuses to list assessments, and the detail pane says an administrator must add them to
`contributor` or `approver`.

**That path is worth testing deliberately** — it demonstrates that authentication is not
authorization, and that the API refuses rather than the UI merely hiding controls.

---

## 9.3 The data layer

[`apps/console/src/client.ts`](../../apps/console/src/client.ts)

Always `authMode: 'userPool'`. There is no guest path in the console at all.

**Note what is absent: no create and no delete on `Assessment`.** The schema grants staff
only `read` and `update`, and the model is written solely by the intake Lambda. A console
that could create assessments would let a rep invent a lead.

### The client is created lazily — do not hoist it

```ts
let cachedClient: DataClient | null = null;
function getClient() {
  cachedClient ??= generateClient<Schema>({ authMode: 'userPool' });
  return cachedClient;
}
```

`generateClient()` requires Amplify to already be configured. At module scope it runs
during **import evaluation**, which happens *before* the importing module's body — so
`main.tsx`'s `Amplify.configure(outputs)` had not run yet and the console failed at startup
with:

```
Amplify has not been configured. Please call Amplify.configure()
before using this service.
```

Creating it on first use makes correctness independent of import order, which is not
something a reader should have to reason about.

### The partial-update rule

The generated `updateAssessment` resolver carries, for both staff groups:

```
allowedFields:            [ ...every field... ]
nullAllowedFields:        []
isAuthorizedOnAllFields:  false
```

Every field may be **written**, but none may be set to **null**. Sending one null fails the
whole mutation with `Unauthorized on [thatField]` — the write is rejected outright, not
partially applied. Verified in a browser against the deployed API: nulling `internalNotes`
and nulling `patientCount` both fail the same way, so it is not about any particular field.

That is a consequence of the model rule being `.to(['read','update'])`. Widening it is a
backend change and a deploy, so the console works within it instead:

- **Send only what changed.** Spreading an object with `undefined` values would put those
  keys in the GraphQL input as nulls.
- **Clear a string with `''`, never null.**
- **A number genuinely cannot be cleared through this API.** That case is refused loudly,
  with a message saying what actually happened — AppSync's own message reads like a
  permissions problem with the signed-in user, which it is not.

### `getPdfUrl()`

Generates a presigned download link, or returns `null` if the PDF has not finished
rendering.

```ts
getUrl({ path, options: { expiresIn: 300, validateObjectExistence: true } })
```

- **It goes through the same Cognito identity-pool credentials the rest of the app uses**,
  so it is bound by the existing storage rule. No new IAM grant; it only exposes what staff
  could already reach.
- **`validateObjectExistence` is what makes "not rendered yet" distinguishable from
  "rendering is broken".** Without it, `getUrl()` happily signs a URL for an object that may
  not exist, and the failure shows up later as a confusing 403 in a new tab instead of a
  clear state in the panel.
- **A `NotFound` error is the expected "still rendering" case** and returns null. Anything
  else — auth, network — is rethrown so it surfaces as a real error.
- **`expiresIn` is short (5 minutes) on purpose.** The link is generated the moment someone
  clicks "View PDF", used immediately, and is not meant to be copied around or bookmarked.
  The proposal is confidential client business information.

### The S3 key is computed, not read back

```ts
`proposals/client/${proposalId}/${versionKey}.pdf`
```

The same formula `price-proposal` writes with and `delete-proposal-version` deletes with.
Deliberately **not** read from `ProposalVersion.pdfS3Key` — see
[Data model §4.3](04-data-model.md#43-proposalversion--an-immutable-priced-version).

---

## 9.4 The panels

### `PricingPanel`

Live quote for the meeting. Three behaviours that must not be "helpfully" relaxed:

1. **It refuses to price until exact counts are confirmed.**
2. **Enterprise shows no price.** The engine returns a refusal branch with no price fields;
   the panel renders that refusal rather than filling in the guide range as if it were a
   quote.
3. **When Micro and Starter both apply, both are shown side by side.**

The discount slider is a percentage of list. Generate is available to both roles.

On success the notice says the version is **immutable — to change it, generate a new
version** — and points at the Approval panel below.

### `ApprovalPanel`

Versions and their decisions. Three deliberate choices:

1. **It shows the content fingerprint next to each version and sends it back as
   `expectedContentSha256`.** If a newer version was minted while the approver was reading,
   the backend refuses instead of approving different numbers. **The approver is approving
   specific bytes, not "the latest".**
2. **It never hides the approve control from a contributor by pretending the feature does
   not exist** — it explains that approval requires the approver group. Hiding a button is
   not a permission model; the API is the boundary.
3. **It shows the decision history**, with who decided and when. The groups that person
   held *at the moment of the decision* are still written to the `Approval` record and are
   still in the audit trail — they were removed from the screen on 2026-08-27 because on a
   row that already carries an approval they restated what the approval implies. Membership
   changes later; the record does not.

**Reject and Delete are two-click armed.** The first click arms, the second confirms, and
the arm self-clears after four seconds so a stale arm cannot be triggered by an unrelated
later click in the same place. Delete's confirm label **names the version explicitly**,
because that row is about to stop existing rather than gain a status.

**An approved version offers only View PDF.** No Approve, no Reject, no Delete. A version is
immutable and `Approval` is append-only, so you do not revise an approved proposal — you
mint a new version and approve that. Re-approving would append a second identical decision,
and "rejecting" an approved version would leave two contradictory records with no way to say
which governs. Neither is something anyone means to do.

A **rejected** version deliberately keeps its buttons: a rejection reversed by a later
approval is a legitimate sequence the append-only log records honestly.

> **Be clear about what this is.** The backend does **not** enforce it — `decide-proposal`
> has no already-decided check and would append a second decision if the mutation were
> called directly. Hiding the buttons prevents the accident, not the act. It is the same
> distinction drawn about roles above: *the API is the boundary, not the screen.* The gap is
> narrow (approver-only, and additive rather than destructive in an append-only log) and is
> recorded rather than quietly closed.

**View PDF sits with the other actions**, first in the cluster. It is the only read-only
control there and the only one every role can use, so the further right you travel the
harder the click is to undo, with Delete last. It moved out of the fingerprint column on
2026-08-27; `npm run check:actions` measures the result against the old layout so the move
cannot be blamed for — or hide — a horizontal-scroll regression.

### `UserMenu` — the account panel, and two-factor enrolment

Initials in the top bar; identity, role, groups, **two-factor**, and Sign out behind a
click. Sign out is deliberately inside the panel rather than beside it — a rare,
disruptive action should not sit permanently next to controls people use all day.

**The `2-factor` row was added 2026-09-16, and it is the only place enrolment can
happen.** The user pool is set to `OPTIONAL` TOTP. That word matters more than it
looks:

| Pool mode | What the Amplify `Authenticator` does at sign-in |
|---|---|
| `REQUIRED` | forces TOTP setup before letting anyone in — no app code needed |
| `OPTIONAL` | **nothing.** People opt in *after* signing in, which needs `setUpTOTP()` and `updateMFAPreference()` called from a screen you build |

Without this row, the pool setting would be true and every account would stay
password-only forever. `check:ui` asserts the row and its control are present for
exactly that reason — the failure mode is silent.

**How the flow is built.** The decisions are a pure reducer in
[`mfaFlow.ts`](../../apps/console/src/mfaFlow.ts), tested in isolation (20 tests,
including every Cognito error name `verifyTOTPSetup` can raise and the case where a
response arrives for a step the person has already left). The component,
[`MfaSetup.tsx`](../../apps/console/src/MfaSetup.tsx), only calls Amplify, dispatches
what came back, and renders the step. Same split as `salvage.ts` and `validate.ts`
on the backend: decisions where they can be tested, I/O where it must be.

Three things in it that are easy to get wrong:

- **Two calls, both required.** `verifyTOTPSetup()` proves the person captured the
  secret. It does **not** make Cognito challenge them — that needs
  `updateMFAPreference({ totp: 'PREFERRED' })` as well. Both are awaited before the
  panel shows "on", so "on" is only ever displayed once it is true.
- **Two exception names mean "wrong code".** Cognito reports a mistyped code during
  setup as `EnableSoftwareTokenMFAException`, not `CodeMismatchException`. A screen
  handling only one shows a raw exception name to half the people who mistype. Both
  keep the QR on screen for another try; an expired setup
  (`SoftwareTokenMFANotFoundException`) cannot be retried and starts over.
- **The secret is shown as text as well as a QR.** Every authenticator app accepts a
  typed key, and the QR is a canvas render that can fail. If it does, the text key is
  the whole flow rather than a dead end.
- **The status read waits for identity.** `fetchMFAPreference()` runs only once the
  ID token is known (`email` non-null). Opening the panel in the first moments after
  sign-in used to fire it against an empty session, which rejected in ~5 ms and left
  the row on "unknown". See [§16.34](16-gotchas.md#1634-optional-mfa-on-the-pool-protects-nobody-by-itself).

The QR is rendered with `qrcode`, which `@aws-amplify/ui-react` already depends on
for its own TOTP screen — so it is guaranteed present wherever the Authenticator is.
It is declared in the console's `package.json` anyway; a routine `ui-react` upgrade
must not be able to silently remove a module this app imports. Its types are a local
declaration written against the installed source, not a fetched package.

### `DeliveryPanel`

**Renders INSIDE the approvals panel**, not as a panel of its own. That is deliberate: it
needs the same versions and the same decision history the table above already loaded.
Giving it its own section would mean a second independent read of those records — which can
land either side of a decision and show the two blocks disagreeing.

Three more deliberate choices:

1. **Sending is armed, not instant.** One click cannot put a document in a client's inbox.
   Same two-click pattern as reject and delete, for the same reason: it cannot be undone.
   **This is the only action in the system that reaches outside the company.**
2. **A refusal is not an error.** While SES is in the sandbox, `blocked` is the *expected*
   outcome for a real client address, so it is shown as a warning with an explanation rather
   than a red failure. Reading "failed" when the true answer was "we deliberately refused"
   sends people debugging a fault that does not exist.
3. **The fingerprint goes back with the send**, same guard the approvals table uses.

**The SES message id.** It is far too long for a table column and, shown bare, reads as a
random string and gets ignored — but it is the one thing that lets support trace a specific
message with AWS when a client says they never received it.

The chip is labelled `SES id`, holds the **full 60-character id in the DOM**, is shortened
by CSS (`text-overflow: ellipsis`), and copies to the clipboard on click with a `copied`
confirmation. If the clipboard is refused — permissions, or a page served over plain HTTP —
it selects the value instead, which works **precisely because** the element holds the whole
id: a selection picks up every character.

> An earlier version sliced the id in JavaScript, so only 14 characters existed in the DOM.
> It could be neither read nor selected. Truncate in CSS, not in the string.

---

## 9.5 Theme

Three states, not two, because "follow the system" is the default and stamps nothing on the
document:

| State | `<html>` | Behaviour |
|---|---|---|
| `choice === null` | nothing stamped | Follow `prefers-color-scheme`, **live** — the media query is subscribed, not read once at mount |
| `choice === 'light'` | `data-theme="light"` | Light, even on a dark OS |
| `choice === 'dark'` | `data-theme="dark"` | Dark, even on a light OS |

**The dark palette is declared twice**, and neither is redundant:

```css
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ... } }
:root[data-theme='dark'] { ... }
```

The `:not()` guard is what lets an explicit *light* choice beat a dark OS; the second block
is what lets an explicit *dark* choice beat a light OS.

**The two dark blocks must stay identical.** `npm run check:ui` parses `brand.css` and fails
if they drift — a real hazard with a token list this long.

**Choosing the theme the OS is already on clears the stored choice** rather than pinning it.
So toggling back to where you started leaves the console following the system again, and
there is no separate "reset to system" control to explain. Divergence is the only thing
worth storing.

**The initial stamp is not done in React.** A `useEffect` runs after first paint, so an
explicit choice would flash the other theme first. An inline script in `index.html` applies
it before paint. That script and `useTheme.ts` share `STORAGE_KEY` and **must keep sharing
it**.

`localStorage` throws outright in some privacy modes, so every read and write is wrapped.

---

## 9.6 Design system — "Porcelain"

Chosen by the user from four rendered candidates in [`ui/`](../../ui/): Nocturne (dark
glass), **Porcelain** (warm light SaaS), Meridian (engineering precision), Solstice (the
branded one). Each mockup has a console screen and a login screen; the design record is
[`ui/README.md`](../../ui/README.md).

### Colour

**Teal `#0b8585` is the one verified brand value** — it is the live health site's
`meta theme-color` and webmanifest value — and it is the action/accent colour throughout.

The status hues (blue, violet, amber, rose) are **tints only**. They never appear as a
saturated fill larger than a pill, so the accent keeps its monopoly on *"this is the thing
to click"*.

```
--ground     #f6f5f2      warm paper ground
--surface    #ffffff      the floating cards
--ink        #1f2329      strong text
--body       #545b66      body text
--line       #ebe8e2      the visible divider
--accent     #0b8585      Aeygis teal
```

> **A token worth knowing about:** `--surface-line` is **`transparent`** in light mode. It
> is not the divider token. Use `--line`. A delivery-block divider was once invisible in
> light mode for exactly this reason.

### Type

**Manrope + IBM Plex Mono.** Manrope's high-waisted, slightly geometric lowercase is what
gives Porcelain its warmth at small sizes; its 800 weight carries headings without needing a
display face.

**Mono is load-bearing, not decorative.** It is reserved for machine-generated facts:
reference ids, content hashes, version keys, money. Sans is for human content. **You can
tell at a glance whether a value was typed by a person or minted by the system.**

### Motion

One orchestrated entrance per surface plus micro-interactions, never scattered effects.
Everything animates `transform`/`opacity` only, so it runs on the compositor and never
triggers layout.

> **Every entrance uses `both` fill mode and NEVER sets `opacity: 0` in a base rule.** Under
> `prefers-reduced-motion` the animations are cancelled outright, and an element whose only
> opacity came from a keyframe would otherwise stay **permanently invisible**. This has
> bitten `brand.css` before.

---

## 9.7 Two Vite settings that exist because of real failures

```ts
resolve: {
  dedupe: ['react', 'react-dom'],
  alias: { '@aeygis/domain': ..., '@aeygis/pricing': ... },
}
```

**`dedupe` is belt-and-braces against a duplicate React.** npm hoisted `react@18.3.1` to the
workspace root while this app declared `^19.2.8`, so `@aws-amplify/ui-react` and the app
loaded **different copies**. The page rendered blank with *"Invalid hook call … more than one
copy of React"* and *"Cannot read properties of null (reading 'useEffect')"*.

Root `overrides` in the top-level `package.json` pins one version at install time; `dedupe`
makes Vite resolve a single copy even if the tree drifts again.

**The aliases point at TypeScript source**, so the workspace packages need no build step.
Note the console aliases only `domain` and `pricing` — `pricing-internal` is deliberately
not resolvable from here, on top of the dependency-cruiser rule that forbids it.

---

## 9.8 Building it

```bash
npm --workspace @aeygis/console run build
```

Runs `tsc --noEmit` first, then `vite build`. Output goes to `apps/console/dist/`.

**Nothing hosts that bundle yet.** Creating an Amplify Hosting app is an AWS action needing
approval, and it also needs a decision about who may reach the console — it holds
confidential client business information and can send documents to clients, so it should not
sit on a public URL protected only by a password form.
