/**
 * Whether a review thread is resolved. Another reviewer's comment had been
 * marked fixed, but the fix covered one query in the file and the candidate was
 * about another. The candidate was linked to the comment by file, with no sign
 * that its thread was resolved, because the REST API does not expose that.
 *
 * Now one read-only GraphQL query reads each thread's state, the client refuses
 * any GraphQL document that is not a query, a failed read falls back to the
 * REST data with a warning, and `resolved: true` reaches the verifier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient, NotAllowlisted, ReadOnlyViolation, REVIEW_THREADS_QUERY } from '../plugins/review-voice/src/github/client.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function recordingClient(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return handler(url, init);
  };
  return { calls, client: new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl }) };
}

test('the client refuses any GraphQL document that is not a plain query, before anything is sent', async () => {
  const { calls, client } = recordingClient(() => json({ data: {} }));
  const refused = [
    'mutation { resolveReviewThread(input: {threadId: $id}) { thread { id } } }',
    'subscription { x }',
    'query A { a } mutation B { b }',
    'query { viewer { login } } # mutation',
    'fragment F on User { login }',
    'query { repository(owner: "other", name: "repo") { id } }',
  ];
  for (const document of refused) {
    await assert.rejects(() => client.graphql('acme/web', document), ReadOnlyViolation, document);
  }
  await assert.rejects(() => client.graphql('other/repo', REVIEW_THREADS_QUERY, { number: 1 }), NotAllowlisted);
  assert.equal(calls.length, 0);
});

test('a GraphQL query is posted to /graphql with owner and name forced to the allowlisted repository', async () => {
  const { calls, client } = recordingClient(() => json({ data: { ok: true } }));
  const data = await client.graphql('acme/web', REVIEW_THREADS_QUERY, { number: 1, cursor: null });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/graphql');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body).variables, { number: 1, cursor: null, owner: 'acme', name: 'web' });
  // REST stays GET-only.
  await assert.rejects(() => client.get('/repos/acme/web/pulls/1/reviews', { method: 'POST' }), ReadOnlyViolation);
});

function threadServer(graphql) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/graphql') return graphql(JSON.parse(init.body));
    if (path === '/repos/acme/web/pulls/7') return json({ body: '', user: { login: 'acme-author' } });
    if (path === '/repos/acme/web/pulls/7/comments') {
      return json([
        { id: 101, path: 'repo.ts', line: 20, original_line: 20, body: 'resolved one', user: { login: 'acme-reviewer' } },
        { id: 102, path: 'repo.ts', line: 40, original_line: 40, body: 'open one', user: { login: 'acme-reviewer' } },
      ]);
    }
    return json([]);
  };
}

test('readThread marks an inline comment whose thread is resolved, joined on the REST comment id', async () => {
  const seen = [];
  const fetchImpl = threadServer((request) => {
    seen.push(request.query);
    return json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 101, path: 'repo.ts', line: 20 }] } },
                { isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 102, path: 'repo.ts', line: 40 }] } },
              ],
            },
          },
        },
      },
    });
  });
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl });
  const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^query /);
  assert.equal(result.comments[0].resolved, true);
  assert.equal('resolved' in result.comments[1], false);
  assert.equal(result.warnings, undefined);
});

test('a failed GraphQL read falls back to the REST comments with a warning, and never fails the read', async () => {
  for (const failure of [
    () => json({ message: 'Resource not accessible by integration' }, 403),
    () => json({ errors: [{ message: 'API rate limit exceeded' }] }),
  ]) {
    const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl: threadServer(failure), sleep: async () => {} });
    const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
    assert.equal(result.comments.length, 2);
    assert.equal(result.comments.some((c) => 'resolved' in c), false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /resolved/);
  }
});

test('check-candidates carries resolved: true into possibleRepeatOf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-43-resolved-'));
  try {
    const patch = join(dir, 'diff.patch');
    writeFileSync(
      patch,
      ['diff --git a/repo.ts b/repo.ts', '--- /dev/null', '+++ b/repo.ts', '@@ -0,0 +1,80 @@', ...Array.from({ length: 80 }, (_, i) => `+line ${i + 1}`)].join('\n'),
    );
    const claim = 'The orders query interpolates the customer filter into raw SQL';
    const failure = 'a crafted filter value can read other tenants rows';
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({
        comments: [{ path: 'repo.ts', line: 20, author: 'acme-reviewer', body: `${claim}; ${failure}.`, kind: 'review-comment', resolved: true }],
      }),
    );
    const candidate = {
      candidate_id: 'c1', path: 'repo.ts', line: 35, category: 'security', severity: 'important',
      claim, failure_mode: failure, evidence: ['Seen in the changed lines.'], technical_confidence: 0.9,
    };
    const r = spawnSync(process.execPath, [bundle, 'check-candidates', '--diff-file', patch, '--thread', thread, '--owner', 'owner-login'], {
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'thread');
    assert.equal(out.kept[0].possibleRepeatOf.resolved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
