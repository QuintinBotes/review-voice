/**
 * `carry` printed an `important` finding again after the author replied with a
 * rebuttal, resolved its review thread and dismissed the review, because a
 * base merge left the pull request's own diff unchanged and carry looked only
 * at lines. `carry --thread` now holds back what the author already answered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

const IMPORTANT = '[important] `a.ts:20` - The loop at line 20 never ends because the counter is never incremented.';
const MINOR = '[minor] `b.ts:5` - This name shadows the import of the same name above.';
const IMPORTANT_BODY = '**important** - The loop at line 20 never ends because the counter is never incremented.';
const LATER = '2099-01-01T00:00:00Z';
const EARLIER = '2000-01-01T00:00:00Z';

function run(args, { input = '', cwd, dataDir }) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A repository with one recorded run of pull request 5, and a base merge that left both files alone. */
function withRun(review, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-held-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const write = (name, body) => writeFileSync(join(repo, name), body);
  try {
    execFileSync('mkdir', ['-p', repo, dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', lines(40));
    write('b.ts', lines(10));
    const prior = commit('first');
    const filesFile = join(base, 'files.json');
    writeFileSync(filesFile, JSON.stringify({ pullNumber: 5 }));
    const recorded = run(['record', '--repository', 'o/r', '--head', prior, '--files', filesFile], { input: review, cwd: repo, dataDir });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    write('c.ts', 'unrelated\n');
    const head = commit('merge base');
    const threadFile = join(base, 'thread.json');
    const writeThread = (thread) =>
      writeFileSync(threadFile, JSON.stringify({ repository: 'o/r', pullNumber: 5, comments: [], reviews: [], truncated: false, ...thread }));
    const carry = (...extra) => run(['carry', '--from', runId, '--head', head, '--text', ...extra], { cwd: repo, dataDir });
    const audit = (fn2) => {
      const db = openDatabase(join(dataDir, 'review-voice.db'));
      try {
        fn2(db);
      } finally {
        db.close();
      }
    };
    return fn({ write, commit, base, repo, dataDir, runId, head, prior, filesFile, threadFile, writeThread, carry, audit });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const inline = (extra) => ({
  path: 'a.ts',
  line: 20,
  author: 'review-bot',
  body: IMPORTANT_BODY,
  kind: 'review-comment',
  id: 1,
  createdAt: LATER,
  reviewId: 900,
  ...extra,
});

test('the reported case: resolved, dismissed and answered, so nothing is printed again', () => {
  withRun(IMPORTANT, ({ writeThread, threadFile, carry }) => {
    writeThread({
      comments: [
        inline({ resolved: true, resolvedBy: 'alice' }),
        { path: 'a.ts', line: 20, author: 'alice', body: 'Wrong: the counter is bumped by the caller.', kind: 'review-comment', id: 2, inReplyTo: 1, createdAt: LATER },
      ],
      reviews: [{ id: 900, author: 'review-bot', state: 'DISMISSED', dismissalMessage: 'Not a defect here.' }],
    });
    const result = carry('--thread', threadFile);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Held back: .* a\.ts:20 \(important\) - /);
    assert.match(result.stderr, /its thread was resolved by alice/);
    assert.match(result.stderr, /the review was dismissed: "Not a defect here\."/);
    assert.match(result.stderr, /alice replied: "Wrong: the counter is bumped by the caller\."/);
    assert.match(result.stderr, /1 finding was held back/);
    assert.doesNotMatch(result.stderr, /Review those files again/);
  });
});

test('a resolved thread alone holds a finding back, and the rest still prints', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ writeThread, threadFile, carry }) => {
    writeThread({ comments: [inline({ resolved: true })] });
    const result = carry('--thread', threadFile);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Held back: .* a\.ts:20 \(important\) - its thread was resolved$/m);
    assert.doesNotMatch(result.stdout, /loop/);
    assert.match(result.stdout, /`b\.ts:5` - This name shadows/);

  });
});

test('JSON mode lists heldBack, outside carried and notCarried', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ writeThread, threadFile, runId, head, repo, dataDir }) => {
    writeThread({ comments: [inline({ resolved: true, resolvedBy: 'alice' })] });
    const out = JSON.parse(run(['carry', '--from', runId, '--head', head, '--thread', threadFile], { cwd: repo, dataDir }).stdout);
    assert.equal(out.heldBack.length, 1);
    assert.equal(out.heldBack[0].path, 'a.ts');
    assert.equal(out.heldBack[0].line, 20);
    assert.equal(out.heldBack[0].severity, 'important');
    assert.match(out.heldBack[0].reason, /resolved by alice/);
    assert.deepEqual(out.carried.map((c) => c.path), ['b.ts']);
    assert.deepEqual(out.notCarried, []);
  });
});

test('a dismissed review holds back all its findings through the audit review id, matched comment or not', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ writeThread, threadFile, carry, audit, runId }) => {
    audit((db) => {
      const attempt = recordAudit(db, 'review_post_attempted', { type: 'pull_request', id: 'o/r#5' }, { key: 'k1', run: runId });
      recordAudit(db, 'review_post_sent', { type: 'pull_request', id: 'o/r#5' }, { key: 'k1', attempt, reviewId: 900 });
    });
    writeThread({ reviews: [{ id: 900, author: 'review-bot', state: 'DISMISSED', dismissalMessage: 'Superseded.' }] });
    const result = carry('--thread', threadFile);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.match(/^Held back: /gm).length, 2);
    assert.match(result.stderr, /the review was dismissed: "Superseded\."/);
  });
});

test('comments that are not the finding do not hold it back', () => {
  withRun(IMPORTANT, ({ writeThread, threadFile, carry, audit, runId }) => {
    const resolved = { resolved: true };
    writeThread({
      comments: [
        inline({ ...resolved, id: 10, path: 'b.ts' }),
        inline({ ...resolved, id: 11, body: '**important** - Something about an unrelated database connection pool.' }),
        inline({ ...resolved, id: 12, createdAt: EARLIER }),
        inline({ ...resolved, id: 13, inReplyTo: 9 }),
        inline({ ...resolved, id: 14, body: IMPORTANT_BODY.replace('**important**', '**minor**') }),
      ],
    });
    const result = carry('--thread', threadFile);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /loop at line 20/);
    assert.doesNotMatch(result.stderr, /Held back/);

    // With the posted review known, another review's comment does not count either.
    audit((db) => {
      const attempt = recordAudit(db, 'review_post_attempted', { type: 'pull_request', id: 'o/r#5' }, { key: 'k2', run: runId });
      recordAudit(db, 'review_post_sent', { type: 'pull_request', id: 'o/r#5' }, { key: 'k2', attempt, reviewId: 901 });
    });
    writeThread({ comments: [inline({ resolved: true, reviewId: 900 })] });
    assert.equal(carry('--thread', threadFile).code, 0);
    writeThread({ comments: [inline({ resolved: true, reviewId: 901, createdAt: EARLIER })] });
    assert.equal(carry('--thread', threadFile).code, 1);
  });
});

test('a thread of another pull request or repository is refused, naming both', () => {
  withRun(IMPORTANT, ({ writeThread, threadFile, carry }) => {
    writeThread({ pullNumber: 6 });
    const other = carry('--thread', threadFile);
    assert.equal(other.code, 2);
    assert.match(other.stderr, /o\/r#6/);
    assert.match(other.stderr, /o\/r#5/);
    writeThread({ repository: 'x/y' });
    assert.equal(carry('--thread', threadFile).code, 2);
    writeThread({ repository: 'O/R' });
    assert.equal(carry('--thread', threadFile).code, 0);
    assert.equal(carry('--thread').code, 2);
  });
});

test('without --thread carry behaves as before and says resolved or dismissed findings were not checked', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ carry }) => {
    const result = carry();
    assert.equal(result.code, 0);
    assert.match(result.stdout, /loop at line 20/);
    assert.match(result.stderr, /not checked/);
    assert.match(result.stderr, /--thread <thread\.json>/);
  });
});

test('a held-back serious finding is not a serious finding that did not carry', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ write, commit, writeThread, threadFile, runId, repo, dataDir }) => {
    write('b.ts', lines(10).replace('line 5\n', 'changed\n'));
    const head = commit('edit near the minor finding');
    writeThread({ comments: [inline({ resolved: true })] });
    const result = run(['carry', '--from', runId, '--head', head, '--text', '--thread', threadFile], { cwd: repo, dataDir });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Review those files again/);
    assert.match(result.stderr, /Not carried: .* b\.ts:5/);
    assert.match(result.stderr, /Held back: .* a\.ts:20/);
    assert.match(result.stderr, /held back/);
  });
});

test('record --carried-from takes the held-back-reduced text, with or without --thread', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ writeThread, threadFile, carry, runId, head, repo, dataDir, filesFile }) => {
    writeThread({ comments: [inline({ resolved: true })] });
    const printed = carry('--thread', threadFile);
    assert.equal(printed.code, 0, printed.stderr);
    for (const extra of [[], ['--thread', threadFile]]) {
      const recorded = run(
        ['record', '--repository', 'o/r', '--head', head, '--carried-from', runId, '--files', filesFile, ...extra],
        { input: printed.stdout, cwd: repo, dataDir },
      );
      assert.equal(recorded.code, 0, recorded.stderr);
      const findings = JSON.parse(recorded.stdout).findings;
      assert.equal(findings.length, 1);
      assert.equal(findings[0].path, 'b.ts');
    }
  });
});

test('record --carried-from refuses a thread of another pull request', () => {
  withRun(`${IMPORTANT}\n\n${MINOR}`, ({ writeThread, threadFile, runId, head, repo, dataDir, filesFile }) => {
    writeThread({ pullNumber: 6 });
    const recorded = run(
      ['record', '--repository', 'o/r', '--head', head, '--carried-from', runId, '--files', filesFile, '--thread', threadFile],
      { input: MINOR, cwd: repo, dataDir },
    );
    assert.equal(recorded.code, 2);
  });
});

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function threadClient(events) {
  const seen = [];
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    seen.push(pathname);
    if (pathname === '/repos/acme/web/pulls/7') return json({ body: '', user: { login: 'acme-author' } });
    if (pathname === '/repos/acme/web/pulls/7/comments') {
      return json([
        { id: 1, pull_request_review_id: 900, path: 'a.ts', line: 3, body: '**minor** - a point', user: { login: 'bot' }, created_at: LATER },
        { id: 2, pull_request_review_id: 901, in_reply_to_id: 1, path: 'a.ts', line: 3, body: 'fixed', user: { login: 'alice' } },
      ]);
    }
    if (pathname === '/repos/acme/web/pulls/7/reviews') {
      return json([
        { id: 900, state: 'DISMISSED', body: '', user: { login: 'bot' }, submitted_at: LATER },
        { id: 901, state: 'COMMENTED', body: 'see inline', user: { login: 'alice' } },
      ]);
    }
    if (pathname === '/repos/acme/web/issues/7/events') return events();
    if (pathname === '/graphql') return json({ errors: [{ message: 'no' }] });
    return json([]);
  };
  return { seen, client: new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl }) };
}

test('readThread records review ids, replies, every review and the dismissal message', async () => {
  const { seen, client } = threadClient(() =>
    json([
      { event: 'labeled' },
      { event: 'review_dismissed', dismissed_review: { review_id: 900, dismissal_message: 'Not a defect here.' } },
    ]),
  );
  const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  const [root, reply] = result.comments.filter((c) => c.kind === 'review-comment');
  assert.equal(root.reviewId, 900);
  assert.equal(root.inReplyTo, undefined);
  assert.equal(reply.inReplyTo, 1);
  assert.equal(result.comments.filter((c) => c.kind === 'review-body').length, 1);
  assert.deepEqual(result.reviews, [
    { id: 900, author: 'bot', state: 'DISMISSED', submittedAt: LATER, dismissalMessage: 'Not a defect here.' },
    { id: 901, author: 'alice', state: 'COMMENTED' },
  ]);
  assert.ok(seen.includes('/repos/acme/web/issues/7/events'));
});

test('a failed events read only warns', async () => {
  const { client } = threadClient(() => json({ message: 'nope' }, 403));
  const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.equal(result.reviews[0].dismissalMessage, undefined);
  assert.ok(result.warnings.some((w) => /why a review was dismissed/.test(w)));
  assert.equal(result.reviews.length, 2);
});

test('the events are not read when no review was dismissed', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).pathname);
    const { pathname } = new URL(url);
    if (pathname === '/repos/acme/web/pulls/7') return json({ body: '', user: { login: 'a' } });
    if (pathname === '/repos/acme/web/pulls/7/reviews') return json([{ id: 1, state: 'APPROVED', body: '', user: { login: 'a' } }]);
    return json([]);
  };
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl });
  const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.comments.length, 0);
  assert.ok(!seen.some((path) => path.endsWith('/events')));
});
