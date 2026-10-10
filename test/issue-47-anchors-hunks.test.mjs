import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -6,3 +6,4 @@ function f() {
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;
`;
const REVIEW = [
  '[nit] `src/a.ts:3` - Consumer still assumes the old shape.',
  '[nit] `src/a.ts:7` - Added line is unused.',
  '[nit] `src/a.ts:6` - Context line inside the hunk.',
  '[nit] `src/other.ts:1` - File is not in the diff.',
].join('\n\n');

function anchors(args, input) {
  const dir = mkdtempSync(join(tmpdir(), 'rv47-'));
  try {
    writeFileSync(join(dir, 'd.patch'), DIFF);
    writeFileSync(join(dir, 's.json'), JSON.stringify([{ path: 'src/a.ts', line: 6, anchor: 'stale-consumer' }]));
    const full = args.map((a) => a.replace('$D', join(dir, 'd.patch')).replace('$S', join(dir, 's.json')));
    const stdout = execFileSync(process.execPath, [bundle, 'anchors', ...full], {
      encoding: 'utf8',
      input,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a line outside every hunk, or a file not in the diff, is unanchorable', () => {
  const out = anchors(['--diff-file', '$D'], REVIEW);
  assert.equal(out.hunkChecks, 'checked');
  assert.deepEqual(out.anchors.map((a) => a.line), [7, 6]);
  assert.deepEqual(out.unanchored.map((u) => [u.path, u.line, u.reason]), [
    ['src/a.ts', 3, 'outside-hunk'],
    ['src/other.ts', 1, 'file-not-in-diff'],
  ]);
  assert.equal(out.unanchorable, 2);
});

test('a stale-consumer finding is unanchorable even inside a hunk', () => {
  const out = anchors(['--diff-file', '$D', '--scores', '$S'], REVIEW);
  assert.ok(out.unanchored.some((u) => u.line === 6 && u.reason === 'stale-consumer'));
  assert.deepEqual(out.anchors.map((a) => a.line), [7]);
});

test('without a diff, stale consumers are still routed and hunk checks are reported skipped', () => {
  const out = anchors(['--scores', '$S'], REVIEW);
  assert.equal(out.hunkChecks, 'skipped');
  assert.deepEqual(out.unanchored.map((u) => u.reason), ['stale-consumer']);
  assert.equal(out.anchors.length, 3);
});
