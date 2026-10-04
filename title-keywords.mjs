// title-keywords.mjs — one definition of how a `title_filter` keyword matches a
// job title, imported by every path that filters titles.
//
// It lives in its own module because there are two such paths and they must not
// drift: scan.mjs (the main pipeline) and openrouter-runner.mjs (the no-Claude
// path, which deliberately does not import scan.mjs because scan.mjs creates
// data/ at import time). Same reason user-agent.mjs and profile-language.mjs
// are separate modules rather than exports of a bigger one.
//
// The repo has already paid for a mirror once: tests/profile-keywords-parity
// exists because web/ carries a copy of the keyword logic and the copy was
// wrong. A second copy of THIS logic would repeat that, so there is one.

// Opt-in whole-word matching for a keyword too long to get it automatically.
// Chosen over widening the 2-3 char rule to every single-word keyword, because
// the right-hand boundary is exactly what a NEGATIVE usually wants to keep:
// "crypto" is meant to catch "Cryptocurrency" and "fellows" to catch
// "Fellowship", and anchoring the whole list would silently stop both. So the
// list says which entries want it, one entry at a time.
//
// The prefix cannot collide with a real keyword: a job title never contains a
// colon-suffixed "word", and an entry is one keyword, not a sentence.
export const WORD_PREFIX = 'word:';

// `stem:` is the other half of the same question, and it exists because the two
// halves are NOT the same setting seen from two sides.
//
// `word:agent` says "agent, and nothing longer" — it rejects Agentforce.
// `stem:agent` says "a word that STARTS with agent" — it keeps Agentforce and
// Agentic, and drops Reagents, where the keyword lands mid-word.
// A bare `agent`, today's default, keeps all three.
//
// So a plain substring is not "the loose option"; it is two loosenesses at once,
// and only one of them is usually wanted. `stem:` lets an entry ask for the one
// it means. Under today's substring default that is already a narrowing rather
// than a no-op: it is what separates Agentforce from Reagents (#3103).
export const STEM_PREFIX = 'stem:';

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One definition of "inside a word", used by BOTH branches below. Anything else
// reintroduces, inside this module, exactly the drift the module exists to
// prevent: the acronym branch used ASCII \b while the `word:` branch had been
// made Unicode-aware, so `vp` still matched inside an accented word.
//
// String.raw, not a plain template literal: `\p` is not a recognised string
// escape, so an ordinary template drops the backslash and the class degenerates
// to the literal characters p, {, L, } — no error, and the anchor is simply off.
//
// Han, Hiragana, Katakana and Hangul are letters to \p{L}, but those scripts
// glue a Latin acronym straight onto the next word ("AI全栈工程师", "AIエンジニア",
// "AI엔지니어" — all "AI engineer"), so a CJK character next to a keyword is a
// word EDGE, not a continuation: `ai` must match them exactly as it matches
// "AI Engineer".
const WORD_CHAR = String.raw`(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{M}\p{N}_])`;
const anchoredPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u');
// Same left boundary, no right one: the keyword must start a word, and the word
// may continue past it.
const stemPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}`, 'u');

// `word:` and `stem:` mean the same thing wherever a keyword list is matched
// against text, so their handling lives here once rather than being copied into
// each compiler — the drift this module exists to prevent. Returns a matcher
// when `kw` carries a recognised prefix, or null when it is an ordinary keyword
// the caller compiles its own way (the title filter auto-anchors short
// acronyms and falls back to substring; the content filter goes straight to
// substring — see #3103, #3274).
//
// Explicit alphanumeric lookarounds rather than \b, because \b's meaning
// depends on the characters at the keyword's own edges: for `word:c++` a
// trailing \b would sit after "+" and assert the opposite of the intent.
// WORD_CHAR rather than [a-z0-9_]: an ASCII-only lookaround treats every
// accented letter as a separator, so `word:intern` matched inside "preintern"
// spelled with an accent and vetoed exactly the international titles this
// prefix exists to protect. \p{M} covers combining marks, so a decomposed "é"
// does not split a word either.
function compilePrefixedKeyword(kw) {
  if (kw.startsWith(WORD_PREFIX)) {
    const bare = kw.slice(WORD_PREFIX.length).trim();
    // A bare `word:` is a config typo. Matching NOTHING is the safe reading: as
    // a positive it simply contributes no match, while the alternative — an
    // empty pattern matching everything — would veto an entire scan from one
    // stray colon. Same trade as the "C++" note on scan.mjs's AND_SEPARATOR:
    // prefer a silent drop of one entry over a silent flood.
    if (!bare) return () => false;
    const re = anchoredPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  if (kw.startsWith(STEM_PREFIX)) {
    const bare = kw.slice(STEM_PREFIX.length).trim();
    // Same reading as a bare `word:`: a stray prefix with nothing after it is a
    // typo, and matching nothing is the safe half of that trade.
    if (!bare) return () => false;
    const re = stemPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  return null;
}

/**
 * Compile a lowercased keyword into a matcher.
 *
 * Short all-letter acronyms (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on WORD
 * BOUNDARIES so "COO" does not match "Coordinator". A `word:` prefix asks for
 * the same treatment explicitly, at any length: `word:intern` rejects
 * "Operations Intern" and leaves "Internal Tools" and "International
 * Partnerships Manager" alone. Multi-word phrases and keywords containing
 * non-letters (".NET", "SAP ", "L&D") keep fast, permissive substring matching.
 *
 * @param {string} kw - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
// Fold diacritics so a keyword and a title compare equal regardless of accents.
// Spanish/Portuguese boards routinely publish titles in UPPERCASE WITHOUT
// accents ("TECNICO CONTROL DE PRODUCCION") while portals.yml is written with
// them ("Producción"); with toLowerCase() alone they never match, and every
// such posting is silently counted as filtered_title. BOTH sides are folded,
// so the comparison stays symmetric.
// Not lib/ascii-fold.mjs: that one deletes everything outside [a-z0-9]
// (spaces, ".NET", "L&D"), and here those characters are part of the keyword.
export function foldAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function compileKeyword(kw) {
  const prefixed = compilePrefixedKeyword(kw);
  if (prefixed) return prefixed;
  if (/^[a-z]{2,3}$/.test(kw)) {
    // The same boundary as above, not \b: \b is ASCII-only, so "vp" matched
    // inside an accented word while `word:vp` did not. Two spellings of one
    // rule in one file is the drift this module was extracted to end.
    const re = anchoredPattern(kw);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

/**
 * Compile a lowercased `content_filter` keyword into a matcher.
 *
 * `content_filter` matches against the job DESCRIPTION, not the title, and its
 * default has always been a plain case-insensitive substring. That default is
 * why a bare negative `java` rejects every posting that merely mentions
 * "JavaScript", and `ios` rejects "curiosity" (#3274). Flipping the default is
 * a breaking change for every configured install — the same conclusion #3103
 * reached for `title_filter` — so the fix is opt-in: a `word:` or `stem:`
 * prefix asks for boundary-anchored matching on that one entry (identical
 * semantics to the title filter), and every other entry keeps the substring
 * behaviour byte-for-byte.
 *
 * Unlike compileKeyword(), there is no automatic anchoring of short keywords.
 * The title filter anchors 2-3 letter acronyms because "COO" inside
 * "Coordinator" is always wrong; a 2-3 letter run inside a paragraph of
 * description prose is routinely intended ("aws", "gcp", "sql", "go").
 *
 * @param {string} kw - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compileContentKeyword(kw) {
  return compilePrefixedKeyword(kw) ?? ((lower) => lower.includes(kw));
}

// An AND-group: " + " (whitespace-delimited) between terms means EVERY term
// must appear in the title, in any order. `title_filter.positive` is otherwise
// matched by compileKeyword — a plain substring, EXCEPT for a 2-3 letter
// keyword ("AI", "ML", "VP") or a `word:`-prefixed one, both of which are
// anchored so they cannot hit inside another word. Either way an entry
// expresses one exact spelling and nothing else, and real titles vary in
// separator and word order:
//
//   "Director of Engineering" misses  Director - Software Engineering
//                                     Director Engineering (Mobile Platform)
//                                     Senior Director, Platform Engineering
//
// The combinations are {level} x {, - of none} x {optional domain word}: no
// hand-maintained list of literal spellings converges, and every miss is
// silent — the summary reports one "filtered by title" count that cannot tell
// a well-tuned filter from a leaking one (#2544).
//
// The separator REQUIRES surrounding whitespace on purpose. A bare split('+')
// would turn the perfectly ordinary keyword "C++" into "c", which matches
// almost every title — trading a silent drop for a silent flood.
// Exported because a caller that must reason about the TERMS of a group — the
// dead-positive guard in tests/title-filter-word-prefix.test.mjs — has to split
// them exactly as this file does, and a second copy of the rule is the drift
// this module was extracted to end.
export const AND_SEPARATOR = /\s+\+\s+/;

// ── the title normalizer ──────────────────────────────────────────────────
// Why it exists. `title_filter.positive` is a literal substring match, and real
// titles spell the SAME role in several ways. Measured on 168 titles from one
// live discovery run, one product-design role surfaced as all of:
//   "Product Designer" · "Senior Product Designer" · "Sr. Product Designer" ·
//   "Product Designer II" · "Product/ UX Designer" · "Product UX Designer" ·
//   "UX/Product Designer" · "Senior Product Design"
// A literal list has to enumerate every combination of separator and word order,
// and every spelling it omits is dropped in SILENCE: the scan summary reports a
// single lower "filtered by title" number, which reads exactly like a quiet
// week on the boards (#2544). So the reach is widened by canonicalising BOTH
// sides rather than by growing the list with near-duplicate entries.
//
// Three rules, all order- or spelling-insensitive:
//
//   1. Separators collapse. "/", "-", "_", ",", "&", "." and any whitespace run
//      become one space, so "Sr. Product Designer" and "Sr Product Designer"
//      are the same string.
//   2. A seniority modifier is dropped from the cluster. THE SENIORITY GATE IS
//      NOT HERE: it lives in `negative`, which still matches the raw title, so
//      this cannot let a Staff, Principal, Lead, Head, Director, VP or Manager
//      title through. Dropping the modifier is what keeps "Senior Product
//      Designer II" matching the "Product Designer II" positive, which it would
//      otherwise stop doing the moment a prefix appeared.
//   3. The cluster before the head noun is sorted, so word order stops
//      mattering. {product, ux} and {ux, product} canonicalise identically,
//      which is what makes "Product/ UX Designer" reachable from the EXISTING
//      "UX/Product Designer" entry without adding a spelling that says the same
//      thing twice.
//
// The head noun gets one extra rule: a role written as the NOUN ("Product
// Design" rather than "Product Designer") is rewritten to the agent form, but
// ONLY when the title ends on it and carries no veto token. Both guards are
// load-bearing. Without them this is a flood rather than a fix, because
// "Engineer II Product Design" (Copeland) and "Engineer - Technical Product
// Design" (Eaton) also end on the noun, and "Director, Product Design" is a
// seniority exclusion that would otherwise acquire a matching positive.
//
// NEGATIVES ARE NOT NORMALISED. They keep matching the raw lowercased title, so
// the discipline gate is byte-identical to before this change and a Graphic,
// Visual, Brand, Marketing, Motion, Art Direction, Packaging or physical-design
// title is rejected exactly as it was. Only the positive side is canonicalised.
const SENIORITY_MODIFIER = new Set(['senior', 'sr', 'snr']);

// Two independent reasons to refuse the noun rewrite: a seniority or
// management word, or an engineering or physical-design word. Either one means
// the title is not the plain agent-form role the rewrite is recovering.
const NOUN_REWRITE_VETO = new Set([
  'staff', 'principal', 'lead', 'head', 'director', 'vp', 'manager', 'chief',
  'associate', 'junior', 'intern', 'internship', 'graduate', 'entry',
  'engineer', 'engineering', 'mechanical', 'electrical', 'software', 'firmware',
  'embedded', 'cad', 'cae', 'plc', 'architect',
]);

// Which heads may carry the bare noun: "Product Design", "UX Design",
// "UI Design". A bare "Design" is NOT in here, so "Senior Design" and
// "Creative Design" are untouched.
const NOUN_REWRITE_HEADS = new Set(['product', 'ux', 'ui']);

/**
 * Canonical form of a job title, for POSITIVE matching only.
 *
 * Exported so a caller that has to reason about what the normaliser does (the
 * recall corpus, the coverage tests) uses this exact function rather than
 * re-deriving the rules, which is the drift this module exists to prevent.
 *
 * @param {string} raw
 * @returns {string}
 */
export function canonicalizeTitle(raw) {
  const text = foldAccents(String(raw ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!text) return '';
  let tokens = text.split(' ').filter(Boolean);

  // Rule 2. Done before the veto check on purpose: "Senior Staff Product
  // Design" must still be seen as carrying "staff" once "senior" is gone.
  tokens = tokens.filter((t) => !SENIORITY_MODIFIER.has(t));

  // Head-noun rule. Guarded twice: the noun must be the FINAL token, and the
  // token before it must be a recognised head, so "Product Design Engineer" and
  // "Engineer II Product Design" are both left alone.
  const last = tokens.length - 1;
  if (
    last > 0 && tokens[last] === 'design' && NOUN_REWRITE_HEADS.has(tokens[last - 1])
    && !tokens.some((t) => NOUN_REWRITE_VETO.has(t))
  ) tokens[last] = 'designer';

  // Rule 3. Only the cluster BEFORE the head is sorted. Tokens after it are a
  // suffix (a roman numeral, a quarter tag, a requisition code) and keep their
  // order, so "Product Designer II" does not collapse into "II Product
  // Designer" and lose the numeral suffix the positives rely on.
  const head = tokens.lastIndexOf('designer');
  if (head > 0) {
    tokens = [...tokens.slice(0, head).sort(), 'designer', ...tokens.slice(head + 1)];
  }
  return tokens.join(' ');
}

/** Split a possibly-prefixed keyword into [prefix, bare].
 *
 *  The canonicaliser rewrites every non-alphanumeric run to a space, so running
 *  it over a RAW entry would turn "word:solana" into the two words "word
 *  solana" and the prefix would silently stop meaning anything. That is not a
 *  cosmetic loss: `word:` is the whole reason "word:intern" rejects "Operations
 *  Intern" while leaving "International Partnerships" alone, so losing it turns
 *  a boundary-anchored veto into a substring flood. The prefix is therefore
 *  split off, only the bare part is canonicalised, and the prefix is reattached
 *  for compileKeyword() to route back through compilePrefixedKeyword().
 *
 *  @param {string} kw
 *  @returns {[string, string]}
 */
function splitPrefix(kw) {
  if (kw.startsWith(WORD_PREFIX)) return [WORD_PREFIX, kw.slice(WORD_PREFIX.length)];
  if (kw.startsWith(STEM_PREFIX)) return [STEM_PREFIX, kw.slice(STEM_PREFIX.length)];
  return ['', kw];
}

/** Canonicalise one config entry, preserving a `word:` / `stem:` prefix. */
function canonicalizeEntry(kw) {
  const [prefix, bare] = splitPrefix(String(kw).trim());
  return prefix + canonicalizeTitle(bare);
}

/**
 * Compile one `positive` entry into a matcher, canonicalising it first.
 *
 * An AND-group is split BEFORE canonicalisation, because the canonicaliser
 * rewrites "+" to a space and would silently fuse "a + b" into the single
 * phrase "a b" (and "product designer ii" then matches "product designer iii"
 * by plain prefix). Each term is canonicalised and compiled by the existing
 * rule, so a short term like "vp" is still matched on a word boundary and a
 * `word:` term keeps its anchoring.
 *
 * @param {string} keyword - the raw entry from config, any case.
 * @returns {(canon: string) => boolean}
 */
export function compilePositiveEntry(keyword) {
  const kw = String(keyword).trim();
  if (!AND_SEPARATOR.test(kw)) return compilePositiveKeyword(canonicalizeEntry(kw));
  const terms = kw.split(AND_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return compilePositiveKeyword(canonicalizeEntry(kw));
  const matchers = terms.map((t) => compilePositiveKeyword(canonicalizeEntry(t)));
  return (canon) => matchers.every((m) => m(canon));
}

/**
 * Compile one `positive` entry into a matcher.
 *
 * Entries without " + " keep their exact previous behaviour, so existing
 * configs are unaffected.
 *
 * @param {string} keyword - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compilePositiveKeyword(keyword) {
  if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
  const terms = keyword.split(AND_SEPARATOR).map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileKeyword(keyword);
  // Each term keeps compileKeyword's own rule, so a short term like "vp" is
  // still matched on a word boundary and cannot hit "vp" inside another word.
  const matchers = terms.map(compileKeyword);
  return (lower) => matchers.every(m => m(lower));
}

/**
 * Compile a whole `title_filter` into one predicate.
 *
 * This lives here, rather than in scan.mjs beside its main caller, because
 * openrouter-runner.mjs filters titles too and cannot import scan.mjs. It used
 * to keep a second implementation, and the two had drifted in three separate
 * ways: an empty positive list meant "accept everything" here and "reject
 * everything" there, AND-groups worked only here, and a non-string YAML entry
 * was dropped here but coerced into a real keyword there. One shared predicate
 * removes the class rather than those three instances.
 *
 * @param {{positive?: unknown, negative?: unknown}} [titleFilter]
 * @returns {(title: string) => boolean}
 */
export function buildTitleFilter(titleFilter) {
  // Normalize defensively: a malformed title_filter (a null, numeric, or otherwise
  // non-string entry in the YAML) must not crash the scan via k.toLowerCase().
  // The POSITIVE list is canonicalised, because that is the side the title
  // normaliser exists for. The NEGATIVE list is folded and lowercased only, so
  // every veto still matches the raw title exactly as it did before the
  // normaliser existed. That asymmetry is the whole safety argument: widening
  // what is accepted cannot weaken what is rejected.
  const normalize = (arr, prepare, compile) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(prepare)
    .filter(k => k.length > 0)
    .map(compile);
  const lowerCase = (k) => foldAccents(k.trim().toLowerCase());
  // AND-groups are a POSITIVE-side feature only. On the negative side an entry
  // is a veto, and " + " there would read as "reject when both appear", which
  // is a different and much easier thing to write as two entries.
  //
  // The positive list is prepared with a TRIM ONLY, not with canonicalizeTitle.
  // That is deliberate and load-bearing: the canonicaliser rewrites "+" to a
  // space, so preparing here would fuse "Product Designer + II" into the single
  // literal phrase "product designer ii", which then also matches "Product
  // Designer iii" by plain prefix. compilePositiveEntry does the canonicalising,
  // and it does so per term AFTER the AND split, which is the only order in
  // which the group still means a group.
  const positive = normalize(titleFilter?.positive, (k) => k.trim(), compilePositiveEntry);
  const negative = normalize(titleFilter?.negative, lowerCase, compileKeyword);

  return (title) => {
    // String(), not `title || ''`: openrouter-runner used String(title ?? '')
    // before both paths were merged here, and scan.mjs threw on a truthy
    // non-string. Consolidating on scan.mjs's version would have carried that
    // throw onto a path that never had it, where it aborts jobs.filter and
    // drops a whole company's results for one malformed title.
    const lower = foldAccents(String(title ?? '').toLowerCase());
    // An empty positive list is "no positive constraint", not "match nothing":
    // a negative-only title_filter is a legitimate config that rejects a few
    // roles and keeps the rest.
    const hasPositive = positive.length === 0 || positive.some(m => m(canonicalizeTitle(title)));
    const hasNegative = negative.some(m => m(lower));
    return hasPositive && !hasNegative;
  };
}
