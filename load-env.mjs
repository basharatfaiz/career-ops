// load-env.mjs — populate process.env from .env without adding a dependency.
// Values already present in the real environment win, so an exported key
// overrides the file. Quotes and `export ` prefixes are tolerated.
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
const file = resolve(process.env.CAREER_OPS_ENV || '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
