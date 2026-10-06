/**
 * #73: a conflicting replay leaked its conflict markers into diff.patch.
 *
 * A file the pull request no longer changes was read against the replay, whose
 * copy holds conflict markers, so the patch showed `-<<<<<<<` ... `->>>>>>>` as
 * removed code. On a stacked pull request whose parent branch was rewritten,
 * an analyst read that as the author dropping a feature in a bad merge. Such a
 * file is now listed as `noLongerChanged` and never read through the markers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';
import { diffSummary } from '../plugins/review-voice/src/cli.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/**
 * main; a parent branch that adds a feature at f.ts:5; this pull request,
 * stacked on the parent, changing only a.ts. Then the parent is rewritten
 * from main without the feature, changing f.ts:5 its own way, and this pull
 * request is rebased onto the rewritten parent with its own commit unchanged.
 */
function withRewrittenParent(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-73-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, contents) => writeFileSync(join(root, path), contents);
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    write('a.ts', lines(20, 'a'));
    write('f.ts', lines(20, 'f'));
    commit('initial');

    git('checkout', '-q', '-b', 'parent');
    write('f.ts', lines(20, 'f').replace('f 5\n', 'f 5 with the feature\n'));
    commit('parent adds the feature');
    git('checkout', '-q', '-b', 'pr');
    write('a.ts', lines(20, 'a').replace('a 9\n', 'a 9 by the author\n'));
    const reviewed = commit('author work');

    // The parent is rewritten without the feature, and the pull request is
    // rebased onto it: the author's own commit is the same change.
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-B', 'parent');
    write('f.ts', lines(20, 'f').replace('f 5\n', 'f 5 reworked by the parent\n'));
    const parent = commit('parent, rewritten');
    git('checkout', '-q', '-B', 'pr');
    write('a.ts', lines(20, 'a').replace('a 9\n', 'a 9 by the author\n'));
    const head = commit('author work, rebased');

    return fn({ root, reviewed, parent, head });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan({ root, reviewed, parent, head }) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head,
    headAvailable: true,
    reviewedFiles: [{ path: 'a.ts' }],
    cwd: root,
    truncated: false,
    forceFull: false,
    base: parent,
  });
}

test('a file only the rewritten parent changed is listed, and no conflict marker reaches the patch', () => {
  withRewrittenParent((repository) => {
    const { scope, interdiffPatch } = plan(repository);
    assert.notEqual(scope.kind, 'full', JSON.stringify(scope));
    assert.deepEqual(scope.noLongerChanged, ['f.ts'], JSON.stringify(scope));
    assert.doesNotMatch(interdiffPatch ?? '', /<<<<<<<|>>>>>>>/);
    assert.doesNotMatch(interdiffPatch ?? '', /feature/);
  });
});

test('the diff summary carries noLongerChanged, and an empty list when there is none', () => {
  withRewrittenParent((repository) => {
    const { scope } = plan(repository);
    const summary = diffSummary({ diff: '', mode: 'pull-request', base: repository.parent, head: repository.head, reviewedFileCount: 1, hunkFileCount: 0, excludedFileCount: 0, scope });
    assert.deepEqual(summary.noLongerChanged, ['f.ts']);
  });
  const local = diffSummary({ diff: '', mode: 'worktree', base: null, head: 'HEAD', reviewedFileCount: 0, hunkFileCount: 0, excludedFileCount: 0 });
  assert.deepEqual(local.noLongerChanged, []);
});
