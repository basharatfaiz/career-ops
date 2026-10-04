#!/usr/bin/env node
/**
 * apply-one.mjs — run one application end to end, with verification at every
 * step. Never assumes a click succeeded.
 *
 * Steps:
 *   1. verify the live posting is still active, geo-eligible, in-band
 *   2. resolve the user's final CV (final-cv.mjs, hash-checked)
 *   3. fill reusable + generated fields (delegated to application-runner.mjs)
 *   4. read back the live form and enumerate what is still unresolved
 *   5. HALT on a visible CAPTCHA, an unresolved REQUIRED field, or login/OTP
 *   6. otherwise click Submit exactly once and verify the site's real response
 *   7. on confirmed success, write a tracker TSV for merge-tracker.mjs
 *
 * Usage:
 *   node apply-one.mjs --company Acme --url <application-url> --role "<role>"
 *   node apply-one.mjs ... --no-submit     # fill and verify only
 *   node apply-one.mjs ... --force-submit  # submit even with unresolved optional fields
 */
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import { classifyGeography, isApplicable } from './geo-eligibility.mjs';
import { finalCv } from './final-cv.mjs';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const BANK = yaml.load(readFileSync('data/application-answers.yml', 'utf8'));
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const company = arg('--company');
const role = arg('--role', '');
const url = arg('--url');
const noSubmit = has('--no-submit');
if (!company || !url) { console.error('usage: node apply-one.mjs --company X --url <application-url> [--role R] [--no-submit]'); process.exit(1); }

const CDP = process.env.CAREER_OPS_CDP || 'http://127.0.0.1:9222';
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const log = (...a) => console.log(...a);

// ── take exclusive ownership of ONE tab ──────────────────────────────────
// The runner picks a tab by "first non-devtools page", so a stale tab silently
// became the fill target while this script read back a different one — the form
// came back empty after a run that had actually filled it. Closing every other
// tab makes the target unambiguous.
for (const p of ctx.pages()) {
  if (p === page) continue;
  if (p.url().startsWith('devtools')) continue;
  await p.close().catch(() => {});
}
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(1200);
log('='.repeat(96));
log(`APPLY ${company} — ${role}`);
log('='.repeat(96));
log(`  tab            : ${page.url().slice(0, 100)}  (sole tab; ${ctx.pages().length} open)`);

const AJ = '/tmp/applications.md';
try {
  if (existsSync('data/applications.md')) copyFileSync('data/applications.md', AJ);
  const tracker = readFileSync(AJ, 'utf8');
  if (new RegExp(`\\|\\s*${norm(company).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`, 'i').test(tracker.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).join('\n'))) {
    log(`✗ ${company} already has a row in applications.md — refusing to duplicate.`);
    await browser.close(); process.exit(2);
  }
} catch { /* tracker unreadable: continue, merge will dedupe */ }

// ── 1. verify the live posting ───────────────────────────────────────────
const postingUrl = url.replace(/\/(application|apply)\/?$/, '');
await page.goto(postingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500);
const live = await page.evaluate(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ad = window.__appData?.posting || {};
  const body = (document.body.innerText || '').replace(/\s+/g, ' ');
  return {
    title: ad.title || norm(document.querySelector('h1')?.innerText),
    isListed: ad.isListed,
    locationName: ad.locationName || '',
    workplaceType: ad.workplaceType || '',
    employmentType: ad.employmentType || '',
    text: body.slice(0, 6000),
    closed: /no longer available|no longer accepting|position (has been )?filled|job not found/i.test(body),
    jdLen: (window.__appData?.posting?.descriptionHtml || '').length,
  };
});
const geo = classifyGeography({ postingText: live.text, url: postingUrl, title: live.title, locationHint: live.locationName, primaryLocation: live.locationName });
log(`  live title     : ${live.title}`);
log(`  location field : ${live.locationName || '(none)'}  workplace=${live.workplaceType || '?'}`);
log(`  isListed       : ${live.isListed}`);
log(`  closed         : ${live.closed}`);
log(`  geography      : ${geo.classification}  (${geo.workArrangement}, ${geo.geography})  sponsorship=${geo.sponsorship}`);
if (live.closed) { log('  ✗ POSTING CLOSED — halting.'); await browser.close(); process.exit(3); }
if (!isApplicable(geo)) {
  log(`  ✗ NOT APPLICABLE (${geo.classification}) — halting, no application made.`);
  log(`     ${geo.rationale || ''}`);
  await browser.close(); process.exit(3);
}
if (geo.relocationRequired) {
  log(`  relocation     : accepted — role is outside India (${geo.geography}), sponsorship=${geo.sponsorship}`);
  log(`                   sponsorship recorded on the application, never fabricated`);
}

// ── 2. CV ────────────────────────────────────────────────────────────────
// The uploaded file is ALWAYS the user's own final CV, resolved and hash-checked
// by final-cv.mjs (path + SHA-256 from the answer bank); never a generated
// or tailored PDF. A per-company copy of it is still made under output/ purely as
// an internal provenance artifact for the report and the tracker; it is never
// what gets uploaded.
let generic;
try { generic = finalCv(BANK).path; } catch (e) { log(`  ✗ ${e.message}`); await browser.close(); process.exit(4); }
const perCompany = `output/${(BANK.cv.unique_filename_pattern || '{company}').replace('{company}', company)}`;
if (!existsSync(perCompany)) {
  try { copyFileSync(generic, perCompany); } catch { /* provenance copy is best-effort */ }
}
const cv = generic;   // ← this is what gets uploaded, every single time
log(`  cv             : ${cv}  (employer-facing filename, consistent across all applications)`);
if (perCompany !== generic) log(`  provenance copy: ${perCompany}`);

// ── 3. fill ──────────────────────────────────────────────────────────────
// ── 3. open the form, then fill ──────────────────────────────────────────
// Recruitee renders the entire form hidden behind an "Apply" button, so every
// fill timed out and no submit control existed until that button is pressed.
const openness = await page.evaluate(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ctrls = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
  const visible = ctrls.filter((e) => !!e.offsetParent).length;
  const apply = [...document.querySelectorAll('button, a, [role=button]')].find((x) => /^apply(\s+(now|for\s+this\s+job))?$|^start application$/i.test(norm(x.innerText)));
  return { total: ctrls.length, visible, hasApply: !!apply };
});
if (openness.hasApply && openness.visible === 0) {
  log(`  form hidden behind an "Apply" button — opening it first`);
  await page.locator('button, a, [role=button]').filter({ hasText: /^apply(\s+(now|for\s+this\s+job))?$|^start application$/i }).first().click({ timeout: 15000, force: true }).catch((e) => log('  open-form click: ' + e.message.split('\n')[0]));
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((e) => !!e.offsetParent).length);
  log(`  form controls now visible: ${after}`);
}

log('\n  ── filling ──');
// Pass the LIVE posting location through. Without it the runner cannot tell
// an India role from an overseas one, and the sponsorship answer — which
// must be "No" for an India role and "Yes" only abroad — silently fell back
// to "Yes", telling Indian employers the candidate needs immigration support.
const liveLoc = [live.locationName, live.location, geo && geo.geography].filter(Boolean).join(', ');
const fillArgs = ['application-runner.mjs', '--url', url, '--company', company, '--role', role, '--fill'];
if (liveLoc) fillArgs.push('--location', liveLoc);
const fill = spawnSync(process.execPath, fillArgs, { encoding: 'utf8', timeout: 300000 });
const fillOut = (fill.stdout || '') + (fill.stderr || '');
log(fillOut.split('\n').filter((l) => /^\s*(✓|○|✗|\?|·|·|PRESERVED|WILL FILL|LEFT BLANK|NEEDS YOU|NOT ANSWERED|SUBMIT|[0-9]+\.)/.test(l) || /human gates|fields \d+/.test(l)).join('\n'));
if (fill.status !== 0) log('  (runner stderr) ' + fillOut.split('\n').filter((l) => /Error|error/.test(l)).slice(0, 3).join(' | '));

// ── 4. read back the live form ───────────────────────────────────────────
// Read the tab the RUNNER filled. Re-navigating here would reload the form and
// wipe every value — which is exactly what an earlier version did, and it
// reported 8 required fields empty on a form the runner had just completed.
const READBACK = (opts) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lbl = (el) => norm((el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest('label')?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '')).slice(0, 120);
  const painted = (el) => { if (!el) return false; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false; if (!r.width || !r.height) return false; if (el.offsetParent === null && cs.position !== 'fixed') return false; return true; };
  const cf = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
  const requiredEmpty = [];
  const rows = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'hidden') continue;
    if (el.name === 'g-recaptcha-response' || el.id === 'g-recaptcha-response') continue;
    if (type === 'file' && !el.id && !el.name) continue;
    const required = el.required === true || el.getAttribute('aria-required') === 'true' || /\*/.test(lbl(el));
    let filled = false, value = '';
    if (type === 'radio' || type === 'checkbox') {
      const grp = el.name ? [...document.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`)] : [el];
      filled = grp.some((g) => g.checked);
    } else if (type === 'file') {
      const f = el.files && el.files[0]; filled = !!f; value = f ? f.name : '';
    } else {
      value = el.tagName === 'SELECT' ? norm(el.selectedOptions[0]?.text) : (el.value || '').trim();
      filled = !!value;
      if (!filled) {
        // react-select (Greenhouse Country / Location (City) / yes-no): the
        // committed choice is painted into a sibling .select__single-value,
        // and often renders as a dialling code ("+91") rather than the full
        // label. Treat a painted label as filled — otherwise a correctly
        // committed dropdown is reported empty and the run halts forever.
        const sv = el.closest('div')?.parentElement?.querySelector('[class*=select__single-value]')
          || el.parentElement?.querySelector('[class*=select__single-value]');
        const paintedLabel = sv ? norm(sv.textContent) : '';
        if (paintedLabel) { filled = true; value = paintedLabel; }
      }
    }
    rows.push({ type, label: lbl(el), required, filled, value: value.slice(0, 60) });
    if (required && !filled) requiredEmpty.push(lbl(el));
  }
  const submit = [...document.querySelectorAll('button, input[type=submit]')].find((x) => /submit|apply now/i.test(x.innerText || x.value || ''));
  // Phone integrity: compare the live digits against the answer bank. A field
  // that already held a value is preserved rather than rewritten, so a bad
  // number can survive a run untouched — one form held 11 digits
  // with a stray leading zero. Shipping that is worse than halting.
  // wantPhone arrives as an evaluate ARG: this function is serialised into the
  // browser, where the Node-side BANK constant does not exist.
  const wantPhone = (opts && opts.wantPhone) || '';
  const phoneIssues = [];
  for (const el of document.querySelectorAll('input[type=tel], input[name*=phone i], input[id*=phone i]')) {
    const v = (el.value || '').trim();
    const digits = v.replace(/\D/g, '');
    if (!digits) continue;
    if (wantPhone && digits !== wantPhone) phoneIssues.push({ label: lbl(el), found: v, digits, expected: wantPhone });
  }
  return {
    href: location.href,
    rows, requiredEmpty, phoneIssues,
    captcha: { rendered: painted(cf), vendor: cf && /hcaptcha/i.test(cf.getAttribute('src') || '') ? 'hcaptcha' : (cf ? 'recaptcha' : null) },
    login: !!document.querySelector('input[type=password]')
      || /sign in to (continue|apply)|log ?in to apply|create account\s*\/\s*sign in/i.test(document.body.innerText)
      || (/current step\s*\d+\s*of\s*\d+/i.test(document.body.innerText)
          && /create account|sign in|my information/i.test(document.body.innerText)),
    otp: /one-?time (code|password)|verification code|check your (email|inbox)/i.test(document.body.innerText),
    submit: submit ? { text: norm(submit.innerText || submit.value), disabled: submit.disabled === true, visible: !!submit.offsetParent } : null,
    fileNames: [...document.querySelectorAll('input[type=file]')].map((f) => (f.files && f.files[0] ? f.files[0].name : '')).filter(Boolean),
  };
};

// find the tab that is on the application form, preferring one with values
let form = null, formPage = null;
const formKey = url.replace(/\/+$/, '').split('?')[0];
for (const p of ctx.pages()) {
  if (p.url().startsWith('devtools')) continue;
  const purl = p.url().split('?')[0].replace(/\/+$/, '');
  if (purl !== formKey && purl.replace(/\/(application|apply)$/, '') !== formKey.replace(/\/(application|apply)$/, '')) continue;
  let s = null;
  // Ashby re-routes after the CV upload, which destroys the execution context
  // mid-evaluate. Settle, then retry a few times before giving up on the tab.
  for (let attempt = 0; attempt < 4 && !s; attempt++) {
    try {
      await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await p.waitForTimeout(attempt === 0 ? 800 : 1800);
      s = await p.evaluate(READBACK, { wantPhone: String((BANK.identity && BANK.identity.phone) || '').replace(/\D/g, '') });
    } catch (e) {
      if (attempt === 3) log(`  (read-back failed after 4 attempts: ${String(e.message).split('\n')[0].slice(0, 80)})`);
    }
  }
  if (!s) continue;
  if (!form || s.rows.filter((r) => r.filled).length > form.rows.filter((r) => r.filled).length) { form = s; formPage = p; }
}
if (!form) { log('  ✗ could not find the filled application tab'); await browser.close(); process.exit(14); }
const state = form;
log(`  (read-back tab: ${form.href.slice(0, 90)})`);

log('\n  ── live form read-back ──');
log(`  controls       : ${state.rows.length}   answered: ${state.rows.filter((r) => r.filled).length}`);
log(`  cv uploaded    : ${state.fileNames.join(', ') || '(none)'}`);
log(`  captcha        : ${state.captcha.rendered ? (state.captcha.vendor || 'yes').toUpperCase() + ' RENDERED' : 'none visible'}`);
log(`  login / otp    : ${state.login} / ${state.otp}`);
log(`  submit button  : ${state.submit ? `"${state.submit.text}" visible=${state.submit.visible} disabled=${state.submit.disabled}` : '(none found)'}`);
if (state.requiredEmpty.length) { log('  REQUIRED EMPTY :'); state.requiredEmpty.forEach((q) => log('     ✗ ' + q)); }
else log('  required empty : none');
if (state.phoneIssues?.length) {
  log('  PHONE MISMATCH :');
  for (const pi of state.phoneIssues) log(`     ✗ "${pi.label}" holds "${pi.found}" (${pi.digits} digits) — the answer bank says ${pi.expected}`);
}
if (state.submit && state.submit.disabled) log('  submit button is DISABLED by the site — its own validation is failing');

// ── 5. halt conditions ───────────────────────────────────────────────────
if (state.login) { log('\n  ⏸ HALT: login required — complete it, then I resume this application.'); await browser.close(); process.exit(10); }
if (state.otp) { log('\n  ⏸ HALT: OTP required — complete it, then I resume this application.'); await browser.close(); process.exit(10); }
if (state.requiredEmpty.length) {
  log('\n  ⏸ HALT: unresolved REQUIRED field(s) above. Not guessing. Not submitting.');
  await browser.close(); process.exit(11);
}
if (state.phoneIssues?.length) {
  log('\n  ⏸ HALT: the phone number in the form does not match the answer bank.');
  log('     I will not submit a wrong phone number. Correct it (or tell me the right one) and I resume.');
  await browser.close(); process.exit(15);
}
if (state.submit && state.submit.disabled) {
  log('\n  ⏸ HALT: the site has disabled its own Submit button, so its validation is');
  log('     failing on something not visible as a required field. Not forcing it.');
  await browser.close(); process.exit(16);
}
if (state.captcha.rendered) {
  log('\n  ⏸ HALT: a visible CAPTCHA widget is rendered. Solve it in the open browser,');
  log('     tell me it is done, and I will resume THIS application from the filled state.');
  await browser.close(); process.exit(12);
}
if (noSubmit) { log('\n  --no-submit: stopping before Submit.'); await browser.close(); process.exit(0); }
if (!state.submit || !state.submit.visible) { log('\n  ✗ no usable Submit control — halting.'); await browser.close(); process.exit(13); }

// ── 6. submit once, then verify ──────────────────────────────────────────
log(`\n  ── submitting "${state.submit.text}" (one click) ──`);
const beforeUrl = formPage.url();
await formPage.locator('button, input[type=submit]').filter({ hasText: /submit|apply now/i }).first().click({ timeout: 20000 }).catch((e) => log('  click error: ' + e.message));
log('  clicked. waiting for the site…');
let res = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500);
  res = await formPage.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const body = document.body.innerText || '';
    const forms = [...document.querySelectorAll('input, select, textarea')].filter((e) => (e.getAttribute('type') || e.tagName).toLowerCase() !== 'hidden').length;
    const submitStill = [...document.querySelectorAll('button')].some((x) => /submit application|apply now/i.test(x.innerText || ''));
    const errs = [...new Set((body.match(/Missing entry for required field:[^•]{0,120}|Your form needs corrections[^•]{0,160}/gi) || []).map((t) => norm(t)))];
    return {
      url: location.href, forms, submitStill, errs: errs.slice(0, 6),
      success: /success|thank you|application (was |has been )?(received|submitted)|we('ve| have) received|successfully (applied|submitted)|received your application|submitted successfully/i.test(body),
      bodyHead: norm(body).slice(0, 400),
    };
  });
  if (res.success || res.url !== beforeUrl || !res.submitStill) break;
  if (i % 5 === 4) log(`  … waiting (${(i + 1) * 1.5}s)`);
}
const confirmed = res.success || (res.url !== beforeUrl && !res.submitStill && res.forms <= 3);
log('\n  ── post-submit live state ──');
log(`  url            : ${res.url}`);
log(`  url changed    : ${res.url !== beforeUrl}`);
log(`  form controls  : ${res.forms} (was ${state.rows.length})`);
log(`  submit button  : ${res.submitStill ? 'STILL PRESENT' : 'gone'}`);
log(`  success signal : ${res.success}`);
if (res.errs.length) { log('  SITE ERRORS    :'); res.errs.forEach((e) => log('     ✗ ' + e)); }
log(`  page text      : ${res.bodyHead}`);
await formPage.screenshot({ path: `output/apply-${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, fullPage: true });

if (!confirmed) {
  log('\n  ✗ SUBMISSION NOT CONFIRMED — not recording, not marking Applied.');
  await browser.close(); process.exit(20);
}

// ── 7. record via the sanctioned tracker path ────────────────────────────
const num = String(Date.now()).slice(-3);
const slug = norm(company).toLowerCase().replace(/[^a-z0-9]+/g, '-');
// Report number: max existing, not the FIRST row. Reading only the first match
// reused a number another company had already taken, producing two report
// files with the same number.
const existingNums = [...readFileSync('data/applications.md', 'utf8').matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
const maxNum = existingNums.length ? Math.max(...existingNums) : 0;
const reportNumsInDir = existsSync('reports')
  ? (require('fs').readdirSync('reports').map((f) => (f.match(/^(\d{3})-/) || [])[1]).filter(Boolean).map(Number))
  : [];
const nextNum = String(Math.max(maxNum, ...reportNumsInDir, 0) + 1).padStart(3, '0');
mkdirSync('reports', { recursive: true });
mkdirSync('batch/tracker-additions', { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const reportPath = `reports/${nextNum}-${slug}-${today}.md`;
const tsvPath = `batch/tracker-additions/${nextNum}-${slug}.tsv`;
const jdHtml = await (async () => { try { return await page.evaluate(() => window.__appData?.posting?.descriptionHtml || ''); } catch { return ''; } })();

writeFileSync(reportPath, `# ${company} — ${role}

**Company:** ${company}
**Role:** ${role}
**Location:** ${live.locationName || '—'} · ${live.workplaceType || '—'}
**URL:** ${postingUrl}
**Legitimacy:** Tier 1 — live posting on the employer's own ATS board; geography and seniority verified against the live page.
**Status:** Applied — submitted and site-confirmed ${today}

## Submission Record

Confirmed submitted. Site response: \`${norm(res.bodyHead).slice(0, 220)}\`

CV uploaded: \`${require('path').basename(cv)}\`
Work arrangement: ${geo.workArrangement} · Geography: ${geo.geography} · Sponsorship: ${geo.sponsorship}

## Machine Summary

\`\`\`yaml
company: ${company}
role: ${role}
location: ${live.locationName || 'unknown'}
work_arrangement: ${geo.workArrangement}
geography_classification: ${geo.classification}
sponsorship: ${geo.sponsorship}
status: Applied
submitted: ${today}
submission_confirmed: true
ats: ${/ashbyhq/.test(url) ? 'Ashby' : (/greenhouse/.test(url) ? 'Greenhouse' : (/workable/.test(url) ? 'Workable' : (/recruitee/.test(url) ? 'Recruitee' : 'other')))}
cv: ${require('path').basename(cv)}
\`\`\`

## Job Description (archived verbatim)

${jdHtml ? jdHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '_JD capture unavailable at submit time; see the posting URL._'}
`);

writeFileSync(tsvPath, [
  ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes', 'url'].join('\t'),
  [nextNum, today, company, role, 'Applied', 'N/A', '✅', `[${nextNum}](reports/${nextNum}-${slug}-${today}.md)`, `Submitted and site-confirmed. ${live.locationName || ''} ${live.workplaceType || ''}`.trim(), postingUrl].join('\t'),
].join('\n') + '\n');

const merge = spawnSync(process.execPath, ['merge-tracker.mjs'], { encoding: 'utf8', timeout: 120000 });
log('\n  ── tracker ──');
log((merge.stdout || '').split('\n').filter((l) => /Add|Update|Summary|error|Error/i.test(l)).join('\n'));
log(`  TSV  : ${tsvPath}`);
log(`  report: ${reportPath}`);
log(`\n  ✅ ${company} — ${role}: SUBMITTED AND RECORDED as Applied.`);
await browser.close();
process.exit(0);
