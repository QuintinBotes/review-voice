import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, ReadOnlyViolation, NotAllowlisted, GitHubError } from '../plugins/review-voice/src/github/client.ts';
import { classifyReviewer, isBot } from '../plugins/review-voice/src/github/roles.ts';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return handler(String(url), init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const ok = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl, allowlist = ['your-org/your-repo']) {
  return new GitHubClient({
    allowlist,
    token: 'test-token',
    fetchImpl,
    sleep: async () => {},
  });
}

test('a non-GET request is refused in code, not by convention', async () => {
  const impl = fakeFetch(() => ok({}));
  const gh = client(impl);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) {
    await assert.rejects(
      () => gh.get('/repos/your-org/your-repo/issues', { method }),
      ReadOnlyViolation,
      `${method} should be refused`,
    );
  }
  // Nothing reached the network.
  assert.equal(impl.calls.length, 0);
});

test('every issued request is a GET', async () => {
  const impl = fakeFetch(() => ok([]));
  await client(impl).get('/repos/your-org/your-repo/pulls');
  assert.deepEqual(impl.calls.map((call) => call.method), ['GET']);
});

test('a repository outside the allowlist is never contacted', async () => {
  const impl = fakeFetch(() => ok({}));
  await assert.rejects(
    () => client(impl).get('/repos/someone-else/private-thing/pulls'),
    NotAllowlisted,
  );
  // The token from `gh` is broader than Review Voice needs, so the allowlist -
  // not the token - is what bounds access. It must stop the request outright.
  assert.equal(impl.calls.length, 0);
});

test('allowlist matching ignores case', async () => {
  const impl = fakeFetch(() => ok([]));
  await client(impl, ['Your-Org/Your-Repo']).get('/repos/your-org/your-repo/pulls');
  assert.equal(impl.calls.length, 1);
});

test('non-repository endpoints are permitted', async () => {
  const impl = fakeFetch(() => ok({ login: 'someone' }));
  const { data } = await client(impl).get('/user');
  assert.equal(data.login, 'someone');
});

test('rate limiting is retried with backoff, then surfaces', async () => {
  let calls = 0;
  const impl = fakeFetch(() => {
    calls += 1;
    if (calls <= 2) {
      return new Response('rate limited', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1' },
      });
    }
    return ok([{ number: 1 }]);
  });
  const { data } = await client(impl).get('/repos/your-org/your-repo/pulls');
  assert.equal(calls, 3);
  assert.equal(data[0].number, 1);
});

test('a 403 that is not rate limiting fails immediately', async () => {
  let calls = 0;
  const impl = fakeFetch(() => {
    calls += 1;
    return new Response('forbidden', { status: 403, headers: { 'x-ratelimit-remaining': '4999' } });
  });
  await assert.rejects(() => client(impl).get('/repos/your-org/your-repo/pulls'), GitHubError);
  // Retrying a permissions error just wastes the user's quota.
  assert.equal(calls, 1);
});

test('a 404 surfaces with its status', async () => {
  const impl = fakeFetch(() => new Response('not found', { status: 404 }));
  await assert.rejects(
    () => client(impl).get('/repos/your-org/your-repo/pulls/9999'),
    (error) => error instanceof GitHubError && error.status === 404,
  );
});

test('pagination follows Link headers', async () => {
  const impl = fakeFetch((url) => {
    if (url.includes('page=2')) return ok([{ id: 3 }, { id: 4 }]);
    return ok([{ id: 1 }, { id: 2 }], {
      link: '<https://api.github.com/repos/your-org/your-repo/pulls?page=2>; rel="next"',
    });
  });
  const items = await client(impl).paginate('/repos/your-org/your-repo/pulls', 10);
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3, 4]);
});

test('pagination stops at the limit so a large repository cannot run away', async () => {
  const impl = fakeFetch((url) =>
    ok([{ id: 1 }, { id: 2 }], {
      link: `<https://api.github.com/next?after=${url.length}>; rel="next"`,
    }),
  );
  const items = await client(impl).paginate('/repos/your-org/your-repo/pulls', 5);
  assert.equal(items.length, 5);
});

test('bots are recognised by account type and by naming convention', () => {
  assert.ok(isBot('dependabot[bot]'));
  assert.ok(isBot('renovate[bot]'));
  assert.ok(isBot('some-service', 'Bot'));
  assert.ok(isBot('github-actions'));
  assert.ok(!isBot('a-real-person'));
  // "robotics-lead" is a person, not automation.
  assert.ok(!isBot('robotics-lead'));
});

test('the owner is whoever is running the plugin', () => {
  const base = { ownerLogin: 'the-owner' };
  assert.equal(classifyReviewer({ ...base, login: 'the-owner' }), 'owner');
  assert.equal(classifyReviewer({ ...base, login: 'THE-OWNER' }), 'owner');
});

test('collaborators are teammates; drive-by contributors are external', () => {
  const base = { ownerLogin: 'the-owner' };
  assert.equal(classifyReviewer({ ...base, login: 'x', authorAssociation: 'MEMBER' }), 'team');
  assert.equal(classifyReviewer({ ...base, login: 'x', authorAssociation: 'COLLABORATOR' }), 'team');
  assert.equal(classifyReviewer({ ...base, login: 'x', authorAssociation: 'CONTRIBUTOR' }), 'external');
  assert.equal(classifyReviewer({ ...base, login: 'x', authorAssociation: 'NONE' }), 'external');
  assert.equal(classifyReviewer({ ...base, login: 'x' }), 'external');
});

test('a bot is a bot even when it is also a collaborator', () => {
  // Bot output must never become voice-training data, whatever its permissions.
  assert.equal(
    classifyReviewer({ ownerLogin: 'the-owner', login: 'dependabot[bot]', authorAssociation: 'COLLABORATOR' }),
    'bot',
  );
});
