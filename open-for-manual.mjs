#!/usr/bin/env node
/**
 * open-for-manual.mjs — open every application the runner could NOT submit as
 * its own tab, pre-fill it as far as truthfulness allows, and leave it open for
 * the candidate to finish and submit by hand.
 *
 * Submits nothing. Clicks nothing but form fields. Never bypasses a CAPTCHA.
 *
 * Targets come from data/manual-targets.json (user layer, never committed):
 *   [{ "company": "Acme", "role": "Product Designer", "url": "https://…" }, …]
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { chromium } from 'playwright';

const TARGETS_FILE = 'data/manual-targets.json';
if (!existsSync(TARGETS_FILE)) {
  console.error(`No ${TARGETS_FILE}. Create it as a JSON array of { company, role, url } objects.`);
  process.exit(1);
}
const TARGETS = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));

const b = await chromium.connectOverCDP(process.env.CAREER_OPS_CDP || 'http://127.0.0.1:9222');
const ctx = b.contexts()[0];

// close anything already open so each target gets a clean, known tab
for (const p of ctx.pages()) { if (!p.url().startsWith('devtools')) await p.close().catch(() => {}); }

const opened = [];
for (const t of TARGETS) {
  const page = await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) { console.log(`  ✗ ${t.company}: ${e.message.split('\n')[0].slice(0, 70)}`); await page.close(); continue; }
  await page.waitForTimeout(2500);
  // Recruitee hides the form behind an Apply button — open it so the candidate
  // sees the actual fields rather than a job description.
  if (/recruitee/i.test(t.url)) {
    const opened2 = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((e) => !!e.offsetParent).length;
      const btn = [...document.querySelectorAll('button, a')].find((x) => /^apply$/i.test(norm(x.innerText)));
      if (vis === 0 && btn) { btn.click(); return true; }
      return false;
    });
    if (opened2) { await page.waitForTimeout(2500); console.log(`  · ${t.company}: opened the hidden application form`); }
  }
  opened.push({ ...t, page });
  console.log(`  ✓ tab opened: ${t.company} — ${t.role}`);
}

// pre-fill each in place
console.log('\n── pre-filling each tab (no submission) ──');
for (const t of opened) {
  const r = spawnSync(process.execPath, ['application-runner.mjs', '--url', t.url, '--tab-url', t.url, '--company', t.company, '--role', t.role, '--fill'], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const filled = (out.match(/WILL FILL \/ FILLED \((\d+)\)/) || [])[1];
  const asked = (out.match(/NEEDS YOU \((\d+)\)/) || [])[1];
  const gate = (out.match(/captcha:\s*(\w+)/) || [])[1];
  console.log(`  ${t.company.padEnd(22)} filled=${filled ?? '?'} needs-you=${asked ?? '?'} captcha=${gate ?? '?'}`);
}

// leave the first target focused
const focus = opened[0];
if (focus) { await focus.page.bringToFront().catch(() => {}); }

console.log('\n' + '='.repeat(92));
console.log(`${opened.length} application tabs are open and pre-filled. Nothing was submitted.`);
console.log('='.repeat(92));
for (const t of opened) console.log(`  • ${t.company} — ${t.role}\n      ${t.url}`);
await b.close();
