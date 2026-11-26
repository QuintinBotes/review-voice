/**
 * Issue #502: the git calls outside the diff and conventions paths carry a
 * SIGKILL timeout. The fake git answers nothing for the named subcommands: it
 * records its pid, ignores SIGTERM and execs into a sleeper, so only the
 * SIGKILL timeout ends it, and the pid file counts the processes it started.
 * Every other subcommand is the real git. A call with no bound never returns,
 * so each test has a test-runner timeout that fails it instead of the run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { deletedFileCheck } from '../plugins/review-voice/src/cli/score.ts';
import { addHeadWorktree } from '../plugins/review-voice/src/review/worktree.ts';
import { checkCitation } from '../plugins/review-voice/src/scoring/citation.ts';
import { runDoctor } from '../plugins/review-voice/src/doctor.ts';
import { runRecall } from '../plugins/review-voice/src/evaluate/recall.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const posix = process.platform === 'win32' ? { skip: 'the fake git is a POSIX shell script' } : {};
const realGit = process.platform === 'win32' ? 'git' : spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const BOUND_MS = 1500;
const home = process.cwd();
const opts = { ...posix, timeout: 60_000 };

const scratch = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function repo(t) {
  const dir = scratch(t, 'rv-502-repo-');
  const git = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n');
  writeFileSync(join(dir, 'gone.ts'), 'x\ny\nz\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'topic');
  git('rm', '-q', 'gone.ts');
  git('commit', '-q', '-m', 'head');
  return { dir, git, base: git('rev-parse', 'main').trim(), head: git('rev-parse', 'topic').trim() };
}

/** Puts a fake git first on PATH for the callback; returns the pids it started. */
async function hanging(t, subcommands, fn) {
  const dir = scratch(t, 'rv-502-fake-');
  mkdirSync(join(dir, 'bin'));
  const pidFile = join(dir, 'pids');
  const fifo = join(dir, 'fifo');
  const survived = join(dir, 'survived');
  spawnSync('mkfifo', [fifo]);
  // A bash builtin read holds the process with no child to outlive a SIGKILL; the survived marker only
  // appears if nothing killed it, which is what an unbounded call waits for.
  writeFileSync(
    join(dir, 'bin', 'git'),
    [
      '#!/bin/bash',
      'sub=; skip=0',
      'for a in "$@"; do if [ $skip = 1 ]; then skip=0; continue; fi; case "$a" in -c) skip=1;; --version) sub=--version; break;; -*) ;; *) sub=$a; break;; esac; done',
      `case "$sub" in ${subcommands.join('|')})`,
      "  trap '' TERM",
      `  echo $$ >> "${pidFile}"`,
      `  exec 3<>"${fifo}"`,
      '  read -t 20 -u 3 line',
      `  echo survived >> "${survived}"`,
      '  exit 1',
      '  ;;',
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'bin', 'git'), 0o755);
  const saved = { path: process.env.PATH, bound: process.env.REVIEW_VOICE_GIT_TIMEOUT_MS };
  process.env.PATH = `${join(dir, 'bin')}:${saved.path}`;
  process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = String(BOUND_MS);
  let result;
  try {
    result = await fn();
  } finally {
    process.env.PATH = saved.path;
    if (saved.bound === undefined) delete process.env.REVIEW_VOICE_GIT_TIMEOUT_MS;
    else process.env.REVIEW_VOICE_GIT_TIMEOUT_MS = saved.bound;
    process.chdir(home);
  }
  let pids = [];
  try {
    pids = readFileSync(pidFile, 'utf8').split('\n').filter((l) => l !== '').map(Number);
  } catch {}
  return { result, pids, survived: existsSync(survived) };
}

/** Every pid the fake started is gone: it was killed, not left behind. */
async function assertGone(pids, survived) {
  assert.equal(survived, false, 'the fake git was ended at its bound, not left to answer');
  assert.ok(pids.length > 0, 'the fake git was reached, so the check is not vacuous');
  for (const pid of pids) {
    let alive = true;
    for (let waited = 0; waited < 5000 && alive; waited += 50) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, `git ${pid} was killed at its bound`);
  }
}

const notInDiff = { ok: false, kind: 'file-not-in-diff' };

test('score: the deleted-file check reads a hung merge-base as no exemption and leaves no git behind', opts, async (t) => {
  const r = repo(t);
  process.chdir(r.dir);
  const { result, pids, survived } = await hanging(t, ['merge-base'], () => {
    const check = deletedFileCheck(['--base', r.base, '--head', r.head]);
    return check({ path: 'gone.ts', line: 2 }, notInDiff);
  });
  assert.equal(result, false);
  await assertGone(pids, survived);
});

test('score: with a real git the deleted-file check still exempts a deleted file', opts, (t) => {
  const r = repo(t);
  process.chdir(r.dir);
  const check = deletedFileCheck(['--base', r.base, '--head', r.head]);
  assert.equal(check({ path: 'gone.ts', line: 2 }, notInDiff), true);
});

test('record: a hung git show leaves the held line unchecked, exits 0 and leaves no git behind', opts, async (t) => {
  const r = repo(t);
  const data = scratch(t, 'rv-502-data-');
  const held = join(data, 'held.json');
  writeFileSync(held, JSON.stringify([{ path: 'a.ts', line: 9, verdict: 'repeat', source: 'thread', reason: 'already raised' }]));
  const files = join(data, 'files.json');
  writeFileSync(files, JSON.stringify({ files: [{ path: 'a.ts' }] }));
  const review = '[important] `a.ts:2` - `load` returns null here, so the caller dereferences it.\n';
  process.env.REVIEW_VOICE_DATA_DIR = data;
  t.after(() => delete process.env.REVIEW_VOICE_DATA_DIR);
  process.chdir(r.dir);
  const { result, pids, survived } = await hanging(t, ['show'], () => runInProcess(['record', '--repository', 'o/r', '--head', r.head, '--held', held, '--files', files], { stdin: review }));
  assert.equal(result.code, 0, result.stderr);
  await assertGone(pids, survived);
});

test('review worktree: a hung git worktree fails the checkout and leaves no git behind', opts, async (t) => {
  const r = repo(t);
  const target = join(scratch(t, 'rv-502-wt-'), 'head');
  const { result, pids, survived } = await hanging(t, ['worktree'], async () => {
    try {
      addHeadWorktree(target, r.head, r.dir);
    } catch (error) {
      return error;
    }
    return null;
  });
  assert.ok(result instanceof Error, 'the unanswered git ended in an error, not a hang');
  await assertGone(pids, survived);
});

test('citation: a hung ls-tree is inconclusive and leaves no git behind', opts, async (t) => {
  const r = repo(t);
  const { result, pids, survived } = await hanging(t, ['ls-tree'], () => checkCitation('nope.ts', r.dir, r.head, null));
  assert.equal(result.inconclusive, true);
  await assertGone(pids, survived);
});

test('evaluate recall: a hung git diff in the shim ends the fixture run and leaves no git behind', opts, async (t) => {
  const { result, pids, survived } = await hanging(t, ['diff'], async () => {
    try {
      await runRecall(
        { fixtures: join(root, 'test/fixtures-recall'), classes: ['positive'], runner: 'fake', only: 'positive/hit', keep: false },
        { commandWith: (fetchImpl) => (args, stdin) => runInProcess(args, { stdin, fetchImpl }), onRequest: () => {} },
      );
    } catch (error) {
      return error;
    }
    return null;
  });
  void result;
  await assertGone(pids, survived);
});

test('evaluate benchmark: a hung git diff in the probe ends the import and leaves no git behind', opts, async (t) => {
  process.chdir(home);
  const synthetic = join(root, 'test/fixtures-benchmark');
  const out = scratch(t, 'rv-502-out-');
  const { pids, survived } = await hanging(t, ['diff'], () =>
    runInProcess([
      'import-benchmark', '--from', join(synthetic, 'set.jsonl'), '--set-version', 'v1.0', '--set-licence', 'MIT',
      '--licences', join(synthetic, 'licences.json'), '--diffs', join(synthetic, 'diffs'), '--out', out,
    ]),
  );
  await assertGone(pids, survived);
});

test('doctor: a git that hangs on --version is reported as unavailable and leaves no git behind', opts, async (t) => {
  const { result, pids, survived } = await hanging(t, ['--version'], () => runDoctor().find((check) => check.name === 'git'));
  assert.equal(result.ok, false);
  await assertGone(pids, survived);
});

test('guard: every synchronous child-process call in src carries a timeout, git or not', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(join(root, 'plugins/review-voice/src'));
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?<![.\w])(?:execFileSync|spawnSync|execSync)\(/g)) {
      // The call's text, to its closing parenthesis.
      let depth = 0;
      let end = match.index;
      for (let i = text.indexOf('(', match.index); i < text.length; i += 1) {
        if (text[i] === '(') depth += 1;
        if (text[i] === ')' && --depth === 0) {
          end = i;
          break;
        }
      }
      const call = text.slice(match.index, end + 1);
      const where = `${relative(root, file)}:${text.slice(0, match.index).split('\n').length}`;
      if (!/\btimeout\b|boundedGit\(/.test(call)) offenders.push(where);
    }
  }
  assert.deepEqual(offenders, [], 'child-process calls without a timeout');
});
