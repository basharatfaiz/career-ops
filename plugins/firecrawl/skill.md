# Firecrawl provider plugin

Optional, keyed job source. Adds coverage for **public** pages the existing
lightweight discovery cannot read — JavaScript-heavy career boards, and career
pages that return no server-rendered job links.

## What it is for

Use it when:

- an existing discovery result already has a **career-page URL** that the
  lightweight resolver could not parse;
- an **ATS page needs structured extraction** (Greenhouse, Lever, Ashby,
  Workable, or another public board);
- a **JavaScript-heavy public career page** yields no job links over plain HTTP;
- **Firecrawl search** would materially expand coverage beyond the board feeds.

It is an **additional** source. Search/index discovery, the ATS APIs, the board
feeds, direct career pages and local Playwright all keep working with no key set.

## What it is NOT for

Firecrawl renders JavaScript and reads public page content. It does **not**:

- solve CAPTCHAs,
- hold logins or bypass authentication,
- defeat access controls, bot protection or rate limits,
- circumvent robots.txt or any access restriction.

When a page is blocked, the provider **records the failure and continues** with
the other sources. That is the intended behaviour, not something to retry hard
or route around.

## Setup

1. `node plugins.mjs enable firecrawl --confirm`
2. Put `FIRECRAWL_API_KEY=…` in `.env`
3. Add entries to `portals.yml → job_boards:` with `provider: firecrawl`
4. `node plugins.mjs run firecrawl`

Without a key the provider reports itself disabled and the free/local pipeline
is unaffected.

## Configuration (all in portals.yml)

| Key | Meaning |
|---|---|
| `mode` | `scrape` (default, one page) · `search` (query, returns URLs) · `crawl` (walk a career page's job links) |
| `url` | target page — required for `scrape` and `crawl` |
| `query` | search string — required for `search` |
| `job_link_pattern` | regex a link must match to count as a posting — required for `scrape` on a listing page |
| `field_map` | which fields hold title / url / company / location / description. Each is a key or an ordered list of fallback keys |
| `defaults.company` | fallback company when the page omits it |
| `wait_for` | CSS selector to wait for on a JS-rendered page |
| `timeout_ms` | per-request timeout |
| `max_results` | cap on returned postings |
| `enabled` | on/off |

## Example

```yaml
job_boards:
  - name: "Firecrawl — Acme careers (JS-heavy)"
    provider: firecrawl
    mode: scrape
    url: https://acme.com/careers
    job_link_pattern: "/jobs/"
    field_map:
      title: [name, title]
      url: url
      company: [company, companyName]
    max_results: 40
    enabled: true
```
