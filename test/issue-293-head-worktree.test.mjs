/**
 * #293. The slash command ran evidence and the second pass in whatever the
 * person had checked out, so on a pull-request review they described the
 * wrong tree. `worktree add` gives it the same safe checkout of the head the
 * driver makes, and `worktree remove` takes it away again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function temporary(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A clone with a base commit and a head commit, and a post-checkout hook that leaves a marker if it ever runs. */
function repository(t) {
  const dir = temporary(t, 'rv-293-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.ts'), 'export const value = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'app.ts'), 'export const value = 2;\n');
  git(dir, 'commit', '-q', '-am', 'head');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'HEAD~1');
  const marker = join(dir, '..', `${dir.split('/').pop()}-hook-ran`);
  writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
  t.after(() => rmSync(marker, { force: true }));
  return { dir, head, marker };
}

function cli(cwd, args) {
  const result = spawnSync(process.execPath, [bundle, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const registered = (dir) => git(dir, 'worktree', 'list', '--porcelain');

test('worktree add checks the head out at dir/head without running its hooks, and remove takes it away', (t) => {
  const { dir, head, marker } = repository(t);
  const run = temporary(t, 'rv-293-run-');

  const added = cli(dir, ['worktree', 'add', '--dir', run, '--head', head]);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { path: join(run, 'head'), head });
  assert.equal(readFileSync(join(run, 'head', 'app.ts'), 'utf8'), 'export const value = 2;\n', 'the head, not the checkout');
  assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), 'export const value = 1;\n', 'the person checkout is untouched');
  assert.equal(existsSync(marker), false, 'no hook ran');
  assert.match(registered(dir), new RegExp(`worktree ${join(run, 'head')}\n`));

  const removed = cli(dir, ['worktree', 'remove', '--dir', run]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout), { path: join(run, 'head'), removed: true });
  assert.equal(existsSync(join(run, 'head')), false);
  assert.doesNotMatch(registered(dir), new RegExp(join(run, 'head')));

  const again = cli(dir, ['worktree', 'remove', '--dir', run]);
  assert.equal(again.status, 0, 'remove is safe to run when nothing is there');
  assert.deepEqual(JSON.parse(again.stdout), { path: join(run, 'head'), removed: false });
});

test('worktree add replaces a worktree a stopped run left, and resolves a short ref to its commit', (t) => {
  const { dir, head } = repository(t);
  const run = temporary(t, 'rv-293-run-');
  assert.equal(cli(dir, ['worktree', 'add', '--dir', run, '--head', head]).status, 0);
  writeFileSync(join(run, 'head', 'left-behind.txt'), 'stale\n');

  const again = cli(dir, ['worktree', 'add', '--dir', run, '--head', 'main']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).head, head);
  assert.equal(existsSync(join(run, 'head', 'left-behind.txt')), false, 'a fresh checkout');
  assert.equal(registered(dir).split(join(run, 'head')).length - 1, 1, 'registered once');
});

test('a symbolic link at dir/head is unlinked, never followed', (t) => {
  const { dir, head } = repository(t);
  const run = temporary(t, 'rv-293-run-');
  const elsewhere = temporary(t, 'rv-293-elsewhere-');
  writeFileSync(join(elsewhere, 'keep.txt'), 'keep\n');
  symlinkSync(elsewhere, join(run, 'head'));

  const removed = cli(dir, ['worktree', 'remove', '--dir', run]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, false);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'keep\n');

  symlinkSync(elsewhere, join(run, 'head'));
  assert.equal(cli(dir, ['worktree', 'add', '--dir', run, '--head', head]).status, 0);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'keep\n', 'the link target is untouched');
  assert.equal(existsSync(join(elsewhere, 'app.ts')), false, 'nothing was checked out through the link');
  assert.equal(readFileSync(join(run, 'head', 'app.ts'), 'utf8'), 'export const value = 2;\n');
});

test('worktree refuses a bad invocation with exit 2 and checks nothing out', (t) => {
  const { dir, head } = repository(t);
  const run = temporary(t, 'rv-293-run-');
  const outside = temporary(t, 'rv-293-outside-');
  for (const [args, message] of [
    [['worktree', 'add', '--dir', run, '--head', 'no-such-ref'], /is not a commit in this clone/],
    [['worktree', 'add', '--dir', run, '--head', '--orphan'], /needs --head <commit>/],
    [['worktree', 'add', '--dir', run], /needs --head <commit>/],
    [['worktree', 'add', '--dir', join(run, 'missing'), '--head', head], /is not a directory/],
    [['worktree', 'list', '--dir', run], /Usage: review-voice worktree/],
    [['worktree', 'add', '--head', head], /Usage: review-voice worktree/],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.equal(existsSync(join(run, 'head')), false);
  const notRepo = cli(outside, ['worktree', 'add', '--dir', run, '--head', head]);
  assert.equal(notRepo.status, 2);
});

test('the slash command checks the head out for evidence and the second pass, and removes it on every way out', () => {
  const text = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8');
  const section = (name) => {
    const start = text.indexOf(`## ${name}`);
    assert.ok(start >= 0, name);
    const end = text.indexOf('\n## ', start + 3);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const evidence = section('Step 1c');
  assert.match(evidence, /When `refs\.head\.available` is\ntrue, run `RV worktree add --dir <tmpdir> --head <refs\.head\.sha>`/);
  assert.match(evidence, /`RV evidence --cwd <tmpdir>\/head > <tmpdir>\/evidence\.json`/);
  assert.match(section('Step 3b'), /add `--cwd <tmpdir>\/head` too/);
  const validate = section('Step 6');
  assert.match(validate, /`RV worktree remove --dir <tmpdir>` once the review is recorded, and on every\nother way out too/);
});
