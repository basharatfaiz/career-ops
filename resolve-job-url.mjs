#!/usr/bin/env node
/**
 * resolve-job-url.mjs — search-index → canonical employer/ATS posting URL.
 *
 * WHY. A Level-3 search hit usually carries only {company, title, location}: the
 * search engine read an INDEX PAGE (an aggregator, a salary guide, a job board's
 * own listing) and the per-posting URL was never observed. That is not enough to
 * evaluate or track a role, and it is not safe to invent one. This script turns
 * those triples into real, canonical posting URLs — or says "unresolved".
 *
 * THE LADDER (first rung that yields a TITLE-MATCHED posting wins):
 *   1. direct employer career URL  2. Greenhouse  3. Lever  4. Ashby
 *   5. Workable                    6. other public ATS/host   7. search-index
 * Rungs 2-5 are public, no-auth JSON APIs, so a hit is a real posting read from
 * the employer's own board — not a search snippet. Rung 1/6 read the employer's
 * public page and match a link by title. Rung 7 is a last resort and is
 * disabled unless --allow-search is passed.
 *
 * NEVER INVENTED. A URL is returned only when a posting was actually fetched
 * whose title matches the target. No CAPTCHA solving, no auth, no rate-limit
 * evasion, no robots.txt circumvention, no URL pattern-guessing. Anything that
 * does not clear the bar is reported `unresolved` with a reason.
 *
 * DEDUP RUNS AFTER RESOLUTION, not before: the same role reached via a search
 * index and via an ATS API must merge into ONE opportunity. Key order is
 * canonical URL (url-key.mjs `normalizeUrl`, the same key the tracker uses),
 * then normalized company|title for the unresolved remainder.
 *
 * Usage:
 *   node resolve-job-url.mjs --in opps.tsv [--out resolved.json] [--summary]
 *   node resolve-job-url.mjs --in opps.tsv --allow-search --limit 10
 *
 * Input TSV (header-driven, so column order can't silently drift):
 *   company \t title \t location \t country_group \t url \t source
 * `url` may be '-' or empty. Extra columns are ignored.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { makeHttpCtx, sleep } from './providers/_http.mjs';
import { normalizeUrl } from './url-key.mjs';

const UA = 'Mozilla/5.0 (compatible; career-ops/1.0; +https://github.com/career-ops-hq/career-ops)';

// ── normalization ────────────────────────────────────────────────────────

const LEGAL = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|group|holdings|technologies|technology|software|solutions|services|labs|india|global|plc|gmbh)\b/g;

function normCompany(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Board slugs to try for a company, most specific first. */
function slugCandidates(company) {
  const raw = String(company || '').toLowerCase().trim();
  const flat = normCompany(company);
  const hyphen = flat.replace(/ /g, '-');
  const camel = flat.replace(/ /g, '');
  const out = new Set();
  if (raw) out.add(raw.replace(/[^a-z0-9-]+/g, ''));
  if (hyphen) out.add(hyphen);
  if (camel) out.add(camel);
  // first two tokens joined — "Nightfall AI" -> "nightfall-ai" already covered;
  // this helps "Zetaglobal Global" style names where a token is noise.
  const parts = flat.split(' ').filter(Boolean);
  if (parts.length > 1) out.add(parts[0]);
  return [...out].filter(Boolean).slice(0, 3);
}

const TITLE_STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'in', 'at', 'to', 'ii', 'iii', 'iv']);

function titleTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#/]+/g, ' ')
    .split(' ')
    .filter((t) => t && !TITLE_STOP.has(t));
}

/**
 * Similarity on title tokens. Strict on purpose: returning a posting whose
 * title merely shares a word ("Product Designer" vs "Product Design Manager")
 * would attach the wrong URL to the role, which is worse than unresolved.
 */
function titleScore(target, candidate) {
  const a = new Set(titleTokens(target));
  const b = new Set(titleTokens(candidate));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  const jaccard = inter / union;
  const subset = [...a].every((t) => b.has(t)) || [...b].every((t) => a.has(t));
  // Exact token-set equality, or one title's tokens fully contained in the
  // other's with a high overlap — covers "Sr. Product Designer" vs
  // "Senior Product Designer" and "Product Designer, AI" vs "AI Product Designer".
  if (jaccard === 1) return 1;
  if (subset && inter >= Math.max(2, Math.min(a.size, b.size) - 1)) return 0.9 + jaccard / 100;
  return jaccard;
}

const MATCH_THRESHOLD = 0.82;

// ── ATS rungs (public, no-auth JSON) ─────────────────────────────────────

const BOARDS = [
  {
    ats: 'greenhouse',
    probe: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    pick: (j) => (j.jobs || []).map((x) => ({ title: x.title, url: x.absolute_url, location: x.location?.name, posted: x.updated_at })),
  },
  {
    ats: 'ashby',
    probe: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
    pick: (j) => (j.jobs || []).map((x) => ({ title: x.title, url: x.jobUrl, location: x.location, posted: x.publishedAt })),
  },
  {
    ats: 'lever',
    probe: (s) => `https://api.lever.co/v0/postings/${s}`,
    pick: (j) => (Array.isArray(j) ? j : []).map((x) => ({ title: x.text, url: x.hostedUrl || x.applyUrl, location: x.categories?.location, posted: x.createdAt })),
  },
  {
    ats: 'workable',
    probe: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    pick: (j) => (j.jobs || []).map((x) => ({ title: x.title, url: x.url || x.application_url, location: x.location, posted: x.published_at })),
  },
  // ── second tier, added after a first test run left one employer unresolved: its
  //    board is Pinpoint, which the original four-rung ladder did not know
  //    about. All four below are public, zero-auth tenant feeds; endpoints and
  //    response shapes are taken from the repo's own providers/ modules so the
  //    two cannot drift (providers/pinpoint.mjs, smartrecruiters.mjs,
  //    recruitee.mjs, breezy.mjs, rippling.mjs).
  {
    ats: 'pinpoint',
    probe: (s) => `https://${s}.pinpointhq.com/postings.json`,
    pick: (j) => (j.data || []).map((x) => ({ title: x.title, url: x.url, location: x.location?.name, posted: x.published_at })),
  },
  {
    ats: 'smartrecruiters',
    probe: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
    // `ref` is an api.* URL; the public board resolves by id alone, and the
    // trailing title slug is cosmetic (providers/smartrecruiters.mjs #1612).
    pick: (j, s) => (j.content || []).map((x) => {
      const slug = (x.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return { title: x.name, url: `https://jobs.smartrecruiters.com/${s}/${x.id}-${slug}`, location: x.location?.fullLocation, posted: x.releasedDate };
    }),
  },
  {
    ats: 'recruitee',
    probe: (s) => `https://${s}.recruitee.com/api/offers/`,
    pick: (j) => {
      const items = Array.isArray(j) ? j : j?.offers || [];
      return items.map((x) => ({ title: x.title, url: x.url || x.careers_url || x.application_url, location: x.city, posted: x.published_at }));
    },
  },
  {
    ats: 'breezy',
    probe: (s) => `https://${s}.breezy.hr/json`,
    pick: (j) => (Array.isArray(j) ? j : []).map((x) => ({ title: x.title, url: x.url, location: x.location?.name, posted: x.published_at })),
  },
  {
    ats: 'rippling',
    probe: (s) => `https://ats.rippling.com/api/v2/board/${s}/jobs?pageSize=1000`,
    pick: (j) => (j.items || []).map((x) => ({ title: x.name, url: x.url, location: (x.locations || [])[0]?.name, posted: x.publishedDate })),
  },
];

/** Employer career-page paths, most conventional first. Kept short on purpose —
 *  see the request-budget note in tryCareersPage(). */
const CAREERS_PATHS = ['/careers', '/jobs', '/careers/jobs'];

// ── resolver ─────────────────────────────────────────────────────────────

const ctx = makeHttpCtx();

async function tryBoard(company, targetTitle) {
  // NOTE: every (slug, vendor) pair is tried. An earlier version returned as
  // soon as a board listed ANY job, which meant a company with boards on two
  // vendors only ever got the first one probed — one employer's Pinpoint board is a
  // UK-only marketing/DEI board, so its India design roles were never
  // looked for on the vendor that actually carries them.
  const boardsSeen = [];
  for (const slug of slugCandidates(company)) {
    for (const b of BOARDS) {
      let payload;
      try {
        payload = await ctx.fetchJson(b.probe(slug), { timeout: 12000, headers: { 'user-agent': UA, accept: 'application/json' } });
      } catch {
        continue; // 404 / unreachable / blocked — try the next rung silently
      }
      const jobs = b.pick(payload || {}, slug);
      if (!jobs.length) continue;
      boardsSeen.push({ board: `${b.ats}:${slug}`, count: jobs.length });
      let best = null;
      for (const j of jobs) {
        if (!j.url || !/^https?:\/\//i.test(j.url)) continue;
        const s = titleScore(targetTitle, j.title);
        if (s >= MATCH_THRESHOLD && (!best || s > best.score)) best = { ...j, score: s, ats: b.ats };
      }
      if (best) return { url: normalizeUrl(best.url) || best.url, ats: best.ats, matchedTitle: best.title, score: Number(best.score.toFixed(2)), via: `${b.ats} board (slug "${slug}")`, boardsSeen };
    }
  }
  // No title match anywhere, but we did reach real boards — that is the most
  // useful thing to tell the user about why a row is unresolved.
  if (boardsSeen.length) {
    return { boardsSeen, boardFound: boardsSeen.map((b) => `${b.board} (${b.count} postings)`).join('; ') };
  }
  return null;
}

async function tryCareersPage(company, targetTitle) {
  // Request budget matters. An earlier version tried 3 slugs x 4 TLDs x 6 paths
  // = up to 72 fetches for ONE unresolved company, which is neither polite to
  // the employer's site nor fast. This is 2 hosts x 3 paths x 3 slugs = 18
  // worst case, and the common case exits on the first hit. A company whose
  // site is not on one of these hosts is reported unresolved, not guessed at.
  const domains = [];
  for (const slug of slugCandidates(company)) {
    domains.push(`https://www.${slug}.com`, `https://${slug}.com`);
  }
  const PATHS = ['/careers', '/jobs', '/careers/jobs'];
  for (const base of domains) {
    for (const p of PATHS) {
      let html;
      try {
        html = await ctx.fetchText(base + p, { timeout: 10000, maxBytes: 400000, headers: { 'user-agent': UA } });
      } catch {
        continue;
      }
      if (!html || html.length < 500) continue;
      // Anchors whose visible text looks like the target title, and whose href
      // is on a job-ish path. Read from the page — never constructed.
      const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)];
      let best = null;
      for (const [, href, inner] of anchors) {
        const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 160) continue;
        if (!/\/(job|jobs|career|vacanc|position|opening|opportunit)/i.test(href)) continue;
        let abs;
        try { abs = new URL(href, base + p).href; } catch { continue; }
        const s = titleScore(targetTitle, text);
        if (s >= MATCH_THRESHOLD && (!best || s > best.score)) best = { url: abs, matchedTitle: text, score: s };
      }
      if (best) return { url: normalizeUrl(best.url) || best.url, ats: guessAts(best.url), matchedTitle: best.matchedTitle, score: Number(best.score.toFixed(2)), via: `employer careers page ${base + p}` };
    }
  }
  return null;
}

/**
 * Last HTML rung before declaring failure: render the careers page with the
 * repo's LOCAL Playwright and read the anchors from the live DOM. This is not
 * the MCP and needs no MCP server — verified 2026-09-26 that local Chromium
 * launches. It exists because many employer career pages (and most SPAs) ship
 * zero job links in their server HTML, which is why the plain fetch above
 * misses them. Strictly read-only: navigate and read, no clicks, no forms.
 *
 * Bounded on purpose: rendering is the most expensive rung, so it only runs for
 * companies that have not already been resolved, and the caller caps how many
 * rows may reach it.
 */
let pw = null;
async function getPlaywright() {
  if (pw !== null) return pw;
  try { pw = (await import('playwright')).chromium; } catch { pw = false; }
  return pw;
}

async function tryRenderedCareersPage(company, targetTitle) {
  const chromium = await getPlaywright();
  if (!chromium) return { skipped: 'playwright unavailable' };
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) { return { skipped: `playwright launch failed: ${e.message.slice(0, 60)}` }; }

  try {
    for (const slug of slugCandidates(company)) {
      for (const host of [`https://www.${slug}.com`, `https://${slug}.com`]) {
        for (const p of ['/careers', '/jobs', '/careers/jobs']) {
          const page = await browser.newPage();
          try {
            await page.goto(host + p, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const anchors = await page.evaluate(() =>
              [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim() })));
            let best = null;
            for (const { href, text } of anchors) {
              if (!text || text.length > 160) continue;
              if (!/\/(job|jobs|career|vacanc|position|opening|opportunit)/i.test(href)) continue;
              const s = titleScore(targetTitle, text);
              if (s >= MATCH_THRESHOLD && (!best || s > best.score)) best = { url: href, matchedTitle: text, score: s };
            }
            if (best) return { url: normalizeUrl(best.url) || best.url, ats: guessAts(best.url), matchedTitle: best.matchedTitle, score: Number(best.score.toFixed(2)), via: `rendered careers page ${host + p} (local Playwright)` };
          } catch { /* page unreachable — next candidate */ }
          finally { await page.close().catch(() => {}); }
        }
      }
    }
    return { skipped: 'no title-matched link in any rendered careers page' };
  } finally {
    await browser.close().catch(() => {});
  }
}

function guessAts(url) {
  const h = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (/greenhouse/.test(h)) return 'greenhouse';
  if (/lever/.test(h)) return 'lever';
  if (/ashbyhq/.test(h)) return 'ashby';
  if (/workable/.test(h)) return 'workable';
  if (/myworkdayjobs/.test(h)) return 'workday';
  if (/smartrecruiters/.test(h)) return 'smartrecruiters';
  if (/bamboohr/.test(h)) return 'bamboohr';
  if (/workdayjobs/.test(h)) return 'workday';
  return 'employer';
}

async function resolveOne(opp, { useBrowser = false } = {}) {
  // Already canonical (came from an ATS/board feed) — nothing to do.
  if (opp.url && opp.url !== '-' && /^https?:\/\//i.test(opp.url)) {
    return { ...opp, resolved: true, canonical: normalizeUrl(opp.url) || opp.url, ats: guessAts(opp.url), via: 'source already carried a URL', matchedTitle: opp.title, score: 1 };
  }

  const board = await tryBoard(opp.company, opp.title);
  if (board?.url) return { ...opp, resolved: true, canonical: board.url, ats: board.ats, matchedTitle: board.matchedTitle, score: board.score, via: board.via, boardsSeen: board.boardsSeen };
  const boardNote = board?.boardFound ? `reached a real board but no title match — ${board.boardFound}` : null;

  const careers = await tryCareersPage(opp.company, opp.title);
  if (careers?.url) return { ...opp, resolved: true, canonical: careers.url, ats: careers.ats, matchedTitle: careers.matchedTitle, score: careers.score, via: careers.via };

  if (useBrowser) {
    const rendered = await tryRenderedCareersPage(opp.company, opp.title);
    if (rendered?.url) return { ...opp, resolved: true, canonical: rendered.url, ats: rendered.ats, matchedTitle: rendered.matchedTitle, score: rendered.score, via: rendered.via };
    return {
      ...opp, resolved: false, canonical: null,
      reason: [
        boardNote || 'no public ATS board resolved from the company name',
        'no title-matched link in the server-rendered careers HTML',
        `rendered-DOM pass: ${rendered?.skipped || 'no match'}`,
      ].join('; '),
    };
  }

  return {
    ...opp,
    resolved: false,
    canonical: null,
    reason: boardNote
      ? `${boardNote}; no title-matched link on the employer careers pages tried`
      : 'no public ATS board or reachable careers page produced a title-matched posting for this company',
  };
}

// ── dedup AFTER resolution ───────────────────────────────────────────────

function dedupeKey(o) {
  if (o.canonical) return 'url:' + o.canonical;
  return 'ct:' + normCompany(o.company) + '|' + titleTokens(o.title).sort().join(' ');
}

function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = dedupeKey(r);
    if (!byKey.has(k)) byKey.set(k, { ...r, sources: [r.source], mergedFrom: 1 });
    else {
      const e = byKey.get(k);
      e.mergedFrom++;
      if (r.source && !e.sources.includes(r.source)) e.sources.push(r.source);
      // Prefer a resolved row, and a row with a real location, as the survivor.
      if (!e.resolved && r.resolved) Object.assign(e, r, { sources: e.sources, mergedFrom: e.mergedFrom });
    }
  }
  return [...byKey.values()];
}

// ── main ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

if (!arg('--in')) {
  console.error('Usage: node resolve-job-url.mjs --in <opps.tsv> [--out resolved.json] [--limit N]');
  process.exit(1);
}

// Header-driven mapping. A positional reader silently mis-assigns when a file
// grows a column — which is exactly the bug that made the first test run read 0
// rows, because `url` sat at index 4 and `source` at 5, not 3 and 4.
const CANON_COLS = ['company', 'title', 'location', 'country_group', 'url', 'source'];

function parseTsv(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const name of CANON_COLS) {
    const i = head.indexOf(name);
    if (i >= 0) idx[name] = i;
  }
  // Fall back to the documented order only if the header is unrecognisable.
  const positional = !idx.company || !idx.title;
  return lines.slice(1).map((line) => {
    const c = line.split('\t');
    const get = (n, i) => (positional ? c[i] : c[idx[n] ?? -1])?.trim();
    return {
      company: get('company', 0),
      title: get('title', 1),
      location: get('location', 2),
      countryGroup: get('country_group', 3),
      url: get('url', 4) || '-',
      source: get('source', 5) || 'unknown',
    };
  }).filter((o) => o.company && o.title);
}

const raw = parseTsv(readFileSync(arg('--in'), 'utf8'));

const limit = Number(arg('--limit', 0)) || raw.length;
const queue = raw.slice(0, limit);

console.log(`Resolving ${queue.length} opportunities (search-index rows without a canonical URL)…\n`);

// The rendered-DOM rung is opt-in and bounded: it is the most expensive rung,
// so it only runs for rows still unresolved after the cheap rungs, up to
// --browser-cap of them. Without the flag the script stays pure HTTP.
const useBrowser = has('--browser');
const browserCap = Number(arg('--browser-cap', 12)) || 12;
let browserBudget = browserCap;

// ── checkpoint / resume ─────────────────────────────────────────────────
// The output file is rewritten after EVERY row, not once at the end. A run
// over ~100 companies takes tens of minutes, and a single end-of-run write
// means a closed laptop or a killed process throws away every row already
// resolved — which is the work that costs the most. One small file write per
// company is cheap by comparison.
//
// --resume reloads that file and skips rows already present AND resolved, so
// the next run spends requests only on what is genuinely still open.
// Unresolved rows are deliberately NOT skipped: their reason may have changed
// (a new posting, a board that came back), and re-probing one row is cheap
// next to re-probing all of them.
const outPath = arg('--out');
const resume = has('--resume');
let out = [];
const doneKeys = new Set();

/** Identity of one INPUT row — company + title + the url it arrived with.
 *  Deliberately not the canonical URL: the point of --resume is to skip work
 *  already done for a given input row, and a row that resolved to a URL has
 *  already been paid for. */
const rowKey = (o) => `${o.company}|${o.title}|${o.url || ''}`;

if (outPath && resume && existsSync(outPath)) {
  try {
    const prev = JSON.parse(readFileSync(outPath, 'utf8'));
    if (Array.isArray(prev)) {
      out = prev;
      for (const r of out) if (r.resolved) doneKeys.add(rowKey(r));
      console.log(`Resuming: ${out.length} rows already on disk, ${doneKeys.size} resolved and skippable.\n`);
    }
  } catch (e) {
    console.log(`Could not read ${outPath} for resume (${e.message.slice(0, 60)}) — starting fresh.\n`);
  }
}

function checkpoint() {
  if (!outPath) return;
  try { writeFileSync(outPath, JSON.stringify(out, null, 2)); }
  catch (e) { console.log(`  ! checkpoint write failed: ${e.message.slice(0, 60)}`); }
}

let skipped = 0;
for (const [i, opp] of queue.entries()) {
  if (resume && doneKeys.has(rowKey(opp))) {
    skipped++;
    console.log(`  [${String(i + 1).padStart(3)}/${queue.length}] ${`${opp.company} — ${opp.title}`.slice(0, 74).padEnd(76)}↷ skipped (already resolved)`);
    continue;
  }
  const allowBrowser = useBrowser && browserBudget > 0;
  const r = await resolveOne(opp, { useBrowser: allowBrowser });
  if (allowBrowser && !r.resolved) browserBudget--;
  const priorIdx = out.findIndex((x) => rowKey(x) === rowKey(opp));
  if (priorIdx >= 0) out[priorIdx] = r; else out.push(r);
  checkpoint();
  const label = `${opp.company} — ${opp.title}`.slice(0, 74).padEnd(76);
  console.log(`  [${String(i + 1).padStart(3)}/${queue.length}] ${label}` + (r.resolved ? `✓ ${r.ats}` : '✗ unresolved'));
  await sleep(220); // be a polite API citizen
}
if (skipped) console.log(`\n  (${skipped} rows skipped as already resolved — this is what makes a re-run cheap)\n`);
checkpoint();

const merged = dedupe(out);
const resolved = merged.filter((m) => m.resolved);
const unresolved = merged.filter((m) => !m.resolved);
const rate = ((resolved.length / merged.length) * 100).toFixed(1);

console.log(`\n${'='.repeat(74)}`);
console.log(`RESOLUTION SUMMARY (deduped after resolution)`);
console.log(`${'='.repeat(74)}`);
console.log(`  input rows              ${queue.length}`);
console.log(`  unique after merge      ${merged.length}`);
console.log(`  canonical URLs resolved ${resolved.length}  (${rate}%)`);
console.log(`  unresolved              ${unresolved.length}`);
console.log(`  rows merged             ${queue.length - merged.length}`);

const bySource = {};
for (const m of merged) for (const s of m.sources) { bySource[s] ??= { res: 0, unres: 0 }; bySource[s][m.resolved ? 'res' : 'unres']++; }
console.log(`\n  BY SOURCE`);
for (const [s, v] of Object.entries(bySource).sort((a, b) => (b[1].res + b[1].unres) - (a[1].res + a[1].unres))) {
  const tot = v.res + v.unres;
  console.log(`    ${s.padEnd(14)} ${String(v.res).padStart(3)}/${String(tot).padEnd(3)} resolved  ${((v.res / tot) * 100).toFixed(0)}%`);
}

const isIndia = (m) => /india|bengaluru|bangalore|hyderabad|mumbai|pune|delhi|noida|gurgaon|gurugram|chennai|kolkata|ahmedabad|jaipur/i.test(`${m.location || ''} ${m.company || ''}`);
const ind = merged.filter(isIndia);
const indRes = ind.filter((m) => m.resolved);
console.log(`\n  INDIA vs GLOBAL`);
console.log(`    India   ${String(indRes.length).padStart(3)}/${String(ind.length).padEnd(3)} resolved  ${ind.length ? ((indRes.length / ind.length) * 100).toFixed(0) : 0}%`);
console.log(`    Global  ${String(resolved.length - indRes.length).padStart(3)}/${String(merged.length - ind.length).padEnd(3)} resolved  ${merged.length - ind.length ? (((resolved.length - indRes.length) / (merged.length - ind.length)) * 100).toFixed(0) : 0}%`);

// The checkpoint written above holds the PER-ROW records, which is what
// --resume reads back. The deduped view goes to a sibling file instead of
// overwriting it — writing `merged` back to --out would collapse rows, and the
// next --resume would then match nothing and redo the whole run.
if (outPath) {
  const dedupPath = outPath.replace(/\.json$/, '') + '.deduped.json';
  writeFileSync(dedupPath, JSON.stringify(merged, null, 2));
  console.log(`\n  checkpoint (resumable) : ${outPath}`);
  console.log(`  deduped view          : ${dedupPath}`);
}
console.log('');
