/**
 * #479: verifier confidence is one low floor, not a fine-grained truth gate.
 * A verified verifier-sourced claim reports its final score without gating
 * on it, and materiality is a verdict of its own: held at minor or nit,
 * lowering one tier above that, never holding an exempt category.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THRESHOLDS,
  EXEMPT_CONFIDENCE_FLOOR,
  FIX_CONFIDENCE_THRESHOLD,
  OWNER_PRECEDENT_PREFIX,
  scoreCandidate,
} from '../plugins/review-voice/src/scoring/score.ts';
import { gateOf } from '../plugins/review-voice/src/cli/score.ts';
import { verificationProblem } from '../plugins/review-voice/src/cli/shared.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-479-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;

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

const REPOSITORY_REACH = {
  reach: 'repository',
  symbols: ['drainQueue'],
  paths: ['src/queue.ts'],
  directoryCount: 4,
  inconclusive: false,
  searchedRef: 'base',
};

const score = (over, confidence, { thresholds = DEFAULT_THRESHOLDS, precedents = [], verification = {} } = {}) =>
  scoreCandidate(candidate(over), precedents, [], thresholds, verified(confidence, verification));

const OLD_FLOORS = { technicalConfidence: 0.8, minorConfidence: 0.7, analystOnlyConfidence: 0.7, finalScore: 0 };

test('the defaults are one low floor, with the analyst and fix gates unmoved', () => {
  assert.equal(DEFAULT_THRESHOLDS.technicalConfidence, 0.7);
  assert.equal(DEFAULT_THRESHOLDS.minorConfidence, 0.7);
  assert.equal(DEFAULT_THRESHOLDS.analystOnlyConfidence, 0.7);
  assert.equal(DEFAULT_THRESHOLDS.finalScore, 0.68);
  assert.equal(EXEMPT_CONFIDENCE_FLOOR, 0.8);
  assert.equal(FIX_CONFIDENCE_THRESHOLD, 0.8);
});

test('a verified candidate at 0.72 ships at nit, minor, important and blocking', () => {
  const cases = [
    ['nit', { category: 'maintainability', severity: 'nit' }, {}],
    ['minor', { category: 'correctness', severity: 'minor' }, {}],
    ['important', { category: 'api_contract', severity: 'important' }, {}],
    ['blocking', { category: 'api_contract', severity: 'blocking' }, { reach: REPOSITORY_REACH }],
  ];
  for (const [tier, over, verification] of cases) {
    const r = score(over, 0.72, { verification });
    assert.equal(r.severity.severity, tier, tier);
    assert.equal(r.confidenceFloor, 0.7, tier);
    assert.equal(r.eligible, true, `${tier}: ${r.rejectedBecause}`);
  }
});

test('the same candidate at 0.65 is rejected at the confidence floor', () => {
  const r = score({ category: 'correctness' }, 0.65);
  assert.equal(r.eligible, false);
  assert.equal(r.rejectedBecause, 'technical confidence 0.65 (verifier) is below 0.7, the floor for a minor finding');
});

test('a security candidate keeps the 0.8 floor, and a higher configured main floor raises it', () => {
  const held = score({ category: 'security', severity: 'blocking' }, 0.75);
  assert.equal(held.eligible, false);
  assert.equal(held.confidenceFloor, 0.8);
  assert.equal(
    held.rejectedBecause,
    'technical confidence 0.75 (verifier) is below 0.8, the floor for every tier in the security category',
  );
  assert.equal(score({ category: 'security', severity: 'blocking' }, 0.82).eligible, true);

  const raised = score(
    { category: 'security', severity: 'blocking' },
    0.85,
    { thresholds: { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.9, minorConfidence: 0.9 } },
  );
  assert.equal(raised.confidenceFloor, 0.9);
  assert.equal(raised.eligible, false);
});

test('an analyst-only candidate at 0.65 is still rejected at its own 0.7 floor', () => {
  const r = scoreCandidate(candidate({ technicalConfidence: 0.65 }), [], [], DEFAULT_THRESHOLDS);
  assert.equal(r.confidenceSource, 'analyst');
  assert.equal(r.confidenceFloor, 0.7);
  assert.equal(r.eligible, false);
  assert.match(r.rejectedBecause, /^technical confidence 0\.65 \(analyst\) is below 0\.7/);
});

function withRepo(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-479-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a policy setting 0.8 and 0.7 reproduces the old confidence gating', () =>
  withRepo('review:\n  confidence_threshold: 0.8\n  minor_confidence_threshold: 0.7\n', (dir) => {
    const loaded = loadConfig(dir, NO_BASELINE);
    assert.deepEqual(loaded.thresholds, { technicalConfidence: 0.8, minorConfidence: 0.7 });
    const thresholds = { ...OLD_FLOORS, ...loaded.thresholds };
    const at = (over, confidence) => score(over, confidence, { thresholds });
    assert.equal(at({ category: 'correctness' }, 0.72).eligible, true);
    assert.equal(at({ category: 'correctness' }, 0.65).eligible, false);
    assert.equal(at({ category: 'correctness' }, 0.65).confidenceFloor, 0.7);
    assert.equal(at({ category: 'api_contract', severity: 'important' }, 0.72).eligible, false);
    assert.equal(at({ category: 'api_contract', severity: 'important' }, 0.72).confidenceFloor, 0.8);
    assert.equal(at({ category: 'api_contract', severity: 'important' }, 0.82).eligible, true);
    assert.equal(at({ category: 'security', severity: 'blocking' }, 0.75).eligible, false);
  }));

test('a suggested fix verified at fix confidence 0.6 is not rendered; the fix gate stays 0.8', () => {
  const withFix = (fixConfidence) =>
    scoreCandidate(
      candidate({ suggestedFix: 'Read the length inside the loop.', fixConfidence: null }),
      [],
      [],
      DEFAULT_THRESHOLDS,
      verified(0.9, { fixVerdict: 'verified', fixConfidence }),
    );
  const held = withFix(0.6);
  assert.equal(held.fix.render, 'none');
  assert.equal(held.fix.withheld, 'verified fix confidence 0.60 is below the 0.8 threshold');
  assert.equal(withFix(0.8).fix.render, 'fix');
});

test('a stricter configured main floor raises the fix gate with it, as it does the exempt floor', () => {
  const strict = { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.95, minorConfidence: 0.95 };
  const withFix = (fixConfidence) =>
    scoreCandidate(
      candidate({ suggestedFix: 'Read the length inside the loop.', fixConfidence: null }),
      [],
      [],
      strict,
      verified(0.97, { fixVerdict: 'verified', fixConfidence }),
    );
  const held = withFix(0.85);
  assert.equal(held.fix.render, 'none');
  assert.equal(held.fix.withheld, 'verified fix confidence 0.85 is below the 0.95 threshold');
  assert.equal(withFix(0.96).fix.render, 'fix');
});

const precedent = (over = {}) => ({
  eventId: 'gh_1',
  repository: 'org/a',
  reviewerLogin: 'owner',
  role: 'owner',
  outcome: 'dismissed',
  createdAt: '2026-01-01T00:00:00Z',
  filePath: 'src/other.ts',
  lineStart: 10,
  excerpt: 'an unrelated remark about another subsystem altogether',
  weight: -2,
  relevance: 1,
  matchStrength: 1,
  ...over,
});

test('a verified verifier-sourced candidate under the old score gate ships, score still reported', () => {
  const r = score({ category: 'correctness' }, 0.72);
  assert.ok(r.finalScore < DEFAULT_THRESHOLDS.finalScore, `finalScore ${r.finalScore}`);
  assert.equal(typeof r.finalScore, 'number');
  assert.equal(typeof r.anchored.finalScore, 'number');
  assert.equal(r.eligible, true, r.rejectedBecause);
  assert.equal(r.rejectedBecause, null);
});

test('owner alignment below neutral rejects that candidate, with the owner-precedent reason', () => {
  const r = score({ category: 'correctness' }, 0.9, { precedents: [precedent()] });
  assert.ok(r.ownerAlignment < 0.5, `alignment ${r.ownerAlignment}`);
  assert.equal(r.eligible, false);
  assert.match(r.rejectedBecause, /owner precedent is against raising this/);
});

test('that owner-precedent hold is a gate of its own, so belowGate lists it and --promote can post it', () => {
  const r = score({ category: 'correctness' }, 0.9, { precedents: [precedent()] });
  assert.ok(r.rejectedBecause.startsWith(OWNER_PRECEDENT_PREFIX), r.rejectedBecause);
  assert.equal(gateOf(r.rejectedBecause), 'owner-precedent');
  // A question's owner-precedent rejection is unchanged: not a promotable gate.
  assert.equal(gateOf('owner precedent is against asking this (0.12 alignment), and a question ...'), null);
});

test('an analyst-only candidate below 0.68 is still rejected on score', () => {
  const r = scoreCandidate(candidate({ technicalConfidence: 0.8, evidence: ['vague'] }), [], [], DEFAULT_THRESHOLDS);
  assert.ok(r.finalScore < DEFAULT_THRESHOLDS.finalScore, `finalScore ${r.finalScore}`);
  assert.equal(r.eligible, false);
  assert.match(r.rejectedBecause, /^score 0\.\d{4} is below the 0\.68 threshold$/);
});

test('the anchored shadow is read through the owner gate for a verified claim', () => {
  const unanchored = (id) => precedent({ eventId: id, outcome: 'accepted', filePath: null, lineStart: null, weight: 2 });
  const r = scoreCandidate(
    candidate({
      evidence: ['Loop opens at line 10.', 'Length is read at line 12.', 'Items are pushed at line 14.'],
    }),
    [unanchored('e1'), unanchored('e2'), unanchored('e3'), precedent({ weight: -1.5 })],
    [],
    DEFAULT_THRESHOLDS,
    verified(0.95),
  );
  assert.equal(r.eligible, true, r.rejectedBecause);
  assert.ok(r.anchored.finalScore >= DEFAULT_THRESHOLDS.finalScore, `anchored score ${r.anchored.finalScore}`);
  assert.ok(r.anchored.ownerAlignment < 0.5, `anchored alignment ${r.anchored.ownerAlignment}`);
  assert.equal(r.anchored.wouldChangeEligibility, true);
});

const NOT_MATERIAL = { material: false, materialReason: 'nothing breaks; the delay is invisible to every caller' };

test('a verified minor judged not material is held with the materiality reason', () => {
  const r = score({ category: 'correctness' }, 0.9, { verification: NOT_MATERIAL });
  assert.equal(r.severity.severity, 'minor');
  assert.equal(r.eligible, false);
  assert.equal(
    r.rejectedBecause,
    'the verifier judged this not material: nothing breaks; the delay is invisible to every caller',
  );
  const nit = score({ category: 'maintainability', severity: 'nit' }, 0.9, { verification: NOT_MATERIAL });
  assert.equal(nit.eligible, false);
  assert.ok(nit.rejectedBecause.startsWith('the verifier judged this not material:'));
});

test('materiality needs an explicit verified: true, so an entry without it is never held or lowered', () => {
  const noVerdict = (over) =>
    scoreCandidate(candidate(over), [], [], DEFAULT_THRESHOLDS, {
      candidateId: 'cand_001',
      technicalConfidence: 0.9,
      ...NOT_MATERIAL,
      severityFit: 'too_high',
    });
  const minor = noVerdict({ category: 'correctness' });
  assert.doesNotMatch(minor.rejectedBecause ?? '', /not material/);
  const important = noVerdict({ category: 'api_contract', severity: 'important' });
  assert.equal(important.severity.severity, 'important');
});

test('a not-material minor also held by an unanchored owner precedent does not claim the anchor flips it', () => {
  const r = score({ category: 'correctness' }, 0.9, {
    verification: NOT_MATERIAL,
    precedents: [precedent({ filePath: null, lineStart: null })],
  });
  assert.equal(r.eligible, false);
  assert.match(r.rejectedBecause, /owner precedent is against raising this/);
  assert.ok(r.anchored.ownerAlignment >= 0.5, `anchored alignment ${r.anchored.ownerAlignment}`);
  assert.equal(r.anchored.wouldChangeEligibility, false);
});

test('a verified important judged not material ships as minor, and a blocking too high as important', () => {
  const important = score({ category: 'api_contract', severity: 'important' }, 0.9, { verification: NOT_MATERIAL });
  assert.equal(important.eligible, true, important.rejectedBecause);
  assert.equal(important.severity.severity, 'minor');
  assert.match(important.severity.reason, /lowered from important to minor because the verifier judged this not material/);

  const blocking = score(
    { category: 'api_contract', severity: 'blocking' },
    0.9,
    { verification: { reach: REPOSITORY_REACH, severityFit: 'too_high' } },
  );
  assert.equal(blocking.eligible, true, blocking.rejectedBecause);
  assert.equal(blocking.severity.severity, 'important');
  assert.match(blocking.severity.reason, /lowered from blocking to important because .*severity_fit: too_high/);
});

test('too_high alone lowers only important or blocking, so a verified minor stays minor', () => {
  const minor = score({ category: 'correctness', severity: 'minor' }, 0.9, { verification: { severityFit: 'too_high' } });
  assert.equal(minor.eligible, true, minor.rejectedBecause);
  assert.equal(minor.severity.severity, 'minor');
  assert.doesNotMatch(minor.severity.reason, /too_high/);
});

test('a security nit judged not material ships, and an exempt minor is only lowered', () => {
  const noExposure = { impactClass: 'no-exposure', ...NOT_MATERIAL };
  const nit = score({ category: 'security', severity: 'nit' }, 0.9, { verification: noExposure });
  assert.equal(nit.severity.severity, 'nit');
  assert.equal(nit.eligible, true, nit.rejectedBecause);
  assert.equal(nit.rejectedBecause, null);

  const minor = score({ category: 'security', severity: 'minor' }, 0.9, { verification: noExposure });
  assert.equal(minor.eligible, true, minor.rejectedBecause);
  assert.equal(minor.severity.severity, 'nit');
});

test('missing materiality fields, and an explicit right fit, change nothing', () => {
  const plain = score({ category: 'api_contract', severity: 'important' }, 0.9);
  assert.equal(plain.severity.severity, 'important');
  assert.doesNotMatch(plain.severity.reason, /not material|too_high/);
  const right = score(
    { category: 'api_contract', severity: 'important' },
    0.9,
    { verification: { material: true, materialReason: 'callers wait a full interval', severityFit: 'right' } },
  );
  assert.deepEqual(right.severity, plain.severity);
  assert.equal(right.eligible, plain.eligible);
});

test('the schema and the CLI checks accept the new fields and refuse the wrong shapes', () => {
  const schema = JSON.parse(readFileSync(join(plugin, 'schemas/verification.schema.json'), 'utf8'));
  assert.equal(schema.properties.material.type, 'boolean');
  assert.equal(schema.properties.material_reason.type, 'string');
  assert.equal(schema.properties.material_reason.maxLength, 300);
  assert.deepEqual(schema.properties.severity_fit.enum, ['right', 'too_high']);

  const base = { candidate_id: 'c1', verified: true, technical_confidence: 0.9 };
  assert.equal(
    verificationProblem([{ ...base, material: false, material_reason: 'nothing breaks', severity_fit: 'too_high' }]),
    null,
  );
  assert.equal(
    verificationProblem([{ ...base, material: true, materialReason: 'callers wait', severityFit: 'right' }]),
    null,
  );
  assert.match(verificationProblem([{ ...base, material: 'no' }]), /material must be true or false/);
  assert.match(verificationProblem([{ ...base, severity_fit: 'low' }]), /severity_fit must be one of right, too_high/);
  assert.match(verificationProblem([{ ...base, material_reason: 'x'.repeat(301) }]), /material_reason must be a string of at most 300/);
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-479-cli-'));
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

function runScore(dir, candidates, verifications, args = []) {
  const verification = join(dir, 'verification.json');
  writeFileSync(verification, JSON.stringify({ results: verifications }));
  const r = spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--min-score', '0', ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the built bundle holds a not-material minor in belowGate and --promote posts it', () =>
  withDir((dir) => {
    const verifications = [
      {
        candidate_id: 'cand_001',
        verified: true,
        technical_confidence: 0.9,
        material: false,
        material_reason: 'nothing breaks; the delay is invisible to every caller',
        severity_fit: 'right',
      },
    ];
    const held = runScore(dir, [RAW], verifications);
    const reason = 'the verifier judged this not material: nothing breaks; the delay is invisible to every caller';
    assert.deepEqual(held.eligible, []);
    assert.deepEqual(held.unverified ?? [], [], 'verified true, not material: held, not unverified');
    assert.equal(held.scores[0].rejectedBecause, reason);
    assert.equal(held.belowGate.length, 1);
    assert.equal(held.belowGate[0].candidateId, 'cand_001');
    assert.equal(held.belowGate[0].gate, 'materiality');
    assert.equal(held.belowGate[0].rejectedBecause, reason);

    const promoted = runScore(dir, [RAW], verifications, ['--promote', 'cand_001']);
    assert.equal(promoted.belowGate.length, 0);
    assert.equal(promoted.eligible.length, 1);
    assert.equal(promoted.scores[0].eligible, true);
    assert.equal(promoted.scores[0].ownerPromotion.gate, 'materiality');
    assert.equal(promoted.scores[0].ownerPromotion.heldBecause, reason);
  }));

test('the built bundle holds a verified, not-material nit in belowGate, not in unverified', () =>
  withDir((dir) => {
    const held = runScore(
      dir,
      [{ ...RAW, category: 'maintainability', severity: 'nit' }],
      [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, material: false, material_reason: 'taste only' }],
    );
    assert.deepEqual(held.eligible, []);
    assert.deepEqual(held.unverified ?? [], []);
    assert.equal(held.belowGate.length, 1);
    assert.equal(held.belowGate[0].gate, 'materiality');
    assert.equal(held.belowGate[0].rejectedBecause, 'the verifier judged this not material: taste only');
  }));

test('the init template carries the 0.7 floor, so a new config does not restore the old one', () => {
  const template = readFileSync(join(plugin, 'templates/config.example.yaml'), 'utf8');
  assert.match(template, /^\s*confidence_threshold: 0\.70$/m);
  assert.match(template, /^\s*minor_confidence_threshold: 0\.70$/m);
});

test('the built bundle reads severity_fit and reports the lower tier', () =>
  withDir((dir) => {
    const out = runScore(
      dir,
      [{ ...RAW, category: 'api_contract', severity: 'important' }],
      [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, severity_fit: 'too_high' }],
    );
    assert.equal(out.eligible.length, 1);
    assert.equal(out.eligible[0].severity, 'minor');
    assert.match(out.eligible[0].severityReason, /lowered from important to minor because .*severity_fit: too_high/);
  }));

test('the verifier brief teaches the three questions, separate from truth, and the ADR records it', () => {
  const brief = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  for (const field of ['material', 'material_reason', 'severity_fit']) {
    assert.ok(brief.includes(`\`${field}\``), field);
  }
  assert.match(brief, /Would a reasonable author change code for this\?/);
  assert.match(brief, /What breaks, and for whom\?/);
  assert.match(brief, /Materiality is not truth/);
  assert.match(brief, /never lowers your\s+`technical_confidence`/);
  assert.match(brief, /Leave all three fields out when you are unsure/);
  assert.doesNotMatch(brief, /default 0\.80/);

  const adr = readFileSync(join(root, 'docs/adr/0037-confidence-is-a-floor-materiality-is-a-verdict.md'), 'utf8');
  assert.match(adr, /0037 - Confidence is a floor, materiality is a verdict/);
  assert.ok(adr.includes('#479'));
});



