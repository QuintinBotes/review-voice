/**
 * #464: an analyst's `category: "lean"` passed check-candidates, and score read
 * the unmapped word as the middle tier, raising a requested nit to minor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSeverity } from '../plugins/review-voice/src/scoring/severity.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-464-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir, args, input = '') =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

const candidate = (category) => ({
  candidate_id: 'cand_001',
  path: 'src/a.ts',
  line: 3,
  category,
  severity: 'nit',
  claim: 'The text key is unused once the column is gone.',
  failure_mode: 'Dead text keys accumulate.',
  evidence: ['nothing reads the key'],
  technical_confidence: 0.9,
});

test('#464: check-candidates refuses a category score cannot map and lists the allowed ones', () =>
  withDir((dir) => {
    const result = run(dir, ['check-candidates'], JSON.stringify({ candidates: [candidate('lean')] }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cand_001: category "lean" is not one score maps to a tier; use one of .*correctness.*maintainability/);
  }));

test('#464: a listed category, or an alias of one, passes check-candidates', () =>
  withDir((dir) => {
    for (const category of ['maintainability', 'bug']) {
      const result = run(dir, ['check-candidates'], JSON.stringify({ candidates: [candidate(category)] }));
      assert.doesNotMatch(result.stderr, /is not one score maps to a tier/, category);
    }
  }));

test('#464: score keeps a requested nit for an unmapped category instead of the middle tier', () => {
  assert.equal(deriveSeverity('lean', 'nit').severity, 'nit');
  assert.equal(deriveSeverity('lean', 'important').severity, 'minor');
});
