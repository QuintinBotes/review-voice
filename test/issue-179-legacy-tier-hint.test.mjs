/**
 * #179: a verified ci finding that broke the shared build was raised as
 * blocking and scored minor, because its claim named no symbol, so reach was
 * unknown and the category's legacy tier applied. The tier stays (reach is
 * still unknown), but the reason now says the requested tier was not applied
 * and names the owner override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, DEFAULT_THRESHOLDS } from '../plugins/review-voice/src/scoring/score.ts';

const candidate = (over = {}) => ({
  candidateId: 'cand_001',
  path: '.github/workflows/build.yml',
  line: 12,
  category: 'ci',
  severity: 'blocking',
  claim: 'The build job now installs from a lockfile that is not committed.',
  failureMode: 'Every later pull request fails the build job at install.',
  evidence: ['.github/workflows/build.yml:12 points the install step at the missing lockfile.'],
  technicalConfidence: 0.9,
  ...over,
});
const verified = { candidateId: 'cand_001', verified: true, technicalConfidence: 0.9, reason: 'The lockfile is absent at head.' };
const score = (over = {}, verification = verified) => scoreCandidate(candidate(over), [], [], DEFAULT_THRESHOLDS, verification);

test('#179: a verified finding held at its legacy tier names the requested tier and the override', () => {
  const { severity } = score();
  assert.equal(severity.severity, 'minor');
  assert.match(severity.reason, /^ci carries minor; reach is unknown, so the requested blocking was not applied/);
  assert.match(severity.reason, /--severity cand_001=blocking/);
});

test('#179: no hint when the request was not above the tier, or the finding is unverified', () => {
  assert.equal(score({ severity: 'minor' }).severity.reason, 'ci carries minor');
  assert.equal(score({}, { ...verified, verified: false }).severity.reason, 'ci carries minor');
});

test('#179: no hint once reach is known', () => {
  const reach = { reach: 'repository', symbols: ['installStep'], paths: ['a', 'b'], directoryCount: 2, inconclusive: false, searchedRef: 'base' };
  assert.doesNotMatch(score({}, { ...verified, reach }).severity.reason, /--severity/);
});
