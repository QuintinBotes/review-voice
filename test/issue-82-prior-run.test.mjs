/**
 * `diff --pr` named no prior run id even when `record` had stored one for the
 * exact `--since` head: the run was stored with no repository, and `--since`
 * never looked at the recorded runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePrior } from '../plugins/review-voice/src/diff/prior.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordedRunsForPull } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const review = '[important] `a.ts:2` - the loop at line 2 never ends.\n';

function withClone(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-82-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('remote', 'add', 'origin', 'https://github.com/acme/web.git');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const head = git('rev-parse', 'HEAD');
    const record = (args) => {
      const stdout = execFileSync(process.execPath, [bundle, 'record', ...args], {
        encoding: 'utf8',
        input: review,
        cwd: repo,
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
      });
      return JSON.parse(stdout).reviewRunId;
    };
    const runs = (repository, pull) => {
      const db = openDatabase(join(dataDir, 'review-voice.db'));
      try {
        return recordedRunsForPull(db, repository, pull);
      } finally {
        db.close();
      }
    };
    return fn({ base, git, head, record, runs });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('record without --repository finds the repository in the --files manifest', () => {
  withClone(({ base, head, record, runs }) => {
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ pullNumber: 12, repository: 'acme/web' }));
    const runId = record(['--head', head, '--files', files]);
    assert.deepEqual(runs('acme/web', 12).map((run) => run.runId), [runId]);
  });
});

test('record without --repository or a manifest repository falls back to origin', () => {
  withClone(({ base, head, record, runs }) => {
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ pullNumber: 12 }));
    const runId = record(['--head', head, '--files', files]);
    assert.deepEqual(runs('acme/web', 12).map((run) => run.runId), [runId]);
  });
});

test('an explicit --repository still wins', () => {
  withClone(({ base, head, record, runs }) => {
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ pullNumber: 12, repository: 'acme/web' }));
    record(['--repository', 'acme/other', '--head', head, '--files', files]);
    assert.equal(runs('acme/web', 12).length, 0);
    assert.equal(runs('acme/other', 12).length, 1);
  });
});

test('a short --head is stored as the full commit', () => {
  withClone(({ base, head, record, runs }) => {
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ pullNumber: 12 }));
    record(['--head', head.slice(0, 7), '--files', files]);
    assert.equal(runs('acme/web', 12)[0].head, head);
  });
});

test('an unresolvable --head is stored as given', () => {
  withClone(({ base, record, runs }) => {
    const files = join(base, 'files.json');
    writeFileSync(files, JSON.stringify({ pullNumber: 12 }));
    record(['--head', 'deadbee', '--files', files]);
    assert.equal(runs('acme/web', 12)[0].head, 'deadbee');
  });
});

const never = async () => null;

test('--since equal to a recorded head uses that run', async () => {
  const recorded = [
    { runId: 'run_new', head: 'b'.repeat(40), createdAt: '2026-09-30T12:00:00.000Z' },
    { runId: 'run_old', head: 'a'.repeat(40), createdAt: '2026-09-29T12:00:00.000Z' },
  ];
  const { prior, resolution } = await resolvePrior({
    since: 'a'.repeat(40),
    recorded,
    pull: 'acme/web#12',
    ownReview: never,
  });
  assert.deepEqual(prior, { reviewRunId: 'run_old', headRef: 'a'.repeat(40), createdAt: '2026-09-29T12:00:00.000Z' });
  assert.equal(resolution.source, 'flag');
  assert.equal(resolution.runId, 'run_old');
  assert.equal(resolution.runIdNote, undefined);
});

test('--since matching no recorded run leaves the run id null and says why', async () => {
  const recorded = [
    { runId: 'run_new', head: 'b'.repeat(40), createdAt: '2026-09-30T12:00:00.000Z' },
    { runId: 'run_old', head: 'a'.repeat(40), createdAt: '2026-09-29T12:00:00.000Z' },
  ];
  const { prior, resolution } = await resolvePrior({
    since: 'c'.repeat(40),
    recorded,
    pull: 'acme/web#12',
    ownReview: never,
  });
  assert.equal(prior.reviewRunId, null);
  assert.equal(resolution.runId, null);
  assert.match(resolution.runIdNote, /--since ccccccc matches no recorded run of acme\/web#12; 2 runs are recorded/);
  assert.match(resolution.runIdNote, /bbbbbbb, aaaaaaa/);
});

test('nothing recorded and a GitHub review as the source each explain the null run id', async () => {
  const none = await resolvePrior({ since: 'c'.repeat(40), recorded: [], pull: 'acme/web#12', ownReview: never });
  assert.match(none.resolution.runIdNote, /no run is recorded for acme\/web#12/);
  const github = await resolvePrior({
    since: null,
    recorded: [],
    pull: 'acme/web#12',
    ownReview: async () => ({ head: 'd'.repeat(40), submittedAt: null }),
  });
  assert.match(github.resolution.runIdNote, /GitHub review, which has no run id/);
  const first = await resolvePrior({ since: null, recorded: [], pull: 'acme/web#12', ownReview: never });
  assert.equal(first.resolution.runIdNote, undefined);
});
