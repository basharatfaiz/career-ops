#!/usr/bin/env node
/**
 * apify-valig.mjs, discovery source 4: valig/linkedin-jobs-scraper on Apify.
 *
 * WHY THIS ACTOR (measured, not assumed (see apify-headtohead.mjs):
 *   valig/linkedin-jobs-scraper  40 raw -> 30 kept (75% precision)  $0.00057/kept
 *   curious_coder/linkedin-...    20 raw -> 10 kept (50% precision)  $0.00400/kept
 *   cheap_scraper/linkedin-...   150 raw ->  5 kept (3% precision)   $0.02200/kept
 * Two identical runs returned byte-identical results (Jaccard 1.000 on the
 * LinkedIn id, the posting URL, company+title+location, and this repo's own
 * identityKey), so repeat scans are reproducible and dedup can rely on any
 * single field.
 *
 * LINKEDIN IS DISCOVERY-ONLY, AND MEASURED TO HAVE NO ALTERNATIVE.
 *   The measured direct-application-URL rate is 0% for all three Actors tested.
 *   valig leaves `applyUrl` EMPTY even on rows it marks applyType=EXTERNAL.
 *   Its README advertises "direct application URLs"; the field is never filled.
 *   So this source harvests company + title + location, and the employer ATS URL
 *   is resolved separately by the repo's existing key-free resolvers. Consistent
 *   with the standing rule that LinkedIn/Naukri/Indeed are never apply targets.
 *
 * It is IDLE without a key, exactly like public-search and firecrawl, so
 * importing it never spends anything on its own.
 *
 * Env:
 *   APIFY_TOKEN   Apify API token. Absent => IDLE, zero cost.
 */

const ACTOR = 'valig~linkedin-jobs-scraper';
const API = 'https://api.apify.com/v2';

// The published per-event prices for this Actor at the FREE tier, read from the
// run record's pricingInfo. Used ONLY to project a cost before the run so the
// caller can see the ceiling; the ACTUAL charge is read back from chargedEventCounts.
export const PRICE_PER_RESULT_USD = 0.0004;
export const PRICE_PER_START_USD = 0.001;

export function hasKey() {
  return !!(process.env.APIFY_TOKEN || '').trim();
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** The ten titles this campaign targets, 2026-09-27. These are SEARCH queries,
 *  and they are deliberately NOT deduplicated down to one: LinkedIn ranks each
 *  phrase differently, so "Product Designer" and "Product UX Designer" surface
 *  different slices of the same market, and a real miss in any one of them is
 *  invisible in the scan summary. The breadth is the point.
 *
 *  Note the title GATE does not need ten spellings. The normaliser in
 *  title-keywords.mjs canonicalises all of these onto a small number of
 *  positive forms, so the same roles are accepted whether they arrive as
 *  "Product/UX Designer", "Product UX Designer" or "UX/UI Product Designer".
 *  Search breadth and gate breadth are deliberately separate concerns.
 */
export const DEFAULT_KEYWORDS = [
  'Product Designer',
  'Senior Product Designer',
  'Product/UX Designer',
  'Product UX Designer',
  'UI/UX Designer',
  'UX/UI Designer',
  'UI/UX Product Designer',
  'UX/UI Product Designer',
  'AI Product Designer',
  'AI/UX Product Designer',
];

/** Server-side negative filtering. Every entry here was OBSERVED being paid for
 *  and then discarded by the title gate in the measured run, so excluding it
 *  upstream is money saved rather than coverage lost. Titles the gate accepts
 *  are untouched: the repo's own title filter still runs afterwards and remains
 *  the authority on what is kept. */
export const DEFAULT_TITLE_EXCLUDE = [
  'Product Engineer', 'Design Engineer', 'Mechanical', 'Solidworks', 'Inventor',
  'CATIA', 'Unigraphics', 'Plastics', 'Furniture', 'Apparel', 'Fashion',
  'Graphic Designer', 'Motion Designer', 'Visual Designer', 'Creative',
  'Intern', 'Internship', 'Product Manager', 'Product Owner', 'Product Analyst',
  'Business Analyst', 'Business Process', 'Service Designer',
  'Product Specialist', 'Software Engineer', 'Frontend', 'Full-Stack', 'Full Stack',
  'Biomedical', 'Data Scientist', 'NPD',
];

/** The India-explicit rule, enforced HERE as well as in the geo gate, because a
 *  paid result that cannot be eligible is wasted money. A role qualifies only if
 *  the posting's OWN location names India or an Indian place. An Indian employer
 *  is NOT sufficient and never counts on its own. */
const INDIA_PLACE = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|new delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|cochin|indore|chandigarh|coimbatore|bhubaneswar|nagpur|vadodara|thiruvananthapuram|trivandrum|mysore|mysuru|mangaluru|manipal|trichy|tiruchirappalli|secunderabad|goa|panaji|guwahati|patna|ranchi|bhopal|thanjavur|kozhikode|andhra pradesh|telangana|karnataka|maharashtra|tamil nadu|west bengal|gujarat|rajasthan|punjab|haryana|odisha|uttar pradesh|uttarakhand|madhya pradesh|assam|jharkhand|chhattisgarh)\b/i;

export function isIndiaExplicit(location) {
  return INDIA_PLACE.test(norm(location));
}

const LINKEDIN_VIEW = /linkedin\.com\/jobs\/view/i;

/** Classify what a record actually is. Split out so it can be unit-tested
 *  without spending a credit. */
export function classifyRow(row) {
  const location = norm(row?.location);
  const title = norm(row?.title);
  const url = norm(row?.url);
  const applyUrl = norm(row?.applyUrl);
  return {
    title,
    company: norm(row?.companyName),
    location,
    url,
    applyUrl,
    postedAt: norm(row?.postedDate),
    // Discovery-only is a FACT about the data, not a policy choice: measured
    // applyUrl was empty on 40/40 valig rows including all 21 EXTERNAL ones.
    applyTarget: !!(applyUrl && !LINKEDIN_VIEW.test(applyUrl)),
    applyType: norm(row?.applyType),
    id: norm(row?.id),
    description: norm(row?.description),
    indiaExplicit: isIndiaExplicit(location),
  };
}

/**
 * Remove anything token-shaped from a string before it is logged or stored.
 *
 * The Apify API takes the token as a `?token=` QUERY PARAMETER, which means the
 * secret rides inside a URL. Any string that ends up in an error message, a log
 * line, or a persisted stats blob is therefore one echoed request away from
 * printing the credential, and the usual places it would surface are a response
 * body, a thrown fetch error, or a run statusMessage. This is a cheap belt on top
 * of never formatting the token directly: it costs nothing and it means a
 * credential cannot leak through a path nobody audited.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function scrubToken(v) {
  return String(v ?? '')
    .replace(/([?&]token=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(apify_api_)[A-Za-z0-9_-]+/g, '$1<redacted>')
    .replace(/\b(fc-[A-Za-z0-9_-]{6,})\b/g, '<redacted>');
}

async function apiGet(path, token) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(scrubToken(`apify GET ${path} -> HTTP ${r.status}`));
  return r.json();
}

/** Items out of a dataset endpoint.
 *
 *  BUG THIS EXISTS TO PREVENT: `/v2/datasets/{id}/items` answers with a BARE
 *  JSON ARRAY. It is not wrapped in `{data: [...]}`, which is what the run
 *  endpoints use. Reading `.data` off it gives undefined, so a run that
 *  SUCCEEDED and billed 30 results was scored as 0 rows found and the paid data
 *  was discarded. That happened on 2026-09-27 and cost $0.13 across 10 queries.
 *  Both shapes are accepted here so a future change to the response cannot
 *  silently cost money again.
 */
function datasetItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

async function waitForRun(token, runId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await apiGet(`/actor-runs/${runId}?waitForFinish=45`, token);
    const d = j?.data || {};
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(d.status)) return d;
    if (Date.now() > deadline) return d;
  }
}

/**
 * @param {object} o
 * @param {string[]} [o.keywords]        queries to run, deduped across runs
 * @param {string}   [o.location]        free-text location, broad India. No
 *                                       per-city fan-out: measured, the fan-out
 *                                       returned FEWER results at worse
 *                                       precision, so it is not used.
 * @param {string}   [o.datePosted]      valig enum: r86400 | r604800 | r2592000
 * @param {number}   [o.limit]           max results per keyword
 * @param {string[]} [o.titleExclude]    server-side negatives
 * @param {string[]} [o.skipJobId]       LinkedIn ids already seen, so repeat
 *                                       runs are not re-paid for
 * @param {number}   [o.maxTotalChargeUsd] hard billing cap for the WHOLE call
 * @param {boolean}  [o.dryRun]          build the plan, spend nothing
 * @param {string[]} [o.replayDatasetIds] drain datasets from ALREADY-PAID runs
 *                                       instead of starting new ones. Costs nothing.
 */
export async function discover({
  keywords = DEFAULT_KEYWORDS,
  location = 'India',
  datePosted = 'r604800',
  limit = 40,
  titleExclude = DEFAULT_TITLE_EXCLUDE,
  skipJobId = [],
  maxTotalChargeUsd = 0.15,
  log = () => {},
  dryRun = false,
  replayDatasetIds = null,
} = {}) {
  const meter = { queries: 0, results: 0, rows: 0, indiaExplicit: 0, costUsd: 0, capUsd: maxTotalChargeUsd, errors: [] };

  // Cost ceiling is computed FIRST, from the published prices, and BEFORE the key
  // is even looked at. Two reasons, the second being the one that matters:
  //   1. it is the honest pre-flight: nothing is charged until the ceiling is
  //      known to sit inside the cap;
  //   2. it makes the PLAN reportable with no credentials at all. Turning this
  //      source on for a schedule means answering "does one pass fit the cap?"
  //      before a token exists, and a dry run that replied "token not set"
  //      instead of the number would make that question unanswerable.
  const projected = keywords.length * (limit * PRICE_PER_RESULT_USD + PRICE_PER_START_USD);
  meter.projectedUsd = Number(projected.toFixed(5));
  if (projected > maxTotalChargeUsd) {
    return {
      ran: false, opps: [], meter,
      reason: `refusing to start: ${keywords.length} keyword(s) x ${limit} would cost up to $${projected.toFixed(3)}, over the $${maxTotalChargeUsd} cap. Lower --apify-limit or raise the cap.`,
      stats: { ran: false, projectedUsd: meter.projectedUsd, capUsd: maxTotalChargeUsd, withinCap: false, keywords: keywords.length, limit },
    };
  }

  if (dryRun) {
    return {
      ran: false, dryRun: true, opps: [], meter,
      reason: `dry run: ${keywords.length} keyword(s) x ${limit}, projected $${projected.toFixed(5)} of a $${maxTotalChargeUsd} cap`,
      stats: {
        ran: false, projectedUsd: meter.projectedUsd, capUsd: maxTotalChargeUsd, withinCap: true,
        keywords, location, datePosted, limit,
        perResultUsd: PRICE_PER_RESULT_USD, perStartUsd: PRICE_PER_START_USD,
        billedWorstCase: limit * keywords.length,
      },
    };
  }

  if (!hasKey()) {
    return { ran: false, reason: 'APIFY_TOKEN not set in .env', opps: [], meter, stats: { ran: false, projectedUsd: meter.projectedUsd, capUsd: maxTotalChargeUsd, withinCap: true } };
  }
  const token = process.env.APIFY_TOKEN.trim();

  const seenUrl = new Set();
  const seenId = new Set();
  const rows = [];
  let budget = maxTotalChargeUsd;

  // REPLAY: read datasets from runs that were already billed, spending nothing.
  // A run that succeeds but whose results fail to read must never be re-paid
  // for, so the paid dataset ids are passed back in and drained here.
  if (Array.isArray(replayDatasetIds) && replayDatasetIds.length) {
    for (const dsId of replayDatasetIds) {
      try {
        const body = await apiGet(`/datasets/${dsId}/items?clean=1&limit=${limit + 10}`, token);
        const items = datasetItems(body);
        for (const item of items) {
          const c = classifyRow(item);
          meter.rows++;
          const idk = c.id || c.url;
          if (idk && seenId.has(idk)) continue;
          if (c.url && seenUrl.has(c.url.split('?')[0])) continue;
          if (idk) seenId.add(idk);
          if (c.url) seenUrl.add(c.url.split('?')[0]);
          rows.push(c);
        }
        meter.results += items.length;
        log(`    replay ${dsId}: ${items.length} rows (no charge)`);
      } catch (e) {
        meter.errors.push(scrubToken(`replay ${dsId}: ${e.message}`).slice(0, 120));
      }
    }
    meter.costUsd = 0;
    const indiaRowsR = rows.filter((r) => r.indiaExplicit);
    const offsiteR = rows.filter((r) => r.applyTarget).length;
    return {
      ran: true, replayed: true, meter, rows, opps: indiaRowsR, seenIds: [...seenId].filter(Boolean),
      stats: {
        ran: true, replayed: true, queries: 0, results: meter.results, rows: rows.length,
        indiaExplicit: indiaRowsR.length, applyTargets: offsiteR, seenIds: seenId.size,
        costUsd: 0, projectedUsd: 0, discoveryOnly: offsiteR === 0,
      },
    };
  }

  for (const kw of keywords) {
    if (budget <= 0) { meter.errors.push('budget exhausted, stopped before running remaining keywords'); break; }
    const input = { keywords: kw, location, datePosted, limit };
    if (titleExclude.length) input.titleExclude = titleExclude;
    if (skipJobId.length) input.skipJobId = skipJobId.slice(0, 500);
    try {
      const r = await fetch(`${API}/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, maxTotalChargeUsd: budget }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        meter.errors.push(scrubToken(`run start "${kw}": HTTP ${r.status} ${txt}`).slice(0, 120));
        if (r.status === 401 || r.status === 403) { meter.errors.push('token rejected (401/403), stopping'); break; }
        if (r.status === 429) { meter.errors.push('rate limited (429), stopping without retrying'); break; }
        continue;
      }
      const started = (await r.json())?.data;
      meter.queries++;
      log(`    apify-valig[${meter.queries}] "${kw}" -> run ${started?.id}`);
      const done = await waitForRun(token, started.id);
      const rc = done?.defaultDatasetId;
      const charge = Number(done?.pricingInfo?.totalChargeUsd ?? done?.usageTotalUsd ?? 0);
      const billed = Number(done?.chargedEventCounts?.['apify-default-dataset-item'] || 0);
      if (Number.isFinite(charge) && charge > 0) { meter.costUsd += charge; budget = Math.max(0, budget - charge); }
      else if (billed) meter.costUsd += billed * PRICE_PER_RESULT_USD;
      if (done?.status !== 'SUCCEEDED') {
        meter.errors.push(scrubToken(`run "${kw}" ended ${done?.status}${done?.statusMessage ? ': ' + done.statusMessage : ''}`).slice(0, 120));
        continue;
      }
      if (!rc) continue;
      const ds = await apiGet(`/datasets/${rc}/items?clean=1&limit=${limit + 10}`, token);
      const items = datasetItems(ds);
      for (const item of items) {
        const c = classifyRow(item);
        meter.rows++;
        // Dedup across keywords inside one pass, and against ids we already paid for.
        const idk = c.id || c.url;
        if (idk && seenId.has(idk)) continue;
        if (c.url && seenUrl.has(c.url.split('?')[0])) continue;
        if (idk) seenId.add(idk);
        if (c.url) seenUrl.add(c.url.split('?')[0]);
        rows.push(c);
      }
      meter.results += items.length;
      log(`      ${items.length} rows · billed ${billed} · running total $${meter.costUsd.toFixed(5)}`);
    } catch (e) {
      meter.errors.push(scrubToken(`"${kw}": ${e.message}`).slice(0, 120));
    }
  }

  const indiaRows = rows.filter((r) => r.indiaExplicit);
  meter.indiaExplicit = indiaRows.length;
  const offsite = rows.filter((r) => r.applyTarget).length;

  // EVERY id this pass saw, not just the ones that survived dedup or the India
  // check. skipJobId is a PAID saving, so an id that was billed for and then
  // dropped locally must still be recorded: paying twice for the same posting is
  // exactly what the flag exists to prevent, and the caller persists this list so
  // tomorrow's pass excludes it upstream.
  const seenIds = [...seenId].filter(Boolean);

  return {
    ran: true, meter, rows, opps: indiaRows, seenIds,
    stats: {
      ran: true, queries: meter.queries, results: meter.results, rows: rows.length,
      indiaExplicit: indiaRows.length, applyTargets: offsite, seenIds: seenIds.length,
      costUsd: Number(meter.costUsd.toFixed(5)), projectedUsd: meter.projectedUsd,
      discoveryOnly: offsite === 0,
    },
  };
}
