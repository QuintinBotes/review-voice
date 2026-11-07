/** #235: context overlap must not replace new work with already reviewed hunks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const files = ['src/client.tsx', 'test/client.test.ts', 'test/handlers.ts'];
const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}\n`).join('');
const parent = original.replace('line 80\n', 'parent feature\n');
const approved = parent
  .replace('line 5\n', "import { approved } from './approved';\n")
  .replace('line 30\n', '<Approved />\n')
  .replace('line 34\n', 'retry = isTemporary(error);\n')
  .replace('line 60\n', 'previous handler\n');

function withSquashedParent(fn, { baseLine = 9, baseText = 'base update\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-235-'));
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
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.filemode', 'true');
    git('config', 'diff.context', '3');
    git('config', 'merge.conflictStyle', 'merge');
    for (const path of files) write(path, original);
    commit('initial');
    git('checkout', '-q', '-b', 'parent');
    for (const path of files) write(path, parent);
    commit('stacked parent');
    git('checkout', '-q', '-b', 'pr');
    for (const path of files) write(path, approved);
    const reviewed = commit('reviewed head A');

    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'parent');
    commit('squash parent into main');
    for (const path of files) {
      write(path, parent.replace('line 5\n', 'base conflict\n').replace(`line ${baseLine}\n`, baseText));
    }
    const base = commit('base advances');
    git('checkout', '-q', 'pr');
    assert.throws(() => git('merge', '-q', '--no-ff', 'main', '-m', 'merge base'));
    assert.deepEqual(git('diff', '--name-only', '--diff-filter=U').trim().split('\n'), files);
    const merged = approved.replace(`line ${baseLine}\n`, baseText);
    for (const path of files) write(path, merged);
    commit('resolve merge keeping approved code');
    return fn({ root, git, write, commit, reviewed, base, merged });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository) {
  return planScope({
    priorRun: { reviewRunId: null, headRef: repository.reviewed, createdAt: null },
    head: repository.git('rev-parse', 'HEAD').trim(),
    headAvailable: true,
    reviewedFiles: files.map((path) => ({ path })),
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.base,
  });
}

function assertTwoHeadChanges(repository, interdiffPatch) {
  for (const path of files) {
    const delta = repository.git('diff', repository.reviewed, 'HEAD', '--', path);
    // The isolated line 9 hunk is the only change inherited from the base.
    const expected = delta.split(/(?=^@@ )/m).filter((part) => !part.includes('-line 9\n')).join('');
    const actual = interdiffPatch.split(/(?=^diff --git )/m).find((part) => part.startsWith(`diff --git a/${path} b/${path}\n`));
    assert.equal(actual, expected, `${path} must equal the two-head diff minus the base hunk`);
  }
  assert.doesNotMatch(interdiffPatch, /^[-+].*(?:approved|Approved|base update|base conflict)/m);
  assert.doesNotMatch(interdiffPatch, /<<<<<<<|>>>>>>>/);
}

test('a conflicting replay after a stacked squash merge emits only the new two-head hunks', () => {
  withSquashedParent((repository) => {
    const merged = repository.merged;
    repository.write(files[0], merged.replace('retry = isTemporary(error);', 'retry = isTemporary(error) && attempts < 3;'));
    repository.write(files[1], merged.replace('retry = isTemporary(error);\n', "retry = isTemporary(error);\ntest('retry stops', retryStops);\n"));
    repository.write(files[2], merged.replace('retry = isTemporary(error);\n', 'retry = isTemporary(error);\nhandler = retryFailure;\n'));
    repository.commit('small follow-up at head B');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, files);
    assertTwoHeadChanges(repository, interdiffPatch);
  });
});

test('an unmatched withdrawal keeps the two-head change and reports its fallback', () => {
  withSquashedParent((repository) => {
    for (const path of files) {
      repository.write(path, repository.merged.replace('previous handler\n', 'line 60\n'));
    }
    repository.commit('withdraw a reviewed handler at head B');

    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assertTwoHeadChanges(repository, interdiffPatch);
    assert.match(scope.detail, /two-head diff.*could not be matched to hunks/);
  });
});

const clientSection = (interdiffPatch) =>
  interdiffPatch.split(/(?=^diff --git )/m).find((part) => part.startsWith(`diff --git a/${files[0]} b/${files[0]}\n`));

test('an inherited base edit sharing a hunk with the author\'s edit is taken out of that hunk', () => {
  withSquashedParent((repository) => {
    // Three unchanged lines apart: one git hunk, two edit runs.
    repository.write(files[0], repository.merged.replace('line 12\n', 'new author work\n'));
    repository.commit('edit beside the inherited base change');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.doesNotMatch(scope.detail ?? '', /kept whole hunks/);
    const section = clientSection(interdiffPatch);
    // The author's edit is the only edit left; the base's line 9 reads as the context it now is.
    assert.deepEqual(section.split('\n').filter((text) => /^[-+][^-+]/.test(text)), ['-line 12', '+new author work']);
    assert.match(section, /^ base update$/m);
    // The recounted header still describes the body, so every later reader of the hunk agrees with it.
    const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/m.exec(section);
    const body = section.slice(section.indexOf('@@')).split('\n').slice(1).filter((text) => text !== '' && !text.startsWith('\\'));
    assert.equal(body.filter((text) => !text.startsWith('+')).length, Number(oldCount));
    assert.equal(body.filter((text) => !text.startsWith('-')).length, Number(newCount));
    assert.doesNotMatch(interdiffPatch, /^[-+].*(?:approved|Approved)/m, 'reviewed hunks are still not re-emitted');
  });
});

test('a base edit on the line right above the author\'s forms one edit run with it, which is kept whole and named', () => {
  withSquashedParent((repository) => {
    repository.write(files[0], repository.merged.replace('line 10\n', 'new author work\n'));
    repository.commit('edit on the line after the inherited base change');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(scope.detail, /kept whole hunks where the base's and the author's edits could not be separated after a conflicting replay: src\/client\.tsx/);
    // The diff pairs the two removed lines with the two added ones as one run, so the base's line rides along.
    assert.deepEqual(clientSection(interdiffPatch).split('\n').filter((text) => /^[-+][^-+]/.test(text)), ['-line 9', '-line 10', '+base update', '+new author work']);
    assert.doesNotMatch(interdiffPatch, /^[-+].*(?:approved|Approved)/m, 'reviewed hunks are still not re-emitted');
  });
});

test('a base edit grouped with a reversed PR edit keeps the hunk whole rather than hiding the reversal', () => {
  withSquashedParent((repository) => {
    repository.write(files[0], repository.merged.replace('retry = isTemporary(error);', 'retry = false;'));
    repository.commit('new retry predicate');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(scope.detail, /could not be separated after a conflicting replay: src\/client\.tsx/);
    assert.match(interdiffPatch, /^\+retry = false;$/m);
  }, { baseLine: 6 });
});

test('an executable mode change cannot be read hunk by hunk and falls back to a full read', () => {
  withSquashedParent((repository) => {
    chmodSync(join(repository.root, files[0]), 0o755);
    repository.commit('make the client executable');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'full', JSON.stringify(scope));
    assert.match(scope.detail, /the two-head diff of src\/client\.tsx could not be read hunk by hunk/);
    assert.equal(interdiffPatch, null);
  });
});

test('insertions, deletions and final newline changes retain their exact two-head text', () => {
  withSquashedParent((repository) => {
    for (const path of files) {
      repository.write(path, repository.merged
        .replace('line 50\n', 'line 50\nnew test handler\n')
        .replace('previous handler\n', '')
        .replace('line 100\n', 'line 100  '));
    }
    repository.commit('insert and remove handlers and change the final newline');
    const { scope, interdiffPatch } = plan(repository);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assertTwoHeadChanges(repository, interdiffPatch);
  });
});

for (const baseText of ['base update\nextra base line\n', '']) {
  test(`a base ${baseText === '' ? 'deletion' : 'insertion'} shifts lines without changing the two-head hunks`, () => {
    withSquashedParent((repository) => {
      for (const path of files) {
        repository.write(path, repository.merged.replace('retry = isTemporary(error);', 'retry = false;'));
      }
      repository.commit('new predicate after shifted base lines');
      const { scope, interdiffPatch } = plan(repository);
      assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
      assertTwoHeadChanges(repository, interdiffPatch);
    }, { baseText });
  });
}
