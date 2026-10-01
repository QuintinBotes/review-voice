import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args, input, dataDir = undefined) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: dataDir === undefined ? process.env : { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function candidates() {
  return {
    candidates: [
      {
        candidate_id: 'cand_added',
        path: 'plugins/review-voice/src/cli.ts',
        line: 10,
        category: 'correctness',
        severity: 'important',
        claim: 'The added branch returns the wrong result.',
        failure_mode: 'A caller takes the wrong branch.',
        evidence: ['The changed branch is at line 10.'],
        technical_confidence: 0.95,
      },
      {
        candidate_id: 'cand_deletion',
        path: 'plugins/review-voice/src/cli.ts',
        line: 21,
        category: 'correctness',
        severity: 'important',
        claim: 'Removing the guard permits an invalid input.',
        failure_mode: 'An invalid input reaches the handler.',
        evidence: ['The guard was removed at line 21.'],
        technical_confidence: 0.95,
      },
      {
        candidate_id: 'cand_context',
        path: 'plugins/review-voice/src/cli.ts',
        line: 20,
        category: 'correctness',
        severity: 'important',
        claim: 'The unchanged setup is unsafe.',
        failure_mode: 'The request is processed incorrectly.',
        evidence: ['The setup is at line 20.'],
        technical_confidence: 0.95,
      },
    ],
  };
}

function writePatch(dir) {
  const patch = join(dir, 'diff.patch');
  writeFileSync(
    patch,
    [
      'diff --git a/plugins/review-voice/src/cli.ts b/plugins/review-voice/src/cli.ts',
      '--- a/plugins/review-voice/src/cli.ts',
      '+++ b/plugins/review-voice/src/cli.ts',
      '@@ -10 +10,2 @@',
      '+const added = true;',
      '+const another = true;',
      '@@ -20,3 +20,2 @@',
      ' before',
      '-guard(input);',
      ' after',
    ].join('\n'),
  );
  return patch;
}

test('check-candidates reports only anchors that are not changed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-anchor-check-'));
  try {
    const patch = writePatch(dir);
    const accepted = run(['check-candidates', '--diff-file', patch], JSON.stringify({ candidates: candidates().candidates.slice(0, 2) }));
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).anchors, { checked: 2 });

    const rejected = run(['check-candidates', '--diff-file', patch], JSON.stringify(candidates()));
    assert.equal(rejected.code, 1, rejected.stderr);
    const report = JSON.parse(rejected.stdout);
    assert.deepEqual(report.anchorFailures.map((failure) => failure.candidateId), ['cand_context']);
    assert.equal(report.anchorFailures[0].kind, 'context');
    assert.match(report.anchorFailures[0].reason, /unchanged context line/);
    assert.deepEqual(report.anchorFailures[0].nearest, [21]);
    assert.match(rejected.stderr, /1 candidate anchor/);

    const unreadable = run(['check-candidates', '--diff-file', join(dir, 'missing.patch')], JSON.stringify(candidates()));
    assert.equal(unreadable.code, 2);
    assert.match(unreadable.stderr, /missing\.patch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('score rejects context anchors and refuses an unreadable thread file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-anchor-score-'));
  try {
    const patch = writePatch(dir);
    const scored = run(['score', '--diff-file', patch], JSON.stringify(candidates()), dir);
    assert.equal(scored.code, 0, scored.stderr);
    const byId = Object.fromEntries(JSON.parse(scored.stdout).scores.map((entry) => [entry.candidateId, entry]));
    assert.equal(byId.cand_added.anchorCheck.kind, 'added');
    assert.equal(byId.cand_deletion.anchorCheck.kind, 'deletion-site');
    assert.equal(byId.cand_context.anchorCheck.kind, 'context');
    assert.match(byId.cand_context.rejectedBecause, /unchanged context line/);

    const missingThread = join(dir, 'missing-thread.json');
    const thread = run(['score', '--thread', missingThread], JSON.stringify({ candidates: [candidates().candidates[0]] }), dir);
    assert.equal(thread.code, 2);
    assert.match(thread.stderr, /missing-thread\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the anchor reason leads even when the score gate also rejects the candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-anchor-lead-'));
  try {
    const patch = writePatch(dir);
    // Below every confidence gate, and anchored on a context line: the anchor
    // is the reason an analyst can act on, so it is the one shown first.
    const weak = { ...candidates().candidates[2], technical_confidence: 0.3 };
    const scored = run(['score', '--diff-file', patch], JSON.stringify({ candidates: [weak] }), dir);
    assert.equal(scored.code, 0, scored.stderr);
    const entry = JSON.parse(scored.stdout).scores[0];
    assert.equal(entry.eligible, false);
    assert.match(entry.rejectedBecause, /^anchors on plugins\/review-voice\/src\/cli\.ts:20, an unchanged context line/);
    assert.match(entry.rejectedBecause, /Also: technical confidence 0\.30/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
