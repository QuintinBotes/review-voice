import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { changedLineCount, cleanStages, shallowPassWarning } from '../plugins/review-voice/src/store/effort.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const patchOf = (lines) =>
  ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', `@@ -1,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`), ''].join('\n');

test('changed lines exclude headers and context', () => {
  assert.equal(changedLineCount(patchOf(7)), 7);
});

test('a clean result from a few tool calls on a large diff is warned about', () => {
  const stages = cleanStages([{ name: 'analyst', seconds: 18, toolCalls: 4, filesRead: 2 }], patchOf(300));
  assert.equal(stages[0].diffLines, 300);
  assert.match(shallowPassWarning(stages, 0), /4 tool call\(s\) on 300 changed lines/);
});

test('findings, a deep pass, a small diff or missing data raise no warning', () => {
  const analyst = (toolCalls) => cleanStages([{ name: 'analyst', seconds: 60, toolCalls }], patchOf(300));
  assert.equal(shallowPassWarning(analyst(4), 1), null, 'a pass that found something is not a clean result');
  assert.equal(shallowPassWarning(analyst(15), 0), null);
  assert.equal(shallowPassWarning(cleanStages([{ name: 'analyst', seconds: 5, toolCalls: 1 }], patchOf(30)), 0), null);
  assert.equal(shallowPassWarning(cleanStages([{ name: 'analyst', seconds: 5 }], patchOf(300)), 0), null, 'effort unknown');
  assert.equal(shallowPassWarning(cleanStages([{ name: 'analyst', seconds: 5, toolCalls: 1 }], null), 0), null, 'no diff to compare');
});

test('record keeps the effort, warns locally, and explain shows both', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-effort-'));
  try {
    const patch = join(data, 'd.patch');
    const stagesFile = join(data, 'stages.json');
    writeFileSync(patch, patchOf(300));
    writeFileSync(stagesFile, JSON.stringify([{ name: 'analyst', seconds: 18, toolCalls: 4, filesRead: 2, tokens: 9000, extra: 'dropped' }]));
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
    const run = (args, input) => execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, input });

    const recorded = JSON.parse(run(['record', '--diff-file', patch, '--stages', stagesFile], 'No actionable findings.'));
    assert.equal(recorded.warnings.length, 1);

    const detail = JSON.parse(run(['explain', '--json']));
    assert.deepEqual(detail.stages, [{ name: 'analyst', seconds: 18, toolCalls: 4, tokens: 9000, filesRead: 2, diffLines: 300 }]);

    const text = run(['explain']);
    assert.match(text, /Effort analyst: 18s, 4 tool calls, 2 files read, 9000 tokens, on 300 changed lines/);
    assert.match(text, /Warning The analyst made 4 tool call/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
