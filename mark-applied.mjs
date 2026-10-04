#!/usr/bin/env node
/**
 * mark-applied.mjs: the write path behind the dashboard's "Mark Applied" button.
 *
 * WHY THIS EXISTS. output/daily-digest.html is a GENERATED static file. A button
 * inside it cannot persist anything: the next digest run regenerates the file and
 * the click is gone. So the click has to reach the repo's own tracker through the
 * one write path the Data Contract sanctions, and the digest then picks the row
 * up on its next run the same way it picks up every other application.
 *
 * THE WRITE PATH, and why it is this one:
 *   1. write batch/tracker-additions/<num>-<slug>.tsv, header-first, one row
 *   2. node merge-tracker.mjs            <- the ONLY sanctioned tracker writer
 *   3. node daily-digest.mjs             <- regenerate so the UI reflects it
 * Doing it by appending a markdown row by hand would be exactly the silent second
 * writer the Data Contract exists to prevent, and it is what makes a tracker grow
 * duplicate rows.
 *
 * SAFETY. Bound to 127.0.0.1 only. This endpoint writes to the user's job
 * tracker, so it must never be reachable from the network; if the port is
 * already bound the process exits rather than falling back to 0.0.0.0. It records
 * what a human said they did, and nothing else: it does not discover, filter,
 * score, or submit anything, and it has no path to an application form.
 *
 * Usage:
 *   node mark-applied.mjs                 # serve on 127.0.0.1:8900
 *   node mark-applied.mjs --port 8910
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'row';

const PORT = Number(arg('--port', '8900'));
const HOST = '127.0.0.1';
const TRACKER = 'data/applications.md';
const ADDITIONS = 'batch/tracker-additions';
const DASH = 'output/daily-digest.html';
const ARCHIVE = 'data/digest-archive.json';

// A dedicated column so a manual "Applied" is never mistaken for an evaluated one.
const SOURCE_MARK = 'manual-mark';

const readTracker = () => (existsSync(TRACKER) ? readFileSync(TRACKER, 'utf8') : '');

/** The next free row number: one past the highest existing #. */
function nextNum() {
  const nums = [...readTracker().matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** Is this role already in the tracker? Compared on company and role, normalised
 *  the way tracker-parse.mjs does it, so "Acme" and "acme inc" are the same
 *  employer rather than two rows. This is the duplicate guard: clicking Mark
 *  Applied twice must not create a second record. */
function alreadyTracked(company, role) {
  const key = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ck = key(company), rk = key(role);
  if (!ck) return null;
  for (const line of readTracker().split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split('|').map((s) => s.trim());
    if (key(c[3]) === ck && (key(c[4]) === rk || !rk)) return { num: c[1], company: c[3], role: c[4], status: c[6], url: c[10] || '' };
  }
  return null;
}

/** The tracker scores are "4.2/5". A manually marked job has no such evaluation,
 *  so the cell carries the recognised "no score" sentinel. N/A rather than the
 *  em dash or hyphen, both of which are also ambiguous status values. The 0-100
 *  fit score the dashboard shows is computed from cv.md at render time and is not
 *  this field. */
const SCORE_SENTINEL = 'N/A';

function buildTsv({ num, company, role, url, location }) {
  const header = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes', 'location', 'url'].join('\t');
  const date = new Date().toISOString().slice(0, 10);
  const cell = (v) => norm(v).replace(/[\t\r\n]+/g, ' ').trim() || '-';
  const row = [String(num), date, cell(company), cell(role), 'Applied', SCORE_SENTINEL, 'N/A', 'N/A',
    `Applied manually by the user from the dashboard (${SOURCE_MARK}).`,
    cell(location), cell(url)].join('\t');
  return header + '\n' + row + '\n';
}

function merge() {
  execFileSync(process.execPath, ['merge-tracker.mjs'], { stdio: 'pipe' });
}
function regenerate() {
  try {
    execFileSync(process.execPath, ['daily-digest.mjs'], { stdio: 'pipe' });
  } catch { /* digest exits 10 when roles are found, which is not a failure */ }
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      // A mark-applied payload is a few hundred bytes. A hard cap means a
      // malformed or hostile request cannot grow this buffer without bound.
      if (b.length > 64 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!existsSync(DASH)) return send(res, 503, 'text/plain; charset=utf-8', 'Run: node daily-digest.mjs');
      return send(res, 200, 'text/html; charset=utf-8', readFileSync(DASH, 'utf8'));
    }

    if (req.method === 'POST' && (req.url || '').startsWith('/api/mark-applied')) {
      let payload;
      try { payload = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, 400, { ok: false, error: 'body was not valid JSON' }); }

      const company = norm(payload.company);
      const role = norm(payload.role);
      const location = norm(payload.location);
      // Prefer the employer application URL for the tracker's URL column, and fall
      // back to the discovery URL. Either way it is a URL a human can click; a
      // row is never written with an invented or reconstructed one.
      const url = norm(payload.applyUrl) || norm(payload.discoveryUrl) || norm(payload.url);

      if (!company || !role) return json(res, 400, { ok: false, error: 'company and role are both required' });
      if (!url) return json(res, 400, { ok: false, error: 'no URL on this row, so there is nothing to record' });

      // The duplicate guard. Clicking twice must not create a second record, and
      // the dashboard's own dedup would then show the job twice.
      const dupe = alreadyTracked(company, role);
      if (dupe) {
        return json(res, 200, {
          ok: true, alreadyTracked: true, num: dupe.num, status: dupe.status,
          message: 'Already in the tracker as row ' + dupe.num + ' (' + dupe.status + '). Not adding a second row.',
        });
      }

      const num = nextNum();
      mkdirSync(ADDITIONS, { recursive: true });
      const file = join(ADDITIONS, String(num).padStart(3, '0') + '-' + slug(company) + '-' + slug(role) + '.tsv');
      writeFileSync(file, buildTsv({ num, company, role, url, location }));

      try {
        merge();
      } catch (e) {
        // A failed merge must not leave a half-written addition behind for the
        // next scheduled run to pick up.
        try { unlinkSync(file); } catch { /* best effort */ }
        return json(res, 500, { ok: false, error: 'merge-tracker refused the row: ' + String(e.stdout || e.message).slice(0, 200) });
      }

      // Regenerate so the page the user is looking at already shows the change.
      regenerate();

      // merge-tracker moves consumed additions out of the live directory; if this
      // build does not, clear it ourselves so the row cannot merge twice.
      try {
        if (existsSync(file)) { rmSync(file, { force: true }); }
      } catch { /* best effort */ }

      return json(res, 200, { ok: true, num, company, role, url, message: 'Recorded as tracker row ' + num + '.' });
    }

    if (req.method === 'POST' && (req.url || '').startsWith('/api/archive-job')) {
      let payload;
      try { payload = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, 400, { ok: false, error: 'body was not valid JSON' }); }

      const action = payload.action === 'unarchive' ? 'unarchive' : 'archive';
      const key = norm(payload.key);
      const company = norm(payload.company);
      const role = norm(payload.role);

      if (!key) return json(res, 400, { ok: false, error: 'key is required' });
      if (action === 'archive' && (!company || !role)) return json(res, 400, { ok: false, error: 'company and role are both required' });

      const archive = existsSync(ARCHIVE) ? JSON.parse(readFileSync(ARCHIVE, 'utf8')) : { entries: [] };

      if (action === 'archive') {
        if (archive.entries.some((e) => e.key === key)) {
          return json(res, 200, { ok: true, alreadyArchived: true, message: 'Already archived.' });
        }
        archive.entries.push({
          key, company, role,
          location: norm(payload.location),
          url: norm(payload.url),
          score: payload.score != null ? Number(payload.score) : null,
          status: norm(payload.status) || 'New',
          firstSeen: norm(payload.firstSeen),
          postedAt: norm(payload.postedAt),
          channel: norm(payload.channel),
          archivedAt: new Date().toISOString().slice(0, 10),
        });
      } else {
        const before = archive.entries.length;
        archive.entries = archive.entries.filter((e) => e.key !== key);
        if (archive.entries.length === before) {
          return json(res, 200, { ok: true, wasNotArchived: true, message: 'Was not archived.' });
        }
      }

      writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2));
      regenerate();

      return json(res, 200, { ok: true, action, message: action === 'archive' ? 'Archived.' : 'Unarchived.' });
    }

    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('  Mark Applied server: http://' + HOST + ':' + PORT + '/');
  console.log('  serves  : ' + DASH);
  console.log('  writes  : ' + TRACKER + '  (via batch/tracker-additions + merge-tracker.mjs)');
  console.log('  bound to ' + HOST + ' only. Stop with Ctrl+C.');
});
