/**
 * The review's own configuration and the workflows stay sensitive whatever
 * `sensitive_paths` says (docs/adr/0012, amended 2026), each glob listed once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';

const file = (path) => ({ path, status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true });

function patch(path) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1,1 @@', '+x', ''].join('\n');
}

const assess = (paths, partial) => assessComplexity(paths.map(patch).join(''), paths.map(file), partial);

test('an empty sensitive_paths list still flags the review configuration and the workflows', () => {
  for (const path of ['.review-voice/config.yaml', '.github/workflows/x.yml']) {
    const result = assess([path], { sensitivePaths: [] });
    assert.equal(result.level, 'high', path);
    assert.deepEqual(result.sensitivePaths, [path], path);
  }
});

test('sensitive_exempt_paths cannot exempt the two protected globs, even with an empty list', () => {
  for (const path of ['.review-voice/config.yaml', '.github/workflows/x.yml']) {
    const result = assess([path], { sensitivePaths: [], sensitiveExemptPaths: ['**/*.yml', '.review-voice/**', '.github/workflows/**'] });
    assert.equal(result.level, 'high', path);
    assert.deepEqual(result.sensitivePaths, [path], path);
  }
});

test('a configured list matches its own paths and the two protected globs and nothing else', () => {
  const result = assess(
    ['src/billing/a.ts', '.review-voice/config.yaml', '.github/workflows/x.yml', 'src/other/b.ts'],
    { sensitivePaths: ['**/billing/**'] },
  );
  assert.deepEqual([...result.sensitivePaths].sort(), ['.github/workflows/x.yml', '.review-voice/config.yaml', 'src/billing/a.ts']);
});

test('limits.sensitivePaths holds each glob once', () => {
  const listed = assess(['src/a.ts'], { sensitivePaths: ['**/billing/**', '.review-voice/**'] }).limits.sensitivePaths;
  assert.deepEqual(listed, ['**/billing/**', '.review-voice/**', '.github/workflows/**']);
  assert.deepEqual(assess(['src/a.ts'], { sensitivePaths: [] }).limits.sensitivePaths, ['.review-voice/**', '.github/workflows/**']);
});
