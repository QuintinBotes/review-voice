/** #477: base lines kept in a whole interdiff hunk must not appear as additions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const path = 'src/app.ts';
const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join('');
const reviewedText = original
  .replace('line 5\n', 'author reviewed five\n')
  .replace('line 20\n', 'author reviewed twenty\n');
const baseText = original
  .replace('line 5\n', 'base five\n')
  .replace('line 9\n', 'base only nine\nbase only nine-b\n');

function withRepository(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-477-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'diff.context', '3');
    git('config', 'merge.conflictStyle', 'merge');
    write(original);
    commit('initial');
    git('checkout', '-q', '-b', 'pr');
    write(reviewedText);
    const reviewed = commit('reviewed head A');

    git('checkout', '-q', 'main');
    write(baseText);
    const base = commit('base advances');
    git('checkout', '-q', 'pr');
    assert.throws(() => git('merge', '-q', '--no-ff', 'main', '-m', 'merge base'));
    assert.deepEqual(git('diff', '--name-only', '--diff-filter=U').trim().split('\n'), [path]);
    const merged = reviewedText.replace('line 9\n', 'base only nine\nbase only nine-b\n');
    write(merged);
    commit('resolve merge keeping reviewed code');
    // The line right below the base's block: one edit run with it in the
    // two-head diff, so the base's lines cannot be separated out of the hunk.
    write(merged.replace('line 10\n', 'author new ten\n'));
    commit('follow-up beside the base block');
    return fn({ root, git, reviewed, base });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertHunkCounts(patch) {
  const lines = patch.split('\n');
  let expected = null;
  let oldSeen = 0;
  let newSeen = 0;
  const finish = () => {
    if (expected === null) return;
    assert.equal(oldSeen, expected.old, `old count of ${expected.header}`);
    assert.equal(newSeen, expected.new, `new count of ${expected.header}`);
    expected = null;
  };
  for (const line of lines) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      finish();
      expected = {
        header: line,
        old: header[1] === undefined ? 1 : Number(header[1]),
        new: header[2] === undefined ? 1 : Number(header[2]),
      };
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      finish();
      continue;
    }
    if (expected === null || line === '' || line.startsWith('\\')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) oldSeen += 1;
    if (line.startsWith(' ') || line.startsWith('+')) newSeen += 1;
  }
  finish();
}

test('lines only the base added are context, not additions, in a kept-whole hunk', () => {
  withRepository((repository) => {
    const { scope, interdiffPatch } = planScope({
      priorRun: { reviewRunId: null, headRef: repository.reviewed, createdAt: null },
      head: repository.git('rev-parse', 'HEAD').trim(),
      headAvailable: true,
      reviewedFiles: [{ path }],
      cwd: repository.root,
      truncated: false,
      forceFull: false,
      base: repository.base,
    });
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(
      scope.detail,
      /could not be separated after a conflicting replay|could not be matched to hunks/,
      JSON.stringify(scope),
    );
    // The author's follow-up is still an addition an anchor may sit on.
    assert.match(interdiffPatch, /^\+author new ten$/m);
    // Lines only the base added are not in the pull request's own diff, so an
    // anchor on one would be refused at posting; they read as context.
    assert.doesNotMatch(interdiffPatch, /^\+base only/m);
    assert.match(interdiffPatch, /^ base only nine$/m);
    assert.match(interdiffPatch, /^ base only nine-b$/m);
    assertHunkCounts(interdiffPatch);
    assert.match(
      scope.detail,
      /shown as context where the base added lines after a conflicting replay: src\/app\.ts/,
    );
  });
});

function withGitRepo(initial, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-477-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (name, contents) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'diff.context', '3');
    git('config', 'merge.conflictStyle', 'merge');
    for (const [name, contents] of Object.entries(initial)) write(name, contents);
    commit('initial');
    return fn({ root, git, write, commit, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function planFor(repo, reviewed, base, names) {
  return planScope({
    priorRun: { reviewRunId: null, headRef: reviewed, createdAt: null },
    head: repo.head(),
    headAvailable: true,
    reviewedFiles: names.map((name) => ({ path: name })),
    cwd: repo.root,
    truncated: false,
    forceFull: false,
    base,
  });
}

test('a line the reviewed head deleted and the head restores stays an addition beside base lines', () => {
  const file = 'src/restored.ts';
  const reviewedContents = original.replace('line 5\n', 'author reviewed five\n').replace('line 10\n', '');
  const baseContents = original
    .replace('line 5\n', 'base five\n')
    .replace('line 9\n', 'base only nine\nbase only nine-b\n');
  const headContents = original
    .replace('line 5\n', 'author reviewed five\n')
    .replace('line 9\n', 'base only nine\nbase only nine-b\n');
  withGitRepo({ [file]: original }, (repo) => {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.write(file, reviewedContents);
    const reviewed = repo.commit('reviewed head deletes line 10');
    repo.git('checkout', '-q', 'main');
    repo.write(file, baseContents);
    const base = repo.commit('base advances');
    repo.git('checkout', '-q', 'pr');
    assert.throws(() => repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge base'));
    repo.write(file, headContents);
    repo.commit('merge base and restore line 10');

    const { scope, interdiffPatch } = planFor(repo, reviewed, base, [file]);
    assert.notEqual(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    // Line 10 is not a changed line of the own diff and the base never added
    // it, so restoring it is the author's withdrawal and stays an addition.
    assert.match(interdiffPatch, /^\+line 10$/m);
    assert.doesNotMatch(interdiffPatch, /^\+base only/m);
    assert.match(interdiffPatch, /^ base only nine$/m);
    assert.match(interdiffPatch, /^ base only nine-b$/m);
    assertHunkCounts(interdiffPatch);
  });
});

test('the shown-as-context note does not name a file whose demoted section dropped out', () => {
  const kept = 'src/kept.ts';
  const dropped = 'src/dropped.ts';
  const keptReviewed = original
    .replace('line 5\n', 'author reviewed five\n')
    .replace('line 20\n', 'author reviewed twenty\n');
  const droppedReviewed = original.replace('line 9\n', 'line 9\nauthor inserted\n');
  const keptBase = original
    .replace('line 5\n', 'base five\n')
    .replace('line 9\n', 'base only nine\nbase only nine-b\n');
  const droppedBase = original.replace('line 9\n', 'line 9\nbase inserted\n');
  const keptMerged = keptReviewed.replace('line 9\n', 'base only nine\nbase only nine-b\n');
  const droppedMerged = original.replace('line 9\n', 'line 9\nauthor inserted\nbase inserted\n');
  withGitRepo({ [kept]: original, [dropped]: original }, (repo) => {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.write(kept, keptReviewed);
    repo.write(dropped, droppedReviewed);
    const reviewed = repo.commit('reviewed head');
    repo.git('checkout', '-q', 'main');
    repo.write(kept, keptBase);
    repo.write(dropped, droppedBase);
    const base = repo.commit('base advances');
    repo.git('checkout', '-q', 'pr');
    assert.throws(() => repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge base'));
    repo.write(kept, keptMerged);
    repo.write(dropped, droppedMerged);
    repo.commit('merge base keeping both insertions');
    repo.write(kept, keptMerged.replace('line 10\n', 'author new ten\n'));
    repo.commit('follow-up beside the base block');

    const { scope, interdiffPatch } = planFor(repo, reviewed, base, [kept, dropped]);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, [kept]);
    assert.match(interdiffPatch, /^\+author new ten$/m);
    // The dropped file's only change since the review is a line the base
    // added, so demoting it leaves nothing to show and no note may name it.
    assert.doesNotMatch(interdiffPatch, /dropped\.ts/);
    assert.doesNotMatch(interdiffPatch, /^\+base inserted$/m);
    assert.match(
      scope.detail,
      /shown as context where the base added lines after a conflicting replay: src\/kept\.ts/,
    );
    assert.doesNotMatch(scope.detail, /src\/dropped\.ts/);
    assertHunkCounts(interdiffPatch);
  });
});

test('the shown-as-context note does not name a file whose demoted hunk was dropped beside a kept author hunk', () => {
  const file = 'src/mixed.ts';
  const reviewedContents = original.replace('line 9\n', 'line 9\nauthor inserted\n');
  const baseContents = original.replace('line 9\n', 'line 9\nbase inserted\n');
  const merged = original.replace('line 9\n', 'line 9\nauthor inserted\nbase inserted\n');
  withGitRepo({ [file]: original }, (repo) => {
    repo.git('checkout', '-q', '-b', 'pr');
    repo.write(file, reviewedContents);
    const reviewed = repo.commit('reviewed head');
    repo.git('checkout', '-q', 'main');
    repo.write(file, baseContents);
    const base = repo.commit('base advances');
    repo.git('checkout', '-q', 'pr');
    assert.throws(() => repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge base'));
    repo.write(file, merged);
    repo.commit('merge base keeping both insertions');
    repo.write(file, merged.replace('line 30\n', 'author new thirty\n'));
    repo.commit('follow-up far from the base block');

    const { scope, interdiffPatch } = planFor(repo, reviewed, base, [file]);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(interdiffPatch, /^\+author new thirty$/m);
    assert.doesNotMatch(interdiffPatch, /base inserted/);
    // The hunk holding the base line is gone, so no line of it shows as context.
    assert.doesNotMatch(scope.detail, /shown as context where the base added lines/);
    assertHunkCounts(interdiffPatch);
  });
});
