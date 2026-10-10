/**
 * A sensitive glob that matches a directory name raised cosmetic changes under
 * it (#70): the reason names the glob that matched, and a repository can opt
 * in to exempting paths, except its own configuration and its workflows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessComplexity, humanReviewNote, parseComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const file = (path) => ({
  path,
  status: 'modified',
  class: 'source',
  language: 'typescript',
  additions: 1,
  deletions: 0,
  reviewed: true,
});

const BANNER = 'modules/auth/src/layouts/Banner.tsx';
const EXEMPT = { sensitiveExemptPaths: ['**/auth/src/layouts/**'] };

test('by default a path under auth/ is still high, and the reason names the glob that matched', () => {
  const result = assessComplexity('', [file(BANNER)]);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.reasons, [`touches sensitive paths (${BANNER} matched **/auth/**)`]);
  assert.deepEqual(result.sensitivePaths, [BANNER]);
  assert.deepEqual(result.sensitiveMatches, [{ path: BANNER, glob: '**/auth/**' }]);
  assert.deepEqual(result.sensitiveExempted, []);
});

test('the first matching glob in config order is the one named', () => {
  const result = assessComplexity('', [file('db/migrations/auth/x.sql')], { sensitivePaths: ['**/auth/**', '**/migrations/**'] });
  assert.deepEqual(result.sensitiveMatches, [{ path: 'db/migrations/auth/x.sql', glob: '**/auth/**' }]);
});

test('an exempt glob makes the same change normal, lists it, and leaves no note', () => {
  const result = assessComplexity('', [file(BANNER)], EXEMPT);
  assert.equal(result.level, 'normal');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.sensitivePaths, []);
  assert.deepEqual(result.sensitiveExempted, [BANNER]);
  assert.deepEqual(result.limits.sensitiveExemptPaths, ['**/auth/src/layouts/**']);
  assert.equal(humanReviewNote(result), null);
});

test('an exempted path beside a non-exempt auth path stays high and both are listed', () => {
  const result = assessComplexity('', [file(BANNER), file('modules/auth/src/login.ts')], EXEMPT);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.sensitivePaths, ['modules/auth/src/login.ts']);
  assert.deepEqual(result.sensitiveExempted, [BANNER]);
  assert.deepEqual(result.reasons, ['touches sensitive paths (modules/auth/src/login.ts matched **/auth/**)']);
  assert.match(humanReviewNote(result), new RegExp(`\\. Exempted by sensitive_exempt_paths: ${BANNER.replaceAll('.', '\\.')}\\. Review Voice`));
});

test('the exempted clause lists three and counts the rest', () => {
  const banners = ['a', 'b', 'c', 'd', 'e'].map((name) => file(`modules/auth/src/layouts/${name}.tsx`));
  const result = assessComplexity('', [...banners, file('modules/auth/src/login.ts')], EXEMPT);
  assert.match(humanReviewNote(result), /Exempted by sensitive_exempt_paths: modules\/auth\/src\/layouts\/a\.tsx, .*b\.tsx, .*c\.tsx, \+2 more\./);
});

test('an exemption cannot reach the review configuration or a workflow', () => {
  for (const path of ['.review-voice/config.yaml', '.github/workflows/ci.yml']) {
    const result = assessComplexity('', [file(path)], { sensitiveExemptPaths: ['.review-voice/**', '.github/**'] });
    assert.equal(result.level, 'high', path);
    assert.deepEqual(result.sensitivePaths, [path]);
    assert.deepEqual(result.sensitiveExempted, []);
    assert.ok(result.reasons.some((reason) => reason.includes(`does not apply to ${path}`)), path);
  }
});

test('a catch-all exempt glob is ignored and reported, only when it would exempt a path of the change', () => {
  const result = assessComplexity('', [file(BANNER)], { sensitiveExemptPaths: ['**'] });
  assert.equal(result.level, 'high');
  assert.equal(result.reasons[0], 'ignored sensitive_exempt_paths glob "**", which matches ordinary source files');
  assert.deepEqual(result.sensitivePaths, [BANNER]);
  assert.deepEqual(result.sensitiveExempted, []);

  // Nothing sensitive in the change: the glob exempts nothing, so there is nothing to report.
  assert.deepEqual(assessComplexity('', [file('src/plain.ts')], { sensitiveExemptPaths: ['**'] }).reasons, []);
});

// ---- configuration and the recorded assessment -----------------------------

function configIn(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-exempt-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sensitive_exempt_paths defaults to none, parses a list, and warns on a non-list', () => {
  assert.deepEqual(configIn('review:\n  max_findings: 5\n').humanReview.sensitiveExemptPaths, []);

  const set = configIn('review:\n  human_review:\n    sensitive_exempt_paths: ["**/auth/src/layouts/**"]\n');
  assert.deepEqual(set.humanReview.sensitiveExemptPaths, ['**/auth/src/layouts/**']);
  assert.deepEqual(set.warnings, []);

  const notList = configIn('review:\n  human_review:\n    sensitive_exempt_paths: "**/layouts/**"\n');
  assert.deepEqual(notList.humanReview.sensitiveExemptPaths, []);
  assert.equal(notList.warnings.length, 1);
  assert.match(notList.warnings[0], /sensitive_exempt_paths must be a list/);
});

test('parseComplexity accepts a record without the new fields and round-trips one with them', () => {
  const current = assessComplexity('', [file(BANNER), file('modules/auth/src/login.ts')], EXEMPT);
  const old = JSON.parse(JSON.stringify(current));
  delete old.sensitiveMatches;
  delete old.sensitiveExempted;
  delete old.limits.sensitiveExemptPaths;
  const parsed = parseComplexity(old);
  assert.deepEqual(parsed.sensitiveMatches, []);
  assert.deepEqual(parsed.sensitiveExempted, []);
  assert.deepEqual(parsed.limits.sensitiveExemptPaths, []);

  assert.deepEqual(parseComplexity(JSON.parse(JSON.stringify(current))), current);
  assert.equal(parseComplexity({ ...current, sensitiveMatches: [{ path: 'a' }] }), null);
  assert.equal(parseComplexity({ ...current, sensitiveExempted: 'a' }), null);
  assert.equal(parseComplexity({ ...current, limits: { ...current.limits, sensitiveExemptPaths: 'a' } }), null);
});
