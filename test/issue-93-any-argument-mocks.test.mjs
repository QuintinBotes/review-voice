import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('multi-call mocks must constrain arguments derived from earlier results', () => {
  const analyst = read('plugins/review-voice/agents/diff-analyst.md');
  const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

  assert.match(analyst, /called more than once with later arguments derived from earlier results/);
  assert.match(analyst, /any-argument setup is inadequate unless exact sequential setups or\s+exact-argument verification catches a dropped cursor, key or page/);
  assert.match(verifier, /establish that a later argument\s+depends on an earlier result/);
  assert.match(verifier, /any-argument matcher accepts the wrong\s+argument/);
  assert.match(verifier, /no exact sequential setup or exact-argument verification\s+catches it/);
});

test('fixtures distinguish an any-argument page setup from exact cursor checks', () => {
  const blind = read('fixtures/positive/paged-mock-any-argument/diff.patch');
  const sensitive = read('fixtures/negative/paged-mock-exact-arguments/diff.patch');

  assert.match(blind, /It\.IsAny<string\?>\(\)/);
  assert.match(blind, /ReturnsAsync\(first\)/);
  assert.match(blind, /ReturnsAsync\(second\)/);
  assert.match(sensitive, /GetPageAsync\(null, 100/);
  assert.match(sensitive, /GetPageAsync\("cursor-2", 100/);
  assert.match(sensitive, /client\.Verify/);
  assert.match(read('fixtures/negative/paged-mock-exact-arguments/case.yaml'), /output: "No actionable findings\."/);
});
