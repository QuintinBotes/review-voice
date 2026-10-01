/**
 * A follow-up review reads the pull request's own diff, not the commit range.
 *
 * A merged base, or a rebase, used to force a full re-read: the commit range
 * since the last reviewed head then includes base-branch work. Comparing the
 * pull request's own diff - head against its merge base - before and after
 * answers the question that matters, which is whether the author changed
 * anything, and where.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope, planIncrementalScope, ownDiffFiles } from '../plugins/review-voice/src/diff/incremental.ts';
import { applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/**
 * A repository with `main` and a pull-request branch `pr` that edits line 5 of
 * src/a.ts. `src/a.ts` is long enough that a base edit near the end does not
 * touch the author's hunk.
 */
function withPullRequest(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-own-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const edit = (path, from, to) => {
    const current = readFileSync(join(root, path), 'utf8');
    write(path, current.replace(from, to));
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/a.ts', lines(40, 'a'));
  write('src/b.ts', lines(10, 'b'));
  write('src/base-only.ts', lines(5, 'base'));
  commit('initial');

  git('checkout', '-q', '-b', 'pr');
  edit('src/a.ts', 'a 5\n', 'a 5 changed by the author\n');
  const reviewed = commit('author work');

  try {
    return fn({ root, git, write, edit, commit, reviewed, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, overrides = {}) {
  const base = repository.git('rev-parse', 'main').trim();
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: repository.reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base,
    ...overrides,
  });
}

/** Moves `main` with a base-only change, including one inside src/a.ts. */
function advanceBase(repository) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/base-only.ts', 'base 1\n', 'base 1 moved on main\n');
  repository.edit('src/a.ts', 'a 35\n', 'a 35 changed on main\n');
  repository.commit('base moves on');
  repository.git('checkout', '-q', 'pr');
}

test('a head that only merged the base is unchanged, with nothing to read', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'unchanged');
    assert.equal(scope.reason, 'base-merged');
    assert.equal(scope.since, repository.reviewed);
    assert.equal(interdiffPatch, null);
  });
});

test('a rebase that leaves the author content alone is unchanged', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('rebase', '-q', 'main');

    const { scope } = plan(repository);
    assert.equal(scope.kind, 'unchanged');
    assert.equal(scope.reason, 'history-rewritten');
  });
});

test('a merge plus new author work reviews only the new author hunk', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    repository.edit('src/b.ts', 'b 3\n', 'b 3 changed after the review\n');
    repository.commit('more author work');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff');
    assert.deepEqual(scope.files, ['src/b.ts']);
    assert.equal(scope.hunks, 1);
    assert.match(interdiffPatch, /^\+b 3 changed after the review$/m);
    // Base churn, inside an author-touched file or not, never reaches the review.
    assert.doesNotMatch(interdiffPatch, /changed on main|moved on main/);
    // The author's already-reviewed hunk is not read again.
    assert.doesNotMatch(interdiffPatch, /a 5 changed by the author/);
    // Head-side line numbers survive, so anchors stay valid.
    assert.match(interdiffPatch, /^@@ -1,6 \+1,6 @@/m);
    assert.doesNotMatch(interdiffPatch, /\n\n$/);
  });
});

test('a rebase that amends one hunk reviews that hunk only', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('rebase', '-q', 'main');
    repository.edit('src/a.ts', 'a 5 changed by the author\n', 'a 5 changed differently\n');
    repository.git('add', '-A');
    repository.git('commit', '-q', '--amend', '--no-edit');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff');
    assert.deepEqual(scope.files, ['src/a.ts']);
    assert.match(interdiffPatch, /^\+a 5 changed differently$/m);
    assert.doesNotMatch(interdiffPatch, /a 35 changed on main/);
  });
});

test('plain author commits are read as their own-diff hunks, against the merge base', () => {
  withPullRequest((repository) => {
    repository.edit('src/b.ts', 'b 3\n', 'b 3 next\n');
    repository.commit('follow-up');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff');
    assert.deepEqual(scope.files, ['src/b.ts']);
    assert.equal(scope.mergeBase, repository.git('merge-base', 'main', 'HEAD').trim());
    assert.match(interdiffPatch, /^\+b 3 next$/m);
  });
});

test('without the base every earlier decision is unchanged', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    const scope = planIncrementalScope({
      priorRun: { reviewRunId: 'run_001', headRef: repository.reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
      head: repository.head(),
      headAvailable: true,
      reviewedFiles: [{ path: 'src/a.ts' }],
      cwd: repository.root,
      truncated: false,
      forceFull: false,
    });
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'base-merged');
  });
});

test('IF the own diff cannot be read THEN the whole pull request is read', () => {
  withPullRequest((repository) => {
    advanceBase(repository);
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    const failing = {
      hasCommit: () => true,
      isAncestor: () => true,
      mergeCommits: () => ['m'],
      changedPaths: () => ['src/a.ts'],
      commitCount: () => 1,
      mergeBase() {
        throw new Error('no merge base');
      },
      diffText: () => '',
    };
    const { scope } = plan(repository, { git: failing });
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'compare-unavailable');

    const unknownBase = plan(repository, { base: 'f'.repeat(40) });
    assert.equal(unknownBase.scope.kind, 'full');
    assert.equal(unknownBase.scope.cause, 'compare-unavailable');
  });
});

test('hunks are matched by what they change and what they sit next to, not by line number', () => {
  const patch = (at, before) =>
    ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', `@@ -${at} +${at} @@`, ` ${before}`, '-old', '+new'].join('\n');
  const key = (text) => ownDiffFiles(text).get('x.ts').hunks[0].key;
  assert.equal(key(patch(5, 'open()')), key(patch(9, 'open()')), 'shifted, same neighbour');
  assert.notEqual(key(patch(5, 'open()')), key(patch(5, 'close()')), 'same edit moved next to other code');
});

// Every author change since the review must be read: these are the shapes that
// once produced `unchanged` and silently skipped the change.

function afterMerge(repository, change) {
  advanceBase(repository);
  repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
  change(repository);
  return plan(repository).scope;
}

test('a reverted author hunk is never unchanged', () => {
  withPullRequest((repository) => {
    const scope = afterMerge(repository, (r) => {
      r.edit('src/a.ts', 'a 5 changed by the author\n', 'a 5\n');
      r.commit('revert the reviewed change');
    });
    assert.notEqual(scope.kind, 'unchanged');
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'own-diff-unrepresentable');
  });
});

test('the same edit moved elsewhere in the file is never unchanged', () => {
  withPullRequest((repository) => {
    const scope = afterMerge(repository, (r) => {
      r.edit('src/a.ts', 'a 5 changed by the author\n', 'a 5\n');
      r.edit('src/a.ts', 'a 20\n', 'a 5 changed by the author\n');
      r.commit('move the edit');
    });
    assert.notEqual(scope.kind, 'unchanged');
  });
});

test('a rename, a mode change and an empty new file are never unchanged', () => {
  for (const change of [
    (r) => r.git('mv', 'src/b.ts', 'src/b-renamed.ts'),
    (r) => chmodSync(join(r.root, 'src/b.ts'), 0o755),
    (r) => r.write('src/empty.ts', ''),
  ]) {
    withPullRequest((repository) => {
      advanceBase(repository);
      repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
      change(repository);
      repository.commit('metadata-only author change');
      const { scope } = plan(repository, {
        reviewedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/b-renamed.ts', previousPath: 'src/b.ts' }, { path: 'src/empty.ts' }],
      });
      assert.notEqual(scope.kind, 'unchanged');
    });
  }
});

test('a rewritten reviewed hunk is reviewed as the new version, not read in full', () => {
  withPullRequest((repository) => {
    const scope = afterMerge(repository, (r) => {
      r.edit('src/a.ts', 'a 5 changed by the author\n', 'a 5 rewritten after review\n');
      r.commit('rewrite');
    });
    assert.equal(scope.kind, 'interdiff');
    assert.deepEqual(scope.files, ['src/a.ts']);
  });
});

test('code restored to its merge-base state is never shown as newly added', () => {
  // On a linear branch the commit range shows a restored line as `+`, though
  // relative to the base the author only withdrew a change. Against the merge
  // base that is a removed hunk, which nothing at the head can show.
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'a 5 changed by the author\n', 'a 5\n');
    repository.commit('restore the base version');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'own-diff-unrepresentable');
    assert.equal(interdiffPatch, null);
  });
});

test('planning from a subdirectory still sees every author change', () => {
  withPullRequest((repository) => {
    const scope = afterMerge(repository, (r) => {
      r.edit('src/b.ts', 'b 3\n', 'b 3 changed after the review\n');
      r.commit('more author work');
    });
    const fromSubdirectory = plan(repository, { cwd: join(repository.root, 'src') }).scope;
    assert.equal(scope.kind, 'interdiff');
    assert.deepEqual(fromSubdirectory, scope);
  });
});

// Applying the scope to an acquired pull request

function acquired() {
  const file = (path) => ({ path, status: 'modified', class: 'source', language: 'TypeScript', additions: 1, deletions: 1, reviewed: true });
  return {
    repositoryRoot: 'acme/web',
    mode: 'pull-request',
    base: 'base',
    head: 'abcdef0123456789',
    title: 'change',
    files: [file('src/a.ts'), file('src/b.ts')],
    reviewedFileCount: 2,
    hunkFileCount: 2,
    excludedFileCount: 0,
    diff: 'full patch',
    totalChangedFiles: 2,
    additions: 2,
    deletions: 2,
    truncated: false,
    truncationNote: null,
    refs: { base: { sha: 'base', available: true }, head: { sha: 'abcdef0123456789', available: true }, fetched: false, note: null },
  };
}

test('an unchanged scope reads nothing and says the earlier review still applies', () => {
  const scoped = applyReviewScope(acquired(), 7, {
    kind: 'unchanged',
    since: '1234567890abcdef',
    priorRunId: null,
    priorReviewedAt: null,
    mergeBase: 'e'.repeat(40),
    reason: 'base-merged',
  }, process.cwd());
  assert.equal(scoped.diff, '');
  assert.equal(scoped.reviewedFileCount, 0);
  assert.equal(scoped.hunkFileCount, 0);
  assert.equal(scoped.scopeNote, "No change to this pull request's own diff since 1234567; the review at 1234567 still applies.");
});

test('an interdiff scope reads the planned patch, and only its files', () => {
  const patch = ['diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -3 +3 @@', '-b 3', '+b 3 next', ''].join('\n');
  const scope = { kind: 'interdiff', since: '1234567890abcdef', priorRunId: 'run_001', priorReviewedAt: '2026-09-30T12:00:00.000Z', mergeBase: 'e'.repeat(40), files: ['src/b.ts'], hunks: 1 };
  const scoped = applyReviewScope(acquired(), 7, scope, process.cwd(), undefined, patch);
  assert.equal(scoped.diff, patch);
  assert.equal(scoped.reviewedFileCount, 1);
  assert.equal(scoped.hunkFileCount, 1);
  assert.equal(scoped.files.find((file) => file.path === 'src/a.ts').reviewed, false);
  assert.match(scoped.scopeNote, /base-branch changes merged in were not reviewed/);

  // Without the planner's patch nothing narrower is known to be safe.
  const fallback = applyReviewScope(acquired(), 7, scope, process.cwd());
  assert.equal(fallback.scope.kind, 'full');
  assert.equal(fallback.diff, 'full patch');
});
