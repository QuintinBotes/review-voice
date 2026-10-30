import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args, input) {
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// diff.patch lines: 1-3 header, 4 hunk header, 5-6 added (src/a.ts 40-41),
// 7-9 header of the second file, 10 hunk header, 11 added (src/b.ts 3).
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -40 +40,2 @@',
  '+const first = true;',
  '+const second = true;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -3 +3 @@',
  '+const third = true;',
].join('\n');

const candidate = (id, path, line) => ({
  candidate_id: id,
  path,
  line,
  category: 'correctness',
  severity: 'important',
  claim: `The change at ${id} is wrong.`,
  failure_mode: 'A caller takes the wrong branch.',
  evidence: ['The added line is wrong.'],
  technical_confidence: 0.95,
});

function check(candidates, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-227-'));
  try {
    const patch = join(dir, 'diff.patch');
    writeFileSync(patch, PATCH);
    return run(['check-candidates', '--diff-file', patch, ...extra], JSON.stringify({ candidates }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a patch line of the same file is offered as the new-file line', () => {
  const result = check([candidate('cand_patch', 'src/a.ts', 5)]);
  assert.equal(result.code, 1, result.stderr);
  const [failure] = JSON.parse(result.stdout).anchorFailures;
  assert.match(failure.reason, /line 5 of diff\.patch is line 40 of src\/a\.ts; use line 40/);
});

test('--apply-patch-lines keeps the candidate at the new-file line and says so', () => {
  const result = check([candidate('cand_patch', 'src/a.ts', 6), candidate('cand_fine', 'src/a.ts', 40)], ['--apply-patch-lines']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Re-anchored cand_patch from src\/a\.ts:6 .* to src\/a\.ts:41/);
  const kept = JSON.parse(result.stdout).kept;
  assert.deepEqual(kept.map((entry) => [entry.candidate_id, entry.line]), [['cand_patch', 41], ['cand_fine', 40]]);
});

test('a patch line that belongs to another file gets no suggestion and is not applied', () => {
  const result = check([candidate('cand_other', 'src/a.ts', 11)]);
  assert.equal(result.code, 1, result.stderr);
  assert.doesNotMatch(JSON.parse(result.stdout).anchorFailures[0].reason, /use line/);

  const applied = check([candidate('cand_other', 'src/a.ts', 11)], ['--apply-patch-lines']);
  assert.equal(applied.code, 1, applied.stderr);
  assert.doesNotMatch(applied.stderr, /Re-anchored/);
});
