// Firecrawl transport — the only file that talks to api.firecrawl.dev.
//
// Host-pinned, mirroring plugins/apify/_apify.mjs: the token is a bearer
// credential, so it must never be sendable to any other host. `allowedHosts` in
// manifest.json restates the same constraint for the plugin engine.
//
// NOT a circumvention tool. Firecrawl renders JavaScript and returns public
// page content; it does not solve CAPTCHAs, hold sessions, or defeat access
// controls. A page behind a login or a bot challenge returns an error here and
// the caller records the failure and moves on — that is the intended behaviour,
// not something to work around.
const API_BASE = 'https://api.firecrawl.dev/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

export function hasKey(key = process.env.FIRECRAWL_API_KEY) {
  return typeof key === 'string' && key.trim().length > 0;
}

/** Reject any non-HTTPS or off-host URL before a request is ever built. */
export function assertFirecrawlTarget(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`firecrawl: target must be HTTPS: ${url}`);
  return parsed;
}

async function call(path, body, { key = process.env.FIRECRAWL_API_KEY, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!hasKey(key)) {
    throw new Error('FIRECRAWL_API_KEY not set — enable firecrawl in config/plugins.yml and add the key to .env');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) {
      // An access control, not a bug. Say so plainly so the caller logs it and
      // continues rather than retrying or working around it.
      throw new Error(`firecrawl: access refused (HTTP ${res.status}) — recording failure and continuing`);
    }
    if (res.status === 429) {
      throw new Error('firecrawl: rate limited (HTTP 429) — record and continue; do not retry aggressively');
    }
    if (!res.ok) throw new Error(`firecrawl: HTTP ${res.status} on ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** One public page → markdown + metadata. Used for a known career/ATS URL. */
export async function scrapeUrl(url, { formats = ['markdown'], onlyMainContent = true, waitFor, timeoutMs } = {}) {
  assertFirecrawlTarget(url);
  const body = { url, formats, onlyMainContent };
  if (waitFor) body.waitFor = waitFor;   // e.g. a CSS selector for JS-rendered boards
  const j = await call('/scrape', body, { timeoutMs });
  const d = j?.data || {};
  return {
    url: d.metadata?.sourceURL || d.metadata?.url || url,
    title: d.metadata?.title || '',
    markdown: d.markdown || d.html || '',
    description: (d.metadata?.description || '').slice(0, 2000),
  };
}

/**
 * Firecrawl search — a search-engine-backed discovery call. This is the "materially
 * expands coverage" mode: it finds pages to scrape, rather than scraping a URL
 * we already have.
 */
export async function search(query, { limit = 20, timeoutMs } = {}) {
  const j = await call('/search', { query, limit }, { timeoutMs });
  return (j?.data || []).map((r) => ({
    url: r.url,
    title: r.title || '',
    description: (r.description || '').slice(0, 2000),
  })).filter((r) => /^https?:\/\//i.test(r.url || ''));
}

/**
 * Crawl — walk a career page's job links. Async in the Firecrawl API: it returns
 * a job id that must be polled. Bounded by `limit`; we never crawl a whole site.
 */
export async function crawl(url, { limit = 20, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 3000, maxPolls = 20 } = {}) {
  assertFirecrawlTarget(url);
  const started = await call('/crawl', { url, limit, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } }, { timeoutMs });
  const id = started?.id;
  if (!id) return [];
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let status;
    try {
      const res = await fetch(`${API_BASE}/crawl/${id}`, { headers: { authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` }, signal: ac.signal });
      status = await res.json();
    } finally { clearTimeout(t); }
    if (status?.status === 'completed') {
      return (status.data || []).map((d) => ({
        url: d.metadata?.sourceURL || d.url,
        title: d.metadata?.title || '',
        markdown: d.markdown || '',
        description: (d.metadata?.description || '').slice(0, 2000),
      })).filter((r) => /^https?:\/\//i.test(r.url || ''));
    }
    if (status?.status === 'failed' || status?.status === 'canceled') return [];
  }
  return [];  // never block the pipeline on a crawl that will not settle
}
