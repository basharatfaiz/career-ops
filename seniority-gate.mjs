// seniority-gate.mjs — HARD title/seniority filter.
//
// This is a GATE, not a score. An excluded title is rejected before any
// evaluation, scoring, CV generation or application work happens — the whole
// point is to not spend effort on roles that were never in scope.
//
// ORDER MATTERS. Exclusions are tested FIRST, because several excluded titles
// contain an accepted substring: "Lead Product Designer" contains "Product
// Designer", and "Staff Product Designer, Design System" contains both
// "Product Designer" and the allowed domain word "Design System". Testing
// acceptance first would wave all of them through.
//
// The user owns this policy; edit the tables, not the logic. Nothing here reads
// or writes profile, compensation, location or domain preferences.
import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

// ── EXCLUSIONS: hard, checked before acceptance ──────────────────────────
// Each entry is [regex, human reason recorded in provenance].
export const EXCLUSIONS = [
  [/\bsenior\s+staff\b|\bsr\.?\s+staff\b/i, 'Senior Staff Product Designer'],
  [/\bstaff[\s-]level\b|\bprincipal[\s-]level\b|\blead[\s-]level\b/i, 'Title states a Staff/Principal/Lead level band'],
  [/\bstaff\b/i, 'Staff Product Designer'],
  [/\bprincipal\b/i, 'Principal Product Designer'],
  [/\bdistinguished\b/i, 'Distinguished Engineer / distinguished-level title'],
  [/\b(lead|head|chief)\b/i, 'Lead-level title'],
  [/\bproduct\s+design\s+manager\b|\bdesign\s+manager\b|\bmanager\s+of\s+design\b/i, 'Design Manager'],
  [/\b(head|director|vp|svp|evp)\s+of\s+(product\s+)?design\b/i, 'Director/Head of Product Design'],
  [/\b(avp|vp)\b/i, 'AVP/VP grade — above Senior'],
  [/\b(engineering|design)\s+manager\b|\bmanager,\s*(design|ux)\b/i, 'Management role'],
  [/\bteam\s+lead\b|\blead\s+the\s+(design|ux)\s+team\b/i, 'Team-lead scope'],
];

// ── ACCEPTED: the role must clearly be a Product Designer / Senior PD ────
export const ACCEPTED = [
  [/\bproduct\s+designer\s*(?:i{1,3}v?|1|2|3|4)\b/i, 'Product Designer (levelled)'],
  [/\bproduct\s+designer\b/i, 'Product Designer'],
  [/\bsr\.?\s+product\s+designer\b/i, 'Sr. Product Designer'],
  [/\bsenior\s+product\s+designer\b/i, 'Senior Product Designer'],
  // Senior UX/Product Designer — allowed ONLY when not Lead/Staff/Principal,
  // which the exclusion table above has already guaranteed.
  [/\bsenior\s+ux\s*[/-]\s*product\s+designer\b/i, 'Senior UX/Product Designer'],
  [/\bux\s*[/-]\s*ai\s+designer\b/i, 'UX/AI Designer'],
  [/\bai\s*[/-]\s*ux\s+(product\s+)?designer\b/i, 'AI/UX Product Designer'],
  [/\bai\s+product\s+designer\b/i, 'AI Product Designer'],
  [/\bsenior\s+ai\s+product\s+designer\b/i, 'Senior AI Product Designer'],
  [/\bproduct\s+design\b/i, 'Product Design (generic)'],
];

// ── DISCIPLINE / DEAL-BREAKER GATE ───────────────────────────────────────
// A title containing "Senior Product Designer" is NOT sufficient. One posting's
// real title was "Senior Product Designer (Illustration & Motion, EdTech)" and
// the JD was full of illustration / motion / character / animation — a visual
// design job wearing a product-design title. The user's deal-breaker is
// consumer/brand/marketing/visual design, so this must be caught.
//
// The hard part is not over-triggering. "Visual design fundamentals" appears in
// almost every competent product-design JD (most do), so WEAK terms never
// reject on their own. Only a concentration of STRONG terms does.
//
//   WEAK  — normal product-design vocabulary, never sufficient alone:
//            "visual design", "creative", "design-led", brand-agnostic styling
//   STRONG — the work IS this discipline:
//            illustration, animation, motion graphics/design, character design,
//            3D, art direction, packaging, video, brand identity/design,
//            creative direction, marketing design, graphic design
const WEAK_DISCIPLINE = /\bvisual design\b|\bcreative\b/i;
// STRONG — the work IS this discipline. Deliberately narrow:
//   "packaging", not "package"  → "total rewards package" is a benefits phrase.
//   "motion design" uses [ \t]+ → "hierarchy, motion\nDesign native mobile" is a
//     LINE-WRAP artefact, not a motion-design discipline.
const STRONG_DISCIPLINE = [
  /\billustration/i, /\banimation/i, /\bmotion[ \t]+(graphics?|design)/i, /\bcharacter[ \t]+(design|art)/i,
  /\b3d[ \t]+(asset|model|art|design)/i, /\bart[ \t]+direction/i, /\bpackaging\b/i, /\bvideo[ \t]+(edit|production)/i,
  /\bbrand[ \t]+(identity|system)/i, /\bcreative[ \t]+direction/i,
  /\bmarketing[ \t]+(design|creative)/i, /\bgraphic[ \t]+design/i,
];
// A responsibility clause is the only body context that counts. Two real
// failures came from ignoring this:
//   Toast      — "hierarchy, motion\nDesign native mobile" and "total rewards
//                 package" were counted as disciplines.
//   GoodHabitz — "a multidisciplinary team of educational designers, writers,
//                 graphic designers, video creatives" describes the TEAM, not
//                 the role's output.
// So a body hit needs a production verb governing the discipline term, and the
// gap must be LAZY: a greedy `[^.]{0,60}` swallowed both disciplines in
// "Own brand identity, produce packaging artwork" and reported only the last,
// hiding a real second discipline.
const DISCIPLINE_RESP = /\b(create|creating|design|designing|produce|producing|own|owning|deliver|delivering|build|building|craft)\b[^.]{0,60}?\b(illustration|animation|motion[ \t]+(graphics?|design)|character[ \t]+(design|art)|3d[ \t]+(asset|model|art)|packaging|brand[ \t]+identity|video[ \t]+edit)/gi;

/** @returns {{hit:boolean, terms:string[], why:string}} */
export function checkDiscipline(title, jdText = '') {
  const t = String(title || '');
  const body = String(jdText || '');

  // 1. The TITLE naming the discipline is decisive — no counting needed.
  //    This is what catches a posting titled
  //    "Senior Product Designer (Illustration & Motion, EdTech)".
  for (const re of STRONG_DISCIPLINE) {
    const m = t.match(re);
    if (m) return { hit: true, terms: [m[0].toLowerCase()], why: 'title names a visual/brand/creative discipline' };
  }

  // 2. Body: require TWO DISTINCT disciplines each governed by a production
  //    verb. One is an incidental mention, never a rejection.
  const resp = [...body.matchAll(DISCIPLINE_RESP)]
    .map((m) => m[2].toLowerCase().replace(/\s+/g, ' ').trim());
  const distinct = [...new Set(resp)];
  if (distinct.length >= 2) {
    return { hit: true, terms: distinct, why: `JD assigns multiple visual/creative disciplines as the work (${distinct.join(', ')})` };
  }
  if (distinct.length === 1) {
    return { hit: false, terms: distinct, why: `one production mention of "${distinct[0]}" — insufficient to call a discipline mismatch` };
  }
  return { hit: false, terms: [], why: 'product design, no visual-discipline concentration' };
}

// ── EXPERIENCE PARSER ────────────────────────────────────────────────────
// The old parser took the MAXIMUM "N years" anywhere in the JD, so a passing
// "celebrating 50+ years" became a 50-year requirement and flagged a role as
// out of band. Only numbers bound to an EXPERIENCE PHRASE count, and the
// binding floor is the minimum of those — not the maximum.
const EXP_PHRASES = [
  // "5+ years of product design experience", "6 years of design experience"
  /\b(\d{1,2})\s*\+?\s*(?:[-–]|to)\s*\d{1,2}\s*\+?\s*years?\s+of\s+(?:professional\s+|relevant\s+|industry\s+|product\s+design\s+|design\s+|UX\s+)?experience\b/gi,
  /\b(\d{1,2})\s*\+?\s*years?\s+of\s+(?:professional\s+|relevant\s+|industry\s+|product\s+design\s+|design\s+|UX\s+|hands-on\s+)*experience\b/gi,
  // "minimum 5 years experience", "at least 5 years of experience"
  /\b(?:minimum|min\.?|at\s+least|over|more\s+than)\s*:?\s*(\d{1,2})\s*\+?\s*years?\b[^.]{0,30}?\bexperience\b/gi,
  /\bexperience\b[^.]{0,25}?\b(?:minimum|at\s+least|of\s+at\s+least)\s*:?\s*(\d{1,2})\s*\+?\s*years?\b/gi,
  // "5+ years' experience", "5+ years experience"
  /\b(\d{1,2})\s*\+?\s*years?['’]?\s+(?:professional\s+|relevant\s+|hands-on\s+|product\s+design\s+|design\s+)*experience\b/gi,
];

/**
 * @returns {number|null} the experience FLOOR in years, or null when the JD
 * states no experience requirement (null is not zero, and not a rejection).
 */
export function extractExperienceYears(text) {
  const t = String(text || '');
  const years = [];
  for (const re of EXP_PHRASES) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && n < 40) years.push(n); // 40 guards absurd captures
    }
  }
  // The MINIMUM of the valid requirement phrases: "5+ years" is the entry bar.
  // Taking the maximum is what produced the "50+ years" artefact.
  return years.length ? Math.min(...years) : null;
}

// ── STAFF/LEAD SCOPE DETECTION ───────────────────────────────────────────
// Expanded to catch explicit lead-scope phrasing. Every pattern here is
// EXPLICIT scope ownership — org-wide direction, strategy ownership, or
// people leadership. Ordinary collaboration language ("partner with
// engineering", "work cross-functionally", "contribute to critique") is
// deliberately NOT here, so one collaborative sentence never flags a Senior PD.
const SCOPE_EXPLICIT = [
  /\blead\s+end-to-end\s+design/i,
  /\bset\s+(the\s+|our\s+)?design\s+direction\b/i,
  /\bdefine\s+(the\s+|our\s+)?design\s+vision\b/i,
  /\bown\s+(the\s+|our\s+)?design\s+(strategy|vision|direction)\b/i,
  /\bstrategic\s+design\s+leadership\b/i,
  /\blead\s+design\s+across\b/i,
  /\blead(s|ing)?\s+the\s+design\s+(team|function|org|organisation|organization)\b/i,
  /\bmultiple\s+design\s+teams\b/i,
  /\bdesign\s+org(anisation|anization)?\b/i,
  /\bmentor(s|ing)?\s+(a\s+)?(team|group)\s+of\s+designers\b/i,
  /\bstaff[\s-]level\b/i,
  /\bprincipal\s+(level|individual\s+contributor|\bic\b)/i,
  /\breports\s+to\s+(the\s+)?(head|vp|svp|evp|chief)\s+of\s+design\b/i,
  /\bhead\s+of\s+design\b/i,
];

// ── verdict ─────────────────────────────────────────────────────────────
/**
 * @param {string} title
 * @param {{rawText?:string, years?:number|null}} [jd]
 * @returns {{verdict:'accept'|'exclude'|'review', reason:string, kind:string, needsReview:string[]}}
 */
export function gateTitle(title, jd = {}) {
  const t = String(title || '').trim();
  const needsReview = [];

  // 1. EXCLUSIONS FIRST — an excluded title is out regardless of anything else.
  for (const [re, reason] of EXCLUSIONS) {
    if (re.test(t)) {
      return { verdict: 'exclude', reason: `Excluded by target seniority: ${reason}`, kind: reason, needsReview };
    }
  }

  // 2. ACCEPTANCE — must be a Product Designer / Senior PD role.
  let kind = null;
  for (const [re, k] of ACCEPTED) {
    if (re.test(t)) { kind = k; break; }
  }
  if (!kind) {
    // 3. Neither. Ambiguous discipline (a bare "UX Designer" is not in the
    //    accepted set) — surface it, never silently drop it.
    return {
      verdict: 'review',
      reason: 'Ambiguous title — not in the accepted Product Designer / Senior Product Designer set',
      kind: 'ambiguous-discipline',
      needsReview: [`"${t}" is not one of the accepted titles; confirm it is genuinely product design`],
    };
  }

  // 4. DISCIPLINE GATE — a product-design TITLE is not sufficient. Runs only
  //    after acceptance, and rejects only on a concentration of strong evidence,
  //    so ordinary "visual design fundamentals" language never trips it.
  const disc = checkDiscipline(t, jd.jdText ?? jd.rawText ?? '');
  if (disc.hit) {
    return {
      verdict: 'exclude',
      reason: 'EXCLUDED: discipline mismatch / consumer-brand-visual design',
      kind: 'discipline-mismatch',
      discipline: disc,
      needsReview,
    };
  }

  // 5. EXPERIENCE RULE — years is NOT a rejection filter, and it is parsed only
  //    from phrases bound to "experience". No stated requirement ⇒ no flag.
  const yrs = jd.years ?? extractExperienceYears(jd.jdText ?? jd.rawText ?? '');
  if (yrs !== null && yrs >= 7) {
    needsReview.push(`JD asks ${yrs}+ years of experience — near the Senior band, confirm level before applying`);
  }

  // 6. DOCUMENTED SCOPE — a Senior title whose JD describes Staff/Principal/Lead
  //    scope is flagged on the documented level. Every pattern is EXPLICIT scope
  //    ownership, so one ordinary collaboration sentence never flags a Senior PD.
  const body = jd.jdText ?? jd.rawText ?? '';
  if (body) {
    const scopeHits = SCOPE_EXPLICIT.filter((re) => re.test(body))
      .map((re) => body.match(re)[0].replace(/\s+/g, ' ').slice(0, 40));
    if (scopeHits.length) {
      needsReview.push(`JD shows explicit Lead/Staff-level scope ("${scopeHits.slice(0,2).join('" / "')}") despite a Senior title — confirm level`);
    }
  }

  return { verdict: 'accept', reason: `Accepted: ${kind}`, kind, years: yrs, discipline: disc, needsReview };
}

// ── CLI: re-gate an existing opportunity set ────────────────────────────
if (isMainModule(import.meta.url)) {
  const sigPath = 'data/discovery/triage-signals.json';
  let sig = [];
  try { sig = JSON.parse(readFileSync(sigPath, 'utf8')); } catch { /* first run */ }
  const sigBy = new Map(sig.map((s) => [s.url, s]));

  const sets = [
    ['data/discovery/opportunities.tsv', '108-opportunity discovery set'],
    ['data/discovery/resolved-provenance.json', '54 resolved live opportunities'],
  ];
  // resolved-provenance carries the resolver's verified matchedTitle; the TSV
  // does not, so look it up per row where the corpus provides one.
  let matched = new Map();
  try {
    const prov = JSON.parse(readFileSync('data/discovery/resolved-provenance.json', 'utf8'));
    for (const p of prov) if (p.canonical) matched.set(p.canonical, p.matchedTitle);
  } catch { /* first run */ }

  for (const [file, label] of sets) {
    let rows;
    try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch { rows = null; }
    // The discovery set is a TSV (header: company, title, location,
    // country_group, url, source) and resolved-provenance is JSON.
    const items = Array.isArray(rows)
      ? rows.map((r) => ({ ...r, matchedTitle: r.matchedTitle || matched.get(r.canonical) }))
      : readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => {
          const c = l.split('\t');
          const url = c[4] && c[4] !== '-' ? c[4].trim() : null;
          return { company: c[0]?.trim(), title: c[1]?.trim(), url, matchedTitle: url ? matched.get(url) : null };
        }).filter((x) => x.company && x.title);

    const out = { accept: [], review: [], exclude: [] };
    for (const it of items) {
      const s = it.url ? sigBy.get(it.url) : null;
      // Gate the title the RESOLVER verified against the live board
      // (matchedTitle), not the aggregator's rendering. One posting's queue title
      // is the harmless "Senior Product Designer"; its real title is
      // "Senior Product Designer (Illustration & Motion, EdTech)". Gating the
      // former let a visual-design job through the discipline gate entirely.
      const title = it.matchedTitle || it.title;
      // Pass the JD text and let gateTitle's own parser read the years, rather
      // than a possibly-stale precomputed value.
      const g = gateTitle(title, { jdText: s?.rawText || '' });
      out[g.verdict].push({ company: it.company, title, queueTitle: it.title, url: it.url, ...g });
    }
    console.log(`\n${label}  (${items.length} opportunities)`);
    console.log(`  accept ${String(out.accept.length).padStart(3)}   review ${String(out.review.length).padStart(3)}   exclude ${String(out.exclude.length).padStart(3)}`);
    const byKind = {};
    for (const e of out.exclude) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`      excluded: ${String(v).padStart(2)}  ${k}`);
    if (out.review.length) for (const r of out.review.slice(0, 6)) console.log(`      review:    ${r.company} — ${r.title}`);
  }
}
