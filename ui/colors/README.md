# Colour studies

Six palettes applied to the **shipped Porcelain console layout** — one
template, six token blocks, so the layout is a controlled variable and the
only thing that differs between any two files is colour.

**Open the `.html` in a browser and use the Dark button (top right)** — every
study ships a light and a dark theme. The PNGs beside each file are stills of
both (`<slug>.png` light, `<slug>-dark.png` dark). Regenerate with
`node ui/screenshot.mjs`.

| # | Palette | Feel | Accent | Note |
|---|---------|------|--------|------|
| c1 | **Porcelain Teal** | warm, calm, current | `#0b8585` | The shipped palette, included so every other study is judged against it rather than against memory. |
| c2 | **Ink & Paper** | quiet, editorial, Notion/Linear-light | `#1f2428` | Colour almost disappears: neutral greys, ink-black primary actions, and the status pills become the only colour on screen — which makes state read louder, not quieter. Dark mode inverts to a white primary button. |
| c3 | **Navy & Teal** | crisp, financial, trustworthy | `#0b8585` | Navy #0a1b33 is a VERIFIED live-site value (health.aeygis.com brand tokens), so this stays inside the brand family: navy carries identity (headings, active nav, avatar), teal keeps the actions. Dark mode is navy-black rather than neutral black. |
| c4 | **Evergreen** | health, reassurance, low urgency | `#2e7d4f` | The one study that leaves teal behind: forest green actions on sage-tinted paper. Reads unmistakably "healthcare" but drifts from the verified brand teal — a rebrand-sized decision, not a restyle. |
| c5 | **Indigo** | Stripe-adjacent, energetic, tech-forward | `#4f46e5` | The look most "modern SaaS" products reach for. Caveat stated plainly: indigo is NOT an Aeygis colour — the Signal rail was removed for exactly this reason — so this is here for honest comparison, not as a recommendation. |
| c6 | **Slate & Gold** | premium, warm, document-matched | `#0b8585` | Ties the console to the proposal deck: teal stays the action colour, and the deck’s gold appears only as moments — a hairline on the hero card and the recommended tag. Gold never carries text or fills a control; it decorates. |

## What is constant, and why

- **Layout** — every file is the same condensed console (top bar, queue,
  chips, hero with the status pill, panels, toast). Comparing colour fairly
  means changing nothing else.
- **Status pills** — blue/violet/amber/rose are semantic state colours,
  already AA-derived, and identical in all six. A palette choice changes the
  console's identity, not what "New" or "In review" looks like.
- **Contrast** — all six palettes (both themes) were derived numerically
  before any HTML existed: `check_palettes.py` gates 15 fg/bg pairs per
  palette per theme at WCAG AA (4.5:1 text, 3:1 control findability),
  including `--dim` on the chip ground — the exact pair that shipped at
  2.77:1 when the original Porcelain mock was eyeballed. Tightest surviving
  pair in the whole set: 4.71:1.

## Brand notes, stated up front

- **Teal `#0b8585` is the one VERIFIED brand value** (live health.aeygis.com
  theme-color). c1, c3 and c6 keep it as the action colour.
- **Navy `#0a1b33` (c3) is also a verified live-site value**, so Navy & Teal
  stays inside the brand family.
- **Gold (c6) is the proposal deck's accent** — it ties the console to the
  documents it produces, and is used only decoratively (hero hairline,
  recommended tag), never carrying text.
- **Evergreen (c4) and Indigo (c5) leave the brand teal.** Indigo in
  particular is the colour the old Signal rail was removed for not being.
  They are here for honest comparison, not as recommendations.

## Adopting one

The winner lands by swapping the token blocks in
`apps/console/src/brand.css` (both dark blocks — `check:ui` fails if they
drift) — no layout change, console-only, nothing to deploy to AWS. Full
AA re-derivation for every console surface happens at adoption time; these
studies cover the pairs they render.
