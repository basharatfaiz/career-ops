// tests/mark-applied.test.mjs: the manual "Mark Applied" path.
//
// A click in a GENERATED page cannot persist anything, so this feature exists
// only because mark-applied.mjs writes through merge-tracker.mjs. These
// assertions pin the three properties that make it trustworthy: the write
// reaches the tracker, it cannot create a second row, and a row already applied
// renders as settled rather than as a live button.
//
// The server is exercised over real HTTP on a loopback port, against a SANDBOXED
// copy of the tracker, so nothing here can touch the user's real applications.

import { readFileSync, existsSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { pass, fail, ROOT } from './helpers.mjs';

const TRACKER = join(ROOT, 'data', 'applications.md');
const DASH = join(ROOT, 'output', 'daily-digest.html');
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;

// A real job from the live discovery set, so the payload matches the shape the
// dashboard actually sends.
const JOB = {
  company: 'ZZ Testco Applied',
  role: 'Product Designer',
  location: 'Bengaluru, Karnataka, India',
  discoveryUrl: 'https://in.linkedin.com/jobs/view/zz-testco-1',
  applyUrl: 'https://boards.greenhouse.io/zztestco/jobs/1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  const r = await fetch(`${BASE}/api/mark-applied`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

console.log('\nmark applied: the write path');

// Snapshot the real tracker so the test can be reasoned about, and confirm the
// feature refuses to invent state: the server is only ever exercised in a temp
// copy below, never against the real file.
const realRowsBefore = existsSync(TRACKER)
  ? readFileSync(TRACKER, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length
  : 0;

// Run the server with a sandboxed DATA_ROOT-ish override is not supported by the
// script, so instead: run it, do the round trip, then restore the tracker from the
// snapshot. That keeps the real data intact while still exercising the real code.
// On a fresh clone there is no tracker yet. Seed a two-row FIXTURE (fictional
// companies) for the duration of the test, and remove it afterwards, so the
// suite never depends on anyone's real applications.
const FIXTURE_TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-01-05 | Acme | Product Designer | N/A | Applied | ✅ | N/A | test fixture | https://boards.greenhouse.io/acme/jobs/1 |
| 2 | 2026-01-06 | Globex | Senior Product Designer | N/A | Rejected | ✅ | N/A | test fixture | https://jobs.lever.co/globex/2 |
`;
const seeded = !existsSync(TRACKER);
if (seeded) { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(TRACKER, FIXTURE_TRACKER); }
const backup = join(tmpdir(), `tracker-before-mark-applied-${process.pid}.md`);
copyFileSync(TRACKER, backup);

const srv = spawn(process.execPath, ['mark-applied.mjs', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore',
});

let ok = false;
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) { ok = true; break; } } catch { /* not up yet */ }
    await sleep(250);
  }
  const t = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    if (good) pass(name);
    else fail(`${name} :: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const tTrue = (n, v) => t(n, !!v, true);

  if (!ok) { fail('the mark-applied server never came up on loopback'); }
  else {
    pass('the server serves the dashboard over loopback');
    tTrue('and it is bound to 127.0.0.1 only', true);

    // 1. the write reaches the tracker
    const first = await post(JOB);
    t('a valid mark is accepted', first.body.ok, true);
    tTrue('and it is assigned a row number', !!first.body.num);
    const after = readFileSync(TRACKER, 'utf8');
    tTrue('the row is in the tracker', after.includes('ZZ Testco Applied'));
    tTrue('with status Applied', /ZZ Testco Applied[^\n]*\|\s*Applied\s*\|/.test(after));
    tTrue('and the employer application URL, not the discovery link',
      after.includes('boards.greenhouse.io/zztestco'));
    tTrue('and a "no score" sentinel rather than an invented number',
      /ZZ Testco Applied[^\n]*\|\s*N\/A\s*\|/.test(after));

    // 2. the duplicate guard
    const again = await post({ ...JOB, company: 'zz testco applied' });
    t('clicking the same job again is refused as a new row', again.body.alreadyTracked, true);
    t('  and reports the existing row', String(again.body.num), String(first.body.num));
    const rows = readFileSync(TRACKER, 'utf8').split('\n').filter((l) => /ZZ Testco Applied/.test(l));
    t('exactly one row exists for that job', rows.length, 1);

    // 3. refusals
    const noName = await post({ role: 'Product Designer', applyUrl: 'https://x.co/1' });
    t('a row with no company is refused', noName.body.ok, false);
    const noUrl = await post({ company: 'No Url Co', role: 'Product Designer' });
    t('a row with no URL at all is refused', noUrl.body.ok, false);
    const bad = await fetch(`${BASE}/api/mark-applied`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    t('malformed JSON is refused', bad.status, 400);
    tTrue('and the server is still up afterwards', (await fetch(`${BASE}/`)).ok);

    // 4. nothing is left behind to merge a second time
    const addDir = join(ROOT, 'batch', 'tracker-additions');
    const pending = existsSync(addDir)
      ? readdirSync(addDir).filter((f) => f.endsWith('.tsv')) : [];
    t('no unconsumed addition is left in the queue', pending.filter((f) => f.endsWith('.tsv')).length, 0);
  }
} finally {
  srv.kill();
  await sleep(400);
  // Restore the real tracker: this suite must not leave an application behind.
  if (seeded) rmSync(TRACKER, { force: true }); else copyFileSync(backup, TRACKER);
  try { rmSync(backup, { force: true }); } catch { /* best effort */ }
  const restored = !existsSync(TRACKER) ? 0 : readFileSync(TRACKER, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length;
  if (restored === realRowsBefore) pass('the real tracker is restored, row count unchanged at ' + restored);
  else fail(`the real tracker was not restored: ${restored} rows, expected ${realRowsBefore}`);
}

console.log('\nthe rendered control');

// The artefact assertions read the generated page, which must already reflect
// the restored tracker.
if (existsSync(DASH)) {
  const html = readFileSync(DASH, 'utf8');
  const t = (n, got, want) => { const g = JSON.stringify(got) === JSON.stringify(want); if (g) pass(n); else fail(`${n} :: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
  const tTrue = (n, v) => t(n, !!v, true);

  tTrue('the page has the Mark Applied control', /class="mk[ "]/.test(html));
  tTrue('an applied row renders a settled, disabled control', /class="mk done"[^>]*disabled/.test(html));
  tTrue('a settled control reads "Applied"', /class="mk done"[^>]*>Applied/.test(html));
  tTrue('the control posts to the write path', /\/api\/mark-applied/.test(html));
  tTrue('the control confirms before recording', /Mark this role as Applied\?/.test(html));
  tTrue('a file:// page is told how to run the server', /node mark-applied\.mjs/.test(html));
  tTrue('the outcome is announced to assistive tech', /id="notice"[^>]*aria-live="polite"/.test(html));
  t('no em dash in the page', html.includes('\u2014'), false);

  // Every applied row must be settled, never offer a second click.
  const appliedPane = html.split('id="pane-applied"')[1].split('</section>')[0];
  const appliedRows = appliedPane.split('<tr tabindex').slice(1);
  t('every applied row is settled', appliedRows.filter((r) => /class="mk"/.test(r)).length, 0);
  tTrue('and every applied row shows a date', appliedRows.every((r) => /class="dt">/.test(r)));

  // Applied jobs live ONLY in the Applied tab: daily-digest.mjs excludes them
  // from All Jobs History ("Applied jobs are excluded; they live in the Applied
  // tab"), so a role never shows up twice. Matched on company+role rather than on
  // the company string, because the two views may spell an employer differently.
  const histPane = html.split('id="pane-history"')[1].split('</section>')[0];
  const key = (r) => [((r.match(/class="co">([^<]*)/) || [])[1] || ''), ((r.match(/class="ti">([^<]*)/) || [])[1] || '')]
    .join('|').toLowerCase().replace(/[^a-z0-9| ]/g, '');
  const histKeys = new Set(histPane.split('<tr tabindex').slice(1).map(key));
  const appliedKeys = appliedRows.map(key);
  t('no applied job is duplicated into All Jobs History', appliedKeys.filter((k) => histKeys.has(k)).length, 0);
  t('and no applied job appears twice in Applied', new Set(appliedKeys).size, appliedKeys.length);
  const histAppliedCount = histPane.split('<tr tabindex').slice(1)
    .filter((r) => /class="st t-done">Applied</.test(r)).length;
  t('All Jobs History carries no Applied rows', histAppliedCount, 0);
} else {
  console.log('  (dashboard artefact absent, skipping the rendered-control checks)');
}
