/**
 * A trust boundary can be a non-security control boundary, so repository reach
 * alone cannot turn a requested minor finding into blocking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';

const CANDIDATE = {
  candidate_id: 'cand_001',
  path: 'ci/paths.ts',
  line: 18,
  category: 'trust_boundary',
  severity: 'minor',
  claim: 'The renamed workflow path bypasses the changed-files gate.',
  failure_mode: 'The required check does not run for a changed protected path.',
  evidence: ['ci/paths.ts:18 matches only the old path.'],
  technical_confidence: 0.9,
};

const REPOSITORY_REACH = {
  reach: 'repository',
  symbolSource: 'hunks',
  moduleFallback: false,
  symbols: ['ChangedPathGate'],
  ignoredSymbols: [],
  paths: [],
  countedPaths: [],
  directoryCount: 4,
  outsideDirectoryCount: 3,
  inconclusive: false,
  searchedRef: 'HEAD',
};

function severity(verification) {
  const candidate = normaliseCandidate(CANDIDATE, 0);
  return scoreCandidate(candidate, [], [], undefined, {
    candidateId: 'cand_001',
    verified: true,
    technicalConfidence: 0.9,
    reach: REPOSITORY_REACH,
    ...verification,
  }).severity;
}

test('an untraced trust_boundary finding at repository reach stays at its requested minor tier', () => {
  const result = severity({ impactTraced: false });
  assert.equal(result.severity, 'minor');
  assert.match(result.reason, /held at minor because escalation needs the verifier to trace impact/);
});

test('a trust_boundary finding can still reach blocking after impact is traced', () => {
  assert.equal(severity({ impactTraced: true }).severity, 'blocking');
});

test('no-exposure still holds a trust_boundary finding at the requested tier', () => {
  const result = severity({ impactTraced: false, impactClass: 'no-exposure' });
  assert.equal(result.severity, 'minor');
  assert.match(result.reason, /held at minor because the verifier found no exposure/);
});
