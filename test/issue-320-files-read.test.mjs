/** #320: a clean result from an analyst that read under half the changed files is warned about, whatever the diff size. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanStages, shallowPassWarning } from '../plugins/review-voice/src/store/effort.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** `files` new files of `each` added lines. */
const patchOf = (files, each) =>
  Array.from({ length: files }, (_, f) =>
    [
      `diff --git a/src/f${f}.ts b/src/f${f}.ts`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/src/f${f}.ts`,
      `@@ -0,0 +1,${each} @@`,
      ...Array.from({ length: each }, (_, i) => `+const v${i} = ${i};`),
    ].join('\n'),
  ).join('\n') + '\n';

const analyst = (filesRead, diff, toolCalls = 30) =>
  cleanStages([{ name: 'analyst', seconds: 90, toolCalls, ...(filesRead === undefined ? {} : { filesRead }) }], diff);

test('the files read are compared with the changed files, independent of the line floor', () => {
  assert.equal(analyst(2, patchOf(14, 20))[0].diffFiles, 14);
  assert.match(shallowPassWarning(analyst(2, patchOf(14, 20)), 0), /read 2 of 14 changed files/);
  assert.match(shallowPassWarning(analyst(0, patchOf(14, 5)), 0), /read 0 of 14 changed files/, 'under 150 changed lines');
});

test('half the files read, a finding, or no filesRead raises no files warning', () => {
  assert.equal(shallowPassWarning(analyst(7, patchOf(14, 20)), 0), null);
  assert.equal(shallowPassWarning(analyst(2, patchOf(14, 20)), 1), null);
  assert.equal(shallowPassWarning(analyst(undefined, patchOf(14, 20)), 0), null);
});

test('a deleted file is not counted as one the analyst could read', () => {
  const deleted = ['diff --git a/old.ts b/old.ts', 'deleted file mode 100644', '--- a/old.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone', ''].join('\n');
  assert.equal(analyst(1, patchOf(1, 3) + deleted)[0].diffFiles, 1);
});

test('a file with no hunk is not counted, wherever git sorts it in the patch', () => {
  const hunkless = {
    'an empty new file': ['diff --git a/z.txt b/z.txt', 'new file mode 100644', 'index 0000000..e69de29'],
    'a pure rename': ['diff --git a/old.ts b/z.ts', 'similarity index 100%', 'rename from old.ts', 'rename to z.ts'],
    'a binary file': ['diff --git a/z.bin b/z.bin', 'index 1234567..89abcde 100644', 'Binary files a/z.bin and b/z.bin differ'],
    'a deleted binary file': ['diff --git a/z.bin b/z.bin', 'deleted file mode 100644', 'index 1234567..0000000', 'Binary files a/z.bin and /dev/null differ'],
  };
  for (const [kind, lines] of Object.entries(hunkless)) {
    const section = `${lines.join('\n')}\n`;
    assert.equal(analyst(1, section + patchOf(2, 3))[0].diffFiles, 2, `${kind} first`);
    assert.equal(analyst(1, patchOf(2, 3) + section)[0].diffFiles, 2, `${kind} last`);
    assert.equal(shallowPassWarning(analyst(1, patchOf(2, 3) + section), 0), null, `${kind} last`);
  }
});

test('record and explain warn when 2 of 14 changed files were read', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-320-'));
  try {
    const patch = join(data, 'd.patch');
    const stagesFile = join(data, 'stages.json');
    writeFileSync(patch, patchOf(14, 20));
    writeFileSync(stagesFile, JSON.stringify([{ name: 'analyst', seconds: 90, toolCalls: 30, filesRead: 2, tokens: 50000 }]));
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
    const run = (args, input) => execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, input, stdio: ['pipe', 'pipe', 'ignore'] });

    const recorded = JSON.parse(run(['record', '--repository', 'o/r', '--diff-file', patch, '--stages', stagesFile], 'No actionable findings.'));
    assert.equal(recorded.warnings?.length, 1);
    assert.match(recorded.warnings[0], /read 2 of 14 changed files/);
    assert.doesNotMatch(recorded.warnings[0], /tool call/, '30 calls cover 280 lines');
    assert.match(run(['explain']), /Warning The analyst read 2 of 14 changed files and found nothing/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
