// tests/apify-valig.test.mjs, assertions for the Apify/valig source adapter.
//
// Every assertion here runs with NO token and NO network call, so the suite
// costs nothing. The behaviours pinned are the ones that decide whether real
// money is spent correctly, plus the India-explicit rule that decides whether a
// paid row is eligible at all.
//
// The EXTERNAL-with-empty-applyUrl case is the load-bearing one: it is the
// measured behaviour that makes this source discovery-only, and it is easy to
// "fix" by accident later without anyone noticing discovery-only is over-stated.

import { pass, fail } from './helpers.mjs';
import {
  hasKey, isIndiaExplicit, classifyRow, discover, scrubToken,
  DEFAULT_KEYWORDS, DEFAULT_TITLE_EXCLUDE, PRICE_PER_RESULT_USD,
} from '../discovery/sources/apify-valig.mjs';

const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass(name);
  else fail(`${name} :: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const tTrue = (name, v) => t(name, !!v, true);

console.log('\nAPIFY VALIG ADAPTER (no token, no network, no credits)');
delete process.env.APIFY_TOKEN;

console.log('\nIDLE without a token');
t('hasKey() is false with no token', hasKey(), false);

console.log('\nIndia-explicit: the posting itself must name India');
tTrue('Bengaluru, Karnataka, India', isIndiaExplicit('Bengaluru, Karnataka, India'));
tTrue('Hyderabad, Telangana, India', isIndiaExplicit('Hyderabad, Telangana, India'));
tTrue('Greater Bengaluru Area', isIndiaExplicit('Greater Bengaluru Area'));
tTrue('Pune Division, Maharashtra, India', isIndiaExplicit('Pune Division, Maharashtra, India'));
tTrue('Mumbai Metropolitan Region', isIndiaExplicit('Mumbai Metropolitan Region'));
t('Singapore is not India', isIndiaExplicit('Singapore'), false);
t('London, United Kingdom is not India', isIndiaExplicit('London, United Kingdom'), false);
t('Cincinnati, OH is not India', isIndiaExplicit('Cincinnati, OH'), false);
t('an Indian company name alone is NOT enough', isIndiaExplicit(''), false);
t('remote with no country is not India-explicit', isIndiaExplicit('Remote'), false);

console.log('\nLinkedIn is discovery-only, by measurement');
const easyApply = classifyRow({
  id: '1', title: 'Product Designer', companyName: 'Acme', location: 'Bengaluru, India',
  url: 'https://in.linkedin.com/jobs/view/x-at-acme-1', applyUrl: '', applyType: 'EASY_APPLY',
});
t('empty applyUrl is not an apply target', easyApply.applyTarget, false);
t('  and the row is still India-explicit', easyApply.indiaExplicit, true);

const externalNoUrl = classifyRow({
  id: '2', title: 'Senior Product Designer', companyName: 'Beta', location: 'Pune, India',
  url: 'https://in.linkedin.com/jobs/view/y-at-beta-2', applyUrl: '', applyType: 'EXTERNAL',
});
t('EXTERNAL with an empty applyUrl is NOT a target (the measured valig bug)', externalNoUrl.applyTarget, false);

const linkedinMirror = classifyRow({
  id: '3', title: 'Product Designer', companyName: 'Gamma', location: 'Hyderabad, India',
  url: 'https://www.linkedin.com/jobs/view/z-at-gamma-3', applyUrl: 'https://www.linkedin.com/jobs/view/z-at-gamma-3',
});
t('a linkedin.com applyUrl is never a target', linkedinMirror.applyTarget, false);

const realOffsite = classifyRow({
  id: '4', title: 'Product Designer', companyName: 'Delta', location: 'Chennai, India',
  url: 'https://www.linkedin.com/jobs/view/w-at-delta-4', applyUrl: 'https://boards.greenhouse.io/delta/jobs/9',
});
t('a real employer ATS applyUrl IS a target', realOffsite.applyTarget, true);

console.log('\nServer-side exclusions only drop what the title gate already drops');
for (const p of ['Product Designer', 'Senior Product Designer', 'Sr. Product Designer']) {
  const hit = DEFAULT_TITLE_EXCLUDE.find((x) => p.toLowerCase().includes(x.toLowerCase()));
  t(`"${p}" is not excluded upstream`, hit || null, null);
}
tTrue('"Product Engineer" is excluded upstream', DEFAULT_TITLE_EXCLUDE.some((x) => 'Product Engineer'.includes(x)));
tTrue('"Mechanical Design Engineer" is excluded upstream', DEFAULT_TITLE_EXCLUDE.includes('Mechanical'));
tTrue('"Associate Product Intern" is excluded upstream', DEFAULT_TITLE_EXCLUDE.some((x) => 'Associate Product Intern'.includes(x)));
tTrue('"Senior Product Manager" is excluded upstream', DEFAULT_TITLE_EXCLUDE.some((x) => 'Senior Product Manager'.includes(x)));

console.log('\nCampaign keywords: the ten breadth titles, un-deduplicated');
t('the ten requested titles are the default', DEFAULT_KEYWORDS, [
  'Product Designer', 'Senior Product Designer', 'Product/UX Designer',
  'Product UX Designer', 'UI/UX Designer', 'UX/UI Designer',
  'UI/UX Product Designer', 'UX/UI Product Designer',
  'AI Product Designer', 'AI/UX Product Designer',
]);
t('no title is repeated', new Set(DEFAULT_KEYWORDS).size, DEFAULT_KEYWORDS.length);
t('every keyword is a real target title, not a gate spelling',
  DEFAULT_KEYWORDS.every((k) => k.trim().length > 3), true);

// The schedule limit and the cap, pinned. Ten keywords at the DEFAULT limit of 40
// projects $0.17 and is REFUSED by the $0.15 cap, which is why daily-scan.sh
// passes --apify-limit 30. If either number moves, this fails and the reason has
// to be written down rather than discovered on a silent schedule.
console.log('\nThe scheduled plan fits the cap');
const at30 = await discover({ keywords: DEFAULT_KEYWORDS, limit: 30, maxTotalChargeUsd: 0.15, dryRun: true, log: () => {} });
t('the scheduled limit 30 is within the cap', at30.stats.withinCap, true);
t('  and projects $0.13', at30.stats.projectedUsd, 0.13);
t('  with 300 as the worst-case billed count', at30.stats.billedWorstCase, 300);
const at40 = await discover({ keywords: DEFAULT_KEYWORDS, limit: 40, maxTotalChargeUsd: 0.15, dryRun: true, log: () => {} });
t('the default limit 40 is REFUSED, so the schedule must override it', at40.stats.withinCap, false);
t('  and the refusal names both numbers', /\$0\.170/.test(at40.reason) && /\$0\.15/.test(at40.reason), true);

// The plan must be reportable with NO credentials, because that is how the
// schedule decision gets made before a token exists.
console.log('\nThe cost plan needs no token');
delete process.env.APIFY_TOKEN;
t('hasKey() is false', hasKey(), false);
const planNoToken = await discover({ keywords: DEFAULT_KEYWORDS, limit: 30, maxTotalChargeUsd: 0.15, dryRun: true, log: () => {} });
t('a dry run still reports the projection without a token', planNoToken.stats.projectedUsd, 0.13);
t('  and does not report "token not set"', /APIFY_TOKEN/.test(planNoToken.reason), false);
t('a real run without a token is still IDLE', (await discover({ keywords: DEFAULT_KEYWORDS, limit: 30, maxTotalChargeUsd: 0.15, log: () => {} })).ran, false);

console.log('\nCost pre-flight: refuse before spending, not after');
const noToken = await discover({ keywords: DEFAULT_KEYWORDS, limit: 30, maxTotalChargeUsd: 0.15, log: () => {} });
t('it refuses to start without a token', noToken.ran, false);
t('  and says why', /APIFY_TOKEN/.test(noToken.reason), true);

process.env.APIFY_TOKEN = 'fake-token-not-used';
t('hasKey() is true once a token is set', hasKey(), true);

const tooBig = await discover({ keywords: DEFAULT_KEYWORDS, limit: 400, maxTotalChargeUsd: 0.15, log: () => {} });
t('an over-cap plan is refused, not run', tooBig.ran, false);
t('  with the projected cost in the reason', /refusing to start/.test(tooBig.reason), true);
t('  and the projection is reported', tooBig.meter.projectedUsd, Number((DEFAULT_KEYWORDS.length * (400 * PRICE_PER_RESULT_USD + 0.001)).toFixed(5)));

const dry = await discover({ keywords: DEFAULT_KEYWORDS, limit: 40, maxTotalChargeUsd: 0.15, dryRun: true, log: () => {} });
t('a dry run spends nothing', dry.ran, false);
t('  and reports the projection', dry.stats.projectedUsd, Number((DEFAULT_KEYWORDS.length * (40 * PRICE_PER_RESULT_USD + 0.001)).toFixed(5)));

const noKeywords = await discover({ keywords: [], limit: 40, maxTotalChargeUsd: 0.15, log: () => {} });
t('zero keywords never starts a run', noKeywords.meter.queries, 0);

delete process.env.APIFY_TOKEN;

console.log('\nthe token must never reach a log, an error, or a stored stat');
// The Apify API takes the credential as a ?token= QUERY PARAMETER, so the secret
// rides inside a URL. A response body, a thrown fetch error, or a run
// statusMessage is therefore one echo away from printing it. These pin the
// scrubber that stands between those strings and any output.
const SECRET = 'apify_api_RAWVALUE123456';
t('a token in a URL query is redacted',
  scrubToken('https://api.apify.com/v2/acts/x/runs?token=' + SECRET + '&waitForFinish=45').includes(SECRET), false);
t('the same token mid-URL is redacted',
  scrubToken('GET /v2/datasets/abc?clean=1&token=' + SECRET).includes(SECRET), false);
t('a bare token in prose is redacted',
  scrubToken('actor start failed for ' + SECRET).includes(SECRET), false);
t('a firecrawl-style key is redacted too',
  scrubToken('error from fc-cSECRET12345').includes('cSECRET12345'), false);
t('the placeholder is still readable',
  scrubToken('https://api.apify.com/v2/x?token=abc&limit=40').includes('token=<redacted>'), true);
t('an ordinary message is left readable',
  scrubToken('run "Product Designer" ended FAILED'), 'run "Product Designer" ended FAILED');
t('a null is safe', scrubToken(null), '');
