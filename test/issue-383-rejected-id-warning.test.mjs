/**
 * #383: the skill keeps the verifier's full output and pipes only the
 * survivors to `score`, which then warned about the verifier's own rejected
 * candidate as an unknown id on every run with a rejection.
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

const candidate = {
  candidate_id: 'cand_001',
  path: 'src/a.ts',
  line: 1,
  category: 'correctness',
  severity: 'minor',
  claim: 'The handler returns before the transaction commits.',
  failure_mode: 'A failed commit is reported as success.',
  evidence: ['src/a.ts:1'],
  technical_confidence: 0.9,
};

function score(verifications) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-383-'));
  try {
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify({ verifications }));
    return spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--min-score', '0'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const kept = { candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 };

test('a rejected candidate that was not piped in is not warned about', () => {
  const result = score([kept, { candidate_id: 'cand_005', verified: false, technical_confidence: 0.2 }]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unknown candidate id/);
});

test('an entry for a candidate that was never piped in and was not rejected is still warned about', () => {
  const result = score([kept, { candidate_id: 'cand_007', verified: true, technical_confidence: 0.9 }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /verifies unknown candidate id\(s\): cand_007\. Ignored\./);
});
