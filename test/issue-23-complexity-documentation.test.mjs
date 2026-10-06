/**
 * Decision points are counted in production source only (docs/adr/0012,
 * amended 2026-10-06). Prose is full of `if`, `when` and `or`, and a Markdown
 * hunk was once named as the densest hunk of a change. Sensitive paths still
 * apply to documentation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity, humanReviewNote, parseComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { classify, isDocumentation } from '../plugins/review-voice/src/diff/classify.ts';

const file = (path, extra = {}) => ({
  path,
  status: 'modified',
  class: classify(path),
  language: null,
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

const prose = Array.from({ length: 10 }, () => 'If the entry point is missing, or when it moves, check the graph or the index.');

test('documentation files are recognised by extension and by conventional name', () => {
  for (const path of ['docs/guide.md', 'a/b/entry-points.MD', 'notes.rst', 'README', 'pkg/LICENSE', 'data/rows.csv', 'x.mdx']) {
    assert.equal(isDocumentation(path), true, path);
  }
  for (const path of ['src/a.ts', 'readme.ts', '.github/workflows/ci.yml', 'Makefile', 'Dockerfile', 'config.json']) {
    assert.equal(isDocumentation(path), false, path);
  }
});

test('a Markdown hunk adds no decision points and is never the densest hunk', () => {
  const diff = patch('pkg/knowledge/entry-points.md', prose, 250) + patch('src/a.ts', ['if (a) {}'], 3);
  const files = [file('pkg/knowledge/entry-points.md'), file('src/a.ts')];
  const result = assessComplexity(diff, files, { sensitivePaths: [], maxDecisionPoints: 5, maxHunkDecisionPoints: 2 });

  assert.equal(result.level, 'normal');
  assert.equal(result.decisionPoints, 1);
  assert.deepEqual(result.densestHunk, { path: 'src/a.ts', line: 3, decisionPoints: 1 });
  assert.equal(result.excluded.documentationFiles, 1);
});

test('the note names the documentation it left out, and sensitive paths still match documentation', () => {
  const files = [file('docs/security/policy.md'), file('docs/other.md')];
  const result = assessComplexity(patch('docs/security/policy.md', prose), files);
  assert.equal(result.decisionPoints, 0);
  assert.deepEqual(result.sensitivePaths, ['docs/security/policy.md']);
  assert.equal(result.level, 'high');
  assert.match(humanReviewNote(result), /Left out of the decision-point count: 2 documentation files\./);
});

test('an assessment recorded before exclusions were reported still parses, as excluding nothing', () => {
  const result = assessComplexity(patch('src/a.ts', ['if (a) {}']), [file('src/a.ts')]);
  const { excluded, ...older } = JSON.parse(JSON.stringify(result));
  assert.equal(parseComplexity(older).excluded.documentationFiles, 0);
  assert.equal(parseComplexity({ ...older, excluded: { documentationFiles: -1 } }), null);
});
