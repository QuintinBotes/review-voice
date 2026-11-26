/**
 * Outcomes become precedent (#480, docs/adr/0039): a strong dismissal or fix
 * of the tool's own posted finding is derived at retrieval time, with role,
 * scope, exclude-pull, provenance and status visibility.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';
import { saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { retrievePrecedents, learnedPrecedentStats, isEchoOnlyFix, outcomeRole } from '../plugins/review-voice/src/retrieval/retrieve.ts';
import { baseWeight } from '../plugins/review-voice/src/retrieval/weights.ts';
import { scoreCandidate, NEUTRAL_ALIGNMENT } from '../plugins/review-voice/src/scoring/score.ts';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';

const REPO = 'acme/web';
const OWNER = 'ownerlogin';
const NOW = new Date('2026-11-25T00:00:00Z');
const CHECKED = '2026-11-20T00:00:00.000Z';
const FINDING_TEXT = 'The exported helper is unused and the unused export should be removed.';
const SIMILAR_TEXT = 'The exported helper is unused and this unused export adds dead code. Dead exports mislead readers about the public surface.';
const UNRELATED_TEXT = 'The database transaction returns the token before it commits. A retry can mint duplicate tokens.';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-480-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  const done = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  try {
    const result = fn(db, dir);
    if (result && typeof result.then === 'function') return result.finally(done);
    done();
    return result;
  } catch (error) {
    done();
    throw error;
  }
}

/** Records one finding and stores one outcome for it. Direct insert so decided_by is exactly as given. */
function seedOutcome(db, over = {}) {
  const repository = over.repository ?? REPO;
  const pullNumber = over.pullNumber ?? 7;
  const path = over.path ?? 'src/exports.ts';
  const line = over.line ?? 12;
  const category = over.category ?? 'maintainability';
  const output = `[minor] \`${path}:${line}\` - ${over.text ?? FINDING_TEXT}`;
  const { reviewRunId } = recordRun(db, {
    repository, baseRef: null, headRef: 'a'.repeat(40), pullNumber, diff: 'd', output,
    candidates: [{ path, line, category }],
  });
  const outcome = over.outcome ?? 'dismissed';
  const strength = over.strength ?? 'strong';
  const evidence = over.evidence ?? `${over.decidedBy ?? OWNER} replied turning it down with reasons about the public surface`;
  db.prepare(
    `INSERT INTO finding_outcomes
       (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at, decided_by)
     VALUES (?, 'rv_01', ?, ?, 101, ?, ?, ?, ?, ?)`,
  ).run(reviewRunId, repository, pullNumber, outcome, strength, evidence, over.checkedAt ?? CHECKED, over.decidedBy === undefined ? OWNER : over.decidedBy);
  return reviewRunId;
}

const candidate = (over = {}) => ({
  candidateId: 'cand_001',
  path: 'src/other.ts',
  line: 40,
  category: 'maintainability',
  severity: 'minor',
  claim: 'The exported helper is unused and this unused export adds dead code.',
  failureMode: 'Dead exports mislead readers about the public surface.',
  evidence: ['`src/other.ts:40` exports the helper.', 'No caller imports it at line 40.'],
  technicalConfidence: 0.9,
  ...over,
});

function alignments(db, cand, extra = {}) {
  const precedents = retrievePrecedents(db, {
    text: `${cand.claim} ${cand.failureMode}`,
    repository: REPO,
    allowlist: [],
    ownerReviewer: OWNER,
    category: cand.category,
    filePath: cand.path,
    maxPositive: 3,
    maxNegative: 2,
    now: NOW,
    ...extra,
  });
  return { precedents, breakdown: scoreCandidate(cand, precedents, []) };
}

test('strong owner dismissal takes a similar candidate below neutral; unrelated is unaffected', () => {
  withDb((db) => {
    seedOutcome(db);
    const similar = alignments(db, candidate());
    assert.equal(similar.precedents.length, 1);
    assert.equal(similar.precedents[0].source, 'outcome');
    assert.equal(similar.precedents[0].role, 'owner');
    assert.equal(similar.precedents[0].outcome, 'dismissed');
    assert.ok(similar.precedents[0].weight < 0);
    assert.ok(similar.breakdown.ownerAlignment < NEUTRAL_ALIGNMENT, `owner ${similar.breakdown.ownerAlignment}`);
    const unrelated = alignments(db, candidate({
      claim: 'The database transaction returns the token before it commits.',
      failureMode: 'A retry can mint duplicate tokens.',
    }));
    assert.equal(unrelated.precedents.filter((p) => p.source === 'outcome').length, 0);
    assert.equal(unrelated.breakdown.ownerAlignment, NEUTRAL_ALIGNMENT);
    assert.equal(unrelated.breakdown.repositoryAlignment, NEUTRAL_ALIGNMENT);
  });
});

test('fixed outcome raises alignment above the no-outcome value', () => {
  withDb((db) => {
    const before = alignments(db, candidate()).breakdown;
    seedOutcome(db, { outcome: 'fixed', decidedBy: null, evidence: 'the anchored lines changed after the comment and the thread was resolved' });
    const { precedents, breakdown } = alignments(db, candidate());
    assert.equal(precedents.length, 1);
    assert.equal(precedents[0].outcome, 'accepted');
    assert.equal(precedents[0].source, 'outcome');
    assert.ok(precedents[0].weight > 0);
    assert.ok(breakdown.repositoryAlignment > before.repositoryAlignment, `${breakdown.repositoryAlignment} <= ${before.repositoryAlignment}`);
    assert.ok(breakdown.repositoryAlignment > NEUTRAL_ALIGNMENT);
    assert.ok(breakdown.finalScore > before.finalScore);
  });
});

test('weak, resolved, outdated, open and unknown outcomes change nothing', () => {
  for (const [outcome, strength] of [['dismissed', 'weak'], ['fixed', 'weak'], ['resolved', 'weak'], ['outdated', 'weak'], ['open', 'weak'], ['unknown', 'weak']]) {
    withDb((db) => {
      seedOutcome(db, { outcome, strength, decidedBy: OWNER });
      const { precedents, breakdown } = alignments(db, candidate());
      assert.equal(precedents.filter((p) => p.source === 'outcome').length, 0, `${outcome}/${strength}`);
      assert.equal(breakdown.ownerAlignment, NEUTRAL_ALIGNMENT, `${outcome}/${strength}`);
      assert.equal(breakdown.repositoryAlignment, NEUTRAL_ALIGNMENT, `${outcome}/${strength}`);
    });
  }
});

test('saveOutcome strong dismissal is also derived (the stored shape outcomes writes)', () => {
  withDb((db) => {
    const output = `[minor] \`src/exports.ts:12\` - ${FINDING_TEXT}`;
    const { reviewRunId } = recordRun(db, {
      repository: REPO, baseRef: null, headRef: 'a'.repeat(40), pullNumber: 7, diff: 'd', output,
      candidates: [{ path: 'src/exports.ts', line: 12, category: 'maintainability' }],
    });
    saveOutcome(db, {
      reviewRunId, findingId: 'rv_01', repository: REPO, pullNumber: 7, commentId: 101,
      outcome: 'dismissed', strength: 'strong', evidence: 'ownerlogin replied turning it down',
      checkedAt: CHECKED, path: 'src/exports.ts', line: 12, reviewIdSource: 'audit', decidedBy: OWNER,
    });
    assert.ok(alignments(db, candidate()).breakdown.ownerAlignment < NEUTRAL_ALIGNMENT);
  });
});

test('bot and echo-only decisions weigh no more than team', () => {
  assert.equal(outcomeRole({ decidedBy: 'dependabot[bot]', ownerReviewer: OWNER, evidence: 'x replied turning it down' }), 'bot');
  assert.equal(baseWeight('bot', 'dismissed'), 0);
  assert.equal(isEchoOnlyFix('fixed in abc1234'), true);
  assert.equal(isEchoOnlyFix('done'), true);
  assert.equal(isEchoOnlyFix('addressed'), true);
  assert.equal(isEchoOnlyFix('fixed the retry to commit before returning the token because the surface matters'), false);
  assert.equal(outcomeRole({ decidedBy: OWNER, ownerReviewer: OWNER, evidence: 'done' }), 'team');
  assert.equal(outcomeRole({ decidedBy: OWNER, ownerReviewer: OWNER, evidence: 'ownerlogin replied turning it down with reasons' }), 'owner');
  const teamMagnitude = Math.abs(baseWeight('team', 'dismissed'));
  for (const [label, over] of [
    ['bot login', { decidedBy: 'dependabot[bot]', evidence: 'dependabot[bot] replied turning it down with reasons' }],
    ['queue bot pattern', { decidedBy: 'my-ci-bot', evidence: 'my-ci-bot replied turning it down with reasons' }],
    ['echo from owner', { decidedBy: OWNER, evidence: 'done' }],
  ]) {
    withDb((db) => {
      seedOutcome(db, over);
      const { precedents, breakdown } = alignments(db, candidate());
      assert.equal(breakdown.ownerAlignment, NEUTRAL_ALIGNMENT, label);
      for (const p of precedents) {
        assert.notEqual(p.role, 'owner', label);
        // No more than a team dismissal could weigh before recency/specificity/context shrink it further.
        assert.ok(Math.abs(p.weight) <= teamMagnitude + 1e-9, `${label}: ${p.weight}`);
      }
    });
  }
  // An echo-only fixed from the owner is team acceptance, not owner acceptance.
  withDb((db) => {
    seedOutcome(db, { outcome: 'fixed', decidedBy: OWNER, evidence: 'fixed in abc1234' });
    const { precedents, breakdown } = alignments(db, candidate());
    assert.equal(precedents.length, 1);
    assert.equal(precedents[0].role, 'team');
    assert.equal(breakdown.ownerAlignment, NEUTRAL_ALIGNMENT);
    assert.ok(breakdown.repositoryAlignment > NEUTRAL_ALIGNMENT);
  });
});

test('exclude-pull and repository scope keep outcomes out', () => {
  withDb((db) => {
    seedOutcome(db, { pullNumber: 7 });
    assert.equal(alignments(db, candidate(), { excludePullNumber: 7 }).precedents.length, 0);
    assert.equal(alignments(db, candidate(), { excludePullNumber: 8 }).precedents.length, 1);
    // Only the repository under review is in scope: acme/web is outside a review of acme/api with an empty allowlist.
    const outOfScope = retrievePrecedents(db, {
      text: SIMILAR_TEXT, repository: 'acme/api', allowlist: [], ownerReviewer: OWNER,
      filePath: 'src/other.ts', maxPositive: 3, maxNegative: 2, now: NOW,
    });
    assert.equal(outOfScope.filter((p) => p.source === 'outcome').length, 0);
    const inScope = retrievePrecedents(db, {
      text: SIMILAR_TEXT, repository: 'acme/api', allowlist: ['acme/web'], ownerReviewer: OWNER,
      filePath: 'src/other.ts', maxPositive: 3, maxNegative: 2, now: NOW,
    });
    assert.equal(inScope.filter((p) => p.source === 'outcome').length, 1);
    const ownerWildcard = retrievePrecedents(db, {
      text: SIMILAR_TEXT, repository: 'acme/api', allowlist: ['acme/*'], ownerReviewer: OWNER,
      filePath: 'src/other.ts', maxPositive: 3, maxNegative: 2, now: NOW,
    });
    assert.equal(ownerWildcard.filter((p) => p.source === 'outcome').length, 1);
    void UNRELATED_TEXT;
  });
});

test('retrieval is deterministic, bounded, and writes nothing', () => {
  withDb((db) => {
    for (let i = 0; i < 6; i += 1) {
      seedOutcome(db, { pullNumber: 10 + i, path: `src/exports${i}.ts` });
    }
    const before = {
      outcomes: db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n,
      events: db.prepare('SELECT COUNT(*) AS n FROM review_events').get().n,
      runs: db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n,
    };
    const first = alignments(db, candidate()).precedents;
    const second = alignments(db, candidate()).precedents;
    assert.deepEqual(first.map((p) => p.eventId), second.map((p) => p.eventId));
    assert.ok(first.length <= 5, `bounded by caps, got ${first.length}`);
    assert.deepEqual({
      outcomes: db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n,
      events: db.prepare('SELECT COUNT(*) AS n FROM review_events').get().n,
      runs: db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n,
    }, before);
  });
});

test('learned stats count accepted and dismissed and name net-negative categories', () => {
  withDb((db) => {
    seedOutcome(db);
    seedOutcome(db, { outcome: 'fixed', decidedBy: null, category: 'correctness', path: 'src/auth.ts', text: 'The token is returned before the transaction commits.' });
    const stats = learnedPrecedentStats(db, { ownerReviewer: OWNER });
    assert.deepEqual({ total: stats.total, accepted: stats.accepted, dismissed: stats.dismissed }, { total: 2, accepted: 1, dismissed: 1 });
    assert.deepEqual(stats.netNegative.map((n) => n.category), ['maintainability']);
    assert.ok(stats.netNegative[0].net < 0);
  });
});

test('explain marks source: outcome and status prints learned counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-480-cli-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  seedOutcome(db);
  const cand = candidate();
  const precedents = retrievePrecedents(db, {
    text: `${cand.claim} ${cand.failureMode}`, repository: REPO, allowlist: [], ownerReviewer: OWNER,
    category: cand.category, filePath: cand.path, maxPositive: 3, maxNegative: 2, now: NOW,
  });
  const breakdown = scoreCandidate(cand, precedents, []);
  const second = recordRun(db, {
    repository: REPO, baseRef: null, headRef: 'b'.repeat(40), pullNumber: 99, diff: 'd',
    output: `[minor] \`${cand.path}:${cand.line}\` - The exported helper is unused and adds dead code.`,
    candidates: [{ path: cand.path, line: cand.line, category: 'maintainability' }],
    scores: [{ ...breakdown, precedents }],
  });
  db.close();
  const saved = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  try {
    const explained = await runInProcess(['explain', '--run', second.reviewRunId]);
    assert.equal(explained.code, 0, explained.stderr);
    assert.match(explained.stdout, /precedents\s+outcome:[^\s]+ \(source: outcome\)/);
    const status = await runInProcess(['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /learned precedents 1 from outcomes: 0 accepted, 1 dismissed/);
    assert.match(status.stdout, /learned negative\s+maintainability \(net -/);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});



test('a strong outcome match does not shrink corpus matchStrength (each source normalised on its own)', () => {
  const query = { text: SIMILAR_TEXT, repository: REPO, allowlist: [], ownerReviewer: OWNER, maxPositive: 5, maxNegative: 5, now: NOW };
  const corpusEvent = {
    eventId: 'gh_c1', source: 'github', repository: REPO, pullNumber: 1, pullRequestUrl: 'https://example.com/pull/1',
    commentId: 'c1', reviewerLogin: 'someone', role: 'owner', createdAt: CHECKED,
    bodyRedacted: 'The exported helper is unused here.', filePath: 'src/a.ts', lineStart: 3,
    contentKey: 'c1', redactionVersion: '1', redactionCounts: {},
  };
  withDb((db) => {
    storeEvents(db, [corpusEvent]);
    const alone = retrievePrecedents(db, query).find((p) => p.source === 'corpus');
    seedOutcome(db, { text: SIMILAR_TEXT });
    const beside = retrievePrecedents(db, query);
    assert.ok(beside.some((p) => p.source === 'outcome'));
    assert.equal(beside.find((p) => p.source === 'corpus').matchStrength, alone.matchStrength);
  });
});

test('the 500-row outcome cap applies after repository scope, not before', () => {
  withDb((db) => {
    seedOutcome(db, { pullNumber: 1, text: SIMILAR_TEXT, checkedAt: '2026-01-01T00:00:00.000Z' });
    for (let i = 0; i < 501; i += 1) {
      seedOutcome(db, { repository: 'acme/api', pullNumber: 100 + i, text: SIMILAR_TEXT, checkedAt: CHECKED });
    }
    const found = retrievePrecedents(db, {
      text: SIMILAR_TEXT, repository: REPO, allowlist: [], ownerReviewer: OWNER, maxPositive: 3, maxNegative: 3, now: NOW,
    });
    assert.equal(found.filter((p) => p.source === 'outcome' && p.repository === REPO).length, 1);
  });
});
