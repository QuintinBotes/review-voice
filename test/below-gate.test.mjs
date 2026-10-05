/**
 * Below the gate: a finding the verifier confirmed whose final score fell
 * short of the gate. It is listed locally and recorded as held, and never
 * posted - nor does it suppress the same candidate at the next head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const HEAD = 'd'.repeat(40);
const REPO = 'acme/web';
const PR = 12;

const LOW_CLAIM = 'The retry loop sleeps a fixed second, so a burst of failures retries in lockstep.';

function run(args, input, cwd, dataDir = cwd) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-below-gate-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const candidate = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'src/retry.ts',
  line: 5,
  category: 'correctness',
  severity: 'minor',
  claim: LOW_CLAIM,
  failure_mode: 'Many clients retry at the same instant and overload the service again.',
  evidence: ['src/retry.ts:5 sleeps 1000 ms on every attempt.'],
  technical_confidence: 0.9,
  ...over,
});

/** Lines 1-10 of `src/retry.ts` are added; line 20 is unchanged context. */
function writePatch(dir) {
  const patch = join(dir, 'diff.patch');
  const added = Array.from({ length: 10 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(
    patch,
    [
      'diff --git a/src/retry.ts b/src/retry.ts',
      '--- a/src/retry.ts',
      '+++ b/src/retry.ts',
      '@@ -0,0 +1,10 @@',
      ...added,
      '@@ -19,3 +20,3 @@',
      ' before',
      '-old();',
      '+fresh();',
      ' after',
    ].join('\n'),
  );
  return patch;
}

/**
 * Three candidates the gate stops: one verified and stopped only by the score,
 * one scored on the analyst's own confidence, one verified but anchored on
 * context. A gate of 0.99 puts every score below it.
 */
function scoreAll(dir) {
  const patch = writePatch(dir);
  const verification = join(dir, 'verification.json');
  writeFileSync(
    verification,
    JSON.stringify({
      results: [
        { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9 },
        { candidate_id: 'cand_003', evidence_quality: 'high', technical_confidence: 0.9 },
      ],
    }),
  );
  const candidates = [
    candidate(),
    candidate({ candidate_id: 'cand_002', line: 6, claim: 'The backoff ignores the server Retry-After header entirely.' }),
    candidate({ candidate_id: 'cand_003', line: 20, claim: 'The setup call before the retry ignores its returned error.' }),
  ];
  const r = run(
    ['score', '--verification', verification, '--diff-file', patch, '--min-score', '0.99'],
    JSON.stringify({ candidates }),
    dir,
  );
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('score lists a verified candidate stopped only by the final score as below the gate', () =>
  withDir((dir) => {
    const out = scoreAll(dir);
    const byId = Object.fromEntries(out.scores.map((row) => [row.candidateId, row]));
    assert.equal(byId.cand_001.confidenceSource, 'verifier');
    assert.equal(byId.cand_002.confidenceSource, 'analyst');
    assert.equal(byId.cand_003.anchorCheck.kind, 'context');

    assert.ok(Array.isArray(out.belowGate), 'score output has no belowGate list');
    assert.deepEqual(out.belowGate.map((entry) => entry.candidateId), ['cand_001']);
    const [entry] = out.belowGate;
    assert.equal(entry.path, 'src/retry.ts');
    assert.equal(entry.line, 5);
    assert.equal(entry.severity, byId.cand_001.severity.severity);
    assert.equal(entry.claim, LOW_CLAIM);
    assert.equal(entry.finalScore, byId.cand_001.finalScore);
    assert.equal(entry.threshold, 0.99);
    assert.deepEqual(out.eligible, []);
  }));

test('a verified candidate rejected on confidence is not below the gate', () =>
  withDir((dir) => {
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify({ results: [{ candidate_id: 'cand_001', technical_confidence: 0.5 }] }));
    const r = run(['score', '--verification', verification, '--min-score', '0.99'], JSON.stringify({ candidates: [candidate()] }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.scores[0].rejectedBecause, /technical confidence/);
    assert.deepEqual(out.belowGate, []);
  }));

test('a claim in the below-gate list is bounded like the rest of the output', () =>
  withDir((dir) => {
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify({ results: [{ candidate_id: 'cand_001', technical_confidence: 0.9 }] }));
    const long = `${LOW_CLAIM} ${'x'.repeat(2000)}`;
    const r = run(
      ['score', '--verification', verification, '--min-score', '0.99'],
      JSON.stringify({ candidates: [candidate({ claim: long })] }),
      dir,
    );
    const [entry] = JSON.parse(r.stdout).belowGate;
    assert.ok(entry.claim.length < long.length);
    assert.equal(entry.truncated, true);
  }));

test('record accepts held entries with the below-gate verdict', () =>
  withDir((dir) => {
    const held = join(dir, 'held.json');
    writeFileSync(
      held,
      JSON.stringify([
        { path: 'src/retry.ts', line: 5, verdict: 'below-gate', source: 'score', reason: 'score 0.66 is below the 0.68 threshold', text: LOW_CLAIM },
      ]),
    );
    const done = run(['record', '--repository', 'o/r', '--head', 'abc', '--held', held], 'No actionable findings.\n', dir);
    assert.equal(done.code, 0, done.stderr);
    const id = JSON.parse(done.stdout).reviewRunId;
    const text = run(['explain', '--run', id], '', dir).stdout;
    assert.match(text, /\[below-gate\] src\/retry\.ts:5 {2}score - score 0\.66 is below the 0\.68 threshold/);
  }));

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub() {
  return async (url) => {
    const parsed = new URL(String(url));
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({
        total_count: 1,
        check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }],
      });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
}

test('a verdict payload built from that run does not contain the below-gate finding', () =>
  withDir(async (dir) => {
    const scored = scoreAll(dir);
    const [below] = scored.belowGate;
    const posted = '[minor] `src/retry.ts:2` - The attempt counter starts at one. The last retry is skipped.';
    // Even if the below-gate finding were rendered, it has no eligible score.
    const leaked = `[${below.severity}] \`src/retry.ts:5\` - ${LOW_CLAIM}`;
    const review = `${posted}\n\n${leaked}\n`;

    const previous = process.env.REVIEW_VOICE_DATA_DIR;
    process.env.REVIEW_VOICE_DATA_DIR = dir;
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      const { reviewRunId } = recordRun(db, {
        repository: REPO,
        baseRef: null,
        headRef: HEAD,
        pullNumber: PR,
        diff: readFileSync(join(dir, 'diff.patch'), 'utf8'),
        output: review,
        scores: [
          ...scored.scores,
          { candidateId: 'cand_009', path: 'src/retry.ts', line: 2, severity: { severity: 'minor' }, confidenceSource: 'verifier', eligible: true },
        ],
        held: [
          { path: below.path, line: below.line, verdict: 'below-gate', source: 'score', reason: 'below the gate', text: below.claim },
        ],
      });
      assert.equal(runDetail(db, reviewRunId).held[0].verdict, 'below-gate');

      const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(), sleep: async () => {} });
      const { output } = await computeVerdict({ db, client, repository: REPO, pullNumber: PR, head: HEAD, review });

      assert.equal(output.action, 'post', output.reasons.join('; '));
      assert.deepEqual(output.payload.comments.map((c) => `${c.path}:${c.line}`), ['src/retry.ts:2']);
      const sent = JSON.stringify(output.payload);
      assert.doesNotMatch(sent, /retries in lockstep/);
      assert.doesNotMatch(sent, /src\/retry\.ts:5/);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
      else process.env.REVIEW_VOICE_DATA_DIR = previous;
    }
  }));

test('a below-gate held finding does not drop or mark the same candidate at the next head', () =>
  withDir((base) => {
    const repo = join(base, 'repo');
    const dataDir = join(base, 'data');
    execFileSync('mkdir', ['-p', repo, dataDir]);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(''));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const prior = git('rev-parse', 'HEAD');

    const held = join(base, 'held.json');
    writeFileSync(
      held,
      JSON.stringify([{ path: 'a.ts', line: 20, verdict: 'below-gate', source: 'score', reason: 'below the gate', text: LOW_CLAIM }]),
    );
    const recorded = run(['record', '--repository', 'o/r', '--head', prior, '--held', held], '[minor] `a.ts:5` - an unrelated note.\n', repo, dataDir);
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;

    writeFileSync(join(repo, 'b.ts'), 'unrelated\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated');
    const head = git('rev-parse', 'HEAD');

    const patch = join(base, 'diff.patch');
    const body = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
    writeFileSync(patch, ['diff --git a/a.ts b/a.ts', '--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,40 @@', ...body].join('\n'));

    const r = run(
      ['check-candidates', '--diff-file', patch, '--held-from', runId, '--head', head],
      JSON.stringify({ candidates: [candidate({ path: 'a.ts', line: 20 })] }),
      repo,
      dataDir,
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  }));

test('the review command prints the below-gate list and records it as held', () => {
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepSix = review.slice(review.indexOf('## Step 6'), review.indexOf('## What not to do'));
  assert.match(stepSix, /`Below the gate \(not posted\)`/);
  assert.match(stepSix, /never posted/);
  assert.match(stepSix, /`below-gate`/);
  const stepFour = review.slice(review.indexOf('## Step 4'), review.indexOf('## Step 5'));
  assert.match(stepFour, /`belowGate`/);
});
