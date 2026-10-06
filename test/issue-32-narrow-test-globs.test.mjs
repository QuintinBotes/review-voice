/**
 * The default test globs are narrow (docs/adr/0012, amended 2026-10-06): a
 * production file they match goes uncounted, so names that only look like
 * tests stay counted unless they sit in a test directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';

const file = (path) => ({ path, status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true });

function patch(path) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1,1 @@', '+if (a) {}', ''].join('\n');
}

function assess(paths) {
  return assessComplexity(paths.map(patch).join(''), paths.map(file), { sensitivePaths: [] });
}

test('production files whose names look like tests are still counted', () => {
  const production = [
    'src/experiments/ab_test.py',
    'lib/split_test.rb',
    'src/main/java/ABTest.java',
    'src/LoadTest.java',
    'src/ABTests.cs',
    'api/spec/handlers.go',
    'test_utils.py',
    'src/Billing/LatestTest.kt',
  ];
  const result = assess(production);
  assert.equal(result.excluded.testFiles, 0);
  assert.equal(result.decisionPoints, production.length);
});

test('the same kinds of file in a test directory, and language test names, are left out', () => {
  const tests = [
    'tests/test_utils.py',
    'test/split_test.rb',
    'src/test/java/com/example/LoadTest.java',
    'src/Billing.Tests/InvoiceTests.cs',
    'src/Billing.UnitTests/InvoiceTests.cs',
    'spec/models/user_spec.rb',
    'lib/widget_spec.rb',
    'pkg/server/handler_test.go',
    'src/a.test.ts',
    'src/b.spec.tsx',
  ];
  const result = assess(tests);
  assert.equal(result.excluded.testFiles, tests.length);
  assert.equal(result.decisionPoints, 0);
});
