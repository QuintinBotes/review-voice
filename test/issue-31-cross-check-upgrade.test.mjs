/**
 * #31: what an independent cross-check may say, and how much it counts.
 *
 * - A cross-check that traced a worse impact than the verifier had no way to
 *   raise a tier. It now proposes one, the tie-breaker settles it like any
 *   other dispute, and the tier rises only on an upheld ruling that traced
 *   the impact at the escalation confidence. See docs/adr/0018.
 * - A cross-check that read excerpts missed the decisive lines. Its verdict
 *   now names them, and the tie-breaker gets them as places to look.
 * - A cross-check answered "REFUTED" while its reason confirmed the claim. A
 *   verdict whose fields contradict its label is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';
import { parseSecondPass, parseTieBreaks, reconcile, ReconcileInputError } from '../plugins/review-voice/src/verify/reconcile.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const DECISIVE = [{ path: 'src/limits.ts', line: 12, why: 'the only writer of the cap; it is never set on this path' }];

const finding = (over = {}) => ({
  candidateId: 'c1',
  path: 'src/queue.ts',
  line: 10,
  severity: 'minor',
  claim: 'The batch size ignores the configured limit.',
  failureMode: 'Large queues exhaust memory.',
  evidence: ['src/queue.ts:10 reads the default'],
  ...over,
});

function verifyWith(raw, over = {}) {
  const runner = () => ({ stdout: typeof raw === 'string' ? raw : JSON.stringify(raw), stderr: '', failed: false });
  return verifyFindings([finding(over)], { enabled: true, command: 'irrelevant', name: 'second-model' }, { cwd: root, runner })
    .verdicts[0];
}

const candidate = (id, severity = 'minor') => ({
  candidate_id: id,
  path: 'src/queue.ts',
  line: 10,
  category: 'correctness',
  severity,
  claim: 'The batch size ignores the configured limit.',
  failure_mode: 'Large queues exhaust memory.',
  evidence: ['src/queue.ts:10 reads the default'],
  technical_confidence: 0.9,
});

const verification = (id) => ({
  candidate_id: id,
  verified: true,
  evidence_quality: 'medium',
  technical_confidence: 0.75,
  impact_traced: false,
  reason: 'confirmed at the changed line',
});

const upgradeVerdict = (over = {}) => ({
  candidateId: 'c1',
  path: 'src/queue.ts',
  line: 10,
  verdict: 'confirmed',
  confidence: 0.9,
  reason: 'A queue past 10k entries reaches the unbounded branch.',
  outcome: 'kept',
  originalSeverity: 'minor',
  finalSeverity: 'minor',
  verifier: 'second-model',
  proposedSeverity: 'blocking',
  decisiveEvidence: DECISIVE,
  ...over,
});

const ruling = (over = {}) => ({ candidate_id: 'c1', upheld: true, reason: 'src/queue.ts:10 to src/limits.ts:12', ...over });

const run = (verdicts, tieBreaks = null) =>
  reconcile([candidate('c1')], [verification('c1')], parseSecondPass({ verdicts }), tieBreaks === null ? null : parseTieBreaks(tieBreaks));

const refused = (verdict, pattern) =>
  assert.throws(() => parseSecondPass({ verdicts: [verdict] }), (error) => error instanceof ReconcileInputError && pattern.test(error.message));

test('verify keeps a traced worse impact as a proposal, never as the tier', () => {
  const v = verifyWith({ verdict: 'confirmed', confidence: 0.9, reason: 'reaches the unbounded branch', suggested_severity: 'blocking', decisive_evidence: DECISIVE });
  assert.equal(v.outcome, 'kept');
  assert.equal(v.finalSeverity, 'minor');
  assert.equal(v.proposedSeverity, 'blocking');
  assert.deepEqual(v.decisiveEvidence, DECISIVE);

  // With nothing to trace it is ignored, as before.
  const bare = verifyWith({ verdict: 'confirmed', confidence: 0.9, reason: 'worse', suggested_severity: 'blocking' });
  assert.equal(bare.proposedSeverity, undefined);
  assert.equal(bare.finalSeverity, 'minor');
});

test('verify keeps only well-formed decisive lines, on any verdict', () => {
  const v = verifyWith({
    verdict: 'rejected',
    confidence: 0.6,
    reason: 'the guard at src/guard.ts:4 stops it',
    decisive_evidence: [{ path: 'src/guard.ts', line: 4, why: 'returns early' }, { path: '', line: 1, why: 'x' }, { path: 'a.ts', line: 0, why: 'x' }, 'src/b.ts:3'],
  });
  assert.equal(v.outcome, 'downgraded');
  assert.deepEqual(v.decisiveEvidence, [{ path: 'src/guard.ts', line: 4, why: 'returns early' }]);
});

test('verify reads a label outside the three as no verdict, not as a confirmation', () => {
  const refuted = verifyWith({ verdict: 'REFUTED', confidence: 0.9, reason: 'the claim holds' });
  assert.equal(refuted.outcome, 'unverified');
  assert.equal(refuted.finalSeverity, 'minor');
  assert.equal(verifyWith({ verdict: 'Rejected', confidence: 0.95, reason: 'guarded' }).outcome, 'dropped');
});

test('verify never turns a question into an assertion when it doubts it', () => {
  const v = verifyWith({ verdict: 'uncertain', confidence: 0.5, reason: 'cannot tell' }, { severity: 'question' });
  assert.equal(v.outcome, 'downgraded');
  assert.equal(v.finalSeverity, 'question');
});

test('every verdict verify writes passes the consistency check', () => {
  const raws = [
    [{ verdict: 'confirmed', confidence: 0.9 }, 'important'],
    [{ verdict: 'confirmed', confidence: 0.9, suggested_severity: 'nit' }, 'important'],
    [{ verdict: 'rejected', confidence: 0.95 }, 'important'],
    [{ verdict: 'rejected', confidence: 0.5 }, 'nit'],
    [{ verdict: 'uncertain', confidence: 0.5 }, 'nit'],
    [{ verdict: 'uncertain', confidence: 0.5 }, 'question'],
    [{ verdict: 'confirmed', confidence: 0.9, reason: 'worse', suggested_severity: 'important', decisive_evidence: DECISIVE }, 'minor'],
    ['no json at all', 'blocking'],
  ];
  const verdicts = raws.map(([raw, severity], index) => verifyWith(raw, { candidateId: `c${index}`, severity }));
  assert.equal(parseSecondPass({ verdicts }).length, raws.length);
});

test('an upgrade proposal is a dispute, and the tie-breaker gets its decisive lines', () => {
  const result = run([upgradeVerdict()]);
  assert.equal(result.disputes.length, 1);
  const [dispute] = result.disputes;
  assert.equal(dispute.kind, 'upgrade');
  assert.equal(dispute.secondPass.proposedSeverity, 'blocking');
  assert.deepEqual(dispute.secondPass.decisiveEvidence, DECISIVE);
  // With no ruling the tier stays.
  assert.equal(result.candidates[0].severity, 'minor');
  assert.deepEqual(result.applied, [{ candidateId: 'c1', kind: 'upgrade', result: 'no tie-break supplied', severity: 'minor', reason: null }]);
});

test('the tier rises only on an upheld ruling that traced the impact at the escalation confidence', () => {
  const raised = run([upgradeVerdict()], [ruling({ impact_traced: true, confidence: 0.9 })]);
  assert.equal(raised.candidates[0].severity, 'blocking');
  assert.equal(raised.applied[0].result, 'upheld');
  assert.deepEqual(raised.tieBreaks, [
    { candidateId: 'c1', upheld: true, reason: 'src/queue.ts:10 to src/limits.ts:12', impactTraced: true, confidence: 0.9, applied: true, raised: 'blocking' },
  ]);

  // A tier stands for a number, read as scoring reads it.
  assert.equal(run([upgradeVerdict()], [ruling({ impact_traced: true, evidence_quality: 'high' })]).candidates[0].severity, 'blocking');

  const unsure = run([upgradeVerdict()], [ruling({ impact_traced: true, confidence: 0.8 })]);
  assert.equal(unsure.candidates[0].severity, 'minor');
  assert.equal(unsure.applied[0].result, 'upheld without traced impact');
  assert.equal(unsure.tieBreaks[0].raised, undefined);

  const untraced = run([upgradeVerdict()], [ruling({ confidence: 0.95 })]);
  assert.equal(untraced.candidates[0].severity, 'minor');

  const no = run([upgradeVerdict()], [ruling({ upheld: false, impact_traced: true, confidence: 0.95 })]);
  assert.equal(no.candidates[0].severity, 'minor');
  assert.equal(no.applied[0].result, 'not upheld');

  // A `raised` mark in the input is recomputed, never trusted.
  assert.equal(run([upgradeVerdict()], [ruling({ upheld: false, raised: 'blocking' })]).tieBreaks[0].raised, undefined);
});

test('a downgrade dispute also hands the tie-breaker the second pass\'s decisive lines', () => {
  const traced = { ...verification('c1'), technical_confidence: 0.9, impact_traced: true };
  const verdict = {
    ...upgradeVerdict({ verdict: 'uncertain', outcome: 'downgraded', finalSeverity: 'nit', reason: 'guarded at src/guard.ts:4' }),
    proposedSeverity: undefined,
  };
  delete verdict.proposedSeverity;
  const result = reconcile([candidate('c1')], [traced], parseSecondPass({ verdicts: [verdict] }), null);
  assert.equal(result.disputes[0].kind, 'downgrade');
  assert.deepEqual(result.disputes[0].secondPass.decisiveEvidence, DECISIVE);
  assert.equal(result.disputes[0].secondPass.proposedSeverity, null);
});

test('a second-pass verdict whose fields contradict its label is refused', () => {
  const base = { candidateId: 'c1', path: 'src/queue.ts', line: 10, confidence: 0.9, reason: 'r', originalSeverity: 'important', finalSeverity: 'important', verifier: 'v' };
  refused({ ...base, verdict: 'REFUTED', outcome: 'kept' }, /verdict must be one of/);
  refused({ ...base, verdict: 'rejected', outcome: 'kept' }, /a kept verdict must be confirmed, not rejected/);
  refused({ ...base, verdict: 'confirmed', outcome: 'dropped' }, /a dropped verdict must be rejected/);
  refused({ ...base, verdict: 'confirmed', outcome: 'unverified' }, /must be uncertain/);
  refused({ ...base, verdict: 'uncertain', outcome: 'downgraded', finalSeverity: 'important' }, /below important, not important/);
  refused({ ...base, verdict: 'uncertain', outcome: 'downgraded', finalSeverity: 'blocking' }, /below important/);
  refused({ ...base, verdict: 'uncertain', outcome: 'downgraded', finalSeverity: 'severe' }, /known tier/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', finalSeverity: 'nit' }, /a kept verdict leaves the severity/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', proposedSeverity: 'blocking' }, /needs decisiveEvidence/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', proposedSeverity: 'blocking', decisiveEvidence: [] }, /needs decisiveEvidence/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', proposedSeverity: 'minor', decisiveEvidence: DECISIVE }, /not above important/);
  refused({ ...base, verdict: 'uncertain', outcome: 'downgraded', finalSeverity: 'minor', proposedSeverity: 'blocking', decisiveEvidence: DECISIVE }, /only a kept verdict/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', proposedSeverity: 'blocking', decisiveEvidence: DECISIVE, reason: ' ' }, /needs a reason/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', decisiveEvidence: [{ path: 'a.ts', line: 'x', why: 'y' }] }, /positive line/);
  refused({ ...base, verdict: 'confirmed', outcome: 'kept', decisiveEvidence: 'src/a.ts:3' }, /must be an array/);

  // A nit has no weaker tier: staying a nit is not a contradiction.
  assert.equal(parseSecondPass({ verdicts: [{ ...base, verdict: 'uncertain', outcome: 'downgraded', originalSeverity: 'nit', finalSeverity: 'nit' }] }).length, 1);
});

test('an upgrade ruling\'s trace fields are read strictly', () => {
  assert.throws(() => parseTieBreaks([ruling({ impact_traced: 'yes' })]), /impact_traced must be true or false/);
  assert.throws(() => parseTieBreaks([ruling({ confidence: 1.5 })]), /confidence must be a number from 0 to 1/);
  assert.throws(() => parseTieBreaks([ruling({ confidence: '0.9' })]), /confidence must be a number/);
  assert.throws(() => parseTieBreaks([ruling({ raised: 'severe' })]), /raised must be a severity/);
});

test('reconcile exits 2 on a contradicting verdict and raises a tier through the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-31-'));
  const data = mkdtempSync(join(tmpdir(), 'rv-issue-31-data-'));
  try {
    writeFileSync(join(dir, 'verification.json'), JSON.stringify([verification('c1')]));
    const cli = (verdicts, tieBreaks) => {
      writeFileSync(join(dir, 'second-pass.json'), JSON.stringify({ enabled: true, verifier: 'second-model', verdicts, didNotRun: [] }));
      const args = ['reconcile', '--verification', join(dir, 'verification.json'), '--second-pass', join(dir, 'second-pass.json')];
      if (tieBreaks !== undefined) {
        writeFileSync(join(dir, 'tie-breaks.json'), JSON.stringify(tieBreaks));
        args.push('--tie-breaks', join(dir, 'tie-breaks.json'));
      }
      return spawnSync(process.execPath, [bundle, ...args], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify({ candidates: [candidate('c1')] }),
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
      });
    };

    const contradicting = cli([upgradeVerdict({ verdict: 'rejected' })]);
    assert.equal(contradicting.status, 2);
    assert.match(contradicting.stderr, /verdict 0: a kept verdict must be confirmed, not rejected/);

    const raised = cli([upgradeVerdict()], [ruling({ impact_traced: true, confidence: 0.9 })]);
    assert.equal(raised.status, 0, raised.stderr);
    const out = JSON.parse(raised.stdout);
    assert.equal(out.candidates[0].severity, 'blocking');
    assert.equal(out.tieBreaks[0].raised, 'blocking');
    assert.equal(out.disputes[0].kind, 'upgrade');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
