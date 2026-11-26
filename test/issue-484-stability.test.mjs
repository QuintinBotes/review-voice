/**
 * Issue #484: `evaluate calibration --stability <k>` re-verifies a fixed set
 * of candidates k times with no cache. Every verifier here is a fake: no
 * model, no network, no spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { loadStoredRuns } from '../plugins/review-voice/src/evaluate/calibration.ts';
import { runStability } from '../plugins/review-voice/src/evaluate/stability.ts';
import { DEFAULT_THRESHOLDS } from '../plugins/review-voice/src/scoring/score.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;

const IDS = ['A', 'B', 'C', 'D'];

/** Four stored candidates, each correctness/minor with a stored final score of 0.75. */
function seed(db) {
  const candidates = IDS.map((id, index) => ({
    candidate_id: id, candidateId: id, path: `src/${id}.ts`, line: index + 1, category: 'correctness', claim: `Claim ${id}.`, severity: 'minor', lane: 'diff',
  }));
  const scores = IDS.map((id, index) => ({
    candidateId: id, candidate_id: id, path: `src/${id}.ts`, line: index + 1, technicalConfidence: 0.85, verifiedConfidence: 0.85,
    confidenceSource: 'verifier', severity: { severity: 'minor', reason: 'fixture' }, finalScore: 0.75, eligible: true,
    rejectedBecause: null, verified: true, category: 'correctness', claim: `Claim ${id}.`,
  }));
  const { reviewRunId } = recordRun(db, { repository: 'org/a', baseRef: null, headRef: 'aaa111', pullNumber: 1, diff: 'd', output: 'No actionable findings.', candidates, scores });
  return reviewRunId;
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-484-'));
  try {
    const db = openDatabase(join(dir, 'review-voice.db'));
    let run;
    let stored;
    try {
      run = seed(db);
      stored = loadStoredRuns(db).flatMap((r) => r.candidates);
    } finally {
      db.close();
    }
    return fn(dir, run, stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A verifier that returns `sequences[candidate][attempt]` ({c, v?}), counts its
 * calls, and consults a pre-seeded cache of 0.99 unless told `useCache: false`.
 */
function fakeVerifier(sequences) {
  const seen = { calls: 0, cacheReads: 0, cacheHits: 0, options: [] };
  const cache = new Map(IDS.map((id) => [id, { technicalConfidence: 0.99, verified: true }]));
  const verify = async (candidate, attempt, options) => {
    seen.calls += 1;
    seen.options.push(options);
    if (options.useCache !== false) {
      seen.cacheReads += 1;
      const hit = cache.get(candidate.candidateId);
      if (hit) {
        seen.cacheHits += 1;
        return hit;
      }
    }
    const step = sequences[candidate.candidateId][attempt];
    return { technicalConfidence: step.c, verified: step.v ?? true };
  };
  return { verify, seen };
}

const SEQUENCES = {
  A: [{ c: 0.75 }, { c: 0.8 }, { c: 0.75 }, { c: 0.8 }],
  B: [{ c: 0.5 }, { c: 0.9 }, { c: 0.9 }, { c: 0.9 }],
  C: [{ c: 0.9 }, { c: 0.9 }, { c: 0.9 }, { c: 0.9 }],
  D: [{ c: 0.9 }, { c: 0.9, v: false }, { c: 0.9 }, { c: 0.9 }],
};

test('stability makes no cached verifier call: no cache read, no hit, k x n verifier calls', async () => {
  await withStore(async (_dir, _run, stored) => {
    const { verify, seen } = fakeVerifier(SEQUENCES);
    const report = await runStability(stored, { k: 4, verify, current: DEFAULT_THRESHOLDS });
    assert.equal(seen.cacheReads, 0);
    assert.equal(seen.cacheHits, 0);
    assert.equal(seen.calls, 16);
    assert.ok(seen.options.every((o) => o.useCache === false));
    assert.equal(report.calls, 16);
    assert.equal(report.expectedCalls, 16);
    // A cached 0.99 would have shown up as the confidence of a run.
    assert.ok(report.rows.every((row) => row.confidences.every((value) => value !== 0.99)));
  });
});

test('the spread and flip rate match a known sequence exactly, under both threshold sets', async () => {
  await withStore(async (_dir, _run, stored) => {
    const { verify } = fakeVerifier(SEQUENCES);
    const proposed = { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.78, minorConfidence: 0.78 };
    const report = await runStability(stored, { k: 4, verify, current: DEFAULT_THRESHOLDS, proposed });
    const row = (id) => report.rows.find((r) => r.candidate_id === id);
    assert.deepEqual([row('A').min, row('A').max, row('A').stddev], [0.75, 0.8, 0.025]);
    assert.deepEqual([row('B').min, row('B').max, row('B').stddev], [0.5, 0.9, 0.173205]);
    assert.deepEqual([row('C').min, row('C').max, row('C').stddev], [0.9, 0.9, 0]);
    // A never crosses 0.7; B does; C never; D flips on a verifier rejection.
    assert.deepEqual(
      report.rows.map((r) => r.flips.current),
      [false, true, false, true],
    );
    assert.deepEqual(report.flipRate.current, { flipped: 2, of: 4, rate: 0.5 });
    // At 0.78 A crosses between 0.75 and 0.80 as well.
    assert.deepEqual(report.flipRate.proposed, { flipped: 3, of: 4, rate: 0.75 });
  });
});

test('a failed verification is counted and a candidate with none is excluded, not scored', async () => {
  await withStore(async (_dir, _run, stored) => {
    const verify = async (candidate, attempt) =>
      candidate.candidateId === 'A' ? null : { technicalConfidence: attempt === 0 ? 0.6 : 0.9, verified: true };
    const report = await runStability(stored, { k: 2, verify, current: DEFAULT_THRESHOLDS });
    assert.equal(report.failedCalls, 2);
    assert.deepEqual(report.excluded, [{ run: stored[0].run, candidate_id: 'A', reason: 'no verification succeeded' }]);
    assert.deepEqual(report.flipRate.current, { flipped: 3, of: 3, rate: 1 });
  });
});

/** Runs the bundle with the fake agent runner; returns its result and the verifier calls made. */
function cli(dir, args, fakeAgents) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir, REVIEW_VOICE_FAKE_AGENTS: fakeAgents },
  });
  const counter = join(fakeAgents, '.calls', 'evidence-verifier.count');
  return { code: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '', calls: existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0 };
}

function withLabelsAndFakes(fn) {
  return withStore((dir, run) => {
    const labels = join(dir, 'labels.json');
    writeFileSync(labels, JSON.stringify(IDS.map((id) => ({ run, candidate_id: id, label: '' }))));
    const fakes = join(dir, 'fakes');
    mkdirSync(fakes);
    writeFileSync(
      join(fakes, 'evidence-verifier.json'),
      JSON.stringify({ output: { verifications: [{ candidate_id: 'A', verified: true, technical_confidence: 0.8 }] } }),
    );
    return fn(dir, labels, fakes);
  });
}

test('the command prints k x candidates and refuses above the cap without --confirm, before any call', () => {
  withLabelsAndFakes((dir, labels, fakes) => {
    const refused = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '51'], fakes);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /51 runs x 4 candidates = 204 model calls/);
    assert.match(refused.stderr, /Refusing: 204 calls is above evaluate\.stability_max_calls \(200\)\. Pass --confirm/);
    assert.equal(refused.calls, 0);
    assert.equal(refused.stdout, '');

    const confirmed = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '51', '--confirm'], fakes);
    assert.equal(confirmed.code, 0);
    assert.match(confirmed.stderr, /204 model calls/);
    assert.equal(confirmed.calls, 204);
    assert.equal(JSON.parse(confirmed.stdout).expectedCalls, 204);
  });
});

test('under the cap it runs with no --confirm, and the flags are validated', () => {
  withLabelsAndFakes((dir, labels, fakes) => {
    const ok = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '3'], fakes);
    assert.equal(ok.code, 0);
    assert.match(ok.stderr, /3 runs x 4 candidates = 12 model calls/);
    assert.equal(ok.calls, 12);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.rows.find((r) => r.candidate_id === 'A').stddev, 0);
    assert.equal(cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '1'], fakes).code, 2);
    assert.equal(cli(dir, ['evaluate', 'calibration', '--labels', labels, '--confirm'], fakes).code, 2);
  });
});

test('the cap is a config setting with a default, and a bad value warns and keeps the default', () => {
  const load = (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-484-config-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), text);
      return loadConfig(dir, NO_BASELINE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(load('identity: {}\n').evaluate.stabilityMaxCalls, 200);
  assert.equal(load('evaluate:\n  stability_max_calls: 40\n').evaluate.stabilityMaxCalls, 40);
  const bad = load('evaluate:\n  stability_max_calls: 0\n');
  assert.equal(bad.evaluate.stabilityMaxCalls, 200);
  assert.ok(bad.warnings.some((w) => w.includes('evaluate.stability_max_calls')));
});

test('the help documents --stability, --confirm and the cap', () => {
  const help = commandHelp('evaluate');
  assert.match(help, /--stability <k>/);
  assert.match(help, /--confirm/);
  assert.match(help, /evaluate\.stability_max_calls/);
});
