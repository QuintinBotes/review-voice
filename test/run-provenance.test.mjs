/**
 * Run provenance (S02): where a recorded run came from, the independence label
 * derived from that, the versions and policy rows in force, and the token
 * counts the envelope reports. The driver's half (the Claude version probe, the
 * report line, tokens summed per stage) is in test/review-driver.test.mjs, which
 * has the pull request harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { ORIGINS, describeProvenance, independenceOf, recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { approvePolicy, proposePolicy, rollbackTo } from '../plugins/review-voice/src/policy/versions.ts';
import { interpretEnvelope } from '../plugins/review-voice/src/agents/claude-cli.ts';
import { runFake } from '../plugins/review-voice/src/agents/fake.ts';
import { pluginVersion } from '../plugins/review-voice/src/version.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const CLEAN = 'No actionable findings.';
const PLUGIN = pluginVersion();

/** A data directory for one test, removed afterwards. */
function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The built CLI against a data directory; stdin is the validated review. */
function cli(data, args, input = CLEAN) {
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  return spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, input, cwd: data });
}

/** Runs a body against the data directory's store and closes it. */
function inStore(data, body) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** Records one run through the CLI and reads it back. */
function recordedBy(data, flags = []) {
  const result = cli(data, ['record', ...flags]);
  assert.equal(result.status, 0, result.stderr);
  return inStore(data, (db) => runDetail(db, JSON.parse(result.stdout).reviewRunId));
}

const direct = (db, extra = {}) =>
  recordRun(db, { repository: 'acme/api', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 4, diff: 'diff', output: CLEAN, ...extra });

const PROVENANCE = { origin: 'driver', pluginVersion: PLUGIN, claudeVersion: '2.1.319 (Claude Code)', mode: 'standard' };

// ---- AC-1: storage ---------------------------------------------------------

test('a database from before the column migrates, its run reads provenance null, and explain says so', (t) => {
  const data = dataDir(t);
  const path = join(data, 'review-voice.db');
  const db = openDatabase(path);
  const legacy = direct(db).reviewRunId;
  db.close();

  // Take the store back to the schema before this column: migration 12, so
  // version 11. Dropping the column leaves the row exactly as an old binary wrote it.
  const raw = new DatabaseSync(path);
  // A later migration's column goes too: SQLite has no ADD COLUMN IF NOT EXISTS,
  // so re-running it over a surviving column would fail.
  raw.exec('ALTER TABLE finding_outcomes DROP COLUMN decided_by');
  raw.exec('ALTER TABLE review_runs DROP COLUMN provenance_json');
  raw.exec('UPDATE schema_version SET version = 11');
  raw.close();

  const reopened = openDatabase(path);
  try {
    assert.equal(reopened.prepare('SELECT version FROM schema_version').get().version >= 12, true, 'the migration ran');
    assert.equal(runDetail(reopened, legacy).provenance, null);
    const fresh = direct(reopened, { provenance: PROVENANCE }).reviewRunId;
    assert.equal(runDetail(reopened, fresh).provenance.origin, 'driver');
  } finally {
    reopened.close();
  }

  const explained = cli(data, ['explain', '--run', legacy]);
  assert.equal(explained.status, 0, explained.stderr);
  assert.match(explained.stdout, /^Provenance not recorded$/m);
});

test('recordRun without provenance writes NULL, and its audit row names no origin', (t) => {
  inStore(dataDir(t), (db) => {
    const { reviewRunId, provenance } = direct(db);
    assert.equal(provenance, null);
    const row = db.prepare('SELECT provenance_json, active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId);
    assert.equal(row.provenance_json, null);
    assert.equal(row.active_policy_versions_json, '[]');
    assert.equal(runDetail(db, reviewRunId).provenance, null);
    const audit = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'review_run_recorded'").get();
    assert.equal(Object.hasOwn(JSON.parse(audit.metadata_json), 'origin'), false);
  });
});

test('malformed provenance JSON reads as null and is reported once on stderr', (t) => {
  inStore(dataDir(t), (db) => {
    const first = direct(db, { provenance: PROVENANCE }).reviewRunId;
    const second = direct(db, { provenance: PROVENANCE }).reviewRunId;
    const set = (id, value) => db.prepare('UPDATE review_runs SET provenance_json = ? WHERE review_run_id = ?').run(value, id);
    const said = t.mock.method(console, 'error', () => {});

    set(first, '{"origin":');
    assert.equal(runDetail(db, first).provenance, null);
    assert.equal(runDetail(db, first).provenance, null);
    assert.equal(said.mock.callCount(), 1, 'the same run is reported once');
    assert.match(said.mock.calls[0].arguments[0], new RegExp(`${first}.*malformed`));

    // Valid JSON of the wrong shape is just as unreadable: an origin nobody defined.
    set(second, JSON.stringify({ ...PROVENANCE, independence: 'independent', policyVersions: [], origin: 'cloud' }));
    assert.equal(runDetail(db, second).provenance, null);
    assert.equal(said.mock.callCount(), 2, 'another run is reported on its own');
  });
});

test('the label is derived from the origin on every read, so a stored claim cannot change it', (t) => {
  assert.deepEqual(
    ORIGINS.map((origin) => [origin, independenceOf(origin)]),
    [
      ['driver', 'independent'],
      ['interactive', 'not-independent'],
      ['watch', 'independent'],
      ['action', 'independent'],
    ],
  );
  inStore(dataDir(t), (db) => {
    const { reviewRunId } = direct(db, { provenance: { ...PROVENANCE, origin: 'interactive' } });
    const stored = JSON.parse(db.prepare('SELECT provenance_json FROM review_runs').get().provenance_json);
    assert.equal(stored.independence, 'not-independent');
    db.prepare('UPDATE review_runs SET provenance_json = ?').run(JSON.stringify({ ...stored, independence: 'independent' }));
    assert.equal(runDetail(db, reviewRunId).provenance.independence, 'not-independent');
  });
});

// ---- AC-2: the record command ----------------------------------------------

test('record stores the origin, mode and Claude version it is given, with the current plugin version', (t) => {
  const data = dataDir(t);
  const detail = recordedBy(data, ['--origin', 'driver', '--mode', 'standard', '--claude-version', '2.1.319 (Claude Code)']);
  assert.deepEqual(detail.provenance, {
    origin: 'driver',
    independence: 'independent',
    pluginVersion: PLUGIN,
    claudeVersion: '2.1.319 (Claude Code)',
    mode: 'standard',
    policyVersions: [],
  });
});

test('record without --origin stores interactive and not-independent, with no mode or version', (t) => {
  const detail = recordedBy(dataDir(t));
  assert.deepEqual(detail.provenance, {
    origin: 'interactive',
    independence: 'not-independent',
    pluginVersion: PLUGIN,
    claudeVersion: null,
    mode: null,
    policyVersions: [],
  });
});

test('every origin in the enum is accepted and labelled from the origin alone', (t) => {
  const data = dataDir(t);
  for (const origin of ORIGINS) {
    const detail = recordedBy(data, ['--origin', origin, '--mode', 'fast']);
    assert.equal(detail.provenance.origin, origin);
    assert.equal(detail.provenance.independence, origin === 'interactive' ? 'not-independent' : 'independent', origin);
  }
});

test('an origin outside the enum, or no value, exits 2 and records nothing; so does a mode outside it', (t) => {
  const data = dataDir(t);
  for (const flags of [['--origin', 'other'], ['--origin', 'Driver'], ['--origin'], ['--origin', '--mode', 'fast'], ['--mode', 'cheap'], ['--mode']]) {
    const result = cli(data, ['record', ...flags]);
    assert.equal(result.status, 2, `${flags.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  assert.equal(inStore(data, (db) => db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n), 0);
});

test('a --claude-version outside the allowed pattern records null; the edges of it are kept', (t) => {
  const data = dataDir(t);
  const stored = (value) => recordedBy(data, ['--claude-version', value]).provenance.claudeVersion;
  for (const bad of ['2.1.319; rm -rf /', '$(whoami)', '1.0\nsecond line', 'v1/2', 'a'.repeat(101), '']) {
    assert.equal(stored(bad), null, JSON.stringify(bad));
  }
  assert.equal(stored('a'.repeat(100)), 'a'.repeat(100));
  assert.equal(stored('1'), '1');
  assert.equal(stored('2.1.319 (Claude Code)'), '2.1.319 (Claude Code)');
});

// ---- AC-5: the policy rows --------------------------------------------------

test('both columns hold the active approved policy rows at record time, and only those', (t) => {
  inStore(dataDir(t), (db) => {
    const columns = (reviewRunId) => {
      const row = db.prepare('SELECT active_policy_versions_json, provenance_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId);
      return { active: JSON.parse(row.active_policy_versions_json), inProvenance: JSON.parse(row.provenance_json).policyVersions };
    };
    const rowOf = (policy) => ({ scopeType: policy.scopeType, scopeKey: policy.scopeKey, policyId: policy.policyId, version: policy.version });

    const none = columns(direct(db, { provenance: PROVENANCE }).reviewRunId);
    assert.deepEqual(none, { active: [], inProvenance: [] });

    const first = proposePolicy(db, []);
    const proposedOnly = columns(direct(db, { provenance: PROVENANCE }).reviewRunId);
    assert.deepEqual(proposedOnly.active, [], 'a proposal is not active');

    approvePolicy(db, first.policyId);
    const second = proposePolicy(db, []);
    approvePolicy(db, second.policyId);
    const latest = columns(direct(db, { provenance: PROVENANCE }).reviewRunId);
    assert.deepEqual(latest.active, [rowOf(second)]);
    assert.deepEqual(latest.inProvenance, latest.active);

    assert.equal(rollbackTo(db, 1).ok, true);
    const rolledBack = columns(direct(db, { provenance: PROVENANCE }).reviewRunId);
    assert.deepEqual(rolledBack.active, [rowOf(first)], 'version 2 was approved but is no longer active');
    assert.deepEqual(rolledBack.inProvenance, rolledBack.active);
    assert.equal(rolledBack.active[0].version, 1);

    // A run recorded without provenance still names its policy.
    const bare = direct(db).reviewRunId;
    assert.deepEqual(JSON.parse(db.prepare('SELECT active_policy_versions_json AS a FROM review_runs WHERE review_run_id = ?').get(bare).a), [rowOf(first)]);
  });
});

// ---- AC-6: tokens from the envelope and the fake backend --------------------

const envelope = (usage, extra = {}) => JSON.stringify({ type: 'result', is_error: false, result: 'done', structured_output: { answer: 'yes' }, total_cost_usd: 0.5, ...(usage === undefined ? {} : { usage }), ...extra });

test('interpretEnvelope sums input and output tokens, and leaves cache counts out', () => {
  const result = interpretEnvelope(
    envelope({ input_tokens: 1000, output_tokens: 234, cache_creation_input_tokens: 5000, cache_read_input_tokens: 7000 }),
    '',
    0,
  );
  assert.deepEqual(result, { ok: true, output: { answer: 'yes' }, costUsd: 0.5, tokens: 1234 });
  assert.equal(interpretEnvelope(envelope({ input_tokens: 0, output_tokens: 0 }), '', 0).tokens, 0, 'a reported zero is a count');
});

test('interpretEnvelope leaves tokens absent when usage is missing or either count is not a count', () => {
  const bare = { ok: true, output: { answer: 'yes' }, costUsd: 0.5 };
  assert.deepEqual(interpretEnvelope(envelope(undefined), '', 0), bare, 'no usage object');
  for (const usage of [
    null,
    'lots',
    [],
    {},
    { input_tokens: 10 },
    { output_tokens: 10 },
    { input_tokens: -1, output_tokens: 5 },
    { input_tokens: 5, output_tokens: -1 },
    { input_tokens: '10', output_tokens: 5 },
    { input_tokens: 10, output_tokens: null },
    { input_tokens: true, output_tokens: 5 },
  ]) {
    const result = interpretEnvelope(envelope(usage), '', 0);
    assert.deepEqual(result, bare, JSON.stringify(usage));
    assert.equal(Object.hasOwn(result, 'tokens'), false, JSON.stringify(usage));
  }
  // 1e999 is valid JSON and parses to Infinity.
  const infinite = interpretEnvelope(envelope(undefined).replace(/\}$/, ', "usage": {"input_tokens": 1e999, "output_tokens": 1}}'), '', 0);
  assert.deepEqual(infinite, bare);
});

test('interpretEnvelope reports the tokens of a failed call too, and none when the output is not an envelope', () => {
  const failed = interpretEnvelope(JSON.stringify({ is_error: true, result: 'schema not satisfied', usage: { input_tokens: 7, output_tokens: 3 } }), '', 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.tokens, 10);
  assert.equal(Object.hasOwn(interpretEnvelope('not json at all', '', 1), 'tokens'), false);
});

test('runFake passes a valid fixture tokens value through and leaves the key absent otherwise', (t) => {
  const dir = dataDir(t);
  const spec = { name: 'diff-analyst', model: 'sonnet', tools: [] };
  const fixtures = [{ output: { a: 1 }, tokens: 1200 }, { output: { a: 1 } }, { output: { a: 1 }, tokens: -5 }, { output: { a: 1 }, tokens: '300' }, { output: { a: 1 }, tokens: null }, { output: { a: 1 }, tokens: 0 }];
  fixtures.forEach((fixture, index) => writeFileSync(join(dir, `diff-analyst.${index + 1}.json`), JSON.stringify(fixture)));
  const results = fixtures.map(() => runFake(spec, 'prompt', dir));
  assert.deepEqual(results.map((r) => r.ok), fixtures.map(() => true));
  assert.deepEqual(results.map((r) => r.tokens), [1200, undefined, undefined, undefined, undefined, 0]);
  assert.deepEqual(results.map((r) => Object.hasOwn(r, 'tokens')), [true, false, false, false, false, true]);
});

// ---- AC-7: what is printed --------------------------------------------------

test('explain prints the exact Provenance line after the scope line, for each form', (t) => {
  const data = dataDir(t);

  // Recorded in process so the run has a scope line, then read by the CLI.
  const withScope = inStore(data, (db) =>
    direct(db, { provenance: PROVENANCE, scope: { kind: 'full', cause: 'forced', since: null, priorRunId: null }, stages: [{ name: 'analyst', seconds: 3 }] }).reviewRunId,
  );
  const lines = cli(data, ['explain', '--run', withScope]).stdout.split('\n');
  const at = lines.findIndex((line) => line.startsWith('Provenance'));
  assert.equal(lines[at], `Provenance origin driver (independent), plugin ${PLUGIN}, claude 2.1.319 (Claude Code), mode standard, policy none`);
  assert.match(lines[at - 1], /^Scope /, 'the scope line comes first');
  assert.match(lines[at + 1], /^Effort analyst/, 'the effort lines follow');

  // The unknown forms.
  const interactive = recordedBy(data).reviewRunId;
  assert.match(
    cli(data, ['explain', '--run', interactive]).stdout,
    new RegExp(`^Provenance origin interactive \\(not-independent\\), plugin ${PLUGIN.replaceAll('.', '\\.')}, claude unknown, mode unknown, policy none$`, 'm'),
  );

  // With an active policy.
  inStore(data, (db) => approvePolicy(db, proposePolicy(db, []).policyId));
  const governed = recordedBy(data, ['--origin', 'watch', '--mode', 'thorough', '--claude-version', '9.9.9']).reviewRunId;
  assert.match(
    cli(data, ['explain', '--run', governed]).stdout,
    new RegExp(`^Provenance origin watch \\(independent\\), plugin ${PLUGIN.replaceAll('.', '\\.')}, claude 9\\.9\\.9, mode thorough, policy global/owner v1$`, 'm'),
  );
});

test('describeProvenance joins several policy rows with a comma and a space', () => {
  const line = describeProvenance({
    origin: 'action',
    independence: 'independent',
    pluginVersion: '1.2.3',
    claudeVersion: null,
    mode: 'fast',
    policyVersions: [
      { scopeType: 'global', scopeKey: 'owner', policyId: 'p1', version: 2 },
      { scopeType: 'repository', scopeKey: 'acme/api', policyId: 'p2', version: 7 },
    ],
  });
  assert.equal(line, 'Provenance origin action (independent), plugin 1.2.3, claude unknown, mode fast, policy global/owner v2, repository/acme/api v7');
  assert.equal(describeProvenance(null), 'Provenance not recorded');
});

test('status appends the origin to the end of the last-review line, and leaves a run without one alone', (t) => {
  const data = dataDir(t);
  inStore(data, (db) => direct(db));
  const before = cli(data, ['status']);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /^last review {6}0 finding\(s\): none$/m, 'a legacy run keeps its line as it was');

  recordedBy(data, ['--origin', 'driver']);
  const after = cli(data, ['status']);
  assert.match(after.stdout, /^last review {6}0 finding\(s\): none; origin driver \(independent\)$/m);

  recordedBy(data);
  assert.match(cli(data, ['status']).stdout, /^last review {6}0 finding\(s\): none; origin interactive \(not-independent\)$/m);
});

// ---- carried runs ----------------------------------------------------------

/** A repository with two commits, so a run at the first head can be carried to the second. */
function twoCommits(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-provenance-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'two');
  return { dir, first, second: git('rev-parse', 'HEAD') };
}

test('a carried run keeps the provenance of the run that produced its findings, not the caller\'s', (t) => {
  const data = dataDir(t);
  const repo = twoCommits(t);
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  const record = (args) => spawnSync(process.execPath, [bundle, 'record', '--repository', 'acme/api', ...args], { encoding: 'utf8', env, input: CLEAN, cwd: repo.dir });
  const stored = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return inStore(data, (db) => runDetail(db, JSON.parse(result.stdout).reviewRunId));
  };

  // The slash command reviewed the first head inside the host session.
  const source = record(['--head', repo.first]);
  const sourceId = JSON.parse(source.stdout).reviewRunId;
  assert.equal(stored(source).provenance.origin, 'interactive');

  // The driver carries that review to the second head. No agent ran, so the caller's flags would describe a review that never happened.
  const carried = stored(record(['--head', repo.second, '--carried-from', sourceId, '--origin', 'driver', '--mode', 'thorough', '--claude-version', '9.9.9']));
  assert.deepEqual(carried.provenance, {
    origin: 'interactive',
    independence: 'not-independent',
    pluginVersion: PLUGIN,
    claudeVersion: null,
    mode: null,
    policyVersions: [],
  });

  // A source from before provenance existed has nothing to keep, so the caller's flags stand.
  inStore(data, (db) => db.prepare('UPDATE review_runs SET provenance_json = NULL WHERE review_run_id = ?').run(sourceId));
  const fallback = stored(record(['--head', repo.second, '--carried-from', sourceId, '--origin', 'watch', '--mode', 'fast']));
  assert.equal(fallback.provenance.origin, 'watch');
  assert.equal(fallback.provenance.mode, 'fast');
});

test('the review_run_recorded audit row carries the origin', (t) => {
  const data = dataDir(t);
  recordedBy(data, ['--origin', 'action']);
  inStore(data, (db) => {
    const audit = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'review_run_recorded'").all();
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].metadata_json).origin, 'action');
  });
});
