import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';

// `base` is the base branch's tip. Once that branch moves on it is not an
// ancestor of the head, so `git diff <base> <head>` shows the branch's own
// changes reversed. `refs.mergeBase` is the commit the pull request branched
// from, and is what a consumer that diffs or records a base wants.

function movedOnBranch() {
  const root = mkdtempSync(join(tmpdir(), 'rv-mb-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (file, text, message) => {
    writeFileSync(join(root, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const branchPoint = commit('a.txt', 'a\n', 'one');
  git('checkout', '-q', '-b', 'topic');
  const head = commit('own.txt', 'own\n', 'own change');
  git('checkout', '-q', 'main');
  const baseTip = commit('elsewhere.txt', 'other\n', 'unrelated base change');
  return { root, git, branchPoint, head, baseTip };
}

async function acquire(shas, cwd) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const json = /\/pulls\/\d+$/.test(String(url))
      ? { number: 7, title: 't', base: { sha: shas.base, ref: 'main' }, head: { sha: shas.head, ref: 'topic' }, changed_files: 1, additions: 1, deletions: 0 }
      : [{ filename: 'own.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+own' }];
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    return await acquirePullRequestDiff({ repository: 'org/a', pullNumber: 7, includeGenerated: false, cwd });
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
}

test('refs carry the merge base beside the base branch tip, which keeps its meaning', async () => {
  const { root, git, branchPoint, head, baseTip } = movedOnBranch();
  try {
    const result = await acquire({ base: baseTip, head }, root);

    assert.equal(result.base, baseTip, 'base stays the base branch tip');
    assert.equal(result.refs.base.sha, baseTip);
    assert.equal(result.refs.mergeBase, branchPoint);
    assert.notEqual(result.refs.mergeBase, result.refs.base.sha);

    // The reason it matters: the tip is not an ancestor of the head, so a
    // diff from it reaches files the pull request never touched.
    const files = (from) => git('diff', '--name-only', from, head).split('\n').sort();
    assert.deepEqual(files(baseTip), ['elsewhere.txt', 'own.txt']);
    assert.deepEqual(files(result.refs.mergeBase), ['own.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the merge base is null when a commit is missing rather than guessed', async () => {
  const { root, baseTip } = movedOnBranch();
  try {
    const result = await acquire({ base: baseTip, head: '0'.repeat(40) }, root);
    assert.equal(result.refs.mergeBase, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
