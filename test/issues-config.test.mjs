/**
 * Config and policy fixes: example keys that are read (#197), the shipped
 * baseline layer (#198) and owner-only rule activation (#203).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { resolvePolicy } from '../plugins/review-voice/src/policy/schema.ts';
import { compileProposals } from '../plugins/review-voice/src/policy/compile.ts';
import { storeEvents, corpusCoverage } from '../plugins/review-voice/src/corpus/store.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { DEFAULT_LIMITS } from '../plugins/review-voice/src/contract/limits.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const example = join(plugin, 'templates/config.example.yaml');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');

function withRepo(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issues-config-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #197
test('the shipped example config loads with no warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-example-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    execFileSync('cp', [example, join(dir, '.review-voice', 'config.yaml')]);
    assert.deepEqual(loadConfig(dir).warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown top-level key is reported', () =>
  withRepo('identity:\n  owner_reviewer: your-github-login\nbootstrap:\n  target_review_events: 5\n', (dir) => {
    const { warnings } = loadConfig(dir);
    assert.ok(warnings.some((w) => w.startsWith('bootstrap ')), warnings.join('\n'));
  }));

test('a bad threshold warns and is ignored', () =>
  withRepo('review:\n  final_score_threshold: 7\n  confidence_threshold: high\n', (dir) => {
    const config = loadConfig(dir);
    assert.deepEqual(config.thresholds, {});
    assert.equal(config.warnings.length, 2);
  }));

const CANDIDATE = {
  candidate_id: 'cand_001',
  path: 'src/retry.ts',
  line: 5,
  category: 'correctness',
  severity: 'minor',
  claim: 'The retry loop sleeps a fixed second, so a burst of failures retries in lockstep.',
  failure_mode: 'Many clients retry at the same instant and overload the service again.',
  evidence: ['src/retry.ts:5 sleeps 1000 ms on every attempt.'],
  technical_confidence: 0.9,
};

function score(dir, extra = []) {
  const patch = join(dir, 'diff.patch');
  writeFileSync(
    patch,
    ['diff --git a/src/retry.ts b/src/retry.ts', '--- a/src/retry.ts', '+++ b/src/retry.ts', '@@ -0,0 +1,10 @@',
      ...Array.from({ length: 10 }, (_, i) => `+line ${i + 1}`)].join('\n'),
  );
  const verification = join(dir, 'verification.json');
  writeFileSync(
    verification,
    JSON.stringify({ results: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9 }] }),
  );
  const r = spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--diff-file', patch, ...extra], {
    encoding: 'utf8',
    input: JSON.stringify({ candidates: [CANDIDATE] }),
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('review.final_score_threshold is the default score gate and --min-score wins', () =>
  withRepo('review:\n  final_score_threshold: 0.99\n', (dir) => {
    const gated = score(dir);
    assert.deepEqual(gated.eligible, []);
    assert.equal(gated.belowGate[0].threshold, 0.99);
    assert.equal(score(dir, ['--min-score', '0.1']).eligible.length, 1);
  }));

test('review.confidence_threshold is the default confidence gate and --min-confidence wins', () =>
  withRepo('review:\n  confidence_threshold: 0.95\n', (dir) => {
    assert.deepEqual(score(dir).eligible, []);
    assert.equal(score(dir, ['--min-confidence', '0.5']).eligible.length, 1);
  }));

// #198
test('with no approved policy the resolved limits come from the shipped baseline', () => {
  const config = loadConfig(join(tmpdir(), 'rv-no-config-dir'));
  const policy = resolvePolicy(config.layers);
  assert.ok(config.layers.some((l) => l.source === 'policies/baseline-global.yaml'));
  assert.equal(policy.maxWordsPerFinding, 40);
  assert.equal(policy.maxTotalWords, 600);
  assert.ok(policy.suppressedPatterns.length > 0);
  assert.ok(policy.priorities.some((p) => p.category === 'correctness'));
});

test('a narrower layer still tightens the baseline and cannot loosen it', () =>
  withRepo('review:\n  max_words_per_finding: 25\n  max_total_words: 5000\n', (dir) => {
    const policy = resolvePolicy(loadConfig(dir).layers);
    assert.equal(policy.maxWordsPerFinding, 25);
    assert.equal(policy.maxTotalWords, 600);
  }));

test('a missing baseline falls back to the built-in limits without a warning', () => {
  const config = loadConfig(join(tmpdir(), 'rv-no-config-dir'), NO_BASELINE);
  const policy = resolvePolicy(config.layers);
  assert.deepEqual(config.warnings, []);
  assert.equal(policy.maxWordsPerFinding, DEFAULT_LIMITS.maxWordsPerFinding);
  assert.equal(policy.maxTotalWords, DEFAULT_LIMITS.maxTotalWords);
  assert.deepEqual(policy.suppressedPatterns, []);
});

// #203
function seedFeedback(db, actors) {
  const output = { findings: [{ findingId: 'f1', path: 'a.ts', category: 'naming', severity: 'minor' }] };
  actors.forEach((actor, i) => {
    const run = `run${i}`;
    db.prepare(
      `INSERT INTO review_runs (review_run_id, diff_hash, active_policy_versions_json, retrieved_precedents_json,
         candidates_json, output_json, created_at) VALUES (?, 'h', '[]', '[]', '[]', ?, '2026-01-01T00:00:00Z')`,
    ).run(run, JSON.stringify(output));
    db.prepare(
      `INSERT INTO feedback (feedback_id, review_run_id, finding_id, action, actor, created_at)
       VALUES (?, ?, 'f1', 'dismiss', ?, '2026-01-01T00:00:00Z')`,
    ).run(`fb${i}`, run, actor);
  });
}

test('teammate-only feedback does not activate a rule; the owner supplies the signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-activation-'));
  const db = openDatabase(join(dir, 'rv.db'));
  try {
    seedFeedback(db, ['teammate', 'teammate', 'teammate']);
    const [blocked] = compileProposals(db);
    assert.equal(blocked.activatable, false);
    assert.equal(blocked.blockedBecause, 'no owner signal');

    seedFeedback(db, []);
    db.prepare("UPDATE feedback SET actor = 'owner' WHERE feedback_id = 'fb0'").run();
    const [allowed] = compileProposals(db);
    assert.equal(allowed.evidence.ownerSignals, 1);
    assert.equal(allowed.activatable, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const event = (login, id) => ({
  eventId: id,
  source: 'github',
  repository: 'acme/web',
  pullNumber: 1,
  pullRequestUrl: 'https://github.com/acme/web/pull/1',
  commentId: id,
  reviewerLogin: login,
  role: 'owner',
  createdAt: '2026-01-01T00:00:00Z',
  bodyRedacted: `comment ${id}`,
  filePath: 'a.ts',
  lineStart: 1,
  contentKey: `key-${id}`,
  redactionVersion: '1',
  redactionCounts: {},
});

test('pooled teammate events alone do not satisfy the owner signal; an owner event does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-coverage-'));
  const db = openDatabase(join(dir, 'rv.db'));
  const warns = () =>
    corpusCoverage(db, { ownerReviewer: 'Your-GitHub-Login' }).warnings.some((w) => w.startsWith('No events authored by the owner reviewer'));
  try {
    storeEvents(db, [event('teammate-login', 'e1')]);
    assert.equal(warns(), true);
    storeEvents(db, [event('your-github-login', 'e2')]);
    assert.equal(warns(), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
