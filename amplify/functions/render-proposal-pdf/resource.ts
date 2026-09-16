import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineFunction } from '@aws-amplify/backend';
import { Duration } from 'aws-cdk-lib';
import { Code, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

const here = path.dirname(fileURLToPath(import.meta.url));
const layerDir = path.join(here, '..', '..', '..', 'layers', 'chromium');

/**
 * Short content hash of the staged layer, used in its CONSTRUCT ID.
 *
 * WHY: `AWS::Lambda::LayerVersion` is immutable, so changing its content is a
 * REPLACEMENT-type update — and Amplify's sandbox deploys with disable-rollback,
 * where CloudFormation refuses those outright:
 *
 *   "Replacement type updates not supported on stack with disable-rollback."
 *
 * Hit for real when the layer gained chromium-min's 18 transitive dependencies.
 *
 * Putting the hash in the construct id means new content becomes a NEW logical
 * resource, so CloudFormation does create-then-delete rather than replace-in-place,
 * which it permits. The alternative — hand-renaming the construct on every content
 * change — is the same trick performed manually and forgotten once.
 */
function layerContentHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      // Path + size is enough to detect added, removed or changed files without
      // reading every byte of a 6 MB tree at synth time.
      hash.update(path.relative(dir, full).replace(/\\/g, '/'));
      if (stat.isDirectory()) walk(full);
      else hash.update(String(stat.size));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 8);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS USES THE PROVIDER OVERLOAD INSTEAD OF PLAIN defineFunction
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `@sparticuz/chromium-min` must be EXTERNAL to the esbuild bundle. It resolves
 * the browser binary via relative paths, so bundling relocates it and it fails at
 * runtime with its own message: "you must externalize @sparticuz/chromium so it is
 * not relocated."
 *
 * This is not a hypothetical. The first deploy used plain `defineFunction`, and
 * downloading the resulting package showed:
 *   - the library's guard text inlined into our index.mjs (so it WAS bundled)
 *   - exactly two files, index.mjs and index.mjs.map (so ./assets was NOT shipped)
 *
 * Amplify cannot express externalization. Verified in the installed types:
 *
 *     export type FunctionBundlingOptions = { minify?: boolean };
 *
 * That is the whole type. So the documented `defineFunction(provider)` overload is
 * the only route, giving direct control of esbuild via CDK's NodejsFunction.
 *
 * The externalized module is supplied by a small layer (`npm run build:layer`),
 * which carries only the LOADER — `chromium-min` downloads the ~50 MB browser pack
 * at runtime from CHROMIUM_PACK_URL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSEQUENCES OF THE PROVIDER OVERLOAD — read before editing
 *
 * `ProvidedFunctionProps` exposes only `resourceGroupName`, so Amplify does not
 * manage this function's name or environment. Two follow-ons:
 *
 *   1. The generated `$amplify/env/render-proposal-pdf` module is not reliably
 *      produced for a provided function, so the handler reads `process.env`
 *      directly and validates what it needs. That is a deliberate trade of a
 *      little type safety for not depending on unverified codegen.
 *   2. Environment variables are wired in backend.ts via `addEnvironment`.
 *
 * SIZING, from the @sparticuz/chromium docs rather than guessed: >=512 MB works,
 * 1600+ MB recommended. More memory also means more CPU, so a larger setting is
 * often CHEAPER — brotli extraction and browser launch finish sooner. Timeout
 * >=10 s for a cold start, 30 s recommended; 60 s here for headroom.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const renderProposalPdf = defineFunction(
  (scope) => {
    // Content hash in the id: see layerContentHash above. Without it, changing
    // the layer's contents fails the sandbox deploy outright.
    const layer = new LayerVersion(scope, `ChromiumLayer${layerContentHash(layerDir)}`, {
      // Built by `npm run build:layer` into layers/chromium/nodejs/node_modules/.
      // That script uses `npm install`, NOT a directory copy: chromium-min pulls in
      // tar-fs and 17 other packages, and a hand-copy silently omitted all of them,
      // producing a runtime "Cannot find package 'tar-fs'".
      code: Code.fromAsset(layerDir),
      compatibleRuntimes: [Runtime.NODEJS_22_X],
      description: 'chromium-min loader (browser binary is fetched at runtime from CHROMIUM_PACK_URL)',
    });

    return new NodejsFunction(scope, 'RenderProposalPdf', {
      entry: path.join(here, 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 2048,
      layers: [layer],
      bundling: {
        // THE WHOLE POINT of dropping to a provider.
        externalModules: ['@sparticuz/chromium-min'],
        // ESM to match the rest of the project.
        format: OutputFormat.ESM,
        // esbuild emits `require` shims that break in ESM without this.
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
        minify: true,
        sourceMap: true,
        // The v3 SDK is present in the Lambda runtime, but bundling it pins a
        // known version instead of inheriting whatever AWS ships.
        bundleAwsSDK: true,
      },
    });
  },
  { resourceGroupName: 'function' },
);
