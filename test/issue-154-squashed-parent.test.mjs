import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';
import { diffSummary } from '../plugins/review-voice/src/cli.ts';

// Branch A is stacked on B, B is squash-merged into main, and A is retargeted.
// The merge base of A and main predates the squash, so the files endpoint
// lists B's files as A's. Files whose head content already matches main's tip
// are not A's change.

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'rv-sq-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  commit({ 'base.txt': 'base\n' }, 'root');
  return { root, git, commit };
}

const patch = '@@ -0,0 +1 @@\n+x';

async function acquire(shas, rawFiles, cwd) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const json = /\/pulls\/\d+$/.test(path)
      ? { number: 7, title: 't', base: { sha: shas.base, ref: 'main' }, head: { sha: shas.head, ref: 'a' }, changed_files: rawFiles.length, commits: 2, additions: 3, deletions: 0 }
      : /\/repos\/org\/a$/.test(path)
        ? { default_branch: 'main' }
        : rawFiles;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const token = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    return await acquirePullRequestDiff({ repository: 'org/a', pullNumber: 7, includeGenerated: false, cwd });
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = token;
  }
}

test('files a squash-merged stacked parent added are excluded, with a warning', async () => {
  const { root, git, commit } = repo();
  try {
    git('checkout', '-q', '-b', 'b');
    commit({ 'x.txt': 'x\n', 'y.txt': 'y\n' }, 'b changes');
    git('checkout', '-q', '-b', 'a');
    const head = commit({ 'z.txt': 'z\n' }, 'a change');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'b');
    git('commit', '-q', '-m', 'squash b');
    const base = git('rev-parse', 'HEAD');

    // What the files endpoint reports: the three-dot diff from the old merge base.
    const listed = git('diff', '--name-only', `${base}...${head}`).split('\n').sort();
    assert.deepEqual(listed, ['x.txt', 'y.txt', 'z.txt']);

    const result = await acquire(
      { base, head },
      listed.map((filename) => ({ filename, status: 'added', patch })),
      root,
    );

    assert.deepEqual(result.files.filter((file) => file.reviewed).map((file) => file.path), ['z.txt']);
    for (const path of ['x.txt', 'y.txt']) {
      assert.match(result.files.find((file) => file.path === path).excludedBecause, /identical to the base branch tip/);
    }
    assert.equal(result.reviewedFileCount, 1);
    assert.equal(result.excludedFileCount, 2);
    assert.ok(result.diff.includes('b/z.txt'));
    assert.ok(!result.diff.includes('x.txt') && !result.diff.includes('y.txt'));
    assert.equal(result.squashedParentSuspected.files, 2);
    assert.match(result.squashedParentSuspected.note, /squash-merged/);
    assert.deepEqual(diffSummary(result).squashedParentSuspected, result.squashedParentSuspected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file the pull request changed again after the parent merged is still reviewed', async () => {
  const { root, git, commit } = repo();
  try {
    git('checkout', '-q', '-b', 'b');
    commit({ 'x.txt': 'x\n' }, 'b changes');
    git('checkout', '-q', '-b', 'a');
    const head = commit({ 'x.txt': 'x\nmore\n' }, 'a grows x');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'b');
    git('commit', '-q', '-m', 'squash b');
    const base = git('rev-parse', 'HEAD');

    const result = await acquire({ base, head }, [{ filename: 'x.txt', status: 'added', patch }], root);
    assert.equal(result.files[0].reviewed, true);
    assert.equal(result.squashedParentSuspected, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rename is excluded only when neither of its paths differs from the base tip', async () => {
  const { root, git, commit } = repo();
  try {
    commit({ 'old.txt': 'kept\n', 'stay.txt': 'stay\n' }, 'files to rename');
    git('checkout', '-q', '-b', 'b');
    git('mv', 'old.txt', 'new.txt');
    commit({}, 'b renames old');
    git('checkout', '-q', '-b', 'a');
    git('mv', 'stay.txt', 'moved.txt');
    const head = commit({}, 'a renames stay');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'b');
    git('commit', '-q', '-m', 'squash b');
    const base = git('rev-parse', 'HEAD');

    const result = await acquire(
      { base, head },
      [
        { filename: 'new.txt', previous_filename: 'old.txt', status: 'renamed', patch },
        { filename: 'moved.txt', previous_filename: 'stay.txt', status: 'renamed', patch },
      ],
      root,
    );
    assert.deepEqual(result.files.map((file) => [file.path, file.reviewed]), [['new.txt', false], ['moved.txt', true]]);
    assert.equal(result.squashedParentSuspected.files, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff.relative in the user config does not exclude files outside the working subdirectory', async () => {
  const { root, git, commit } = repo();
  try {
    mkdirSync(join(root, 'sub'));
    commit({ 'sub/inner.txt': 'inner\n' }, 'subdirectory');
    git('config', 'diff.relative', 'true');
    git('checkout', '-q', '-b', 'a');
    const head = commit({ 'outer.txt': 'outer\n', 'sub/inner.txt': 'inner\nedited\n' }, 'own change');
    git('checkout', '-q', 'main');
    const base = git('rev-parse', 'HEAD');

    const result = await acquire(
      { base, head },
      [
        { filename: 'outer.txt', status: 'added', patch },
        { filename: 'sub/inner.txt', status: 'modified', patch },
      ],
      join(root, 'sub'),
    );
    assert.deepEqual(result.files.map((file) => [file.path, file.reviewed]), [['outer.txt', true], ['sub/inner.txt', true]]);
    assert.equal(result.squashedParentSuspected, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a normal pull request is unchanged and carries no warning', async () => {
  const { root, git, commit } = repo();
  try {
    git('checkout', '-q', '-b', 'a');
    const head = commit({ 'own.txt': 'own\n', 'base.txt': 'base\nedited\n' }, 'own change');
    git('checkout', '-q', 'main');
    const base = commit({ 'elsewhere.txt': 'other\n' }, 'unrelated base change');

    const result = await acquire(
      { base, head },
      [
        { filename: 'base.txt', status: 'modified', patch },
        { filename: 'own.txt', status: 'added', patch },
      ],
      root,
    );
    assert.deepEqual(result.files.map((file) => [file.path, file.reviewed]), [['base.txt', true], ['own.txt', true]]);
    assert.equal(result.excludedFileCount, 0);
    assert.equal(result.squashedParentSuspected, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without the commits locally nothing is excluded and the warning is null', async () => {
  const result = await acquire(
    { base: 'a'.repeat(40), head: 'b'.repeat(40) },
    [{ filename: 'own.txt', status: 'added', patch }],
    '/nonexistent',
  );
  assert.equal(result.files[0].reviewed, true);
  assert.equal(result.squashedParentSuspected, null);
  assert.equal(diffSummary(result).squashedParentSuspected, null);
});
