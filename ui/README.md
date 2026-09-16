# Console design directions

Four candidate redesigns of the sales console, mocked with real pipeline data
(Lakeshore, Bayview, Riverside, Northern; the live approvals table). Each is a
self-contained HTML file — **open it in a browser to see the motion system**;
the PNG beside it is a still for quick comparison.

Each direction has TWO screens: the console (`0X-name.html`) and its login page
(`0X-name-login.html`).

Regenerate the PNGs after editing a mockup: `node ui/screenshot.mjs`

| # | Direction | One-liner | Motion signature |
|---|-----------|-----------|------------------|
| 01 | **Nocturne** | Dark glass, Linear/Vercel lineage — near-black blue, translucent panels, luminous teal, ambient aurora | Staggered rise-ins, drifting background glow, glowing selected card, live "PDF rendering" toast with spinner |
| 02 | **Porcelain** ✅ | Warm light SaaS, Stripe/Notion lineage — white cards floating on paper, big soft shadows, pastel status tints | Springy pop-ins, cards lift 3px on hover, pill filter chips, "Changes saved" toast |
| 03 | **Meridian** | Engineering precision, Vercel/GitHub lineage — pure white, hairline borders, one electric blue, keyboard-first | Fast 120ms everything, travelling underline nav, blinking command-bar caret, pulsing region dot, kbd hints throughout |
| 04 | **Solstice** | The branded one — Aeygis teal gradient rail + the proposal deck's gold, mint ground, teal-tinted shadows | Slow gradient drift on the rail, buoyant card float-ins, animated discovery progress meters, gold accent moments |

---

## Colour studies — ui/colors/ (2026-08-23)

Six palettes applied to the SHIPPED Porcelain layout, stamped from one
template so only colour varies. Each page has an in-page Light/Dark button;
stills exist for both themes (`<slug>.png` / `<slug>-dark.png`). All six were
derived numerically to WCAG AA before any HTML was written — see
`ui/colors/README.md` for the table, brand caveats and adoption notes.

## ✅ DECIDED: Porcelain (2026-08-23)

**Porcelain is built,** in both a light and a dark theme. It lives in
`apps/console` — `src/brand.css` plus the components around it. These mockups
are kept as the record of what was considered, not as anything the app reads.

### What shipped

- **Shell** — a translucent top bar over two independently-scrolling columns:
  a 360px intake queue of floating cards, and the clinic detail. The page
  itself never scrolls. The old indigo rail is gone; it was never an Aeygis
  colour, and Porcelain has no rail to put it on.
- **Type** — Manrope + IBM Plex Mono, the mockup's own pairing. Mono stays
  load-bearing: reference ids, hashes, version keys and money are
  machine-generated facts and are set in mono, so you can tell at a glance
  what a person typed and what the system minted.
- **Sign-in** — Porcelain's split composition. One large floating ink card
  carrying the brand, a white form card beside it. The image is bundled at
  `src/assets/auth-panel.jpg` rather than hot-linked: an internal console must
  not need a third-party CDN to render its own front door. The ink gradient
  under it is a real fallback, not decoration.
- **Motion** — one orchestrated entrance per surface plus micro-interactions.
  Transform/opacity only, so nothing triggers layout. No base rule sets
  `opacity: 0`, which is what makes the `prefers-reduced-motion` kill switch
  safe rather than a blank screen.

### Dark theme

Three states, not two — "follow the system" is the default and stamps nothing
on the document:

| `data-theme` | Behaviour |
|---|---|
| *(absent)* | follows `prefers-color-scheme`, live |
| `light` | light, even on a dark OS |
| `dark` | dark, even on a light OS |

The toggle sits in the top bar and on the sign-in screen. Choosing the theme
the OS is already on **clears** the stored choice rather than pinning it, so
toggling back to where you started leaves the console following the system
again — there is no separate "reset to system" control to explain. An explicit
choice is applied by an inline script in `index.html` before first paint, so
it never flashes the other theme.

Two things about the dark palette worth knowing:

- **It was derived numerically, not eyeballed.** Every foreground/background
  pair the console renders was checked before a line of CSS was written —
  including WCAG 1.4.11 non-text contrast for a form field's boundary, which
  is why dark inputs get their own `--field-line` token at 3:1 against the
  field fill rather than reusing the card hairline.
- **The accent ladder lifts.** `#0b8585` on a near-black ground has too little
  separation to read as the action colour, so dark uses a brighter shade of
  the same hue with a near-black label (`--on-accent`). The verified brand
  value is unchanged; what changes is which shade sits behind a label.

The dark palette is declared **twice** — once under
`@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` and once
under `:root[data-theme='dark']` — because CSS cannot share one token list
between a media query and a plain selector. `npm run check:ui` parses
`brand.css` and fails if the two drift, since a token added to one but not the
other produces a half-dark UI in exactly one of the three states.

### Three changes to what the mockups showed, all deliberate

**The mockup palette failed WCAG AA and was corrected.** `--dim` at `#8a919c`
measured **2.77:1** on the chip ground — 77 text nodes below AA on the first
run of `check:ui`. It is now `#636870`, which clears 4.5:1 on all four grounds
while staying clearly below `--body` in the hierarchy. The four status hues
were re-derived against their own tints at ≥4.8:1.

**Overview and Scope are NOT paired side by side.** They were, briefly, for
density — and it broke the section nav outright. Siblings share a top edge, so
a vertical scroll-spy cannot tell them apart, and "Scope" won the highlight
permanently. All seven sections are stacked full width. Navigation correctness
beats a denser first screen.

**The logo tile does not flip with the theme.** `--brand-tile-bg` is white in
both, and deliberately absent from the dark blocks: the Aeygis mark is a fixed
asset drawn in dark ink, so a tile that follows the theme makes it disappear
into its own background.

### Lead status is editable

The status pill in the detail header is a `<select>` styled as the pill it
replaces — a real control, so keyboard and screen-reader behaviour come for
free and the native option list follows the theme (`color-scheme` is set per
theme). Any status can move to any other; a change joins the edit buffer and
commits with **Save changes**, with an `unsaved` marker beside the pill until
it does.

Two cascade traps were avoided deliberately, both noted in `brand.css`: every
rule is `select.pill-select` (0,2,1) so it outranks the global `select` and
`select:focus-visible` — reusing the plain `.status-*` classes would have lost
to `select` and painted the pill as a form field, the same collision that once
rendered the sign-in button as a text box. And the tints set `background-color`
rather than the `background` shorthand, which would wipe out the chevron drawn
in `background-image`.

### Known deviation

Light-mode input borders do not meet WCAG 1.4.11 (3:1 for a control's
boundary). Reaching it needs roughly `#928f89`, a visibly outlined field that
is not this design — the same trade every soft light SaaS system makes. Dark
mode **does** meet it, because there an invisible field boundary is a
usability problem and not only a spec one. Flagged rather than silently
ignored; say the word and the light fields get real outlines.

### Verifying it

```
npm run check:ui        # dev server must already be running
```

127 checks in a real browser, **in both themes**, at five widths, covering the
class of defect that compiles, serves and mounts perfectly: horizontal
overflow, elements past the viewport edge, text clipped without an ellipsis,
WCAG AA contrast, the typeface actually painted, section jumps landing under
the sticky header, `prefers-reduced-motion` leaving content invisible, and
console errors. It also refuses to run against a stale dev server.

It earns its keep. Four real defects so far that nothing else could see:

1. **77 text nodes below AA** — the mockup palette, carried over unchanged.
2. **The sign-in submit button rendering as a white text field.** Amplify's
   submit carries `amplify-field-group__control` as well as
   `amplify-button--primary`, so styling the former as an input (`0,2,0`)
   silently outranked the latter (`0,1,0`). Every structural probe passed
   while the main action of the screen was the wrong colour — which is why the
   script now asserts brand surfaces by computed colour, not just layout.
3. **Half the console painting in Segoe UI Black.** Amplify's stylesheet sets
   `font-family` on `[data-amplify-theme]`, and `ThemeProvider` wraps the
   whole app — so every element without its own `font-family` inherited the
   auth theme's font instead of `--font-sans`. `document.fonts.check()`
   answered "Manrope: true" throughout, because availability is not usage;
   only `CSS.getPlatformFontsForNode` can see what was actually painted.
4. **White-on-teal at 2.59:1 in dark mode.** Amplify's primary button label
   defaults to white, which works against the light theme's deeper accent and
   fails against the brighter dark one.
