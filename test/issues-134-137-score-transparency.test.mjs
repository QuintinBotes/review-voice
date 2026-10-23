/**
 * #134 trailing text was counted against the last finding's word limit.
 * #135 an escalation above the requested tier did not name its rule.
 * #136 a below-gate finding could only be posted by editing scores.json.
 * #137 the unverifiable cap did not say which input applied it.
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
  const dir = mkdtempSync(join(tmpdir(), 'rv-issues-134-137-'));
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

function run(dir, args, input) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
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

function score(dir, verifications, extra, candidates = [candidate]) {
  const verification = join(dir, 'verification.json');
  writeFileSync(verification, JSON.stringify(verifications));
  return run(
    dir,
    ['score', '--verification', verification, '--diff-file', join(dir, 'change.patch'), ...extra],
    JSON.stringify({ candidates }),
  );
}

const words = (n) => Array.from({ length: n }, () => 'word').join(' ');

test('#134: a paragraph after the last finding is stray text, not words of that finding', () =>
  withDir((dir) => {
    const output = `[minor] \`a/b.ts:1\` - ${words(36)}.\n\nVerified against the base branch; two candidates held below the gate.\n`;
    const result = run(dir, ['validate-output'], output);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /finding_too_long/);
    assert.match(result.stdout + result.stderr, /\[stray_text\] line 3/);
  }));

test('#134: a wrapped finding still counts as one finding, and the limit message says what it counts', () =>
  withDir((dir) => {
    const wrapped = run(dir, ['validate-output'], `[minor] \`a/b.ts:1\` - ${words(20)}\n${words(10)}.\n`);
    assert.equal(wrapped.status, 0, wrapped.stdout + wrapped.stderr);
    const long = run(dir, ['validate-output'], `[minor] \`a/b.ts:1\` - ${words(41)}.\n`);
    assert.match(long.stdout + long.stderr, /41 words of prose, 1 over the limit of 40\. The tag and `path:line` are not counted/);
  }));

test('#161 #167: an over-long finding is named by its path:line and severity, with the excess to cut', () =>
  withDir((dir) => {
    const out = `[nit] \`a/b.ts:1\` - ${words(20)}.\n\n[question] \`a/c.ts:7\` - ${words(46)}?\n`;
    const result = run(dir, ['validate-output'], out);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /finding at `a\/c\.ts:7` \[question\]: 46 words of prose, 6 over the limit of 40\. The tag and `path:line` are not counted\. Cut at least 6 words or drop the finding\./,
    );
  }));

test('#135: an escalation above the requested tier names the rule that allowed it', () =>
  withDir((dir) => {
    repository(dir);
    const scored = score(dir, [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, impact_traced: true }], [
      '--min-score',
      '0',
    ]);
    assert.equal(scored.status, 0, scored.stderr);
    const { eligible } = JSON.parse(scored.stdout);
    assert.equal(eligible[0].severity, 'important');
    assert.match(
      eligible[0].severityReason,
      /raised above the requested minor because the verifier traced impact beyond the changed code \(impact_traced: true\) at confidence 0\.\d+, at least 0\.85/,
    );
  }));

test('#135: a fixed boundary category says its tier ignores the request', () =>
  withDir((dir) => {
    repository(dir);
    const security = { ...candidate, category: 'security' };
    const scored = score(dir, [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 }], ['--min-score', '0'], [security]);
    assert.equal(scored.status, 0, scored.stderr);
    const [breakdown] = JSON.parse(scored.stdout).scores;
    assert.notEqual(breakdown.severity.severity, 'minor');
    assert.match(breakdown.severity.reason, /raised above the requested minor because security names a breach by itself/);
  }));

test('#136: --promote posts a below-gate finding, validates, and records the owner decision', () =>
  withDir((dir) => {
    repository(dir);
    const verification = [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9, impact_traced: true }];
    const held = JSON.parse(score(dir, verification, ['--min-score', '0.99']).stdout);
    assert.equal(held.belowGate.length, 1);
    assert.equal(held.eligible.length, 0);

    const scored = score(dir, verification, ['--min-score', '0.99', '--promote', 'cand_001']);
    assert.equal(scored.status, 0, scored.stderr);
    const out = JSON.parse(scored.stdout);
    assert.equal(out.belowGate.length, 0);
    assert.equal(out.eligible.length, 1);
    assert.equal(out.scores[0].eligible, true);
    assert.equal(out.scores[0].ownerPromotion.gate, 'score');
    assert.match(out.scores[0].ownerPromotion.heldBecause, /^score 0\.\d{4} is below the 0\.99 threshold$/);

    const scores = join(dir, 'scores.json');
    writeFileSync(scores, scored.stdout);
    const review =
      `[${out.eligible[0].severity}] \`ci/paths.ts:2\` - The renamed workflow path skips the required check. ` +
      'Protected changes can merge without it.\n';
    const validated = run(dir, ['validate-output', '--scores', scores], review);
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);
    const recorded = run(dir, ['record', '--scores', scores], review);
    assert.equal(recorded.status, 0, recorded.stderr);
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: join(dir, 'data') }));
    try {
      const stored = runDetail(db, JSON.parse(recorded.stdout).reviewRunId).scores.find((e) => e.candidate_id === 'cand_001');
      assert.equal(stored.ownerPromotion.gate, 'score');
    } finally {
      db.close();
    }
  }));

test('#136: --promote refuses a finding something other than a numeric gate stopped', () =>
  withDir((dir) => {
    repository(dir);
    const rejected = score(dir, [{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.9 }], ['--promote', 'cand_001']);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /only a verified finding held by the score or confidence gate alone can be promoted/);
    const unknown = score(dir, [], ['--promote', 'cand_404']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown candidate "cand_404"/);
  }));

test('#137: the unverifiable cap names the required_context_missing item that applied it', () =>
  withDir((dir) => {
    repository(dir);
    const scored = score(
      dir,
      [
        {
          candidate_id: 'cand_001',
          verified: true,
          technical_confidence: 0.7,
          required_context_missing: ['whether generated code imports the dependency'],
        },
      ],
      [],
    );
    assert.equal(scored.status, 0, scored.stderr);
    const out = JSON.parse(scored.stdout);
    assert.equal(out.scores[0].confidenceSource, 'unverifiable-cap');
    const because = /required_context_missing the claim depends on: whether generated code imports the dependency/;
    assert.match(out.scores[0].unverifiableBecause, because);
    assert.deepEqual(out.unverified[0].requiredContextMissing, ['whether generated code imports the dependency']);
  }));
