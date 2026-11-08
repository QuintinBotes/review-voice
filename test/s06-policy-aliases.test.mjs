/**
 * The suppression carve-out compares categories the way the severity table
 * does (docs/adr/0032): an alias such as `authz`, or a spelling such as
 * `data-integrity`, names the same exempt category and gets no further.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCategory } from '../plugins/review-voice/src/scoring/severity.ts';
import { isSuppressionExempt, matchingSuppression, SUPPRESSION_EXEMPT_CATEGORIES } from '../plugins/review-voice/src/scoring/score.ts';

test('the canonical category resolves aliases, case, spaces and hyphens', () => {
  assert.equal(canonicalCategory('authz'), 'authorization');
  assert.equal(canonicalCategory('AuthN'), 'authentication');
  assert.equal(canonicalCategory('secrets'), 'security');
  assert.equal(canonicalCategory('vulnerability'), 'security');
  assert.equal(canonicalCategory(' Data-Integrity '), 'data_integrity');
  assert.equal(canonicalCategory('trust boundary'), 'trust_boundary');
  assert.equal(canonicalCategory('maintainability'), 'maintainability');
  // A word the table does not know is kept as written, in canonical spelling.
  assert.equal(canonicalCategory('Made-Up'), 'made_up');
});

test('every spelling of an exempt category is exempt, and no other category is', () => {
  for (const spelling of ['authz', 'authn', 'secrets', 'vulnerability', 'Data-Integrity', 'trust-boundary', ' Security ', 'AUTHORIZATION']) {
    assert.equal(isSuppressionExempt(spelling), true, spelling);
  }
  for (const spelling of ['maintainability', 'perf', 'docs', 'correctness', 'made_up']) {
    assert.equal(isSuppressionExempt(spelling), false, spelling);
  }
  for (const category of SUPPRESSION_EXEMPT_CATEGORIES) assert.equal(isSuppressionExempt(category), true, category);
});

test('a suppression keyed on an alias of an exempt category matches nothing', () => {
  const suppression = (ruleId) => [{ ruleId, glob: null, reason: null, policyVersion: 1 }];
  const candidate = (category) => ({ category, lane: 'diff', blockerClass: undefined, path: 'src/auth.ts' });
  assert.equal(matchingSuppression(suppression('authz:diff'), candidate('authz')), null);
  assert.equal(matchingSuppression(suppression('data-integrity:diff'), candidate('data-integrity')), null);
  assert.equal(matchingSuppression(suppression('secrets:diff'), candidate('secrets')), null);
  // The same shape on a category that is not exempt does match, so the test
  // would fail if the matcher were simply broken.
  assert.notEqual(matchingSuppression(suppression('docs:diff'), candidate('docs')), null);
});

test('a scoped suppression matches the path however the candidate spells it', () => {
  const scoped = [{ ruleId: 'maintainability:diff', glob: 'src/billing/**', reason: null, policyVersion: 1 }];
  const candidate = (path) => ({ category: 'maintainability', lane: 'diff', blockerClass: undefined, path });
  for (const spelling of ['src/billing/retry.ts', './src/billing/retry.ts', 'src/./billing/retry.ts', 'src/orders/../billing/retry.ts']) {
    assert.notEqual(matchingSuppression(scoped, candidate(spelling)), null, spelling);
  }
  assert.equal(matchingSuppression(scoped, candidate('src/orders/retry.ts')), null);
  assert.equal(matchingSuppression(scoped, candidate('./src/orders/retry.ts')), null);
});
