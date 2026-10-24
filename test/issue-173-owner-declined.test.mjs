/**
 * #173: the owner skipped a held finding on one pull request, and a stacked
 * sibling raised it again a day later. The skip is now recorded on the run
 * (`decline`), and `check-candidates --held-from` reads several runs, so a
 * sibling's declined findings hold the repeat back.
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
const TEXT = 'The binding check is written out in three handlers instead of one shared guard.';

const candidate = (over = {}) => ({
  candidate_id: 'c1',
  path: 'src/auth/handlers.ts',
  line: 30,
  category: 'maintainability',
  severity: 'minor',
  claim: 'The binding check is written out in each of three handlers instead of one shared guard.',
  failure_mode: 'A later fix to one copy misses the other two.',
  evidence: ['src/auth/handlers.ts:30 repeats the check.'],
  technical_confidence: 0.8,
  ...over,
});

function withRuns(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-issue-173-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const run = (args, input = '') => {
    const r = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input, cwd: repo, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    execFileSync('mkdir', ['-p', join(repo, 'src/auth'), dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'src/auth/handlers.ts'), lines(40));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    const record = (pull, held) => {
      const heldFile = join(base, `held-${pull}.json`);
      writeFileSync(heldFile, JSON.stringify(held));
      const r = run(['record', '--repository', 'o/r', '--pull', String(pull), '--head', head, '--held', heldFile], 'No actionable findings.\n');
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout).reviewRunId;
    };
    const patch = join(base, 'diff.patch');
    writeFileSync(
      patch,
      ['diff --git a/src/auth/handlers.ts b/src/auth/handlers.ts', '--- /dev/null', '+++ b/src/auth/handlers.ts', '@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join('\n'),
    );
    const check = (heldFrom, candidates = [candidate()]) =>
      run(['check-candidates', '--diff-file', patch, '--held-from', heldFrom, '--head', head], JSON.stringify({ candidates }));
    return fn({ run, record, check });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const unverified = { path: 'src/auth/handlers.ts', line: 30, verdict: 'unverified', source: 'evidence-verifier', reason: 'structural point', text: TEXT };

test('#173: decline records the owner skip on a held finding of a recorded run', () => {
  withRuns(({ run, record }) => {
    const runId = record(1, [unverified]);
    const r = run(['decline', '--run', runId, 'src/auth/handlers.ts:30', '--reason', 'the owner prefers the explicit checks']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Recorded owner-declined for src\/auth\/handlers\.ts:30/);
    const held = JSON.parse(run(['explain', '--run', runId, '--json']).stdout).held;
    assert.deepEqual([held[0].verdict, held[0].source, held[0].reason, held[0].text], ['owner-declined', 'owner', 'the owner prefers the explicit checks', TEXT]);
  });
});

test('#173: decline names the held anchors when the one given has none', () => {
  withRuns(({ run, record }) => {
    const runId = record(1, [unverified]);
    const r = run(['decline', '--run', runId, 'src/auth/handlers.ts:31']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No held finding at src\/auth\/handlers\.ts:31.*src\/auth\/handlers\.ts:30/s);
  });
});

test('#173: a sibling run read through --held-from drops the declined repeat and names that run', () => {
  withRuns(({ run, record, check }) => {
    const sibling = record(1, [unverified]);
    assert.equal(run(['decline', '--run', sibling, 'src/auth/handlers.ts:30']).code, 0);
    const own = record(2, []);
    const r = check(`${own},${sibling}`);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsHeld[0].heldVerdict, 'owner-declined');
    assert.equal(out.droppedAsHeld[0].priorRunId, sibling);
  });
});

test('#173: an unverified entry the owner did not decline does not hold a candidate back', () => {
  withRuns(({ record, check }) => {
    const sibling = record(1, [unverified]);
    const out = JSON.parse(check(sibling).stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.droppedAsHeld.length, 0);
  });
});

test('#173: an unknown run in the list is reported and the others are still read', () => {
  withRuns(({ record, check }) => {
    const sibling = record(1, [{ ...unverified, verdict: 'owner-declined', source: 'owner' }]);
    const r = check(`no-such-run,${sibling}`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Held findings were not consulted: No recorded run no-such-run\./);
    assert.equal(JSON.parse(r.stdout).droppedAsHeld.length, 1);
  });
});
