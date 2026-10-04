// tests/title-normalizer-coverage.test.mjs, coverage for the 2026-09-27 title
// normaliser in title-keywords.mjs.
//
// The change under test widens `title_filter.positive` by CANONICALISING both
// sides instead of by adding near-duplicate literal spellings. Measured over
// the 152 distinct titles returned by one live discovery run, it accepts 7 more
// roles and loses none. The 7 are pinned at the bottom of this file as an
// explicit list rather than a golden blob, because a silent narrowing here is
// the exact failure the recall corpus exists to catch (#3103, #2544).
//
// The safety argument is structural and is asserted here rather than asserted in
// a comment: NEGATIVES ARE NOT NORMALISED. They still match the raw lowercased
// title, so the discipline gate and the seniority gate cannot have been widened
// by anything done to the positive side. `seniority is enforced on the raw
// string` below is that claim, tested.

import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { pass, fail, ROOT } from './helpers.mjs';
import { buildTitleFilter, canonicalizeTitle, foldAccents } from '../title-keywords.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
// A fixed fixture, not the user's portals.yml: this suite tests the normaliser,
// so it must give the same answer on every machine.
const cfg = yaml.load(readFileSync(join(ROOT, 'tests', 'fixtures', 'title-filter.product-design.yml'), 'utf8'));
const filter = buildTitleFilter(cfg.title_filter);
const negs = cfg.title_filter.negative.filter((k) => typeof k === 'string')
  .map((k) => foldAccents(k.trim().toLowerCase())).filter(Boolean);

console.log('\ntitle normaliser: the seven roles this change was made for');

const mustAccept = [
  ['UI/UX Designer', 'the plain form'],
  ['UX/UI Designer', 'same role, words reversed'],
  ['UI/UX Product Designer', 'with the product head'],
  ['UX/UI Product Designer', 'same, words reversed'],
  ['Product/UX Designer', 'slash separator, product first'],
  ['Product UX Designer', 'space separator, product first'],
  ['Senior Product Design', 'the NOUN spelling, no -er'],
];
for (const [title, why] of mustAccept) {
  if (filter(title)) pass(`accepts "${title}" (${why})`);
  else fail(`REJECTS "${title}" (${why})`);
}

// Aliases of the same family, observed on real boards, which now come along
// because the normaliser is order-insensitive rather than because each one was
// typed into portals.yml.
for (const title of ['Senior UI/UX Designer', 'Senior UI-UX Designer', 'Sr UI/UX Designer', 'Product/ UI/UX Designer']) {
  if (filter(title)) pass(`accepts family alias "${title}"`);
  else fail(`REJECTS family alias "${title}"`);
}

console.log('\nseniority exclusions: unchanged, and still enforced on the RAW title');
// Each family member, prefixed with every excluded rank. The normaliser strips
// "senior" from the positive cluster, so if the negative side were normalised
// too (or if the veto depended on the positive match) these would slip through.
for (const rank of ['Staff', 'Senior Staff', 'Principal', 'Senior Principal', 'Lead', 'Manager', 'Director', 'Head of', 'VP']) {
  for (const core of ['Product Designer', 'UI/UX Designer', 'Product/UX Designer']) {
    const title = core.replace('Product', rank + ' Product').replace('UI/UX', rank + ' UI/UX');
    if (!filter(title)) pass(`rejects "${title}"`);
    else fail(`ACCEPTS "${title}" :: a seniority exclusion leaked through the normaliser`);
  }
}

console.log('\nseniority is enforced on the raw string, not the canonical form');
// Before 2026-09-27 the title filter alone ACCEPTED "Lead - Product Designer":
// the positive "Product Designer" matched, and no negative did, because every
// rank entry was the phrase "Lead Product Designer" and this title has a hyphen
// in the middle. The leadership veto for it lived downstream in discover-multi.mjs
// and geo-eligibility.mjs, so the title filter was, on its own, one layer short.
// The `word:Lead` entry added with this change closes that at the gate itself.
// Asserted explicitly so the change is a recorded decision, not a surprise.
t_('"Lead - Product Designer" is now rejected AT THE GATE', filter('Lead - Product Designer'), false);
t_('the phrase negative still does not match it literally', negs.some((n) => n.startsWith('lead product designer') && 'lead - product designer'.includes(n)), false);
t_('but the anchored rank does', negs.includes('word:lead'), true);

console.log('\nthe discipline gate must not be weakened');
const mustReject = [
  // the families the change explicitly promised to keep rejecting
  'Graphic Designer', 'Senior Graphic Designer', 'Visual Designer', 'Brand Designer',
  'Marketing Designer', 'Growth Designer', 'Motion Designer', 'Art Director',
  'Creative Designer', 'Packaging Designer', 'Fashion Designer', 'Apparel Designer',
  'Interior Designer', 'UI/UX Visual Designer', 'Web Designer',
  // industrial / physical / mechanical, incl. the noun-spelling trap
  'Design Engineer', 'Product Design Engineer', 'Engineer II Product Design',
  'Engineer - Technical Product Design', 'Mechanical Design Engineer',
  'Engineer Mechanical', 'Design Engineer - Solidworks / Inventor',
  'Catia Design Engineer (Exterior)', 'Senior Designer - Unigraphics NX - Hydraulic Tubing',
  'Modular Furniture Designer', 'Manufacturing Design Engineer', 'NPD Engineers',
  'User Experience Designer with CAD Experience',
  // adjacent disciplines that are not product design
  'Service Designer_Q2 27', 'Business Process Designer', 'Product Analyst',
  'Product Manager', 'Product Owner', 'Product Engineer', 'UX/UX Engineer',
  'AI Interaction Designer_Q2 27', 'Senior UX Designer (Research & AI)',
  'Sr User Experience Designer', 'UX Designer', 'User Interface Designer',
  'UI/UX Design Intern', 'Product Designer - Fashion',
];
for (const title of mustReject) {
  if (!filter(title)) pass(`rejects "${title}"`);
  else fail(`ACCEPTS "${title}" :: the discipline gate was weakened`);
}

console.log('\nthe noun rewrite is guarded, not a blanket rule');
t_('"Senior Product Design" rewrites (agent form recovered)', canonicalizeTitle('Senior Product Design'), 'product designer');
t_('"Engineer II Product Design" does NOT rewrite', canonicalizeTitle('Engineer II Product Design').includes('designer'), false);
t_('"Engineer - Technical Product Design" does NOT rewrite', canonicalizeTitle('Engineer - Technical Product Design').includes('designer'), false);
t_('"Director, Product Design" does NOT rewrite', canonicalizeTitle('Director, Product Design').includes('designer'), false);
t_('"Product Design Engineer" does NOT rewrite', canonicalizeTitle('Product Design Engineer').includes('designer'), false);
t_('"Senior Staff Product Design" does NOT rewrite', canonicalizeTitle('Senior Staff Product Design').includes('designer'), false);
t_('a bare "Design" head is never rewritten', canonicalizeTitle('Senior Design'), 'design');
t_('"Creative Design" is not rewritten to a designer', canonicalizeTitle('Creative Design'), 'creative design');

console.log('\ncanonicalisation rules');
t_('separators collapse', canonicalizeTitle('Sr. Product Designer'), 'product designer');
t_('word order is normalised', canonicalizeTitle('UX/Product Designer'), canonicalizeTitle('Product/ UX Designer'));
t_('the ui/ux pair is order-free', canonicalizeTitle('UI/UX Designer'), canonicalizeTitle('UX/UI Designer'));
t_('a suffix after the head keeps its order', canonicalizeTitle('Product Designer II'), 'product designer ii');
t_('a prefixed levelled title still matches the levelled positive', filter('Senior Product Designer II'), true);
t_('and the same for III', filter('Product Designer III'), true);
t_('and the same for IV', filter('Senior Product Designer IV'), true);
t_('accents still fold', canonicalizeTitle('Product Désigner'), 'product designer');
t_('an empty title is safe', canonicalizeTitle(''), '');
t_('a null title is safe', canonicalizeTitle(null), '');
t_('a non-string title is safe', canonicalizeTitle(42), '42');

console.log('\nAND-groups survive canonicalisation (the "+" must not be eaten)');
const andFilter = buildTitleFilter({ positive: ['Product Designer + II'], negative: [] });
t_('"Product Designer II" matches the group', andFilter('Product Designer II'), true);
t_('"Product Designer III" does not', andFilter('Product Designer III'), false);
t_('"Product Designer" alone does not', andFilter('Product Designer'), false);
t_('"Senior Product Designer II" does match, prefix stripped', andFilter('Senior Product Designer II'), true);

console.log('\nnegatives are matched on the raw title, byte for byte');
// A negative with a separator in it must still see that separator, which is only
// true if the negative side is NOT canonicalised.
const sepFilter = buildTitleFilter({ positive: ['Product Designer'], negative: ['Design Manager'] });
t_('"Design Manager" is vetoed', sepFilter('Design Manager'), false);
t_('"Sr. Product Designer" is not vetoed by a canonicalised negative', sepFilter('Sr. Product Designer'), true);

console.log('\nthe measured before/after, pinned');
// 152 distinct titles from one live run. These 7 flipped to accepted; nothing
// flipped to rejected. The list is the deliverable, not a golden file.
const gained = [
  'Senior Product Design', 'Product/ UX Designer', 'UI/UX Designer',
  'Product UX Designer - Interaction Design', 'Senior UI/UX Designer',
  'Senior UI-UX Designer', 'UX/UI Designer – SCG India',
];
const OLD_POS = ['Product Designer', 'Senior Product Designer', 'Sr. Product Designer', 'AI/UX Product Designer', 'AI Product Designer', 'Product Designer, AI', 'Product Designer II', 'Product Designer III', 'Product Designer IV', 'Senior UX/Product Designer', 'UX/Product Designer', 'AI/UX Designer', 'UX/AI Designer']
  .map((k) => foldAccents(k.trim().toLowerCase()));
const before = (t) => {
  const lower = foldAccents(String(t ?? '').toLowerCase());
  return OLD_POS.some((p) => lower.includes(p)) && !negs.some((n) => lower.includes(n));
};
for (const title of gained) {
  t_(`"${title}" was rejected before and is accepted now`, before(title) === false && filter(title) === true, true);
}

const RAW = join(ROOT, 'data', 'discovery', 'apify-raw', 'apify-headtohead.json');
if (existsSyncSafe(RAW)) {
  const raw = JSON.parse(readFileSync(RAW, 'utf8'));
  const titles = new Set();
  for (const items of Object.values(raw)) for (const i of items) titles.add(String(i.title || '').replace(/\s+/g, ' ').trim());

  const flippedOn = [...titles].filter((t) => !before(t) && filter(t)).sort();
  const flippedOff = [...titles].filter((t) => before(t) && !filter(t)).sort();

  t_('exactly the seven intended roles flipped to accepted', flippedOn, [...gained].sort());
  // The one deliberate correction in the other direction: a LEAD role that the
  // old title filter let through because every rank entry was a phrase. It is
  // listed rather than waved through, so if this ever moves it is on the record.
  t_('the only flip to rejected is the leadership one', flippedOff, ['Lead - Product Designer']);
} else {
  console.log('  (measured corpus absent, skipping the no-loss assertion)');
}

function t_(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass(name);
  else fail(`${name} :: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function existsSyncSafe(p) {
  try { readFileSync(p); return true; } catch { return false; }
}
