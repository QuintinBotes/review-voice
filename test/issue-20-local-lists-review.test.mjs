/**
 * What reaches the local lists, after review of the first version.
 *
 * - A candidate the verifier rejected for blocking missing context now reaches
 *   `score` (the review sets it aside instead of discarding it), lands in
 *   `unverified`, and can never be eligible: `verified: false` rejects any
 *   non-question.
 * - A verifier-confirmed candidate below the verifier's own confidence floor
 *   is listed in `belowGate` with `gate: confidence`.
 * - Both lists hold only candidates that one gate alone stopped. A thread
 *   repeat, a missing citation or an untraced stale consumer keeps it off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const CLAIMS = {
  c1: 'The export reads the tenant scope from the request body instead of the token.',
  c2: 'The rate limiter counts retries against the wrong bucket entirely.',
  c3: 'The webhook signature check compares strings with early exit.',
  c4: 'The pagination cursor skips the record at each page boundary.',
};

const candidate = (id, over = {}) => ({
  candidate_id: id,
  path: 'src/api.ts',
  line: 2,
  category: 'correctness',
  severity: 'minor',
  claim: CLAIMS[id],
  failure_mode: 'Users receive data or limits that are not theirs.',
  evidence: ['src/api.ts:2 does it.'],
  technical_confidence: 0.9,
  ...over,
});

const PATCH = ['diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-local-lists-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function score(dir, candidates, verifications, extra = [], { minScore = '0.3', diff = true } = {}) {
  writeFileSync(join(dir, 'diff.patch'), PATCH);
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verifications));
  const r = spawnSync(
    process.execPath,
    [
      bundle,
      'score',
      '--verification',
      join(dir, 'v.json'),
      ...(diff ? ['--diff-file', join(dir, 'diff.patch')] : []),
      '--min-score',
      minScore,
      ...extra,
    ],
    { cwd: dir, encoding: 'utf8', input: JSON.stringify({ candidates }), env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a candidate the verifier rejected for blocking context is listed as unverified and never eligible', () =>
  withDir((dir) => {
    const out = score(
      dir,
      [candidate('c1'), candidate('c2', { line: 3 })],
      [
        { candidate_id: 'c1', verified: false, technical_confidence: 0.72, required_context_missing: ['the token issuer in a sibling service'] },
        // Rejected outright, with nothing missing and a high number: still not eligible.
        { candidate_id: 'c2', verified: false, technical_confidence: 0.95 },
      ],
    );
    const byId = Object.fromEntries(out.scores.map((row) => [row.candidateId, row]));
    assert.equal(byId.c1.eligible, false);
    assert.deepEqual(out.unverified.map((entry) => entry.candidateId), ['c1']);
    assert.equal(byId.c2.eligible, false);
    assert.match(byId.c2.rejectedBecause, /verified: false/);
    assert.deepEqual(out.eligible, []);
    assert.deepEqual(out.belowGate, []);
  }));

test('a verified: false question is still decided by its premises', () =>
  withDir((dir) => {
    const question = candidate('c3', { severity: 'question', claim: 'Does the signature check run before the body is parsed?' });
    const out = score(dir, [question], [{ candidate_id: 'c3', verified: false, technical_confidence: 0.5, premises_verified: true }]);
    assert.equal(out.scores[0].eligible, true, out.scores[0].rejectedBecause);
  }));

test('verified must be a boolean', () =>
  withDir((dir) => {
    const r = spawnSync(process.execPath, [bundle, 'check-verification'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify([{ candidate_id: 'c1', verified: 'false' }]),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /verified must be true or false/);
  }));

test('a verifier-confirmed candidate below the confidence floor is below the gate with gate: confidence', () =>
  withDir((dir) => {
    const out = score(dir, [candidate('c4')], [{ candidate_id: 'c4', verified: true, technical_confidence: 0.7 }]);
    assert.match(out.scores[0].rejectedBecause, /^technical confidence 0\.70 \(verifier\) is below 0\.8$/);
    assert.equal(out.belowGate.length, 1);
    const [entry] = out.belowGate;
    assert.equal(entry.candidateId, 'c4');
    assert.equal(entry.gate, 'confidence');
    assert.equal(entry.technicalConfidence, 0.7);
    assert.equal(entry.threshold, 0.8);
  }));

test('a final-score entry says gate: score', () =>
  withDir((dir) => {
    const out = score(dir, [candidate('c4')], [{ candidate_id: 'c4', technical_confidence: 0.9 }], [], { minScore: '0.99' });
    assert.deepEqual(out.belowGate.map((entry) => entry.gate), ['score']);
  }));

test('a candidate the thread already states is on neither list, and the reason says both', () =>
  withDir((dir) => {
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({
        comments: [
          { path: 'src/api.ts', line: 2, author: 'another-reviewer', body: CLAIMS.c1, kind: 'review-comment' },
          { path: 'src/api.ts', line: 2, author: 'another-reviewer', body: CLAIMS.c4, kind: 'review-comment' },
        ],
      }),
    );
    const out = score(
      dir,
      [candidate('c1'), candidate('c4', { line: 2 })],
      [
        { candidate_id: 'c1', technical_confidence: 0.9, required_context_missing: ['a sibling service'] },
        { candidate_id: 'c4', technical_confidence: 0.7 },
      ],
      ['--thread', thread],
    );
    assert.deepEqual(out.unverified, []);
    assert.deepEqual(out.belowGate, []);
    for (const row of out.scores) assert.match(row.rejectedBecause, /\. Also: already said on this pull request by another-reviewer/);
  }));

test('a candidate citing a file that does not exist is on neither list', () =>
  withDir((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/other.ts'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    // No diff: a path the diff adds always resolves, so the citation check
    // can only fail on a path the reviewed tree and the diff both lack.
    const out = score(
      dir,
      [candidate('c1'), candidate('c4', { line: 3 })],
      [
        { candidate_id: 'c1', technical_confidence: 0.9, required_context_missing: ['a sibling service'] },
        { candidate_id: 'c4', technical_confidence: 0.7 },
      ],
      [],
      { diff: false },
    );
    assert.deepEqual(out.unverified, []);
    assert.deepEqual(out.belowGate, []);
    for (const row of out.scores) assert.match(row.rejectedBecause, /Also: cites src\/api\.ts, which does not exist/);
  }));

test('an untraced stale consumer stopped by the cap or the floor is on neither list', () =>
  withDir((dir) => {
    const stale = (id, line) =>
      candidate(id, { path: 'src/consumer.ts', line, anchor: 'stale-consumer', caused_by: { path: 'src/api.ts', line: 2 } });
    const out = score(
      dir,
      [stale('c1', 10), stale('c4', 20)],
      [
        { candidate_id: 'c1', technical_confidence: 0.9, required_context_missing: ['a sibling service'] },
        { candidate_id: 'c4', technical_confidence: 0.7 },
      ],
    );
    assert.deepEqual(out.unverified, []);
    assert.deepEqual(out.belowGate, []);
    for (const row of out.scores) assert.match(row.rejectedBecause, /Also: a stale-consumer finding needs the verifier to trace/);
  }));

test('the review sets context-blocked rejections aside for step 4, and the verifier lists the context when it rejects', () => {
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepThree = review.slice(review.indexOf('## Step 3 - Verify'), review.indexOf('## Step 3b'));
  assert.match(stepThree, /\*\*Set it aside\*\*/);
  assert.match(stepThree, /never eligible and never\s+posted/);
  const stepFour = review.slice(review.indexOf('## Step 4'), review.indexOf('## Step 5'));
  assert.match(stepFour, /plus those\s+set aside in step 3/);
  assert.match(stepFour, /`gate: confidence`/);
  const verifier = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  assert.match(verifier, /List\s+that context in `required_context_missing` even when you reject/);
});
