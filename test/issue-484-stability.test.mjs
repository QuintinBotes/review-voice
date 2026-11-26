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
import { stabilityCommand } from '../plugins/review-voice/src/cli/evaluate.ts';
import { runStability } from '../plugins/review-voice/src/evaluate/stability.ts';
import { DEFAULT_THRESHOLDS } from '../plugins/review-voice/src/scoring/score.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;

const IDS = ['A', 'B', 'C', 'D'];
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** Four stored candidates, each correctness/minor with a stored final score of 0.75. */
function seed(db, headRef) {
  const candidates = IDS.map((id, index) => ({
    candidate_id: id, candidateId: id, path: `src/${id}.ts`, line: index + 1, category: 'correctness', claim: `Claim ${id}.`, severity: 'minor', lane: 'diff',
  }));
  const scores = IDS.map((id, index) => ({
    candidateId: id, candidate_id: id, path: `src/${id}.ts`, line: index + 1, technicalConfidence: 0.85, verifiedConfidence: 0.85,
    confidenceSource: 'verifier', severity: { severity: 'minor', reason: 'fixture' }, finalScore: 0.75, eligible: true,
    rejectedBecause: null, verified: true, category: 'correctness', claim: `Claim ${id}.`,
  }));
  const { reviewRunId } = recordRun(db, { repository: 'org/a', baseRef: null, headRef, pullNumber: 1, diff: 'd', output: 'No actionable findings.', candidates, scores });
  return reviewRunId;
}

/** A checkout in `dir/repo` with one commit; returns its HEAD sha. */
function makeCheckout(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', [...COMMIT, ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  return git('rev-parse', 'HEAD');
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-484-'));
  try {
    const head = makeCheckout(dir);
    const db = openDatabase(join(dir, 'review-voice.db'));
    let run;
    let stored;
    try {
      run = seed(db, head);
      stored = loadStoredRuns(db).flatMap((r) => r.candidates);
    } finally {
      db.close();
    }
    const result = fn(dir, run, stored);
    // An async body must finish before the directory goes.
    if (typeof result?.then === 'function') return result.finally(() => rmSync(dir, { recursive: true, force: true }));
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
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

test('a stored non-threshold hold is never a post or a flip, however the confidence moves', async () => {
  await withStore(async (_dir, _run, stored) => {
    const held = (id, rejectedBecause, gate) => ({
      ...stored[0],
      candidateId: id,
      breakdown: { ...stored[0].breakdown, eligible: false, rejectedBecause, gate },
    });
    const candidates = [
      held('E', 'not material: the change is cosmetic', 'materiality'),
      held('F', 'owner precedent is against asking this (0.30 alignment)', 'owner-precedent'),
    ];
    let attempt = 0;
    const verify = async () => ({ technicalConfidence: [0.5, 0.95][attempt++ % 2], verified: true });
    const report = await runStability(candidates, {
      k: 2,
      verify,
      current: DEFAULT_THRESHOLDS,
      proposed: { ...DEFAULT_THRESHOLDS, technicalConfidence: 0.9 },
      concurrency: 1,
    });
    assert.deepEqual(report.rows.map((row) => row.flips), [{ current: false, proposed: false }, { current: false, proposed: false }]);
    assert.deepEqual(report.flipRate.current, { flipped: 0, of: 2, rate: 0 });
  });
});

test('calls are dispatched concurrently, bounded, with results kept in attempt order', async () => {
  await withStore(async (_dir, _run, stored) => {
    let inFlight = 0;
    let peak = 0;
    const verify = async (_candidate, attempt) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { technicalConfidence: 0.7 + attempt / 100, verified: true };
    };
    const report = await runStability(stored, { k: 4, verify, current: DEFAULT_THRESHOLDS, concurrency: 3 });
    assert.ok(peak > 1, `peak ${peak}`);
    assert.ok(peak <= 3, `peak ${peak}`);
    assert.deepEqual(report.rows[0].confidences, [0.7, 0.71, 0.72, 0.73]);
  });
});

/** Runs the bundle with the fake agent runner; returns its result and the verifier calls made. */
function cli(dir, args, fakeAgents) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    cwd: join(dir, 'repo'),
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
      JSON.stringify({ output: { verifications: IDS.map((id) => ({ candidate_id: id, verified: true, technical_confidence: 0.8 })) } }),
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

test('a verifier answering with another candidate id is a failed call, not a stand-in', () => {
  withLabelsAndFakes((dir, labels, fakes) => {
    writeFileSync(
      join(fakes, 'evidence-verifier.json'),
      JSON.stringify({ output: { verifications: [{ candidate_id: 'ZZ', verified: true, technical_confidence: 0.9 }] } }),
    );
    const result = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '2'], fakes);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedCalls, 8);
    assert.equal(report.rows.length, 0);
    assert.equal(report.excluded.length, 4);
  });
});

test('a working directory at another head, or candidates from two heads, are refused with no call', () => {
  withLabelsAndFakes((dir, labels, fakes) => {
    execFileSync('git', [...COMMIT, 'commit', '-q', '--allow-empty', '-m', 'y'], { cwd: join(dir, 'repo') });
    const moved = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '2'], fakes);
    assert.equal(moved.code, 2);
    assert.match(moved.stderr, /Refusing: the working directory is at [0-9a-f]{40}, but the candidates were found at [0-9a-f]{40}\. Check out [0-9a-f]{40} and run again/);
    assert.equal(moved.calls, 0);
  });
  withLabelsAndFakes((dir, labels, fakes) => {
    const db = openDatabase(join(dir, 'review-voice.db'));
    let second;
    try {
      second = seed(db, 'bbb222');
    } finally {
      db.close();
    }
    const entries = JSON.parse(readFileSync(labels, 'utf8'));
    writeFileSync(labels, JSON.stringify([entries[0], { run: second, candidate_id: 'A', label: '' }]));
    const result = cli(dir, ['evaluate', 'calibration', '--labels', labels, '--stability', '2'], fakes);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /do not share one repository and recorded head/);
    assert.equal(result.calls, 0);
  });
});

test('duplicate blank rows are refused before any call, and unmatched labels are listed', () => {
  withLabelsAndFakes((dir, labels, fakes) => {
    const entries = JSON.parse(readFileSync(labels, 'utf8'));
    const dup = join(dir, 'dup.json');
    writeFileSync(dup, JSON.stringify([...entries, entries[0]]));
    const refused = cli(dir, ['evaluate', 'calibration', '--labels', dup, '--stability', '2'], fakes);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /candidate_id A of run .* is listed more than once/);
    assert.equal(refused.calls, 0);

    const extra = join(dir, 'extra.json');
    writeFileSync(extra, JSON.stringify([...entries, { run: entries[0].run, candidate_id: 'NOPE', label: '' }]));
    const listed = cli(dir, ['evaluate', 'calibration', '--labels', extra, '--stability', '2'], fakes);
    assert.equal(listed.code, 0);
    assert.match(listed.stderr, /Unmatched label .* NOPE: not in the store/);
    const report = JSON.parse(listed.stdout);
    assert.deepEqual(report.unmatched.map((u) => u.candidate_id), ['NOPE']);
    assert.equal(report.candidates, 4);
    assert.equal(listed.calls, 8);
  });
});

test('a configured cap of 5 refuses above it and runs at it, through stabilityCommand', async () => {
  await withStore(async (dir, run, stored) => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.review-voice'));
    writeFileSync(join(repo, '.review-voice', 'config.yaml'), 'evaluate:\n  stability_max_calls: 5\n');
    const config = loadConfig(repo, NO_BASELINE);
    assert.equal(config.evaluate.stabilityMaxCalls, 5);
    const labels = [{ run, candidate_id: 'A', label: '' }, { run, candidate_id: 'B', label: '' }];
    const { verify, seen } = fakeVerifier(SEQUENCES);
    const head = stored[0].headRef;
    const errors = [];
    const realError = console.error;
    const realLog = console.log;
    const previousDir = process.env.REVIEW_VOICE_DATA_DIR;
    process.env.REVIEW_VOICE_DATA_DIR = dir;
    console.error = (line) => errors.push(String(line));
    console.log = () => {};
    try {
      const refused = await stabilityCommand(['--stability', '3'], labels, null, null, { verify, config, headOf: () => head });
      assert.equal(refused, 2);
      assert.equal(seen.calls, 0);
      assert.match(errors.join('\n'), /3 runs x 2 candidates = 6 model calls \(cap 5 without --confirm\)/);
      assert.match(errors.join('\n'), /above evaluate\.stability_max_calls \(5\)/);
      const at = await stabilityCommand(['--stability', '2'], labels, null, null, { verify, config, headOf: () => head });
      assert.equal(at, 0);
      assert.equal(seen.calls, 4);
    } finally {
      console.error = realError;
      console.log = realLog;
      if (previousDir === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
      else process.env.REVIEW_VOICE_DATA_DIR = previousDir;
    }
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
  assert.ok(load('evaluate: 5\n').warnings.includes('evaluate must be a mapping; using the defaults.'));
});

test('the help documents --stability, --confirm and the cap', () => {
  const help = commandHelp('evaluate');
  assert.match(help, /--stability <k>/);
  assert.match(help, /--confirm/);
  assert.match(help, /evaluate\.stability_max_calls/);
});
