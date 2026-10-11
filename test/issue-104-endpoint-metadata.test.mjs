/** Issue #104: document-only endpoint metadata cannot silently preempt a filter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function section(text) {
  const heading = '### Endpoint metadata\n';
  const start = text.indexOf(heading);
  assert.ok(start >= 0, 'missing endpoint-metadata section');
  const next = text.indexOf('\n### ', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

test('the analyst checks routing metadata against endpoint filters and middleware', () => {
  const analyst = section(read('plugins/review-voice/agents/diff-analyst.md'));
  for (const phrase of [
    '`Accepts`', 'consumes or', 'route constraints', 'versioning attributes',
    'filter or middleware', 'same condition', 'metadata preempts',
    'change behaviour or only document',
  ]) {
    assert.ok(analyst.includes(phrase), `analyst rule omits ${phrase}`);
  }
});

test('the verifier proves the routing order and overlapping response', () => {
  const verifier = section(read('plugins/review-voice/agents/evidence-verifier.md'));
  for (const phrase of [
    'routing or rejection', 'before filters or middleware run', 'same endpoint',
    'same condition', 'response is preempted', 'intended to change behaviour',
  ]) {
    assert.ok(verifier.includes(phrase), `verifier rule omits ${phrase}`);
  }
});

test('the corpus covers a preempted content-type filter and a document-only restraint', () => {
  const positive = read('fixtures/positive/runtime-endpoint-metadata/case.yaml');
  const negative = read('fixtures/negative/document-only-endpoint-metadata/case.yaml');
  assert.match(positive, /content-type filter/i);
  assert.match(read('fixtures/positive/runtime-endpoint-metadata/diff.patch'), /\.Accepts<ItemRequest>/);
  assert.match(negative, /No actionable findings\./);
  assert.match(read('fixtures/negative/document-only-endpoint-metadata/diff.patch'), /WithOpenApi/);
});
