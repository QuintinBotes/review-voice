/** #473: record-post records a review posted outside `post`, so carry reports its verdict. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const IMPORTANT = '[important] `a.ts:20` - The loop at line 20 never ends because the counter is never incremented.';
const URL = 'https://github.com/o/r/pull/5#pullrequestreview-900';

test('record-post makes carry report the posted verdict, once, and refuses bad input', () => {
  const base = mkdtempSync(join(tmpdir(), 'rv-473-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const rv = (args, input = '') =>
    spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input, cwd: repo, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
  try {
    mkdirSync(repo);
    mkdirSync(dataDir);
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), lines(40));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    const filesFile = join(base, 'files.json');
    writeFileSync(filesFile, JSON.stringify({ pullNumber: 5 }));
    const recorded = rv(['record', '--repository', 'o/r', '--head', head, '--files', filesFile], IMPORTANT);
    assert.equal(recorded.status, 0, recorded.stderr);
    const run = JSON.parse(recorded.stdout).reviewRunId;

    const post = (extra) => rv(['record-post', '--run', run, '--event', 'REQUEST_CHANGES', '--url', URL, ...extra]);
    const first = post(['--review-id', '900']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { run, event: 'REQUEST_CHANGES', url: URL, recorded: true });
    const second = post([]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).recorded, false);

    const threadFile = join(base, 'thread.json');
    writeFileSync(threadFile, JSON.stringify({ repository: 'o/r', pullNumber: 5, reviews: [], truncated: false, comments: [] }));
    const carried = rv(['carry', '--from', run, '--head', head, '--thread', threadFile]);
    assert.equal(carried.status, 0, carried.stderr);
    const out = JSON.parse(carried.stdout);
    assert.equal(out.priorVerdict, 'REQUEST_CHANGES');
    assert.equal(out.changeRequestStands, true);

    assert.equal(rv(['record-post', '--run', 'nope', '--event', 'COMMENT', '--url', URL]).status, 2);
    assert.equal(rv(['record-post', '--run', run, '--event', 'MAYBE', '--url', URL]).status, 2);
    assert.equal(rv(['record-post', '--run', run, '--event', 'COMMENT']).status, 2);
    for (const bad of ['', '   ']) assert.equal(rv(['record-post', '--run', run, '--event', 'COMMENT', '--url', bad]).status, 2, `url ${JSON.stringify(bad)}`);
    for (const bad of ['', ' ', '-1', '0', 'abc', '1.5'])
      assert.equal(rv(['record-post', '--run', run, '--event', 'COMMENT', '--url', 'https://github.com/o/r/pull/5#x', '--review-id', bad]).status, 2, `review-id ${JSON.stringify(bad)}`);

    // A failing second insert leaves neither row.
    const db = new DatabaseSync(join(dataDir, 'review-voice.db'));
    const count = () => db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE json_extract(metadata_json, '$.url') = 'https://github.com/o/r/pull/5#atomic'`).get().n;
    db.exec(`CREATE TRIGGER rv_fail BEFORE INSERT ON audit_events WHEN NEW.action = 'review_post_sent' AND json_extract(NEW.metadata_json, '$.url') LIKE '%#atomic' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const failed = rv(['record-post', '--run', run, '--event', 'COMMENT', '--url', 'https://github.com/o/r/pull/5#atomic']);
    assert.notEqual(failed.status, 0);
    assert.equal(count(), 0);
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
