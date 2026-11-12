/**
 * Two confidence floors for a finding the verifier scored (#343): the main
 * floor at blocking and important, a lower one at minor and nit, and the main
 * floor at every tier for a category no suppression may reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLDS, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;

// The final score is set aside so each case is decided by the confidence floor alone.
const ONLY_CONFIDENCE = { ...DEFAULT_THRESHOLDS, finalScore: 0 };

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

const verified = (technicalConfidence, over = {}) => ({
  candidateId: 'cand_001',
  verified: true,
  technicalConfidence,
  ...over,
});

const score = (over, confidence, thresholds = ONLY_CONFIDENCE, ownerTier = undefined, verification = {}) =>
  scoreCandidate(candidate(over), [], [], thresholds, verified(confidence, verification), undefined, ownerTier);

test('a verified minor at 0.72 is eligible and an important at 0.72 is held', () => {
  const minor = score({ category: 'correctness' }, 0.72);
  assert.equal(minor.severity.severity, 'minor');
  assert.equal(minor.eligible, true, minor.rejectedBecause);
  assert.equal(minor.confidenceFloor, 0.7);

  const important = score({ category: 'api_contract', severity: 'important' }, 0.72);
  assert.equal(important.severity.severity, 'important');
  assert.equal(important.eligible, false);
  assert.equal(important.confidenceFloor, 0.8);
  assert.equal(
    important.rejectedBecause,
    'technical confidence 0.72 (verifier) is below 0.8, the floor for an important finding',
  );
});

test('a nit at 0.69 is held with the 0.7 floor named', () => {
  const nit = score({ category: 'maintainability', severity: 'nit' }, 0.69);
  assert.equal(nit.severity.severity, 'nit');
  assert.equal(nit.eligible, false);
  assert.equal(nit.rejectedBecause, 'technical confidence 0.69 (verifier) is below 0.7, the floor for a nit finding');
  assert.equal(nit.confidenceFloor, 0.7);
});

test('a security finding lowered to minor at 0.72 is held under 0.8', () => {
  const security = score({ category: 'security' }, 0.72, ONLY_CONFIDENCE, 'minor');
  assert.equal(security.eligible, false);
  assert.equal(security.confidenceFloor, 0.8);
  assert.equal(
    security.rejectedBecause,
    'technical confidence 0.72 (verifier) is below 0.8, the floor for every tier in the security category',
  );
  // An alias reaches the same carve-out.
  assert.equal(score({ category: 'authz' }, 0.72, ONLY_CONFIDENCE, 'nit').confidenceFloor, 0.8);
  // The same override on an ordinary category takes the lower floor.
  assert.equal(score({ category: 'api_contract', severity: 'important' }, 0.72, ONLY_CONFIDENCE, 'minor').eligible, true);
});

test('an owner raise to important takes the main floor', () => {
  const raised = score({ category: 'correctness' }, 0.72, ONLY_CONFIDENCE, 'important');
  assert.equal(raised.eligible, false);
  assert.match(raised.rejectedBecause, /is below 0\.8, the floor for an important finding$/);
});

test('a question is unaffected by the minor floor', () => {
  const asked = score({ category: 'correctness', severity: 'question' }, 0.3, ONLY_CONFIDENCE, undefined, { premisesVerified: true });
  assert.equal(asked.severity.severity, 'question');
  assert.equal(asked.eligible, true, asked.rejectedBecause);

  const moot = score({ category: 'correctness', severity: 'question' }, 0.45, ONLY_CONFIDENCE, undefined, {
    verified: false,
    premisesVerified: true,
  });
  assert.equal(moot.eligible, false);
  assert.equal(moot.confidenceFloor, 0.5);
  assert.equal(
    moot.rejectedBecause,
    'technical confidence 0.45 (verifier) is below 0.5, and the verifier rejected this question (verified: false)',
  );
});

test('the analyst-only floor is unchanged at minor', () => {
  const r = scoreCandidate(candidate({ technicalConfidence: 0.65 }), [], [], ONLY_CONFIDENCE);
  assert.equal(r.confidenceSource, 'analyst');
  assert.equal(r.confidenceFloor, 0.7);
  assert.match(r.rejectedBecause, /^technical confidence 0\.65 \(analyst\) is below 0\.7\. No verification/);
});

function withRepo(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-343-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const loaded = (review) => withRepo(`review:\n${review}`, (dir) => loadConfig(dir, NO_BASELINE));

test('the config key moves the minor floor and a value above the main threshold is clamped with a warning', () => {
  const lowered = loaded('  minor_confidence_threshold: 0.6\n');
  assert.equal(lowered.thresholds.minorConfidence, 0.6);
  assert.deepEqual(lowered.warnings.filter((w) => w.includes('minor_confidence_threshold')), []);

  const above = loaded('  minor_confidence_threshold: 0.9\n');
  assert.equal(above.thresholds.minorConfidence, 0.8);
  assert.ok(
    above.warnings.includes(
      'review.minor_confidence_threshold 0.9 is above review.confidence_threshold 0.8; ' +
        'using 0.8 for minor and nit too, since a lower tier never needs more confidence.',
    ),
    above.warnings.join('\n'),
  );

  const both = loaded('  confidence_threshold: 0.75\n  minor_confidence_threshold: 0.78\n');
  assert.equal(both.thresholds.technicalConfidence, 0.75);
  assert.equal(both.thresholds.minorConfidence, 0.75);

  // A flag above the main floor is clamped by the scorer.
  const r = score({ category: 'correctness' }, 0.82, { ...ONLY_CONFIDENCE, minorConfidence: 0.9 });
  assert.equal(r.eligible, true, r.rejectedBecause);
  assert.equal(r.confidenceFloor, 0.8);
});

test('a malformed minor threshold warns and keeps 0.7', () => {
  for (const value of ['high', '0', '1.5', '-0.2']) {
    const config = loaded(`  minor_confidence_threshold: ${value}\n`);
    assert.equal(config.thresholds.minorConfidence, undefined, value);
    assert.ok(
      config.warnings.includes('review.minor_confidence_threshold must be a number above 0 and at most 1; using the default.'),
      config.warnings.join('\n'),
    );
  }
  assert.equal(DEFAULT_THRESHOLDS.minorConfidence, 0.7);
});

function runScore(dir, candidates, verifications, args = []) {
  // The patch adds src/queue.ts, so every cited line resolves and is anchored.
  const patch = join(dir, 'diff.patch');
  writeFileSync(
    patch,
    ['diff --git a/src/queue.ts b/src/queue.ts', '--- a/src/queue.ts', '+++ b/src/queue.ts', '@@ -0,0 +1,50 @@',
      ...Array.from({ length: 50 }, (_, i) => `+line ${i + 1}`)].join('\n'),
  );
  const verification = join(dir, 'verification.json');
  writeFileSync(verification, JSON.stringify({ results: verifications }));
  const flags = ['score', '--verification', verification, '--diff-file', patch, '--min-score', '0', ...args];
  const r = spawnSync(process.execPath, [bundle, ...flags], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const raw = (id, category, severity, line) => ({
  candidate_id: id,
  path: 'src/queue.ts',
  line,
  category,
  severity,
  claim: `The drain loop at line ${line} reads the length once, so items pushed during the drain wait for the next tick.`,
  failure_mode: 'A burst pushed mid-drain is delayed by a full interval.',
  evidence: [`src/queue.ts:${line} caches queue.length before the loop.`],
  technical_confidence: 0.9,
});

const CANDIDATES = [
  raw('cand_001', 'correctness', 'minor', 10),
  raw('cand_002', 'correctness', 'minor', 20),
  raw('cand_003', 'api_contract', 'important', 30),
  raw('cand_004', 'security', 'blocking', 40),
];
const VERIFICATIONS = [
  { candidate_id: 'cand_001', verified: true, technical_confidence: 0.72 },
  { candidate_id: 'cand_002', verified: true, technical_confidence: 0.65 },
  { candidate_id: 'cand_003', verified: true, technical_confidence: 0.72 },
  { candidate_id: 'cand_004', verified: true, technical_confidence: 0.72 },
];

test('the built bundle holds each tier to its floor and the below-gate entry names it', () =>
  withRepo('review:\n  minor_confidence_threshold: high\n', (dir) => {
    const out = runScore(dir, CANDIDATES, VERIFICATIONS, ['--severity', 'cand_004=minor']);
    const byId = new Map(out.scores.map((s) => [s.candidate_id, s]));
    assert.equal(byId.get('cand_001').eligible, true, byId.get('cand_001').rejectedBecause);
    assert.equal(byId.get('cand_002').rejectedBecause, 'technical confidence 0.65 (verifier) is below 0.7, the floor for a minor finding');
    assert.equal(byId.get('cand_003').rejectedBecause, 'technical confidence 0.72 (verifier) is below 0.8, the floor for an important finding');
    assert.match(byId.get('cand_004').rejectedBecause, /is below 0\.8, the floor for every tier in the security category$/);

    const below = new Map(out.belowGate.map((entry) => [entry.candidateId, entry]));
    assert.deepEqual([...below.keys()].sort(), ['cand_002', 'cand_003', 'cand_004']);
    assert.deepEqual(
      [...below.values()].map(({ candidateId, severity, gate, technicalConfidence, threshold }) => ({
        candidateId,
        severity,
        gate,
        technicalConfidence,
        threshold,
      })),
      [
        { candidateId: 'cand_002', severity: 'minor', gate: 'confidence', technicalConfidence: 0.65, threshold: 0.7 },
        { candidateId: 'cand_003', severity: 'important', gate: 'confidence', technicalConfidence: 0.72, threshold: 0.8 },
        { candidateId: 'cand_004', severity: 'minor', gate: 'confidence', technicalConfidence: 0.72, threshold: 0.8 },
      ],
    );
  }));

test('the minor floor flag moves the floor and is clamped to the main one', () =>
  withRepo('review: {}\n', (dir) => {
    const lowered = runScore(dir, CANDIDATES.slice(1, 2), VERIFICATIONS.slice(1, 2), ['--min-minor-confidence', '0.6']);
    assert.equal(lowered.scores[0].eligible, true, lowered.scores[0].rejectedBecause);

    const clamped = runScore(
      dir,
      CANDIDATES.slice(0, 1),
      [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.75 }],
      ['--min-minor-confidence', '0.9', '--min-confidence', '0.75'],
    );
    assert.equal(clamped.scores[0].eligible, true, clamped.scores[0].rejectedBecause);
    assert.equal(clamped.scores[0].confidenceFloor, 0.75);
  }));
