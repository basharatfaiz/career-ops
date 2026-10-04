#!/usr/bin/env node
/**
 * daily-digest.mjs: the twice-daily job digest, with per-channel filtering.
 *
 * CHANNELS
 *   ats        roles found by the repo's own ATS scanners (Greenhouse, Lever,
 *              Ashby, Workday, iCAMS, BambooHR, …)
 *   rippling   roles from Rippling-hosted boards
 *   naukri     roles from Naukri
 *   manual     roles the user pasted in, or that a watched board supplied
 *
 * The last three are fed by data/manual-jobs.json, which is the seam for any
 * source this repo cannot read directly. See data/source-reachability.md for
 * the measured state of Rippling and Naukri: as of 2026-09-27 neither serves
 * an anonymous session, so those channels populate from that file rather than
 * pretending an automatic feed exists.
 *
 * Every role also gets a FIT score against the documented profile, so the
 * digest leads with the roles best suited to the CV rather than dumping a flat
 * list. The score is built ONLY from signals already in the repo: the title,
 * the location, and keyword overlap with cv.md. It never invents a reason.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';

const HIST = 'data/scan-history.tsv';
const STATE = 'data/digest-state.json';
const LEDGER = 'data/campaign-ledger.json';
const TRACKER = 'data/applications.md';
const MANUAL = 'data/manual-jobs.json';
const CV = 'cv.md';
const OUT_HTML = 'output/daily-digest.html';
const ARCHIVE = 'data/digest-archive.json';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const { classifyGeography, isApplicable } = await import('./geo-eligibility.mjs');

const TITLE_ACCEPT = /^\s*(?:(?:senior|sr\.?|junior|associate|principal|staff|lead|distinguished)\s+)?(?:(?:ai|ux|ui|product|interaction|service|visual|web|app|growth|full-stack|digital|mid|midweight)\s*(?:[\/&+,]\s*|-)?)*(?:product|ux|ui|ai)\s+designer\b/i;
const SENIORITY_BAD = /\b(principal|staff|lead|head of design|director|distinguished)\b/i;

/** The scanner stores board slugs ("acme", "globex-ai"), which read badly in
 *  a list a human is scanning. Turn a slug into a presentable name without
 *  inventing anything: split on separators, drop a trailing tenant digit, and
 *  title-case. A real name that already contains a space is left alone. */
function prettyCompany(s) {
  const v = norm(s);
  if (!v) return '(unknown)';
  if (/\s/.test(v)) return v;
  return v
    .replace(/\d+$/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^(ai|ux|ui|hr|it|sr|qa|api|crm|erp|payments?|fin|tech)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ') || v;
}

// ── profile signals, read from cv.md so the ranking tracks the real CV ────
const cvText = existsSync(CV) ? readFileSync(CV, 'utf8') : '';
const cvLow = ' ' + cvText.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ') + ' ';
const hasCv = (re) => re.test(cvLow);
// Weighted toward the things that have actually been asked for on this
// campaign: AI tooling, design systems, integrations, B2B/complex workflows.
const SIGNALS = [
  { re: /\bai\b|artificial intelligence|copilot|llm|agent|generative/, w: 3, label: 'AI' },
  { re: /design system/, w: 3, label: 'design systems' },
  { re: /integration|api|webhook|connector|platform/, w: 2, label: 'integrations' },
  { re: /b2b|saas|enterprise|admin|complex workflow|data-?heavy/, w: 2, label: 'B2B / complex UX' },
  { re: /0\s*(?:→|->|to)\s*1|zero to one|greenfield/, w: 2, label: '0→1' },
  { re: /user research|usability|discover/, w: 1, label: 'research' },
  { re: /fintech|payments|banking|wallet/, w: 2, label: 'fintech' },
  { re: /marketplace|ecommerce|e-?commerce/, w: 1, label: 'marketplace' },
  { re: /edtech|education|learning/, w: 1, label: 'edtech' },
  { re: /mobile|ios|android/, w: 1, label: 'mobile' },
];
// JD-side boosts: what the ROLE asks for, matched against what the CV proves.
const ROLE_BOOST = [
  { re: /\bai\b|copilot|llm|agent|generative|figma make|prompt/i, w: 4, label: 'asks for AI tooling' },
  { re: /design system/, w: 3, label: 'asks for design systems' },
  { re: /0\s*(?:→|->|to)\s*1|greenfield|early stage/, w: 2, label: '0→1 scope' },
  { re: /b2b|enterprise|admin|complex|platform/i, w: 2, label: 'platform / B2B' },
  { re: /fintech|payments|banking|wallet|trading/, w: 2, label: 'fintech domain' },
];

/** 0-100 fit score, plus the reasons. Never invents a reason: every label
 *  below is emitted only when the corresponding text actually matched. */
function fitScore(title, location, desc) {
  const blob = (' ' + (title + ' ' + location + ' ' + desc).toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ') + ' ');
  let score = 40, reasons = [];
  for (const s of SIGNALS) if (s.re.test(blob) && hasCv(s.re)) { score += s.w * 3; reasons.push('CV: ' + s.label); }
  for (const s of ROLE_BOOST) if (s.re.test(blob)) { score += s.w * 3; reasons.push('role: ' + s.label); }
  // Senior band is a genuine plus for a 5.8y CV; junior/lead is a hard negative.
  if (/senior|sr\.?\b/i.test(title)) { score += 6; reasons.push('senior band matches 5.8y'); }
  if (/\b(junior|associate|entry|graduate|intern)\b/i.test(title)) { score -= 30; reasons.push('junior band: weak fit'); }
  if (/lead|principal|staff|director|head/i.test(title)) { score -= 40; reasons.push('out of band'); }
  if (/ai|product designer|ux/i.test(title)) score += 4;
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons: [...new Set(reasons)].slice(0, 5) };
}

// ── inputs ────────────────────────────────────────────────────────────────
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { seenUrls: [] };
const appliedUrls = new Set();
if (existsSync(TRACKER)) for (const l of readFileSync(TRACKER, 'utf8').split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(l)) continue;
  const m = l.match(/https?:\/\/\S+/);
  if (m) appliedUrls.add(m[0].replace(/[.,;]$/, '').split('?')[0].toLowerCase());
}
const attempted = new Set();
if (existsSync(LEDGER)) for (const e of JSON.parse(readFileSync(LEDGER, 'utf8')).entries || []) if (e.url) attempted.add(e.url.split('?')[0].replace(/\/$/, '').toLowerCase());

// ── archive state: roles the user chose not to apply to ────────────────────
const archived = existsSync(ARCHIVE) ? JSON.parse(readFileSync(ARCHIVE, 'utf8')) : { entries: [] };
const archivedKeys = new Set((archived.entries || []).map((e) => e.key));

/** The seam for boards this repo cannot read. See data/source-reachability.md.
 *  Shape: [{channel, company, title, location, url, note}] where channel is one of
 *  rippling | naukri | manual. Anything here is gated exactly like ATS roles. */
const manualRaw = existsSync(MANUAL) ? JSON.parse(readFileSync(MANUAL, 'utf8')) : [];
const manual = Array.isArray(manualRaw) ? manualRaw : (manualRaw.jobs || []);

let jobs = [];
const seen = new Set(state.seenUrls || []);

// ATS channel
if (existsSync(HIST)) {
  const lines = readFileSync(HIST, 'utf8').split('\n').filter(Boolean);
  const H = lines[0].split('\t');
  for (const l of lines.slice(1)) {
    const c = l.split('\t'); const r = {}; H.forEach((h, i) => { r[h] = c[i]; });
    const u = (r.url || '').split('?')[0];
    if (!u || seen.has(u.toLowerCase())) continue;
    const title = norm(r.title);
    if (!TITLE_ACCEPT.test(title) || !/designer/i.test(title) || SENIORITY_BAD.test(title)) continue;
    if (appliedUrls.has(u.toLowerCase())) continue;
    const geo = classifyGeography({ title, postingText: '', url: r.url || '', primaryLocation: r.location || '' });
    if (!isApplicable(geo)) continue;
    let host = ''; try { host = new URL(r.url).hostname; } catch { /* keep empty */ }
    const fit = fitScore(title, r.location, '');
    // A LinkedIn row is a discovery signal, never an apply target, so it is
    // always flagged "needs you" and never auto-actionable.
    const fromLinkedin = /(^|\.)(linkedin\.com|[a-z]{2}\.linkedin\.com)$/i.test(host);
    jobs.push({ channel: fromLinkedin ? 'linkedin' : 'ats', company: prettyCompany(r.company), title, location: norm(r.location), url: r.url, posted: norm(r.posted_at), host, attempted: attempted.has(u.replace(/\/$/, '').toLowerCase()), gated: fromLinkedin || /myworkdayjobs|workable|recruitee/i.test(host), discoveryOnly: fromLinkedin, ...fit });
  }
}

// Rippling / Naukri / manual channels: gated identically, never trusted blind
for (const m of manual) {
  const ch = ['rippling', 'naukri', 'manual'].includes(m.channel) ? m.channel : 'manual';
  const title = norm(m.title);
  const geo = classifyGeography({ title, postingText: m.description || '', url: m.url || '', primaryLocation: m.location || '' });
  jobs.push({
    channel: ch, company: prettyCompany(m.company), title, location: norm(m.location), url: m.url,
    posted: norm(m.posted), host: (() => { try { return new URL(m.url).hostname; } catch { return ''; } })(),
    note: norm(m.note), gateReason: norm(m.gateReason),
    attempted: false, gated: true, eligible: isApplicable(geo), geoWhy: geo.rationale,
    ...fitScore(title, m.location, m.description || ''),
  });
}

jobs.sort((a, b) => b.score - a.score);
const strong = jobs.filter((j) => j.score >= 62);
const needsYou = jobs.filter((j) => j.gated || j.attempted);

// watermark
const allUrls = Array.from(new Set([...(state.seenUrls || []), ...jobs.map((j) => (j.url || '').split('?')[0])]));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(STATE, JSON.stringify({ lastRun: new Date().toISOString(), seenUrls: allUrls }, null, 2));
mkdirSync('data/digests', { recursive: true });
writeFileSync(`data/digests/${stamp}.json`, JSON.stringify({ generated: new Date().toISOString(), total: jobs.length, strong: strong.length, needsYou: needsYou.length, jobs }, null, 2));
appendFileSync('data/digest-log.tsv', [new Date().toISOString(), jobs.length, strong.length, needsYou.length, jobs.filter((j) => j.channel === 'rippling').length, jobs.filter((j) => j.channel === 'naukri').length].join('\t') + '\n');

// ── applied + history sources, for the job-history views ───────────────────
// Everything above this point is the EXISTING digest logic, untouched: the
// title gate, the geo gate, the fit score, the 20+80 cap, the watermark and the
// console line that daily-scan.sh parses. What follows only ADDS two read-only
// views over data the repo already owns.
//
// The tracker is parsed with the repo's own tracker-parse.mjs, not a third
// hand-rolled markdown reader: that module already owns column aliasing, the
// score/status transposition guard and the header detection, and a second
// parser is the exact drift this repo keeps paying for.
import { parseTrackerRow, isHeaderRow, isSeparatorRow, resolveColumns, LEGACY_COLMAP, normalizeTextKey } from './tracker-parse.mjs';
import { normalizeUrl } from './url-key.mjs';

// "CV used", resolved from what is actually on disk, in descending order of
// how much the record can be trusted. Nothing here is guessed:
//
//   1. the report's own `**PDF:**` line, which names the exact file submitted.
//      Only 1 of the 11 current reports carries one, so this is the strongest
//      signal but not the common one;
//   2. a tailored PDF in output/ whose name matches the employer. Matched on
//      the company key with a length floor and a uniqueness requirement, so a
//      short or ambiguous company resolves to "not recorded" instead of to
//      somebody else's CV;
//   3. the tracker's PDF cell, which says a CV was attached but not which one.
// Per-company copies are named "<your CV name> - <Company>.pdf"; the prefix is
// derived from the final CV's own filename in the answer bank, never hard-coded.
const CV_PREFIX = (() => {
  try {
    const bank = readFileSync('data/application-answers.yml', 'utf8');
    const p = bank.match(/^\s*final_path:\s*["']?([^"'\n]+)/m)?.[1] || '';
    const stem = p.split('/').pop().replace(/\.pdf$/i, '');
    return stem ? `${stem} - ` : null;
  } catch { return null; }
})();
const cvByStem = (() => {
  if (!CV_PREFIX || !existsSync('output')) return [];
  try {
    return readdirSync('output')
      .filter((f) => f.startsWith(CV_PREFIX) && f.toLowerCase().endsWith('.pdf'))
      .map((f) => ({ file: 'output/' + f, key: normalizeTextKey(f.slice(CV_PREFIX.length, -4)) }));
  } catch { return []; }
})();

function cvFromDisk(company) {
  const key = normalizeTextKey(company);
  if (key.length < 5) return null;
  const exact = cvByStem.find((c) => c.key === key);
  if (exact) return exact.file;
  const hits = cvByStem.filter((c) => c.key.startsWith(key));
  // Exactly one candidate, or it is ambiguous and we say nothing.
  return hits.length === 1 ? hits[0].file : null;
}

function readCvUsed(reportCell, company, pdfCell) {
  const m = String(reportCell || '').match(/\(([^)]+\.md)\)/);
  if (m) {
    const rel = m[1].replace(/^\.\.\//, '');
    const path = rel.startsWith('reports/') ? rel : 'reports/' + rel;
    if (existsSync(path)) {
      try {
        // The filename contains spaces, so \S+ can never match it. Capture to
        // the extension on the same line, then drop the leading tick and any
        // other non-path decoration.
        const head = readFileSync(path, 'utf8').slice(0, 4000);
        const pdf = head.match(/^\*\*PDF:\*\*[^\n]*?([^\n]*?\.pdf)/m);
        if (pdf) {
          const clean = pdf[1].replace(/^[^\w./-]+/, '').trim();
          if (clean) return clean;
        }
      } catch { /* fall through to the other sources */ }
    }
  }
  const onDisk = cvFromDisk(company);
  if (onDisk) return onDisk;
  return /✅/.test(String(pdfCell || '')) ? 'CV attached (file not named)' : '';
}

// A stable key for "the same role", used to attach a discovery URL to a tracker
// row and to stop the history view creating a second record for it. URL first,
// because two different employers can post the same title, and the same role
// can appear under two URLs.
const roleKey = (company, role) => normalizeTextKey(company) + '|' + normalizeTextKey(role);
const urlKey = (u) => { try { return normalizeUrl(u) || ''; } catch { return String(u || ''); } };

// Remove archived jobs from the active queue; they live in the Archived tab.
const isArchived = (j) => {
  const u = norm(j.url || '');
  if (u && archivedKeys.has(urlKey(u))) return true;
  return archivedKeys.has(roleKey(j.company, j.title));
};
jobs = jobs.filter((j) => !isArchived(j));

// ── applied rows, straight out of the tracker ─────────────────────────────
const applied = [];
if (existsSync(TRACKER)) {
  const tlines = readFileSync(TRACKER, 'utf8').split('\n');
  // Column positions come from the file's own header when it is recognisable,
  // so a tracker that gains or loses a column keeps parsing.
  const headerLine = tlines.find((l) => isHeaderRow(l) && /\|\s*(?:#|num)/i.test(l));
  const colmap = headerLine ? resolveColumns(tlines.filter((l) => !isSeparatorRow(l))) : LEGACY_COLMAP;
  for (const line of tlines) {
    const r = parseTrackerRow(line, colmap);
    if (!r) continue;
    // A row marked applied from the dashboard can carry the LinkedIn URL it was
    // found on. LinkedIn is discovery only (see the page footer), so that URL is
    // the row's Source link, never its Apply target.
    const trackerUrl = norm(r.url) || '';
    const urlIsDiscovery = /^https?:\/\/([a-z]{2,3}\.)?(linkedin|naukri|indeed|glassdoor)\./i.test(trackerUrl);
    applied.push({
      num: r.num,
      appliedAt: r.date,
      company: norm(r.company),
      title: norm(r.role),
      score: r.score,
      status: norm(r.status) || 'Unknown',
      pdf: r.pdf,
      report: r.report,
      notes: norm(r.notes),
      applyUrl: urlIsDiscovery ? '' : trackerUrl,
      discoveryUrl: urlIsDiscovery ? trackerUrl : '',
      cvUsed: readCvUsed(r.report, r.company, r.pdf),
      hasReport: /reports\/.+\.md/.test(String(r.report || '')),
    });
  }
}
applied.sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : a.appliedAt > b.appliedAt ? -1 : b.num - a.num));
const appliedByKey = new Map();
for (const a of applied) {
  if (a.applyUrl) appliedByKey.set(urlKey(a.applyUrl), a);
  const k = roleKey(a.company, a.title);
  if (!appliedByKey.has(k)) appliedByKey.set(k, a);
}

// ── all history: every role this repo has ever recorded, deduplicated ─────
// Three sources folded into one list, keyed URL-first then company|title, which
// is the same precedence the repo already uses for tracker dedup. A role that
// was discovered AND applied is ONE record here, carrying its applied status,
// because that is the whole point of a history view.
const historyByKey = new Map();
const put = (rec) => {
  const uk = rec.applyUrl ? urlKey(rec.applyUrl) : '';
  const rk = roleKey(rec.company, rec.title);
  const existing = (uk && historyByKey.get(uk)) || historyByKey.get(rk);
  if (existing) {
    // Merge rather than replace: keep whichever field is actually known.
    //
    // The COMPANY SPELLING is the one field where "keep the first" is wrong. A
    // scan-history row carries the board slug ("acme", "globexinc")
    // while the tracker carries the name a human wrote ("Acme", "Globex
    // Inc"). The tracker is the curated record, so on a merge the spelling
    // that reads like a company name wins, and the same employer stops appearing
    // as "Acme" in one tab and "acme" in the other.
    const richer = (a, b) => (/\s/.test(a) && !/\s/.test(b) ? a : b);
    if (existing.company && rec.company) existing.company = richer(existing.company, rec.company);
    existing.applyUrl ||= rec.applyUrl;
    existing.discoveryUrl ||= rec.discoveryUrl;
    existing.status = existing.status || rec.status;
    existing.appliedAt = existing.appliedAt || rec.appliedAt;
    existing.cvUsed = existing.cvUsed || rec.cvUsed;
    existing.score = existing.score ?? rec.score;
    existing.notes = existing.notes || rec.notes;
    existing.sources = [...new Set([...(existing.sources || []), ...(rec.sources || [])])];
    return existing;
  }
  const fresh = { ...rec, sources: rec.sources || [] };
  if (uk) historyByKey.set(uk, fresh);
  historyByKey.set(rk, fresh);
  return fresh;
};

// 1. everything in scan-history, including rows already shown in a past digest
//
// scan-history.tsv is the SCANNER'S RAW LOG, not a shortlist: it holds every
// posting every board ever returned, which is why an ungated read of it put
// "Senior/Staff Product Designer" in Germany, Bosnia, Norway and Portugal into a
// job-search console as if it were a role to pursue. The same title, seniority
// and India gates the New Jobs view already applies are applied here, for the
// same reason and with the same code. A row the user has APPLIED is always kept
// regardless, because the applied record is a fact about what happened and must
// not disappear because a gate changed since.
const inScopeForHistory = (title, location) => {
  if (!TITLE_ACCEPT.test(title) || !/designer/i.test(title) || SENIORITY_BAD.test(title)) return false;
  return isApplicable(classifyGeography({ title, postingText: '', url: '', primaryLocation: location }));
};

if (existsSync(HIST)) {
  const lines = readFileSync(HIST, 'utf8').split('\n').filter(Boolean);
  const H = lines[0].split('\t');
  for (const l of lines.slice(1)) {
    const c = l.split('\t'); const r = {}; H.forEach((h, i) => { r[h] = c[i]; });
    const u = norm(r.url);
    if (!u) continue;
    const company = norm(r.company);
    const title = norm(r.title);
    const ap = appliedByKey.get(urlKey(u)) || appliedByKey.get(roleKey(company, title));
    if (ap) {
      // Applied jobs live in the Applied tab, not history. Their discovery hit
      // still supplies the Source link and the location the tracker lacks; the
      // enrichment pass below can never see it once the row is skipped here.
      ap.discoveryUrl ||= u;
      ap.location ||= norm(r.location);
      continue;
    }
    if (!inScopeForHistory(title, norm(r.location))) continue;
    put({
      company, title, location: norm(r.location), discoveryUrl: u,
      applyUrl: ap?.applyUrl || '',
      firstSeen: norm(r.first_seen), postedAt: norm(r.posted_at),
      score: ap ? null : (fitScore(title, norm(r.location), '').score),
      status: ap ? ap.status : 'New', appliedAt: ap?.appliedAt || '',
      cvUsed: ap?.cvUsed || null, notes: ap?.notes || '',
      sources: [norm(r.portal) || 'scan'],
    });
  }
}
// A record is registered under BOTH its URL key and its company|title key, so
// collecting .values() naively yields the same object twice for every role that
// has an application URL. Set() collapses by object identity, which is exactly
// the right granularity here: two genuinely different roles are two different
// objects and both survive.
const history = [...new Set(historyByKey.values())].filter((h) => (h.company || h.title) && !isArchived(h));

// Enrich each applied row from its history twin. The tracker has no location
// column, but scan-history does, so the location is borrowed rather than shown as
// "not stated" when the very same role is sitting right there with one.
for (const a of applied) {
  const hit = history.find((h) => roleKey(h.company, h.title) === roleKey(a.company, a.title));
  if (!hit) continue;
  a.discoveryUrl = a.discoveryUrl || hit.discoveryUrl || '';
  a.location = a.location || hit.location || '';
}

// ── page ──────────────────────────────────────────────────────────────────
// Single chokepoint for everything the page displays, so escaping and
// punctuation normalisation cannot be forgotten on one field.
//
// The dash rule is about TYPOGRAPHY, not content. Job titles, company names and
// notes arrive verbatim from ATS boards and LinkedIn, and several of them use an
// em dash as a subtitle separator. Rewriting the character in the rendered
// string leaves the posting's meaning untouched while keeping the page
// typographically consistent, which also avoids the inconsistent-punctuation
// problems assistive tech reports with mixed dash characters. The underlying
// record in scan-history.tsv and the tracker is never touched: this runs on the
// way out to HTML only.
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  .replace(/\u2014/g, '-');
const byChannel = (c) => jobs.filter((j) => j.channel === c);
const LABEL = { ats: 'ATS boards', linkedin: 'LinkedIn', rippling: 'Rippling', naukri: 'Naukri', manual: 'Manual' };

// ── the 20 Top Fit + up to 80 broader cap ─────────────────────────────────
// Unchanged requirement and unchanged behaviour: the best 20 by fit score are
// shown first, then up to 80 more, and anything past that is COUNTED rather
// than silently dropped. Only the New Jobs view is capped, because it is the
// only one that is a per-scan work queue; Applied and History are complete by
// definition, and truncating a record of what was actually applied to would be
// the one truncation nobody would forgive.
const TOP_N = 20;
const BROADER_N = 80;
const ranked = [...jobs].sort((a, b) => b.score - a.score);
const topFit = ranked.slice(0, TOP_N);
const broader = ranked.slice(TOP_N, TOP_N + BROADER_N);
const overflow = Math.max(0, ranked.length - TOP_N - BROADER_N);
const shown = [...topFit, ...broader];

// Date formatting goes through Intl rather than a hand-rolled slice, so a
// timestamp from any source renders in the reader's locale instead of an
// ISO fragment with a chopped-off timezone.
const dtf = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const dtfShort = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
const fmtDate = (v) => {
  const s = norm(v);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return dtf.format(d);
};
const fmtDay = (v) => {
  const s = norm(v);
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : dtfShort.format(d);
};
const num = (n) => new Intl.NumberFormat('en-IN').format(n);
const fitTier = (s) => (s >= 62 ? 'hi' : s >= 50 ? 'mid' : 'lo');
// A status is only ever a word this repo actually recorded. Anything the
// tracker does not know about is shown verbatim rather than mapped to a guess.
const STATUS_TONE = {
  Applied: 'done', Hired: 'win', Offer: 'win', Interview: 'live', Responded: 'live',
  Evaluated: 'idle', Rejected: 'bad', Discarded: 'bad', SKIP: 'bad',
};
const tone = (s) => STATUS_TONE[norm(s)] || (norm(s) === 'New' ? 'new' : 'idle');

const srcChip = (s) => `<span class="chip" translate="no">${esc(s)}</span>`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Fit cell: a number you can compare down a column, plus a bar so the shape of
// the column is readable before you read a single digit. tabular-nums does the
// real work here; without it a column of two-digit scores jitters.
const fitCell = (s) => `<div class="fit"><span class="fitnum t-${fitTier(s)}">${esc(s)}</span><span class="fitbar" aria-hidden="true"><i class="t-${fitTier(s)}" style="width:${Math.max(2, Math.min(100, Number(s) || 0))}%"></i></span></div>`;

const reasons = (r) => (r?.reasons?.length ? `<ul class="why">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');

// The two link targets are kept distinct and separately labelled, because they
// answer different questions: where the role was FOUND, and where you APPLY.
// Two links only when they are genuinely two destinations. When the role was
// discovered on the employer's own board, the source IS the application page,
// and offering both would be two buttons for one intent, which is exactly the
// kind of duplicate CTA that reads as unconsidered.
// The Mark Applied control. It is NOT a status editor: it records one fact, that
// the user says they applied, and it posts that to mark-applied.mjs, which
// writes it through merge-tracker.mjs. The page is generated, so a click that
// only lived in the DOM would be erased by the next digest run; this is why the
// write path exists.
//
// A row already in the tracker renders as a settled, disabled control, so the
// button can never claim a job is applied when the tracker disagrees.
const markApplied = (r) => {
  const label = r.appliedAt ? 'Applied \u2713' : 'Mark Applied';
  if (r.appliedAt) {
    return `<button type="button" class="mk done" disabled aria-label="Recorded as applied on ${esc(fmtDate(r.appliedAt))}">${esc(label)}</button>`;
  }
  return `<button type="button" class="mk" data-company="${esc(r.company || '')}" data-role="${esc(r.title || '')}" data-location="${esc(r.location || '')}" data-discovery="${esc(r.discoveryUrl || r.url || '')}" data-apply="${esc(r.applyUrl || '')}">${esc(label)}</button>`;
};

// The Archive control. It moves a role out of the active views and into the
// Archived tab, so the user can keep a record of jobs they decided not to
// pursue without them cluttering the history. Like Mark Applied, it posts to
// a server endpoint because the page is generated and a DOM-only change would
// not survive the next digest run.
const archiveKey = (r) => {
  const u = norm(r.discoveryUrl || r.url || '');
  if (u) return urlKey(u);
  return roleKey(r.company, r.title);
};
const archiveBtn = (r) => {
  if (r.appliedAt || r.archived) return '';
  const key = archiveKey(r);
  return `<button type="button" class="arch" data-key="${esc(key)}" data-company="${esc(r.company || '')}" data-role="${esc(r.title || '')}" data-location="${esc(r.location || '')}" data-url="${esc(r.discoveryUrl || r.url || '')}" data-score="${esc(r.score ?? '')}" data-status="${esc(r.status || 'New')}" data-first-seen="${esc(r.firstSeen || '')}" data-posted-at="${esc(r.postedAt || '')}" data-channel="${esc(r.channel || '')}">Archive</button>`;
};
const unarchiveBtn = (r) => {
  if (!r.archived) return '';
  return `<button type="button" class="unarch" data-key="${esc(archiveKey(r))}">Unarchive</button>`;
};

const actions = (discovery, apply) => {
  const d = norm(discovery), a = norm(apply);
  const link = (href, cls, label, aria) => `<a class="lnk${cls ? ' ' + cls : ''}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(aria)} (opens in a new tab)">${esc(label)}</a>`;
  // Two links only when they are genuinely two destinations. Every other case
  // gets exactly one, because two buttons for one intent reads as unconsidered
  // and there is nothing for the second one to do.
  if (a && d && d !== a && urlKey(d) !== urlKey(a)) {
    return link(d, '', 'Source', 'Open the page this role was discovered on')
      + link(a, 'go', 'Apply', 'Open the employer application page');
  }
  if (a) return link(a, 'go', 'Open job', 'Open the employer job and application page');
  if (d) return link(d, '', 'Open job', 'Open the job page');
  return '<span class="none">no link</span>';
};

// ── the three job-history views ───────────────────────────────────────────
// One row shape for all three so the eye learns it once. Only the columns that
// are meaningful for a given view are filled in.
// p.note is a literal authored in this file, not user data, so it is emitted as
// markup (it contains <code> runs for file paths). Every USER-supplied string in
// a row still goes through esc().
const rowFor = (r) => {
  const cells = [];
  cells.push(`<td class="c-co"><span class="co">${esc(r.company || '(unknown)')}</span>${(r.sources || []).length ? `<span class="srcs">${r.sources.slice(0, 3).map(srcChip).join('')}</span>` : ''}</td>`);
  cells.push(`<td class="c-ti"><span class="ti">${esc(r.title || '(untitled)')}</span>${reasons(r)}${r.notes ? `<span class="note" title="${esc(r.notes)}">${esc(r.notes)}</span>` : ''}</td>`);
  cells.push(`<td class="c-lo" data-label="Location">${r.location ? esc(r.location) : '<span class="none">not stated</span>'}</td>`);
  cells.push(`<td class="c-sc" data-label="Fit">${r.score == null || r.score === '' ? '<span class="none">n/a</span>' : fitCell(Number(r.score))}</td>`);
  // The chip already carries the status word, so the date line leads with the date
  // and only says "Applied" when the recorded status is something else.
  const dateWord = /^applied$/i.test(norm(r.status)) ? '' : 'Applied ';
  cells.push(`<td class="c-st"><span class="st t-${tone(r.status)}">${esc(r.status || 'Unknown')}</span>${r.appliedAt ? `<span class="dt">${dateWord}${esc(fmtDate(r.appliedAt))}</span>` : ''}</td>`);
  // "<your CV name> - Acme.pdf" carries the same long prefix
  // on every row, so the constant prefix is stripped and the
  // employer tail is what actually identifies the file. The full path stays in
  // the title attribute for anyone who needs it.
  const cvName = r.cvUsed ? String(r.cvUsed).split('/').pop().replace(CV_PREFIX || /^$/, '') : '';
  cells.push(`<td class="c-cv" data-label="CV used">${r.cvUsed ? `<span class="cv" title="${esc(r.cvUsed)}">${esc(cvName)}</span>` : '<span class="none">none recorded</span>'}</td>`);
  const markable = r.markable === false ? '' : markApplied(r);
  const archivable = r.archived ? unarchiveBtn(r) : archiveBtn(r);
  cells.push(`<td class="c-go"><span class="acts">${actions(r.discoveryUrl || r.url || '', r.applyUrl || (r.discoveryOnly === false ? r.url : ''))}${markable}${archivable}</span></td>`);
  return `<tr tabindex="-1" data-hay="${esc(((r.company || '') + ' ' + (r.title || '') + ' ' + (r.location || '') + ' ' + (r.status || '')).toLowerCase())}" data-score="${esc(r.score ?? '')}" data-date="${esc(r.appliedAt || r.postedAt || r.firstSeen || '')}" data-status="${esc(tone(r.status))}" data-ch="${esc(r.channel || '')}">${cells.join('')}</tr>`;
};

const HEAD = `<thead><tr>
<th scope="col" class="c-co"><button type="button" data-sort="co">Company</button></th>
<th scope="col" class="c-ti"><button type="button" data-sort="ti">Role</button></th>
<th scope="col" class="c-lo">Location</th>
<th scope="col" class="c-sc"><button type="button" data-sort="sc" aria-label="Sort by fit score">Fit</button></th>
<th scope="col" class="c-st"><button type="button" data-sort="st">Status</button></th>
<th scope="col" class="c-cv">CV used</th>
<th scope="col" class="c-go"><span class="sr">Links</span></th>
</tr></thead>`;

// ── New Jobs Found: the existing gated queue, unchanged in content ────────
const newRows = shown.map((j) => rowFor({
  company: j.company, title: j.title, location: j.location, url: j.url,
  score: j.score, reasons: j.reasons, status: j.gated ? 'Needs you' : (j.attempted ? 'Attempted' : 'New'),
  sources: [j.channel], channel: j.channel, discoveryOnly: j.discoveryOnly,
}));

// ── Applied Jobs: the tracker, which is the persistent record ─────────────
// The tracker records a "4.2/5" evaluation when one happened. A row marked
// Applied from the dashboard has no such evaluation, and its cell carries the
// recognised "no score" sentinel rather than a number nobody assessed.
//
// The Fit column still has to show something real, so it falls back to the SAME
// measurement the New Jobs view shows for that role: fitScore() against cv.md,
// computed at render time from the title and the borrowed location. That is one
// measurement reused, not a second opinion and not an invented figure.
const trackerScoreToHundred = (raw) => {
  const m = String(raw || '').match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? Math.round(Number(m[1]) * 20) : null;
};

const appliedRows = applied.map((a) => rowFor({
  company: a.company, title: a.title, url: a.discoveryUrl || '', location: a.location || '',
  applyUrl: a.applyUrl,
  score: trackerScoreToHundred(a.score) ?? fitScore(a.title, a.location, '').score,
  status: a.status, appliedAt: a.appliedAt, cvUsed: a.cvUsed, notes: a.notes,
  sources: ['tracker'], channel: 'tracker',
}));

// ── All Jobs History: everything ever recorded, one row per role ──────────
const historyRows = history.map((h) => rowFor(h));

// ── Archived: roles the user chose not to apply to ───────────────────────
const archivedRows = (archived.entries || []).map((e) => rowFor({
  company: e.company, title: e.role || e.title, location: e.location || '',
  url: e.url || '', score: e.score, status: e.status || 'New',
  firstSeen: e.firstSeen || '', postedAt: e.postedAt || '',
  archived: true, sources: [e.channel || 'archived'],
}));

const CHANNELS = ['ats', 'linkedin', 'rippling', 'naukri', 'manual'];
// Applied rows come from the tracker, so they are their own source. History
// rows carry several sources at once, so a source filter cannot be applied to
// them honestly and the control is switched off on that tab.
const CHANNEL_FOR = { new: CHANNELS, applied: ['tracker'], history: [] };
const STATUSES = [...new Set([...applied.map((a) => a.status), 'New', 'Needs you', 'Attempted'])].filter(Boolean).sort();
const STATUS_FILTER = `<label class="fld"><span>Status</span><select id="f-status"><option value="">All</option>${STATUSES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></label>`;
const CHANNEL_FILTER = `<label class="fld" id="f-ch-wrap"><span>Source</span><select id="f-ch"><option value="">All</option>${[...CHANNELS, 'tracker'].map((c) => `<option value="${c}">${esc(LABEL[c] || 'Tracker')}</option>`).join('')}</select></label>`;

const PANES = {
  new: {
    id: 'new', label: 'New Jobs Found',
    count: newRows.length,
    note: `Top ${TOP_N} by fit plus up to ${BROADER_N} more${overflow ? `, ${overflow} further gated roles below the cut` : ''}. LinkedIn rows are discovery only: the measured direct-apply rate was 0%, so open the employer page before applying.`,
    empty: `<p class="empty-t">No new roles in scope.</p><p class="empty-s">The gates found nothing new since the last run. Check <code>data/scan-cron.log</code> if a scan was expected.</p>`,
    rows: newRows, head: HEAD,
  },
  applied: {
    id: 'applied', label: 'Applied Jobs',
    count: appliedRows.length,
    note: 'Read from <code>data/applications.md</code> on every run, so status, date applied and the CV used persist across regenerations.',
    empty: `<p class="empty-t">No applications recorded yet.</p><p class="empty-s">Rows appear here once <code>data/applications.md</code> has one, and they are never removed by regenerating this page.</p>`,
    rows: appliedRows, head: HEAD,
  },
  history: {
    id: 'history', label: 'All Jobs History',
    count: historyRows.length,
    note: 'Scan history and the campaign ledger folded into one record per role, keyed on the posting URL first and then company plus title. Applied jobs are excluded; they live in the Applied tab.',
    empty: `<p class="empty-t">No history yet.</p><p class="empty-s">Runs once a discovery pass has written to <code>data/scan-history.tsv</code>.</p>`,
    rows: historyRows, head: HEAD,
  },
  archived: {
    id: 'archived', label: 'Archived',
    count: archivedRows.length,
    note: 'Roles you chose not to apply to. Archived here so they stop appearing in the other views. Unarchive any row to move it back.',
    empty: `<p class="empty-t">Nothing archived yet.</p><p class="empty-s">Use the Archive button on any role to move it here.</p>`,
    rows: archivedRows, head: HEAD,
  },
};

const generatedAt = new Date();
const ageMin = Math.round((Date.now() - generatedAt.getTime()) / 60000);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101114" media="(prefers-color-scheme: dark)">
<title>Job Search Console</title>
<style>
/* ── tokens ──────────────────────────────────────────────────────────────
   One accent (blue, carried over from the existing dashboard so the tool keeps
   its own identity), one neutral ramp, and semantic colours for fit tiers and
   status. Radius rule for the whole page: controls are 6px, the table and the
   page frame are square. Nothing is rounded for decoration. */
:root{
  --bg:#fbfbfd; --surface:#fff; --surface-2:#f5f5f7; --surface-3:#eeeef1;
  --line:#e3e3e8; --line-2:#d5d5dc; --line-3:#c3c3cc;
  --tx:#16161a; --tx-2:#5c5c68; --tx-3:#8a8a96;
  --acc:#0b57d0; --acc-weak:#e8f0fd; --acc-tx:#0a4b8c;
  --hi-bg:#e4f4e8; --hi-tx:#12633a; --hi-bar:#1f9254;
  --mid-bg:#fdf1de; --mid-tx:#7d4a05; --mid-bar:#c07c12;
  --lo-bg:#eeeef1; --lo-tx:#5c5c68; --lo-bar:#9a9aa5;
  --new-bg:#eaf1fd; --new-tx:#0a4b8c;
  --live-bg:#e8f4f4; --live-tx:#0f5252;
  --bad-bg:#fdeceb; --bad-tx:#8f2a20;
  --win-bg:#e4f4e8; --win-tx:#12633a;
  --done-bg:#eef0f4; --done-tx:#3d4654;
  --focus:#0b57d0;
  --r:6px;
  --ff:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#101114; --surface:#17181c; --surface-2:#1e1f25; --surface-3:#26272e;
    --line:#282a31; --line-2:#33353d; --line-3:#43464f;
    --tx:#e9e9ed; --tx-2:#a3a5b0; --tx-3:#767986;
    --acc:#6ea8fe; --acc-weak:#16233a; --acc-tx:#a8c7fa;
    --hi-bg:#12261a; --hi-tx:#7fd3a1; --hi-bar:#2fae63;
    --mid-bg:#2a2113; --mid-tx:#e0b263; --mid-bar:#b9861f;
    --lo-bg:#23242a; --lo-tx:#a3a5b0; --lo-bar:#5d6069;
    --new-bg:#16233a; --new-tx:#a8c7fa;
    --live-bg:#12262a; --live-tx:#79c4c9;
    --bad-bg:#2b1614; --bad-tx:#e79a90;
    --win-bg:#12261a; --win-tx:#7fd3a1;
    --done-bg:#21232a; --done-tx:#b3b6c0;
    --focus:#6ea8fe;
  }
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--tx);font:400 14px/1.5 var(--ff);
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:8px;top:-60px;z-index:20;background:var(--surface);color:var(--tx);
  border:1px solid var(--line-2);border-radius:var(--r);padding:9px 14px;font-weight:600;text-decoration:none;
  transition:top .12s ease}
.skip:focus{top:8px}
:where(a,button,select,input,summary,[tabindex]):focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}

.wrap{max-width:1440px;margin:0 auto;padding:20px 20px 64px}

/* ── masthead ───────────────────────────────────────────────────────────── */
.top{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:baseline;justify-content:space-between;
  padding-bottom:14px;border-bottom:1px solid var(--line)}
h1{font-size:19px;font-weight:640;letter-spacing:-.015em;margin:0;text-wrap:balance}
.top .meta{color:var(--tx-3);font-size:12.5px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.top .meta code{font-family:var(--mono);font-size:11.5px}

/* ── metrics: a data strip, not a card grid ─────────────────────────────── */
.metrics{display:flex;flex-wrap:wrap;gap:0 28px;padding:14px 0 16px;border-bottom:1px solid var(--line)}
.metrics div{display:flex;flex-direction:column;gap:1px;min-width:74px}
.metrics b{font-size:19px;font-weight:640;letter-spacing:-.02em;line-height:1.2}
.metrics span{font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.07em}
.metrics .warn b{color:var(--mid-tx)}

/* ── tabs ───────────────────────────────────────────────────────────────── */
.tabs{display:flex;gap:2px;margin:16px 0 0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;
  color:var(--tx-2);font:inherit;font-size:13.5px;font-weight:520;padding:9px 13px;cursor:pointer;white-space:nowrap;
  display:inline-flex;gap:7px;align-items:baseline;transition:color .12s ease,border-color .12s ease}
.tabs button:hover{color:var(--tx)}
.tabs button[aria-selected="true"]{color:var(--tx);border-bottom-color:var(--acc);font-weight:600}
.tabs .n{font-size:11.5px;color:var(--tx-3);font-weight:500}
.tabs button[aria-selected="true"] .n{color:var(--acc)}

/* ── toolbar ────────────────────────────────────────────────────────────── */
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 0}
.fld{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--tx-2)}
.fld>span{color:var(--tx-3)}
select,input[type=search]{appearance:none;font:inherit;font-size:13px;color:var(--tx);background-color:var(--surface);
  border:1px solid var(--line-2);border-radius:var(--r);padding:6px 9px;min-width:0;transition:border-color .12s ease,background-color .12s ease}
select{padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
input[type=search]{min-width:260px;flex:0 1 320px}
input[type=search]::placeholder{color:var(--tx-3)}
select:hover,input[type=search]:hover{border-color:var(--line-3)}
.grow{flex:1 1 auto}
.notice{margin:0 0 14px;padding:8px 11px;font-size:12.5px;background:var(--hi-bg);color:var(--hi-tx);border-left:2px solid var(--hi-bar)}
.notice.good{background:var(--hi-bg);color:var(--hi-tx);border-left-color:var(--hi-bar)}
.notice.bad{background:var(--bad-bg);color:var(--bad-tx);border-left-color:#c2483c}
.mk.failed{color:var(--bad-tx);background:var(--bad-bg);border-color:transparent}
.count{font-size:12.5px;color:var(--tx-2);white-space:nowrap}
.count b{color:var(--tx);font-weight:600}
.btn-reset{font:inherit;font-size:12.5px;color:var(--tx-2);background:none;border:0;padding:4px 6px;cursor:pointer;
  text-decoration:underline;text-underline-offset:3px;border-radius:3px}
.btn-reset:hover{color:var(--tx)}

/* ── table ──────────────────────────────────────────────────────────────── */
.sect{margin:0 0 8px;color:var(--tx-2);font-size:12.5px;font-weight:600;letter-spacing:-.005em}
.tblwrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);table-layout:fixed}
.tbl thead th{position:sticky;top:0;z-index:2;background:var(--surface-2);text-align:left;
  font-size:11px;font-weight:600;color:var(--tx-2);text-transform:uppercase;letter-spacing:.06em;
  padding:0;border-bottom:1px solid var(--line-2);white-space:nowrap}
.tbl thead th button{appearance:none;background:none;border:0;font:inherit;color:inherit;text-transform:inherit;
  letter-spacing:inherit;padding:9px 12px;cursor:pointer;width:100%;text-align:left;display:inline-flex;gap:5px;align-items:center}
.tbl thead th button:hover{color:var(--tx)}
.tbl thead th button::after{content:"";width:0;height:0;opacity:0;transition:opacity .12s ease;
  border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor}
.tbl thead th[aria-sort] button::after{opacity:.85}
.tbl thead th[aria-sort="descending"] button::after{transform:rotate(180deg)}
.tbl thead th:not(:has(button)){padding:9px 12px}
/* Once discovery is running at full breadth a view can hold 100+ records, so the
   rows are given to the compositor with a reserved height. Browsers without
   content-visibility ignore both declarations and render exactly as before, so
   this cannot be the thing that breaks a table. */
.tbl tbody tr{border-bottom:1px solid var(--line);transition:background-color .1s ease;content-visibility:auto;contain-intrinsic-size:auto 4.25rem}
.tbl tbody tr:last-child{border-bottom:0}
.tbl tbody tr:hover{background:var(--surface-2)}
.tbl tbody tr:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.tbl td{padding:9px 12px;vertical-align:top;min-width:0;overflow-wrap:anywhere}
.c-co{width:16%}.c-ti{width:29%}.c-lo{width:17%}.c-sc{width:8%}.c-st{width:14%}.c-cv{width:10%}.c-go{width:7%}
.co{display:block;font-weight:600;letter-spacing:-.005em}
.srcs{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
.chip{font-size:10px;line-height:1.5;padding:1px 5px;border-radius:3px;background:var(--surface-3);color:var(--tx-2);white-space:nowrap}
.ti{display:block;font-weight:520}
.why{list-style:none;margin:3px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:3px 6px}
.why li{font-size:11px;color:var(--tx-3);white-space:nowrap}
.why li+li::before{content:"·";margin-right:6px;color:var(--line-3)}
.note{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;font-size:11.5px;color:var(--tx-3)}
@media (max-width:900px){.note{-webkit-line-clamp:4}}
.fit{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.fitnum{font-family:var(--mono);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.fitbar{display:block;width:46px;height:3px;background:var(--surface-3);border-radius:2px;overflow:hidden}
.fitbar i{display:block;height:100%}
.t-hi{color:var(--hi-tx)}.t-mid{color:var(--mid-tx)}.t-lo{color:var(--lo-tx)}
.fitbar .t-hi{background:var(--hi-bar)}.fitbar .t-mid{background:var(--mid-bar)}.fitbar .t-lo{background:var(--lo-bar)}
.st{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:3px;white-space:nowrap}
.st.t-new{background:var(--new-bg);color:var(--new-tx)}
.st.t-live{background:var(--live-bg);color:var(--live-tx)}
.st.t-win{background:var(--win-bg);color:var(--win-tx)}
.st.t-done{background:var(--done-bg);color:var(--done-tx)}
.st.t-bad{background:var(--bad-bg);color:var(--bad-tx)}
.st.t-idle{background:var(--surface-3);color:var(--tx-2)}
.dt{display:block;margin-top:3px;font-size:11px;color:var(--tx-3);white-space:nowrap}
.cv{display:block;font-family:var(--mono);font-size:11px;color:var(--tx-2);overflow-wrap:break-word}
.none{color:var(--tx-3);font-size:12px}
.c-go{text-align:right;width:7%}
.c-go .acts{display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:0}
.mk{appearance:none;font:inherit;font-size:11.5px;font-weight:560;color:var(--tx-2);background:var(--surface);
  border:1px solid var(--line-2);border-radius:var(--r);padding:3px 8px;margin:0;cursor:pointer;
  max-width:100%;transition:color .12s ease,border-color .12s ease,background-color .12s ease,transform .08s ease}
.mk:hover:not(:disabled){color:var(--tx);border-color:var(--line-3);background:var(--surface-2)}
.mk:active:not(:disabled){transform:translateY(1px)}
.mk[disabled],.mk.done{cursor:default;color:var(--hi-tx);background:var(--hi-bg);border-color:transparent}
.mk.busy{opacity:.6;pointer-events:none}
.arch,.unarch{appearance:none;font:inherit;font-size:11.5px;font-weight:560;color:var(--tx-2);background:var(--surface);
  border:1px solid var(--line-2);border-radius:var(--r);padding:3px 8px;margin:0;cursor:pointer;
  max-width:100%;transition:color .12s ease,border-color .12s ease,background-color .12s ease,transform .08s ease}
.arch:hover,.unarch:hover{color:var(--tx);border-color:var(--line-3);background:var(--surface-2)}
.arch:active,.unarch:active{transform:translateY(1px)}
.arch[disabled],.arch.done,.unarch[disabled],.unarch.done{cursor:default;color:var(--hi-tx);background:var(--hi-bg);border-color:transparent}
.arch.busy,.unarch.busy{opacity:.6;pointer-events:none}
.lnk{display:inline-block;font-size:12px;font-weight:560;color:var(--acc);text-decoration:none;
  padding:3px 7px;border-radius:3px;transition:background-color .12s ease,transform .08s ease}
.lnk+.lnk{margin-left:3px}
.lnk:hover{background:var(--acc-weak);text-decoration:underline;text-underline-offset:2px}
.lnk:active{transform:translateY(1px)}
.lnk.go{background:var(--acc);color:#fff}
.lnk.go:hover{filter:brightness(1.08);text-decoration:none}
@media (prefers-color-scheme:dark){.lnk.go{color:#0a1220}}

/* ── states ─────────────────────────────────────────────────────────────── */
.empty{padding:40px 20px;text-align:center;border:1px dashed var(--line-2);background:var(--surface)}
.empty-t{margin:0 0 4px;font-size:14px;font-weight:600}
.empty-s{margin:0;color:var(--tx-3);font-size:12.5px}
.warnbar{display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;padding:9px 12px;font-size:12.5px;
  background:var(--mid-bg);color:var(--mid-tx);border-left:2px solid var(--mid-bar)}
.notes{margin:22px 0 0;padding-top:14px;border-top:1px solid var(--line);color:var(--tx-3);font-size:12px}
.notes p{margin:0 0 5px;max-width:78ch}
code{font-family:var(--mono);font-size:11.5px;background:var(--surface-3);padding:1px 4px;border-radius:3px}
[hidden]{display:none !important}

/* ── responsive: the table becomes stacked records on a phone ──────────── */
@media (max-width:900px){
  .tbl,.tbl tbody,.tbl tr,.tbl td{display:block;width:auto}
  .tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .tbl tbody tr{border-bottom:1px solid var(--line-2);padding:10px 12px;position:relative}
  .tbl td{border:0;padding:2px 0}
  .c-go{text-align:left;padding-top:6px !important}
  .fit{flex-direction:row;align-items:center;gap:8px}
  /* The column headers are visually hidden above, so the stacked rows carry
     their own field labels. Without these, "not stated" and a bare number give
     the reader no idea which field they belong to. */
  .c-lo::before,.c-sc::before,.c-cv::before{content:attr(data-label);display:block;color:var(--tx-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:1px}
  .c-lo,.c-sc,.c-cv{font-size:12.5px}
  .dt{margin:2px 0 0;display:block}
}


/* Motion is limited to colour and a 1px press, and is switched off entirely
   for anyone who has asked their system to reduce it. */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important;animation-iteration-count:1 !important;scroll-behavior:auto !important}
}
@media (hover:hover){ .lnk:hover,.tbl tbody tr:hover{transition-duration:.12s} }
::selection{background:var(--acc-weak);color:var(--tx)}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to job list</a>
<div class="wrap">

<header class="top">
  <h1>Job Search Console</h1>
  <div class="meta">
    <span>Generated <time datetime="${generatedAt.toISOString()}">${esc(dtf.format(generatedAt))} ${esc(generatedAt.toTimeString().slice(0, 5))}</time> IST</span>
    <span aria-hidden="true">·</span>
    <span>Fit is measured against <code>cv.md</code></span>
  </div>
</header>

<div class="metrics">
  <div><b>${num(jobs.length)}</b><span>in scope</span></div>
  <div><b>${num(strong.length)}</b><span>strong fit</span></div>
  <div><b>${num(needsYou.length)}</b><span>need a human</span></div>
  <div><b>${num(applied.length)}</b><span>applied</span></div>
  <div><b>${num(history.length)}</b><span>in history</span></div>
  <div><b>${num(shown.length)}</b><span>shown (${TOP_N}+${BROADER_N})</span></div>
  ${overflow ? `<div class="warn"><b>${num(overflow)}</b><span>below the cut</span></div>` : ''}
</div>

${(applied.some((a) => a.status && !STATUS_TONE[norm(a.status)])) ? `<div class="warnbar" role="status"><span>Some tracker rows carry a status this page has no colour for. They are shown verbatim rather than guessed at: ${esc([...new Set(applied.filter((a) => a.status && !STATUS_TONE[norm(a.status)]).map((a) => a.status))].join(', '))}.</span></div>` : ''}

<nav class="tabs" role="tablist" aria-label="Job views">
${Object.values(PANES).map((p, i) => `<button type="button" role="tab" id="tab-${p.id}" aria-controls="pane-${p.id}" aria-selected="${i === 0 ? 'true' : 'false'}" tabindex="${i === 0 ? '0' : '-1'}" data-tab="${p.id}">${esc(p.label)} <span class="n">${num(p.count)}</span></button>`).join('\n')}
</nav>

<main id="main">
<div class="bar">
  <label class="fld"><span class="sr">Search jobs</span><input type="search" id="q" placeholder="Company, role, location" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>
  ${CHANNEL_FILTER}
  ${STATUS_FILTER}
  <button type="button" class="btn-reset" id="reset" hidden>Clear filters</button>
  <span class="grow"></span>
  <p class="count" id="count" role="status" aria-live="polite"></p>
</div>
<p class="notice" id="notice" role="status" aria-live="polite" hidden></p>

${Object.values(PANES).map((p, i) => `<section role="tabpanel" id="pane-${p.id}" aria-labelledby="tab-${p.id}" ${i === 0 ? '' : 'hidden'}>
  <h2 class="sr">${esc(p.label)}</h2>
  <p class="sect">${p.note}</p>
  <div class="tblwrap">
  ${p.rows.length ? `<table class="tbl" data-pane="${p.id}">${p.head}<tbody>${p.rows.join('')}</tbody></table>` : `<div class="empty">${p.empty}</div>`}
  </div>
</section>`).join('\n')}

<p class="notes">
  <p>Gates applied to every role: the title must anchor on a product-design title, Staff, Principal, Lead, Manager, Director and Head are rejected, India must be explicit in the posting, and already-applied URLs are excluded.</p>
  <p>Source and Apply are different links on purpose. Source is where the role was found; Apply is the employer's own page. LinkedIn is discovery only, measured at a 0% direct-apply rate, so an Apply link appears only once an employer page has been resolved.</p>
  <p>Rippling retired its public board host and Naukri serves no search to an anonymous session, both measured in <code>data/source-reachability.md</code>. Those channels fill from <code>data/manual-jobs.json</code>.</p>
</p>
</main>
</div>
<script>
(function(){
  "use strict";
  var TABS = ${JSON.stringify(Object.keys(PANES))};
  var CHANNEL_FOR = ${JSON.stringify(CHANNEL_FOR)};
  var LABEL = ${JSON.stringify(LABEL)};
  var q = document.getElementById('q');
  var fCh = document.getElementById('f-ch');
  var fSt = document.getElementById('f-status');
  var reset = document.getElementById('reset');
  var count = document.getElementById('count');
  var sortState = { key: 'sc', dir: 'desc' };

  function cell(tr, cls){
    var td = tr.querySelector('.' + cls);
    return td ? td.textContent.trim() : '';
  }
  function rows(){
    var pane = document.querySelector('section[role=tabpanel]:not([hidden])');
    return pane ? Array.prototype.slice.call(pane.querySelectorAll('tbody tr')) : [];
  }
  function visible(){
    var needle = q.value.trim().toLowerCase();
    var ch = fCh.value, st = fSt.value;
    return rows().filter(function(tr){
      if (needle && tr.dataset.hay.indexOf(needle) === -1) return false;
      if (ch && tr.dataset.ch !== ch) return false;
      if (st && cell(tr, 'c-st') !== st) return false;
      return true;
    });
  }
  function sort(list){
    var k = sortState.key, dir = sortState.dir === 'asc' ? 1 : -1;
    var get = {
      co:  function(tr){ return cell(tr, 'c-co').toLowerCase(); },
      ti:  function(tr){ return cell(tr, 'c-ti').toLowerCase(); },
      sc:  function(tr){ return parseFloat(tr.dataset.score); },
      st:  function(tr){ return cell(tr, 'c-st').toLowerCase(); },
    }[k] || function(tr){ return 0; };
    return list.sort(function(a, b){
      var x = get(a), y = get(b);
      if (typeof x === 'number' && isNaN(x)) x = -1;
      if (typeof y === 'number' && isNaN(y)) y = -1;
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return 0;
    });
  }
  function activeTab(){ var b = document.querySelector('[role=tab][aria-selected=true]'); return b ? b.dataset.tab : TABS[0]; }
  function syncChannelControl(){
    var allowed = CHANNEL_FOR[activeTab()] || [];
    var on = allowed.indexOf(fCh.value) !== -1;
    fCh.disabled = allowed.length === 0;
    fCh.parentNode.style.opacity = fCh.disabled ? '.5' : '';
    fCh.title = fCh.disabled ? 'Not applicable to this view' : '';
    if (!on) fCh.value = '';
  }
  function paint(){
    syncChannelControl();
    var pane = document.querySelector('section[role=tabpanel]:not([hidden])');
    var all = pane ? Array.prototype.slice.call(pane.querySelectorAll('tbody tr')) : [];
    var match = visible();
    // HIDE the non-matching rows first. This step is what makes the list actually
    // filter; without it the counter updates and the table does not move, which
    // reads as a search that is not working.
    all.forEach(function (tr) { tr.classList.toggle('hide', match.indexOf(tr) === -1); });
    // Then put the matches in sort order. Re-appending only touches the rows that
    // matched, so the hidden ones keep their position and unhide in place.
    var tb = pane && pane.querySelector('tbody');
    if (tb) sort(match).forEach(function (tr) { tb.appendChild(tr); });
    count.innerHTML = '<b>' + match.length + '</b> of ' + all.length + ' shown';
    reset.hidden = !(q.value || fCh.value || fSt.value);
    document.querySelectorAll('section[role=tabpanel]').forEach(function (s) {
      var isVisible = s.id === (pane && pane.id);
      var t = s.querySelector('table');
      var e = s.querySelector('.empty');
      if (t) t.hidden = !(isVisible && match.length);
      if (e) e.hidden = !(isVisible && !match.length);
    });
  }
  function sync(){
    var p = new URLSearchParams();
    var active = document.querySelector('[role=tab][aria-selected=true]');
    if (active && active.dataset.tab !== TABS[0]) p.set('tab', active.dataset.tab);
    if (q.value) p.set('q', q.value);
    if (fCh.value) p.set('src', fCh.value);
    if (fSt.value) p.set('status', fSt.value);
    if (sortState.key !== 'sc' || sortState.dir !== 'desc') { p.set('sort', sortState.key); p.set('dir', sortState.dir); }
    var url = location.pathname + (p.toString() ? '?' + p.toString() : '');
    history.replaceState(null, '', url);
  }

  function selectTab(name, focus){
    document.querySelectorAll('[role=tab]').forEach(function(b){
      var on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll('section[role=tabpanel]').forEach(function(s){
      s.hidden = s.id !== 'pane-' + name;
    });
    paint(); sync();
  }

  document.querySelector('.tabs').addEventListener('click', function(e){
    var b = e.target.closest('[role=tab]'); if (!b) return;
    selectTab(b.dataset.tab, false);
  });
  document.querySelector('.tabs').addEventListener('keydown', function(e){
    var tabs = TABS.slice();
    var i = tabs.indexOf(document.querySelector('[role=tab][aria-selected=true]').dataset.tab);
    var next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) { e.preventDefault(); selectTab(next, true); }
  });

  document.querySelectorAll('th button[data-sort]').forEach(function(b){
    b.addEventListener('click', function(){
      var k = b.dataset.sort;
      sortState = (sortState.key === k) ? { key: k, dir: sortState.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: (k === 'sc' ? 'desc' : 'asc') };
      document.querySelectorAll('th[data-sort]').forEach(function(th){ th.removeAttribute('aria-sort'); });
      b.closest('th').setAttribute('aria-sort', sortState.dir === 'asc' ? 'ascending' : 'descending');
      paint(); sync();
    });
  });
  var scTh = document.querySelector('th.c-sc');
  if (scTh) scTh.setAttribute('aria-sort', 'descending');

  [q, fCh, fSt].forEach(function(el){ el.addEventListener('input', function(){ paint(); sync(); }); el.addEventListener('change', function(){ paint(); sync(); }); });
  reset.addEventListener('click', function(){ q.value = ''; fCh.value = ''; fSt.value = ''; paint(); sync(); q.focus(); });

  // "/" focuses search from anywhere, Escape clears it. Neither fires while the
  // user is already typing in a field.
  document.addEventListener('keydown', function(e){
    var typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); q.focus(); q.select(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; paint(); sync(); }
  });
  // Arrow keys walk the rows of the visible pane without needing a pointer.
  document.addEventListener('keydown', function(e){
    if (!/^(ArrowDown|ArrowUp)$/.test(e.key)) return;
    var list = sort(visible()); if (!list.length) return;
    var i = list.indexOf(document.activeElement);
    var next = e.key === 'ArrowDown' ? list[Math.min(i + 1, list.length - 1)] : list[Math.max(i - 1, 0)];
    if (i === -1) next = list[0];
    e.preventDefault(); next.focus();
  });

  // ── Mark Applied ────────────────────────────────────────────────────────
  // Opened as a file:// page there is no server to receive the write, so every
  // click would fail. Say that plainly, once, up front, and disable the controls
  // rather than letting a click discover it.
  if (location.protocol === 'file:') {
    document.querySelectorAll('button.mk:not([disabled]), button.arch:not([disabled]), button.unarch:not([disabled])').forEach(function (b) {
      b.disabled = true;
      b.title = 'Needs the local server';
    });
    say('Opened as a file. Mark Applied and Archive need the write path: run  node mark-applied.mjs  and open http://127.0.0.1:8900/', 'bad');
  }

  // Posts to mark-applied.mjs, which writes the row through merge-tracker.mjs
  // and regenerates this page. The page is a generated artefact, so a click that
  // only mutated the DOM would not survive the next digest run; that is why this
  // is a real write and not a CSS class toggle.
  function say(msg, kind) {
    var n = document.getElementById('notice');
    if (!n) return;
    n.textContent = msg;
    n.className = 'notice' + (kind ? ' ' + kind : '');
    n.hidden = false;
  }
  function markError(b, msg) {
    b.classList.remove('busy');
    b.textContent = 'Not saved';
    b.disabled = false;
    b.classList.add('failed');
    // The reason goes in the page, not only in a tooltip. A button that just
    // says "Failed" gives the reader nothing to act on, which is exactly the
    // dead end that made this look like the feature was broken.
    say('Not saved: ' + msg, 'bad');
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button.mk');
    if (!b || b.disabled) return;
    var who = (b.dataset.company || '') + ': ' + (b.dataset.role || '');
    // Newline built from a char code, not a \\n escape, on purpose. This whole
    // script lives inside a TEMPLATE LITERAL, so a \\n written here is evaluated
    // into a REAL newline before it reaches the browser. A JS string literal
    // cannot span lines, so that broke the parse of the ENTIRE script block and
    // every handler on the page silently stopped working while the markup still
    // rendered. tests/digest-dashboard.test.mjs now parses the emitted script.
    var NL = String.fromCharCode(10);
    var msg = 'Mark this role as Applied?' + NL + NL + who + NL + NL + 'Record it as applied today. Use this only after you have actually applied.';
    if (!confirm(msg)) return;
    b.classList.add('busy');
    b.textContent = 'Saving\u2026';
    fetch('/api/mark-applied', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company: b.dataset.company, role: b.dataset.role, location: b.dataset.location,
        discoveryUrl: b.dataset.discovery, applyUrl: b.dataset.apply,
      }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        if (!r.ok || !r.body || r.body.ok !== true) {
          markError(b, (r.body && r.body.error) || 'the server refused the row');
          return;
        }
        // Settle the control immediately so the click visibly registers, then
        // reload so the Applied tab and the counts are rebuilt from the tracker
        // rather than patched in the DOM.
        b.textContent = 'Applied \u2713';
        b.classList.remove('busy');
        b.disabled = true;
        b.classList.add('done');
        b.title = r.body.message || 'Recorded.';
        say(r.body.message || 'Recorded.', 'good');
        setTimeout(function () { location.reload(); }, 650);
      })
      .catch(function (err) {
        // Almost always means the page was opened as a file:// URL, where there is
        // no server to receive the write. Say so instead of failing silently.
        markError(b, location.protocol === 'file:'
          ? 'Open the dashboard through: node mark-applied.mjs  (a file:// page has nowhere to save this)'
          : String(err && err.message || err));
      });
  });

  // ── Archive / Unarchive ─────────────────────────────────────────────────
  // Same pattern as Mark Applied: the page is generated, so the click has to
  // reach a server endpoint that persists the change and regenerates the page.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button.arch, button.unarch');
    if (!b || b.disabled) return;
    var isUnarchive = b.classList.contains('unarch');
    var who = (b.dataset.company || '') + ': ' + (b.dataset.role || '');
    var NL = String.fromCharCode(10);
    var msg = isUnarchive
      ? 'Move this role back to the active views?' + NL + NL + who
      : 'Archive this role?' + NL + NL + who + NL + NL + 'It will be moved to the Archived tab and stop appearing in the other views.';
    if (!confirm(msg)) return;
    b.classList.add('busy');
    b.textContent = 'Saving\u2026';
    fetch('/api/archive-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: isUnarchive ? 'unarchive' : 'archive',
        key: b.dataset.key,
        company: b.dataset.company,
        role: b.dataset.role,
        location: b.dataset.location,
        url: b.dataset.url,
        score: b.dataset.score,
        status: b.dataset.status,
      }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        if (!r.ok || !r.body || r.body.ok !== true) {
          markError(b, (r.body && r.body.error) || 'the server refused the change');
          return;
        }
        b.textContent = isUnarchive ? 'Unarchived \u2713' : 'Archived \u2713';
        b.classList.remove('busy');
        b.disabled = true;
        b.classList.add('done');
        say(r.body.message || (isUnarchive ? 'Unarchived.' : 'Archived.'), 'good');
        setTimeout(function () { location.reload(); }, 650);
      })
      .catch(function (err) {
        markError(b, location.protocol === 'file:'
          ? 'Open the dashboard through: node mark-applied.mjs  (a file:// page has nowhere to save this)'
          : String(err && err.message || err));
      });
  });

  // restore from the URL so a view is linkable and survives a reload
  var s = new URLSearchParams(location.search);
  if (s.get('q')) q.value = s.get('q');
  if (s.get('src')) fCh.value = s.get('src');
  if (s.get('status')) fSt.value = s.get('status');
  if (s.get('sort')) { sortState.key = s.get('sort'); sortState.dir = s.get('dir') === 'asc' ? 'asc' : 'desc'; }
  if (TABS.indexOf(s.get('tab')) !== -1) selectTab(s.get('tab'), false); else paint();
})();
</script>
</body>
</html>`;

mkdirSync('output', { recursive: true });
writeFileSync(OUT_HTML, html);

const rip = byChannel('rippling').length, nau = byChannel('naukri').length; const lin = byChannel('linkedin').length;
// The first six fields are the exact shape daily-scan.sh greps for. Anything
// after them is additive and safe to ignore.
console.log(`digest: ${jobs.length} in scope · ${strong.length} strong fit · ${needsYou.length} need a human · rippling ${rip} · naukri ${nau} · linkedin ${lin} · shown ${shown.length} (top ${TOP_N} + up to ${BROADER_N})${overflow ? ` · ${overflow} below the cut` : ''} · applied ${applied.length} · history ${history.length}`);
console.log(`  html : ${OUT_HTML}`);
if (jobs.length) { console.log('\nROLES (best fit first):'); for (const j of shown.slice(0, 25)) console.log(`  [${String(j.score).padStart(3)}] ${j.channel.padEnd(8)} ${j.company} - ${j.title}  [${j.location}]`); }
process.exit(jobs.length ? 10 : 0);
