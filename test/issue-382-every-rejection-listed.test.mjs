/**
 * #382: two kinds of rejected candidate were in `scores[]` alone, which no
 * step of the review reads: a verifier rejection with blocking missing
 * context at a low confidence, and a verified stale consumer whose impact was
 * not traced.
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

const candidate = (id, extra = {}) => ({
  candidate_id: id,
  path: `src/${id}.ts`,
  line: 1,
  category: 'correctness',
  severity: 'minor',
  claim: `The handler in ${id} returns before the transaction commits.`,
  failure_mode: 'A failed commit is reported as success.',
  evidence: [`src/${id}.ts:1`],
  technical_confidence: 0.9,
  ...extra,
});

function score(candidates, verifications) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-382-'));
  try {
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify({ verifications }));
    const result = spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--min-score', '0'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ids = (list) => list.map((entry) => entry.candidate_id);

test('a rejection for missing context is listed under unverified whatever confidence came with it', () => {
  const out = score(
    [candidate('cand_001')],
    [{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.3, required_context_missing: ['the state of the pull request on GitHub'] }],
  );
  assert.deepEqual(ids(out.unverified), ['cand_001']);
  assert.deepEqual(out.unverified[0].requiredContextMissing, ['the state of the pull request on GitHub']);
  assert.deepEqual(out.rejected, []);
});

test('a verified stale consumer the verifier did not trace is listed under rejected with its reason', () => {
  const out = score(
    [candidate('cand_001'), candidate('cand_002', { anchor: 'stale-consumer', caused_by: { path: 'src/cand_001.ts', line: 1 } })],
    [
      { candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 },
      { candidate_id: 'cand_002', verified: true, technical_confidence: 0.8 },
    ],
  );
  assert.deepEqual(ids(out.eligible), ['cand_001']);
  assert.deepEqual(ids(out.rejected), ['cand_002']);
  assert.equal(out.rejected[0].verified, true);
  assert.match(out.rejected[0].rejectedBecause, /needs the verifier to trace the impact/);
});

test('every candidate that is not eligible is in exactly one list', () => {
  const out = score(
    [candidate('cand_001'), candidate('cand_002'), candidate('cand_003'), candidate('cand_004')],
    [
      { candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 },
      { candidate_id: 'cand_002', verified: true, technical_confidence: 0.4 },
      { candidate_id: 'cand_003', verified: false, technical_confidence: 0.9 },
      { candidate_id: 'cand_004', verified: false, technical_confidence: 0.2, required_context_missing: ['a file outside the clone'] },
    ],
  );
  const listed = [out.belowGate, out.suppressed, out.unverified, out.absenceContradicted, out.rejected].flatMap(ids);
  assert.deepEqual(listed.sort(), ['cand_002', 'cand_003', 'cand_004']);
  assert.deepEqual(ids(out.belowGate), ['cand_002']);
  assert.deepEqual(ids(out.rejected), ['cand_003']);
});
