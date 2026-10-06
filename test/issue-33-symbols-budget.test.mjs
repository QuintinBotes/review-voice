import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSymbolContext } from '../plugins/review-voice/src/diff/symbols.ts';

// `symbols` ran for 15+ minutes on large diffs. It now has a time budget that
// the process enforces itself, between and within searches, and reports what
// it did not finish instead of running on.

const files = ['alpha', 'beta', 'gamma', 'delta'];
const diff = files
  .flatMap((name) => [
    `diff --git a/src/${name}.ts b/src/${name}.ts`,
    `--- a/src/${name}.ts`,
    `+++ b/src/${name}.ts`,
    '@@ -1 +1 @@',
    `+export const ${name}FirstSymbol = ${name}SecondSymbol;`,
  ])
  .join('\n');

test('an exhausted budget keeps finished files and marks the rest inconclusive', () => {
  let clock = 0;
  const searched = [];
  const report = collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: null,
    maxMs: 100,
    now: () => clock,
    search: (symbol, _cwd, _ref, timeoutMs) => {
      searched.push([symbol, timeoutMs]);
      clock += 40; // each search is slow
      return ['src/consumer.ts'];
    },
  });

  assert.equal(report.files.length, 4, 'an unfinished file is listed, not dropped');
  assert.equal(report.budget.exhausted, true);
  assert.equal(report.budget.maxMs, 100);

  const finished = report.files.filter((file) => file.inconclusive !== true);
  const unfinished = report.files.filter((file) => file.inconclusive === true);
  assert.ok(unfinished.length >= 3);
  assert.ok(unfinished.every((file) => file.reason === 'time-budget'));
  // Searches that completed before the deadline are still reported.
  const partial = report.files.flatMap((file) => file.symbols);
  assert.ok(partial.length >= 2 && partial.every((entry) => entry.references?.[0] === 'src/consumer.ts'));
  assert.equal(finished.length + unfinished.length, 4);

  // No search starts after the budget is spent, and each is told what is left.
  assert.equal(searched.length, 3);
  assert.deepEqual(searched.map(([, timeout]) => timeout), [100, 60, 20]);
});

test('a collection inside its budget is untouched by it', () => {
  let clock = 0;
  const report = collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: null,
    maxMs: 1_000,
    now: () => clock++,
    search: () => [],
  });
  assert.equal(report.budget.exhausted, false);
  assert.ok(report.files.every((file) => file.inconclusive === undefined && file.reason === undefined));
});

test('symbols --max-ms rejects a value that is not a positive number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-budget-'));
  try {
    const patch = join(dir, 'd.patch');
    writeFileSync(patch, diff);
    const cli = join(dirname(fileURLToPath(import.meta.url)), '../plugins/review-voice/dist/review-voice.mjs');
    for (const value of ['0', 'abc', '-5']) {
      const run = spawnSync('node', [cli, 'symbols', '--diff-file', patch, '--max-ms', value], { encoding: 'utf8', cwd: dir });
      assert.equal(run.status, 2, `--max-ms ${value}`);
      assert.match(run.stderr, /--max-ms needs a positive number/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
