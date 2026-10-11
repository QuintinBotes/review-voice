/**
 * A high-complexity change is never approved by Review Voice (docs/adr/0012):
 * the assessment from `diff --out`, its record with the run, and the cap it
 * puts on the verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assessComplexity, DEFAULT_TEST_PATHS, humanReviewNote, parseComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;

// ---- the assessment --------------------------------------------------------

const file = (path, extra = {}) => ({
  path,
  status: 'modified',
  class: 'source',
  language: 'typescript',
  additions: 1,
  deletions: 0,
  reviewed: true,
  ...extra,
});

/** A one-file diff whose added lines are `added`, in a single hunk starting at `start`. */
function patch(path, added, { start = 1, removed = [] } = {}) {
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +${start},${added.length} @@`,
    ...body,
    '',
  ].join('\n');
}

const NONE = { sensitivePaths: [] };

test('decision points are counted per added line: keywords, && and ||, and a spaced ternary', () => {
  const diff = patch('src/a.ts', [
    'if (a && b) {',
    '} else if (c || d) {',
    'for (const x of xs) while (y) {}',
    'const v = ok ? 1 : 2;',
    'switch (k) { case 1: break; }',
    'try {} catch (e) {}',
  ]);
  const result = assessComplexity(diff, [file('src/a.ts')], NONE);
  // if, &&  |  if, ||  |  for, while  |  ?  |  case  |  catch
  assert.equal(result.decisionPoints, 2 + 2 + 2 + 1 + 1 + 1);
});

test('else if counts once, and ?. ?? and an optional ?: do not count', () => {
  const diff = patch('src/a.ts', ['} else if (a) {', 'const x = a?.b ?? c;', 'function f(p?: string) {}']);
  assert.equal(assessComplexity(diff, [file('src/a.ts')], NONE).decisionPoints, 1);
});

test('comments, removed lines, non-source and unreviewed files are not counted', () => {
  const comments = patch('src/a.ts', ['// if (a && b)', '# while true', ' * if the list is empty', '/* for each */', '-- if it is null']);
  assert.equal(assessComplexity(comments, [file('src/a.ts')], NONE).decisionPoints, 0);

  const removed = patch('src/a.ts', ['const a = 1;'], { removed: ['if (a && b) {', 'while (x) {'] });
  assert.equal(assessComplexity(removed, [file('src/a.ts')], NONE).decisionPoints, 0);

  const branchy = patch('docs/a.md', ['if (a && b)']);
  assert.equal(assessComplexity(branchy, [file('docs/a.md', { class: 'docs' })], NONE).decisionPoints, 0);
  assert.equal(
    assessComplexity(patch('src/a.ts', ['if (a)']), [file('src/a.ts', { reviewed: false })], NONE).decisionPoints,
    0,
  );
});

test('an added line that begins with ++ is still a line of its hunk', () => {
  const diff = patch('src/a.ts', ['++ if (a && b)']);
  assert.equal(assessComplexity(diff, [file('src/a.ts')], NONE).decisionPoints, 2);
});

test('the limits are strict: at the limit is normal, one over is high', () => {
  const lines = (n) => Array.from({ length: n }, () => 'if (a) {}');
  const files = [file('src/a.ts')];
  const atLimit = assessComplexity(patch('src/a.ts', lines(5)), files, { ...NONE, maxDecisionPoints: 5, maxHunkDecisionPoints: 5 });
  assert.equal(atLimit.level, 'normal');
  assert.deepEqual(atLimit.reasons, []);

  const wholeChange = assessComplexity(patch('src/a.ts', lines(6)), files, { ...NONE, maxDecisionPoints: 5, maxHunkDecisionPoints: 99 });
  assert.equal(wholeChange.level, 'high');
  assert.deepEqual(wholeChange.reasons, ['6 decision points added (limit 5)']);

  const oneHunk = assessComplexity(patch('src/a.ts', lines(6)), files, { ...NONE, maxDecisionPoints: 99, maxHunkDecisionPoints: 5 });
  assert.equal(oneHunk.level, 'high');
  assert.match(oneHunk.reasons[0], /6 decision points in one hunk at src\/a\.ts:1 \(limit 5\)/);
});

test('the densest hunk is reported with its path and new-side start line', () => {
  const diff = [
    patch('src/a.ts', ['if (a) {}'], { start: 3 }),
    patch('src/b.ts', ['if (a && b && c) {}', 'while (x) {}'], { start: 40 }),
  ].join('');
  const result = assessComplexity(diff, [file('src/a.ts'), file('src/b.ts')], NONE);
  assert.deepEqual(result.densestHunk, { path: 'src/b.ts', line: 40, decisionPoints: 4 });
  assert.equal(result.decisionPoints, 5);
});

test('sensitive paths match unreviewed and renamed files, at the root and nested', () => {
  const files = [
    file('migrations/001.sql', { class: 'other', reviewed: false }),
    file('db/migrations/002.sql', { class: 'other' }),
    file('.github/workflows/ci.yml', { class: 'config', reviewed: false }),
    file('src/billing.ts', { status: 'renamed', previousPath: 'src/auth/billing.ts' }),
    file('src/plain.ts'),
  ];
  const result = assessComplexity('', files);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.sensitivePaths, [
    '.github/workflows/ci.yml',
    'db/migrations/002.sql',
    'migrations/001.sql',
    'src/auth/billing.ts',
  ]);
  assert.match(result.reasons[0], /^touches sensitive paths \(.github\/workflows\/ci\.yml matched \.github\/workflows\/\*\*, db\/migrations\/002\.sql matched \*\*\/migrations\/\*\*, migrations\/001\.sql matched \*\*\/migrations\/\*\*, \+1 more\)$/);
});

test('an empty configured list disables the signal, a configured list replaces the defaults', () => {
  const files = [file('src/auth/login.ts'), file('docs/payments/x.ts')];
  assert.equal(assessComplexity('', files, { sensitivePaths: [] }).level, 'normal');
  const custom = assessComplexity('', files, { sensitivePaths: ['docs/payments/**'] });
  assert.deepEqual(custom.sensitivePaths, ['docs/payments/x.ts']);
  assert.equal(assessComplexity('', [file('src/plain.ts')]).level, 'normal');
});

test('the note is null unless high, and is one line naming the reasons', () => {
  assert.equal(humanReviewNote(null), null);
  assert.equal(humanReviewNote(assessComplexity('', [file('src/plain.ts')])), null);
  const note = humanReviewNote(assessComplexity('', [file('src/auth/a.ts')]));
  assert.equal(
    note,
    'Needs a human reviewer: touches sensitive paths (src/auth/a.ts matched **/auth/**). Review Voice will not approve this change; this is not posted to the pull request.',
  );
});

test('parseComplexity round-trips an assessment and rejects anything malformed', () => {
  const assessment = assessComplexity(patch('src/a.ts', ['if (a) {}']), [file('src/a.ts')]);
  assert.deepEqual(parseComplexity(JSON.parse(JSON.stringify(assessment))), assessment);
  for (const bad of [null, 'x', [], {}, { ...assessment, level: 'severe' }, { ...assessment, limits: null }, { ...assessment, decisionPoints: -1 }]) {
    assert.equal(parseComplexity(bad), null);
  }
});

// ---- configuration ---------------------------------------------------------

function configIn(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hr-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    if (yaml !== null) writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('human_review defaults when absent and reads each key when present', () => {
  const absent = configIn('review:\n  max_findings: 5\n');
  assert.deepEqual(absent.humanReview, {
    maxDecisionPoints: 40,
    maxHunkDecisionPoints: 15,
    sensitivePaths: ['.github/workflows/**', '**/migrations/**', '**/auth/**', '**/security/**', '.review-voice/**'],
    sensitiveExemptPaths: [],
    testPaths: DEFAULT_TEST_PATHS,
    generatedPaths: [],
    structure: { fileLineCrossing: false, branchGrowth: false },
  });
  const set = configIn('review:\n  human_review:\n    max_decision_points: 10\n    sensitive_paths: ["infra/**"]\n');
  assert.equal(set.humanReview.maxDecisionPoints, 10);
  assert.equal(set.humanReview.maxHunkDecisionPoints, 15);
  assert.deepEqual(set.humanReview.sensitivePaths, ['infra/**']);
  assert.deepEqual(set.warnings, []);
});

test('a bad limit falls back with a warning; an empty list is valid; a non-list is ignored with a warning', () => {
  const bad = configIn('review:\n  human_review:\n    max_decision_points: 0\n    max_hunk_decision_points: 2.5\n');
  assert.equal(bad.humanReview.maxDecisionPoints, 40);
  assert.equal(bad.humanReview.maxHunkDecisionPoints, 15);
  assert.equal(bad.warnings.length, 2);

  const empty = configIn('review:\n  human_review:\n    sensitive_paths: []\n');
  assert.deepEqual(empty.humanReview.sensitivePaths, []);
  assert.deepEqual(empty.warnings, []);

  const notList = configIn('review:\n  human_review:\n    sensitive_paths: "infra/**"\n');
  assert.equal(notList.humanReview.sensitivePaths.length, 5);
  assert.equal(notList.warnings.length, 1);
});

// ---- diff --out and record, through the bundle ----------------------------------

function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rv-hr-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { base, repo, cwd: repo, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function cli(args, { cwd, dataDir, input = '' }) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('diff --out writes the assessment to files.json and the summary', () => {
  const scratch = scratchRepo();
  try {
    mkdirSync(join(scratch.repo, 'src/auth'), { recursive: true });
    writeFileSync(join(scratch.repo, 'src/auth/login.ts'), 'export const x = 1;\n');
    const out = join(scratch.base, 'out');
    const result = cli(['diff', '--out', out], scratch);
    assert.equal(result.code, 0, result.stderr);

    const summary = JSON.parse(result.stdout).summary;
    const manifest = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
    assert.equal(summary.complexity.level, 'high');
    assert.deepEqual(summary.complexity.sensitivePaths, ['src/auth/login.ts']);
    assert.match(summary.humanReviewNote, /^Needs a human reviewer: touches sensitive paths \(src\/auth\/login\.ts matched \*\*\/auth\/\*\*\)/);
    assert.deepEqual(manifest.complexity, summary.complexity);
    assert.equal(manifest.humanReviewNote, summary.humanReviewNote);

    const inline = JSON.parse(cli(['diff'], scratch).stdout);
    assert.equal(inline.complexity.level, 'high');
  } finally {
    scratch.cleanup();
  }
});

test('a plain change is normal with no note, and repository config changes the limits', () => {
  const scratch = scratchRepo();
  try {
    writeFileSync(join(scratch.repo, 'a.ts'), 'if (a && b) { go(); }\n');
    const out = join(scratch.base, 'out');
    const plain = JSON.parse(cli(['diff', '--out', out], scratch).stdout).summary;
    assert.equal(plain.complexity.level, 'normal');
    assert.equal(plain.humanReviewNote, null);

    mkdirSync(join(scratch.repo, '.review-voice'));
    writeFileSync(
      join(scratch.repo, '.review-voice/config.yaml'),
      'review:\n  human_review:\n    max_decision_points: 1\n',
    );
    const tight = JSON.parse(cli(['diff', '--out', out], scratch).stdout).summary;
    assert.equal(tight.complexity.level, 'high');
    assert.match(tight.humanReviewNote, /2 decision points added \(limit 1\)/);
  } finally {
    scratch.cleanup();
  }
});

test('record --files stores the assessment; a malformed one is skipped with a message', () => {
  const scratch = scratchRepo();
  try {
    mkdirSync(join(scratch.repo, 'src/auth'), { recursive: true });
    writeFileSync(join(scratch.repo, 'src/auth/login.ts'), 'export const x = 1;\n');
    const out = join(scratch.base, 'out');
    cli(['diff', '--out', out], scratch);

    const recorded = cli(
      ['record', '--repository', REPO, '--head', HEAD, '--diff-file', join(out, 'diff.patch'), '--files', join(out, 'files.json')],
      { ...scratch, input: 'No actionable findings.' },
    );
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const explained = cli(['explain', '--run', runId], scratch);
    assert.match(explained.stdout, /Complexity high - touches sensitive paths/);

    const manifest = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
    writeFileSync(join(out, 'broken.json'), JSON.stringify({ ...manifest, complexity: { level: 'maybe' } }));
    const skipped = cli(
      ['record', '--repository', REPO, '--head', HEAD, '--diff-file', join(out, 'diff.patch'), '--files', join(out, 'broken.json')],
      { ...scratch, input: 'No actionable findings.' },
    );
    assert.equal(skipped.code, 0);
    assert.match(skipped.stderr, /complexity assessment.*malformed/);
    const none = cli(['explain', '--run', JSON.parse(skipped.stdout).reviewRunId], scratch);
    assert.ok(!/Complexity /.test(none.stdout));
  } finally {
    scratch.cleanup();
  }
});

// ---- storage ---------------------------------------------------------------

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hr-db-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  const restore = () => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => body(db, dir))
    .finally(restore);
}

const HIGH = assessComplexity('', [file('src/auth/login.ts')]);
const NORMAL = assessComplexity('', [file('src/plain.ts')]);

function record(db, output, extra = {}) {
  return recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'diff',
    output,
    ...extra,
  });
}

test('runDetail returns the recorded assessment, null when none, and null when the stored value is malformed', async () => {
  await withDb((db) => {
    const withIt = record(db, 'No actionable findings.', { complexity: HIGH });
    assert.deepEqual(runDetail(db, withIt.reviewRunId).complexity, HIGH);

    const without = record(db, 'No actionable findings.');
    assert.equal(runDetail(db, without.reviewRunId).complexity, null);

    db.prepare('UPDATE review_runs SET complexity_json = ? WHERE review_run_id = ?').run('{"level":', withIt.reviewRunId);
    assert.equal(runDetail(db, withIt.reviewRunId).complexity, null);
    db.prepare('UPDATE review_runs SET complexity_json = ? WHERE review_run_id = ?').run('{"level":"high"}', withIt.reviewRunId);
    assert.equal(runDetail(db, withIt.reviewRunId).complexity, null);
  });
});

test('a database from before the column migrates and its runs read as unassessed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hr-migrate-'));
  const path = join(dir, 'review-voice.db');
  try {
    const db = openDatabase(path);
    const old = record(db, 'No actionable findings.', { complexity: HIGH });
    db.close();

    // Take the store back to the schema before this column existed.
    const raw = new DatabaseSync(path);
    raw.exec('ALTER TABLE review_runs DROP COLUMN complexity_json');
    raw.exec('UPDATE schema_version SET version = version - 1');
    raw.close();

    const reopened = openDatabase(path);
    try {
      assert.equal(runDetail(reopened, old.reviewRunId).complexity, null);
      const fresh = record(reopened, 'No actionable findings.', { complexity: HIGH });
      assert.deepEqual(runDetail(reopened, fresh.reviewRunId).complexity, HIGH);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the verdict -----------------------------------------------------------

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const check = (status, conclusion = null) => ({
  id: 1,
  name: 'build',
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [check('completed', 'success')];
const PENDING = [check('in_progress')];

function fakeGitHub({ checkRuns = GREEN } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: checkRuns.length, check_runs: checkRuns });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

const verdict = (db, impl, review, extra = {}) =>
  computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, ...extra });

const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

const CLEAN = 'No actionable findings.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const IMPORTANT = '[important] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';
const NOTE = humanReviewNote(HIGH);
const CAP_REASON = 'the change was raised for human review, so this comments rather than approves';

test('a high run that would approve comments instead, with the reason and no mention of a human in the body', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const { exitCode, output } = await verdict(db, fakeGitHub(), CLEAN);
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.action, 'post');
    assert.ok(output.reasons.includes(CAP_REASON));
    assert.equal(output.complexity.level, 'high');
    assert.equal(output.payload.body, 'No problems found.');
    assert.equal(output.humanReviewNote, NOTE);
  });
});

test('nits are named in the capped summary, plainly', async () => {
  await withDb(async (db) => {
    record(db, NIT, { complexity: HIGH, scores: [verified('src/cart.ts', 40, 'nit')] });
    const { output } = await verdict(db, fakeGitHub(), NIT);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.body, '1 nit.');
  });
});

test('pending CI does not turn the capped approval into a wait', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const { exitCode, output } = await verdict(db, fakeGitHub({ checkRuns: PENDING }), CLEAN);
    assert.equal(exitCode, 0);
    assert.equal(output.action, 'post');
    assert.equal(output.event, 'COMMENT');
  });
});

test('--recheck refuses with exit 2 because there is no approval to re-check', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const { exitCode, output } = await verdict(db, fakeGitHub(), CLEAN, { recheck: true });
    assert.equal(exitCode, 2);
    assert.equal(output.action, 'refuse');
    assert.ok(output.reasons.includes('the change was raised for human review, so there is no approval to re-check'));
  });
});

test('a moved head still refuses first, with exit 3', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const impl = async (url) => {
      const parsed = new URL(String(url));
      return /\/pulls\/\d+$/.test(parsed.pathname) ? json({ head: { sha: 'b'.repeat(40) } }) : new Response('no', { status: 404 });
    };
    const { exitCode, output } = await verdict(db, impl, CLEAN);
    assert.equal(exitCode, 3);
    assert.equal(output.action, 'refuse');
  });
});

test('a high run that maps to REQUEST_CHANGES or COMMENT keeps its event and the body stays plain', async () => {
  await withDb(async (db) => {
    record(db, IMPORTANT, { complexity: HIGH, scores: [verified('src/pay.ts', 8, 'important')] });
    const { output } = await verdict(db, fakeGitHub(), IMPORTANT);
    assert.equal(output.event, 'REQUEST_CHANGES');
    assert.ok(!output.payload.body.includes(NOTE));
    assert.ok(!output.reasons.includes(CAP_REASON));
  });
  await withDb(async (db) => {
    record(db, MINOR, { complexity: HIGH, scores: [verified('src/cart.ts', 12, 'minor')] });
    const { output } = await verdict(db, fakeGitHub(), MINOR);
    assert.equal(output.event, 'COMMENT');
    assert.ok(!output.payload.body.includes(NOTE));
    assert.ok(!output.payload.body.includes('leaving approval'), 'the summary is the ordinary one');
  });
});

test('a normal run approves as before, with no note', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: NORMAL });
    const { output } = await verdict(db, fakeGitHub(), CLEAN);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.payload.body, 'No problems found.');
    assert.ok(!output.reasons.some((reason) => /complexity/.test(reason)));
  });
});

const incremental = (priorRunId) => ({
  kind: 'incremental',
  since: 'c'.repeat(40),
  priorRunId,
  priorReviewedAt: '2026-10-01T10:00:00Z',
  commits: 3,
  files: ['src/a.ts'],
});

test('a narrower normal run whose prior run was high is still capped', async () => {
  await withDb(async (db) => {
    const first = record(db, CLEAN, { complexity: HIGH });
    const second = record(db, CLEAN, { complexity: NORMAL, scope: incremental(first.reviewRunId) });
    const third = record(db, CLEAN, { complexity: NORMAL, scope: incremental(second.reviewRunId) });
    const { output } = await verdict(db, fakeGitHub(), CLEAN, { runId: third.reviewRunId });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.complexity.level, 'high');
    assert.ok(output.reasons.includes(CAP_REASON));
    assert.equal(output.humanReviewNote, NOTE);
    assert.ok(!output.payload.body.includes(NOTE));
  });
});

test('a full run does not follow its prior run', async () => {
  await withDb(async (db) => {
    const first = record(db, CLEAN, { complexity: HIGH });
    const full = record(db, CLEAN, {
      complexity: NORMAL,
      scope: { kind: 'full', cause: 'forced', since: null, priorRunId: first.reviewRunId },
    });
    const { output } = await verdict(db, fakeGitHub(), CLEAN, { runId: full.reviewRunId });
    assert.equal(output.event, 'APPROVE');
  });
});

test('following prior runs stops at a missing run and at a cycle', async () => {
  await withDb(async (db) => {
    const lost = record(db, CLEAN, { complexity: NORMAL, scope: incremental('00000000-0000-0000-0000-000000000000') });
    const missing = await verdict(db, fakeGitHub(), CLEAN, { runId: lost.reviewRunId });
    assert.equal(missing.output.event, 'APPROVE');

    const a = record(db, CLEAN, { complexity: NORMAL, scope: incremental(null) });
    const b = record(db, CLEAN, { complexity: NORMAL, scope: incremental(a.reviewRunId) });
    db.prepare('UPDATE review_runs SET scope_json = ? WHERE review_run_id = ?').run(
      JSON.stringify(incremental(b.reviewRunId)),
      a.reviewRunId,
    );
    const cycle = await verdict(db, fakeGitHub(), CLEAN, { runId: b.reviewRunId });
    assert.equal(cycle.exitCode, 0);
    assert.equal(cycle.output.event, 'APPROVE');
  });
});

test('a run with no assessment is not capped, and says so in reasons', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, fakeGitHub(), CLEAN);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.complexity, null);
    assert.ok(output.reasons.includes('no complexity assessment was recorded for this run'));
    assert.equal(output.payload.body, 'No problems found.');
  });
});
