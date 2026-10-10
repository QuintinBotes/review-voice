/**
 * A plain follow-up is read as the commit range since the reviewed head.
 *
 * When the reviewed head is an ancestor of the new head and the pull request's
 * merge base did not move, everything between the two heads is author work.
 * Matching own-diff hunks there sent a new file, an edit inside a reviewed
 * hunk, withdrawn lines and a refactor's moved code to a full re-read. Each is
 * now the diff between the heads, restricted to the pull request's files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

/**
 * `main` plus a pull-request branch `pr` whose reviewed head adds a helper
 * block to src/a.ts. src/other.ts is outside the pull request.
 */
function withPullRequest(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-plain-follow-up-'));
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
    assert.ok(current.includes(from), `${path} holds ${JSON.stringify(from)}`);
    write(path, current.replace(from, to));
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/a.ts', lines(40, 'a'));
  write('src/other.ts', lines(10, 'other'));
  commit('initial');

  git('checkout', '-q', '-b', 'pr');
  edit('src/a.ts', 'a 10\n', 'a 10\nhelperOne();\nhelperTwo();\nhelperThree();\n');
  const reviewed = commit('author work');

  try {
    return fn({ root, git, write, edit, commit, reviewed, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, reviewedFiles, overrides = {}) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: repository.reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles,
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.git('rev-parse', 'main').trim(),
    ...overrides,
  });
}

/** Checks the shape every plain follow-up shares. */
function assertPlain(repository, planned, files) {
  const { scope, interdiffPatch } = planned;
  assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
  assert.equal(scope.since, repository.reviewed);
  assert.equal(scope.priorRunId, 'run_001');
  assert.equal(scope.mergeBase, repository.git('merge-base', 'main', 'HEAD').trim());
  assert.deepEqual(scope.files, files);
  assert.equal(interdiffPatch, repository.git('diff', '--no-ext-diff', '--no-color', repository.reviewed, 'HEAD', '--', ...files));
  // Nothing outside the pull request, and nothing the review already read.
  assert.doesNotMatch(interdiffPatch, /^[+-]other /m);
  assert.doesNotMatch(interdiffPatch, /^\+helperOne\(\);$/m);
}

test('a follow-up that adds a new file is read as that file', () => {
  withPullRequest((repository) => {
    repository.write('src/new.ts', 'export const fresh = 1;\n');
    repository.commit('add a file');
    const planned = plan(repository, [{ path: 'src/a.ts' }, { path: 'src/new.ts' }]);
    assertPlain(repository, planned, ['src/new.ts']);
    assert.match(planned.interdiffPatch, /^new file mode/m);
    assert.match(planned.interdiffPatch, /^\+export const fresh = 1;$/m);
    assert.equal(planned.scope.hunks, 1);
  });
});

test('a follow-up that edits a line inside a reviewed hunk is read as that edit', () => {
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'helperTwo();\n', 'helperTwo(withArgument);\n');
    repository.commit('edit inside the reviewed hunk');
    const planned = plan(repository, [{ path: 'src/a.ts' }]);
    assertPlain(repository, planned, ['src/a.ts']);
    assert.match(planned.interdiffPatch, /^-helperTwo\(\);$/m);
    assert.match(planned.interdiffPatch, /^\+helperTwo\(withArgument\);$/m);
  });
});

test('a follow-up that removes lines the pull request added shows them as removed', () => {
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'helperOne();\nhelperTwo();\n', '');
    repository.commit('withdraw two helpers');
    const planned = plan(repository, [{ path: 'src/a.ts' }]);
    assertPlain(repository, planned, ['src/a.ts']);
    assert.match(planned.interdiffPatch, /^-helperOne\(\);$/m);
    assert.match(planned.interdiffPatch, /^-helperTwo\(\);$/m);
    assert.doesNotMatch(planned.interdiffPatch, /^\+(?!\+\+ )/m);
  });
});

test('a follow-up that withdraws every change to a file still shows the withdrawn lines', () => {
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'helperOne();\nhelperTwo();\nhelperThree();\n', '');
    repository.write('src/kept.ts', 'export const kept = 1;\n');
    repository.commit('withdraw the whole change to a.ts');
    // src/a.ts is no longer part of the pull request, so the full read would not list it.
    const planned = plan(repository, [{ path: 'src/kept.ts' }]);
    assertPlain(repository, planned, ['src/a.ts', 'src/kept.ts']);
    assert.match(planned.interdiffPatch, /^-helperThree\(\);$/m);
  });
});

test('a refactor that moves reviewed code into a new file shows it in both places', () => {
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'helperOne();\nhelperTwo();\nhelperThree();\n', 'helpers();\n');
    repository.write('src/helpers.ts', 'export function helpers() {\n  helperOne();\n  helperTwo();\n  helperThree();\n}\n');
    repository.commit('move the helpers out');
    const planned = plan(repository, [{ path: 'src/a.ts' }, { path: 'src/helpers.ts' }]);
    assertPlain(repository, planned, ['src/a.ts', 'src/helpers.ts']);
    for (const name of ['helperOne', 'helperTwo', 'helperThree']) {
      assert.match(planned.interdiffPatch, new RegExp(`^-${name}\\(\\);$`, 'm'), `${name} leaves src/a.ts`);
      assert.match(planned.interdiffPatch, new RegExp(`^\\+  ${name}\\(\\);$`, 'm'), `${name} arrives in src/helpers.ts`);
    }
    assert.match(planned.interdiffPatch, /^\+helpers\(\);$/m);
  });
});

test('a follow-up that combines these is read as all of them, over several commits', () => {
  withPullRequest((repository) => {
    repository.edit('src/a.ts', 'helperTwo();\n', 'helperTwo(changed);\n');
    repository.commit('edit inside');
    repository.edit('src/a.ts', 'helperThree();\n', '');
    repository.write('src/extra.ts', 'export const extra = 2;\n');
    repository.commit('withdraw one helper and add a file');
    repository.edit('src/a.ts', 'a 30\n', 'a 30 edited later\n');
    repository.commit('edit elsewhere');
    const planned = plan(repository, [{ path: 'src/a.ts' }, { path: 'src/extra.ts' }]);
    assertPlain(repository, planned, ['src/a.ts', 'src/extra.ts']);
    assert.match(planned.interdiffPatch, /^\+helperTwo\(changed\);$/m);
    assert.match(planned.interdiffPatch, /^-helperThree\(\);$/m);
    assert.match(planned.interdiffPatch, /^\+export const extra = 2;$/m);
    assert.match(planned.interdiffPatch, /^\+a 30 edited later$/m);
    assert.equal(planned.scope.hunks, 3);
  });
});

test('a follow-up whose merge base moved is not read as the commit range', () => {
  withPullRequest((repository) => {
    repository.git('checkout', '-q', 'main');
    repository.edit('src/other.ts', 'other 1\n', 'other 1 moved on main\n');
    repository.commit('base moves on');
    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    repository.write('src/new.ts', 'export const fresh = 1;\n');
    repository.commit('add a file');

    // The reviewed head is still an ancestor, but the merge base moved: the
    // reviewed head is replayed onto the new base, so the new file is read and
    // the base's change, which the commit range would hold, is not.
    const { scope, interdiffPatch } = plan(repository, [{ path: 'src/a.ts' }, { path: 'src/new.ts' }]);
    assert.equal(scope.kind, 'interdiff');
    assert.match(interdiffPatch, /^\+\+\+ b\/src\/new\.ts$/m);
    assert.doesNotMatch(interdiffPatch, /moved on main/);
  });
});

test('a previous head that cannot be read is a full read with its cause', () => {
  withPullRequest((repository) => {
    repository.write('src/new.ts', 'export const fresh = 1;\n');
    repository.commit('add a file');
    const missing = 'e'.repeat(40);
    const { scope, interdiffPatch } = plan(repository, [{ path: 'src/a.ts' }, { path: 'src/new.ts' }], {
      priorRun: { reviewRunId: 'run_001', headRef: missing, createdAt: '2026-09-30T12:00:00.000Z' },
    });
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, /previous head eeeeeee is not in this clone/);
    assert.equal(interdiffPatch, null);
  });
});
