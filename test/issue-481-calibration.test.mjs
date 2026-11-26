/**
 * Issue #481: calibration measured against labels, and the deterministic
 * label sampler. The fixture store holds 20 labelled candidates across four
 * repositories' runs, three verifier-confidence bands, two categories, and
 * verified and verifier-rejected candidates, so every expected count below
 * is hand-derived from the table in `FIXTURE_RUNS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import {
  bandIndexOf,
  calibrationReport,
  loadStoredRuns,
  parseLabels,
  parseThresholds,
  sampleCandidates,
  wilsonLower,
} from '../plugins/review-voice/src/evaluate/calibration.ts';
import {
  DEFAULT_THRESHOLDS,
  holdReasonOf,
  POLICY_SUPPRESSED_PREFIX,
  reGateBreakdown,
  UNVERIFIABLE_REJECTION,
} from '../plugins/review-voice/src/scoring/score.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function cli(args, dataDir) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-481-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seeds a store in a fresh data directory, runs `fn(dir, seeded)` against the bundle, removes it. */
function withStore(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-481-cli-'));
  try {
    const db = openDatabase(join(dir, 'review-voice.db'));
    let seeded;
    try {
      seeded = seed(db);
    } finally {
      db.close();
    }
    return fn(dir, seeded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VERIFIER_FALSE = 'the verifier did not verify this claim (verified: false)';
const confidenceHold = (conf, category) =>
  category === 'security'
    ? `technical confidence ${conf.toFixed(2)} (verifier) is below 0.8, the floor for every tier in the security category`
    : `technical confidence ${conf.toFixed(2)} (verifier) is below 0.7, the floor for a minor finding`;

/** [id, verifier confidence, verified, category, tier, label, outcome] */
const FIXTURE_RUNS = [
  {
    repository: 'org/a', pullNumber: 1, headRef: 'aaa111',
    rows: [
      ['A1', 0.85, true, 'correctness', 'minor', 'TRUE', 'eligible'],
      ['A2', 0.85, true, 'correctness', 'minor', 'TRUE', 'eligible'],
      ['A3', 0.85, true, 'security', 'important', 'TRUE', 'eligible'],
      ['A4', 0.85, true, 'security', 'important', 'TRUE', 'eligible'],
      ['A5', 0.85, true, 'correctness', 'minor', 'TRUE', 'eligible'],
    ],
  },
  {
    repository: 'org/b', pullNumber: 2, headRef: 'bbb222',
    rows: [
      ['B1', 0.85, true, 'correctness', 'minor', 'TRUE', 'eligible'],
      ['B2', 0.85, true, 'security', 'important', 'TRUE', 'eligible'],
      ['B3', 0.85, true, 'correctness', 'minor', 'TRUE-NOT-WORTH', 'eligible'],
      ['B4', 0.85, false, 'correctness', 'minor', 'FALSE', 'verifier-false'],
      ['B5', 0.85, false, 'security', 'important', 'FALSE', 'verifier-false'],
    ],
  },
  {
    repository: 'org/c', pullNumber: 3, headRef: 'ccc333',
    rows: [
      ['C1', 0.75, true, 'correctness', 'minor', 'TRUE', 'eligible'],
      ['C2', 0.75, true, 'correctness', 'minor', 'TRUE', 'eligible'],
      ['C3', 0.75, true, 'security', 'important', 'PARTLY', 'confidence'],
      ['C4', 0.75, true, 'security', 'important', 'FALSE', 'confidence'],
      ['C5', 0.75, false, 'correctness', 'minor', 'FALSE', 'verifier-false'],
    ],
  },
  {
    repository: 'org/d', pullNumber: 4, headRef: 'ddd444',
    rows: [
      ['D1', 0.75, false, 'security', 'important', 'UNCHECKABLE', 'verifier-false'],
      ['D2', 0.55, true, 'correctness', 'minor', 'TRUE', 'confidence'],
      ['D3', 0.55, false, 'correctness', 'minor', 'TRUE-NOT-WORTH', 'verifier-false'],
      ['D4', 0.55, false, 'security', 'important', 'TRUE', 'verifier-false'],
      ['D5', 0.55, true, 'security', 'important', 'UNCHECKABLE', 'confidence'],
    ],
  },
];

/** Records the fixture; returns its labels in file form. `materialById` adds a `material` field to named breakdowns. */
function buildFixture(db, materialById = {}) {
  const labels = [];
  const runIds = {};
  for (const run of FIXTURE_RUNS) {
    const candidates = [];
    const scores = [];
    run.rows.forEach(([id, conf, verified, category, tier, label, outcome], index) => {
      const path = `src/${id.toLowerCase()}.ts`;
      const line = index + 1;
      const claim = `Claim ${id} names a concrete defect.`;
      candidates.push({ candidate_id: id, candidateId: id, path, line, category, claim, severity: tier, lane: 'diff' });
      scores.push({
        candidateId: id,
        candidate_id: id,
        path,
        line,
        technicalConfidence: conf,
        verifiedConfidence: conf,
        analystConfidence: 0.7,
        confidenceSource: 'verifier',
        confidenceFloor: category === 'security' ? 0.8 : 0.7,
        severity: { severity: tier, reason: 'fixture' },
        finalScore: 0.75,
        eligible: outcome === 'eligible',
        rejectedBecause: outcome === 'eligible' ? null : outcome === 'verifier-false' ? VERIFIER_FALSE : confidenceHold(conf, category),
        verified,
        category,
        claim,
        ownerAlignment: 0.6,
        ...(id in materialById ? { material: materialById[id] } : {}),
      });
      labels.push({ run: null, candidate_id: id, label, _repository: run.repository });
    });
    const { reviewRunId } = recordRun(db, {
      repository: run.repository,
      baseRef: null,
      headRef: run.headRef,
      pullNumber: run.pullNumber,
      diff: 'd',
      output: 'No actionable findings.',
      candidates,
      scores,
    });
    runIds[run.repository] = reviewRunId;
    for (const entry of labels) if (entry._repository === run.repository && entry.run === null) entry.run = reviewRunId;
  }
  return { labels: labels.map(({ _repository, ...entry }) => entry), runIds };
}

const bandRow = (report, band, split) =>
  (split === undefined ? report.precision.byBand : report.precision[split].byBand).find((row) => row.band === band);
const categoryRow = (report, category, split) =>
  (split === undefined ? report.precision.byCategory : report.precision[split].byCategory).find((row) => row.category === category);

test('wilsonLower matches the hand-computed 8 of 10 bound, and bands close at 1.0', () => {
  assert.equal(wilsonLower(8, 10).toFixed(3), '0.490');
  assert.equal(wilsonLower(0, 0), null);
  assert.equal(bandIndexOf(0), 0);
  assert.equal(bandIndexOf(0.4999), 0);
  assert.equal(bandIndexOf(0.5), 1);
  assert.equal(bandIndexOf(0.85), 4);
  assert.equal(bandIndexOf(1), 5);
  assert.equal(bandIndexOf(1.01), null);
  assert.equal(bandIndexOf(null), null);
});

test('parseLabels is strict, naming the entry and the field, and accepts a blank sheet row', () => {
  const bad = (text, pattern) => assert.throws(() => parseLabels(text), pattern);
  bad('{}', /must be a JSON array/);
  bad('[{"candidate_id":"c1","label":"TRUE"}]', /labels entry 0.*field run/);
  bad('[{"run":"r1","label":"TRUE"}]', /labels entry 0.*field candidate_id/);
  bad('[{"run":"r1","candidate_id":"c1","label":"MAYBE"}]', /labels entry 0 \(run r1, candidate_id c1\): field label must be one of/);
  bad('[{"run":"r1","candidate_id":"c1","label":true}]', /field label/);
  bad('[{"run":"r1","candidate_id":"c1"}]', /field label is missing/);
  bad('[{"run":"r1","candidate_id":"c1","label":"TRUE","note":3}]', /field note/);
  bad(
    '[{"run":"r1","candidate_id":"c1","label":"TRUE"},{"run":"r1","candidate_id":"c1","label":"FALSE"}]',
    /labels entry 1.*labelled more than once/,
  );
  const sheet = parseLabels(
    '[{"run":"r1","candidate_id":"c1","label":"","repository":"org/a","claim":"x","verifier_confidence":0.9}]',
  );
  assert.deepEqual(sheet, [{ run: 'r1', candidate_id: 'c1', label: '' }]);
});

test('holdReasonOf buckets every rejection the scorer writes', () => {
  assert.equal(holdReasonOf(null), null);
  assert.equal(holdReasonOf('technical confidence 0.55 (verifier) is below 0.7, the floor for a minor finding'), 'confidenceFloor');
  assert.equal(holdReasonOf('score 0.6000 is below the 0.68 threshold'), 'score');
  assert.equal(holdReasonOf(`${POLICY_SUPPRESSED_PREFIX}style:diff`), 'policy');
  assert.equal(holdReasonOf(UNVERIFIABLE_REJECTION), 'unverifiable');
  assert.equal(holdReasonOf('owner precedent is against asking this (0.30 alignment)'), 'ownerPrecedent');
  assert.equal(holdReasonOf('not material: the change is cosmetic'), 'materiality');
  assert.equal(holdReasonOf(VERIFIER_FALSE), 'other');
});

test('reGateBreakdown reuses the scorer floors: one breakdown, two threshold sets, two outcomes', () => {
  const breakdown = {
    eligible: true,
    rejectedBecause: null,
    technicalConfidence: 0.85,
    confidenceSource: 'verifier',
    finalScore: 0.75,
    severityTier: 'important',
    category: 'security',
  };
  assert.deepEqual(reGateBreakdown(breakdown, DEFAULT_THRESHOLDS), { reapplicable: true, eligible: true, hold: null });
  assert.deepEqual(reGateBreakdown(breakdown, { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.9 }), {
    reapplicable: true,
    eligible: false,
    hold: 'confidenceFloor',
  });
  // A gate-held minor is released by a lower minor floor, through verifiedFloor's tier rule.
  const heldMinor = {
    ...breakdown,
    eligible: false,
    rejectedBecause: 'technical confidence 0.75 (verifier) is below 0.8, the floor for an important finding',
    technicalConfidence: 0.75,
    severityTier: 'minor',
    category: 'correctness',
  };
  assert.deepEqual(reGateBreakdown(heldMinor, DEFAULT_THRESHOLDS), { reapplicable: true, eligible: true, hold: null });
  // Missing fields are named, never guessed.
  assert.deepEqual(reGateBreakdown({ ...breakdown, finalScore: undefined }, DEFAULT_THRESHOLDS), {
    reapplicable: false,
    reason: 'missing finalScore',
  });
  assert.deepEqual(reGateBreakdown({ ...breakdown, category: undefined }, DEFAULT_THRESHOLDS), {
    reapplicable: false,
    reason: 'missing category',
  });
  // No threshold set releases a verifier rejection.
  assert.deepEqual(
    reGateBreakdown({ ...breakdown, eligible: false, rejectedBecause: VERIFIER_FALSE }, { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.5, finalScore: 0.1 }),
    { reapplicable: true, eligible: false, hold: 'other' },
  );
});

test('parseThresholds reads JSON and YAML spellings and refuses unknown or out-of-range keys', () => {
  assert.deepEqual(parseThresholds('{"technicalConfidence": 0.9}', 't.json'), { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.9 });
  assert.deepEqual(parseThresholds('review:\n  confidence_threshold: 0.9\n  final_score_threshold: 0.7\n', 't.yaml'), {
    ...DEFAULT_THRESHOLDS,
    technicalConfidence: 0.9,
    finalScore: 0.7,
  });
  assert.throws(() => parseThresholds('{"nonsense": 0.5}', 't.json'), /unknown key "nonsense"/);
  assert.throws(() => parseThresholds('{"finalScore": 2}', 't.json'), /field finalScore must be a number above 0 and at most 1/);
});

test('the report gives the hand-counted bands, categories, splits, volume and rejection audit', () => {
  withDb((db) => {
    const { labels } = buildFixture(db);
    const report = calibrationReport(db, parseLabels(JSON.stringify(labels)));
    assert.deepEqual(
      { total: report.labels.total, matched: report.labels.matched, unmatched: report.labels.unmatched.length, blank: report.labels.blank },
      { total: 20, matched: 20, unmatched: 0, blank: 0 },
    );
    // Bands: [0.8, 0.9) is the 8-of-10 example; its Wilson lower bound is 0.490.
    assert.deepEqual(bandRow(report, '[0.8, 0.9)'), {
      band: '[0.8, 0.9)', min: 0.8, max: 0.9, n: 10,
      counts: { TRUE: 7, 'TRUE-NOT-WORTH': 1, PARTLY: 0, FALSE: 2, UNCHECKABLE: 0 },
      precision: 0.8, wilsonLower: 0.49,
    });
    assert.deepEqual(bandRow(report, '[0.7, 0.8)').counts, { TRUE: 2, 'TRUE-NOT-WORTH': 0, PARTLY: 1, FALSE: 2, UNCHECKABLE: 1 });
    assert.equal(bandRow(report, '[0.7, 0.8)').precision, 0.5);
    assert.deepEqual(bandRow(report, '[0.5, 0.6)').counts, { TRUE: 2, 'TRUE-NOT-WORTH': 1, PARTLY: 0, FALSE: 0, UNCHECKABLE: 1 });
    assert.equal(bandRow(report, '[0.5, 0.6)').precision, 1);
    assert.equal(bandRow(report, '[0, 0.5)').n, 0);
    assert.equal(bandRow(report, '[0, 0.5)').precision, null);
    // Categories.
    assert.deepEqual(categoryRow(report, 'correctness').counts, { TRUE: 7, 'TRUE-NOT-WORTH': 2, PARTLY: 0, FALSE: 2, UNCHECKABLE: 0 });
    assert.equal(categoryRow(report, 'correctness').precision, 0.818);
    assert.deepEqual(categoryRow(report, 'security').counts, { TRUE: 4, 'TRUE-NOT-WORTH': 0, PARTLY: 1, FALSE: 2, UNCHECKABLE: 2 });
    assert.equal(categoryRow(report, 'security').precision, 0.667);
    // Verified and verifier-rejected apart.
    assert.equal(bandRow(report, '[0.8, 0.9)', 'verified').n, 8);
    assert.equal(bandRow(report, '[0.8, 0.9)', 'verified').precision, 1);
    assert.equal(bandRow(report, '[0.8, 0.9)', 'rejected').n, 2);
    assert.equal(bandRow(report, '[0.8, 0.9)', 'rejected').precision, 0);
    assert.equal(report.precision.unbanded, 0);
    assert.equal(report.precision.unknownVerified, 0);
    // Volume under the recorded thresholds: eligible 5, 3, 2, 0 per review.
    assert.deepEqual(report.volume.current, {
      reviews: 4,
      candidates: 20,
      eligible: 10,
      eligiblePerReview: { mean: 2.5, median: 2.5, max: 5 },
      holdsByReason: { confidenceFloor: 4, materiality: 0, ownerPrecedent: 0, unverifiable: 0, score: 0, policy: 0, other: 6 },
    });
    // No breakdown records material, which is the expected origin/main shape.
    assert.deepEqual(report.materiality, {
      n: 0,
      table: { true: { TRUE: 0, 'TRUE-NOT-WORTH': 0 }, false: { TRUE: 0, 'TRUE-NOT-WORTH': 0 } },
      agreement: null,
    });
    // Rejected labelled: B4, B5, C5 FALSE; D1 UNCHECKABLE; D3 TRUE-NOT-WORTH and D4 TRUE are false rejects.
    assert.equal(report.rejectionAudit.n, 6);
    assert.equal(report.rejectionAudit.falseRejects, 2);
    assert.equal(report.rejectionAudit.rate, 0.333);
    assert.deepEqual(report.rejectionAudit.counts, { TRUE: 1, 'TRUE-NOT-WORTH': 1, PARTLY: 0, FALSE: 3, UNCHECKABLE: 1 });
  });
});

test('materiality agreement is the hand-counted 2x2 when breakdowns record material', () => {
  withDb((db) => {
    const { labels } = buildFixture(db, { A1: true, A2: false, A3: true, B3: false, D3: true });
    const report = calibrationReport(db, parseLabels(JSON.stringify(labels)));
    assert.deepEqual(report.materiality, {
      n: 5,
      table: { true: { TRUE: 2, 'TRUE-NOT-WORTH': 1 }, false: { TRUE: 1, 'TRUE-NOT-WORTH': 1 } },
      agreement: 0.6,
    });
  });
});

test('a verifier verdict is read from the breakdown reason when no explicit field was stored', () => {
  withDb((db) => {
    const { reviewRunId } = recordRun(db, {
      repository: 'org/a', baseRef: null, headRef: 'abc', pullNumber: 9, diff: 'd', output: 'No actionable findings.',
      candidates: [{ candidate_id: 'c1', path: 'src/a.ts', line: 1, category: 'correctness', claim: 'A claim.' }],
      scores: [{
        candidateId: 'c1', path: 'src/a.ts', line: 1, technicalConfidence: 0.9, verifiedConfidence: 0.9,
        confidenceSource: 'verifier', severity: { severity: 'minor', reason: 'fixture' }, finalScore: 0.8,
        eligible: false, rejectedBecause: VERIFIER_FALSE,
      }],
    });
    const report = calibrationReport(db, parseLabels(JSON.stringify([{ run: reviewRunId, candidate_id: 'c1', label: 'TRUE' }])));
    assert.equal(report.rejectionAudit.n, 1);
    assert.equal(report.rejectionAudit.falseRejects, 1);
    assert.equal(report.precision.rejected.byBand.find((row) => row.band === '[0.9, 1.0]').n, 1);
  });
});

test('a rejected low-confidence question counts as rejected, and a held candidate keeps its claim from the held entry', () => {
  withDb((db) => {
    const { reviewRunId } = recordRun(db, {
      repository: 'org/a', baseRef: null, headRef: 'abc', pullNumber: 9, diff: 'd', output: 'No actionable findings.',
      candidates: [],
      held: [{ path: 'src/q.ts', line: 4, verdict: 'below-gate', source: 'score', reason: 'below the confidence gate', text: 'Is the cache key per enterprise?', severity: 'question' }],
      scores: [{
        candidateId: 'q1', path: 'src/q.ts', line: 4, technicalConfidence: 0.3, verifiedConfidence: 0.3,
        confidenceSource: 'verifier', severity: { severity: 'question', reason: 'fixture' }, finalScore: 0.5,
        eligible: false,
        rejectedBecause: 'technical confidence 0.30 (verifier) is below 0.5, and the verifier rejected this question (verified: false)',
      }],
    });
    const [candidate] = loadStoredRuns(db).flatMap((run) => run.candidates);
    assert.equal(candidate.verified, false, 'a rejected question is not counted as verified');
    assert.equal(candidate.claim, 'Is the cache key per enterprise?', 'the claim comes from the held entry');
    const report = calibrationReport(db, parseLabels(JSON.stringify([{ run: reviewRunId, candidate_id: 'q1', label: 'TRUE' }])));
    assert.equal(report.rejectionAudit.n, 1);
    assert.equal(report.rejectionAudit.falseRejects, 1);
  });
});

test('calibration over the CLI prints the same report as JSON and as text', () => {
  withStore(
    (db) => buildFixture(db),
    (dir, { labels }) => {
      const file = join(dir, 'labels.json');
      writeFileSync(file, JSON.stringify(labels));
      const result = cli(['evaluate', 'calibration', '--labels', file], dir);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.labels.matched, 20);
      assert.equal(bandRow(report, '[0.8, 0.9)').wilsonLower, 0.49);
      assert.equal(bandRow(report, '[0.8, 0.9)').wilsonLower.toFixed(3), '0.490');
      assert.equal(report.volume.current.eligiblePerReview.mean, 2.5);
      assert.equal(report.volume.proposed, undefined);
      const text = cli(['evaluate', 'calibration', '--labels', file, '--text'], dir);
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /Precision by band/);
      assert.match(text.stdout, /\[0\.8, 0\.9\)/);
      assert.match(text.stdout, /0\.490/);
      assert.match(text.stdout, /confidence floor 4/);
      assert.match(text.stdout, /Rejection audit: 2 false reject\(s\) of 6/);
      assert.match(text.stdout, /Materiality agreement: n 0/);
    },
  );
});

test('--thresholds with a higher floor shows fewer eligible per review and more confidence floor holds', () => {
  withStore(
    (db) => buildFixture(db),
    (dir, { labels }) => {
      const file = join(dir, 'labels.json');
      writeFileSync(file, JSON.stringify(labels));
      const thresholds = join(dir, 'thresholds.json');
      writeFileSync(thresholds, JSON.stringify({ technicalConfidence: 0.9, minorConfidence: 0.85, finalScore: 0.68 }));
      const result = cli(['evaluate', 'calibration', '--labels', file, '--thresholds', thresholds], dir);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      // Hand-derived: the three eligible security findings at 0.85 and the two
      // eligible minors at 0.75 fall under the higher floors; nothing else moves.
      assert.equal(report.volume.current.eligible, 10);
      assert.equal(report.volume.proposed.eligible, 5);
      assert.deepEqual(report.volume.proposed.eligiblePerReview, { mean: 1.25, median: 1, max: 3 });
      assert.ok(report.volume.proposed.eligiblePerReview.mean < report.volume.current.eligiblePerReview.mean);
      assert.equal(report.volume.current.holdsByReason.confidenceFloor, 4);
      assert.equal(report.volume.proposed.holdsByReason.confidenceFloor, 9);
      assert.ok(report.volume.proposed.holdsByReason.confidenceFloor > report.volume.current.holdsByReason.confidenceFloor);
      assert.equal(report.volume.proposed.holdsByReason.other, 6);
      assert.equal(report.volume.proposed.notReapplicable.count, 0);
      // The same set as YAML, in config spellings under review:.
      const yaml = join(dir, 'thresholds.yaml');
      writeFileSync(yaml, 'review:\n  confidence_threshold: 0.9\n  minor_confidence_threshold: 0.85\n  final_score_threshold: 0.68\n');
      const fromYaml = cli(['evaluate', 'calibration', '--labels', file, '--thresholds', yaml], dir);
      assert.equal(fromYaml.code, 0, fromYaml.stderr);
      assert.equal(JSON.parse(fromYaml.stdout).volume.proposed.eligible, 5);
    },
  );
});

test('a breakdown missing a re-gate field counts under notReapplicable with the field named', () => {
  withStore(
    (db) => {
      recordRun(db, {
        repository: 'org/a', baseRef: null, headRef: 'abc', pullNumber: 9, diff: 'd', output: 'No actionable findings.',
        candidates: [{ candidate_id: 'c1', path: 'src/a.ts', line: 1, category: 'correctness', claim: 'A claim.' }],
        scores: [{
          candidateId: 'c1', path: 'src/a.ts', line: 1, technicalConfidence: 0.9, verifiedConfidence: 0.9,
          confidenceSource: 'verifier', severity: { severity: 'minor', reason: 'fixture' },
          eligible: true, rejectedBecause: null, verified: true, category: 'correctness',
        }],
      });
    },
    (dir) => {
      const file = join(dir, 'labels.json');
      writeFileSync(file, '[]');
      const thresholds = join(dir, 'thresholds.json');
      writeFileSync(thresholds, '{"technicalConfidence": 0.9}');
      const result = cli(['evaluate', 'calibration', '--labels', file, '--thresholds', thresholds], dir);
      assert.equal(result.code, 0, result.stderr);
      const proposed = JSON.parse(result.stdout).volume.proposed;
      assert.equal(proposed.notReapplicable.count, 1);
      assert.deepEqual(proposed.notReapplicable.byReason, { 'missing finalScore': 1 });
      assert.equal(proposed.notReapplicable.entries[0].candidate_id, 'c1');
      assert.equal(proposed.eligible, 0);
    },
  );
});

test('malformed labels exit 2 naming the entry, and unmatched labels are listed, not counted', () => {
  withStore(
    (db) => buildFixture(db),
    (dir, { labels }) => {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify([{ run: labels[0].run, candidate_id: 'A1', label: 'MAYBE' }]));
      const refused = cli(['evaluate', 'calibration', '--labels', bad], dir);
      assert.equal(refused.code, 2);
      assert.match(refused.stderr, /labels entry 0 \(run .*candidate_id A1\): field label/);
      const withUnknown = join(dir, 'labels.json');
      writeFileSync(withUnknown, JSON.stringify([
        ...labels,
        { run: 'no-such-run', candidate_id: 'A1', label: 'TRUE' },
        { run: labels[0].run, candidate_id: 'no-such-candidate', label: 'FALSE' },
      ]));
      const result = cli(['evaluate', 'calibration', '--labels', withUnknown], dir);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.labels.matched, 20);
      assert.deepEqual(report.labels.unmatched, [
        { run: 'no-such-run', candidate_id: 'A1', label: 'TRUE', reason: 'unknown run' },
        { run: labels[0].run, candidate_id: 'no-such-candidate', label: 'FALSE', reason: 'unknown candidate' },
      ]);
      assert.equal(bandRow(report, '[0.8, 0.9)').n, 10);
      // A missing --labels and an unknown subcommand are bad invocations too.
      assert.equal(cli(['evaluate', 'calibration'], dir).code, 2);
      assert.equal(cli(['evaluate', 'nonsuch'], dir).code, 2);
    },
  );
});

test('label-sample is deterministic, stratified, and its sheet goes straight back to --labels', () => {
  withStore(
    (db) => buildFixture(db),
    (dir) => {
      const first = join(dir, 'sheet-1.json');
      const second = join(dir, 'sheet-2.json');
      const run1 = cli(['evaluate', 'label-sample', '--out', first, '--n', '6', '--seed', 'alpha'], dir);
      const run2 = cli(['evaluate', 'label-sample', '--out', second, '--n', '6', '--seed', 'alpha'], dir);
      assert.equal(run1.code, 0, run1.stderr);
      assert.equal(run2.code, 0, run2.stderr);
      assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'), 'the same seed writes byte-identical sheets');
      const summary = JSON.parse(run1.stdout);
      assert.equal(summary.sampled, 6);
      assert.equal(summary.strata.length, 6, 'three bands crossed with verified and rejected');
      assert.ok(summary.strata.every((stratum) => stratum.sampled >= 1), 'every non-empty stratum is represented');
      const sheet = JSON.parse(readFileSync(first, 'utf8'));
      assert.equal(sheet.length, 6);
      for (const row of sheet) {
        assert.equal(row.label, '');
        assert.equal(typeof row.run, 'string');
        assert.equal(typeof row.candidate_id, 'string');
        assert.equal(row.location, `${row.path}:${row.line}`);
        assert.ok('repository' in row && 'pull_number' in row && 'head_sha' in row);
        assert.ok('severity' in row && 'category' in row && 'claim' in row);
        assert.ok('verifier_confidence' in row && 'verified' in row && 'band' in row);
      }
      const strataInSheet = new Set(sheet.map((row) => `${row.band}|${row.verified}`));
      assert.equal(strataInSheet.size, 6);
      // A different seed draws a different selection at the same size.
      const other = join(dir, 'sheet-3.json');
      const run3 = cli(['evaluate', 'label-sample', '--out', other, '--n', '6', '--seed', 'beta'], dir);
      assert.equal(run3.code, 0, run3.stderr);
      const firstIds = new Set(sheet.map((row) => row.candidate_id));
      const otherSheet = JSON.parse(readFileSync(other, 'utf8'));
      assert.notDeepEqual(new Set(otherSheet.map((row) => row.candidate_id)), firstIds);
      // The blank sheet is accepted by --labels as is: every row blank, nothing counted.
      const accepted = cli(['evaluate', 'calibration', '--labels', first], dir);
      assert.equal(accepted.code, 0, accepted.stderr);
      const report = JSON.parse(accepted.stdout);
      assert.equal(report.labels.blank, 6);
      assert.equal(report.labels.matched, 0);
      // Fill two rows and the same file still works, context fields ignored.
      sheet[0].label = 'TRUE';
      sheet[1].label = 'FALSE';
      const filled = join(dir, 'filled.json');
      writeFileSync(filled, JSON.stringify(sheet));
      const filledResult = cli(['evaluate', 'calibration', '--labels', filled], dir);
      assert.equal(filledResult.code, 0, filledResult.stderr);
      assert.equal(JSON.parse(filledResult.stdout).labels.matched, 2);
    },
  );
});

test('label-sample honours --repository and --since, and refuses bad flags', () => {
  withStore(
    (db) => {
      const fixture = buildFixture(db);
      db.prepare('UPDATE review_runs SET created_at = ? WHERE review_run_id = ?')
        .run('2020-01-01T00:00:00.000Z', fixture.runIds['org/d']);
      return fixture;
    },
    (dir, { runIds }) => {
      const onlyA = join(dir, 'a.json');
      const byRepo = cli(['evaluate', 'label-sample', '--out', onlyA, '--n', '10', '--seed', 's', '--repository', 'org/a'], dir);
      assert.equal(byRepo.code, 0, byRepo.stderr);
      const aSheet = JSON.parse(readFileSync(onlyA, 'utf8'));
      assert.equal(aSheet.length, 5);
      assert.ok(aSheet.every((row) => row.repository === 'org/a'));
      const recent = join(dir, 'recent.json');
      const bySince = cli(['evaluate', 'label-sample', '--out', recent, '--n', '20', '--seed', 's', '--since', '2021-01-01'], dir);
      assert.equal(bySince.code, 0, bySince.stderr);
      const recentSheet = JSON.parse(readFileSync(recent, 'utf8'));
      assert.ok(recentSheet.every((row) => row.run !== runIds['org/d']), 'the aged run is left out');
      assert.equal(cli(['evaluate', 'label-sample', '--out', recent, '--n', '0', '--seed', 's'], dir).code, 2);
      assert.equal(cli(['evaluate', 'label-sample', '--out', recent, '--n', 'x', '--seed', 's'], dir).code, 2);
      assert.equal(cli(['evaluate', 'label-sample', '--n', '5', '--seed', 's'], dir).code, 2);
      assert.equal(cli(['evaluate', 'label-sample', '--out', recent, '--n', '5'], dir).code, 2);
      assert.equal(cli(['evaluate', 'label-sample', '--out', recent, '--n', '5', '--seed', 's', '--since', 'whenever'], dir).code, 2);
    },
  );
});

test('sampleCandidates itself is deterministic and the sampler source uses no unseeded randomness', () => {
  withDb((db) => {
    buildFixture(db);
    const pool = loadStoredRuns(db).flatMap((run) => run.candidates);
    const a = sampleCandidates(pool, { n: 8, seed: 'fixed' }).selected.map((candidate) => candidate.candidateId);
    const b = sampleCandidates(pool, { n: 8, seed: 'fixed' }).selected.map((candidate) => candidate.candidateId);
    assert.deepEqual(a, b);
    assert.equal(a.length, 8);
  });
  const source = readFileSync(join(root, 'plugins/review-voice/src/evaluate/calibration.ts'), 'utf8');
  assert.ok(!source.includes('Math.random'), 'the draw is seeded, never unseeded');
});

test('evaluate help documents both subcommands and their flags', () => {
  const help = commandHelp('evaluate');
  assert.match(help, /evaluate calibration --labels <file>/);
  assert.match(help, /--thresholds <file>/);
  assert.match(help, /--text/);
  assert.match(help, /evaluate label-sample --out <file> --n <k> --seed <s>/);
  assert.match(help, /notReapplicable/);
  // The metrics help the other tests rely on is unchanged.
  assert.match(help, /--since <Nd>/);
  assert.match(help, /by_family/);
  assert.match(help, /Exit codes: 0 ok, 2 bad invocation\./);
});



/** One run holding the given breakdowns; candidates default to none. */
function recordScores(db, scores, candidates = []) {
  return recordRun(db, {
    repository: 'org/a', baseRef: null, headRef: 'abc', pullNumber: 9, diff: 'd', output: 'No actionable findings.',
    candidates, scores,
  }).reviewRunId;
}
const heldBreakdown = (id, extra = {}) => ({
  candidateId: id, path: 'src/h.ts', line: 3, technicalConfidence: 0.4, verifiedConfidence: 0.4,
  confidenceSource: 'verifier', severity: { severity: 'minor', reason: 'fixture' }, finalScore: 0.7,
  eligible: false, rejectedBecause: confidenceHold(0.4, 'security'), gate: 'confidence-floor', verified: true, ...extra,
});

test('a held candidate keeps the category and claim stored with it, and can be re-gated; a pre-#486 run stays unknown', () => {
  withDb((db) => {
    const runId = recordScores(
      db,
      [heldBreakdown('h1')],
      [{ candidate_id: 'h1', path: 'src/h.ts', line: 3, category: 'security', claim: 'A held claim.', held: true }],
    );
    const old = recordScores(db, [heldBreakdown('o1', { path: 'src/o.ts' })]);
    const byId = Object.fromEntries(loadStoredRuns(db).flatMap((run) => run.candidates).map((c) => [c.candidateId, c]));
    assert.equal(byId.h1.category, 'security');
    assert.equal(byId.h1.claim, 'A held claim.');
    assert.equal(byId.o1.category, 'unknown');
    const labels = parseLabels(JSON.stringify([{ run: runId, candidate_id: 'h1', label: 'TRUE' }, { run: old, candidate_id: 'o1', label: 'TRUE' }]));
    const report = calibrationReport(db, labels, { thresholds: { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.3 } });
    assert.equal(categoryRow(report, 'security').n, 1);
    assert.equal(categoryRow(report, 'unknown').n, 1);
    assert.equal(report.volume.proposed.notReapplicable.entries.some((e) => e.candidate_id === 'h1'), false, 'the held candidate is re-gateable');
    assert.equal(report.volume.proposed.notReapplicable.entries.some((e) => e.candidate_id === 'o1'), true);
  });
});

test('the verdict is the recorded verified field, null included; without it a rejected question still counts as rejected', () => {
  withDb((db) => {
    const question = (id, extra) => ({
      candidateId: id, path: `src/${id}.ts`, line: 1, technicalConfidence: 0.4, verifiedConfidence: 0.4,
      confidenceSource: 'verifier', severity: { severity: 'question', reason: 'fixture' }, finalScore: 0.5,
      eligible: false, premisesVerified: true, gate: 'question-gap',
      rejectedBecause: 'technical confidence 0.40 (verifier) is below 0.5, and the verifier rejected this question (verified: false)',
      ...extra,
    });
    const noKey = question('q2', {});
    const runId = recordScores(db, [question('q1', { verified: false }), noKey, question('q3', { verified: null })]);
    const byId = Object.fromEntries(loadStoredRuns(db).flatMap((run) => run.candidates).map((c) => [c.candidateId, c.verified]));
    assert.deepEqual(byId, { q1: false, q2: false, q3: null });
    const labels = parseLabels(JSON.stringify(['q1', 'q2'].map((id) => ({ run: runId, candidate_id: id, label: 'TRUE' }))));
    const report = calibrationReport(db, labels);
    assert.equal(report.rejectionAudit.n, 2);
    const sample = sampleCandidates(loadStoredRuns(db).flatMap((run) => run.candidates), { n: 5, seed: 's' });
    assert.deepEqual(sample.strata.map((stratum) => stratum.stratum ?? stratum.key ?? stratum.name), ['[0, 0.5)|rejected']);
    assert.equal(sample.unstratified, 1);
  });
});

test('hold buckets read the recorded gate, and the prose only when a breakdown has none', () => {
  assert.equal(holdReasonOf('reworded entirely', 'materiality'), 'materiality');
  assert.equal(holdReasonOf('not material: the change is cosmetic', 'verified-false'), 'other');
  assert.equal(holdReasonOf('not material: the change is cosmetic', 'question-gap'), 'confidenceFloor');
  assert.equal(holdReasonOf('x', 'owner-precedent-question'), 'ownerPrecedent');
  assert.equal(holdReasonOf('score could not be computed', 'not-computable'), 'other');
  assert.equal(holdReasonOf('held', 'constructor'), 'other');
  assert.equal(holdReasonOf('held', '__proto__'), 'other');
  assert.equal(holdReasonOf('x', 'confidence-floor'), 'confidenceFloor');
  assert.equal(holdReasonOf('x', 'owner-precedent'), 'ownerPrecedent');
  assert.equal(holdReasonOf('x', 'unverifiable'), 'unverifiable');
  assert.equal(holdReasonOf('x', 'score'), 'score');
  assert.equal(holdReasonOf('x', 'policy'), 'policy');
  assert.equal(holdReasonOf('not material: the change is cosmetic'), 'materiality');
  withDb((db) => {
    recordScores(db, [
      heldBreakdown('g1', { gate: 'materiality', rejectedBecause: 'worded some other way' }),
      heldBreakdown('g2', { gate: 'confidence-floor', rejectedBecause: 'not material: the change is cosmetic' }),
      heldBreakdown('g3', { gate: undefined, rejectedBecause: 'not material: the change is cosmetic' }),
    ]);
    const { holdsByReason } = calibrationReport(db, []).volume.current;
    assert.deepEqual([holdsByReason.materiality, holdsByReason.confidenceFloor, holdsByReason.other], [2, 1, 0]);
  });
});

test('calibration and label-sample open the store read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-481-ro-'));
  try {
    const labels = join(dir, 'labels.json');
    writeFileSync(labels, '[]');
    const data = join(dir, 'data');
    const none = cli(['evaluate', 'calibration', '--labels', labels], data);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(JSON.parse(none.stdout).labels.total, 0);
    const sample = cli(['evaluate', 'label-sample', '--out', join(dir, 'sheet.json'), '--n', '3', '--seed', 's'], data);
    assert.equal(sample.code, 0, sample.stderr);
    assert.equal(existsSync(data), false, 'no data directory was created');

    const db = openDatabase(join(data, 'review-voice.db'));
    buildFixture(db);
    db.close();
    const file = join(data, 'review-voice.db');
    const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
    for (const args of [['calibration', '--labels', labels], ['label-sample', '--out', join(dir, 's2.json'), '--n', '3', '--seed', 's']]) {
      const result = cli(['evaluate', ...args], data);
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(readFileSync(file), before.bytes);
    assert.equal(statSync(file).mtimeMs, before.mtime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store older than the code exits 2 naming the upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-481-old-'));
  try {
    const file = join(dir, 'review-voice.db');
    const db = openDatabase(file);
    db.prepare('UPDATE schema_version SET version = 1').run();
    db.close();
    const labels = join(dir, 'labels.json');
    writeFileSync(labels, '[]');
    const result = cli(['evaluate', 'calibration', '--labels', labels], dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /run any other review-voice command once to upgrade/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
