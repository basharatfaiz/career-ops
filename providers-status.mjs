#!/usr/bin/env node
/**
 * providers-status.mjs — one screen showing what discovery is live right now.
 *
 * The point is that the FREE/LOCAL pipeline is the baseline and the two keyed
 * scrapers are additions. Nothing here fails when a key is missing: an absent
 * key is a reported state, not an error. Run it any time to answer "is my
 * discovery actually covering what I think it is?".
 *
 * Usage: node providers-status.mjs [--json]
 */
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { normalizeUrl } from './url-key.mjs';

const arg = (k) => process.argv.includes(k);

const hasKey = (k) => {
  const v = process.env[k];
  return typeof v === 'string' && v.trim().length > 0;
};

const dotenv = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const dotenvHas = (k) => new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(dotenv);

// ── baseline: the always-on local/zero-token discovery ─────────────────
function baseline() {
  let portals = {};
  try {
    const yaml = require('js-yaml');
    portals = yaml.load(readFileSync('portals.yml', 'utf8')) || {};
  } catch { /* no portals.yml yet */ }
  const tc = portals.title_filter || {};
  return {
    searchQueries: (portals.search_queries || []).filter((q) => q.enabled).length,
    companies: (portals.tracked_companies || []).filter((c) => c.enabled).length,
    jobBoards: (portals.job_boards || []).filter((b) => b.enabled).length,
    positiveTitles: (tc.positive || []).length,
    negativeTitles: (tc.negative || []).length,
    locationGate: 'location_filter' in portals ? 'PRESENT' : 'absent (no geographic gate)',
  };
}

function pluginState(id, envKeys, envFile) {
  const manifestPath = `plugins/${id}/manifest.json`;
  const installed = existsSync(manifestPath);
  const manifest = installed ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const keyName = manifest?.requiredEnv?.[0] || envKeys[0];
  const inEnv = hasKey(keyName);
  const inDotenv = envFile ? dotenvHas(keyName) : false;
  let pluginsYml = 'absent';
  if (existsSync('config/plugins.yml')) {
    const y = readFileSync('config/plugins.yml', 'utf8');
    pluginsYml = new RegExp(`^\\s*-?\\s*id:\\s*${id}\\b.*enabled:\\s*true`, 'm').test(y)
      || new RegExp(`^\\s*${id}:\\s*\\n\\s*enabled:\\s*true`, 'm').test(y) ? 'enabled' : 'listed, not enabled';
  }
  const configured = inEnv || inDotenv;
  const state = !installed ? 'NOT INSTALLED' : configured && pluginsYml === 'enabled' ? 'ENABLED' : configured ? 'key present, plugin not enabled' : 'DISABLED';
  return { id, installed, state, enabled: state === 'ENABLED', keyName, keyInEnv: inEnv, keyInDotenv: inDotenv, pluginsYml };
}

const base = baseline();
const apify = pluginState('apify', ['APIFY_TOKEN', 'APIFY_API_TOKEN'], true);
const firecrawl = pluginState('firecrawl', ['FIRECRAWL_API_KEY'], true);

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  existing: { status: 'ENABLED', ...base },
  apify, firecrawl,
  anyKeyedEnabled: apify.enabled || firecrawl.enabled,
};

if (arg('--json')) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const line = (s) => console.log(s);
line('='.repeat(72));
line('DISCOVERY PROVIDER STATUS');
line('='.repeat(72));
line(`  Existing discovery:  ENABLED`);
line(`    search queries     ${base.searchQueries} enabled`);
line(`    tracked companies  ${base.companies} enabled`);
line(`    board feeds        ${base.jobBoards} enabled`);
line(`    title filter       ${base.positiveTitles} accepted / ${base.negativeTitles} excluded`);
line(`    location gate      ${base.locationGate}`);
line(`    ATS / Playwright   built in, no key required`);
line('');
for (const p of [apify, firecrawl]) {
  line(`  ${p.id === 'apify' ? 'Apify   ' : 'Firecrawl'}: ${p.state}`);
  if (!p.installed) { line('    not installed'); }
  else {
    line(`    key var            ${p.keyName}  ${p.keyInEnv ? '(set in env)' : p.keyInDotenv ? '(present in .env)' : '(absent)'}`);
    line(`    plugins.yml        ${p.pluginsYml}`);
    line(`    acts only on       portals.yml entries with 'provider: ${p.id}'`);
  }
  line('');
}
line('-'.repeat(72));
if (!payload.anyKeyedEnabled) {
  line('  No keyed provider is active. The free/local pipeline is running alone —');
  line('  that is a fully supported configuration, not a degraded one.');
  line('  Nothing here needs a paid service to keep working.');
} else {
  line('  At least one keyed provider is active.');
}
line('='.repeat(72));
