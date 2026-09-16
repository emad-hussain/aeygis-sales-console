/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BARRIER 5 of 5 — the runtime guard.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The last line of defence before bytes become a client-facing PDF.
 *
 * The other four barriers are static: a forbidden dependency edge, a closed
 * payload type, cost data kept out of the AppSync schema, and IAM scoping. All
 * four can be defeated by a determined edit. This one runs on every render and
 * throws, so a leak becomes a failed render rather than a document in a
 * prospect's inbox.
 *
 * Deliberately paranoid: it rejects on KEY NAMES rather than trying to detect
 * confidential values, because a key called `grossMarginCad` is a reliable
 * signal while the number 41200 is not.
 */

/**
 * Key substrings that must never appear in a client payload.
 *
 * Chosen to match the vocabulary of @aeygis/pricing-internal:
 *   cost, margin, competitor, hourly, gross, cogs, internal, floor, payroll
 *
 * NOTE the word "cost" is included even though it is broad. That is deliberate:
 * client-facing money fields are named `setupTotal`, `monthlyTotal`,
 * `firstYearTotal` and `annualCheckup`, none of which contain "cost". If a new
 * client-facing field genuinely needs "cost" in its name, rename the field
 * rather than weakening this pattern.
 */
const FORBIDDEN_KEY = /cost|margin|competitor|hourly|gross|cogs|internal|floor|payroll|discountFactor/i;

/**
 * String values that indicate confidential content leaked as text, not a key.
 * Catches the case where a whole document string was interpolated.
 */
const FORBIDDEN_VALUE = /confidential\s*[-–—]\s*internal use only|cost per hour|per engineer-hour|gross margin/i;

export class ClientSafetyError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ClientSafetyError';
  }
}

/**
 * Deep-scans a payload and throws on the first violation.
 *
 * @param payload  the value about to be rendered
 * @param path     current position, used to make the error actionable
 */
export function assertClientSafe(payload: unknown, path = '$'): void {
  if (payload === null || payload === undefined) return;

  if (typeof payload === 'string') {
    if (FORBIDDEN_VALUE.test(payload)) {
      throw new ClientSafetyError(
        `Confidential text detected at ${path}. This payload must never reach a client document.`,
        path,
      );
    }
    return;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') return;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertClientSafe(item, `${path}[${i}]`));
    return;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new ClientSafetyError(
          `Forbidden key "${key}" at ${path}. Keys matching ${FORBIDDEN_KEY} are confidential ` +
            'and must not reach a client-facing document. Derive a client-safe figure in ' +
            '@aeygis/pricing instead of widening this payload.',
          `${path}.${key}`,
        );
      }
      assertClientSafe(value, `${path}.${key}`);
    }
    return;
  }

  // Functions, symbols, bigints — nothing legitimate arrives here.
  throw new ClientSafetyError(`Unexpected value type "${typeof payload}" at ${path}`, path);
}

/**
 * Strips markup so a scan sees only what a reader would see.
 *
 * This is NOT cosmetic. Scanning raw HTML for confidential vocabulary is
 * useless: `margin` is a CSS property, so every stylesheet trips it, and
 * `padding: 0 100pt` contains "100". A naive whole-document scan therefore
 * either always fails or gets deleted by whoever is tired of it.
 *
 * Removing <style> and <script> entirely (not just their tags) plus all
 * attributes leaves the visible copy, which is the only place a leak actually
 * harms anyone.
 */
export function extractVisibleText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // ENTITIES MUST BE DECODED, not just stripped. `esc()` turns every
      // apostrophe into &#39; and every quote into &quot; on the way in, so a
      // scanner that leaves them encoded is not reading what a reader reads —
      // "the competitor's price" would sit in the document as
      // "the competitor&#39;s price" and still match, but a phrase whose only
      // distinguishing character was escaped could slip past. Decoding closes
      // that gap and is also simply what "visible text" means.
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;|&middot;|&mdash;|&ndash;/g, ' ')
      // &amp; LAST, so a double-escaped entity such as &amp;lt; does not become
      // a real "<" and reintroduce something that looks like markup.
      .replace(/&amp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Smallest literal worth scanning for.
 *
 * Below this, collisions with ordinary layout and copy are near-certain (a rate
 * of 75 matches "75" in a date, a percentage, a page number). Scanning them
 * would produce false positives that erode trust in the guard.
 *
 * Small confidential figures are covered instead by the VOCABULARY scan — the
 * phrase "cost per hour" is what makes 75 meaningful, and that phrase is caught.
 */
export const MIN_SCANNABLE_LITERAL = 1_000;

/**
 * Scans rendered output for confidential numeric literals.
 *
 * Complements the key scan: a figure could in principle be copied into a
 * legitimately-named field. Takes the values as an argument so the renderer
 * never imports the internal package itself.
 *
 * Throws a plain Error (not ClientSafetyError) when handed an unscannable
 * literal, so a caller cannot accidentally write a vacuous test that passes
 * because nothing could ever match.
 */
export function assertHtmlFreeOfLiterals(html: string, forbiddenLiterals: readonly number[]): void {
  const text = extractVisibleText(html);

  for (const literal of forbiddenLiterals) {
    if (Math.abs(literal) < MIN_SCANNABLE_LITERAL) {
      throw new Error(
        `Refusing to scan for the literal ${literal}: values below ${MIN_SCANNABLE_LITERAL} ` +
          'collide with ordinary layout and copy, so the check would be unreliable. ' +
          'Rely on the vocabulary scan for small figures.',
      );
    }

    // Allow an optional thousands separator, and require word boundaries so
    // 41200 does not match inside 141200.
    const pattern = new RegExp(`(^|[^\\d.])${literal.toLocaleString('en-CA').replace(/,/g, '[,\\s]?')}([^\\d.]|$)`);
    if (pattern.test(text)) {
      throw new ClientSafetyError(
        `Rendered document contains the confidential literal ${literal}.`,
        'html',
      );
    }
  }
}

/**
 * Confidential vocabulary that must not appear in visible copy.
 * Phrases, not bare words, for the reason described in `extractVisibleText`.
 */
const FORBIDDEN_PHRASES = [
  'cost per hour',
  'per engineer-hour',
  'gross margin',
  'internal use only',
  'competitor',
  'payroll',
  'cogs',
  'margin',
] as const;

/** Scans visible copy for confidential vocabulary. */
export function assertHtmlFreeOfConfidentialWords(html: string): void {
  const text = extractVisibleText(html).toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (text.includes(phrase)) {
      throw new ClientSafetyError(
        `Rendered document contains the confidential phrase "${phrase}" in visible copy.`,
        'html',
      );
    }
  }
}
