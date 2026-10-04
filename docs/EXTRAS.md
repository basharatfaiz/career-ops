# career-ops extras: daily discovery, dashboard, Gmail sync, assisted apply

This fork adds a hands-off daily workflow on top of [career-ops](https://github.com/career-ops-hq/career-ops).
Everything in the base project still works exactly as documented there; these
are additions. They were built for a product-design job search in India, so the
defaults lean that way (see [Defaults to change](#defaults-to-change)).

**Nothing here submits an application for you.** Every tool stops before
Submit, and nothing is marked Applied until you say so.

**New to this?** Start with the step-by-step
[setup guide (PDF)](career-ops-setup-guide.pdf). It goes from a fresh Mac to a
daily routine, with no prior terminal experience assumed. Its source is
[setup-guide.html](setup-guide.html).

## What it adds

| Piece | Files | What it does |
|---|---|---|
| Daily discovery | `daily-scan.sh`, `discover-multi.mjs`, `discovery/`, `resolve-job-url.mjs`, `plugins/firecrawl/` | Runs `scan.mjs`, a multi-source discovery pass (Workday boards, public search, optional Apify and Firecrawl) and the reverse-ATS sweep, then builds the digest and sends a macOS notification. |
| Gates | `geo-eligibility.mjs`, `seniority-gate.mjs`, `title-keywords.mjs` | Keep only roles you can actually take: location and relocation, seniority (no Staff, Lead or Manager when you want IC) and discipline (product design, not graphic or visual). |
| Dashboard | `daily-digest.mjs`, `mark-applied.mjs` | `output/daily-digest.html` with New Jobs, Applied, All Jobs History and Archived views. `node mark-applied.mjs` serves it at http://127.0.0.1:8900 so the **Mark Applied** and **Archive** buttons write to your tracker. |
| Gmail sync | `gmail-sync.mjs` | Turns your Gmail `Jobs/*` labels into proposed tracker status changes (Rejected, Interview, Offer). It proposes and you approve; it never writes on its own. |
| Assisted apply | `browser-session.mjs`, `application-runner.mjs`, `apply-one.mjs`, `answer-generator.mjs`, `open-for-manual.mjs`, `final-cv.mjs`, `untick-sensitive.mjs`, `inspect-form.mjs`, `screenshot-gate.mjs`, `captcha-inspect.mjs` | Fills application forms from your own answer bank in a visible browser, uploads your one final CV (hash-checked), and stops before Submit. Questions it cannot answer truthfully from your files are handed back to you. |

## Setup

1. **Install career-ops first** and finish its onboarding (CV, profile, portals).
   Then:

   ```bash
   npm install
   npx playwright install chromium
   cp docs/local-paths.fork.txt config/local-paths.txt
   ```

   The last line tells career-ops's own updater (`update-system.mjs`) that this
   fork's files are yours, so an upstream update never overwrites them.

2. **Answer bank.** Copy the template and fill it in from your own CV:

   ```bash
   cp templates/application-answers.example.yml data/application-answers.yml
   ```

   Leave anything you are unsure of blank: a blank makes the runner ask you
   instead of guessing. `free_text.stories` and `free_text.highlights` are what
   the answer generator uses for "why this company" and "tell us about a
   project" questions. Write them in your own words. The generator never
   invents experience.

3. **Your final CV.** Put the one PDF you upload everywhere somewhere stable,
   then record it in the answer bank:

   ```bash
   shasum -a 256 "path/to/Your Name - CV.pdf"
   ```

   Set `cv.final_path` and `cv.final_sha256`. Check it with `node final-cv.mjs`.

4. **Optional keys** in `.env` (see `.env.example`): `APIFY_TOKEN` for LinkedIn
   discovery and `FIRECRAWL_API_KEY` for web discovery. Without them those
   sources stay idle at zero cost.

5. **Daily schedule (macOS).** Save this as
   `~/Library/LaunchAgents/com.careerops.daily-scan.plist`, replacing
   `/ABSOLUTE/PATH/TO/career-ops`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.careerops.daily-scan</string>
     <key>ProgramArguments</key><array>
       <string>/bin/bash</string><string>/ABSOLUTE/PATH/TO/career-ops/daily-scan.sh</string>
     </array>
     <key>StartCalendarInterval</key><array>
       <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>30</integer></dict>
       <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
     </array>
     <key>StandardOutPath</key><string>/ABSOLUTE/PATH/TO/career-ops/data/launchd.log</string>
     <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/TO/career-ops/data/launchd.log</string>
   </dict></plist>
   ```

   ```bash
   launchctl load ~/Library/LaunchAgents/com.careerops.daily-scan.plist
   ```

   Set `CAREER_OPS_TZ` (e.g. `Asia/Kolkata`) if you want log timestamps in a
   specific timezone. On Linux, run `daily-scan.sh` from cron instead.

6. **Gmail sync (optional).** Create labels `Jobs/Applied`, `Jobs/Interview`,
   `Jobs/Rejected` and `Jobs/Offered` and filter job mail into them. Label ids
   differ per account, so map yours in `data/gmail-labels.json`:

   ```json
   { "Label_1234567890": "Jobs/Applied", "Label_2345678901": "Jobs/Rejected" }
   ```

   Ask your agent to list your Gmail labels to get the ids. Then ask it to
   "sync gmail". It saves the labelled threads, runs `node gmail-sync.mjs import <file>`
   and `node gmail-sync.mjs review`, and shows you each proposed change to approve.

## Applying, step by step

```bash
node browser-session.mjs start <job-url>        # visible Chromium, its own profile
node application-runner.mjs --check-bank        # answer bank + final CV self-check
node application-runner.mjs --plan --url <job-url> --company "Acme"   # read-only plan
node application-runner.mjs --fill --url <job-url> --company "Acme"   # fill, never submit
```

Review what it filled and what it handed back to you, then submit yourself.
For a batch the runner could not finish, list them in `data/manual-targets.json`
(`[{ "company", "role", "url" }]`) and run `node open-for-manual.mjs`. Each
one opens pre-filled in its own tab.

## Your data stays yours

Everything personal lives in the user layer, which git ignores:
`cv.md`, `config/profile.yml`, `portals.yml`, `data/` (tracker, answer bank,
Gmail label map, browser profile) and `output/`. No script in this fork
contains anyone's personal details, and none of them sends your data anywhere
except the job sites you point it at.

Suggested house rules to paste into `modes/_custom.md`, so your agent follows them:

```markdown
- Never submit an application without my explicit approval for that specific job.
- Never mark anything Applied because a form was opened or filled; only a
  site-confirmed submission or my own statement counts.
- Upload only my final CV (`node final-cv.mjs`); never generate or tailor one.
- Never invent answers. Anything not in data/application-answers.yml or cv.md
  is a question for me.
- Stop at CAPTCHAs, logins/OTPs and legal attestations.
```

## Defaults to change

- **Home country is India.** `geo-eligibility.mjs` treats India-based and
  India-eligible remote roles as in scope, and roles abroad as
  `relocation_eligible`. If you are elsewhere, change `INDIA_CITY` and the
  campaign gate there, plus the India location lists in `discovery/sources/`,
  `scraper-sources.mjs` and `resolve-job-url.mjs`.
- **Product design, individual contributor.** The seniority and discipline
  gates reject Staff, Lead, Manager, graphic, visual and marketing design roles.
  `tests/fixtures/title-filter.product-design.yml` is a ready `title_filter`
  for `portals.yml` if that is your search too.

## Tests

```bash
node test-all.mjs --quick
```

The added suites (`tests/digest-dashboard`, `mark-applied`, `gmail-sync`,
`apify-valig`, `seniority-gate`, `title-normalizer-coverage`) use fictional
fixtures and never touch your real tracker.
