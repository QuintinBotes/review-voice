// #545: GitHub Enterprise Server (`https://<host>/api/v3`) and GHE.com data
// residency (`https://api.<sub>.ghe.com`) work when the operator, or the
// Actions runner, sets GITHUB_API_URL. The token goes to that host and no other,
// and with nothing set the host is still api.github.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, NotAllowlisted, REVIEW_THREADS_QUERY } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { githubToken } from '../plugins/review-voice/src/github/auth.ts';
import { apiBaseUrl, remoteRepository, webHost } from '../plugins/review-voice/src/github/host.ts';

import { closingReferences } from '../plugins/review-voice/src/diff/thread.ts';

const REPO = 'acme/web';
const SHA = 'a'.repeat(40);

function fakeFetch(respond = () => ok({})) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, authorization: init?.headers?.authorization, redirect: init?.redirect });
    return respond(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

const ok = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/** Runs `fn` with GITHUB_API_URL set to `value` (or unset), restoring it after. */
async function withApiUrl(value, fn) {
  const saved = process.env.GITHUB_API_URL;
  if (value === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** Every request the reader and the writer make, against whatever host is configured. */
async function everyRequest() {
  const fetchImpl = fakeFetch((url) => ok(url.endsWith('/graphql') ? { data: {} } : { id: 1 }));
  const reader = new GitHubClient({ allowlist: [REPO], token: 'tkn', fetchImpl, sleep: async () => {} });
  await reader.get(`/repos/${REPO}/pulls/5`);
  await reader.graphql(REPO, REVIEW_THREADS_QUERY, { number: 5, cursor: null });
  const writer = new ReviewWriter({ allowlist: [REPO], token: 'tkn', fetchImpl });
  await writer.submitReview(REPO, 5, { commit_id: SHA, event: 'COMMENT', body: 'b', comments: [] });
  await writer.replyToComment(REPO, 5, 9, 'thanks');
  return fetchImpl.calls;
}

const HOSTS = [
  {
    name: 'Enterprise Server',
    api: 'https://ghe.example.com/api/v3',
    graphql: 'https://ghe.example.com/api/graphql',
    web: 'ghe.example.com',
  },
  {
    name: 'GHE.com data residency',
    api: 'https://api.acme.ghe.com',
    graphql: 'https://api.acme.ghe.com/graphql',
    web: 'acme.ghe.com',
  },
];

for (const host of HOSTS) {
  test(`${host.name}: REST and GraphQL reads and both writes go to the configured host, with the token`, async () => {
    const calls = await withApiUrl(`${host.api}/`, everyRequest);
    assert.deepEqual(
      calls.map((call) => [call.method, call.url]),
      [
        ['GET', `${host.api}/repos/${REPO}/pulls/5`],
        ['POST', host.graphql],
        ['POST', `${host.api}/repos/${REPO}/pulls/5/reviews`],
        ['POST', `${host.api}/repos/${REPO}/pulls/5/comments/9/replies`],
      ],
    );
    for (const call of calls) {
      assert.equal(call.authorization, 'Bearer tkn');
      assert.equal(call.redirect, 'manual');
    }
  });

  test(`${host.name}: the web host follows, for origin matching and the clone`, async () => {
    await withApiUrl(host.api, () => {
      assert.equal(webHost(), host.web);
      assert.equal(remoteRepository(`https://${host.web}/${REPO}.git`), REPO);
      assert.equal(remoteRepository(`git@${host.web}:${REPO}.git`), REPO);
      assert.equal(remoteRepository(`https://other-${host.web}/${REPO}.git`), null);
      assert.equal(remoteRepository(`https://other.example/a/${host.web}/${REPO}.git`), null);
      assert.deepEqual(closingReferences(`Fixes https://${host.web}/${REPO}/issues/2 and closes https://github.com/${REPO}/issues/3`, REPO).numbers, [2]);
      // A github.com remote is another host's repository, not this one.
      assert.equal(remoteRepository(`https://github.com/${REPO}.git`), null);
    });
  });
}

test('with nothing configured, every request still goes to api.github.com', async () => {
  const calls = await withApiUrl(undefined, everyRequest);
  assert.deepEqual(calls.map((call) => call.url), [
    `https://api.github.com/repos/${REPO}/pulls/5`,
    'https://api.github.com/graphql',
    `https://api.github.com/repos/${REPO}/pulls/5/reviews`,
    `https://api.github.com/repos/${REPO}/pulls/5/comments/9/replies`,
  ]);
  assert.equal(webHost(), 'github.com');
  assert.equal(remoteRepository(`git@${webHost()}:${REPO}.git`), REPO);
});

test('configured for Enterprise Server, the token is never sent to another host', async () => {
  await withApiUrl('https://ghe.example.com/api/v3', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes('page=2') ? ok([]) : ok([{ id: 1 }], { link: '<https://evil.example/repos/acme/web/pulls?page=2>; rel="next"' }),
    );
    const client = new GitHubClient({ allowlist: [REPO], token: 'tkn', fetchImpl, sleep: async () => {} });

    // An absolute URL on api.github.com, another host, or the right host outside the API root.
    for (const url of [
      `https://api.github.com/repos/${REPO}/pulls`,
      `https://evil.example/api/v3/repos/${REPO}/pulls`,
      `https://ghe.example.com/repos/${REPO}/pulls`,
      `http://ghe.example.com/api/v3/repos/${REPO}/pulls`,
    ]) {
      await assert.rejects(() => client.get(url), NotAllowlisted, url);
    }
    assert.equal(fetchImpl.calls.length, 0);

    // A pagination link naming another host is followed on the configured one.
    await client.paginate(`/repos/${REPO}/pulls`, 10);
    assert.deepEqual(fetchImpl.calls.map((call) => new URL(call.url).origin), ['https://ghe.example.com', 'https://ghe.example.com']);
  });
});

test('a redirect that lands on another host is refused', async () => {
  await withApiUrl('https://api.acme.ghe.com', async () => {
    const fetchImpl = fakeFetch(() => {
      const response = ok({ stolen: true });
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/repos/acme/web' });
      return response;
    });
    const client = new GitHubClient({ allowlist: [REPO], token: 'tkn', fetchImpl, sleep: async () => {} });
    await assert.rejects(() => client.get(`/repos/${REPO}`), NotAllowlisted);
  });
});

test('GITHUB_API_URL must be a plain https URL', () => {
  for (const bad of ['http://ghe.example.com/api/v3', 'https://user:pw@ghe.example.com/api/v3', 'https://ghe.example.com/api/v3?x=1', 'not a url']) {
    assert.throws(() => apiBaseUrl({ GITHUB_API_URL: bad }), /GITHUB_API_URL/, bad);
  }
  assert.equal(apiBaseUrl({}), 'https://api.github.com');
  assert.equal(apiBaseUrl({ GITHUB_API_URL: '' }), 'https://api.github.com');
});

test('the gh fallback asks for the configured host\'s token, and github.com\'s only by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-545-gh-'));
  const savedPath = process.env.PATH;
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "token-for $*"\n');
    chmodSync(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    assert.equal(githubToken({ GITHUB_API_URL: 'https://ghe.example.com/api/v3' }), 'token-for auth token --hostname ghe.example.com');
    assert.equal(githubToken({ GITHUB_API_URL: 'https://api.acme.ghe.com' }), 'token-for auth token --hostname acme.ghe.com');
    assert.equal(githubToken({}), 'token-for auth token');
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
