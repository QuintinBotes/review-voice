import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreCandidate, DEFAULT_THRESHOLDS } from '../plugins/review-voice/src/scoring/score.ts';
import { canActivate, compileProposals } from '../plugins/review-voice/src/policy/compile.ts';
import { proposePolicy, approvePolicy, rollbackTo, listPolicies } from '../plugins/review-voice/src/policy/versions.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';

const candidate = (over = {}) => ({
  candidateId: 'cand_001',
  path: 'src/auth.ts',
  line: 84,
  category: 'correctness',
  severity: 'blocking',
  claim: 'The response returns a refresh token before its transaction commits.',
  failureMode: 'A request retry can create multiple valid tokens.',
  evidence: ['Transaction begins at line 65.', 'Response is returned at line 84.', 'Commit happens after the return path.'],
  technicalConfidence: 0.91,
  ...over,
});

const precedent = (over = {}) => ({
  eventId: 'gh_1',
  repository: 'org/a',
  reviewerLogin: 'someone',
  role: 'owner',
  outcome: 'accepted',
  createdAt: '2026-09-01T00:00:00Z',
  filePath: 'src/auth.ts',
  lineStart: 84,
  excerpt: 'Same issue here.',
  weight: 1.2,
  relevance: 5,
  polarity: 'positive',
  ...over,
});

test('a strong candidate with supporting precedent is eligible', () => {
  const result = scoreCandidate(candidate(), [precedent()], []);
  assert.equal(result.eligible, true);
  assert.equal(result.rejectedBecause, null);
});

test('a breakdown carries the location it came from', () => {
  // Without it there is no reliable way to match a score back to the finding
  // it produced: the editor may drop candidates it cannot state in 40 words,
  // so position is not a link either.
  const result = scoreCandidate(candidate(), [precedent()], []);
  assert.equal(result.path, 'src/auth.ts');
  assert.equal(result.line, 84);
});

test('low technical confidence is rejected before anything else matters', () => {
  // Precedent cannot manufacture truth; a weak claim stays weak.
  const result = scoreCandidate(candidate({ technicalConfidence: 0.5 }), [precedent({ weight: 5 })], []);
  assert.equal(result.eligible, false);
  assert.match(result.rejectedBecause, /technical confidence/);
});

test('negative precedent lowers the score', () => {
  const positive = scoreCandidate(candidate(), [precedent({ weight: 1.5 })], []).finalScore;
  const negative = scoreCandidate(candidate(), [precedent({ weight: -1.5, polarity: 'negative' })], []).finalScore;
  assert.ok(negative < positive);
});

test('a duplicate of a kept finding scores zero novelty', () => {
  const first = candidate();
  const duplicate = candidate({ candidateId: 'cand_002' });
  const result = scoreCandidate(duplicate, [precedent()], [first]);
  // Same path and line: two findings about one root cause spend two-fifths of
  // the budget saying one thing.
  assert.equal(result.novelty, 0);
});

test('evidence quality rewards specificity rather than volume', () => {
  const specific = scoreCandidate(candidate(), [], []).evidenceQuality;
  const vague = scoreCandidate(candidate({ evidence: ['bad', 'wrong', 'no'] }), [], []).evidenceQuality;
  assert.ok(specific > vague);
});

test('a candidate with no evidence scores zero on evidence', () => {
  assert.equal(scoreCandidate(candidate({ evidence: [] }), [], []).evidenceQuality, 0);
});

test('thresholds are configurable but default to the specification', () => {
  assert.equal(DEFAULT_THRESHOLDS.technicalConfidence, 0.8);
  assert.equal(DEFAULT_THRESHOLDS.finalScore, 0.78);
});

const evidence = (over = {}) => ({
  keeps: 0,
  dismissals: 3,
  rewrites: 0,
  ownerSignals: 3,
  contradictingSignals: 0,
  mostRecentAt: '2026-09-01T00:00:00Z',
  eventIds: [],
  ...over,
});

test('a rule needs three corroborating signals', () => {
  assert.equal(canActivate(evidence()).ok, true);
  assert.equal(canActivate(evidence({ dismissals: 2, ownerSignals: 2 })).ok, false);
  assert.match(canActivate(evidence({ dismissals: 2, ownerSignals: 2 })).reason, /corroborating/);
});

test('a rule needs at least one owner signal', () => {
  const result = canActivate(evidence({ ownerSignals: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /owner signal/);
});

test('one contradicting owner signal blocks a rule', () => {
  // The owner disagreeing with themselves is a reason to ask, not to guess.
  const result = canActivate(evidence({ contradictingSignals: 1 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /contradicting/);
});

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-policy-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT = [
  '[minor] `src/a.ts:1` - First problem here. It fails. Fix it.',
  '[minor] `src/b.ts:2` - Second problem here. It fails. Fix it.',
].join('\n\n');

test('a proposal is never active on arrival', () => {
  withDb((db) => {
    const stored = proposePolicy(db, []);
    assert.equal(stored.active, false);
    assert.equal(stored.approvedAt, null);
    // Generation and activation are separate operations by construction, not
    // by discipline.
    assert.equal(listPolicies(db)[0].active, false);
  });
});

test('approval refuses rules that have not met the evidence bar', () => {
  withDb((db) => {
    const stored = proposePolicy(db, [
      {
        scope: { type: 'global', key: 'owner' },
        kind: 'suppress',
        rule: 'Suppress something.',
        evidence: evidence({ dismissals: 1, ownerSignals: 1 }),
        confidence: 0.2,
        activatable: false,
        blockedBecause: 'only 1 corroborating signals; 3 are needed',
      },
    ]);
    const result = approvePolicy(db, stored.policyId);
    assert.equal(result.ok, false);
    assert.match(result.error, /evidence bar/);
    assert.equal(listPolicies(db)[0].active, false);
  });
});

test('approval activates and deactivates the previous version', () => {
  withDb((db) => {
    const first = proposePolicy(db, []);
    assert.equal(approvePolicy(db, first.policyId).ok, true);
    const second = proposePolicy(db, []);
    assert.equal(approvePolicy(db, second.policyId).ok, true);

    const policies = listPolicies(db);
    assert.equal(policies.find((p) => p.version === 2).active, true);
    assert.equal(policies.find((p) => p.version === 1).active, false);
  });
});

test('rollback restores a previously approved version', () => {
  withDb((db) => {
    const first = proposePolicy(db, []);
    approvePolicy(db, first.policyId);
    const second = proposePolicy(db, []);
    approvePolicy(db, second.policyId);

    assert.equal(rollbackTo(db, 1).ok, true);
    assert.equal(listPolicies(db).find((p) => p.version === 1).active, true);
  });
});

test('rollback refuses a version that was never approved', () => {
  withDb((db) => {
    proposePolicy(db, []);
    const result = rollbackTo(db, 1);
    // Activating something nobody agreed to is worse than refusing.
    assert.equal(result.ok, false);
    assert.match(result.error, /never approved|No approved/i);
  });
});

const HINTS = [
  { path: 'src/a.ts', line: 1, category: 'maintainability' },
  { path: 'src/b.ts', line: 2, category: 'maintainability' },
];

test('proposals are compiled from explicit feedback only', () => {
  withDb((db) => {
    assert.deepEqual(compileProposals(db), []);

    recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'x', output: OUTPUT, candidates: HINTS });
    recordFeedback(db, { findingRef: 'rv_01', action: 'dismiss', reason: 'intentional', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'dismiss', actor: 'owner' });

    const proposals = compileProposals(db);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].kind, 'suppress');
    assert.equal(proposals[0].category, 'maintainability');
    assert.equal(proposals[0].evidence.dismissals, 2);
    // Two dismissals are not yet three.
    assert.equal(proposals[0].activatable, false);
  });
});

test('rules are grouped by category, not by file path', () => {
  withDb((db) => {
    // Same two files, different categories: two rules, not one about a folder.
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'x',
      output: OUTPUT,
      candidates: [
        { path: 'src/a.ts', line: 1, category: 'maintainability' },
        { path: 'src/b.ts', line: 2, category: 'security' },
      ],
    });
    recordFeedback(db, { findingRef: 'rv_01', action: 'dismiss', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'keep', actor: 'owner' });

    const proposals = compileProposals(db);
    const categories = proposals.map((p) => `${p.kind}:${p.category}`).sort();
    assert.deepEqual(categories, ['prioritise:security', 'suppress:maintainability']);
    // A rule now says something about a kind of finding rather than a folder.
    assert.match(proposals.find((p) => p.kind === 'suppress').rule, /maintainability/);
  });
});

test('going both ways on one category registers as contradiction', () => {
  withDb((db) => {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'x',
      output: OUTPUT,
      candidates: HINTS,
    });
    recordFeedback(db, { findingRef: 'rv_01', action: 'dismiss', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'keep', actor: 'owner' });

    const suppress = compileProposals(db).find((p) => p.kind === 'suppress');
    // The owner disagreeing with themselves on a category is a reason to ask,
    // not to guess.
    assert.equal(suppress.evidence.contradictingSignals, 1);
    assert.equal(suppress.activatable, false);
  });
});

test('feedback with no recorded category counts for precision but forms no rule', () => {
  withDb((db) => {
    recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'x', output: OUTPUT });
    recordFeedback(db, { findingRef: 'rv_01', action: 'dismiss', actor: 'owner' });
    // Nothing to group on. Inventing a category from the wording would be
    // manufacturing evidence.
    assert.deepEqual(compileProposals(db), []);
  });
});

// The corpus already said it
//
// Novelty used to be measured only against the other candidates in the current
// review, so a comment published on the same line scored full novelty and its
// positive polarity raised alignment on top of that.

const echo = (over = {}) =>
  precedent({
    eventId: 'ghr_5232333607',
    excerpt:
      'This returns the refresh token before the transaction commits, so a retry mints multiple valid tokens.',
    ...over,
  });

test('a candidate repeating a precedent on the same line is rejected', () => {
  const result = scoreCandidate(candidate(), [echo()], []);
  assert.equal(result.eligible, false);
  assert.equal(result.duplicateOfPrecedent, 'ghr_5232333607');
  assert.match(result.rejectedBecause, /already stated at src\/auth\.ts:84/);
  assert.equal(result.novelty, 0);
});

test('a comment anchored a line or two off still counts as the same point', () => {
  // Anchors drift as a file is edited.
  const result = scoreCandidate(candidate(), [echo({ lineStart: 86 })], []);
  assert.equal(result.eligible, false);
  assert.equal(result.duplicateOfPrecedent, 'ghr_5232333607');
});

test('a repeat does not also argue for itself through alignment', () => {
  const alone = scoreCandidate(candidate(), [], []);
  const repeated = scoreCandidate(candidate(), [echo()], []);
  assert.equal(repeated.ownerAlignment, alone.ownerAlignment);
});

test('a precedent on the same line about something else is not a repeat', () => {
  const unrelated = echo({ excerpt: 'Please rename this variable, the abbreviation is unclear.' });
  const result = scoreCandidate(candidate(), [unrelated], []);
  assert.equal(result.duplicateOfPrecedent, null);
  assert.equal(result.eligible, true);
});

test('the same point elsewhere in the file caps novelty without rejecting', () => {
  const result = scoreCandidate(candidate(), [echo({ lineStart: 400 })], []);
  assert.equal(result.duplicateOfPrecedent, null);
  assert.equal(result.novelty, 0.5);
});

test('an unanchored precedent can never be a repeat', () => {
  // A review summary matches any candidate, so it must not silence one.
  const result = scoreCandidate(candidate(), [echo({ filePath: null, lineStart: null })], []);
  assert.equal(result.duplicateOfPrecedent, null);
  assert.equal(result.eligible, true);
});

// Whose confidence the gate actually reads
//
// Both rejections in a real run read "technical confidence 0.75 is below 0.8",
// a number the analyst wrote about its own output, on candidates the verifier
// had just rated high.

test("the verifier's conclusion supersedes the analyst's self-report", () => {
  // 0.75 from the analyst was rejected outright in a real run, on a candidate
  // the verifier had just rated high.
  const result = scoreCandidate(candidate({ technicalConfidence: 0.75 }), [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    evidenceQuality: 'high',
  });
  assert.equal(result.analystConfidence, 0.75);
  assert.equal(result.verifiedConfidence, 0.9);
  assert.equal(result.technicalConfidence, 0.9);
  assert.equal(result.confidenceSource, 'verifier');
  assert.equal(result.eligible, true);
});

test('the verifier can lower confidence as well as raise it', () => {
  const result = scoreCandidate(candidate({ technicalConfidence: 0.95 }), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    evidenceQuality: 'low',
  });
  assert.equal(result.technicalConfidence, 0.5);
  assert.equal(result.eligible, false);
});

test('an explicit verifier confidence beats its own quality tier', () => {
  const result = scoreCandidate(candidate(), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    evidenceQuality: 'low',
    technicalConfidence: 0.88,
  });
  assert.equal(result.technicalConfidence, 0.88);
});

test('without a verification the analyst is still what there is', () => {
  const result = scoreCandidate(candidate({ technicalConfidence: 0.91 }), [], []);
  assert.equal(result.confidenceSource, 'analyst');
  assert.equal(result.verifiedConfidence, null);
  assert.equal(result.technicalConfidence, 0.91);
});

// A claim nobody could check

test('a candidate whose own evidence admits it is unverifiable cannot ship', () => {
  // Observed verbatim, filed at 0.8, in two consecutive runs.
  const result = scoreCandidate(
    candidate({
      technicalConfidence: 0.8,
      evidence: [
        'lt() is called at line 40 with a key that is not defined locally.',
        "No local key catalogue exists in the repo, so the keys' existence cannot be verified here.",
      ],
    }),
    [],
    [],
  );
  assert.equal(result.technicalConfidence, 0.6);
  assert.equal(result.confidenceSource, 'unverifiable-cap');
  assert.equal(result.eligible, false);
  assert.match(result.rejectedBecause, /could not be verified/);
});

test('the cap holds even when the verifier says high', () => {
  // The verifier passed this same claim twice. A dependency on a repository
  // nobody in the pipeline can read is not resolved by asserting harder.
  const result = scoreCandidate(
    candidate({ evidence: ['This cannot be confirmed without access to the sibling repository.'] }),
    [],
    [],
    DEFAULT_THRESHOLDS,
    { candidateId: 'cand_001', evidenceQuality: 'high' },
  );
  assert.equal(result.technicalConfidence, 0.6);
  assert.equal(result.eligible, false);
});

test('context the verifier could not obtain caps confidence too', () => {
  const result = scoreCandidate(candidate(), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    evidenceQuality: 'high',
    requiredContextMissing: ['the localization key catalogue, which lives in another repository'],
  });
  assert.equal(result.confidenceSource, 'unverifiable-cap');
  assert.equal(result.eligible, false);
});

// Evidence quality has to be able to fail

test('evidence with no anchor scores low, where length alone once scored full', () => {
  const vague = candidate({
    evidence: [
      'the change appears to alter behaviour in ways that may not be intended by the author here',
      'this pattern is generally discouraged in production code and should probably be avoided',
      'there are potential issues with how the logic has been restructured in this particular case',
    ],
  });
  const result = scoreCandidate(vague, [], []);
  // Three bullets, none anchored: full breadth, zero depth.
  assert.equal(Math.round(result.evidenceQuality * 1000) / 1000, 0.4);
});

test('anchored evidence scores on how much of it is anchored', () => {
  // Two of the three bullets name a line; the third names nothing. Under the
  // old length test all three counted and every candidate scored 1.000.
  const result = scoreCandidate(candidate(), [], []);
  assert.equal(Math.round(result.evidenceQuality * 1000) / 1000, 0.8);

  const allAnchored = candidate({
    evidence: ['Transaction begins at line 65.', 'Response is returned at line 84.', 'Commit runs at line 91.'],
  });
  assert.equal(scoreCandidate(allAnchored, [], []).evidenceQuality, 1);
});
