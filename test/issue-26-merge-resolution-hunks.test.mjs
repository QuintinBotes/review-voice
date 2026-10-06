/**
 * #26: a merge whose conflict resolution rewrote the pull request's own code.
 *
 * A conflicted file was read as the pull request's whole own diff of it, so a
 * one-line resolution in a long file re-read every hunk the earlier review
 * had covered. It is now cut to the hunks the resolution touched, and read
 * whole only when the resolution cannot be matched to hunks, which the scope
 * note says. A file the pull request no longer changes because the base made
 * the same change is listed rather than silently gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope, narrowToResolution, parseReviewScope } from '../plugins/review-voice/src/diff/incremental.ts';
import { applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';
import { diffSummary } from '../plugins/review-voice/src/cli.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/** A pull request whose reviewed head edits lines 5 and 300 of src/a.ts. */
function withPullRequest(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-26-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const edit = (path, from, to) => {
    const current = read(path);
    assert.ok(current.includes(from), `${path} holds ${JSON.stringify(from)}`);
    write(path, current.replace(from, to));
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'merge.conflictStyle', 'merge');
  write('src/a.ts', lines(400, 'a'));
  write('src/b.ts', lines(20, 'b'));
  commit('initial');

  git('checkout', '-q', '-b', 'pr');
  edit('src/a.ts', 'a 5\n', 'a 5 by the author\n');
  edit('src/a.ts', 'a 300\n', 'a 300 by the author\n');
  const reviewed = commit('author work');

  try {
    return fn({ root, git, write, read, edit, commit, reviewed, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, reviewedFiles = ['src/a.ts']) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: repository.reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles: reviewedFiles.map((path) => ({ path })),
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.git('rev-parse', 'main').trim(),
  });
}

/** Main rewrites line 5, which the pull request also changed, so a merge conflicts there. */
function baseRewritesLine5(repository) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/a.ts', 'a 5\n', 'a 5 rewritten on main\n');
  repository.commit('base rewrites line 5');
  repository.git('checkout', '-q', 'pr');
  assert.throws(() => repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main'));
}

test('a conflicted file is cut to the hunk its resolution touched', () => {
  withPullRequest((repository) => {
    baseRewritesLine5(repository);
    repository.write('src/a.ts', lines(400, 'a').replace('a 5\n', 'a 5 resolved by the author\n').replace('a 300\n', 'a 300 by the author\n'));
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.equal(scope.hunks, 1);
    assert.match(interdiffPatch, /^\+a 5 resolved by the author$/m);
    // The reviewed hunk the resolution did not touch is not read again.
    assert.doesNotMatch(interdiffPatch, /a 300/);
    assert.doesNotMatch(interdiffPatch, /<<<<<<<|>>>>>>>/);
    assert.match(scope.detail, /^narrowed to the merge resolution after a conflicting replay: src\/a\.ts$/);
  });
});

test('an edit made in a clean part of a conflicted file while resolving is kept', () => {
  withPullRequest((repository) => {
    baseRewritesLine5(repository);
    repository.write(
      'src/a.ts',
      lines(400, 'a')
        .replace('a 5\n', 'a 5 resolved by the author\n')
        .replace('a 150\n', 'a 150 slipped into the merge\n')
        .replace('a 300\n', 'a 300 by the author\n'),
    );
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.equal(scope.hunks, 2);
    assert.match(interdiffPatch, /^\+a 5 resolved by the author$/m);
    assert.match(interdiffPatch, /^\+a 150 slipped into the merge$/m);
    assert.doesNotMatch(interdiffPatch, /a 300/);
  });
});

test('a resolution that cannot be matched to hunks reads the file whole, and the scope note says so', () => {
  withPullRequest((repository) => {
    baseRewritesLine5(repository);
    // The base's side is taken at line 5: no own diff is left there, so that
    // part of the resolution has no hunk to be cut to.
    repository.write('src/a.ts', lines(400, 'a').replace('a 5\n', 'a 5 rewritten on main\n').replace('a 300\n', 'a 300 by the author\n'));
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(interdiffPatch, /^\+a 300 by the author$/m);
    assert.match(scope.detail, /read whole after a conflicting replay, as its resolution could not be matched to hunks: src\/a\.ts/);

    const scoped = applyReviewScope(acquired(repository), 7, scope, repository.root, undefined, interdiffPatch);
    assert.match(scoped.scopeNote, /could not be matched to hunks: src\/a\.ts\.$/);
    assert.equal(diffSummary({ ...scoped, mode: 'pull-request' }).scope.detail, scope.detail);
  });
});

test('a file the base now changes the same way is listed as absorbed, not reviewed', () => {
  withPullRequest((repository) => {
    repository.edit('src/b.ts', 'b 3\n', 'b 3 shared fix\n');
    repository.reviewed = repository.commit('author fixes b');

    repository.git('checkout', '-q', 'main');
    repository.edit('src/b.ts', 'b 3\n', 'b 3 shared fix\n');
    repository.edit('src/a.ts', 'a 200\n', 'a 200 on main\n');
    repository.commit('the base lands the same fix');
    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    repository.edit('src/a.ts', 'a 100\n', 'a 100 after the review\n');
    repository.commit('more author work');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.deepEqual(scope.absorbedByBase, ['src/b.ts']);
    assert.doesNotMatch(interdiffPatch, /b\.ts|on main/);
    assert.deepEqual(parseReviewScope(JSON.parse(JSON.stringify(scope))), scope);

    const scoped = applyReviewScope(acquired(repository), 7, scope, repository.root, undefined, interdiffPatch);
    assert.deepEqual(diffSummary({ ...scoped, mode: 'pull-request' }).absorbedByBase, ['src/b.ts']);
  });
});

test('a merge that only absorbs a change is unchanged, and still lists the file', () => {
  withPullRequest((repository) => {
    repository.edit('src/b.ts', 'b 3\n', 'b 3 shared fix\n');
    repository.reviewed = repository.commit('author fixes b');

    repository.git('checkout', '-q', 'main');
    repository.edit('src/b.ts', 'b 3\n', 'b 3 shared fix\n');
    repository.commit('the base lands the same fix');
    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');

    const { scope } = plan(repository);
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.deepEqual(scope.absorbedByBase, ['src/b.ts']);
  });
});

test('a withdrawal with no base move is shown, never listed as absorbed', () => {
  withPullRequest((repository) => {
    repository.edit('src/b.ts', 'b 3\n', 'b 3 by the author\n');
    repository.reviewed = repository.commit('author edits b');
    repository.edit('src/b.ts', 'b 3 by the author\n', 'b 3\n');
    repository.commit('author withdraws it');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.equal(scope.absorbedByBase, undefined);
    assert.match(interdiffPatch, /^-b 3 by the author$/m);
  });
});

test('narrowing refuses a resolution hunk that meets no own-diff hunk, and a missing resolution', () => {
  const own = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -10,3 +10,3 @@', ' x 9', '-x 10', '+x 10 own', ' x 11', ''].join('\n');
  const away = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -40,7 +40,1 @@', '-<<<<<<< ours', ''].join('\n');
  const near = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -8,7 +11,1 @@', '-<<<<<<< ours', ''].join('\n');
  assert.equal(narrowToResolution(own, away), null);
  assert.equal(narrowToResolution(own, undefined), null);
  assert.equal(narrowToResolution(own, near), own);
});

function acquired(repository) {
  return {
    diff: 'diff --git a/src/a.ts b/src/a.ts\n',
    mode: 'pull-request',
    base: repository.git('rev-parse', 'main').trim(),
    head: repository.head(),
    title: 'Example',
    totalChangedFiles: 1,
    additions: 1,
    deletions: 1,
    truncated: false,
    truncationNote: null,
    refs: { base: { sha: 'b', available: true }, head: { sha: 'h', available: true }, mergeBase: null, note: null },
    files: [{ path: 'src/a.ts', status: 'modified', reviewed: true }],
    reviewedFileCount: 1,
    hunkFileCount: 1,
    excludedFileCount: 0,
  };
}
