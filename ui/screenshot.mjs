/**
 * Renders each design mockup in ui/ to a PNG beside it.
 *
 * Waits past the entrance animations (longest delay ~1s + ~.6s duration) so
 * the shot captures the settled layout, not elements mid-flight.
 *
 *   node ui/screenshot.mjs
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));

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

// Top-level mockups plus one level of subfolders (ui/colors/ holds the
// palette studies). PNGs land beside each file either way.
const files = [];
for (const entry of readdirSync(here).sort()) {
  const full = path.join(here, entry);
  if (entry.endsWith('.html')) files.push(entry);
  else if (statSync(full).isDirectory()) {
    for (const sub of readdirSync(full).sort()) {
      if (sub.endsWith('.html')) files.push(path.join(entry, sub));
    }
  }
}
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

try {
  for (const file of files) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 });
    await page.goto('file:///' + path.join(here, file).replace(/\\/g, '/'), {
      waitUntil: 'networkidle0',
      timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready);
    // Let entrance animations finish.
    await new Promise((r) => setTimeout(r, 2600));
    const out = path.join(here, file.replace(/\.html$/, '.png'));
    await page.screenshot({ path: out });
    console.log('wrote', file.replace(/\.html$/, '.png'));

    // Pages that declare data-theme-capable ship a dark palette too — the
    // colour studies do. Capture it as a second still so both themes can
    // be compared without opening a browser.
    const darkCapable = await page.evaluate(() =>
      document.documentElement.hasAttribute('data-theme-capable'),
    );
    if (darkCapable) {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: out.replace(/\.png$/, '-dark.png') });
      console.log('wrote', file.replace(/\.html$/, '-dark.png'));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
