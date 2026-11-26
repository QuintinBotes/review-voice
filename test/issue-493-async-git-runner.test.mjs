/**
 * Issue #493: git runs through the async runner of `evidence/run.ts`, and the
 * timer ends git's process group (the tree on Windows) while git is still
 * unreaped, never after it has returned, when its group id may be another's.
 *
 * Nothing here asserts on elapsed time. The kill is observed by wrapping
 * `process.kill`, ordering is read from counted events and process state, and
 * the hung git is a fake that answers only when the test lets it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlobs } from '../plugins/review-voice/src/diff/structure.ts';
import { gitTreeReader } from '../plugins/review-voice/src/conventions/tree.ts';
import { commitReadable } from '../plugins/review-voice/src/diff/carry.ts';
import { runGit, runGitCatFile } from '../plugins/review-voice/src/git-exec.ts';

// Long enough for the fake git's shell to start on a loaded machine; it is a bound, not an assertion on time.
const BOUND_MS = 3000;
const posixOnly = { skip: process.platform === 'win32' && 'the fake git is a POSIX shell script' };
const realGit = process.platform === 'win32' ? 'git' : spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scratchRepo(t) {
  const dir = scratch(t, 'rv-493-repo-');
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

/** A bin directory whose `git` is the given script body (after the shebang) for `cat-file`, real git otherwise. */
function fakeGit(t, body) {
  const dir = scratch(t, 'rv-493-fake-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pids = join(dir, 'pids');
  writeFileSync(join(bin, 'git'), ['#!/bin/sh', 'if [ "$1" = "cat-file" ]; then', body.replaceAll('$PIDS', `"${pids}"`), 'fi', `exec "${realGit}" "$@"`, ''].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, pids };
}

async function withPath(path, fn) {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

const pidsIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map(Number) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const zombie = (pid) => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');

/** Waits, in event-loop turns rather than a clock, until `done()`; gives up after many turns so a failure is a failure, not a hang. */
async function until(done) {
  for (let turn = 0; turn < 2000 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return done();
}

async function gone(pid) {
  for (let polls = 0; polls < 200 && alive(pid) && !zombie(pid); polls += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  if (alive(pid) && !zombie(pid)) process.kill(pid, 'SIGKILL');
  return !alive(pid) || zombie(pid);
}

/** Wraps process.kill, recording each group kill (negative pid) with the state of the world at that moment. */
function recordGroupKills(t, snapshot) {
  const real = process.kill;
  const kills = [];
  process.kill = function kill(pid, signal) {
    if (typeof pid === 'number' && pid < 0) kills.push({ pid: -pid, signal, ...snapshot(-pid) });
    return real.call(process, pid, signal);
  };
  t.after(() => {
    process.kill = real;
  });
  return kills;
}

test('the group is killed from the timer while git is unreaped, before the call settles', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, '  echo $$ >> $PIDS\n  exec sleep 60');
  let settled = false;
  const kills = recordGroupKills(t, (pid) => ({ settledAtKill: settled, leaderAlive: alive(pid) && !zombie(pid) }));
  const failure = await withPath(`${fake.bin}:${process.env.PATH}`, async () => {
    try {
      await runGitCatFile(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { maxBuffer: 1 << 20, timeoutMs: BOUND_MS }).finally(() => {
        settled = true;
      });
    } catch (error) {
      return error;
    }
    return null;
  });
  assert.equal(failure?.code, 'ETIMEDOUT');
  const [pid] = pidsIn(fake.pids);
  const groupKills = kills.filter((kill) => kill.pid === pid);
  assert.equal(groupKills.length, 1, 'exactly one group kill, aimed at git');
  assert.equal(groupKills[0].settledAtKill, false, 'sent before the call settled');
  assert.equal(groupKills[0].leaderAlive, true, 'sent while git was still running, so its group id was still its own');
  assert.equal(await gone(pid), true);
});

test('a normal exit, clean or failed, sends no group kill', async (t) => {
  const dir = scratchRepo(t);
  const kills = recordGroupKills(t, () => ({}));
  const out = await runGitCatFile(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { maxBuffer: 1 << 20, timeoutMs: BOUND_MS });
  assert.equal(out.toString('utf8'), 'a\n');
  await assert.rejects(runGit(dir, ['cat-file', 'blob', 'HEAD:missing.txt'], { timeoutMs: BOUND_MS }), /failed/);
  assert.deepEqual(kills, [], 'once git is reaped its group id may be reused, so nothing is signalled');
});

test('a descendant that holds the pipes and ignores SIGTERM dies at the bound', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  // git itself waits; the descendant ignores SIGTERM, and keeps stdout and stderr open.
  const fake = fakeGit(t, "  echo $$ >> $PIDS\n  (trap '' TERM; exec sleep 60) &\n  echo $! >> $PIDS\n  wait");
  const failure = await withPath(`${fake.bin}:${process.env.PATH}`, async () => {
    try {
      await runGitCatFile(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { maxBuffer: 1 << 20, timeoutMs: BOUND_MS });
    } catch (error) {
      return error;
    }
    return null;
  });
  assert.equal(failure?.code, 'ETIMEDOUT');
  const pids = pidsIn(fake.pids);
  assert.equal(pids.length, 2, 'git and its descendant both started');
  for (const pid of pids) assert.equal(await gone(pid), true, `process ${pid} went with the group`);
});

test('a flood of output is capped, and git is stopped', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, '  echo $$ >> $PIDS\n  exec yes');
  const failure = await withPath(`${fake.bin}:${process.env.PATH}`, async () => {
    try {
      await runGitCatFile(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { maxBuffer: 1024, timeoutMs: 60_000 });
    } catch (error) {
      return error;
    }
    return null;
  });
  assert.equal(failure?.code, 'ENOBUFS', 'rejects on overflow, as spawnSync did');
  const [pid] = pidsIn(fake.pids);
  assert.equal(await gone(pid), true, 'the flooding git was stopped, not left writing');
});

test('a missing git binary degrades as it did: the call rejects, and readers see an unreadable blob', async (t) => {
  const dir = scratchRepo(t);
  const empty = scratch(t, 'rv-493-nogit-');
  await withPath(empty, async () => {
    await assert.rejects(runGit(dir, ['rev-parse', 'HEAD'], { timeoutMs: BOUND_MS }), (error) => error.code === 'ENOENT');
    assert.equal(await commitReadable('HEAD', dir), false);
    assert.deepEqual([...(await readBlobs(dir, ['HEAD:a.txt'])).entries()], [['HEAD:a.txt', null]]);
    await assert.rejects(gitTreeReader(dir, 'HEAD'), (error) => error.code === 'ENOENT');
  });
});

test('a git that never answers is killed at the bound, and the event loop keeps turning meanwhile', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t, '  echo $$ >> $PIDS\n  exec sleep 60');
  let turns = 0;
  const ticker = setInterval(() => {
    turns += 1;
  }, 10);
  t.after(() => clearInterval(ticker));
  const failure = await withPath(`${fake.bin}:${process.env.PATH}`, async () => {
    try {
      await runGit(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { timeoutMs: BOUND_MS });
    } catch (error) {
      return error;
    }
    return null;
  });
  assert.equal(failure?.code, 'ETIMEDOUT');
  assert.match(failure.message, /timed out after 3s/);
  // A blocked event loop (spawnSync) runs no timer until git returns; an async runner lets many fire.
  assert.ok(turns > 0, `timers ran while git was pending (${turns})`);
  assert.equal(await until(() => pidsIn(fake.pids).length > 0), true);
  assert.equal(await gone(pidsIn(fake.pids)[0]), true);
});
