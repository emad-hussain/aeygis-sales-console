/**
 * The approvals row: what its action cluster offers, and whether it fits.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO QUESTIONS, BOTH ANSWERED BY RENDERING RATHER THAN BY READING THE JSX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. STATE. An approved version is terminal: it must offer View PDF and
 *    nothing else. Approve, Reject and Delete have to be unreachable, and the
 *    honest way to check "unreachable" is to look at the rendered buttons.
 *
 * 2. LAYOUT. `.row-actions` exists because THREE buttons in one cell once
 *    pushed the table into horizontal scroll. Moving View PDF out of the
 *    fingerprint column on 2026-08-27 made it four, so "flex-wrap handles it"
 *    needed testing rather than assuming.
 *
 * The layout half measures the OLD layout as a baseline and compares. That
 * matters: this table already overflows at very narrow widths because of the
 * decision column, and a check that only asked "does it overflow" would have
 * blamed a change that was not responsible. The bar is NO WORSE THAN BEFORE.
 *
 * Free and standalone — real brand.css, headless browser, no AWS, no dev
 * server, no seeded data. Unlike check:ui it can run beside `npm test`.
 *
 * Run:  npm run check:actions
 */
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CSS = readFileSync(new URL('../apps/console/src/brand.css', import.meta.url), 'utf8');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No local Chrome/Edge found.'); process.exit(1); }

const PDF_BUTTON = '<button type="button" class="secondary">View PDF</button>';

/**
 * Mirrors ApprovalPanel.tsx. `armed` uses the widest labels the buttons ever
 * take — the armed confirm states — because that is when the cluster is at its
 * widest and so the only version worth measuring for overflow.
 */
const actions = ({ approved, armed, pdfInActions }) => `
  <div class="row-actions">
    ${pdfInActions ? PDF_BUTTON : ''}
    ${approved ? '' : `
      <button>${armed ? 'Approving…' : 'Approve'}</button>
      <button class="${armed ? 'danger' : 'secondary'}">${armed ? 'Confirm reject?' : 'Reject'}</button>
      <button class="${armed ? 'danger' : 'secondary'}">${armed ? 'Delete v0003?' : 'Delete'}</button>`}
  </div>`;

/* The OLD layout put View PDF under the fingerprint. Rendering both is the only
   way to attribute an overflow: the question is not "does this table ever
   scroll" — it did before — but "did moving the button make it worse". */
const fingerprintCell = (withPdf) =>
  withPdf
    ? `<td class="mono tiny">25c64ace2475…<br>${PDF_BUTTON}</td>`
    : '<td class="mono tiny">25c64ace2475…</td>';

const row = ({ approved, armed, pdfInActions, id }) => `
  <tr>
    <td class="mono">v0003</td>
    <td>professional<span class="tiny muted"> / fullManaged</span></td>
    <td class="num">$61,000</td>
    <td class="num">$21,400</td>
    ${fingerprintCell(!pdfInActions)}
    <td>
      <span class="pill status-${approved ? 'proposed' : 'closed'}">${approved ? 'approved' : 'rejected'}</span><br>
      <span class="tiny muted">test-approver@aeygis-test.invalid<br>2026-08-27, 12:02:29 a.m.</span>
    </td>
    <td id="${id}">${actions({ approved, armed, pdfInActions })}</td>
  </tr>`;

const html = (pdfInActions) => `<style>${CSS}</style>
<div class="panel" style="padding:1rem">
  <div class="table-wrap" id="wrap">
    <table>
      <thead><tr>
        <th>Version</th><th>Tier / plan</th><th class="num">Setup</th>
        <th class="num">Monthly</th><th>Fingerprint</th><th>Decision</th><th></th>
      </tr></thead>
      <tbody>
        ${row({ approved: false, armed: false, pdfInActions, id: 'open' })}
        ${row({ approved: false, armed: true, pdfInActions, id: 'armed' })}
        ${row({ approved: true, armed: false, pdfInActions, id: 'approved' })}
      </tbody>
    </table>
  </div>
</div>`;

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();

const measure = async (width, pdfInActions) => {
  await page.setViewport({ width, height: 900 });
  await page.setContent(html(pdfInActions), { waitUntil: 'load' });
  return page.evaluate(() => {
    const wrap = document.getElementById('wrap');
    const read = (id) => {
      const buttons = [...document.getElementById(id).querySelectorAll('button')];
      return {
        labels: buttons.map((b) => b.textContent.trim()),
        // Distinct y-offsets = how many lines the cluster wrapped onto.
        lines: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
        sameLine:
          buttons.length > 1 &&
          Math.round(buttons[0].getBoundingClientRect().top) ===
            Math.round(buttons[1].getBoundingClientRect().top),
      };
    };
    return {
      overflow: Math.max(0, wrap.scrollWidth - wrap.clientWidth),
      open: read('open'),
      armed: read('armed'),
      approved: read('approved'),
    };
  });
};

// ── 1. what an APPROVED row offers ────────────────────────────────────────
console.log('An approved version is terminal — it may offer nothing but View PDF:');
console.log('');
{
  const m = await measure(1280, true);
  const { labels } = m.approved;

  if (labels.length === 1 && labels[0] === 'View PDF') {
    pass('approved row shows View PDF and nothing else');
  } else {
    fail(`approved row shows [${labels.join(', ')}] — expected only View PDF`);
  }
  for (const forbidden of ['Approve', 'Reject', 'Delete']) {
    if (labels.includes(forbidden)) fail(`  "${forbidden}" is reachable on an approved version`);
  }

  /* Guards the guard. Every assertion above is of the "X is absent" shape, and
     those all pass on an empty list — so a fixture that had stopped rendering
     buttons entirely would report a clean bill of health. See gotcha §16.21. */
  if (m.open.labels.length === 4) {
    pass('an undecided row still shows all four — the check above is not vacuous');
  } else {
    fail(`undecided row shows ${m.open.labels.length} button(s), expected 4 — the fixture is wrong`);
  }
}

// ── 2. does the cluster fit ────────────────────────────────────────────────
console.log('');
console.log('Layout, compared against the OLD position of View PDF at each width:');
console.log('');

for (const width of [520, 720, 900, 1100, 1280, 1600]) {
  const before = await measure(width, false); // View PDF under the fingerprint
  const after = await measure(width, true);   // View PDF in the action cluster
  const label = `${String(width).padStart(4)}px`;

  if (after.overflow > before.overflow) {
    fail(`${label}  overflow grew ${before.overflow}px -> ${after.overflow}px — the move made it worse`);
  } else if (after.overflow > 0) {
    pass(`${label}  still overflows ${after.overflow}px, but it did before too (${before.overflow}px) — not caused by this`);
  } else {
    const n = after.armed.lines;
    pass(`${label}  no horizontal scroll · cluster on ${n} line(s)${n === 1 ? ' — all four in a row' : ''}`);
  }

  if (after.open.labels[0] !== 'View PDF') {
    fail(`${label}  View PDF is not the first control in the cluster`);
  }
  if (width >= 1100 && !after.open.sameLine) {
    fail(`${label}  View PDF is not on the same line as Approve — the point of the change`);
  }
}

await browser.close();

console.log('');
if (failures === 0) {
  console.log('An approved version offers only View PDF, and the four-button cluster sits on');
  console.log('one line on a normal pane, wraps on a narrow one, and adds no horizontal');
  console.log('scroll the table did not already have.');
} else {
  console.log(`${failures} CHECK(S) FAILED.`);
}
console.log('');
process.exit(failures === 0 ? 0 : 1);
