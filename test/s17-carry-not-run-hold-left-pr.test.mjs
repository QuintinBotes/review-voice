/**
 * S17: a carry keeps a hold for a challenger that did not run, since nothing
 * has judged that finding on the new head (docs/adr/0024). A hold on a file the
 * pull request no longer changes (`scope.noLongerChanged`) is settled like the
 * findings there (#178): it no longer belongs to this pull request, so it must
 * not keep the carried review from approving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { planFindings } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const NOT_RUN = 'challenger not run: runners.codex is not configured';
const hold = (path, line, candidateId) => ({ path, line, verdict: 'challenge-partly', source: 'challenge', reason: NOT_RUN, severity: 'minor', candidateId, text: `the value at ${path}:${line} is never checked` });

/** Records a run holding `held`, moves a.ts out of the pull request, carries the run, and returns the carried run and its event. */
function carried(held) {
  const base = mkdtempSync(join(tmpdir(), 'rv-s17-carry-hold-'));
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
    const heldFile = join(base, 'held.json');
    writeFileSync(heldFile, JSON.stringify({ held }));
    const recorded = run(['record', '--repository', 'o/r', '--head', prior, '--held', heldFile], 'No actionable findings.\n');
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    // The base merge rewrites a.ts, which the pull request no longer changes.
    writeFileSync(join(repo, 'a.ts'), lines(18) + 'base 19\nbase 20\nbase 21\n' + lines(40).split('\n').slice(21).join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'merge base');
    const head = git('rev-parse', 'HEAD');
    const files = join(base, 'files.json');
    const scope = { kind: 'unchanged', since: prior, priorRunId: runId, priorReviewedAt: null, mergeBase: prior, reason: 'base-merged', noLongerChanged: ['a.ts'] };
    writeFileSync(files, JSON.stringify({ files: [{ path: 'b.ts' }], scope }));
    const carry = run(['carry', '--from', runId, '--head', head, '--text', '--files', files]);
    assert.equal(carry.code, 0, carry.stderr);
    const second = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId, '--files', files], carry.stdout);
    assert.equal(second.code, 0, second.stderr);
    const db = openDatabase(join(dataDir, 'review-voice.db'));
    try {
      const detail = runDetail(db, JSON.parse(second.stdout).reviewRunId);
      const { mapped } = planFindings(carry.stdout, detail, (id) => runDetail(db, id));
      return { held: detail.held.map((entry) => `${entry.path}:${entry.line}`), mapped };
    } finally {
      db.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('S17: a carry settles a challenger-not-run hold on a file the pull request no longer changes, and can approve', () => {
  const result = carried([hold('a.ts', 20, 'cand_001')]);
  assert.deepEqual(result.held, []);
  assert.equal(result.mapped, 'APPROVE');
});

test('S17: a challenger-not-run hold on a file the pull request still changes carries next to a settled one, and caps the event', () => {
  const result = carried([hold('a.ts', 20, 'cand_001'), hold('b.ts', 5, 'cand_002')]);
  assert.deepEqual(result.held, ['b.ts:5']);
  assert.equal(result.mapped, 'COMMENT');
});
