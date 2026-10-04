// discovery/canonical.mjs — canonical URLs, provenance, and cross-source dedup.
//
// Every opportunity that enters the campaign passes through here, whatever
// found it. Nothing else in this layer is allowed to invent a URL: a canonical
// URL is only ever derived from a URL that a source actually returned, and an
// application URL is only ever derived from a URL the source labelled as the
// apply action.
//
// The dedup rule is deliberately stronger than the scanner's per-source
// normalizeUrlForDedup, because the whole point of a multi-source layer is that
// the same role shows up on a search index, a LinkedIn post, an ATS board and a
// company career page. Those four URLs are different strings for one job.

/** Query params that never identify a posting — stripped before comparison. */
const TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'referrer', 'source',
  'src', 'trk', 'trackingid', 'tracking_id', 'gh_src', 'gh_jid', 'lever-source',
  'origin', 'locale', 'lang', '_ga', 'yclid', 'igshid', 's_kwcid', 'si',
]);

/**
 * Host-level identity, so `boards.greenhouse.io/acme` and
 * `job-boards.greenhouse.io/acme` collapse to one board.
 */
const HOST_ALIASES = new Map(Object.entries({
  'boards.greenhouse.io': 'greenhouse',
  'job-boards.greenhouse.io': 'greenhouse',
  'job-boards.eu.greenhouse.io': 'greenhouse',
  'boards-api.greenhouse.io': 'greenhouse',
  'api.lever.co': 'lever',
  'jobs.lever.co': 'lever',
  'jobs.ashbyhq.com': 'ashby',
  'api.ashbyhq.com': 'ashby',
  'apply.workable.com': 'workable',
  'apply.recruitee.com': 'recruitee',
  'careers.smartrecruiters.com': 'smartrecruiters',
  'api.smartrecruiters.com': 'smartrecruiters',
  'apply.bamboohr.com': 'bamboohr',
  'jobs.ashbyhq.com': 'ashby',
}));

/** Reduce a URL to a stable identity string. Never throws. */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  for (const k of Array.from(u.searchParams.keys())) {
    if (TRACKING.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  u.hash = '';
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');

  let path = u.pathname.replace(/\/+$/, '') || '/';
  path = path.replace(/\/(application|apply|jobs?careers?)$/i, '');

  const board = HOST_ALIASES.get(u.hostname);
  const key = board
    ? `${board}${path}`
    : `${u.hostname}${path}${u.search ? '?' + u.searchParams.toString() : ''}`;
  return key;
}

/**
 * ATS-aware identity. A Workday posting is the same job across
 * `hpe.wd5…` and `hpe.wd105…` when the requisition id matches, so a req id —
 * when a source actually exposes one — beats the URL.
 */
export function identityKey({ url, reqId, source, company, title }) {
  const req = String(reqId || '').trim();
  if (req) {
    const co = String(company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Req ids are only unique within a tenant, so the company travels with it.
    if (co && co.length > 2) return `req:${co}:${req.toLowerCase()}`;
  }
  const canon = canonicalUrl(url);
  if (canon) return 'url:' + canon;
  // Last resort: never merge on a bare title, that would collapse real jobs.
  return null;
}

/**
 * Provenance is mandatory on every opportunity. The shape matches the fields
 * the campaign asked for, plus what was actually observed.
 */
export function makeOpportunity(o) {
  const canonical = canonicalUrl(o.url);
  if (!canonical) return null;                       // never invent a URL
  return {
    // --- the normalized Job shape the existing scanner/sink already expects ---
    title: String(o.title || '').replace(/\s+/g, ' ').trim(),
    url: o.url,
    company: String(o.company || '').replace(/\s+/g, ' ').trim(),
    location: String(o.location || '').replace(/\s+/g, ' ').trim(),
    description: o.description || '',
    postedAt: o.postedAt,
    // --- provenance ---
    source: o.source,                                // 'workday-cxs' | 'public-search' | 'ats-sweep' | …
    discovery_method: o.discoveryMethod || o.source, // how it was found
    discovered_at: o.discoveredAt || new Date().toISOString(),
    original_url: o.url,                             // exactly what the source returned
    canonical_url: canonical,
    application_url: o.applicationUrl || o.url,       // only from a source that labelled it
    req_id: o.reqId || null,
    title_query: o.titleQuery || null,
    // --- dedup ---
    identity_key: identityKey({ url: o.url, reqId: o.reqId, source: o.source, company: o.company, title: o.title }),
  };
}

/**
 * Strong dedup across sources. Keeps the FIRST occurrence, and records every
 * additional source that also saw the same job — so the digest can show that a
 * role was corroborated by three independent surfaces without tripling it.
 */
export class Deduper {
  constructor() { this.byIdentity = new Map(); this.merged = 0; }

  add(opp) {
    if (!opp || !opp.identity_key) return null;
    const prior = this.byIdentity.get(opp.identity_key);
    if (prior) {
      this.merged++;
      const seen = prior.corroborating_sources || [];
      if (opp.source && !seen.includes(opp.source)) seen.push(opp.source);
      prior.corroborating_sources = seen;
      // Prefer a real application URL over a search/aggregator URL.
      if (opp.application_url && opp.application_url !== prior.url && !prior.has_real_apply) {
        prior.application_url = opp.application_url;
        prior.url = opp.application_url;
        prior.has_real_apply = true;
      }
      // Fill an empty location rather than overwrite a real one.
      if (!prior.location && opp.location) prior.location = opp.location;
      if (!prior.company && opp.company) prior.company = opp.company;
      return null;
    }
    const rec = { ...opp, has_real_apply: !!opp.application_url && opp.application_url !== opp.url, corroborating_sources: opp.source ? [opp.source] : [] };
    this.byIdentity.set(opp.identity_key, rec);
    return rec;
  }

  get size() { return this.byIdentity.size; }
  all() { return Array.from(this.byIdentity.values()); }
}
