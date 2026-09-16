import type { ClientProposalPayload } from '@aeygis/pricing';

/**
 * Proposal HTML, modelled on docs/Aeygis_Cloud_Overview.pdf.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN VALUES ARE EXTRACTED FROM THE DECK, NOT INVENTED
 * ═══════════════════════════════════════════════════════════════════════════
 * Read out of the PDF with PyMuPDF (fill colours by area, and font/size/colour
 * per text span), so the proposal reads as the same family of document the
 * client has already seen:
 *
 *   page background   #f6f7fb        dark cover / bands  #0a1830
 *   card              #ffffff        rules / borders     #e7e9ef
 *   teal accent       #15b8a7        heading ink         #141f2e
 *   body text         #4b5563        muted               #9aa7bc
 *   purple            #7564e8        gold                #e8b84a
 *   blue              #4b9ff5        highlight bg        #fff6db / #f3e3a8
 *   typeface          Lato 400 / 700 / 900
 *
 * Worth recording: the deck is a DARK cover with LIGHT interior pages, and its
 * wordmark is gold on dark / near-black on light. That is a different system
 * from health.aeygis.com (light navy + teal, Cormorant Garamond), which is why
 * the console and this document deliberately do not look alike.
 *
 * Fonts and logos are inlined as data URIs. Chromium in Lambda has no system
 * fonts and no reliable network, so anything not embedded would render as
 * fallback glyphs or blank boxes.
 *
 * Page size is 960x679pt landscape to match the deck's own geometry.
 */

export interface TemplateAssets {
  readonly lato400: string;
  readonly lato700: string;
  readonly lato900: string;
  readonly logoOnDark: string;
  readonly logoOnLight: string;
}

/** Escapes text for HTML. Every interpolated value passes through this. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderProposalHtml(p: ClientProposalPayload, assets: TemplateAssets): string {
  const footer = (page: string) =>
    `<footer><span>${esc(p.preparedBy)} &nbsp;|&nbsp; Confidential proposal for ${esc(p.preparedFor)} &nbsp;|&nbsp; ${esc(p.issuedOn)}</span><span class="pg">${page}</span></footer>`;

  const planRows = p.plans
    .map(
      (plan) => `
      <tr class="${plan.isRecommended ? 'rec' : ''}">
        <td>
          <strong>${esc(plan.planLabel)}</strong>
          ${plan.isRecommended ? '<span class="tag tag-teal">Recommended</span>' : ''}
          ${plan.customQuote ? '<span class="tag tag-gold">Starting point</span>' : ''}
        </td>
        <td class="num">${esc(plan.monthly.display)}<span class="per">/month</span></td>
        <td class="num">${plan.annualCheckup ? `${esc(plan.annualCheckup.display)}<span class="per">/year</span>` : '<span class="dim">&mdash;</span>'}</td>
        <td class="num"><strong>${esc(plan.firstYearTotal.display)}</strong></td>
      </tr>`,
    )
    .join('');

  // Current-state tiles: only fields the prospect actually answered (or that
  // matched a known code) appear. Order mirrors the questions as asked on the
  // public form. The whole page is omitted if none were answered — a page
  // with nothing on it would look like a rendering bug, not a clean skip.
  const currentStateRows: { label: string; value: string }[] = [
    { label: 'Current hosting', value: p.currentState.hosting },
    { label: 'Multi-factor authentication', value: p.currentState.mfa },
    { label: 'Backups tested regularly', value: p.currentState.backups },
    { label: 'Documented incident response plan', value: p.currentState.incidentPlan },
    { label: 'Last compliance risk assessment', value: p.currentState.lastRiskAssessment },
  ].filter((row): row is { label: string; value: string } => row.value !== null);
  const hasCurrentState = currentStateRows.length > 0;

  const stateTiles = currentStateRows
    .map(
      (row) => `
      <div class="state-tile">
        <div class="state-k">${esc(row.label)}</div>
        <div class="state-v">${esc(row.value)}</div>
      </div>`,
    )
    .join('');

  // Page numbers shift automatically when the current-state page is skipped,
  // so the footer never disagrees with the actual page count.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  let pageNo = 1;
  const pCover = pad2(pageNo++);
  const pCurrentState = hasCurrentState ? pad2(pageNo++) : null;
  // Every one of these is conditional, so the numbering has to be computed in
  // render order rather than hardcoded — the same reason the current-state page
  // introduced this counter.
  // Narrative order: their situation, why it matters, what it buys, then the
  // price. The proof pages sit BEFORE the investment page deliberately — a
  // number read before any reason to want it is just a number.
  const pRegulatory = pad2(pageNo++);
  const pImpact = pad2(pageNo++);
  const hasSpend = p.spendComparison !== null;
  const pSpend = hasSpend ? pad2(pageNo++) : null;
  const pInvestment = pad2(pageNo++);
  const hasTracks = p.migrationTracks.length > 0;
  const pTracks = hasTracks ? pad2(pageNo++) : null;
  const pDelivery = pad2(pageNo++);
  const hasSchedule = p.schedule !== null;
  const pSchedule = hasSchedule ? pad2(pageNo++) : null;
  /**
   * The matrix CHUNKS across pages. It used to be one page, which silently
   * clipped: `.page` is `overflow: hidden`, so once a clinic accumulated enough
   * custom rows the surplus simply stopped being drawn — present in the DOM,
   * absent from the PDF, and invisible to a layout check run against sample
   * data with one custom row. Found by the browser walk against real data that
   * had grown to fourteen rows.
   *
   * PACKED BY ESTIMATED HEIGHT, not by a fixed row count — because row height
   * is not fixed. Measured in a real browser: a short approved row is ~52px,
   * but a row whose cells run to MAX_RESPONSIBILITY_TEXT_LENGTH wraps to three
   * lines and reaches ~88px. The usable height between the card top and the
   * footer is 593px.
   *
   * A fixed count cannot satisfy both ends: seven short rows should sit on one
   * page (the default matrix is exactly seven), yet six tall ones already
   * overflow. So rows are packed against a height budget instead, which keeps
   * the common case on a single page and still cannot spill.
   */
  const MATRIX_BUDGET_PX = 500; // 593 available, less thead and card padding
  const MATRIX_LINE_PX = 24;
  const MATRIX_ROW_PADDING_PX = 28;
  // Calibrated against the browser, not assumed: the approved rows' ~58-char
  // cells render on ONE line (measured row height 52px), while a 160-char cell
  // wraps to three (measured 88px). 50 chars/line called the approved rows
  // two-liners and split the default seven-row matrix across two pages for no
  // reason; 62 reproduces both observations.
  const MATRIX_CHARS_PER_LINE = 62;

  const matrixRowHeight = (r: { area: string; aeygis: string; clinic: string }) => {
    const lines = Math.max(
      1,
      Math.ceil(r.area.length / 26),
      Math.ceil(r.aeygis.length / MATRIX_CHARS_PER_LINE),
      Math.ceil(r.clinic.length / MATRIX_CHARS_PER_LINE),
    );
    return MATRIX_ROW_PADDING_PX + lines * MATRIX_LINE_PX;
  };

  const responsibilityPages: (typeof p.responsibilities)[number][][] = [];
  {
    let current: (typeof p.responsibilities)[number][] = [];
    let used = 0;
    for (const row of p.responsibilities) {
      const h = matrixRowHeight(row);
      // A single row taller than the budget still gets its own page rather
      // than being dropped; the cap on cell length keeps that from clipping.
      if (current.length > 0 && used + h > MATRIX_BUDGET_PX) {
        responsibilityPages.push(current);
        current = [];
        used = 0;
      }
      current.push(row);
      used += h;
    }
    if (current.length > 0) responsibilityPages.push(current);
  }
  const hasResponsibilities = responsibilityPages.length > 0;
  const pResponsibilities = responsibilityPages.map(() => pad2(pageNo++));
  // Co-existence rides with the responsibility matrix: both answer "who owns
  // what", and showing one without the other invites the wrong conclusion
  // about the clinic's existing IT provider.
  const pCoExistence = hasResponsibilities ? pad2(pageNo++) : '';
  const pSecurity = pad2(pageNo++);
  const pContinuity = pad2(pageNo++);
  // Uptime gets its own page. Sharing one with the recovery objectives
  // overflowed the footer by 38px — caught by `npm run check:layout`, which is
  // why that script exists. Splitting also suits the content: the two figures
  // need room to be labelled properly rather than compressed into a corner.
  const pServiceLevels = pad2(pageNo++);
  // Positioned as the closing argument: last substantive page before the
  // commercial terms and the signature. It answers "why this vendor" at the
  // point the reader is deciding, not on the way in.
  const pWhyAeygis = pad2(pageNo++);
  const pTerms = pad2(pageNo++);
  // Acceptance sits immediately after the terms it accepts, and before the
  // sources appendix — a signature page buried behind citations invites being
  // missed entirely.
  const pAcceptance = pad2(pageNo++);
  // NO sources-and-references page, and nothing after Acceptance: a signature
  // page is the last thing a reader should reach.
  //
  // Removing it orphans no claim. Checked page by page against the rendered
  // document before doing it: IDC's 44/62/94 also sits on the impact page with
  // its full citation, CIRA's 45% and the $1,000,000 PHIPA maximum on the
  // regulatory page with theirs, and 99.99% on the service-levels page
  // attributed to "Amazon Web Services' contractual SLA". The only entries
  // that appeared NOWHERE else were Flexera's 27%/84% and the Well-Architected
  // pillars — claim and source left together, so no statistic is now unsourced.
  //
  // p.citations is still built and tested in the client payload; nothing
  // renders it.

  // NO technical-discovery appendix.
  //
  // It used to render every one of the approved questions and its staff-
  // written answer as an appendix. Removed on request: discovery is a
  // working record for the console, not something the client needs back.
  //
  // Worth knowing if it is ever restored: those answers are free text a
  // staff member typed, and rendering them was the one route by which
  // unreviewed internal wording could reach a client document. The
  // confidentiality guard scanned it (that is what
  // assertHtmlFreeOfConfidentialWords is for), but not rendering it at all
  // removes the vector rather than policing it.
  //
  // The payload still CARRIES p.discoveryAnswers — toClientPayload builds
  // and tests it as part of the closed client-safe type. Nothing renders
  // it now; restoring the appendix is a template change alone.

  const phaseCards = p.phases
    .map(
      (phase, i) => `
      <div class="phase" style="--bar: ${['#15b8a7', '#7564e8', '#e8b84a', '#4b9ff5', '#15b8a7'][i % 5]}">
        <div class="phase-bar"></div>
        <div class="phase-n">${i + 1}</div>
        <h4>${esc(phase.name.replace(/^\d+\.\s*/, ''))}</h4>
        <p class="obj">${esc(phase.objective)}</p>
        <p class="del">${esc(phase.deliverables)}</p>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(p.documentTitle)} — ${esc(p.preparedFor)}</title>
<style>
  @font-face { font-family: 'Lato'; font-weight: 400; font-style: normal;
    src: url(data:font/woff2;base64,${assets.lato400}) format('woff2'); }
  @font-face { font-family: 'Lato'; font-weight: 700; font-style: normal;
    src: url(data:font/woff2;base64,${assets.lato700}) format('woff2'); }
  @font-face { font-family: 'Lato'; font-weight: 900; font-style: normal;
    src: url(data:font/woff2;base64,${assets.lato900}) format('woff2'); }

  :root {
    --navy: #0a1830;
    --ink: #141f2e;
    --body: #4b5563;
    --muted: #9aa7bc;
    --page: #f6f7fb;
    --card: #ffffff;
    --rule: #e7e9ef;
    --teal: #15b8a7;
    --purple: #7564e8;
    --gold: #e8b84a;
    --blue: #4b9ff5;
    --cream: #fff6db;
    --cream-edge: #f3e3a8;
  }

  @page { size: 960pt 679pt; margin: 0; }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Lato', system-ui, sans-serif;
    color: var(--body);
    font-size: 10.6pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .page {
    position: relative;
    width: 960pt; height: 679pt;
    padding: 34pt 46pt 44pt;
    background: var(--page);
    page-break-after: always;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }

  /* ---------- cover ---------- */
  .cover { background: var(--navy); color: #fff; }
  .cover .badge {
    display: inline-block; padding: 5pt 12pt; border-radius: 999pt;
    background: #253243; color: #d9e0eb;
    font-size: 7.6pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  }
  .cover h1 {
    font-weight: 900; font-size: 46pt; line-height: 1.02;
    margin: 26pt 0 18pt; color: #fff; letter-spacing: -0.01em;
  }
  .cover .lede { font-size: 23pt; line-height: 1.3; color: #fff; font-weight: 400; margin: 0; }
  .cover .lede em { color: var(--teal); font-style: normal; display: block; }
  .cover .intro { margin-top: 16pt; max-width: 470pt; color: #d9e0eb; font-size: 11.5pt; }
  .cover .pills { margin-top: 22pt; display: flex; gap: 8pt; flex-wrap: wrap; }
  .cover .pill {
    padding: 6pt 12pt; border-radius: 999pt; font-size: 9pt; font-weight: 700; color: var(--navy);
  }
  .cover .meta { margin-top: 20pt; color: var(--muted); font-size: 9.5pt; }
  .cover .logo { position: absolute; left: 46pt; bottom: 74pt; width: 150pt; }
  .cover footer { color: var(--muted); border-top-color: #253243; }

  /* decorative concentric rings, echoing the deck's cover motif */
  .rings { position: absolute; right: 60pt; top: 130pt; width: 340pt; height: 340pt; }
  .rings .ring { fill: none; stroke: #1d3b52; stroke-width: 1; }
  /* NOTE: scoped to .ring, NOT to the bare element selector. A rule like
     '.rings circle { fill: none }' BEATS a presentation attribute such as
     fill="#e8b84a" -- CSS always wins over attributes -- which silently made
     every coloured dot invisible. Also: no backticks in here; the whole
     stylesheet lives inside a JS template literal, so a backtick ends it. */
  .rings .dot { stroke: none; }

  /* ---------- interior ---------- */
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12pt; border-bottom: 1px solid var(--rule); margin-bottom: 20pt;
  }
  .head img { width: 104pt; }
  .head .kicker {
    font-size: 8.4pt; font-weight: 700; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink);
  }

  .eyebrow {
    font-size: 8.4pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    color: var(--teal); border-left: 3pt solid var(--teal); padding-left: 8pt; margin-bottom: 10pt;
  }
  h2 { font-weight: 900; font-size: 26pt; line-height: 1.16; color: var(--ink); margin: 0 0 8pt; }
  h3 { font-weight: 700; font-size: 13.6pt; color: var(--ink); margin: 0 0 6pt; }
  h4 { font-weight: 700; font-size: 11.5pt; color: var(--ink); margin: 0 0 4pt; }
  .sub { font-size: 11.5pt; color: var(--body); margin: 0 0 18pt; max-width: 620pt; }

  .card {
    background: var(--card); border: 1px solid var(--rule); border-radius: 10pt;
    padding: 16pt 18pt;
  }
  .cols { display: flex; gap: 14pt; align-items: stretch; }
  .cols > * { flex: 1; }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 8pt; font-weight: 700; letter-spacing: .07em;
    text-transform: uppercase; color: #525c6b;
    border-bottom: 1px solid var(--rule); padding: 8pt 10pt;
  }
  td { padding: 11pt 10pt; border-bottom: 1px solid var(--rule); font-size: 10.6pt; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr.rec { background: var(--cream); }
  tr.rec td { border-bottom-color: var(--cream-edge); }
  .per { color: var(--muted); font-size: 8.6pt; margin-left: 2pt; }
  .dim { color: var(--muted); }

  .tag {
    display: inline-block; margin-left: 6pt; padding: 2pt 7pt; border-radius: 999pt;
    font-size: 7.6pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  }
  .tag-teal { background: rgba(21,184,167,.16); color: #0d7d72; }
  .tag-gold { background: rgba(232,184,74,.2); color: #8a6410; }

  .figure { font-weight: 900; font-size: 30pt; color: var(--ink); line-height: 1; }
  .figure-label { font-size: 9pt; color: var(--muted); margin-top: 4pt; }

  .band {
    background: var(--navy); color: #fff; border-radius: 10pt; padding: 14pt 18pt; margin-top: 14pt;
  }
  .band h4 { color: #fff; margin-bottom: 8pt; }
  .band .chips { display: flex; gap: 7pt; flex-wrap: wrap; }
  .band .chip {
    background: #1b2942; color: #d9e0eb; border-radius: 999pt; padding: 5pt 11pt; font-size: 8.8pt;
  }

  .phases { display: flex; gap: 10pt; margin-top: 4pt; }
  .phase {
    flex: 1; background: var(--card); border: 1px solid var(--rule); border-radius: 10pt;
    padding: 14pt 12pt; position: relative; overflow: hidden;
  }
  .phase-bar { position: absolute; inset: 0 0 auto 0; height: 3.5pt; background: var(--bar); }
  .phase-n {
    position: absolute; right: 10pt; top: 12pt; width: 15pt; height: 15pt; border-radius: 50%;
    background: #eef1f6; color: #525c6b; font-size: 8pt; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .phase h4 { margin-top: 8pt; }
  .phase .obj {
    font-size: 7.6pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: #525c6b; margin: 0 0 6pt;
  }
  .phase .del { font-size: 9.2pt; margin: 0; color: var(--body); }

  ul.plain { margin: 0; padding-left: 14pt; }
  ul.plain li { margin-bottom: 5pt; font-size: 10pt; }

  .fine { font-size: 8.4pt; line-height: 1.5; color: #525c6b; }
  .fine p { margin: 0 0 6pt; }

  /* spend comparison */
  .spend-cols { display: flex; gap: 14pt; align-items: stretch; margin-top: 4pt; }
  .spend-cols > * { flex: 1; }
  .spend-line {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10pt;
    padding: 7pt 0; border-bottom: 1px solid var(--rule); font-size: 10pt;
  }
  .spend-line:last-of-type { border-bottom: none; }
  .spend-line .v { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .spend-total {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 10pt; padding-top: 10pt; border-top: 2pt solid var(--ink);
  }
  .spend-total .l { font-weight: 700; font-size: 11pt; color: var(--ink); }
  .spend-total .v { font-weight: 900; font-size: 20pt; color: var(--ink); font-variant-numeric: tabular-nums; }
  .spend-delta { background: var(--cream); border: 1px solid var(--cream-edge); }

  /* two-column list blocks (co-existence) */
  .split { display: flex; gap: 14pt; margin-top: 4pt; }
  .split > * { flex: 1; }
  .split h4 { margin-bottom: 8pt; }

  /* schedule */
  .sched-row {
    display: flex; align-items: baseline; gap: 12pt;
    padding: 9pt 0; border-bottom: 1px solid var(--rule);
  }
  .sched-row:last-child { border-bottom: none; }
  .sched-n {
    flex: 0 0 auto; width: 16pt; height: 16pt; border-radius: 50%;
    background: var(--teal); color: #fff; font-size: 8pt; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .sched-name { flex: 1; font-weight: 700; font-size: 10.6pt; color: var(--ink); }
  .sched-est {
    flex: 0 0 auto; font-size: 10.6pt; font-weight: 700; color: var(--teal);
    font-variant-numeric: tabular-nums;
  }

  /* responsibility matrix */
  td.area { font-weight: 700; color: var(--ink); width: 24%; }
  td.resp { font-size: 9.6pt; }
  /* Staff-authored cells can hold a long unbroken token — a pasted identifier,
     a URL, a path. Without this such a token cannot wrap and pushes the table
     past the page edge, where overflow:hidden silently amputates it.
     (No backticks anywhere in this stylesheet — see the note on .rings.) */
  td.area, td.resp { overflow-wrap: anywhere; }

  /* acceptance */
  .accept-meta { display: flex; gap: 0; flex-wrap: wrap; }
  .accept-meta > div {
    flex: 1 1 33%; padding: 7pt 12pt 7pt 0; border-bottom: 1px solid var(--rule);
  }
  .accept-meta .k {
    font-size: 7.4pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: #525c6b; display: block; margin-bottom: 3pt;
  }
  .accept-meta .v { font-size: 11.5pt; font-weight: 700; color: var(--ink); }

  /* .plan-pick is the acceptance page's plan statement. (An earlier comment
     here claimed the investment page used these too — it does not; that page
     renders a table. The .tick rule was dropped with the check-box.) */
  .plan-pick {
    display: flex; align-items: center; gap: 10pt;
    padding: 8pt 12pt; border: 1px solid var(--rule); border-radius: 8pt;
    background: var(--card); margin-bottom: 6pt;
  }
  .plan-pick.rec { background: var(--cream); border-color: var(--cream-edge); }
  .plan-pick .nm { flex: 1; font-weight: 700; font-size: 11pt; color: var(--ink); }
  .plan-pick .pr { font-size: 10pt; color: var(--body); white-space: nowrap; }
  .plan-pick .fy { font-weight: 700; color: var(--ink); }

  .sig-grid { display: flex; gap: 14pt; margin-top: 4pt; }
  .sig-grid > * { flex: 1; }
  .sig-who {
    font-size: 7.4pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: #525c6b; margin-bottom: 3pt;
  }
  .sig-party { font-size: 12.5pt; font-weight: 900; color: var(--ink); margin-bottom: 8pt; }
  /*
   * TWO ROWS OF TWO, not four stacked lines.
   *
   * Four stacked lines overflowed the page by 50pt once a Micro engagement's
   * THIRD support-plan row was added — measured, not guessed. Pairing
   * Name/Title and Signature/Date halves the height without shortening the
   * lines themselves: each is still ~190pt (~6.7cm) wide and 13pt tall, which
   * is comfortably writable. Compressing the line heights instead would have
   * produced a signature block nobody can actually sign.
   */
  .sig-row { display: flex; gap: 10pt; }
  .sig-row > * { flex: 1; }
  .sig-line { margin-bottom: 12pt; }
  .sig-line .lbl { font-size: 8.4pt; color: #525c6b; }
  .sig-line .rule-line { border-bottom: 1px solid #9aa7bc; height: 13pt; }

  .state-tiles { display: flex; gap: 10pt; margin-top: 4pt; flex-wrap: wrap; }
  .state-tile {
    flex: 1 1 160pt; background: var(--card); border: 1px solid var(--rule); border-radius: 10pt;
    padding: 16pt 14pt;
  }
  .state-k {
    font-size: 7.6pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: #525c6b; margin: 0 0 8pt;
  }
  .state-v { font-size: 13pt; font-weight: 700; color: var(--ink); line-height: 1.25; }

  footer {
    position: absolute; left: 46pt; right: 46pt; bottom: 22pt;
    display: flex; justify-content: space-between;
    font-size: 9pt; color: var(--muted);
    border-top: 1px solid var(--rule); padding-top: 10pt;
  }
  footer .pg { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>

<!-- ══════════════ 01 cover ══════════════ -->
<section class="page cover">
  <span class="badge">Cloud Migration Proposal</span>
  <h1>${esc(p.preparedFor)}</h1>
  <p class="lede">Secure, compliant cloud infrastructure<em>for your clinic.</em></p>
  <p class="intro">
    A fully managed, PHIPA-aligned AWS environment in Canadian regions &mdash; so your team can focus on
    patients, not servers, backups, or compliance paperwork.
  </p>
  <div class="pills">
    <span class="pill" style="background:#15b8a7">Secure by design</span>
    <span class="pill" style="background:#7564e8;color:#fff">Canadian data residency</span>
    <span class="pill" style="background:#e8b84a">Managed end-to-end</span>
    <span class="pill" style="background:#4b9ff5;color:#fff">Built for clinics</span>
  </div>
  <p class="meta">
    ${esc(p.tierSummary)}<br>
    Reference ${esc(p.proposalReference)} &nbsp;&middot;&nbsp; Issued ${esc(p.issuedOn)}
    ${p.preparedForContact ? ` &nbsp;&middot;&nbsp; Prepared for ${esc(p.preparedForContact)}` : ''}
  </p>

  <!-- viewBox is inset by 10 so the r=5 dots at coords 2 and 338 are not clipped -->
    <svg class="rings" viewBox="-10 -10 360 360">
    <circle class="ring" cx="170" cy="170" r="168"/><circle class="ring" cx="170" cy="170" r="126"/>
    <circle class="ring" cx="170" cy="170" r="84"/><circle class="ring" cx="170" cy="170" r="42"/>
    <circle class="dot" cx="170" cy="2"   r="5" fill="#e8b84a"/>
    <circle class="dot" cx="338" cy="170" r="5" fill="#15b8a7"/>
    <circle class="dot" cx="170" cy="338" r="5" fill="#7564e8"/>
    <circle class="dot" cx="2"   cy="170" r="5" fill="#4b9ff5"/>
  </svg>

  <img class="logo" src="data:image/png;base64,${assets.logoOnDark}" alt="Aeygis">
  ${footer(pCover)}
</section>

${
  hasCurrentState
    ? `
<!-- ══════════════ current environment ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Where you're starting from</div>
  <h2>A snapshot of your current environment.</h2>
  <p class="sub">
    Captured from your assessment answers, this is the starting point this proposal is built around.
  </p>

  <div class="state-tiles">${stateTiles}</div>

  ${footer(pCurrentState ?? '')}
</section>`
    : ''
}

<!-- ══════════════ why now ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Why now</div>
  <h2>Enforcement is active, not theoretical.</h2>
  <p class="sub">
    Clinic technology risk in Ontario is now a privacy and regulatory matter, not only an
    operational one.
  </p>

  <div class="state-tiles">
    ${p.regulatory.points
      .map(
        (pt) => `
      <div class="state-tile">
        <div class="figure" style="font-size:22pt">${esc(pt.figure)}</div>
        <div class="state-k" style="margin:6pt 0 4pt">${esc(pt.label)}</div>
        <p class="fine" style="margin:0">${esc(pt.detail)}</p>
      </div>`,
      )
      .join('')}
  </div>

  <!-- The pointer to a sources page went with that page. Every figure on this
       page already carries its own attribution in the detail line beneath it
       ("CIRA, 2024.", "PHIPA Decision 298", "as amended in 2020"), so nothing
       here is left unsourced by dropping the cross-reference. -->
  <p class="fine" style="margin-top:14pt">${esc(p.regulatory.note)}</p>

  ${footer(pRegulatory)}
</section>

<!-- ══════════════ measured impact ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">What organizations gain</div>
  <h2>Independently measured &mdash; not vendor promises.</h2>
  <p class="sub">
    Published, citable research into organizations that moved workloads to AWS.
  </p>

  <div class="state-tiles">
    ${p.impact.figures
      .map(
        (f) => `
      <div class="state-tile">
        <div class="figure" style="font-size:30pt">${esc(f.figure)}</div>
        <div class="state-k" style="margin:6pt 0 4pt">${esc(f.label)}</div>
        <p class="fine" style="margin:0">${esc(f.detail)}</p>
      </div>`,
      )
      .join('')}
  </div>

  <div class="card" style="margin-top:14pt">
    <p class="fine" style="margin:0">${esc(p.impact.attribution)}</p>
  </div>

  ${footer(pImpact)}
</section>

${
  p.spendComparison === null
    ? ''
    : `
<!-- ══════════════ what it replaces ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">What this replaces</div>
  <h2>Set against what your clinic already spends.</h2>
  <p class="sub">
    Built from the figures you supplied during the assessment &mdash; not from assumptions about
    clinics of your size.
  </p>

  <div class="spend-cols">
    <div class="card">
      <h3>Your current annual spend</h3>
      ${
        p.spendComparison.annualIt
          ? `<div class="spend-line"><span>IT spend, reported monthly &times; 12</span><span class="v">${esc(p.spendComparison.annualIt.display)}</span></div>`
          : ''
      }
      ${
        p.spendComparison.annualHardware
          ? `<div class="spend-line"><span>Emergency hardware, last year</span><span class="v">${esc(p.spendComparison.annualHardware.display)}</span></div>`
          : ''
      }
      ${
        p.spendComparison.annualDowntime
          ? `<div class="spend-line"><span>Downtime &mdash; ${esc(String(p.spendComparison.downtimeHours))} hrs at ${esc(p.spendComparison.spendPerDowntimeHour?.display ?? '')} per hour</span><span class="v">${esc(p.spendComparison.annualDowntime.display)}</span></div>`
          : ''
      }
      <div class="spend-total">
        <span class="l">Estimated annual total</span>
        <span class="v">${esc(p.spendComparison.annualTotal.display)}</span>
      </div>
    </div>

    <div class="card spend-delta">
      <h3>${esc(p.spendComparison.comparedPlanLabel)} &mdash; first year</h3>
      <div class="figure" style="margin-top:6pt">${esc(p.spendComparison.proposedFirstYear.display)}</div>
      <div class="figure-label">
        One-time migration plus twelve months of ${esc(p.spendComparison.comparedPlanLabel)}
      </div>
      <div class="spend-total">
        <span class="l">Difference in year one</span>
        <span class="v">${esc(p.spendComparison.difference.display)}</span>
      </div>
      <p class="fine" style="margin-top:10pt">
        Year one carries the one-time migration. Subsequent years are the monthly plan only.
      </p>
    </div>
  </div>

  <p class="fine" style="margin-top:14pt">
    Indicative, and based entirely on figures your clinic provided. This estimate covers
    ${esc(p.spendComparison.coversOnly.join('; '))}. It is not a guarantee of savings: actual
    spending depends on your workloads, AWS consumption, and the service levels agreed during
    discovery. AWS usage fees are paid by the clinic directly and are not included in either column.
  </p>

  ${footer(pSpend ?? '')}
</section>`
}

<!-- ══════════════ investment ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Your investment</div>
  <h2>${esc(p.tierLabel)} &mdash; scoped to your clinic.</h2>
  <p class="sub">
    A one-time migration cost, then a monthly support plan you choose. The two are priced and billed
    separately.
  </p>

  <div class="cols">
    <div class="card" style="flex:0 0 250pt">
      <h3>One-time migration</h3>
      <div class="figure">${esc(p.setupTotal.display)}</div>
      <div class="figure-label">${esc(p.setupTotal.currency)}, one time</div>
      <ul class="plain" style="margin-top:12pt">
        ${p.setupBreakdown.map((b) => `<li>${esc(b)}</li>`).join('')}
      </ul>
    </div>

    <div class="card">
      <h3>Monthly support plans</h3>
      <table>
        <thead>
          <tr><th>Plan</th><th class="num">Monthly</th><th class="num">Annual check-up</th><th class="num">First year total</th></tr>
        </thead>
        <tbody>${planRows}</tbody>
      </table>
      <p class="fine" style="margin-top:10pt">
        First-year total includes the one-time migration cost plus twelve months of the selected plan.
        Where an annual check-up applies it is mandatory, not optional.
      </p>
    </div>
  </div>

  <div class="band">
    <h4>Included from day one</h4>
    <div class="chips">
      <span class="chip">Encryption at rest &amp; in transit</span>
      <span class="chip">Role-based access + audit logging</span>
      <span class="chip">Automated Canadian backups</span>
      <span class="chip">MFA and secure remote access</span>
      <span class="chip">Measurable RTO / RPO</span>
    </div>
  </div>

  ${footer(pInvestment)}
</section>

${
  !hasTracks
    ? ''
    : `
<!-- ══════════════ migration track ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Your migration path</div>
  <h2>${p.migrationTracks.length > 1 ? 'Both migration tracks apply to your environment.' : 'The track your environment follows.'}</h2>
  <p class="sub">
    ${
      p.migrationTracks.length > 1
        ? 'Your systems are split across on-premises hardware and existing cloud accounts, so the engagement covers both routes.'
        : 'Determined by the current environment you described during the assessment.'
    }
  </p>

  ${p.migrationTracks
    .map(
      (t) => `
  <div class="card" style="margin-bottom:12pt">
    <h3>${esc(t.name)}</h3>
    <p style="margin:4pt 0 10pt">${esc(t.focus)}</p>
    <div class="state-tiles">
      <div class="state-tile"><div class="state-k">Starting from</div><div class="state-v" style="font-size:10.6pt">${esc(t.entryInfrastructure)}</div></div>
      <div class="state-tile"><div class="state-k">Method</div><div class="state-v" style="font-size:10.6pt">${esc(t.methodology)}</div></div>
      <div class="state-tile"><div class="state-k">Target architecture</div><div class="state-v" style="font-size:10.6pt">${esc(t.targetArchitecture)}</div></div>
    </div>
  </div>`,
    )
    .join('')}

  ${footer(pTracks ?? '')}
</section>`
}

<!-- ══════════════ delivery ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Managed delivery</div>
  <h2>From assessment to ongoing support in five managed steps.</h2>
  <p class="sub">
    A guided process that reduces uncertainty and keeps clinic operations at the centre of every decision.
  </p>

  <div class="phases">${phaseCards}</div>

  <div class="card" style="margin-top:14pt">
    <h3>Costs you pay directly</h3>
    <p class="fine">
      The following are not included in the migration or monthly management fees, and are paid by your
      clinic directly to the relevant provider:
    </p>
    <ul class="plain">
      ${p.clientPaysSeparately.map((c) => `<li>${esc(c)}</li>`).join('')}
    </ul>
  </div>

  ${footer(pDelivery)}
</section>

${
  p.schedule === null
    ? ''
    : `
<!-- ══════════════ schedule ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Indicative schedule</div>
  <h2>How long each stage is expected to take.</h2>
  <p class="sub">
    Estimates prepared for this engagement. Exact dates are fixed in the statement of work after
    discovery.
  </p>

  <div class="card">
    ${p.schedule.phases
      .map(
        (ph, i) => `
      <div class="sched-row">
        <div class="sched-n">${i + 1}</div>
        <div class="sched-name">${esc(ph.name)}</div>
        <div class="sched-est">${esc(ph.estimate)}</div>
      </div>`,
      )
      .join('')}
  </div>

  ${p.schedule.note ? `<div class="card" style="margin-top:12pt"><h3>Scheduling notes</h3><p class="fine" style="margin:0">${esc(p.schedule.note)}</p></div>` : ''}

  <p class="fine" style="margin-top:14pt">
    Timings are estimates, not commitments. They assume timely access to systems, vendor
    cooperation where third-party EMR or PACS platforms are involved, and agreed maintenance
    windows for cutover.
  </p>

  ${footer(pSchedule ?? '')}
</section>`
}

${
  !hasResponsibilities
    ? ''
    : `
<!-- ══════════════ shared responsibility ══════════════ -->
${responsibilityPages
  .map(
    (rows, i) => `
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Who does what</div>
  <h2>Shared responsibility, stated before you sign.${
    responsibilityPages.length > 1 ? ` (${i + 1} of ${responsibilityPages.length})` : ''
  }</h2>
  ${
    i === 0
      ? `<p class="sub">
    Several rows below are owned by your clinic, not by Aeygis. They are set out here so there is
    no ambiguity during an incident.
  </p>`
      : '<p class="sub">Continued.</p>'
  }

  <div class="card">
    <table>
      <thead>
        <tr><th>Area</th><th>Aeygis Cloud</th><th>Your clinic</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
        <tr>
          <td class="area">${esc(r.area)}</td>
          <td class="resp">${esc(r.aeygis)}</td>
          <td class="resp">${esc(r.clinic)}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>

  ${footer(pResponsibilities[i] ?? '')}
</section>`,
  )
  .join('')}

<!-- ══════════════ co-existence ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Working alongside your IT provider</div>
  <h2>This does not replace your local IT support.</h2>
  <p class="sub">${esc(p.coExistence.positioning)}</p>

  <div class="split">
    <div class="card">
      <h4>Your local IT provider keeps</h4>
      <ul class="plain">
        ${p.coExistence.localProvider.map((x) => `<li>${esc(x)}</li>`).join('')}
      </ul>
    </div>
    <div class="card">
      <h4>Aeygis takes on</h4>
      <ul class="plain">
        ${p.coExistence.aeygis.map((x) => `<li>${esc(x)}</li>`).join('')}
      </ul>
    </div>
  </div>

  ${footer(pCoExistence)}
</section>`
}

<!-- ══════════════ security & privacy ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Security and privacy</div>
  <h2>Controls built into the foundation.</h2>
  <p class="sub">
    The baseline below applies across every managed environment. What applies to your clinic is
    documented in the final statement of work.
  </p>

  <div class="phases">
    ${p.security.controls
      .slice(0, 3)
      .map(
        (c, i) => `
      <div class="phase" style="--bar: ${['#15b8a7', '#7564e8', '#4b9ff5'][i % 3]}">
        <div class="phase-bar"></div>
        <h4 style="margin-top:6pt">${esc(c.title)}</h4>
        <p class="del">${esc(c.detail)}</p>
      </div>`,
      )
      .join('')}
  </div>
  <div class="phases" style="margin-top:10pt">
    ${p.security.controls
      .slice(3)
      .map(
        (c, i) => `
      <div class="phase" style="--bar: ${['#e8b84a', '#15b8a7', '#7564e8'][i % 3]}">
        <div class="phase-bar"></div>
        <h4 style="margin-top:6pt">${esc(c.title)}</h4>
        <p class="del">${esc(c.detail)}</p>
      </div>`,
      )
      .join('')}
  </div>

  <div class="band">
    <h4>Implemented with</h4>
    <div class="chips">
      ${p.security.specifics.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
    </div>
  </div>

  <p class="fine" style="margin-top:12pt">${esc(p.security.note)}</p>

  ${footer(pSecurity)}
</section>

<!-- ══════════════ continuity & service levels ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Continuity and service levels</div>
  <h2>Recovery should be measurable before an outage.</h2>

  <div class="cols">
    ${p.continuity.objectives
      .map(
        (o) => `
      <div class="card">
        <div class="figure" style="font-size:24pt">${esc(o.code)}</div>
        <h4 style="margin:6pt 0 4pt">${esc(o.name)}</h4>
        <p class="fine" style="margin:0">${esc(o.plain)}</p>
      </div>`,
      )
      .join('')}
  </div>

  <div class="band">
    <h4>How resilience is managed</h4>
    <div class="chips">
      ${p.continuity.cycle.map((c) => `<span class="chip">${esc(c.step)} &mdash; ${esc(c.detail)}</span>`).join('')}
    </div>
  </div>

  <p class="fine" style="margin-top:14pt">${esc(p.continuity.disclaimer)}</p>

  ${footer(pContinuity)}
</section>

<!-- ══════════════ service levels ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Uptime</div>
  <h2>Two commitments, and they are not the same thing.</h2>
  <p class="sub">
    Uptime figures are often quoted without saying who is promising them. These are set out
    separately so there is no confusion about which applies to what.
  </p>

  <div class="cols">
    ${p.continuity.serviceLevels
      .map(
        (s) => `
      <div class="card">
        <div class="figure">${esc(s.figure)}</div>
        <div class="figure-label">${esc(s.layer)}</div>
        <div class="spend-line" style="margin-top:10pt"><span>Whose commitment</span><span class="v" style="font-size:9.2pt;text-align:right">${esc(s.whoseCommitment)}</span></div>
        <div class="spend-line"><span>Covers</span><span class="v" style="font-size:9.2pt;text-align:right">${esc(s.scope)}</span></div>
        <div class="spend-line"><span>Permits</span><span class="v" style="font-size:9.2pt;text-align:right">${esc(s.allowedDowntime)}</span></div>
      </div>`,
      )
      .join('')}
  </div>

  <p class="fine" style="margin-top:14pt">${esc(p.continuity.serviceLevelNote)}</p>

  ${footer(pServiceLevels)}
</section>

<!-- ══════════════ why Aeygis ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Why Aeygis</div>
  <h2>An Ontario partner that understands healthcare operations.</h2>
  <p class="sub">${esc(p.whyAeygis.positioning)}</p>

  <div class="phases">
    ${p.whyAeygis.differentiators
      .map(
        (d, i) => `
      <div class="phase" style="--bar: ${['#15b8a7', '#7564e8', '#e8b84a', '#4b9ff5'][i % 4]}">
        <div class="phase-bar"></div>
        <h4 style="margin-top:6pt">${esc(d.title)}</h4>
        <p class="del">${esc(d.detail)}</p>
      </div>`,
      )
      .join('')}
  </div>

  <div class="card" style="margin-top:14pt">
    <h3>What to expect from Aeygis</h3>
    <div class="state-tiles" style="margin-top:8pt">
      ${p.whyAeygis.expectations
        .map(
          (e) => `
        <div class="state-tile" style="padding:12pt 12pt">
          <div class="state-k">${esc(e.title)}</div>
          <p class="fine" style="margin:0">${esc(e.detail)}</p>
        </div>`,
        )
        .join('')}
    </div>
  </div>

  ${footer(pWhyAeygis)}
</section>

<!-- ══════════════ scope & terms ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Scope and terms</div>
  <h2>Clear scope, transparent assumptions.</h2>
  <p class="sub">${esc(p.validityNote)}</p>

  <div class="card">
    <h3>Important notices</h3>
    <div class="fine">
      ${p.disclaimers.map((d) => `<p>${esc(d)}</p>`).join('')}
    </div>
  </div>

  <div class="band">
    <h4>Next step</h4>
    <div class="chips">
      <span class="chip">Review this proposal with your team</span>
      <span class="chip">Confirm scope and support plan</span>
      <span class="chip">We issue the formal statement of work</span>
    </div>
  </div>

  <p class="fine" style="margin-top:14pt">
    Prepared by ${esc(p.preparedBy)} &nbsp;&middot;&nbsp; Reference ${esc(p.proposalReference)}
    &nbsp;&middot;&nbsp; ${esc(p.issuedOn)}
  </p>

  ${footer(pTerms)}
</section>

<!-- ══════════════ acceptance ══════════════ -->
<section class="page">
  <div class="head">
    <img src="data:image/png;base64,${assets.logoOnLight}" alt="Aeygis">
    <span class="kicker">Cloud Migration Proposal</span>
  </div>

  <div class="eyebrow">Acceptance</div>
  <h2>Confirming this proposal.</h2>
  <p class="sub">${esc(p.acceptance.statement)}</p>

  <div class="accept-meta">
    <div><span class="k">Proposal reference</span><span class="v">${esc(p.proposalReference)}</span></div>
    <div><span class="k">Issued</span><span class="v">${esc(p.issuedOn)}</span></div>
    <div><span class="k">Pricing held until</span><span class="v">${esc(p.acceptance.validUntil)}</span></div>
  </div>

  <!-- The plan IS stated here. What was removed is the TICK-BOX: the client
       is not asked to choose at the point of signature, because the plan is
       settled beforehand and a check-box invites a last-minute change to the
       thing being signed for. Showing it and asking for it are different
       things, and only the asking was wrong.

       p.plans is filtered to the plan this version was generated for (the
       Lambda re-quotes with supportPlan set), so this states one plan rather
       than presenting a menu.

       Stated BEFORE the signature lines, not after. A reader should know what
       they are agreeing to on the way to the pen, not on the way back. -->
  <h3 style="margin-top:11pt">Your support plan</h3>
  ${p.plans
    .map(
      (plan) => `
    <div class="plan-pick${plan.isRecommended ? ' rec' : ''}">
      <div class="nm">${esc(plan.planLabel)}${plan.isRecommended ? ' <span class="tag tag-teal">Recommended</span>' : ''}</div>
      <div class="pr">${esc(plan.monthly.display)}/month &nbsp;&middot;&nbsp; first year <span class="fy">${esc(plan.firstYearTotal.display)}</span></div>
    </div>`,
    )
    .join('')}

  <p class="fine" style="margin:11pt 0 0">${esc(p.acceptance.notAgreementNote)}</p>

  <div class="sig-grid" style="margin-top:10pt">
    <div class="card">
      <div class="sig-who">For the clinic</div>
      <div class="sig-party">${esc(p.preparedFor)}</div>
      ${[
        ['Name', 'Title'],
        ['Signature', 'Date'],
      ]
        .map(
          (pair) =>
            `<div class="sig-row">${pair
              .map(
                (l) =>
                  `<div class="sig-line"><div class="rule-line"></div><div class="lbl">${l}</div></div>`,
              )
              .join('')}</div>`,
        )
        .join('')}
    </div>
    <div class="card">
      <div class="sig-who">For Aeygis</div>
      <div class="sig-party">${esc(p.acceptance.signatoryEntity)}</div>
      ${[
        ['Name', 'Title'],
        ['Signature', 'Date'],
      ]
        .map(
          (pair) =>
            `<div class="sig-row">${pair
              .map(
                (l) =>
                  `<div class="sig-line"><div class="rule-line"></div><div class="lbl">${l}</div></div>`,
              )
              .join('')}</div>`,
        )
        .join('')}
    </div>
  </div>

  ${footer(pAcceptance)}
</section>


</body>
</html>`;
}
