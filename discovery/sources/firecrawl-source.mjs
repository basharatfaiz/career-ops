// discovery/sources/firecrawl-source.mjs — Firecrawl-backed discovery.
//
// USES THE EXISTING INTEGRATION. This file imports plugins/firecrawl/_firecrawl.mjs
// verbatim — the same host-pinned transport the provider plugin uses. It does
// not re-implement an API client, does not touch plugins/firecrawl/index.mjs,
// and does not add a second credential path.
//
// WHY NOT portals.yml + the firecrawl provider directly
// index.mjs is a BOARD provider: one portals.yml entry → one careers page, with
// a static field_map. That cannot express a title × city query matrix over the
// open web, and Firecrawl's /search returns no location field at all — so the
// India gate would have nothing to read. This adapter adds the missing piece:
// search → candidate URLs → selective scrape → extract location/company/date →
// normalize into the Job shape the existing pipeline already consumes.
//
// COMPLIANCE (inherited from the transport, restated because it matters)
//   · HTTPS only, host-pinned to api.firecrawl.dev.
//   · 401/403/429 THROW in the transport and are caught here as a recorded
//     failure. Nothing is retried past a block and no fallback scraper exists.
//   · Firecrawl renders JS and reads public content. It does not solve CAPTCHAs
//     or hold sessions, and a login-walled page simply fails.
//   · LinkedIn/Naukri/Indeed are SIGNAL-ONLY. A result on those domains is
//     recorded as provenance and then dropped unless it resolves to an employer
//     ATS/careers URL. It is never offered as an application target and never
//     fetched while signed in.

import { makeOpportunity, canonicalUrl } from '../canonical.mjs';
import { hasKey, search as fcSearch, scrapeUrl } from '../../plugins/firecrawl/_firecrawl.mjs';

// Re-exported so callers can check readiness without importing the plugin
// transport themselves.
export { hasKey };

// Signal-only domains are recorded as provenance and DROPPED. mygwork is
// LinkedIn's company-job-listing site, so it belongs here, not with the ATSes.
// Aggregators are included because a role found on one must be resolved to the
// employer's own page — never applied to through the aggregator.
const SIGNAL_ONLY = /(^|\.)(linkedin\.com|naukri\.com|indeed\.com|glassdoor\.com|monster\.com|ziprecruiter\.com|mygwork\.com|my\.gwork\.com|ambitionbox\.com|designproject\.io|instahyre\.com|wellfound\.com|angellist\.com|workatastartup\.com|foundit\.com|shine\.com|job Hai\.com)$/i;
const ATS_HOST = /(^|\.)(boards-api\.greenhouse\.io|boards\.greenhouse\.io|job-boards\.greenhouse\.io|job-boards\.eu\.greenhouse\.io|api\.lever\.co|jobs\.lever\.co|jobs\.ashbyhq\.com|api\.ashbyhq\.com|apply\.workable\.com|apply\.recruitee\.com|careers\.smartrecruiters\.com|apply\.bamboohr\.com)$/i;
const WORKDAY_HOST = /myworkdayjobs\.com$/i;
const SUCCESSFACTORS_HOST = /(^|\.)(jobs\.[a-z0-9-]+\.sap\.com|successfactors\.com)$/i;

// Pages that mention "Product Designer" and "India" but are NOT a role.
// The first bounded test spent credits on a salary page and two aggregators,
// all of which passed the India gate because the location extractor happily
// returned the page TITLE. A salary/guide/listicle page is not an opportunity.
const NON_JOB_PATH = /\/(salary|salaries|interview|interview-questions|cover-letter|resume|resumes|cv-guide|portfolio|samples?|blog|news|guide|guides|how-to|best|top-\d+|vs|comparison|reviews?|courses?|certification|freelance-rate)\b/i;
const NOT_A_ROLE_TEXT = /\b(salary|salaries|average (pay|salary)|how much (do|does|are)|interview questions|cover letter|resume (guide|template|examples?)|best (product design|portfolio)|top \d+ (product|design|jobs?)|courses? to|learn \w+ in \d+|jobs? in \w+ (salary|interview))/i;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isSignalOnlyUrl = (u) => SIGNAL_ONLY.test(hostOf(u));
/** Can this URL be handed to the user as a real application target? */
export const isApplyTarget = (u) => {
  const h = hostOf(u);
  return ATS_HOST.test(h) || WORKDAY_HOST.test(h) || SUCCESSFACTORS_HOST.test(h);
};

export const TITLE_QUERIES = [
  '"Product Designer"', '"Senior Product Designer"', '"Sr. Product Designer"',
  '"Product Designer II"', '"Product Designer III"', '"Senior UX/Product Designer"',
  '"AI Product Designer"', '"AI/UX Product Designer"',
];
export const GEO_TERMS = [
  'India', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Pune', 'Mumbai', 'Delhi',
  'Gurgaon', 'Gurugram', 'Noida', 'Chennai', 'Ahmedabad', 'Kolkata',
  'Bengaluru remote', 'India remote',
];

/** Credit accounting. 1 search = 1 credit; 1 scrape = 1 credit. */
export function makeCreditMeter() {
  return { searches: 0, results: 0, scrapes: 0, scrapeOk: 0, scrapeFailed: 0, blocked: 0, forbidden: 0, errors: [] };
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Pull an India signal out of a scraped posting. Deliberately conservative:
 * it prefers an explicit location line and will accept a stated remote-for-India
 * phrase, but it never infers India from a company name or from "remote".
 */
const INDIA_RE = /\b(india|indian|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurugram|gurgaon|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|trivandrum|coimbatore|mysuru|nagpur|bhopal|patna|lucknow|kanpur|madurai|vadodara|surat|rajkot|thane|nashik|aurangabad|visakhapatnam|thiruvananthapuram)\b/i;
const REMOTE_IN = /\b(remote[^\n]{0,40}\b(india|indian)\b|\b(india|indian)\b[^\n]{0,40}\bremote\b|remote\s*[-–—]\s*(india|in)\b)/i;

export function extractLocation(markdown, metaDescription = '', pageTitle = '') {
  const head = String(markdown || '').slice(0, 6000);
  // A "Location: X" / "Locations: X" line near the top is the most reliable form.
  const labelled = head.match(/(?:^|\n)\s*\**\s*(?:location|locations|workplace|office|job location)\s*\**\s*[:\-–]\s*\**([^\n]{2,120})/i);
  if (labelled && labelled[1].trim()) return labelled[1].trim().replace(/\s+/g, ' ');

  if (REMOTE_IN.test(head) || REMOTE_IN.test(String(metaDescription || ''))) return 'Remote (India)';

  // Otherwise the first short line carrying an India token. Two guards, both
  // added after the first test returned page TITLES as locations:
  //   · the line must not be (or contain) the page title — a title repeats the
  //     role name, not a place;
  //   · the line must not be salary/ guide prose.
  const titleKey = String(pageTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const line of head.split('\n').slice(0, 40)) {
    let L = line.trim();
    if (!L || L.length > 140 || !INDIA_RE.test(L)) continue;
    L = L.replace(/^[#*\-\s]+/, '').replace(/\s+/g, ' ').trim();
    if (NOT_A_ROLE_TEXT.test(L)) continue;
    const lineKey = L.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Reject when the candidate line is just the title with the role stripped,
    // or when the whole title is contained in it.
    if (titleKey && (lineKey === titleKey || (titleKey.length > 12 && lineKey.includes(titleKey)))) continue;
    // A location line names a place; it should not restate the role.
    if (/\b(designer|designer[s]?|engineer|developer|manager|analyst|salary|salaries)\b/i.test(L) && !/\b(office|based|location|remote)\b/i.test(L)) continue;
    const stop = L.search(/[.;]\s/);
    if (stop > 8) L = L.slice(0, stop);
    if (L.length >= 3) return L;
  }
  if (INDIA_RE.test(String(metaDescription || '')) && !NOT_A_ROLE_TEXT.test(String(metaDescription))) return norm(metaDescription).slice(0, 120);
  return '';
}

function extractCompany(markdown, url, title) {
  const head = String(markdown || '').slice(0, 4000);
  const labelled = head.match(/(?:^|\n)\s*\**\s*(?:company|employer|organisation|organization)\s*\**\s*[:\-–]\s*\**([^\n]{2,80})/i);
  if (labelled && labelled[1].trim()) return labelled[1].trim();
  // h1 on the page is usually "<Role> at <Company>" or "<Role> | <Company>".
  const h1 = head.match(/^#\s+(.{3,120})$/m);
  if (h1) {
    const m = h1[1].match(/\s+(?:at|@|[-–—|])\s+([A-Z][\w&.' -]{2,50})$/);
    if (m) return m[1].trim();
  }
  const fromTitle = String(title || '').match(/[-–—|]\s+([A-Z][\w&.' ]{2,40})$/);
  if (fromTitle) return fromTitle[1].trim();
  try { const h = new URL(url).hostname.replace(/^www\./, ''); return h.split('.')[0]; } catch { return ''; }
}

const DATE_RES = [
  /(\d{4})-(\d{2})-(\d{2})/,
  /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})/i,
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i,
];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Build a date at UTC NOON, not local midnight.
 *
 * `new Date("12 Aug 2026")` is local midnight; in IST (UTC+05:30) `.toISOString()`
 * then rolls it back to 11 Aug. A scraped posting would appear one day older
 * than it is, which quietly corrupts any recency window built on this field.
 * Noon-UTC cannot roll over in any timezone between -12 and +12.
 */
function ymdToIso(y, m, d) {
  const dt = new Date(Date.UTC(Number(y), Number(m), Number(d), 12, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function extractPosted(markdown, metaDescription) {
  const blob = String(metaDescription || '') + '\n' + String(markdown || '').slice(0, 3000);
  // ISO first. Date.UTC takes a ZERO-indexed month, so an ISO "2026-09-20"
  // must pass month-1 — passing 9 silently yields 20 October.
  let m = blob.match(DATE_RES[0]);
  if (m) return ymdToIso(m[1], Number(m[2]) - 1, m[3]) || undefined;
  // "12 Aug 2026"
  m = blob.match(DATE_RES[1]);
  if (m) return ymdToIso(m[3], MONTHS[m[2].toLowerCase()], m[1]) || undefined;
  // "Aug 12, 2026"
  m = blob.match(DATE_RES[2]);
  if (m) return ymdToIso(m[3], MONTHS[m[1].toLowerCase()], m[2]) || undefined;
  const rel = blob.match(/\b(\d{1,3})\s+days?\s+ago\b/i);
  if (rel) { const d = new Date(); d.setDate(d.getDate() - Number(rel[1])); return d.toISOString(); }
  return undefined;
}

/** Strip a trailing " | Company" / " - Company" so the title matches the gate. */
export function cleanTitle(t) {
  return norm(t)
    .replace(/\s*[|\-–—]\s*[A-Z][\w&.' ]{2,40}$/, '')
    .replace(/^\s*(job|vacancy|opening)\s*[:\-–]\s*/i, '')
    .trim();
}

/**
 * Run the controlled discovery test.
 *
 * @param {object} o
 * @param {number} o.maxQueries      hard cap on search calls
 * @param {number} o.maxResults      results requested per query (server-side)
 * @param {number} o.maxCandidates   total candidate URLs kept for scraping
 * @param {number} o.maxScrapes      hard cap on scrape calls (credit ceiling)
 * @param {(s:string)=>void} o.log
 */
export async function discover({
  maxQueries = 8, maxResults = 20, maxCandidates = 60, maxScrapes = 40, log = () => {}, politeMs = 2500,
  titleQueries = TITLE_QUERIES, geoTerms = GEO_TERMS, recencyDays = null,
} = {}) {
  const meter = makeCreditMeter();
  if (!hasKey()) {
    return {
      ran: false, reason: 'FIRECRAWL_API_KEY not set — put it in .env (gitignored) and re-run',
      meter, candidates: [], opportunities: [], stats: {},
    };
  }

  // ── 1. SEARCH: build a bounded query matrix ──────────────────────────
  const queries = [];
  outer:
  for (const t of titleQueries) {
    for (const g of geoTerms) {
      // Prefer recent postings when the caller asks for it.
      const q = recencyDays ? `${t} ${g} after:${isoDaysAgo(recencyDays)}` : `${t} ${g} jobs`;
      queries.push(q);
      if (queries.length >= maxQueries) break outer;
    }
  }

  const hits = [];
  const seenUrl = new Set();
  // Pace every call. The first live run fired 10 searches back-to-back and
  // tripped Firecrawl's rate limiter, so the re-run was 429'd on its very first
  // call. Pacing is the correct fix: it keeps inside the published limit
  // instead of provoking it and then backing off.
  const pace = () => new Promise((r) => setTimeout(r, politeMs));
  for (const [qi, q] of queries.entries()) {
    if (qi > 0) await pace();
    let got = [];
    try {
      got = await fcSearch(q, { limit: maxResults });
      meter.searches++;
      meter.results += got.length;
    } catch (e) {
      const msg = String(e.message);
      meter.errors.push(`search "${q}": ${msg.slice(0, 90)}`);
      if (/rate limited/i.test(msg)) { meter.blocked++; log(`    search rate limited — halting, not retrying`); break; }
      if (/access refused/i.test(msg)) { meter.blocked++; log(`    search access refused — the key is likely invalid; halting`); break; }
      continue;
    }
    for (const h of got) {
      if (!h.url || seenUrl.has(h.url)) continue;
      seenUrl.add(h.url);
      hits.push({ ...h, query: q });
    }
    log(`    search[${meter.searches}] "${q}" → ${got.length} results (running total ${hits.length} unique)`);
  }

  // ── 2. PRIORITISE: which candidates are worth a scrape credit? ──────
  // Scrape budget is the scarce resource, so rank before spending. An ATS or
  // careers host is worth a scrape; a signal-only domain never is.
  const direct = [], signals = [], other = [];
  for (const h of hits) {
    if (isSignalOnlyUrl(h.url)) signals.push(h);
    else if (isApplyTarget(h.url)) direct.push(h);
    else other.push(h);
  }
  // Search-result titles are the only free signal we have; keep the ones that
  // look like product design before spending a scrape on the rest.
  const looksLikePD = (t) => /\b(product|ux|ui|ai)\s+designer\b/i.test(String(t || ''));
  direct.sort((a, b) => Number(looksLikePD(b.title)) - Number(looksLikePD(a.title)));
  other.sort((a, b) => Number(looksLikePD(b.title)) - Number(looksLikePD(a.title)));

  const candidates = [...direct, ...other].slice(0, maxCandidates);
  log(`    candidates: ${direct.length} direct-ATS, ${signals.length} signal-only (LinkedIn/Naukri/Indeed — provenance only, never scraped as a target), ${other.length} career pages`);
  log(`    scraping up to ${Math.min(maxScrapes, candidates.length)} of ${candidates.length} candidates`);

  // ── 3. SCRAPE: only the promising ones, and only for location detail ──
  const opportunities = [];
  const rejectedNotARole = [];
  let scraped = 0;
  for (const c of candidates.slice(0, maxScrapes)) {
    if (scraped > 0) await pace();
    scraped++;
    // Cheap pre-scrape reject: a /salary or /interview-questions path is not a
    // role whatever the page says, and there is no reason to spend a credit.
    if (NON_JOB_PATH.test(c.url)) { rejectedNotARole.push({ url: c.url, why: 'non-job path' }); continue; }
    let page;
    try {
      page = await scrapeUrl(c.url, { formats: ['markdown'], onlyMainContent: true });
      meter.scrapes++; meter.scrapeOk++;
    } catch (e) {
      meter.scrapes++; meter.scrapeFailed++;
      const msg = String(e.message);
      meter.errors.push(`scrape ${c.url.slice(0, 60)}: ${msg.slice(0, 80)}`);
      // 429 is ACCOUNT-WIDE (we are going too fast) and 401 means the key is
      // bad — both must halt. A 403 is a PER-URL refusal: reddit, for example,
      // blocks scraping outright. Treating that as a reason to stop cost the
      // first run 20 of its 30 scrape credits, so it now skips that one URL and
      // carries on. Nothing is retried either way.
      if (/rate limited/i.test(msg)) { meter.blocked++; log(`    scrape rate limited — halting the source, not retrying`); break; }
      if (/access refused \(HTTP 401\)/i.test(msg)) { meter.blocked++; log(`    scrape auth refused (401) — the key is not valid; halting`); break; }
      if (/HTTP 403/i.test(msg)) { meter.forbidden++; log(`    scrape 403 on ${hostOf(c.url)} — skipping this URL, continuing (per-URL refusal, not an account block)`); continue; }
      continue;
    }
    const title = cleanTitle(page.title || c.title);
    if (!title) continue;
    // A salary/guide/listicle page is not an opportunity, however well it
    // matches the title and geography.
    if (NON_JOB_PATH.test(c.url) || NOT_A_ROLE_TEXT.test(String(page.title || '') + ' ' + String(page.description || '').slice(0, 400))) {
      rejectedNotARole.push({ url: c.url, why: 'salary/guide page, not a role' });
      continue;
    }
    const location = extractLocation(page.markdown, page.description, page.title);
    if (!location) continue;                       // no India signal → nothing to gate
    const opp = makeOpportunity({
      title,
      url: page.url || c.url,
      applicationUrl: page.url || c.url,
      company: extractCompany(page.markdown, page.url || c.url, page.title || c.title),
      location,
      description: (page.markdown || '').slice(0, 4000),
      postedAt: extractPosted(page.markdown, page.description),
      source: 'firecrawl',
      discoveryMethod: `firecrawl:search?q=${encodeURIComponent(c.query)}→scrape`,
      titleQuery: c.query,
    });
    if (opp) opportunities.push(opp);
  }

  return {
    ran: true, meter, candidates, opportunities, signals, rejectedNotARole,
    stats: { queries: queries.length, results: meter.results, uniqueCandidates: hits.length },
  };
}

function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
