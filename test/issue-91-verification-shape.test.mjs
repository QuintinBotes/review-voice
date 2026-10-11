/**
 * The evidence verifier once returned second-pass field names. The checker
 * accepted them while score ignored them and fell back to analyst confidence.
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
  path: 'src/orders.ts',
  line: 12,
  category: 'reliability',
  severity: 'minor',
  claim: 'The retry records success before the delivery completes.',
  failure_mode: 'A transient delivery failure is not retried.',
  evidence: ['src/orders.ts:12 records the result before the await.'],
  technical_confidence: 0.6,
};

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-91-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args, input) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
  });
}

test('check-verification and score reject second-pass verdict/confidence fields', () =>
  withDir((dir) => {
    const mistaken = {
      candidate_id: 'cand_001',
      verdict: 'verified',
      confidence: 0.82,
      impact_traced: true,
    };
    const checked = run(dir, ['check-verification'], JSON.stringify([mistaken]));
    assert.equal(checked.status, 2, checked.stderr);
    assert.match(checked.stderr, /use verified \(boolean\) and technical_confidence/);

    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify([mistaken]));
    const scored = run(dir, ['score', '--verification', verification, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 2, scored.stderr);
    assert.match(scored.stderr, /not verdict or confidence/);
  }));

test('the documented verified/technical_confidence shape remains scoreable', () =>
  withDir((dir) => {
    const verification = [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.82, impact_traced: true }];
    const checked = run(dir, ['check-verification'], JSON.stringify(verification));
    assert.equal(checked.status, 0, checked.stderr);

    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify(verification));
    const scored = run(dir, ['score', '--verification', file, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 0, scored.stderr);
    const [entry] = JSON.parse(scored.stdout).scores;
    assert.equal(entry.confidenceSource, 'verifier');
    assert.equal(entry.technicalConfidence, 0.82);
  }));
