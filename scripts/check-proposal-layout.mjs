/**
 * Measures whether any proposal page overflows or collides with its footer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT scrollHeight
 * ═══════════════════════════════════════════════════════════════════════════
 * `.page` is `overflow: hidden`, so `scrollHeight` is ALWAYS clamped to
 * `clientHeight` and reports "fits" no matter how far content runs past the
 * bottom. It is a check that cannot fail, which is worse than no check.
 *
 * This measures the real bottom edge of the last flowed child against the page
 * box and against the footer's own top edge — the two ways content actually
 * goes wrong on a fixed-height page with no auto-pagination.
 *
 * Run `npm run preview:proposal` first; this reads the HTML it writes.
 *
 *   node scripts/check-proposal-layout.mjs [path-to-html]
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.argv[2] ?? path.join(here, '..', 'proposal-preview.html');
if (!existsSync(htmlPath)) {
  console.error(`No preview HTML at ${htmlPath}. Run: npm run preview:proposal`);
  process.exit(1);
}

const CANDIDATE_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No local Chrome/Edge found.');
  process.exit(1);
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  await page.setContent(readFileSync(htmlPath, 'utf8'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const report = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.page')).map((pageEl, i) => {
      const box = pageEl.getBoundingClientRect();
      const footerEl = pageEl.querySelector('footer');
      const footerTop = footerEl ? footerEl.getBoundingClientRect().top : box.bottom;

      let maxBottom = box.top;
      for (const child of Array.from(pageEl.children)) {
        if (child.tagName.toLowerCase() === 'footer') continue;
        if (getComputedStyle(child).position === 'absolute') continue;
        const b = child.getBoundingClientRect().bottom;
        if (b > maxBottom) maxBottom = b;
      }

      return {
        page: pageEl.querySelector('footer .pg')?.textContent?.trim() ?? String(i + 1),
        heading: (pageEl.querySelector('h2')?.textContent?.trim() ?? '(cover)').slice(0, 46),
        clearance: Math.round(footerTop - maxBottom),
        overflows: maxBottom > box.bottom + 0.5,
        hitsFooter: maxBottom > footerTop + 0.5,
      };
    }),
  );

  console.table(report);

  const bad = report.filter((r) => r.overflows || r.hitsFooter);
  if (bad.length > 0) {
    console.error(
      `\n${bad.length} PAGE(S) OVERFLOW OR COLLIDE WITH THE FOOTER: ` +
        bad.map((b) => `p${b.page} "${b.heading}"`).join(', '),
    );
    process.exitCode = 1;
  } else {
    const tightest = report.reduce((a, b) => (a.clearance < b.clearance ? a : b));
    console.log(
      `\nAll ${report.length} pages fit. Tightest: p${tightest.page} ` +
        `"${tightest.heading}" — ${tightest.clearance}px above the footer.`,
    );
  }
} finally {
  await browser.close();
}
