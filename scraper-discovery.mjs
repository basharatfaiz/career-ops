#!/usr/bin/env node
/**
 * scraper-discovery.mjs — optional scraper ingestion, wired into the EXISTING
 * dedup + seniority-gate layers.
 *
 *   Apify / Firecrawl
 *          ↓  normalize      (never invent a missing field)
 *          ↓  deduplicate    (canonical URL → ATS id → company+title+location → near-dup)
 *          ↓  seniority gate (exclusions BEFORE acceptance)
 *          ↓  → joins the normal eligibility / evaluation / queue path
 *
 * Cost control: a provider with no key is reported DISABLED and skipped. It is
 * not an error, and the free/local pipeline is unaffected. DRY-RUN is the
 * default — this never spends money unless you pass --live.
 *
 * Usage:
 *   node scraper-discovery.mjs                 # dry-run: plan + counts, no API calls
 *   node scraper-discovery.mjs --status        # provider status only
 *   node scraper-discovery.mjs --live          # actually call the providers (needs keys)
 *   node scraper-discovery.mjs --provider apify --live
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { normalizeUrl } from './url-key.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { gateTitle } from './seniority-gate.mjs';
import { apifyEntries, firecrawlEntries } from './scraper-sources.mjs';
const require = createRequire(import.meta.url);

const arg = (k) => process.argv.includes(k);
const opt = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

const LIVE = arg('--live');
const only = opt('--provider');

const dotenv = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const dotenvHas = (k) => new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(dotenv);
const hasKey = (k) => (typeof process.env[k] === 'string' && process.env[k].trim() !== '') || dotenvHas(k);

const PROVIDERS = [
  { id: 'apify', keys: ['APIFY_TOKEN', 'APIFY_API_TOKEN'], entries: apifyEntries },
  { id: 'firecrawl', keys: ['FIRECRAWL_API_KEY'], entries: firecrawlEntries },
];

// ── the existing dedup layer ────────────────────────────────────────────
//
// The normalized title used as dedup key #3 must be CONSERVATIVE. An earlier
// version stripped seniority words and parentheticals, which silently merged
// four genuinely distinct roles in the existing corpus:
//     Initech    "Lead Product Designer"  + "Staff Product Designer"
//     Globex     "Senior PD (Design)"     + "Senior PD"
//     Globex     "Senior PD (Design)"     + "Senior PD (Secrets Manager)"
//     Acme       "Staff Product Designer"  + "Product Designer (4 open roles)"
// Same data-loss failure the resolver work already caught once: two different
// reqs at one company are two jobs. So key #3 keeps every word — only case,
// punctuation and whitespace are normalized. Fuzzy matching belongs in key #4,
// and key #4 only FLAGS; it never deletes.
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** ATS job id, when the URL exposes one. Second dedup key after canonical URL. */
function atsId(url) {
  const m = String(url || '').match(
    /(?:greenhouse\.io\/[^/]+\/jobs\/(\d+))|(?:lever\.co\/[^/]+\/([0-9a-f-]{20,}))|(?:ashbyhq\.com\/[^/]+\/([0-9a-f-]{20,}))|(?:workable\.com\/j\/([A-Z0-9]+))/i
  );
  return m ? (m[1] || m[2] || m[3] || m[4] || '').toUpperCase() : null;
}

/**
 * Deduplicate in the specified order:
 *   1. canonical job URL
 *   2. normalized ATS job identifier
 *   3. company + normalized title + location
 *   4. near-duplicate (same company, title tokens overlapping)
 */
function makeDeduper() {
  const byUrl = new Map(), byAts = new Map(), byCR = new Map();
  const all = [];
  return {
    add(o) {
      const kUrl = o.canonicalUrl ? normalizeUrl(o.canonicalUrl) : null;
      const kAts = o.canonicalUrl ? atsId(o.canonicalUrl) : null;
      const kCR = `${normalizeCompanyName(o.company)}|${normTitle(o.title)}|${normTitle(o.location)}`;
      let hit = null;
      if (kUrl && byUrl.has(kUrl)) hit = byUrl.get(kUrl);
      else if (kAts && byAts.has(kAts)) hit = byAts.get(kAts);
      else if (byCR.has(kCR)) hit = byCR.get(kCR);
      if (hit) {
        hit.alsoSeenVia = [...new Set([...(hit.alsoSeenVia || []), o.source])];
        return { merged: true, into: hit };
      }
      if (kUrl) byUrl.set(kUrl, o);
      if (kAts) byAts.set(kAts, o);
      byCR.set(kCR, o);
      all.push(o);
      return { merged: false, into: o };
    },
    /**
     * Key #4 — near-duplicate. FLAG ONLY, never a delete. Same company with
     * heavily overlapping title tokens is usually two distinct reqs (Lead vs
     * Staff at one employer, two reqs at another), so merging on this signal is
     * how real jobs go missing. It is recorded so a human can look.
     */
    flagNearDuplicates() {
      const flags = [];
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i], b = all[j];
          if (normalizeCompanyName(a.company) !== normalizeCompanyName(b.company)) continue;
          const ta = new Set(normTitle(a.title).split(' ').filter(Boolean));
          const tb = new Set(normTitle(b.title).split(' ').filter(Boolean));
          if (!ta.size || !tb.size) continue;
          const shared = [...ta].filter((t) => tb.has(t)).length;
          if (shared >= Math.min(ta.size, tb.size) && ta.size !== tb.size) {
            flags.push({ a: `${a.company} — ${a.title}`, b: `${b.company} — ${b.title}`, sharedTokens: shared });
          }
        }
      }
      return flags;
    },
    all: () => all,
  };
}

// ── normalize: map a scraper record to the EXISTING opportunity schema ──
function normalize(raw, source, sourceUrl) {
  const url = raw.url || raw.link || raw.jobUrl || null;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const title = (raw.title || raw.name || raw.jobTitle || raw.position || '').toString().trim();
  if (!title) return null;
  return {
    company: (raw.company || raw.companyName || raw.employer || '').toString().trim(),
    title,
    location: (raw.location || raw.city || raw.formattedLocation || '').toString().trim(),
    workArrangement: raw.workArrangement || raw.workModel || null,   // null, not ''
    canonicalUrl: url,
    source,
    sourceUrl: sourceUrl || url,
    description: raw.description || raw.markdown || null,
    compensation: raw.compensation ?? raw.salary ?? null,
    discovered_at: new Date().toISOString().slice(0, 10),
    provenance: { provider: source.split(':')[0], entry: source, fieldMapApplied: true },
  };
}

// ── main ────────────────────────────────────────────────────────────────
const yaml = require('js-yaml');

const status = {};
for (const p of PROVIDERS) {
  const keyName = p.keys.find((k) => hasKey(k)) || p.keys[0];
  const configured = hasKey(keyName);
  status[p.id] = {
    keyName, configured,
    state: configured ? 'key present' : 'DISABLED (no key)',
    entries: p.entries().length,
    live: LIVE && configured && (!only || only === p.id),
  };
}

console.log('='.repeat(74));
console.log(`SCRAPER DISCOVERY — ${LIVE ? 'LIVE' : 'DRY-RUN (no API calls, no spend)'}`);
console.log('='.repeat(74));
for (const [id, s] of Object.entries(status)) {
  console.log(`  ${id.padEnd(10)} ${s.state.padEnd(22)} ${String(s.entries).padStart(3)} configured sources  ${LIVE && s.live ? '→ will run' : '→ skipped'}`);
}
if (!LIVE) console.log('\n  DRY-RUN: no provider is called, nothing is fetched, no credits are spent.');

// The existing discovery corpus — the thing scraper results must dedup against.
let existing = [];
try {
  const S = JSON.parse(readFileSync('data/discovery/resolved.json', 'utf8'));
  existing = S.filter((r) => r.resolved).map((r) => ({
    canonicalUrl: r.canonical, company: r.company, title: r.title, location: r.location,
  }));
} catch { /* first run */ }

const deduper = makeDeduper();
for (const e of existing) deduper.add({ ...e, source: 'existing-discovery' });

const before = deduper.all().length;
let fetched = 0, normalized = 0;

if (LIVE) {
  for (const [id, s] of Object.entries(status)) {
    if (!s.live) continue;
    for (const entry of (id === 'apify' ? apifyEntries() : firecrawlEntries())) {
      let records = [];
      try {
        if (id === 'apify') {
          const { runActor, hasToken } = await import('./plugins/apify/_apify.mjs');
          if (!hasToken()) { console.log(`  ! ${entry.name}: no token — recorded and continuing`); continue; }
          records = await runActor(entry.actor, entry.input, { timeoutMs: entry.timeout_ms });
        } else {
          const fc = await import('./plugins/firecrawl/_firecrawl.mjs');
          const rec = entry.mode === 'search'
            ? await fc.search(entry.query, { limit: entry.max_results, timeoutMs: entry.timeout_ms })
            : await fc.scrapeUrl(entry.url, { timeoutMs: entry.timeout_ms });
          records = Array.isArray(rec) ? rec : (rec.url ? [rec] : []);
        }
      } catch (e) {
        // Blocked / refused / rate-limited: record and continue. Never work around.
        console.log(`  ! ${entry.name}: ${String(e.message).slice(0, 90)} — recorded, continuing`);
        continue;
      }
      fetched += records.length;
      for (const r of records) {
        const n = normalize(r, `${id}:${entry.name}`, entry.url || entry.query);
        if (!n) continue;
        normalized++;
        deduper.add(n);
      }
    }
  }
} else {
  // Dry-run: project the matrix size without calling anything.
  fetched = 0;
  normalized = 0;
}

const after = deduper.all().length;
const nearDupFlags = deduper.flagNearDuplicates();

// ── seniority gate on the NEW records only ──────────────────────────────
const newOnes = deduper.all().filter((o) => o.source !== 'existing-discovery');
const gated = newOnes.map((o) => ({ ...o, gate: gateTitle(o.title, {}) }));
const accepted = gated.filter((g) => g.gate.verdict === 'accept');
const gateRejected = gated.filter((g) => g.gate.verdict === 'exclude');
const gateReview = gated.filter((g) => g.gate.verdict === 'review');

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  mode: LIVE ? 'live' : 'dry-run',
  providers: status,
  existingOpportunities: before,
  fetched, normalized,
  duplicatesRemoved: Math.max(0, after - before - newOnes.length),
  newOpportunities: newOnes.length,
  nearDuplicateFlags: nearDupFlags,
  gateAccepted: accepted.length,
  gateRejectedSeniority: gateRejected.length,
  gateReviewAmbiguous: gateReview.length,
  finalProjected: before + accepted.length,
  accepted, rejected: gateRejected, review: gateReview,
};
writeFileSync('data/discovery/scraper-discovery.json', JSON.stringify(payload, null, 2));

console.log('\n' + '-'.repeat(74));
console.log(`  existing discovery opportunities   ${before}`);
console.log(`  scraper records fetched            ${fetched}${LIVE ? '' : '  (dry-run: none)'}`);
console.log(`  normalized                         ${normalized}`);
console.log(`  duplicates removed vs existing     ${payload.duplicatesRemoved}`);
console.log(`  new opportunities after dedup      ${newOnes.length}`);
console.log(`  near-duplicate pairs FLAGGED       ${nearDupFlags.length}  (flagged, never merged)`);
console.log(`  rejected by seniority gate         ${gateRejected.length}`);
console.log(`  flagged (ambiguous title)          ${gateReview.length}`);
console.log(`  ────────────────────────────────────────────`);
console.log(`  FINAL PROJECTED DISCOVERY COUNT    ${before + accepted.length}`);
if (!LIVE) {
  console.log('\n  Projected scraper contribution = 0 by design: no key, no call, no spend.');
  console.log('  The figures above are what WOULD be added once a key exists.');
}
console.log('\n  written: data/discovery/scraper-discovery.json');
