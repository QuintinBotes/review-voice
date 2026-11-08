/**
 * S11: a repository may opt in to holding approval when a change removes a
 * control (`review.human_review.structure.removed_controls`), the third signal
 * beside `file_line_crossing` and `branch_growth` (docs/adr/0020). The cap is a
 * local note; nothing about it is posted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStructureHumanReviewCap, DEFAULT_HUMAN_REVIEW } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const HEAD = 'b'.repeat(40);
const REPOSITORY = 'acme/web';
const PULL = 9;
const CLEAN = 'No actionable findings.';

const normal = () => ({ level: 'normal', reasons: [], decisionPoints: 3, densestHunk: null, limits: { maxDecisionPoints: 40, maxHunkDecisionPoints: 15 } });
const control = (path = 'src/control.ts', line = 2, kind = 'guard') => ({ path, line, kind, text: '  if (!permission) stop();', deletedFile: false });
const quiet = { sizeCrossings: [], branchGrowth: [] };
const ON = { structure: { removedControls: true } };

// ---- applyStructureHumanReviewCap ---------------------------------------------------

test('switch on, a removed control: the level is high and the reason names the signal and the entry', () => {
  const result = applyStructureHumanReviewCap(normal(), { ...quiet, removedControls: [control()] }, ON);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.reasons, ['removed-control signal (structure.removedControls): src/control.ts:2 (guard)']);
  assert.equal(result.decisionPoints, 3, 'the rest of the assessment is kept');
});

test('switch on, nothing removed: the same assessment object comes back', () => {
  const assessment = normal();
  assert.equal(applyStructureHumanReviewCap(assessment, { ...quiet, removedControls: [] }, ON), assessment);
});

test('switch off or left at its default: the same object, whatever was removed', () => {
  const assessment = normal();
  const signals = { ...quiet, removedControls: [control(), control('src/b.ts', 9, 'middleware')] };
  for (const partial of [undefined, {}, { structure: {} }, { structure: { removedControls: false } }, { structure: { fileLineCrossing: true, branchGrowth: true } }]) {
    assert.equal(applyStructureHumanReviewCap(assessment, signals, partial), assessment, JSON.stringify(partial));
  }
  assert.equal(DEFAULT_HUMAN_REVIEW.structure.removedControls, false);
});

test('a long list is cut to three entries and a count, as the other signals are', () => {
  const many = Array.from({ length: 5 }, (_, index) => control(`src/f${index}.ts`, index + 1, 'allowlist-entry'));
  const [reason] = applyStructureHumanReviewCap(normal(), { ...quiet, removedControls: many }, ON).reasons;
  assert.equal(reason, 'removed-control signal (structure.removedControls): src/f0.ts:1 (allowlist-entry), src/f1.ts:2 (allowlist-entry), src/f2.ts:3 (allowlist-entry), +2 more');
});

test('the three signals are independent: only the enabled ones add a reason', () => {
  const signals = {
    sizeCrossings: [{ path: 'src/big.ts', baseLines: 900, headLines: 1010, threshold: 1000 }],
    branchGrowth: [],
    removedControls: [control()],
  };
  const only = applyStructureHumanReviewCap(normal(), signals, { structure: { fileLineCrossing: true } });
  assert.equal(only.reasons.length, 1);
  assert.match(only.reasons[0], /^file-line crossing signal/);
  const both = applyStructureHumanReviewCap(normal(), signals, { structure: { fileLineCrossing: true, removedControls: true } });
  assert.equal(both.level, 'high');
  assert.equal(both.reasons.length, 2);
  assert.match(both.reasons[1], /^removed-control signal/);
});

// ---- configuration -------------------------------------------------------------------

function configIn(yaml) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-removed-cap-config-'));
  try {
    mkdirSync(join(directory, '.review-voice'));
    writeFileSync(join(directory, '.review-voice', 'config.yaml'), yaml);
    return loadConfig(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const withSwitch = (value) => `review:\n  human_review:\n    structure:\n      removed_controls: ${value}\n`;

test('removed_controls loads as true or false, and defaults to false', () => {
  const on = configIn(withSwitch('true'));
  assert.equal(on.humanReview.structure.removedControls, true);
  assert.deepEqual(on.warnings, []);
  assert.equal(on.humanReview.structure.fileLineCrossing, false);
  const off = configIn(withSwitch('false'));
  assert.equal(off.humanReview.structure.removedControls, false);
  assert.deepEqual(off.warnings, []);
  assert.equal(configIn('review:\n  max_findings: 5\n').humanReview.structure.removedControls, false);
});

test('a value that is not a boolean warns and keeps the default', () => {
  for (const value of ['yes', '1', '"true"', '[true]']) {
    const config = configIn(withSwitch(value));
    assert.equal(config.humanReview.structure.removedControls, false, value);
    assert.deepEqual(config.warnings, ['review.human_review.structure.removed_controls must be true or false; using the default.'], value);
  }
});

// ---- the verdict ---------------------------------------------------------------------

const GUARD = '  if (!permission) stop();';

/** A repository whose working tree deletes a file holding a guard; `switchValue` null leaves the config out. */
function scratchRepo(switchValue) {
  const base = mkdtempSync(join(tmpdir(), 'rv-removed-cap-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(data);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  if (switchValue !== null) {
    mkdirSync(join(repo, '.review-voice'));
    writeFileSync(join(repo, '.review-voice', 'config.yaml'), withSwitch(switchValue));
  }
  writeFileSync(join(repo, 'src/control.ts'), `export function run(permission) {\n${GUARD}\n  work();\n}\n`);
  writeFileSync(join(repo, 'src/other.ts'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  rmSync(join(repo, 'src/control.ts'));
  return { base, repo, data, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function diffOut(scratch) {
  const out = join(scratch.base, 'out');
  const result = spawnSync(process.execPath, [bundle, 'diff', '--out', out], {
    cwd: scratch.repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.data },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  const manifest = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
  assert.deepEqual(manifest.complexity, summary.complexity);
  return { summary, manifest };
}

async function verdictFor(complexity) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-removed-cap-db-'));
  const db = openDatabase(join(directory, 'review-voice.db'));
  try {
    recordRun(db, { repository: REPOSITORY, baseRef: null, headRef: HEAD, pullNumber: PULL, diff: 'diff', output: CLEAN, complexity });
    const calls = [];
    const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push(init.method ?? 'GET');
      if (/\/pulls\/\d+$/.test(path)) return response({ head: { sha: HEAD } });
      if (path.endsWith('/check-runs')) {
        return response({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-10T10:00:00Z' }] });
      }
      if (path.endsWith('/status')) return response({ state: 'success', total_count: 0, statuses: [] });
      return new Response('not found', { status: 404 });
    };
    const client = new GitHubClient({ allowlist: [REPOSITORY], token: 't', fetchImpl, sleep: async () => {} });
    const result = await computeVerdict({ db, client, repository: REPOSITORY, pullNumber: PULL, head: HEAD, review: CLEAN });
    return { output: result.output, calls };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a clean change that removes a control is COMMENT with the switch on and APPROVE with it off; the posted review is the same', async () => {
  const off = scratchRepo(null);
  const explicitOff = scratchRepo('false');
  const on = scratchRepo('true');
  try {
    const offOut = diffOut(off);
    assert.equal(offOut.summary.structure.removedControls.length, 1);
    assert.equal(offOut.summary.complexity.level, 'normal');
    assert.deepEqual(offOut.summary.complexity.reasons, []);
    assert.equal(offOut.summary.humanReviewNote, null);
    const explicitOffOut = diffOut(explicitOff);
    assert.deepEqual(explicitOffOut.summary.complexity, offOut.summary.complexity);
    assert.equal(explicitOffOut.summary.humanReviewNote, null);

    const onOut = diffOut(on);
    assert.equal(onOut.summary.complexity.level, 'high');
    assert.match(onOut.summary.complexity.reasons.join('; '), /removed-control signal \(structure\.removedControls\): src\/control\.ts:\d+ \(guard\)/);
    assert.match(onOut.summary.humanReviewNote, /structure\.removedControls/);
    assert.deepEqual(onOut.summary.structure.removedControls, offOut.summary.structure.removedControls, 'the evidence is the same either way');

    const approved = await verdictFor(offOut.summary.complexity);
    const held = await verdictFor(onOut.summary.complexity);
    assert.equal(approved.output.event, 'APPROVE');
    assert.equal(held.output.event, 'COMMENT');
    assert.equal(held.output.wouldHaveEvent, 'APPROVE');
    assert.match(held.output.humanReviewNote, /structure\.removedControls/);
    // Nothing about the cap reaches the review that would be posted.
    assert.deepEqual({ ...held.output.payload, event: 'APPROVE' }, approved.output.payload);
    assert.doesNotMatch(JSON.stringify(held.output.payload), /human|structure|removed|control/i);
    assert.ok(held.calls.every((method) => method === 'GET'));
  } finally {
    off.cleanup();
    explicitOff.cleanup();
    on.cleanup();
  }
});
