/**
 * `reconcile` and `score` read the evidence-verifier's confidence the same way.
 *
 * Scoring falls back to the quality tier when the verifier gave no number;
 * reconcile read only the number. A trace reported as `evidence_quality:
 * "high"` alone was then never disputed, so a second pass that downgraded it
 * was undone by scoring escalating on the very trace it doubted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile } from '../plugins/review-voice/src/verify/reconcile.ts';
import { verifierConfidence } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = {
  candidate_id: 'c1',
  path: 'src/client.ts',
  line: 10,
  category: 'api_contract',
  severity: 'minor',
  claim: 'The response drops the `total` field that callers read.',
  failure_mode: 'Every caller that sums `total` reads undefined.',
  evidence: ['src/client.ts:10 builds the response without `total`.'],
  technical_confidence: 0.9,
};

const qualityOnly = { candidate_id: 'c1', evidence_quality: 'high', impact_traced: true, reason: 'traced to src/report.ts:30' };

const downgrade = {
  candidateId: 'c1',
  path: 'src/client.ts',
  line: 10,
  verdict: 'uncertain',
  confidence: 0.6,
  reason: 'only reachable with the legacy client',
  outcome: 'downgraded',
  originalSeverity: 'minor',
  finalSeverity: 'nit',
  verifier: 'second-model',
};

test('verifierConfidence prefers the number and falls back to the tier', () => {
  assert.equal(verifierConfidence(0.7, 'high'), 0.7);
  assert.equal(verifierConfidence(undefined, 'high'), 0.9);
  assert.equal(verifierConfidence(undefined, 'medium'), 0.75);
  assert.equal(verifierConfidence(undefined, undefined), null);
  assert.equal(verifierConfidence('0.9', 'constructor'), null);
});

test('a trace reported only by quality tier is disputed when the second pass downgrades it', () => {
  const result = reconcile([candidate], [qualityOnly], [downgrade], null);
  assert.deepEqual(result.disputes.map((d) => d.candidateId), ['c1']);
  assert.equal(result.candidates[0].severity, 'nit');
  assert.equal(result.candidates[0].impact_disputed, true);

  // Below the bar by tier, as by number: medium stands for 0.75.
  const medium = reconcile([candidate], [{ ...qualityOnly, evidence_quality: 'medium' }], [downgrade], null);
  assert.deepEqual(medium.disputes, []);
});

test('scoring then holds the downgraded tier instead of escalating on the disputed trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-quality-'));
  try {
    const { candidates } = reconcile([candidate], [qualityOnly], [downgrade], null);
    writeFileSync(join(dir, 'verification.json'), JSON.stringify([qualityOnly]));
    const run = (input) => {
      const r = spawnSync(process.execPath, [bundle, 'score', '--verification', join(dir, 'verification.json')], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify({ candidates: input }),
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).scores[0].severity.severity;
    };
    // Undisputed, the traced quality-only verification escalates.
    assert.equal(run([candidate]), 'important');
    // Disputed and not upheld, it stays where the second pass left it.
    assert.equal(run(candidates), 'nit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
