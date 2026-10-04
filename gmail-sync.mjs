#!/usr/bin/env node
/**
 * gmail-sync.mjs — feed the Gmail "Jobs/*" label tracker into reply-watch.
 *
 * Gmail is read by Claude through its Gmail connector (no OAuth client here);
 * Claude saves the threads it fetched as JSON and this script does the rest:
 *
 *   import  normalise those threads into reply-watch's candidate shape and
 *           append them to data/reply-candidates.json (deduped by Gmail id).
 *   review  match candidates to tracker rows and classify them with
 *           reply-watch's own reply-matcher.mjs, then print the proposed status
 *           changes. Writes NOTHING. The user approves each change, which is then
 *           applied with set-status.mjs (the canonical tracker writer).
 *
 * The Gmail labels are hints, not verdicts: Jobs/Interview also catches
 * newsletters and job alerts, so classification always comes from the email
 * text. Only rows already in the tracker are proposed, and a proposal never
 * moves a row backwards (e.g. Interview → Responded).
 *
 * Usage:
 *   node gmail-sync.mjs import <threads.json> [...]
 *   node gmail-sync.mjs review [--json]
 *   node gmail-sync.mjs status          # last sync time + candidate count
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import path from 'path';
import { matchCandidates, classifyReply } from './reply-matcher.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CANDIDATES = 'data/reply-candidates.json';
const STATE = 'data/gmail-sync-state.json';
const TRACKER = 'data/applications.md';

// Forward-only lifecycle. Terminal outcomes (Rejected/Discarded/Hired) are
// proposed from any open state, and never replaced by an open one.
const RANK = { Evaluated: 0, Applied: 1, Responded: 2, Interview: 3, Offer: 4 };
const TERMINAL = new Set(['Rejected', 'Discarded', 'Hired', 'SKIP']);

const decode = (s) => String(s || '')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[͏​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, v) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2) + '\n'); renameSync(`${p}.tmp`, p); };

// The user's Gmail label ids, so the connector's raw labelIds read as names.
// Ids are per-account, so they live in the user layer, not here:
//   data/gmail-labels.json  →  { "Label_123…": "Jobs/Applied", … }
// Copy each id from the Gmail connector's list_labels output.
const LABEL_NAMES = readJson('data/gmail-labels.json', {});

// Unambiguous rejection wording that reply-matcher's keyword list misses.
const REJECTION_PHRASES = [
  'regret to inform', 'decided to proceed with another', 'decided to move forward with other',
  'not to move forward', 'not be moving forward', 'no longer moving forward', 'not moving forward with your application',
  'proceed with other candidates', 'pursue other candidates',
];

/**
 * reply-matcher's `signal` hint. Jobs/Rejected and Jobs/Offered are trusted as
 * hints (every proposal is still shown to the user with its evidence);
 * Jobs/Interview is NOT, because that label also catches newsletters and job
 * alerts, so interviews are only ever detected from the email text.
 */
export function signalFor(labels, text) {
  const t = text.toLowerCase();
  if (labels.includes('Jobs/Rejected') || REJECTION_PHRASES.some((p) => t.includes(p))) return 'rejection';
  if (labels.includes('Jobs/Offered')) return 'offer';
  return null;
}

/** Accepts the connector's search_threads shape ({threads:[{messages}]}) or a flat message array. */
export function toCandidates(input, labelNames = LABEL_NAMES) {
  const messages = Array.isArray(input) ? input
    : (input.threads || []).flatMap((t) => t.messages || []);
  return messages.map((m) => {
    const labels = (m.labels || m.labelIds || []).map((l) => labelNames[l] || l).filter((l) => l.startsWith('Jobs/'));
    const subject = decode(m.subject);
    const body = decode(m.snippet || m.body_snippet);
    return {
      message_id: `gmail:${m.id}`,
      thread_id: m.threadId || null,
      received_at: m.date || null,
      from: decode(m.sender || m.from),
      subject,
      body_snippet: body,
      signal: signalFor(labels, `${subject} ${body}`),
      gmail_labels: labels,
      source: 'gmail',
    };
  }).filter((c) => c.subject || c.body_snippet);
}

export function proposeChange(current, suggested) {
  if (!suggested || suggested === 'none' || suggested === 'Needs Review' || suggested === current) return false;
  if (TERMINAL.has(current)) return false;
  if (TERMINAL.has(suggested)) return true;
  return (RANK[suggested] ?? -1) > (RANK[current] ?? -1);
}

function loadApps() {
  if (!existsSync(TRACKER)) return [];
  const lines = readFileSync(TRACKER, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
}

export function review(candidates, apps) {
  const byId = new Map(candidates.map((c) => [c.message_id, c]));
  const proposals = [];
  const unmatched = { tracked: 0, untracked: 0, noise: 0 };
  for (const match of matchCandidates(candidates, apps)) {
    const cand = byId.get(match.message_id);
    const cls = classifyReply(cand);
    if (match.application_num === null) { unmatched.untracked++; continue; }
    const app = apps.find((a) => a.num === match.application_num);
    if (!app) continue;
    if (!proposeChange(app.status, cls.suggestedTrackerUpdate)) { unmatched.tracked++; continue; }
    proposals.push({
      row: app.num, company: app.company, role: app.role,
      from: app.status, to: cls.suggestedTrackerUpdate, type: cls.type,
      confidence: match.confidence, evidence: cls.evidence,
      email: { date: (cand.received_at || '').slice(0, 10), from: cand.from, subject: cand.subject, id: cand.message_id, labels: cand.gmail_labels || [] },
    });
  }
  // One proposal per row: the latest email wins; disagreeing emails are flagged.
  const perRow = new Map();
  for (const p of proposals.sort((a, b) => a.email.date.localeCompare(b.email.date))) {
    const prev = perRow.get(p.row);
    perRow.set(p.row, prev && prev.to !== p.to ? { ...p, conflict: `${prev.to} (${prev.email.date}) vs ${p.to}` } : p);
  }
  return { proposals: [...perRow.values()], skipped: unmatched };
}

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'import') {
    if (!rest.length) { console.error('usage: node gmail-sync.mjs import <threads.json> [...]'); process.exit(1); }
    const existing = readJson(CANDIDATES, []);
    const seen = new Set(existing.map((c) => c.message_id));
    let added = 0, newest = readJson(STATE, {}).newestMessageAt || '';
    for (const file of rest) {
      for (const c of toCandidates(JSON.parse(readFileSync(file, 'utf8')))) {
        if (c.received_at && c.received_at > newest) newest = c.received_at;
        if (seen.has(c.message_id)) continue;
        seen.add(c.message_id); existing.push(c); added++;
      }
    }
    writeJson(CANDIDATES, existing);
    writeJson(STATE, { lastSyncAt: new Date().toISOString(), newestMessageAt: newest });
    console.log(`imported ${added} new email(s) · ${existing.length} candidate(s) total · newest ${newest || 'n/a'}`);
  } else if (cmd === 'review') {
    const result = review(readJson(CANDIDATES, []), loadApps());
    if (rest.includes('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
    const { proposals, skipped } = result;
    console.log(`${proposals.length} proposed tracker update(s) — nothing written`);
    for (const p of proposals) {
      console.log(`\n  #${p.row} ${p.company} — ${p.role}\n    ${p.from} → ${p.to}  (${p.type}, match ${p.confidence})${p.conflict ? `  ⚠ conflicting emails: ${p.conflict}` : ''}`);
      console.log(`    ${p.email.date}  ${p.email.from}  [${p.email.labels.join(', ') || 'no Jobs label'}]\n    "${p.email.subject}"\n    evidence: ${p.evidence.join('; ') || 'n/a'}`);
      console.log(`    apply: node set-status.mjs --row ${p.row} ${p.to} --on ${p.email.date} --source reply-watch --note "gmail: ${p.email.subject.replace(/"/g, "'").slice(0, 80)}"`);
    }
    console.log(`\n  no change: ${skipped.tracked} email(s) for tracked rows · ${skipped.untracked} email(s) for jobs not in the tracker`);
  } else if (cmd === 'status') {
    const s = readJson(STATE, {});
    console.log(`last sync ${s.lastSyncAt || 'never'} · newest email ${s.newestMessageAt || 'n/a'} · ${readJson(CANDIDATES, []).length} candidate(s)`);
  } else {
    console.error('usage: node gmail-sync.mjs <import <threads.json>... | review [--json] | status>');
    process.exit(1);
  }
}
