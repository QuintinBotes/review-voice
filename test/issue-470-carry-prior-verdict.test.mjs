/** #470: carry says which event the source run posted, and whether that change request still stands. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const IMPORTANT = '[important] `a.ts:20` - The loop at line 20 never ends because the counter is never incremented.';
const MINOR = '[minor] `b.ts:5` - This name shadows the import of the same name above.';

const rv = (args, { input = '', cwd, dataDir }) =>
  spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input, cwd, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });

/** One recorded run of pull request 5, a base merge that left its files alone, and `post` as the given event (or never). */
function carryAfter(event, thread, input = `${IMPORTANT}\n\n${MINOR}`) {
  const base = mkdtempSync(join(tmpdir(), 'rv-470-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo);
    mkdirSync(dataDir);
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), lines(40));
    writeFileSync(join(repo, 'b.ts'), lines(10));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const prior = git('rev-parse', 'HEAD');
    const filesFile = join(base, 'files.json');
    writeFileSync(filesFile, JSON.stringify({ pullNumber: 5 }));
    const recorded = rv(['record', '--repository', 'o/r', '--head', prior, '--files', filesFile], { input, cwd: repo, dataDir });
    assert.equal(recorded.status, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    if (event !== null) {
      const db = openDatabase(join(dataDir, 'review-voice.db'));
      try {
        const subject = { type: 'pull_request', id: 'o/r#5' };
        const attempt = recordAudit(db, 'review_post_attempted', subject, { run: runId, event });
        recordAudit(db, 'review_post_sent', subject, { attempt, event, reviewId: 900 });
      } finally {
        db.close();
      }
    }
    writeFileSync(join(repo, 'c.ts'), 'unrelated\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'merge base');
    const args = ['carry', '--from', runId, '--head', git('rev-parse', 'HEAD')];
    if (thread !== undefined) {
      const threadFile = join(base, 'thread.json');
      writeFileSync(threadFile, JSON.stringify({ repository: 'o/r', pullNumber: 5, reviews: [], truncated: false, ...thread }));
      args.push('--thread', threadFile);
    }
    const result = rv(args, { cwd: repo, dataDir });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const EMPTY = { comments: [] };
const NIT = '[nit] `b.ts:5` - This name shadows the import of the same name above.';

test('a REQUEST_CHANGES run with a serious finding carried says the change request stands', () => {
  const out = carryAfter('REQUEST_CHANGES', EMPTY);
  assert.equal(out.priorVerdict, 'REQUEST_CHANGES');
  assert.equal(out.changeRequestStands, true);
});

test('without --thread the answer is unknown', () => {
  assert.equal(carryAfter('REQUEST_CHANGES').changeRequestStands, null);
});

test('a run whose carried findings are all nits does not stand', () => {
  const out = carryAfter('REQUEST_CHANGES', EMPTY, NIT);
  assert.equal(out.changeRequestStands, false);
});

test('a settled finding means it no longer stands', () => {
  const resolved = { path: 'a.ts', line: 20, author: 'review-bot', body: '**important** - The loop at line 20 never ends because the counter is never incremented.', kind: 'review-comment', id: 1, reviewId: 900, createdAt: '2099-01-01T00:00:00Z', resolved: true, resolvedBy: 'alice' };
  const out = carryAfter('REQUEST_CHANGES', { comments: [resolved] });
  assert.equal(out.priorVerdict, 'REQUEST_CHANGES');
  assert.equal(out.changeRequestStands, false);
});

test('a COMMENT run does not stand as a change request', () => {
  const out = carryAfter('COMMENT', EMPTY);
  assert.equal(out.priorVerdict, 'COMMENT');
  assert.equal(out.changeRequestStands, false);
});

test('a run with no stored event reads as null', () => {
  const out = carryAfter(null, EMPTY);
  assert.equal(out.priorVerdict, null);
  assert.equal(out.changeRequestStands, false);
});
