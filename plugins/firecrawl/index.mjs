// @ts-check
// ── Firecrawl provider plugin ────────────────────────────────────────────
// A KEYED provider: it never auto-detects, and it fires only on a portals.yml
// entry that sets `provider: firecrawl`. All variation lives in portals.yml —
// which mode (scrape / search / crawl), which URL or query, which fields to map.
//
// Purpose: cover the pages the existing lightweight discovery cannot read. It
// is an ADDITIONAL source, never a replacement: the search/index layer, the ATS
// APIs, the board feeds, the direct career pages and local Playwright all keep
// working with no key set.
//
// NOT a circumvention tool. Firecrawl renders JavaScript and reads public page
// content. It does not solve CAPTCHAs, hold logins, or evade access controls. A
// blocked page throws, the caller records the failure and continues.
//
//   job_boards:
//     - name: "Firecrawl — Acme careers (JS-heavy board)"
//       provider: firecrawl
//       mode: scrape            # scrape | search | crawl
//       url: https://acme.com/careers
//       job_link_pattern: "/jobs/"   # required for scrape/crawl
//       field_map:
//         title:    [name, title]
//         url:      url
//         company:  [company, companyName]
//         location: [location, city]
//       enabled: true

import { hasKey, scrapeUrl, search, crawl } from './_firecrawl.mjs';

const MIN_JD_CHARS = 200;

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function pickField(item, spec) {
  const keys = Array.isArray(spec) ? spec : [spec];
  for (const k of keys) {
    const v = get(item, k);
    if (v != null && String(v).trim() !== '') return v;
  }
  return undefined;
}
function isHttpsUrl(u) {
  try { return new URL(String(u)).protocol === 'https:'; } catch { return false; }
}

/** Map any shaped record to the scanner's Job shape. Never invents a field. */
function toJob(rec, entry) {
  const fm = entry.field_map || {};
  const title = fm.title ? pickField(rec, fm.title) : rec.title;
  const url = fm.url ? pickField(rec, fm.url) : rec.url;
  if (!title || !url || !isHttpsUrl(url)) return null;
  const out = {
    title: String(title).trim(),
    url: String(url).trim(),
    company: fm.company ? (pickField(rec, fm.company) ?? entry.defaults?.company ?? '') : (entry.defaults?.company ?? ''),
    location: fm.location ? (pickField(rec, fm.location) ?? '') : (rec.location ?? ''),
  };
  if (fm.description) {
    const d = pickField(rec, fm.description);
    if (d && String(d).length >= MIN_JD_CHARS) out.description = String(d);
  }
  return out;
}

/** Pull job-ish links out of a markdown/HTML body, for mode: scrape. */
function linksFrom(body, pattern) {
  if (!body) return [];
  const re = new RegExp(pattern, 'gi');
  const out = [];
  for (const m of body.matchAll(/\[([^\]]{3,160})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const [, text, href] = m;
    if (!re.test(href)) continue;
    out.push({ title: text.trim(), url: href });
  }
  // also plain anchors in raw HTML
  for (const m of String(body).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const [, href, inner] = m;
    if (!re.test(href)) continue;
    const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) out.push({ title: t, url: href });
  }
  return out;
}

export default {
  provider: {
    id: 'firecrawl',

    detect() { return null; },  // keyed providers never auto-detect

    async fetch(entry, ctx) {
      const key = ctx?.env?.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;
      if (!hasKey(key)) {
        throw new Error('FIRECRAWL_API_KEY not set — enable firecrawl in config/plugins.yml and add the key to .env');
      }
      const mode = entry.mode || 'scrape';
      const timeoutMs = entry.timeout_ms ?? undefined;
      const maxResults = entry.max_results ?? 50;

      if (mode === 'search') {
        if (!entry.query) throw new Error(`firecrawl: entry ${entry.name} uses mode: search but has no 'query'`);
        const hits = await search(entry.query, { limit: Math.min(maxResults, 100), timeoutMs });
        return hits.map((h) => toJob(h, entry)).filter(Boolean);
      }

      if (!entry.url) throw new Error(`firecrawl: entry ${entry.name} is missing 'url'`);

      if (mode === 'crawl') {
        const pages = await crawl(entry.url, { limit: Math.min(maxResults, 100), timeoutMs });
        return pages.map((p) => toJob(p, entry)).filter(Boolean).slice(0, maxResults);
      }

      // mode: scrape (default) — read one page and extract its job links
      const page = await scrapeUrl(entry.url, { waitFor: entry.wait_for, timeoutMs });
      if (entry.field_map?.description) {
        // a single posting page
        const one = toJob({ ...page, ...(entry.field_map.company ? { company: entry.defaults?.company } : {}) }, entry);
        return one ? [one] : [];
      }
      if (!entry.job_link_pattern) {
        throw new Error(`firecrawl: entry ${entry.name} uses mode: scrape on a listing page but has no 'job_link_pattern' (e.g. "/jobs/")`);
      }
      const links = linksFrom(page.markdown || page.title, entry.job_link_pattern);
      const seen = new Set();
      return links
        .filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)))
        .slice(0, maxResults)
        .map((l) => toJob(l, entry))
        .filter(Boolean);
    },
  },
};
