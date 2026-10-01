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
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A repository with one reviewed head, a data dir, and a recorded run of two findings. */
function withRun(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-carry-'));
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
    write('b.ts', lines(10));
    const prior = commit('first');
    const review =
      '[important] `a.ts:20` - the loop at line 20 never ends.\n\n' +
      '[minor] `b.ts:5` - this name shadows the import.\n';
    const recorded = run(['record', '--repository', 'o/r', '--head', prior], { input: review, cwd: repo, dataDir });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const carry = (head) => run(['carry', '--from', runId, '--head', head], { cwd: repo, dataDir });
    return fn({ repo, dataDir, git, commit, write, runId, prior, carry, review });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('carry moves a finding by the lines inserted above it', () => {
  withRun(({ write, commit, carry }) => {
    write('a.ts', 'new 1\nnew 2\nnew 3\n' + lines(40));
    const result = JSON.parse(carry(commit('insert above')).stdout);
    const moved = result.carried.find((c) => c.path === 'a.ts');
    assert.equal(moved.oldLine, 20);
    assert.equal(moved.line, 23);
    assert.match(result.output, /`a\.ts:23` - the loop/);
    assert.equal(result.carried.find((c) => c.path === 'b.ts').line, 5);
  });
});

test('carry drops a finding when its neighbours changed', () => {
  withRun(({ write, commit, carry }) => {
    write('a.ts', lines(40).replace('line 22\n', 'changed\n'));
    const result = JSON.parse(carry(commit('edit near')).stdout);
    assert.equal(result.notCarried.length, 1);
    assert.match(result.notCarried[0].reason, /anchor or its neighbours changed/);
    assert.equal(result.carried.length, 1);
  });
});

test('carry keeps a finding when the change is three lines away', () => {
  withRun(({ write, commit, carry }) => {
    write('a.ts', lines(40).replace('line 23\n', 'changed\n'));
    const result = JSON.parse(carry(commit('edit far')).stdout);
    assert.equal(result.carried.find((c) => c.path === 'a.ts').line, 20);
  });
});

test('carry does not carry a deleted or renamed file', () => {
  withRun(({ git, commit, carry }) => {
    git('mv', 'b.ts', 'c.ts');
    const result = JSON.parse(carry(commit('rename')).stdout);
    assert.match(result.notCarried.find((n) => n.path === 'b.ts').reason, /deleted or renamed/);
  });
});

test('carry exits 2 for an unknown run or an unreadable commit', () => {
  withRun(({ repo, dataDir, prior }) => {
    assert.equal(run(['carry', '--from', 'nope', '--head', prior], { cwd: repo, dataDir }).code, 2);
    const missing = 'f'.repeat(40);
    assert.equal(run(['carry', '--from', 'nope', '--head', missing], { cwd: repo, dataDir }).code, 2);
  });
  withRun(({ repo, dataDir, runId }) => {
    assert.equal(run(['carry', '--from', runId, '--head', 'f'.repeat(40)], { cwd: repo, dataDir }).code, 2);
  });
});

test('record --carried-from marks matching findings and refuses a moved anchor', () => {
  withRun(({ repo, dataDir, write, commit, carry, runId }) => {
    write('a.ts', 'new 1\nnew 2\nnew 3\n' + lines(40));
    const head = commit('insert above');
    const { output } = JSON.parse(carry(head).stdout);

    const good = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId], { input: output, cwd: repo, dataDir });
    assert.equal(good.code, 0, good.stderr);
    const findings = JSON.parse(good.stdout).findings;
    assert.equal(findings.length, 2);
    assert.deepEqual(findings[0].carriedFrom, { runId, findingId: 'rv_01' });

    const stale = output.replace('a.ts:23', 'a.ts:20');
    const bad = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId], { input: stale, cwd: repo, dataDir });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /rv_01/);

    const unknown = run(['record', '--head', head, '--carried-from', 'nope'], { input: output, cwd: repo, dataDir });
    assert.equal(unknown.code, 2);
  });
});
