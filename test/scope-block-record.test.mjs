import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const CLEAN = 'No actionable findings.';
const HEAD = 'a'.repeat(40);
const SYMBOLS = {
  files: [{ path: 'src/a.ts', inconclusive: true }, { path: 'src/b.ts', inconclusive: false }, { path: 'src/c.ts', inconclusive: true }],
  budget: { exhausted: true },
};
const COMMANDS = [
  { name: 'typecheck', exitCode: 0, signals: [], version: 'tsc 7.0.2' },
  { name: 'missing', exitCode: 127, signals: [], unavailable: 'executable not found' },
  { name: 'lint', exitCode: 1, signals: [{ kind: 'lint' }, { kind: 'lint' }] },
  { name: 'denied', exitCode: 126, signals: [], unavailable: 'permission denied' },
  { name: 'interrupted', exitCode: null, signals: [] },
];
const RAN = [
  { name: 'typecheck', exitCode: 0, signals: 0, version: 'tsc 7.0.2' },
  { name: 'lint', exitCode: 1, signals: 2 },
  { name: 'interrupted', exitCode: null, signals: 0 },
];

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-scope-record-'));
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

function cli(data, args) {
  return spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    input: CLEAN,
    cwd: data,
  });
}

function reports(data, evidence, symbols = SYMBOLS) {
  writeFileSync(join(data, 'evidence.json'), JSON.stringify(evidence));
  writeFileSync(join(data, 'symbols.json'), JSON.stringify(symbols));
  return ['--evidence', join(data, 'evidence.json'), '--symbols', join(data, 'symbols.json')];
}

const record = (db, extra = {}) =>
  recordRun(db, { repository: 'acme/web', baseRef: null, headRef: HEAD, diff: 'diff', output: CLEAN, ...extra });

for (const skipped of ['REVIEW_VOICE_NO_COMMANDS', undefined]) {
  test('AC-1: record stores membership, order and reasons with skipped ' + (skipped ?? 'absent'), (t) => {
    const data = dataDir(t);
    const flags = reports(data, { commands: COMMANDS, didNotRun: ['denied', 'missing', 'disabled'], ...(skipped ? { skipped } : {}) });
    const result = cli(data, ['record', '--repository', 'acme/web', '--head', HEAD, ...flags]);
    assert.equal(result.status, 0, result.stderr);
    const expected = {
      staticRan: RAN,
      staticDidNotRun: [
        { name: 'denied', reason: 'permission denied' },
        { name: 'missing', reason: 'executable not found' },
        { name: 'disabled', reason: skipped ?? 'not run' },
      ],
      symbolsInconclusive: 2,
      symbolsBudgetExhausted: true,
    };
    inStore(data, (db) => {
      const id = JSON.parse(result.stdout).reviewRunId;
      const stored = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(id);
      assert.deepEqual(JSON.parse(stored.output_json).checks, expected);
      assert.deepEqual(runDetail(db, id).checks, expected);
    });
  });
}

test('AC-1: record accepts neither report and an old output row returns null checks', (t) => {
  const data = dataDir(t);
  const result = cli(data, ['record', '--repository', 'acme/web']);
  assert.equal(result.status, 0, result.stderr);
  inStore(data, (db) => {
    const id = JSON.parse(result.stdout).reviewRunId;
    assert.equal(runDetail(db, id).checks, null);
    // Older binaries stored only output and findings, so absence must remain readable.
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?')
      .run(JSON.stringify({ output: CLEAN, findings: [] }), id);
    assert.equal(runDetail(db, id).checks, null);
  });
});

test('AC-1: record refuses either report alone or a missing flag value without storing a run', (t) => {
  for (const flags of [['--evidence', 'evidence.json'], ['--symbols', 'symbols.json'], ['--evidence', '--symbols']]) {
    const data = dataDir(t);
    const result = cli(data, ['record', '--repository', 'acme/web', ...flags]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--evidence and --symbols go together/);
    inStore(data, (db) => assert.equal(runDetail(db), null));
  }
});

test('AC-1: malformed reports are refused without recording an apparently complete review', (t) => {
  for (const [evidence, symbols] of [[{ commands: [] }, SYMBOLS], [{ commands: [], didNotRun: [] }, {}]]) {
    const data = dataDir(t);
    const flags = reports(data, evidence, symbols);
    const result = cli(data, ['record', '--repository', 'acme/web', ...flags]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Cannot read the checks/);
    inStore(data, (db) => assert.equal(runDetail(db), null));
  }
});

test('AC-1: explain prints the recorded checks in one line', (t) => {
  const data = dataDir(t);
  const id = inStore(data, (db) => record(db, { checks: {
    staticRan: RAN,
    staticDidNotRun: [{ name: 'missing', reason: 'executable not found' }],
    symbolsInconclusive: 2,
    symbolsBudgetExhausted: true,
  } }).reviewRunId);
  const result = cli(data, ['explain', '--run', id]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Checks ')), [
    'Checks typecheck ran (exit 0, 0 signals); lint ran (exit 1, 2 signals); interrupted ran (exit none, 0 signals); missing did not run (executable not found); 2 symbol files not finished (time budget)',
  ]);
});

test('S19: explain names the linked issues the thread read, or none, after the checks', (t) => {
  const data = dataDir(t);
  const checks = { staticRan: [], staticDidNotRun: [], symbolsInconclusive: 0, symbolsBudgetExhausted: false };
  const line = (issuesRead) => {
    const id = inStore(data, (db) => record(db, { checks: { ...checks, issuesRead } }).reviewRunId);
    const result = cli(data, ['explain', '--run', id]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((l) => l.startsWith('Checks '));
  };
  assert.deepEqual(line([12, 34]), ['Checks no static checks; every symbol file finished; linked issues #12, #34']);
  assert.deepEqual(line([]), ['Checks no static checks; every symbol file finished; linked issues none']);
});

test('AC-1: explain names missing checks for an old run', (t) => {
  const data = dataDir(t);
  const id = inStore(data, (db) => record(db).reviewRunId);
  const result = cli(data, ['explain', '--run', id]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Checks not recorded$/m);
});

test('AC-1: record help names both report flags', (t) => {
  const result = cli(dataDir(t), ['record', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--evidence <path>/);
  assert.match(result.stdout, /--symbols <path>/);
});
