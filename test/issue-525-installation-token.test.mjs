/**
 * The Action's github.token is a GitHub App installation token, and GET /user
 * refuses one with 403, so the thread re-check before posting failed every post
 * after the review was paid for (#525). In Actions the token acts as
 * github-actions[bot]; anywhere else a refusal still reaches the caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError } from '../plugins/review-voice/src/github/client.ts';
import { tokenLogin } from '../plugins/review-voice/src/github/identity.ts';

const REPO = 'acme/api';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });
const refused = async () => json({ message: 'Resource not accessible by integration' }, 403);

async function withActions(value, body) {
  const saved = process.env.GITHUB_ACTIONS;
  if (value === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = saved;
  }
}

test('#525: a user token answers with its own login, in Actions or not', async () => {
  const gh = client(async () => json({ login: 'a-person' }));
  assert.equal(await withActions('true', () => tokenLogin(gh)), 'a-person');
  assert.equal(await withActions(undefined, () => tokenLogin(gh)), 'a-person');
});

test('#525: in Actions, an installation token refused by /user acts as github-actions[bot]', async () => {
  assert.equal(await withActions('true', () => tokenLogin(client(refused))), 'github-actions[bot]');
});

test('#525: outside Actions the refusal reaches the caller, and a refusal that is not a 403 does too', async () => {
  await assert.rejects(() => withActions(undefined, () => tokenLogin(client(refused))), (error) => error instanceof GitHubError && error.status === 403);
  const down = client(async () => json({ message: 'Bad credentials' }, 401));
  await assert.rejects(() => withActions('true', () => tokenLogin(down)), (error) => error instanceof GitHubError && error.status === 401);
});

test('#525: a reply with no login is no answer', async () => {
  assert.equal(await tokenLogin(client(async () => json({}))), undefined);
});
