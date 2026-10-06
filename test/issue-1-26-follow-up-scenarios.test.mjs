/**
 * The scenarios reported in the follow-up scope issues, as written there.
 *
 * - A follow-up that merges a different feature branch into the pull request
 *   branch, then adds an author commit, read the whole pull request again.
 * - A base merge plus two author commits did too.
 * - A merge whose conflict resolution rewrote the pull request's own code
 *   (a removed card replaced by the base's new component, reshaped imports,
 *   swapped props) read every unchanged line of the pull request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

function withRepository(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-scenarios-'));
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
  try {
    return fn({ root, git, write, edit, commit, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, reviewed, reviewedFiles) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles: reviewedFiles.map((path) => ({ path })),
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.git('rev-parse', 'main').trim(),
  });
}

test('#1: merging a different feature branch and adding a commit reads only what is new', () => {
  withRepository((repository) => {
    repository.write('src/a.ts', lines(60, 'a'));
    repository.write('src/b.ts', lines(20, 'b'));
    repository.commit('initial');

    repository.git('checkout', '-q', '-b', 'pr');
    repository.edit('src/a.ts', 'a 5\n', 'a 5 by the author\n');
    repository.edit('src/a.ts', 'a 15\n', 'a 15 by the author\n');
    const reviewed = repository.commit('author work');

    // A feature branch that left main earlier and touches an existing file
    // and adds a new one.
    repository.git('checkout', '-q', '-b', 'feature', 'main');
    repository.edit('src/b.ts', 'b 7\n', 'b 7 from the feature branch\n');
    repository.write('src/feature.ts', lines(8, 'feature'));
    repository.commit('feature work');

    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'feature', '-m', 'merge the feature branch');
    repository.edit('src/a.ts', 'a 30\n', 'a 30 after the review\n');
    repository.commit('one author commit');

    const { scope, interdiffPatch } = plan(repository, reviewed, ['src/a.ts', 'src/b.ts', 'src/feature.ts']);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/a.ts', 'src/b.ts', 'src/feature.ts']);
    assert.match(interdiffPatch, /^\+b 7 from the feature branch$/m);
    assert.match(interdiffPatch, /^\+feature 1$/m);
    assert.match(interdiffPatch, /^\+a 30 after the review$/m);
    // What the review already read is not read again.
    assert.doesNotMatch(interdiffPatch, /by the author/);
    assert.equal(scope.hunks, 3);
  });
});

test('#1: a base merge and two author commits read the commits and no base change', () => {
  withRepository((repository) => {
    repository.write('src/a.ts', lines(40, 'a'));
    repository.write('src/b.ts', lines(10, 'b'));
    repository.write('src/base-only.ts', lines(5, 'base'));
    repository.commit('initial');

    repository.git('checkout', '-q', '-b', 'pr');
    repository.edit('src/a.ts', 'a 5\n', 'a 5 by the author\n');
    const reviewed = repository.commit('author work');

    repository.git('checkout', '-q', 'main');
    repository.edit('src/a.ts', 'a 35\n', 'a 35 changed on main\n');
    repository.edit('src/base-only.ts', 'base 1\n', 'base 1 moved on main\n');
    repository.commit('base moves on');

    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
    repository.edit('src/b.ts', 'b 3\n', 'b 3 after the review\n');
    repository.commit('first follow-up');
    repository.edit('src/b.ts', 'b 8\n', 'b 8 after the review\n');
    repository.commit('second follow-up');

    const { scope, interdiffPatch } = plan(repository, reviewed, ['src/a.ts', 'src/b.ts']);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/b.ts']);
    assert.match(interdiffPatch, /^\+b 3 after the review$/m);
    assert.match(interdiffPatch, /^\+b 8 after the review$/m);
    assert.doesNotMatch(interdiffPatch, /on main|base-only|by the author/);
  });
});

test('#26: a conflict resolution that rewrites the pull request\'s own code reads those files, not the rest', () => {
  withRepository((repository) => {
    const card = ['import { Card } from "./card";', 'export function Panel() {', '  return <Card title="old" />;', '}', ''].join('\n');
    repository.write('src/panel.tsx', card);
    repository.write('src/props.ts', lines(30, 'prop'));
    repository.write('src/large.ts', lines(2000, 'line'));
    repository.commit('initial');

    repository.git('checkout', '-q', '-b', 'pr');
    repository.write('src/panel.tsx', card.replace('title="old"', 'title="new" dense'));
    repository.edit('src/props.ts', 'prop 4\n', 'prop 4 swapped by the author\n');
    repository.edit('src/large.ts', 'line 1000\n', 'line 1000 by the author\n');
    const reviewed = repository.commit('author work');

    // The base replaces the card the pull request edited, and reshapes the
    // imports of an adjacent region of props.ts.
    repository.git('checkout', '-q', 'main');
    repository.write('src/panel.tsx', ['import { Tile } from "./tile";', 'export function Panel() {', '  return <Tile />;', '}', ''].join('\n'));
    repository.edit('src/props.ts', 'prop 20\n', 'prop 20 reshaped on main\n');
    repository.commit('base replaces the card');

    repository.git('checkout', '-q', 'pr');
    assert.throws(() => repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main'));
    // The author keeps the base's component and carries their prop over, and
    // rewrites their own prop line while resolving.
    repository.write(
      'src/panel.tsx',
      ['import { Tile } from "./tile";', 'export function Panel() {', '  return <Tile dense />;', '}', ''].join('\n'),
    );
    repository.edit('src/props.ts', 'prop 4 swapped by the author\n', 'prop 4 swapped again in the merge\n');
    repository.commit('merge main');

    const { scope, interdiffPatch } = plan(repository, reviewed, ['src/panel.tsx', 'src/props.ts', 'src/large.ts']);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.deepEqual(scope.files, ['src/panel.tsx', 'src/props.ts']);
    assert.match(interdiffPatch, /^\+  return <Tile dense \/>;$/m);
    assert.match(interdiffPatch, /^\+prop 4 swapped again in the merge$/m);
    // None of the base's changes, none of the unconflicted rewrites' neighbours,
    // and none of the two-thousand-line file the merge did not change.
    assert.doesNotMatch(interdiffPatch, /large\.ts|line 1000/);
    assert.doesNotMatch(interdiffPatch, /reshaped on main/);
    assert.ok(interdiffPatch.split('\n').length < 80, `the patch was ${interdiffPatch.split('\n').length} lines`);
  });
});
