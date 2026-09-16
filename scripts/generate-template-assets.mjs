/**
 * Generates `template-assets.generated.ts` — fonts and logos as base64 constants.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY: reading these from disk at runtime DOES NOT WORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The handler originally did `readFileSync(path.join(dirname, 'assets', ...))`.
 * Inspecting the actually-deployed Lambda package showed it contained exactly two
 * files — `index.mjs` and `index.mjs.map`. Amplify's bundler does not copy
 * sibling asset directories, so every font and logo was simply absent and the
 * first render would have thrown ENOENT.
 *
 * Baking them into the module means esbuild inlines them into the bundle, so they
 * cannot be left behind. That is a deliberate trade: ~130 kB of base64 in the
 * bundle in exchange for the assets being impossible to lose.
 *
 * Re-run after changing any font or logo:
 *   npm run gen:assets
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fnDir = path.join(here, '..', 'amplify', 'functions', 'render-proposal-pdf');
const assetDir = path.join(fnDir, 'assets');

const FILES = {
  lato400: 'lato-400.woff2',
  lato700: 'lato-700.woff2',
  lato900: 'lato-900.woff2',
  logoOnDark: 'logo-light-on-dark.png',
  logoOnLight: 'logo-dark-on-light.png',
};

const entries = Object.entries(FILES).map(([key, file]) => {
  const bytes = readFileSync(path.join(assetDir, file));
  console.log(`  ${file.padEnd(26)} ${(bytes.length / 1024).toFixed(1)} kB`);
  return [key, file, bytes.toString('base64')];
});

const total = entries.reduce((n, [, , b64]) => n + b64.length, 0);

const out = `// GENERATED FILE — do not edit by hand.
// Produced by scripts/generate-template-assets.mjs (npm run gen:assets).
//
// Fonts and logos are inlined as base64 because Amplify's bundler does NOT copy
// sibling asset directories into the Lambda package. Verified by downloading the
// deployed package: it contained only index.mjs and index.mjs.map, so a runtime
// readFileSync of ./assets/* would have thrown ENOENT.
//
// Chromium in Lambda also has no system fonts, so an embedded face is not
// optional — without it the PDF renders in fallback glyphs or blank boxes.
//
// Source files live in amplify/functions/render-proposal-pdf/assets/.
// The logos were extracted from docs/Aeygis_Cloud_Overview.pdf with their SMask
// applied, so they carry real transparency (the raw extraction was opaque black).

import type { TemplateAssets } from './template.js';

${entries.map(([key, file, b64]) => `/** ${file} */\nconst ${key} = '${b64}';`).join('\n\n')}

export const TEMPLATE_ASSETS: TemplateAssets = {
  lato400,
  lato700,
  lato900,
  logoOnDark,
  logoOnLight,
};
`;

const outPath = path.join(fnDir, 'template-assets.generated.ts');
writeFileSync(outPath, out, 'utf8');
console.log(`\nwrote ${path.relative(path.join(here, '..'), outPath)} (${(total / 1024).toFixed(0)} kB of base64)`);
