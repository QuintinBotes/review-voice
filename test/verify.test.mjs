import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';

/**
 * Verifier output is injected rather than produced by a subprocess.
 *
 * Earlier versions of these fixtures built shell commands, then wrote temp
 * files and ran `cat`. Both failed on Linux and passed on macOS for reasons
 * that had nothing to do with the code under test. The module takes a runner
 * so the parsing and decision logic can be tested without a shell, a
 * filesystem, or a platform.
 */
function emitsRaw(text, opts = {}) {
  return {
    config: { enabled: true, command: 'irrelevant', name: 'test', ...opts },
    runner: () => ({ stdout: text, stderr: '', failed: false }),
  };
}

const failing = { config: { enabled: true, command: 'irrelevant', name: 'absent' }, runner: () => ({ stdout: '', stderr: '', failed: true }) };

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
const emits = (json, opts) => emitsRaw(JSON.stringify(json), opts);

/** Accepts either a plain config or a {config, runner} fixture. */
const run = (findings, fixture) => {
  const config = fixture.config ?? fixture;
  const runner = fixture.runner;
  return verifyFindings(findings, config, { cwd: process.cwd(), ...(runner ? { runner } : {}) });
};

test('verification is off unless configured', () => {
  const report = run([finding()], { enabled: false, command: 'echo x' });
  assert.equal(report.enabled, false);
  assert.deepEqual(report.verdicts, []);
});

test('a configured verifier with no command does not run', () => {
  assert.equal(run([finding()], { enabled: true, command: '   ' }).enabled, false);
});

test('a verdict is read the same way whichever shell runs the command', () => {
  // /bin/sh is dash on Linux and bash on macOS. The module must not care.
  const [v] = run([finding()], emitsRaw('{"verdict":"rejected","confidence":0.95,"reason":"nope"}')).verdicts;
  assert.equal(v.outcome, 'dropped');
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
  const fixture = emits({ verdict: 'rejected', confidence: 0.6 }, { dropThreshold: 0.5 });
  assert.equal(run([finding()], fixture).verdicts[0].outcome, 'dropped');
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
  const report = run([finding()], failing);
  const [v] = report.verdicts;
  assert.equal(v.outcome, 'unverified');
  assert.equal(v.finalSeverity, 'blocking', 'the finding must stand unchanged');
  assert.deepEqual(report.didNotRun, ['absent']);
});

test('unparseable output is not confirmation either', () => {
  const report = run([finding()], emitsRaw('I think it is probably fine', { name: 'chatty' }));
  assert.equal(report.verdicts[0].outcome, 'unverified');
  assert.deepEqual(report.didNotRun, ['chatty']);
});

test('a chatty verifier that still emits JSON is understood', () => {
  // Real verifiers narrate. Take the last JSON object rather than demanding
  // the command print nothing else.
  const config = emitsRaw(
    ['thinking about this one', 'checking the anchor lines', '{"verdict":"rejected","confidence":0.9,"reason":"nope"}'].join('\n'),
  );
  const [v] = run([finding()], config).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.equal(v.reason, 'nope');
});

test('a verifier that emits several JSON objects is read on the last one', () => {
  const config = emitsRaw(
    ['{"verdict":"confirmed","confidence":0.1}', 'on reflection:', '{"verdict":"rejected","confidence":0.95,"reason":"final"}'].join('\n'),
  );
  const [v] = run([finding()], config).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.equal(v.reason, 'final');
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

test('a verdict containing nested objects is parsed whole', () => {
  // A non-greedy regex would stop at the first closing brace and lose the rest.
  const config = emitsRaw(
    '{"verdict":"rejected","confidence":0.9,"reason":"see below","detail":{"line":84,"note":"unreachable"}}',
  );
  const [v] = run([finding()], config).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.equal(v.reason, 'see below');
});

test('a brace inside a string does not confuse the extractor', () => {
  const config = emitsRaw('{"verdict":"rejected","confidence":0.9,"reason":"literal { and } in text"}');
  const [v] = run([finding()], config).verdicts;
  assert.equal(v.outcome, 'dropped');
  assert.match(v.reason, /literal \{ and \}/);
});
