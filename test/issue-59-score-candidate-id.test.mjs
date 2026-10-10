/**
 * `score` names each candidate `candidate_id`, the spelling candidates,
 * verification and `check-candidates` use, so one key joins them all.
 * `candidateId` is still written beside it while it is deprecated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-score-id-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function candidate(id, line, overrides = {}) {
  return {
    candidate_id: id,
    path: 'src/orders.ts',
    line,
    category: 'correctness',
    severity: 'important',
    claim: `The total at line ${line} drops the discount when the cart is empty.`,
    failure_mode: 'An empty cart with a coupon is charged a negative amount.',
    evidence: [`src/orders.ts:${line} subtracts the discount without a floor.`],
    technical_confidence: 0.9,
    ...overrides,
  };
}

function score(dir, candidates, verification) {
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verification));
  const r = spawnSync(process.execPath, [bundle, 'score', '--verification', join(dir, 'v.json'), '--min-score', '0'], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const candidates = [candidate('c1', 10), candidate('c2', 20), candidate('c3', 30)];
const verification = [
  { candidate_id: 'c1', verified: true, technical_confidence: 0.95 },
  // Verified, but under the confidence floor: listed below the gate.
  { candidate_id: 'c2', verified: true, technical_confidence: 0.5 },
  // Held for context the verifier could not reach.
  { candidate_id: 'c3', verified: false, technical_confidence: 0.72, required_context_missing: ['the pricing service'] },
];

test('every score list carries candidate_id, equal to candidateId', () =>
  withDir((dir) => {
    const out = score(dir, candidates, verification);
    assert.deepEqual(out.eligible.map((e) => e.candidate_id), ['c1']);
    assert.deepEqual(out.belowGate.map((e) => e.candidate_id), ['c2']);
    assert.deepEqual(out.unverified.map((e) => e.candidate_id), ['c3']);
    assert.deepEqual(out.scores.map((e) => e.candidate_id).sort(), ['c1', 'c2', 'c3']);
    for (const list of [out.scores, out.eligible, out.belowGate, out.unverified]) {
      for (const entry of list) assert.equal(entry.candidate_id, entry.candidateId);
    }
  }));

test('score entries join back to candidates and verification on candidate_id alone', () =>
  withDir((dir) => {
    const out = score(dir, candidates, verification);
    const byId = new Map(verification.map((v) => [v.candidate_id, v]));
    for (const entry of [...out.eligible, ...out.belowGate, ...out.unverified]) {
      assert.ok(byId.has(entry.candidate_id), `no verification joins ${JSON.stringify(entry.candidate_id)}`);
      assert.ok(candidates.some((c) => c.candidate_id === entry.candidate_id));
    }
  }));

test('candidate_id sits next to candidateId', () =>
  withDir((dir) => {
    const out = score(dir, candidates, verification);
    const keys = Object.keys(out.eligible[0]);
    assert.equal(keys.indexOf('candidate_id'), keys.indexOf('candidateId') + 1);
  }));

test('score --help names candidate_id and the deprecated candidateId', () => {
  const r = spawnSync(process.execPath, [bundle, 'score', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /candidate_id/);
  assert.match(r.stdout, /candidateId[\s\S]*deprecated/);
});
