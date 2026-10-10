/**
 * Missing context the claim does not depend on. A verified behavioural finding
 * was rejected by the unverifiable cap because the only missing context was the
 * display text of a key it quoted; the defect did not depend on that wording.
 * The verifier can now mark an entry `cosmetic`, and the cap applies only to
 * blocking entries. A plain string, or an object with no kind, stays blocking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingContext, scoreCandidate, DEFAULT_THRESHOLDS } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const candidate = {
  candidateId: 'cand_001',
  path: 'src/checkout.ts',
  line: 12,
  category: 'user_visible_behavior',
  severity: 'minor',
  claim: 'The declined branch shows the `payment.retry` message instead of `payment.declined`.',
  failureMode: 'A customer whose card was declined is told to retry.',
  evidence: ['src/checkout.ts:12 picks `payment.retry` when the status is declined.'],
  suggestedFix: null,
  fixConfidence: null,
  technicalConfidence: 0.85,
};

const KEY_TEXT = 'the display text of `payment.retry`, which lives in the translation service';

const verify = (missing) =>
  scoreCandidate(candidate, [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.85,
    requiredContextMissing: missing,
  });

test('cosmetic missing context leaves the verifier confidence standing', () => {
  const result = verify([{ context: KEY_TEXT, kind: 'cosmetic' }]);
  assert.equal(result.confidenceSource, 'verifier');
  assert.equal(result.technicalConfidence, 0.85);
  assert.notEqual(result.rejectedBecause, 'the claim states it could not be verified, so it cannot ship whatever it scores');
});

test('blocking, unmarked and plain-string context still caps', () => {
  for (const missing of [[KEY_TEXT], [{ context: KEY_TEXT }], [{ context: KEY_TEXT, kind: 'blocking' }], [{ context: 'a', kind: 'cosmetic' }, 'b']]) {
    const result = verify(missing);
    assert.equal(result.confidenceSource, 'unverifiable-cap', JSON.stringify(missing));
    assert.equal(result.eligible, false);
  }
});

test('blockingContext keeps strings and unmarked or blocking objects', () => {
  assert.deepEqual(blockingContext(['a', { context: 'b' }, { context: 'c', kind: 'blocking' }, { context: 'd', kind: 'cosmetic' }]), ['a', 'b', 'c']);
  assert.deepEqual(blockingContext(undefined), []);
});

function cli(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-cosmetic-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const raw = {
  candidate_id: 'cand_001',
  path: 'src/checkout.ts',
  line: 12,
  category: 'user_visible_behavior',
  severity: 'minor',
  claim: candidate.claim,
  failure_mode: candidate.failureMode,
  evidence: candidate.evidence,
  technical_confidence: 0.85,
};

test('score reads cosmetic entries from the verification file and lists only blocking ones as unverified', () =>
  withDir((dir) => {
    const file = join(dir, 'verification.json');
    writeFileSync(
      file,
      JSON.stringify([
        { candidate_id: 'cand_001', technical_confidence: 0.85, required_context_missing: [{ context: KEY_TEXT, kind: 'cosmetic' }] },
        { candidate_id: 'cand_002', technical_confidence: 0.85, required_context_missing: [{ context: 'a sibling service' }, { context: KEY_TEXT, kind: 'cosmetic' }] },
      ]),
    );
    const second = { ...raw, candidate_id: 'cand_002', line: 40, claim: 'The refund path skips the ledger write for partial refunds.' };
    const r = cli(['score', '--verification', file, '--min-score', '0.3'], JSON.stringify({ candidates: [raw, second] }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const byId = Object.fromEntries(out.scores.map((row) => [row.candidateId, row]));
    assert.equal(byId.cand_001.confidenceSource, 'verifier');
    assert.equal(byId.cand_002.confidenceSource, 'unverifiable-cap');
    assert.deepEqual(out.unverified.map((entry) => [entry.candidateId, entry.requiredContextMissing]), [['cand_002', ['a sibling service']]]);
  }));

test('check-verification refuses a context entry with an unknown kind or no context', () =>
  withDir((dir) => {
    for (const entry of [{ context: KEY_TEXT, kind: 'minor' }, { kind: 'cosmetic' }, { context: '' }, { context: KEY_TEXT, why: 'x' }]) {
      const r = cli(['check-verification'], JSON.stringify([{ candidate_id: 'cand_001', required_context_missing: [entry] }]), dir);
      assert.equal(r.code, 2, JSON.stringify(entry));
      assert.match(r.stderr, /required_context_missing must be an array of strings, or of \{"context": string, "kind": "blocking" \| "cosmetic"\}/);
    }
    const ok = cli(['check-verification'], JSON.stringify([{ candidate_id: 'cand_001', required_context_missing: ['x', { context: KEY_TEXT, kind: 'cosmetic' }] }]), dir);
    assert.equal(ok.code, 0, ok.stderr);
  }));

test('the schema and the verifier prompt describe the two kinds', () => {
  const schema = JSON.parse(readFileSync(join(plugin, 'schemas/verification.schema.json'), 'utf8'));
  const object = schema.properties.required_context_missing.items.oneOf.find((option) => option.type === 'object');
  assert.deepEqual(object.properties.kind.enum, ['blocking', 'cosmetic']);
  const verifier = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  assert.match(verifier, /\{"context": "\.\.\.", "kind": "cosmetic"\}/);
  assert.match(verifier, /When in doubt, it is blocking/);
});
