/**
 * Layout and visual-defect check for the console, in a REAL browser, in BOTH
 * themes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * `verify-console-renders.mjs` proves the app MOUNTS. It cannot see a card
 * that overflows its column, text clipped without an ellipsis, a sticky
 * header covering the thing it was asked to scroll to, grey-on-grey text
 * nobody can read, or a heading silently painting in the wrong typeface.
 * Every one of those compiles, serves, and mounts perfectly.
 *
 * Three real defects it has caught so far, none of which any other check
 * could see:
 *
 *   1. 77 text nodes below WCAG AA — the mockup palette was carried over
 *      unchanged and --dim measured 2.77:1 on the chip ground.
 *   2. The sign-in submit button rendering as a WHITE TEXT FIELD. Amplify's
 *      submit carries `amplify-field-group__control` as well as
 *      `amplify-button--primary`, so styling the former as an input (0,2,0)
 *      silently outranked the latter (0,1,0).
 *   3. Half the console painting in Segoe UI Black. Amplify's stylesheet sets
 *      font-family on [data-amplify-theme], and ThemeProvider wraps the whole
 *      app — so every element without its own font-family inherited the auth
 *      theme's font. document.fonts.check() said "Manrope: true" throughout,
 *      because availability is not usage.
 *
 * Usage — the dev server must already be running (npm run console):
 *   node scripts/check-console-ui.mjs [url]
 *
 * Screenshots land in .artifacts/ui/ for eyeballing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const SHOT_DIR = path.join(repo, '.artifacts', 'ui');
const URL_TO_CHECK = process.argv[2] ?? 'http://localhost:5173/';
const THEME_KEY = 'aeygis-console-theme';

const CANDIDATE_BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No local Chrome/Edge found.');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(path.join(repo, '.test-credentials.json'), 'utf8'));
const who = creds.approver;

let failures = 0;
let checks = 0;
const pass = (m) => {
  checks += 1;
  console.log(`  PASS  ${m}`);
};
const fail = (m, detail) => {
  checks += 1;
  failures += 1;
  console.error(`  FAIL  ${m}`);
  if (detail) for (const d of detail.slice(0, 8)) console.error(`          ${d}`);
  if (detail && detail.length > 8) console.error(`          …and ${detail.length - 8} more`);
};

const VIEWPORTS = [
  { name: '1600', width: 1600, height: 1000 },
  { name: '1280', width: 1280, height: 860 },
  { name: '1024', width: 1024, height: 820 },
  { name: '900', width: 900, height: 900 },
  { name: '620', width: 620, height: 900 },
];

const THEMES = ['light', 'dark'];

/* Mirrored from packages/domain/src/assessment.ts. A unit test guards the
   labels; this guards that the console actually offers every one of them. */
const STATUSES = ['new', 'needs_confirmation', 'in_review', 'proposed', 'closed'];

/* Noise that is not a defect. Deliberately SHORT — a permissive ignore list
   is how a real error gets waved through. */
const IGNORABLE = [/Download the React DevTools/i, /\[vite\] connect(ing|ed)/i];

mkdirSync(SHOT_DIR, { recursive: true });

/* ═══════════════════════════════════════════════════════════════════════════
   STATIC: the dark palette is declared twice and the two must not drift
   ═══════════════════════════════════════════════════════════════════════════
   brand.css needs `@media (prefers-color-scheme: dark) :root:not([data-theme=
   'light'])` for system-followers AND `:root[data-theme='dark']` for an
   explicit choice. CSS has no way to share one token list between them, so
   they are duplicated — and a token added to one but not the other produces a
   half-dark UI in exactly one of the three theme states, which is the state
   nobody tests by hand.
   ═══════════════════════════════════════════════════════════════════════════ */
function blockAfter(css, marker) {
  const start = css.indexOf(marker);
  if (start === -1) return null;
  let i = css.indexOf('{', start);
  let depth = 0;
  const open = i;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

function tokensIn(block) {
  const map = new Map();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return map;
}

function checkDarkBlocksAgree() {
  const css = readFileSync(path.join(repo, 'apps/console/src/brand.css'), 'utf8');
  const a = blockAfter(css, ":root:not([data-theme='light'])");
  const b = blockAfter(css, ":root[data-theme='dark']");
  if (a === null || b === null) {
    fail('brand.css: could not find both dark blocks', [`media=${a !== null} explicit=${b !== null}`]);
    return;
  }
  const ta = tokensIn(a);
  const tb = tokensIn(b);
  const problems = [];
  for (const [k, v] of ta) {
    if (!tb.has(k)) problems.push(`${k} only in the media block`);
    else if (tb.get(k) !== v) problems.push(`${k}: media=${v} explicit=${tb.get(k)}`);
  }
  for (const k of tb.keys()) if (!ta.has(k)) problems.push(`${k} only in the [data-theme] block`);

  // Every dark token must also exist in :root, or it has no light value.
  const root = blockAfter(css, '\n:root {');
  const troot = root === null ? new Map() : tokensIn(root);
  for (const k of ta.keys()) {
    if (k !== 'color-scheme' && !troot.has(k)) problems.push(`${k} has no light value in :root`);
  }

  if (problems.length === 0) {
    pass(`brand.css: both dark blocks declare the same ${ta.size} tokens`);
  } else {
    fail('brand.css: dark blocks have drifted', problems);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STATIC: is the dev server actually serving the code on disk?
   ═══════════════════════════════════════════════════════════════════════════
   This is not paranoia. Twice during the Porcelain rebuild Vite's watcher
   coalesced rapid successive writes and kept a MID-EDIT transform cached:

     - authTheme.ts served the previous font stack while disk said Manrope
     - App.tsx served the ThemeToggle import but none of its usages

   Both times every check below still ran, and passed, against code that was
   not the code on disk. A green run against a stale server is worse than a
   red one, so this goes first.

   The CSS comparison is exact — Vite embeds the raw stylesheet in the module.
   For TSX the transform rewrites the source, so the check is that every
   className literal on disk survives into what is served; those are string
   literals and pass through untouched.
   ═══════════════════════════════════════════════════════════════════════════ */
const DECL_RE = /^(?:export )?(?:const|function|class) ([A-Za-z_$][\w$]*)/gm;

async function checkDevServerFresh(baseUrl) {
  const srcDir = path.join(repo, 'apps/console/src');
  const problems = [];

  try {
    const served = await (await fetch(new URL('/src/brand.css', baseUrl))).text();
    const m = served.match(/const __vite__css = ("(?:[^"\\]|\\.)*")/);
    if (m === null) {
      problems.push('brand.css: could not read the served stylesheet');
    } else {
      const norm = (t) => t.replace(/\r\n/g, '\n').trim();
      const onDisk = norm(readFileSync(path.join(srcDir, 'brand.css'), 'utf8'));
      if (norm(JSON.parse(m[1])) !== onDisk) {
        problems.push('brand.css: served stylesheet differs from the file on disk');
      }
    }

    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))) {
      const disk = readFileSync(path.join(srcDir, file), 'utf8');
      // Two independent fingerprints, because one is not enough: a stale
      // transform once carried every className from the new source while
      // DROPPING a top-level `const`, so the page mounted and then died on
      // "STATUS_CHOICES is not defined". Declarations catch that; classNames
      // catch markup-only edits. Both survive Vite's transform verbatim.
      const names = [
        ...[...disk.matchAll(/className="([^"{}]+)"/g)].map((x) => x[1]),
        ...[...disk.matchAll(DECL_RE)].map((x) => x[1]),
      ];
      if (names.length === 0) continue;
      const text = await (await fetch(new URL(`/src/${file}`, baseUrl))).text();
      const missing = [...new Set(names)].filter((n) => !text.includes(n));
      if (missing.length > 0) {
        problems.push(`${file}: served module is missing ${missing.length} name(s) - e.g. "${missing[0]}"`);
      }
    }
  } catch (e) {
    problems.push(`could not reach the dev server: ${e.message}`);
  }

  if (problems.length === 0) {
    pass('dev server is serving the current source');
  } else {
    fail('dev server is STALE - every check below is meaningless', [
      ...problems,
      'restart `npm run console`, or touch the files, then re-run',
    ]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   In-page probes. These run in the browser, so they must be self-contained.
   ═══════════════════════════════════════════════════════════════════════════ */

const OVERFLOW_PROBE = () => {
  const SCROLLERS = '.table-wrap, .section-nav, .detail-pane, .queue-pane, .auth-formside';
  const out = [];
  const w = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    // Inside a deliberate horizontal scroller: its container clips it, so
    // measure the container rather than every descendant.
    if (el.closest(SCROLLERS) !== null && el.matches(SCROLLERS) === false) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > w + 1) {
      const cls = (el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.');
      out.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)} vw=${w}`);
    }
  }
  return out;
};

const PANE_SCROLL_PROBE = () => {
  const out = [];
  for (const sel of ['.queue-pane', '.detail-pane', '.auth-formside', '.detail-body', '.panel-body']) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push(`${sel} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
      }
    }
  }
  return out;
};

const CLIP_PROBE = () => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim();
    if (text === '') continue;
    const s = getComputedStyle(el);
    if (s.overflow !== 'hidden' && s.overflowX !== 'hidden') continue;
    if (s.textOverflow === 'ellipsis') continue;
    // Screen-reader-only text is a 1x1 clipped box BY DESIGN — Amplify's
    // "Password is hidden" live region is one. Real visible text is never
    // this small, so the size test separates the two without needing to know
    // every framework's sr-only class name.
    if (el.clientWidth <= 4 || el.clientHeight <= 4) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      out.push(`"${text.slice(0, 40)}" clipped ${el.scrollWidth}>${el.clientWidth}`);
    }
  }
  return out;
};

const CONTRAST_PROBE = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim();
    if (text === '') continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.9) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const fg = parse(s.color);
    if (!fg || fg.a < 0.95) continue;

    // First opaque ancestor background; bail out on an image, where there is
    // no single colour to compare against (the sign-in brand panel).
    let bg = null;
    let node = el;
    while (node && node !== document.documentElement) {
      const ns = getComputedStyle(node);
      if (ns.backgroundImage !== 'none') {
        bg = 'image';
        break;
      }
      const c = parse(ns.backgroundColor);
      if (c && c.a >= 0.95) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    if (bg === 'image' || bg === null) continue;

    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) {
      out.push(
        `${got.toFixed(2)}:1 (need ${need}) "${text.slice(0, 34)}" ${s.color} on rgb(${bg.r},${bg.g},${bg.b}) ${size}px/${weight}`,
      );
    }
  }
  return out;
};

/** Are the webfonts even available? Necessary, nowhere near sufficient. */
const FONT_PROBE = () => ({
  manrope: document.fonts.check('700 1rem Manrope'),
  mono: document.fonts.check('400 1rem "IBM Plex Mono"'),
});

/**
 * What the rendering engine ACTUALLY painted with, per element.
 *
 * document.fonts.check() only answers "is this face loadable" — it says
 * nothing about whether any element uses it. Both returned true while half
 * the console rendered in Segoe UI Black. Only CSS.getPlatformFontsForNode
 * can see that.
 *
 * The selectors deliberately include elements that do NOT set their own
 * font-family (h1, h2, dt, .hint) — those are the ones that inherit, and so
 * the ones a stray ancestor rule silently captures.
 */
async function paintedFonts(page, selectors) {
  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const out = {};
  for (const sel of selectors) {
    const { root } = await client.send('DOM.getDocument');
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) {
      out[sel] = null;
      continue;
    }
    const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
    const main = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
    out[sel] = main ? main.familyName : null;
  }
  await client.detach();
  return out;
}

function checkPainted(painted, expect, label) {
  const wrong = Object.entries(painted)
    .filter(([sel]) => expect[sel] !== undefined)
    .filter(([, fam]) => fam !== null)
    .filter(([sel, fam]) => !fam.startsWith(expect[sel]))
    .map(([sel, fam]) => `${sel} painted "${fam}", expected ${expect[sel]}`);
  const missing = Object.entries(painted)
    .filter(([, fam]) => fam === null)
    .map(([sel]) => `${sel}: element not found or no text`);
  if (wrong.length === 0 && missing.length === 0) pass(`${label}: type painted in Manrope / IBM Plex Mono`);
  else fail(`${label}: wrong typeface painted`, [...wrong, ...missing]);
}

/* ═══════════════════════════════════════════════════════════════════════════ */

function attachListeners(page, bag) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (IGNORABLE.some((re) => re.test(t))) return;
    if (msg.type() === 'error') bag.errors.push(t);
  });
  page.on('pageerror', (e) => bag.errors.push(`[uncaught] ${e.message}`));
  page.on('requestfailed', (r) => bag.errors.push(`[request failed] ${r.url()} — ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) bag.errors.push(`[${r.status()}] ${r.url()}`);
  });
}

async function runProbes(page, label) {
  const [overflow, paneScroll, clipped, contrast] = await Promise.all([
    page.evaluate(OVERFLOW_PROBE),
    page.evaluate(PANE_SCROLL_PROBE),
    page.evaluate(CLIP_PROBE),
    page.evaluate(CONTRAST_PROBE),
  ]);

  const doc = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));

  if (doc.sw <= doc.cw + 1) pass(`${label}: no horizontal page scroll`);
  else fail(`${label}: page scrolls sideways`, [`scrollWidth=${doc.sw} clientWidth=${doc.cw}`]);

  if (overflow.length === 0) pass(`${label}: nothing overflows the viewport`);
  else fail(`${label}: ${overflow.length} element(s) past the right edge`, overflow);

  if (paneScroll.length === 0) pass(`${label}: no pane scrolls sideways`);
  else fail(`${label}: pane(s) scroll sideways`, paneScroll);

  if (clipped.length === 0) pass(`${label}: no text clipped without an ellipsis`);
  else fail(`${label}: ${clipped.length} clipped text node(s)`, clipped);

  if (contrast.length === 0) pass(`${label}: text meets WCAG AA contrast`);
  else fail(`${label}: ${contrast.length} low-contrast text node(s)`, contrast);
}

const shoot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });

/** Pin a theme the way a returning user would have it: stored, then loaded. */
async function applyTheme(page, theme) {
  await page.evaluate(
    (k, t) => {
      if (t === null) localStorage.removeItem(k);
      else localStorage.setItem(k, t);
    },
    THEME_KEY,
    theme,
  );
  await page.reload({ waitUntil: 'networkidle2' });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the intake queue to SETTLE, not merely to fill.
 *
 * The earlier version waited for a `.queue-item` or the words "No assessments",
 * which cannot see the third outcome: the list failed to load and the pane is
 * showing an error. That produced a bare 40s timeout with no clue why. Waiting
 * for `.empty-state` too covers every terminal state, and the error is then
 * reported as an error rather than as a hang.
 */
async function waitForQueue(page, label) {
  await page.waitForSelector('.app-frame', { timeout: 40_000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.queue-item').length > 0 ||
      document.querySelector('.queue-pane .empty-state') !== null,
    { timeout: 40_000 },
  );
  const state = await page.evaluate(() => {
    const err = document.querySelector('.queue-pane .notice-block');
    return {
      items: document.querySelectorAll('.queue-item').length,
      error: err ? (err.textContent ?? '').trim() : null,
    };
  });
  if (state.error !== null) {
    fail(`${label}: the queue failed to load`, [state.error]);
    return false;
  }
  if (state.items === 0) {
    fail(`${label}: the queue is empty`, ['run `npm run seed:demo` to populate it']);
    return false;
  }
  return true;
}

const SIGNIN_FONTS = {
  '.auth-hero h1': 'Manrope',
  '.auth-hero p': 'Manrope',
  '.auth-card h2': 'Manrope',
  '.auth-card .sub': 'Manrope',
  '.auth-footnote': 'IBM Plex Mono',
};

const CONSOLE_FONTS = {
  '.detail-head h1': 'Manrope',
  '.panel-head h2': 'Manrope',
  '.qi-name': 'Manrope',
  '.def-grid dt': 'Manrope',
  '.panel-body .hint': 'Manrope',
  '.brand-word': 'Manrope',
  '.detail-head .meta': 'IBM Plex Mono',
  '.qi-ref': 'IBM Plex Mono',
};

/**
 * The user menu: identity, role, groups and Sign out behind the initials.
 *
 * Opens and closes it for real rather than inspecting markup, because the
 * things that break here are behavioural — a panel that opens off-screen, a
 * click-outside handler that never detaches, focus stranded on the trigger.
 * Nothing here writes: it reads the token claims the app already holds.
 */
async function checkUserMenu(page, theme) {
  const shut = () => page.evaluate(() => document.querySelector('.user-panel') === null);
  const problems = [];

  if (!(await shut())) problems.push('panel was already open before clicking');

  await page.click('button.avatar');
  await settle(450);

  const open = await page.evaluate(() => {
    const el = document.querySelector('.user-panel');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const trigger = document.querySelector('button.avatar');
    return {
      text: el.innerText.replace(/\s+/g, ' '),
      role: el.getAttribute('role'),
      expanded: trigger?.getAttribute('aria-expanded'),
      hasSignOut: [...el.querySelectorAll('button')].some((b) => /sign out/i.test(b.textContent ?? '')),
      focusInside: el.contains(document.activeElement),
      onScreen: r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      background: getComputedStyle(el).backgroundColor,
      surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
      strayTopbarSignOut: [...document.querySelectorAll('.topbar > button')].some((b) =>
        /sign out/i.test(b.textContent ?? ''),
      ),
    };
  });

  if (open === null) {
    fail(`console · ${theme}: user menu did not open`);
    return;
  }
  if (open.role !== 'dialog') problems.push(`role is "${open.role}"`);
  if (open.expanded !== 'true') problems.push('aria-expanded did not flip');
  if (!/@/.test(open.text)) problems.push('no email address shown');
  if (!/role/i.test(open.text)) problems.push('no role shown');
  if (!/groups/i.test(open.text)) problems.push('no groups shown');
  if (!open.hasSignOut) problems.push('Sign out is not inside the panel');
  if (open.strayTopbarSignOut) problems.push('a Sign out button is still loose in the top bar');
  if (!open.focusInside) problems.push('focus did not move into the panel');
  if (!open.onScreen) problems.push('panel is not fully on screen');

  // The panel is a card: it must take the theme's surface, not stay white.
  const hex = open.surface;
  if (hex.startsWith('#')) {
    const n = parseInt(hex.slice(1), 16);
    const want = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    if (open.background !== want) problems.push(`background ${open.background} != --surface ${want}`);
  }

  await page.keyboard.press('Escape');
  await settle(350);
  if (!(await shut())) problems.push('Escape did not close it');
  const returned = await page.evaluate(
    () => document.activeElement === document.querySelector('button.avatar'),
  );
  if (!returned) problems.push('focus did not return to the trigger');

  await page.click('button.avatar');
  await settle(300);
  await page.mouse.click(600, 600);
  await settle(350);
  if (!(await shut())) problems.push('clicking outside did not close it');

  if (problems.length === 0) {
    pass(`console · ${theme}: user menu opens, shows identity + role + groups, closes cleanly`);
  } else {
    fail(`console · ${theme}: user menu`, problems);
  }
}

/**
 * The "Send to client" block inside the approvals panel.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO: click Send.
 * ---------------------------------------------------------------------------
 * Sending is armed - the first click only changes the label, and a second
 * confirms. Testing that properly means clicking once and asserting nothing
 * was sent, which is a fine test right up until the arming is BROKEN, at which
 * point the test itself emails a client. A UI check must not be able to perform
 * the one irreversible action in the system.
 *
 * So this asserts everything up to the click: the control exists, is labelled
 * un-armed, and the block is laid out and coloured correctly in both themes.
 * The arming behaviour is covered by scripts/verify-email-delivery.mjs, which
 * goes through the API where a mis-send is bounded by the recipient allowlist.
 *
 * The two faults this block actually shipped with were both invisible to
 * typecheck, the unit suite and the build, and both are checked here:
 *   - three stacked margins, giving ~56px of dead space above the heading
 *   - a divider using --surface-line, which is `transparent` in light mode,
 *     so the separation appeared as a gap with nothing in it
 */
async function checkDeliveryPanel(page, theme) {
  const found = await page.evaluate(() => {
    const block = document.querySelector('.delivery-block');
    if (block === null) return null;

    const head = block.querySelector('.sub-head');
    const cs = getComputedStyle(block);
    const buttons = [...block.querySelectorAll('.send-list button')];
    const pills = [...block.querySelectorAll('.pill')].map((p) => ({
      text: (p.textContent ?? '').trim(),
      cls: p.className,
      color: getComputedStyle(p).color,
      background: getComputedStyle(p).backgroundColor,
    }));

    return {
      hasHeading: head !== null && /send to client/i.test(head.textContent ?? ''),
      gapAboveHeading:
        head === null
          ? -1
          : Math.round(head.getBoundingClientRect().top - block.getBoundingClientRect().top),
      borderTopWidth: cs.borderTopWidth,
      borderTopColor: cs.borderTopColor,
      buttonLabels: buttons.map((b) => (b.textContent ?? '').trim()),
      anyArmed: buttons.some((b) => b.classList.contains('danger')),
      pills,
      historyTable: block.querySelector('table') !== null,
      overflowsRight: block.scrollWidth > block.clientWidth + 1,
    };
  });

  if (found === null) {
    // Not a failure: a lead with no proposals renders no delivery block at all.
    console.log(`         (no delivery block on this lead - nothing to check)`);
    return;
  }

  const problems = [];

  if (!found.hasHeading) problems.push('no "Send to client" heading');
  if (!found.historyTable) problems.push('no send-history table');

  // The regression that shipped: three stacked margins.
  if (found.gapAboveHeading < 0 || found.gapAboveHeading > 32) {
    problems.push(`${found.gapAboveHeading}px of space above the heading (expected <= 32)`);
  }

  // The other one: a divider that is invisible in light mode.
  if (found.borderTopWidth === '0px') {
    problems.push('no divider above the block');
  } else if (/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(found.borderTopColor)) {
    problems.push(`divider is transparent in ${theme} (${found.borderTopColor})`);
  }

  // Sending is irreversible; nothing may render pre-armed.
  if (found.anyArmed) problems.push('a Send button is already armed on load');
  for (const label of found.buttonLabels) {
    if (/\?$/.test(label)) problems.push(`a Send button renders in its confirming state: "${label}"`);
  }

  // A status pill that renders as unstyled text is how "Blocked" stops looking
  // like a distinct outcome and starts looking like a rendering bug.
  for (const p of found.pills) {
    if (/^(sent|blocked|failed)$/i.test(p.text)) {
      const transparentBg = /rgba\(0,\s*0,\s*0,\s*0\)/.test(p.background);
      if (transparentBg) problems.push(`the "${p.text}" pill has no background in ${theme}`);
      if (!/status-/.test(p.cls)) problems.push(`the "${p.text}" pill carries no status class`);
    }
  }

  if (found.overflowsRight) problems.push('the block scrolls sideways');

  if (problems.length === 0) {
    pass(
      `console \u00b7 ${theme}: delivery block (gap ${found.gapAboveHeading}px, divider visible, ` +
        `${found.buttonLabels.length} send control(s), none armed)`,
    );
  } else {
    fail(`console \u00b7 ${theme}: delivery block`, problems);
  }
}

/** The accent must survive the cascade — this is how the white-button bug hid. */
async function brandColourCheck(page, selectorDesc, label) {
  const res = await page.evaluate((desc) => {
    const want = getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim();
    const toRgb = (h) => {
      const n = parseInt(h.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const el = desc.text
      ? [...document.querySelectorAll(desc.sel)].find((b) => new RegExp(desc.text, 'i').test(b.textContent ?? ''))
      : document.querySelector(desc.sel);
    return { want: toRgb(want), got: el ? getComputedStyle(el).backgroundColor : 'MISSING' };
  }, selectorDesc);
  if (res.got === res.want) pass(`${label}: primary action is the accent colour`);
  else fail(`${label}: primary action is not the accent colour`, [JSON.stringify(res)]);
}

/* ═══════════════════════════════════════════════════════════════════════════ */

console.log('\n── static ────────────────────────────────────────────────');
await checkDevServerFresh(URL_TO_CHECK);
checkDarkBlocksAgree();

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

try {
  const bag = { errors: [] };
  const page = await browser.newPage();
  attachListeners(page, bag);

  await page.setViewport(VIEWPORTS[0]);
  await page.goto(URL_TO_CHECK, { waitUntil: 'networkidle2', timeout: 45_000 });
  await page.waitForSelector('.auth-shell', { timeout: 20_000 });

  /* ─────────────────────────── SIGN-IN, BOTH THEMES ──────────────────── */
  for (const theme of THEMES) {
    console.log(`\n── sign-in · ${theme} ──────────────────────────────────────`);
    await applyTheme(page, theme);
    await page.waitForSelector('.auth-card', { timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await settle(1200);

    const stamped = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (stamped === theme) pass(`sign-in · ${theme}: data-theme applied`);
    else fail(`sign-in · ${theme}: data-theme is "${stamped}"`);

    if (theme === 'light') {
      const fonts = await page.evaluate(FONT_PROBE);
      if (fonts.manrope && fonts.mono) pass('sign-in: Manrope and IBM Plex Mono loaded');
      else fail('sign-in: webfont fell back silently', [JSON.stringify(fonts)]);

      const panel = await page.evaluate(async () => {
        const el = document.querySelector('.auth-brand');
        if (!el) return { found: false };
        const m = getComputedStyle(el).backgroundImage.match(/url\("([^"]+)"\)/);
        if (!m) return { found: true, url: null };
        const ok = await new Promise((res) => {
          const img = new Image();
          img.onload = () => res(true);
          img.onerror = () => res(false);
          img.src = m[1];
        });
        return { found: true, url: m[1], ok };
      });
      if (panel.found && panel.url && panel.ok) pass('sign-in: brand panel image decoded');
      else fail('sign-in: brand panel image missing', [JSON.stringify(panel)]);
    }

    checkPainted(await paintedFonts(page, Object.keys(SIGNIN_FONTS)), SIGNIN_FONTS, `sign-in · ${theme}`);
    await brandColourCheck(page, { sel: 'button[type="submit"]' }, `sign-in · ${theme}`);

    for (const vp of VIEWPORTS) {
      await page.setViewport(vp);
      await settle(400);
      await runProbes(page, `sign-in · ${theme} @${vp.name}`);
      await shoot(page, `signin-${theme}-${vp.name}`);
    }
    await page.setViewport(VIEWPORTS[0]);
  }

  /* ─────────────────── the toggle itself, and persistence ────────────── */
  console.log('\n── theme toggle ──────────────────────────────────────────');
  await applyTheme(page, null);
  await page.waitForSelector('.theme-toggle', { timeout: 20_000 });
  await settle(600);
  const before = await page.evaluate(() => ({
    stamp: document.documentElement.getAttribute('data-theme'),
    ground: getComputedStyle(document.body).backgroundColor,
  }));
  await page.click('.theme-toggle');
  await settle(700);
  const after = await page.evaluate(() => ({
    stamp: document.documentElement.getAttribute('data-theme'),
    ground: getComputedStyle(document.body).backgroundColor,
    stored: localStorage.getItem('aeygis-console-theme'),
  }));
  if (before.ground !== after.ground && after.stamp !== null) {
    pass(`theme toggle: flips the ground (${before.ground} -> ${after.ground})`);
  } else {
    fail('theme toggle: nothing changed', [JSON.stringify({ before, after })]);
  }
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 20_000 });
  await settle(500);
  const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (persisted === after.stamp) pass('theme toggle: choice survives a reload');
  else fail('theme toggle: choice lost on reload', [`was ${after.stamp}, now ${persisted}`]);

  /* ─────────────────────── CONSOLE, BOTH THEMES ──────────────────────── */
  await applyTheme(page, 'light');
  await page.waitForSelector('input[name="username"]', { timeout: 20_000 });
  await page.type('input[name="username"]', who.username, { delay: 8 });
  await page.type('input[name="password"]', who.password, { delay: 8 });
  await page.click('button[type="submit"]');
  if (!(await waitForQueue(page, 'console'))) {
    /* THIS CHECK NEEDS DATA IN THE DEPLOYED BACKEND.
     *
     * Nearly every other local check is self-contained; this one signs into the
     * real console and measures real rows, so an empty Assessment table stops it
     * dead. That is easy to hit by accident, because `npm run cleanup:tests`
     * deletes the seeded demo leads and nothing connects the two in a reader's
     * head.
     *
     * Naming the remedy in the error is the whole point: "the queue is empty"
     * on its own sends you looking for a rendering bug that is not there. */
    throw new Error(
      'the console never loaded its queue.\n\n' +
        'If the failure above is "the queue is empty", the deployed Assessment table has no\n' +
        'records to render - most likely because `npm run cleanup:tests` removed the seeded\n' +
        'demo leads. This check measures real rows, so it needs them:\n\n' +
        '    npm run seed:demo     # writes 4 sample assessments  (AWS write - needs approval)\n\n' +
        'Anything else above is a genuine rendering or sign-in failure.',
    );
  }

  for (const theme of THEMES) {
    console.log(`\n── console · ${theme} ──────────────────────────────────────`);
    await applyTheme(page, theme);
    await waitForQueue(page, `console · ${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await settle(1500);

    if (theme === 'light') {
      const shell = await page.evaluate(() => ({
        topbar: !!document.querySelector('.topbar'),
        queue: document.querySelectorAll('.queue-item').length,
        chips: document.querySelectorAll('.filter-chips .chip').length,
        detail: !!document.querySelector('.detail-head'),
        sections: document.querySelectorAll('.section-nav button').length,
        panels: document.querySelectorAll('.detail-body .panel').length,
        saveBtn: [...document.querySelectorAll('.head-actions button')].some((b) =>
          /Save changes/i.test(b.textContent ?? ''),
        ),
        toggle: !!document.querySelector('.topbar .theme-toggle'),
      }));
      console.log(`         shell: ${JSON.stringify(shell)}`);
      if (shell.topbar && shell.detail && shell.sections === 7 && shell.panels >= 7 && shell.toggle) {
        pass('console: Porcelain shell rendered (topbar, toggle, hero, 7 sections, panels)');
      } else {
        fail('console: shell incomplete', [JSON.stringify(shell)]);
      }
      if (shell.saveBtn) pass('console: Save changes in the sticky header');
      else fail('console: Save changes missing from the header');
    }

    /* ── the lead-status picker ──────────────────────────────────────
       Purely client-side: selecting a value only touches the edit buffer.
       Nothing is written until Save changes, so this never mutates AWS. */
    const picker = await page.evaluate(async (statuses) => {
      const sel = document.querySelector('select.pill-select');
      if (sel === null) return { found: false };

      const rgb = (v) => {
        const n = parseInt(v.trim().slice(1), 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const tintFor = {
        new: '--blue-tint',
        needs_confirmation: '--amber-tint',
        in_review: '--violet-tint',
        proposed: '--accent-tint',
        closed: '--slate-tint',
      };
      const root = getComputedStyle(document.documentElement);

      // Two waits, for two different reasons:
      //   1. React's setState is asynchronous, so the class (and therefore
      //      the tint) is not updated in the same tick as the dispatch.
      //   2. .pill-select transitions background-color over 220ms, so even
      //      after React commits, getComputedStyle returns a colour part-way
      //      between the old tint and the new one.
      // Reading too early failed both ways: first the previous status, then
      // an interpolated colour that matched nothing.
      const settled = () =>
        new Promise((r) =>
          requestAnimationFrame(() => setTimeout(r, 380)),
        );

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      ).set;
      const choose = async (value) => {
        // React tracks the previous value on the node and skips the event if
        // it thinks nothing changed — the native setter is how you get past
        // that from outside React.
        nativeSetter.call(sel, value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await settled();
      };

      const before = sel.value;
      const mismatches = [];
      for (const status of statuses) {
        await choose(status);
        const cs = getComputedStyle(sel);
        const want = rgb(root.getPropertyValue(tintFor[status]));
        if (cs.backgroundColor !== want) {
          mismatches.push(`${status}: ${cs.backgroundColor} != ${want}`);
        }
        if (!sel.className.includes(`status-${status}`)) {
          mismatches.push(`${status}: class is "${sel.className}"`);
        }
      }

      // The marker only makes sense while the buffer differs from the record.
      const differing = statuses.find((x) => x !== before) ?? before;
      await choose(differing);
      const unsavedShown = document.querySelector('.pending-change') !== null;

      // Put it back, so nothing downstream sees a dirty buffer.
      await choose(before);
      const cleared = document.querySelector('.pending-change') === null;

      return {
        found: true,
        options: [...sel.options].map((o) => o.value),
        mismatches,
        unsavedShown,
        cleared,
        restored: sel.value === before,
      };
    }, [...STATUSES]);

    if (!picker.found) {
      fail(`console · ${theme}: status picker missing`);
    } else if (picker.mismatches.length > 0) {
      fail(`console · ${theme}: status picker tint wrong`, picker.mismatches);
    } else if (STATUSES.some((x) => !picker.options.includes(x))) {
      fail(`console · ${theme}: status picker options incomplete`, [picker.options.join(', ')]);
    } else if (!picker.unsavedShown) {
      fail(`console · ${theme}: changing status showed no "unsaved" marker`);
    } else if (!picker.cleared) {
      fail(`console · ${theme}: "unsaved" marker stuck after reverting the status`);
    } else if (!picker.restored) {
      fail(`console · ${theme}: status picker left the buffer dirty`);
    } else {
      pass(`console · ${theme}: status picker offers ${picker.options.length} states, each correctly tinted`);
    }

    await checkUserMenu(page, theme);

    await checkDeliveryPanel(page, theme);

    checkPainted(await paintedFonts(page, Object.keys(CONSOLE_FONTS)), CONSOLE_FONTS, `console · ${theme}`);
    await brandColourCheck(
      page,
      { sel: '.head-actions button', text: 'Save changes' },
      `console · ${theme}`,
    );

    // At rest the FIRST section is current. This caught a real bug: paired
    // side-by-side panels share a top edge, so the scroll-spy locked onto the
    // second one permanently.
    const current = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.section-nav button')].find(
        (x) => x.getAttribute('aria-current') === 'true',
      );
      return b ? (b.textContent ?? '').trim() : 'NONE';
    });
    if (/^Overview$/i.test(current)) pass(`console · ${theme}: Overview is current at rest`);
    else fail(`console · ${theme}: wrong section current at rest`, [current]);

    for (const vp of VIEWPORTS) {
      await page.setViewport(vp);
      await settle(500);
      await runProbes(page, `console · ${theme} @${vp.name}`);
      await shoot(page, `console-${theme}-${vp.name}`);
    }
    await page.setViewport(VIEWPORTS[0]);
    await settle(400);
  }

  /* ──────────────── behaviour: nav jumps, sticky, reduced motion ─────── */
  console.log('\n── behaviour ─────────────────────────────────────────────');
  await applyTheme(page, 'light');
  await page.waitForSelector('.section-nav button', { timeout: 40_000 });
  await settle(1200);

  const navIssues = [];
  const count = await page.evaluate(() => document.querySelectorAll('.section-nav button').length);
  for (let i = 0; i < count; i += 1) {
    const label = await page.evaluate((idx) => {
      const b = document.querySelectorAll('.section-nav button')[idx];
      b.click();
      return b.textContent;
    }, i);
    await settle(1100); // smooth scroll + the 900ms spy lock
    const res = await page.evaluate((idx) => {
      const ids = ['overview', 'scope', 'pricing', 'discovery', 'proposal', 'approvals', 'notes'];
      const el = document.getElementById(ids[idx]);
      const head = document.querySelector('.detail-head');
      const pane = document.querySelector('.detail-pane');
      if (!el || !head || !pane) return { ok: false, why: 'missing node' };
      const t = (el.querySelector('h2') ?? el).getBoundingClientRect();
      const hr = head.getBoundingClientRect();
      const pr = pane.getBoundingClientRect();
      // At the very bottom the last sections cannot reach the top — physics,
      // not a bug. Only flag a heading hidden UNDER the header while the pane
      // still has room to scroll.
      const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
      const covered = t.top < hr.bottom - 1 && t.bottom > pr.top;
      const isCurrent =
        document.querySelectorAll('.section-nav button')[idx].getAttribute('aria-current') === 'true';
      return { ok: atEnd || !covered, isCurrent, top: Math.round(t.top), headBottom: Math.round(hr.bottom) };
    }, i);
    if (!res.ok) navIssues.push(`"${label?.trim()}" heading at ${res.top} under header bottom ${res.headBottom}`);
    if (res.isCurrent === false) navIssues.push(`"${label?.trim()}" clicked but not marked current`);
  }
  if (navIssues.length === 0) pass('console: every section jump lands clear of the sticky header');
  else fail('console: section jumps land under the header', navIssues);

  await page.evaluate(() => {
    document.querySelector('.detail-pane').scrollTop = 900;
  });
  await settle(350);
  const sticky = await page.evaluate(() => {
    const head = document.querySelector('.detail-head');
    const pane = document.querySelector('.detail-pane');
    return {
      headTop: Math.round(head.getBoundingClientRect().top),
      paneTop: Math.round(pane.getBoundingClientRect().top),
      scrolled: pane.scrollTop,
    };
  });
  if (sticky.scrolled > 0 && Math.abs(sticky.headTop - sticky.paneTop) <= 2) {
    pass('console: detail header stays pinned while the pane scrolls');
  } else {
    fail('console: detail header did not stick', [JSON.stringify(sticky)]);
  }
  await shoot(page, 'console-scrolled');

  /* The classic bug: an entrance animation was the only thing setting opacity,
     so cancelling animations left the content permanently invisible. */
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const theme of THEMES) {
    await applyTheme(page, theme);
    await page.waitForSelector('.queue-item', { timeout: 40_000 });
    await settle(900);
    const rm = await page.evaluate(() =>
      ['.topbar', '.queue-item', '.detail-head', '.detail-body .panel', '.filter-chips .chip', '.theme-toggle']
        .map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return `${sel}: MISSING`;
          const o = parseFloat(getComputedStyle(el).opacity);
          const r = el.getBoundingClientRect();
          return o >= 0.99 && r.width > 0 && r.height > 0 ? null : `${sel}: opacity=${o} ${r.width}x${r.height}`;
        })
        .filter(Boolean),
    );
    if (rm.length === 0) pass(`console · ${theme}: visible under prefers-reduced-motion`);
    else fail(`console · ${theme}: invisible under prefers-reduced-motion`, rm);
    await shoot(page, `console-${theme}-reduced-motion`);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* Errors last, so the layout report is not buried. */
  if (bag.errors.length === 0) pass('no console errors, failed requests or 4xx/5xx');
  else fail(`${bag.errors.length} runtime error(s)`, bag.errors);
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`screenshots: ${SHOT_DIR}`);
process.exit(failures === 0 ? 0 : 1);
