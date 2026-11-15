/**
 * #384: a finding on one line of a settings file took its reach from the
 * symbols of every other file in the diff, and a tier held because the
 * verifier's confidence was under the bar said no impact had been traced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReach } from '../plugins/review-voice/src/scoring/reach.ts';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';

const DIFF = [
  'diff --git a/.claude/settings.json b/.claude/settings.json',
  '--- a/.claude/settings.json',
  '+++ b/.claude/settings.json',
  '@@ -1,2 +1,3 @@',
  ' {',
  '+  "allow": ["Bash(*/run-checks sync *)"],',
  ' }',
  'diff --git a/src/queue.ts b/src/queue.ts',
  '--- a/src/queue.ts',
  '+++ b/src/queue.ts',
  '@@ -1,1 +1,2 @@',
  ' export {};',
  '+export function drainWorkQueue() {}',
  '',
].join('\n');

const everywhere = () => ['src/queue.ts', 'packages/a/x.ts', 'tools/y.ts', 'apps/z.ts'];

test('a file the diff touches is measured by its own hunks, even when they hold no identifier', () => {
  const check = computeReach('The permission pattern misses a bare call.', '.claude/settings.json', '/repo', 'base', everywhere, DIFF);
  assert.deepEqual(check.symbols, [], 'no symbol of another file is searched');
  assert.equal(check.symbolSource, 'hunks');
  assert.equal(check.reach, null);
});

test('a file the diff does not touch still takes the symbols the diff changed elsewhere', () => {
  const check = computeReach('The consumer still calls the old name.', 'src/consumer.ts', '/repo', 'base', everywhere, DIFF);
  assert.equal(check.symbolSource, 'diff');
  assert.deepEqual(check.symbols, ['drainWorkQueue']);
});

const REACH = { reach: 'repository', symbolSource: 'hunks', moduleFallback: false, symbols: ['drainWorkQueue'], ignoredSymbols: [], paths: [], countedPaths: [], directoryCount: 6, outsideDirectoryCount: 5, inconclusive: false, searchedRef: 'HEAD' };

function severity(verification) {
  const candidate = normaliseCandidate(
    {
      candidate_id: 'c1',
      path: 'src/queue.ts',
      line: 2,
      category: 'api_contract',
      severity: 'minor',
      claim: 'The queue is never drained after a failed job.',
      failure_mode: 'The work queue stalls until the process restarts.',
      evidence: 'src/queue.ts:2',
      technical_confidence: 0.9,
    },
    0,
  );
  return scoreCandidate(candidate, [], [], undefined, { candidateId: 'c1', reach: REACH, ...verification }).severity;
}

test('a trace under the escalation bar is named as the reason the tier was held', () => {
  const held = severity({ technicalConfidence: 0.82, impactTraced: true });
  assert.equal(held.severity, 'minor');
  assert.match(held.reason, /held at minor because the verifier traced the impact at confidence 0\.82, and escalation needs at least 0\.85/);
  assert.doesNotMatch(held.reason, /needs the verifier to trace impact/);
});

test('an untraced finding keeps the reason that asks for a trace', () => {
  const held = severity({ technicalConfidence: 0.9 });
  assert.match(held.reason, /held at minor because escalation needs the verifier to trace impact beyond the changed code/);
});
