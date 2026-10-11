import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('added or changed tests need a production mutation that makes them red', () => {
  const analyst = read('plugins/review-voice/agents/diff-analyst.md');
  const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

  assert.match(analyst, /For each added or changed test, name the smallest production\s+mutation that should turn it red/);
  assert.match(analyst, /raise a `test_coverage`\s+candidate at the test line and name the assertion or setup that leaves it\s+green/);
  assert.match(analyst, /Shared tracked read-backs, nullable negative-only or subset assertions/);
  assert.match(analyst, /`nameof` wire values/);
  assert.match(verifier, /trace the\s+named smallest production mutation through the production flow and the test/);
  assert.match(verifier, /cited assertion or setup admits that mutation and the\s+test stays green/);
  assert.match(verifier, /candidate when an existing setup or assertion catches the mutation/);
});

test('fixtures distinguish a tracked read-back from a persistence-sensitive test', () => {
  const blind = read('fixtures/positive/test-revert-blind/diff.patch');
  const sensitive = read('fixtures/negative/test-revert-sensitive/diff.patch');

  assert.match(blind, /await _db\.SaveChangesAsync/);
  assert.match(blind, /await db\.Orders\.SingleAsync/);
  assert.match(sensitive, /OpenFreshDbConnection/);
  assert.match(read('fixtures/negative/test-revert-sensitive/case.yaml'), /output: "No actionable findings\."/);
});
