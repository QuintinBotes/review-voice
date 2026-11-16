/**
 * #429, #431-#435: record says what it stored and refuses the wrong verdicts
 * file; score holds an unverified boundary claim at its requested tier, gates
 * a held tier at its own floor and attaches no withheld patch; validate-output
 * refuses an "or" the finding never said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-429-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir, args, input = '') =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

const REACH = (reach) => ({ reach, symbolSource: 'hunks', moduleFallback: false, symbols: ['x'], ignoredSymbols: [], paths: [], countedPaths: [], directoryCount: 6, outsideDirectoryCount: 5, inconclusive: false, searchedRef: 'HEAD' });
const raw = (over = {}) => ({
  candidate_id: 'c1',
  path: 'src/queue.ts',
  line: 248,
  category: 'correctness',
  severity: 'minor',
  claim: 'The queue drops a held issue when its newest run is blocked.',
  failure_mode: 'The issue is never retried.',
  evidence: 'src/queue.ts:248',
  technical_confidence: 0.9,
  ...over,
});
const score = (over, verification) => scoreCandidate(normaliseCandidate(raw(over), 0), [], [], undefined, { candidateId: 'c1', reach: REACH('repository'), ...verification });

test('#435: a finding held at minor is gated at the minor floor, not the important one', () => {
  const result = score({}, { verified: true, technicalConfidence: 0.72 });
  assert.equal(result.severity.severity, 'minor');
  assert.doesNotMatch(result.rejectedBecause ?? '', /floor for an important finding/);
  assert.equal(result.confidenceFloor, 0.7);
});

test('#432: a security claim the verifier did not verify stays at the requested tier', () => {
  const rejected = score({ category: 'security' }, { verified: false, technicalConfidence: 0.42 });
  assert.equal(rejected.severity.severity, 'minor');
  assert.match(rejected.severity.reason, /held at minor because the verifier did not verify the claim/);
  // Verified, the breach still carries its tier by itself.
  assert.equal(score({ category: 'security' }, { verified: true, technicalConfidence: 0.9 }).severity.severity, 'blocking');
});

test('#433: an eligible entry carries no suggested patch when its fix is withheld', () =>
  withDir((dir) => {
    const patch = { start_line: 248, end_line: 248, original: '  return;', replacement: '  return retry();' };
    const candidate = { ...raw({ suggested_fix: 'Retry the held issue.', suggested_patch: patch }), category: 'reliability' };
    const verification = join(dir, 'v.json');
    const scoreWith = (fix) => {
      writeFileSync(verification, JSON.stringify([{ candidate_id: 'c1', verified: true, evidence_quality: 'high', technical_confidence: 0.9, ...fix }]));
      const result = run(dir, ['score', '--verification', verification, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).eligible[0];
    };
    const withheld = scoreWith({ fix_verdict: 'verified', fix_confidence: 0.72, fix_reason: 'Holds on the traced input.' });
    assert.equal(withheld.fix.render, 'none');
    assert.equal(withheld.suggested_patch, undefined);
    const rendered = scoreWith({ fix_verdict: 'verified', fix_confidence: 0.9, fix_reason: 'Holds on the traced input.' });
    assert.equal(rendered.fix.render, 'fix');
    assert.ok(rendered.suggested_patch, 'a rendered fix keeps its patch');
  }));

test('#434: validate-output refuses an "or" the scored finding does not use', () =>
  withDir((dir) => {
    const scores = join(dir, 'scores.json');
    const entry = { candidateId: 'c1', path: 'src/a.ts', line: 3, eligible: true, confidenceSource: 'verifier', severity: { severity: 'minor' }, claim: 'The handler must require a token and throw when it is missing.', failureMode: 'A request with no token is accepted.', evidence: ['src/a.ts:3'] };
    writeFileSync(scores, JSON.stringify({ scores: [entry], eligible: [entry] }));
    const reversed = run(dir, ['validate-output', '--scores', scores], '[minor] `src/a.ts:3` - The handler must require a token or throw, so a request with no token is accepted.');
    assert.equal(reversed.status, 1);
    assert.match(reversed.stderr, /\[unbacked_connective\].*"or"/);
    const kept = run(dir, ['validate-output', '--scores', scores], '[minor] `src/a.ts:3` - The handler must require a token and throw when it is missing; a request with no token is accepted.');
    assert.equal(kept.status, 0, kept.stderr);
  }));

test('#429 and #431: record says what it stored, and refuses the evidence-verifier file as verdicts', () =>
  withDir((dir) => {
    const held = join(dir, 'held.json');
    writeFileSync(held, JSON.stringify([{ path: 'src/a.ts', line: 3, verdict: 'below-gate', source: 'score', reason: 'below the confidence gate', text: 'x', severity: 'minor' }]));
    const stages = join(dir, 'stages.json');
    writeFileSync(stages, JSON.stringify([{ name: 'analyst' }, { name: 'verify' }]));
    const ok = run(dir, ['record', '--repository', 'acme/api', '--held', held, '--stages', stages], 'No actionable findings.');
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).stored, { held: 1, stages: 2 });

    const verification = join(dir, 'verification.json');
    for (const shape of [{ verifications: [{ candidate_id: 'c1', verified: true }] }, [{ candidate_id: 'c1', verified: true, technical_confidence: 0.9 }]]) {
      writeFileSync(verification, JSON.stringify(shape));
      const refused = run(dir, ['record', '--repository', 'acme/api', '--verdicts', verification], 'No actionable findings.');
      assert.equal(refused.status, 2, JSON.stringify(shape));
      assert.match(refused.stderr, /is the evidence-verifier's output, not a second-pass report/);
    }
  }));
