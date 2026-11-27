/**
 * Inside the Action, the review's own job is a check run on the pull request's
 * head and is still running when `verdict` reads CI, so CI was never green and
 * every clean review ended `wait` (#508). The Action passes its own check run's
 * id in REVIEW_VOICE_OWN_CHECK_RUN, and readCi leaves that one run out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { readCi } from '../plugins/review-voice/src/publish/ci.ts';

const REPO = 'acme/web';
const SHA = 'a'.repeat(40);

const OWN = { id: 900, name: 'review', status: 'in_progress', conclusion: null, started_at: '2026-11-27T08:18:20Z' };
const TEST = { id: 901, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-27T08:18:20Z', completed_at: '2026-11-27T08:19:34Z' };

const read = (checkRuns, ownId, t) => {
  const previous = process.env.REVIEW_VOICE_OWN_CHECK_RUN;
  if (ownId === undefined) delete process.env.REVIEW_VOICE_OWN_CHECK_RUN;
  else process.env.REVIEW_VOICE_OWN_CHECK_RUN = ownId;
  t.after(() => {
    if (previous === undefined) delete process.env.REVIEW_VOICE_OWN_CHECK_RUN;
    else process.env.REVIEW_VOICE_OWN_CHECK_RUN = previous;
  });
  const impl = async (url) => {
    const body = String(url).includes('/check-runs')
      ? { total_count: checkRuns.length, check_runs: checkRuns }
      : { state: 'success', total_count: 0, statuses: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });
  return readCi(client, REPO, SHA, [], Date.parse('2026-11-27T08:18:46Z'));
};

test('the Action\'s own running job is left out of CI, so the others decide the state', async (t) => {
  const ci = await read([OWN, TEST], '900', t);
  assert.equal(ci.state, 'green');
  assert.equal(ci.passed, 1);
  assert.deepEqual(ci.pending, []);
});

test('without the variable the running job keeps CI pending, as before', async (t) => {
  const ci = await read([OWN, TEST], undefined, t);
  assert.equal(ci.state, 'pending');
  assert.deepEqual(ci.pending.map((entry) => entry.name), ['review']);
});

test('only the named run is left out: another running check still holds CI, and a failure still fails it', async (t) => {
  const sibling = { id: 902, name: 'build', status: 'in_progress', conclusion: null, started_at: '2026-11-27T08:18:20Z' };
  assert.deepEqual((await read([OWN, TEST, sibling], '900', t)).pending.map((entry) => entry.name), ['build']);
  const broken = { id: 903, name: 'lint', status: 'completed', conclusion: 'failure', started_at: '2026-11-27T08:18:20Z', completed_at: '2026-11-27T08:19:00Z' };
  assert.equal((await read([OWN, TEST, broken], '900', t)).state, 'red');
});

test('a review that is the only check on the head is still not green: nothing else has reported', async (t) => {
  const ci = await read([OWN], '900', t);
  assert.equal(ci.state, 'pending');
  assert.deepEqual(ci.pending.map((entry) => entry.name), ['no checks reported yet']);
});
