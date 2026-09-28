import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planIncrementalScope } from '../plugins/review-voice/src/diff/incremental.ts';

function withRepository(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-incremental-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (path, contents, message) => {
    write(path, contents);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  commit('src/a.ts', 'export const a = 1;\n', 'initial');
  write('src/b.ts', 'export const b = 1;\n');
  write('src/untouched.ts', 'export const untouched = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'add files');

  try {
    return fn({ root, git, write, commit, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function optionsFor(repository, priorHead, overrides = {}) {
  return {
    priorRun: { reviewRunId: 'run_001', headRef: priorHead, createdAt: '2026-09-28T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/untouched.ts' }],
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    ...overrides,
  };
}

function fullCause(scope) {
  assert.equal(scope.kind, 'full');
  return scope.cause;
}

test('incremental scope intersects files and counts only commits after the recorded head', () => {
  withRepository((repository) => {
    const prior = repository.commit('src/a.ts', 'export const a = 2;\n', 'reviewed');
    repository.commit('src/a.ts', 'export const a = 3;\n', 'follow-up one');
    repository.commit('src/b.ts', 'export const b = 2;\n', 'follow-up two');

    const scope = planIncrementalScope(optionsFor(repository, prior));

    assert.deepEqual(scope, {
      kind: 'incremental',
      since: prior,
      priorRunId: 'run_001',
      priorReviewedAt: '2026-09-28T12:00:00.000Z',
      commits: 2,
      files: ['src/a.ts', 'src/b.ts'],
    });
  });
});

test('the early full-scope decisions run before any local comparison', () => {
  withRepository((repository) => {
    const prior = repository.head();
    const noPrior = planIncrementalScope(optionsFor(repository, prior, { priorRun: null }));
    assert.equal(fullCause(noPrior), 'no-prior-review');

    const requested = planIncrementalScope(optionsFor(repository, prior, { forceFull: true }));
    assert.equal(fullCause(requested), 'requested');

    const noNew = planIncrementalScope(optionsFor(repository, prior));
    assert.equal(fullCause(noNew), 'no-new-commits');

    repository.commit('src/a.ts', 'export const a = 2;\n', 'new work');
    const truncated = planIncrementalScope(optionsFor(repository, prior, { truncated: true }));
    assert.equal(fullCause(truncated), 'truncated');
  });
});

test('unreadable commits and failed commands never narrow a pull request', () => {
  withRepository((repository) => {
    const prior = repository.head();
    repository.commit('src/a.ts', 'export const a = 2;\n', 'new work');

    const unavailable = planIncrementalScope(optionsFor(repository, prior, { headAvailable: false }));
    assert.equal(fullCause(unavailable), 'compare-unavailable');

    const failed = planIncrementalScope(
      optionsFor(repository, prior, {
        git: {
          hasCommit() {
            throw new Error('object database unavailable');
          },
          isAncestor: () => true,
          mergeCommits: () => [],
          changedPaths: () => ['src/a.ts'],
          commitCount: () => 1,
        },
      }),
    );
    assert.equal(fullCause(failed), 'compare-unavailable');
  });
});

test('rewritten history, merges and base-only updates each keep the full diff', () => {
  withRepository((repository) => {
    const common = repository.head();
    const prior = repository.commit('src/a.ts', 'export const a = 2;\n', 'old review head');
    repository.git('checkout', '-q', '-B', 'rewritten', common);
    repository.commit('src/a.ts', 'export const a = 3;\n', 'replacement history');
    assert.equal(fullCause(planIncrementalScope(optionsFor(repository, prior))), 'history-rewritten');
  });

  withRepository((repository) => {
    const prior = repository.head();
    repository.git('checkout', '-q', '-b', 'base-update', prior);
    repository.commit('src/base.ts', 'export const base = 2;\n', 'base update');
    repository.git('checkout', '-q', '-b', 'author-work', prior);
    repository.commit('src/a.ts', 'export const a = 2;\n', 'author work');
    repository.git('merge', '--no-ff', '-q', 'base-update', '-m', 'merge base update');
    assert.equal(fullCause(planIncrementalScope(optionsFor(repository, prior))), 'base-merged');
  });

  withRepository((repository) => {
    const prior = repository.head();
    repository.commit('src/base.ts', 'export const base = 2;\n', 'base-only update');
    assert.equal(fullCause(planIncrementalScope(optionsFor(repository, prior))), 'base-sync-only');
  });
});

test('a renamed reviewed file is retained when the comparison names its previous path', () => {
  withRepository((repository) => {
    const prior = repository.head();
    repository.git('mv', 'src/a.ts', 'src/renamed.ts');
    repository.git('commit', '-q', '-m', 'rename');

    const scope = planIncrementalScope(
      optionsFor(repository, prior, {
        reviewedFiles: [{ path: 'src/renamed.ts', previousPath: 'src/a.ts' }],
        git: {
          hasCommit: () => true,
          isAncestor: () => true,
          mergeCommits: () => [],
          // A comparison tool may report the old side of a rename. The
          // current path still has to be sent to the local diff.
          changedPaths: () => ['src/a.ts'],
          commitCount: () => 1,
        },
      }),
    );

    assert.equal(scope.kind, 'incremental');
    assert.deepEqual(scope.files, ['src/renamed.ts']);
  });
});
