/**
 * Exclusion globs come from the checked-out tree, so a change could widen
 * them to cover itself (docs/adr/0012, amended 2026-10-06). A catch-all glob is
 * ignored with a reason, and the review's own configuration is a sensitive
 * path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity, DEFAULT_SENSITIVE_PATHS } from '../plugins/review-voice/src/diff/complexity.ts';

const file = (path) => ({ path, status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true });

function patch(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

const branchy = (n) => Array.from({ length: n }, () => 'if (a && b) {}');

test('a catch-all test or generated glob is ignored and named in the reasons', () => {
  for (const [key, partial] of [
    ['test_paths', { testPaths: ['**'] }],
    ['generated_paths', { generatedPaths: ['**'] }],
    ['generated_paths', { generatedPaths: ['src/**'] }],
    ['test_paths', { testPaths: ['**/*.go'] }],
  ]) {
    const path = key === 'test_paths' && partial.testPaths[0] === '**/*.go' ? 'pkg/api/server.go' : 'src/a.ts';
    const result = assessComplexity(patch(path, branchy(2)), [file(path)], { sensitivePaths: [], ...partial });
    const glob = (partial.testPaths ?? partial.generatedPaths)[0];
    assert.equal(result.decisionPoints, 4, glob);
    assert.equal(result.excluded.testFiles + result.excluded.generatedFiles, 0, glob);
    assert.equal(result.level, 'high', glob);
    assert.deepEqual(result.reasons, [`ignored ${key} glob "${glob}", which matches ordinary source files`]);
  }
});

test('a narrow glob still applies, and a test-only change is not raised for it', () => {
  const result = assessComplexity(patch('src/a.spec.ts', branchy(30)), [file('src/a.spec.ts')], { sensitivePaths: [] });
  assert.equal(result.level, 'normal');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.excluded.testFiles, 1);

  const generated = assessComplexity(patch('gen/client.ts', branchy(30)), [file('gen/client.ts')], {
    sensitivePaths: [],
    generatedPaths: ['gen/**'],
  });
  assert.equal(generated.level, 'normal');
  assert.equal(generated.excluded.generatedFiles, 1);
});

test('a catch-all glob that would exclude nothing in this change adds no reason', () => {
  const result = assessComplexity(patch('docs/a.md', ['text']), [file('docs/a.md')], { sensitivePaths: [], testPaths: ['**'] });
  assert.equal(result.level, 'normal');
});

test('a change to the review configuration is a sensitive path by default', () => {
  assert.ok(DEFAULT_SENSITIVE_PATHS.includes('.review-voice/**'));
  const result = assessComplexity('', [file('.review-voice/config.yaml'), file('src/a.ts')]);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.sensitivePaths, ['.review-voice/config.yaml']);
});
