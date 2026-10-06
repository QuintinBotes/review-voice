/**
 * `explain` on a run recorded before reconcile marked rulings `applied`.
 *
 * Such a run stores the tie-breaker's rulings as they were, with no mark. It
 * must explain exactly as it did when it was recorded: an upheld ruling hides
 * the drop it overturned, and nothing is called "not applied". Only a ruling
 * reconcile marked `applied: false` is.
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

const kept = {
  candidateId: 'k1',
  path: 'src/queue.ts',
  line: 10,
  verdict: 'uncertain',
  confidence: 0.6,
  reason: 'only on a cold start',
  outcome: 'downgraded',
  originalSeverity: 'important',
  finalSeverity: 'minor',
  verifier: 'second-model',
};

function explain(rulings) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-legacy-rulings-'));
  try {
    const run = (args, input) =>
      spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } });
    writeFileSync(join(dir, 'verdicts.json'), JSON.stringify({ verdicts: [kept] }));
    writeFileSync(join(dir, 'rulings.json'), JSON.stringify(rulings));
    const recorded = run(
      ['record', '--repository', 'o/r', '--verdicts', join(dir, 'verdicts.json'), '--tie-breaks', join(dir, 'rulings.json')],
      '[minor] `src/queue.ts:10` - The worker acknowledges before the write commits.\n',
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    return run(['explain', '--run', JSON.parse(recorded.stdout).reviewRunId], '').stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an unmarked ruling is shown as it was, with no "not applied"', () => {
  const text = explain([{ candidate_id: 'k1', upheld: false, reason: 'Guarded at src/queue.ts:8.' }]);
  assert.match(text, /tie-break\s+not upheld - Guarded at src\/queue\.ts:8\./);
  assert.doesNotMatch(text, /not applied/);
});

test('a ruling reconcile marked applied: false is shown as not applied', () => {
  const text = explain([{ candidate_id: 'k1', upheld: true, reason: 'src/queue.ts:10 acks early.', applied: false }]);
  assert.match(text, /tie-break\s+upheld \(not applied\) - src\/queue\.ts:10 acks early\./);
});
