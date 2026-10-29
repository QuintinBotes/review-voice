/**
 * Complexity and the human-review note follow the diff scope.
 *
 * A pull request touched a sensitive path in its first commit; the follow-up
 * edits one documentation file. An interdiff review reads only that file, so
 * its flag must not name the earlier commit's sensitive path. The full scope
 * still names it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';
import { emitDiff } from '../plugins/review-voice/src/cli.ts';

const file = (path, reviewed = true) => ({
  path,
  status: 'modified',
  class: 'source',
  language: null,
  additions: 1,
  deletions: 0,
  reviewed,
});

const INTERDIFF = [
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1,1 +1,2 @@',
  ' guide',
  '+more words',
  '',
].join('\n');

function emit(scope, interdiffPatch) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-225-'));
  const saved = { cwd: process.cwd(), log: console.log };
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/guide.md'), 'guide\n');
    process.chdir(dir);
    const full = {
      repositoryRoot: dir,
      mode: 'pull-request',
      base: 'main',
      head: 'a'.repeat(40),
      files: [file('.github/workflows/ci.yml'), file('docs/guide.md')],
      reviewedFileCount: 2,
      hunkFileCount: 2,
      excludedFileCount: 0,
      diff: INTERDIFF,
      title: 't',
      totalChangedFiles: 2,
      additions: 2,
      deletions: 0,
      truncated: false,
      truncationNote: null,
      refs: { head: true, base: true },
      suspectedWrongBase: null,
      squashedParentSuspected: null,
    };
    const scoped = applyReviewScope(full, 7, scope, dir, undefined, interdiffPatch);
    let out = '';
    console.log = (text) => void (out += text);
    emitDiff(scoped, null);
    return JSON.parse(out);
  } finally {
    console.log = saved.log;
    process.chdir(saved.cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

const since = 'b'.repeat(40);
const interdiff = {
  kind: 'interdiff',
  since,
  priorRunId: null,
  priorReviewedAt: null,
  mergeBase: 'c'.repeat(40),
  files: ['docs/guide.md'],
  hunks: 1,
};

test('an interdiff over a docs file is not flagged for an earlier commit\'s sensitive path', () => {
  const result = emit(interdiff, INTERDIFF);
  assert.equal(result.scope.kind, 'interdiff');
  assert.equal(result.complexity.level, 'normal');
  assert.deepEqual(result.complexity.sensitivePaths, []);
  assert.equal(result.humanReviewNote, null);
});

test('the full scope still names the sensitive path', () => {
  const result = emit({ kind: 'full', cause: 'no-prior-review', since: null, priorRunId: null }, null);
  assert.equal(result.complexity.level, 'high');
  assert.deepEqual(result.complexity.sensitivePaths, ['.github/workflows/ci.yml']);
  assert.match(result.humanReviewNote, /workflows/);
});
