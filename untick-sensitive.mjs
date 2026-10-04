// Untick sensitive/demographic radios that must never be answered by the agent.
// The earlier guard missed an LGB question, so the list is now explicit and
// broad, and it matches on the QUESTION TEXT (not the option label), because
// every sensitive question here offers a "No" that is indistinguishable by label.
import { chromium } from 'playwright';

const SENSITIVE = [
  /lesbian|gay|bisexual|\bLGB\b|sexual orientation|sexually/i,
  /ethnic|race|black|african|asian|hispanic|latinx|spanish origin|pacific islander|indian or alaska/i,
  /gender|woman|female|masculine|man, male|non-?binary|transgender|third gender/i,
  /self describe|self-describe/i,
  /veteran|disab|accommodation/i,
  /ethnicity|demographic|diversity/i,
];

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('/application')) || ctx.pages()[0];

const result = await page.evaluate((pats) => {
  const compiled = pats.map((p) => new RegExp(p.source, p.flags));
  const unticked = [];
  for (const el of document.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')) {
    // question text = nearest enclosing fieldset/group, else the block
    let n = el, q = '';
    for (let i = 0; i < 8 && n; i++) {
      n = n.parentElement; if (!n) break;
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > q.length && t.length < 500) q = t;
      if (n.tagName === 'FIELDSET' || n.getAttribute('role') === 'group') break;
    }
    const lab = (el.closest('label')?.innerText || document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '').trim();
    if (compiled.some((r) => r.test(q) || r.test(lab))) {
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      unticked.push({ question: q.slice(0, 130), option: lab.slice(0, 40) });
    }
  }
  return unticked;
}, SENSITIVE.map((r) => ({ source: r.source, flags: r.flags })));

console.log('=== UNTICKED SENSITIVE ANSWERS ===');
if (!result.length) console.log('  (none found)');
for (const u of result) console.log(`  ✗ "${u.option}"  ←  ${u.question}`);

// Final independent state read
const final = await page.evaluate(() => {
  const radios = [], checks = [], texts = [];
  const lbl = (el) => (el.closest('label')?.innerText || document.querySelector(`label[for="${CSS.escape(el.id || '')}"]`)?.innerText || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('input[type=radio]:checked')) radios.push(lbl(el).slice(0, 58));
  for (const el of document.querySelectorAll('input[type=checkbox]:checked')) checks.push(lbl(el).slice(0, 58));
  for (const el of document.querySelectorAll('input[type=text], input[type=email], input[type=number]')) {
    const v = (el.value || '').trim();
    if (v) texts.push(`${lbl(el).slice(0, 40)} = "${v.slice(0, 50)}"`);
  }
  const f = document.querySelector('#_systemfield_resume');
  const rc = document.querySelector('[name="g-recaptcha-response"]');
  return { radios, checks, texts, resume: f?.files?.[0]?.name || 'EMPTY', recaptcha: rc ? (rc.value ? 'has value' : 'EMPTY (unsolved)') : 'absent' };
});

console.log('\n=== FINAL STATE ===');
console.log('checked radios   :', final.radios.length ? '\n  • ' + final.radios.join('\n  • ') : '(none)');
console.log('checked checkboxes:', final.checks.length ? '\n  • ' + final.checks.join('\n  • ') : '(none)');
console.log('text fields with values:\n  ' + final.texts.join('\n  '));
console.log('resume           :', final.resume);
console.log('reCAPTCHA        :', final.recaptcha);

await page.screenshot({ path: 'output/weave-final.png', fullPage: false });
console.log('\nscreenshot -> output/weave-final.png');
await b.close();
