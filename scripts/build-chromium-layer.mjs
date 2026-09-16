/**
 * Stages a Lambda layer containing @sparticuz/chromium-min.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A LAYER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The package MUST NOT be bundled by esbuild. It resolves the browser binary
 * through relative paths, so bundling relocates it and it fails at runtime with
 * its own error: "you must externalize @sparticuz/chromium so it is not
 * relocated." Verified: the first deploy inlined it, and the library's guard text
 * was visible inside our index.mjs.
 *
 * Externalizing means the module must exist at runtime by another route. Two
 * options, and only one works here:
 *
 *   - CDK's `bundling.nodeModules` installs instead of bundles, but its own docs
 *     say it works "only when bundling runs in Docker". No Docker dependency
 *     wanted in this build.
 *   - A LAYER. The package is 67 kB across 11 files, so the layer is trivially
 *     small. This is the route taken.
 *
 * Note this layer carries only the LOADER, not the browser. `chromium-min` is
 * the variant that downloads the ~50 MB pack at runtime from CHROMIUM_PACK_URL,
 * which is why the layer stays tiny and why the pack is hosted in ca-central-1
 * rather than fetched across a region boundary.
 *
 * Lambda requires the layout `nodejs/node_modules/<pkg>` for Node runtimes.
 *
 * Run:  npm run build:layer
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const PKG = '@sparticuz/chromium-min';
const installed = path.join(root, 'node_modules', ...PKG.split('/'));
const layerRoot = path.join(root, 'layers', 'chromium');
const nodejsDir = path.join(layerRoot, 'nodejs');

if (!existsSync(installed)) {
  console.error(`${PKG} is not installed. Run npm install first.`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version;

rmSync(layerRoot, { recursive: true, force: true });
mkdirSync(nodejsDir, { recursive: true });

/**
 * `npm install` rather than a directory copy — DEPENDENCIES MATTER.
 *
 * The first version of this script copied only the package directory. The layer
 * deployed, the module resolved from /opt/nodejs/..., and the function then died
 * at runtime with:
 *
 *   Cannot find package 'tar-fs' imported from
 *   /opt/nodejs/node_modules/@sparticuz/chromium-min/build/helper.js
 *
 * chromium-min depends on tar-fs (it extracts the browser pack), and a hand-copy
 * silently omits the whole transitive tree. Letting npm resolve it is the only
 * way to be sure nothing is missing.
 *
 * `--omit=dev` keeps the layer to runtime requirements only.
 */
writeFileSync(
  path.join(nodejsDir, 'package.json'),
  JSON.stringify({ name: 'aeygis-chromium-layer', private: true, dependencies: { [PKG]: version } }, null, 2),
  'utf8',
);

console.log(`installing ${PKG}@${version} and its dependencies...`);
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: nodejsDir,
  stdio: 'inherit',
  shell: true,
});

// A layer that resolves the entry point but not its dependencies fails at
// runtime, not at deploy — so assert the dependency is present before shipping.
const layerModules = path.join(nodejsDir, 'node_modules');
const REQUIRED = [PKG, 'tar-fs'];
for (const dep of REQUIRED) {
  if (!existsSync(path.join(layerModules, ...dep.split('/')))) {
    console.error(`\nLayer is incomplete: ${dep} is missing from node_modules.`);
    process.exit(1);
  }
}
const topLevel = readdirSync(layerModules).filter((n) => !n.startsWith('.'));
console.log(`  layer node_modules: ${topLevel.length} top-level package(s)`);

// Record the version alongside the layer. The pack downloaded at runtime MUST
// match this exactly — a mismatch produces an obscure launch failure rather than
// a clear error, so leaving a visible marker is worth the one extra file.
writeFileSync(
  path.join(layerRoot, 'VERSION'),
  `${PKG}@${version}\n\n` +
    `The Chromium pack referenced by CHROMIUM_PACK_URL must be version ${version}.\n` +
    `A mismatched pack fails obscurely at browser launch. See docs/deployment.md -> P4.\n`,
  'utf8',
);

console.log(`staged ${PKG}@${version}`);
console.log(`  layer root: ${path.relative(root, layerRoot)}`);
console.log(`  layout:     nodejs/node_modules/${PKG}`);
console.log(`\nThe pack at CHROMIUM_PACK_URL must be version ${version}.`);
