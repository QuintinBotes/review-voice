/**
 * Issue #482 (async since #493): `review-voice diff` hung for about 7 hours in
 * `git cat-file --batch` (`readBlobs`), which in a partial clone starts
 * a lazy fetch over ssh that stalled on a dead connection. Both that
 * batch and the per-blob `cat-file blob` in conventions/tree.ts are now
 * bounded, and the bound holds when a descendant (git fetch, ssh) keeps
 * stdout open: git runs in its own process group and the group is
 * killed, so the sleeping descendant goes with it.
 *
 * The fake git below spawns a 60s sleeper holding stdout open and then
 * waits on it, exactly the hung shape. Timeouts are injected through
 * REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS /
 * REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlobs } from '../plugins/review-voice/src/diff/structure.ts';
import { gitTreeReader } from '../plugins/review-voice/src/conventions/tree.ts';
import { discoverConventions } from '../plugins/review-voice/src/conventions/discover.ts';
import { CAT_FILE_BATCH_TIMEOUT_MS, catFileBatchTimeoutMs, isPartialClone, resetCatFileTimeoutWarning } from '../plugins/review-voice/src/git-exec.ts';

// Long enough for the fake git's shell to start its sleeper on a loaded machine (400 ms was not),
// far below the 60 s sleeper the bounded call must not wait on.
const TIMEOUT_MS = 3000;
const posixOnly = { skip: process.platform === 'win32' && 'the fake git is a POSIX shell script' };

// Resolved only off Windows, where the POSIX-only tests skip and `which` may not exist.
const realGit = process.platform === 'win32' ? 'git' : spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function scratchRepo(t, { partial = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-482-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'CLAUDE.md'), 'Handlers validate before they persist.\n');
  writeFileSync(join(dir, 'src.ts'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  if (partial) git('config', 'remote.origin.partialclonefilter', 'blob:none');
  return dir;
}

/**
 * A bin directory holding a fake `git` whose `cat-file` spawns a sleeper
 * that inherits (and so holds open) stdout and stderr, appends its pid,
 * and waits. Every other subcommand delegates to the real git.
 */
function fakeGit(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-482-fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pidFile = join(dir, 'sleepers.pid');
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = "cat-file" ]; then',
      '  sleep 60 &',
      `  echo $! >> "${pidFile}"`,
      '  wait',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, pidFile };
}

/**
 * Runs `fn` with the fake git first on PATH and both
 * cat-file timeouts injected, capturing stderr lines printed through
 * console.error. Everything is restored afterwards.
 */
async function withHangingGit(fake, fn) {
  const saved = {
    path: process.env.PATH,
    batch: process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS,
    blob: process.env.REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS,
    error: console.error,
  };
  const stderrLines = [];
  process.env.PATH = `${fake.bin}:${saved.path ?? ''}`;
  process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS = String(TIMEOUT_MS);
  process.env.REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS = String(TIMEOUT_MS);
  console.error = (...args) => stderrLines.push(args.join(' '));
  try {
    return { value: await fn(), stderrLines };
  } finally {
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.batch === undefined) delete process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS = saved.batch;
    if (saved.blob === undefined) delete process.env.REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS = saved.blob;
    console.error = saved.error;
  }
}

function sleeperPids(pidFile) {
  try {
    return readFileSync(pidFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map(Number);
  } catch {
    return [];
  }
}

/** After a moment for the kill to land, every sleeper is gone. */
async function assertSleepersGone(pidFile) {
  const pids = sleeperPids(pidFile);
  assert.ok(pids.length > 0, 'the fake git spawned a sleeper, so the checks below are not vacuous');
  for (const pid of pids) {
    let alive = true;
    for (let waited = 0; alive && waited < 5000; waited += 50) {
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

test('readBlobs returns nulls within the bound when cat-file hangs holding stdout open, and the sleeper is gone', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t);
  resetCatFileTimeoutWarning();
  const started = Date.now();
  const { value: blobs, stderrLines } = await withHangingGit(fake, async () => readBlobs(dir, ['HEAD:CLAUDE.md', 'HEAD:src.ts']));
  const elapsed = Date.now() - started;
  // Well under the 60 s sleeper, with room for a loaded machine: a 5 s margin flaked once at 14 s.
  assert.ok(elapsed < 30000, `returned without waiting on the sleeper (took ${elapsed}ms)`);
  assert.deepEqual([...blobs.entries()], [['HEAD:CLAUDE.md', null], ['HEAD:src.ts', null]], 'every spec maps to null, and that is not an error');
  assert.deepEqual(stderrLines, [], 'a normal clone prints no partial-clone line');
  await assertSleepersGone(fake.pidFile);
});

test('the tree blob read fails as unreadable within the bound, and discovery skips the document', posixOnly, async (t) => {
  const dir = scratchRepo(t);
  const fake = fakeGit(t);
  resetCatFileTimeoutWarning();
  const started = Date.now();
  const { value } = await withHangingGit(fake, async () => {
    const reader = await gitTreeReader(dir, 'HEAD');
    let readError = null;
    try {
      await reader.read('CLAUDE.md');
    } catch (error) {
      readError = error;
    }
    const report = await discoverConventions(dir, [], await gitTreeReader(dir, 'HEAD'));
    return { readError, report };
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30000, `bounded, well under the 60 s sleeper (took ${elapsed}ms)`);
  assert.ok(value.readError instanceof Error, 'the blob read throws instead of hanging');
  assert.match(value.readError.message, /timed out/);
  assert.equal(value.readError.code, 'ETIMEDOUT');
  const skipped = value.report.skipped.find((entry) => entry.path === 'CLAUDE.md');
  assert.ok(skipped !== undefined, 'discovery treats the blob as unreadable and skips it');
  assert.match(skipped.reason, /timed out/);
  assert.deepEqual(value.report.documents, []);
  await assertSleepersGone(fake.pidFile);
});

test('a timeout in a partial clone prints one stderr line naming it, once', posixOnly, async (t) => {
  const dir = scratchRepo(t, { partial: true });
  assert.equal(isPartialClone(dir), true, 'the fixture reads as a partial clone');
  const fake = fakeGit(t);
  resetCatFileTimeoutWarning();
  const { stderrLines } = await withHangingGit(fake, async () => {
    await readBlobs(dir, ['HEAD:CLAUDE.md']);
    await readBlobs(dir, ['HEAD:CLAUDE.md']);
  });
  assert.equal(stderrLines.length, 1, 'once per command, not once per batch');
  assert.match(stderrLines[0], /partial clone/);
  await assertSleepersGone(fake.pidFile);
});

test('with a real git, readBlobs and the tree reader return the blobs as before', async (t) => {
  const dir = scratchRepo(t);
  assert.equal(isPartialClone(dir), false);
  const blobs = await readBlobs(dir, ['HEAD:CLAUDE.md', 'HEAD:missing.md']);
  assert.equal(blobs.get('HEAD:CLAUDE.md')?.toString('utf8'), 'Handlers validate before they persist.\n');
  assert.equal(blobs.get('HEAD:missing.md'), null);
  const reader = await gitTreeReader(dir, 'HEAD');
  assert.equal((await reader.read('CLAUDE.md')).toString('utf8'), 'Handlers validate before they persist.\n');
  const report = await discoverConventions(dir, [], reader);
  assert.deepEqual(report.documents.map((document) => document.path), ['CLAUDE.md']);
});

test('an environment override can only shorten the bounds, never lift them', () => {
  const saved = process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS;
  try {
    process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS = String(CAT_FILE_BATCH_TIMEOUT_MS * 100);
    assert.equal(catFileBatchTimeoutMs(), CAT_FILE_BATCH_TIMEOUT_MS);
    process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS = '250';
    assert.equal(catFileBatchTimeoutMs(), 250);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS = saved;
  }
});
