#!/usr/bin/env node
/**
 * geo-eligibility.mjs — decide whether a role is actually open to an
 * India-based candidate, from the LIVE posting text.
 *
 * The core rule: "Remote" is not eligibility. Eligibility comes from the
 * geographic scope the posting actually states, plus the sponsorship signal.
 *
 * Outputs one of:
 *   india_eligible      India explicitly in scope
 *   global_eligible     worldwide / no restriction
 *   apac_eligible       APAC scoped AND India explicitly named
 *   relocation_eligible a specific non-India location — the candidate is OPEN
 *                       TO RELOCATION (policy change 2026-09-26), so a
 *                       non-India city is no longer a rejection
 *   manual_review       plausible but unproven — NOT a rejection, NOT a pass
 *   ineligible          the posting EXPLICITLY excludes India. This is the only
 *                       geography outcome that removes a role from the queue.
 *   closed              the posting is gone
 *   seniority_excluded  the title is outside the Product Designer / Senior band
 *
 * Sponsorship is RECORDED, never used as a rejection reason: a role abroad that
 * needs sponsorship is still applied to, with the requirement stated accurately
 * (policy change 2026-09-26). The one thing that must never happen is inventing
 * work authorization outside India — the sponsor, not us, decides that.
 */

const INDIA_CITY = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|chennai|gurugram|gurgaon|trivandrum|kochi|coimbatore|ahmedabad|jaipur)\b/i;
const WORLDWIDE = /\b(worldwide|world-wide|globally|anywhere in the world|any location|no location restriction|any country|international remote|remote - worldwide|global remote)\b/i;
const APAC = /\b(apac|asia[\s-]?pacific|asia pacific|anz|australasia|india & apac|apac & india)\b/i;
const EMEA = /\b(emea|europe|eu\b|european union|eea|uk\b|united kingdom|england|scotland|ireland|netherlands|germany|france|spain|portugal|poland|sweden|denmark|finland|belgium|austria|switzerland|norway|italy|romania|bulgaria|greece|czech|turkey|uae|israel|dubai|abu dhabi|saudi)\b/i;
const NAMERICA = /\b(usa|u\.s\.a?\b|united states|us-based|u\.s\.|america|canada|north america|toronto|vancouver|new york|california|texas|washington)\b/i;
// "distinguished" is Principal-equivalent in Google's title ladder, and the
// user's reject list names it explicitly. Anchored on word boundaries so it
// cannot fire on prose.
const SENIORITY_BLOCK = /\b(principal|staff|lead|distinguished|head of design|director|manager|vp|vice president|chief|group design)\b/i;

// The ONLY geography signal that may remove a role. Everything else — a
// non-India city, EMEA, North America, APAC-other, an unstated country — is
// applied to under the open-to-relocation policy. This pattern must stay tight:
// it may only fire on language that plainly excludes India, never on a role
// that merely fails to mention India.
const INDIA_INELIGIBLE = /\b(?:cannot|can't|may not|unable to|not eligible to)\s+(?:apply|work|be employed|be based)\s+(?:from|in|within)\s+india\b|\bindia\s+(?:is|are)\s+not\s+(?:eligible|accepted|supported|available)\b|\bexclude[sd]?\s+india\b|\bnot\s+(?:available|open|supported)\s+(?:to|in)\s+(?:applicants?|candidates?)\s+(?:based\s+|residing\s+|located\s+)?(?:in\s+)?india\b/i;

// A remote role that enumerates the countries it will hire in. When such a list
// exists and omits India, the list wins over the word "Worldwide" in the title —
// the Tether case: "100% Remote Worldwide", but 19 permitted countries with no
// India among them. The list must be explicit, so a passing mention of some
// other country can never exclude a role.
const ELIGIBLE_COUNTRY_LIST = /\b(?:eligible|permitted|allowed|authori[sz]ed)\s+(?:countries|country|locations?|regions?)\b/i;

// City → region. A posting very often states only a city ("On-site in Berlin"),
// which matches no country pattern and would otherwise fall through to
// "unstated" and get treated as an unexplained manual review.
const CITY_REGION = [
  [/\b(berlin|munich|hamburg|frankfurt|cologne|düsseldorf|munich)\b/i, 'EMEA'],
  [/\b(london|manchester|edinburgh|bristol|leeds|birmingham|cambridge|oxford|reading)\b/i, 'EMEA'],
  [/\b(dublin|amsterdam|paris|lyon|madrid|barcelona|valencia|lisbon|porto|rome|milan|madrid|warsaw|krakow|kraków|prague|praha|brussels|antwerp|zurich|zurich|geneva|vienna|stockholm|oslo|helsinki|copenhagen|austin|amsterdam)\b/i, 'EMEA'],
  [/\b(toronto|vancouver|montreal|ottawa|calgary|new york|nyc|brooklyn|san francisco|sf|seattle|austin|chicago|boston|denver|los angeles|san diego|portland|philadelphia|atlanta|dallas|houston|washingto?n d\.?c\.?|miami)\b/i, 'North America'],
  [/\b(sydney|melbourne|brisbane|perth|auckland|wellington)\b/i, 'APAC-other'],
  [/\b(singapore|tokyo|osaka|seoul|hong kong|taipei|manila|jakarta|bangkok|ho chi minh|phnom penh)\b/i, 'APAC-other'],
  [/\b(tel aviv|jerusalem|haifa|abu dhabi|dubai|riyadh|doha|kuwait city)\b/i, 'EMEA'],
];
const cityRegion = (t) => { for (const [re, r] of CITY_REGION) if (re.test(t)) return r; return null; };

const SPON_AVAILABLE = /\b(we (can|will) (provide|offer|support) (work )?(authori[sz]ation|visa)?\s*sponsorship|sponsorship (is )?(available|provided|offered)|we sponsor|visa sponsorship available|we will sponsor|relocation (support|package) (is )?(available|offered|provided))\b/i;
const SPON_UNAVAILABLE = /\b(no (visa )?sponsorship|not able to sponsor|cannot sponsor|unable to sponsor|sponsorship (is )?(not available|unavailable)|without sponsorship|we do not sponsor|must (already )?be (legally )?(authorized|eligible) to work|must have the right to work|existing work authorization|you must be authorized)\b/i;
const SPON_UNCLEAR = /\b(sponsorship|visa|authori[sz]ation|right to work|work permit|relocat)\b/i;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} postingText  full visible text of the live posting
 * @param {string} url
 * @param {string} title
 * @param {object} opts { queueLocation, queueRole }
 */
export function classifyGeography({ postingText = '', url = '', title = '', queueLocation = '', queueRole = '', locationHint = '', primaryLocation = '' } = {}) {
  const raw = norm(postingText);
  // Strip EEO / benefits boilerplate before scanning for geography. MaintainX's
  // Toronto role mentions "United States" and (elsewhere) India inside Autodesk
  // benefits and equal-opportunity text; scanning the raw page turned a Canada
  // role into "india_eligible" because the incidental mention outranked the
  // actual location field.
  const text = norm(raw
    .split(/(?<=\.)\s+/)
    .filter((s) => !/equal opportunity|benefits differ by country|accommodation|reasonable accommodation|we are an equal|non-?discrimination|affirmative action|diversity|gender identity|protected characteristics|legal first|equal employer/i.test(s))
    .join(' '));
  const hay = `${title} ${queueRole} ${url}`;
  const prim = norm(primaryLocation || '');

  // ── HARD EXCLUSIONS RUN FIRST, ALWAYS ──────────────────────────────────
  // Regression guard (found by geo-campaign-tests.mjs, 2026-09-26): these four
  // checks used to sit BELOW the structured-location early return, so any
  // posting that exposed a location field skipped them entirely. A "Principal
  // Product Designer" role in Bengaluru classified as india_eligible and was
  // applied to, because the seniority gate never ran. Every gate below must
  // therefore execute before any early return — that is the whole point of a
  // gate. `prim` is now computed above so the country-list check can use it.
  if (/sorry,? this job posting is no longer available|position (has been )?filled|no longer (accepting|open)|posting (has been )?(closed|expired)|we are no longer/i.test(text)) {
    return { classification: 'closed', workArrangement: null, geography: null, allowedCountries: [], sponsorship: 'n/a', rationale: 'posting states it is closed or no longer available' };
  }
  // The one geography outcome that removes a role: the posting says outright
  // that India cannot apply. Checked against the posting prose only — never
  // inferred from a location the posting simply does not mention.
  if (INDIA_INELIGIBLE.test(text)) {
    return { classification: 'ineligible', workArrangement: null, geography: 'explicitly excludes India', allowedCountries: [], sponsorship: 'n/a', rationale: 'posting explicitly states India-based applicants are not eligible — the only geography-based removal under the relocation policy' };
  }
  // "Worldwide" in a title does not survive an explicit country list that omits
  // India. The list has to actually enumerate several countries, otherwise a
  // single stray mention could wrongly exclude a role.
  const worldFlag = WORLDWIDE.test(text) || WORLDWIDE.test(locationHint) || WORLDWIDE.test(prim);
  if (worldFlag && ELIGIBLE_COUNTRY_LIST.test(text)) {
    const listed = [...text.matchAll(/\b(United Kingdom|United States|Canada|Germany|Netherlands|Singapore|Australia|Ireland|Poland|Spain|France|Brazil|UAE|Israel|Mexico|Japan|Philippines|Vietnam|Indonesia|Nigeria|Kenya|South Africa|Switzerland|Italy|Portugal|Belgium|Denmark|Sweden|Norway|Finland|Romania|Bulgaria|Greece|Czechia|Hungary|Croatia|Serbia|Ukraine|Georgia|Armenia|Kazakhstan|Uzbekistan|Malaysia|Thailand|Cambodia|Myanmar|Sri Lanka|Bangladesh|Pakistan|Qatar|Kuwait|Bahrain|Oman|Saudi Arabia|Egypt|Morocco|Ghana|Tanzania|Uganda|Senegal|Ethiopia|Colombia|Chile|Peru|Uruguay|Paraguay|Bolivia|Ecuador|Panama|Costa Rica|Guatemala|Honduras|Nicaragua|El Salvador|Dominican Republic|Jamaica|Trinidad|New Zealand)\b/g)].map((m) => m[1]);
    const uniq = [...new Set(listed)];
    if (uniq.length >= 4 && !uniq.some((c) => /India/i.test(c)) && !INDIA_CITY.test(text)) {
      return { classification: 'ineligible', workArrangement: 'remote', geography: 'eligible-country list excludes India', allowedCountries: uniq, sponsorship: 'n/a', excludedBy: 'remote_country_list', rationale: `posting enumerates ${uniq.length} eligible countries for this remote role (${uniq.slice(0, 6).join(', ')}…) and India is not among them — the explicit list overrides "Worldwide" in the title`, locationField: null };
    }
  }
  // Guard against the word appearing only inside JD prose about other companies
  // or about "no management experience required": require it near the start,
  // where a real title lives. Only the TITLE, the location hint and the URL
  // slug are inspected — never the JD body — so a Senior Product Designer whose
  // description is full of "lead" and "end-to-end" is not caught by this.
  const senM = SENIORITY_BLOCK.exec(norm(title) + ' || ' + norm(locationHint) + ' || ' + (url.match(/\/([^/]+)$/)?.[1] || ''));
  if (senM) {
    return { classification: 'seniority_excluded', workArrangement: null, geography: null, allowedCountries: [], sponsorship: 'n/a', excludedTerm: senM[0], rationale: `live posting title reads "${senM[0]}" — outside the Product Designer / Senior band` };
  }

  // The structured location field beats any prose scan when the page exposes one.
  if (prim) {
    const primHasIndia = INDIA_CITY.test(prim);
    const primHasWorld = WORLDWIDE.test(prim);
    const primRegion = cityRegion(prim);
    const primNA = NAMERICA.test(prim) || primRegion === 'North America';
    const primEMEA = EMEA.test(prim) || primRegion === 'EMEA';
    const primApac = APAC.test(prim) || primRegion === 'APAC-other';
    let g = null, rationale = '';
    if (primHasIndia) { g = ['india_eligible', 'India', "the posting's own Location field names India"]; }
    else if (primHasWorld) { g = ['global_eligible', 'worldwide', "the posting's own Location field says worldwide"]; }
    else if (primNA) { g = ['relocation_eligible', 'North America / US', `the posting's own Location field reads "${prim}" — outside India, but the candidate is open to relocation`]; }
    else if (primEMEA) { g = ['relocation_eligible', 'EMEA', `the posting's own Location field reads "${prim}" — outside India, but the candidate is open to relocation`]; }
    else if (primApac) { g = ['relocation_eligible', 'APAC (India not named)', `the posting's own Location field reads "${prim}" — APAC outside India, but the candidate is open to relocation`]; }
    if (g) {
      const arrangement = /\bhybrid\b/i.test(raw) ? 'hybrid' : /\bon-?site\b|\bin office\b/i.test(raw) ? 'onsite' : /\bremote\b/i.test(raw) ? 'remote' : 'unstated';
      const sponsorship = g[0] === 'india_eligible' ? 'not_required'
        : SPON_AVAILABLE.test(raw) ? 'explicitly_available'
          : SPON_UNAVAILABLE.test(raw) ? 'explicitly_unavailable'
            : SPON_UNCLEAR.test(raw) ? 'unclear' : 'unstated';
      const sponsorshipNote = sponsorship === 'not_required' ? 'India-based role — authorized in India, no sponsorship needed'
        : sponsorship === 'explicitly_available' ? 'posting states sponsorship / work-authorization support is available'
          : sponsorship === 'explicitly_unavailable' ? 'posting states sponsorship is not available / candidate must already be authorized there'
            : sponsorship === 'unclear' ? 'posting mentions sponsorship or authorization without resolving it'
              : 'posting says nothing about sponsorship';
      if (g[0] === 'relocation_eligible') {
        return { classification: 'relocation_eligible', workArrangement: arrangement, geography: g[1], allowedCountries: [], sponsorship, sponsorshipNote, relocationRequired: true, rationale: g[2] + (sponsorship === 'explicitly_unavailable' ? ' — posting states sponsorship is unavailable, so the employer may not be able to hire from abroad; recorded, not treated as a rejection' : ''), locationField: prim };
      }
      return { classification: g[0], workArrangement: arrangement, geography: g[1], allowedCountries: [], sponsorship, sponsorshipNote, rationale: g[2], locationField: prim };
    }
  }
  // The seniority check must see the LIVE posting, not just a title field: a
  // "Product Designer" queue row redirected to a Principal posting, where the
  // word only appears in the page's heading and its URL. (This now runs above,
  // before the structured-location early return — see the regression note there.)
  const liveIdentity = `${title} ${locationHint ? '' : ''}${url} ${(text || '').slice(0, 600)}`;

  // ── work arrangement ─────────────────────────────────────────────────
  const arrangement = /\bhybrid\b/i.test(text) ? 'hybrid'
    : /\bon-?site\b|\bin office\b|\bin-person\b/i.test(text) ? 'onsite'
      : /\bremote\b|\bwork from home\b|\bwfh\b/i.test(text) ? 'remote' : 'unstated';

  // ── geography scope ──────────────────────────────────────────────────
  // The URL is part of the LIVE posting's own metadata, not boilerplate, and
  // Workday encodes the location in its path (".../Bengaluru-Karntaka-India/…",
  // "/IN---Bengaluru---Office/…"). Workday renders client-side, so on a slow
  // page the prose scan finds nothing while the URL plainly names the country.
  // Reading the path is what stops every India Workday role from falling
  // through to manual_review purely because of render timing.
  const hasIndia = INDIA_CITY.test(text) || INDIA_CITY.test(locationHint) || INDIA_CITY.test(url);
  const hasWorld = WORLDWIDE.test(text) || WORLDWIDE.test(locationHint);
  const hasApac = APAC.test(text) || APAC.test(locationHint);
  const hasEmea = EMEA.test(text) || EMEA.test(locationHint);
  const hasNA = NAMERICA.test(text) || NAMERICA.test(locationHint);
  // A city that maps to a region counts as that region, so "On-site in Berlin"
  // is EMEA rather than "unstated".
  const cityRegionHit = cityRegion(`${locationHint} ${text.slice(0, 900)}`);

  // explicit list of allowed countries, when the posting enumerates them
  const allowedCountries = [];
  const listMatch = text.match(/[^.]*?\b(?:eligible|allowed|authori[sz]ed|open to|based in|located in|residing in|candidates? (?:from|in)|work from)\b[^.]*?\./gi);
  if (listMatch) {
    for (const s of listMatch.slice(0, 4)) {
      for (const m of s.matchAll(/\b(India|United Kingdom|United States|Canada|Germany|Netherlands|Singapore|Australia|Ireland|Poland|Spain|France|Brazil|UAE|Israel|Mexico|Japan|Philippines|Vietnam|Indonesia|Nigeria|Kenya|South Africa)\b/g)) {
        if (!allowedCountries.includes(m[1])) allowedCountries.push(m[1]);
      }
    }
  }

  let classification, geography, rationale;
  if (hasIndia) {
    classification = 'india_eligible';
    geography = 'India';
    rationale = 'posting explicitly names India in scope';
  } else if (hasWorld) {
    classification = 'global_eligible';
    geography = 'worldwide';
    rationale = 'posting states worldwide / no location restriction';
  } else if (hasApac && hasIndia) {
    classification = 'apac_eligible';
    geography = 'APAC (India named)';
    rationale = 'APAC scope with India explicitly included';
  } else if (hasApac) {
    classification = 'manual_review';
    geography = 'APAC (India not named)';
    rationale = 'APAC scope but India is not explicitly listed — needs a human check, not an automatic pass';
  } else if (hasEmea || cityRegionHit === 'EMEA') {
    classification = 'relocation_eligible';
    geography = 'EMEA';
    rationale = 'scope is EMEA — outside India, but the candidate is open to relocation';
  } else if (hasNA || cityRegionHit === 'North America') {
    classification = 'relocation_eligible';
    geography = 'North America / US';
    rationale = 'scope is US/North America — outside India, but the candidate is open to relocation';
  } else if (cityRegionHit === 'APAC-other') {
    classification = 'relocation_eligible';
    geography = 'APAC (India not named)';
    rationale = 'APAC-region posting that does not name India — outside the confirmed scope, but the candidate is open to relocation';
  } else if (arrangement === 'remote') {
    classification = 'manual_review';
    geography = 'unstated (remote, no scope given)';
    rationale = '"Remote" alone is not eligibility — the employing entity and its country are unknown';
  } else if (arrangement === 'onsite' || arrangement === 'hybrid') {
    classification = 'manual_review';
    geography = 'unstated (' + arrangement + ')';
    rationale = `${arrangement} role with no stated country — needs the location before eligibility can be decided`;
  } else {
    classification = 'manual_review';
    geography = 'unstated';
    rationale = 'no location or work arrangement recoverable from the posting';
  }

  // ── sponsorship ──────────────────────────────────────────────────────
  let sponsorship, sponsorshipNote;
  if (classification === 'india_eligible') {
    sponsorship = 'not_required';
    sponsorshipNote = 'India-based role — authorized in India, no sponsorship needed';
  } else if (SPON_AVAILABLE.test(text)) {
    sponsorship = 'explicitly_available';
    sponsorshipNote = 'posting states sponsorship / work-authorization support is available';
  } else if (SPON_UNAVAILABLE.test(text)) {
    sponsorship = 'explicitly_unavailable';
    sponsorshipNote = 'posting states sponsorship is not available / candidate must already be authorized there';
  } else if (SPON_UNCLEAR.test(text)) {
    sponsorship = 'unclear';
    sponsorshipNote = 'posting mentions sponsorship or authorization without resolving it';
  } else {
    sponsorship = 'unstated';
    sponsorshipNote = 'posting says nothing about sponsorship';
  }

  // Sponsorship is RECORDED, never used to remove a role. Policy change
  // 2026-09-26: a role abroad that needs sponsorship is still applied to, with
  // the requirement stated accurately. What must never happen is inventing
  // work authorization outside India — so an "unavailable sponsorship" note
  // travels with the application instead of silently filtering it out.
  if (sponsorship === 'explicitly_unavailable' && classification !== 'india_eligible') {
    rationale += ' — posting states sponsorship is not available, so this may not be hireable from abroad; recorded accurately, NOT rejected';
  }
  if (classification === 'relocation_eligible') {
    rationale += ' — relocation accepted; sponsorship requirement recorded as "' + sponsorship + '"';
  }

  return { classification, workArrangement: arrangement, geography, allowedCountries, sponsorship, sponsorshipNote, relocationRequired: classification === 'relocation_eligible', rationale };
}

/** Grouping used by the final queue report. */
export const GEO_BUCKETS = [
  { id: 'eligible_no_blocker', label: 'Eligible + no known blocker', test: (c) => c.classification === 'india_eligible' && c.sponsorship === 'not_required' },
  { id: 'eligible_captcha', label: 'Eligible + CAPTCHA', test: (c) => c.classification === 'india_eligible' },
  { id: 'eligible_unknown', label: 'Eligible + unknown mandatory question', test: (c) => c.classification === 'india_eligible' },
  { id: 'eligible_global', label: 'Eligible + global / worldwide', test: (c) => c.classification === 'global_eligible' || c.classification === 'apac_eligible' },
  { id: 'eligible_relocation', label: 'Eligible + relocation required', test: (c) => c.classification === 'relocation_eligible' },
  { id: 'manual_review', label: 'Manual review (geography unproven)', test: (c) => c.classification === 'manual_review' },
  { id: 'geo_ineligible', label: 'Explicitly excludes India', test: (c) => c.classification === 'ineligible' },
  { id: 'seniority_excluded', label: 'Seniority excluded', test: (c) => c.classification === 'seniority_excluded' },
  { id: 'closed', label: 'Closed / unavailable', test: (c) => c.classification === 'closed' },
];

/**
 * THE CAMPAIGN GATE — India-explicit only (policy change 2026-09-26).
 *
 * APPLICABLE only when the LIVE posting explicitly establishes India as the
 * work location or an eligible country. Removed from the queue:
 *   · generic "Remote" with no India statement
 *   · "Remote worldwide" / Global / Worldwide that does not list India
 *   · APAC that does not name India
 *   · EMEA, North America, UK, EU, Australia, Singapore, any non-India city
 *   · a job-board location that conflicts with the live posting
 *
 * India is never INFERRED. It does not count when it appears incidentally in
 * the JD body, benefits copy, an office list, customer references or other
 * boilerplate — only the structured location field, the location hint, or an
 * explicit eligibility statement in the posting own scope language counts.
 *
 * Willingness to relocate is NOT a licence to convert a non-India posting into
 * an India-eligible one. It only answers "are you willing to relocate?" after a
 * role has already qualified on its own merits.
 */
export const isApplicable = (c) => c?.classification === 'india_eligible';

export const bucketFor = (c) => GEO_BUCKETS.find((b) => b.test(c))?.id || 'manual_review';
