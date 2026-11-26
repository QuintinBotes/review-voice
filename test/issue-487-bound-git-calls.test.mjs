/**
 * Issue #487: the remaining unbounded git calls in the diff and conventions
 * path now run through `runGit`, bounded and group-killed like the
 * cat-file reads of #482. The fake git hangs the named subcommands holding
 * stdout open through a sleeper; every other subcommand is the real git.
 * The runner is async since #493, so the timer ends the group while git is unreaped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitReadable } from '../plugins/review-voice/src/diff/carry.ts';
import { linguistGeneratedPaths } from '../plugins/review-voice/src/diff/acquire.ts';
import { gitTreeReader } from '../plugins/review-voice/src/conventions/tree.ts';
import { GIT_CHECK_TIMEOUT_MS, GIT_READ_TIMEOUT_MS, gitTimeoutMs, runGit } from '../plugins/review-voice/src/git-exec.ts';

// Long enough for the fake git's shell to start its sleeper on a loaded machine.
const TIMEOUT_MS = 3000;
const posixOnly = { skip: process.platform === 'win32' && 'the fake git is a POSIX shell script' };
const realGit = process.platform === 'win32' ? 'git' : spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-487-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

function fakeGit(t, hanging) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-487-fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pidFile = join(dir, 'sleepers.pid');
  const cases = hanging.map((name) => `"${name}"`).join('|');
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      `case "$1" in ${cases})`,
      '  sleep 60 &',
      `  echo $! >> "${pidFile}"`,
      '  wait',
      '  ;;',
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, pidFile };
}

async function withHangingGit(fake, fn) {
  const saved = { path: process.env.PATH, bound: process.env.REVIEW_VOICE_GIT_TIMEOUT_MS };
  process.env.PATH = `${fake.bin}:${saved.path ?? ''}`;
  process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = String(TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.path;
    if (saved.bound === undefined) delete process.env.REVIEW_VOICE_GIT_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = saved.bound;
  }
}

async function assertSleepersGone(pidFile) {
  let pids = [];
  try {
    pids = readFileSync(pidFile, 'utf8').split('\n').filter((l) => l.trim() !== '').map(Number);
  } catch {}
  assert.ok(pids.length > 0, 'the fake git spawned a sleeper, so the check is not vacuous');
  for (const pid of pids) {
    let alive = true;
    for (let waited = 0; waited < 5000; waited += 50) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, `sleeper ${pid} went with its process group`);
  }
}

test('commitReadable (rev-parse) is false within the bound when git hangs, and the sleeper is gone', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, ['rev-parse']);
  const started = Date.now();
  const readable = await withHangingGit(fake, () => commitReadable('HEAD', dir));
  assert.ok(Date.now() - started < 30000, 'returned without waiting on the sleeper');
  assert.equal(readable, false);
  await assertSleepersGone(fake.pidFile);
});

test('the cat-file -e check in acquisition reads as an absent commit within the bound', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, ['cat-file']);
  const started = Date.now();
  const paths = await withHangingGit(fake, () => linguistGeneratedPaths(dir, ['a.txt'], 'HEAD'));
  assert.ok(Date.now() - started < 30000);
  assert.equal(paths.size, 0);
  await assertSleepersGone(fake.pidFile);
});

test('check-attr takes its failure path (nothing marked generated) within the bound', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, ['check-attr']);
  const started = Date.now();
  const paths = await withHangingGit(fake, () => linguistGeneratedPaths(dir, ['a.txt'], 'HEAD'));
  assert.ok(Date.now() - started < 30000);
  assert.equal(paths.size, 0);
  await assertSleepersGone(fake.pidFile);
});

test('ls-tree in the tree reader throws ETIMEDOUT within the bound', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, ['ls-tree']);
  const started = Date.now();
  const error = await withHangingGit(fake, async () => {
    try {
      await gitTreeReader(dir, 'HEAD');
    } catch (e) {
      return e;
    }
    return null;
  });
  assert.ok(Date.now() - started < 30000);
  assert.equal(error?.code, 'ETIMEDOUT');
  await assertSleepersGone(fake.pidFile);
});

test('with a real git the calls behave as before, and failures keep status and stdout', async (t) => {
  const dir = scratchRepo(t);
  assert.equal(await commitReadable('HEAD', dir), true);
  assert.equal(await commitReadable('nope', dir), false);
  assert.equal((await (await gitTreeReader(dir, 'HEAD')).read('a.txt')).toString('utf8'), 'a\n');
  assert.equal((await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_READ_TIMEOUT_MS })).toString('utf8').trim(), 'main');
  let failure;
  try {
    await runGit(dir, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD^'], { timeoutMs: GIT_READ_TIMEOUT_MS });
  } catch (e) {
    failure = e;
  }
  assert.equal(typeof failure?.status, 'number');
  assert.equal(typeof failure?.stdout, 'string');
});

test('the bound only shortens through the environment', () => {
  const saved = process.env.REVIEW_VOICE_GIT_TIMEOUT_MS;
  try {
    process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = String(GIT_CHECK_TIMEOUT_MS * 100);
    assert.equal(gitTimeoutMs(GIT_CHECK_TIMEOUT_MS), GIT_CHECK_TIMEOUT_MS);
    process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = '250';
    assert.equal(gitTimeoutMs(GIT_READ_TIMEOUT_MS), 250);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_VOICE_GIT_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = saved;
  }
});
