/**
 * Issue #100: cross-service reviews have to establish compatibility and
 * rollout enforcement from code or contracts, never from deployment prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const read = (path) => readFileSync(join(plugin, path), 'utf8');

test('the analyst checks peer compatibility, rollout enforcement and cross-repository claims', () => {
  const analyst = read('agents/diff-analyst.md');

  assert.match(analyst, /what the old peer does with a new field, what\s+the new peer does with an old request, and what null and absent mean/);
  assert.match(analyst, /compatible default,\s+draft or blocking label/);
  assert.match(analyst, /copied cross-service constants and comments\s+that claim a compile-time link across repositories/);
  assert.match(analyst, /peer is not\s+readable, make unproved semantics a question/);
});

test('the verifier requires peer evidence and records an unavailable peer as missing context', () => {
  const verifier = read('agents/evidence-verifier.md');

  assert.match(verifier, /null and\s+absent semantics, against peer code or a versioned contract rather than prose/);
  assert.match(verifier, /rollout order is enforced by a compatible default, draft or blocking\s+label/);
  assert.match(verifier, /shared constants or compile-time links across\s+repositories/);
  assert.match(verifier, /required_context_missing/);
});
