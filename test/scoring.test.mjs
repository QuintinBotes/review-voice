import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scoreCandidate,
  DEFAULT_THRESHOLDS,
  normaliseCandidate,
  MalformedCandidate,
} from '../plugins/review-voice/src/scoring/score.ts';
import { computeReach, symbolsFromHunks } from '../plugins/review-voice/src/scoring/reach.ts';
import { gitGrepPaths } from '../plugins/review-voice/src/scoring/existence.ts';
import { deriveSeverity } from '../plugins/review-voice/src/scoring/severity.ts';
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

const reachCheck = (reach, over = {}) => ({
  reach,
  symbols: ['SharedThing'],
  paths: ['src/auth.ts'],
  directoryCount: 1,
  inconclusive: false,
  searchedRef: 'base',
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

test('thresholds are configurable, and the final-score gate has moved off the specification', () => {
  assert.equal(DEFAULT_THRESHOLDS.technicalConfidence, 0.8);

  // The specification says 0.78. That was calibrated when evidenceQuality
  // returned 1.000 for every candidate and handed each one a free 0.15.
  //
  // 0.68 is measured, not derived. Across five runs every candidate the
  // verifier judged false was already rejected on confidence, and the true
  // and false classes separated between 0.6313 and 0.6884 with nothing in
  // between. This is a deliberate deviation from the spec constant, recorded
  // here so it cannot be reverted by accident.
  assert.equal(DEFAULT_THRESHOLDS.finalScore, 0.68);
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

// The cap is a prior, not a ceiling (NEW-03)

test('an explicit verifier confidence overturns the analyst self-doubt cap', () => {
  // The verifier established the claim directly and said in as many words
  // that the caveat bore on severity rather than confidence. A regex reading
  // the analyst's prose overruled it.
  const admitting = candidate({
    evidence: ['lt() is called at line 40.', 'The catalogue cannot be verified from this repository.'],
  });

  const unengaged = scoreCandidate(admitting, [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    evidenceQuality: 'high',
  });
  assert.equal(unengaged.confidenceSource, 'unverifiable-cap');

  const engaged = scoreCandidate(admitting, [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.93,
  });
  assert.equal(engaged.confidenceSource, 'verifier');
  assert.equal(engaged.technicalConfidence, 0.93);
});

test('context the verifier could not reach still caps absolutely', () => {
  // That is the verifier reporting on its own reach, not a guess about the
  // analyst's, so an explicit number does not lift it.
  const result = scoreCandidate(candidate(), [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.95,
    requiredContextMissing: ['a sibling repository'],
  });
  assert.equal(result.confidenceSource, 'unverifiable-cap');
  assert.equal(result.eligible, false);
});

// Novelty across files (NEW-04)

test('a second defect in another file is not a restatement of the first', () => {
  // A double-submit race and an unhandled failure in neighbouring hooks share
  // a vocabulary because the subsystem has one. The second was being dropped
  // for sounding like the first.
  const first = candidate({
    path: 'src/hooks/useEditForm.ts',
    line: 20,
    claim: 'A failed mutation without a status is treated as success.',
    failureMode: 'The panel closes and the edit is silently lost.',
  });
  const second = candidate({
    candidateId: 'cand_002',
    path: 'src/hooks/useApply.ts',
    line: 44,
    claim: 'Apply re-enables before the refetch completes, so a mutation can be submitted twice.',
    failureMode: 'A second click issues a duplicate request and two success toasts.',
  });

  const result = scoreCandidate(second, [], [first]);
  assert.equal(result.novelty, 1);
});

test('a near-identical claim in another file is still a restatement', () => {
  const first = candidate({ path: 'src/a.ts', line: 10 });
  const second = candidate({ candidateId: 'cand_002', path: 'src/b.ts', line: 10 });
  const result = scoreCandidate(second, [], [first]);
  assert.ok(result.novelty < 0.3, `expected a heavy penalty, got ${result.novelty}`);
});

test('two findings in the same file still deduplicate', () => {
  const first = candidate({ path: 'src/a.ts', line: 10 });
  const second = candidate({ candidateId: 'cand_002', path: 'src/a.ts', line: 80 });
  const result = scoreCandidate(second, [], [first]);
  assert.ok(result.novelty < 0.3, `expected a heavy penalty, got ${result.novelty}`);
});

test('a rejection message carries enough precision to be true', () => {
  // "score 0.78 is below 0.78" on a finalScore of 0.7788996174443317.
  const weak = candidate({ evidence: ['vague'], technicalConfidence: 0.8 });
  const result = scoreCandidate(weak, [], []);
  assert.equal(result.eligible, false);
  assert.doesNotMatch(result.rejectedBecause, /score 0\.68 is below the 0\.68/);
  assert.match(result.rejectedBecause, /score 0\.\d{4} is below the 0\.68 threshold/);
});

// Severity is derived from category and CLI-computed reach, not requested

test('the same category always produces the same tier, whatever was asked for', () => {
  // On two runs of a byte-identical diff the same finding was minor at 0.90
  // and important at 0.85. Ordering is severity-first, so the finding moved up
  // and down the page between identical reviews.
  const a = scoreCandidate(candidate({ category: 'correctness', severity: 'minor' }), [], []);
  const b = scoreCandidate(candidate({ category: 'correctness', severity: 'important' }), [], []);
  assert.equal(a.severity.severity, b.severity.severity);
  assert.equal(a.severity.severity, 'minor');
});

test('reach reports its symbols, hit paths, directory count, and searched ref', () => {
  const seen = [];
  const check = computeReach(
    'The `SharedThing` implementation is used by every consumer.',
    'src/auth.ts',
    '/repo',
    'base-ref',
    (symbol, cwd, ref) => {
      seen.push([symbol, cwd, ref]);
      return ['src/auth.ts', 'packages/client.ts', 'tools/check.ts'];
    },
  );

  assert.equal(check.reach, 'repository');
  assert.deepEqual(check.symbols, ['SharedThing']);
  assert.deepEqual(check.paths, ['packages/client.ts', 'src/auth.ts', 'tools/check.ts']);
  assert.equal(check.directoryCount, 3);
  assert.equal(check.searchedRef, 'base-ref');
  assert.deepEqual(seen, [['SharedThing', '/repo', 'base-ref']]);
});

test('reach distinguishes local, component, and repository-wide toolchain changes', () => {
  const local = computeReach('`SharedThing` is wrong.', 'src/auth.ts', '/repo', 'base', () => ['src/auth.ts']);
  const component = computeReach(
    '`SharedThing` is wrong.',
    'src/auth.ts',
    '/repo',
    'base',
    () => ['src/auth.ts', 'src/consumer.ts'],
  );
  const toolchain = computeReach('`SharedThing` is wrong.', 'eslint.config.js', '/repo', 'base', () => []);

  assert.equal(local.reach, 'local');
  assert.equal(component.reach, 'component');
  assert.equal(toolchain.reach, 'repository');
});

test('prose that names a symbol is not evidence that it spreads', () => {
  // Measured on this repository: `deriveSeverity` hit docs, plugins and test,
  // and a changelog entry alone pushed it to repository-wide. Reach is a claim
  // about code coupling, so prose is not counted.
  const check = computeReach(
    '`SharedThing` is wrong.',
    'src/auth.ts',
    '/repo',
    'base',
    () => ['src/auth.ts', 'docs/architecture.md', 'CHANGELOG.md'],
  );

  assert.equal(check.reach, 'local');
  assert.deepEqual(check.countedPaths, ['src/auth.ts']);
  assert.equal(check.outsideDirectoryCount, 0);
});

test('a symbol named only in prose has absent reach, never local', () => {
  const check = computeReach('`SharedThing` is wrong.', 'src/auth.ts', '/repo', 'base', () => [
    'docs/architecture.md',
  ]);

  assert.equal(check.reach, null);
  assert.deepEqual(check.countedPaths, []);
});

test('reach is measured relative to the changed file, not by tree depth', () => {
  // The monorepo case this reviewer is actually pointed at. Counting distinct
  // top-level directories is inert here: every source file shares `packages`,
  // so genuinely shared code read as narrow.
  const shared = computeReach('`SharedThing` is wrong.', 'packages/core/src/thing.ts', '/repo', 'base', () => [
    'packages/core/src/thing.ts',
    'packages/web/src/page.ts',
    'packages/api/src/route.ts',
  ]);
  const withinOwnSubtree = computeReach(
    '`SharedThing` is wrong.',
    'packages/core/src/thing.ts',
    '/repo',
    'base',
    () => ['packages/core/src/thing.ts', 'packages/core/src/nested/helper.ts'],
  );

  assert.equal(shared.reach, 'repository');
  assert.equal(shared.outsideDirectoryCount, 2);
  assert.equal(withinOwnSubtree.reach, 'component');
  assert.equal(withinOwnSubtree.outsideDirectoryCount, 0);
});

test('one neighbouring directory is a component relationship, not the repository', () => {
  const check = computeReach('`SharedThing` is wrong.', 'packages/core/src/thing.ts', '/repo', 'base', () => [
    'packages/core/src/thing.ts',
    'packages/web/src/page.ts',
  ]);

  assert.equal(check.reach, 'component');
  assert.equal(check.outsideDirectoryCount, 1);
});

test('reach is absent when a claim names no searchable symbol', () => {
  const check = computeReach('The handler returns before commit.', 'src/auth.ts', '/repo', 'base', () => {
    throw new Error('a vague claim must not be searched');
  });

  assert.equal(check.reach, null);
  assert.deepEqual(check.symbols, []);
  assert.deepEqual(check.paths, []);
  assert.equal(check.directoryCount, 0);
  assert.equal(check.inconclusive, false);
});

test('a failed reach search is absent, never silently local', () => {
  const check = computeReach(
    '`LocalThing` and `TimedOutThing` are inconsistent.',
    'src/auth.ts',
    '/repo',
    'base',
    (symbol) => {
      if (symbol === 'LocalThing') return ['src/auth.ts'];
      throw new Error('git grep timed out');
    },
  );

  assert.equal(check.reach, null);
  assert.equal(check.inconclusive, true);
  assert.deepEqual(check.paths, ['src/auth.ts']);
  assert.equal(check.directoryCount, 1);
});

test('a bad git ref yields absent reach rather than local reach', () => {
  const check = computeReach(
    '`ReachFailureProbe` is inconsistent.',
    'plugins/review-voice/src/scoring/reach.ts',
    process.cwd(),
    'refs/does-not-exist-for-reach-test',
  );

  assert.equal(check.reach, null);
  assert.equal(check.inconclusive, true);
});

test('reach is calculated against the supplied ref, which can change its result', () => {
  const seen = [];
  const search = (symbol, cwd, ref) => {
    seen.push(ref);
    return ref === 'base' ? ['src/auth.ts'] : ['src/auth.ts', 'packages/client.ts', 'tools/check.ts'];
  };

  const base = computeReach('`SharedThing` is wrong.', 'src/auth.ts', '/repo', 'base', search);
  const head = computeReach('`SharedThing` is wrong.', 'src/auth.ts', '/repo', 'head', search);

  assert.equal(base.reach, 'local');
  assert.equal(head.reach, 'repository');
  assert.deepEqual(seen, ['base', 'head']);
});

test('absent reach reproduces the legacy tier for every schema category', () => {
  const categories = JSON.parse(
    readFileSync(new URL('../plugins/review-voice/schemas/finding-category.schema.json', import.meta.url), 'utf8'),
  ).enum;
  const legacy = {
    security: 'blocking',
    trust_boundary: 'blocking',
    authorization: 'blocking',
    authentication: 'blocking',
    data_integrity: 'blocking',
    concurrency: 'important',
    persistence: 'important',
    migration: 'important',
    api_contract: 'important',
    release: 'important',
    correctness: 'minor',
    error_handling: 'minor',
    reliability: 'minor',
    user_visible_behavior: 'minor',
    ci: 'minor',
    packaging: 'minor',
    dependency: 'minor',
    performance: 'minor',
    observability: 'nit',
    test_coverage: 'nit',
    maintainability: 'nit',
    style: 'nit',
  };

  for (const category of categories) {
    assert.equal(deriveSeverity(category, 'minor').severity, legacy[category], category);
  }
});

test('severity combines category with computed reach', () => {
  assert.equal(deriveSeverity('ci', 'minor', reachCheck('repository')).severity, 'blocking');
  assert.equal(deriveSeverity('ci', 'minor', reachCheck('local')).severity, 'nit');
  assert.equal(deriveSeverity('correctness', 'minor', reachCheck('repository')).severity, 'important');

  for (const value of ['local', 'component', 'repository']) {
    assert.equal(deriveSeverity('security', 'minor', reachCheck(value)).severity, 'blocking');
    assert.equal(deriveSeverity('style', 'minor', reachCheck(value)).severity, 'nit');
  }
});

test('a local question remains a question while a wide question earns its reach', () => {
  assert.equal(deriveSeverity('correctness', 'question', reachCheck('local')).severity, 'question');
  assert.equal(deriveSeverity('correctness', 'question', reachCheck('repository')).severity, 'important');
  assert.equal(deriveSeverity('correctness', 'question').severity, 'question');
});

test('score carries CLI reach evidence into the derived severity', () => {
  const computed = reachCheck('repository', {
    symbols: ['BuildScript'],
    paths: ['.github/workflows/ci.yml', 'scripts/build.ts', 'src/check.ts'],
    directoryCount: 3,
  });
  const result = scoreCandidate(candidate({ category: 'ci' }), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    reach: computed,
  });

  assert.equal(result.severity.severity, 'blocking');
  assert.deepEqual(result.severity.reach, computed);
});

test('reach and severity derivation never read technical confidence', () => {
  for (const path of [
    '../plugins/review-voice/src/scoring/reach.ts',
    '../plugins/review-voice/src/scoring/severity.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /technicalConfidence|technical_confidence/);
  }
});

test('what the analyst asked for is recorded, not obeyed', () => {
  const result = scoreCandidate(candidate({ category: 'style', severity: 'blocking' }), [], []);
  assert.equal(result.severity.severity, 'nit');
  assert.equal(result.severity.requested, 'blocking');
});



test('confidence does not move the tier, at any point in the shipping range', () => {
  // The whole remaining instability was here. Category was identical on both
  // runs and the tier differed anyway, at 0.82 against 0.90 and 0.85 against
  // 0.80: everything that ships sits in [0.8, 1.0] and run to run variance is
  // around 0.08, so any boundary inside that band gets crossed.
  const tiers = new Set();
  for (const confidence of [0.8, 0.82, 0.85, 0.9, 0.95, 1]) {
    const result = scoreCandidate(
      candidate({ category: 'user_visible_behavior' }),
      [],
      [],
      DEFAULT_THRESHOLDS,
      { candidateId: 'cand_001', technicalConfidence: confidence },
    );
    tiers.add(result.severity.severity);
  }
  assert.equal(tiers.size, 1, `tier moved with confidence: ${[...tiers].join(', ')}`);
});

test('a missing category is not silently promoted to correctness', () => {
  // It was defaulted before it reached the derivation, which gave an
  // unlabelled finding a real tier and recorded nothing about the swap.
  const result = scoreCandidate(candidate({ category: undefined }), [], []);
  assert.equal(result.severity.severity, 'minor');
  assert.match(result.severity.reason, /no category was supplied/);
});

test('a severe category is severe whatever the wording asked for', () => {
  const result = scoreCandidate(candidate({ category: 'authorization', severity: 'nit' }), [], []);
  assert.equal(result.severity.severity, 'blocking');
});

test('a question stays a question, because it is a kind and not a tier', () => {
  const result = scoreCandidate(candidate({ category: 'correctness', severity: 'question' }), [], []);
  assert.equal(result.severity.severity, 'question');
});

test('an unmapped category takes the middle tier rather than a guess', () => {
  const result = scoreCandidate(candidate({ category: 'something_new', severity: 'blocking' }), [], []);
  assert.equal(result.severity.severity, 'minor');
  assert.match(result.severity.reason, /no mapping/);
});

test('a foreign shape is named as such, not reported as a missing path', () => {
  // One analyst run returned title, location and suggested_direction. The
  // whole pull request produced nothing, and the error said "missing path",
  // which describes a field rather than the problem.
  assert.throws(
    () => normaliseCandidate({ title: 'A thing', location: 'src/a.ts line 4', suggested_direction: 'change it' }, 0),
    (error) => {
      assert.ok(error instanceof MalformedCandidate);
      assert.match(error.message, /has title, location, suggested_direction but no path/);
      assert.match(error.message, /not the candidate schema/);
      return true;
    },
  );
});

test('an ordinary missing path is still an ordinary missing path', () => {
  assert.throws(
    () => normaliseCandidate({ candidate_id: 'cand_001', line: 4 }, 0),
    /cand_001: missing path$/,
  );
});

// Category resolution remains the consequence half of severity derivation

test('plausible synonyms outside the enum resolve to the category they mean', () => {
  // Half the findings on one pull request used `testing` and `documentation`.
  // The fallback behaved as designed and the findings still lost the
  // distinction they were making: a test-coverage nit landed on minor.
  const testing = scoreCandidate(candidate({ category: 'testing' }), [], []);
  assert.equal(testing.severity.severity, 'nit');
  assert.match(testing.severity.reason, /testing read as test_coverage/);

  const docs = scoreCandidate(candidate({ category: 'documentation' }), [], []);
  assert.equal(docs.severity.severity, 'nit');
  assert.match(docs.severity.reason, /documentation read as maintainability/);
});

test('casing and spacing do not decide a tier', () => {
  const spaced = scoreCandidate(candidate({ category: 'User Visible Behavior' }), [], []);
  assert.equal(spaced.severity.severity, 'minor');
  assert.equal(spaced.severity.reason, 'user_visible_behavior carries minor');
});

test('an ambiguous word is left to the fallback rather than guessed into blocking', () => {
  // Aliasing into a blocking tier is the riskiest kind, so a word that could
  // mean two different severe categories gets the middle tier instead.
  const result = scoreCandidate(candidate({ category: 'privacy' }), [], []);
  assert.equal(result.severity.severity, 'minor');
  assert.match(result.severity.reason, /no mapping/);
});

test('a real category is never rerouted by an alias', () => {
  for (const category of ['test_coverage', 'maintainability', 'correctness', 'security']) {
    const result = scoreCandidate(candidate({ category }), [], []);
    assert.equal(result.severity.reason, `${category} carries ${result.severity.severity}`);
  }
});

// The confidence floor, by who established the number

test('an analyst self-report is gated at its own floor, not the verifier gate', () => {
  // Measured against ground truth: over eleven candidates the self-report did
  // not separate true from false anywhere above 0.7. Held at 0.8 it discarded a
  // real behavioural defect, a test that does not test what it claims, and the
  // finding that drove an actual changes-requested review, while shipping the
  // only false one.
  const verified = scoreCandidate(candidate({ technicalConfidence: 0.7 }), [precedent()], []);
  assert.equal(verified.confidenceSource, 'analyst');
  assert.equal(verified.eligible, true);
});

test('a verifier confidence is still held to the higher bar', () => {
  const result = scoreCandidate(candidate(), [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.7,
  });
  assert.equal(result.confidenceSource, 'verifier');
  assert.equal(result.eligible, false);
  assert.match(result.rejectedBecause, /0\.70 \(verifier\) is below 0\.8/);
});

test('below its own floor the analyst self-report still gates', () => {
  // The signal does carry down there: candidates at 0.50 and 0.65 were weak or
  // wrong. It is only noise in the band above 0.7.
  const result = scoreCandidate(candidate({ technicalConfidence: 0.65 }), [precedent()], []);
  assert.equal(result.eligible, false);
  assert.match(result.rejectedBecause, /analyst's opinion of its own output/);
});

test('a claim that says it could not be verified is rejected on its own terms', () => {
  // Not by sitting under a numeric floor, which tied it to a number that has
  // since moved twice.
  const result = scoreCandidate(
    candidate({ evidence: ['This cannot be verified from here.'] }),
    [precedent()],
    [],
  );
  assert.equal(result.eligible, false);
  assert.match(result.rejectedBecause, /cannot ship whatever it scores/);
});

test('the default floors are the measured ones', () => {
  assert.equal(DEFAULT_THRESHOLDS.technicalConfidence, 0.8);
  assert.equal(DEFAULT_THRESHOLDS.analystOnlyConfidence, 0.7);
});

// These run against real git with a real ref on purpose. The synthetic
// searchers above return bare paths, which is exactly why a ref-prefix bug
// survived a green suite: `git grep -l <ref>` prefixes every line with
// `<ref>:`, and production always passes --base.
//
// They build their own repository rather than grepping this one. An earlier
// version probed this repository at HEAD and passed locally while failing in
// CI, where HEAD is the merge commit and therefore contains the very code the
// probes were written against. A test whose expected value depends on what the
// repository happens to contain today is measuring the wrong thing.

function gitRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'rv-reach-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

test('git grep paths come back without the ref prefix', () => {
  const root = gitRepository({ 'src/a.ts': 'export const widgetTotal = 1;\n' });
  try {
    const hits = gitGrepPaths('widgetTotal', root, 'HEAD');
    assert.deepEqual(hits, ['src/a.ts'], 'git grep -l <ref> prefixes paths with the ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local reach is reachable when a ref is passed, not only without one', () => {
  // The signature of the prefix bug was outsideDirectoryCount === directoryCount
  // on every observation, because no hit was ever recognised as the changed
  // file or as inside its subtree.
  const root = gitRepository({
    'src/only/here.ts': 'export const widgetTotal = 1;\n',
    'src/other/thing.ts': 'export const unrelated = 2;\n',
  });
  try {
    const check = computeReach('`widgetTotal` is off by one.', 'src/only/here.ts', root, 'HEAD');

    assert.equal(check.reach, 'local');
    assert.equal(check.outsideDirectoryCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a name common enough to describe the language does not decide reach', () => {
  // A correctness defect in one date formatter was raised a tier because the
  // claim mentioned Math.round, which appeared in 58 directories of the
  // repository under review. Popularity of a word is not spread of a change.
  const files = { 'src/home/format.ts': 'export const x = Math.round(1.5);\n' };
  for (let i = 0; i < 20; i += 1) files[`src/d${i}/use.ts`] = 'const y = Math.round(2.5);\n';
  const root = gitRepository(files);
  try {
    const check = computeReach('`Math.round` is asymmetric.', 'src/home/format.ts', root, 'HEAD');

    assert.ok(check.ignoredSymbols.includes('Math.round'));
    assert.equal(check.reach, null, 'with its only symbol ignored there is no evidence of spread');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symbol the changed file does not contain is not part of its reach', () => {
  const root = gitRepository({
    'src/home/format.ts': 'export const widgetTotal = 1;\n',
    'src/other/client.ts': 'export class RemoteApiClient {}\n',
  });
  try {
    const check = computeReach(
      '`RemoteApiClient` is misused near `widgetTotal`.',
      'src/home/format.ts',
      root,
      'HEAD',
    );

    assert.ok(
      check.ignoredSymbols.includes('RemoteApiClient'),
      "a symbol absent from the changed file cannot describe that file's reach",
    );
    assert.equal(check.reach, 'local');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unanchored precedent is a constant, and the shadow score says so', () => {
  // matchStrength is normalised to the best hit in each candidate's own result
  // set, so when the same unanchored summaries come back for every candidate,
  // every candidate gets the same alignment. On a live run all eight findings
  // drew the same three precedents and the gate rejected nothing.
  const unanchored = (id) => ({
    eventId: id,
    repository: 'org/a',
    reviewerLogin: 'owner',
    role: 'owner',
    outcome: 'accepted',
    createdAt: '2026-01-01T00:00:00Z',
    filePath: null,
    lineStart: null,
    excerpt: 'a general remark about quality',
    weight: 1,
    relevance: 1,
    matchStrength: 1,
  });

  const candidate = {
    candidate_id: 'cand_001',
    path: 'src/a.ts',
    line: 4,
    category: 'correctness',
    severity: 'minor',
    claim: 'The retry writes twice.',
    failure_mode: 'A duplicate charge.',
    evidence: ['`chargeOnce` at line 4'],
    technical_confidence: 0.9,
  };

  const breakdown = scoreCandidate(
    normaliseCandidate(candidate, 0),
    [unanchored('e1'), unanchored('e2'), unanchored('e3')],
    [],
    DEFAULT_THRESHOLDS,
    { candidateId: 'cand_001', technicalConfidence: 0.9 },
  );

  // Live behaviour is unchanged: the gate still uses the current computation.
  assert.ok(breakdown.ownerAlignment > 0.9, 'three positive unanchored precedents saturate alignment');
  // The shadow reports the neutral, and the gap is the thing to measure.
  assert.equal(breakdown.anchored.ownerAlignment, 0.5);
  assert.ok(
    breakdown.finalScore - breakdown.anchored.finalScore > 0.05,
    'the shift is large enough that switching without measuring would delete findings',
  );
});

test('an anchored precedent counts in both the live and the shadow score', () => {
  const anchored = {
    eventId: 'e1',
    repository: 'org/a',
    reviewerLogin: 'owner',
    role: 'owner',
    outcome: 'accepted',
    createdAt: '2026-01-01T00:00:00Z',
    filePath: 'src/other.ts',
    lineStart: 99,
    excerpt: 'this retry path needs a guard',
    weight: 1,
    relevance: 1,
    matchStrength: 1,
  };

  const breakdown = scoreCandidate(
    normaliseCandidate(
      {
        candidate_id: 'cand_001',
        path: 'src/a.ts',
        line: 4,
        category: 'correctness',
        severity: 'minor',
        claim: 'The retry writes twice.',
        failure_mode: 'A duplicate charge.',
        evidence: ['`chargeOnce` at line 4'],
        technical_confidence: 0.9,
      },
      0,
    ),
    [anchored],
    [],
    DEFAULT_THRESHOLDS,
    { candidateId: 'cand_001', technicalConfidence: 0.9 },
  );

  assert.equal(breakdown.anchored.ownerAlignment, breakdown.ownerAlignment);
  assert.equal(breakdown.anchored.finalScore, breakdown.finalScore);
  assert.equal(breakdown.anchored.wouldChangeEligibility, false);
});

test('reach is measured from what the diff touched, not what the claim mentioned', () => {
  // The case containment could not catch: a finding whose whole point is that
  // some symbol is the WRONG referent names that symbol, and it is genuinely in
  // the changed file, so "does the file contain it" cannot tell them apart.
  const diff = [
    'diff --git a/src/home/format.ts b/src/home/format.ts',
    '--- a/src/home/format.ts',
    '+++ b/src/home/format.ts',
    '@@ -1,3 +1,3 @@',
    ' const whenOffsetMinutes = 0;',
    '-export const shown = roundedTotal(1);',
    '+export const shown = roundedTotal(2);',
  ].join('\n');

  const search = (symbol) =>
    symbol === 'whenOffsetMinutes'
      ? ['src/home/format.ts', 'src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts']
      : ['src/home/format.ts'];

  const fromDiff = computeReach(
    'The wrong referent `whenOffsetMinutes` is used near `roundedTotal`.',
    'src/home/format.ts',
    '/repo',
    'base',
    search,
    diff,
  );
  const fromClaim = computeReach(
    'The wrong referent `whenOffsetMinutes` is used near `roundedTotal`.',
    'src/home/format.ts',
    '/repo',
    'base',
    search,
  );

  assert.equal(fromDiff.symbolSource, 'hunks');
  assert.deepEqual(fromDiff.symbols, ['roundedTotal']);
  assert.equal(fromDiff.reach, 'local');

  // Without the diff the wrong referent still decides the tier.
  assert.equal(fromClaim.symbolSource, 'claim');
  assert.ok(fromClaim.symbols.includes('whenOffsetMinutes'));
  assert.equal(fromClaim.reach, 'repository');
});

test('a context line is what the change is near, not what it changed', () => {
  const diff = [
    'diff --git a/src/home/format.ts b/src/home/format.ts',
    '--- a/src/home/format.ts',
    '+++ b/src/home/format.ts',
    '@@ -1,2 +1,2 @@',
    ' import { sharedHelper } from "../shared";',
    '+const localThing = 1;',
  ].join('\n');

  assert.deepEqual(symbolsFromHunks(diff, 'src/home/format.ts'), ['localThing']);
});

test("hunks from another file in the same diff are not this finding's reach", () => {
  const diff = [
    'diff --git a/src/other/thing.ts b/src/other/thing.ts',
    '--- a/src/other/thing.ts',
    '+++ b/src/other/thing.ts',
    '@@ -1 +1 @@',
    '+const unrelatedSymbol = 1;',
    'diff --git a/src/home/format.ts b/src/home/format.ts',
    '--- a/src/home/format.ts',
    '+++ b/src/home/format.ts',
    '@@ -1 +1 @@',
    '+const ourChangedSymbol = 2;',
  ].join('\n');

  assert.deepEqual(symbolsFromHunks(diff, 'src/home/format.ts'), ['ourChangedSymbol']);
});

test('a symbol the change introduces falls back to the module it lives in', () => {
  // Reach is measured at the base ref, where a new symbol does not exist, so it
  // had no spread by construction and fell back to the category tier. Most
  // findings are about new code, so the feature was inert for most of them.
  const diff = [
    'diff --git a/src/home/formatter.ts b/src/home/formatter.ts',
    '--- a/src/home/formatter.ts',
    '+++ b/src/home/formatter.ts',
    '@@ -1 +1,2 @@',
    '+export const brandNewSymbol = 1;',
  ].join('\n');

  const search = (symbol) =>
    symbol === 'brandNewSymbol'
      ? [] // does not exist at base
      : ['src/home/formatter.ts', 'src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts'];

  const check = computeReach(
    '`brandNewSymbol` is wrong.',
    'src/home/formatter.ts',
    '/repo',
    'base',
    search,
    diff,
  );

  assert.equal(check.moduleFallback, true);
  assert.ok(check.symbols.includes('formatter'));
  assert.equal(check.reach, 'repository');
});
