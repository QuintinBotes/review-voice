import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { collectRepository } from '../plugins/review-voice/src/corpus/collect.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';
import { loadWatermarks, saveWatermarks } from '../plugins/review-voice/src/sync/watermark.ts';

const PULLS = [
  { number: 1, html_url: 'https://example.com/1', updated_at: '2026-09-01T00:00:00Z' },
  { number: 2, html_url: 'https://example.com/2', updated_at: '2026-09-02T00:00:00Z' },
];

const COMMENTS = {
  1: [
    {
      id: 11,
      body: 'This returns before the transaction commits, so a retry mints two tokens.',
      user: { login: 'the-owner', type: 'User' },
      created_at: '2026-09-01T00:00:00Z',
      path: 'src/a.ts',
      line: 4,
      diff_hunk: '@@ -1 +1 @@',
      author_association: 'OWNER',
    },
  ],
  2: [
    {
      id: 22,
      body: 'The retry backoff is unbounded, which will hammer the downstream service.',
      user: { login: 'a-teammate', type: 'User' },
      created_at: '2026-09-02T00:00:00Z',
      path: 'src/b.ts',
      line: 9,
      diff_hunk: '@@ -1 +1 @@',
      author_association: 'MEMBER',
    },
  ],
};

/** Counts requests, so a test can prove work was or was not repeated. */
function transport() {
  const calls = [];
  const impl = async (url) => {
    const href = String(url);
    calls.push(href);
    const body = (data) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (/\/pulls\?/.test(href)) return body(PULLS);
    const match = /\/pulls\/(\d+)\/comments/.exec(href);
    if (match) return body(COMMENTS[Number(match[1])] ?? []);
    return body([]);
  };
  impl.calls = calls;
  return impl;
}

function freshStats() {
  return {
    pullRequestsScanned: 0,
    pullRequestsUnchanged: 0,
    commentsSeen: 0,
    bySource: { inline: 0, reviewSummary: 0, conversation: 0 },
    eligible: 0,
    duplicates: 0,
    excluded: {},
  };
}

/** Async: a synchronous finally would close the database mid-await. */
async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-sync-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const collect = (fetchImpl, stats, watermarks) =>
  collectRepository(
    new GitHubClient({ allowlist: ['org/a'], token: 't', fetchImpl, sleep: async () => {} }),
    {
      repository: 'org/a',
      ownerLogin: 'the-owner',
      maxPullRequests: 50,
      maxCommentsPerPull: 50,
      includeForks: false,
      includeConversationComments: false,
      watermarks,
    },
    stats,
  );

test('a dry run does not starve the sync that follows it', async () => {
  await withDb(async (db) => {
    // The bug this replaces: a dry run populated an ETag cache without storing
    // anything, so the real sync received 304s and imported almost nothing.
    // It projected 250 events and stored 6.
    const dryStats = freshStats();
    const dry = await collect(transport(), dryStats, undefined);
    assert.equal(dry.events.length, 2);

    // A dry run persists no state at all — not watermarks, not events.
    assert.equal(loadWatermarks(db, 'org/a').size, 0);

    const realStats = freshStats();
    const real = await collect(transport(), realStats, loadWatermarks(db, 'org/a'));
    assert.equal(real.events.length, 2, 'the real sync must see everything the dry run projected');
    assert.equal(storeEvents(db, real.events).inserted, 2);
  });
});

test('watermarks are recorded only for pull requests actually read', async () => {
  await withDb(async (db) => {
    const { events, watermarks } = await collect(transport(), freshStats(), undefined);
    assert.deepEqual(
      watermarks.map((w) => w.pullNumber).sort(),
      [1, 2],
    );
    storeEvents(db, events);
    saveWatermarks(
      db,
      watermarks.map((w) => ({ repository: 'org/a', ...w })),
    );
    assert.equal(loadWatermarks(db, 'org/a').size, 2);
  });
});

test('a second sync skips unchanged pull requests without losing them', async () => {
  await withDb(async (db) => {
    const first = await collect(transport(), freshStats(), undefined);
    storeEvents(db, first.events);
    saveWatermarks(db, first.watermarks.map((w) => ({ repository: 'org/a', ...w })));

    const secondStats = freshStats();
    const impl = transport();
    const second = await collect(impl, secondStats, loadWatermarks(db, 'org/a'));

    assert.equal(secondStats.pullRequestsUnchanged, 2);
    assert.equal(second.events.length, 0, 'nothing new to collect');
    // The corpus keeps what it already had; skipping is not forgetting.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM review_events').get().n,
      2,
    );
    // And it did not re-fetch the comments for unchanged pull requests.
    assert.ok(!impl.calls.some((call) => /\/comments/.test(call)));
  });
});

test('a changed pull request is re-read', async () => {
  await withDb(async (db) => {
    const first = await collect(transport(), freshStats(), undefined);
    storeEvents(db, first.events);
    saveWatermarks(db, first.watermarks.map((w) => ({ repository: 'org/a', ...w })));

    // PR 2 was touched since.
    const marks = loadWatermarks(db, 'org/a');
    marks.set(2, '2026-01-01T00:00:00Z');

    const stats = freshStats();
    const again = await collect(transport(), stats, marks);
    assert.equal(stats.pullRequestsUnchanged, 1);
    assert.equal(stats.pullRequestsScanned, 1);
    assert.equal(again.watermarks.length, 1);
    assert.equal(again.watermarks[0].pullNumber, 2);
  });
});

test('pagination is not truncated by an unchanged page', async () => {
  // The old conditional-request path returned an empty page with no Link
  // header on a 304, stopping the walk at whichever page happened to be
  // unchanged. Requests are unconditional now, so a full walk is a full walk.
  const impl = async (url) => {
    const href = String(url);
    const headers = { 'content-type': 'application/json' };
    if (/page=2/.test(href)) return new Response(JSON.stringify([{ number: 3, html_url: 'x', updated_at: 'z' }]), { status: 200, headers });
    if (/\/pulls\?/.test(href)) {
      return new Response(JSON.stringify(PULLS), {
        status: 200,
        headers: { ...headers, link: '<https://api.github.com/x?page=2>; rel="next"' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers });
  };
  const client = new GitHubClient({ allowlist: ['org/a'], token: 't', fetchImpl: impl, sleep: async () => {} });
  const items = await client.paginate('/repos/org/a/pulls?per_page=100', 100);
  assert.equal(items.length, 3);
});

test('the client never sends a conditional request header', async () => {
  const seen = [];
  const impl = async (url, init) => {
    seen.push(init?.headers ?? {});
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new GitHubClient({ allowlist: ['org/a'], token: 't', fetchImpl: impl, sleep: async () => {} });
  await client.get('/repos/org/a/pulls');
  await client.get('/repos/org/a/pulls');
  for (const headers of seen) {
    assert.equal(headers['if-none-match'], undefined, 'a 304 would be a lie: no response body is ever kept');
  }
});
