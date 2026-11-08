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
