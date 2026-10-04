#!/usr/bin/env node
/**
 * Apify LinkedIn Actor head-to-head — READ-ONLY ANALYSIS.
 *
 * Consumes raw datasets already fetched from Apify (data/discovery/apify-raw/)
 * and runs them through the EXISTING gates. It does not call Apify, does not
 * spend credits, and does not write to scan-history, the tracker, or any
 * production file. It imports the gate implementations rather than
 * reimplementing them:
 *
 *   · buildTitleFilter()  <- scan.mjs, built from portals.yml title_filter
 *   · classifyGeography() <- geo-eligibility.mjs
 *   · isApplicable()      <- geo-eligibility.mjs
 *   · Deduper / makeOpportunity() <- discovery/canonical.mjs
 *   · fit scoring is reported from the same signal the digest uses
 *
 * The gate ORDER and the gate SETTINGS are copied verbatim from
 * discover-multi.mjs lines 164-175 so the measured yield is what production
 * would actually keep. Nothing is relaxed for this test.
 *
 *   node apify-headtohead.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { classifyGeography, isApplicable } from './geo-eligibility.mjs';
import { Deduper, makeOpportunity } from './discovery/canonical.mjs';
import { buildTitleFilter, PORTALS_PATH } from './scan.mjs';

const RAW = 'data/discovery/apify-raw/apify-headtohead.json';
if (!existsSync(RAW)) {
  console.error('missing ' + RAW + ' — fetch the datasets first');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(RAW, 'utf8'));

// ── the EXISTING title gate, built exactly as discover-multi.mjs builds it ──
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
const titleFilter = buildTitleFilter(cfg.title_filter);
const titleOk = (t) => {
  if (!titleFilter) return false;
  try { return titleFilter(t); } catch { return false; }
};

// ── costs as actually billed by Apify (from the run records) ──────────────
const COST = {
  'valig_run1':      { items: 40, perResult: 0.0004, start: 0.001,  billed: 40, billedTotal: 0.017 },
  'valig_run2':      { items: 40, perResult: 0.0004, start: 0.001,  billed: 40, billedTotal: 0.017 },
  'curious_coder':   { items: 20, perResult: 0.002,  start: 0.00005, billed: 20, billedTotal: 0.04005 },
  'cheap_scraper':   { items: 150, perResult: 0.0007, start: 0.005, billed: 150, billedTotal: 0.110 },
  'aborted_probe':   { items: 0,  perResult: 0.002,  start: 0.00005, billed: 0, billedTotal: 0.00005 },
};

const ACTORS = [
  { key: 'valig_run1',    label: 'valig/linkedin-jobs-scraper',              run: 'run 1' },
  { key: 'valig_run2',    label: 'valig/linkedin-jobs-scraper',              run: 'run 2 (repeat)' },
  { key: 'curious_coder', label: 'curious_coder/linkedin-jobs-scraper',      run: 'fan-out IN' },
  { key: 'cheap_scraper', label: 'cheap_scraper/linkedin-job-scraper',       run: '20-city array' },
];

// ── measurement helpers, independent of the gate ──────────────────────────
// A location is India-explicit on its OWN terms: it names India or an Indian
// place. It must NOT be inferred from the company being Indian, so the company
// name and country are deliberately not inputs here.
const INDIA_LOC = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|new delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|cochin|indore|chandigarh|coimbatore|bhubaneswar|nagpur|vadodara|thiruvananthapuram|trivandrum|mysore|mysuru|mangaluru|manipal|trichy|tiruchirappalli|goa|panaji|guwahati|patna|ranchi|bhopal|thanjavur|kozhikode|secunderabad|hyderabad telangana|andhra pradesh|telangana|karnataka|maharashtra|tamil nadu|west bengal|gujarat|rajasthan|punjab|haryana|odisha|uttar pradesh|uttarakhand|madhya pradesh|himachal pradesh|assam|jharkhand|chhattisgarh|goa\b)/i;
const isLinkedInView = (u) => /linkedin\.com\/(jobs\/view|jobs\/search)/i.test(String(u || ''));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function measure(key) {
  const items = raw[key] || [];
  const out = {
    key,
    actor: ACTORS.find((a) => a.key === key)?.label || key,
    run: ACTORS.find((a) => a.key === key)?.run || '',
    raw: items.length,
    indiaExplicit: 0, indiaByCompanyOnly: 0, notIndia: 0,
    applyUrlPresent: 0, applyUrlDirect: 0, applyUrlIsLinkedIn: 0, applyUrlMissing: 0,
    passTitle: 0, passSeniority: 0, passGeo: 0, kept: 0,
    rejects: { title: 0, seniority: 0, geo: 0 },
    rejectSamples: { title: [], geo: [] },
    applyTypes: new Map(), companies: new Set(), locations: new Set(),
    rows: [],
  };

  const dedup = new Deduper();
  for (const it of items) {
    const loc = norm(it.location);
    const indiaLoc = INDIA_LOC.test(loc);
    if (indiaLoc) out.indiaExplicit++;
    else if (/india/i.test(norm(it.company) + ' ' + norm(it.country || ''))) out.indiaByCompanyOnly++;
    else out.notIndia++;

    const au = norm(it.applyUrl);
    if (au) {
      out.applyUrlPresent++;
      if (isLinkedInView(au)) out.applyUrlIsLinkedIn++;
      else out.applyUrlDirect++;
    } else out.applyUrlMissing++;
    if (norm(it.applyType)) out.applyTypes.set(norm(it.applyType), (out.applyTypes.get(norm(it.applyType)) || 0) + 1);
    if (norm(it.company)) out.companies.add(norm(it.company));
    if (norm(it.location)) out.locations.add(norm(it.location));

    const opp = makeOpportunity({
      title: norm(it.title),
      url: it.url,
      applicationUrl: au || it.url,
      company: norm(it.company),
      location: loc,
      description: it.desc || '',
      postedAt: it.posted,
      source: key,
      discoveryMethod: 'apify:' + key,
    });
    if (opp) dedup.add(opp);
  }

  out.afterDedup = dedup.all().length;
  out.mergedByDeduper = items.length - dedup.all().length;

  // ── the gate chain, copied from discover-multi.mjs 164-175 ──────────────
  for (const o of dedup.all()) {
    if (!titleOk(o.title)) { out.rejects.title++; if (out.rejectSamples.title.length < 6) out.rejectSamples.title.push(o.title); continue; }
    out.passTitle++;
    if (/\b(principal|staff|lead|head of design|director|distinguished)\b/i.test(o.title)) { out.rejects.seniority++; continue; }
    out.passSeniority++;
    const geo = classifyGeography({ title: o.title, postingText: o.description || '', url: o.url, primaryLocation: o.location });
    if (!isApplicable(geo)) {
      out.rejects.geo++;
      if (out.rejectSamples.geo.length < 6) out.rejectSamples.geo.push(o.title.slice(0, 46) + '  [' + geo.classification + '] ' + (geo.rationale || '').slice(0, 80));
      continue;
    }
    out.passGeo++;
    out.kept++;
    out.rows.push({ title: o.title, company: o.company, location: o.location, url: o.url, apply: o.application_url, why: geo.rationale });
  }
  return out;
}

const results = ACTORS.map((a) => measure(a.key));

// ── dedup stability: same search twice, compared on several identities ────
function stability() {
  const a = raw.valig_run1 || [], b = raw.valig_run2 || [];
  const key = (x) => norm(x.id);
  const urlKey = (x) => norm(x.url).split('?')[0].replace(/\/$/, '');
  const combo = (x) => [norm(x.company), norm(x.title), norm(x.location)].join('|').toLowerCase().replace(/[^a-z0-9| ]/g, '').replace(/\s+/g, ' ');
  const A = new Set(a.map(key)), B = new Set(b.map(key));
  const Au = new Set(a.map(urlKey)), Bu = new Set(b.map(urlKey));
  const Ac = new Set(a.map(combo)), Bc = new Set(b.map(combo));
  const inter = (s, t) => [...s].filter((x) => t.has(x));
  const union = (s, t) => new Set([...s, ...t]);
  const jacc = (s, t) => { const i = inter(s, t).length; const u = union(s, t).size; return u ? i / u : 0; };
  // how the repo's own identity behaves across the two runs
  const mk = (arr) => arr.map((x) => makeOpportunity({ title: norm(x.title), url: x.url, applicationUrl: norm(x.applyUrl) || x.url, company: norm(x.company), location: norm(x.location), description: x.desc || '', postedAt: x.posted, source: 'valig' })).filter(Boolean);
  const dA = new Deduper(), dB = new Deduper();
  for (const o of mk(a)) dA.add(o);
  for (const o of mk(b)) dB.add(o);
  const sA = new Set(dA.all().map((o) => o.identity || o.canonical_url));
  const sB = new Set(dB.all().map((o) => o.identity || o.canonical_url));
  return {
    n1: a.length, n2: b.length,
    idStable: inter(A, B).length, idJaccard: jacc(A, B),
    urlStable: inter(Au, Bu).length, urlJaccard: jacc(Au, Bu),
    comboStable: inter(Ac, Bc).length, comboJaccard: jacc(Ac, Bc),
    repoIdentityStable: inter(sA, sB).length, repoIdentityJaccard: jacc(sA, sB),
    onlyIn1: [...A].filter((x) => !B.has(x)).length,
    onlyIn2: [...B].filter((x) => !A.has(x)).length,
  };
}

// ── report ───────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const usd = (n) => '$' + Number(n).toFixed(5);
const L = (s = '', n = 78) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s);

console.log('='.repeat(100));
console.log('APIFY LINKEDIN ACTOR HEAD-TO-HEAD — raw results, then post-gate');
console.log('='.repeat(100));
console.log('Query for all three: keywords "Product Designer" · posted past week · India');
console.log('Gates: buildTitleFilter(portals.yml) → seniority → classifyGeography → isApplicable');
console.log('Nothing relaxed. Firecrawl, daily-scan.sh, discover-multi.mjs and the tracker untouched.\n');

const billed = Object.values(COST).reduce((s, c) => s + c.billedTotal, 0);
console.log('ACTUAL COST (from Apify run records, not estimates)');
console.log('-'.repeat(100));
for (const [k, c] of Object.entries(COST)) {
  if (!c.billed && !c.billedTotal) continue;
  console.log('  ' + k.padEnd(18) + L(k, 18) + '  billed items ' + String(c.billed).padStart(4) +
    '  @ ' + usd(c.perResult) + '  + start ' + usd(c.start) + '  = ' + usd(c.billedTotal));
}
console.log('  ' + 'TOTAL ACTUAL'.padEnd(18) + ' '.repeat(18) + '  ' + usd(billed));

console.log('\n' + '='.repeat(100));
console.log('1. RAW RESULTS');
console.log('='.repeat(100));
console.log('  ' + 'actor'.padEnd(42) + 'raw'.padStart(5) + 'India-exp'.padStart(11) + 'co-only'.padStart(9) + 'notIN'.padStart(7) + 'applyURL'.padStart(10) + 'direct'.padStart(8) + '→LinkedIn'.padStart(11));
for (const r of results) {
  console.log('  ' + L(r.actor, 42).padEnd(42) + String(r.raw).padStart(5) + pct(r.indiaExplicit, r.raw).padStart(11) +
    String(r.indiaByCompanyOnly).padStart(9) + String(r.notIndia).padStart(7) +
    String(r.applyUrlPresent).padStart(10) + String(r.applyUrlDirect).padStart(8) + String(r.applyUrlIsLinkedIn).padStart(11));
}
console.log('\n  India-exp = location field itself names India or an Indian place.');
console.log('  co-only  = India appears ONLY via the company, which does NOT count as eligible.');

console.log('\n' + '='.repeat(100));
console.log('2. POST-GATE RESULTS');
console.log('='.repeat(100));
console.log('  ' + 'actor'.padEnd(42) + 'raw'.padStart(5) + 'dedup'.padStart(7) + 'title'.padStart(7) + 'senior'.padStart(8) + 'geo'.padStart(6) + 'KEPT'.padStart(6) + 'cost/kept'.padStart(11));
for (const r of results) {
  const c = COST[r.key];
  console.log('  ' + L(r.actor, 42).padEnd(42) + String(r.raw).padStart(5) + String(r.afterDedup).padStart(7) +
    String(r.passTitle).padStart(7) + String(r.passSeniority).padStart(8) + String(r.passGeo).padStart(6) +
    String(r.kept).padStart(6) + (r.kept ? usd(c.billedTotal / r.kept) : 'n/a').padStart(11));
}
console.log('\n  cost/kept = actual billed USD divided by roles that survived every gate.');

for (const r of results) {
  console.log('\n' + '-'.repeat(100));
  console.log(L(r.actor, 60) + '  (' + r.run + ')');
  console.log('  rejects: title ' + r.rejects.title + ' · seniority ' + r.rejects.seniority + ' · geo ' + r.rejects.geo +
    ' · deduper merged ' + r.mergedByDeduper);
  console.log('  applyType mix : ' + ([...r.applyTypes.entries()].map(([k, v]) => k + '=' + v).join(', ') || 'field absent') +
    '   |   distinct companies: ' + r.companies.size + '   distinct locations: ' + r.locations.size);
  if (r.rejectSamples.title.length) console.log('  title-gate rejects: ' + r.rejectSamples.title.map((t) => '"' + L(t, 40) + '"').join(', '));
  if (r.rejectSamples.geo.length) console.log('  geo-gate rejects  :\n    ' + r.rejectSamples.geo.join('\n    '));
  console.log('  KEPT (' + r.kept + '):');
  for (const k of r.rows) console.log('    · ' + L(k.title, 46).padEnd(46) + L(k.company, 22).padEnd(22) + L(k.location, 26));
}

console.log('\n' + '='.repeat(100));
console.log('3. DEDUP STABILITY — identical search run twice (valig, the cheap one)');
console.log('='.repeat(100));
const s = stability();
console.log('  run1 items ' + s.n1 + ' · run2 items ' + s.n2);
console.log('  LinkedIn id      stable ' + String(s.idStable).padStart(3) + '   Jaccard ' + s.idJaccard.toFixed(3));
console.log('  posting URL      stable ' + String(s.urlStable).padStart(3) + '   Jaccard ' + s.urlJaccard.toFixed(3));
console.log('  company+title+loc stable ' + String(s.comboStable).padStart(3) + '   Jaccard ' + s.comboJaccard.toFixed(3));
console.log('  repo identityKey stable ' + String(s.repoIdentityStable).padStart(3) + '   Jaccard ' + s.repoIdentityJaccard.toFixed(3));
console.log('  only in run1: ' + s.onlyIn1 + ' · only in run2: ' + s.onlyIn2);
console.log('\n  A high Jaccard means repeat runs are reproducible. A LOW one means the Actor');
console.log('  returns a rotating sample, and dedup cannot rely on any single field alone.');
console.log('');
