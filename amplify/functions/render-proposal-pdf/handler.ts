import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import { renderProposalHtml } from './template.js';
import { TEMPLATE_ASSETS } from './template-assets.generated.js';
import { assertClientSafe, assertHtmlFreeOfConfidentialWords } from './assertClientSafe.js';

/**
 * Renders a frozen snapshot into a client-facing PDF.
 *
 * INPUT is ONLY an S3 key under snapshots/. The handler never receives assessment
 * data, pricing inputs, or anything else directly — it reads the frozen,
 * already-client-safe JSON that price-proposal wrote. That is barrier 3: there is
 * no path from here to the live data model or to internal cost figures.
 *
 * Its IAM role can read snapshots/ and write proposals/client/. It has no ARN for
 * proposals/internal/ at all (barrier 4).
 *
 * Before rendering, the payload passes the runtime guard (barrier 5) and the
 * rendered HTML is scanned for confidential wording. A leak becomes a failed
 * render, never a document in a prospect's inbox.
 */

const s3 = new S3Client({});
const ssm = new SSMClient({});

/**
 * Reads configuration from `process.env` rather than the generated
 * `$amplify/env/*` module.
 *
 * This function uses `defineFunction(provider)` (see resource.ts), and
 * `ProvidedFunctionProps` exposes only `resourceGroupName` — Amplify does not
 * manage its environment, so the generated typed env module is not reliably
 * produced. Reading process.env with an explicit check is honest about that
 * instead of importing something that may not exist.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set on the render-proposal-pdf function`);
  }
  return value;
}

/**
 * Resolves the proposals bucket name via SSM rather than a plain env var.
 *
 * Amplify's automatic env injection (`allow.resource(fn)` in
 * storage/resource.ts -> AMPLIFY_SSM_ENV_CONFIG -> a wrapper that resolves it
 * before the handler runs) does not reach a function defined via
 * `defineFunction(provider)` — confirmed by reading this function's own
 * deployed config, which ships an empty AMPLIFY_SSM_ENV_CONFIG. See the
 * matching comment in backend.ts, which publishes a dedicated parameter and
 * grants this function's role read access to it.
 *
 * Cached at module scope: this only needs to run once per COLD START, not
 * per invocation. A warm container reuses the resolved value.
 */
let cachedBucketName: string | null = null;

async function resolveProposalsBucketName(): Promise<string> {
  if (cachedBucketName !== null) return cachedBucketName;
  const paramName = requireEnv('AEYGIS_PROPOSALS_BUCKET_NAME_PARAM');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const value = result.Parameter?.Value;
  if (value === undefined || value === '') {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }
  cachedBucketName = value;
  return value;
}

/**
 * Assets are IMPORTED, not read from disk.
 *
 * An earlier version did `readFileSync(join(dirname, 'assets', ...))`. Downloading
 * the deployed Lambda package proved that wrong: it contained exactly two files,
 * index.mjs and index.mjs.map. Amplify's bundler does not copy sibling asset
 * directories, so every font and logo was absent and the first render would have
 * thrown ENOENT. Regenerate with `npm run gen:assets`.
 */

export interface RenderEvent {
  readonly snapshotS3Key: string;
  readonly outputS3Key: string;
  readonly proposalId: string;
  readonly versionKey: string;
}

export interface RenderResult {
  readonly ok: boolean;
  readonly pdfS3Key?: string;
  readonly bytes?: number;
  readonly error?: string;
}

async function readSnapshot(bucket: string, key: string): Promise<unknown> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await result.Body?.transformToString();
  if (body === undefined) throw new Error(`snapshot ${key} is empty`);
  return JSON.parse(body);
}

export const handler = async (event: RenderEvent): Promise<RenderResult> => {
  const packUrl = process.env['CHROMIUM_PACK_URL'];

  if (packUrl === undefined || packUrl === '') {
    // Refuse loudly. A missing binary must not look like a rendering failure of
    // the document itself, or someone will spend a day debugging the template.
    const error =
      'CHROMIUM_PACK_URL is not set. Upload the Chromium pack to the ca-central-1 ' +
      'bucket and set the variable; see docs/deployment.md.';
    console.error(error);
    return { ok: false, error };
  }

  let bucket: string;
  try {
    bucket = await resolveProposalsBucketName();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return { ok: false, error: message };
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

  try {
    const payload = await readSnapshot(bucket, event.snapshotS3Key);

    // Barrier 5 — before a single byte is rendered.
    assertClientSafe(payload);

    const html = renderProposalHtml(payload as never, TEMPLATE_ASSETS);
    assertHtmlFreeOfConfidentialWords(html);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 905 },
      executablePath: await chromium.executablePath(packUrl),
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // Fonts are embedded as data URIs, but the engine still applies them
    // asynchronously; without this the first page can rasterise in a fallback.
    // Passed as a STRING rather than a closure on purpose: the code runs in the
    // browser context, so a closure would require DOM lib types in a Node
    // tsconfig, which would then wrongly hand every other handler DOM globals.
    await page.evaluate('document.fonts.ready');

    // Geometry comes from the template's own `@page` rule, so there is one
    // source of truth. Note puppeteer rejects `pt` units for width/height,
    // which is a second reason not to duplicate them here.
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: event.outputS3Key,
        Body: pdf,
        ContentType: 'application/pdf',
        // Surfaces which snapshot produced this object, so a PDF can always be
        // traced back to the approved content hash.
        Metadata: {
          proposalid: event.proposalId,
          versionkey: event.versionKey,
          snapshotkey: event.snapshotS3Key,
        },
      }),
    );

    console.info('rendered proposal', {
      proposalId: event.proposalId,
      versionKey: event.versionKey,
      key: event.outputS3Key,
      bytes: pdf.length,
    });

    return { ok: true, pdfS3Key: event.outputS3Key, bytes: pdf.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('render failed', { event, message });
    return { ok: false, error: message };
  } finally {
    await browser?.close();
  }
};
