/**
 * A stale consumer: unchanged code - a caller, a document, a config elsewhere -
 * that the change made wrong. It is anchored by the changed line that caused
 * it, needs the verifier to have traced the impact, and is posted in the
 * review body because a comment cannot sit on an unchanged line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const HEAD = 'c'.repeat(40);
const REPO = 'acme/web';
const PR = 11;

const CLAIM = '`formatTotal` now returns cents, but `src/report.ts` still divides its result by 100.';

/** Runs outside any repository, so no citation or absence search applies. */
function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-stale-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** `src/total.ts` gains lines 10 and 11; line 20 is unchanged context. */
function writePatch(dir) {
  const patch = join(dir, 'diff.patch');
  writeFileSync(
    patch,
    [
      'diff --git a/src/total.ts b/src/total.ts',
      '--- a/src/total.ts',
      '+++ b/src/total.ts',
      '@@ -10 +10,2 @@',
      '+export function formatTotal(cents: number) {',
      '+  return cents;',
      '@@ -20,3 +21,3 @@',
      ' before',
      '-old();',
      '+fresh();',
      ' after',
    ].join('\n'),
  );
  return patch;
}

const stale = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'src/report.ts',
  line: 30,
  category: 'correctness',
  severity: 'important',
  claim: CLAIM,
  failure_mode: 'Every report shows totals a hundred times too small.',
  evidence: ['src/report.ts:30 divides formatTotal() by 100.', 'src/total.ts:11 now returns cents unchanged.'],
  technical_confidence: 0.9,
  anchor: 'stale-consumer',
  caused_by: { path: 'src/total.ts', line: 11 },
  ...over,
});

test('check-candidates accepts a stale consumer whose cause is a changed line', () =>
  withDir((dir) => {
    const patch = writePatch(dir);
    const r = run(['check-candidates', '--diff-file', patch], JSON.stringify({ candidates: [stale()] }), dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).valid, true);
  }));

test('check-candidates refuses a stale consumer with no cause, and says so', () =>
  withDir((dir) => {
    const patch = writePatch(dir);
    const candidate = stale();
    delete candidate.caused_by;
    const r = run(['check-candidates', '--diff-file', patch], JSON.stringify({ candidates: [candidate] }), dir);
    assert.equal(r.code, 1, r.stderr);
    const [failure] = JSON.parse(r.stdout).anchorFailures;
    assert.equal(failure.kind, 'stale-consumer');
    assert.match(failure.reason, /names no caused_by/);
  }));

test('check-candidates refuses a stale consumer whose cause is not a changed line', () =>
  withDir((dir) => {
    const patch = writePatch(dir);
    const onContext = stale({ caused_by: { path: 'src/total.ts', line: 21 } });
    const offDiff = stale({ candidate_id: 'cand_002', caused_by: { path: 'src/other.ts', line: 3 } });
    const r = run(['check-candidates', '--diff-file', patch], JSON.stringify({ candidates: [onContext, offDiff] }), dir);
    assert.equal(r.code, 1, r.stderr);
    const failures = JSON.parse(r.stdout).anchorFailures;
    assert.equal(failures.length, 2);
    assert.match(failures[0].reason, /caused_by src\/total\.ts:21 is an unchanged context line/);
    assert.match(failures[0].reason, /must be an added line or deletion site/);
    assert.deepEqual(failures[0].causedBy, { path: 'src/total.ts', line: 21, kind: 'context' });
    assert.match(failures[1].reason, /caused_by src\/other\.ts:3 is in a file the diff does not touch/);
  }));

test('an ordinary candidate on the same unchanged line still fails as before', () =>
  withDir((dir) => {
    const patch = writePatch(dir);
    const plain = stale();
    delete plain.anchor;
    delete plain.caused_by;
    const r = run(['check-candidates', '--diff-file', patch], JSON.stringify({ candidates: [plain] }), dir);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).anchorFailures[0].kind, 'file-not-in-diff');
  }));

function score(dir, candidates, verification) {
  const patch = writePatch(dir);
  const file = join(dir, 'verification.json');
  writeFileSync(file, JSON.stringify({ results: verification }));
  return run(
    ['score', '--verification', file, '--diff-file', patch, '--min-score', '0.3'],
    JSON.stringify({ candidates }),
    dir,
  );
}

test('score makes a traced stale consumer eligible and records its cause', () =>
  withDir((dir) => {
    const r = score(dir, [stale()], [
      { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9, impact_traced: true },
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const [row] = out.scores;
    assert.equal(row.eligible, true, row.rejectedBecause);
    assert.equal(row.anchorCheck.kind, 'stale-consumer');
    assert.equal(row.anchorCheck.ok, true);
    assert.deepEqual(row.anchorCheck.causedBy, { path: 'src/total.ts', line: 11, kind: 'added' });
    assert.equal(row.anchor, 'stale-consumer');
    assert.equal(out.eligible[0].path, 'src/report.ts');
    assert.equal(out.eligible[0].line, 30);
  }));

test('score rejects a stale consumer the verifier did not trace', () =>
  withDir((dir) => {
    for (const verdict of [
      { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9, impact_traced: false },
      { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9 },
    ]) {
      const r = score(dir, [stale()], [verdict]);
      assert.equal(r.code, 0, r.stderr);
      const [row] = JSON.parse(r.stdout).scores;
      assert.equal(row.eligible, false);
      assert.match(row.rejectedBecause, /stale-consumer finding needs the verifier to trace the impact/);
    }
  }));

test('score rejects a stale consumer whose cause is unchanged, whatever was traced', () =>
  withDir((dir) => {
    const r = score(dir, [stale({ caused_by: { path: 'src/total.ts', line: 21 } })], [
      { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9, impact_traced: true },
    ]);
    const [row] = JSON.parse(r.stdout).scores;
    assert.equal(row.eligible, false);
    assert.equal(row.anchorCheck.kind, 'stale-consumer');
    assert.match(row.rejectedBecause, /unchanged context line/);
  }));

test('a malformed caused_by is refused as a shape error', () =>
  withDir((dir) => {
    const r = run(['check-candidates'], JSON.stringify({ candidates: [stale({ caused_by: 'src/total.ts:11' })] }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /caused_by must be/);
  }));

// Publishing

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub() {
  return async (url) => {
    const parsed = new URL(String(url));
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({
        total_count: 1,
        check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }],
      });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
}

test('a verified stale consumer posts in the body with its path and line, never inline', () =>
  withDir(async (dir) => {
    const r = score(dir, [stale()], [
      { candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9, impact_traced: true },
    ]);
    assert.equal(r.code, 0, r.stderr);
    const scored = JSON.parse(r.stdout);
    const severity = scored.scores[0].severity.severity;

    const staleLine = `[${severity}] \`src/report.ts:30\` - The report still divides the total by 100. Totals show a hundred times too small.`;
    const inlineLine = '[minor] `src/total.ts:10` - The parameter name hides the unit. Callers pass dollars.';
    const inlineScore = {
      candidateId: 'cand_002',
      path: 'src/total.ts',
      line: 10,
      severity: { severity: 'minor' },
      confidenceSource: 'verifier',
      eligible: true,
    };

    const previous = process.env.REVIEW_VOICE_DATA_DIR;
    process.env.REVIEW_VOICE_DATA_DIR = dir;
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      const review = `${staleLine}\n\n${inlineLine}\n`;
      recordRun(db, {
        repository: REPO,
        baseRef: null,
        headRef: HEAD,
        pullNumber: PR,
        diff: readFileSync(join(dir, 'diff.patch'), 'utf8'),
        output: review,
        scores: [...scored.scores, inlineScore],
      });
      const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(), sleep: async () => {} });
      const { output } = await computeVerdict({ db, client, repository: REPO, pullNumber: PR, head: HEAD, review });

      assert.equal(output.action, 'post', output.reasons.join('; '));
      assert.deepEqual(output.held, []);
      assert.deepEqual(
        output.payload.comments.map((comment) => `${comment.path}:${comment.line}`),
        ['src/total.ts:10'],
      );
      assert.match(output.payload.body, /`src\/report\.ts:30` - The report still divides the total by 100/);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
      else process.env.REVIEW_VOICE_DATA_DIR = previous;
    }
  }));

// The prompts carry the rule

const read = (path) => readFileSync(join(plugin, path), 'utf8');

test('the analyst, verifier and review command describe the stale-consumer anchor', () => {
  const analyst = read('agents/diff-analyst.md');
  const verifier = read('agents/evidence-verifier.md');
  const review = read('commands/review.md');
  const schema = JSON.parse(read('schemas/candidate.schema.json')).properties.candidates.items.properties;

  assert.doesNotMatch(analyst, /no off-diff exception/);
  assert.match(analyst, /`"stale-consumer"`/);
  assert.match(analyst, /`caused_by`/);
  assert.match(analyst, /cause must be an added line or a deletion site/);
  assert.match(verifier, /`anchor: "stale-consumer"`/);
  assert.match(verifier, /Set `impact_traced` to true only\s+when you did/);
  assert.match(review, /stale consumer/i);
  assert.deepEqual(schema.anchor.enum, ['stale-consumer']);
  assert.deepEqual(schema.caused_by.required, ['path', 'line']);
});
