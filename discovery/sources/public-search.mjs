// discovery/sources/public-search.mjs — public web search, KEY-GATED.
//
// WHY KEY-GATED
// Every legitimate programmatic web search (Brave, Serper, Bing, Google CSE,
// SerpAPI) requires an API key. There is no compliant key-free equivalent:
// scraping a search engine's HTML results page violates that engine's terms,
// and the user explicitly forbade bypassing access controls. So this source
// activates only when a key is present in the environment, and reports itself
// as idle otherwise. It never silently degrades into scraping.
//
// WHAT IT IS FOR
// The ATS connectors and the reverse directory sweep only see jobs published on
// an ATS the repo already knows. A company careers page built in-house, or a role
// posted straight to a job board, is invisible to both. Public search is the one
// way to find those.
//
// LINKEDIN / NAUKRI — SIGNALS ONLY, BY DESIGN
// Results from these domains are treated as DISCOVERY SIGNALS ONLY. This source
// never authenticates, never uses a session, never touches a logged-in surface,
// and never retries past a block. When a result points at a LinkedIn or Naukri
// URL, that URL is recorded as `original_url` for provenance and then the role
// is resolved to the employer's own ATS/careers URL via `resolveEmployerUrl`.
// If it cannot be resolved, the opportunity is DROPPED rather than surfaced as
// an apply target — the campaign must never point the user at a login-walled
// page as though it were an application.

import { makeOpportunity } from '../canonical.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Titles the campaign actually wants. Kept as a list rather than one long OR so
// each is a separate, auditable query.
export const TITLE_QUERIES = [
  '"Product Designer"',
  '"Senior Product Designer"',
  '"Sr. Product Designer"',
  '"Product Designer II"',
  '"Product Designer III"',
  '"Senior UX/Product Designer"',
  '"AI Product Designer"',
  '"AI/UX Product Designer"',
];

// Indian cities + India-remote, per the geography policy.
export const GEO_QUERIES = [
  'India', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Pune', 'Mumbai',
  'Delhi NCR', 'Noida', 'Gurugram', 'Gurgaon', 'Chennai', 'Kolkata',
  'Ahmedabad', 'Jaipur', 'Kochi', 'Chandigarh', 'Indore', '"Remote India"',
  '"India remote"',
];

/** Domains that are a SIGNAL, never an apply target. */
const SIGNAL_ONLY = /(^|\.)(linkedin\.com|www\.linkedin\.com|naukri\.com|www\.naukri\.com|indeed\.com|www\.indeed\.com)$/i;

/** Domains we can turn into a real application URL. */
const ATS_HOST = /(^|\.)(boards-api\.greenhouse\.io|boards\.greenhouse\.io|job-boards\.greenhouse\.io|job-boards\.eu\.greenhouse\.io|api\.lever\.co|jobs\.lever\.co|jobs\.ashbyhq\.com|api\.ashbyhq\.com|apply\.workable\.com|apply\.recruitee\.com|careers\.smartrecruiters\.com|apply\.bamboohr\.com)$/i;
const WORKDAY_HOST = /myworkdayjobs\.com$/i;

/** Which provider, if any, is configured. Returns null when none is. */
export function activeProvider(env = process.env) {
  if (env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.SERPER_API_KEY) return 'serper';
  if (env.BING_SEARCH_KEY) return 'bing';
  if (env.SERPAPI_KEY) return 'serpapi';
  return null;
}

const ENDPOINTS = {
  brave: (q, key) => ({ url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20`, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } }),
  serper: (q, key) => ({ url: 'https://google.serper.dev/search', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, num: 20 }) }),
  bing: (q, key) => ({ url: `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=20`, headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' } }),
  serpapi: (q, key) => ({ url: `https://serpapi.com/search.json?q=${encodeURIComponent(q)}&num=20&api_key=${encodeURIComponent(key)}`, headers: {} }),
};

const POST = { serper: true };

/** Normalize each provider's payload down to { title, url, snippet }. */
function normalize(provider, json) {
  const out = [];
  const push = (title, url, snippet) => { if (title && url) out.push({ title: String(title), url: String(url), snippet: String(snippet || '') }); };
  if (provider === 'brave') for (const r of json?.web?.results || []) push(r.title, r.url, r.description);
  else if (provider === 'serper') for (const r of json?.organic || []) push(r.title, r.link, r.snippet);
  else if (provider === 'bing') for (const r of json?.webPages?.value || []) push(r.name, r.url, r.snippet);
  else if (provider === 'serpapi') for (const r of json?.organic_results || []) push(r.title, r.link, r.snippet);
  return out;
}

/**
 * Is this URL something we can actually hand the user as an application target?
 * A signal-only URL (LinkedIn/Naukri/Indeed) must first be resolved to the
 * employer's own page; that resolution is the caller's job and is deliberately
 * NOT faked here.
 */
export function isDirectApplyTarget(url) {
  return ATS_HOST.test(hostOf(url)) || WORKDAY_HOST.test(hostOf(url));
}
export function isSignalOnly(url) { return SIGNAL_ONLY.test(hostOf(url)); }
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }

/**
 * One search page. Returns [] rather than throwing when a provider errors, so a
 * transient 429 cannot fail a whole run — but a persistent block is reported so
 * the caller can back off rather than hammer.
 */
async function searchOnce(provider, key, query, { timeoutMs = 20000 } = {}) {
  const spec = ENDPOINTS[provider](query, key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(spec.url, {
      method: POST[provider] ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, ...spec.headers },
      body: spec.body,
      signal: ac.signal,
    });
    if (r.status === 429 || r.status === 403) return { blocked: true, status: r.status, results: [] };
    if (!r.ok) return { blocked: false, status: r.status, results: [] };
    return { blocked: false, status: r.status, results: normalize(provider, await r.json()) };
  } catch {
    return { blocked: false, status: 0, results: [] };
  } finally { clearTimeout(timer); }
}

/**
 * Run the title × geography matrix. Bounded, polite, and self-limiting: a 429
 * or 403 halts the whole source rather than retrying, because continuing would
 * be exactly the rate-limit evasion the brief forbids.
 */
export async function search({ env = process.env, maxQueries = 60, politeMs = 900, log = () => {} } = {}) {
  const provider = activeProvider(env);
  if (!provider) {
    return { provider: null, ran: false, reason: 'no search API key configured — set one of BRAVE_SEARCH_API_KEY / SERPER_API_KEY / BING_SEARCH_KEY / SERPAPI_KEY', opportunities: [], signalsOnly: 0, blocked: false };
  }
  const key = env[`${provider.toUpperCase()}_SEARCH_API_KEY`] || env[`${provider.toUpperCase()}_API_KEY`] || env.SERPAPI_KEY || env.BING_SEARCH_KEY;

  const queries = [];
  for (const g of GEO_QUERIES) for (const t of TITLE_QUERIES) queries.push(`${t} ${g}`);
  const capped = queries.slice(0, maxQueries);

  const opportunities = [];
  const signals = [];
  let blocked = false;

  for (const q of capped) {
    if (blocked) break;
    const r = await searchOnce(provider, key, q);
    if (r.blocked) { blocked = true; log(`    search BLOCKED (${r.status}) — halting this source, not retrying`); break; }
    for (const hit of r.results) {
      if (isSignalOnly(hit.url)) { signals.push({ ...hit, query: q }); continue; }
      if (!isDirectApplyTarget(hit.url)) continue;   // not an application target we can use
      const title = hit.title.replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/, '').trim();  // drop " | Company"
      const opp = makeOpportunity({
        title,
        url: hit.url,
        applicationUrl: hit.url,
        company: '',
        location: '',
        description: hit.snippet,
        source: 'public-search',
        discoveryMethod: `${provider}:${q}`,
        titleQuery: q,
      });
      if (opp) opportunities.push(opp);
    }
    await new Promise((r2) => setTimeout(r2, politeMs));
  }
  log(`    public-search[${provider}] ${capped.length} queries → ${opportunities.length} apply targets, ${signals.length} signal-only (LinkedIn/Naukri/Indeed)`);
  return { provider, ran: true, opportunities, signalsOnly: signals.length, signals, blocked };
}
