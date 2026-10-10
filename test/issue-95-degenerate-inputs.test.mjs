/** Issue #95: parser, mapper, and validator boundary cases are paired with verifier checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function section(text, heading) {
  const start = text.indexOf(`### ${heading}\n`);
  assert.ok(start >= 0, `missing ${heading} section`);
  const next = text.indexOf('\n### ', start + heading.length + 5);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

test('the analyst enumerates degenerate inputs and replacement-type fields', () => {
  const analyst = section(read('plugins/review-voice/agents/diff-analyst.md'), 'Parsers, mappers and validators');
  for (const phrase of [
    'blank', 'separators only', 'zero or empty', 'empty list', 'null',
    'missing root', 'wrong case', 'trailing whitespace', 'repeated element',
    'valid domain value', 'silent no-op', 'optional ones',
  ]) {
    assert.ok(analyst.includes(phrase), `analyst rule omits ${phrase}`);
  }
});

test('the verifier traces the named case instead of accepting a plausible risk', () => {
  const verifier = section(read('plugins/review-voice/agents/evidence-verifier.md'), 'Parsers, mappers and validators');
  for (const phrase of ['exercise the named', 'valid domain value', 'silent no-op', 'old and new fields', 'optional ones', 'existing guard']) {
    assert.ok(verifier.includes(phrase), `verifier rule omits ${phrase}`);
  }
});

test('the corpus has a caught separator-only parser and a validated restraint', () => {
  const positive = read('fixtures/positive/degenerate-parser-input/case.yaml');
  const negative = read('fixtures/negative/validated-parser-input/case.yaml');
  assert.match(positive, /separator-only/i);
  assert.match(read('fixtures/positive/degenerate-parser-input/diff.patch'), /Scope\.None/);
  assert.match(negative, /No actionable findings\./);
  assert.match(read('fixtures/negative/validated-parser-input/diff.patch'), /new Set\(names\)/);
});
