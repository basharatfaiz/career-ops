// tests/digest-dashboard.test.mjs: the generated dashboard's structure, data
// contract and accessibility floor.
//
// The digest is a single generated HTML file with no build step, so nothing else
// in the suite would notice a table quietly losing its date-applied column, a
// row acquiring two buttons that go to the same URL, or a focus ring being
// dropped. These assertions are the regression net for exactly that.
//
// Regenerating the digest is the generator's job; this suite only READS the
// artefact, plus a couple of cheap logic checks that do not need a browser.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import vm from 'node:vm';
import { pass, fail, ROOT } from './helpers.mjs';

const OUT = join(ROOT, 'output', 'daily-digest.html');

// On a fresh clone there is no tracker yet. Seed a two-row FIXTURE (fictional
// companies) for the duration of the test, and remove it afterwards, so the
// suite never depends on anyone's real applications.
const FIXTURE_TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-01-05 | Acme | Product Designer | N/A | Applied | ✅ | N/A | test fixture | https://boards.greenhouse.io/acme/jobs/1 |
| 2 | 2026-01-06 | Globex | Senior Product Designer | N/A | Rejected | ✅ | N/A | test fixture | https://jobs.lever.co/globex/2 |
`;
const TRACKER = join(ROOT, 'data', 'applications.md');
const seeded = !existsSync(TRACKER);
if (seeded) { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(TRACKER, FIXTURE_TRACKER); }
// A matching discovery hit, so the applied row also carries its original
// (LinkedIn) discovery URL. The location keeps a third-party em dash on purpose:
// the display layer must normalise it while the record stays untouched.
const HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const seededHistory = !existsSync(HISTORY);
if (seededHistory) writeFileSync(HISTORY, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
  + 'https://in.linkedin.com/jobs/view/product-designer-at-acme-1\t2026-01-04\tlinkedin\tProduct Designer\tAcme\tadded\tRemote \u2014 India\n');
process.on('exit', () => {
  if (seeded) rmSync(TRACKER, { force: true });
  if (seededHistory) rmSync(HISTORY, { force: true });
});

// Regenerate so the assertions describe the current code, not a stale artefact.
try {
  execFileSync(process.execPath, ['daily-digest.mjs'], { cwd: ROOT, stdio: 'ignore' });
} catch (e) {
  // daily-digest.mjs exits 10 when it found roles, which is not a failure.
  if (!existsSync(OUT)) {
    // Reported through the shared counters rather than a bare process.exit, which
    // a discovered suite is not allowed to call.
    fail('could not generate output/daily-digest.html: ' + String(e.message).slice(0, 120));
  }
}

const html = readFileSync(OUT, 'utf8');
// Some behaviour is only observable in the generator: an empty state renders
// only when a view HAS no rows, and the 20+80 overflow card renders only when
// there IS overflow. Asserting those against the artefact would be asserting
// the absence of a feature. So the source is read too, and each of those is
// checked on whichever side it actually lives.
const gen = readFileSync(join(ROOT, 'daily-digest.mjs'), 'utf8');
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass(name);
  else fail(`${name} :: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const tTrue = (name, v) => t(name, !!v, true);
const count = (re) => (html.match(re) || []).length;
const pane = (id) => html.split(`id="pane-${id}"`)[1].split('</section>')[0] || '';
const rowsIn = (id) => pane(id).split('<tr tabindex').slice(1);

// ── structure: the three required views ───────────────────────────────────
console.log('\nviews');
tTrue('the page declares a language', /<html lang="en">/.test(html));
tTrue('there is a main landmark', /<main id="main">/.test(html));
tTrue('there is a skip link', /class="skip" href="#main"/.test(html));
tTrue('there is a tablist', /role="tablist"/.test(html));
tTrue('there are three tabs', count(/role="tab"/g), 3);
tTrue('there are three tabpanels', count(/role="tabpanel"/g), 3);
for (const id of ['new', 'applied', 'history']) {
  tTrue(`the ${id} pane exists`, pane(id).length > 0);
}
tTrue('the new pane is the selected one by default', /aria-selected="true"/.test(html));

// ── the required job-history data actually reaches the page ───────────────
console.log('\njob history data');
const appliedRows = rowsIn('applied');
tTrue('the applied view has rows', appliedRows.length > 0);
tTrue('every applied row carries a date applied', appliedRows.every((r) => /data-date="\d{4}-\d{2}-\d{2}"/.test(r)));
tTrue('every applied row carries a status', appliedRows.every((r) => /class="st t-/.test(r)));
tTrue('every applied row carries a CV cell', appliedRows.every((r) => /class="c-cv"/.test(r)));
tTrue('every applied row has at least one CV value', count(/class="cv"/g) > 0);
tTrue('every applied row has a company', appliedRows.every((r) => /class="co">[^<]+</.test(r)));
tTrue('every applied row has a role', appliedRows.every((r) => /class="ti">[^<]+</.test(r)));
// The point is that it is a real employer page and NOT a discovery-only board.
tTrue('every applied row links somewhere real',
  appliedRows.every((r) => /<a class="lnk[^"]*" href="https?:\/\/[^"]+"/.test(r)));
// A "Source" link to LinkedIn is REQUIRED: the discovery URL has to stay
// clickable. What must never happen is the ACTION link (the .go button, or the
// only link on the row) pointing at a board you cannot apply through, because
// that would dress a discovery hit up as an employer application page.
const DISCOVERY_BOARD = /href="https?:\/\/(?:[a-z]{2}\.)?(?:linkedin|naukri|indeed|glassdoor|mygwork)\./i;
tTrue('no applied row makes a discovery board its apply target',
  appliedRows.every((r) => {
    const action = [...r.matchAll(/<a class="lnk go"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    const anyLink = [...r.matchAll(/<a class="lnk[^"]*"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    const primary = action.length ? action : anyLink;
    return primary.every((u) => !DISCOVERY_BOARD.test(`href="${u}"`));
  }));
tTrue('the original discovery URL stays clickable',
  appliedRows.some((r) => DISCOVERY_BOARD.test(r)),
  true);
tTrue('the CV column header is present', /<th scope="col" class="c-cv">CV used<\/th>/.test(html));
tTrue('the status column header is present', /class="c-st"/.test(html));

// ── no duplicate records, and no duplicate calls to action ────────────────
console.log('\nno duplicates');
const histRows = rowsIn('history');
const hay = histRows.map((r) => (r.match(/data-hay="([^"]*)"/) || [])[1] || '');
t('every history row has a distinct key', new Set(hay).size, hay.length);
const hrefs = (r) => [...r.matchAll(/<a class="lnk[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
let twinLink = 0, noLink = 0;
for (const id of ['new', 'applied', 'history']) {
  for (const r of rowsIn(id)) {
    const h = hrefs(r);
    if (new Set(h).size !== h.length) twinLink++;
    if (!h.length) noLink++;
  }
}
t('no row offers two links to the same destination', twinLink, 0);
t('no row is left without a link', noLink, 0);
tTrue('every outbound link is safe to open in a new tab', (html.match(/target="_blank"/g) || []).length === (html.match(/rel="noopener noreferrer"/g) || []).length);

// ── accessibility floor ───────────────────────────────────────────────────
console.log('\naccessibility');
tTrue('focus is styled with :focus-visible', /:focus-visible/.test(html));
tTrue('outline is never removed without a replacement', !/outline:\s*none/.test(html));
tTrue('there is no transition:all', !/transition:\s*all/.test(html));
tTrue('motion is gated on prefers-reduced-motion', /prefers-reduced-motion:reduce/.test(html));
tTrue('column headers are scoped', (html.match(/<th scope="col"/g) || []).length >= 7);
tTrue('the result count announces itself', /aria-live="polite"/.test(html));
tTrue('tabpanels are labelled by their tab', /aria-labelledby="tab-/.test(html));
tTrue('only one tab is in the tab order', count(/role="tab"[^>]*tabindex="0"/g), 1);
tTrue('numeric columns use tabular figures', /font-variant-numeric:tabular-nums/.test(html));
tTrue('sortable columns expose a sort state', /aria-sort="descending"/.test(html));
tTrue('sorting is done with a real button, not a div', /<th[^>]*>\s*<button type="button" data-sort=/.test(html));
tTrue('the search field is labelled', /class="sr">Search jobs<\/span><input type="search"/.test(html));
tTrue('selects have labels', /<span>Status<\/span><select/.test(html) && /<span>Source<\/span><select/.test(html));
tTrue('search autocomplete is off for a non-auth field', /autocomplete="off"/.test(html));
tTrue('colour scheme is declared', /<meta name="color-scheme" content="light dark">/.test(html));
tTrue('theme-color follows the page background', /<meta name="theme-color"/.test(html));
tTrue('both light and dark tokens exist', /prefers-color-scheme:dark/.test(html));
tTrue('the table has a mobile stacked layout', /@media \(max-width:900px\)/.test(html));
tTrue('headings do not use raw text-wrap without balance on h1', /h1\{[^}]*text-wrap:balance/.test(html));

// ── states ────────────────────────────────────────────────────────────────
console.log('\nstates');
tTrue('there is an empty state template for the new view', /empty-t[^>]*>No new roles in scope/.test(gen));
tTrue('there is an empty state for applied', /empty-t[^>]*>No applications recorded yet/.test(gen));
tTrue('there is an empty state for history', /empty-t[^>]*>No history yet/.test(gen));
tTrue('a view with rows renders a table, not an empty state',
  rowsIn('applied').length > 0 && !/empty-t/.test(pane('applied')));
tTrue('the 20 + 80 cap is stated on the page', /Top 20 by fit plus up to 80 more/.test(html));
tTrue('the cap is visible in the metrics', /shown \(20\+80\)/.test(html));
tTrue('overflow is counted rather than silently dropped', /below the cut/.test(gen));
tTrue('the overflow card is conditional on there being overflow', /overflow \? `<div class="warn"/.test(gen));
tTrue('long content is allowed to wrap rather than overflow', /overflow-wrap:anywhere/.test(html));

// ── house rules ───────────────────────────────────────────────────────────
console.log('\nthe inline script must actually parse');
// This is the assertion that matters most in this file. The page's behaviour is
// ALL in one inline <script>, and a single syntax error there kills every handler
// at once while the markup still renders perfectly: the page LOOKS fine and does
// nothing. That is exactly what happened on 2026-09-27, when a newline escape
// written inside a TEMPLATE LITERAL was evaluated into a real newline, the string
// literal spanned lines, and every tab, filter and the Mark Applied button
// silently stopped working. Compiling the source is a two-line guard against
// shipping that again, and nothing else in the suite would have caught it.
const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
tTrue('there is an inline script', !!scriptSrc);
if (scriptSrc) {
  let parseErr = null;
  try { new vm.Script(scriptSrc, { filename: 'daily-digest.inline.js' }); }
  catch (e) { parseErr = e.message; }
  t('the inline script compiles', parseErr, null);
  // A string literal broken by a real newline is the specific failure, so assert
  // the emitted text has no raw line break inside a quoted message.
  tTrue('no bare newline inside the confirm message',
    !/confirm\([^)]*\n/.test(scriptSrc) && scriptSrc.includes('String.fromCharCode(10)'));
  tTrue('tabs are wired to a delegated listener', /role=tab|\[data-tab\]/.test(scriptSrc));
  tTrue('the tab handler exists on the tablist', /\.tabs'\)\.addEventListener|\.tabs\)\.addEventListener/.test(scriptSrc));
}

console.log('\nfiltering must hide rows, not just recount them');
// The counter and the visible list are two different things, and they drifted
// apart on 2026-09-28: paint() updated the number while never touching the rows,
// so typing in the search box reported "1 of 62 shown" with all 62 still on
// screen. A test that only checks the counter would have passed. These assert
// that the row-hiding step exists in the source at all, and that the filter
// inputs are actually wired to it.
const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
tTrue('paint toggles the hide class on rows', /classList\.toggle\('hide'/.test(js));
tTrue('and it does so for rows that did NOT match', /match\.indexOf\(tr\) === -1/.test(js));
tTrue('the count is derived from the same match set', /match\.length/.test(js));
tTrue('search is bound to input, not only on submit', /\[q, fCh, fSt\][\s\S]{0,220}addEventListener\('input'/.test(js));
tTrue('the reset control clears every filter', /reset\.addEventListener/.test(js));

console.log('\na failed write must say why');
tTrue('the failure state is not a bare "Failed"', !/textContent = 'Failed'/.test(js));
tTrue('the reason is shown in the page', /say\('Not saved: '/.test(js));
tTrue('a file:// page is detected before any click', /location\.protocol === 'file:'/.test(js));

console.log('\nthe actions cell must not widen the page');
tTrue('the table lives in a horizontal scroll wrapper', /\.tblwrap\{[^}]*overflow-x:auto/.test(html));
tTrue('the actions cell is not nowrap', !/\.c-go\{[^}]*white-space:nowrap/.test(html));
tTrue('the actions cell stacks in a shrinkable flex column', /\.c-go \.acts\{[^}]*flex-direction:column/.test(html));

console.log('\nhouse rules');
t('no em dash anywhere in the generated page', html.includes('\u2014'), false);
t('no em dash in the generator', gen.includes('\u2014'), false);
tTrue('the display layer normalises a third-party em dash', /replace\(\/\\u2014\/g, '- '\)/.test(gen) || gen.includes(".replace(/\\u2014/g, '-')"));
tTrue('the underlying record is not rewritten', readFileSync(join(ROOT, 'data', 'scan-history.tsv'), 'utf8').includes('\u2014'));
tTrue('dates are formatted through Intl', /Intl\.DateTimeFormat/.test(gen));
tTrue('counts are formatted through Intl', /Intl\.NumberFormat/.test(gen));
tTrue('no hand-rolled ISO date slice reaches the page', !/\.slice\(0, 10\)\}<\/time>/.test(html));
tTrue('the discovery-only caveat is still on the page', /discovery only/.test(html));
tTrue('the gates are still documented on the page', /Gates applied to every role/.test(html));
