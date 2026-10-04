// Generates the optional scraper source configs for portals.yml.
// Written as DATA, appended under job_boards by a separate step, so the query
// matrix is reviewable before it touches the config.
//
// Geography here is a QUERY TERM, never a filter: these widen what we ask for.
// There is no allow-list and no block list — the seniority gate and triage
// decide what survives, exactly as for every other source.
export const TITLES = [
  'Product Designer',
  'Senior Product Designer',
  'Sr Product Designer',
  'Product Designer II',
  'Product Designer III',
  'AI Product Designer',
  'AI/UX Product Designer',
  'Senior UX/Product Designer',
];

export const GEOGRAPHIES = [
  'India', 'Bengaluru', 'Hyderabad', 'Delhi NCR', 'Mumbai', 'Pune',
  'Chennai', 'Gurgaon', 'Noida', 'Remote', 'Global remote', 'UK', 'EU',
];

/** Rows for portals.yml job_boards, one per title×geography pair. */
export function apifyEntries() {
  const out = [];
  for (const t of TITLES) {
    for (const g of GEOGRAPHIES) {
      out.push({
        name: `Apify — ${t} · ${g}`,
        provider: 'apify',
        // Not hard-coded to one Actor on purpose: any Apify Actor whose dataset
        // items expose a title + url can be mapped. Override per entry.
        actor: 'apify/google-search-scraper',
        input: { queries: [`${t} jobs ${g}`], maxCrawlPages: 1, resultsPerPage: 20 },
        field_map: {
          title: ['title', 'name', 'jobTitle', 'position'],
          url: ['url', 'link', 'jobUrl'],
          company: ['companyName', 'company', 'employer'],
          location: ['location', 'formattedLocation', 'city'],
        },
        timeout_ms: 180000,
        max_results: 40,
        enabled: false,   // stays off until a key exists AND the plugin is enabled
      });
    }
  }
  return out;
}

export function firecrawlEntries() {
  return [
    {
      name: 'Firecrawl — search: Senior Product Designer India',
      provider: 'firecrawl', mode: 'search', query: '"Senior Product Designer" India jobs',
      field_map: { title: ['title'], url: ['url'], company: ['company'], location: ['location'] },
      max_results: 40, timeout_ms: 90000, enabled: false,
    },
    {
      name: 'Firecrawl — search: Product Designer Bengaluru',
      provider: 'firecrawl', mode: 'search', query: '"Product Designer" Bengaluru jobs',
      field_map: { title: ['title'], url: ['url'], company: ['company'], location: ['location'] },
      max_results: 40, timeout_ms: 90000, enabled: false,
    },
    {
      name: 'Firecrawl — search: AI Product Designer remote',
      provider: 'firecrawl', mode: 'search', query: '"AI Product Designer" remote jobs',
      field_map: { title: ['title'], url: ['url'], company: ['company'], location: ['location'] },
      max_results: 40, timeout_ms: 90000, enabled: false,
    },
    {
      name: 'Firecrawl — search: Product Designer greenhouse lever ashby',
      provider: 'firecrawl', mode: 'search',
      query: '"Product Designer" (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:apply.workable.com)',
      field_map: { title: ['title'], url: ['url'], company: ['company'], location: ['location'] },
      max_results: 50, timeout_ms: 90000, enabled: false,
    },
    // Company career pages that the lightweight resolver could not parse.
    // `job_link_pattern` decides what counts as a posting link; nothing is invented.
    {
      name: 'Firecrawl — scrape: JS-heavy career page (template)',
      provider: 'firecrawl', mode: 'scrape',
      url: 'https://REPLACE-WITH-A-CAREERS-PAGE/careers',
      job_link_pattern: '/(job|jobs|career|vacanc|position|opening)[^/]*',
      field_map: { title: ['title'], url: ['url'], company: [], location: [] },
      defaults: { company: 'REPLACE-WITH-COMPANY' },
      wait_for: undefined, max_results: 40, timeout_ms: 90000, enabled: false,
    },
  ];
}
