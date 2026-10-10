/**
 * Issue #107: a probe or shadow path is useful only when its timing,
 * concurrency and cancellation budget match the production path it represents.
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

test('one shared best-effort and shadow paragraph compares production parity', () => {
  const analyst = shadowParagraph(read('agents/diff-analyst.md'));
  const verifier = shadowParagraph(read('agents/evidence-verifier.md'));

  assert.equal(analyst.length, 1);
  assert.match(analyst[0], /Locate the production counterpart and compare timer\s+start and stop, concurrency and timeout or budget/);
  assert.match(analyst[0], /cancellation-token\s+budget, name each awaited call that does not observe it/);

  assert.equal(verifier.length, 1);
  assert.match(verifier[0], /production counterpart to compare timer start and stop, concurrency and timeout\s+or budget/);
  assert.match(verifier[0], /cancellation-token budgets, identify each awaited call that does\s+not receive or observe the token/);
});

test('the parity fixture contrasts a delayed concurrent probe with a matching restraint', () => {
  const positive = fixture('positive', 'shadow-path-parity', 'diff.patch');
  const restraint = fixture('negative', 'shadow-path-parity', 'diff.patch');

  assert.match(positive, /const startedAt = performance\.now\(\);\n\+    const budget/);
  assert.match(positive, /Promise\.all/);
  assert.match(positive, /check\.run\(order, token\)/);
  assert.match(restraint, /const startedAt = performance\.now\(\);\n\+    const enabled/);
  assert.match(restraint, /check\.run\(order, token, budget\)/);
  assert.doesNotMatch(restraint, /Promise\.all/);
});
