/**
 * #277. Configured commands ran with spawnSync, which blocks the event loop,
 * so a stop signal waited for the command, up to its whole timeout, and a
 * watcher's SIGKILL after its grace period left the head worktree behind.
 * They now run with the asynchronous spawner, which keeps spawnSync's
 * reporting, and stopCommands kills every one still running. The driver's
 * signal tests are in review-driver.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { collectEvidence, commandEnvironment, spawnCommand, stopCommands } from '../plugins/review-voice/src/evidence/run.ts';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-277-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const options = (cwd, over = {}) => ({
  cwd, env: commandEnvironment(process.env, []), shell: true, encoding: 'utf8',
  timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, detached: true, ...over,
});

/** The pid a command wrote, once it has written it. */
async function pidIn(file) {
  for (let waited = 0; !existsSync(file) || readFileSync(file, 'utf8').trim() === ''; waited += 20) {
    assert.ok(waited < 10000, `${file} never held a pid`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return Number(readFileSync(file, 'utf8'));
}

/** After a moment for the kill to land, the process is gone. */
async function assertGone(pid, what) {
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(alive, false, what);
}

test('a check past its timeout is reported as timed out after its seconds, and its background child is killed', async (t) => {
  const dir = temporary(t);
  const pidFile = join(dir, 'child.pid');
  const started = Date.now();
  const report = await collectEvidence([{ name: 'slow', run: `sleep 30 & echo $! > "${pidFile}"; wait`, timeoutSeconds: 1 }], { cwd: dir, enabled: true });
  assert.ok(Date.now() - started < 5000, 'the timeout cut it off');
  assert.equal(report.commands[0].unavailable, 'timed out after 1s');
  assert.equal(report.commands[0].exitCode, null);
  assert.deepEqual(report.didNotRun, ['slow']);
  await assertGone(await pidIn(pidFile), 'the background child went with its process group');
});

test('a shell that cannot find the tool exits 127, which is reported as not runnable', async (t) => {
  const report = await collectEvidence([{ name: 'missing', run: 'no-such-tool-for-issue-277 --check' }], { cwd: temporary(t), enabled: true });
  assert.equal(report.commands[0].exitCode, 127);
  assert.equal(report.commands[0].unavailable, 'not found or not executable (exit 127)');
  assert.deepEqual(report.didNotRun, ['missing']);
});

test('output past the cap is cut there, and the check is reported as not run, as under spawnSync', async (t) => {
  const dir = temporary(t);
  const direct = await spawnCommand('head -c 5000 /dev/zero', options(dir, { maxBuffer: 1000 }));
  assert.equal(direct.error?.code, 'ENOBUFS');
  assert.equal(direct.stdout.length, 1000);
  const report = await collectEvidence([{ name: 'loud', run: 'head -c 20000000 /dev/zero' }], { cwd: dir, enabled: true });
  assert.match(report.commands[0].unavailable, /ENOBUFS/);
  assert.equal(report.commands[0].exitCode, null);
  assert.deepEqual(report.didNotRun, ['loud']);
});

test('stopCommands kills a running command with what it started, and the command returns at once', async (t) => {
  const dir = temporary(t);
  const pidFile = join(dir, 'child.pid');
  const started = Date.now();
  const running = spawnCommand(`sleep 30 & echo $! > "${pidFile}"; wait`, options(dir, { timeout: 60000 }));
  const pid = await pidIn(pidFile);
  stopCommands();
  const result = await running;
  assert.ok(Date.now() - started < 5000, 'it returned without waiting for the sleep');
  assert.equal(result.status, null, 'the shell was killed');
  await assertGone(pid, 'the background child went with its process group');
});

test('a command is read as it prints, and aborting its signal kills it with what it started at once', async (t) => {
  const dir = temporary(t);
  const pidFile = join(dir, 'child.pid');
  const killer = new AbortController();
  let printed = '';
  const started = Date.now();
  const running = spawnCommand(`sleep 30 & echo $! > "${pidFile}"; echo ready; wait`, options(dir, { timeout: 60000, signal: killer.signal, onStdout: (text) => (printed += text) }));
  const pid = await pidIn(pidFile);
  for (let waited = 0; printed !== 'ready\n'; waited += 20) {
    assert.ok(waited < 10000, 'its output arrives while it runs');
    await new Promise((r) => setTimeout(r, 20));
  }
  killer.abort();
  const result = await running;
  assert.ok(Date.now() - started < 5000, 'it returned without waiting for the sleep');
  assert.deepEqual([result.status, result.error?.code, result.stdout], [null, 'ABORT_ERR', 'ready\n']);
  await assertGone(pid, 'the background child went with its process group');
});

test('a command whose signal was aborted before it started never runs', async (t) => {
  const dir = temporary(t);
  const marker = join(dir, 'ran');
  const killer = new AbortController();
  killer.abort();
  const result = await spawnCommand(`echo ran > "${marker}"`, options(dir, { signal: killer.signal }));
  assert.deepEqual([result.status, result.error?.code, result.stdout], [null, 'ABORT_ERR', '']);
  assert.equal(existsSync(marker), false, 'the command left nothing behind');
});

test('aborting the signal of a command that has returned signals nothing, since its group id may be another by then', async (t) => {
  const killer = new AbortController();
  const result = await spawnCommand('echo done', options(temporary(t), { signal: killer.signal }));
  assert.deepEqual([result.status, result.stdout], [0, 'done\n']);
  const real = process.kill;
  const signalled = [];
  process.kill = (pid, signal) => signalled.push([pid, signal]);
  try {
    killer.abort();
  } finally {
    process.kill = real;
  }
  assert.deepEqual(signalled, []);
});

test('input reaches stdin, and without input stdin is empty rather than left open', async (t) => {
  const dir = temporary(t);
  const piped = await spawnCommand('cat', options(dir, { input: '{"verdict":"confirmed"}' }));
  assert.equal(piped.stdout, '{"verdict":"confirmed"}');
  const empty = await spawnCommand('cat', options(dir));
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
});

test('a timeout of zero is no timeout, as under spawnSync', async (t) => {
  const result = await spawnCommand('sleep 0.2; echo done', options(temporary(t), { timeout: 0 }));
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, 'done\n');
});

// The driver captures a command's output by standing in for stdout while it
// runs. Now that a check awaits, other code runs meanwhile, and what it prints
// (under node:test, the runner's own event stream) is not the command's output.
test('an in-process command that awaits keeps only its own output, not what other code prints meanwhile', async (t) => {
  const dir = temporary(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({ static_evidence: { enabled: true, commands: [{ name: 'pause', run: 'sleep 0.5' }] } }));
  const saved = { cwd: process.cwd(), noCommands: process.env.REVIEW_VOICE_NO_COMMANDS, config: process.env.REVIEW_VOICE_CONFIG };
  process.chdir(dir);
  delete process.env.REVIEW_VOICE_NO_COMMANDS;
  delete process.env.REVIEW_VOICE_CONFIG;
  t.after(() => {
    process.chdir(saved.cwd);
    if (saved.noCommands !== undefined) process.env.REVIEW_VOICE_NO_COMMANDS = saved.noCommands;
    if (saved.config !== undefined) process.env.REVIEW_VOICE_CONFIG = saved.config;
  });
  const meanwhile = setTimeout(() => console.log('printed meanwhile'), 100);
  const result = await runInProcess(['evidence']);
  clearTimeout(meanwhile);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /printed meanwhile/);
  assert.deepEqual(JSON.parse(result.stdout).commands.map((command) => [command.name, command.exitCode]), [['pause', 0]]);
});

// A descendant that leaves the group keeps the pipes open after the group is
// killed; a timeout or the cap must not wait for it, as spawnSync did not.
const escapee = (seconds) =>
  `node -e "require('child_process').spawn('sleep', ['${seconds}'], { detached: true, stdio: 'inherit' }).unref()"`;

test('a timeout returns at once even when a descendant outside the group holds the pipes', async (t) => {
  const started = Date.now();
  const result = await spawnCommand(`${escapee(4)}; sleep 30`, options(temporary(t), { timeout: 500 }));
  const elapsed = Date.now() - started;
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
  assert.ok(elapsed < 2500, `returned after ${elapsed} ms`);
});

test('output past the cap returns at once even when a descendant outside the group holds the pipes', async (t) => {
  const started = Date.now();
  const result = await spawnCommand(`${escapee(4)}; head -c 100000 /dev/zero; sleep 30`, options(temporary(t), { maxBuffer: 1000 }));
  const elapsed = Date.now() - started;
  assert.equal(result.error?.code, 'ENOBUFS');
  assert.equal(result.stdout.length, 1000);
  assert.ok(elapsed < 2500, `returned after ${elapsed} ms`);
});

// Run on its own, the CLI shares no process group with its configured
// commands, so a stop signal must kill them itself.
const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins/review-voice/dist/review-voice.mjs');

function standaloneRepo(t, config) {
  const dir = temporary(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), JSON.stringify(config, null, 2));
  return dir;
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  for (const command of ['evidence', 'verify']) {
    test(`a ${signal} to a standalone ${command} kills its configured command and exits ${code}`, async (t) => {
      const scratch = temporary(t);
      const pidFile = join(scratch, 'pid');
      const run = `echo $$ > '${pidFile}'; exec sleep 30`;
      const config = command === 'evidence'
        ? { static_evidence: { enabled: true, commands: [{ name: 'tsc', run, timeout_seconds: 60 }] } }
        : { verification: { enabled: true, command: run, timeout_seconds: 60 } };
      const dir = standaloneRepo(t, config);
      const env = { ...process.env, REVIEW_VOICE_NO_COMMANDS: '0', REVIEW_VOICE_DATA_DIR: join(scratch, 'data') };
      delete env.REVIEW_VOICE_CONFIG;
      const child = spawn(process.execPath, [bundle, command], { cwd: dir, env, stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(command === 'verify'
        ? JSON.stringify({ candidates: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 1, severity: 'minor', claim: 'x', failure_mode: 'y', evidence: ['src/a.ts:1'] }] })
        : '');
      const exited = new Promise((resolve) => child.on('exit', (status) => resolve(status)));
      const pid = await pidIn(pidFile);
      child.kill(signal);
      const status = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 10000))]);
      assert.equal(status, code);
      await assertGone(pid, 'the configured command');
    });
  }
}
