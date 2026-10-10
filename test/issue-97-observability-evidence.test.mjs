/** Issue #97: metric labels must describe the final, evidenced outcome. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function section(text) {
  const heading = '### Observability and alerting\n';
  const start = text.indexOf(heading);
  assert.ok(start >= 0, 'missing observability section');
  const next = text.indexOf('\n### ', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

test('the analyst derives every metric label from the final outcome', () => {
  const analyst = section(read('plugins/review-voice/agents/diff-analyst.md'));
  for (const phrase of [
    'every label value', 'final outcome', 'pull-request description',
    'filters and validation', 'free-text outcome', 'siblings use an enum',
    'caller cancellation',
  ]) {
    assert.ok(analyst.includes(phrase), `analyst rule omits ${phrase}`);
  }
});

test('the verifier enumerates reachable labels and distinguishes cancellation', () => {
  const verifier = section(read('plugins/review-voice/agents/evidence-verifier.md'));
  for (const phrase of [
    'reachable label values', 'every assignment', 'final outcome',
    'pull-request description', 'caller cancellation', 'sibling-enum claim',
  ]) {
    assert.ok(verifier.includes(phrase), `verifier rule omits ${phrase}`);
  }
});

test('the corpus distinguishes an unbacked metric label from an evidenced one', () => {
  const positive = read('fixtures/positive/metric-label-evidence/case.yaml');
  const negative = read('fixtures/negative/metric-label-evidence/case.yaml');
  assert.match(positive, /label.*final decision/i);
  assert.match(read('fixtures/positive/metric-label-evidence/pr-body.md'), /sent, denied, or failed/i);
  assert.match(negative, /No actionable findings\./);
  assert.match(read('fixtures/negative/metric-label-evidence/diff.patch'), /DispatchOutcome/);
});
