/**
 * A follow-up after a merged base or a rebase reads what the author changed
 * since the review, and nothing the base brought in.
 *
 * The reviewed head is replayed onto the new merge base - what the reviewed
 * pull request would look like had it branched there - and the head is read
 * against that. Matching own-diff hunks before and after instead read a base
 * change that only brought two reviewed hunks within diff context of each
 * other as a reverted hunk, and fell back to reading the whole pull request.
 *
 * The plain follow-up cases at the end cover the files a follow-up is read
 * over: both paths of an undone rename, a deleted file, and no files at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';
import { applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/**
 * `main`, and a pull-request branch `pr` whose reviewed head edits lines 5 and
 * 13 of src/a.ts: two hunks, seven unchanged lines apart.
 */
function withPullRequest(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-merge-delta-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const edit = (path, from, to) => {
    const current = readFileSync(join(root, path), 'utf8');
    assert.ok(current.includes(from), `${path} holds ${JSON.stringify(from)}`);
    write(path, current.replace(from, to));
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('src/a.ts', lines(40, 'a'));
  write('src/b.ts', lines(10, 'b'));
  write('src/base-only.ts', lines(5, 'base'));
  commit('initial');

  git('checkout', '-q', '-b', 'pr');
  edit('src/a.ts', 'a 5\n', 'a 5 by the author\n');
  edit('src/a.ts', 'a 13\n', 'a 13 by the author\n');
  const reviewed = commit('author work');

  try {
    return fn({ root, git, write, edit, commit, reviewed, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, overrides = {}) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: repository.reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.git('rev-parse', 'main').trim(),
    ...overrides,
  });
}

/**
 * Moves `main` on: drops lines 9 and 10 of src/a.ts, which brings the two
 * reviewed hunks within diff context of each other without touching either,
 * edits line 35 of src/a.ts, and edits a file the pull request never touches.
 */
function advanceBase(repository) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/a.ts', 'a 9\na 10\n', '');
  repository.edit('src/a.ts', 'a 35\n', 'a 35 changed on main\n');
  repository.edit('src/base-only.ts', 'base 1\n', 'base 1 moved on main\n');
  repository.commit('base moves on');
  repository.git('checkout', '-q', 'pr');
}

/** No line the base changed is in the patch as a change. */
function holdsNoBaseChange(patch) {
  assert.doesNotMatch(patch, /on main/);
  assert.doesNotMatch(patch, /^[-+]a (9|10|35)$/m);
  assert.doesNotMatch(patch, /base-only/);
}

test('(a) a base merge with no author change since the review is unchanged', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(scope.reason, 'base-merged');
    assert.equal(scope.mergeBase, repository.git('rev-parse', 'main').trim());
    assert.equal(interdiffPatch, null);
  });
});

/** Merges main without committing, rewrites a reviewed line, then commits. */
function mergeRewritingLine5(repository) {
  repository.git('merge', '-q', '--no-ff', '--no-commit', 'main');
  repository.edit('src/a.ts', 'a 5 by the author\n', 'a 5 by the author, fixed in the merge\n');
  repository.commit('merge main');
}

test('(b) a merge whose resolution rewrites a reviewed line reads that rewrite and no base change', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    mergeRewritingLine5(repository);

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.equal(scope.hunks, 1);
    assert.match(interdiffPatch, /^-a 5 by the author$/m);
    assert.match(interdiffPatch, /^\+a 5 by the author, fixed in the merge$/m);
    // The other reviewed line did not change and is not read again.
    assert.doesNotMatch(interdiffPatch, /^[-+]a 13/m);
    holdsNoBaseChange(interdiffPatch);
  });
});

test('(c) a merge plus a new author commit reads both the rewrite and the commit', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    mergeRewritingLine5(repository);
    repository.edit('src/b.ts', 'b 3\n', 'b 3 after the review\n');
    repository.commit('more author work');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts', 'src/b.ts']);
    assert.match(interdiffPatch, /^\+a 5 by the author, fixed in the merge$/m);
    assert.match(interdiffPatch, /^\+b 3 after the review$/m);
    holdsNoBaseChange(interdiffPatch);
  });
});

test('(d) a rebase onto a newer base with an edited reviewed line reads that edit only', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('rebase', '-q', 'main');
    repository.edit('src/a.ts', 'a 13 by the author\n', 'a 13 edited after the rebase\n');
    repository.git('add', '-A');
    repository.git('commit', '-q', '--amend', '--no-edit');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.match(interdiffPatch, /^-a 13 by the author$/m);
    assert.match(interdiffPatch, /^\+a 13 edited after the rebase$/m);
    assert.doesNotMatch(interdiffPatch, /^[-+]a 5/m);
    holdsNoBaseChange(interdiffPatch);
  });
});

/** Main edits reviewed line 5 and a file the pull request never touches. */
function baseEditsLine5(repository) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/a.ts', 'a 5\n', 'a 5 changed on main\n');
  repository.edit('src/base-only.ts', 'base 1\n', 'base 1 moved on main\n');
  repository.commit('base edits the reviewed line');
  repository.git('checkout', '-q', 'pr');
}

/** Merges main, which conflicts on line 5, and commits `resolved` as src/a.ts. */
function mergeResolving(repository, resolved) {
  assert.throws(() => repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main'));
  repository.write('src/a.ts', resolved);
  repository.commit('merge main');
}

test('(e) a merge whose conflict the author resolves by rewriting their own line reads that resolution', () => {
  withPullRequest((repository) => {
    baseEditsLine5(repository);
    mergeResolving(repository, lines(40, 'a').replace('a 5\n', 'a 5 resolved by the author\n').replace('a 13\n', 'a 13 by the author\n'));

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.match(scope.detail, /narrowed to the merge resolution after a conflicting replay: src\/a\.ts/);
    assert.match(interdiffPatch, /^\+a 5 resolved by the author$/m);
    // No conflict markers: the conflicted file is read against the new base.
    assert.doesNotMatch(interdiffPatch, /<<<<<<<|>>>>>>>/);
    // The base's change in a file the pull request does not touch stays out.
    assert.doesNotMatch(interdiffPatch, /base-only|moved on main/);
  });
});

test('(e) a conflicted file the author resolves by dropping all their changes is listed, never read through conflict markers', () => {
  withPullRequest((repository) => {
    baseEditsLine5(repository);
    mergeResolving(repository, lines(40, 'a').replace('a 5\n', 'a 5 changed on main\n'));

    // The pull request no longer changes src/a.ts, so its own diff there is
    // empty. The replay's marker diff was the only other place it showed, and
    // markers read as a bad resolution (#73): it is listed instead.
    const { scope, interdiffPatch } = plan(repository, { reviewedFiles: [{ path: 'src/b.ts' }] });
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.deepEqual(scope.noLongerChanged, ['src/a.ts']);
    assert.equal(interdiffPatch, null);
  });
});

test('(f) a base change in a file the pull request touches is not in the patch', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    repository.edit('src/a.ts', 'a 20\n', 'a 20 after the review\n');
    repository.commit('more author work in the same file');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.equal(scope.hunks, 1);
    assert.match(interdiffPatch, /^\+a 20 after the review$/m);
    assert.doesNotMatch(interdiffPatch, /^[-+]a (5|13)/m);
    holdsNoBaseChange(interdiffPatch);
  });
});

// The files a plain follow-up is read over.

test('a plain follow-up that undoes a rename shows the old path coming back', () => {
  withPullRequest((repository) => {
    repository.git('checkout', '-q', 'main');
    repository.write('src/old-name.ts', lines(6, 'named'));
    repository.commit('a file to rename');
    repository.git('checkout', '-q', 'pr');
    repository.git('rebase', '-q', 'main');
    repository.git('mv', 'src/old-name.ts', 'src/new-name.ts');
    const renamed = repository.commit('rename');
    repository.git('mv', 'src/new-name.ts', 'src/old-name.ts');
    repository.commit('undo the rename');

    // The head no longer renames anything, so the full read lists src/a.ts only.
    const { scope, interdiffPatch } = plan({ ...repository, reviewed: renamed }, { reviewedFiles: [{ path: 'src/a.ts' }] });
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(interdiffPatch, /^(?:rename to src\/old-name\.ts|\+\+\+ b\/src\/old-name\.ts)$/m);
    assert.ok(scope.files.includes('src/old-name.ts'), JSON.stringify(scope.files));
  });
});

test('a plain follow-up that deletes a file the pull request modified shows the deletion', () => {
  withPullRequest((repository) => {
    repository.edit('src/b.ts', 'b 3\n', 'b 3 by the author\n');
    const reviewed = repository.commit('author work on b');
    repository.git('rm', '-q', 'src/b.ts');
    repository.commit('delete b');

    // A deleted file is not reviewed in a full read; it comes in as deleted.
    const { scope, interdiffPatch } = plan(
      { ...repository, reviewed },
      { reviewedFiles: [{ path: 'src/a.ts' }], deletedFiles: ['src/b.ts'] },
    );
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/b.ts']);
    assert.match(interdiffPatch, /^deleted file mode/m);
    assert.match(interdiffPatch, /^-b 3 by the author$/m);
  });
});

test('a plain follow-up with no pull request files to read is unchanged, never the whole range', () => {
  withPullRequest((repository) => {
    repository.edit('src/base-only.ts', 'base 2\n', 'base 2 outside the reviewed files\n');
    repository.commit('a change in no reviewed file');

    const { scope, interdiffPatch } = plan(repository, { reviewedFiles: [] });
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(interdiffPatch, null);
  });
});

test('an interdiff that only deletes a file is still a review of that file', () => {
  const file = (path, status, reviewed) => ({
    path,
    status,
    class: 'source',
    language: 'TypeScript',
    additions: 0,
    deletions: 10,
    reviewed,
    ...(reviewed ? {} : { excludedBecause: 'file deleted' }),
  });
  const acquired = {
    repositoryRoot: 'example/app',
    mode: 'pull-request',
    base: 'base',
    head: 'abcdef0123456789',
    title: 'change',
    files: [file('src/a.ts', 'modified', true), file('src/b.ts', 'deleted', false)],
    reviewedFileCount: 1,
    hunkFileCount: 1,
    excludedFileCount: 1,
    diff: 'full patch',
    totalChangedFiles: 2,
    additions: 1,
    deletions: 11,
    truncated: false,
    truncationNote: null,
    refs: { base: { sha: 'base', available: true }, head: { sha: 'abcdef0123456789', available: true }, fetched: false, note: null },
  };
  const patch = ['diff --git a/src/b.ts b/src/b.ts', 'deleted file mode 100644', '--- a/src/b.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-b 1', ''].join('\n');
  const scope = { kind: 'interdiff', since: '1234567890abcdef', priorRunId: null, priorReviewedAt: null, mergeBase: 'e'.repeat(40), files: ['src/b.ts'], hunks: 1 };

  const scoped = applyReviewScope(acquired, 7, scope, process.cwd(), undefined, patch);
  assert.equal(scoped.diff, patch);
  assert.ok(scoped.reviewedFileCount > 0, 'a deletion-only follow-up is not "nothing to review"');
  const deleted = scoped.files.find((entry) => entry.path === 'src/b.ts');
  assert.equal(deleted.reviewed, true);
  assert.equal(deleted.excludedBecause, undefined);
  assert.equal(scoped.files.find((entry) => entry.path === 'src/a.ts').reviewed, false);
});
