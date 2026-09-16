import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';
import { retrievePrecedents, toMatchQuery } from '../plugins/review-voice/src/retrieval/retrieve.ts';
import {
  baseWeight,
  recencyWeight,
  specificityWeight,
  contextWeight,
  eventWeight,
} from '../plugins/review-voice/src/retrieval/weights.ts';

const NOW = new Date('2026-09-16T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

test('owner evidence outweighs teammate evidence', () => {
  assert.ok(baseWeight('owner', 'accepted') > baseWeight('team', 'accepted'));
  assert.equal(baseWeight('bot', 'accepted'), 0);
});

test('an owner comment with unknown outcome still carries real weight', () => {
  // Weaker than a confirmed keep, far from worthless.
  const unknown = baseWeight('owner', 'unknown');
  assert.ok(unknown > 0);
  assert.ok(unknown < baseWeight('owner', 'accepted'));
});

test('dismissals are negative and at least as strong as keeps', () => {
  // Being told not to say something is a clearer instruction than being told
  // a comment was fine.
  assert.ok(baseWeight('owner', 'dismissed') <= -Math.abs(baseWeight('owner', 'accepted')));
});

test('recency halves on the half-life', () => {
  assert.ok(Math.abs(recencyWeight(daysAgo(0), NOW) - 1) < 1e-9);
  assert.ok(Math.abs(recencyWeight(daysAgo(180), NOW) - 0.5) < 1e-6);
  assert.ok(Math.abs(recencyWeight(daysAgo(360), NOW) - 0.25) < 1e-6);
});

test('a comment pinned to an exact line outweighs a general remark', () => {
  const pinned = specificityWeight({ hasFilePath: true, hasLine: true, hasDiffHunk: true });
  const vague = specificityWeight({ hasFilePath: false, hasLine: false, hasDiffHunk: false });
  assert.ok(pinned > vague);
  assert.ok(pinned <= 1);
});

test('same-repository precedent counts for more', () => {
  const near = contextWeight({ sameRepository: true, samePath: true, sameLanguage: true });
  const far = contextWeight({ sameRepository: false, samePath: false, sameLanguage: false });
  assert.ok(near > far);
});

test('the owner multiplier amplifies dismissals as much as keeps', () => {
  const shared = {
    createdAt: daysAgo(0),
    specificity: { hasFilePath: true, hasLine: true, hasDiffHunk: true },
    context: { sameRepository: true, samePath: true, sameLanguage: true },
    now: NOW,
    ownerMultiplier: 3,
  };
  const keep = eventWeight({ ...shared, role: 'owner', outcome: 'accepted' });
  const dismiss = eventWeight({ ...shared, role: 'owner', outcome: 'dismissed' });
  // Amplifying only the positives would make the reviewer progressively louder.
  assert.ok(Math.abs(Math.abs(keep) - Math.abs(dismiss)) < 1e-9);
  assert.ok(dismiss < 0);
});

test('prose is turned into a safe FTS query', () => {
  const query = toMatchQuery('The response returns a token before the transaction commits!');
  // Punctuation is FTS5 syntax; passing prose through would throw on a stray quote.
  assert.ok(!query.includes('!'));
  assert.ok(query.includes('"transaction"'));
  assert.ok(query.includes(' OR '));
  // Stopwords add noise without adding signal.
  assert.ok(!query.includes('"the"'));
});

function withCorpus(events, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-retr-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    storeEvents(db, events);
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const event = (key, body, extra = {}) => ({
  eventId: `gh_${key}`,
  source: 'github',
  repository: extra.repository ?? 'org/a',
  pullNumber: 1,
  pullRequestUrl: 'https://example.com/pull/1',
  commentId: key,
  reviewerLogin: 'someone',
  role: extra.role ?? 'owner',
  createdAt: extra.createdAt ?? daysAgo(10),
  bodyRedacted: body,
  filePath: extra.filePath ?? 'src/auth.ts',
  lineStart: 12,
  contentKey: key,
  redactionVersion: '1',
  redactionCounts: {},
});

test('retrieval finds the relevant precedent and ignores the irrelevant', () => {
  withCorpus(
    [
      event('k1', 'The response is returned before the transaction commits, so a retry mints two tokens.'),
      event('k2', 'The button colour here does not match the design system palette.'),
    ],
    (db) => {
      const found = retrievePrecedents(db, {
        text: 'response emitted before transaction commit allows duplicate tokens on retry',
        maxPositive: 3,
        maxNegative: 2,
        now: NOW,
      });
      assert.ok(found.length >= 1);
      assert.match(found[0].excerpt, /transaction commits/);
    },
  );
});

test('only redacted text reaches a precedent excerpt', () => {
  withCorpus([event('k1', 'The token [REDACTED:GITHUB_TOKEN] is logged in plaintext here.')], (db) => {
    const [found] = retrievePrecedents(db, {
      text: 'token logged in plaintext',
      maxPositive: 3,
      maxNegative: 2,
      now: NOW,
    });
    assert.match(found.excerpt, /\[REDACTED:GITHUB_TOKEN\]/);
  });
});

test('positive and negative precedents are capped separately', () => {
  const events = [
    ...Array.from({ length: 6 }, (_, i) =>
      event(`p${i}`, 'The transaction commits after the response is emitted here.'),
    ),
  ];
  withCorpus(events, (db) => {
    const found = retrievePrecedents(db, {
      text: 'transaction commits after response emitted',
      maxPositive: 3,
      maxNegative: 2,
      now: NOW,
    });
    assert.ok(found.filter((p) => p.polarity === 'positive').length <= 3);
  });
});

test('an unmatchable query returns nothing rather than failing the review', () => {
  withCorpus([event('k1', 'Something entirely unrelated to the query.')], (db) => {
    assert.deepEqual(
      retrievePrecedents(db, { text: '!!! ??? ***', maxPositive: 3, maxNegative: 2, now: NOW }),
      [],
    );
  });
});

test('the index follows deletions, so purged events stop being retrievable', () => {
  withCorpus([event('k1', 'The transaction commits after the response is emitted.')], (db) => {
    const query = { text: 'transaction commits response emitted', maxPositive: 3, maxNegative: 2, now: NOW };
    assert.ok(retrievePrecedents(db, query).length >= 1);
    db.prepare('DELETE FROM review_events').run();
    // A purge that left the index behind would keep surfacing deleted evidence.
    assert.deepEqual(retrievePrecedents(db, query), []);
  });
});

test('recent evidence outranks older evidence of the same kind', () => {
  withCorpus(
    [
      event('old', 'The transaction commits after the response is emitted here.', { createdAt: daysAgo(700) }),
      event('new', 'The transaction commits after the response is emitted here too.', { createdAt: daysAgo(2) }),
    ],
    (db) => {
      const found = retrievePrecedents(db, {
        text: 'transaction commits after response emitted',
        maxPositive: 3,
        maxNegative: 2,
        now: NOW,
      });
      assert.ok(found[0].weight > 0);
      assert.equal(found[0].eventId, 'gh_new');
    },
  );
});
