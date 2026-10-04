#!/usr/bin/env node
/**
 * browser-session.mjs — a VISIBLE, persistent, externally-controllable browser
 * for the apply workflow.
 *
 * WHY THIS EXISTS. The repo already launches headed Chromium
 * (liveness-browser.mjs, check-liveness.mjs --headed-fallback) but only for
 * one-shot read-only liveness checks: the browser is opened, read, and closed
 * inside a single call. Applying to a job needs three things that shape does
 * not provide — a window the candidate can WATCH, a profile that survives
 * between steps so a login is not lost, and a handle the agent can keep
 * driving after the window appears. So this is the minimum launcher that adds
 * exactly those, on the Playwright already in node_modules.
 *
 * DESIGN
 *   start   launch headed Chromium with a DEDICATED profile, open a debugging
 *           port, navigate to a URL, then stay alive so the window persists.
 *           State (cookies, a logged-in session) lives in the dedicated profile
 *           and survives restarts.
 *   stop    close the session.
 *
 * The profile is `<repo>/data/browser-profile/career-ops`, which is inside
 * `data/*` — gitignored and never synced. It is deliberately NOT the user's
 * normal Chrome profile: this must never read their stored passwords, cookies
 * or logged-in sessions.
 *
 * READ-ONLY BY DEFAULT: this launcher opens and navigates. It never clicks
 * Submit and never bypasses a login, CAPTCHA or OTP — those are handed back to
 * the candidate by design.
 *
 * Usage:
 *   node browser-session.mjs start [url] [--port 9222] [--profile <dir>]
 *   node browser-session.mjs stop  [--port 9222]
 *   node browser-session.mjs status
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';

import { fileURLToPath } from 'url';
// '.' resolves to THIS file's directory (the repo root). Using '..' climbed one
// level too far and put the profile at ~/data/browser-profile, outside the repo
// and therefore outside the data/* gitignore rule.
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DEFAULT_PROFILE = resolve(ROOT, 'data/browser-profile/career-ops');
const PID_FILE = resolve(ROOT, 'data/browser-session.json');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const cmd = process.argv[2] || 'status';
const port = Number(arg('--port', 9222));
const profile = resolve(arg('--profile', DEFAULT_PROFILE));
const url = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;

async function cdpAlive(p) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

if (cmd === 'status') {
  const alive = await cdpAlive(port);
  let meta = {};
  try { meta = JSON.parse(readFileSync(PID_FILE, 'utf8')); } catch { /* none */ }
  console.log(`CDP endpoint : http://127.0.0.1:${port}`);
  console.log(`reachable    : ${alive ? 'YES' : 'no'}`);
  console.log(`profile      : ${profile}`);
  if (meta.url) console.log(`last url     : ${meta.url}`);
  process.exit(alive ? 0 : 1);
}

if (cmd === 'stop') {
  if (existsSync(PID_FILE)) {
    try { const m = JSON.parse(readFileSync(PID_FILE, 'utf8')); process.kill(m.pid, 'SIGTERM'); console.log(`signalled launcher pid ${m.pid}`); } catch { /* already gone */ }
    rmSync(PID_FILE, { force: true });
  }
  console.log('stopped (the window may close momentarily)');
  process.exit(0);
}

if (cmd === 'start') {
  if (await cdpAlive(port)) {
    console.log(`A browser is already listening on ${port}. Use it, or run 'stop' first.`);
    process.exit(1);
  }
  mkdirSync(profile, { recursive: true });

  console.log(`launching VISIBLE chromium (headed) …`);
  console.log(`  dedicated profile: ${profile}`);
  console.log(`  debugging port  : ${port}`);

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,                       // the candidate must SEE this
    viewport: null,
    args: [
      `--remote-debugging-port=${port}`,
      '--start-maximized',
      // No automation banners; keeps the session looking like a normal window.
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  if (url) {
    console.log(`navigating to ${url} …`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      console.log(`  navigation warning: ${String(e.message).slice(0, 90)}`);
    });
  }

  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, profile, url, started: new Date().toISOString() }, null, 2));
  console.log(`\nBROWSER IS OPEN AND VISIBLE.`);
  console.log(`  CDP: http://127.0.0.1:${port}`);
  console.log(`  This launcher stays alive so the window persists.`);
  console.log(`  Close the window, or run: node browser-session.mjs stop\n`);

  // Stay alive until the window is closed or the process is signalled.
  await new Promise((resolve) => {
    context.on('close', () => { console.log('browser window closed — launcher exiting'); resolve(); });
    process.on('SIGTERM', () => { context.close().catch(() => {}); resolve(); });
    process.on('SIGINT', () => { context.close().catch(() => {}); resolve(); });
  });
  rmSync(PID_FILE, { force: true });
  process.exit(0);
}

console.log('usage: node browser-session.mjs <start [url] | stop | status> [--port N] [--profile DIR]');
process.exit(1);
