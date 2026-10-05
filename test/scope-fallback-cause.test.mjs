/**
 * A follow-up review that falls back to a full read says why.
 *
 * The cause code alone (`compare-unavailable`, `own-diff-unrepresentable`)
 * left nothing to act on when follow-ups kept reading the whole pull request.
 * `detail` names the condition that fired and, for a failed git command, which
 * command and what git said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeScope, parseReviewScope, planScope } from '../plugins/review-voice/src/diff/incremental.ts';
import { applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';

function withRepository(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-fallback-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (contents, message) => {
    writeFileSync(join(root, 'src.ts'), contents);
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    const base = commit('one();\ntwo();\nthree();\n', 'base');
    git('checkout', '-q', '-b', 'pr');
    const prior = commit('one();\ntwo();\nadded();\nthree();\n', 'reviewed');
    const head = commit('one();\ntwo();\nadded();\nthree();\nmore();\n', 'follow-up');
    return fn({ root, git, commit, base, prior, head });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const options = (repository, overrides = {}) => ({
  priorRun: { reviewRunId: 'run_001', headRef: repository.prior, createdAt: '2026-09-30T12:00:00.000Z' },
  head: repository.head,
  headAvailable: true,
  reviewedFiles: [{ path: 'src.ts' }],
  cwd: repository.root,
  truncated: false,
  forceFull: false,
  base: repository.base,
  ...overrides,
});

test('a head that is not in the clone is named', () => {
  withRepository((repository) => {
    const { scope } = planScope(options(repository, { headAvailable: false }));
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, new RegExp(`head ${repository.head.slice(0, 7)} is not in this clone`));
  });
});

test('a previous head that is not in the clone is named', () => {
  withRepository((repository) => {
    const missing = 'e'.repeat(40);
    const { scope } = planScope(options(repository, { priorRun: { reviewRunId: null, headRef: missing, createdAt: null } }));
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, /previous head eeeeeee is not in this clone/);
  });
});

test('a base that is not in the clone is named', () => {
  withRepository((repository) => {
    const { scope } = planScope(options(repository, { base: 'f'.repeat(40) }));
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, /base fffffff is not in this clone/);
  });
});

test('a git command that fails names the command and what git said', () => {
  withRepository((repository) => {
    // A base with no history in common: `merge-base` finds nothing and exits 1.
    repository.git('checkout', '-q', '--orphan', 'unrelated');
    const unrelated = repository.commit('other();\n', 'unrelated root');
    repository.git('checkout', '-q', 'pr');
    const { scope } = planScope(options(repository, { base: unrelated }));
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, new RegExp(`^merge-base ${unrelated.slice(0, 7)} ${repository.head.slice(0, 7)} failed: `));
  });
});

test('an injected git failure keeps its message', () => {
  withRepository((repository) => {
    const failing = {
      hasCommit: () => true,
      isAncestor: () => true,
      mergeCommits: () => [],
      changedPaths: () => ['src.ts'],
      commitCount: () => 1,
      mergeBase() {
        throw new Error('merge-base abc1234 def5678 failed: fatal: Not a valid commit name');
      },
      diffText: () => '',
    };
    const { scope } = planScope(options(repository, { git: failing }));
    assert.equal(scope.detail, 'merge-base abc1234 def5678 failed: fatal: Not a valid commit name');
  });
});

test('an unrepresentable own diff names the file and the reviewed hunk', () => {
  withRepository((repository) => {
    const reverted = repository.commit('one();\ntwo();\nthree();\nmore();\n', 'withdraw the reviewed line');
    const { scope } = planScope(options(repository, { head: reverted }));
    assert.equal(scope.cause, 'own-diff-unrepresentable');
    assert.match(scope.detail, /^src\.ts: the reviewed hunk @@ -\S+ \+\S+ @@ was reverted or moved$/);
  });
});

test('a narrowed scope that cannot be applied says which step failed', () => {
  const acquired = {
    repositoryRoot: 'acme/web',
    mode: 'pull-request',
    base: 'base',
    head: 'abcdef0123456789',
    title: 'change',
    files: [{ path: 'src/a.ts', status: 'modified', class: 'source', language: 'TypeScript', additions: 1, deletions: 1, reviewed: true }],
    reviewedFileCount: 1,
    hunkFileCount: 1,
    excludedFileCount: 0,
    diff: 'full patch',
    totalChangedFiles: 1,
    additions: 1,
    deletions: 1,
    truncated: false,
    truncationNote: null,
    refs: { base: { sha: 'base', available: true }, head: { sha: 'abcdef0123456789', available: true }, fetched: false, note: null },
  };
  const since = '1234567890abcdef';
  const interdiff = { kind: 'interdiff', since, priorRunId: null, priorReviewedAt: null, mergeBase: 'e'.repeat(40), files: ['src/a.ts'], hunks: 1 };
  const noPatch = applyReviewScope(acquired, 7, interdiff, process.cwd());
  assert.equal(noPatch.scope.cause, 'compare-unavailable');
  assert.match(noPatch.scope.detail, /no interdiff patch/);

  const incremental = { kind: 'incremental', since, priorRunId: null, priorReviewedAt: null, commits: 1, files: ['src/a.ts'] };
  const unreadable = applyReviewScope(acquired, 7, incremental, process.cwd(), () => {
    throw new Error('diff 1234567 abcdef0 failed: fatal: bad object');
  });
  assert.equal(unreadable.scope.cause, 'compare-unavailable');
  assert.match(unreadable.scope.detail, /reading the incremental diff failed: diff 1234567 abcdef0 failed: fatal: bad object/);
  // Still a full read: the API patch is kept.
  assert.equal(unreadable.diff, 'full patch');
});

test('a detail survives a read back and is shown by explain', () => {
  const scope = { kind: 'full', cause: 'compare-unavailable', since: 'a'.repeat(40), priorRunId: null, detail: 'the base fffffff is not in this clone' };
  assert.deepEqual(parseReviewScope(scope), scope);
  assert.equal(parseReviewScope({ ...scope, detail: 7 }), null);
  assert.equal(describeScope(scope), 'full (compare-unavailable: the base fffffff is not in this clone)');
});
