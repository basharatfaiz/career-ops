// discovery/sources/workday-cxs.mjs — Workday public job board, key-free.
//
// WHY THIS EXISTS
// The reverse-ATS sweep reads Workday through a company DIRECTORY, so it only
// ever sees tenants somebody happened to list. This source reads the public
// CXS endpoint directly, which is the same JSON the employer's own careers page
// calls — no key, no auth, no scraping of rendered HTML.
//
//   POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   body: { limit, offset, searchText, appliedFacets }
//
// Verified response shape (2026-09-27):
//   { total, jobPostings: [ { title, externalPath, locationsText, postedOn,
//                             bulletFields: [ "<reqId>" ] } ], facets, userAuthenticated }
//
// The important detail: the location field is `locationsText`, NOT `locations`.
// Reading the wrong key is why an earlier probe saw empty locations on every
// posting and would have failed the India gate on all of them.
//
// COMPLIANCE
// A public JSON endpoint, read with a browser-shaped User-Agent, paginated
// politely, one request per page. No login, no CAPTCHA, no rate-limit evasion.

import { makeOpportunity } from '../canonical.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE = 20;
// Workday's CXS backend refuses to paginate past offset 2000 on some tenants and
// then serves offset=0 again, so the cap is a correctness guard, not a limit.
const MAX_OFFSET = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Posted Yesterday" / "Posted 3 Days Ago" / "Posted on 12 Aug 2026" → ISO date. */
export function parsePostedOn(text) {
  if (!text) return null;
  const s = String(text);
  const rel = s.match(/Posted\s+(Yesterday|Today)/i);
  if (rel) {
    const d = new Date();
    if (/yesterday/i.test(rel[1])) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const n = s.match(/Posted\s+(\d+)\s+Days?\s+Ago/i);
  if (n) {
    const d = new Date();
    d.setDate(d.getDate() - Number(n[1]));
    return d.toISOString().slice(0, 10);
  }
  const abs = s.match(/Posted\s+(?:on\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (abs) {
    const d = new Date(`${abs[2]} ${abs[1]}, ${abs[3]}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

/** Does this tenant/site answer at all? Cheap single-page probe. */
export async function probeTenant(tenant, instance, site, { timeoutMs = 15000 } = {}) {
  const url = `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.jobPostings)) return null;
    return { host: `${tenant}.${instance}.myworkdayjobs.com`, base: `https://${tenant}.${instance}.myworkdayjobs.com`, total: j.total ?? null };
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

/**
 * Fetch every posting on one tenant/site that matches any of `queries`.
 * `queries` are passed to CXS `searchText`; each is tried separately because
 * CXS OR-matches loosely and a single broad query returns the whole board.
 */
export async function fetchTenant(tenant, instance, site, queries, { maxPerQuery = 60, politeMs = 250, log = () => {} } = {}) {
  const host = `${tenant}.${instance}.myworkdayjobs.com`;
  const base = `https://${host}`;
  const endpoint = `${base}/wday/cxs/${tenant}/${site}/jobs`;
  const out = [];
  const seenTitles = new Set();

  for (const q of queries) {
    let offset = 0;
    let fetched = 0;
    while (offset < MAX_OFFSET && fetched < maxPerQuery) {
      let j = null;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ limit: PAGE, offset, searchText: q, appliedFacets: {} }),
        });
        if (!r.ok) break;
        j = await r.json();
      } catch { break; }
      const postings = (j && j.jobPostings) || [];
      if (!postings.length) break;
      for (const p of postings) {
        const title = String(p.title || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const path = String(p.externalPath || '');
        if (!path) continue;                    // no path → no URL. Never fabricate one.
        const reqId = Array.isArray(p.bulletFields) && p.bulletFields.length ? String(p.bulletFields[0]) : null;
        const url = base + path;
        const key = reqId ? `req:${reqId}` : url;
        if (seenTitles.has(key)) continue;
        seenTitles.add(key);
        const opp = makeOpportunity({
          title,
          url,
          applicationUrl: url,               // the job page IS the apply entry on Workday
          company: p.companyName || tenant,
          location: p.locationsText || '',
          postedAt: parsePostedOn(p.postedOn),
          reqId,
          source: 'workday-cxs',
          discoveryMethod: `workday-cxs:${host}/${site}?searchText=${encodeURIComponent(q)}`,
          titleQuery: q,
        });
        if (opp) out.push(opp);
      }
      fetched += postings.length;
      offset += PAGE;
      if (postings.length < PAGE) break;
      await sleep(politeMs);
    }
    log(`    ${host}/${site} "${q}" → ${out.length} kept`);
  }
  return out;
}
