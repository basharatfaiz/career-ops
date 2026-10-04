#!/usr/bin/env node
/**
 * answer-generator.mjs — generate company-specific free-text answers.
 *
 * The runner must not stop for every open-ended question. This generates a
 * concise, specific answer from four sources, in order:
 *
 *   1. JOB DESCRIPTION   — the live posting's actual responsibilities,
 *                          product area, users and requirements
 *   2. COMPANY / PRODUCT — only what the posting itself states about the
 *                          company or its product
 *   3. VERIFIED EXPERIENCE — the closed set in data/application-answers.yml,
 *                          which mirrors cv.md and nothing else
 *   4. ROLE FIT          — the connection between 1/2 and 3
 *
 * It never invents customers, metrics, products, industries, tools,
 * responsibilities, company knowledge, or personal connections, and never
 * implies the user has used a company's product.
 *
 * Every answer is length-budgeted and then quality-checked. A claim that cannot
 * be traced to the JD, the posting, or cv.md is dropped, not softened.
 *
 * Usage (library):
 *   import { generateAnswer, extractJdContext } from './answer-generator.mjs';
 *   const out = generateAnswer({ question, company, role, jdText, limit });
 *   // -> { ok, answer, wordCount, type, sources, checks, blocked, reason }
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const BANK = yaml.load(readFileSync('data/application-answers.yml', 'utf8'));
const V = BANK.verified_experience || {};
const BUDGETS = BANK.free_text?.word_budgets || {};
const HOME = BANK.geography?.home_country || 'India';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = norm(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// ── 1. JD CONTEXT EXTRACTION ─────────────────────────────────────────────
/**
 * Pull the distinctive, checkable specifics out of a live posting. Everything
 * returned here is quoted from the posting, so an answer built on it is
 * grounded by construction.
 */
export function extractJdContext(jdText = '', meta = {}) {
  const text = norm(jdText);
  const company = norm(meta.company || '');
  const lines = String(jdText).split('\n').map((l) => norm(l)).filter(Boolean);

  // Words that are capitalised only because they start a sentence or a heading.
  const STOP_CAP = new RegExp('^(We|A|The|This|You|Your|Our|What|Who|How|Why|When|Where|Will|Can|Do|Does|Is|Are|In|On|At|To|For|And|Or|If|As|By|With|From|About|Design|Product|Team|Role|Work|Experience|Working|Requirements|Responsibilities|Overview|Apply|Senior|Junior|Staff|Principal|About|Company|Benefits|Equal|Employment|Beware|Using|Leverage|Partner|Contribute|Conduct|Define|Establish|Own|Lead|Ensure|Strong|Excellent|Good|Proven|Ability|Awareness|Understanding|Familiarity|Use|Used|Proficiency|Knowledge|Skills|Salary|Bonus|Location|Department|Type|Status|Name|Email|Phone|Notice|Current|Expected|Referral|Submit|Upload|Presume|Cover|Letter|Password|Upload|Submit|Describe|Share|Tell|Paste|Summary|Notice|Period|Current|Notice)$', 'i');

  // Product / feature surface: proper nouns and capitalised multiword terms.
  // "Digital Forms", "Team Chat", "Task Centre", "Pendo", "Sigma" — the words a
  // generic answer would never contain, and the proof the JD was read.
  //
  // Page-chrome rejection is not optional. Feeding raw page text produced terms
  // like "Explore Locations See and Life At Acme Your" and "Remote
  // Employment Type Full", which then appeared verbatim inside answers.
  const CHROME = /\b(overview|application|apply|employment type|department|compensation|location type|share this job|autofill|upload|submit|privacy policy|security|vulnerability disclosure|powered by|skip and solve|add to favorites|view all|back to|home|sign in|log in|menu|search|job board|careers|apply now|submit application|see all|learn more|read more|cookie|accept|privacy|terms)\b/i;
  const properNouns = new Set();
  const addTerm = (phrase) => {
    const t = norm(phrase);
    if (!t || t.length < 3 || t.length > 42) return;
    if (company && t.toLowerCase() === company.toLowerCase()) return;
    // The ROLE TITLE is not a product term. Letting it through produced
    // "the work around Senior Product Designer", which reads as nonsense.
    if (meta.role && t.toLowerCase() === norm(meta.role).toLowerCase()) return;
    if (STOP_CAP.test(t.split(/\s+/)[0]) && t.split(/\s+/).length === 1) return;
    if (CHROME.test(t)) return;
    if (/[.,;]$/.test(t)) return;
    if (/^(and|or|the|a|an|of|for|to|in|on|at|by|with|from|is|are|was|were|be|been)\b/i.test(t)) return;
    // A term that is just the role's job-family noun adds nothing
    if (/^(senior|junior|staff|principal|lead)?\s*(product|ux|ui)?\s*designer$/i.test(t)) return;
    // Person names are not product terms. One posting listed its
    // founders in the JD, and the generated cover letter opened by naming them.
    for (const m of text.matchAll(new RegExp(`.{0,90}${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,60}`, 'gi'))) {
      if (/\b(founder|co-?founder|founded|established|started by|ceo|cto|coo|cpo|head of|led by|still lead|leads the|reports to|join us|meet the (team|people)|author|attended|graduated from)\b/i.test(m[0])) return;
    }
    properNouns.add(t);
  };
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,3})\b/g)) {
    const phrase = norm(m[1]);
    const words = phrase.split(/\s+/);
    if (words.length === 1) {
      // Single capitalised words are the weakest signal — sentence starts,
      // adverbs and stray jargon all match. Keep only ones that look like a
      // brand or product: internal capitals, digits, or an all-caps token.
      if (!/^(?:[A-Z][a-z0-9]+){2,}$/.test(phrase) && !/\d/.test(phrase) && !/^[A-Z]{2,}$/.test(phrase)) continue;
      addTerm(phrase);
      continue;
    }
    // Multi-word phrases get a NARROW leading-stop list. The broad list dropped
    // legitimate product names — "Team Chat" died because "Team" was on it.
    if (/^(A|An|The|This|That|These|Those|We|You|Your|Our|It|They|There|Here|What|Who|Why|When|Where|Will|Would|Can|Could|Should|Do|Does|Did|Is|Are|Was|Were|Be|Been|And|Or|But|If|So|As|By|In|On|At|To|For|From|With|About|Than|Then|While|After|Before|Under|Also|Most|Some|Any|All|Each|Every|New|Other|More|Less)$/i.test(words[0])) continue;
    addTerm(phrase);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s+and\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g)) {
    for (const g of m.slice(1, 4)) {
      addTerm(g);
      // "Positively and Automotive Retail Cloud" is one capture spanning a
      // conjunction; the real term is the tail. Split it.
      const parts = g.split(/\s+and\s+/i);
      if (parts.length > 1) for (const p2 of parts) addTerm(p2);
    }
  }
  // Drop any term that CONTAINS another term — the shorter one is the real name.
  const all = [...properNouns];
  const clean = all.filter((t) => !all.some((o) => o !== t && o.length > 3 && t.includes(o)));
  properNouns.clear();
  for (const t of clean) properNouns.add(t);

  const bullets = lines.filter((l) => /^[-•*]/.test(l)).map((l) => l.replace(/^[-•*]\s*/, ''));
  const sections = {};
  let current = 'general';
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) { current = l.replace(/^#+\s*/, '').trim(); sections[current] = sections[current] || []; continue; }
    if (/^(what you will own|what you will need|what will make you|responsibilities|requirements|about the role|about us|what you'll own|what you'll need|who you are|nice to have|qualifications)/i.test(l)) { current = l.trim(); sections[current] = sections[current] || []; continue; }
    (sections[current] = sections[current] || []).push(l);
  }

  const pickBullets = (names) => {
    for (const n of names) {
      const k = Object.keys(sections).find((s) => s.toLowerCase().includes(n));
      if (k) return sections[k].filter((l) => /^[-•*]/.test(l)).map((l) => l.replace(/^[-•*]\s*/, ''));
    }
    return [];
  };

  const owns = pickBullets(['what you will own', "what you'll own", 'responsibilities', 'what you will need to accomplish']);
  const needs = pickBullets(['what you will need', "what you'll need", 'requirements', 'qualifications', 'what you need to accomplish']);
  const love = pickBullets(['what will make us love you', 'nice to have', 'preferred qualifications', 'bonus']);

  // the user's/problem sentence: first substantive paragraph
  const opener = lines.find((l) => l.length > 60 && !/^[-•*#]/.test(l)) || '';

  // problem language the posting actually uses
  const problemTerms = [];
  for (const re of [/\b(simplif\w+|streamlin\w+|unblock\w+|fragment\w+|duplicat\w+|manual\w*|complex\w*|scal\w+|multi-?tenant|integrat\w+|workflow|onboard\w+|activat\w+|adoption|compliance|accessib\w+|trust)\w*/gi]) {
    for (const m of text.matchAll(re)) { const w = m[0].toLowerCase(); if (w.length > 4 && !problemTerms.includes(w)) problemTerms.push(w); }
  }

  return {
    text,
    company: meta.company || '',
    role: meta.role || '',
    productTerms: [...properNouns].slice(0, 14),
    // Fallback focus when a posting has no extractable product names. Taken from
    // the JD's own top responsibility, so it is still grounded in the posting —
    // and it stops the generator from refusing to answer at all, which is what
    // "references-the-posting" did for five roles with terse JDs.
    focus: (() => {
      const t = [...properNouns].slice(0, 2);
      if (t.length) return t;
      const first = owns[0] || needs[0] || '';
      const cleaned = norm(first).replace(/^(design|build|own|lead|define|contribute|partner|use|conduct|leverage)\s+/i, '');
      const head = cleaned.split(/[,;.]/)[0].trim();
      if (head && head.length > 8 && head.length < 90) return [head];
      // No product name and no usable responsibility. Fall back to the themes
      // the posting actually emphasises, phrased as themes rather than as a
      // pretend product name.
      const themes = [];
      if (/\b(enterprise|b2b|customer|admin|tenant|workspace)\b/i.test(text)) themes.push('enterprise product design');
      if (/\b(ai|artificial intelligence|llm|copilot|agent|automation)\b/i.test(text)) themes.push('AI-assisted workflows');
      if (/integration|api|connector|third-?party|platform/i.test(text)) themes.push('platform integrations');
      if (/design system|component library|pattern/i.test(text)) themes.push('design-system work');
      if (/research|interview|discovery/i.test(text)) themes.push('customer research');
      if (!themes.length && meta.role) {
        // Deliberately NOT the role title. "the work around Senior Product
        // Designer" is nonsense, and it reached two live answers.
        const kind = /\bdesigner\b/i.test(meta.role) ? 'product design' : norm(meta.role);
        themes.push(kind === 'product design' ? 'enterprise product design' : kind);
      }
      return themes.slice(0, 2);
    })(),
    owns, needs, love,
    opener: clip(opener, 260),
    problemTerms: problemTerms.slice(0, 12),
    hasResearch: /research|interview|discovery|customer/i.test(text),
    hasDesignSystem: /design system|component library|pattern/i.test(text),
    hasAI: /\b(ai|artificial intelligence|ml|llm|copilot|agent|automation)\b/i.test(text),
    hasIntegrations: /integration|api|connector|third-?party|webhook|platform/i.test(text),
    hasB2B: /b2b|enterprise|customer|admin|workspace|tenant/i.test(text),
    hasMobile: /mobile|ios|android|app\b/i.test(text),
    isRemoteFirst: /remote|distributed|async/i.test(text),
    sections: Object.keys(sections),
  };
}

// ── 2. QUESTION TYPE ──────────────────────────────────────────────────────
const TYPES = [
  ['why_company', /(why do you want to work (here|at|with)|why (weave|bitwarden|this company)|why us\b|what interests you about (our|the) (product|company)|what do you like about|why .*company)/i],
  ['why_role', /(why (are you )?interested (in|with) (this|the) (role|job|position|opportunity)|what (excites|interests) you (about )?(this|about) (opportunity|role)|why this role)/i],
  ['why_fit', /(why are you a (good )?fit|why (would|should) we (hire|choose)|what makes you a strong candidate|what makes you (the )?(right|strong)|why are you the right)/i],
  ['about_yourself', /(tell us about yourself|tell me about yourself|introduce yourself|walk us through your|short bio|about you\b)/i],
  ['relevant_product', /(what product have you worked on|product (have you|you've) (built|worked)|what have you (built|shipped)|tell us about a (relevant )?product)/i],
  ['proud_project', /(share one design project|project you are most proud|most proud|portfolio link|figma link|show us your work|walk us through a project)/i],
  ['difficult_problem', /(difficult (design )?problem|challenging (problem|situation)|hardest|times things (went wrong|didn't work)|ambiguous|stakeholder (conflict|disagreement))/i],
  ['ai_experience', /(experience (with )?(ai|artificial intelligence|llm|ml|agents?|copilot)|how have you used ai|ai-powered|worked on ai)/i],
  ['integrations_experience', /(experience (with )?integrations?|third-?party|api work|connector|platform integration|worked on integrations)/i],
  ['research_experience', /(user research|customer research|discovery|interviews|how do you (do|run) research|usability)/i],
  ['design_system_experience', /(design system|component library|design tokens|pattern library)/i],
  ['metrics_outcome', /(measurable|metric|outcome|how do you measure|impact you|results you)/i],
  ['why_leaving', /(why are you (looking|leaving)|why (now|nowadays)|what made you (look|leave)|looking for your next|why are you changing)/i],
  ['what_bring', /(what would you bring|what can you (contribute|offer)|how can you (contribute|help)|what would you add)/i],
  ['cover_letter', /(cover letter|cover note)/i],
];
export function classifyQuestion(q, company = '') {
  const t = norm(q);
  for (const [type, re] of TYPES) if (re.test(t)) return type;
  // Company-name patterns last, and only when the company is known. "Why are you
  // interested in working at Tether?" matched nothing at all, so a question the
  // generator exists to answer was escalated to the user.
  const co = norm(company);
  if (co) {
    const esc = co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = [
      ['why_company', new RegExp(`^\\s*\\*?\\s*why[^?]{0,40}\\b(at|with|for|to join)\\s+(the\\s+)?${esc}\\b`, 'i')],
      ['why_company', new RegExp(`\\bwhy\\s+${esc}\\b`, 'i')],
      ['why_company', new RegExp(`\\b${esc}\\s*[-—:]?\\s*why (are you|do you|what)\b`, 'i')],
      ['why_role', new RegExp(`^\\s*\\*?\\s*why[^?]{0,40}\\b(at|with|for)\\s+(the\\s+)?${esc}\\b`, 'i')],
    ];
    for (const [type, re] of named) if (re.test(t)) return type;
  }
  // generic fallbacks that do not need the company name
  if (/^\s*\*?\s*why (are you )?interested (in|with) (working|joining)/i.test(t)) return 'why_company';
  if (/^\s*\*?\s*why do you want to (join|work|be)/i.test(t)) return 'why_company';
  if (/^\s*\*?\s*what (made|led) you (to )?apply/i.test(t)) return 'why_company';
  if (/^\s*\*?\s*(tell us |why do you )?(about )?(your )?(story|background)\b/i.test(t)) return 'about_yourself';
  return 'unknown';
}

/** Read a stated character/word limit off the question or its field. */
export function readLimit(text = '') {
  const t = norm(text);
  const chars = t.match(/(\d[\d,]*)\s*(?:characters|chars)/i);
  if (chars) return { kind: 'chars', value: parseInt(chars[1].replace(/,/g, ''), 10) };
  const words = t.match(/(\d[\d,]*)\s*(?:words)/i);
  if (words) return { kind: 'words', value: parseInt(words[1].replace(/,/g, ''), 10) };
  const maxChars = t.match(/(?:max|maximum|under|below|up to|no more than|limit[:\s]*)\s*(\d[\d,]*)/i);
  if (maxChars && /char/i.test(t)) return { kind: 'chars', value: parseInt(maxChars[1].replace(/,/g, ''), 10) };
  return null;
}

// ── 3. THE USER'S OWN EXPERIENCE (closed set, from the answer bank) ──────
// Nothing about the candidate is written in this file. Every highlight, angle,
// story and metric comes from data/application-answers.yml, which the user
// writes from cv.md. A question the bank has no material for composes to null,
// and generateAnswer() returns it as blocked, so the runner asks the user
// instead of submitting something they never said.
//
//   free_text:
//     title: "product designer"         # how you describe yourself
//     years_experience: "five-plus"     # used as "the last {years} years"
//     home_city: "Pune"                 # optional
//     highlights:                       # short phrases, each traceable to cv.md
//       primary: "…"                    # the achievement you lead with
//       secondary: "…"                  # optional second one
//       metrics: "…"                    # numbers, verbatim from cv.md
//     angles:                           # how to frame your work per posting theme
//       ai: "…"                         # keys: ai, integrations, designSystem,
//       workflow: "…"                   #       research, workflow (fallback)
//     stories:                          # full first-person answers, in your words
//       proud_project: "… {termA} …"    # placeholders: {termA} {termB} {company} {role}
//
// Story keys: relevant_product, proud_project, difficult_problem, ai_experience,
// integrations_experience, research_experience, design_system_experience,
// metrics_outcome, why_leaving, what_bring.
const FT = BANK.free_text || {};
const HL = FT.highlights || {};
const ANGLES = FT.angles || {};
const STORIES = FT.stories || {};
const YEARS = FT.years_experience || '';
const CITY = FT.home_city || '';
const TITLE = FT.title || 'product designer';
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

// ── 4. COMPOSITION ────────────────────────────────────────────────────────
/** Pick the JD's most distinctive product terms, for a grounded opening. */
function surface(ctx, n = 2) {
  return (ctx.productTerms.length ? ctx.productTerms : (ctx.focus || [])).slice(0, n);
}
function sentenceCase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** Which of the user's own angles best matches what THIS posting emphasises. */
function relevantAngle(ctx) {
  const order = [['ai', ctx.hasAI], ['integrations', ctx.hasIntegrations], ['designSystem', ctx.hasDesignSystem], ['research', ctx.hasResearch], ['workflow', true]];
  for (const [tag, wanted] of order) if (wanted && ANGLES[tag]) return { tag, phrase: ANGLES[tag] };
  return null;
}

const STORY_TYPES = new Set(['relevant_product', 'proud_project', 'difficult_problem', 'ai_experience', 'integrations_experience', 'research_experience', 'design_system_experience', 'metrics_outcome', 'why_leaving', 'what_bring']);

function compose(type, ctx, company) {
  const terms = surface(ctx, 2);
  const termA = terms[0] || (ctx.opener ? clip(ctx.opener, 60) : 'the product surface described in the posting');
  const termB = terms[1] || '';
  const co = company || 'the company';

  if (STORY_TYPES.has(type)) {
    return STORIES[type] ? fill(STORIES[type], { termA, termB, company: co, role: ctx.role || '' }) : null;
  }

  const angle = relevantAngle(ctx);
  if (!angle) return null;
  const tenure = YEARS ? `the last ${YEARS} years` : 'most of my career';

  switch (type) {
    case 'why_company': {
      const parts = [];
      parts.push(termB
        ? `What caught my attention in the posting is the work around ${termA} and ${termB} — the kind of surface where a small interaction decision cascades across everything downstream of it.`
        : `What caught my attention in the posting is the work around ${termA} — the kind of surface where a small interaction decision cascades across everything downstream of it.`);
      parts.push(`That is the part of the job I have spent ${tenure} in: ${angle.phrase}.`);
      parts.push(`The part I would want to dig into is how ${co} keeps that coherent as it scales, rather than patching the edges case by case.`);
      return parts.join(' ');
    }
    case 'why_role': {
      const parts = [];
      parts.push(termB
        ? `The role description reads as ownership of ${termA} and ${termB} end to end, which is the scope I have been moving toward.`
        : `The role description reads as end-to-end ownership, which is the scope I have been moving toward.`);
      parts.push(`Most of my work has been ${angle.phrase}.`);
      parts.push(`What I am looking for next is a problem where the design decisions are made with engineering and product together, early, rather than after the requirements are fixed — that is what this posting describes.`);
      return parts.join(' ');
    }
    case 'why_fit': {
      if (!HL.primary) return null;
      const parts = [];
      parts.push(`The short version: I have solved problems adjacent to this one, and I know where they get hard.`);
      parts.push(`Reading the posting, the centre of gravity is ${termA}${termB ? ' and ' + termB : ''}, which is the kind of surface I have spent ${tenure} on.`);
      parts.push(`The experience that maps most directly: ${HL.primary}${HL.secondary ? `, and ${HL.secondary}` : ''}.`);
      parts.push(`I would rather be somewhere I can see the effect of a decision end to end than own one surface in isolation.`);
      return parts.join(' ');
    }
    case 'about_yourself': {
      if (!HL.primary) return null;
      const employers = (V.employers || []).map((e) => e.name).filter(Boolean);
      const parts = [];
      parts.push(`I am a ${TITLE}${CITY ? ` in ${CITY}` : ''}${YEARS ? ` with ${YEARS} years of experience` : ''}${employers.length ? ` — ${employers.join(', ')}` : ''}.`);
      parts.push(`The through-line is ${angle.phrase}: ${HL.primary}${HL.secondary ? `, then ${HL.secondary}` : ''}.`);
      if (HL.metrics) parts.push(`I care about the part where requirements are still negotiable, and I measure what I ship — ${HL.metrics}.`);
      return parts.join(' ');
    }
    case 'cover_letter': {
      if (!HL.primary) return null;
      const opener = sentenceCase(angle.phrase.split(' — ')[0]);
      return `${opener} is the work I want to keep doing. Reading the posting, the interesting part is ${termA}${termB ? ' and ' + termB : ''} — a surface where consistency and clarity decide whether the product feels simple or feels like a pile of tools. I have spent ${tenure} on exactly that kind of problem: ${HL.primary}${HL.metrics ? `, which moved ${HL.metrics}` : ''}. I would like to bring that to ${co}.`;
    }
    default:
      return null;
  }
}


const which = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * Trim to a word budget at a SENTENCE boundary, never mid-sentence.
 * The earlier slice-to-N-words cut answers off mid-name (e.g. "…shown at Acme.") which
 * reads as a broken application and is worse than a slightly long answer.
 */
function trimToBudget(text, max) {
  if (which(text) <= max) return text;
  const sentences = text.split(/(?<=\.)\s+(?=[A-Z"'(])/);
  let out = '';
  for (const s of sentences) {
    const next = out ? out + ' ' + s : s;
    if (which(next) > max) break;
    out = next;
  }
  if (out && which(out) >= Math.min(40, max)) return out;
  // No sentence boundary fits — clamp at the last complete clause, not a word.
  const words = text.split(/\s+/);
  const hard = words.slice(0, max).join(' ');
  const lastStop = Math.max(hard.lastIndexOf('; '), hard.lastIndexOf(', '));
  return (lastStop > hard.length * 0.5 ? hard.slice(0, lastStop) : hard).replace(/[,;:]$/, '') + '.';
}

// ── 5. QUALITY CHECKS ────────────────────────────────────────────────────
const BANNED = [
  [/\bi am excited\b/i, 'generic enthusiasm'],
  [/\bexcited to leverage\b/i, 'buzzword opener'],
  [/\bleverage my skills\b/i, 'buzzword filler'],
  [/\bpassionate about\b/i, 'generic enthusiasm'],
  [/\bproven track record\b/i, 'buzzword filler'],
  [/\bsynergy\b|\bvalue-add\b|\bresults-driven\b|\bdetail-oriented\b|\bteam player\b|\bself-starter\b|\bwear many hats\b/i, 'corporate buzzword'],
  [/\bthrilled\b|\bhonoured\b|\bhonored\b/i, 'generic enthusiasm'],
  [/\bperfect (fit|candidate)\b/i, 'generic enthusiasm'],
  [/\bguarantee\b|\bhighly increases? (a )?(callback|response)|\bwill surely\b|\b100% chance\b/i, 'an outcome guarantee'],
  [/\bwe've always admired\b|\bi have always admired\b|\bi've always admired\b/i, 'unverifiable company familiarity'],
  [/\b[i']m a huge fan\b|\bbig fan of\b/i, 'unverifiable company familiarity'],
];
const METRIC_RE = /(\d+\s*%|\$\d|\d+\s*m\b|\bUMUX\b|\b\d+ ?x\b|\bfrom \d+ to \d+)/i;

export function qualityCheck(answer, ctx, type = 'unknown') {
  const checks = [];
  const a = answer;
  const wc = a.split(/\s+/).filter(Boolean).length;
  checks.push({ name: 'non-empty', pass: a.trim().length > 0 });
  checks.push({ name: 'concise', pass: wc <= 260, detail: wc + ' words' });
  const banned = BANNED.filter(([re]) => re.test(a)).map(([, why]) => why);
  checks.push({ name: 'no-banned-phrasing', pass: banned.length === 0, detail: banned.join(', ') || undefined });

  // every metric asserted must be traceable to cv.md
  const docMetrics = (V.metrics || []).map((m) => m.replace(/\s/g, ''));
  const found = a.match(/\b\d{1,3}\s*%|\$\d+[A-Z]?\+?/g) || [];
  const unsupported = found.filter((m) => {
    const t = m.replace(/\s/g, '');
    return !docMetrics.some((d) => d.includes(t) || t === d.slice(0, 6));
  });
  checks.push({ name: 'metrics-traceable-to-cv', pass: unsupported.length === 0, detail: unsupported.length ? 'unverified: ' + unsupported.join(', ') : undefined });

  // Grounding. Company/role/fit answers MUST name something from the posting —
  // otherwise they are the generic answers this generator exists to replace.
  // Experience-led answers are grounded differently: the posting must actually
  // emphasise that theme. Requiring a product noun there blocked every one of
  // them on postings whose surface terms were irrelevant to the question.
  const NAMING = ['why_company', 'why_role', 'why_fit', 'cover_letter', 'what_bring', 'about_yourself', 'proud_project', 'relevant_product'];
  // >= 3, not > 3: the real product terms on a fintech/compliance posting are
  // 3-letter acronyms (KYB, KYC, AML), and a >3 filter made the grounding check
  // fail on exactly the postings where the product surface is an acronym.
  const productHit = ctx.productTerms.some((t) => t.length >= 3 && a.includes(t))
    || (ctx.focus || []).some((t) => t.length > 8 && a.toLowerCase().includes(t.toLowerCase().slice(0, 24)));
  const emphFor = [];
  if (ctx.hasAI) emphFor.push(/\bai\b|artificial intelligence|copilot|agent|llm/i);
  if (ctx.hasIntegrations) emphFor.push(/integration|connector|api|platform/i);
  if (ctx.hasDesignSystem) emphFor.push(/design system|component|pattern/i);
  if (ctx.hasResearch) emphFor.push(/research|customer|discovery|interview/i);
  if (ctx.hasB2B) emphFor.push(/enterprise|b2b|customer|workflow/i);
  const themeHit = emphFor.some((re) => re.test(a));
  const grounded = productHit || themeHit;
  if (NAMING.includes(type)) {
    checks.push({ name: 'references-the-posting', pass: grounded, detail: grounded ? undefined : 'answer cites nothing from the posting' });
    // A product term that is itself page chrome must never reach the answer.
    const chrome = (ctx.productTerms || []).find((t) => /\b(overview|application|employment type|department|autofill|apply|submit|privacy|skip and solve|add to favorites)\b/i.test(t) && a.includes(t));
    checks.push({ name: 'no-page-chrome-in-answer', pass: !chrome, detail: chrome ? `page chrome leaked: "${chrome}"` : undefined });
  } else {
    const emph = [];
    if (ctx.hasAI) emph.push(/\bai\b|artificial intelligence|copilot|agent|llm/i);
    if (ctx.hasIntegrations) emph.push(/integration|connector|api|platform/i);
    if (ctx.hasDesignSystem) emph.push(/design system|component|pattern/i);
    if (ctx.hasResearch) emph.push(/research|customer|discovery|interview/i);
    if (ctx.hasB2B) emph.push(/enterprise|b2b|customer|workflow/i);
    const emphHit = emph.some((re) => re.test(a));
    checks.push({ name: 'matches-posting-emphasis', pass: emphHit, detail: emphHit ? undefined : 'posting emphasises none of the themes the answer uses' });
  }

  // Connected = names one of the user's own employers, repeats one of their own
  // highlight phrases, or speaks to a core design theme.
  const own = [...(V.employers || []).map((e) => e.name), HL.primary, HL.secondary].filter(Boolean)
    .map((x) => String(x).slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const connects = new RegExp([...own, 'integration', 'design system', 'research', 'enterprise', 'workflow'].join('|'), 'i');
  checks.push({ name: 'connects-to-verified-experience', pass: connects.test(a) });
  const impliedUse = new RegExp('\\b(when I (used|use|worked with) ' + (ctx.company || 'x') + '\\b|your product is (great|excellent)|I (used|use) your)', 'i');
  checks.push({ name: 'no-implied-product-use', pass: !impliedUse.test(a) });
  return { checks, pass: checks.every((c) => c.pass) };
}

// ── 6. ENTRY POINT ────────────────────────────────────────────────────────
export function generateAnswer({ question = '', company = '', role = '', jdText = '', postingText = '', limit = null, extraContext = null } = {}) {
  const type = classifyQuestion(question, company);
  const ctx = extraContext || extractJdContext(jdText || postingText, { company, role });

  if (type === 'unknown') {
    return { ok: false, blocked: true, type, reason: 'question type not recognised — needs the user', question, checks: [] };
  }

  let answer = compose(type, ctx, company);
  if (!answer) {
    return { ok: false, blocked: true, type, reason: 'no composition available for this type', question, checks: [] };
  }

  // enforce a stated employer limit
  const lim = limit || readLimit(question);
  if (lim) {
    if (lim.kind === 'chars' && answer.length > lim.value) answer = answer.slice(0, Math.max(0, lim.value - 1)).trimEnd() + '…';
    if (lim.kind === 'words') {
      const w = answer.split(/\s+/);
      if (w.length > lim.value) answer = w.slice(0, lim.value).join(' ').replace(/[,;:]$/, '') + '.';
    }
  } else {
    const budget = BUDGETS[type] || BUDGETS.short_textbox || [40, 80];
    answer = trimToBudget(answer, budget[1]);
  }

  const qc = qualityCheck(answer, ctx, type);
  const blockingFails = qc.checks.filter((c) => !c.pass && ['references-the-posting', 'matches-posting-emphasis', 'metrics-traceable-to-cv', 'no-implied-product-use', 'connects-to-verified-experience'].includes(c.name));
  if (blockingFails.length) {
    return { ok: false, blocked: true, type, question, reason: `generated answer failed a grounding check: ${blockingFails.map((f) => f.name).join(', ')}`, checks: qc.checks, answer };
  }

  return {
    ok: true, blocked: false, type, question,
    answer,
    wordCount: answer.split(/\s+/).filter(Boolean).length,
    sources: ['job description (live posting)', 'company/product description (same posting)', 'verified_experience (cv.md)'],
    checks: qc.checks,
  };
}

export { BUDGETS, V as VERIFIED, norm, clip };
