/**
 * #178: after a rebase onto a base that already holds one of its files, the
 * pull request no longer changes that file (`scope.noLongerChanged`). The
 * base merge still moves lines in it, so its findings looked like findings on
 * changed code and carry refused the follow-up. With `--files`, such a
 * finding is settled instead: it no longer belongs to this pull request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

function withRun(review, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-issue-178-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const run = (args, input = '') => {
    const r = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input, cwd: repo, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    execFileSync('mkdir', ['-p', repo, dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), lines(40));
    writeFileSync(join(repo, 'b.ts'), lines(10));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const prior = git('rev-parse', 'HEAD');
    const recorded = run(['record', '--repository', 'o/r', '--head', prior], review);
    assert.equal(recorded.code, 0, recorded.stderr.split("\n").slice(-3).join("\n"));
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    // The base merge rewrites the lines around the finding in a.ts.
    writeFileSync(join(repo, 'a.ts'), lines(18) + 'base 19\nbase 20\nbase 21\n' + lines(40).split('\n').slice(21).join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'merge base');
    const head = git('rev-parse', 'HEAD');
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ files: ['b.ts'], scope: { kind: 'unchanged', since: prior, noLongerChanged: ['a.ts'] } }));
    const carry = (...extra) => run(['carry', '--from', runId, '--head', head, '--text', ...extra]);
    return fn({ carry, files, run, head, runId });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('#178: a finding on a file the pull request no longer changes is settled, and the follow-up is clean', () => {
  withRun('[important] `a.ts:20` - the loop at line 20 never ends.\n', ({ carry, files, run, head, runId }) => {
    const r = carry('--files', files);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'No actionable findings.');
    assert.match(r.stderr, /Settled: rv_01 a\.ts:20 - file no longer changed by the pull request/);
    const recorded = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId, '--files', files], r.stdout);
    assert.equal(recorded.code, 0, recorded.stderr.split("\n").slice(-3).join("\n"));
  });
});

test('#178: other findings still carry next to a settled one', () => {
  withRun('[important] `a.ts:20` - the loop at line 20 never ends.\n\n[minor] `b.ts:5` - this name shadows the import.\n', ({ carry, files }) => {
    const r = carry('--files', files);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /`b\.ts:5` - this name shadows the import/);
    assert.doesNotMatch(r.stdout, /a\.ts/);
  });
});

test('#178: without --files the old refusal stands', () => {
  withRun('[important] `a.ts:20` - the loop at line 20 never ends.\n', ({ carry }) => {
    const r = carry();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /anchor or its neighbours changed/);
  });
});
