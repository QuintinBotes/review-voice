/**
 * Unverified: a candidate rejected only because the verifier listed context it
 * could not obtain. It used to vanish - not eligible, not below the gate - so
 * the owner never saw a claim that was later confirmed end to end. `score` now
 * lists it locally with what was missing. It is never posted.
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

const CLAIMS = {
  cand_001: 'The export job reads the tenant scope from the request rather than the token.',
  cand_002: 'The cache key omits the locale, so two languages share one entry.',
  cand_003: 'The retry loop sleeps a fixed second, so failures retry in lockstep.',
};

function run(args, input, cwd) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: cwd },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-unverified-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const candidate = (id, line) => ({
  candidate_id: id,
  path: 'src/export.ts',
  line,
  category: 'correctness',
  severity: 'minor',
  claim: CLAIMS[id],
  failure_mode: 'A user sees or changes data that is not theirs.',
  evidence: [`src/export.ts:${line} reads the value.`],
  technical_confidence: 0.9,
});

/** Lines 1-10 of `src/export.ts` are added; line 30 is outside the diff. */
function writePatch(dir) {
  const patch = join(dir, 'diff.patch');
  const added = Array.from({ length: 10 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(patch, ['diff --git a/src/export.ts b/src/export.ts', '--- a/src/export.ts', '+++ b/src/export.ts', '@@ -0,0 +1,10 @@', ...added].join('\n'));
  return patch;
}

function score(dir, verifications, candidates) {
  const file = join(dir, 'verification.json');
  writeFileSync(file, JSON.stringify({ results: verifications }));
  const r = run(
    ['score', '--verification', file, '--diff-file', writePatch(dir), '--min-score', '0.3'],
    JSON.stringify({ candidates }),
    dir,
  );
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('score lists a candidate held back only by missing context as unverified', () =>
  withDir((dir) => {
    const out = score(
      dir,
      [
        { candidate_id: 'cand_001', technical_confidence: 0.72, required_context_missing: ['the token issuer in a sibling repository'] },
        { candidate_id: 'cand_002', technical_confidence: 0.9 },
      ],
      [candidate('cand_001', 3), candidate('cand_002', 5)],
    );
    const byId = Object.fromEntries(out.scores.map((row) => [row.candidateId, row]));
    assert.equal(byId.cand_001.eligible, false);
    assert.equal(byId.cand_001.confidenceSource, 'unverifiable-cap');

    assert.ok(Array.isArray(out.unverified), 'score output has no unverified list');
    assert.deepEqual(out.unverified, [
      {
        candidateId: 'cand_001',
        candidate_id: 'cand_001',
        path: 'src/export.ts',
        line: 3,
        severity: byId.cand_001.severity.severity,
        claim: CLAIMS.cand_001,
        verifierConfidence: 0.72,
        requiredContextMissing: ['the token issuer in a sibling repository'],
      },
    ]);
    // Not below the gate, and not offered to the editor.
    assert.deepEqual(out.belowGate, []);
    assert.deepEqual(out.eligible.map((entry) => entry.candidateId), ['cand_002']);
  }));

test('a candidate another gate also rejected, or the analyst alone doubted, is not listed', () =>
  withDir((dir) => {
    const admitting = { ...candidate('cand_003', 5), evidence: ['This cannot be verified without access to the service.'] };
    const out = score(
      dir,
      [
        // Anchored outside the diff: the anchor reason leads, so it is not
        // held back by the missing context alone.
        { candidate_id: 'cand_001', technical_confidence: 0.9, required_context_missing: ['a sibling repository'] },
        // Capped on the analyst's own admission; the verifier listed nothing.
        { candidate_id: 'cand_003', evidence_quality: 'high' },
      ],
      [candidate('cand_001', 30), admitting],
    );
    assert.equal(out.scores.find((row) => row.candidateId === 'cand_003').confidenceSource, 'unverifiable-cap');
    assert.deepEqual(out.unverified, []);
  }));

test('record accepts unverified held entries and explain lists them', () =>
  withDir((dir) => {
    const held = join(dir, 'held.json');
    writeFileSync(
      held,
      JSON.stringify([
        { path: 'src/export.ts', line: 3, verdict: 'unverified', source: 'score', reason: 'could not check: the token issuer', text: CLAIMS.cand_001 },
      ]),
    );
    const done = run(['record', '--repository', 'o/r', '--head', 'abc', '--held', held], 'No actionable findings.\n', dir);
    assert.equal(done.code, 0, done.stderr);
    const id = JSON.parse(done.stdout).reviewRunId;
    assert.match(run(['explain', '--run', id], '', dir).stdout, /\[unverified\] src\/export\.ts:3/);
  }));

test('the review command prints the unverified list, records it as held, and never posts it', () => {
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepFour = review.slice(review.indexOf('## Step 4'), review.indexOf('## Step 5'));
  assert.match(stepFour, /`unverified` lists the candidates/);
  assert.match(stepFour, /never\s+posted/);
  const stepSix = review.slice(review.indexOf('## Step 6'), review.indexOf('## What not to do'));
  assert.match(stepSix, /`Unverified \(not posted\)`/);
  assert.match(stepSix, /`unverified` entry from step 4 as `unverified`/);
});
