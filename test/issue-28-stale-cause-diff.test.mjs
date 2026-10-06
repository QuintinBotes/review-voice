/**
 * A stale consumer's cause is judged against the diff the analyst read.
 *
 * On a follow-up that reverted the pull request's own earlier change, the
 * analyst anchored a stale comment on the line the latest commit changed. In
 * the interdiff that line is a change; in the full diff it is unchanged
 * context, and the stale comment is itself an added line - an ordinary
 * finding all along. `check-candidates` and `score` read the same patch, and
 * both now say when the consumer should be re-filed as an ordinary finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

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
  const dir = mkdtempSync(join(tmpdir(), 'rv-stale-cause-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The latest commit puts line 154 back to the base code; line 150 is context. */
const INTERDIFF = [
  'diff --git a/src/parser.ts b/src/parser.ts',
  '--- a/src/parser.ts',
  '+++ b/src/parser.ts',
  '@@ -152,5 +152,5 @@',
  ' a',
  ' b',
  '-  return parseStrict(input);',
  '+  return parseLoose(input);',
  ' c',
  ' d',
].join('\n');

/** The pull request against its base: the comment at 150 is added, 154 is back to base. */
const FULL = [
  'diff --git a/src/parser.ts b/src/parser.ts',
  '--- a/src/parser.ts',
  '+++ b/src/parser.ts',
  '@@ -148,4 +148,5 @@',
  ' a',
  ' b',
  '+  // Strict parsing rejects trailing commas.',
  ' c',
  ' d',
].join('\n');

/** A diff that changes both the comment at 150 and the call at 154. */
const BOTH = [FULL, '@@ -152,3 +153,3 @@', ' e', '-  return parseStrict(input);', '+  return parseLoose(input);', ' f'].join('\n');

const stale = {
  candidate_id: 'cand_001',
  path: 'src/parser.ts',
  line: 150,
  category: 'maintainability',
  severity: 'nit',
  claim: 'The comment above `parse` still says parsing is strict, but it is loose again.',
  failure_mode: 'A reader trusts the comment and relies on trailing commas being rejected.',
  evidence: ['src/parser.ts:150 says strict.', 'src/parser.ts:154 calls `parseLoose`.'],
  technical_confidence: 0.85,
  anchor: 'stale-consumer',
  caused_by: { path: 'src/parser.ts', line: 154 },
};

function patch(dir, name, text) {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

test('check-candidates and score accept the cause against the interdiff the analyst read', () =>
  withDir((dir) => {
    const interdiff = patch(dir, 'diff.patch', INTERDIFF);
    const checked = run(['check-candidates', '--diff-file', interdiff], JSON.stringify({ candidates: [stale] }), dir);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);

    const verification = patch(
      dir,
      'verification.json',
      JSON.stringify([{ candidate_id: 'cand_001', technical_confidence: 0.9, impact_traced: true }]),
    );
    const scored = run(
      ['score', '--verification', verification, '--diff-file', interdiff, '--min-score', '0.3'],
      JSON.stringify({ candidates: [stale] }),
      dir,
    );
    assert.equal(scored.code, 0, scored.stderr);
    const [row] = JSON.parse(scored.stdout).scores;
    assert.equal(row.anchorCheck.ok, true);
    assert.equal(row.eligible, true, row.rejectedBecause);
  }));

test('against the full diff the cause fails, and the reason says to file it as an ordinary finding', () =>
  withDir((dir) => {
    const full = patch(dir, 'full.patch', FULL);
    const r = run(['check-candidates', '--diff-file', full], JSON.stringify({ candidates: [stale] }), dir);
    assert.equal(r.code, 1, r.stderr);
    const [failure] = JSON.parse(r.stdout).anchorFailures;
    assert.match(failure.reason, /caused_by src\/parser\.ts:154 is/);
    assert.match(failure.reason, /src\/parser\.ts:150 is itself an added line in this diff, so it is an ordinary finding/);
    assert.match(failure.reason, /drop anchor and caused_by/);

    const verification = patch(dir, 'v.json', JSON.stringify([{ candidate_id: 'cand_001', technical_confidence: 0.9, impact_traced: true }]));
    const scored = run(['score', '--verification', verification, '--diff-file', full], JSON.stringify({ candidates: [stale] }), dir);
    const [row] = JSON.parse(scored.stdout).scores;
    assert.equal(row.eligible, false);
    assert.match(row.rejectedBecause, /is itself an added line in this diff/);
  }));

test('a passing stale consumer on a changed line is listed under suggestions, and still passes', () =>
  withDir((dir) => {
    // Both the comment and its cause changed in this diff.
    const both = patch(dir, 'both.patch', BOTH);
    const r = run(['check-candidates', '--diff-file', both], JSON.stringify({ candidates: [stale] }), dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.valid, true);
    assert.deepEqual(out.suggestions.map((entry) => entry.candidateId), ['cand_001']);
    assert.match(out.suggestions[0].suggestion, /src\/parser\.ts:150 is itself an added line in this diff/);
  }));

test('an ordinary stale consumer gets no suggestion', () =>
  withDir((dir) => {
    const interdiff = patch(dir, 'diff.patch', INTERDIFF);
    const out = JSON.parse(run(['check-candidates', '--diff-file', interdiff], JSON.stringify({ candidates: [stale] }), dir).stdout);
    assert.equal(out.suggestions, undefined);
  }));

test('the analyst and the review command say which diff the cause is judged against', () => {
  const analyst = readFileSync(join(plugin, 'agents/diff-analyst.md'), 'utf8');
  assert.match(analyst, /judged against the diff you were given/);
  assert.match(analyst, /interdiff/);
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepTwo = review.slice(review.indexOf('## Step 2'), review.indexOf('## Step 3 - Verify'));
  assert.match(stepTwo, /`--diff-file` here and in step 4 is the `diff\.patch` the analyst read/);
});
