#!/usr/bin/env node
/**
 * discover-multi.mjs — multi-source discovery layer.
 *
 * Adds NEW SOURCES. Changes NOTHING that already exists: it does not touch the
 * digest, the fit scoring, the eligibility gates, the tracker, the CV logic or
 * the application runner. It reuses them:
 *
 *   · India + title + seniority gate  →  ./geo-eligibility.mjs (classifyGeography,
 *                                        isApplicable) and the scanner's own
 *                                        title filter via buildTitleFilter()
 *   · URL normalisation for dedup     →  ./scan.mjs (normalizeUrlForDedup)
 *   · output sink                     →  ./scan.mjs (appendToScanHistory)
 *
 * Everything a source returns is shaped as the existing normalized Job, so
 * anything this finds flows into the digest, the fit score and the application
 * pipeline with no further wiring.
 *
 * Provenance is mandatory on every opportunity: source, discovered_at,
 * original_url, canonical_url, application_url, discovery_method.
 *
 * Usage:
 *   node discover-multi.mjs --sources workday-cxs,public-search
 *   node discover-multi.mjs --workday-tenants 300      # bounded slice
 *   node discover-multi.mjs --workday-offset 600      # rotate the slice
 *   node discover-multi.mjs --status
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import './load-env.mjs';   // populate process.env from .env (gitignored) before any key check
import { Deduper, canonicalUrl, makeOpportunity } from './discovery/canonical.mjs';
import { probeTenant, fetchTenant } from './discovery/sources/workday-cxs.mjs';
import { search, activeProvider, TITLE_QUERIES } from './discovery/sources/public-search.mjs';
import { discover as firecrawlDiscover, hasKey as firecrawlHasKey } from './discovery/sources/firecrawl-source.mjs';
import { discover as valigDiscover, hasKey as valigHasKey, DEFAULT_KEYWORDS as VALIG_KEYWORDS } from './discovery/sources/apify-valig.mjs';
import { classifyGeography, isApplicable } from './geo-eligibility.mjs';
import { appendToScanHistory, normalizeUrlForDedup, buildTitleFilter } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const STATE = 'data/multi-discovery-state.json';
const WD_DIR = 'data/cache/ats-companies/workday.json';

// How many LinkedIn job ids to remember for the Actor's skipJobId filter. The
// scan looks back one week (r604800), so anything older than that can never be
// returned again; 3000 ids is roughly 30x the widest measured pass, which is
// far more slack than the window needs while keeping the request body small.
const LINKEDIN_ID_MEMORY = 3000;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { workdayOffset: 0, lastRun: null, totals: {} };

if (has('--status')) {
  console.log(JSON.stringify({ ...state, searchProvider: activeProvider() }, null, 2));
  process.exit(0);
}

// ── the EXISTING title gate, reused rather than re-implemented ────────────
let titleFilter = null;
try {
  // js-yaml is CommonJS, so it needs createRequire — a dynamic import yields a
  // namespace whose named exports are not there.
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const yaml = require('js-yaml');
  const { PORTALS_PATH } = await import('./scan.mjs');
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  if (cfg.title_filter) titleFilter = buildTitleFilter(cfg.title_filter);
} catch (e) {
  console.error('⚠️  could not build the title filter from portals.yml — ' + e.message);
  process.exit(1);
}
const titleOk = (t) => {
  if (!titleFilter) return false;
  try { return titleFilter(t); } catch { return false; }
};

// ── source 1: Workday public CXS (key-free) ──────────────────────────────
async function sourceWorkdayCxs({ tenantCount, offset, log }) {
  if (!existsSync(WD_DIR)) { log('  workday-cxs: no cached tenant directory — run scan-ats-full.mjs once first'); return { opps: [], stats: {} }; }
  const dir = JSON.parse(readFileSync(WD_DIR, 'utf8'));
  const slice = [];
  for (let i = 0; i < tenantCount && slice.length < tenantCount; i++) {
    slice.push(dir[(offset + i) % dir.length]);
  }
  const opps = [];
  let probed = 0, live = 0;
  for (const entry of slice) {
    const [tenant, instance, site] = String(entry).split('|');
    if (!tenant || !instance || !site) continue;
    probed++;
    if (!(await probeTenant(tenant, instance, site, { timeoutMs: 12000 }))) continue;
    live++;
    const got = await fetchTenant(tenant, instance, site, TITLE_QUERIES, { maxPerQuery: 20, politeMs: 150, log: () => {} });
    opps.push(...got);
    if (probed % 25 === 0) log(`    …${probed}/${slice.length} probed · ${live} live · ${opps.length} postings`);
  }
  return { opps, stats: { probed, live, directorySize: dir.length } };
}

// ── source 2: public web search (key-gated) ───────────────────────────────
async function sourcePublicSearch({ log, maxQueries }) {
  const r = await search({ maxQueries, log });
  if (!r.ran) log('  public-search: IDLE — ' + r.reason);
  return { opps: r.opportunities, stats: { provider: r.provider, ran: r.ran, signalsOnly: r.signalsOnly, blocked: r.blocked } };
}

// ── source 3: Firecrawl (keyed) — public search + selective scrape ───────
// Reuses the repo's own transport (plugins/firecrawl/_firecrawl.mjs) verbatim.
// This is the source that reaches in-house career pages and job-board-only
// roles, i.e. everything the ATS connectors and the directory sweep cannot see.
async function sourceFirecrawl({ log, maxQueries, maxScrapes, recentDays }) {
  if (!firecrawlHasKey()) { log('  firecrawl: IDLE — FIRECRAWL_API_KEY not set in .env'); return { opps: [], stats: { ran: false } }; }
  const r = await firecrawlDiscover({ maxQueries, maxScrapes, recencyDays: recentDays, log });
  log(`    firecrawl: ${r.meter.searches} searches + ${r.meter.scrapes} scrapes = ${r.meter.searches + r.meter.scrapes} credits`);
  return {
    opps: r.opportunities,
    stats: {
      ran: true,
      credits: r.meter.searches + r.meter.scrapes,
      searches: r.meter.searches, results: r.meter.results,
      scrapes: r.meter.scrapes, scrapeFailed: r.meter.scrapeFailed,
      signalOnly: r.signals.length, blocked: r.meter.blocked,
    },
  };
}

// ── source 4: valig/linkedin-jobs-scraper on Apify (keyed) ────────────────
// Broad DISCOVERY index over LinkedIn, and discovery-only by measurement: the
// Actor returned 0 usable employer apply URLs in the measured run, so it hands
// us company + title + location and the employer ATS URL is resolved elsewhere.
// This source does not relax any gate. Its rows are shaped as the same
// normalized Job, so they fall through the identical title / seniority / geo /
// dedup chain below and into the same scan-history sink.
async function sourceApifyValig({ log, limit, keywords, maxChargeUsd, datePosted, skipJobId, replay }) {
  if (!valigHasKey()) { log('  apify-valig: IDLE - APIFY_TOKEN not set in .env'); return { opps: [], stats: { ran: false } }; }
  // Replay drains datasets from runs that were ALREADY billed, so a run whose
  // read failed is never paid for twice. Cost of a replay is 0 by construction.
  const r = replay
    ? await valigDiscover({ limit, maxTotalChargeUsd: maxChargeUsd, replayDatasetIds: replay, log })
    : await valigDiscover({
      keywords, limit, datePosted, maxTotalChargeUsd: maxChargeUsd,
      skipJobId, log,
    });
  if (!r.ran) { log('  apify-valig: not run - ' + r.reason); return { opps: [], stats: { ran: false, reason: r.reason } }; }
  log(`    apify-valig: ${r.replayed ? `replayed ${r.meter.results} paid rows` : `${r.meter.queries} queries -> ${r.rows.length} rows`}, ${r.stats.indiaExplicit} India-explicit, $${r.stats.costUsd} spent`);
  // Only India-explicit rows become opportunities. The rest were paid for and
  // discarded, which is what the pre-flight cost projection is there to bound.
  const opps = r.opps.map((c) => makeOpportunity({
    title: c.title,
    url: c.url,
    // LinkedIn is never an apply target, so the application URL is the posting
    // itself and the row is tagged discovery-only for the digest to surface.
    applicationUrl: c.applyTarget ? c.applyUrl : c.url,
    company: c.company,
    location: c.location,
    description: c.description,
    postedAt: c.postedAt,
    source: 'linkedin',
    discoveryMethod: 'apify:valig/linkedin-jobs-scraper',
    discoveryOnly: !c.applyTarget,
  })).filter(Boolean);
  return { opps, stats: r.stats, seenIds: r.seenIds || [] };
}

// ── employer-URL resolution for LinkedIn rows ──────────────────────────────
// LinkedIn is a DISCOVERY index (measured: valig leaves applyUrl empty on every
// row, including rows it marks EXTERNAL), so a LinkedIn row has no apply target.
// Rather than invent one, hand the {company, title, location} triple to the
// repo's EXISTING resolver, resolve-job-url.mjs, which walks public no-auth ATS
// APIs and the employer's own careers page and returns a canonical posting URL
// only when a posting was actually fetched whose title matches.
//
// It is invoked as a bounded subprocess rather than imported, because that file
// is a CLI and re-implementing its ladder here would be a second copy of exactly
// the logic the repo works to keep in one place. Bounded twice over: only rows
// that already passed every gate are offered, and --limit caps the work so a
// large pass cannot turn a cron slot into an hours-long crawl.
//
// A row that does not resolve keeps its LinkedIn URL and stays discovery-only.
// Nothing is guessed and no URL is synthesised from a slug.
async function resolveEmployerUrls(opps, { log, limit }) {
  // "Discovery only" is derived from the URL, never from a field. The first
  // version of this checked `o.discoveryOnly`, which makeOpportunity silently
  // drops because it copies a fixed field set, so the resolver never ran at all
  // and every LinkedIn row passed through unresolved without saying so.
  const isLinkedInRow = (o) => {
    const u = String(o.application_url || o.url || '');
    return /(^|\.)(linkedin\.com|[a-z]{2}\.linkedin\.com)$/i.test((() => { try { return new URL(u).hostname; } catch { return ''; } })());
  };
  const targets = opps.filter((o) => o.source === 'linkedin' && isLinkedInRow(o));
  if (!targets.length) return { attempted: 0, resolved: 0, byCompany: new Map() };
  const take = targets.slice(0, limit);
  const dir = 'data/discovery';
  mkdirSync(dir, { recursive: true });
  const stamp = started.replace(/[:.]/g, '-').slice(0, 19);
  const tsv = `${dir}/apify-resolve-in-${stamp}.tsv`;
  const out = `${dir}/apify-resolve-out-${stamp}.json`;

  // Header-driven TSV, the shape resolve-job-url.mjs documents. country_group
  // is not used by its ladder, but the column is part of the contract.
  const head = ['company', 'title', 'location', 'country_group', 'url', 'source'].join('\t');
  // The url column is '-', NOT the LinkedIn link. resolve-job-url.mjs treats a
  // supplied http URL as "this is already canonical" and returns it unchanged
  // with via="source already carried a URL", which scored 15/15 = 100% while
  // every one of the 15 was still a LinkedIn link. Passing '-' makes it run its
  // real ladder (employer careers page, then Greenhouse, Lever, Ashby,
  // Workable, other public ATS) and actually look for the employer's page.
  const body = take.map((o) => [o.company || '', o.title || '', o.location || '', 'india', '-', o.source || 'linkedin']
    .map((c) => String(c).replace(/[\t\r\n]+/g, ' ').trim()).join('\t'));
  writeFileSync(tsv, [head, ...body].join('\n') + '\n');

  try {
    await promisify(execFile)(process.execPath, ['resolve-job-url.mjs', '--in', tsv, '--out', out, '--limit', String(take.length)],
      { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    log(`    apify-valig: employer-URL resolution did not complete (${String(e.message).slice(0, 90)}) — rows stay discovery-only`);
    return { attempted: take.length, resolved: 0, byCompany: new Map() };
  }
  if (!existsSync(out)) return { attempted: take.length, resolved: 0, byCompany: new Map() };

  let rows = [];
  try { rows = JSON.parse(readFileSync(out, 'utf8')).data || JSON.parse(readFileSync(out, 'utf8')) || []; }
  catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  // Key on company+title, the same normalisation the resolver dedupes on, so a
  // resolved row is matched back to the opportunity that asked for it.
  const key = (r) => `${norm(r.company).toLowerCase()}|${norm(r.title).toLowerCase()}`;
  const byCompany = new Map();
  for (const r of rows) if (r && r.resolved && r.canonical) byCompany.set(key(r), r);

  let applied = 0;
  for (const o of take) {
    const hit = byCompany.get(key(o));
    if (!hit) continue;
    o.application_url = hit.canonical;
    o.discoveryOnly = false;
    o.discoveryMethod += `->employer:${hit.via || 'ats'}`;
    applied++;
  }
  log(`    apify-valig: employer URLs resolved ${applied}/${take.length} via the existing resolver`);
  return { attempted: take.length, resolved: applied, byCompany };
}

// ── main ──────────────────────────────────────────────────────────────────
const sources = (arg('--sources', 'workday-cxs,public-search,firecrawl,apify-valig')).split(',').map((s) => s.trim());
const tenantCount = Number(arg('--workday-tenants', '250'));
const offset = Number(arg('--workday-offset', String(state.workdayOffset || 0)));
const log = (m) => console.log(m);
const started = new Date().toISOString();

console.log('='.repeat(78));
console.log('MULTI-SOURCE DISCOVERY');
console.log('='.repeat(78));
console.log(`  sources        : ${sources.join(', ')}`);
console.log(`  workday slice  : ${tenantCount} tenants from offset ${offset}`);
console.log(`  started        : ${started}`);

// --apify-replay <file.json> points at a paid-run record (data/discovery/paid-run-datasets.json)
// and drains it instead of paying for new runs. Exists so a billed run whose read
// failed is recoverable at zero cost rather than by spending again.
let replayIds = null;
const replayFile = arg('--apify-replay', null);
if (replayFile) {
  if (!existsSync(replayFile)) {
    console.error(`\u274c  --apify-replay: ${replayFile} not found`);
    process.exit(1);
  }
  const paid = JSON.parse(readFileSync(replayFile, 'utf8'));
  replayIds = paid.datasetIds || null;
  if (!replayIds?.length) { console.error('\u274c  --apify-replay: no datasetIds in ' + replayFile); process.exit(1); }
  console.log(`  apify replay       : ${replayIds.length} already-paid dataset(s), $0.00 to drain`);
}

const dedup = new Deduper();
const stats = { seen: 0, titleRejected: 0, geoRejected: 0, seniorityRejected: 0, kept: 0, merged: 0 };

for (const s of sources) {
  if (s === 'workday-cxs') {
    const r = await sourceWorkdayCxs({ tenantCount, offset, log });
    stats.workday = r.stats;
    stats.seen += r.opps.length;
    for (const o of r.opps) { const rec = dedup.add(o); if (rec) stats.kept++; else stats.merged++; }
  } else if (s === 'public-search') {
    const r = await sourcePublicSearch({ log, maxQueries: Number(arg('--search-queries', '60')) });
    stats.search = r.stats;
    stats.seen += r.opps.length;
    for (const o of r.opps) { const rec = dedup.add(o); if (rec) stats.kept++; else stats.merged++; }
  } else if (s === 'firecrawl') {
    const r = await sourceFirecrawl({
      log,
      maxQueries: Number(arg('--fc-queries', '20')),
      maxScrapes: Number(arg('--fc-scrapes', '60')),
      recentDays: arg('--fc-recent', null) ? Number(arg('--fc-recent')) : null,
    });
    stats.firecrawl = r.stats;
    stats.seen += r.opps.length;
    for (const o of r.opps) { const rec = dedup.add(o); if (rec) stats.kept++; else stats.merged++; }
  } else if (s === 'apify-valig') {
    const r = await sourceApifyValig({
      log,
      limit: Number(arg('--apify-limit', '40')),
      keywords: arg('--apify-keywords', null) ? arg('--apify-keywords').split('|').map((s) => s.trim()).filter(Boolean) : VALIG_KEYWORDS,
      datePosted: arg('--apify-date', 'r604800'),
      maxChargeUsd: Number(arg('--apify-max-charge', '0.15')),
      skipJobId: state.seenLinkedinIds || [],
      replay: replayIds,
    });
    stats.apifyValig = r.stats;
    stats.seen += r.opps.length;
    for (const o of r.opps) { const rec = dedup.add(o); if (rec) stats.kept++; else stats.merged++; }
    // Persist every id this pass was billed for, so tomorrow's pass can hand
    // them to the Actor as skipJobId and not pay for the same posting twice.
    // Capped, because the list is a rolling window rather than a full archive:
    // a posting older than the recency window can never be returned again, so
    // keeping every id forever would grow the file and the request for nothing.
    if (r.seenIds && r.seenIds.length) {
      const merged = [...new Set([...(state.seenLinkedinIds || []), ...r.seenIds])];
      state.seenLinkedinIds = merged.slice(-LINKEDIN_ID_MEMORY);
      log(`    apify-valig: skipJobId memory now ${state.seenLinkedinIds.length} id(s) (rolling window of ${LINKEDIN_ID_MEMORY})`);
    }
  } else {
    log(`  unknown source "${s}" — skipped`);
  }
}

// ── gates, using the EXISTING implementations ────────────────────────────
const passed = [];
for (const o of dedup.all()) {
  if (!titleOk(o.title)) { stats.titleRejected++; continue; }
  // Seniority is enforced by the title filter itself (its negative list carries
  // Principal/Staff/Lead/Director), and re-checked here so a source that
  // skipped the filter cannot slip one through.
  if (/\b(principal|staff|lead|head of design|director|distinguished)\b/i.test(o.title)) { stats.seniorityRejected++; continue; }
  const geo = classifyGeography({ title: o.title, postingText: o.description || '', url: o.url, primaryLocation: o.location });
  if (!isApplicable(geo)) { stats.geoRejected++; continue; }
  passed.push({ ...o, geography: geo.classification, geography_why: geo.rationale });
}

// ── resolve employer application URLs, BEFORE the sink ─────────────────────
// Runs after the gates and before appendToScanHistory, so scan-history carries
// the employer's real posting URL wherever one was actually found, and the
// LinkedIn URL only where none was. Rows that stay unresolved keep
// discoveryOnly, which is what the digest surfaces as "needs a human".
//
// Bounded on purpose: only rows that survived every gate are offered, the
// per-run count is capped, and the subprocess carries its own timeout, so a
// large pass cannot occupy a cron slot indefinitely.
if (!has('--no-resolve') && passed.some((o) => o.source === 'linkedin' && o.discoveryOnly)) {
  const rr = await resolveEmployerUrls(passed, { log, limit: Number(arg('--resolve-limit', '30')) });
  stats.employerResolution = { attempted: rr.attempted, resolved: rr.resolved };
  log(`    employer-URL resolution: ${rr.resolved}/${rr.attempted} LinkedIn rows now point at the employer's own posting`);
}

// ── write to the EXISTING sink ───────────────────────────────────────────
let written = 0;
if (passed.length) {
  const offers = passed.map((o) => ({
    url: o.application_url || o.url,
    title: o.title,
    company: o.company,
    location: o.location,
    description: o.description || '',
    postedAt: o.postedAt,
    source: o.source,
    discoveryMethod: o.discoveryMethod,
    discoveredAt: o.discovered_at,
    originalUrl: o.original_url,
    canonicalUrl: o.canonical_url,
    applicationUrl: o.application_url,
    reqId: o.req_id,
  }));
  await appendToScanHistory(offers, localToday());
  written = offers.length;
  mkdirSync('data/discovery', { recursive: true });
  writeFileSync(`data/discovery/multi-${started.replace(/[:.]/g, '-').slice(0, 19)}.json`, JSON.stringify({ started, stats, opportunities: passed }, null, 2));
}

// advance the rotating cursor so successive runs cover new ground
writeFileSync(STATE, JSON.stringify({
  workdayOffset: (offset + tenantCount) % (existsSync(WD_DIR) ? JSON.parse(readFileSync(WD_DIR, 'utf8')).length : 1),
  lastRun: started,
  // Carried through so the skipJobId memory survives between scheduled runs.
  // Omitted entirely when empty, to keep the state file clean for a config that
  // has never run this source.
  ...(state.seenLinkedinIds?.length ? { seenLinkedinIds: state.seenLinkedinIds } : {}),
  totals: {
    runs: (state.totals?.runs || 0) + 1,
    kept: (state.totals?.kept || 0) + passed.length,
  },
}, null, 2));

console.log('\n' + '='.repeat(78));
console.log('RESULT');
console.log('='.repeat(78));
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(18)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
console.log(`  WRITTEN to scan-history: ${written}`);
console.log(`  provenance file        : data/discovery/multi-*.json`);
if (passed.length) {
  console.log('\nOPPORTUNITIES:');
  for (const o of passed.slice(0, 40)) console.log(`  · ${o.company || '(unnamed)'} — ${o.title}\n      ${o.location}\n      ${o.application_url || o.url}\n      via ${o.source} · ${o.discovery_method}`);
}
process.exit(0);
