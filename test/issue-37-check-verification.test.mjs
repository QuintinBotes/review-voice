/**
 * The verifier's output is shape-checked straight after it runs.
 *
 * `score` refused an `evidence_quality` of "strong" with every earlier stage
 * already spent. `check-verification` runs the same checks on the verifier's
 * output alone, so the relaunch happens while its context is still warm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function check(payload) {
  const data = mkdtempSync(join(tmpdir(), 'rv-check-verification-'));
  try {
    const r = spawnSync(process.execPath, [bundle, 'check-verification'], {
      encoding: 'utf8',
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      cwd: data,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

const good = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.9 };

test('check-verification accepts output in the documented shape', () => {
  const r = check({ results: [good, { ...good, candidate_id: 'cand_002', evidence_quality: 'low' }] });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true, verifications: 2 });
});

for (const word of ['strong', 'weak']) {
  test(`check-verification refuses evidence_quality "${word}" and names the entry, field and value`, () => {
    const r = check([good, { ...good, candidate_id: 'cand_002', evidence_quality: word }]);
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stderr, /entry 1 \(cand_002\)/);
    assert.match(r.stderr, /evidence_quality must be one of high, medium, low/);
    assert.ok(r.stderr.includes(`"${word}"`), r.stderr);
    assert.match(r.stderr, /Re-run the evidence-verifier/);
  });
}

test('check-verification refuses what score refuses, and an empty or unreadable file', () => {
  assert.equal(check([{ ...good, technical_confidence: '0.9' }]).code, 2);
  assert.equal(check([{ evidence_quality: 'high' }]).code, 2);
  assert.equal(check({ findings: [good] }).code, 2);
  assert.equal(check([]).code, 2);
  assert.equal(check('not json').code, 2);
});

test('the verifier states the evidence_quality enum and the review checks the shape after it', () => {
  const verifier = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  assert.match(verifier, /`evidence_quality` is exactly one of `high`, `medium` or `low`/);
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepThree = review.slice(review.indexOf('## Step 3 - Verify'), review.indexOf('## Step 3b'));
  assert.match(stepThree, /RV check-verification/);
  assert.match(stepThree, /relaunch the verifier once/);
});

function checkWith(payload, candidates) {
  const data = mkdtempSync(join(tmpdir(), 'rv-check-verification-'));
  try {
    const file = join(data, 'checked.json');
    writeFileSync(file, JSON.stringify(candidates));
    const r = spawnSync(process.execPath, [bundle, 'check-verification', '--candidates', file], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      cwd: data,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

const kept = { valid: true, kept: [{ candidate_id: 'cand_001' }, { candidate_id: 'tn_001' }], droppedAsRepeat: [] };

test('#165: check-verification --candidates refuses output that skips a kept candidate, naming it', () => {
  const r = checkWith([good], kept);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /No verification for kept candidate tn_001/);
  assert.match(r.stderr, /Re-run the evidence-verifier/);
});

test('#165: check-verification --candidates accepts output that covers every kept candidate', () => {
  const r = checkWith([good, { ...good, candidate_id: 'tn_001' }], kept);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true, verifications: 2 });
});

test('#165: check-verification --candidates also reads a plain candidates array or {candidates}', () => {
  assert.equal(checkWith([good], [{ candidate_id: 'cand_001' }]).code, 0);
  assert.equal(checkWith([good], { candidates: [{ candidate_id: 'cand_001' }, { candidate_id: 'cand_002' }] }).code, 2);
});
