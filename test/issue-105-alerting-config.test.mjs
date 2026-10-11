/** Issue #105: alert routing evidence and threshold meaning are verified together. */
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

test('the analyst asks for routing-map evidence and keeps alert thresholds scoped', () => {
  const analyst = section(read('plugins/review-voice/agents/diff-analyst.md'));
  for (const phrase of [
    'label-to-route key', 'matching series', 'telemetry is outside',
    'manual re-save or reassignment', 'threshold reused', 'distinct units or meanings',
    'scoped threshold per alert',
  ]) {
    assert.ok(analyst.includes(phrase), `analyst rule omits ${phrase}`);
  }
});

test('the verifier requires evidence for data, operational migration, and threshold meaning', () => {
  const verifier = section(read('plugins/review-voice/agents/evidence-verifier.md'));
  for (const phrase of [
    'telemetry, data, or a repository source', 'every key\'s series',
    'missing context', 'manual re-save or reassignment', 'distinct units or meanings',
  ]) {
    assert.ok(verifier.includes(phrase), `verifier rule omits ${phrase}`);
  }
});

test('the corpus catches a shared threshold with two meanings and accepts named values', () => {
  const positive = read('fixtures/positive/alert-threshold-meaning/case.yaml');
  const negative = read('fixtures/negative/alert-threshold-meaning/case.yaml');
  assert.match(positive, /two (?:unrelated|different) alert meanings/i);
  assert.match(read('fixtures/positive/alert-threshold-meaning/diff.patch'), /min_calls/);
  assert.match(negative, /No actionable findings\./);
  assert.match(read('fixtures/negative/alert-threshold-meaning/diff.patch'), /queue_depth_threshold/);
});
