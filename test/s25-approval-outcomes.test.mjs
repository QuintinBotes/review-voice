/**
 * S25 (docs/adr/0034): each APPROVE Review Voice sent is followed to an outcome
 * from what a fake GitHub shows. AC-1 (every row of the table, and an
 * unreadable pull request leaves its stored row alone), AC-2 (pending inside
 * the window, survived past it) and AC-4 (GET inside the allowlist only, a run
 * for another repository skipped without a request).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { approvedRuns, sentRuns } from '../plugins/review-voice/src/store/outcomes.ts';
import { checkApprovals, storedApprovalOutcomes } from '../plugins/review-voice/src/store/approvals.ts';

const REPO = 'acme/web';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const SINCE = '2000-01-01T00:00:00.000Z';
const ME = 'review-bot-user';
const MERGED_AT = '2026-10-01T12:00:00Z';
/** Nine days after the merge: inside a 14 day window. */
const INSIDE = () => new Date('2026-10-10T12:00:00Z');
/** Twenty days after the merge: past it. */
const PAST = () => new Date('2026-10-21T12:00:00Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const approval = (number) => ({ id: 500 + number, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-09-30T10:00:00Z', user: { login: ME } });
const requested = (login, extra = {}) => ({ id: 900, state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-09-30T12:00:00Z', user: { login }, ...extra });
const merged = (head = HEAD) => ({ state: 'closed', merged: true, merged_at: MERGED_AT, head: { sha: head } });

/**
 * GitHub for the approval check. `pulls`, `reviews` and `commits` are keyed by
 * pull number; `reverts` lists the search hits for the revert query, each a
 * pull in `pulls` whose body is read back, and `incomplete` marks that search
 * unfinished. `failing` pulls answer 500.
 */
function fakeGitHub({ pulls = {}, reviews = {}, commits = {}, reverts = [], incomplete = false, failing = [] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname, q: parsed.searchParams.get('q') });
    const path = parsed.pathname;
    if (path === '/search/issues') {
      const items = reverts.map((number) => ({ number, repository_url: `https://api.github.com/repos/${REPO}`, pull_request: {} }));
      return json({ total_count: items.length, incomplete_results: incomplete, items });
    }
    const pull = /^\/repos\/acme\/web\/pulls\/(\d+)(\/reviews|\/commits)?$/.exec(path);
    if (pull === null) return new Response('not found', { status: 404 });
    const number = Number(pull[1]);
    if (failing.includes(number)) return new Response('boom', { status: 500 });
    if (pull[2] === '/reviews') return json([approval(number), ...(reviews[number] ?? [])]);
    if (pull[2] === '/commits') return json((commits[number] ?? [HEAD]).map((sha) => ({ sha })));
    return pulls[number] === undefined ? new Response('not found', { status: 404 }) : json(pulls[number]);
  };
  impl.calls = calls;
  return impl;
}

const client = (impl, allowlist = [REPO]) => new GitHubClient({ allowlist, token: 't', fetchImpl: impl, sleep: async () => {} });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-approvals-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** Records a run for pull `number` and a sent review of `event` for it. */
function sentRun(db, number, { event = 'APPROVE', repository = REPO, head = HEAD, reviewId = 500 + number } = {}) {
  const { reviewRunId } = recordRun(db, { repository, baseRef: null, headRef: head, pullNumber: number, diff: 'd', output: 'No actionable findings.' });
  const subject = { type: 'pull_request', id: `${repository.toLowerCase()}#${number}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head, event, reviewId });
  return reviewRunId;
}

const check = (db, impl, extra = {}) => checkApprovals({ db, client: client(impl), since: SINCE, now: INSIDE, ...extra });
const byPull = (result) => Object.fromEntries(result.outcomes.map((o) => [o.pullNumber, o]));

test('approvedRuns lists the APPROVE sends with head, review id and sent time, and sentRuns is unchanged', async () => {
  await withDb(async (db) => {
    const approved = sentRun(db, 1);
    sentRun(db, 2, { event: 'COMMENT' });
    sentRun(db, 3, { event: 'REQUEST_CHANGES' });
    const runs = approvedRuns(db, { since: SINCE });
    assert.deepEqual(
      runs.map((run) => ({ runId: run.runId, pull: run.pullNumber, head: run.head, reviewId: run.reviewId })),
      [{ runId: approved, pull: 1, head: HEAD, reviewId: 501 }],
    );
    assert.match(runs[0].sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(approvedRuns(db, { since: SINCE, repository: 'other/repo' }).length, 0);
    assert.equal(approvedRuns(db, { since: '2999-01-01T00:00:00.000Z' }).length, 0);
    // The finding follower still sees every send, whatever its event.
    assert.equal(sentRuns(db, { since: SINCE }).length, 3);
  });
});

test('each outcome of the table is produced from the state that defines it', async () => {
  await withDb(async (db) => {
    for (const number of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 29]) sentRun(db, number);
    const impl = fakeGitHub({
      pulls: {
        // Merged, but GitHub shows no head: unreadable, never "at the approved head".
        10: { state: 'closed', merged: true, merged_at: MERGED_AT },
        11: merged(),
        12: merged(),
        13: merged(),
        14: merged(OTHER_HEAD),
        15: merged(),
        16: { state: 'closed', merged: false, head: { sha: HEAD } },
        17: { state: 'open', merged: false, head: { sha: HEAD } },
        18: { state: 'open', head: { sha: HEAD } },
        // A request for changes on the approved head counts whatever the merge: 19 merged at another head, 20 not merged.
        19: merged(OTHER_HEAD),
        20: { state: 'open', merged: false, head: { sha: HEAD } },
        // Merged, but GitHub shows no merge time: there is no window to have passed, so never pending or survived.
        29: { state: 'closed', merged: true, merged_at: null, head: { sha: HEAD } },
        // The revert candidates: 70 names another pull request, 71 is a draft never merged, 72 reverts #11.
        70: { state: 'closed', merged: true, merged_at: '2026-10-03T00:00:00Z', body: 'Reverts acme/web#110', head: { sha: 'c'.repeat(40) } },
        71: { state: 'open', merged: false, merged_at: null, body: 'Reverts acme/web#11', head: { sha: 'd'.repeat(40) } },
        72: { state: 'closed', merged: true, merged_at: '2026-10-03T00:00:00Z', body: 'Reverts acme/web#11\n\nIt broke the checkout.', head: { sha: 'e'.repeat(40) } },
      },
      reviews: { 12: [requested('carol')], 19: [requested('carol')], 20: [requested('carol')] },
      // No commits for 19: the request for changes is answered before they would be read.
      commits: { 14: [HEAD, 'f'.repeat(40), OTHER_HEAD] },
      reverts: [70, 71, 72],
    });
    // The search answers the same hits for every pull request; only the body read decides.
    const result = await check(db, impl, { now: PAST });
    const outcomes = byPull(result);
    const reverted = outcomes[11];
    // Only pull 11 is named by a revert hit's body, so the other merged pulls at the approved head survive.
    assert.deepEqual(
      Object.fromEntries(Object.entries(outcomes).map(([pull, o]) => [pull, `${o.outcome} ${o.strength}`])),
      {
        10: 'unknown weak',
        11: 'reverted strong',
        12: 'changes_requested strong',
        13: 'survived strong',
        14: 'merged_other_head weak',
        15: 'survived strong',
        16: 'closed weak',
        17: 'open weak',
        18: 'unknown weak',
        19: 'changes_requested strong',
        20: 'changes_requested strong',
        29: 'unknown weak',
      },
    );
    assert.equal(reverted.evidence.revertPull, 72);
    assert.equal(outcomes[10].evidence.currentHead, null);
    assert.equal(outcomes[12].evidence.changesRequestedBy, 'carol');
    assert.equal(outcomes[14].evidence.commitsAfterHead, 2);
    assert.match(outcomes[14].evidence.summary, /2 commit\(s\) after the approved head/);
    assert.equal(result.warnings.length, 0);
    // Stored, one row per run, readable back with its evidence.
    const stored = storedApprovalOutcomes(db);
    assert.equal(stored.length, 12);
    assert.equal(stored.find((row) => row.pullNumber === 11).evidence.revertPull, 72);
  });
});

test('a bot, the poster, another head or a request before the approval does not request changes', async () => {
  await withDb(async (db) => {
    for (const number of [21, 22, 23, 24]) sentRun(db, number);
    const impl = fakeGitHub({
      pulls: { 21: merged(), 22: merged(), 23: merged(), 24: merged() },
      reviews: {
        21: [requested('ci[bot]')],
        22: [requested(ME)],
        23: [requested('carol', { commit_id: OTHER_HEAD })],
        24: [requested('carol', { submitted_at: '2026-09-01T00:00:00Z' })],
      },
    });
    const outcomes = byPull(await check(db, impl, { now: PAST }));
    assert.deepEqual(Object.values(outcomes).map((o) => o.outcome), ['survived', 'survived', 'survived', 'survived']);
  });
});

test('a request for changes with no user is no person, and the approval is still followed', async () => {
  await withDb(async (db) => {
    // GitHub shows a deleted account's review with a null user; 26 is open, so the not-merged path reads it too.
    for (const number of [25, 26]) sentRun(db, number);
    const impl = fakeGitHub({
      pulls: { 25: merged(), 26: { state: 'open', merged: false, head: { sha: HEAD } } },
      reviews: { 25: [requested('x', { user: null })], 26: [requested('x', { user: { type: 'User' } })] },
    });
    const result = await check(db, impl, { now: PAST });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.outcomes.map((o) => [o.pullNumber, o.outcome, o.strength]), [[25, 'survived', 'strong'], [26, 'open', 'weak']]);
    assert.equal(storedApprovalOutcomes(db).length, 2);
  });
});

test('a merge inside the window is pending and the same state past the window is survived', async () => {
  await withDb(async (db) => {
    sentRun(db, 31);
    const impl = fakeGitHub({ pulls: { 31: merged() } });
    const inside = byPull(await check(db, impl, { now: INSIDE }))[31];
    assert.equal(inside.outcome, 'pending');
    assert.equal(inside.strength, 'weak');
    assert.equal(inside.evidence.windowEndsAt, '2026-10-15T12:00:00.000Z');
    const past = byPull(await check(db, impl, { now: PAST }))[31];
    assert.equal(past.outcome, 'survived');
    assert.equal(past.strength, 'strong');
    // A shorter window settles sooner.
    const short = byPull(await check(db, impl, { now: INSIDE, windowDays: 7 }))[31];
    assert.equal(short.outcome, 'survived');
    // One row per run, the newest check standing.
    assert.equal(storedApprovalOutcomes(db).length, 1);
    assert.equal(storedApprovalOutcomes(db)[0].outcome, 'survived');
  });
});

test('a revert merged after the window does not count, and one inside it counts whichever head merged', async () => {
  await withDb(async (db) => {
    sentRun(db, 41);
    sentRun(db, 42);
    sentRun(db, 43);
    const impl = fakeGitHub({
      pulls: {
        41: merged(),
        42: merged(OTHER_HEAD),
        43: merged(OTHER_HEAD),
        73: { state: 'closed', merged: true, merged_at: '2026-11-01T00:00:00Z', body: 'Reverts acme/web#41', head: { sha: 'c'.repeat(40) } },
        75: { state: 'closed', merged: true, merged_at: '2026-10-05T00:00:00Z', body: 'Reverts acme/web#42', head: { sha: 'd'.repeat(40) } },
      },
      reverts: [73, 75],
    });
    const outcomes = byPull(await check(db, impl, { now: PAST }));
    assert.equal(outcomes[41].outcome, 'survived');
    // The table puts `reverted` above `merged_other_head` and names no head for it.
    assert.deepEqual([outcomes[42].outcome, outcomes[42].strength, outcomes[42].evidence.revertPull], ['reverted', 'strong', 75]);
    assert.equal(outcomes[43].outcome, 'merged_other_head');
    // One search per merged pull request.
    assert.deepEqual(
      impl.calls.filter((call) => call.path === '/search/issues').map((call) => call.q),
      [41, 42, 43].map((n) => `is:pr is:merged repo:acme/web "Reverts acme/web#${n}" in:body`),
    );
  });
});

test('two approvals of one merged pull request share one revert search', async () => {
  await withDb(async (db) => {
    // Approved at two heads, as after a push; it merged at the second and was reverted.
    sentRun(db, 46);
    sentRun(db, 46, { head: OTHER_HEAD, reviewId: 600 });
    const impl = fakeGitHub({
      pulls: { 46: merged(OTHER_HEAD), 78: { state: 'closed', merged: true, merged_at: '2026-10-05T00:00:00Z', body: 'Reverts acme/web#46', head: { sha: 'c'.repeat(40) } } },
      reverts: [78],
    });
    const result = await check(db, impl, { now: PAST });
    assert.deepEqual(result.outcomes.map((o) => [o.head, o.outcome]), [[HEAD, 'reverted'], [OTHER_HEAD, 'reverted']]);
    assert.equal(impl.calls.filter((call) => call.path === '/search/issues').length, 1);
    assert.equal(impl.calls.filter((call) => call.path === '/repos/acme/web/pulls/78').length, 1);
  });
});

test('a revert search GitHub did not finish settles nothing, and a revert it did confirm still counts', async () => {
  await withDb(async (db) => {
    sentRun(db, 47);
    sentRun(db, 48);
    await check(db, fakeGitHub({ pulls: { 47: merged(), 48: merged() } }));
    const before = storedApprovalOutcomes(db).find((row) => row.pullNumber === 47);
    assert.equal(before.outcome, 'pending');
    // Past the window, but the search timed out: no revert was found, which is not the same as none existing.
    const impl = fakeGitHub({
      pulls: { 47: merged(), 48: merged(), 79: { state: 'closed', merged: true, merged_at: '2026-10-05T00:00:00Z', body: 'Reverts acme/web#48', head: { sha: 'c'.repeat(40) } } },
      reverts: [79],
      incomplete: true,
    });
    const result = await check(db, impl, { now: PAST });
    assert.deepEqual(result.outcomes.map((o) => [o.pullNumber, o.outcome]), [[48, 'reverted']]);
    assert.deepEqual(result.warnings, ['acme/web#47: approval not checked (the revert search was incomplete)']);
    assert.deepEqual(storedApprovalOutcomes(db).find((row) => row.pullNumber === 47), before);
  });
});

test('a merge at another head or a close is read again until its window has passed, so a later revert or merge still counts', async () => {
  await withDb(async (db) => {
    for (const number of [91, 92, 93, 94]) sentRun(db, number);
    const EARLY = '2026-09-20T00:00:00Z';
    const closed = (at) => ({ state: 'closed', merged: false, closed_at: at, head: { sha: HEAD } });
    // 91 and 93 inside their windows at INSIDE; 92 and 94 merged or closed early enough that theirs have passed.
    const first = byPull(
      await check(db, fakeGitHub({ pulls: { 91: merged(OTHER_HEAD), 92: { ...merged(OTHER_HEAD), merged_at: EARLY }, 93: closed(MERGED_AT), 94: closed(EARLY) } })),
    );
    assert.deepEqual([91, 92, 93, 94].map((number) => first[number].outcome), ['merged_other_head', 'merged_other_head', 'closed', 'closed']);
    assert.equal(first[91].evidence.windowEndsAt, '2026-10-15T12:00:00.000Z');
    assert.equal(first[93].evidence.windowEndsAt, '2026-10-15T12:00:00.000Z');

    // Every approval is now before `since`, as for watch a week on. 91 is
    // reverted inside its window, and 93 is reopened and merged.
    const later = fakeGitHub({
      pulls: {
        91: merged(OTHER_HEAD),
        93: { ...merged(), merged_at: '2026-10-11T00:00:00Z' },
        76: { state: 'closed', merged: true, merged_at: '2026-10-11T00:00:00Z', body: 'Reverts acme/web#91', head: { sha: 'c'.repeat(40) } },
      },
      reverts: [76],
    });
    const result = await check(db, later, { now: () => new Date('2026-10-12T00:00:00Z'), since: '2999-01-01T00:00:00.000Z' });
    assert.deepEqual(
      result.outcomes.map((o) => [o.pullNumber, o.outcome, o.strength]),
      [[91, 'reverted', 'strong'], [93, 'pending', 'weak']],
    );
    assert.deepEqual(result.warnings, []);
    // Past their windows, 92 and 94 are settled and not read again.
    assert.ok(!later.calls.some((call) => /\/pulls\/9[24](\/|$)/.test(call.path)), 'a settled row was read again');
  });
});

test('a pull request that cannot be read leaves its stored row unchanged', async () => {
  await withDb(async (db) => {
    sentRun(db, 51);
    const first = await check(db, fakeGitHub({ pulls: { 51: merged() } }));
    assert.equal(byPull(first)[51].outcome, 'pending');
    const before = storedApprovalOutcomes(db);

    const second = await check(db, fakeGitHub({ pulls: { 51: merged() }, failing: [51] }), { now: PAST });
    assert.equal(second.outcomes.length, 0);
    assert.equal(second.warnings.length, 1);
    assert.match(second.warnings[0], /^acme\/web#51: approval not checked \(/);
    assert.deepEqual(storedApprovalOutcomes(db), before);
  });
});

test('an unsettled row is checked again however old its approval; a settled one is not', async () => {
  await withDb(async (db) => {
    for (const number of [61, 62, 63, 64]) sentRun(db, number);
    // 63 is still open and 64 shows no merge flag: stored unsettled beside the two pending merges.
    const impl = fakeGitHub({ pulls: { 61: merged(), 62: merged(), 63: { state: 'open', merged: false, head: { sha: HEAD } }, 64: { state: 'open', head: { sha: HEAD } } } });
    const first = byPull(await check(db, impl, { now: INSIDE }));
    assert.deepEqual([61, 62, 63, 64].map((number) => first[number].outcome), ['pending', 'pending', 'open', 'unknown']);
    // Pulls 61 and 62 settle; then every approval falls before `since`.
    assert.equal(byPull(await check(db, impl, { now: PAST, repository: REPO }))[62].outcome, 'survived');
    db.prepare(`UPDATE approval_outcomes SET outcome = 'pending', strength = 'weak' WHERE pull_number = 61`).run();
    // By now 63 and 64 have merged too; the settled 62 is not read again.
    const laterImpl = fakeGitHub({ pulls: { 61: merged(), 63: merged(), 64: merged() } });
    const later = await check(db, laterImpl, { now: PAST, since: '2999-01-01T00:00:00.000Z' });
    assert.deepEqual(
      later.outcomes.map((o) => [o.pullNumber, o.outcome]).sort((a, b) => a[0] - b[0]),
      [[61, 'survived'], [63, 'survived'], [64, 'survived']],
    );
    assert.deepEqual(later.warnings, []);
    assert.ok(!laterImpl.calls.some((call) => call.path.startsWith('/repos/acme/web/pulls/62')), 'the settled 62 was read again');
  });
});

test('an approval with no row is followed however old, and a settled one is read again only at or after since', async () => {
  await withDb(async (db) => {
    for (const number of [65, 66]) sentRun(db, number);
    const FUTURE = '2999-01-01T00:00:00.000Z';
    // Both sends are before `since`, as for a pull request past the twenty watch reads, and neither has a row yet.
    const first = await check(db, fakeGitHub({ pulls: { 65: merged(), 66: merged() } }), { now: PAST, since: FUTURE });
    assert.deepEqual(first.outcomes.map((o) => [o.pullNumber, o.outcome]), [[65, 'survived'], [66, 'survived']]);
    // Settled and before `since`: not read.
    const quiet = fakeGitHub({ pulls: { 65: merged(), 66: merged() } });
    assert.deepEqual((await check(db, quiet, { now: PAST, since: FUTURE })).outcomes, []);
    assert.deepEqual(quiet.calls, []);
    // Settled and at or after `since`: read again.
    const again = fakeGitHub({ pulls: { 65: merged(), 66: merged() } });
    assert.equal((await check(db, again, { now: PAST, since: SINCE })).outcomes.length, 2);
    assert.ok(again.calls.some((call) => call.path === '/repos/acme/web/pulls/65'));
  });
});

test('purge --all removes approval outcomes along with the runs they belong to', async () => {
  const { executePurge } = await import('../plugins/review-voice/src/consent/purge.ts');
  await withDb(async (db) => {
    sentRun(db, 81);
    await check(db, fakeGitHub({ pulls: { 81: merged() } }));
    assert.equal(storedApprovalOutcomes(db).length, 1);
    executePurge(db, { all: true });
    assert.equal(storedApprovalOutcomes(db).length, 0);
  });
});

test('every request is a GET to a repository in the allowlist, and a run for another repository is skipped without one', async () => {
  await withDb(async (db) => {
    sentRun(db, 71);
    sentRun(db, 5, { repository: 'other/repo' });
    const impl = fakeGitHub({
      pulls: { 71: merged(), 74: { state: 'closed', merged: true, merged_at: '2026-10-02T00:00:00Z', body: 'Reverts acme/web#71', head: { sha: 'c'.repeat(40) } } },
      reverts: [74],
    });
    const result = await check(db, impl, { now: PAST });
    assert.deepEqual(result.skipped, [{ repository: 'other/repo', pullNumber: 5, reason: 'not in the allowlist' }]);
    assert.equal(byPull(result)[71].outcome, 'reverted');
    assert.ok(impl.calls.length >= 4, 'the pull, its reviews, the search and the revert were read');
    for (const call of impl.calls) {
      assert.equal(call.method, 'GET', `${call.path} was not a GET`);
      assert.ok(call.path.startsWith('/repos/acme/web/') || (call.path === '/search/issues' && call.q.includes('repo:acme/web')), `${call.path} is outside the allowlist`);
    }
    assert.ok(!impl.calls.some((call) => call.path.includes('other/repo')));
  });
});
