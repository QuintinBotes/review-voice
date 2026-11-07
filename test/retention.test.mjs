/**
 * Retention (PRIVACY.md, docs/adr/0005): the store sweep, the `retention:`
 * config block, `purge --runs` and the per-pass sweep in `watch`.
 * Deletion is irreversible, so each test checks what stays as well as what goes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { DEFAULT_VERDICT_POLICY } from '../plugins/review-voice/src/publish/verdict.ts';
import { defaultQueueConfig } from '../plugins/review-voice/src/queue/config.ts';
import { previewPurge, executePurge } from '../plugins/review-voice/src/consent/purge.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { applyRetention, previewRetention, DEFAULT_RETENTION } from '../plugins/review-voice/src/store/retention.ts';
import { defaultWatchConfig } from '../plugins/review-voice/src/watch/config.ts';
import { watchCommand } from '../plugins/review-voice/src/watch/command.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
const DAY = 86_400_000;
const NOW = new Date('2026-10-25T12:00:00Z');

/** A data directory holding a database, with cleanup. */
function withData(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-retention-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    return fn(dir, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A run directory last changed `ageDays` before `now`; `finished` adds the verdict.json a completed run leaves. */
function runDir(dir, name, ageDays, { finished = true, now = NOW } = {}) {
  const path = join(dir, 'runs', name);
  mkdirSync(path, { recursive: true });
  if (finished) writeFileSync(join(path, 'verdict.json'), '{}');
  writeFileSync(join(path, 'diff.patch'), 'raw code');
  const when = new Date(now.getTime() - ageDays * DAY);
  utimesSync(path, when, when);
  return path;
}

function audit(db, action, ageDays, now = NOW) {
  const created = new Date(now.getTime() - ageDays * DAY).toISOString();
  db.prepare('INSERT INTO audit_events (audit_id, action, subject_type, subject_id, metadata_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?)').run(
    `${action}-${ageDays}-${Math.random()}`,
    action,
    '{}',
    created,
  );
}

const actions = (db) =>
  db
    .prepare('SELECT action, created_at FROM audit_events ORDER BY created_at')
    .all()
    .map((row) => row.action);

// --- the store sweep ---

test('previewRetention changes neither the filesystem nor the database', () =>
  withData((dir, db) => {
    const old = runDir(dir, 'old', 40);
    audit(db, 'review_failed', 200);
    const preview = previewRetention(dir, db, DEFAULT_RETENTION, NOW);
    assert.deepEqual(preview.runDirectories.paths, [old]);
    assert.equal(preview.runDirectories.count, 1);
    assert.equal(preview.auditEvents, 1);
    assert.ok(existsSync(old));
    assert.equal(actions(db).length, 1);
  }));

test('applyRetention removes exactly what the preview lists and leaves the rest', () =>
  withData((dir, db) => {
    const old = runDir(dir, 'old', 31);
    const young = runDir(dir, 'young', 29);
    audit(db, 'review_failed', 181);
    audit(db, 'review_failed', 179);
    audit(db, 'review_post_sent', 400);
    audit(db, 'review_post_attempted', 400);

    const preview = previewRetention(dir, db, DEFAULT_RETENTION, NOW);
    const result = applyRetention(dir, db, DEFAULT_RETENTION, NOW);

    assert.deepEqual(result.runDirectories.paths, preview.runDirectories.paths);
    assert.equal(result.auditEvents, preview.auditEvents);
    assert.equal(result.auditEvents, 1);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(young));
    // The posting rows are the single write path's memory: no age may drop them.
    assert.deepEqual(actions(db).sort(), ['review_failed', 'review_post_attempted', 'review_post_sent']);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'review_failed'").get().n, 1);
  }));

test('a run directory without verdict.json is kept at 1.5x runs_days and removed past 2x', () =>
  withData((dir, db) => {
    const keptCompleted = runDir(dir, 'completed-young', 20);
    const goneCompleted = runDir(dir, 'completed-old', 31);
    const keptFailed = runDir(dir, 'failed-45', 45, { finished: false });
    const goneFailed = runDir(dir, 'failed-61', 61, { finished: false });
    const result = applyRetention(dir, db, DEFAULT_RETENTION, NOW);
    assert.equal(result.runDirectories.count, 2);
    assert.ok(existsSync(keptCompleted));
    assert.ok(existsSync(keptFailed));
    assert.ok(!existsSync(goneCompleted));
    assert.ok(!existsSync(goneFailed));
  }));

test('runs_days 0 or null keeps every run directory while the audit sweep still runs, and audit_days the reverse', () => {
  for (const off of [0, null]) {
    withData((dir, db) => {
      const old = runDir(dir, 'old', 400);
      audit(db, 'review_failed', 400);
      const runsOff = applyRetention(dir, db, { runsDays: off, auditDays: 180 }, NOW);
      assert.equal(runsOff.runDirectories.count, 0);
      assert.equal(runsOff.auditEvents, 1);
      assert.ok(existsSync(old));
    });
    withData((dir, db) => {
      const old = runDir(dir, 'old', 400);
      audit(db, 'review_failed', 400);
      const auditOff = applyRetention(dir, db, { runsDays: 30, auditDays: off }, NOW);
      assert.equal(auditOff.runDirectories.count, 1);
      assert.equal(auditOff.auditEvents, 0);
      assert.ok(!existsSync(old));
      assert.equal(actions(db).length, 1);
    });
  }
});

test('retention with no runs directory and no audit rows removes nothing', () =>
  withData((dir, db) => {
    const result = applyRetention(dir, db, DEFAULT_RETENTION, NOW);
    assert.deepEqual(result, { runDirectories: { count: 0, paths: [] }, auditEvents: 0 });
  }));

// --- config ---

function withConfig(yaml, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-retention-config-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    return fn(loadConfig(dir, NO_BASELINE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig defaults retention to 30 and 180 days', () =>
  withConfig(null, (config) => {
    assert.deepEqual(config.retention, { runsDays: 30, auditDays: 180 });
  }));

test('loadConfig reads set values, 0 and null without warnings', () => {
  withConfig('retention:\n  runs_days: 7\n  audit_days: 90\n', (config) => {
    assert.deepEqual(config.retention, { runsDays: 7, auditDays: 90 });
    assert.deepEqual(config.warnings, []);
  });
  withConfig('retention:\n  runs_days: 0\n  audit_days: null\n', (config) => {
    assert.deepEqual(config.retention, { runsDays: 0, auditDays: null });
    assert.deepEqual(config.warnings, []);
  });
});

test('loadConfig warns on a non-integer or negative period and keeps the default', () => {
  withConfig('retention:\n  runs_days: -3\n  audit_days: 1.5\n', (config) => {
    assert.deepEqual(config.retention, { runsDays: 30, auditDays: 180 });
    assert.equal(config.warnings.filter((w) => w.startsWith('retention.')).length, 2);
  });
  withConfig('retention:\n  runs_days: soon\n', (config) => {
    assert.equal(config.retention.runsDays, 30);
    assert.ok(config.warnings.some((w) => w.startsWith('retention.runs_days')));
  });
});

// --- purge ---

test('previewPurge and executePurge never touch the filesystem', () =>
  withData((dir, db) => {
    const path = runDir(dir, 'run', 400);
    previewPurge(db, { all: true });
    executePurge(db, { all: true }, 1);
    assert.ok(existsSync(path));
    assert.ok(existsSync(join(path, 'verdict.json')));
  }));

function cli(dir, args) {
  return spawnSync(process.execPath, [bundle, ...args], { env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir }, encoding: 'utf8' });
}

/** A data directory with run directories dated by days before the real now, for the bundle. */
function withBundleData(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-purge-runs-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bare purge still exits 2 and deletes nothing', () =>
  withBundleData((dir) => {
    const path = runDir(dir, 'run', 400, { now: new Date() });
    const result = cli(dir, ['purge']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs a scope/i);
    assert.ok(existsSync(path));
  }));

test('purge --runs previews first and deletes only what the preview lists', () =>
  withBundleData((dir) => {
    const a = runDir(dir, 'a', 10, { now: new Date() });
    const b = runDir(dir, 'b', 400, { now: new Date() });

    const preview = cli(dir, ['purge', '--runs']);
    assert.equal(preview.status, 0, preview.stderr);
    const shown = JSON.parse(preview.stdout);
    assert.equal(shown.confirmed, false);
    assert.equal(shown.wouldRemove.runDirectories.count, 2);
    assert.deepEqual([...shown.wouldRemove.runDirectories.paths].sort(), [a, b].sort());
    assert.ok(existsSync(a) && existsSync(b), 'a preview is not a deletion');

    const done = cli(dir, ['purge', '--runs', '--confirm']);
    assert.equal(done.status, 0, done.stderr);
    const removed = JSON.parse(done.stdout);
    assert.equal(removed.confirmed, true);
    assert.deepEqual([...removed.removed.runDirectories.paths].sort(), [a, b].sort());
    assert.ok(!existsSync(a) && !existsSync(b));

    // The removed count lands in the purge audit event.
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      const row = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'purge'").get();
      assert.equal(JSON.parse(row.metadata_json).removed.runDirectories, 2);
    } finally {
      db.close();
    }
  }));

test('purge --runs --before honours the directory mtime', () =>
  withBundleData((dir) => {
    const old = runDir(dir, 'old', 400, { now: new Date() });
    const recent = runDir(dir, 'recent', 1, { now: new Date() });
    const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const done = JSON.parse(cli(dir, ['purge', '--runs', '--before', cutoff, '--confirm']).stdout);
    assert.deepEqual(done.removed.runDirectories.paths, [old]);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(recent));
    assert.equal(cli(dir, ['purge', '--runs', '--before', 'last-week']).status, 2);
  }));

test('purge --all includes run directories', () =>
  withBundleData((dir) => {
    const path = runDir(dir, 'run', 1, { now: new Date() });
    const preview = JSON.parse(cli(dir, ['purge', '--all']).stdout);
    assert.deepEqual(preview.wouldRemove.runDirectories.paths, [path]);
    const done = JSON.parse(cli(dir, ['purge', '--all', '--confirm']).stdout);
    assert.equal(done.removed.runDirectories.count, 1);
    assert.ok(!existsSync(path));
  }));

// --- the watch pass ---

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const emptyGitHub = async (url) => {
  const { pathname } = new URL(String(url));
  if (pathname === '/user') return json({ login: 'your-github-login' });
  if (pathname === '/search/issues') return json({ total_count: 0, incomplete_results: false, items: [] });
  return new Response('not found', { status: 404 });
};

function watchSettings(retention) {
  const base = defaultQueueConfig();
  const settings = {
    allowlist: ['acme/*'],
    queue: { ...base, skip: { ...base.skip } },
    watch: defaultWatchConfig(),
    warnings: [],
    postingEnabled: true,
    ciGateChecks: [],
    ciRules: {},
    ownerReviewer: 'your-github-login',
    verdictPolicy: { ...DEFAULT_VERDICT_POLICY },
  };
  if (retention !== undefined) settings.retention = retention;
  return settings;
}

async function watchPass(dir, argv, retention) {
  const dbPath = join(dir, 'review-voice.db');
  const source = join(dir, 'source-config.yaml');
  writeFileSync(source, 'watch: {}\n');
  const out = [];
  const err = [];
  const code = await watchCommand(argv, {
    configSource: source,
    loadSettings: () => watchSettings(retention),
    client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: emptyGitHub, sleep: async () => {} }),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: emptyGitHub }),
    openDb: () => openDatabase(dbPath),
    dataDir: dir,
    review: async () => ({ exitCode: 0, runId: null, event: null, reviewUrl: null, detail: null }),
    stopReview: () => {},
    prepareClone: () => {},
    now: () => NOW,
    sleep: async () => {},
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out, err };
}

test('a watch pass removes an old run directory, keeps a young one and prints one line on stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-retention-'));
  try {
    const old = runDir(dir, 'old', 45);
    const young = runDir(dir, 'young', 5);
    const { code, out, err } = await watchPass(dir, ['--once'], { runsDays: 30, auditDays: 180 });
    assert.equal(code, 0);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(young));
    assert.deepEqual(err, []);
    const lines = out.join('\n').split('\n').filter((line) => /^removed /.test(line));
    assert.deepEqual(lines, ['removed 1 run directory, 0 audit events']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with --json the retention line goes to the error stream and stdout stays one JSON document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-retention-json-'));
  try {
    const old = runDir(dir, 'old', 45);
    const { out, err } = await watchPass(dir, ['--once', '--json'], { runsDays: 30, auditDays: 180 });
    assert.ok(!existsSync(old));
    assert.deepEqual(JSON.parse(out.join('\n')), []);
    assert.deepEqual(err, ['removed 1 run directory, 0 audit events']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings without a retention block apply the defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-retention-default-'));
  try {
    const old = runDir(dir, 'old', 45);
    const young = runDir(dir, 'young', 5);
    await watchPass(dir, ['--once'], undefined);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(young));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a watch pass with retention switched off removes nothing and prints no retention line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-retention-off-'));
  try {
    const old = runDir(dir, 'old', 400);
    const { out } = await watchPass(dir, ['--once'], { runsDays: 0, auditDays: null });
    assert.ok(existsSync(old));
    assert.ok(!out.join('\n').includes('removed '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
