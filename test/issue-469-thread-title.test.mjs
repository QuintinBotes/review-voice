/** #469: thread.json carries the pull request title, redacted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const threadFor = (pull) => {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    return json(path === '/repos/acme/web/pulls/7' ? pull : []);
  };
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 't', fetchImpl });
  return readThread({ repository: 'acme/web', pullNumber: 7, client });
};

test('readThread writes the pull request title at the top level', async () => {
  const thread = await threadFor({ title: 'Add notes routes', body: 'Body.', user: { login: 'a' } });
  assert.equal(thread.title, 'Add notes routes');
});

test('a pull request answer without a title leaves the key out', async () => {
  const thread = await threadFor({ body: 'Body.', user: { login: 'a' } });
  assert.equal('title' in thread, false);
});
