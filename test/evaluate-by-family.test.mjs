/**
 * S17 part B: `evaluate` reports the second pass's and the challenger's figures
 * per model family (AC-11), from the families each run recorded. Every figure
 * is reported, never a gate, and an absence reads `no data`, never zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { byFamily, describeByFamily } from '../plugins/review-voice/src/evaluate/metrics.ts';

const bundle = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins/review-voice/dist/review-voice.mjs');
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };

const verdict = (outcome, family) => ({
  candidateId: 'c', path: 'src/a.ts', line: 1, verdict: 'confirmed', confidence: 0.9, reason: 'r', outcome,
  originalSeverity: 'minor', finalSeverity: 'minor', verifier: 'v', ...(family === undefined ? {} : { family }),
});
const judged = (heldBack) => ({ candidateId: 'c', challenge: { verdict: heldBack ? 'refuted' : 'confirmed' }, ...(heldBack ? { rejectedBecause: 'challenge-refuted: no' } : {}) });
const stage = (family) => ({ name: 'challenge', seconds: 1, model: 'm', ...(family === undefined ? {} : { family }) });

function withStore(t, seed) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-by-family-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    seed((extra) => recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd', output: 'No actionable findings.', provenance: PROVENANCE, ...extra }), db);
    return { dir, figures: byFamily(db) };
  } finally {
    db.close();
  }
}

const evaluate = (dir, args) => spawnSync(process.execPath, [bundle, 'evaluate', ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } });

function seeded(record, db) {
  // Codex second pass over two runs: 12 verdicts, 3 dropped, 2 downgraded, 1 applied tie-break of 2.
  // Dropped and downgraded differ, so a figure counted or printed as the other shows.
  record({
    verdicts: [
      verdict('dropped', 'codex'), verdict('dropped', 'codex'), verdict('downgraded', 'codex'),
      verdict('kept', 'codex'), verdict('kept', 'codex'), verdict('kept', 'codex'), verdict('kept', 'codex'), verdict('kept', 'codex'),
    ],
    tieBreaks: [{ candidateId: 'c', upheld: true, reason: 'r', applied: true }, { candidateId: 'c', upheld: false, reason: 'r', applied: false }],
    stages: [stage()],
    scores: [judged(true), judged(false), { candidateId: 'unjudged' }],
  });
  record({
    verdicts: [verdict('dropped', 'codex'), verdict('downgraded', 'codex'), verdict('kept', 'codex'), verdict('unverified', 'codex')],
    stages: [stage('codex')],
    scores: [judged(false), judged(false)],
  });
  // A second pass whose family is not known.
  record({ verdicts: [verdict('kept'), verdict('kept')] });
  // A gemini challenge that judged nothing: gemini has neither half and is not listed.
  record({ stages: [stage('gemini')], scores: [{ candidateId: 'unjudged' }] });
  // Neither stage ran.
  record({});
  // Recorded without provenance, so without families.
  record({ provenance: undefined, verdicts: [verdict('dropped', 'codex')], stages: [stage('codex')], scores: [judged(true)] });
  // Recorded with provenance before families were stored: the key is missing, as on a row from before part A.
  const older = record({ verdicts: [verdict('dropped', 'codex')], stages: [stage('codex')], scores: [judged(true)] }).reviewRunId;
  const stored = JSON.parse(db.prepare('SELECT provenance_json FROM review_runs WHERE review_run_id = ?').get(older).provenance_json);
  delete stored.families;
  db.prepare('UPDATE review_runs SET provenance_json = ? WHERE review_run_id = ?').run(JSON.stringify(stored), older);
}

const EXPECTED = {
  families: {
    claude: { second_pass: null, challenge: { judged: 2, held: 1, runs: 1, hold_rate: 0.5 } },
    codex: {
      second_pass: { verdicts: 12, dropped: 3, downgraded: 2, tie_breaks: 1, runs: 2, drop_rate: 0.25, downgrade_rate: 2 / 12, tie_break_rate: 1 / 12 },
      challenge: { judged: 2, held: 0, runs: 1, hold_rate: 0 },
    },
    unknown: {
      second_pass: { verdicts: 2, dropped: 0, downgraded: 0, tie_breaks: 0, runs: 1, drop_rate: 0, downgrade_rate: 0, tie_break_rate: 0 },
      challenge: null,
    },
  },
  runs_without_families: 2,
};

test('AC-11: byFamily counts, rates and nulls per recorded family, and leaves out a family with neither half', (t) => {
  const { figures } = withStore(t, seeded);
  assert.deepEqual(figures, EXPECTED);
});

test('AC-11: evaluate --json carries by_family beside the metrics, and the text prints the by family block', (t) => {
  const { dir } = withStore(t, seeded);
  const json = evaluate(dir, ['--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.by_family, EXPECTED);
  assert.equal(parsed.metrics.some((metric) => metric.name === 'by_family'), false, 'not a metric');
  const text = evaluate(dir, []);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.split('\n');
  const start = lines.indexOf('by family (2 run(s) recorded before families were stored)');
  assert.ok(start > 0, text.stdout);
  assert.deepEqual(lines.slice(start + 1, start + 4), [
    '  claude  second pass no data; challenge 2 judged, hold 0.50, 1 run(s)',
    '  codex   second pass 12 verdicts, drop 0.25, downgrade 0.17, tie-break 0.08, 2 run(s); challenge 2 judged, hold 0.00, 1 run(s)',
    '  unknown second pass 2 verdicts, drop 0.00, downgrade 0.00, tie-break 0.00, 1 run(s); challenge no data',
  ]);
  assert.ok(lines.indexOf('by family (2 run(s) recorded before families were stored)') > lines.findIndex((line) => /challenge_hold_rate/.test(line)), 'after the metrics');
});

test('AC-11: an empty store, and one with only runs from before families, print no data and never zero', (t) => {
  const empty = withStore(t, () => {});
  assert.deepEqual(empty.figures, { families: {}, runs_without_families: 0 });
  assert.deepEqual(describeByFamily(empty.figures), ['by family  no data']);
  const text = evaluate(empty.dir, []);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^by family {2}no data$/m);

  const older = withStore(t, (record) => record({ provenance: undefined, stages: [stage()], scores: [judged(true)] }));
  assert.deepEqual(older.figures, { families: {}, runs_without_families: 1 });
  assert.deepEqual(describeByFamily(older.figures), ['by family  no data (1 run(s) recorded before families were stored)']);
});
