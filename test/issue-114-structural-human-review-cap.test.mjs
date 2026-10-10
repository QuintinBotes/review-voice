/**
 * Issue #114: structural evidence stays evidence by default, but a repository
 * can opt either signal into the existing ADR 0012 human-review approval cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const HEAD = 'a'.repeat(40);
const REPOSITORY = 'acme/web';
const PULL = 7;
const CLEAN = 'No actionable findings.';

function config(flags) {
  if (flags === null) return null;
  return [
    'review:',
    '  human_review:',
    '    structure:',
    `      file_line_crossing: ${flags.fileLineCrossing}`,
    `      branch_growth: ${flags.branchGrowth}`,
    '',
  ].join('\n');
}

function configIn(yaml) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-114-config-'));
  try {
    mkdirSync(join(directory, '.review-voice'));
    writeFileSync(join(directory, '.review-voice', 'config.yaml'), yaml);
    return loadConfig(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('human-review structural switches default off, accept booleans, and reject other values', () => {
  assert.deepEqual(configIn('review:\n  max_findings: 5\n').humanReview.structure, {
    fileLineCrossing: false,
    branchGrowth: false,
  });

  const enabled = configIn(
    'review:\n  human_review:\n    structure:\n      file_line_crossing: true\n      branch_growth: true\n',
  );
  assert.deepEqual(enabled.humanReview.structure, { fileLineCrossing: true, branchGrowth: true });
  assert.deepEqual(enabled.warnings, []);

  const invalid = configIn(
    'review:\n  human_review:\n    structure:\n      file_line_crossing: yes\n      branch_growth: 1\n',
  );
  assert.deepEqual(invalid.humanReview.structure, { fileLineCrossing: false, branchGrowth: false });
  assert.deepEqual(invalid.warnings, [
    'review.human_review.structure.file_line_crossing must be true or false; using the default.',
    'review.human_review.structure.branch_growth must be true or false; using the default.',
  ]);
});

const sourceLines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${index} = ${index};`).join('\n') + '\n';

function scratchRepo(flags) {
  const base = mkdtempSync(join(tmpdir(), 'rv-114-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(data);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  const humanReview = config(flags);
  if (humanReview !== null) {
    mkdirSync(join(repo, '.review-voice'));
    writeFileSync(join(repo, '.review-voice', 'config.yaml'), humanReview);
  }
  writeFileSync(join(repo, 'src/big.ts'), sourceLines(950, 'const value'));
  const steps = Array.from({ length: 10 }, (_, index) => `  step${index}(order);`);
  writeFileSync(join(repo, 'src/flow.ts'), ['export function handle(order) {', ...steps, '}', ''].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  writeFileSync(join(repo, 'src/big.ts'), sourceLines(1050, 'const value'));
  steps.splice(8, 0, '  if (order.region) applyRegion(order);', '  if (order.coupon) applyCoupon(order);', '  if (order.gift) applyGift(order);');
  writeFileSync(join(repo, 'src/flow.ts'), ['export function handle(order) {', ...steps, '}', ''].join('\n'));

  return { base, repo, data, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function diffOut(scratch) {
  const out = join(scratch.base, `out-${Math.random().toString(36).slice(2)}`);
  const result = spawnSync(process.execPath, [bundle, 'diff', '--out', out], {
    cwd: scratch.repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.data },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    summary: JSON.parse(result.stdout).summary,
    manifest: JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')),
  };
}

function withDatabase(body) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-114-db-'));
  const db = openDatabase(join(directory, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
}

function verdictFor(complexity) {
  return withDatabase(async (db) => {
    recordRun(db, {
      repository: REPOSITORY,
      baseRef: null,
      headRef: HEAD,
      pullNumber: PULL,
      diff: 'diff',
      output: CLEAN,
      complexity,
    });
    const calls = [];
    const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push(init.method ?? 'GET');
      if (/\/pulls\/\d+$/.test(path)) return response({ head: { sha: HEAD } });
      if (path.endsWith('/check-runs')) {
        return response({
          total_count: 1,
          check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-10T10:00:00Z' }],
        });
      }
      if (path.endsWith('/status')) return response({ state: 'success', total_count: 0, statuses: [] });
      return new Response('not found', { status: 404 });
    };
    const client = new GitHubClient({ allowlist: [REPOSITORY], token: 't', fetchImpl, sleep: async () => {} });
    const result = await computeVerdict({
      db,
      client,
      repository: REPOSITORY,
      pullNumber: PULL,
      head: HEAD,
      review: CLEAN,
    });
    return { output: result.output, calls };
  });
}

test('structural signals cap only enabled settings, name their reasons locally, and keep the posted review unchanged', async () => {
  const defaultScratch = scratchRepo(null);
  const explicitOffScratch = scratchRepo({ fileLineCrossing: false, branchGrowth: false });
  const fileCrossingScratch = scratchRepo({ fileLineCrossing: true, branchGrowth: false });
  const branchGrowthScratch = scratchRepo({ fileLineCrossing: false, branchGrowth: true });
  try {
    const defaultOutput = diffOut(defaultScratch);
    const explicitOffOutput = diffOut(explicitOffScratch);
    assert.equal(defaultOutput.summary.structure.sizeCrossings.length, 1);
    assert.equal(defaultOutput.summary.structure.branchGrowth.length, 1);
    assert.equal(defaultOutput.summary.complexity.level, 'normal');
    assert.deepEqual(defaultOutput.summary.complexity.reasons, []);
    assert.equal(Object.hasOwn(defaultOutput.summary.complexity.limits, 'structure'), false);
    assert.equal(defaultOutput.summary.humanReviewNote, null);
    assert.deepEqual(explicitOffOutput.summary.structure, defaultOutput.summary.structure);
    assert.deepEqual(explicitOffOutput.summary.complexity, defaultOutput.summary.complexity);
    assert.equal(explicitOffOutput.summary.humanReviewNote, defaultOutput.summary.humanReviewNote);

    const fileCrossingOutput = diffOut(fileCrossingScratch);
    assert.deepEqual(fileCrossingOutput.manifest.complexity, fileCrossingOutput.summary.complexity);
    assert.equal(fileCrossingOutput.summary.complexity.level, 'high');
    assert.match(fileCrossingOutput.summary.complexity.reasons.join('; '), /file-line crossing signal \(structure\.sizeCrossings\)/);
    assert.doesNotMatch(fileCrossingOutput.summary.complexity.reasons.join('; '), /branch-growth signal/);
    assert.match(fileCrossingOutput.summary.humanReviewNote, /file-line crossing signal \(structure\.sizeCrossings\)/);

    const branchGrowthOutput = diffOut(branchGrowthScratch);
    assert.deepEqual(branchGrowthOutput.manifest.complexity, branchGrowthOutput.summary.complexity);
    assert.equal(branchGrowthOutput.summary.complexity.level, 'high');
    assert.match(branchGrowthOutput.summary.complexity.reasons.join('; '), /branch-growth signal \(structure\.branchGrowth\)/);
    assert.doesNotMatch(branchGrowthOutput.summary.complexity.reasons.join('; '), /file-line crossing signal/);

    const normal = await verdictFor(defaultOutput.summary.complexity);
    const capped = await verdictFor(fileCrossingOutput.summary.complexity);
    assert.equal(normal.output.event, 'APPROVE');
    assert.equal(capped.output.event, 'COMMENT');
    assert.notEqual(capped.output.event, 'REQUEST_CHANGES');
    assert.equal(capped.output.action, 'post');
    assert.equal(capped.output.wouldHaveEvent, 'APPROVE');
    assert.match(capped.output.humanReviewNote, /structure\.sizeCrossings/);
    assert.deepEqual({ ...capped.output.payload, event: 'APPROVE' }, normal.output.payload);
    assert.doesNotMatch(JSON.stringify(capped.output.payload), /human|structure|crossing|branch/i);
    assert.ok(capped.calls.every((method) => method === 'GET'));
  } finally {
    defaultScratch.cleanup();
    explicitOffScratch.cleanup();
    fileCrossingScratch.cleanup();
    branchGrowthScratch.cleanup();
  }
});
