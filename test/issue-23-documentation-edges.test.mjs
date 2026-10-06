/**
 * Only real documentation is left out of the decision-point count
 * (docs/adr/0012, amended 2026-10-06). A text file that is a build script,
 * MDX that can carry components, and an extensionless script that happens to
 * share a documentation name are code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocumentation } from '../plugins/review-voice/src/diff/classify.ts';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';

test('CMakeLists.txt, MDX and extensionless names outside the root or docs are code', () => {
  for (const path of ['CMakeLists.txt', 'src/engine/CMakeLists.txt', 'site/pages/index.mdx', 'bin/changes', 'tools/notice', 'pkg/README']) {
    assert.equal(isDocumentation(path), false, path);
  }
});

test('extensionless documentation names at the root or under docs are documentation', () => {
  for (const path of ['README', 'LICENSE', 'CHANGES', 'docs/AUTHORS', 'project/doc/NOTICE', 'requirements.txt']) {
    assert.equal(isDocumentation(path), true, path);
  }
});

test('a build script named CMakeLists.txt is counted', () => {
  const path = 'CMakeLists.txt';
  const diff = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1,1 @@', '+if (WIN32 OR APPLE)', ''].join('\n');
  const changed = { path, status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true };
  const result = assessComplexity(diff, [changed], { sensitivePaths: [] });
  assert.equal(result.decisionPoints, 1);
  assert.equal(result.excluded.documentationFiles, 0);
});
