/**
 * An owner can explicitly lower a tier when computed repository reach is wider
 * than the impact every review stage established, without editing score JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = {
  candidate_id: 'cand_001',
  path: 'ci/paths.ts',
  line: 2,
  category: 'reliability',
  severity: 'minor',
  claim: 'The renamed workflow path skips the required check.',
  failure_mode: 'A protected change can merge without the check running.',
  evidence: ['ci/paths.ts:2 adds a path guard shared by every workflow.'],
  technical_confidence: 0.9,
};

const patch = [
  'diff --git a/ci/paths.ts b/ci/paths.ts',
  '--- a/ci/paths.ts',
  '+++ b/ci/paths.ts',
  '@@ -1 +1,2 @@',
  ' export const sharedPaths = [];',
  '+export function SharedPipelineGuard() { return true; }',
  '',
].join('\n');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-90-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function run(dir, data, args, input) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
  });
}

function repository(dir) {
  mkdirSync(join(dir, 'ci'), { recursive: true });
  mkdirSync(join(dir, 'src', 'web'), { recursive: true });
  mkdirSync(join(dir, 'src', 'jobs'), { recursive: true });
  writeFileSync(join(dir, 'ci', 'paths.ts'), 'export const sharedPaths = [];\n');
  writeFileSync(join(dir, 'src', 'web', 'view.ts'), 'import { SharedPipelineGuard } from "../../ci/paths";\nSharedPipelineGuard();\n');
  writeFileSync(join(dir, 'src', 'jobs', 'worker.ts'), 'import { SharedPipelineGuard } from "../../ci/paths";\nSharedPipelineGuard();\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.']);
  writeFileSync(join(dir, 'ci', 'paths.ts'), 'export const sharedPaths = [];\nexport function SharedPipelineGuard() { return true; }\n');
  writeFileSync(join(dir, 'change.patch'), patch);
}

test('owner override lowers a traced repository-reach score, validates, and is recorded with its reason', () =>
  withDir((dir) => {
    const data = join(dir, 'data');
    repository(dir);
    const verification = join(dir, 'verification.json');
    writeFileSync(
      verification,
      JSON.stringify([{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, impact_traced: true }]),
    );

    const scored = run(
      dir,
      data,
      ['score', '--verification', verification, '--diff-file', join(dir, 'change.patch'), '--min-score', '0', '--severity', 'cand_001=minor'],
      JSON.stringify({ candidates: [candidate] }),
    );
    assert.equal(scored.status, 0, scored.stderr);
    const scoreOutput = JSON.parse(scored.stdout);
    const [breakdown] = scoreOutput.scores;
    assert.equal(breakdown.severity.severity, 'minor');
    assert.match(breakdown.severity.reason, /reliability at repository reach carries important/);
    assert.match(breakdown.severity.reason, /held at minor by an explicit owner override/);
    assert.equal(scoreOutput.eligible[0].severity, 'minor');

    const scores = join(dir, 'scores.json');
    writeFileSync(scores, scored.stdout);
    const review = '[minor] `ci/paths.ts:2` - The renamed workflow path skips the required check. Protected changes can merge without it. Restore the path match.\n';
    const validated = run(dir, data, ['validate-output', '--scores', scores], review);
    assert.equal(validated.status, 0, validated.stderr);

    const recorded = run(dir, data, ['record', '--scores', scores], review);
    assert.equal(recorded.status, 0, recorded.stderr);
    const { reviewRunId } = JSON.parse(recorded.stdout);
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: data }));
    try {
      const detail = runDetail(db, reviewRunId);
      const stored = detail.scores.find((entry) => entry.candidate_id === 'cand_001');
      assert.match(stored.severity.reason, /explicit owner override/);
    } finally {
      db.close();
    }
  }));

test('owner severity overrides cannot raise a scored tier', () =>
  withDir((dir) => {
    const data = join(dir, 'data');
    repository(dir);
    const verification = join(dir, 'verification.json');
    writeFileSync(
      verification,
      JSON.stringify([{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, impact_traced: true }]),
    );
    const result = run(
      dir,
      data,
      ['score', '--verification', verification, '--diff-file', join(dir, 'change.patch'), '--min-score', '0', '--severity', 'cand_001=blocking'],
      JSON.stringify({ candidates: [candidate] }),
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /must lower the scored important tier/);
  }));
