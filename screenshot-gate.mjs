// Screenshot the VISIBLE browser window and detect the apply/login gate.
// Read-only.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

mkdirSync('output', { recursive: true });
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('ashby')) || ctx.pages()[0];

const out = 'output/weave-apply-gate.png';
await page.screenshot({ path: out, fullPage: false });
console.log('screenshot ->', out);

// What does the apply control actually do? Read its attributes WITHOUT clicking.
const gate = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, a')].filter((e) => /apply/i.test(e.innerText || ''));
  return els.map((e) => ({
    tag: e.tagName,
    text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
    href: e.getAttribute('href') || null,
    type: e.getAttribute('type') || null,
    target: e.getAttribute('target') || null,
    outer: e.outerHTML.slice(0, 220),
  }));
});
console.log('\n--- APPLY CONTROL(S) — not clicked ---');
for (const g of gate) {
  console.log(`  <${g.tag}> "${g.text}"`);
  console.log(`     href=${g.href}  type=${g.type}  target=${g.target}`);
  console.log(`     ${g.outer}`);
}

// Does the page mention login/account/OTP anywhere in the apply area?
const mentions = await page.evaluate(() => {
  const t = document.body.innerText.toLowerCase();
  return {
    signIn: /sign in|log in|login|create an account|register/.test(t),
    otp: /one-?time|otp|verification code|magic link/.test(t),
    captcha: /captcha|recaptcha|hcaptcha|are you a human/.test(t),
  };
});
console.log('\n--- GATE SIGNALS ON PAGE ---');
console.log('  login/account language :', mentions.signIn);
console.log('  OTP language           :', mentions.otp);
console.log('  CAPTCHA language       :', mentions.captcha);

await b.close();
