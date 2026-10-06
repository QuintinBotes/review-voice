import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const review = '[important] `src/a.ts:20` - the loop at line 20 never ends.\n';

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

function makeClone(dir, origin) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  mkdirSync(join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  if (origin !== null) git('remote', 'add', 'origin', `https://github.com/${origin}.git`);
  return git;
}

/**
 * A clone of `origin` with two commits and a run recorded against the first,
 * under `repository` (null records none), plus a second clone of `other`.
 */
function withRun({ origin = 'o/r', repository = 'o/r', other = 'x/y' }, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-carry-repo-'));
  const repo = join(base, 'repo');
  const wrong = join(base, 'wrong');
  const plain = join(base, 'plain');
  const dataDir = join(base, 'data');
  try {
    for (const dir of [repo, wrong, plain, dataDir]) mkdirSync(dir, { recursive: true });
    const git = makeClone(repo, origin);
    makeClone(wrong, other);
    writeFileSync(join(repo, 'src/a.ts'), lines(40));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const prior = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/b.ts'), 'unrelated\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    const head = git('rev-parse', 'HEAD');
    const args = ['record', '--head', prior, ...(repository === null ? [] : ['--repository', repository])];
    const recorded = run(args, { input: review, cwd: repo, dataDir });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    return fn({ repo, wrong, plain, dataDir, runId, prior, head, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('carry from a clone of another repository names both repositories and the path', () => {
  withRun({}, ({ wrong, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: wrong, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`Run ${runId} is a review of o/r, but .*wrong is a clone of x/y\\.`));
    assert.match(result.stderr, /Run carry from a clone of o\/r\./);
    assert.doesNotMatch(result.stderr, /not readable/);
  });
});

test('--repository that disagrees with the run is refused', () => {
  withRun({}, ({ repo, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head, '--repository', 'x/y'], { cwd: repo, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is a review of o\/r, not x\/y/);
  });
});

test('--repository is compared case-insensitively', () => {
  withRun({}, ({ repo, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head, '--repository', 'O/R'], { cwd: repo, dataDir });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('carry outside a git repository says to run inside a clone', () => {
  withRun({}, ({ plain, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: plain, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Run carry inside a clone of o\/r\./);
    assert.doesNotMatch(result.stderr, /at .*\.(mjs|ts):\d+/);
  });
});

test('a commit missing from the right clone names the path and the slug', () => {
  withRun({}, ({ repo, dataDir, runId }) => {
    const missing = 'a'.repeat(40);
    const result = run(['carry', '--from', runId, '--head', missing], { cwd: repo, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`Commit ${missing} is not readable in .*repo \\(a clone of o/r\\)\\.`));
    assert.match(result.stderr, /Fetch it there, or run carry from a clone of o\/r\./);
  });
});

test('the same repository carries', () => {
  withRun({}, ({ repo, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).carried.length, 1);
  });
});

test('record --carried-from from the wrong clone exits 2', () => {
  withRun({}, ({ repo, wrong, dataDir, runId, head }) => {
    const text = run(['carry', '--from', runId, '--head', head, '--text'], { cwd: repo, dataDir }).stdout;
    const result = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId], { input: text, cwd: wrong, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is a review of o\/r, but .*wrong is a clone of x\/y/);
  });
});

test('a run with no recorded repository carries from any clone that has the commits', () => {
  withRun({ repository: null }, ({ repo, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('a run with no recorded repository still names where a commit was not found', () => {
  withRun({ repository: null }, ({ wrong, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: wrong, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not readable in .*wrong \(a clone of x\/y\)/);
  });
});

test('carry --help states the working-directory requirement and --repository', () => {
  withRun({}, ({ repo, dataDir }) => {
    const result = run(['carry', '--help'], { cwd: repo, dataDir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /working directory/);
    assert.match(result.stdout, /clone of the run's\s+repository/);
    assert.match(result.stdout, /--repository/);
  });
});

test('a fork clone carries when another remote is the run repository', () => {
  withRun({ origin: 'fork/r' }, ({ repo, dataDir, runId, head }) => {
    execFileSync('git', ['remote', 'add', 'upstream', 'ssh://github.com/o/r.git'], { cwd: repo });
    const result = run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('a fork clone without the run repository as a remote is refused', () => {
  withRun({ origin: 'fork/r' }, ({ repo, dataDir, runId, head }) => {
    const result = run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is a clone of fork\/r\. Run carry from a clone of o\/r\./);
  });
});
