/**
 * Tests and fixtures are reviewed but left out of the decision-point count
 * (docs/adr/0012, amended 2026-10-06). Counting them made the cap shape how
 * tests were written: an author split one spec into several files to get a
 * hunk under the limit. The globs are configurable; sensitive paths still
 * apply to test files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessComplexity, humanReviewNote, parseComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const file = (path, extra = {}) => ({
  path,
  status: 'modified',
  class: 'source',
  language: 'typescript',
  additions: 1,
  deletions: 0,
  reviewed: true,
  ...extra,
});

function patch(path, added, start = 1) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${start},${added.length} @@`,
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}

const branchy = (n) => Array.from({ length: n }, () => 'if (a && b) { expect(x).toBe(y); }');

test('test and fixture files under the default globs add no decision points', () => {
  const paths = [
    'src/components/Widget.spec.tsx',
    'src/lib/parse.test.ts',
    'src/__tests__/a.ts',
    'test/helpers.mjs',
    'pkg/tests/b.py',
    'src/fixtures/widget-reader.ts',
    'cmd/main_test.go',
    'app/Services.Tests/OrderServiceTests.cs',
    'spec/models/user_spec.rb',
  ];
  const diff = paths.map((path) => patch(path, branchy(10))).join('') + patch('src/widget.ts', ['if (a) {}'], 4);
  const files = [...paths.map((path) => file(path)), file('src/widget.ts')];
  const result = assessComplexity(diff, files, { sensitivePaths: [] });

  assert.equal(result.level, 'normal');
  assert.equal(result.decisionPoints, 1);
  assert.deepEqual(result.densestHunk, { path: 'src/widget.ts', line: 4, decisionPoints: 1 });
  assert.equal(result.excluded.testFiles, paths.length);
  assert.equal(result.excluded.testDecisionPoints, paths.length * 20);
});

test('production files that merely mention tests are still counted', () => {
  const paths = ['src/testing-utils.ts', 'src/contest.ts', 'src/latest.ts', 'src/attestation/sign.ts'];
  const diff = paths.map((path) => patch(path, ['if (a) {}'])).join('');
  const result = assessComplexity(diff, paths.map((path) => file(path)), { sensitivePaths: [] });
  assert.equal(result.decisionPoints, 4);
  assert.equal(result.excluded.testFiles, 0);
});

test('the note names the production hunk and the tests it left out; sensitive paths still match tests', () => {
  const diff = patch('src/auth/login.spec.ts', branchy(30)) + patch('src/auth/login.ts', branchy(8), 12);
  const files = [file('src/auth/login.spec.ts'), file('src/auth/login.ts')];
  const result = assessComplexity(diff, files);

  assert.equal(result.decisionPoints, 16);
  assert.deepEqual(result.sensitivePaths, ['src/auth/login.spec.ts', 'src/auth/login.ts']);
  assert.match(result.reasons.join('; '), /16 decision points in one hunk at src\/auth\/login\.ts:12/);
  const note = humanReviewNote(result);
  assert.doesNotMatch(note, /login\.spec\.ts:/);
  assert.match(note, /Left out of the decision-point count: 1 test file \(60 decision points\)\./);
});

test('configured globs replace the defaults, and an empty list counts tests again', () => {
  const diff = patch('src/a.spec.ts', branchy(1)) + patch('checks/a.ts', branchy(1));
  const files = [file('src/a.spec.ts'), file('checks/a.ts')];

  const custom = assessComplexity(diff, files, { sensitivePaths: [], testPaths: ['checks/**'] });
  assert.equal(custom.decisionPoints, 2);
  assert.equal(custom.excluded.testFiles, 1);
  assert.deepEqual(custom.limits.testPaths, ['checks/**']);

  const none = assessComplexity(diff, files, { sensitivePaths: [], testPaths: [] });
  assert.equal(none.decisionPoints, 4);
  assert.equal(none.excluded.testFiles, 0);
});

test('review.human_review.test_paths is read from config, with a warning for a non-list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-32-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    const configPath = join(dir, '.review-voice', 'config.yaml');
    writeFileSync(configPath, 'review:\n  human_review:\n    test_paths: ["qa/**"]\n');
    assert.deepEqual(loadConfig(dir).humanReview.testPaths, ['qa/**']);

    writeFileSync(configPath, 'review:\n  human_review:\n    test_paths: []\n');
    assert.deepEqual(loadConfig(dir).humanReview.testPaths, []);

    writeFileSync(configPath, 'review:\n  human_review:\n    test_paths: "qa/**"\n');
    const bad = loadConfig(dir);
    assert.ok(bad.humanReview.testPaths.includes('**/*.spec.*'));
    assert.equal(bad.warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the test counts and globs round-trip, and an older record without them still parses', () => {
  const result = assessComplexity(patch('src/a.test.ts', branchy(2)), [file('src/a.test.ts')]);
  assert.deepEqual(parseComplexity(JSON.parse(JSON.stringify(result))), result);

  const older = JSON.parse(JSON.stringify(result));
  delete older.excluded.testFiles;
  delete older.excluded.testDecisionPoints;
  delete older.limits.testPaths;
  const parsed = parseComplexity(older);
  assert.equal(parsed.excluded.testFiles, 0);
  assert.deepEqual(parsed.limits.testPaths, []);
  assert.equal(parseComplexity({ ...result, limits: { ...result.limits, testPaths: 'x' } }), null);
});
