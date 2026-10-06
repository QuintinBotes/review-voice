/**
 * A question is eligible only when the verifier backed it: `verified: true` or
 * `premises_verified: true`. A rejection, silence about its premises, no entry
 * for it, or no verification at all keeps it from being asked.
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

function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-question-gate-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const question = {
  candidate_id: 'cand_001',
  path: 'src/orders.ts',
  line: 12,
  category: 'api_contract',
  severity: 'question',
  claim: 'Does the billing service accept the new `currency` field on this request?',
  failure_mode: 'If it rejects unknown fields, every order submission fails.',
  evidence: ['src/orders.ts:12 adds `currency` to the request body.'],
  technical_confidence: 0.5,
};

const nit = {
  candidate_id: 'cand_002',
  path: 'src/orders.ts',
  line: 30,
  category: 'maintainability',
  severity: 'nit',
  claim: 'The helper `total` is exported but never imported anywhere.',
  failure_mode: 'Dead exports mislead readers about the public surface.',
  evidence: ['src/orders.ts:30 exports `total`; no other file imports it.'],
  technical_confidence: 0.9,
};

function score(dir, entries, candidates = [question]) {
  const args = ['score'];
  if (entries !== null) {
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify(entries));
    args.push('--verification', file);
  }
  const r = run(args, JSON.stringify({ candidates }), dir);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function assertRejected(out, pattern) {
  const row = out.scores.find((s) => s.candidateId === 'cand_001');
  assert.equal(row.severity.severity, 'question');
  assert.equal(row.eligible, false);
  assert.match(row.rejectedBecause, pattern);
  assert.deepEqual(out.eligible.filter((e) => e.candidateId === 'cand_001'), []);
  assert.deepEqual(out.belowGate.filter((e) => e.candidateId === 'cand_001'), []);
  assert.deepEqual(out.unverified.filter((e) => e.candidateId === 'cand_001'), []);
  return row;
}

test('the field case: a rejected question with a reason is not asked, and the reason is quoted', () =>
  withDir((dir) => {
    const out = score(dir, [
      {
        candidate_id: 'cand_001',
        verified: false,
        premises_verified: false,
        technical_confidence: 0.25,
        reason: 'pre-existing gap, wrong anchor, not material',
      },
    ]);
    const row = assertRejected(out, /premises_verified: false\); the verifier said: "pre-existing gap, wrong anchor, not material"/);
    assert.equal(row.eligible, false);
    assert.deepEqual(out.eligible, []);
  }));

test('verified false with the premises omitted is not asked', () =>
  withDir((dir) => {
    const out = score(dir, [{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.25, reason: 'wrong anchor' }]);
    assertRejected(out, /did not verify this question or confirm the premises.*premises_verified is not true\); the verifier said: "wrong anchor"/);
  }));

test('the quoted reason is bounded', () =>
  withDir((dir) => {
    const out = score(dir, [{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.25, reason: 'x'.repeat(5000) }]);
    const row = assertRejected(out, /the verifier said: "x+…"/);
    assert.ok(row.rejectedBecause.length < 500);
  }));

test('verified true with the premises omitted is eligible', () =>
  withDir((dir) => {
    const out = score(dir, [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.5 }]);
    assert.equal(out.scores[0].eligible, true, out.scores[0].rejectedBecause);
    assert.equal(out.eligible.length, 1);
  }));

test('premises verified with an unverified answer is eligible', () =>
  withDir((dir) => {
    const out = score(dir, [{ candidate_id: 'cand_001', verified: false, premises_verified: true, technical_confidence: 0.5 }]);
    assert.equal(out.scores[0].eligible, true, out.scores[0].rejectedBecause);
    assert.equal(out.eligible.length, 1);
  }));

test('a question the verifier returned no entry for is not asked', () =>
  withDir((dir) => {
    const out = score(dir, [{ candidate_id: 'cand_002', verified: true, technical_confidence: 0.9 }], [question, nit]);
    assertRejected(out, /needs the verifier to confirm the premises it rests on \(premises_verified: true\)/);
  }));

test('a question scored with no verification is not asked', () =>
  withDir((dir) => {
    const out = score(dir, null);
    assertRejected(out, /needs the verifier to confirm the premises it rests on \(premises_verified: true\)/);
    assert.deepEqual(out.eligible, []);
  }));

test('a verified nit in the same run is still eligible', () =>
  withDir((dir) => {
    const out = score(
      dir,
      [
        { candidate_id: 'cand_001', verified: false, technical_confidence: 0.25 },
        { candidate_id: 'cand_002', verified: true, technical_confidence: 0.9, evidence_quality: 'high' },
      ],
      [question, nit],
    );
    assertRejected(out, /premises_verified is not true/);
    const row = out.scores.find((s) => s.candidateId === 'cand_002');
    assert.equal(row.eligible, true, row.rejectedBecause);
    assert.deepEqual(out.eligible.map((e) => e.candidateId), ['cand_002']);
  }));
