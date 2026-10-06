/**
 * `explain` hides a dropped finding only behind a ruling `reconcile` applied.
 *
 * Reconcile ignores a tie-break on a candidate nobody disputed, but explain
 * read the tie-breaker's own file and hid every drop with an upheld ruling,
 * so a real suppression vanished from "Suppressed by verification". Reconcile
 * now marks each ruling `applied`, record keeps that, and explain reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTieBreaks } from '../plugins/review-voice/src/verify/reconcile.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = (id, line) => ({
  candidate_id: id,
  path: 'src/jobs.ts',
  line,
  category: 'correctness',
  severity: 'important',
  claim: id === 'd1' ? 'The job marks itself done before the upload finishes.' : 'The lock is released on the error path twice.',
  failure_mode: id === 'd1' ? 'A crash mid-upload loses the file silently.' : 'A second worker takes the lock while the first still runs.',
  evidence: [`src/jobs.ts:${line} does it.`],
  technical_confidence: 0.9,
});

const dropped = (id, line) => ({
  candidateId: id,
  path: 'src/jobs.ts',
  line,
  verdict: 'rejected',
  confidence: 0.9,
  reason: `${id}: not reachable`,
  outcome: 'dropped',
  originalSeverity: 'important',
  finalSeverity: 'important',
  verifier: 'second-model',
});

function cli(args, input, dir) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
}

test('an upheld ruling on an undisputed drop does not hide the suppression', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-applied-'));
  try {
    // d1 was traced at 0.9 and dropped: disputed. d2 was never traced: a drop
    // nobody disputed, so a ruling on it is ignored.
    writeFileSync(
      join(dir, 'verification.json'),
      JSON.stringify([
        { candidate_id: 'd1', technical_confidence: 0.9, impact_traced: true },
        { candidate_id: 'd2', technical_confidence: 0.9, impact_traced: false },
      ]),
    );
    const report = { verdicts: [dropped('d1', 10), dropped('d2', 20)] };
    writeFileSync(join(dir, 'second-pass.json'), JSON.stringify(report));
    writeFileSync(
      join(dir, 'tie-breaks.json'),
      JSON.stringify([
        { candidate_id: 'd1', upheld: true, reason: 'src/jobs.ts:10 marks done before src/upload.ts:4 resolves.' },
        { candidate_id: 'd2', upheld: true, reason: 'src/jobs.ts:20 releases twice.' },
      ]),
    );
    const reconciled = cli(
      ['reconcile', '--verification', join(dir, 'verification.json'), '--second-pass', join(dir, 'second-pass.json'), '--tie-breaks', join(dir, 'tie-breaks.json')],
      JSON.stringify({ candidates: [candidate('d1', 10), candidate('d2', 20)] }),
      dir,
    );
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const out = JSON.parse(reconciled.stdout);
    assert.deepEqual(
      out.tieBreaks.map((t) => [t.candidateId, t.applied]),
      [['d1', true], ['d2', false]],
    );
    assert.deepEqual(out.candidates.map((c) => c.candidate_id), ['d1']);

    writeFileSync(join(dir, 'reconciled.json'), reconciled.stdout);
    writeFileSync(join(dir, 'verdicts.json'), JSON.stringify(report));
    const recorded = cli(
      ['record', '--repository', 'o/r', '--verdicts', join(dir, 'verdicts.json'), '--tie-breaks', join(dir, 'reconciled.json')],
      '[important] `src/jobs.ts:10` - The job marks itself done before the upload finishes.\n',
      dir,
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    const text = cli(['explain', '--run', JSON.parse(recorded.stdout).reviewRunId], '', dir).stdout;
    const suppressed = text.slice(text.indexOf('Suppressed by verification'));
    assert.match(suppressed, /Suppressed by verification \(1\)/);
    assert.match(suppressed, /src\/jobs\.ts:20/);
    assert.match(suppressed, /tie-break upheld but not applied/);
    assert.doesNotMatch(suppressed, /src\/jobs\.ts:10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ruling straight from the tie-breaker is not taken as applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-applied-raw-'));
  try {
    writeFileSync(join(dir, 'verdicts.json'), JSON.stringify({ verdicts: [dropped('d2', 20)] }));
    writeFileSync(join(dir, 'raw.json'), JSON.stringify([{ candidate_id: 'd2', upheld: true, reason: 'src/jobs.ts:20 releases twice.' }]));
    const recorded = cli(
      ['record', '--repository', 'o/r', '--verdicts', join(dir, 'verdicts.json'), '--tie-breaks', join(dir, 'raw.json')],
      'No actionable findings.\n',
      dir,
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    const text = cli(['explain', '--run', JSON.parse(recorded.stdout).reviewRunId], '', dir).stdout;
    assert.match(text, /Suppressed by verification \(1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTieBreaks keeps a boolean applied and refuses any other', () => {
  assert.equal(parseTieBreaks([{ candidate_id: 'd1', upheld: true, reason: 'x', applied: true }])[0].applied, true);
  assert.equal(parseTieBreaks([{ candidate_id: 'd1', upheld: true, reason: 'x' }])[0].applied, undefined);
  assert.throws(() => parseTieBreaks([{ candidate_id: 'd1', upheld: true, reason: 'x', applied: 'yes' }]), /applied must be true or false/);
});
