/** Issue #103: a completeness finding must enumerate the complete set. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the analyst and verifier independently require every in-scope call site', () => {
  const analyst = read('plugins/review-voice/agents/diff-analyst.md');
  const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

  assert.match(analyst, /every\s+call site of that pattern in the changed scope/);
  assert.match(analyst, /every miss with\s+its `path:line` in one candidate's evidence/);
  assert.match(analyst, /inconclusive or the\s+pattern is dynamic, do not claim completeness/);
  assert.match(verifier, /independently enumerate every call site of its\s+pattern in the changed scope at the final head/);
  assert.match(verifier, /evidence names every miss\s+as `path:line`/);
  assert.match(verifier, /partial or inconclusive search cannot support an `every` or\s+completeness claim/);
});

test('completeness fixtures cover all misses together and a fully covered restraint case', () => {
  const positive = 'fixtures/positive/complete-call-sites';
  const negative = 'fixtures/negative/complete-call-sites-covered';
  assert.match(read(`${positive}/case.yaml`), /both uninstrumented calls are listed\s+in one finding/);
  assert.match(read(`${positive}/diff.patch`), /Count every loader request/);
  assert.match(read(`${negative}/case.yaml`), /No actionable findings\./);
  assert.match(read(`${negative}/diff.patch`), /countedFetch/);
});
