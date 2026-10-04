#!/bin/bash
# daily-scan.sh — one scheduled discovery + digest pass.
#
# Schedule it yourself (launchd on macOS, cron on Linux) — see
# docs/EXTRAS.md for a ready-made launchd plist. Twice a day works well.
# Set CAREER_OPS_TZ to log in your own timezone (default: the system's).
#
# Deliberately does NOT auto-submit. It discovers, gates, digests and notifies.
# Submission stays a human-authorised step, because a CAPTCHA, a Workday login
# wall or a genuinely unknowable personal question has to stop at a person, and
# because the user reviews anything gated before it goes out under their name.
#
# Logs to data/scan-cron.log (rotated by the launchd job's stdout).

set -uo pipefail
# This script lives at the REPO ROOT, so the working directory is its own
# directory — not its parent. Using "$(dirname "$0")/.." sent every relative
# path (data/, output/) to the parent, which is the user's home directory.
cd "$(dirname "$0")" || exit 1
[ -n "${CAREER_OPS_TZ:-}" ] && export TZ="$CAREER_OPS_TZ"
mkdir -p data output

STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z')"
say() { echo "[$STAMP] $*"; }

say "=== career-ops discovery pass starting ==="

# 1. Tracked-company scan (portals.yml). Fast, bounded.
say "scanning tracked companies (scan.mjs)…"
if node scan.mjs >>data/scan-cron.log 2>&1; then
  say "scan.mjs ok"
else
  say "scan.mjs finished non-zero (rc=$?) — continuing to digest anyway"
fi

# 2b. Multi-source discovery layer. Adds sources WITHOUT touching the digest,
#     the fit scoring, the gates, the tracker, the CV or the runner — it reuses
#     all of them and writes to the same scan-history sink. Bounded, and it
#     keeps its own rotating cursor in data/multi-discovery-state.json so
#     successive runs cover new tenants instead of re-sweeping the same ones.
# apify-valig is the fourth source: valig/linkedin-jobs-scraper on Apify, a
# DISCOVERY-ONLY index (measured: it returns no usable employer apply URL, so the
# employer posting is resolved afterwards by resolve-job-url.mjs, and anything
# unresolved stays discovery-only). It is IDLE with no cost when APIFY_TOKEN is
# absent from .env.
#
# --apify-limit 30 is NOT arbitrary. The source projects its own cost BEFORE it
# spends anything and refuses to start if the projection is over the cap, which
# is $0.15. Ten keywords x 40 results would project $0.17 and be REFUSED, so the
# default limit of 40 would have discovered nothing on every single run. At 30
# the worst case is $0.13, inside the cap with headroom. Verified locally at
# zero cost with a dry run before this line was added.
say "multi-source discovery (workday-cxs + public-search + apify-valig)…"
node discover-multi.mjs --sources workday-cxs,public-search,apify-valig --workday-tenants 200 --apify-limit 30 --resolve-limit 30 >>data/scan-cron.log 2>&1
say "discover-multi finished (rc=$?)"

# 3. Reverse-ATS pass, bounded so it cannot run for hours inside a cron slot.
#    --limit caps companies per ATS; the full sweep is a manual/occasional act.
say "reverse-ATS pass (bounded, 120 companies per ATS)…"
if node scan-ats-full.mjs --since 3 --limit 120 >>data/scan-cron.log 2>&1; then
  say "scan-ats-full ok"
else
  say "scan-ats-full finished non-zero (rc=$?) — continuing to digest anyway"
fi

# 4. Gate + digest. The digest prints:
#      "digest: N in scope · M strong fit · K need a human · rippling R · naukri U"
#    Parse those exact fields rather than assuming a format.
say "building digest…"
node daily-digest.mjs >output/digest-last.txt 2>&1
DIGEST_RC=$?
DIGEST_LINE="$(grep -m1 '^digest:' output/digest-last.txt || true)"
# The digest prints "N in scope · M strong fit · K need a human · rippling R ·
# naukri U" — the NUMBER COMES FIRST, so the pattern must be "N <label>".
field() { printf '%s' "$DIGEST_LINE" | grep -oE "[0-9]+ $1" | grep -oE '^[0-9]+' | head -1; }
NEW=$(field 'in scope');     NEW=${NEW:-0}
STRONG=$(field 'strong fit'); STRONG=${STRONG:-0}
NEEDS=$(field 'need a human'); NEEDS=${NEEDS:-0}
RIPP=$(field 'rippling');    RIPP=${RIPP:-0}
NAUK=$(field 'naukri');      NAUK=${NAUK:-0}
SCANNED=$(field 'scanned')
say "digest: ${NEW} in scope (${STRONG} strong fit, ${RIPP} rippling, ${NAUK} naukri) · ${NEEDS} need a human (rc=$DIGEST_RC)"

# 5. Notify. A local macOS notification needs no account or auth, so it always
#    works. The HTML digest is the durable artefact.
if [ "$NEW" -gt 0 ]; then
  TITLE="career-ops: ${NEW} new role(s)"
  if [ "$NEEDS" -gt 0 ]; then
    MSG="${NEEDS} need a manual application. Open output/daily-digest.html"
  else
    MSG="All auto-applicable. Open output/daily-digest.html"
  fi
else
  TITLE="career-ops: no new roles"
  MSG="Scanned ${SCANNED} postings — nothing new passed the gates."
fi

/usr/bin/osascript -e "display notification \"$MSG\" with title \"$TITLE\"" 2>/dev/null \
  && say "notification sent" \
  || say "osascript notification unavailable (headless?) — digest still written"

say "digest HTML: $(pwd)/output/daily-digest.html"
say "=== pass complete ==="
exit 0
