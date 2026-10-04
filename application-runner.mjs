#!/usr/bin/env node
/**
 * application-runner.mjs — reusable, company-agnostic application filler.
 *
 * NOT a per-job script. It reads the applicant from the answer bank
 * (data/application-answers.yml) and CV facts from cv.md, then fills any
 * application form it is pointed at. The same binary runs every role in the
 * queue.
 *
 * RULES ENFORCED HERE
 *  1. Identity and reusable answers come from the answer bank, never a literal.
 *  2. CV facts (education, years, tools) are read from cv.md, the source of
 *     truth, and are labelled `cv.md` in the log so provenance stays visible.
 *  3. Fields are detected SEMANTICALLY. Radio/checkbox GROUPS are classified
 *     ONCE from the question and then one option is chosen inside that group —
 *     never per-option, which would answer a question N times.
 *  4. NEVER a global getByText("No"). That is what previously selected "No" on
 *     an LGB question, because every sensitive question offers a "No".
 *  5. Never guess. An answer not in the bank or cv.md is `ask`, not a default.
 *  6. Optional fields are left blank rather than filled with a plausible value.
 *  7. Withheld categories (never_answer) are never answered; if one is
 *     mandatory the run stops and asks.
 *  8. CAPTCHA / OTP / login are detected, reported, and never automated.
 *  9. Nothing is submitted. Only a site-confirmed submission may later be
 *     written to applications.md, and only by a separate explicit step.
 *
 * Usage:
 *   node application-runner.mjs --check-bank
 *   node application-runner.mjs --plan   --url <url> [--company X]
 *   node application-runner.mjs --fill    --url <url> [--company X]
 */
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import { generateAnswer, extractJdContext, readLimit, classifyQuestion } from './answer-generator.mjs';
import { finalCv } from './final-cv.mjs';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const BANK_PATH = 'data/application-answers.yml';
const CV_PATH = 'cv.md';
const CDP = process.env.CAREER_OPS_CDP || 'http://127.0.0.1:9222';

// Parsed from argv up front, because classify() runs inside --check-bank, which
// executes BEFORE the run block. Reading them there instead meant `company` was
// still in its temporal dead zone.
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
// `let`, not `const`: --check-bank runs before the run block and temporarily
// sets a company to exercise the per-company location override.
let company = arg('--company', '');

const BANK = yaml.load(readFileSync(BANK_PATH, 'utf8'));
const NEVER = (BANK.demographics?.never_answer || []).map((s) => new RegExp(s, 'i'));
const D = BANK.demographics || {};
// Confirmed sensitive answers, compiled ONCE from the bank. Each is a semantic
// question match, never a bare "No" — a generic text match is what previously
// selected "No" on an unrelated sensitive question. The order below is the
// precedence order and matches the bank file.
const CONFIRMED_SENSITIVE = [
  {
    key: 'disability',
    rx: new RegExp((D.disability?.match_question || []).join('|'), 'i'),
    prefer: (D.disability?.prefer || []).map((s) => new RegExp(s, 'i')),
    why: 'disability (answer bank)',
  },
  {
    key: 'lgbt',
    rx: new RegExp((D.lgbt?.match_question || []).join('|'), 'i'),
    prefer: (D.lgbt?.prefer || []).map((s) => new RegExp(s, 'i')),
    why: 'LGBTQ/LGB membership (answer bank)',
  },
  {
    key: 'gender_identity',
    rx: new RegExp((D.gender_identity?.match_question || []).join('|'), 'i'),
    prefer: (D.gender_identity?.prefer || []).map((s) => new RegExp(s, 'i')),
    why: 'gender identity (answer bank)',
  },
].filter((c) => c.rx && c.rx.source !== '(?:)');

// ── CV facts, read from cv.md (the source of truth) ─────────────────────
function readCvFacts() {
  if (!existsSync(CV_PATH)) return null;
  const md = readFileSync(CV_PATH, 'utf8');

  const edu = md.match(/## Education\s*\n+([\s\S]*?)(?=\n## |\Z)/);
  let education = null;
  if (edu) {
    const b = edu[1];
    education = {
      degree: b.match(/Bachelor in Design \(([^)]+)\)/)?.[1] || b.match(/\*\*(.+?)\*\*/)?.[1]?.trim() || null,
      degreeFull: b.match(/(Bachelor[^*]*?)(?=\s*—|\*\*|$)/)?.[1]?.trim() || null,
      org: b.match(/[^\n—*]*\b(?:University|Institute|College|School)\b[^,\n*]*/)?.[0]?.trim() || b.match(/—\s*([^*]+?),\s*[A-Z]/)?.[1]?.trim() || null,
      field: b.match(/\(([^)]+)\)/)?.[1] || null,
      start: b.match(/([A-Z][a-z]{2})\s+(\d{4})/)?.[0] || null,
      end: (b.match(/[–-]\s*([A-Z][a-z]{2}\s+\d{4})/) || [])[1] || null,
    };
    // Graduation year = the END year of the degree. "Year of graduation" appears
    // as a required field and was being escalated to the user even though cv.md
    // states the degree ended Sep 2021.
    education.graduationYear = education.end ? education.end.split(/\s+/).pop() : null;
  }

  // total professional design years, from the EARLIEST experience start date
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const expBlock = md.match(/## Experience\s*\n([\s\S]*?)(?=\n## |\Z)/)?.[1] || '';
  const ranges = [...expBlock.matchAll(/([A-Z][a-z]{2})\s+(\d{4})\s*[–-]\s*([A-Z][a-z]{2})\s+(\d{4})/g)]
    .map((m) => ({ start: new Date(Date.UTC(+m[2], MONTHS[m[1].toLowerCase()], 1)), end: new Date(Date.UTC(+m[4], MONTHS[m[3].toLowerCase()], 1)) }))
    .filter((r) => !isNaN(r.start) && !isNaN(r.end))
    .sort((a, b) => a.start - b.start);
  const now = new Date();
  const years = ranges.length
    ? Math.round(((now - ranges[0].start) / 31557600000) * 10) / 10
    : null;

  // cv.md writes Tools as a middle-dot separated line, not a bullet list:
  //   "Figma · FigJam · Framer · Maze"
  // A bullet-only reader silently returned [], which then blocked every
  // tool-derived answer (e.g. the Figma question) from ever being asked.
  const toolsBlock = md.match(/## Tools\s*\n+([\s\S]*?)(?=\n## |\Z)/)?.[1] || '';
  const tools = [...new Set([
    ...[...toolsBlock.matchAll(/^-\s*(.+)$/gm)].map((m) => m[1].trim()),
    ...toolsBlock.split(/[·•|]/).map((s) => s.trim()),
  ].map((s) => s.replace(/\s*\(.*?\)\s*$/, '').trim()).filter((s) => s && s.length < 40 && !/^-+$/.test(s)))];

  return { education, years, yearsRange: ranges.length ? `${ranges[0].start.toISOString().slice(0, 7)} → present` : null, tools, raw: md };
}
const CV = readCvFacts();

/** Map a decimal year count onto a form's banded options. */
function yearBandOption(years) {
  if (years == null) return null;
  if (years < 5) return /^less than 5 years$/i;
  if (years < 7) return /^5-6 years$/i;
  if (years < 9) return /^7-8 years$/i;
  return /^9\+ years$/i;
}

// ── semantic classification ──────────────────────────────────────────────
/** Answer one postal-address field from the bank, or ask. */
function addr(field, required) {
  const a = BANK.address || {};
  const v = a[field];
  if (!v) return { action: required ? 'ask' : 'blank', why: 'address ' + field + ' — not in the bank; a street address is personal data and is never invented' };
  return { action: 'fill', value: v, why: 'address ' + field + ' (user-supplied)' };
}

const RX = {
  currentCtc: /(current|present|existing)\s*(ctc|compensation|salary|package|pay)\b|\bctc\s*(current|now)\b|what\s*(is|are)\s*your\s*current\s*(ctc|compensation|salary)/i,
  expectedCtc: /(expected|desire[d]?|target|anticipated)\s*(ctc|compensation|salary|package)\b|what\s*(is|are)\s*your\s*(expected|desired)|salary\s*expectation/i,
  notice: /(notice\s*period|how\s*(soon|quickly)|when\s*can\s*you\s*(start|join|begin)|availability|earliest\s*start|available to start|are you an? immediate(ly)?\s*(joiner|available)|how soon can you join|how soon would you be available|how long is your notice)/i,
  joiningDate: /(joining\s*date|start\s*date|date\s*of\s*(joining|start)|available\s*from|earliest\s*joining)/i,
  referral: new RegExp(BANK.referral.match_question.join('|'), 'i'),
  related: /(related\s*to\s*(anyone|any)|do\s*you\s*know\s*(anyone|any)|family\s*(member|relation)|spouse|relative)/i,
  prevEmployee: /(previous\s+\w*\s*(former\s+)?employee|current\s+or\s+former|\bformer\s+employee\b|ever\s+(worked|been)\s+(at|with)|previously\s+(employed|worked)|have\s+you\s+ever\s+worked\s+(at|for))/i,
  veteran: new RegExp(BANK.demographics.veteran_status.match_question.join('|'), 'i'),
  race: /(race|ethnic|national origin|ancestry|hispanic|latino|asian|indian\s+origin|descen)/i,
  // A job-location PREFERENCE question (where do you want to work) — answered
  // from the posting's own location, never the candidate's residence.
  locationPref: new RegExp((BANK.location_preference?.match_question || []).join('|'), 'i'),
  // A CURRENT-location/residence question is a DIFFERENT question. The user
  // asked to be stopped rather than have these inferred.
  locationCurrent: new RegExp((BANK.location_preference?.current_residence?.match_question || []).join('|'), 'i'),
  countryOnly: /^\s*\*?\s*country\s*\*?\s*$/i,
  cityOfResidence: /location\s*\(?\s*city|^\s*\*?\s*city\s*\*?\s*$|which city|your city/i,
  // "indicate the number of years of professional experience you have in
  // Product Design" is the single most common required question on India
  // applications, and it is answered from cv.md, not invented.
  years: /(how\s*many\s*years|number\s*of\s*years|years\s*of\s*(full[- ]time\s*)?(experience|exp|professional))|(professional|practical|relevant|industry)\s+experience\s+you\s+have|total\s*(professional\s*)?experience|indicate\s+the\s+number\s+of\s+years/i,
  // "number of years of hands-on experience with Figma" is a tenure question,
  // not a proficiency one — it must not be answered with an "advanced"
  // proficiency label. Handled separately below via RX.figmaYears.
  figma: /figma\s*(proficiency|skill|experience)|proficiency.*figma/i,
  figmaYears: /(number\s+of\s+)?years?.*(hands[- ]on\s+)?(experience|exposure).{0,40}figma|figma.{0,40}(number\s+of\s+)?years?/i,
  school: /(school|university|institution|college)/i,
  degree: /(^|\b)degree\b|educational\s*qualification|highest\s*(educational|academic|qualification)|qualification\s*(held|obtained)/i,
  fieldOfStudy: /field\s*of\s*study|major|discipline/i,
  graduationYear: /year of graduation|graduation year|graduating|passing year|year of passing|year of completion|completed\s+(?:my\s+|the\s+|in\s+)?(?:degree|bachelor|master|b\.?sc|m\.?sc|education)|on\s+which\s+(?:did\s+you\s+)?(?:graduat|complet)/i,
  totalExperience: /total\s*(years?\s*of\s*)?(work\s*)?experience|total\s*experience/i,
  toolsUsed: /(what )?(design |prototyping |other )?tools? (have you used|do you use|are you proficient|are you experienced)|design and prototyping tools|tool(s)? (proficiency|expert|skills?)/i,
  experienceAs: /experience working as|years of experience as|have you worked as/i,
  b2bYears: /\d+\+?\s*years? (in|of|with)\s*(b2b|saas|enterprise)|b2b saas[^?]{0,30}years/i,
  name: /^(full\s*)?(name|candidate name|applicant name)$|^your name$/i,
  fullName: /full\s*name|full\s*&?\s*last\s+name|name as per|legal name/i,
  firstName: /^\*?\s*(legal\s*)?first\s*(name)?\s*\*?$|first\s+name/i,
  lastName: /^\*?\s*(legal\s*)?last\s*(name|&\s*first\s+name)?\s*\*?$|last\s+name|surname|family name/i,
  website: /^website$|personal website|your website/i,
  email: /e-?mail/i,
  phone: /phone|mobile|contact number|cell/i,
  linkedin: /linked\s*in/i,
  portfolio: /portfolio|personal site|behance|dribbble|your website|online portfolio|work samples/i,
  // US-style postal address, split across four required boxes. Matched on the
  // field label so a "City" question is not confused with a job-location
  // preference question elsewhere in the same form.
  addressLine1: /address\s*(line)?\s*1|street\s*address|address\s*line\s*i\b|^address$/i,
  addressCity: /^(?:\*?\s*)?city\s*\*?$/i,
  addressZip: /zip\s*code|postal\s*code|postcode|\bzip\b/i,
  addressState: /state\s*\/?\s*province|^state$|province/i,
  addressCountry: /^\*?\s*country\s*\*?$/i,
  // "Are you currently residing in <city>?" is a CURRENT-RESIDENCE question
  // about a specific city, not a job-location preference. The truthful answer
  // is No for any city that is not the user confirmed residence — and
  // answering it Yes would be claiming to live somewhere they do not.
  resideInCity: /are\s+you\s+(currently\s+)?(residing|based|located|living)\s+in|do\s+you\s+(currently\s+)?(reside|live)\s+in|currently\s+(residing|based)\s+in/i,
  // "do you understand this is a hybrid role requiring onsite presence at our
  // <city> office three days per week, and are you comfortable?" — a
  // work-commitment question, answered Yes under the all-India relocation
  // policy rather than by the narrower commute patterns.
  onsiteComfort: /comfortable\s+with\s+this\s+work\s+arrangement|onsite\s+presence|understand\s+that\s+this\s+is\s+a\s+(hybrid|on[- ]?site)|hybrid\s+role.{0,80}(comfortable|onsite)/i,
  // "Which of the following AI-powered prototyping tools have you used?" —
  // asked on most India AI-mandate applications. Answered ONLY from the
  // user-stated list in the bank; the never-list blocks the other options,
  // because ticking a tool the user has not used is a fabricated skill.
  aiProtoTools: /ai[- ]powered\s+prototyping\s+tools|which\s+(of\s+the\s+following\s+)?ai\s+(tools|design\s+tools|prototyping)|ai\s*(design|prototyping|coding)\s+tools.{0,50}(you|used|use|experience)/i,
  resume: /resume|cv|curriculum vitae/i,
  // Work authorisation. Recurs on nearly every non-India application, so it is
  // answered from documented fact rather than parked each time. Scoped tightly
  // so it cannot swallow an India-only question: the handler below also
  // refuses when the question itself names India.
  authorizedToWork: /(legally\s+authori[sz]ed|authori[sz]ation)\s+to\s+work|authorized\s+to\s+work|able\s+to\s+work\s+(legally\s+)?(in|within)|right\s+to\s+work|eligible\s+to\s+work|work\s+authori[sz]ation/i,
  requiresSponsorship: /require[sd]?\s+(visa\s+)?sponsorship|(?:need|want|apply\s+for)\b[^.?]{0,60}?\b(?:sponsorship|visa\s+sponsorship)\b|\b(?:sponsorship|immigration\s+support|visa\s+support|work\s+visa)\b[^.?]{0,60}?\b(?:need|required|necessary)\b|will\s+you\s+(now|in\s+the\s+future)\s+require|need\s+(a\s+)?(work\s+)?visa|visa\s+sponsorship|employment\s*visa|work\s*(permit|authorization)\s*(status)?\s*required/i,
};

function isWithheld(q) {
  const hit = NEVER.find((r) => r.test(q));
  return hit ? String(hit.source) : null;
}

/**
 * Decide what to do with a question (or a standalone control).
 * @returns {{action:'fill'|'select'|'file'|'skip'|'blank'|'ask', ...}}
 */
function classify(question, label = '', { required = false, kind = 'text' } = {}) {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  // `both` is a concatenation and carries a leading space when the question is
  // empty, which silently broke every `^`-anchored pattern — "Country*" arrived
  // as " Country*" and the India answer never fired.
  const both = `${q} ${l}`.trim();

  const withheld = isWithheld(both);
  if (withheld) return { action: required ? 'ask' : 'skip', why: `WITHHELD (${withheld}) — never answered` };

  // --- the one authorised demographic category -------------------------
  if (RX.race.test(both)) {
    const forbid = BANK.demographics.race_ethnicity.forbid.map((s) => new RegExp(s, 'i'));
    // A form that asks ethnicity/nationality explicitly (rather than the
    // standard EEO race list) takes the bank's dedicated ethnicity_prefer list
    // when one is set.
    //
    // "Explicitly" is load-bearing. One employer's standard EEO race question is
    // "What is your race or ethnicity?", which contains "ethnicity" — and taking
    // this branch on it swapped to the narrower ethnicity list, dropping the
    // race option the bank actually prefers, so it was reported as not offered. The
    // narrower list applies only when the question asks for ethnicity or
    // nationality WITHOUT also framing it as race.
    const asksRace = /\brace\b/i.test(q);
    const asksEthnicityAlone = /\b(ethnicity|national origin|ancestry)\b/i.test(q) && !asksRace;
    const list = asksEthnicityAlone && BANK.demographics.race_ethnicity.ethnicity_prefer?.length
      ? BANK.demographics.race_ethnicity.ethnicity_prefer
      : BANK.demographics.race_ethnicity.prefer;
    // Only block on the label for a STANDALONE control. In a group the label is
    // just whichever option happens to come first — and Ashby's EEO list is
    // alphabetised, so that is "American Indian or Alaska Native", which would
    // reject the entire ethnicity block. Per-option blocking is already enforced
    // downstream, by the `forbid` list passed to findOptionInGroup.
    if (!q && forbid.some((r) => r.test(l))) return { action: 'skip', why: 'forbidden race option' };
    return {
      action: 'select-multi',
      // PREFIX match, not exact: EEO lists append examples in parentheses after
      // each option. An exact match never fires on those and the question
      // silently went unanswered. Anchoring at ^ is what keeps a broader option
      // from matching a narrower preference that it merely contains.
      prefer: list.map((s) => new RegExp(`^${s}\\b`, 'i')),
      forbid,
      why: `race: ${list.join(' → ')}, else ask (forbidden: ${(BANK.demographics.race_ethnicity.forbid || []).join(', ') || 'none'})`,
    };
  }
  if (RX.veteran.test(both)) {
    const vp = D.veteran_status?.prefer || [];
    return vp.length
      ? { action: 'select', prefer: vp.map((s) => new RegExp(s, 'i')), why: 'veteran status (answer bank)' }
      : { action: required ? 'ask' : 'skip', why: 'veteran status — not in the bank' };
  }

  // --- confirmed sensitive categories (disability / LGBTQ / gender) -------
  // Each is matched by the QUESTION's meaning and scoped to its own fieldset by
  // the caller, so an identical option label on a different question can never
  // be picked up. Withheld categories were already returned as `skip` above.
  // A preferred option that appears EARLIER in a list than the one the bank
  // names must not win. Ashby's gender scale is ordered
  // "Woman, female or feminine | Transgender woman | Man, male or masculine | …",
  // and a short unanchored preference can match an EARLIER option that merely
  // contains it, which silently answered the wrong option. Every preference is therefore matched
  // against the WHOLE option text with an anchored start, and options are
  // rejected if a LONGER bank preference also matches them.
  for (const c of CONFIRMED_SENSITIVE) {
    if (c.rx.test(both)) {
      return { action: 'select', prefer: c.prefer, forbid: [/^yes\b/i], why: c.why, sensitive: true, longestMatchWins: true };
    }
  }

  // --- work commitments (user-confirmed, narrowly scoped) -----------------
  // Each commitment answers ONE arrangement. The user was explicit: never
  // generalise these to other locations or working arrangements, so a commitment
  // only fires when its own match_question hits.
  for (const c of BANK.commitments || []) {
    const rx = new RegExp((c.match_question || []).join('|'), 'i');
    if (rx.test(both)) {
      return {
        action: 'select',
        prefer: (c.options || ['^yes$', 'yes']).map((s) => new RegExp(s, 'i')),
        // Some ATS render a yes/no question as a plain TEXT input — Ashby's
        // "Are you willing and able to come into the Bangalore office 5 days a
        // week?" is `type=text` with no radios at all, so a select-only answer
        // had nothing to select and the field was left blank.
        textAnswer: c.answer,
        why: `${c.detail} (user-confirmed)`,
      };
    }
  }

  // --- location -----------------------------------------------------------
  // Current RESIDENCE: country and city come only from the answer bank, and a
  // city the bank does not hold is never claimed — not from a posting, not from
  // browser autofill.
  if (RX.locationCurrent.test(both)) {
    const cr = BANK.location_preference?.current_residence || {};
    if (RX.countryOnly.test(both) && cr.country_answer) {
      return {
        action: 'select',
        prefer: [new RegExp(`^${cr.country_answer}\\b`, 'i'), new RegExp(`\\b${cr.country_answer}\\b`, 'i')],
        // Greenhouse renders "Country*" as a text input on some templates.
        textAnswer: cr.country_answer,
        why: 'country of residence = ' + cr.country_answer + ' (answer bank)',
      };
    }
    if (RX.cityOfResidence.test(both)) {
      // Answered from the bank's current_residence.city — never inferred from a
      // posting, and never trusted from browser autofill (which once put a
      // stale saved address into an employer's address field).
      const city = cr.city || null;
      if (city) {
        const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const variants = (cr.city_variants || [city]).filter(Boolean);
        return {
          action: 'select',
          prefer: [new RegExp('^' + esc(city) + '\\b', 'i'), ...variants.map((v) => new RegExp('^' + esc(v) + '\\b', 'i'))],
          textAnswer: city,
          why: 'city of current residence = ' + city + ' (answer bank)',
        };
      }
      return { action: required ? 'ask' : 'skip', why: 'city of current residence — not in the bank; never inferred' };
    }
    return { action: required ? 'ask' : 'skip', why: 'current residence/location — not in the bank; never inferred' };
  }

  // --- work authorisation / sponsorship ---------------------------------
  // These recur on nearly every non-India role, so answering them from
  // documented fact unblocks a large share of the campaign instead of
  // parking each application. Both answers are forced by the profile and
  // neither asserts anything untrue:
  //   · the candidate resides in India and holds no work authorisation
  //     anywhere else, so "are you legally authorised to work in
  //     <country>?" is No;
  //   · therefore a visa WOULD be required, so "will you require
  //     sponsorship?" is Yes. Answering No there would falsely imply
  //     existing authorisation — the exact fabrication the rules forbid.
  const wa = BANK.work_authorization || {};
  if (RX.authorizedToWork.test(both)) {
    const no = wa.authorized_answer || 'No';
    return {
      action: 'select',
      prefer: [new RegExp('^' + no + '\\b', 'i'), new RegExp('^' + no + '$', 'i')],
      textAnswer: no,
      why: 'work authorisation outside India = ' + no + ' (resides in India; no foreign work authorisation on file — never fabricated)',
    };
  }
  if (RX.requiresSponsorship.test(both)) {
    const wa2 = BANK.work_authorization || {};
    // An India-based role needs no immigration support, so the honest answer
    // there is No. Only a role OUTSIDE India implies sponsorship would be
    // required, because the candidate holds no foreign work authorisation.
    // Getting this backwards is a false claim either way, so it is derived
    // from the posting location rather than hardcoded.
    const loc = String(locationAnswer() || '');
    const roleIsIndia = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurugram|gurgaon|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore)\b/i.test(loc) || /\bin\b/i.test(loc);
    const ans = roleIsIndia ? (wa2.not_required_answer || 'No') : (wa2.sponsorship_required_answer || 'Yes');
    // With no location at all, claiming either answer is a guess about a legal
    // status. Ask instead — this is exactly the question the rules say to stop
    // and hand back rather than answer from inference.
    if (!loc) return { action: required ? 'ask' : 'blank', why: 'sponsorship needed — posting location unknown, so the answer cannot be derived without guessing at work-authorisation status' };
    return {
      action: 'select',
      prefer: [new RegExp('^' + ans + '\\b', 'i'), new RegExp('^' + ans + '$', 'i')],
      textAnswer: ans,
      why: 'role is ' + (roleIsIndia ? 'India-based' : 'outside India') + ' → immigration support required = ' + ans + ' (answer bank)',
    };
  }

  // --- postal address (US-style forms ask for four separate fields) ---
  // Sourced exclusively from bank.address. Never synthesised: a street address
  // is personal data, and inventing one would put a false claim in front of an
  // employer. Left as a question when the bank has no value.
  if (RX.addressLine1.test(both)) return addr('line1', required);
  if (RX.addressCity.test(both)) return addr('city', required);
  if (RX.addressZip.test(both)) return addr('zip', required);
  if (RX.addressState.test(both)) return addr('state', required);
  if (RX.addressCountry.test(both)) return addr('country', required);

  if (RX.locationPref.test(both)) {
    const loc = locationAnswer();
    if (!loc) return { action: 'ask', why: 'preferred job location — no posting location known; ask' };
    return { action: 'select', prefer: [new RegExp(`^${loc}\\b`, 'i'), new RegExp(loc.split(' / ')[0], 'i'), ...(BANK.location_preference?.current_residence?.city_variants || []).map((v) => new RegExp(String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))], why: `preferred job location = ${loc} (from the posting)` };
  }

  // --- availability ----------------------------------------------------
  if (RX.joiningDate.test(both)) return { action: 'ask', why: 'joining date — policy is ASK, never invent' };
  if (RX.notice.test(both)) {
    const np = BANK.availability.notice_period;
    // Free-text variants ("how soon can you commence (with notice period)?")
    // need a textAnswer, or the field is left empty and the run halts on it.
    return {
      action: 'select',
      prefer: (np.prefer || []).map((x) => new RegExp(x, 'i')),
      textAnswer: np.display,
      why: 'notice period = ' + np.display + ' (answer bank)',
    };
  }

  // --- compensation -----------------------------------------------------
  if (RX.currentCtc.test(both)) return { action: 'fill', value: BANK.compensation.current_ctc, why: 'current CTC (user-confirmed)' };
  if (RX.expectedCtc.test(both)) return { action: 'fill', value: BANK.compensation.expected_ctc, why: 'expected CTC (user-confirmed)' };

  // --- provenance / relationships ---------------------------------------
  if (RX.referral.test(both)) {
    const first = (BANK.referral.preference_order || [])[0] || 'Job board';
    const escR = (x) => String(x).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    return {
      action: 'select',
      prefer: (BANK.referral.preference_order || []).map((x) => new RegExp('^' + escR(x) + '$', 'i')),
      forbid: (BANK.referral.never || []).map((x) => new RegExp(x, 'i')),
      // Many boards render this as a free-text box rather than a select, so
      // without a textAnswer the field stays empty and the run halts on it.
      textAnswer: first.charAt(0).toUpperCase() + first.slice(1),
      why: 'source: public job board (never a fabricated referral or referral code)',
    };
  }
  if (RX.prevEmployee.test(both)) return { action: 'fill', value: BANK.relationships.previous_employee.answer, why: 'previous employee (user-confirmed)' };
  if (RX.related.test(both)) return { action: BANK.relationships.related_to_employees.answer ? 'fill' : (required ? 'ask' : 'blank'), value: BANK.relationships.related_to_employees.answer || undefined, why: 'relationship — blank if optional, ask if mandatory' };

  // --- India-specific recurring questions -------------------------------
  // These four question shapes appear on almost every India application and
  // were parking the entire campaign, so each is answered from documented
  // fact rather than escalated.
  if (RX.resideInCity.test(both)) {
    const home = (BANK.location_preference?.current_residence?.city || '').toLowerCase();
    // If the question names the city the user actually lives in, answer Yes.
    const named = (both.match(/residing in ([a-z ]+)|based in ([a-z ]+)|located in ([a-z ]+)/i) || []).slice(1).join(' ').toLowerCase();
    if (home && named && named.includes(home) && !/hyderabad|pune|mumbai|delhi|noida|gurugram|gurgaon|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|bangalore/.test(named.replace(home, ''))) {
      return { action: 'select', prefer: [/^yes$/i, /^y$/i], textAnswer: 'Yes', why: 'the named city is the user confirmed residence (' + home + ')' };
    }
    return { action: 'select', prefer: [/^no$/i, /^n$/i], textAnswer: 'No', why: 'current residence is ' + (BANK.location_preference?.current_residence?.city || 'the city in the answer bank') + ', NOT the city named in the question — relocation willingness is a separate question' };
  }
  if (RX.onsiteComfort.test(both)) {
    // Answer bank: location_preference.onsite_comfort: { answer: Yes|No, detail }
    const oc = BANK.location_preference?.onsite_comfort;
    if (!oc?.answer) return { action: required ? 'ask' : 'skip', why: 'hybrid/onsite comfort — not in the bank' };
    const yes = /^y/i.test(oc.answer);
    return { action: 'select', prefer: yes ? [/^yes$/i, /^y$/i, /comfortable/i] : [/^no$/i, /^n$/i], textAnswer: yes ? 'Yes' : 'No', why: `hybrid/onsite comfort = ${oc.answer} (answer bank)` };
  }
  if (RX.aiProtoTools.test(both)) {
    const t = BANK.ai_prototyping_tools || {};
    const list = t.answer || [];
    if (!list.length) return { action: required ? 'ask' : 'blank', why: 'AI prototyping tools — nothing user-stated on record; never inferred' };
    const escT = (x) => String(x).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    return {
      action: 'select',
      // Match on a stable leading fragment rather than the whole label:
      // One employer's form misspells the option as "Figna Make", and an
      // exact-label match can never hit a typo the employer made.
      prefer: list.map((x) => new RegExp('^\\s*' + escT(String(x).slice(0, 3)), 'i')),
      forbid: (t.never || []).map((x) => new RegExp(x, 'i')),
      textAnswer: t.free_text_answer || t.display,
      why: 'AI prototyping tools = ' + list.join(', ') + ' (user-stated ' + (t.stated_by_user || '') + '). The never-list forbids the other options — an unstated tool is never ticked.',
    };
  }
  if (RX.figmaYears.test(both) && CV?.years != null) {
    // cv.md lists Figma as a core tool across the whole documented career, so
    // the tenure is the documented career length. This is a tenure answer,
    // NOT a proficiency claim.
    return { action: 'fill', value: String(CV.years), why: 'Figma tenure = documented career length from cv.md (' + CV.yearsRange + ') — a tenure figure, not a proficiency claim' };
  }

  // --- CV-derived -------------------------------------------------------
  if (RX.years.test(both)) {
    const band = yearBandOption(CV.years);
    if (band) return { action: 'select', prefer: [band], textAnswer: String(CV.years), why: `years from cv.md (${CV.yearsRange} → ${CV.years}y) — band preferred, exact figure as the free-text fallback` };
  }
  if (RX.graduationYear.test(both) && CV?.education?.graduationYear) {
    return { action: 'fill', value: CV.education.graduationYear, why: 'graduation year from cv.md' };
  }
  if (RX.totalExperience.test(both) && CV?.years != null) {
    return { action: 'fill', value: String(CV.years), why: `total years from cv.md (${CV.yearsRange})` };
  }
  if (RX.toolsUsed.test(both) && CV?.tools?.length) {
    return { action: 'fill', value: CV.tools.join(', '), why: 'tools from cv.md' };
  }
  if (RX.experienceAs.test(both) && CV?.years != null) {
    return { action: 'fill', value: String(CV.years), why: `years as a product designer from cv.md (${CV.yearsRange})` };
  }
  if (RX.b2bYears.test(both) && CV?.years != null) {
    return { action: 'fill', value: `${CV.years}`, why: 'B2B SaaS years from cv.md summary ("5+ years … B2B SaaS")' };
  }
  if (RX.figma.test(both) && CV?.tools?.some((t) => /figma/i.test(t))) {
    return { action: 'select', prefer: [/^advanced/i], why: 'Figma in cv.md tools; design-system ownership in cv.md' };
  }
  if (RX.school.test(both) && CV?.education?.org) return { action: 'fill', value: CV.education.org, why: 'cv.md education' };
  if (RX.degree.test(both) && !RX.fieldOfStudy.test(both) && CV?.education?.degreeFull) return { action: 'fill', value: CV.education.degreeFull, why: 'cv.md education' };
  if (RX.fieldOfStudy.test(both) && CV?.education?.field) return { action: 'fill', value: CV.education.field, why: 'cv.md education' };

  // ---- identity ---------------------------------------------------------
  // Full-name variants are matched BEFORE the split parts, so
  // "legal first & last name" is not mis-sliced into a first-name-only answer.
  if (RX.fullName.test(both)) return { action: 'fill', value: BANK.identity.full_name, why: 'identity (full name, bank)' };
  if (RX.firstName.test(both)) return { action: 'fill', value: String(BANK.identity.full_name).split(/\s+/)[0], why: 'identity (first name, bank)' };
  if (RX.lastName.test(both)) return { action: 'fill', value: String(BANK.identity.full_name).split(/\s+/).slice(1).join(' '), why: 'identity (last name, bank)' };
  if (RX.name.test(l) || RX.name.test(q)) return { action: 'fill', value: BANK.identity.full_name, why: 'identity (bank)' };
  if (RX.email.test(both)) return { action: 'fill', value: BANK.identity.email, why: 'identity (bank)' };
  if (RX.phone.test(both)) return { action: 'fill', value: BANK.identity.phone, why: 'identity (bank) — national 10-digit' };
  if (RX.linkedin.test(both)) return { action: 'fill', value: BANK.identity.linkedin, why: 'identity (bank)' };
  if (RX.portfolio.test(both)) return { action: 'fill', value: BANK.identity.portfolio, why: 'identity (bank)' };
  if (RX.resume.test(both) && kind === 'file') return { action: 'file', why: 'CV upload' };

  return { action: required ? 'ask' : 'blank', why: required ? 'required but unknown — ask' : 'optional and unknown — left blank' };
}

function productCheckboxPolicy(labelText) {
  const l = String(labelText).toLowerCase();
  for (const r of BANK.product_experience || []) if (l.includes(r.label_contains.toLowerCase())) return r;
  return null;
}

/**
 * The answer for a job-location PREFERENCE field.
 *
 * Order: explicit per-company override in the bank, then --location on the
 * command line (the posting's own location), then nothing — which becomes
 * `ask`. The candidate's own residence is never a source for this; that is a
 * different question and is handled by the locationCurrent branch in classify().
 */
function locationAnswer() {
  const byCompany = BANK.location_preference?.by_company || {};
  const key = Object.keys(byCompany).find((k) => k.toLowerCase() === String(company).toLowerCase());
  if (key) return byCompany[key].answer;
  return arg('--location') || '';
}

/**
 * The CV uploaded on every application: the user's own final CV, resolved and
 * hash-checked by final-cv.mjs (the path and SHA-256 recorded in the answer
 * bank). Never a generated or per-company PDF from output/. Throws when the
 * file is missing or altered; the caller turns that into an `ask`.
 */
function cvPathFor() {
  return finalCv(BANK).path;
}

// ── self-check ───────────────────────────────────────────────────────────
  if (has('--check-bank')) {
  const d = String(BANK.identity.phone).replace(/\D/g, '');
  console.log('=== ANSWER BANK ===');
  console.log('  name/phone/email    ', BANK.identity.full_name, '|', BANK.identity.phone, `(${d.length}d)`, '|', BANK.identity.email);
  console.log('  current / expected  ', BANK.compensation.current_ctc.display, '/', BANK.compensation.expected_ctc.display);
  console.log('  notice / joining    ', BANK.availability.notice_period.display, '/', BANK.availability.joining_date.policy);
  console.log('  referral            ', BANK.referral.preference_order.join(' → '));
  console.log('\n=== CONFIRMED SENSITIVE (user-authorised) ===');
  for (const c of CONFIRMED_SENSITIVE) console.log(`  ${c.key.padEnd(18)} ${c.why}`);
  console.log('  race               ', BANK.demographics.race_ethnicity.prefer.join(' → '), '| forbidden:', BANK.demographics.race_ethnicity.forbid.join(', '));
  console.log('  still withheld     ', (BANK.demographics.never_answer || []).length, ':', (BANK.demographics.never_answer || []).join(', '));
  console.log('\n=== LOCATION RULE ===');
  const [ovCo, ov] = Object.entries(BANK.location_preference?.by_company || {})[0] || [];
  console.log('  preference (job)   ', ov ? `${ov.answer}  [${ovCo}, bank override]` : '(no per-company override in the bank)');
  console.log('  current residence  ', BANK.location_preference.current_residence.policy, '— never inferred from a posting');
  console.log('  CV filename         ', BANK.cv.professional_filename);
  let cvCheck;
  try { const f = finalCv(BANK); cvCheck = [`final CV verified: ${f.path} (sha256 ${f.sha256.slice(0, 12)}…)`, true]; }
  catch (e) { cvCheck = [e.message, false]; }
  console.log('  final CV            ', `${cvCheck[1] ? '✓' : '✗'} ${cvCheck[0]}`);
  console.log('\n=== CV FACTS FROM cv.md ===');
  console.log('  years               ', CV?.years, `(${CV?.yearsRange})`);
  console.log('  education           ', JSON.stringify(CV?.education));
  console.log('  tools               ', (CV?.tools || []).join(', '));
  const cases = [
    ['What is your Current CTC?', '', 'fill'],
    ['What is your Expected CTC?', '', 'fill'],
    ['What is your current Notice Period?', '', 'select'],
    ['What is your earliest joining date?', '', 'ask'],
    ['How did you hear about this job?', '', 'select'],
    ['Are you related to anyone who currently works at Acme?', '', 'blank'],
    ['Do you consider yourself a member of the LGB community?', '', 'select'],
    ['What is your gender?', '', 'select'],   // now a confirmed answer, not withheld
    ['How do you currently describe your gender identity?', '', 'select'],
    ['Have you been diagnosed with any disability or impairment?', '', 'select'],
    ['What is your race or ethnicity?', '', 'select-multi'],
    ['Are you a protected veteran?', '', 'select'],
    ['What is your religion?', '', 'skip'],
    ['What is your sexual orientation?', '', 'skip'],
    ['Where do you currently live?', '', 'skip'],
    ['How many years of full-time experience do you have as a Product Designer?', '', 'select'],
    ['What is your Figma proficiency?', '', 'select'],
  ];
  console.log('\n=== CLASSIFIER ===');
  let pass = 0;
  for (const [q, l, exp] of cases) {
    const r = classify(q, l, { required: /joining/i.test(q) });
    const ok = r.action === exp; if (ok) pass++;
    console.log(`  ${ok ? '✓' : '✗'} ${q.slice(0, 58).padEnd(60)} → ${r.action}`);
  }

  // Location resolves only when a source exists: a per-company bank override, or
  // --location carrying the posting's own location. With neither it must ASK.
  // Asserted as a truth table so it holds in any company context.
  const probe = (co, extraLoc) => { const c = company; company = co; const a = arg('--location'); if (extraLoc) process.argv.push('--location', extraLoc); const r = classify('What is your preferred job location?', '', {}); if (extraLoc) { process.argv.splice(process.argv.indexOf('--location'), 2); } company = c; return r; };
  const locCases = [
    ['no company, no --location → ask (never guesses)', probe('', null).action === 'ask'],
    ...(ovCo ? [[`${ovCo} bank override → select`, probe(ovCo, null).action === 'select']] : []),
    ['other company + --location → select', probe('SomeOtherCo', 'Springfield').action === 'select'],
    ['other company, no --location → ask', probe('SomeOtherCo', null).action === 'ask'],
    ['current residence → skip, never from a posting', classify('Where do you currently live?', '', {}).action === 'skip'],
  ];
  console.log('\n=== LOCATION PRECONDITIONS ===');
  for (const [n, ok] of locCases) { if (ok) pass++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); }
  if (ovCo) console.log(`  · ${ovCo} → ${ov.answer} (bank override)`);
  if (cvCheck[1]) pass++;
  const total = cases.length + locCases.length + 1;
  console.log(`\n  ${pass}/${total} checks correct (incl. final CV)`);
  process.exit(pass === total ? 0 : 1);
}

const normish = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Select an option with a REAL click on its input, then read the result back.
 *
 * `check({ force: true })` is not sufficient on a React controlled form. It can
 * set the DOM `checked` property — and even the fiber's memoized props — while
 * the component's own state stays null, because the synthetic change event the
 * site validates against never fires. One ATS rejected a submission with
 * "Missing entry for required field: What is your current Notice Period?" for
 * four fields that every DOM probe reported as checked.
 *
 * So: click the input (not its label — a label click on a DOM-checked radio
 * toggles it back off), then verify. Never skip the read-back.
 */
async function clickOption(page, { type, index, wantLabel }) {
  const sel = `input[type=${type}]`;
  const el = page.locator(sel).nth(index);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(200);
  await el.click({ timeout: 10000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate((arg) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const list = [...document.querySelectorAll(`input[type=${arg.type}]`)];
    const el = list[arg.index];
    if (!el) return { ok: false, why: 'input vanished after click' };
    const lab = norm((el.closest('label')?.innerText)
      || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || '');
    return { ok: el.checked, label: lab };
  }, { type, index });
  if (!after.ok) return { ok: false, label: after.label || wantLabel };
  return { ok: true, label: after.label || wantLabel };
}

/**
 * Resolve the best option for a question, then select it and VERIFY — with two
 * rules learned the hard way on a React controlled form:
 *
 *  1. `check({ force: true })` is not sufficient. It can set the DOM `checked`
 *     property — and even the fiber's memoizedProps — while the component's own
 *     state stays null, because the synthetic change event the site validates
 *     against never fires. One ATS rejected a submission with "Missing entry for
 *     required field: What is your current Notice Period?" for four fields that
 *     every DOM probe reported as checked.
 *
 *  2. Clicking an option that is ALREADY checked turns it OFF. These inputs sit
 *     inside a <label>, so the click bubbles to the label and is re-dispatched
 *     to the input — a net toggle. So the live state is read first and the click
 *     is only issued when the target is genuinely unchecked.
 *
 * Verification re-queries the LIVE DOM by index. Reading `isChecked()` off the
 * handle returns false once React has re-rendered and detached it, which
 * reported ten healthy fields as failures.
 */
/**
 * A react-select widget (Greenhouse uses one for Country, Location (City), and
 * every yes/no dropdown). It is NOT a native <select> and it rejects both
 * .fill() and direct value assignment, because the visible input only ever
 * holds the typed filter text — the chosen value is rendered into a sibling
 * .select__single-value and pushed into a hidden requiredInput.
 *
 * So: focus, type a prefix to filter the menu, then commit with Enter. The
 * value is then read from the rendered label, never from input.value, which
 * is why the naive path reported 'wrote "India" but the field reads ""'.
 */
async function setReactSelect(page, f, value) {
  const loc = await resolveLive(page, f);
  if (!loc) return { ok: false, why: 'combobox not found' };
  const isReact = await loc.evaluate((el) => /select__input/.test(String(el.className || '')) || el.getAttribute('role') === 'combobox').catch(() => false);
  if (!isReact) {
    // A plain text input that happens to be matched here.
    await loc.fill(value).catch(() => {});
    await loc.blur().catch(() => {});
    const got = (await loc.inputValue().catch(() => '')).trim();
    return { ok: got.toLowerCase() === String(value).toLowerCase(), via: 'text', read: got };
  }
  // Already chosen? Read the rendered label before touching it — typing into
  // an already-set react-select REPLACES the value, and clicking a selected
  // option can toggle it off.
  const shown = () => loc.evaluate((el) => {
    const s = el.closest('div')?.parentElement?.querySelector('[class*=select__single-value]');
    return s ? s.textContent.replace(/\s+/g, ' ').trim() : '';
  }).catch(() => '');
  const before = await shown();
  if (before) return { ok: true, via: 'react-select', read: before, already: true };

  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ force: true }).catch(() => {});
  await page.waitForTimeout(250);
  // The value may be a regex SOURCE (the years and notice branches pass
  // prefer[0].source, e.g. "^5\\s*-\\s*7"). Typing that literal text into a
  // search box matches nothing, so the menu comes back empty. Strip regex
  // escapes and keep the leading alphanumeric run as the search token.
  const raw = String(value).replace(/\\\\[sSdDwWbBnrtfv^$.|?*+()\[\]{}]/g, '').trim();
  const token = (raw.match(/^[0-9a-z]+/i) || [raw.slice(0, 4)])[0].slice(0, 6);
  await loc.pressSequentially(token || String(value).slice(0, 4), { delay: 80 }).catch(() => {});
  await page.waitForTimeout(900);

  const opts = await page.evaluate(() => [...document.querySelectorAll('[role=option]')]
    .filter((o) => o.offsetParent).map((o) => (o.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 12));
  const want = String(value).toLowerCase();
  // Greenhouse's country options carry a dialling prefix ("+246 Barbados",
  // "+91 India"), so startsWith() on the value can never match. Fall back to a
  // word-boundary search anywhere in the option, and require the match to be
  // the WHOLE word so "Indiana" or "British Indian Ocean Territory" cannot
  // satisfy a request for "India".
  const esc2 = (x) => String(x).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const wordHit = (o) => new RegExp('\\b' + esc2(want) + '\\b', 'i').test(o);
  const hit = opts.find((o) => o.toLowerCase() === want)
    || opts.find(wordHit)
    // Also test the search token: a banded years select is filtered by token
  // ("5") and offers "5+ years", which matches neither `want` ("5.8") nor a
  // word-boundary test for it.
  || opts.find((o) => o.toLowerCase().startsWith(want.slice(0, 3)))
  || (token && token !== want && opts.find((o) => o.toLowerCase().includes(token.toLowerCase())));
  if (!hit) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, why: `"${value}" not offered (saw ${JSON.stringify(opts.slice(0, 5))}) — not guessing` };
  }
  // Enter is WRONG here: react-select commits whichever option it has
  // highlighted, which after typing "India" is the FIRST match — and that is
  // "British Indian Ocean Territory +246", not "India +91". Clicking our own
  // matched node is the only way to commit the option we actually verified.
  // Scope the click to the open menu so it cannot land on a JD list item.
  const committed = await page.evaluate((h) => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const opt = [...document.querySelectorAll('[role=option]')]
      .filter((o) => o.offsetParent)
      .find((o) => norm(o.innerText).toLowerCase() === h.toLowerCase());
    if (!opt) return null;
    opt.scrollIntoView({ block: 'nearest' });
    opt.click();
    return norm(opt.innerText);
  }, hit);
  if (!committed) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(800);
  const after = await shown();
  if (!after) return { ok: false, why: 'option not committed — widget still empty' };
  // Verification has to cope with two renderings of the same commit:
  //   · the full label  — "Springfield, Illinois, United States"
  //   · a dialling code — Greenhouse's country field commits "India +91" but
  //     renders only "+91", so a word-boundary test for "India" fails on a
  //     perfectly good commit.
  // Both are accepted only when the render is CONTAINED IN the option text we
  // actually clicked, so a wrong commit (e.g. "+246" for "British Indian Ocean
  // Territory") still fails.
  const a = after.toLowerCase(), h = String(committed).toLowerCase();
  const ok = a === want || new RegExp('\\b' + esc2(want) + '\\b', 'i').test(after) || h.includes(a) || a.includes(h);
  return { ok, via: 'react-select', read: after, clicked: committed };
}

async function selectViaRealClick(page, f, c, type) {
  // A text control has no options to choose between. Indian forms routinely
  // render "indicate the number of years of experience" as a free-text box
  // rather than a banded select, so the option hunt returns an empty list and
  // the run used to halt with '"5.8" not offered (saw [])' despite the plan
  // carrying the value. Use the textAnswer directly in that case.
  if (type !== 'radio' && type !== 'checkbox' && c.textAnswer != null) {
    // Years questions are usually a react-select of BANDS ("0-2 years",
    // "3-5 years", "6-8 years"), not a free-text box. Typing the exact figure
    // ("5.8") filters the menu to nothing, so try the preferred band FIRST and
    // only fall back to the exact value for a genuine text control.
    const first = (c.prefer && c.prefer[0] && c.prefer[0].source) || null;
    const order = first ? [first, String(c.textAnswer)] : [String(c.textAnswer)];
    let last = null;
    for (const candidate of order) {
      const r = await setReactSelect(page, f, candidate);
      if (r.ok) return { ok: true, label: r.read, via: r.via };
      last = r;
    }
    return { ok: false, why: (last && last.why) || 'text control did not accept the value', label: '' };
  }
  const hit = await findOptionInGroup(page, { qText: f.question, prefer: c.prefer, forbid: c.forbid, type });
  const el = hit.asElement();
  if (!el) {
    return { ok: false, why: c.fallbackAsk || 'none of the preferred options offered; not guessing', label: '' };
  }
  // index within the live list of same-type inputs, read from the handle
  const idx = await el.evaluate((node) => {
    const sel = `input[type=${node.type}]`;
    return [...document.querySelectorAll(sel)].indexOf(node);
  });
  if (idx < 0) return { ok: false, why: 'could not locate the option in the live DOM', label: '' };

  const read = () => page.evaluate((arg) => {
    const list = [...document.querySelectorAll(`input[type=${arg.type}]`)];
    const el = list[arg.idx];
    if (!el) return null;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return {
      checked: el.checked,
      label: norm((el.closest('label')?.innerText)
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText)
        || el.getAttribute('aria-label') || '').slice(0, 90),
    };
  }, { type, idx });

  const before = await read();
  if (!before) return { ok: false, why: 'option vanished from the live DOM', label: '' };
  if (before.checked) return { ok: true, label: before.label, alreadyChecked: true };

  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);
  await el.click({ timeout: 10000 });
  await page.waitForTimeout(600);
  const after = await read();
  if (!after) return { ok: false, why: 'option vanished after the click', label: before.label };
  if (!after.checked) return { ok: false, why: `clicked "${before.label}" but it did not stay checked`, label: before.label };
  return { ok: true, label: after.label || before.label };
}

/**
 * Fetch the job description for the posting this application belongs to, so the
 * free-text generator has real SOURCE 1 material instead of the form labels.
 * Read-only: opens the POSTING page in a throwaway tab and extracts the text.
 */
async function fetchJd(page, company, role, applicationUrl) {
  if (arg('--jd-file') && existsSync(arg('--jd-file'))) return readFileSync(arg('--jd-file'), 'utf8');
  let target = applicationUrl.replace(/\/(application|apply)\/?$/, '');
  if (!/^https?:/i.test(target)) target = applicationUrl;
  const tab = await page.context().newPage();
  try {
    await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await tab.waitForTimeout(2000);
    const jd = await tab.evaluate(() => {
      const html = window.__appData?.posting?.descriptionHtml;
      if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const out = [];
        const walk = (n) => {
          for (const c of n.childNodes) {
            if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, ' '); if (t.trim()) out.push(t.trim()); continue; }
            if (c.nodeType !== 1) continue;
            const tag = c.tagName.toLowerCase();
            if (tag === 'ul' || tag === 'ol') { for (const li of c.children) if (li.tagName.toLowerCase() === 'li') out.push('- ' + li.innerText.replace(/\s+/g, ' ').trim()); continue; }
            if (/^h[1-6]$/.test(tag)) { out.push('## ' + c.innerText.replace(/\s+/g, ' ').trim()); continue; }
            if (tag === 'p' || tag === 'div') { const t = c.innerText.replace(/\s+/g, ' ').trim(); if (t) { out.push(t); out.push(''); } continue; }
            walk(c);
          }
        };
        walk(doc.body);
        return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      return (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });
    return jd;
  } catch (e) {
    return '';
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Lazily fetch + cache the JD context, only when a free-text field appears. */
let jdCache = null;
async function getJdContext(page, company, role) {
  if (jdCache) return jdCache;
  const jd = await fetchJd(page, company, role, page.url());
  jdCache = { jd, ctx: extractJdContext(jd, { company, role }) };
  return jdCache;
}

/**
 * Re-find a control in the LIVE DOM. Ashby re-renders on change, so a locator
 * built from a plan-time id can go stale (or be "#" when the id was empty).
 * Preference order: stable name attribute → non-empty id → visible label.
 */
async function resolveLive(page, f) {
  if (f.name) {
    const byName = page.locator(`[name="${f.name.replace(/"/g, '\\"')}"]`).first();
    if (await byName.count()) return byName;
  }
  if (f.id) {
    const byId = page.locator(`#${f.id}`).first();
    if (await byId.count()) return byId;
  }
  if (f.label && f.type !== 'radio' && f.type !== 'checkbox') {
    const byPlaceholder = page.getByPlaceholder(f.label, { exact: false }).first();
    if (await byPlaceholder.count()) return byPlaceholder;
    const byLabel = page.getByLabel(f.label, { exact: false }).first();
    if (await byLabel.count()) return byLabel;
  }
  return null;
}

/**
 * Find, IN THE LIVE DOM, the best-matching option that belongs to the question
 * `qText`.
 *
 * The scope is resolved by QUESTION, never by a captured id. Ashby re-renders on
 * every change, so an id captured at plan time is stale and `getElementById`
 * silently returns null — which is why Notice Period and Figma reported
 * "filled" in the log yet never actually ticked. Membership is decided with the
 * same nearest-preceding-question-mark heuristic the plan used, applied fresh.
 */
function findOptionInGroup(page, { qText, prefer, forbid, type }) {
  return page.evaluateHandle((arg) => {
    const pref = arg.prefer.map((p) => new RegExp(p.source, p.flags));
    const ban = (arg.forbid || []).map((p) => new RegExp(p.source, p.flags));
    const want = (arg.qText || '').replace(/\s+/g, ' ').trim();
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const wantKey = want.toLowerCase();
    const raceGroup = /race|ethnic/i.test(wantKey);

    /**
     * Score how well an option's FULL label matches the preferences, and pick
     * the best-scoring option rather than the first that matches.
     *
     * First-match-wins is unsafe on an ordered scale. Ashby's gender options are
     * "Woman, female or feminine" then "Man, male or masculine"; a short
     * preference pattern can match the wrong one, so the runner reported it had
     * answered one option while actually ticking the option above it. Scoring by longest matching preference, with a start-anchored
     * pattern, makes the bank's exact phrasing win.
     */
    /**
     * Score the WHOLE label of every candidate option and keep the best.
     * Returns the matching input element, or null.
     *
     * First-match-wins is unsafe on an ordered scale. Ashby's gender options are
     * "Woman, female or feminine" then "Man, male or masculine"; a short
     * preference pattern can match the wrong one, so the runner reported it had
     * answered one option while actually ticking the option above it. Longer, more specific preference patterns must win, so the
     * score is the length of the longest matching pattern.
     */
    const pickBestInput = (cands) => {
      let best = null;
      for (const inp of cands) {
        const lab = optLabel(inp);
        if (!lab) continue;
        if (ban.some((r) => r.test(lab))) continue;
        let score = 0;
        for (const r of pref) if (r.test(lab)) score = Math.max(score, r.source.length);
        if (score && (!best || score > best.score)) best = { inp, score };
      }
      return best ? best.inp : null;
    };

    // same question-mark harvest as the plan, rebuilt live
    const marks = [];
    for (const el of document.querySelectorAll('label, legend, h1, h2, h3, h4, h5, p, span, div, strong, b')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
      const t = norm(own || (el.childElementCount === 0 ? el.textContent : ''));
      if (!t || t.length > 220) continue;
      // Greenhouse truncates long questions, so the text can end mid-sentence
    // ("Which of the following AI-powered prototyping tools have you") with no
    // trailing "?" or "*". Accept a heading that contains a question word so
    // those groups are still found.
    if (!/(\?|\*)\s*$/.test(t) && !/\b(how|what|which|why|when|where|who|do|does|did|are|is|will|would|can|could|have|has)\b[^.]*[?*]?\s*$/i.test(t)) continue;
      if (!el.offsetParent && el.tagName !== 'LEGEND') continue;
      marks.push({ el, text: t });
    }
    const order = new Map();
    let i = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n = document.body;
    while (n) { order.set(n, i++); n = walk.nextNode(); }
    marks.sort((a, b) => (order.get(a.el) ?? 0) - (order.get(b.el) ?? 0));

    const optLabel = (inp) => norm(inp.closest('label')?.innerText
      || (inp.id && document.querySelector(`label[for="${CSS.escape(inp.id)}"]`)?.innerText)
      || inp.getAttribute('aria-label') || '');

    // Same EEO option-signature detection as the plan harvest — see the comment
    // there. Without it, the ethnicity checkboxes resolved to the referral
    // question ("How did you hear about us?"), so the race preference matched
    // nothing and the block was silently skipped.
    const EEO = /alaska native|african|pacific islander|caucasian|latino|hispanic|asian|indian|self describe|wish to answer|prefer not to say|declined/i;
    const eeoSignature = (scope) => {
      if (!scope) return 0;   // control sits outside any group → not an EEO block
      let hits = 0;
      for (const i of scope.querySelectorAll('input[type=radio],input[type=checkbox]')) {
        const lab = (i.closest('label')?.innerText
          || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.innerText) || '').trim();
        if (EEO.test(lab)) hits++;
      }
      return hits >= 4 ? hits : 0;
    };

    const questionFor = (el) => {
      const fs = el.closest('fieldset, [role=group]');
      if (fs) {
        const lg = fs.querySelector('legend');
        if (lg) return norm(lg.innerText);
        if (eeoSignature(fs)) return 'What is your race or ethnicity?';
        const own = [...fs.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (own) return own;
      }
      const my = order.get(el) ?? 0;
      let best = null;
      for (const m of marks) { if ((order.get(m.el) ?? 0) < my) best = m; else break; }
      const q = best ? best.text : '';
      // same experience-band override as the plan harvest
      if (el.type === 'radio' && /(?:less than\s*)?\d+\+?\s*years?$/i.test(optLabel(el))
          && !/years?\s*of\s*experience|how many years/i.test(q)) {
        return 'How many years of full-time experience do you have?';
      }
      return q;
    };

    // exact-question members first, so a preference can never leak into a
    // neighbouring question that happens to share a word ("Do you know anyone…")
    const pool = [...document.querySelectorAll(`input[type=${arg.type}]`)];
    const scored = pool.map((inp) => ({ inp, q: questionFor(inp) }));

    // A race/ethnicity answer is only ever offered inside a real EEO block.
    // Without this guard a mis-resolved question could let a race preference
    // match an unrelated checkbox anywhere on the form.
    if (raceGroup) {
      const inEeo = scored.filter((s) => eeoSignature(s.inp.closest('fieldset, [role=group]')));
      return inEeo.length ? pickBestInput(inEeo.map((s) => s.inp)) : null;
    }

    const exact = scored.filter((s) => s.q.toLowerCase().startsWith(wantKey));
    const loose = scored.filter((s) => !exact.includes(s) && s.q.toLowerCase().includes(wantKey));
    for (const group of [exact, loose]) {
      if (!group.length) continue;
      const hit = pickBestInput(group.map((s) => s.inp));
      if (hit) return hit;
    }
    return null;
  }, {
    qText, type,
    prefer: prefer.map((r) => ({ source: r.source, flags: r.flags })),
    forbid: (forbid || []).map((r) => ({ source: r.source, flags: r.flags })),
  });
}

// ── run ──────────────────────────────────────────────────────────────────
const url = arg('--url');
const planOnly = has('--plan') || !has('--fill');
if (!url) { console.error('usage: node application-runner.mjs [--plan|--fill] --url <url> [--company X] [--location "City"] [--overwrite]'); process.exit(1); }

const b = await chromium.connectOverCDP(CDP);
const ctx = b.contexts()[0];
// --tab-url pins the run to one specific tab. Without it the runner grabs the
// FIRST non-devtools page, which fills the wrong application whenever several
// are open — exactly the case when several are left open for manual submission.
const tabUrl = arg('--tab-url');
const live = ctx.pages().filter((p) => !p.url().startsWith('devtools'));
let page;
if (tabUrl) {
  const key = tabUrl.split('?')[0].replace(/\/+$/, '');
  page = live.find((p) => {
    const u = p.url().split('?')[0].replace(/\/+$/, '');
    return u === key || u.replace(/\/(application|apply)$/, '') === key.replace(/\/(application|apply)$/, '');
  });
  if (!page) { console.error(`✗ no open tab matches --tab-url ${tabUrl}\n  open tabs:\n${live.map((p) => '    ' + p.url()).join('\n')}`); await b.close(); process.exit(2); }
} else {
  page = live[0] || ctx.pages()[0];
}
if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2000);

const plan = await page.evaluate(() => {
  const labelOf = (el) => (el.getAttribute('aria-label')
    || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText)
    || el.closest('label')?.innerText || el.getAttribute('placeholder') || el.getAttribute('name')
    // Greenhouse's file inputs are id="resume" / id="cover_letter" with no
    // label, name, aria-label or placeholder at all, so the resume read as
    // unlabelled and no CV was attached on ANY Greenhouse form.
    || el.id
    || '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);

  // Ashby does NOT wrap these questions in <fieldset>/<legend>, so an
  // ancestor-innerText heuristic collapses a whole option group down to the
  // option's own label ("Immediate Joiner") and the question is lost. Instead,
  // collect every QUESTION-LIKE string in document order — a short text block
  // ending in "?" or "*" — and attribute each control to the nearest one that
  // precedes it. That is what the candidate sees on screen.
  const QUESTIONY = /(\?|\*)\s*$/;
  const questionMarks = [];
  for (const el of document.querySelectorAll('label, legend, h1, h2, h3, h4, h5, p, span, div, strong, b')) {
    // only elements whose OWN text is the question, not a container's
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const t = own || ((el.childElementCount === 0) ? (el.textContent || '') : '');
    const t2 = t.replace(/\s+/g, ' ').trim();
    if (!t2 || t2.length > 220) continue;
    if (!QUESTIONY.test(t2)) continue;
    if (!el.offsetParent && el.tagName !== 'LEGEND') continue;   // rendered only
    questionMarks.push({ el, text: t2, pos: 0 });
  }
  // document order via a single TreeWalker pass
  {
    const order = new Map();
    let i = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n = document.body;
    while (n) { order.set(n, i++); n = walk.nextNode(); }
    for (const q of questionMarks) q.pos = order.get(q.el) ?? 0;
  }
  questionMarks.sort((a, b) => a.pos - b.pos);

  // Ashby's EEO checkbox groups are <fieldset>s with NO <legend> and a question
  // that no keyword matches — the ethnicity block is literally
  // "Which categories describe you? Select all that apply to you:". So the
  // question text is useless for detection; the OPTION SET is the reliable
  // signal. This is the one place a group is identified by what it offers.
  //
  // Threshold 4 keeps it narrow: the race block scores 11 (every category plus
  // "self describe" / "wish to answer"), while the gender block scores only 2
  // and the product-experience and referral blocks score 0. Withheld
  // categories are still checked FIRST, so gender/LGB/disability can never be
  // mistaken for race.
  const EEO = /alaska native|african|pacific islander|caucasian|latino|hispanic|asian|indian|self describe|wish to answer|prefer not to say|declined/i;
  const eeoSignature = (scope) => {
    let hits = 0;
    for (const i of scope.querySelectorAll('input[type=radio],input[type=checkbox]')) {
      const lab = (i.closest('label')?.innerText
        || (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.innerText) || '').trim();
      if (EEO.test(lab)) hits++;
    }
    return hits >= 4 ? hits : 0;
  };

  const groupOf = (el) => {
    const fs = el.closest('fieldset, [role=group]');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) return { text: lg.innerText.replace(/\s+/g, ' ').trim().slice(0, 300), key: 'fs:' + (lg.innerText || '').slice(0, 40) };
      if (eeoSignature(fs)) return { text: 'What is your race or ethnicity?', key: 'fs:eeo-race-ethnicity' };
      // no legend and not EEO: the question is the fieldset's own leading text
      const own = [...fs.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (own) return { text: own.slice(0, 300), key: 'fso:' + own.slice(0, 40) };
    }
    // nearest preceding question-like element, by document order
    const order = new Map();
    let i = 0;
    const walk = document.createTreeWalker(el.ownerDocument.body, NodeFilter.SHOW_ELEMENT);
    let n = el.ownerDocument.body;
    while (n) { order.set(n, i++); n = walk.nextNode(); }
    const myPos = order.get(el) ?? 0;
    let best = null;
    for (const q of questionMarks) { if (q.pos < myPos) best = q; else break; }
    if (best) return { text: best.text.slice(0, 300), key: 'q:' + best.text.slice(0, 40) };
    return { text: labelOf(el), key: 'solo:' + labelOf(el) };
  };
  return [...document.querySelectorAll('input, select, textarea')]
    .filter((e) => (e.getAttribute('type') || e.tagName).toLowerCase() !== 'hidden')
    .map((el) => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      const label = labelOf(el);
      let g = groupOf(el);
      // Some Ashby questions end in ":" or carry no terminal mark at all, so
      // the question-mark harvest attributes their options to whatever question
      // happened to precede them. That silently swallowed the years-of-
      // experience radios ("5-6 years", "9+ years") into the NOTICE PERIOD
      // group, so the band question was never asked. A recognisable option set
      // is a stronger signal than a missing question mark, so trust it.
      if (type === 'radio' && /(?:less than\s*)?\d+\+?\s*years?$/i.test(label)
          && !/years?\s*of\s*experience|how many years/i.test(g.text)) {
        g = { text: 'How many years of full-time experience do you have?', key: 'q:band:years-of-experience' };
      }
      return {
        type, tag: el.tagName.toLowerCase(),
        id: el.id || '', name: el.getAttribute('name') || '',
        label: labelOf(el),
        // Only radio/checkbox carry a GROUP question. Assigning one to every
        // control made a textarea inherit the preceding question — the "Workflow
        // design…" box was read as "Are you willing to come into the Bangalore
        // office 5 days a week?", so the free-text generator was asked the wrong
        // question and escalated instead of answering.
        question: (type === 'radio' || type === 'checkbox') ? g.text : '',
        groupKey: g.key,
        required: el.required === true || el.getAttribute('aria-required') === 'true'
          || /\*/.test((type === 'radio' || type === 'checkbox' ? g.text : '') || '')
          || /\*/.test(labelOf(el)),
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })) : undefined,
      };
    });
});

const gates = {
  captcha: await page.evaluate(() => !!document.querySelector('[name="g-recaptcha-response"], .g-recaptcha, iframe[src*="recaptcha"]')),
  otp: /one-?time|verification code|magic link|check your (email|inbox)/i.test(await page.evaluate(() => document.body.innerText)),
  login: /sign in to continue|log in to continue|create an account to apply/i.test(await page.evaluate(() => document.body.innerText)),
};

// ── read what the LIVE form already holds ────────────────────────────────
// A question already answered in the page is treated as authoritative and left
// alone. This is what protects a hand-completed answer: the user filled
// Disability / LGBTQ / Gender manually, and an unguarded fill would silently
// overwrite them with a bank default. --overwrite is required to defeat this.
const overwrite = has('--overwrite');
const snapshot = await page.evaluate(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lbl = (el) => (el.getAttribute('aria-label')
    || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText)
    || el.closest('label')?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const qOf = (el) => {
    const fs = el.closest('fieldset, [role=group]');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return norm(lg.innerText).slice(0, 300); }
    return norm(lbl(el)).slice(0, 300);
  };
  const ans = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'hidden') continue;
    if (type === 'radio' || type === 'checkbox') {
      if (!el.checked) continue;
      ans.push({ key: `${type}:${qOf(el)}`, label: norm(lbl(el)), q: qOf(el), value: norm(lbl(el)) || '(checked)' });
    } else if (type === 'file') {
      const f = el.files && el.files[0];
      if (f) ans.push({ key: `file:${el.id || el.name}`, label: lbl(el) || '(file)', q: qOf(el), value: f.name });
    } else {
      const v = (el.value || '').trim();
      if (!v) continue;
      const o = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.text || '').trim() : v;
      if (!o) continue;
      ans.push({ key: `${type}:${el.id || el.name || lbl(el)}`, label: lbl(el), q: qOf(el), value: o });
    }
  }
  return ans;
});
const answeredKeys = new Set(snapshot.map((a) => a.key));
const alreadyAnswered = (f) => {
  // A text control's own label identifies it; a group is identified by question.
  if (f.type === 'radio' || f.type === 'checkbox') return answeredKeys.has(`${f.type}:${f.question}`);
  return answeredKeys.has(`${f.type}:${f.id}`) || answeredKeys.has(`${f.type}:${f.name}`) || answeredKeys.has(`${f.type}:${f.label}`);
};
const heldValue = (f) => {
  const keys = (f.type === 'radio' || f.type === 'checkbox')
    ? [`${f.type}:${f.question}`]
    : [`${f.type}:${f.id}`, `${f.type}:${f.name}`, `${f.type}:${f.label}`];
  for (const k of keys) { const a = snapshot.find((x) => x.key === k); if (a) return a.value; }
  return 'answered';
};
// Values present before the run start; anything that appears here was already
// in the form and is therefore the user's, not ours.
const preExisting = new Set(snapshot.map((a) => a.key));
const preserved = [];   // skipped because the user already answered them
if (!overwrite) {
  console.log('PRESERVED — already answered in the live form, not touched:');
  let n = 0;
  for (const f of plan) {
    if (!alreadyAnswered(f)) continue;
    n++;
    console.log(`  · ${f.type === 'radio' || f.type === 'checkbox'
      ? f.question.slice(0, 56) : (f.label || f.name || f.id).slice(0, 56)} = "${heldValue(f)}"`);
    preserved.push(f);
  }
  if (!n) console.log('  (none)');
  console.log('  (--overwrite is required to rewrite any of these)\n');
}

const filled = [], blanked = [], asked = [], skipped = [], kept = [], generated = [];
const handledGroups = new Set();

console.log('='.repeat(74));
console.log(`APPLICATION RUNNER — ${company || 'role'} @ ${page.url()}`);
console.log('='.repeat(74));
console.log(`  fields ${plan.length} · mode ${planOnly ? 'PLAN (fills nothing)' : 'FILL'}`);
console.log(`  human gates → captcha: ${gates.captcha ? 'YES — never automated' : 'no'} · otp: ${gates.otp} · login: ${gates.login}\n`);

for (const f of plan) {
  // ---- GUARD: never overwrite what is already answered ------------------
  // Skipped entirely, so a hand-entered answer survives untouched. This is the
  // protection for a field the user filled by hand: an unguarded fill would
  // silently replace it with a bank default.
  if (preserved.includes(f)) {
    kept.push(`"${heldValue(f)}" — ${f.type === 'radio' || f.type === 'checkbox' ? f.question.slice(0, 50) : f.label}`);
    continue;
  }

  // ---- file ----------------------------------------------------------
  if (f.type === 'file') {
    // Workable's upload inputs carry no label, so the resume was skipped as
    // "not a CV field" and no CV was ever attached. On Workable there are two:
    // an optional one first and the REQUIRED CV second, so preferring the first
    // uploaded the CV into the optional slot and left the required one empty.
    // Prefer a REQUIRED unlabelled input; fall back to the first only if none.
    const unlabelled = plan.filter((x) => x.type === 'file' && !x.label);
    const requiredUnlabelled = unlabelled.filter((x) => x.required);
    const target = (requiredUnlabelled[0] || unlabelled[0]);
    const isResumeSlot = target && target.id === f.id;
    // Greenhouse wraps its file inputs in a visible "Attach" label, which wins
    // the label chain before the id ("resume" / "cover_letter") is reached — so
    // test the id too, or no CV is ever attached on a Greenhouse form.
    if (!RX.resume.test(`${f.label} ${f.question} ${f.id}`) && !isResumeSlot) {
      skipped.push(`file input "${f.label || '(unlabelled, not the CV slot)'}" — skipped`); continue;
    }
    let p;
    try { p = cvPathFor(); } catch (e) { asked.push(`CV not attached: ${e.message}`); continue; }
    if (planOnly) { filled.push(`(planned) upload ${require('path').basename(p)}`); continue; }
    try {
      await page.locator(`input[type=file]#${f.id}`).first().setInputFiles(require('path').resolve(p));
      filled.push(`CV uploaded → ${require('path').basename(p)}`);
    } catch (e) { asked.push(`CV upload failed: ${String(e.message).slice(0, 60)}`); }
    continue;
  }

  // ---- radio group: classify ONCE, choose ONE option -------------------
  if (f.type === 'radio') {
    if (handledGroups.has(f.groupKey)) continue;
    handledGroups.add(f.groupKey);
    const c = classify(f.question, '', { required: f.required, kind: 'radio' });
    const members = plan.filter((x) => x.type === 'radio' && x.groupKey === f.groupKey);
    if (c.action === 'skip' || c.action === 'blank') { skipped.push(`Q "${f.question.slice(0, 66)}" — ${c.why}`); continue; }
    if (c.action === 'ask') { asked.push(`Q "${f.question.slice(0, 66)}" — ${c.why}`); continue; }
    if (c.action !== 'select') continue;
    if (planOnly) { filled.push(`(planned) Q "${f.question.slice(0, 46)}"`); continue; }
    const r = await selectViaRealClick(page, f, c, 'radio');
    if (r.ok) filled.push(`Q "${f.question.slice(0, 46)}" → "${r.label}"  [${c.why}]  (${r.alreadyChecked ? 'already checked, left as is' : 'real click, verified'})`);
    else asked.push(`Q "${f.question.slice(0, 60)}" — ${r.why}`);
    continue;
  }

  // ---- checkbox (possibly multi-select) --------------------------------
  if (f.type === 'checkbox') {
    // Product-experience rules are decided PER OPTION, from the answer bank.
    // A `select: true` rule must check that box directly: routing it through the
    // group classifier instead fell through to "optional and unknown — left
    // blank", because the group's question text ("Which best describes your
    // primary product design experience?") matches no bank rule. The evidence
    // gate lives in the bank, so a `false`/`conditional` rule still overrides.
    const rule = productCheckboxPolicy(f.label);
    if (rule && rule.select === false) { skipped.push(`"${f.label}" — ${rule.reason}`); continue; }
    if (rule && rule.select === 'conditional') { asked.push(`"${f.label}" — ${rule.evidence_required}`); continue; }
    if (rule && rule.select === true) {
      if (planOnly) { filled.push(`(planned) check "${f.label}"  [bank: ${rule.evidence || rule.label_contains}]`); continue; }
      const box = await resolveLive(page, f).catch(() => null);
      if (!box) { asked.push(`"${f.label}" — checkbox not found in the live DOM`); continue; }
      try {
        if (await box.isChecked()) {
          filled.push(`"${f.label}" already checked — left as is  [bank: ${rule.label_contains}]`);
        } else {
          await box.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(200);
          await box.click({ timeout: 10000 });
          await page.waitForTimeout(600);
          const on = await box.isChecked();
          if (on) filled.push(`checked "${f.label}"  [bank: ${rule.evidence || rule.label_contains}]  (real click, verified)`);
          else asked.push(`"${f.label}" — real click did not leave it checked`);
        }
      } catch (e) { asked.push(`"${f.label}" — check failed: ${String(e.message).slice(0, 50)}`); }
      continue;
    }
    if (handledGroups.has(f.groupKey)) continue;
    handledGroups.add(f.groupKey);
    const c = classify(f.question, f.label, { required: f.required, kind: 'checkbox' });
    if (c.action === 'skip' || c.action === 'blank') { skipped.push(`Q "${f.question.slice(0, 66)}" — ${c.why}`); continue; }
    if (c.action === 'ask') { asked.push(`Q "${f.question.slice(0, 66)}" — ${c.why}`); continue; }
    if (c.action === 'select-multi') {
      const r = await selectViaRealClick(page, f, c, 'checkbox');
      if (r.ok) filled.push(`Q "${f.question.slice(0, 40)}" → "${r.label}"  [${c.why}]  (${r.alreadyChecked ? 'already checked, left as is' : 'real click, verified'})`);
      else asked.push(`Q "${f.question.slice(0, 60)}" — ${r.why}`);
      continue;
    }
    if (c.action === 'select') {
      const r = await selectViaRealClick(page, f, c, 'checkbox');
      if (r.ok) filled.push(`"${r.label}"  [${c.why}]  (real click, verified)`);
      else asked.push(`"${f.question.slice(0, 60)}" — ${r.why}`);
      continue;
    }
    continue;
  }

  // ---- select element --------------------------------------------------
  if (f.tag === 'select') {
    // Education month/year pickers carry no useful label and sit under a
    // heading, so they are recognised by their OPTIONS, and paired by ORDINAL
    // position (start month, start year, end month, end year). Ashby's select
    // ids carry no "end"/"graduation" hint, so an id-based test set BOTH years
    // to the start year.
    const optTexts = (f.options || []).map((o) => o.text);
    const isMonth = optTexts.includes('January') && optTexts.includes('December');
    const isYear = optTexts.some((t) => /^(19|20)\d{2}$/.test(t));
    if ((isMonth || isYear) && CV?.education) {
      // Paired by ORDINAL among the plan's selects, matched by OBJECT IDENTITY.
      // Ashby's select ids are all empty, so `x.id === f.id` was true for the
      // first select four times over and every date became the START date.
      // Order is: start month, start year, end month, end year.
      const allSelects = plan.filter((x) => x.tag === 'select');
      const ord = allSelects.indexOf(f);
      const isEnd = ord === 2 || ord === 3;
      const want = String((isEnd ? CV.education.end : CV.education.start) || '');
      const monName = want.split(' ')[0];
      const yr = want.split(' ')[1];
      let hitOpt = null;
      if (isYear) hitOpt = f.options.find((o) => o.text === yr);
      else {
        // cv.md says "Aug 2017"; the dropdown says "August". Match the OPTION
        // and then use its VALUE — Ashby's month select values are the month
        // numbers (August = "8"), not the option index (index 8 = "September"
        // once the "Month..." placeholder is counted), so selecting by index
        // silently wrote the wrong month.
        hitOpt = f.options.find((o) => /^month/i.test(o.text) ? false
          : o.text.toLowerCase().startsWith(monName.toLowerCase().slice(0, 3)));
      }
      if (hitOpt && hitOpt.value) {
        const what = `${isEnd ? 'end' : 'start'} ${isYear ? 'year' : 'month'} = ${hitOpt.text}`;
        if (planOnly) { filled.push(`(planned) education ${what}  [cv.md]`); continue; }
        const live = await page.locator('select').count();
        if (ord < 0 || ord >= live) { asked.push(`education ${what} — select index ${ord} out of range`); continue; }
        await page.locator('select').nth(ord).selectOption(hitOpt.value);
        filled.push(`education ${what}  [cv.md]`);
        continue;
      }
      asked.push(`education ${isYear ? 'year' : 'month'} select — could not map cv.md value "${want}"`);
      continue;
    }
    const c = classify(f.question, f.label, { required: f.required, kind: 'select' });
    if (c.action !== 'select' && c.action !== 'fill') { (c.action === 'ask' ? asked : skipped).push(`${f.label || 'select'} — ${c.why}`); continue; }
    const pref = c.prefer || [new RegExp('^' + String(c.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')];
    const opt = f.options.find((o) => o.value && pref.some((r) => r.test(o.text)));
    if (!opt) { asked.push(`${f.label || 'select'} — preferred option not offered`); continue; }
    if (planOnly) { filled.push(`(planned) select "${opt.text}"`); continue; }
    await page.locator('select').nth(plan.filter((x) => x.tag === 'select').indexOf(f)).selectOption(opt.value);
    filled.push(`selected "${opt.text}" — ${c.why}`);
    continue;
  }

  // ---- text / number / email -------------------------------------------
  // A text control's OWN label is the question. The nearest-preceding-question
  // heuristic is for GROUPS only: applying it to a text input made LinkedIn,
  // portfolio, Degree and Field of Study inherit the question of the control
  // before them ("Are you a previous Acme employee?" → value "No").
  const c = classify('', f.label, { required: f.required, kind: f.type });
  if (c.action === 'skip') { skipped.push(`${f.label} — ${c.why}`); continue; }
  if (c.action === 'blank') { blanked.push(`${f.label} — ${c.why}`); continue; }

  // ── FREE-TEXT GENERATION ──────────────────────────────────────────────
  // An open-ended question ("why do you want to work here", "cover letter",
  // "describe a difficult design problem") used to be escalated to the user.
  // It is now answered from the live JD + the closed verified-experience set,
  // then quality-checked. Still escalates when generation is blocked, so an
  // unanswerable question is never invented.
  if (c.action === 'ask' || (c.action === 'fill' && c.via === 'free_text')) {
    const qText = f.question || f.label;
    const gtype = classifyQuestion(qText);
    if (gtype !== 'unknown') {
      const { jd, ctx: jctx } = await getJdContext(page, company, arg('--role', ''));
      const lim = readLimit(`${qText} ${f.hint || ''}`);
      const gen = generateAnswer({ question: qText, company, role: arg('--role', ''), jdText: jd, limit: lim, extraContext: jctx });
      if (gen.ok) {
        if (planOnly) { filled.push(`(planned) generated ${gtype} (${gen.wordCount}w) for "${f.label}"`); continue; }
        const loc = await resolveLive(page, f);
        if (!loc) { asked.push(`${f.label} — free-text control not found`); continue; }
        try {
          await loc.fill(gen.answer);
          await loc.blur().catch(() => {});
          generated.push({ field: f.label, type: gtype, words: gen.wordCount, answer: gen.answer, checks: gen.checks });
          filled.push(`generated ${gtype} → "${f.label}" (${gen.wordCount}w)  [JD + cv.md]`);
        } catch (e) { asked.push(`${f.label} — free-text fill failed: ${String(e.message).slice(0, 50)}`); }
        continue;
      }
      // blocked: report the structured reason rather than inventing
      asked.push(`${f.label} — ${gtype}: ${gen.reason}`);
      continue;
    }
  }

  if (c.action === 'ask') { asked.push(`${f.label} — ${c.why}`); continue; }
  if (c.action === 'select' && c.textAnswer) {
    // A yes/no question rendered as a text input.
    const loc0 = await resolveLive(page, f);
    if (!loc0) { asked.push(`${f.label} — text control not found`); continue; }
    if (planOnly) { filled.push(`(planned) ${f.label} = ${c.textAnswer}  [${c.why}]`); continue; }
    try {
      const r = await setReactSelect(page, f, c.textAnswer);
      if (r.ok) filled.push(`${f.label} = ${r.read}  [${c.why}]  (${r.via}${r.already ? ', already set' : ', verified'})`);
      else asked.push(`${f.label} — ${r.why || ('wrote "' + c.textAnswer + '" but the field reads "' + (r.read || '') + '"')}`);
    } catch (e) { asked.push(`${f.label} — text fill failed: ${String(e.message).slice(0, 50)}`); }
    continue;
  }
  if (c.action !== 'fill') { blanked.push(`${f.label} — ${c.why}`); continue; }
  let v = c.value;
  if (v && typeof v === 'object') v = BANK.compensation.bare_number ? String(v.value) : v.display;

  // Resolve the control LIVE, not from the plan snapshot. Ashby is React and
  // re-renders on every change, which invalidates the ids captured at plan
  // time — a stale `page.locator('#id')` then either throws or, with an empty
  // id, produces the bare selector "#" and a querySelector SyntaxError. That is
  // why Phone, Portfolio and Expected CTC silently failed to fill.
  const loc = await resolveLive(page, f);
  if (!loc) { asked.push(`${f.label} — control not found in the live DOM`); continue; }
  if (planOnly) { filled.push(`(planned) ${f.label} = ${v}`); continue; }
  // Greenhouse renders many of these as react-selects even when the plan
  // classified them as a plain text fill (CTC, expected CTC, highest
  // qualification, year of completion, Figma tenure). .fill() on a
  // react-select writes the visible input but never commits, leaving the
  // hidden requiredInput empty — the read-back then reports the field empty
  // and the run halts on a value the fill log had just printed. Detect the
  // widget and commit properly.
  const isWidget = await loc.evaluate((el) =>
    /select__input/.test(String(el.className || '')) || el.getAttribute('role') === 'combobox',
  ).catch(() => false);
  if (isWidget && v != null && String(v) !== '') {
    const r = await setReactSelect(page, f, String(v));
    if (r.ok) { filled.push(`${f.label} = ${r.read}  [${c.why}]  (react-select, verified)`); continue; }
    // fall through to the plain fill so the DOM at least carries the value
  }
  try {
    // Ashby's "Search schools..." is a typeahead: typing filters a suggestion
    // list and the value is only committed when a suggestion is clicked. A bare
    // .fill() leaves the field empty. So type, wait for suggestions, and click
    // the one that actually matches — then confirm the field took the value.
    if (await loc.getAttribute('placeholder') === 'Search schools...') {
      await loc.click();
      // Real keystrokes, not fill(): the typeahead is driven by input/keydown
      // handlers, so a one-shot .fill() sets the DOM value without ever
      // producing a suggestion list (the pool came back empty).
      await loc.fill('');
      await loc.pressSequentially(String(v), { delay: 60 });
      await page.waitForTimeout(2500);
      const picked = await page.evaluate((want) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const w = norm(want);
        // A candidate suggestion is a leaf-ish list item that is NOT part of a
        // radio/checkbox group. Without that exclusion the loose class selector
        // swept up the whole option list of the form ("immediate joiner",
        // "30 days", …) and the real school suggestion was never considered.
        const isOpt = (e) => e.offsetParent && !e.querySelector('input,select,textarea,button')
          && norm(e.innerText) && norm(e.innerText).length < 120;
        // role="option" is the combobox suggestion contract and is unambiguous.
        // A class-name sweep ("*option*", "*suggest*") is not: it matched the
        // form's own radio options and the <select> option lists, which is how
        // "immediate joiner" and "2027 2026 2025 …" got into the pool. If no
        // role=option is found, fall back to <li> inside a listbox only.
        const items = [...document.querySelectorAll('[role=option]')].filter(isOpt);
        if (!items.length) items.push(...[...document.querySelectorAll('[role=listbox] li')].filter(isOpt));
        const hit = items.find((e) => norm(e.innerText) === w)
          || items.find((e) => norm(e.innerText).startsWith(w))
          || items.find((e) => norm(e.innerText).includes(w))
          || items.find((e) => w.includes(norm(e.innerText)) && norm(e.innerText).length > 6);
        if (!hit) return { ok: false, seen: items.slice(0, 8).map((e) => norm(e.innerText)) };
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return { ok: true, clicked: norm(hit.innerText) };
      }, String(v));
      await page.waitForTimeout(900);
      const after = await loc.inputValue().catch(() => '');
      if (picked.ok && normish(after).includes(normish(String(v)).slice(0, 12))) {
        filled.push(`${f.label} = "${after}"  [cv.md education — typeahead]`);
      } else {
        asked.push(`School typeahead — ${picked.ok ? `clicked "${picked.clicked}" but field reads "${after}"` : `no suggestion matched "${v}" (saw: ${(picked.seen || []).join(' | ')})`}`);
      }
      continue;
    }
    await loc.fill(String(v));
    await loc.blur().catch(() => {});
    // Phone integrity check. Workable's tel input already held a leading "0",
    // so filling a 10-digit number produced 11 digits with a stray leading
    // zero. A wrong phone number is worse than a reported failure, so compare
    // the digits actually in the field against the bank value and report a
    // mismatch rather than letting it through silently.
    if (RX.phone.test(`${f.label} ${f.question}`)) {
      const want = String(BANK.identity.phone).replace(/\D/g, '');
      const got = await loc.inputValue().catch(() => '');
      const gotDigits = String(got).replace(/\D/g, '');
      if (gotDigits === want) filled.push(`${f.label} = ${got}  [${c.why}]  (10 digits verified)`);
      else if (gotDigits.replace(/^0+/, '') === want) {
        // a leading zero crept in — clear and retype rather than ship it
        await loc.fill('');
        await loc.pressSequentially(want, { delay: 30 });
        await loc.blur().catch(() => {});
        const retry = (await loc.inputValue().catch(() => '')).replace(/\D/g, '');
        if (retry === want) filled.push(`${f.label} = ${want}  [${c.why}]  (leading zero removed, verified)`);
        else asked.push(`${f.label} — phone field holds "${retry}" after a retype, expected ${want}. Not submitting a wrong number.`);
      } else {
        asked.push(`${f.label} — phone field holds "${gotDigits}" but the bank says ${want}. Not submitting a wrong number.`);
      }
      continue;
    }
    filled.push(`${f.label} = ${v}  [${c.why}]`);
  } catch (e) { asked.push(`${f.label} — fill failed: ${String(e.message).slice(0, 60)}`); }
}

console.log(`\nPRESERVED — your existing entries, not overwritten (${kept.length})`);
for (const k of kept) console.log('  · ' + k);
console.log(`\nWILL FILL / FILLED (${filled.length})`);
for (const f of filled) console.log('  ✓ ' + f);
console.log(`\nLEFT BLANK — OPTIONAL (${blanked.length})`);
for (const s of blanked) console.log('  ○ ' + s);
console.log(`\nNEEDS YOU (${asked.length})`);
for (const a of asked) console.log('  ? ' + a);
console.log(`\nNOT ANSWERED BY DESIGN (${skipped.length})`);
for (const s of skipped) console.log('  ✗ ' + s);
console.log(`\nSUBMIT: not clicked — always a human action.`);

await b.close();
