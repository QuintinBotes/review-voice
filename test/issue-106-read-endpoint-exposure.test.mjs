/** Issue #106: read-endpoint authorization and payload exposure are one review pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function section(text) {
  const heading = '### Read endpoints\n';
  const start = text.indexOf(heading);
  assert.ok(start >= 0, 'missing read-endpoints section');
  const next = text.indexOf('\n### ', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

test('the analyst reviews authorization, tests, payload, callers, and premises together', () => {
  const analyst = section(read('plugins/review-voice/agents/diff-analyst.md'));
  for (const phrase of [
    'narrowest role', 'no-role', 'wrong-role', 'serialized payload',
    'personal data', 'client-id telemetry', 'already true elsewhere',
    'exact file and line', 'ask a question',
  ]) {
    assert.ok(analyst.includes(phrase), `analyst rule omits ${phrase}`);
  }
});

test('the verifier traces effective access and every payload field before accepting the claim', () => {
  const verifier = section(read('plugins/review-voice/agents/evidence-verifier.md'));
  for (const phrase of [
    'effective inherited', 'narrowest role', 'no-role', 'wrong-role',
    'DTO or serializer fields', 'nested ones', 'client-id telemetry',
    'already true elsewhere', 'cited source at that file and line',
  ]) {
    assert.ok(verifier.includes(phrase), `verifier rule omits ${phrase}`);
  }
});

test('the verifier receives the pull-request description it must compare', () => {
  const review = read('plugins/review-voice/commands/review.md');
  const step = review.slice(review.indexOf('## Step 3 - Verify'), review.indexOf('## Step 3b'));
  assert.match(step, /same `thread\.json`/);
  assert.match(step, /claims in the description/);
});

test('the corpus distinguishes broad, data-bearing reads from a constrained status route', () => {
  const positive = read('fixtures/positive/read-endpoint-exposure/case.yaml');
  const negative = read('fixtures/negative/read-endpoint-exposure/case.yaml');
  assert.match(positive, /status-only/i);
  assert.match(read('fixtures/positive/read-endpoint-exposure/diff.patch'), /OwnerDisplayName/);
  assert.match(negative, /No actionable findings\./);
  assert.match(read('fixtures/negative/read-endpoint-exposure/diff.patch'), /AccountStatusReader/);
});
