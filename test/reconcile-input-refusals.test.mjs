/**
 * `reconcile` refuses input it cannot apply safely, rather than skipping it.
 *
 * A skipped drop would post a finding the second pass removed; a skipped
 * downgrade would post it a tier too high; an empty verification file would
 * read as "nothing was traced" and make every dispute disappear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSecondPass, reconcile, ReconcileInputError } from '../plugins/review-voice/src/verify/reconcile.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = (id, line) => ({
  candidate_id: id,
  path: 'src/cache.ts',
  line,
  category: 'correctness',
  severity: 'important',
  claim: `${id}: the cache entry outlives its invalidation.`,
  failure_mode: 'Readers see stale prices.',
  evidence: [`src/cache.ts:${line} keeps the entry.`],
  technical_confidence: 0.9,
});

const verdict = (over = {}) => ({
  candidateId: 'k1',
  path: 'src/cache.ts',
  line: 10,
  verdict: 'uncertain',
  confidence: 0.6,
  reason: 'only on a cold start',
  outcome: 'downgraded',
  originalSeverity: 'important',
  finalSeverity: 'minor',
  verifier: 'second-model',
  ...over,
});

for (const [name, entry, pattern] of [
  ['an unknown outcome', verdict({ outcome: 'ignored' }), /verdict 0: outcome must be one of kept, downgraded, dropped, unverified/],
  ['a downgrade without finalSeverity', verdict({ finalSeverity: undefined }), /verdict 0: a downgraded verdict needs finalSeverity/],
  ['a downgrade with an empty finalSeverity', verdict({ finalSeverity: '' }), /a downgraded verdict needs finalSeverity/],
  ['a verdict with no id and no location', verdict({ candidateId: undefined, path: undefined, line: undefined }), /verdict 0: needs candidateId, or path and line/],
  ['a verdict with no id and a non-integer line', verdict({ candidateId: undefined, line: '10' }), /needs candidateId, or path and line/],
]) {
  test(`parseSecondPass refuses ${name}`, () => {
    assert.throws(() => parseSecondPass({ verdicts: [entry] }), (error) => error instanceof ReconcileInputError && pattern.test(error.message));
  });
}

test('parseSecondPass refuses a report with no verdict list', () => {
  assert.throws(() => parseSecondPass({ results: [] }), ReconcileInputError);
  assert.throws(() => parseSecondPass('verdicts'), ReconcileInputError);
});

test('reconcile refuses two verdicts for one candidate, by id or by location', () => {
  const verification = [{ candidate_id: 'k1', technical_confidence: 0.9, impact_traced: true }];
  assert.throws(
    () => reconcile([candidate('k1', 10)], verification, [verdict(), verdict({ outcome: 'dropped' })], null),
    /verdict 1: a second verdict for k1/,
  );
  assert.throws(
    () => reconcile([candidate('k1', 10)], verification, [verdict(), verdict({ candidateId: undefined })], null),
    /verdict 1: a second verdict for k1/,
  );
});

test('reconcile refuses duplicate candidate ids and a candidate with no id', () => {
  assert.throws(() => reconcile([candidate('k1', 10), candidate('k1', 20)], [], [], null), /candidate ids must be unique/);
  const anonymous = candidate('k1', 10);
  delete anonymous.candidate_id;
  assert.throws(() => reconcile([anonymous], [], [], null), /candidate 0: candidate_id must be a non-empty string/);
});

function cli(dir, verification, secondPass, candidates) {
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(verification));
  writeFileSync(join(dir, 'second-pass.json'), JSON.stringify(secondPass));
  return spawnSync(
    process.execPath,
    [bundle, 'reconcile', '--verification', join(dir, 'verification.json'), '--second-pass', join(dir, 'second-pass.json')],
    { cwd: dir, encoding: 'utf8', input: JSON.stringify({ candidates }), env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
  );
}

test('the reconcile command refuses an empty verification file, and a malformed second pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reconcile-refusals-'));
  try {
    for (const empty of [[], { results: [] }]) {
      const r = cli(dir, empty, { verdicts: [verdict()] }, [candidate('k1', 10)]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /contained no verifications, so no dispute could be detected/);
    }
    const bad = cli(dir, [{ candidate_id: 'k1', technical_confidence: 0.9 }], { verdicts: [verdict({ outcome: 'maybe' })] }, [candidate('k1', 10)]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Cannot read the second pass/);
    const twice = cli(dir, [{ candidate_id: 'k1', technical_confidence: 0.9 }], { verdicts: [verdict(), verdict()] }, [candidate('k1', 10)]);
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /Cannot reconcile: verdict 1: a second verdict for k1/);
    const dupes = cli(dir, [{ candidate_id: 'k1', technical_confidence: 0.9 }], { verdicts: [] }, [candidate('k1', 10), candidate('k1', 20)]);
    assert.equal(dupes.status, 2);
    assert.match(dupes.stderr, /candidate ids must be unique/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
