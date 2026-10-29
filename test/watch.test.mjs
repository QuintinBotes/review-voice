/**
 * The watcher (docs/adr/0027): one row per head, idempotent passes, the
 * failure cap, a moved head retried, the CI recheck path, the lock, the
 * report, and the queue's output left alone while the watch table is empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { DEFAULT_VERDICT_POLICY } from '../plugins/review-voice/src/publish/verdict.ts';
import { defaultQueueConfig } from '../plugins/review-voice/src/queue/config.ts';
import { buildQueue } from '../plugins/review-voice/src/queue/queue.ts';
import { queueCommand, renderQueue } from '../plugins/review-voice/src/queue/command.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { saveWatchHead, watchHead, watchSummary } from '../plugins/review-voice/src/store/watch.ts';
import { defaultWatchConfig, parseDuration } from '../plugins/review-voice/src/watch/config.ts';
import { watchCommand } from '../plugins/review-voice/src/watch/command.ts';
import { reviewResult, spawnReview } from '../plugins/review-voice/src/watch/review.ts';
import { pathToFileURL } from 'node:url';
import { cloneDir, gitPrepareClone, removeStaleGitLocks } from '../plugins/review-voice/src/watch/workspace.ts';
import { acquireLock, lockPort } from '../plugins/review-voice/src/watch/lock.ts';
import { createServer } from 'node:net';

const ME = 'your-github-login';
const REPO = 'acme/web';
const sha = (c) => c.repeat(40);
const NOW = new Date('2026-10-25T12:00:00Z');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const item = (repository, number) => ({ number, repository_url: `https://api.github.com/repos/${repository}`, pull_request: {} });
const checkRun = (conclusion) => ({
  id: 1,
  name: 'build',
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  completed_at: conclusion === null ? null : '2026-10-25T10:00:00Z',
});

/**
 * GitHub for the watcher: `requested` lists the pull requests, `pulls` holds
 * each one keyed `owner/repo#n`, and `state.ci` ('green' | 'red') can change
 * between passes. POSTs to /reviews are answered and kept.
 */
function fakeGitHub({ requested = [], pulls = {}, state = { ci: 'green' } } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: parsed.pathname, body });
    if (parsed.pathname.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (method === 'POST') {
      return json({ id: 100 + calls.length, html_url: `https://github.com/${REPO}/pull/7#pullrequestreview-${100 + calls.length}`, state: body.event });
    }
    if (parsed.pathname === '/user') return json({ login: ME });
    if (parsed.pathname === '/search/issues') {
      const q = parsed.searchParams.get('q');
      const items = q.includes('review-requested') ? requested : [];
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(parsed.pathname);
    if (pull) {
      const found = pulls[`${pull[1]}#${pull[2]}`];
      return found === undefined ? new Response('not found', { status: 404 }) : json(found);
    }
    if (parsed.pathname.endsWith('/reviews')) return json([]);
    if (/\/(pulls|issues)\/\d+\/comments$/.test(parsed.pathname)) return json([]);
    if (parsed.pathname.endsWith('/check-runs')) {
      const runs = [checkRun(state.ci === 'red' ? 'failure' : 'success')];
      return json({ total_count: 1, check_runs: runs });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.posts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  return impl;
}

const openPull = ({ head = sha('a'), author = 'alice' } = {}) => ({
  state: 'open',
  draft: false,
  created_at: '2026-10-01T00:00:00Z',
  head: { sha: head },
  user: { login: author, type: 'User' },
  assignees: [],
});

const settings = ({ queue = {}, skip = {}, watch = {}, postingEnabled = true } = {}) => {
  const base = defaultQueueConfig();
  return {
    allowlist: ['acme/*'],
    queue: { ...base, ...queue, skip: { ...base.skip, ...skip } },
    watch: { ...defaultWatchConfig(), ...watch },
    warnings: [],
    postingEnabled,
    ciGateChecks: [],
    ciRules: {},
    ownerReviewer: ME,
    verdictPolicy: { ...DEFAULT_VERDICT_POLICY },
  };
};

/** A fake review driver: answers from `results` in order, the last one repeating. */
function fakeReview(results) {
  const calls = [];
  const review = async (args) => {
    assert.ok(existsSync(join(args.clone, '.git')), 'review runs in a prepared clone');
    calls.push(args);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  review.calls = calls;
  return review;
}

/** Stands in for the clone step with a local repository. */
function fakePrepare() {
  const calls = [];
  const prepare = (repository, pull, dir) => {
    calls.push({ repository, pull, dir });
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', dir]);
    }
  };
  prepare.calls = calls;
  return prepare;
}

/** A watcher harness in a fresh data directory. */
async function withWatcher(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-'));
  const dbPath = join(dir, 'review-voice.db');
  const out = [];
  const err = [];
  const harness = {
    dir,
    out,
    err,
    openDb: () => openDatabase(dbPath),
    loads: [],
    source: join(dir, 'source-config.yaml'),
    run: (argv, { impl, config = settings(), review = fakeReview([{ exitCode: 0, runId: null, event: null, reviewUrl: null, detail: null }]), prepare = fakePrepare(), sleep, stopReview } = {}) => {
      out.length = 0;
      err.length = 0;
      if (!existsSync(harness.source)) writeFileSync(harness.source, 'watch: {}\n');
      return watchCommand(argv, {
        configSource: harness.source,
        loadSettings: (path) => {
          harness.loads.push(path);
          // A fresh object per read, as reading the file gives: a change reaches the watcher only by a reload.
          return structuredClone(config);
        },
        client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }),
        writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
        openDb: () => openDatabase(dbPath),
        dataDir: dir,
        review,
        stopReview: stopReview ?? (() => {}),
        prepareClone: prepare,
        now: () => NOW,
        sleep: sleep ?? (async () => {}),
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      });
    },
  };
  try {
    await body(harness);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (h) => {
  const db = h.openDb();
  try {
    return db.prepare('SELECT * FROM watch_heads ORDER BY pull_number').all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

const posted = { exitCode: 0, runId: 'run-1', event: 'APPROVE', reviewUrl: `https://github.com/${REPO}/pull/7#pullrequestreview-9`, detail: null };

// --- passes ---

test('a second pass does nothing for a head already posted, and sends no second review', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const calls = [];
    // Posts for real through the stubbed GitHub every time it runs, as the driver would.
    const review = async (args) => {
      calls.push(args);
      const sent = await new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl }).submitReview(REPO, 7, {
        commit_id: args.expectHead,
        event: 'APPROVE',
        body: 'No actionable findings.',
        comments: [],
      });
      return { exitCode: 0, runId: 'run-1', event: 'APPROVE', reviewUrl: sent.htmlUrl, detail: null };
    };
    const prepare = fakePrepare();

    assert.equal(await h.run(['--once', '--post'], { impl, review, prepare }), 0);
    assert.equal(impl.posts().length, 1);
    const [line, totals] = h.out[0].split('\n');
    assert.match(line, /^acme\/web#7: review APPROVE \(posted https:\/\/github\.com\/acme\/web\/pull\/7#pullrequestreview-\d+\)$/);
    assert.equal(totals, '1 entry: 1 posted; 0 not reached; outcomes followed on 0 pull request(s)');
    assert.deepEqual(calls[0], {
      repository: REPO,
      pull: 7,
      clone: join(h.dir, 'clones', 'acme', 'web'),
      post: true,
      mode: undefined,
      expectHead: sha('a'),
      timeoutMs: 45 * 60_000,
      runRepositoryCommands: false,
    });
    assert.equal(prepare.calls.length, 1);
    const [row] = rows(h);
    assert.equal(row.status, 'posted');
    assert.equal(row.head_sha, sha('a'));
    assert.equal(row.run_id, 'run-1');
    assert.equal(row.attempts, 0);

    assert.equal(await h.run(['--once', '--post'], { impl, review, prepare }), 0);
    assert.deepEqual(h.out[0].split('\n'), ['0 entries; 0 not reached; outcomes followed on 0 pull request(s)']);
    assert.equal(calls.length, 1, 'not reviewed again');
    assert.equal(impl.posts().length, 1, 'no second review POST');
    assert.equal(existsSync(join(h.dir, 'watch.lock')), false, 'the lock is removed on exit');
  });
});

test('the config is copied and read again every pass, and the copy is what the pass reads', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub();
    await h.run(['--once'], { impl });
    const copy = join(h.dir, 'watch-config.yaml');
    assert.equal(readFileSync(copy, 'utf8'), 'watch: {}\n');
    writeFileSync(h.source, 'watch:\n  interval: 30m\n');
    await h.run(['--once'], { impl });
    assert.equal(readFileSync(copy, 'utf8'), 'watch:\n  interval: 30m\n');
    // Each run: the startup check reads the source, the pass reads the copy.
    assert.deepEqual(h.loads, [h.source, copy, h.source, copy]);
  });
});

test('posting turned off between passes: the recheck path and the review child post nothing', async () => {
  await withWatcher(async (h) => {
    const db = h.openDb();
    recordRun(db, { repository: REPO, baseRef: null, headRef: sha('a'), pullNumber: 7, diff: 'diff', output: 'No actionable findings.', scores: [] });
    db.close();
    const state = { ci: 'red' };
    const pulls = { [`${REPO}#7`]: openPull() };
    const requested = [item(REPO, 7)];
    const impl = fakeGitHub({ requested, pulls, state });
    const review = fakeReview([{ exitCode: 4, runId: null, event: null, reviewUrl: null, detail: 'waiting on CI' }]);
    const config = settings();
    let passes = 0;
    // One watcher, two passes: between them the owner turns posting off, CI goes green and a new pull request arrives.
    const sleep = async () => {
      passes += 1;
      if (passes === 2) throw new Error('stop');
      assert.deepEqual(impl.posts().map((c) => c.body.event), ['COMMENT']);
      config.postingEnabled = false;
      state.ci = 'green';
      pulls[`${REPO}#8`] = openPull({ head: sha('b') });
      requested.push(item(REPO, 8));
    };
    await assert.rejects(() => h.run(['--post', '--interval', '1h'], { impl, review, config, sleep }), /stop/);
    assert.match(h.err.join('\n'), /Posting is off in the config now/);
    assert.deepEqual(impl.posts().map((c) => c.body.event), ['COMMENT'], 'no approval was posted');
    assert.equal(review.calls.at(-1).post, false, 'the review child was not asked to post');
    assert.equal(rows(h).find((row) => row.pull_number === 7).status, 'reviewed');
  });
});

test('a repository removed from the allowlist between passes is not posted to', async () => {
  await withWatcher(async (h) => {
    const db = h.openDb();
    recordRun(db, { repository: REPO, baseRef: null, headRef: sha('a'), pullNumber: 7, diff: 'diff', output: 'No actionable findings.', scores: [] });
    db.close();
    const state = { ci: 'red' };
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() }, state });
    const config = settings();
    let passes = 0;
    const sleep = async () => {
      passes += 1;
      if (passes === 2) throw new Error('stop');
      assert.deepEqual(impl.posts().map((c) => c.body.event), ['COMMENT']);
      config.allowlist = ['acme/api'];
      state.ci = 'green';
    };
    await assert.rejects(() => h.run(['--post', '--interval', '1h'], { impl, config, sleep }), /stop/);
    assert.deepEqual(impl.posts().map((c) => c.body.event), ['COMMENT'], 'no approval to a repository no longer allowed');
    assert.match(h.out.at(-1), /^0 entries;/);
  });
});

test('a new head on the same pull request is reviewed', async () => {
  await withWatcher(async (h) => {
    const pulls = { [`${REPO}#7`]: openPull() };
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls });
    const review = fakeReview([posted]);
    await h.run(['--once'], { impl, review });
    pulls[`${REPO}#7`] = openPull({ head: sha('b') });
    await h.run(['--once'], { impl, review });
    assert.equal(review.calls.length, 2);
    assert.deepEqual(rows(h).map((row) => row.head_sha), [sha('a'), sha('b')]);
  });
});

test('a skip writes a skipped row with its rule and is not evaluated again', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull({ author: 'carol' }) } });
    const review = fakeReview([posted]);
    const config = settings({ skip: { authors: ['carol'] } });
    assert.equal(await h.run(['--once'], { impl, review, config }), 0);
    assert.equal(h.out[0].split('\n')[0], `${REPO}#7: skip (skipped authors)`);
    assert.deepEqual(rows(h).map((row) => [row.status, row.detail]), [['skipped', 'authors']]);

    assert.equal(await h.run(['--once'], { impl, review, config }), 0);
    assert.match(h.out[0], /^0 entries;/);
    assert.equal(review.calls.length, 0);
    assert.equal(rows(h)[0].updated_at, NOW.toISOString());
  });
});

test('a failed review adds an attempt, exits 1, and stops being retried at the cap', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const review = fakeReview([{ exitCode: 7, runId: null, event: null, reviewUrl: null, detail: 'an agent failed twice: diff-analyst' }]);

    assert.equal(await h.run(['--once'], { impl, review }), 1);
    assert.equal(h.out[0].split('\n')[0], `${REPO}#7: review (failed an agent failed twice: diff-analyst)`);
    assert.equal(rows(h)[0].attempts, 1);

    assert.equal(await h.run(['--once'], { impl, review }), 1);
    assert.equal(rows(h)[0].attempts, 2);

    assert.equal(await h.run(['--once'], { impl, review }), 0);
    assert.match(h.out[0], /^0 entries;/);
    assert.equal(review.calls.length, 2, 'left for a person after two attempts');
    assert.equal(rows(h)[0].detail, 'an agent failed twice: diff-analyst', 'the detail is kept');
  });
});

test('watch.max_attempts_per_head sets the cap', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const review = fakeReview([{ exitCode: 2, runId: null, event: null, reviewUrl: null, detail: 'review refused' }]);
    const config = settings({ watch: { maxAttemptsPerHead: 1 } });
    await h.run(['--once'], { impl, review, config });
    await h.run(['--once'], { impl, review, config });
    assert.equal(review.calls.length, 1);
  });
});

test('a moved head leaves no row and is retried on the next pass', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const review = fakeReview([{ exitCode: 3, runId: null, event: null, reviewUrl: null, detail: 'head moved' }, posted]);
    assert.equal(await h.run(['--once'], { impl, review }), 0);
    assert.deepEqual(h.out[0].split('\n'), [
      `${REPO}#7: review (no row: head moved)`,
      '1 entry: 1 retried; 0 not reached; outcomes followed on 0 pull request(s)',
    ]);
    assert.deepEqual(rows(h), []);
    await h.run(['--once'], { impl, review });
    assert.equal(review.calls.length, 2);
    assert.equal(rows(h)[0].status, 'posted');
  });
});

test('exit 4 and exit 6 record waiting-ci and held; held is not handled again', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({
      requested: [item(REPO, 7), item(REPO, 8)],
      pulls: { [`${REPO}#7`]: openPull(), [`${REPO}#8`]: openPull({ head: sha('c') }) },
    });
    const review = async (args) =>
      args.pull === 7
        ? { exitCode: 4, runId: 'run-7', event: 'APPROVE', reviewUrl: null, detail: 'waiting on CI' }
        : { exitCode: 6, runId: 'run-8', event: null, reviewUrl: null, detail: 'CI needs a rerun' };
    assert.equal(await h.run(['--once', '--json'], { impl, review }), 0);
    const printed = JSON.parse(h.out[0]);
    assert.deepEqual(printed.map((row) => [row.pull, row.status, row.runId]), [[7, 'waiting-ci', 'run-7'], [8, 'held', 'run-8']]);
    assert.deepEqual(Object.keys(printed[0]).sort(), ['attempts', 'detail', 'event', 'head', 'pull', 'repository', 'reviewUrl', 'runId', 'status', 'updatedAt']);

    // Without a recorded run the waiting head comes back as a review; the held one does not come back.
    await h.run(['--once', '--json'], { impl, review });
    assert.deepEqual(JSON.parse(h.out[0]).map((row) => row.pull), [7]);
  });
});

test('waiting on red CI, then green: the recheck path approves exactly once', async () => {
  await withWatcher(async (h) => {
    const db = h.openDb();
    recordRun(db, { repository: REPO, baseRef: null, headRef: sha('a'), pullNumber: 7, diff: 'diff', output: 'No actionable findings.', scores: [] });
    db.close();
    const state = { ci: 'red' };
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() }, state });
    const review = fakeReview([posted]);

    // Red CI caps the approval at COMMENT.
    assert.equal(await h.run(['--once', '--post'], { impl, review }), 0);
    assert.match(h.out[0], /^acme\/web#7: verdict-only COMMENT \(posted https:/);
    // Still red: the recheck waits.
    assert.equal(await h.run(['--once', '--post'], { impl, review }), 0);
    assert.match(h.out[0], /^acme\/web#7: recheck-ci .*\(waiting-ci /);
    assert.equal(rows(h)[0].status, 'waiting-ci');
    // Green: the approval goes out.
    state.ci = 'green';
    assert.equal(await h.run(['--once', '--post'], { impl, review }), 0);
    assert.match(h.out[0], /^acme\/web#7: recheck-ci APPROVE \(posted https:/);
    // And never again.
    assert.equal(await h.run(['--once', '--post'], { impl, review }), 0);
    assert.match(h.out[0], /^0 entries;/);

    assert.deepEqual(impl.posts().map((c) => c.body.event), ['COMMENT', 'APPROVE']);
    assert.equal(review.calls.length, 0, 'a recorded run is never reviewed again');
    assert.equal(rows(h)[0].status, 'posted');
  });
});

test('without --post a recorded run is reviewed, not posted, and the outcomes step reads sent reviews', async () => {
  await withWatcher(async (h) => {
    const db = h.openDb();
    recordRun(db, { repository: REPO, baseRef: null, headRef: sha('a'), pullNumber: 7, diff: 'diff', output: 'No actionable findings.', scores: [] });
    recordAudit(db, 'review_post_sent', { type: 'pull_request', id: `${REPO}#5` }, { head: sha('e'), event: 'COMMENT', inline: [] });
    db.close();
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    assert.equal(await h.run(['--once'], { impl }), 0);
    assert.deepEqual(h.out[0].split('\n'), [
      `${REPO}#7: verdict-only APPROVE (reviewed)`,
      '1 entry: 1 reviewed; 0 not reached; outcomes followed on 1 pull request(s)',
    ]);
    assert.equal(impl.posts().length, 0);
  });
});

// --- invocation and the lock ---

test('--post without writes.github_posting_enabled exits 2 before anything is read', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub();
    assert.equal(await h.run(['--once', '--post'], { impl, config: settings({ postingEnabled: false }) }), 2);
    assert.match(h.err.join('\n'), /writes\.github_posting_enabled/);
    assert.equal(impl.calls.length, 0);
  });
});

test('bad flags and an empty allowlist exit 2', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub();
    assert.equal(await h.run(['--interval', 'soon'], { impl }), 2);
    assert.equal(await h.run(['--mode', 'cheap'], { impl }), 2);
    assert.equal(await h.run(['--max', '0'], { impl }), 2);
    assert.equal(await h.run(['--once'], { impl, config: { ...settings(), allowlist: [] } }), 2);
    assert.equal(impl.calls.length, 0);
  });
});

test('a second watcher exits 2 naming the holder, whatever watch.lock says', async () => {
  await withWatcher(async (h) => {
    const held = await acquireLock(h.dir);
    try {
      writeFileSync(join(h.dir, 'watch.lock'), '999999');
      const impl = fakeGitHub();
      assert.equal(await h.run(['--once'], { impl }), 2);
      assert.match(h.err.join('\n'), new RegExp(`Another watcher is running on .* \\(pid ${process.pid}\\)`));
      assert.equal(impl.calls.length, 0);
    } finally {
      held.release();
    }
  });
});

test('watch.lock is display only: a leftover one is overwritten with this pid, and removed on exit', async () => {
  await withWatcher(async (h) => {
    const lock = join(h.dir, 'watch.lock');
    writeFileSync(lock, String(spawnSync(process.execPath, ['-e', '']).pid));
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const seen = [];
    const review = async () => {
      seen.push(readFileSync(lock, 'utf8'));
      return posted;
    };
    assert.equal(await h.run(['--once'], { impl, review }), 0);
    assert.deepEqual(seen, [String(process.pid)]);
    assert.equal(existsSync(lock), false);
  });
});

test('a program other than a watcher on the lock port: exit 2 naming watch.lock_port', async () => {
  await withWatcher(async (h) => {
    const foreign = createServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise((resolve) => foreign.listen({ host: '127.0.0.1', port: 0 }, resolve));
    try {
      const port = foreign.address().port;
      const impl = fakeGitHub();
      assert.equal(await h.run(['--once'], { impl, config: settings({ watch: { lockPort: port } }) }), 2);
      assert.match(h.err.join('\n'), new RegExp(`Port ${port} on 127\\.0\\.0\\.1, .* is taken by another program\\. Set watch\\.lock_port`));
      assert.equal(impl.calls.length, 0);
    } finally {
      foreign.close();
    }
  });
});

test('--interval loops without overlapping, waiting out the rest of the interval', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub();
    const waits = [];
    const sleep = async (ms) => {
      waits.push(ms);
      if (waits.length === 2) throw new Error('stop');
    };
    await assert.rejects(() => h.run(['--interval', '30m'], { impl, sleep }), /stop/);
    assert.deepEqual(waits, [30 * 60_000, 30 * 60_000]);
    assert.equal(impl.calls.filter((c) => c.path === '/user').length, 2, 'two passes, one after the other');
    assert.equal(existsSync(join(h.dir, 'watch.lock')), false);
  });
});

// --- the queue seam ---

test('the queue output is unchanged while the watch table is empty, and a settled head drops out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-queue-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    const pulls = {
      'acme/web#1': openPull({ head: sha('1') }),
      'acme/web#2': openPull({ head: sha('2') }),
      'acme/web#3': openPull({ head: sha('3') }),
      'acme/web#4': openPull({ head: sha('4'), author: 'carol' }),
    };
    const impl = fakeGitHub({ requested: [1, 2, 3, 4].map((n) => item(REPO, n)), pulls });
    recordRun(db, { repository: REPO, baseRef: null, headRef: sha('2'), pullNumber: 2, diff: 'd', output: 'No actionable findings.', scores: [] });
    recordAudit(db, 'review_post_sent', { type: 'pull_request', id: `${REPO}#3` }, { head: sha('3'), event: 'COMMENT', cappedByCi: true, inline: [] });
    const base = defaultQueueConfig();
    const config = { ...base, sources: ['requested'], skip: { ...base.skip, authors: ['carol'] } };
    const queue = () =>
      buildQueue({ client: new GitHubClient({ allowlist: ['acme/*'], allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }), db, config, me: ME, now: NOW });

    assert.equal(
      renderQueue(await queue()),
      [
        `REVIEW acme/web#1 1111111 @alice [requested]`,
        `VERDICT-ONLY acme/web#2 2222222 @alice [requested]`,
        `RECHECK-CI acme/web#3 3333333 @alice [requested]`,
        `SKIP acme/web#4 1234567 @carol [requested] (authors)`.replace('1234567', sha('4').slice(0, 7)),
        '4 listed, 0 not reached, 0 outside the allowlist, truncated: no',
      ].join('\n'),
    );

    const row = (pull, head, status) => ({ repository: REPO, pull, head, runId: null, event: null, reviewUrl: null, status, detail: null });
    saveWatchHead(db, row(1, sha('1'), 'failed'), NOW); // under the cap: kept
    saveWatchHead(db, row(2, sha('2'), 'held'), NOW);
    saveWatchHead(db, row(3, sha('3'), 'posted'), NOW); // a CI-capped COMMENT is still rechecked
    saveWatchHead(db, row(4, sha('4'), 'skipped'), NOW);
    assert.deepEqual((await queue()).entries.map((e) => `${e.action.kind} #${e.pull}`), ['review #1', 'recheck-ci #3']);
    assert.equal(watchHead(db, 'ACME/Web', 1, sha('1').toUpperCase()).attempts, 1, 'rows are matched without regard to case');
    const capped = await buildQueue({
      client: new GitHubClient({ allowlist: ['acme/*'], allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }),
      db,
      config,
      me: ME,
      now: NOW,
      maxAttemptsPerHead: 1,
    });
    assert.deepEqual(capped.entries.map((e) => `${e.action.kind} #${e.pull}`), ['recheck-ci #3'], 'maxAttemptsPerHead drops a head failed that often');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- parts ---

test('reviewResult reads review JSON defensively and maps the exit code to a detail', () => {
  assert.deepEqual(reviewResult(0, JSON.stringify({ runId: 'r', verdict: { event: 'COMMENT' }, reviewUrl: 'u' }), ''), {
    exitCode: 0,
    runId: 'r',
    event: 'COMMENT',
    reviewUrl: 'u',
    detail: null,
    carried: false,
  });
  assert.deepEqual(reviewResult(7, 'not json', 'first\ndiff-analyst refused twice\n'), {
    exitCode: 7,
    runId: null,
    event: null,
    reviewUrl: null,
    detail: 'an agent failed twice: diff-analyst refused twice',
    carried: false,
  });
  assert.equal(reviewResult(0, JSON.stringify({ verdict: { event: 'MERGE' }, reviewUrl: 3 }), '').event, null);
  assert.equal(reviewResult(9, '', '').detail, 'review exited 9');
});

const SPAWN = { configPath: null };
const CALL = { repository: REPO, pull: 7, expectHead: sha('a'), timeoutMs: 60_000, runRepositoryCommands: false };

test('spawnReview runs review --json from the bundle in the clone, adding --post --recheck-thread and --mode when given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-spawn-'));
  try {
    const script = join(dir, 'bundle.mjs');
    const seen = join(dir, 'argv.json');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), noCommands: process.env.REVIEW_VOICE_NO_COMMANDS ?? null, config: process.env.REVIEW_VOICE_CONFIG ?? null }));
       process.stdout.write(JSON.stringify({ runId: 'r9', verdict: { event: 'APPROVE' }, reviewUrl: null }));
       process.exit(process.argv.includes('--post') ? 0 : 4);`,
    );
    const clone = join(dir, 'clone');
    mkdirSync(clone);
    const result = await spawnReview(script, { configPath: '/abs/watch-config.yaml' })({ ...CALL, clone, post: true, mode: 'fast' });
    assert.deepEqual(result, { exitCode: 0, runId: 'r9', event: 'APPROVE', reviewUrl: null, detail: null, carried: false });
    const first = JSON.parse(readFileSync(seen, 'utf8'));
    assert.deepEqual(first.argv, ['review', '--pr', '7', '--repository', REPO, '--json', '--expect-head', sha('a'), '--post', '--recheck-thread', '--mode', 'fast']);
    assert.equal(first.cwd, realpath(clone));
    assert.equal(first.noCommands, '1', 'repository commands are off by default');
    assert.equal(first.config, '/abs/watch-config.yaml');

    const waiting = await spawnReview(script, SPAWN)({ ...CALL, clone, post: false, runRepositoryCommands: true });
    assert.equal(waiting.exitCode, 4);
    assert.match(waiting.detail, /^waiting on CI/);
    const second = JSON.parse(readFileSync(seen, 'utf8'));
    assert.deepEqual(second.argv, ['review', '--pr', '7', '--repository', REPO, '--json', '--expect-head', sha('a')]);
    assert.equal(second.noCommands, null, 'watch.run_repository_commands: true leaves them on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const realpath = (path) => execFileSync('pwd', ['-P'], { cwd: path, encoding: 'utf8' }).trim();

test('the review child reads the watcher config, never the clone config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-config-source-'));
  try {
    const load = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../plugins/review-voice/src/policy/load.ts')).href;
    const script = join(dir, 'bundle.mjs');
    writeFileSync(
      script,
      `import { loadConfig } from ${JSON.stringify(load)};
       const config = loadConfig(process.cwd());
       process.stdout.write(JSON.stringify({ runId: JSON.stringify({ allowlist: config.allowlist, posting: config.postingEnabled }) }));`,
    );
    const clone = join(dir, 'clones', 'acme', 'web');
    mkdirSync(join(clone, '.review-voice'), { recursive: true });
    writeFileSync(join(clone, '.review-voice', 'config.yaml'), 'repositories:\n  include: [mallory/*]\nwrites:\n  github_posting_enabled: true\n');
    const own = join(dir, 'home', '.review-voice', 'config.yaml');
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, 'repositories:\n  include: [acme/*]\nwrites:\n  github_posting_enabled: false\n');

    const result = await spawnReview(script, { configPath: own })({ ...CALL, clone, post: false });
    assert.deepEqual(JSON.parse(result.runId), { allowlist: ['acme/*'], posting: false });
    // Without the override the clone's own config would have been read.
    const unpinned = await spawnReview(script, SPAWN)({ ...CALL, clone, post: false });
    assert.deepEqual(JSON.parse(unpinned.runId), { allowlist: ['mallory/*'], posting: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REVIEW_VOICE_CONFIG must be absolute; a relative one warns and the repository config is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-config-env-'));
  const previous = process.env.REVIEW_VOICE_CONFIG;
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), 'repositories:\n  include: [acme/web]\n');
    writeFileSync(join(dir, 'other.yaml'), 'repositories:\n  include: [acme/api]\n');
    process.env.REVIEW_VOICE_CONFIG = join(dir, 'other.yaml');
    assert.deepEqual(loadConfig(dir).allowlist, ['acme/api']);
    process.env.REVIEW_VOICE_CONFIG = 'other.yaml';
    const config = loadConfig(dir);
    assert.deepEqual(config.allowlist, ['acme/web']);
    assert.match(config.warnings.join('\n'), /REVIEW_VOICE_CONFIG must be an absolute path/);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_VOICE_CONFIG;
    else process.env.REVIEW_VOICE_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A bundle that starts a grandchild, records its pid, and never finishes. */
function sleepingBundle(dir) {
  const script = join(dir, 'bundle.mjs');
  const pidFile = join(dir, 'grandchild.pid');
  writeFileSync(
    script,
    `import { spawn } from 'node:child_process';
     import { writeFileSync } from 'node:fs';
     const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
     writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
     setTimeout(() => {}, 60000);`,
  );
  return { script, pidFile };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a review past its timeout gets SIGTERM, its process group goes, and it is reported as timed out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-timeout-'));
  try {
    const { script, pidFile } = sleepingBundle(dir);
    const result = await spawnReview(script, { configPath: null, graceMs: 500 })({ ...CALL, clone: dir, post: false, timeoutMs: 1_000 });
    assert.deepEqual(result, { exitCode: 124, runId: null, event: null, reviewUrl: null, detail: 'review timed out after 1s' });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(grandchild));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a review that ignores SIGTERM is sent SIGKILL after the grace period', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-grace-'));
  try {
    const script = join(dir, 'bundle.mjs');
    const termed = join(dir, 'termed');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
       process.on('SIGTERM', () => writeFileSync(${JSON.stringify(termed)}, 'yes'));
       writeFileSync(${JSON.stringify(join(dir, 'ready'))}, 'yes');
       setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const result = await spawnReview(script, { configPath: null, graceMs: 800 })({ ...CALL, clone: dir, post: false, timeoutMs: 500 });
    assert.equal(result.detail, 'review timed out after 500ms');
    assert.equal(readFileSync(termed, 'utf8'), 'yes', 'SIGTERM came first');
    assert.ok(Date.now() - started >= 1_200, 'and SIGKILL only after the grace period');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a descendant holding stdout cannot keep the review from settling', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-descendant-'));
  const strays = [];
  try {
    // The stray is detached, so it is outside the review's process group and outlives it, still holding stdout.
    const bundle = (tail) => {
      const script = join(dir, `bundle-${strays.length}.mjs`);
      const pidFile = `${script}.pid`;
      writeFileSync(
        script,
        `import { spawn } from 'node:child_process';
         import { writeFileSync } from 'node:fs';
         const stray = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
         stray.unref();
         writeFileSync(${JSON.stringify(pidFile)}, String(stray.pid));
         ${tail}`,
      );
      return { script, pidFile };
    };
    const exiting = bundle(`process.stdout.write(JSON.stringify({ runId: 'r1' })); process.exit(0);`);
    const done = await spawnReview(exiting.script, SPAWN)({ ...CALL, clone: dir, post: false });
    strays.push(Number(readFileSync(exiting.pidFile, 'utf8')));
    assert.equal(done.exitCode, 0);
    assert.equal(done.runId, 'r1');

    const hanging = bundle('setInterval(() => {}, 1000);');
    const timedOut = await spawnReview(hanging.script, { configPath: null, graceMs: 500 })({ ...CALL, clone: dir, post: false, timeoutMs: 500 });
    strays.push(Number(readFileSync(hanging.pidFile, 'utf8')));
    assert.equal(timedOut.detail, 'review timed out after 500ms');
  } finally {
    for (const pid of strays) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop ends a running review and its process group, and waits for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-stop-'));
  try {
    const { script, pidFile } = sleepingBundle(dir);
    const review = spawnReview(script, { configPath: null, graceMs: 2_000 });
    const running = review({ ...CALL, clone: dir, post: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    await review.stop();
    const result = await running;
    assert.equal(result.exitCode, 1);
    assert.match(result.detail, /killed by SIGTERM/);
    await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGINT during a pass stops the review before the lock is released', async () => {
  await withWatcher(async (h) => {
    const lock = join(h.dir, 'watch.lock');
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const order = [];
    const exit = process.exit;
    process.exit = (code) => order.push(`exit ${code}`);
    try {
      const review = async () => {
        process.emit('SIGINT', 'SIGINT');
        return posted;
      };
      await h.run(['--once'], { impl, review, stopReview: () => order.push(`stop, lock ${existsSync(lock) ? 'held' : 'gone'}`) });
    } finally {
      process.exit = exit;
    }
    assert.deepEqual(order, ['stop, lock held', 'exit 130']);
    assert.equal(existsSync(lock), false);
  });
});

test('a review the child reports as carried is recorded as carried when posting', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    const carried = { exitCode: 0, runId: 'run-1', event: null, reviewUrl: null, detail: null, carried: true };
    assert.equal(await h.run(['--once', '--post'], { impl, review: fakeReview([carried]) }), 0);
    assert.equal(rows(h)[0].status, 'carried');
    assert.equal(reviewResult(0, JSON.stringify({ verdict: { action: 'carry' } }), '').carried, true);
    assert.equal(reviewResult(0, JSON.stringify({ carried: true }), '').carried, true);
    assert.equal(reviewResult(0, JSON.stringify({ verdict: { action: 'post' } }), '').carried, false);
  });
});

test('a carried flag without --post is still recorded as reviewed', async () => {
  await withWatcher(async (h) => {
    const impl = fakeGitHub({ requested: [item(REPO, 7)], pulls: { [`${REPO}#7`]: openPull() } });
    await h.run(['--once'], { impl, review: fakeReview([{ exitCode: 0, runId: 'run-1', event: null, reviewUrl: null, detail: null, carried: true }]) });
    assert.equal(rows(h)[0].status, 'reviewed');
  });
});

test('status prints the watcher counts and the five newest rows, and nothing without rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-status-'));
  try {
    const bundle = join(dirname(fileURLToPath(import.meta.url)), '../plugins/review-voice/dist/review-voice.mjs');
    const status = () =>
      execFileSync(process.execPath, [bundle, 'status'], { cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir }, encoding: 'utf8' });
    const db = openDatabase(join(dir, 'review-voice.db'));
    assert.doesNotMatch(status(), /^watcher/m);
    const row = (pull, status, detail = null) => ({ repository: REPO, pull, head: sha(String(pull)), runId: null, event: null, reviewUrl: null, status, detail });
    for (let pull = 1; pull <= 6; pull += 1) {
      saveWatchHead(db, row(pull, pull === 6 ? 'failed' : 'posted', pull === 6 ? 'review timed out after 45m' : null), new Date(Date.UTC(2026, 9, pull)));
    }
    assert.deepEqual(watchSummary(db), [
      'watcher          1 failed, 5 posted',
      `  ${REPO}#6 6666666 failed review timed out after 45m`,
      `  ${REPO}#5 5555555 posted`,
      `  ${REPO}#4 4444444 posted`,
      `  ${REPO}#3 3333333 posted`,
      `  ${REPO}#2 2222222 posted`,
    ]);
    db.close();
    assert.ok(status().includes(watchSummary(openDatabase(join(dir, 'review-voice.db'))).join('\n')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the clone step clones once with gh, falls back to git over https, and always fetches the head', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-clone-'));
  try {
    const calls = [];
    const clone = join(dir, 'acme', 'web');
    gitPrepareClone((command, args) => calls.push([command, ...args]))(REPO, 7, clone);
    assert.deepEqual(calls, [
      ['gh', 'repo', 'clone', REPO, clone, '--', '--filter=blob:none'],
      ['git', '-C', clone, 'worktree', 'prune'],
      ['git', '-C', clone, 'fetch', '--no-tags', '--quiet', 'origin', '+pull/7/head:refs/review-voice/pr/7/head'],
    ]);

    calls.length = 0;
    const noGh = (command, args) => {
      if (command === 'gh') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      calls.push([command, ...args]);
    };
    gitPrepareClone(noGh)(REPO, 7, clone);
    assert.deepEqual(calls[0], ['git', 'clone', '--filter=blob:none', `https://github.com/${REPO}.git`, clone]);

    calls.length = 0;
    mkdirSync(join(clone, '.git'), { recursive: true });
    gitPrepareClone((command, args) => calls.push([command, ...args]))(REPO, 8, clone);
    assert.deepEqual(calls.map((c) => c[0] + ' ' + c[3]), ['git worktree', 'git fetch'], 'an existing clone is only pruned and fetched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository name that could leave the workspace is refused', () => {
  assert.equal(cloneDir('/w', 'acme/web'), join('/w', 'acme', 'web'));
  for (const name of ['acme/..', 'acme/.', '../x', 'acme/web/extra', '-x/web', 'acme']) {
    assert.throws(() => cloneDir('/w', name), /not an owner\/repo name/, name);
  }
});

test('watch: config keys are read, and bad values warn and keep the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    const write = (yaml) => writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    write('watch:\n  workspace: /srv/clones\n  interval: 30m\n  post: true\n  max_attempts_per_head: 3\n  review_timeout: 20m\n  run_repository_commands: true\n  lock_port: 50123\n');
    let config = loadConfig(dir);
    assert.deepEqual(config.watch, { workspace: '/srv/clones', intervalMs: 30 * 60_000, post: true, maxAttemptsPerHead: 3, reviewTimeoutMs: 20 * 60_000, runRepositoryCommands: true, lockPort: 50123 });
    assert.deepEqual(config.warnings, []);

    write('watch:\n  workspace: ""\n  interval: soon\n  post: yes please\n  max_attempts_per_head: 0\n  review_timeout: 7h\n  run_repository_commands: sometimes\n  lock_port: 80\n');
    config = loadConfig(dir);
    assert.deepEqual(config.watch, defaultWatchConfig());
    assert.equal(config.warnings.length, 7);

    write('identity:\n  owner_reviewer: your-github-login\n');
    assert.deepEqual(loadConfig(dir).watch, defaultWatchConfig());
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('0m'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ref lock left by a killed run does not fail the next fetch; a fresh one is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-gitlock-'));
  try {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=watch-test', '-c', 'user.email=watch-test@example.com', ...args], { cwd, stdio: 'pipe' });
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q');
    writeFileSync(join(origin, 'a.txt'), 'a\n');
    git(origin, 'add', 'a.txt');
    git(origin, 'commit', '-q', '-m', 'one');
    git(origin, 'update-ref', 'refs/pull/7/head', 'HEAD');
    const clone = join(dir, 'clone');
    git(dir, 'clone', '-q', origin, clone);

    const lockDir = join(clone, '.git', 'refs', 'review-voice', 'pr', '7');
    mkdirSync(lockDir, { recursive: true });
    const stale = join(lockDir, 'head.lock');
    writeFileSync(stale, '');
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(stale, old, old);
    const fresh = join(clone, '.git', 'index.lock');
    writeFileSync(fresh, '');

    gitPrepareClone()(REPO, 7, clone);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true, 'a lock younger than ten minutes may be a running git');
    assert.match(execFileSync('git', ['rev-parse', 'refs/review-voice/pr/7/head'], { cwd: clone, encoding: 'utf8' }), /^[0-9a-f]{40}/);
    assert.deepEqual(removeStaleGitLocks(clone), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue uses watch.max_attempts_per_head, and queue --settled lists what watch left for a person', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-queue-cmd-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    const impl = fakeGitHub({ requested: [item(REPO, 1), item(REPO, 2)], pulls: { 'acme/web#1': openPull({ head: sha('1') }), 'acme/web#2': openPull({ head: sha('2') }) } });
    const row = (pull, status, detail, at) => saveWatchHead(db, { repository: REPO, pull, head: sha(String(pull)), runId: null, event: null, reviewUrl: null, status, detail }, at);
    row(1, 'failed', 'an agent failed twice', new Date('2026-10-20T00:00:00Z'));
    row(3, 'held', 'CI needs a rerun', new Date('2026-10-21T00:00:00Z'));
    row(4, 'skipped', 'authors', new Date('2026-10-22T00:00:00Z'));
    row(5, 'posted', null, new Date('2026-10-23T00:00:00Z'));
    const out = [];
    const deps = (cap) => ({
      config: { allowlist: ['acme/*'], queue: { ...defaultQueueConfig(), sources: ['requested'] }, warnings: [], watch: { maxAttemptsPerHead: cap } },
      client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }),
      openDb: () => ({ prepare: (...args) => db.prepare(...args), close: () => {} }),
      now: NOW,
      out: (text) => out.push(text),
      err: () => {},
    });

    assert.equal(await queueCommand([], deps(1)), 0);
    assert.deepEqual(out.pop().split('\n').slice(0, -1), [`REVIEW acme/web#2 2222222 @alice [requested]`], 'one failure is the cap');
    assert.equal(await queueCommand([], deps(2)), 0);
    assert.equal(out.pop().split('\n').length, 3, 'under the default cap the failed head is listed again');

    assert.equal(await queueCommand(['--settled'], deps(1)), 0);
    assert.equal(
      out.pop(),
      [
        `SKIPPED acme/web#4 4444444 authors`,
        `HELD acme/web#3 3333333 CI needs a rerun`,
        `FAILED acme/web#1 1111111 (1 attempts) an agent failed twice`,
        '3 left for a person',
      ].join('\n'),
    );
    assert.equal(await queueCommand(['--settled'], deps(2)), 0);
    assert.match(out.pop(), /^2 left for a person$/m);
    assert.equal(await queueCommand(['--settled', '--json'], deps(1)), 0);
    assert.deepEqual(JSON.parse(out.pop()).map((head) => head.status), ['skipped', 'held', 'failed']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A process that takes the lock for `dataDir`, prints the outcome, and holds it until killed. */
function lockWorker(dir, dataDir, start) {
  const lock = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../plugins/review-voice/src/watch/lock.ts')).href;
  const worker = join(dir, 'worker.mjs');
  writeFileSync(
    worker,
    `import { existsSync } from 'node:fs';
     import { acquireLock } from ${JSON.stringify(lock)};
     while (${JSON.stringify(start)} !== null && !existsSync(${JSON.stringify(start ?? '')})) {}
     const result = await acquireLock(${JSON.stringify(dataDir)});
     process.stdout.write(('release' in result ? 'won' : 'holder' in result ? 'lost ' + result.holder : 'foreign') + '\\n');
     setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [worker], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.line = new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.trim());
    });
  });
  return child;
}

test('two watchers started together: exactly one runs, and the other names it', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-lock-'));
  const start = join(dir, 'start');
  const children = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      mkdirSync(join(dir, `w${i}`));
      children.push(lockWorker(join(dir, `w${i}`), dir, start));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    writeFileSync(start, '');
    const lines = await Promise.all(children.map((child) => child.line));
    const winner = children[lines.indexOf('won')];
    assert.equal(lines.filter((line) => line === 'won').length, 1, lines.join(', '));
    assert.deepEqual(lines.filter((line) => line !== 'won'), [`lost ${winner.pid}`]);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a watcher killed with SIGKILL frees the lock at once for the next one', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-lock-kill-'));
  try {
    const holder = lockWorker(dir, dir, null);
    assert.equal(await holder.line, 'won');
    assert.deepEqual(await acquireLock(dir), { holder: holder.pid });
    const exited = new Promise((resolve) => holder.on('exit', resolve));
    holder.kill('SIGKILL');
    await exited;
    const next = await acquireLock(dir);
    assert.ok('release' in next, 'no stale state to wait out or take over');
    next.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock port is derived from the data directory and stays in the dynamic range', () => {
  const a = lockPort('/data/one');
  assert.equal(lockPort('/data/one'), a);
  assert.notEqual(lockPort('/data/two'), a);
  for (const path of ['/a', '/b', '/c', '/d']) {
    const port = lockPort(path);
    assert.ok(port >= 49152 && port < 65152, String(port));
  }
});

test('the config copy is replaced atomically with mode 0600, never written through a symlink', async () => {
  await withWatcher(async (h) => {
    const outside = join(h.dir, 'outside.yaml');
    writeFileSync(outside, 'untouched\n');
    symlinkSync(outside, join(h.dir, 'watch-config.yaml'));
    writeFileSync(join(h.dir, `watch-config.yaml.tmp-${process.pid}`), 'left by a crash\n');
    assert.equal(await h.run(['--once'], { impl: fakeGitHub() }), 0);
    const copy = join(h.dir, 'watch-config.yaml');
    assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
    assert.equal(lstatSync(copy).isSymbolicLink(), false);
    assert.equal(lstatSync(copy).mode & 0o777, 0o600);
    assert.equal(readFileSync(copy, 'utf8'), 'watch: {}\n');
    assert.equal(existsSync(join(h.dir, `watch-config.yaml.tmp-${process.pid}`)), false);
  });
});

test('once a stopped review exits, the rest of its group is killed at once, not after the grace period', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-group-'));
  try {
    const script = join(dir, 'bundle.mjs');
    const pidFile = join(dir, 'stubborn.pid');
    // An agent that ignores SIGTERM, in the review's process group.
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
       import { fileURLToPath } from 'node:url';
       const pidFile = fileURLToPath(new URL('stubborn.pid', import.meta.url));
       const agent = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
       spawn(process.execPath, ['-e', agent, pidFile], { stdio: 'ignore' });
       setInterval(() => {}, 1000);`,
    );
    const review = spawnReview(script, { configPath: null, graceMs: 10_000 });
    const running = review({ ...CALL, clone: dir, post: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const started = Date.now();
    await review.stop();
    await running;
    await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 3_000);
    assert.ok(Date.now() - started < 5_000, 'well inside the 10 s grace period');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
