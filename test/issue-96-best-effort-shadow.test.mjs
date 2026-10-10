/**
 * Issue #96: non-fatal work is non-fatal only when every potentially throwing
 * statement is guarded and values are validated before cache publication.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const read = (path) => readFileSync(join(plugin, path), 'utf8');
const fixture = (...parts) => readFileSync(join(root, 'fixtures', ...parts), 'utf8');

function shadowParagraph(text) {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => /\*\*Best-effort and shadow paths\.\*\*/.test(paragraph));
}

test('best-effort handling covers work before the guarded call and validates before caching', () => {
  const analyst = shadowParagraph(read('agents/diff-analyst.md'));
  const verifier = shadowParagraph(read('agents/evidence-verifier.md'));

  assert.equal(analyst.length, 1);
  assert.match(analyst[0], /flag reads, option parsing, metric recording, tracing and logging/);
  assert.match(analyst[0], /guarded or proven unable to throw/);
  assert.match(analyst[0], /cached value must be\s+validated before its write/);

  assert.equal(verifier.length, 1);
  assert.match(verifier[0], /flags, options, metrics, tracing and logging/);
  assert.match(verifier[0], /guarded or\s+cannot throw/);
  assert.match(verifier[0], /cached data is validated before its write/);
});

test('the shared fixture includes both an unsafe path and a fully guarded restraint', () => {
  const positive = fixture('positive', 'shadow-path-parity', 'diff.patch');
  const restraint = fixture('negative', 'shadow-path-parity', 'diff.patch');

  assert.match(positive, /flags\.isEnabled/);
  assert.match(positive, /cache\.set\(order\.id, results\)/);
  assert.match(positive, /results\.map\(mapResult\)/);
  assert.match(restraint, /try \{/);
  assert.match(restraint, /const validated = validateResult\(result\)/);
  assert.match(restraint, /cache\.set\(order\.id, validated\)/);
});
