import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('contract tests must constrain provider-visible behavior and run in CI', () => {
  const analyst = read('plugins/review-voice/agents/diff-analyst.md');
  const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

  assert.match(analyst, /null examples, enum matchers accepting\s+arbitrary strings, exact nondeterministic values, a copied client/);
  assert.match(analyst, /header\/idempotency interaction without provider state tying the header to an\s+observable response/);
  assert.match(analyst, /check that CI runs the contract project/);
  assert.match(verifier, /trace the interaction to the real\s+provider rather than a copied client/);
  assert.match(verifier, /null,\s+unbounded-enum or exact-nondeterministic matcher/);
  assert.match(verifier, /state-and-response link, or CI exclusion actually permits the named provider\s+drift/);
  assert.match(verifier, /compare the CI command with the contract project path/);
});

test('fixtures distinguish a drift-blind contract from a provider-sensitive one', () => {
  const blind = read('fixtures/positive/contract-provider-drift/diff.patch');
  const sensitive = read('fixtures/negative/contract-provider-drift-sensitive/diff.patch');

  assert.match(blind, /CopiedOrderProvider/);
  assert.match(blind, /Match\.Type\("Accepted"\)/);
  assert.match(blind, /parentId = \(string\?\)null/);
  assert.match(blind, /Guid\.NewGuid\(\)/);
  assert.match(sensitive, /ProviderHarness\.For<OrderApi>/);
  assert.match(sensitive, /Match\.OneOf\("Accepted", "Pending"\)/);
  assert.match(sensitive, /idempotency key repeat-key has id order-42/);
  assert.match(sensitive, /test\/contracts\/Contracts\.csproj/);
  assert.match(read('fixtures/negative/contract-provider-drift-sensitive/case.yaml'), /output: "No actionable findings\."/);
});
