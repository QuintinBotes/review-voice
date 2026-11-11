/**
 * S17 part A: every recorded run says which family ran its second pass and
 * its challenge (docs/adr/0021, amended). Derived at record time, stored
 * beside the provenance in its column, null for older rows, and printed as a
 * `Families` line by `record`, `explain` and the driver report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { describeFamilies, recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { cleanStages } from '../plugins/review-voice/src/store/effort.ts';
import { reportText } from '../plugins/review-voice/src/review/driver.ts';
import { pluginVersion } from '../plugins/review-voice/src/version.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const CLEAN = 'No actionable findings.';
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };
const STORED_PROVENANCE = { ...PROVENANCE, independence: 'independent', policyVersions: [] };
const verdict = (extra = {}) => ({ candidateId: 'cand_001', path: 'src/a.ts', line: 1, verdict: 'confirmed', confidence: 0.9, reason: '', outcome: 'kept', originalSeverity: 'minor', finalSeverity: 'minor', verifier: 'codex', ...extra });

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-families-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inStore(data, body) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return body(db);
  } finally {
    db.close();
  }
}

const record = (db, extra = {}) =>
  recordRun(db, { repository: 'acme/api', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 4, diff: 'diff', output: CLEAN, provenance: PROVENANCE, ...extra });

function cli(data, args, input = CLEAN) {
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  return spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, input, cwd: data });
}

test('AC-4: recordRun derives the families from the verdicts and the challenge stage, stores them beside the provenance and returns them', (t) => {
  inStore(dataDir(t), (db) => {
    const cases = [
      [{ verdicts: [verdict({ family: 'codex' })], stages: [{ name: 'challenge', seconds: 1, model: 'codex', family: 'codex' }] }, { secondPass: 'codex', challenge: 'codex' }],
      [{ verdicts: [verdict()], stages: [{ name: 'challenge', seconds: 1, model: 'sonnet' }] }, { secondPass: 'unknown', challenge: 'claude' }],
      [{ verdicts: [], stages: [{ name: 'analyst', seconds: 1, model: 'sonnet' }] }, { secondPass: null, challenge: null }],
      [{ verdicts: [verdict({ family: 'llama' })], stages: [{ name: 'challenge', seconds: 1, model: 'x', family: 'llama' }] }, { secondPass: 'unknown', challenge: 'claude' }],
      [{}, { secondPass: null, challenge: null }],
    ];
    for (const [input, expected] of cases) {
      const { reviewRunId, families, provenance } = record(db, input);
      assert.deepEqual(families, expected, JSON.stringify(input));
      assert.deepEqual(provenance, STORED_PROVENANCE, 'the provenance keeps its shape');
      const stored = JSON.parse(db.prepare('SELECT provenance_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId).provenance_json);
      assert.deepEqual(stored.families, expected, 'stored as a families key inside provenance_json');
      const detail = runDetail(db, reviewRunId);
      assert.deepEqual(detail.families, expected);
      assert.deepEqual(detail.provenance, STORED_PROVENANCE, 'read back without the key');
    }
  });
});

test('AC-4: a run recorded without provenance has no families, and the column stays NULL', (t) => {
  inStore(dataDir(t), (db) => {
    const { reviewRunId, families } = record(db, { provenance: undefined, verdicts: [verdict({ family: 'codex' })] });
    assert.equal(families, null);
    assert.equal(db.prepare('SELECT provenance_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId).provenance_json, null);
    assert.equal(runDetail(db, reviewRunId).families, null);
  });
});

test('AC-4: a row recorded before the key, and a malformed value, read as families null while the provenance still reads', (t) => {
  inStore(dataDir(t), (db) => {
    const { reviewRunId } = record(db, { verdicts: [verdict({ family: 'codex' })] });
    const set = (value) => db.prepare('UPDATE review_runs SET provenance_json = ? WHERE review_run_id = ?').run(JSON.stringify(value), reviewRunId);
    set(STORED_PROVENANCE);
    assert.equal(runDetail(db, reviewRunId).families, null, 'no key');
    assert.deepEqual(runDetail(db, reviewRunId).provenance, STORED_PROVENANCE);
    for (const malformed of ['codex', { secondPass: 'llama', challenge: null }, { secondPass: null }, { secondPass: null, challenge: 'unknown' }]) {
      set({ ...STORED_PROVENANCE, families: malformed });
      assert.equal(runDetail(db, reviewRunId).families, null, JSON.stringify(malformed));
      assert.deepEqual(runDetail(db, reviewRunId).provenance, STORED_PROVENANCE);
    }
  });
});

test('AC-4: cleanStages keeps a family only from the closed enum', () => {
  const stages = cleanStages(
    [
      { name: 'challenge', seconds: 1, model: 'codex', family: 'codex' },
      { name: 'verifier', seconds: 1, model: 'sonnet', family: 'llama' },
      { name: 'analyst', seconds: 1, model: 'sonnet' },
    ],
    null,
  );
  assert.deepEqual(stages, [
    { name: 'challenge', seconds: 1, model: 'codex', family: 'codex' },
    { name: 'verifier', seconds: 1, model: 'sonnet' },
    { name: 'analyst', seconds: 1, model: 'sonnet' },
  ]);
});

test('AC-4: record prints the top-level families key, from the --stages and --verdicts files it is given', (t) => {
  const data = dataDir(t);
  writeFileSync(join(data, 'stages.json'), JSON.stringify([{ name: 'challenge', seconds: 2, model: 'codex-5', family: 'codex' }]));
  writeFileSync(join(data, 'verdicts.json'), JSON.stringify({ verdicts: [verdict({ family: 'gemini' })] }));
  const result = cli(data, ['record', '--origin', 'driver', '--stages', join(data, 'stages.json'), '--verdicts', join(data, 'verdicts.json')]);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.families, { secondPass: 'gemini', challenge: 'codex' });
  assert.equal(printed.provenance.pluginVersion, pluginVersion());
  assert.deepEqual(inStore(data, (db) => runDetail(db, printed.reviewRunId).families), { secondPass: 'gemini', challenge: 'codex' });
  assert.deepEqual(inStore(data, (db) => runDetail(db, printed.reviewRunId).stages), [{ name: 'challenge', seconds: 2, model: 'codex-5', family: 'codex' }]);

  const plain = JSON.parse(cli(data, ['record']).stdout);
  assert.deepEqual(plain.families, { secondPass: null, challenge: null }, 'a run with provenance and no stages records none');
});

test('AC-4: describeFamilies prints each exact form', () => {
  assert.equal(describeFamilies({ secondPass: 'codex', challenge: 'claude' }), 'Families second-pass codex, challenge claude');
  assert.equal(describeFamilies({ secondPass: 'unknown', challenge: 'codex' }), 'Families second-pass unknown, challenge codex');
  assert.equal(describeFamilies({ secondPass: null, challenge: null }), 'Families second-pass none, challenge none');
  assert.equal(describeFamilies(null), 'Families not recorded');
});

test('AC-4: explain prints the Families line after the Effort lines, and not recorded for a run without provenance', (t) => {
  const data = dataDir(t);
  const withFamilies = inStore(data, (db) =>
    record(db, {
      verdicts: [verdict({ family: 'codex' })],
      stages: [{ name: 'analyst', seconds: 3 }, { name: 'challenge', seconds: 1, model: 'sonnet' }],
    }).reviewRunId,
  );
  const lines = cli(data, ['explain', '--run', withFamilies]).stdout.split('\n');
  const effort = lines.map((line, index) => (line.startsWith('Effort ') ? index : -1)).filter((index) => index !== -1);
  assert.equal(effort.length, 2);
  assert.equal(lines[effort.at(-1) + 1], 'Families second-pass codex, challenge claude');
  assert.match(lines[lines.findIndex((line) => line.startsWith('Provenance')) + 1], /^Checks /, 'the provenance and checks lines are where they were');

  const legacy = inStore(data, (db) => record(db, { provenance: undefined }).reviewRunId);
  const legacyLines = cli(data, ['explain', '--run', legacy]).stdout.split('\n');
  assert.ok(legacyLines.includes('Provenance not recorded'));
  assert.ok(legacyLines.includes('Families not recorded'));
});

test('AC-4: the driver report prints the Families line on the line after Provenance, in each form', () => {
  const report = (families) => ({
    exitCode: 0,
    runId: 'run-1',
    head: 'a'.repeat(40),
    runDir: '/runs/one',
    scope: null,
    plan: null,
    findings: [],
    held: [],
    verdict: { event: 'APPROVE', action: 'post' },
    posted: false,
    carried: false,
    reviewUrl: null,
    costUsd: null,
    seconds: 1,
    stages: [],
    notes: [],
    configSource: null,
    provenance: STORED_PROVENANCE,
    families,
    failure: null,
  });
  for (const [families, line] of [
    [{ secondPass: 'codex', challenge: 'claude' }, 'Families second-pass codex, challenge claude'],
    [{ secondPass: null, challenge: null }, 'Families second-pass none, challenge none'],
    [null, 'Families not recorded'],
  ]) {
    const lines = reportText(report(families)).split('\n');
    const at = lines.findIndex((entry) => entry.startsWith('Provenance '));
    assert.ok(at !== -1);
    assert.equal(lines[at + 1], line);
  }
});
