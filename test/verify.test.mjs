import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';

const finding = (over = {}) => ({
  candidateId: 'cand_001',
  path: 'src/auth.ts',
  line: 84,
  severity: 'blocking',
  claim: 'Token returned before commit.',
  failureMode: 'A retry mints two tokens.',
  evidence: ['line 84'],
  ...over,
});

/** A verifier that emits whatever JSON it is told to. */
const emits = (json) => ({ enabled: true, command: `printf '%s' '${JSON.stringify(json)}'`, name: 'test' });

const run = (findings, config) => verifyFindings(findings, config, { cwd: process.cwd() });

test('verification is off unless configured', () => {
  const report = run([finding()], { enabled: false, command: 'echo x' });
  assert.equal(report.enabled, false);
  assert.deepEqual(report.verdicts, []);
});

test('a configured verifier with no command does not run', () => {
  assert.equal(run([finding()], { enabled: true, command: '   ' }).enabled, false);
});

test('a confident rejection drops the finding', () => {
  const [v] = run([finding()], emits({ verdict: 'rejected', confidence: 0.95, reason: 'no path reaches it' })).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.equal(v.reason, 'no path reaches it');
});

test('an unsure rejection downgrades rather than deleting', () => {
  // An unsure verifier must not be able to delete evidence.
  const [v] = run([finding()], emits({ verdict: 'rejected', confidence: 0.4 })).verdicts;
  assert.equal(v.outcome, 'downgraded');
  assert.equal(v.originalSeverity, 'blocking');
  assert.equal(v.finalSeverity, 'important');
});

test('the drop threshold is configurable', () => {
  const config = { ...emits({ verdict: 'rejected', confidence: 0.6 }), dropThreshold: 0.5 };
  assert.equal(run([finding()], config).verdicts[0].outcome, 'dropped');
});

test('an uncertain verdict downgrades', () => {
  const [v] = run([finding()], emits({ verdict: 'uncertain', confidence: 0.5 })).verdicts;
  assert.equal(v.outcome, 'downgraded');
});

test('a confirmation leaves the finding alone', () => {
  const [v] = run([finding()], emits({ verdict: 'confirmed', confidence: 0.9 })).verdicts;
  assert.equal(v.outcome, 'kept');
  assert.equal(v.finalSeverity, 'blocking');
});

test('a verifier may weaken a severity but never strengthen one', () => {
  // Its job is to doubt, not to escalate.
  const weaker = run([finding()], emits({ verdict: 'confirmed', confidence: 0.9, suggested_severity: 'nit' }));
  assert.equal(weaker.verdicts[0].finalSeverity, 'nit');

  const stronger = run(
    [finding({ severity: 'minor' })],
    emits({ verdict: 'confirmed', confidence: 0.9, suggested_severity: 'blocking' }),
  );
  assert.equal(stronger.verdicts[0].finalSeverity, 'minor');
});

test('a verifier that cannot run never counts as confirmation', () => {
  const report = run([finding()], { enabled: true, command: 'definitely-not-a-binary-xyz', name: 'absent' });
  const [v] = report.verdicts;
  assert.equal(v.outcome, 'unverified');
  assert.equal(v.finalSeverity, 'blocking', 'the finding must stand unchanged');
  assert.deepEqual(report.didNotRun, ['absent']);
});

test('unparseable output is not confirmation either', () => {
  const report = run([finding()], { enabled: true, command: 'echo "I think it is probably fine"', name: 'chatty' });
  assert.equal(report.verdicts[0].outcome, 'unverified');
  assert.deepEqual(report.didNotRun, ['chatty']);
});

test('a chatty verifier that still emits JSON is understood', () => {
  // Real verifiers narrate. Take the last JSON object rather than demanding
  // the command print nothing else.
  const command = `printf 'thinking...\\nchecking anchors\\n{"verdict":"rejected","confidence":0.9,"reason":"nope"}\\n'`;
  const [v] = run([finding()], { enabled: true, command, name: 'verbose' }).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.equal(v.reason, 'nope');
});

test('every finding gets a verdict, including ones nothing happened to', () => {
  const report = run([finding(), finding({ candidateId: 'cand_002', line: 90 })], emits({ verdict: 'confirmed', confidence: 0.9 }));
  // A suppressed finding leaves no other trace, so the record has to be complete.
  assert.equal(report.verdicts.length, 2);
  assert.ok(report.verdicts.every((v) => v.verifier === 'test'));
});

test('a nit cannot be downgraded past the bottom of the scale', () => {
  const [v] = run([finding({ severity: 'nit' })], emits({ verdict: 'uncertain', confidence: 0.3 })).verdicts;
  assert.equal(v.finalSeverity, 'nit');
});
