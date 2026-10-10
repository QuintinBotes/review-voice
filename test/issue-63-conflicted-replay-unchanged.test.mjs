/**
 * #63: a base merge that conflicted but left the author's code as reviewed.
 *
 * A conflicted file was cut to the own-diff hunks its resolution touched, even
 * when the file was the same at the reviewed head and the new one, so a
 * stacked pull request whose lower half merged re-read code nobody changed.
 * Such a file now drops out, which leaves the scope `unchanged` when nothing
 * else moved, and a file that did change keeps only the hunks that changed
 * since the review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/** A pull request whose reviewed head edits lines 5 and 300 of src/a.ts. */
function withPullRequest(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-63-'));
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

/**
 * Main rewrites line 5, which the pull request also changed, so the merge
 * conflicts there; with `alsoLine100` it changes line 100 too, cleanly.
 */
function conflictingMerge(repository, { alsoLine100 = false } = {}) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/a.ts', 'a 5\n', 'a 5 rewritten on main\n');
  if (alsoLine100) repository.edit('src/a.ts', 'a 100\n', 'a 100 changed on main\n');
  repository.commit('base changes src/a.ts');
  repository.git('checkout', '-q', 'pr');
  assert.throws(() => repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main'));
}

const asReviewed = (base = lines(400, 'a')) =>
  base.replace('a 5\n', 'a 5 by the author\n').replace('a 300\n', 'a 300 by the author\n');

test('a conflicted file the same at both heads leaves the scope unchanged, as a base merge', () => {
  withPullRequest((repository) => {
    conflictingMerge(repository);
    repository.write('src/a.ts', asReviewed());
    repository.commit('merge main');
    assert.equal(repository.git('diff', repository.reviewed, 'HEAD', '--', 'src/a.ts'), '');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(scope.reason, 'base-merged');
    assert.equal(interdiffPatch, null);
  });
});

test("the base's clean change in a conflicted file does not bring back the author's reviewed hunks", () => {
  withPullRequest((repository) => {
    conflictingMerge(repository, { alsoLine100: true });
    repository.write('src/a.ts', asReviewed(lines(400, 'a').replace('a 100\n', 'a 100 changed on main\n')));
    repository.commit('merge main');

    const { scope } = plan(repository);
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(scope.reason, 'base-merged');
  });
});

test('a conflicted file keeps only the own hunks that changed since the review', () => {
  withPullRequest((repository) => {
    conflictingMerge(repository, { alsoLine100: true });
    repository.write(
      'src/a.ts',
      lines(400, 'a')
        .replace('a 5\n', 'a 5 by the author\n')
        .replace('a 100\n', 'a 100 changed on main\n')
        .replace('a 300\n', 'a 300 rewritten while merging\n'),
    );
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.equal(scope.hunks, 1);
    assert.match(interdiffPatch, /^\+a 300 rewritten while merging$/m);
    assert.doesNotMatch(interdiffPatch, /a 5 by the author/);
    assert.doesNotMatch(interdiffPatch, /a 100/);
    assert.match(scope.detail, /narrowed to the merge resolution after a conflicting replay: src\/a\.ts/);
  });
});

test('a conflicted file unchanged since the review drops out while another file still reads', () => {
  withPullRequest((repository) => {
    conflictingMerge(repository);
    repository.write('src/a.ts', asReviewed());
    repository.edit('src/b.ts', 'b 7\n', 'b 7 new since the review\n');
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository, ['src/a.ts', 'src/b.ts']);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/b.ts']);
    assert.doesNotMatch(interdiffPatch, /src\/a\.ts/);
    assert.equal(scope.detail, undefined);
  });
});

test("taking the base's side in a conflict still reads the file whole", () => {
  withPullRequest((repository) => {
    conflictingMerge(repository);
    repository.write('src/a.ts', lines(400, 'a').replace('a 5\n', 'a 5 rewritten on main\n').replace('a 300\n', 'a 300 by the author\n'));
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(interdiffPatch, /^\+a 300 by the author$/m);
    assert.match(scope.detail, /read whole after a conflicting replay/);
  });
});
