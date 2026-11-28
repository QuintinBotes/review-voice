import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withComparisons } from '../plugins/review-voice/src/evidence/comparisons.ts';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const report = { enabled: false, signals: [], commands: [], didNotRun: [] };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-comparison-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'diff.patch'), 'diff --git a/api.yaml b/api.yaml\n--- a/api.yaml\n+++ b/api.yaml\n@@ -1,2 +1,2 @@\n-required: []\n+required: [currency]\n type: object\n');
  writeFileSync(join(dir, 'files.json'), JSON.stringify({ mode: 'base', head, refs: { mergeBase: base }, files: [{ path: 'api.yaml', reviewed: true, class: 'source' }] }));
  const path = join(dir, 'comparison.json');
  return { dir, path, run(reports, override = {}) {
    writeFileSync(path, JSON.stringify({ base, head, reports, ...override }));
    return withComparisons(report, path, dir);
  } };
}
const change = { id: 'new-required-request-property', operation: 'POST', path: '/prices', text: 'currency is now required', level: 3, revisionSource: { file: 'api.yaml', line: 1 } };
const pair = { isNew: true, firstFile: { name: 'api.yaml', start: 1, end: 1 }, secondFile: { name: 'schemas/prices.yaml', start: 5, end: 5 } };
const sample = { name: 'price lookup', metric: 'duration', unit: 'us', runner: 'linux-a', samples: [10,11,12] };
const bench = { base: sample, head: { ...sample, samples: [20,21,22] }, direction: 'lower', thresholdPercent: 15, location: { path: 'api.yaml', line: 1 } };

test('the built evidence CLI imports revision-bound local reports with commands disabled', async t => {
  const input = setup(t);
  await input.run([{ format: 'oasdiff', data: [change, { ...change, level: 1 }] },
    { format: 'jscpd', data: { duplicates: [pair, { ...pair, isNew: false }] } },
    { format: 'benchmark-v1', data: [bench, { ...bench, head: sample }] }]);
  const cli = resolve('plugins/review-voice/dist/review-voice.mjs');
  const output = JSON.parse(execFileSync(process.execPath, [cli, 'evidence', '--review-dir', input.dir], {
    env: { ...process.env, REVIEW_VOICE_NO_COMMANDS: '1', REVIEW_VOICE_COMPARISON_REPORT: input.path }
  }));
  assert.deepEqual(output.signals.map(s => s.kind), ['api_compatibility', 'introduced_clone', 'performance_comparison']);
  assert.deepEqual(output.comparison.notes, []);
  assert.deepEqual(output.signals[1].evidence.slice(1), ['api.yaml:1-1', 'schemas/prices.yaml:5-5']);
  assert.equal(output.commands.length, 0);
});
test('stale comparisons, missing locations and differently measured benchmarks are inconclusive', async t => {
  const input = setup(t);
  const runs = await Promise.all([
    await input.run([], { head: base }),
    await input.run([{ format: 'oasdiff', data: [{ ...change, revisionSource: { file: 'api.yaml', line: 99 } }] }]),
    await input.run([{ format: 'benchmark-v1', data: [{ ...bench, head: { ...bench.head, unit: 'ms' } }, { ...bench, head: null }] }]),
    await input.run([{ format: 'jscpd', data: { duplicates: [{ ...pair, secondFile: { ...pair.secondFile, name: '../outside' } }] } }]),
  ]);
  for (const result of runs) { assert.equal(result.signals.length, 0); assert.ok(result.comparison.notes.length); }
});
test('throughput, noise, unchanged ranges and generated peers', async t => {
  const input = setup(t);
  const result = await input.run([
    { format: 'benchmark-v1', data: [{ ...bench, direction: 'higher', base: bench.head, head: sample },
      { ...bench, head: { ...sample, samples: [11,30,31] } }, { ...bench, location: null }] },
    { format: 'jscpd', data: { duplicates: [{ ...pair, firstFile: { ...pair.firstFile, start: 2, end: 3 } },
      { ...pair, secondFile: { ...pair.secondFile, name: 'vendor/api.yaml' } }] } },
  ]);
  assert.equal(result.signals.length, 1);
  assert.match(result.comparison.notes.join(' '), /No source location/);
});

test('a base-side removal must map to an actual head deletion site', async t => {
  const input = setup(t);
  const removed = { ...change, revisionSource: null, baseSource: { file: base + ':api.yaml', line: 1 } };
  const result = await input.run([{ format: 'oasdiff', data: [removed] }]);
  assert.equal(result.signals[0].line, 1);
});
