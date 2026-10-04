// Inspect the live application page over CDP and dump the REAL form fields.
// Read-only: navigates/reads only. Never clicks, never submits.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://jobs.ashbyhq.com/weave/25fc2824-6ae0-42a1-902b-3f3ba60f1815';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('ashby')) || ctx.pages()[0];
if (!page) page = await ctx.newPage();

if (page.url() !== URL) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
}

console.log('URL      :', page.url());
console.log('TITLE    :', await page.title());

const text = await page.evaluate(() => document.body.innerText.slice(0, 700));
console.log('\n--- VISIBLE TEXT (head) ---\n' + text);

// Real fields only — no guessing from the JD.
const fields = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'hidden') continue;
    const label =
      el.getAttribute('aria-label') ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
      el.closest('label')?.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '';
    out.push({
      tag: el.tagName.toLowerCase(),
      type,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      label: String(label).replace(/\s+/g, ' ').trim().slice(0, 90),
      value: type === 'file' ? '' : (el.value || '').slice(0, 40),
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value + ' :: ' + o.text).slice(0, 12) : undefined,
    });
  }
  return out;
});

console.log(`\n--- FORM FIELDS (${fields.length}) ---`);
for (const f of fields) {
  console.log(`  [${f.tag}${f.type && f.type !== f.tag ? ':' + f.type : ''}] ${f.required ? 'REQUIRED ' : ''}${f.label || f.name || '(no label)'}`);
  if (f.name) console.log(`      name=${f.name}${f.id ? ' id=' + f.id : ''}`);
  if (f.value) console.log(`      value="${f.value}"`);
  if (f.options) console.log(`      options: ${f.options.join(' | ')}`);
}

// Buttons — so Submit can be identified and AVOIDED.
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button, input[type=submit], a[class*=submit]')].map((e) => ({
    text: (e.innerText || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    type: e.getAttribute('type') || '',
  })).filter((x) => x.text)
);
console.log(`\n--- BUTTONS (${buttons.length}) — DO NOT CLICK SUBMIT ---`);
for (const btn of buttons) console.log(`  "${btn.text}"${btn.type ? ' type=' + btn.type : ''}`);

await b.close();
