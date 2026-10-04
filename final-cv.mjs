#!/usr/bin/env node
/**
 * final-cv.mjs — the ONE CV file uploaded on every application.
 *
 * The user has a single final CV and does not want Career Ops to generate,
 * tailor, or substitute one. Its location and SHA-256 live in
 * data/application-answers.yml (`cv.final_path`, `cv.final_sha256`), and every
 * script that attaches a CV gets the path from here. A file whose bytes do not
 * match the recorded hash is refused, so a regenerated PDF that lands at the
 * same path can never be uploaded in its place.
 *
 * cv.md stays the TEXT source for fit scoring and answer facts; it is a
 * transcription of this PDF, never something rendered into an upload.
 *
 * Usage:
 *   node final-cv.mjs           # verify, print path + hash, exit 0/1
 *   import { finalCv } from './final-cv.mjs'; finalCv().path
 */
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { basename } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

export const BANK_PATH = 'data/application-answers.yml';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Returns { path, filename, sha256 }; throws when unset, missing, or altered. */
export function finalCv(bank = yaml.load(readFileSync(BANK_PATH, 'utf8'))) {
  const path = bank?.cv?.final_path;
  const want = String(bank?.cv?.final_sha256 || '').toLowerCase();
  if (!path || !want) throw new Error(`final CV not configured: set cv.final_path and cv.final_sha256 in ${BANK_PATH}`);
  if (!existsSync(path)) throw new Error(`final CV missing: ${path}`);
  const got = sha256(path);
  if (got !== want) throw new Error(`final CV altered: ${path} hashes ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}… — refusing to upload a different file`);
  return { path, filename: basename(path), sha256: got };
}

if (isMainModule(import.meta.url)) {
  try {
    const cv = finalCv();
    console.log(`✓ final CV  ${cv.path}\n  sha256    ${cv.sha256}\n  uploaded as "${cv.filename}"`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
