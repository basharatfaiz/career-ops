// Regression tests for the three gate bugs fixed 2026-09-26.
//   Bug 1  discipline/deal-breaker  — a product-design TITLE is not sufficient
//   Bug 2  experience parser        — only years bound to "experience" count
//   Bug 3  Staff/Lead scope        — explicit scope phrases, not one ordinary
//                                    collaboration sentence
// Run: node tests/seniority-gate.test.mjs (also discovered by test-all.mjs)
import { gateTitle, checkDiscipline, extractExperienceYears } from '../seniority-gate.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nseniority gate: discipline, experience parser, Staff/Lead scope');
const t = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(name);
  else fail(`${name} :: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

console.log('\nBUG 1 — discipline / deal-breaker gate');
t('Visual-design posting: "Senior Product Designer (Illustration & Motion, EdTech)" excluded',
  gateTitle('Senior Product Designer (Illustration & Motion, EdTech)', { jdText: 'Create illustrations, animation and motion graphics for learning content. Character design and visual assets.' }).verdict,
  'exclude');
t('Visual-design posting reason is the recorded discipline string',
  gateTitle('Senior Product Designer (Illustration & Motion, EdTech)', {}).reason,
  'EXCLUDED: discipline mismatch / consumer-brand-visual design');
t('legit PD with ONE incidental "graphic" mention is NOT rejected',
  gateTitle('Senior Product Designer', { jdText: 'You will partner with marketing on a graphic refresh, but this is a product role.' }).verdict,
  'accept');
t('legit PD JD full of "visual design" language is NOT rejected',
  gateTitle('Senior Product Designer', { jdText: 'Strong visual design fundamentals and interaction design craft. You will do creative work across the platform.' }).verdict,
  'accept');
t('brand-identity-heavy JD excluded on concentration',
  gateTitle('Product Designer', { jdText: 'Own brand identity, produce packaging artwork, and art direct photo shoots.' }).verdict,
  'exclude');
t('discipline check reports why on a near-miss',
  checkDiscipline('Senior Product Designer', 'We need strong visual design and creative skills.').hit,
  false);
t('Toast JD NOT excluded — "motion\\nDesign" is a line-wrap artefact, "rewards package" is benefits',
  checkDiscipline('Senior Product Designer', 'Real opinions on type, spacing, hierarchy, motion\nDesign native mobile and responsive. Our total rewards package goes beyond great earnings.').hit,
  false);
t('GoodHabitz JD NOT excluded — a team roster is not the role\'s discipline',
  checkDiscipline('Senior Product Designer', "You'll land on a multidisciplinary team of educational designers, writers, graphic designers, video creatives, and engineers.").hit,
  false);
t('Visual-design JD still excluded on TITLE even with a lenient body',
  gateTitle('Senior Product Designer (Illustration & Motion, EdTech)', { jdText: 'More expressive illustration, more purposeful motion.' }).verdict,
  'exclude');
t('a real product-design body with two production disciplines IS excluded',
  checkDiscipline('Product Designer', 'You will create illustrations for every lesson and produce animation for each module.').hit,
  true);

console.log('\nBUG 2 — experience parser');
t('"5+ years of product design experience" → 5',
  extractExperienceYears('We require 5+ years of product design experience.'), 5);
t('"minimum 5 years experience" → 5',
  extractExperienceYears('Minimum 5 years experience in design.'), 5);
t('"5-7 years of experience" → 5 (the floor, not the max)',
  extractExperienceYears('You have 5-7 years of experience.'), 5);
t('"at least 6 years" → 6',
  extractExperienceYears('At least 6 years of relevant experience.'), 6);
t('unrelated "50+ years" is IGNORED',
  extractExperienceYears('Celebrating 50+ years of heritage. Founded long ago, we build things.'), null);
t('unrelated "50+ years" alongside a real 5+ requirement → 5',
  extractExperienceYears('Trusted for 50+ years. We need 5+ years of product design experience.'), 5);
t('"8+ years" → 8, and 8 triggers a review flag (never a rejection)',
  gateTitle('Senior Product Designer', { jdText: '8+ years of product design experience required.' }).verdict, 'accept');
t('…and that flag is present',
  gateTitle('Senior Product Designer', { jdText: '8+ years of product design experience required.' }).needsReview.length > 0, true);
t('A "50+ years" artefact no longer flags',
  gateTitle('Senior Product Designer', { jdText: '50+ years of trust in logistics software.' }).needsReview.length, 0);

console.log('\nBUG 3 — Staff/Lead scope detection');
t('"Lead end-to-end design strategy" IS flagged',
  gateTitle('Senior Product Designer', { jdText: 'Lead end-to-end design strategy and execution across core product areas.' }).needsReview.length > 0, true);
t('"set design direction" IS flagged',
  gateTitle('Senior Product Designer', { jdText: 'Set design direction for the platform.' }).needsReview.length > 0, true);
t('"define the design vision" IS flagged',
  gateTitle('Senior Product Designer', { jdText: 'Define the design vision for the org.' }).needsReview.length > 0, true);
t('"own design strategy across" IS flagged',
  gateTitle('Senior Product Designer', { jdText: 'Own design strategy across three product lines.' }).needsReview.length > 0, true);
t('"strategic design leadership" IS flagged',
  gateTitle('Senior Product Designer', { jdText: 'Drive strategic design leadership.' }).needsReview.length > 0, true);
t('ONE ordinary collaboration sentence is NOT flagged',
  gateTitle('Senior Product Designer', { jdText: 'Partner closely with Engineering through implementation. Work cross-functionally with Product and Research.' }).needsReview.length, 0);
t('"contribute to critique and mentorship" is NOT flagged alone',
  gateTitle('Senior Product Designer', { jdText: 'Contribute to design culture through critique, knowledge sharing and mentorship.' }).needsReview.length, 0);
t('scope flag never becomes a rejection',
  gateTitle('Senior Product Designer', { jdText: 'Lead end-to-end design strategy and set design direction org-wide.' }).verdict, 'accept');

console.log('\nREGRESSION — seniority gate still behaves');
t('"Lead Product Designer" still excluded (contains "Product Designer")',
  gateTitle('Lead Product Designer', {}).verdict, 'exclude');
t('"Staff Product Designer" excluded', gateTitle('Staff Product Designer', {}).verdict, 'exclude');
t('"Senior Product Designer, Growth" accepted', gateTitle('Senior Product Designer, Growth', {}).verdict, 'accept');
t('"Product Designer, Design Systems" accepted', gateTitle('Product Designer, Design Systems', {}).verdict, 'accept');
t('"Sr. Product Designer" accepted', gateTitle('Sr. Product Designer', {}).verdict, 'accept');
t('"Product Designer II" accepted', gateTitle('Product Designer II', {}).verdict, 'accept');
t('"Principal Product Designer" excluded', gateTitle('Principal Product Designer', {}).verdict, 'exclude');
t('"Product Design Manager" excluded', gateTitle('Product Design Manager', {}).verdict, 'exclude');
t('bare "UX Designer" → review, not silent drop', gateTitle('UX Designer', {}).verdict, 'review');

