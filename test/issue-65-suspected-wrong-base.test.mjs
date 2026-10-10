import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';
import { diffSummary } from '../plugins/review-voice/src/cli.ts';

// A branch cut from the default branch and opened against a release branch
// carries the default branch's history. `suspectedWrongBase` says so, and is
// null whenever it is not suspected or could not be checked.

const SHA = 'a'.repeat(40);

/** `routes` maps a path pattern to a status code and body; the log lists requested paths. */
async function acquire({ baseRef = 'release/1', headRef = 'topic', commits = 100, aheadBy = 1, repo = { default_branch: 'main' }, compareStatus = 200, repoStatus = 200 }) {
  const requested = [];
  const original = globalThis.fetch;
  const reply = (status, json) =>
    new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    if (/\/pulls\/\d+$/.test(path)) {
      return reply(200, {
        number: 7, title: 't', base: { sha: SHA, ref: baseRef }, head: { sha: 'b'.repeat(40), ref: headRef },
        changed_files: 500, commits, additions: 1, deletions: 0,
      });
    }
    if (path.includes('/compare/')) return reply(compareStatus, compareStatus === 200 ? { ahead_by: aheadBy } : { message: 'boom' });
    if (/\/repos\/org\/a$/.test(path)) return reply(repoStatus, repoStatus === 200 ? repo : { message: 'boom' });
    return reply(200, [{ filename: 'own.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+own' }]);
  };
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    const result = await acquirePullRequestDiff({ repository: 'org/a', pullNumber: 7, includeGenerated: false, cwd: '/nonexistent' });
    return { result, requested };
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
}

test('most commits already on the default branch is suspected, with the numbers and a note', async () => {
  const { result, requested } = await acquire({});
  assert.deepEqual(result.suspectedWrongBase, {
    base: 'release/1',
    otherBranch: 'main',
    commits: 100,
    alreadyOn: 99,
    files: 500,
    note:
      "99 of the pull request's 100 commits are already on main, which suggests it was opened against release/1 by mistake (a branch cut from main). Ask about the base before reviewing the whole patch, unless bringing main's commits into release/1 is the intent.",
  });
  assert.ok(requested.some((path) => path.includes('/compare/main...')));
});

test('a pull request against the default branch is never compared', async () => {
  const { result, requested } = await acquire({ baseRef: 'main' });
  assert.equal(result.suspectedWrongBase, null);
  assert.ok(!requested.some((path) => path.includes('/compare/')));
});

test('a genuine hotfix whose commits are all new is not suspected', async () => {
  const { result } = await acquire({ commits: 12, aheadBy: 12 });
  assert.equal(result.suspectedWrongBase, null);
});

test('a small pull request stays quiet below the floor', async () => {
  const { result } = await acquire({ commits: 3, aheadBy: 0 });
  assert.equal(result.suspectedWrongBase, null);
});

test('a failed compare read is null and the diff still succeeds', async () => {
  const { result } = await acquire({ compareStatus: 500 });
  assert.equal(result.suspectedWrongBase, null);
  assert.equal(result.files.length, 1);
});

test('a failed repository read is null and the diff still succeeds', async () => {
  const { result } = await acquire({ repoStatus: 500 });
  assert.equal(result.suspectedWrongBase, null);
  assert.equal(result.files.length, 1);
});

test('diffSummary carries the field, null when absent', async () => {
  const { result } = await acquire({});
  assert.equal(diffSummary(result).suspectedWrongBase.alreadyOn, 99);
  const local = { diff: '', mode: 'worktree', base: null, head: 'HEAD', reviewedFileCount: 0, hunkFileCount: 0, excludedFileCount: 0 };
  assert.equal(diffSummary(local).suspectedWrongBase, null);
});

test('a promotion from the default branch itself is not suspected, and is never compared', async () => {
  const { result, requested } = await acquire({ headRef: 'main', aheadBy: 0 });
  assert.equal(result.suspectedWrongBase, null);
  assert.ok(!requested.some((path) => path.includes('/compare/')));
});
