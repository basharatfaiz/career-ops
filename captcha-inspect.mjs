#!/usr/bin/env node
/**
 * captcha-inspect.mjs — READ-ONLY. Precise reCAPTCHA inspection.
 *
 * Reports, for every reCAPTCHA-related node: computed display/visibility/
 * opacity, bounding box, whether it is an iframe, and whether it is actually
 * painted on screen (viewport intersection + non-zero area + offsetParent).
 *
 * Classifies the mechanism as:
 *   A) a real visible challenge requiring human action
 *   B) an invisible / background mechanism
 *   C) a hidden DOM transport field only, no visible challenge
 *
 * Clicks nothing. Submits nothing. Defeats nothing.
 */
import { chromium } from 'playwright';
const CDP = process.env.CAREER_OPS_CDP || 'http://127.0.0.1:9222';
const b = await chromium.connectOverCDP(CDP);
const page = b.contexts()[0].pages().find((p) => !p.url().startsWith('devtools')) || b.contexts()[0].pages()[0];
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const info = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const painted = !!(el.offsetParent !== null || cs.position === 'fixed')
      && cs.display !== 'none' && cs.visibility !== 'hidden'
      && parseFloat(cs.opacity) > 0
      && r.width > 0 && r.height > 0;
    const vr = { w: innerWidth, h: innerHeight };
    const inViewport = r.width > 0 && r.height > 0
      && r.bottom > 0 && r.right > 0 && r.top < vr.h && r.left < vr.w;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.className || '').toString().slice(0, 70) || null,
      name: el.getAttribute('name'),
      src: (el.getAttribute('src') || '').slice(0, 90) || null,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, zIndex: cs.zIndex,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hasOffsetParent: el.offsetParent !== null,
      painted, inViewport,
      ariaHidden: el.getAttribute('aria-hidden'),
      tabIndex: el.getAttribute('tabindex'),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    };
  };

  const nodes = [];
  const add = (el, role) => { if (el) nodes.push({ role, ...info(el) }); };

  add(document.querySelector('[name="g-recaptcha-response"]'), 'g-recaptcha-response (hidden transport textarea)');
  add(document.querySelector('.g-recaptcha'), '.g-recaptcha container');
  document.querySelectorAll('iframe').forEach((f, i) => {
    const s = f.getAttribute('src') || '';
    if (/recaptcha/i.test(s)) add(f, `recaptcha iframe [${i}]`);
  });
  document.querySelectorAll('[class*="grecaptcha"]').forEach((e, i) => {
    add(e, `grecaptcha* element [${i}]`);
  });
  // any iframe at all, so we can see whether one is hidden behind zero size
  const allFrames = [...document.querySelectorAll('iframe')].map((f, i) => ({ i, ...info(f) }));

  // scripts reveal invisible vs enterprise vs explicit render
  const scripts = [...document.querySelectorAll('script[src*="recaptcha"]')].map((s) => s.getAttribute('src'));
  const inline = [...document.querySelectorAll('script:not([src])')]
    .map((s) => s.textContent || '')
    .filter((t) => /recaptcha|grecaptcha|api\.js/i.test(t))
    .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 220));
  const sitekey = document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null;

  // the badge is the "protected by reCAPTCHA" watermark
  const badge = document.querySelector('.grecaptcha-badge, [class*="grecaptcha-badge"]');
  const badgeEls = badge ? [...document.querySelectorAll('.grecaptcha-badge, [class*="grecaptcha-badge"]')].map(info) : [];

  // any text on the page suggesting a challenge
  const body = document.body.innerText;
  const challengeText = /recaptcha|verify you are human|i'?m not a robot|select all|confirm you'?re human/i.exec(body);

  return {
    url: location.href,
    nodes, allFrames, scripts, inline, sitekey, badgeEls,
    challengeText: challengeText ? challengeText[0] : null,
    recaptchaScriptPresent: scripts.length > 0 || inline.length > 0,
    windowGrecaptcha: typeof window.grecaptcha !== 'undefined',
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { y: Math.round(scrollY), docH: document.body.scrollHeight },
  };
});

const L = (s) => console.log(s);
L('='.repeat(96));
L(`reCAPTCHA INSPECTION (read-only) — ${out.url}`);
L('='.repeat(96));
L(`viewport ${out.viewport.w}x${out.viewport.h} · scrollY ${out.scroll.y} · document ${out.scroll.docH}px`);
L(`window.grecaptcha present : ${out.windowGrecaptcha}`);
L(`data-sitekey on form     : ${out.sitekey || '(none)'}`);
L(`recaptcha <script>       : ${out.scripts.length ? out.scripts.join(' | ') : '(none)'}`);
L(`inline recaptcha config  : ${out.inline.length ? out.inline.join(' | ') : '(none)'}`);
L(`challenge wording on page: ${out.challengeText || '(none)'}`);
L(`badge nodes              : ${out.badgeEls.length}`);

L('\n--- reCAPTCHA NODES -------------------------------------------------------');
if (!out.nodes.length) L('  (no reCAPTCHA nodes matched)');
for (const n of out.nodes) {
  L(`\n  [${n.role}]`);
  L(`    <${n.tag}${n.id ? ' id=' + n.id : ''}${n.cls ? ' class="' + n.cls + '"' : ''}>`);
  if (n.name) L(`    name       : ${n.name}`);
  if (n.src) L(`    src        : ${n.src}`);
  L(`    display    : ${n.display}`);
  L(`    visibility : ${n.visibility}`);
  L(`    opacity    : ${n.opacity}`);
  L(`    position   : ${n.position}  z-index: ${n.zIndex}`);
  L(`    rect       : x=${n.rect.x} y=${n.rect.y} w=${n.rect.w} h=${n.rect.h}`);
  L(`    offsetParent: ${n.hasOffsetParent}   tabindex: ${n.tabIndex}   aria-hidden: ${n.ariaHidden}`);
  L(`    IN VIEWPORT: ${n.inViewport}     PAINTED: ${n.painted}`);
  if (n.text) L(`    text       : "${n.text}"`);
}

L('\n--- ALL IFRAMES ON PAGE --------------------------------------------------');
if (!out.allFrames.length) L('  (no iframes)');
for (const f of out.allFrames) {
  L(`  [${f.i}] src="${(f.src || '(no src)').slice(0, 70)}"`);
  L(`      display=${f.display} visibility=${f.visibility} opacity=${f.opacity} rect=${f.rect.w}x${f.rect.h} PAINTED=${f.painted} IN_VIEWPORT=${f.inViewport}`);
}

L('\n--- BADGE (reCAPTCHA watermark) ------------------------------------------');
if (!out.badgeEls.length) L('  (none)');
for (const g of out.badgeEls) {
  L(`  <${g.tag} class="${g.cls}"> display=${g.display} visibility=${g.visibility} opacity=${g.opacity} rect=${g.rect.w}x${g.rect.h} PAINTED=${g.painted}`);
}

L('\n--- CLASSIFICATION -------------------------------------------------------');
const anyChallengeFrame = out.nodes.find((n) => n.tag === 'iframe' && n.painted);
const badge = out.badgeEls.find((g) => g.painted);
const transport = out.nodes.find((n) => n.name === 'g-recaptcha-response');
if (anyChallengeFrame) {
  L('  A) A VISIBLE reCAPTCHA CHALLENGE IS RENDERED — human action required.');
  L(`     frame: ${anyChallengeFrame.src}`);
} else if (out.windowGrecaptcha && (badge || out.recaptchaScriptPresent)) {
  L('  B) INVISIBLE / BACKGROUND reCAPTCHA (v3-style). No visible challenge is');
  L('     painted. The script is loaded and scoring happens in the background;');
  L('     no checkbox puzzle is presented, so there is nothing for a human to click.');
  if (badge) L(`     badge watermark is present (${badge.rect.w}x${badge.rect.h}, painted).`);
} else {
  L('  C) NO reCAPTCHA MECHANISM IS ACTIVE ON THIS PAGE.');
}
if (transport) {
  L(`\n  transport field g-recaptcha-response: present, value="${transport.rect.w ? 'has value' : 'empty'}", painted=${transport.painted}`);
  L('     (this is a hidden textarea the site writes the token into; it is not a');
  L('      challenge, and a human is never asked to interact with it)');
}
L('\n  This script clicked nothing and defeated nothing.');
await b.close();
