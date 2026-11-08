/**
 * S12. The command modules under src/cli/ never import cli.ts: importing it
 * runs main at module top level, and it would make a cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins/review-voice/src');

test('no module under src/cli imports cli.ts', () => {
  const files = readdirSync(join(src, 'cli')).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length > 0, 'src/cli holds the command modules');
  for (const file of files) {
    const text = readFileSync(join(src, 'cli', file), 'utf8');
    assert.doesNotMatch(text, /(?:from\s*|import\(\s*)['"]\.\.\/cli\.ts['"]/, `${file} imports cli.ts`);
  }
});

test('cli.ts keeps only the dispatch and the in-process runner', () => {
  const lines = readFileSync(join(src, 'cli.ts'), 'utf8').split('\n').length;
  assert.ok(lines < 600, `src/cli.ts has ${lines} lines`);
});

test('the architecture note names where the handlers live', () => {
  const architecture = readFileSync(join(src, '..', '..', '..', 'docs', 'ARCHITECTURE.md'), 'utf8');
  assert.ok(architecture.includes('src/cli/'));
});
