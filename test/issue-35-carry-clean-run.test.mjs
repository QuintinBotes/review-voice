import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

function run(args, { input = '', cwd, dataDir }) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      cwd,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A repository with one recorded run of `review` at its first commit. */
function withRun(review, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-carry-clean-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const write = (name, body) => writeFileSync(join(repo, name), body);
  try {
    execFileSync('mkdir', ['-p', repo, dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', lines(40));
    const prior = commit('first');
    const recorded = run(['record', '--repository', 'o/r', '--head', prior], { input: review, cwd: repo, dataDir });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    return fn({ repo, dataDir, write, commit, runId });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('carry of a clean run gives the clean-review sentence, which validates and records', () => {
  withRun('No actionable findings.\n', ({ repo, dataDir, write, commit, runId }) => {
    write('b.ts', 'unrelated\n');
    const head = commit('rebase stand-in');

    const json = JSON.parse(run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir }).stdout);
    assert.equal(json.output, 'No actionable findings.');

    const text = run(['carry', '--from', runId, '--head', head, '--text'], { cwd: repo, dataDir });
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout, 'No actionable findings.\n');

    assert.equal(run(['validate-output'], { input: text.stdout, cwd: repo, dataDir }).code, 0);
    const recorded = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId], {
      input: text.stdout,
      cwd: repo,
      dataDir,
    });
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(recorded.stdout).findings, []);
  });
});

test('carry --text prints the moved review, ready for validate-output', () => {
  const review = '[important] `a.ts:20` - The loop never ends. The request hangs. Break on the sentinel.\n';
  withRun(review, ({ repo, dataDir, write, commit, runId }) => {
    write('a.ts', 'new 1\n' + lines(40));
    const head = commit('insert above');
    const text = run(['carry', '--from', runId, '--head', head, '--text'], { cwd: repo, dataDir });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^\[important\] `a\.ts:21` - The loop/);
    assert.equal(run(['validate-output'], { input: text.stdout, cwd: repo, dataDir }).code, 0);
  });
});

test('carry --text refuses to call a run clean when its findings did not carry', () => {
  const review = '[important] `a.ts:20` - The loop never ends. The request hangs. Break on the sentinel.\n';
  withRun(review, ({ repo, dataDir, write, commit, runId }) => {
    write('a.ts', lines(40).replace('line 20\n', 'changed\n'));
    const head = commit('edit the anchor');
    const json = JSON.parse(run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir }).stdout);
    assert.equal(json.output, '');
    const text = run(['carry', '--from', runId, '--head', head, '--text'], { cwd: repo, dataDir });
    assert.equal(text.code, 1);
    assert.equal(text.stdout, '');
    assert.match(text.stderr, /Not carried: rv_01 a\.ts:20/);
  });
});
