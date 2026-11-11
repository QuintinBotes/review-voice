/**
 * S25 (docs/adr/0036, amending 0026): the client builds the revert search
 * itself from a typed `reverts:<owner>/<repo>#<n>` source, for merged pull
 * requests only, and refuses one that is malformed or names a repository
 * outside the allowlist before any request is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, NotAllowlisted } from '../plugins/review-voice/src/github/client.ts';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function client(allowlist = ['acme/web']) {
  const queries = [];
  const impl = async (url) => {
    queries.push(new URL(String(url)).searchParams.get('q'));
    return json({ total_count: 1, incomplete_results: false, items: [{ number: 72, repository_url: 'https://api.github.com/repos/acme/web' }] });
  };
  return { gh: new GitHubClient({ allowlist, token: 't', fetchImpl: impl, sleep: async () => {} }), queries };
}

test('the revert source searches merged pull requests of one allowlisted repository for the body GitHub writes', async () => {
  const { gh, queries } = client();
  const found = await gh.searchPullRequests('reverts:acme/web#41');
  assert.deepEqual(queries, ['is:pr is:merged repo:acme/web "Reverts acme/web#41" in:body']);
  assert.deepEqual(found.pullRequests, [{ repository: 'acme/web', number: 72 }]);
});

test('a revert source outside the allowlist or malformed is refused before any request', async () => {
  const { gh, queries } = client();
  for (const source of ['reverts:other/repo#41', 'reverts:acme/web#0', 'reverts:acme/web#x', 'reverts:acme/web', 'reverts:acme/web/extra#1', 'reverts:acme/web#1 is:open']) {
    await assert.rejects(gh.searchPullRequests(source), NotAllowlisted, source);
  }
  assert.deepEqual(queries, []);
});

test('the revert source takes an allowlisted repository whose name starts with a dot, and never a dot segment', async () => {
  // An organisation's `.github` repository is a real GitHub name; `.` and `..` are path segments, not names.
  const { gh, queries } = client(['acme/.github', 'acme/.', 'acme/..']);
  await gh.searchPullRequests('reverts:acme/.github#3');
  assert.deepEqual(queries, ['is:pr is:merged repo:acme/.github "Reverts acme/.github#3" in:body']);
  for (const source of ['reverts:acme/.#3', 'reverts:acme/..#3']) {
    await assert.rejects(gh.searchPullRequests(source), NotAllowlisted, source);
  }
  assert.equal(queries.length, 1);
});
