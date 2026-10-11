/**
 * Issue #94: a read-decide-write finding needs a database-side guard and a
 * deterministic two-caller test, not a one-caller pre-check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const read = (path) => readFileSync(join(plugin, path), 'utf8');

test('the analyst requires a database guard, a held two-caller test and a proven conflict', () => {
  const analyst = read('agents/diff-analyst.md');

  assert.match(analyst, /\*\*Read-decide-write handlers\.\*\*/);
  assert.match(analyst, /model, migrations and\s+write for a unique index, concurrency token or conditional update/);
  assert.match(analyst, /concrete two-caller interleaving/);
  assert.match(analyst, /two independent contexts until both reads finish, then releases both/);
  assert.match(analyst, /every save failure into a conflict unless it\s+re-reads and proves a rival write/);
});

test('the verifier rejects an unproven race test or catch-all conflict mapping', () => {
  const verifier = read('agents/evidence-verifier.md');

  assert.match(verifier, /model, migrations and write for the\s+claimed unique index, concurrency token or conditional update/);
  assert.match(verifier, /independent contexts are held until both\s+reads finish before either writes/);
  assert.match(verifier, /merely starting two calls is not enough/);
  assert.match(verifier, /catch covers failures beyond a\s+known conflict and no re-read proves a rival write/);
});
