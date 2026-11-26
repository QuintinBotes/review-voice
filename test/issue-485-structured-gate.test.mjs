/**
 * #485: the verdict and the gate that held a candidate are stored as data
 * (`verified`, `premisesVerified`, `gate`) next to the `rejectedBecause`
 * prose, and every consumer reads them instead of parsing the sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THRESHOLDS,
  HOLD_GATES,
  applyQuestionCap,
  normaliseCandidate,
  scoreCandidate,
} from '../plugins/review-voice/src/scoring/score.ts';
import { gateOf } from '../plugins/review-voice/src/cli/score.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { normaliseHeld, recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { compileProposals } from '../plugins/review-voice/src/policy/compile.ts';
import { approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
delete process.env.REVIEW_VOICE_CONFIG;

const seen = new Set();
/** Asserts the recorded gate and remembers it for the coverage test at the end. */
function expectGate(breakdown, gate) {
  assert.equal(breakdown.gate, gate, `${breakdown.rejectedBecause}`);
  if (gate !== null) seen.add(gate);
}

const candidate = (over = {}) => ({
  candidateId: 'cand_001',
  path: 'src/queue.ts',
  line: 12,
  category: 'correctness',
  severity: 'minor',
  claim: 'The drain loop reads the length once, so items pushed during the drain wait for the next tick.',
  failureMode: 'A burst pushed mid-drain is delayed by a full interval.',
  evidence: ['src/queue.ts:12 caches queue.length before the loop.'],
  technicalConfidence: 0.9,
  ...over,
});

const verifiedAt = (technicalConfidence, over = {}) => ({ candidateId: 'cand_001', verified: true, technicalConfidence, ...over });

const precedent = (over = {}) => ({
  eventId: 'gh_9',
  repository: 'org/a',
  reviewerLogin: 'owner',
  role: 'owner',
  outcome: 'dismissed',
  createdAt: '2026-09-01T00:00:00Z',
  filePath: 'src/elsewhere.ts',
  lineStart: 3,
  excerpt: 'an unrelated remark about another subsystem altogether',
  weight: -2,
  relevance: 1,
  matchStrength: 1,
  ...over,
});

const question = (over = {}) =>
  normaliseCandidate(
    {
      candidate_id: 'cand_q',
      path: 'src/a.ts',
      line: 4,
      category: 'correctness',
      severity: 'question',
      claim: 'Was the flag confirmed at 100% before this removal?',
      failure_mode: 'Users on the old path lose the feature.',
      evidence: ['`featureFlag` at line 4, and the flag service is outside this repository'],
      technical_confidence: 0.3,
      ...over,
    },
    0,
  );

const run = (cand, verification, precedents = []) => scoreCandidate(cand, precedents, [], DEFAULT_THRESHOLDS, verification);

/** One breakdown per `scoreCandidate` rejection branch, keyed by the gate it must record. */
const branches = {
  'not-computable': () => run(candidate({ technicalConfidence: Number.NaN })),
  'already-said': () =>
    run(candidate({ path: 'src/auth.ts', line: 84, claim: 'The response returns a refresh token before its transaction commits.' }), undefined, [
      precedent({
        eventId: 'ghr_5',
        filePath: 'src/auth.ts',
        lineStart: 84,
        weight: 1.2,
        excerpt: 'This returns the refresh token before the transaction commits, so a retry mints multiple valid tokens.',
      }),
    ]),
  'question-premises-false': () => run(question(), { candidateId: 'cand_q', premisesVerified: false }),
  'question-unverified': () => run(question(), undefined),
  'question-gap': () => run(question(), { candidateId: 'cand_q', verified: false, premisesVerified: true, technicalConfidence: 0.3 }),
  'owner-precedent-question': () =>
    run(question(), { candidateId: 'cand_q', premisesVerified: true }, [precedent({ filePath: 'src/a.ts', lineStart: 4, excerpt: 'Was the flag confirmed' })]),
  unverifiable: () => run(candidate(), { candidateId: 'cand_001', requiredContextMissing: ['the catalogue, which lives in another repository'] }),
  'verified-false': () => run(candidate(), verifiedAt(0.9, { verified: false })),
  'confidence-floor': () => run(candidate(), verifiedAt(0.65)),
  'owner-precedent': () => run(candidate(), verifiedAt(0.9), [precedent()]),
  materiality: () => run(candidate(), verifiedAt(0.9, { material: false, materialReason: 'nothing breaks' })),
  score: () => run(candidate({ technicalConfidence: 0.8, evidence: ['vague'] }), undefined),
  'stale-consumer': () => run(candidate({ anchor: 'stale-consumer' }), verifiedAt(0.9)),
};

for (const [gate, build] of Object.entries(branches)) {
  test(`scoreCandidate records gate ${gate}`, () => {
    const r = build();
    assert.equal(r.eligible, false);
    expectGate(r, gate);
  });
}

test('an eligible candidate has gate null', () => {
  const r = run(candidate(), verifiedAt(0.9));
  assert.equal(r.eligible, true, r.rejectedBecause);
  expectGate(r, null);
});

test('verified and premisesVerified mirror the verification, and are null when it is absent', () => {
  const none = run(candidate({ technicalConfidence: 0.95 }), undefined);
  assert.equal(none.verified, null);
  assert.equal(none.premisesVerified, null);
  const partial = run(candidate(), verifiedAt(0.9, { verified: false }));
  assert.equal(partial.verified, false);
  assert.equal(partial.premisesVerified, null);
  const q = run(question(), { candidateId: 'cand_q', premisesVerified: true });
  assert.equal(q.eligible, true, q.rejectedBecause);
  assert.equal(q.verified, null);
  assert.equal(q.premisesVerified, true);
  assert.equal(run(question(), { candidateId: 'cand_q', premisesVerified: false }).premisesVerified, false);
  assert.equal(run(candidate(), verifiedAt(0.9)).verified, true);
});

test('a question past the cap records question-cap', () => {
  const outcomes = [question(), question(), question()].map((c) => run(c, { candidateId: 'cand_q', premisesVerified: true }));
  applyQuestionCap(outcomes);
  const dropped = outcomes.filter((b) => !b.eligible);
  assert.equal(dropped.length, 1);
  expectGate(dropped[0], 'question-cap');
  for (const kept of outcomes.filter((b) => b.eligible)) expectGate(kept, null);
});

test('gateOf reads the recorded gate, and rewording the prose changes nothing', () => {
  const r = branches['confidence-floor']();
  assert.equal(gateOf(r), 'confidence');
  assert.equal(gateOf({ ...r, rejectedBecause: 'reworded entirely' }), 'confidence');
  assert.equal(gateOf({ ...branches.materiality(), rejectedBecause: 'reworded' }), 'materiality');
  assert.equal(gateOf({ ...branches['owner-precedent'](), rejectedBecause: 'reworded' }), 'owner-precedent');
  assert.equal(gateOf({ ...branches.score(), rejectedBecause: 'reworded' }), 'score');
  assert.equal(gateOf({ ...branches['question-gap'](), rejectedBecause: 'reworded' }), 'confidence');
  // A gate the lists do not show is no gate, whatever the prose says.
  assert.equal(gateOf({ gate: 'verified-false', rejectedBecause: 'score 0.1 is below the 0.68 threshold' }), null);
  assert.equal(gateOf({ gate: 'stale-consumer', rejectedBecause: 'technical confidence 0.1 (verifier) is below 0.7' }), null);
  assert.equal(gateOf({ gate: null, rejectedBecause: null }), null);
});

test('gateOf on a breakdown with no gate keeps today\'s prose reading', () => {
  for (const [name, build] of Object.entries(branches)) {
    const r = build();
    const { gate: _g, ...old } = r;
    assert.equal(gateOf(old), gateOf(r.rejectedBecause));
    // The recorded gate and the prose agree on every branch, except one the prose
    // misread: "score could not be computed" starts with "score ". Every list
    // also requires a finite score, so no list ever changed on it.
    if (name === 'not-computable') assert.equal(gateOf(r), null);
    else assert.equal(gateOf(r), gateOf(old), r.rejectedBecause);
  }
  assert.equal(gateOf({ rejectedBecause: 'score 0.5000 is below the 0.68 threshold' }), 'score');
  assert.equal(gateOf({ rejectedBecause: 'x. Also: score 0.5000 is below the 0.68 threshold' }), null);
});

// ---- the stages in `score` after scoreCandidate, through the built bundle ----

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-485-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/queue.ts'), Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n');
  writeFileSync(join(dir, 'src/guard.ts'), 'export function SharedPipelineGuard() { return true; }\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RAW = {
  candidate_id: 'cand_001',
  path: 'src/queue.ts',
  line: 12,
  category: 'correctness',
  severity: 'minor',
  claim: 'The drain loop reads the length once, so items pushed during the drain wait for the next tick.',
  failure_mode: 'A burst pushed mid-drain is delayed by a full interval.',
  evidence: ['src/queue.ts:12 caches queue.length before the loop.'],
  technical_confidence: 0.9,
};
const VERIFIED = { candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 };

function cliScore(dir, raw, verification, args = [], env = {}) {
  const file = join(dir, 'verification.json');
  writeFileSync(file, JSON.stringify({ results: [verification] }));
  const r = spawnSync(process.execPath, [bundle, 'score', '--verification', file, '--min-score', '0', ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates: [raw] }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data'), ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the built bundle records verified and the gate on the stored score', () =>
  withRepo((dir) => {
    const ok = cliScore(dir, RAW, VERIFIED);
    assert.equal(ok.scores[0].gate, null);
    assert.equal(ok.scores[0].verified, true);
    const held = cliScore(dir, RAW, { ...VERIFIED, technical_confidence: 0.6 });
    expectGate(held.scores[0], 'confidence-floor');
    assert.equal(held.belowGate[0].gate, 'confidence');
  }));

test('an uncorrectable correction records uncorrectable-correction', () =>
  withRepo((dir) => {
    const out = cliScore(dir, RAW, { ...VERIFIED, corrections: [{ wrong: 'twelve call sites', right: 'nine call sites' }] });
    expectGate(out.scores[0], 'uncorrectable-correction');
  }));

test('the absence check records absence', () =>
  withRepo((dir) => {
    const out = cliScore(
      dir,
      { ...RAW, path: 'src/guard.ts', line: 1, claim: 'The `SharedPipelineGuard` helper does not exist.' },
      VERIFIED,
    );
    expectGate(out.scores[0], 'absence');
  }));

test('a repeat of the thread records echo, alone and after another gate', () =>
  withRepo((dir) => {
    const thread = join(dir, 'thread.json');
    const body = `${RAW.claim} ${RAW.failure_mode}`;
    writeFileSync(thread, JSON.stringify({ comments: [{ path: null, line: null, author: 'acme-reviewer', body, kind: 'review-body' }] }));
    const alone = cliScore(dir, RAW, VERIFIED, ['--thread', thread]);
    assert.match(alone.scores[0].rejectedBecause, /already said on this pull request/);
    expectGate(alone.scores[0], 'echo');
    // After the confidence floor: "Also:" prose, so no single gate and not below-gate.
    const both = cliScore(dir, RAW, { ...VERIFIED, technical_confidence: 0.6 }, ['--thread', thread]);
    assert.match(both.scores[0].rejectedBecause, /\. Also: already said/);
    expectGate(both.scores[0], 'echo');
    assert.deepEqual(both.belowGate, []);
  }));

test('a refused anchor records anchor', () =>
  withRepo((dir) => {
    const patch = join(dir, 'diff.patch');
    writeFileSync(
      patch,
      ['diff --git a/src/queue.ts b/src/queue.ts', '--- a/src/queue.ts', '+++ b/src/queue.ts', '@@ -1,2 +1,3 @@', ' export const value0 = 0;', '+export const added = 1;', ' export const value1 = 1;', ''].join('\n'),
    );
    const out = cliScore(dir, { ...RAW, line: 25 }, VERIFIED, ['--diff-file', patch]);
    assert.equal(out.scores[0].eligible, false);
    expectGate(out.scores[0], 'anchor');
  }));

test('a citation to a missing file records citation', () =>
  withRepo((dir) => {
    const out = cliScore(dir, { ...RAW, path: 'src/nowhere.ts' }, VERIFIED);
    assert.match(out.scores[0].rejectedBecause, /does not exist at the reviewed ref/);
    expectGate(out.scores[0], 'citation');
  }));

test('an approved suppression records policy, and --promote clears it', () =>
  withRepo((dir) => {
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const db = openDatabase(join(data, 'review-voice.db'));
    let proposalId;
    try {
      assert.equal(approvePolicy(db, proposePolicy(db, []).policyId).ok, true);
      const output = ['First', 'Second', 'Third']
        .map((n, i) => `[minor] \`src/queue.ts:${5 + i}\` - ${n} repeated calculation here. It drifts. Fix it.`)
        .join('\n\n');
      recordRun(db, {
        repository: 'org/a',
        baseRef: null,
        headRef: null,
        diff: 'x',
        output,
        candidates: [5, 6, 7].map((line) => ({ path: 'src/queue.ts', line, category: 'maintainability' })),
      });
      for (const ref of ['rv_01', 'rv_02', 'rv_03']) recordFeedback(db, { findingRef: ref, action: 'dismiss', actor: 'owner' });
      proposalId = proposePolicy(db, compileProposals(db)).policyId;
    } finally {
      db.close();
    }
    const cli = (args) => spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data } });
    assert.equal(cli(['policy', 'approve', proposalId]).status, 0);

    const raw = { ...RAW, category: 'maintainability', line: 5, technical_confidence: 0.95 };
    const verification = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.95 };
    const held = cliScore(dir, raw, verification);
    assert.equal(held.scores[0].rejectedBecause, 'policy-suppressed:maintainability:diff');
    expectGate(held.scores[0], 'policy');
    assert.equal(held.suppressed.length, 1);

    const promoted = cliScore(dir, raw, verification, ['--promote', 'cand_001']);
    assert.equal(promoted.scores[0].eligible, true);
    assert.equal(promoted.scores[0].gate, null);
  }));

test('--promote clears the gate on a below-gate finding', () =>
  withRepo((dir) => {
    const out = cliScore(dir, RAW, { ...VERIFIED, technical_confidence: 0.6 }, ['--promote', 'cand_001']);
    assert.equal(out.scores[0].eligible, true);
    assert.equal(out.scores[0].gate, null);
    assert.equal(out.scores[0].ownerPromotion.gate, 'confidence');
  }));

// ---- challenge holds ----

const PATCH = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,7 @@', ' line 1', '+added 2', '+added 3', '+added 4', '+added 5', '+added 6', ' line 7', ''].join('\n');
const CLAIMS = {
  cand_001: 'The cache key omits the tenant, so one tenant reads the entries of another.',
  cand_002: 'The retry loop never stops when the server keeps answering with a timeout.',
  cand_003: 'The parsed limit is used before it is checked for a negative value.',
};

function challenge(verdicts) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-485-challenge-'));
  try {
    const ids = Object.keys(CLAIMS);
    const scores = {
      scores: ids.map((id, i) => ({
        candidateId: id,
        candidate_id: id,
        path: 'src/a.ts',
        line: 3 + i,
        eligible: true,
        rejectedBecause: null,
        gate: null,
        finalScore: 0.81,
        confidenceSource: 'verifier',
        severity: { severity: 'important', reason: 'correctness, traced' },
        anchorCheck: { path: 'src/a.ts', line: 3 + i, kind: 'added', ok: true, nearest: [3 + i], patchLine: null, beyondHunks: false },
      })),
      distribution: { count: 3 },
      eligible: ids.map((id, i) => ({
        candidateId: id,
        candidate_id: id,
        path: 'src/a.ts',
        line: 3 + i,
        severity: 'important',
        requestedSeverity: 'important',
        severityReason: 'correctness, traced',
        category: 'correctness',
        claim: CLAIMS[id],
        failureMode: `Failure mode of ${id}.`,
        evidence: ['src/a.ts:3'],
        fix: { render: 'none' },
      })),
      belowGate: [],
    };
    const candidates = {
      candidates: ids.map((id, i) => ({
        candidate_id: id,
        path: 'src/a.ts',
        line: 3 + i,
        category: 'correctness',
        severity: 'important',
        claim: CLAIMS[id],
        failure_mode: `Failure mode of ${id}.`,
        evidence: ['src/a.ts:3'],
        technical_confidence: 0.937,
      })),
    };
    writeFileSync(join(dir, 'diff.patch'), PATCH);
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores));
    writeFileSync(join(dir, 'checked.json'), JSON.stringify(candidates));
    const r = spawnSync(
      process.execPath,
      [bundle, 'challenge', '--scores', join(dir, 'scores.json'), '--candidates', join(dir, 'checked.json'), '--diff-file', join(dir, 'diff.patch')],
      { input: JSON.stringify({ verdicts }), encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const verdict = (id, over = {}) => ({ candidate_id: id, verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/a.ts:3'], reason: '', ...over });

test('challenge holds record challenge-partly and challenge-refuted, whichever way they are written', () => {
  const out = challenge([
    verdict('cand_001', { line_ok: false, corrected_line: 3 }),
    verdict('cand_002', { verdict: 'partly', reason: 'Stops after five attempts at src/a.ts:4.' }),
    verdict('cand_003', { verdict: 'refuted', reason: 'Checked at src/a.ts:2.' }),
  ]);
  const gateOfId = (id) => out.scores.find((s) => s.candidateId === id).gate;
  // The refused corrected line is the second place a partly hold is written.
  assert.equal(gateOfId('cand_001'), 'challenge-partly');
  assert.equal(gateOfId('cand_002'), 'challenge-partly');
  assert.equal(gateOfId('cand_003'), 'challenge-refuted');
  seen.add('challenge-partly');
  seen.add('challenge-refuted');
});

test('every code in HOLD_GATES is written by a branch that a test drove', () => {
  assert.deepEqual([...seen].sort(), [...HOLD_GATES].sort());
  assert.equal(new Set(HOLD_GATES).size, HOLD_GATES.length);
});

test('a rejected breakdown with a gate still normalises as refuted, a belowGate entry as below-gate', () => {
  const rejected = { candidateId: 'c1', path: 'a.ts', line: 3, eligible: false, gate: 'verified-false', rejectedBecause: 'the verifier rejected it' };
  assert.equal(normaliseHeld(rejected).verdict, 'refuted');
  assert.equal(normaliseHeld({ ...rejected, gate: 'challenge-refuted' }).verdict, 'refuted');
  const below = { candidateId: 'c2', path: 'a.ts', line: 4, gate: 'score', finalScore: 0.5, threshold: 0.68, claim: 'x' };
  assert.equal(normaliseHeld(below).verdict, 'below-gate');
});

test('the ADR records the decision and the docs carry it', () => {
  const adr = readFileSync(join(root, 'docs/adr/0041-holds-are-recorded-as-data.md'), 'utf8');
  assert.match(adr, /0041 - Holds are recorded as data/);
  assert.ok(adr.includes('#485'));
  assert.ok(readFileSync(join(root, 'docs/adr/README.md'), 'utf8').includes('0041-holds-are-recorded-as-data.md'));
  assert.ok(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes('#485'));
});
