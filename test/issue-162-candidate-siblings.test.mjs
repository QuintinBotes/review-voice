/**
 * Candidates from different sources (the analyst, a second model, another lane)
 * often raise one concern twice, and one anchor can carry two different
 * concerns. check-candidates marks both cases and drops neither (#162).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const base = {
  path: 'src/orders/query.ts',
  line: 40,
  category: 'correctness',
  severity: 'minor',
  failure_mode: 'Orders from another day are returned.',
  evidence: ['src/orders/query.ts:40 builds the date range.'],
  technical_confidence: 0.8,
};

function check(candidates) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-siblings-'));
  try {
    const diff = join(dir, 'diff.patch');
    const thread = join(dir, 'thread.json');
    const added = Array.from({ length: 10 }, (_, i) => `+const line${36 + i} = ${36 + i};`);
    writeFileSync(diff, ['diff --git a/src/orders/query.ts b/src/orders/query.ts', '--- a/src/orders/query.ts', '+++ b/src/orders/query.ts', '@@ -35,0 +36,10 @@', ...added, ''].join('\n'));
    writeFileSync(thread, JSON.stringify({ repository: 'example/orders', pullNumber: 1, comments: [], reviews: [] }));
    const r = spawnSync(process.execPath, [bundle, 'check-candidates', '--diff-file', diff, '--thread', thread], {
      encoding: 'utf8',
      input: JSON.stringify({ candidates }),
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#162: the same claim from two sources is kept twice and the later one points at the earlier', () => {
  const out = check([
    { ...base, candidate_id: 'cand_001', claim: 'The date range filter uses an inclusive end and returns the next day orders.' },
    { ...base, candidate_id: 'codex_001', line: 44, claim: 'The inclusive end of the date range filter returns orders from the next day.' },
  ]);
  assert.equal(out.kept.length, 2);
  assert.equal(out.kept[0].possibleDuplicateOf, undefined);
  assert.deepEqual(out.kept[1].possibleDuplicateOf, { candidate_id: 'cand_001', kind: 'same-claim' });
});

test('#162: two different concerns on one anchor share it but are not marked duplicates', () => {
  const out = check([
    { ...base, candidate_id: 'cand_001', claim: 'The date range filter uses an inclusive end and returns the next day orders.' },
    { ...base, candidate_id: 'tn_001', category: 'maintainability', severity: 'nit', claim: 'Pagination limits are duplicated across three helpers instead of one constant.' },
  ]);
  assert.equal(out.kept.length, 2);
  assert.deepEqual(out.kept[0].sharesAnchorWith, ['tn_001']);
  assert.deepEqual(out.kept[1].sharesAnchorWith, ['cand_001']);
  assert.equal(out.kept[1].possibleDuplicateOf, undefined);
});

test('#162: the same claim on the same anchor is marked same-anchor', () => {
  const claim = 'The date range filter uses an inclusive end and returns the next day orders.';
  const out = check([
    { ...base, candidate_id: 'cand_001', claim },
    { ...base, candidate_id: 'codex_001', claim },
  ]);
  assert.deepEqual(out.kept[1].possibleDuplicateOf, { candidate_id: 'cand_001', kind: 'same-anchor' });
});
