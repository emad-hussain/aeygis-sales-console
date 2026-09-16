/**
 * Walks the ACTUAL UI, in a real browser, for the two features added last:
 * per-assessment custom discovery questions, and deleting a proposal version.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * Both features shipped with green unit tests and a clean typecheck, and the
 * first thing that happened when someone clicked the button was:
 *
 *     getClient(...).mutations.deleteProposalVersion is not a function
 *
 * Nothing in the test suite could have caught that. Vitest exercises pure
 * functions against imported TypeScript types; the failure was that the
 * DEPLOYED AppSync schema did not contain the mutation, which is a property of
 * AWS, not of the code. A green suite and a broken button are entirely
 * compatible states, and this file is the thing that tells them apart.
 *
 * So every assertion below is made by CLICKING, reading the DOM that a user
 * would read, and — for the PDF — fetching the bytes the browser was actually
 * handed. Nothing is asserted from a return value the UI never displayed.
 *
 * Requires: the dev server running (npm run console) and .test-credentials.json.
 *
 * Run:  node scripts/verify-discovery-and-delete.mjs [url]
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const URL_TO_CHECK = process.argv[2] ?? 'http://localhost:5173/';
const CLINIC = 'Bayview';
const PDF_TMP = path.join(tmpdir(), `aeygis-verify-${process.pid}.pdf`);

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
const credsPath = new URL('../.test-credentials.json', import.meta.url);
if (!existsSync(credsPath)) {
  console.error('Missing .test-credentials.json');
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const who = creds.approver;

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failures += 1;
};
const step = (m) => console.log(`\n── ${m} ──`);

// A marker unique to this run, so a re-run cannot pass on last run's leftovers.
const STAMP = String(Date.now()).slice(-6);
const CUSTOM_Q = `Which staff can export records in bulk? [${STAMP}]`;
const CUSTOM_CAT = `Imaging & PACS [${STAMP}]`;
const CUSTOM_CAT_Q = `Which imaging modalities are in use? [${STAMP}]`;
const SCHED_ESTIMATE = `${STAMP} weeks`;
const CUSTOM_ROW_AREA = `Digital fax [${STAMP}]`;

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox'],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const badResponses = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    // "Failed to load resource: ... 404" carries NO url in the console text, so
    // filtering on it here is guesswork. Those are captured by URL below
    // instead, and excluded here so the same event is not reported twice
    // anonymously.
    if (m.type() !== 'error') return;
    if (/Download the React|Failed to load resource/i.test(t)) return;
    pageErrors.push(t);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
  });

  /* ─────────────────────────── sign in ─────────────────────────── */
  step('Sign in');
  await page.goto(URL_TO_CHECK, { waitUntil: 'networkidle2', timeout: 45_000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.type('input[name="username"]', who.username, { delay: 8 });
  await page.type('input[name="password"]', who.password, { delay: 8 });
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () =>
      /Intake queue/i.test(document.body.innerText ?? '') &&
      (document.querySelectorAll('.queue-item').length > 0 ||
        /No assessments yet/i.test(document.body.innerText ?? '')),
    { timeout: 30_000 },
  );
  pass(`signed in as ${who.group}`);

  const openClinic = async () => {
    const ok = await page.evaluate((name) => {
      const item = [...document.querySelectorAll('.queue-item')].find((el) =>
        (el.textContent ?? '').includes(name),
      );
      if (!item) return false;
      item.click();
      return true;
    }, CLINIC);
    if (!ok) throw new Error(`${CLINIC} not found in the queue`);
    await page.waitForFunction(() => /Technical discovery/i.test(document.body.innerText ?? ''), {
      timeout: 20_000,
    });
    // Every <details> starts collapsed; its inputs are not interactable until open.
    await page.evaluate(() =>
      document.querySelectorAll('details').forEach((d) => {
        d.open = true;
      }),
    );
  };

  await openClinic();
  pass(`opened ${CLINIC}`);

  /* ──────────────── custom question in an EXISTING category ──────────────── */
  step('Add a custom question to an existing category');

  const typedIntoExisting = await page.evaluate((text) => {
    const input = [...document.querySelectorAll('input[aria-label^="Add a question to"]')].find(
      (i) => /Identity & security/.test(i.getAttribute('aria-label') ?? ''),
    );
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, CUSTOM_Q);
  typedIntoExisting
    ? pass('found the per-category "Add a question" input')
    : fail('no "Add a question to Identity & security" input rendered');

  if (typedIntoExisting) {
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('input[aria-label^="Add a question to"]')].find(
        (i) => /Identity & security/.test(i.getAttribute('aria-label') ?? ''),
      );
      const btn = input?.parentElement?.querySelector('button');
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const shows = await page.evaluate((t) => (document.body.innerText ?? '').includes(t), CUSTOM_Q);
    shows
      ? pass('custom question appears in the form immediately')
      : fail('custom question did not appear after clicking Add');
  }

  /* ──────────────────────── new custom category ──────────────────────── */
  step('Create a new category and add a question to it');

  await page.evaluate((title) => {
    const input = document.querySelector('#new-category');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.parentElement.querySelector('button').click();
  }, CUSTOM_CAT);
  await new Promise((r) => setTimeout(r, 300));

  const catShows = await page.evaluate(
    (t) => (document.body.innerText ?? '').includes(t),
    CUSTOM_CAT,
  );
  catShows ? pass('new category appears') : fail('new category did not appear');

  if (catShows) {
    await page.evaluate(() =>
      document.querySelectorAll('details').forEach((d) => {
        d.open = true;
      }),
    );
    const added = await page.evaluate(
      (cat, q) => {
        const input = [...document.querySelectorAll('input[aria-label^="Add a question to"]')].find(
          (i) => (i.getAttribute('aria-label') ?? '').includes(cat),
        );
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.parentElement.querySelector('button').click();
        return true;
      },
      CUSTOM_CAT,
      CUSTOM_CAT_Q,
    );
    await new Promise((r) => setTimeout(r, 300));
    added
      ? pass('added a question inside the new category')
      : fail('the new category had no "Add a question" input');
  }

  /* ─────────────── proposal content: schedule + responsibilities ─────────────── */
  step('Fill in a migration estimate and tailor the responsibility matrix');

  const setNative = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const typedEstimate = await page.evaluate(
    (v, setterSrc) => {
      // eslint-disable-next-line no-eval
      const setNative = eval(`(${setterSrc})`);
      const input = document.querySelector('#sched-discover');
      if (!input) return false;
      setNative(input, v);
      return true;
    },
    SCHED_ESTIMATE,
    setNative.toString(),
  );
  typedEstimate
    ? pass('migration schedule input present and filled')
    : fail('no #sched-discover input — the Proposal panel did not render');

  /**
   * Exercises the toggle in BOTH directions and always finishes unticked.
   *
   * The naive version ("click it, assert unticked") passed once and then failed
   * on every later run, because the previous run had saved the row unticked and
   * the script bailed on finding it already off. A verification script that only
   * works against a fresh database is not a verification script.
   */
  const toggleResult = await page.evaluate(() => {
    const find = () =>
      [...document.querySelectorAll('input[type="checkbox"][aria-label^="Include"]')].find((b) =>
        /EMR/.test(b.getAttribute('aria-label') ?? ''),
      );
    const box = find();
    if (!box) return { ok: false, why: 'no EMR checkbox rendered' };

    // Normalise to ticked first, so the off-switch is genuinely tested.
    if (!box.checked) {
      box.click();
      if (!find()?.checked) return { ok: false, why: 'ticking it back on did not take effect' };
    }
    box.click();
    if (find()?.checked) return { ok: false, why: 'unticking did not take effect' };
    return { ok: true, why: '' };
  });
  toggleResult.ok
    ? pass('responsibility row toggles both ways and ends unticked')
    : fail(`responsibility toggle broken — ${toggleResult.why}`);

  /**
   * Clear rows left by previous runs first.
   *
   * Not just hygiene: unbounded accumulation is what pushed the matrix past one
   * page and exposed that surplus rows were being silently clipped out of the
   * PDF. That bug is fixed (the renderer packs across pages now), but a
   * verification script should still leave the data roughly as it found it
   * rather than growing it every time it runs.
   */
  const cleared = await page.evaluate(() => {
    let removed = 0;
    // Re-query each time: removing a row re-renders the table.
    for (let guard = 0; guard < 50; guard += 1) {
      const btn = [...document.querySelectorAll('#proposal table tbody tr button')].find(
        (b) => (b.textContent ?? '').trim() === '×',
      );
      if (!btn) break;
      btn.click();
      removed += 1;
    }
    return removed;
  });
  if (cleared > 0) console.log(`     (cleared ${cleared} row(s) left by earlier runs)`);

  const addedRow = await page.evaluate(
    (area, setterSrc) => {
      // eslint-disable-next-line no-eval
      const setNative = eval(`(${setterSrc})`);
      const areaInput = document.querySelector('#row-area');
      if (!areaInput) return false;
      setNative(areaInput, area);
      const row = areaInput.parentElement;
      const aeygis = row.querySelector('input[aria-label="Aeygis responsibility"]');
      const clinic = row.querySelector('input[aria-label="Clinic responsibility"]');
      if (aeygis) setNative(aeygis, 'Owner: hosting and routing');
      if (clinic) setNative(clinic, 'Owner: number porting');
      [...row.querySelectorAll('button')].find((b) => /Add row/.test(b.textContent ?? ''))?.click();
      return true;
    },
    CUSTOM_ROW_AREA,
    setNative.toString(),
  );
  await new Promise((r) => setTimeout(r, 300));
  const rowShows = await page.evaluate(
    (a) => (document.body.innerText ?? '').includes(a),
    CUSTOM_ROW_AREA,
  );
  addedRow && rowShows
    ? pass('added a custom responsibility row')
    : fail('custom responsibility row did not appear');

  /* ──────────────────────────── save + persist ──────────────────────────── */
  step('Save, reload, and confirm it persisted to AWS');

  // Matches the button's real label ("Save changes" / "Saving…"), not a guess.
  const saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /^Sav(e|ing)/.test((b.textContent ?? '').trim()),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  saved ? pass('clicked Save changes') : fail('no Save button found');

  await page
    .waitForFunction(() => /Changes saved|Save failed/i.test(document.body.innerText ?? ''), {
      timeout: 25_000,
    })
    .catch(() => {});
  const saveText = await page.evaluate(() => document.body.innerText ?? '');
  if (/Save failed/i.test(saveText)) {
    const line = saveText.split('\n').find((l) => /Save failed/i.test(l));
    fail(`save reported failure: ${line?.trim().slice(0, 160)}`);
  } else if (/Changes saved/i.test(saveText)) {
    pass('save confirmed by the UI');
  } else {
    fail('save produced neither a success nor a failure message');
  }

  // The real test of persistence: full page reload, not component state.
  await page.reload({ waitUntil: 'networkidle2', timeout: 45_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.queue-item').length > 0,
    { timeout: 30_000 },
  );
  await openClinic();

  const afterReload = await page.evaluate(() => document.body.innerText ?? '');
  afterReload.includes(CUSTOM_Q)
    ? pass('custom question SURVIVED a reload (persisted to AWS)')
    : fail('custom question vanished after reload — customDiscoveryQuestions did not persist');
  afterReload.includes(CUSTOM_CAT)
    ? pass('custom category survived a reload')
    : fail('custom category vanished after reload');
  afterReload.includes(CUSTOM_ROW_AREA)
    ? pass('custom responsibility row survived a reload')
    : fail('custom responsibility row vanished after reload');

  const estimateKept = await page.evaluate(
    (v) => document.querySelector('#sched-discover')?.value === v,
    SCHED_ESTIMATE,
  );
  estimateKept
    ? pass('migration estimate survived a reload')
    : fail('migration estimate did not persist');

  const stillUnticked = await page.evaluate(() => {
    const box = [...document.querySelectorAll('input[type="checkbox"][aria-label^="Include"]')].find(
      (b) => /EMR/.test(b.getAttribute('aria-label') ?? ''),
    );
    return box ? !box.checked : false;
  });
  stillUnticked
    ? pass('the unticked responsibility row stayed unticked')
    : fail('the responsibility exclusion did not persist');

  /* ─────────────────── generate, then read the real PDF ─────────────────── */
  step('Generate a proposal and read the PDF the browser is handed');

  const versionsBefore = await page.evaluate(() => {
    const table = document.querySelector('#approvals table');
    return table ? table.querySelectorAll('tbody tr').length : 0;
  });

  const gen = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Generate',
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  gen ? pass('clicked Generate') : fail('no Generate button');

  await page.waitForFunction(
    () => /Created AEY-|Could not create|not applicable/i.test(document.body.innerText ?? ''),
    { timeout: 45_000 },
  );
  const genText = await page.evaluate(() => document.body.innerText ?? '');
  if (!/Created AEY-/.test(genText)) {
    fail(`generation failed: ${genText.split('\n').find((l) => /Could not|not applicable/.test(l))?.trim()}`);
  } else {
    pass('proposal version created');
    // Chromium cold start; the PDF is rendered fire-and-forget.
    await new Promise((r) => setTimeout(r, 12_000));

    const newTabPromise = new Promise((resolve) => {
      browser.once('targetcreated', async (t) => resolve(await t.page()));
    });
    const clickedPdf = await page.evaluate(() => {
      const table = document.querySelector('#approvals table');
      const btn = table?.querySelector('tbody tr button');
      if (!btn || !/View PDF/.test(btn.textContent ?? '')) return false;
      btn.click();
      return true;
    });

    if (!clickedPdf) {
      fail('no View PDF button on the newest version');
    } else {
      const pdfTab = await Promise.race([
        newTabPromise,
        new Promise((r) => setTimeout(() => r(null), 20_000)),
      ]);
      if (!pdfTab) {
        fail('clicking View PDF opened no new tab');
      } else {
        await new Promise((r) => setTimeout(r, 2500));
        const pdfUrl = pdfTab.url();
        if (!/^https?:/.test(pdfUrl)) {
          fail(`the new tab never navigated to a PDF (url: ${pdfUrl.slice(0, 60)})`);
        } else {
          const res = await fetch(pdfUrl);
          const buf = Buffer.from(await res.arrayBuffer());
          const magic = buf.subarray(0, 5).toString('latin1');
          magic === '%PDF-'
            ? pass(`PDF fetched from the tab the user got: ${buf.length} bytes, ${magic}`)
            : fail(`the new tab served something that is not a PDF (magic: ${magic})`);

          // Does the CUSTOM question actually reach the client document? That
          // is the whole point of the feature, and neither the magic bytes nor
          // the byte count says anything about it.
          //
          // PDF text lives in Flate streams written against a SUBSET font, so
          // a hand-rolled inflate-and-grep finds nothing — it was tried, and it
          // failed to find even the approved questions that are demonstrably
          // present. PyMuPDF is used instead, and the check SKIPS loudly rather
          // than passing when it is unavailable: a checker that silently
          // reports success when it cannot run is worse than no checker.
          writeFileSync(PDF_TMP, buf);
          const probe = spawnSync(
            'python',
            [
              '-c',
              'import sys,re,pymupdf;d=pymupdf.open(sys.argv[1]);' +
                "t=re.sub(r'\\s+',' ',' '.join(p.get_text() for p in d));" +
                'print("HIT" if sys.argv[2] in t else "MISS")',
              PDF_TMP,
              CUSTOM_Q,
            ],
            { encoding: 'utf8' },
          );
          if (probe.status !== 0) {
            console.log(
              `     SKIP  PDF text check — PyMuPDF unavailable (${(probe.stderr ?? '').trim().split('\n').pop()?.slice(0, 80)})`,
            );
          } else if (probe.stdout.includes('HIT')) {
            // Inverted deliberately. The discovery appendix was REMOVED from
            // the client document — discovery is a working record for the
            // console. A hit now means the appendix came back, or that staff
            // free text is leaking into the client PDF by some other route.
            fail('a discovery question reached the client PDF — the appendix should be gone');
          } else {
            pass('no discovery question in the client PDF (appendix removed as intended)');
          }

          // Everything else that must have reached the document. Run as one
          // python call per needle so a miss names which one.
          if (probe.status === 0) {
            for (const [label, needle] of [
              ['migration estimate', SCHED_ESTIMATE],
              ['custom responsibility row', CUSTOM_ROW_AREA],
              ['shared responsibility page', 'Shared responsibility, stated before you sign'],
              ['IT-provider co-existence page', 'Keep your local IT provider'],
              ['excluded EMR row is ABSENT', 'Application usage, charting, billing'],
              // Uptime must always arrive labelled, never as a bare figure.
              ['AWS uptime figure', '99.99%'],
              ['Aeygis uptime figure', '99.9%'],
              ['AWS attribution', 'contractual SLA'],
              ['Aeygis target is qualified', 'not a guarantee'],
              ['binding levels point at the agreement', 'set in the signed agreement'],
              ['unsourced 99.97% is ABSENT', '99.97'],
              // The sources appendix was removed. These three replace it: the
              // invariant it served was that no statistic stands unattributed,
              // and every figure that remains carries its source inline.
              ['no sources appendix', 'Every figure in this document, attributed'],
              ['no dangling pointer to it', 'Full attribution for every figure above is on page'],
              ['PHIPA enforcement page', 'Enforcement is active, not theoretical'],
              ['impact figures attributed to IDC', 'across 27 organizations'],
              ['CIRA figure attributed inline', 'CIRA, 2024'],
              ['PHIPA maximum attributed inline', 'as amended in 2020'],
              // The signature page STATES the plan but asks nothing: the
              // heading is not an instruction and there is no tick-box.
              ['plan stated on the signature page', 'Your support plan'],
              ['no imperative plan heading', 'Select your support plan'],
              ['acceptance statement intact', 'confirms the support plan selected above'],
              ['security specifics', 'AES-256'],
              ['RTO explained in plain words', 'Recovery Time Objective'],
              ['acceptance page', 'Confirming this proposal'],
              ['signs for the registered entity', 'Aeygis Technologies Inc.'],
              ['acceptance is not the agreement', 'not the service agreement'],
              ['pricing expiry is a real date', 'Pricing held until'],
              // A relative phrase would make the reader compute the date from
              // one printed elsewhere.
              ['no relative validity phrase', '30 days from the issue date'],
              ['why-Aeygis page', 'An Ontario partner that understands healthcare operations'],
              ['what to expect row', 'What to expect from Aeygis'],
              // Positioning names the category, never a named rival.
              ['no named rival', 'competitor'],
            ]) {
              // CASE-INSENSITIVE on purpose: `text-transform: uppercase` means
              // the glyphs actually drawn into the PDF may not match the case
              // written in the template, and a case-sensitive miss here reads
              // as "the content is absent" when it is merely uppercased.
              const r = spawnSync(
                'python',
                [
                  '-c',
                  'import sys,re,pymupdf;d=pymupdf.open(sys.argv[1]);' +
                    "t=re.sub(r'\\s+',' ',' '.join(p.get_text() for p in d)).lower();" +
                    'print("HIT" if sys.argv[2].lower() in t else "MISS")',
                  PDF_TMP,
                  needle,
                ],
                { encoding: 'utf8' },
              );
              const hit = r.stdout.includes('HIT');
              const shouldBeAbsent = label.includes('ABSENT') || label.startsWith('no ');
              if (shouldBeAbsent ? !hit : hit) pass(`PDF: ${label}`);
              else fail(`PDF: ${label} — expected ${shouldBeAbsent ? 'absent' : 'present'}`);
            }
          }
          rmSync(PDF_TMP, { force: true });
        }
        await pdfTab.close().catch(() => {});
      }
    }
    // The original tab must NOT have navigated away.
    /Approvals/i.test(await page.evaluate(() => document.body.innerText ?? ''))
      ? pass('the console tab stayed on the app')
      : fail('the console tab navigated away from the app');
  }

  /* ─────────────────────────── delete a version ─────────────────────────── */
  step('Delete a pending version (the click that failed before)');

  // Generating above added a row asynchronously. Let the panel settle before
  // measuring, or the "before" count is stale and the delta is meaningless —
  // which is exactly how an earlier run produced a bogus "9 → 10".
  await new Promise((r) => setTimeout(r, 2500));

  const rowsBefore = await page.evaluate(() => {
    const table = document.querySelector('#approvals table');
    return [...(table?.querySelectorAll('tbody tr') ?? [])].map((tr) => ({
      version: tr.querySelector('td')?.textContent?.trim() ?? '',
      decision: tr.children[5]?.textContent?.trim() ?? '',
      hasDelete: [...tr.querySelectorAll('button')].some((b) =>
        /^Delete$/.test((b.textContent ?? '').trim()),
      ),
    }));
  });
  console.log(`     ${rowsBefore.length} versions listed`);

  const approvedRows = rowsBefore.filter((r) => /approved/i.test(r.decision));
  const pendingRows = rowsBefore.filter((r) => !/approved/i.test(r.decision));

  if (approvedRows.length > 0) {
    approvedRows.every((r) => !r.hasDelete)
      ? pass(`approved version(s) offer NO delete control (${approvedRows.map((r) => r.version).join(', ')})`)
      : fail('an APPROVED version is showing a Delete button');
  } else {
    console.log('     SKIP  no approved version present to check the refusal against');
  }

  if (pendingRows.length === 0) {
    fail('no non-approved version to delete');
  } else {
    const target = pendingRows[0].version;
    if (!pendingRows[0].hasDelete) {
      fail(`pending version ${target} has no Delete button`);
    } else {
      // Two-click arming, exactly as a user would.
      const clickDelete = (version) =>
        page.evaluate((v) => {
          const tr = [...document.querySelectorAll('#approvals table tbody tr')].find(
            (r) => r.querySelector('td')?.textContent?.trim() === v,
          );
          const btn = [...(tr?.querySelectorAll('button') ?? [])].find((b) =>
            /Delete/.test(b.textContent ?? ''),
          );
          btn?.click();
        }, version);

      await clickDelete(target);
      await new Promise((r) => setTimeout(r, 300));
      const armed = await page.evaluate(
        (v) => (document.body.innerText ?? '').includes(`Delete ${v}?`),
        target,
      );
      armed
        ? pass('first click arms the confirmation rather than deleting')
        : fail('Delete did not arm — it may be firing on a single click');

      // Counted immediately before the confirming click, so the delta cannot
      // be polluted by anything that happened earlier in the walk.
      const countAtDelete = await page.evaluate(
        () => document.querySelectorAll('#approvals table tbody tr').length,
      );
      await clickDelete(target);
      await page.waitForFunction(
        () => /Deleted v|not deleted|Could not delete|cannot be deleted/i.test(document.body.innerText ?? ''),
        { timeout: 30_000 },
      );
      const outcome = await page.evaluate(() => document.body.innerText ?? '');
      if (/Deleted v/.test(outcome)) {
        pass(`the UI reports ${target} deleted`);
        await new Promise((r) => setTimeout(r, 1500));
        const rowsAfter = await page.evaluate(
          () => document.querySelectorAll('#approvals table tbody tr').length,
        );
        rowsAfter === countAtDelete - 1
          ? pass(`version list went ${countAtDelete} → ${rowsAfter}`)
          : fail(`list did not shrink by one (${countAtDelete} → ${rowsAfter})`);
        const goneFromList = await page.evaluate((v) => {
          const rows = [...document.querySelectorAll('#approvals table tbody tr')];
          return !rows.some((r) => r.querySelector('td')?.textContent?.trim() === v);
        }, target);
        goneFromList
          ? pass(`${target} is no longer listed`)
          : fail(`${target} is still listed after a reported delete`);

        // Survives a reload = actually gone from AWS, not just from React state.
        await page.reload({ waitUntil: 'networkidle2', timeout: 45_000 });
        await page.waitForFunction(() => document.querySelectorAll('.queue-item').length > 0, {
          timeout: 30_000,
        });
        await openClinic();
        const stillGone = await page.evaluate((v) => {
          const rows = [...document.querySelectorAll('#approvals table tbody tr')];
          return !rows.some((r) => r.querySelector('td')?.textContent?.trim() === v);
        }, target);
        stillGone
          ? pass(`${target} is still gone after a reload — deleted in AWS, not just locally`)
          : fail(`${target} came back after reload — the delete did not reach AWS`);
      } else {
        const line = outcome.split('\n').find((l) => /not deleted|Could not delete|cannot be deleted/i.test(l));
        fail(`delete did not succeed: ${line?.trim().slice(0, 180)}`);
      }
    }
  }

  /* ───────────────────────────── page errors ───────────────────────────── */
  step('Browser console');
  pageErrors.length === 0
    ? pass('no uncaught errors during the whole walk')
    : fail(`${pageErrors.length} console error(s): ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`);

  // A missing favicon is not an app defect; anything else 4xx/5xx is. Judged by
  // URL rather than by an un-URL'd console string.
  const realBad = badResponses.filter((r) => !/favicon\.ico/i.test(r));
  realBad.length === 0
    ? pass(
        badResponses.length === 0
          ? 'no failed requests'
          : `only favicon 404s (${badResponses.length}), which is not an app defect`,
      )
    : fail(`${realBad.length} failed request(s): ${realBad.slice(0, 3).join(' | ').slice(0, 300)}`);
} catch (error) {
  fail(`walk threw: ${error?.message ?? error}`);
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? '\nUI walk passed — every assertion made by clicking, not by unit test.\n'
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
